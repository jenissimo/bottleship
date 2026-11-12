import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Process } from "../../src/worker/core/process";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { LanNetwork, lanNetwork } from "../../src/worker/net/lan-network";
import { Wsock32 } from "../../src/worker/modules/wsock32";
import { Ws2_32 } from "../../src/worker/modules/ws2_32";
import { getWsaProcessState, wsaAsyncTaskCounter } from "../../src/worker/modules/wsa-stub-shared";
import { WsaSocketTable, WsaFailure, WSA } from "../../src/worker/modules/wsa-network";
import { WsaActorKernel } from "../../src/worker/modules/wsa-actor-kernel";
import { createWsaActorTable } from "../../src/worker/modules/wsa-actor-table";
import { getWsaOverlapped } from "../../src/worker/modules/wsa-overlapped";
import { reserveControlApc } from "../../src/worker/modules/wsa-control-apc";
import {
    captureWinsockSavestate, restoreWinsockSavestate, registerWinsockSavestate,
    WINSOCK_PROCESS_FIELDS, WS2_32_FIELDS, WSOCK32_FIELDS, type WinsockState,
} from "../../src/worker/modules/wsa-savestate";
import { CaptureRefusal } from "../../src/worker/savestate/object-codecs";
import { savestateParticipants } from "../../src/worker/savestate/participant";
import { decodeValue, encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";

const disposers: Array<() => void> = [];
afterEach(() => { for (const fn of disposers.splice(0).reverse()) fn(); });
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};
const throughCodec = <T>(v: T): T => decodeValue(encodeValue(v as SaveValue)) as T;
const NOT_IDLE = "winsock: not idle, 1 thing(s) open: ";

interface Stub { dllName: string; functionName: string; address: number; }

function session() {
    const memory = new Uint8Array(0x100000), view = new DataView(memory.buffer);
    let allocation = 0x10000, tid = 1;
    const allocated: number[] = [], freed: number[] = [], stubs: Stub[] = [];
    const process = Object.create(Process.prototype) as Process;
    Object.assign(process as object, {
        resetGeneration: 0,
        memory: { alloc(size: number) { const ptr = allocation; allocation += size + 16; allocated.push(ptr); return ptr; }, free(ptr: number) { freed.push(ptr); } },
        addressSpace: {
            validateRange: (ptr: number, length: number) => ptr > 0 && ptr + length <= memory.length,
            write: (ptr: number, data: Uint8Array) => { memory.set(data, ptr); return data.length; },
        },
        onReset: () => () => undefined,
        thunkGenerator: { captureState: () => ({ stubs }) },
    });
    const wsock32 = new Wsock32(), ws2_32 = new Ws2_32();
    wsock32.initialize(process); ws2_32.initialize(process);
    const state = getWsaProcessState(process);
    const call = (module: Wsock32 | Ws2_32, name: string, args: number[]) =>
        (module.exports[name] as (ctx: unknown, mem: Uint8Array, args: number[]) => unknown)({ esp: 0x800 }, memory, args) as number;
    const text = (ptr: number, value: string) => { memory.set(new TextEncoder().encode(value + "\0"), ptr); return ptr; };
    const sockaddr = (ptr: number, port: number) => { view.setUint16(ptr, 2, true); view.setUint16(ptr + 2, port, false); view.setUint32(ptr + 4, 0); return ptr; };
    disposers.push(() => state.reset());
    return {
        process, state, wsock32, ws2_32, call, text, sockaddr, view, memory, allocated, freed, stubs,
        thread(value: number) { tid = value; }, currentThread: () => tid,
        capture: () => captureWinsockSavestate(process, state),
        restore: (saved: WinsockState) => restoreWinsockSavestate(process, state, saved),
    };
}

function environment() {
    let current: ReturnType<typeof session> | undefined;
    const scheduler = System.getInstance().scheduler, errors = new Map<number, number>(), messages: number[][] = [];
    const spies = [
        spyOn(scheduler, "getCurrentThreadId").mockImplementation(() => current?.currentThread() ?? 1),
        spyOn(scheduler, "getLastError").mockImplementation(() => errors.get(current?.currentThread() ?? 1) ?? 0),
        spyOn(scheduler, "setLastError").mockImplementation(code => { errors.set(current?.currentThread() ?? 1, code); }),
        spyOn(scheduler, "setLastErrorForThread").mockImplementation((id, code) => { errors.set(id, code); return true; }),
        spyOn(scheduler, "wakeMessageWaiters").mockImplementation(() => undefined),
        spyOn(System.getInstance().windowManager, "postMessage").mockImplementation((...args) => { messages.push(args as number[]); }),
    ];
    const counter = wsaAsyncTaskCounter();
    disposers.push(() => { for (const spy of spies) spy.mockRestore(); wsaAsyncTaskCounter(counter); });
    return {
        messages,
        open() { const s = session(); current = s; Mem.bind(() => s.memory); return s; },
        use(s: ReturnType<typeof session>) { current = s; Mem.bind(() => s.memory); },
    };
}

async function used(env: ReturnType<typeof environment>) {
    const s = env.open();
    expect(s.call(s.wsock32, "WSAStartup", [0x0101, 0x1000])).toBe(0);
    expect(s.call(s.ws2_32, "WSAStartup", [0x0202, 0x1000])).toBe(0);
    const socket = s.call(s.ws2_32, "socket", [2, 2, 17]);
    expect(s.call(s.wsock32, "closesocket", [socket])).toBe(0);
    const hostent = s.call(s.wsock32, "gethostbyname", [s.text(0x3000, "localhost")]);
    s.thread(2);
    const dotted = s.call(s.ws2_32, "inet_ntoa", [0x0100007f]);
    s.thread(1);
    const protoent = s.call(s.wsock32, "getprotobyname", [s.text(0x3100, "tcp")]);
    const servent = s.call(s.ws2_32, "getservbyname", [s.text(0x3200, "http"), 0]);
    expect(s.call(s.ws2_32, "getaddrinfo", [0x3000, 0, 0, 0x3300])).toBe(0);
    const task = s.call(s.wsock32, "WSAAsyncGetHostByName", [5, 0x400, 0x3000, 0x4000, 1024]);
    await tick();
    return { ...s, socket, hostent, dotted, protoent, servent, chain: s.view.getUint32(0x3300, true), task };
}

describe("winsock idle participant", () => {
    test("both modules register one participant that covers wsock32 and ws2_32, with a pinned schema", () => {
        const env = environment(), s = env.open();
        const undo = registerWinsockSavestate(s.process, s.state);
        try {
            const covered = savestateParticipants.coveredModules();
            expect([covered.has("wsock32"), covered.has("ws2_32")]).toEqual([true, true]);
            expect(savestateParticipants.schemas().winsock).toEqual({ version: 1, schemaHash: "15198a623a60eea0" });
            const participant = savestateParticipants.all().find(p => p.id === "winsock")!;
            expect(participant.order).toBe(77);
            expect(participant.capture({} as never)).toEqual(s.capture() as unknown as SaveValue);
            s.call(s.ws2_32, "WSAStartup", [0x0202, 0x1000]);
            s.call(s.ws2_32, "socket", [2, 1, 6]);
            expect(() => participant.capture({} as never)).toThrow(CaptureRefusal);
        } finally {
            undo();
        }
        expect(savestateParticipants.coveredModules().has("ws2_32")).toBe(false);
    });

    test("the modules register on initialize when savestates are enabled", () => {
        const env = environment(), flags = globalThis as { __savestates?: unknown }, before = flags.__savestates;
        flags.__savestates = true;
        try {
            env.open();
            expect(savestateParticipants.all().filter(p => p.id === "winsock").length).toBe(1);
        } finally {
            flags.__savestates = before;
            for (const p of savestateParticipants.all().filter(p => p.id === "winsock")) savestateParticipants.add(p)();
        }
        expect(savestateParticipants.all().some(p => p.id === "winsock")).toBe(false);
    });

    test("every module field and every process-state field has a policy", () => {
        const env = environment(), s = env.open();
        expect(Object.keys(new Wsock32()).sort()).toEqual(Object.keys(WSOCK32_FIELDS).sort());
        expect(Object.keys(new Ws2_32()).sort()).toEqual(Object.keys(WS2_32_FIELDS).sort());
        expect(Object.keys(s.state).sort()).toEqual(Object.keys(WINSOCK_PROCESS_FIELDS).sort());
    });

    test("an untouched module saves its initial state", () => {
        const env = environment(), s = env.open();
        expect(s.capture()).toEqual({
            startups: 0, version: 0x0202, nextSocket: 0x10000000, nextAsyncTask: wsaAsyncTaskCounter(),
            hostent: [], protoent: 0, servent: 0, addrinfo: [],
        });
    });

    test("capture → codec → restore → capture is byte-identical in a fresh session", async () => {
        const env = environment(), first = await used(env), saved = first.capture();
        expect(saved).toEqual({
            startups: 2, version: 0x0101, nextSocket: first.socket + 1, nextAsyncTask: first.task + 1,
            hostent: [[1, first.hostent], [2, first.dotted - 4080]],
            protoent: first.protoent, servent: first.servent, addrinfo: [[first.chain, [first.chain]]],
        });
        wsaAsyncTaskCounter(1);
        const fresh = env.open();
        fresh.restore(throughCodec(saved));
        expect(bytes(fresh.capture())).toBe(bytes(saved));
    });

    test("every saved field reaches the capture and survives a restore", async () => {
        const env = environment(), base = (await used(env)).capture();
        const values: WinsockState = {
            startups: 5, version: 0x0002, nextSocket: 0x10000400, nextAsyncTask: 77,
            hostent: [[3, 0x50000], [9, 0x51000]], protoent: 0x52000, servent: 0x53000,
            addrinfo: [[0x54000, [0x54000, 0x54100]], [0x55000, [0x55000]]],
        };
        expect(Object.keys(values).sort()).toEqual(Object.keys(base).sort());
        for (const [field, value] of Object.entries(values) as Array<[keyof WinsockState, unknown]>) {
            expect({ field, same: bytes(value) === bytes(base[field]) }).toEqual({ field, same: false });
            const fresh = env.open();
            fresh.restore(throughCodec({ ...base, [field]: value }) as WinsockState);
            expect({ field, value: bytes(fresh.capture()[field]) }).toEqual({ field, value: bytes(value) });
        }
    });

    test("a restored session keeps its startups, buffers, chains and counters in use", async () => {
        const env = environment(), first = await used(env), saved = throughCodec(first.capture());
        wsaAsyncTaskCounter(1);
        const s = env.open();
        s.restore(saved);
        expect(s.allocated).toEqual([]);
        expect(s.call(s.wsock32, "gethostbyname", [s.text(0x3000, "localhost")])).toBe(first.hostent);
        s.thread(2);
        expect(s.call(s.wsock32, "inet_ntoa", [0x0100007f])).toBe(first.dotted);
        s.thread(1);
        expect(s.call(s.ws2_32, "getprotobyname", [s.text(0x3100, "udp")])).toBe(first.protoent);
        expect(s.call(s.wsock32, "getservbyname", [s.text(0x3200, "ftp"), 0])).toBe(first.servent);
        expect(s.allocated).toEqual([]);
        expect(s.call(s.ws2_32, "freeaddrinfo", [first.chain])).toBe(0);
        expect(s.freed).toEqual([first.chain]);
        const socket = s.call(s.wsock32, "socket", [2, 1, 6]);
        expect(socket).toBe(first.socket + 1);
        expect(s.call(s.ws2_32, "closesocket", [socket])).toBe(0);
        expect(s.call(s.ws2_32, "WSAAsyncGetHostByName", [5, 0x400, 0x3000, 0x4000, 1024])).toBe(first.task + 1);
        await tick();
        expect(s.call(s.ws2_32, "WSACleanup", [])).toBe(0);
        expect(s.state.counter.started).toBe(true);
        expect(s.call(s.wsock32, "WSACleanup", [])).toBe(0);
        expect(s.state.counter.started).toBe(false);
        expect(s.call(s.wsock32, "WSACleanup", [])).toBe(-1);
        expect(s.call(s.wsock32, "WSAStartup", [0x0202, 0x1000])).toBe(0);
        expect(s.call(s.wsock32, "socket", [2, 2, 17])).toBe(first.socket + 2);
    });

    test("an open socket refuses the save by kind and handle until it is closed", () => {
        const env = environment(), s = env.open(), hex = (n: number) => `0x${n.toString(16)}`;
        s.call(s.ws2_32, "WSAStartup", [0x0202, 0x1000]);
        const udp = s.call(s.ws2_32, "socket", [2, 2, 17]);
        expect(() => s.capture()).toThrow(`${NOT_IDLE}socket ${hex(udp)} (UDP)`);
        expect(s.call(s.ws2_32, "bind", [udp, s.sockaddr(0x2000, 1234), 16])).toBe(0);
        expect(() => s.capture()).toThrow(`${NOT_IDLE}socket ${hex(udp)} (UDP, bound to port 1234)`);
        expect(s.call(s.wsock32, "closesocket", [udp])).toBe(0);
        expect(s.capture().nextSocket).toBe(udp + 1);
        const tcp = s.call(s.wsock32, "socket", [2, 1, 6]);
        expect(s.call(s.wsock32, "bind", [tcp, s.sockaddr(0x2000, 4321), 16])).toBe(0);
        expect(s.call(s.wsock32, "listen", [tcp, 5])).toBe(0);
        expect(() => s.capture()).toThrow(`${NOT_IDLE}socket ${hex(tcp)} (TCP, listening on port 4321)`);
        s.state.table.setHandleFlags(tcp, 2, 2);
        expect(s.call(s.ws2_32, "closesocket", [tcp])).toBe(0);
        expect(() => s.capture()).toThrow(`socket ${hex(tcp)} (TCP, listening on port 4321)`);
        s.state.table.setHandleFlags(tcp, 2, 0);
        expect(s.call(s.ws2_32, "closesocket", [tcp])).toBe(0);
        expect(s.capture().startups).toBe(1);
        const ipx = s.call(s.wsock32, "socket", [6, 2, 1000]);
        expect(() => s.capture()).toThrow(`${NOT_IDLE}socket ${hex(ipx)} (IPX)`);
        expect(s.call(s.ws2_32, "WSACleanup", [])).toBe(0);
        expect(s.capture().startups).toBe(0);
    });

    test("WSAAsyncSelect and WSAEventSelect registrations live on a socket and go with it", () => {
        const env = environment(), s = env.open();
        s.call(s.ws2_32, "WSAStartup", [0x0202, 0x1000]);
        const selected = s.call(s.wsock32, "socket", [2, 2, 17]);
        expect(s.call(s.wsock32, "WSAAsyncSelect", [selected, 5, 0x400, 1])).toBe(0);
        expect(() => s.capture()).toThrow(`${NOT_IDLE}socket 0x${selected.toString(16)} (UDP)`);
        expect(s.call(s.wsock32, "closesocket", [selected])).toBe(0);
        expect(s.capture().startups).toBe(1);
        const event = s.call(s.ws2_32, "WSACreateEvent", []);
        disposers.push(() => System.getInstance().resourceProvider.unregisterKernelObject(event));
        expect(s.capture().startups).toBe(1);
        const watched = s.call(s.ws2_32, "socket", [2, 2, 17]);
        expect(s.call(s.ws2_32, "WSAEventSelect", [watched, event, 1])).toBe(0);
        expect(() => s.capture()).toThrow(`${NOT_IDLE}socket 0x${watched.toString(16)} (UDP)`);
        expect(s.call(s.ws2_32, "closesocket", [watched])).toBe(0);
        expect(s.capture().startups).toBe(1);
    });

    test("an asynchronous lookup refuses the save until it is published or cancelled", async () => {
        const env = environment(), s = env.open();
        s.call(s.wsock32, "WSAStartup", [0x0101, 0x1000]);
        const local = s.call(s.wsock32, "WSAAsyncGetHostByName", [5, 0x400, s.text(0x3000, "localhost"), 0x4000, 1024]);
        expect(() => s.capture()).toThrow(`${NOT_IDLE}asynchronous lookup 0x${local.toString(16)}`);
        await Promise.resolve();
        expect(env.messages).toEqual([]);
        expect(() => s.capture()).toThrow(`${NOT_IDLE}asynchronous lookup 0x${local.toString(16)}`);
        await tick();
        expect(env.messages.length).toBe(1);
        expect(s.capture().nextAsyncTask).toBe(local + 1);
        const resolver = spyOn(lanNetwork, "resolve").mockImplementation(() => new Promise(() => undefined));
        disposers.push(() => resolver.mockRestore());
        const remote = s.call(s.ws2_32, "WSAAsyncGetHostByName", [5, 0x400, s.text(0x3000, "far.example"), 0x4000, 1024]);
        await tick();
        expect(() => s.capture()).toThrow(`${NOT_IDLE}asynchronous lookup 0x${remote.toString(16)}`);
        expect(s.call(s.wsock32, "WSACancelAsyncRequest", [remote])).toBe(0);
        expect(s.capture().nextAsyncTask).toBe(remote + 1);
    });

    test("an open service lookup refuses the save until WSALookupServiceEnd", () => {
        const env = environment(), s = env.open();
        s.call(s.ws2_32, "WSAStartup", [0x0202, 0x1000]);
        s.text(0x6000, "example.test");
        s.view.setUint32(0x5000, 60, true); s.view.setUint32(0x5004, 0x6000, true); s.view.setUint32(0x5008, 0x6400, true); s.view.setUint32(0x5014, 12, true);
        s.memory.set(Uint8Array.of(3, 0xa8, 2, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46), 0x6400);
        s.view.setUint32(0x5020, 1, true); s.view.setUint32(0x5024, 0x6100, true); s.view.setUint32(0x6100, 2, true); s.view.setUint32(0x6104, 6, true);
        expect(s.call(s.ws2_32, "WSALookupServiceBeginA", [0x5000, 0x330, 0x6200])).toBe(0);
        const handle = s.view.getUint32(0x6200, true);
        expect(() => s.capture()).toThrow(`${NOT_IDLE}service lookup 0x${handle.toString(16)}`);
        expect(s.call(s.ws2_32, "WSALookupServiceEnd", [handle])).toBe(0);
        expect(s.capture().startups).toBe(1);
    });

    test("an unfinished overlapped request refuses the save and a finished one does not", async () => {
        const env = environment(), s = env.open();
        s.call(s.ws2_32, "WSAStartup", [0x0202, 0x1000]);
        const socket = s.call(s.ws2_32, "socket", [2, 2, 17]), provider = getWsaOverlapped(s.state.table, s.process);
        const answer = provider.issue(socket, 0x7000, 0, "read", () => { throw new WsaFailure(WSA.EWOULDBLOCK); }, () => []);
        expect(answer.error).toBe(997);
        expect(() => s.capture()).toThrow(`winsock: not idle, 2 thing(s) open: socket 0x${socket.toString(16)} (UDP), overlapped request 0x7000 on socket 0x${socket.toString(16)}`);
        expect(s.call(s.ws2_32, "closesocket", [socket])).toBe(0);
        expect(() => s.capture()).toThrow(`${NOT_IDLE}overlapped request 0x7000 on socket 0x${socket.toString(16)}`);
        await tick();
        expect(s.view.getUint32(0x7000, true)).not.toBe(259);
        expect(s.capture().startups).toBe(1);
    });

    test("a reserved control APC refuses the save until it is retired", () => {
        const env = environment(), s = env.open(), lifetime = reserveControlApc(s.process);
        expect(() => s.capture()).toThrow(`${NOT_IDLE}1 control APC(s)`);
        lifetime.onDiscard!();
        expect(s.capture().startups).toBe(0);
    });

    test("a provider entry point handed to the guest refuses the save", () => {
        const env = environment(), s = env.open();
        s.stubs.push({ dllName: "kernel32", functionName: "Sleep", address: 0x9000 });
        expect(s.capture().startups).toBe(0);
        s.stubs.push({ dllName: "__winsock", functionName: "AcceptEx", address: 0x9010 });
        expect(() => s.capture()).toThrow(`${NOT_IDLE}provider entry point AcceptEx at 0x9010`);
        s.stubs.length = 0;
        expect(s.capture().startups).toBe(0);
    });

    test("an installed Winsock 1.1 blocking hook refuses the save", () => {
        const env = environment(), s = env.open(), names = new Map<string, number>();
        const noop = () => 0;
        Object.assign(s.process as object, {
            getCurrentMemory: () => s.memory,
            modules: new Map([["user32", { name: "user32", exports: { PeekMessageA: noop, TranslateMessage: noop, DispatchMessageA: noop } }]]),
            thunkGenerator: {
                captureState: () => ({ stubs: s.stubs }),
                getExportAddress: (name: string) => names.get(name) ?? 0,
                allocateOneStub(dllName: string, functionName: string) {
                    const address = 0x9000 + s.stubs.length * 16;
                    names.set(dllName + ":" + functionName, address); s.stubs.push({ dllName, functionName, address });
                    return { address, code: Uint8Array.of(0xc3) };
                },
            },
            dispatcher: { register: () => undefined },
        });
        s.call(s.wsock32, "WSAStartup", [0x0101, 0x1000]);
        const previous = s.call(s.wsock32, "WSASetBlockingHook", [0x8000]);
        expect(previous).toBeGreaterThan(0);
        expect(() => s.capture()).toThrow("winsock: not idle, 4 thing(s) open: blocking hook 0x8000 of thread 1, provider entry point LegacyPeekMessage at 0x9000");
        expect(s.call(s.wsock32, "WSAUnhookBlockingHook", [])).toBe(0);
        expect(() => s.capture()).toThrow("winsock: not idle, 3 thing(s) open: provider entry point LegacyPeekMessage at 0x9000");
    });

    test("a provider that does not answer refuses the save", () => {
        const env = environment(), s = env.open(), table = s.state.table as unknown as { openForSavestate: () => unknown };
        table.openForSavestate = () => { throw new WsaFailure(WSA.ENETDOWN); };
        expect(() => s.capture()).toThrow(`${NOT_IDLE}the socket provider did not answer (`);
        table.openForSavestate = () => ({ count: 0 });
        expect(() => s.capture()).toThrow(`${NOT_IDLE}the socket provider did not answer (malformed answer)`);
    });

    test("more than four open things are counted and the list is cut", () => {
        const env = environment(), s = env.open();
        s.call(s.ws2_32, "WSAStartup", [0x0202, 0x1000]);
        const first = s.call(s.ws2_32, "socket", [2, 2, 17]), hex = (n: number) => `socket 0x${n.toString(16)} (UDP)`;
        for (let i = 1; i < 12; i++) s.call(s.ws2_32, "socket", [2, 2, 17]);
        expect(() => s.capture()).toThrow(`winsock: not idle, 12 thing(s) open: ${[0, 1, 2, 3].map(i => hex(first + i)).join(", ")}, …`);
    });

    test("a restore into a session that is not idle fails", async () => {
        const env = environment(), saved = (await used(env)).capture(), s = env.open();
        s.call(s.ws2_32, "WSAStartup", [0x0202, 0x1000]);
        const socket = s.call(s.ws2_32, "socket", [2, 2, 17]);
        expect(() => s.restore(saved)).toThrow(`winsock: the fresh session is not idle: socket 0x${socket.toString(16)} (UDP)`);
        expect(s.state.counter.captureState()).toEqual({ startups: 1, version: 0x0202 });
    });
});

describe("winsock idle check in the socket actor", () => {
    test("the kernel lists every descriptor and I/O lease of the asking process only", () => {
        const table = new WsaSocketTable(new LanNetwork(Uint8Array.of(2, 0, 0, 4, 5, 6))), kernel = new WsaActorKernel(table);
        const one = { pid: 11, slot: 0, epoch: 1 }, two = { pid: 12, slot: 1, epoch: 1 };
        kernel.register(one); kernel.register(two);
        const idle = { count: 0, open: [], nextHandle: 0x10000000 };
        expect(kernel.execute(one, "openForSavestate", [])).toEqual(idle);
        const socket = kernel.execute(one, "socket", [2, 2, 17]) as number, name = `socket 0x${socket.toString(16)} (UDP)`;
        expect(kernel.execute(one, "openForSavestate", [])).toEqual({ count: 1, open: [name], nextHandle: socket + 1 });
        expect(kernel.execute(two, "openForSavestate", [])).toEqual({ ...idle, nextHandle: socket + 1 });
        const copy = kernel.execute(one, "duplicate", [socket, 12]) as number;
        expect(kernel.execute(two, "openForSavestate", [])).toEqual({ count: 1, open: [`socket 0x${copy.toString(16)} (UDP)`], nextHandle: copy + 1 });
        kernel.execute(two, "reset", []);
        expect((kernel.execute(two, "openForSavestate", []) as { count: number }).count).toBe(1);
        const lease = kernel.execute(one, "acquireNativeIo", [socket, "data"], true) as number;
        expect(kernel.execute(one, "closesocket", [socket])).toBe(0);
        expect(kernel.execute(one, "openForSavestate", [])).toEqual({ count: 1, open: [`data operation on socket 0x${socket.toString(16)}`], nextHandle: copy + 1 });
        kernel.execute(one, "releaseNativeIo", [lease], true);
        expect((kernel.execute(one, "openForSavestate", []) as { count: number }).count).toBe(0);
        expect(kernel.execute(two, "closesocket", [copy], true)).toBe(0);
        expect((kernel.execute(two, "openForSavestate", []) as { count: number }).count).toBe(0);
        for (let i = 0; i < 10; i++) kernel.execute(one, "socket", [1, 2, 6]);
        const many = kernel.execute(one, "openForSavestate", []) as { count: number; open: string[] };
        expect([many.count, many.open.length]).toEqual([10, 8]);
        kernel.execute(one, "advanceHandles", [0x10000400]);
        kernel.execute(one, "advanceHandles", [0x10000100]);
        expect(kernel.execute(one, "socket", [2, 2, 17])).toBe(0x10000400);
        kernel.drop(one); kernel.drop(two);
    });

    test("the worker-side table asks the actor, not its local table", async () => {
        const worker = new Worker(new URL("./fixtures/dp4-listener-actor-worker.ts", import.meta.url).href, { type: "module" });
        const channel = new MessageChannel(), ready = new Promise<void>(resolve => { worker.onmessage = () => resolve(); });
        worker.postMessage({ port: channel.port2 }, [channel.port2]); await ready;
        const table = createWsaActorTable(new LanNetwork(), { port: channel.port1, pid: 1234, slot: 0, epoch: 1 });
        try {
            const state = { table, counter: { captureState: () => ({ startups: 1, version: 0x0202 }) }, buffers: { hostent: new Map(), protoent: 0, servent: 0, addrinfo: new Map() } };
            const process = { resetGeneration: 0 } as Process, capture = () => captureWinsockSavestate(process, state as never);
            expect(capture().nextSocket).toBe(0x10000000);
            const socket = table.socket(2, 2, 17);
            expect(table.openForSavestate()).toEqual({ count: 1, open: [`socket 0x${socket.toString(16)} (UDP)`], nextHandle: socket + 1 });
            expect(capture).toThrow(`${NOT_IDLE}socket 0x${socket.toString(16)} (UDP)`);
            table.closesocket(socket);
            expect(capture().nextSocket).toBe(socket + 1);
            table.advanceHandles(0x10000800);
            expect(table.socket(1, 2, 6)).toBe(0x10000800);
            table.closesocket(0x10000800);
            channel.port1.close();
            await new Promise(resolve => setTimeout(resolve, 20));
            expect(capture).toThrow(`${NOT_IDLE}the socket provider did not answer (`);
        } finally { channel.port1.close(); worker.terminate(); }
    }, 10000);
});
