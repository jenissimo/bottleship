import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Process } from "../../src/worker/core/process";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { wsaAsyncTaskCounter } from "../../src/worker/modules/wsa-stub-shared";
import {
    WsaSocketTable, WSA, WSA_DATAGRAM_OPTION_KEYS, FD_READ, FD_WRITE, ipv4Address,
    type WsaAddress, type WsaDatagramConfig, type WsaEventTarget, type WsaIdleDatagram,
} from "../../src/worker/modules/wsa-network";
import { WsaActorKernel } from "../../src/worker/modules/wsa-actor-kernel";
import { createWsaActorTable } from "../../src/worker/modules/wsa-actor-table";
import {
    captureWinsockSavestate, restoreWinsockSavestate, WINSOCK_SOCKET_FIELDS, WINSOCK_SCHEMA, type WinsockState,
} from "../../src/worker/modules/wsa-savestate";
import { savestateParticipants } from "../../src/worker/savestate/participant";
import { decodeValue, encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";

const nodeA = Uint8Array.of(2, 0, 0, 4, 5, 6), nodeB = Uint8Array.of(2, 0, 0, 9, 8, 7);
const disposers: Array<() => void> = [];
let counter = 0;
beforeEach(() => { counter = wsaAsyncTaskCounter(); });
afterEach(() => {
    for (const fn of disposers.splice(0).reverse()) fn();
    wsaAsyncTaskCounter(counter);
});
const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};
const throughCodec = <T>(v: T): T => decodeValue(encodeValue(v as SaveValue)) as T;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 15));
const hex = (n: number) => `0x${n.toString(16)}`;

function table(network = new LanNetwork(nodeA)) {
    const t = new WsaSocketTable(network);
    disposers.push(() => t.reset());
    return t;
}
function provider(t: WsaSocketTable) {
    const state = {
        table: t,
        counter: { captureState: () => ({ startups: 1, version: 0x0202 }), restoreState: () => undefined },
        buffers: { hostent: new Map(), protoent: 0, servent: 0, addrinfo: new Map() },
    };
    const process = { resetGeneration: 0 } as unknown as Process;
    return {
        capture: () => captureWinsockSavestate(process, state as never),
        restore: (saved: WinsockState) => restoreWinsockSavestate(process, state as never, saved),
    };
}
const idleDatagram = (t: WsaSocketTable, handle: number): WsaIdleDatagram => {
    const found = t.openForSavestate().idle.find(item => item.handle === handle);
    if (!found) throw new Error("not idle");
    return found;
};
const any = (value: unknown) => value as Record<string, any>;
const wildcard = (port: number): WsaAddress => ({ family: 2, port, node: new Uint8Array(6), ip: new Uint8Array(4) });
const WINDOW: WsaEventTarget = { kind: "window", hwnd: 0x66, message: 0x401 };

function bound(t: WsaSocketTable, port: number, af = 2, protocol = 0): number {
    const id = t.socket(2, af, protocol);
    if (af === 2) t.bind(id, wildcard(port));
    else if (af === 23) t.bind(id, { family: 23, port, node: new Uint8Array(6), ip6: new Uint8Array(16) });
    else t.bind(id, { family: 6, port, node: new Uint8Array(6) });
    return id;
}

describe("winsock idle datagram sockets", () => {
    test("a bound unused socket is saved as configuration and recreated with its handle, options, port and selection", () => {
        const first = table(), saved1 = provider(first);
        const spacer = first.socket(2, 2, 17);
        first.closesocket(spacer);
        const id = bound(first, 5000);
        const s = first.get(id);
        s.broadcast = true; s.reuse = true; s.receiveLimit = 12345; s.lingerEnabled = true; s.lingerSeconds = 7; s.multicastTtl = 9;
        first.setHandleFlags(id, 3, 0);
        first.configureEvents(id, FD_READ, () => undefined, WINDOW);
        const saved = throughCodec(saved1.capture());
        expect(saved.datagrams.length).toBe(1);
        expect(saved.datagrams[0].handle).toBe(id);
        expect(saved.nextSocket).toBe(id + 1);
        first.closesocket(id);

        const second = table(new LanNetwork(nodeB)), fresh = provider(second);
        fresh.restore(saved);
        expect(bytes(fresh.capture())).toBe(bytes(saved));
        const restored = second.get(id);
        expect([restored.broadcast, restored.reuse, restored.receiveLimit, restored.lingerEnabled, restored.lingerSeconds, restored.multicastTtl, restored.handleFlags])
            .toEqual([true, true, 12345, true, 7, 9, 0]);
        expect(restored.local?.port).toBe(5000);
        expect(restored.nonBlocking).toBe(true);
        expect(second.socket(2, 2, 17)).toBe(id + 1);
    });

    test("the restored socket sends, receives and notifies again", () => {
        const first = table(), saved = provider(first);
        const id = bound(first, 5000);
        first.configureEvents(id, FD_READ, () => undefined, WINDOW);
        const blob = throughCodec(saved.capture());
        first.closesocket(id);

        const second = table(new LanNetwork(nodeB));
        const notified: Array<[number, number]> = [];
        expect(second.restoreIdleDatagrams(blob.datagrams, () => (bit, error) => { notified.push([bit, error]); })).toEqual({ failed: null });
        second.advanceHandles(blob.nextSocket);
        const peer = bound(second, 5001);
        expect(second.sendto(peer, Uint8Array.of(1, 2, 3), ipv4Address(Uint8Array.of(127, 0, 0, 1), 5000))).toBe(3);
        expect(second.readable(id)).toBe(true);
        expect([...second.receive(id, 16).data]).toEqual([1, 2, 3]);
        expect(notified).toEqual([[FD_READ, 0]]);
    });

    test("an event selection restored from a save fires its own notifier", () => {
        const first = table(), saved = provider(first);
        const id = bound(first, 5000);
        first.configureEvents(id, FD_READ, () => undefined, { kind: "event", handle: 0x44 });
        const blob = throughCodec(saved.capture());
        first.closesocket(id);
        const second = table(new LanNetwork(nodeB));
        const made: Array<[number, WsaEventTarget]> = [];
        expect(second.restoreIdleDatagrams(blob.datagrams, (socket, target) => { made.push([socket, target]); return () => undefined; })).toEqual({ failed: null });
        expect(made).toEqual([[id, { kind: "event", handle: 0x44 }]]);
        expect(typeof any(second.get(id)).notify).toBe("function");
    });

    test("every option, binding kind, family and selection field is saved and survives a restore", () => {
        const mutate = (key: string, value: unknown) => (value === null ? 7 : typeof value === "boolean" ? !value : (value as number) + 1);
        for (const key of WSA_DATAGRAM_OPTION_KEYS) {
            const first = table(), p1 = provider(first), id = bound(first, 6000);
            const before = any(first.get(id))[key];
            any(first.get(id))[key] = mutate(key, before);
            const saved = throughCodec(p1.capture());
            expect({ key, value: any(saved.datagrams[0].config.options)[key] }).toEqual({ key, value: mutate(key, before) });
            first.closesocket(id);
            const second = table(), p2 = provider(second);
            p2.restore(saved);
            expect({ key, value: any(second.get(id))[key] }).toEqual({ key, value: mutate(key, before) });
            expect(bytes(p2.capture())).toBe(bytes(saved));
        }
        for (const field of ["nonBlocking", "overlapped"] as const) {
            const first = table(), p1 = provider(first), id = bound(first, 6000);
            any(first.get(id))[field] = !first.get(id)[field];
            const saved = throughCodec(p1.capture());
            first.closesocket(id);
            const second = table(), p2 = provider(second);
            p2.restore(saved);
            expect({ field, value: second.get(id)[field] }).toEqual({ field, value: saved.datagrams[0].config[field] });
            expect(bytes(p2.capture())).toBe(bytes(saved));
        }
        const flags = table(), pf = provider(flags), fid = bound(flags, 6000);
        flags.setHandleFlags(fid, 3, 0);
        const flagSaved = throughCodec(pf.capture());
        expect(flagSaved.datagrams[0].handleFlags).toBe(0);
        const flagFresh = table(new LanNetwork(nodeB));
        provider(flagFresh).restore(flagSaved);
        expect(flagFresh.get(fid).handleFlags).toBe(0);
    });

    test("families and binding kinds are saved as kinds and recreated on the new session's addresses", () => {
        const cases: Array<{ af: number; protocol: number; address?: (network: LanNetwork) => WsaAddress; kind: string }> = [
            { af: 2, protocol: 0, kind: "wildcard" },
            { af: 2, protocol: 0, kind: "loopback", address: () => ({ family: 2, port: 6001, node: new Uint8Array(6), ip: Uint8Array.of(127, 0, 0, 1) }) },
            { af: 2, protocol: 0, kind: "own", address: n => ({ family: 2, port: 6001, node: n.node.slice(), ip: n.ipv4.slice() }) },
            { af: 23, protocol: 0, kind: "wildcard" },
            { af: 23, protocol: 0, kind: "loopback", address: () => ({ family: 23, port: 6001, node: new Uint8Array(6), ip6: Uint8Array.from({ length: 16 }, (_, i) => i === 15 ? 1 : 0) }) },
            { af: 23, protocol: 0, kind: "own", address: n => ({ family: 23, port: 6001, node: new Uint8Array(6), ip6: n.ipv6.slice() }) },
            { af: 6, protocol: 1005, kind: "wildcard" },
        ];
        for (const item of cases) {
            const netA = new LanNetwork(nodeA), first = table(netA), p1 = provider(first);
            const id = first.socket(2, item.af, item.protocol);
            first.bind(id, item.address ? item.address(netA) : { family: item.af, port: 6001, node: new Uint8Array(6), ...(item.af === 2 ? { ip: new Uint8Array(4) } : item.af === 23 ? { ip6: new Uint8Array(16) } : {}) });
            const saved = throughCodec(p1.capture());
            expect([item.af, saved.datagrams[0].config.binding?.kind, saved.datagrams[0].config.protocol])
                .toEqual([item.af, item.kind, item.af === 6 ? 1005 : 17]);
            first.closesocket(id);
            const netB = new LanNetwork(nodeB), second = table(netB), p2 = provider(second);
            p2.restore(saved);
            expect(bytes(p2.capture())).toBe(bytes(saved));
            const local = second.get(id).local!;
            expect(local.port).toBe(6001);
            if (item.kind === "own" && item.af === 2) expect([...local.ip!]).toEqual([...netB.ipv4]);
            if (item.kind === "own" && item.af === 23) expect([...local.ip6!]).toEqual([...netB.ipv6]);
            if (item.kind === "wildcard" && item.af !== 6) expect((local.ip ?? local.ip6)!.every(v => v === 0)).toBe(true);
        }
    });

    test("an unbound socket and an ephemeral port are both saved", () => {
        const first = table(), p1 = provider(first);
        const unbound = first.socket(2, 2, 17), auto = first.socket(2, 2, 17);
        first.bind(auto);
        const port = first.get(auto).local!.port;
        const saved = throughCodec(p1.capture());
        expect(saved.datagrams.map(item => item.config.binding)).toEqual([null, { kind: "wildcard", port, address: null }]);
        first.closesocket(unbound); first.closesocket(auto);
        const second = table(), p2 = provider(second);
        p2.restore(saved);
        expect([second.get(unbound).local, second.get(auto).local?.port]).toEqual([null, port]);
    });

    test("every other state keeps the save refused and names the socket and the reason", () => {
        const first = table(), p = provider(first);
        const refuse = (id: number, text: string, kind = "UDP, bound to port 7000") =>
            expect(p.capture).toThrow(`winsock: not idle, 1 thing(s) open: socket ${hex(id)} (${kind}): ${text}`);
        const reset = (id: number) => first.closesocket(id);

        const tcp = first.socket(1, 2, 6);
        refuse(tcp, "is not a datagram socket", "TCP");
        reset(tcp);
        const raw = first.socket(3, 2, 255);
        refuse(raw, "is not a datagram socket", "RAW");
        reset(raw);

        let id = bound(first, 7000);
        first.connect(id, ipv4Address(Uint8Array.of(127, 0, 0, 1), 7001));
        refuse(id, "has been connected", "UDP, connected");
        reset(id);

        id = bound(first, 7000);
        const peer = bound(first, 7001);
        first.sendto(peer, Uint8Array.of(9), ipv4Address(Uint8Array.of(127, 0, 0, 1), 7000));
        expect(first.readable(id)).toBe(true);
        refuse(id, "holds received data");
        first.receive(id, 8);
        expect(p.capture().datagrams.length).toBe(2);
        reset(peer);
        reset(id);

        id = bound(first, 7000);
        first.changeMulticastMembership(id, Uint8Array.of(224, 1, 2, 3), Uint8Array.of(127, 0, 0, 1), true);
        refuse(id, "has a multicast membership");
        first.changeMulticastMembership(id, Uint8Array.of(224, 1, 2, 3), Uint8Array.of(127, 0, 0, 1), false);
        expect(p.capture().datagrams.length).toBe(1);

        first.configureEvents(id, FD_READ, () => undefined);
        refuse(id, "has an event selection");
        first.configureEvents(id, FD_WRITE, () => undefined, WINDOW);
        refuse(id, "has a pending error or event");
        first.configureEvents(id, FD_READ, () => undefined, WINDOW);
        expect(p.capture().datagrams.length).toBe(1);
        first.configureEvents(id, 0);

        first.shutdown(id, 1);
        refuse(id, "was shut down");
        reset(id);

        id = bound(first, 7000);
        any(first.get(id)).error = WSA.ECONNRESET;
        refuse(id, "has a pending error or event");
        any(first.get(id)).error = 0;
        any(first.get(id)).local.ip = Uint8Array.of(10, 1, 2, 3);
        refuse(id, "is bound to an address that cannot be recreated");
        reset(id);
    });

    test("a second descriptor on the same socket refuses the save in the actor", () => {
        const kernel = new WsaActorKernel(table()), one = { pid: 11, slot: 0, epoch: 1 }, two = { pid: 12, slot: 1, epoch: 1 };
        kernel.register(one); kernel.register(two);
        const socket = kernel.execute(one, "socket", [2, 2, 17]) as number;
        expect((kernel.execute(one, "openForSavestate", []) as { idle: unknown[] }).idle.length).toBe(1);
        kernel.execute(one, "duplicate", [socket, 12]);
        const answer = kernel.execute(one, "openForSavestate", []) as { count: number; open: string[]; idle: unknown[] };
        expect([answer.count, answer.open, answer.idle]).toEqual([1, [`socket ${hex(socket)} (UDP): is shared by more than one descriptor`], []]);
        kernel.drop(one); kernel.drop(two);
    });

    test("a port that the fresh session cannot get is a named restore error and leaves nothing behind", () => {
        const network = new LanNetwork(nodeA), first = table(network), p1 = provider(first);
        const a = bound(first, 5000), b = bound(first, 5001);
        const saved = throughCodec(p1.capture());
        first.closesocket(a);
        const second = table(network), p2 = provider(second);
        expect(() => p2.restore(saved)).toThrow(`winsock: port 5001 of socket ${hex(b)} is taken`);
        expect(any(second).sockets.size).toBe(0);
        expect(any(second).bindings.size).toBe(0);
        expect(second.openForSavestate()).toEqual({ count: 0, open: [], nextHandle: second.openForSavestate().nextHandle, idle: [] });
        first.closesocket(b);
        p2.restore(saved);
        expect(second.get(a).local?.port).toBe(5000);
        expect(second.get(b).local?.port).toBe(5001);
    });

    test("a restore into a session that already has a socket fails before creating anything", () => {
        const first = table(), p1 = provider(first);
        const id = bound(first, 5000);
        const saved = throughCodec(p1.capture());
        first.closesocket(id);
        const second = table(), p2 = provider(second);
        const other = second.socket(2, 2, 17);
        expect(() => p2.restore(saved)).toThrow(`winsock: the fresh session is not idle: socket ${hex(other)} (UDP)`);
        expect(any(second).sockets.size).toBe(1);
    });

    test("a malformed or hostile saved socket is refused before the session is touched", () => {
        const first = table(), p1 = provider(first);
        const id = bound(first, 5000);
        const good = throughCodec(p1.capture());
        first.closesocket(id);
        const second = table(), p2 = provider(second);
        const attempt = (change: (value: WinsockState) => void) => {
            const copy = throughCodec(good);
            change(copy);
            expect(() => p2.restore(copy)).toThrow(/^winsock: /);
            expect(any(second).sockets.size).toBe(0);
            expect(any(second).bindings.size).toBe(0);
        };
        attempt(v => { v.datagrams[0].handle = v.nextSocket; });
        attempt(v => { v.datagrams.push(structuredClone(v.datagrams[0])); });
        attempt(v => { v.datagrams[0].config.af = 99; });
        attempt(v => { v.datagrams[0].config.type = 1; });
        attempt(v => { v.datagrams[0].config.binding!.port = 0; });
        attempt(v => { v.datagrams[0].config.binding!.kind = "other" as never; });
        attempt(v => { any(v.datagrams[0].config.options).broadcast = 1; });
        attempt(v => { v.datagrams[0].config.events.mask = 1; });
        attempt(v => { v.datagrams[0].handleFlags = 9; });
        attempt(v => { (v as unknown as Record<string, unknown>).datagrams = null; });
    });

    test("the field policy table lists every socket field and the saved ones are exactly the schema's", () => {
        const t = table(), id = t.socket(2, 2, 17);
        const optional = new Set(["acceptListener", "acceptListenerObjectId", "originalLocal", "connectExCompleted", "connectTimer", "notify", "eventTarget"]);
        expect(Object.keys(t.get(id)).sort()).toEqual(Object.keys(WINSOCK_SOCKET_FIELDS).filter(key => !optional.has(key)).sort());
        const saved = Object.entries(WINSOCK_SOCKET_FIELDS).filter(([, policy]) => policy === "save").map(([key]) => key).sort();
        const covered = ["af", "type", "protocol", "nonBlocking", "overlapped", "handleFlags", "local", "eventMask", "eventDisabled", "eventTarget", ...WSA_DATAGRAM_OPTION_KEYS].sort();
        expect(saved).toEqual(covered);
        const config = idleDatagram(t, id).config;
        expect(Object.keys(config.options).sort()).toEqual([...WSA_DATAGRAM_OPTION_KEYS].sort());
        expect(Object.keys(config).sort()).toEqual(WINSOCK_SCHEMA.datagramConfig);
        expect(Object.keys(config.events).sort()).toEqual(WINSOCK_SCHEMA.datagramEvents);
        expect(Object.keys(idleDatagram(t, id)).sort()).toEqual(WINSOCK_SCHEMA.datagramRow);
    });

    test("repeated save and restore leaves no sockets, bindings or registrations behind", () => {
        const network = new LanNetwork(nodeA), first = table(network), second = table(network);
        const p1 = provider(first), p2 = provider(second);
        for (let round = 0; round < 50; round++) {
            const id = bound(first, 5000 + (round % 7));
            first.configureEvents(id, FD_READ, () => undefined, round % 2 ? WINDOW : { kind: "event", handle: 5 });
            const saved = throughCodec(p1.capture());
            first.closesocket(id);
            p2.restore(saved);
            second.closesocket(id);
        }
        for (const t of [first, second]) {
            expect([any(t).sockets.size, any(t).bindings.size, any(t).wireSockets.size, any(t).udpReceiveQueues.size]).toEqual([0, 0, 0, 0]);
        }
    });

    test("the same open and close loop without any participant behaves the same", () => {
        const network = new LanNetwork(nodeA), t = table(network);
        for (let round = 0; round < 50; round++) {
            const id = bound(t, 5000 + (round % 7));
            t.configureEvents(id, FD_READ, () => undefined, WINDOW);
            t.closesocket(id);
        }
        expect(savestateParticipants.all().some(item => item.id === "winsock")).toBe(false);
        expect([any(t).sockets.size, any(t).bindings.size, any(t).wireSockets.size]).toEqual([0, 0, 0]);
    });

    test("the socket actor recreates the descriptor under its saved handle and forwards events to the restored selection", () => {
        const network = new LanNetwork(nodeA), kernel = new WsaActorKernel(new WsaSocketTable(network));
        const one = { pid: 21, slot: 0, epoch: 1 };
        kernel.register(one);
        const events: any[] = [];
        kernel.attach(one, message => { if (message.type === "event") events.push(message); });
        kernel.execute(one, "closesocket", [kernel.execute(one, "socket", [2, 2, 17])]);
        const handle = kernel.execute(one, "socket", [2, 2, 17]) as number;
        kernel.execute(one, "bind", [handle, wildcard(5000)]);
        kernel.execute(one, "configureEvents", [handle, FD_READ, WINDOW]);
        kernel.execute(one, "setHandleFlags", [handle, 3, 0]);
        const listed = throughCodec(kernel.execute(one, "openForSavestate", []) as { idle: WsaIdleDatagram[] });
        expect(listed.idle.map(item => [item.handle, item.handleFlags, item.config.events.target])).toEqual([[handle, 0, WINDOW]]);
        kernel.execute(one, "discardDatagram", [handle]);
        expect((kernel.execute(one, "openForSavestate", []) as { idle: unknown[] }).idle.length).toBe(0);

        expect(kernel.execute(one, "restoreDatagram", [listed.idle[0]])).toBe(handle);
        expect((kernel.execute(one, "get", [handle]) as { handleFlags: number }).handleFlags).toBe(0);
        expect(throughCodec(kernel.execute(one, "openForSavestate", []) as { idle: WsaIdleDatagram[] }).idle).toEqual(listed.idle);
        const peer = kernel.execute(one, "socket", [2, 2, 17]) as number;
        kernel.execute(one, "bind", [peer, wildcard(5001)]);
        kernel.execute(one, "sendto", [peer, Uint8Array.of(4), ipv4Address(Uint8Array.of(127, 0, 0, 1), 5000)]);
        expect(events).toEqual([{ type: "event", socket: handle, bit: FD_READ, error: 0 }]);
        expect(() => kernel.execute(one, "restoreDatagram", [listed.idle[0]])).toThrow();
        expect(() => kernel.execute({ ...one, pid: 99 }, "restoreDatagram", [listed.idle[0]])).toThrow();
        kernel.drop(one);
        expect([any(kernel).references.size, any(kernel).selected.size, any(kernel.table).sockets.size, any(kernel.table).bindings.size]).toEqual([0, 0, 0, 0]);
    });

    test("a handle held by another process refuses the restore and leaves no socket behind", () => {
        const network = new LanNetwork(nodeA), kernel = new WsaActorKernel(new WsaSocketTable(network));
        const one = { pid: 21, slot: 0, epoch: 1 }, two = { pid: 22, slot: 0, epoch: 1 };
        kernel.register(one); kernel.register(two);
        const held = kernel.execute(two, "socket", [2, 2, 17]) as number;
        const item: WsaIdleDatagram = idleItem(held, 5000);
        const before = any(kernel.table).sockets.size;
        expect(() => kernel.execute(one, "restoreDatagram", [item])).toThrow();
        expect([any(kernel.table).sockets.size, any(kernel.table).bindings.size]).toEqual([before, 0]);
        kernel.drop(one); kernel.drop(two);
    });

    test("50 rounds through the socket actor leave its sockets, aliases and selections empty", () => {
        const network = new LanNetwork(nodeA), kernel = new WsaActorKernel(new WsaSocketTable(network));
        const one = { pid: 21, slot: 0, epoch: 1 };
        kernel.register(one);
        for (let round = 0; round < 50; round++) {
            const handle = kernel.execute(one, "socket", [2, 2, 17]) as number;
            kernel.execute(one, "bind", [handle, wildcard(5000)]);
            kernel.execute(one, "configureEvents", [handle, FD_READ, round % 2 ? WINDOW : { kind: "event", handle: 3 }]);
            const listed = throughCodec(kernel.execute(one, "openForSavestate", []) as { idle: WsaIdleDatagram[] });
            kernel.execute(one, "closesocket", [handle]);
            expect(kernel.execute(one, "restoreDatagram", [listed.idle[0]])).toBe(handle);
            kernel.execute(one, "closesocket", [handle]);
        }
        const context = any(kernel).processes.get(21);
        expect([context.aliases.size, any(kernel).references.size, any(kernel).selected.size, any(kernel.table).sockets.size, any(kernel.table).bindings.size]).toEqual([0, 0, 0, 0, 0]);
        kernel.drop(one);
    });
});

function idleItem(handle: number, port: number): WsaIdleDatagram {
    const scratch = new WsaSocketTable(new LanNetwork(nodeA)), id = scratch.socket(2, 2, 17);
    scratch.bind(id, wildcard(port));
    const config: WsaDatagramConfig = scratch.openForSavestate().idle[0].config;
    scratch.reset();
    return { handle, handleFlags: 1, config };
}

describe("winsock idle datagram sockets through the real socket actor", () => {
    test("save, restore, wrong port, rollback and 50 rounds over the worker mailbox", async () => {
        const worker = new Worker(new URL("./fixtures/dp4-listener-actor-worker.ts", import.meta.url).href, { type: "module" });
        const channel = new MessageChannel(), ready = new Promise<void>(resolve => { worker.onmessage = () => resolve(); });
        worker.postMessage({ port: channel.port2 }, [channel.port2]); await ready;
        const proxy = createWsaActorTable(new LanNetwork(), { port: channel.port1, pid: 1234, slot: 0, epoch: 1 });
        try {
            const state = { table: proxy, counter: { captureState: () => ({ startups: 1, version: 0x0202 }), restoreState: () => undefined }, buffers: { hostent: new Map(), protoent: 0, servent: 0, addrinfo: new Map() } };
            const process = { resetGeneration: 0 } as unknown as Process;
            const capture = () => captureWinsockSavestate(process, state as never);
            const restore = (saved: WinsockState) => restoreWinsockSavestate(process, state as never, saved);

            const filler = proxy.socket(2, 2, 17); proxy.closesocket(filler);
            const id = proxy.socket(2, 2, 17);
            proxy.bind(id, wildcard(5000));
            proxy.get(id).broadcast = true;
            proxy.configureEvents(id, FD_READ, () => undefined, WINDOW);
            const saved = throughCodec(capture());
            expect(saved.datagrams.map(item => [item.handle, item.config.options.broadcast, item.config.binding, item.config.events.target]))
                .toEqual([[id, true, { kind: "wildcard", port: 5000, address: null }, WINDOW]]);
            proxy.closesocket(id);
            expect(capture().datagrams).toEqual([]);

            const seen: Array<[number, number, number]> = [];
            const notifierFor = (socket: number) => (bit: number, error: number) => { seen.push([socket, bit, error]); };
            expect(proxy.restoreIdleDatagrams(saved.datagrams, notifierFor)).toEqual({ failed: null });
            expect(bytes(capture())).toBe(bytes(saved));
            const peer = proxy.socket(2, 2, 17);
            proxy.bind(peer, wildcard(5001));
            proxy.sendto(peer, Uint8Array.of(8), ipv4Address(Uint8Array.of(127, 0, 0, 1), 5000));
            await tick();
            expect(seen).toEqual([[id, FD_READ, 0]]);
            expect(proxy.receive(id, 4).data[0]).toBe(8);
            expect(proxy.enumEvents(id).mask).toBe(FD_READ);
            proxy.closesocket(peer);

            const second = proxy.socket(2, 2, 17);
            proxy.bind(second, wildcard(5002));
            const two = throughCodec(capture());
            expect(two.datagrams.map(item => item.config.binding!.port).sort()).toEqual([5000, 5002]);
            proxy.closesocket(id); proxy.closesocket(second);
            const hold = proxy.socket(2, 2, 17);
            proxy.bind(hold, wildcard(5002));
            expect(proxy.restoreIdleDatagrams(two.datagrams, notifierFor)).toEqual({ failed: { handle: second, error: WSA.EADDRINUSE } });
            expect(proxy.openForSavestate().idle.map(item => item.handle)).toEqual([hold]);
            expect(() => restore(two)).toThrow(`winsock: the fresh session is not idle: socket ${hex(hold)} (UDP, bound to port 5002)`);
            proxy.closesocket(hold);
            expect(proxy.openForSavestate()).toMatchObject({ count: 0, idle: [] });

            for (let round = 0; round < 50; round++) {
                const handle = proxy.socket(2, 2, 17);
                proxy.bind(handle, wildcard(5000));
                proxy.configureEvents(handle, FD_READ, () => undefined, round % 2 ? WINDOW : { kind: "event", handle: 9 });
                const snapshot = throughCodec(capture());
                proxy.closesocket(handle);
                restore(snapshot);
                proxy.closesocket(handle);
            }
            expect(proxy.openForSavestate()).toMatchObject({ count: 0, idle: [] });
        } finally { channel.port1.close(); worker.terminate(); }
    }, 20000);
});
