/**
 * Secondary host-only protocol invariants. A deterministic raw mailbox responder
 * exercises the actual actor facade parser; it is not UDP/native causality proof.
 * No Worker, namespace, guest pointer, OS socket or network service is created.
 */
import {expect, test} from "bun:test";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {WsaFailure, WsaUdpReceiveFailure, WSA} from "../../src/worker/modules/wsa-network";
import {copyActorUdpReceiveError, WSA_ACTOR_ERROR, WSA_ACTOR_HEADER_BYTES,
    type WsaActorUdpReceiveError} from "../../src/worker/modules/wsa-actor-protocol";

function metadata(family: 2 | 23 = 2): WsaActorUdpReceiveError {
    return {version: 1, family, address: family === 2 ? [127, 0, 0, 1] : [...new Array<number>(15).fill(0), 1],
        node: [2, 0, 0, 1, 2, 3], port: 54321,
        ...(family === 23 ? {scopeId: 0, flowInfo: 0} : {})};
}
function thrown(call: () => unknown): unknown {
    try { call(); } catch (error) { return error; }
    throw Error("Expected actual facade receive to fail");
}
/** Complete a real facade mailbox synchronously, before it could Atomics.wait. */
function rawErrorFacade(text: string) {
    const requests: string[] = [];
    const port = {
        onmessage: null,
        addEventListener() {},
        start() {},
        postMessage(request: {command: string; mailbox: SharedArrayBuffer}) {
            if (request.command !== "receive") throw Error("Unexpected protocol-test command: " + request.command);
            requests.push(request.command);
            const bytes = new TextEncoder().encode(text);
            if (bytes.length > request.mailbox.byteLength - WSA_ACTOR_HEADER_BYTES) throw Error("Protocol fixture quota");
            new Uint8Array(request.mailbox, WSA_ACTOR_HEADER_BYTES, bytes.length).set(bytes);
            const header = new Int32Array(request.mailbox, 0, WSA_ACTOR_HEADER_BYTES / 4);
            Atomics.store(header, 1, bytes.length);
            Atomics.store(header, 0, WSA_ACTOR_ERROR);
            Atomics.notify(header, 0);
        },
    } as unknown as MessagePort;
    const table = createWsaActorTable(new LanNetwork(), {pid: 1234, slot: 0, epoch: 1, port});
    return {table, requests};
}

test("UDP error metadata preserves all original bytes and owns plain-array inputs", () => {
    const input = metadata(23), copy = copyActorUdpReceiveError(input)!;
    expect(copy).toEqual(input);
    expect(copy.address).not.toBe(input.address); expect(copy.node).not.toBe(input.node);
    input.address[15] = 9; input.node[5] = 9; input.scopeId = 9;
    expect(copy.address[15]).toBe(1); expect(copy.node[5]).toBe(3); expect(copy.scopeId).toBe(0);
    copy.address[0] = 7; copy.node[0] = 7;
    expect(input.address[0]).toBe(0); expect(input.node[0]).toBe(2);
    const edge = metadata(23); edge.scopeId = 0xffffffff; edge.flowInfo = 0xffffffff; edge.port = 65535;
    expect(copyActorUdpReceiveError(edge)).toEqual(edge);
});

for (const family of [2, 23] as const) test(`actual actor ERROR parser restores an owned AF${family} failure and repeated calls do not alias`, () => {
    const value = metadata(family), fixture = rawErrorFacade(JSON.stringify({error: WSA.ECONNRESET, udpReceive: value}));
    const first = thrown(() => fixture.table.receive(7, 1));
    expect(first).toBeInstanceOf(WsaUdpReceiveFailure);
    if (!(first instanceof WsaUdpReceiveFailure)) throw Error("Missing typed error");
    expect(first.code).toBe(WSA.ECONNRESET); expect(first.from.family).toBe(family); expect(first.from.port).toBe(value.port);
    expect(first.from.node).toEqual(Uint8Array.from(value.node));
    expect(family === 2 ? first.from.ip : first.from.ip6).toEqual(Uint8Array.from(value.address));
    first.from.node.fill(9);
    (family === 2 ? first.from.ip! : first.from.ip6!).fill(9);
    value.address.fill(8); value.node.fill(8);
    const next = thrown(() => fixture.table.receive(7, 1));
    expect(next).toBeInstanceOf(WsaUdpReceiveFailure);
    if (!(next instanceof WsaUdpReceiveFailure)) throw Error("Missing repeated typed error");
    expect(next.from.node).toEqual(Uint8Array.from(metadata(family).node));
    expect(family === 2 ? next.from.ip : next.from.ip6).toEqual(Uint8Array.from(metadata(family).address));
    expect(fixture.requests).toEqual(["receive", "receive"]);
});

for (const badByte of [383, -129, 127.5]) test(`address byte${badByte} cannot clamp into127 before provenance validation`, () => {
    const bad = metadata(); bad.address[0] = badByte;
    // Demonstrate the actual lossy conversion that this boundary must prevent.
    expect(Uint8Array.from(bad.address)).toEqual(Uint8Array.from(metadata().address));
    expect(copyActorUdpReceiveError(bad)).toBeUndefined();
    const fixture = rawErrorFacade(JSON.stringify({error: WSA.ECONNRESET, udpReceive: bad}));
    const error = thrown(() => fixture.table.receive(7, 1));
    expect(error).toBeInstanceOf(WsaFailure); expect(error).not.toBeInstanceOf(WsaUdpReceiveFailure);
    expect((error as WsaFailure).code).toBe(WSA.ENETDOWN);
    // Invalid provenance fences the facade, rather than accepting a next reply.
    const again = thrown(() => fixture.table.receive(7, 1));
    expect((again as WsaFailure).code).toBe(WSA.ENETDOWN);
    expect(fixture.requests).toEqual(["receive"]);
});

const malformed: Array<{name: string; value: unknown}> = [
    {name: "wrong address width", value: {...metadata(), address: [127, 0, 1]}},
    {name: "wrong node width", value: {...metadata(), node: [2, 0, 0, 1, 2]}},
    {name: "node byte above255", value: {...metadata(), node: [258, 0, 0, 1, 2, 3]}},
    {name: "node negative byte", value: {...metadata(), node: [-254, 0, 0, 1, 2, 3]}},
    {name: "node fractional byte", value: {...metadata(), node: [2.5, 0, 0, 1, 2, 3]}},
    {name: "AF_INET scope even zero", value: {...metadata(), scopeId: 0}},
    {name: "AF_INET flow even zero", value: {...metadata(), flowInfo: 0}},
    {name: "unsupported family", value: {...metadata(), family: 4}},
    {name: "IPv6 family with IPv4 width", value: {...metadata(), family: 23}},
    {name: "zero port", value: {...metadata(), port: 0}},
    {name: "oversize port", value: {...metadata(), port: 65536}},
    {name: "fractional port", value: {...metadata(), port: 54321.5}},
    {name: "negative IPv6 scope", value: {...metadata(23), scopeId: -1}},
    {name: "oversize IPv6 flow", value: {...metadata(23), flowInfo: 0x100000000}},
    {name: "fractional IPv6 scope", value: {...metadata(23), scopeId: 0.5}},
    {name: "foreign version", value: {...metadata(), version: 2}},
    {name: "extra metadata keys", value: {...metadata(), lastDestination: metadata()}},
    {name: "general byte reviver object", value: {...metadata(), address: {$wsaBytes: [383, 0, 0, 1]}}},
];
for (const {name, value} of malformed) test(`actual actor ERROR raw JSON refuses${name} without address promotion`, () => {
    expect(copyActorUdpReceiveError(value)).toBeUndefined();
    const fixture = rawErrorFacade(JSON.stringify({error: WSA.ECONNRESET, udpReceive: value}));
    const error = thrown(() => fixture.table.receive(7, 1));
    expect(error).toBeInstanceOf(WsaFailure); expect(error).not.toBeInstanceOf(WsaUdpReceiveFailure);
    expect((error as WsaFailure).code).toBe(WSA.ENETDOWN); expect(fixture.requests).toEqual(["receive"]);
});

test("malformed typed errors are distinct from ordinary code-only Winsock failure", () => {
    for (const errorCode of [WSA.ECONNRESET, WSA.EFAULT]) {
        const ordinary = rawErrorFacade(JSON.stringify({error: errorCode}));
        const error = thrown(() => ordinary.table.receive(7, 1));
        expect(error).toBeInstanceOf(WsaFailure); expect(error).not.toBeInstanceOf(WsaUdpReceiveFailure);
        expect((error as WsaFailure).code).toBe(errorCode);
    }
    for (const errorCode of [WSA.EFAULT, "10054"]) {
        const wrongStatus = rawErrorFacade(JSON.stringify({error: errorCode, udpReceive: metadata()}));
        const error = thrown(() => wrongStatus.table.receive(7, 1));
        expect(error).toBeInstanceOf(WsaFailure); expect(error).not.toBeInstanceOf(WsaUdpReceiveFailure);
        expect((error as WsaFailure).code).toBe(WSA.ENETDOWN);
    }
});

test("non-JSON array/object prototypes, sparse arrays and nonfinite values never gain a typed origin", () => {
    const hole = metadata(); delete hole.address[1];
    const foreign = Object.assign(Object.create(null), metadata());
    const typed = {...metadata(), address: Uint8Array.of(127, 0, 0, 1)};
    expect(copyActorUdpReceiveError(hole)).toBeUndefined();
    expect(copyActorUdpReceiveError(foreign)).toBeUndefined();
    expect(copyActorUdpReceiveError(typed)).toBeUndefined();
    for (const byte of [NaN, Infinity, -Infinity]) {
        const bad = metadata(); bad.address[0] = byte;
        expect(copyActorUdpReceiveError(bad)).toBeUndefined();
        const fixture = rawErrorFacade(JSON.stringify({error: WSA.ECONNRESET, udpReceive: bad}));
        expect(thrown(() => fixture.table.receive(7, 1))).not.toBeInstanceOf(WsaUdpReceiveFailure);
    }
});
