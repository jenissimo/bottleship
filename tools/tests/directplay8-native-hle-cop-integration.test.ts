/**
 * Component/HLE regression for remote binary Host completion and buffer lifetime.
 * Real binary C1/C2/C3/E0/SACK/E1; only the existing Process/callbackManager guest
 * execution seam and in-memory carrier are modeled. No Windows/thread/shipping claim.
 */
import { expect, test } from "bun:test";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { PROTO_UDP, decodeDatagram, encodeDatagram } from "../../src/worker/net/netplay-wire";
import { NativeHostBackend } from "../../src/worker/modules/dpnet/native-wire/host-backend";
import { NativeDirectPlayCore } from "../../src/worker/modules/dpnet/native-wire/core";
import { decodeNativeProtocolFrame, DN } from "../../src/worker/modules/dpnet/native-wire/frame-codec";
import { DirectPlay8Session } from "../../src/worker/modules/dpnet/peer";
import { DirectPlay8Callbacks } from "../../src/worker/modules/dpnet/callbacks";
import { DirectPlayCallbackExecutor } from "../../src/worker/modules/dpnet/executor";
import { DirectPlayAddressApi } from "../../src/worker/modules/dpnet/address-api";
import { DPN } from "../../src/worker/modules/dpnet/constants";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import type { Process } from "../../src/worker/core/process";
import type { ThunkImplementation, ThunkResult, X86Context } from "../../src/worker/core/thunking/thunk-dispatcher";
import type { SessionDesc } from "../../src/worker/modules/dplayx/session";
import type { DirectPlay8HostReady } from "../../src/worker/modules/dpnet/backend";

interface Invocation {
    args: number[];
    thread: number;
    enteredOrder: number;
    returnCalls: number;
    returnOrder: number;
    done(value: number): number | null;
}
interface WireReceipt {
    phase: string;
    source: number;
    kind: "data" | "ack" | "control";
    command: number;
    sequence?: number;
    nextReceive?: number;
    coreCommand?: number;
    coreHandle?: number;
    payload: Uint8Array;
    sentOrder: number;
    delivered: boolean;
    deliveryOrder: number;
    deliveredWhileReceiveHeld: boolean;
    callbackReturnCallsAtSend: number;
}
const description: SessionDesc = {
    instance: "00112233445566778899aabbccddeeff",
    application: "11223344556677889900aabbccddeeff",
    name: "Remote HLE COP component", password: "", maxPlayers: 2, flags: 0,
    user: [0, 0, 0, 0], extended: { flags: 0, reserved: [], application: [] },
};
const context = () => ({
    eax: 0, ebx: 1, ecx: 2, edx: 3, edi: 4, esi: 5, ebp: 6,
    esp: 0x2000, eip: 0x7000, eflags: 0x202,
}) as X86Context;
const word = (bytes: Uint8Array, offset = 0) =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
async function turns() { for (let i = 0; i < 32; i++) await Promise.resolve(); }
function observe(result: Promise<number>) {
    const values: number[] = [];
    const promise = result.then(value => { values.push(value); return value; });
    void promise.catch(() => {}); // Failure-path cleanup must not leave an unhandled rejection.
    return { values, promise };
}

test("remote binary Host to HLE separates carrier ACK, actual callback return, and retained ReturnBuffer", async () => {
    const system = System.getInstance(), scheduler = system.scheduler;
    const original = {
        process: system.process, create: scheduler.createThread,
        id: scheduler.getThreadIdByHandle, current: scheduler.getCurrentThreadId,
    };
    const mainThread = 1, callbackThread = 100;
    const ram = new Uint8Array(8 << 20), empty = new Uint8Array();
    const frees: number[] = [], handlers: ThunkImplementation[] = [], invocations: Invocation[] = [];
    const reset = new Set<() => void>(), wire: WireReceipt[] = [];
    const heldSacks: { row: WireReceipt; deliver(): void }[] = [];
    const nets = [41, 42].map(last => new LanNetwork(Uint8Array.of(2, 0, 0, 0, 0, last)));
    let current = mainThread, cursor = 0x600000, nextThread = callbackThread, order = 0;
    let phase = "setup", holdPeerSacks = false, activeReceive: Invocation | undefined;
    let process: Process | undefined, callbacks: DirectPlay8Callbacks | undefined;
    let executor: DirectPlayCallbackExecutor | undefined, addresses: DirectPlayAddressApi | undefined;
    let receiver: DirectPlay8Session | undefined, host: NativeHostBackend | undefined;

    try {
        const alloc = (size: number) => {
            const pointer = cursor; cursor += (size + 15) & ~15;
            if (cursor > ram.length) throw Error("Finite fixture memory exhausted");
            return pointer;
        };
        const generator = new ThunkGenerator(); generator.setBaseAddress(0x500000);
        process = {
            resetGeneration: 0, thunkGenerator: generator, getCurrentMemory: () => ram,
            memory: { alloc, allocSystemBlock: alloc, free: (pointer: number) => frees.push(pointer), freeSystemBlock() {} },
            addressSpace: { validateRange: (pointer: number, size: number, perms: string) =>
                pointer >= 0x1000 && pointer + size <= ram.length && (!perms.includes("x") || pointer === 0x7000) },
            resourceProvider: { unregisterKernelObject() {} },
            onReset: (listener: () => void) => { reset.add(listener); return () => reset.delete(listener); },
            dispatcher: {
                register: (_dll: string, _name: string, handler: ThunkImplementation) => handlers.push(handler),
                callbackManager: {
                    saveSuspendedThunkContext: () => 1, abandonSuspendedFrame() {},
                    getPendingCallback: (id: number) => invocations[id - 1],
                    invokeCallback: (_routine: number, args: number[], _cleanup: number, done: (value: number) => number | null) => {
                        if (invocations.length >= 32) throw Error("Finite fixture invocation cap");
                        invocations.push({ args, done, thread: current, enteredOrder: ++order, returnCalls: 0, returnOrder: 0 });
                        return { callbackId: invocations.length };
                    },
                },
            },
        } as unknown as Process;
        system.process = process; Mem.bind(() => ram);
        scheduler.createThread = () => nextThread++;
        scheduler.getThreadIdByHandle = handle => handle;
        scheduler.getCurrentThreadId = () => current;

        // Standard virtual-carrier address adaptation, using actual codec bytes.
        // ACKs are withheld only after C1/C2/C3 and released to the original Host.
        for (const [source, net] of nets.entries()) net.attach({
            send(frame) {
                const datagram = decodeDatagram(frame);
                if (!datagram || datagram.proto !== PROTO_UDP) throw Error("Actual UDP datagram required");
                const target = 1 - source;
                if (!nets[target].node.every((byte, i) => byte === datagram.node[i])) return false;
                const protocol = decodeNativeProtocolFrame(datagram.payload);
                if (!protocol || wire.length >= 512) throw Error("Finite actual DNET frame ledger");
                const payload = protocol.kind === "data" ? protocol.payload.slice() : new Uint8Array();
                const core = protocol.kind === "data" && (protocol.command & DN.USER1) && payload.length >= 4;
                const row: WireReceipt = {
                    phase, source, kind: protocol.kind, command: protocol.command, payload,
                    sequence: protocol.kind === "data" ? protocol.sequence : undefined,
                    nextReceive: protocol.kind === "control" ? undefined : protocol.nextReceive,
                    coreCommand: core ? word(payload) : undefined,
                    coreHandle: core && payload.length >= 8 ? word(payload, 4) : undefined,
                    sentOrder: ++order, delivered: false, deliveryOrder: 0,
                    deliveredWhileReceiveHeld: false, callbackReturnCallsAtSend: activeReceive?.returnCalls ?? 0,
                };
                wire.push(row);
                const bytes = encodeDatagram(datagram.proto, net.node, datagram.dstPort, datagram.srcPort, datagram.payload);
                const deliver = () => {
                    if (row.delivered) throw Error("Fixture delivery may not replay an ACK");
                    nets[target].receiveFrame(bytes);
                    row.delivered = true; row.deliveryOrder = ++order;
                    row.deliveredWhileReceiveHeld = !!activeReceive && activeReceive.returnCalls === 0;
                };
                if (holdPeerSacks && source === 1 && protocol.kind === "ack") {
                    if (heldSacks.length >= 64) throw Error("Finite held SACK cap");
                    heldSacks.push({ row, deliver });
                } else deliver();
                return true;
            }, close() {},
        });

        host = new NativeHostBackend(nets[0], 2000, 500);
        const provider = {
            prepare: async (request: { localPort: number }): Promise<DirectPlay8HostReady> => ({
                address: { node: [2, 1, 127, 0, 0, 1], port: request.localPort },
                allowIncoming: address => address.node.every((byte, i) => byte === nets[1].node[i]),
                url: address => "x-directplay:/hostname=127.0.0.1;port=" + address.port,
                release() {},
            }),
        };
        expect(await host.start(description, { name: "host", data: Uint8Array.of(0) },
            provider, 57140, () => ({ hr: DPN.OK }), () => {})).toBe(DPN.OK);
        receiver = new DirectPlay8Session(nets[1]);
        expect(receiver.initialize()).toBe(DPN.OK);
        addresses = new DirectPlayAddressApi(process, () => ({}), nets[1]);
        callbacks = new DirectPlay8Callbacks(process, receiver, addresses, 0x7000, 0x1234);
        receiver.onEvent = event => callbacks!.emit(event);
        executor = callbacks.queue.executor;
        expect(await receiver.connectNative({ node: [...nets[0].node], port: 57140 },
            description, 0x5401, new Uint8Array(), 57141, [20, 0, 500, 14, 2000])).toBe(DPN.OK);
        expect(receiver.engine).toBeInstanceOf(NativeDirectPlayCore);
        expect(receiver.localId).not.toBe(host.localId);
        expect(host.entities.has(receiver.localId)).toBe(true);
        expect(receiver.engine.entities.has(host.localId)).toBe(true);

        const enter = () => {
            expect(handlers).toHaveLength(1);
            current = callbackThread;
            const before = invocations.length;
            const result = handlers[0](context(), ram, []) as ThunkResult;
            expect(result.suspendedForCallback).toBe(true);
            expect(invocations).toHaveLength(before + 1);
            const invocation = invocations[before];
            expect(invocation.thread).toBe(callbackThread);
            expect(invocation.args[0]).toBe(0x1234);
            return invocation;
        };
        const returned = (invocation: Invocation, result: number) => {
            expect(invocation.returnCalls).toBe(0);
            current = invocation.thread;
            invocation.returnCalls++; invocation.returnOrder = ++order;
            expect(invocation.done(result)).toBe(1);
        };
        // Drain only handshake callbacks through their real executor/queue invocations.
        for (let n = 0; callbacks.pending; n++) {
            if (n >= 16) throw Error("Finite handshake callback drain");
            const invocation = enter();
            expect(invocation.args[1] & 0xffff).not.toBe(0x11);
            returned(invocation, DPN.OK);
        }
        await turns();
        expect(callbacks.pending).toBe(0);
        for (const code of [0xc1, 0xc2, 0xc3])
            expect(wire.some(row => row.coreCommand === code && row.delivered)).toBe(true);

        const receive = (payload: Uint8Array) => {
            const invocation = enter();
            expect(invocation.args[1] >>> 0).toBe(0xffff0011);
            expect(executor!.inCallback).toBe(true);
            const allocation = invocation.args[2], pointer = Mem.readUint32(allocation + 12)!;
            const size = Mem.readUint32(allocation + 16)!, handle = Mem.readUint32(allocation + 20)!;
            expect(Mem.readUint32(allocation)).toBe(28);
            expect(Mem.readUint32(allocation + 4)).toBe(host!.localId);
            expect(Mem.readUint32(allocation + 24)).toBe(1);
            expect(pointer).toBe(allocation + 28); expect(size).toBe(payload.length); expect(handle).toBeGreaterThan(0);
            expect(Mem.readBytes(pointer, size)).toEqual(payload);
            expect(frees).not.toContain(allocation);
            activeReceive = invocation;
            return { invocation, allocation, pointer, size, handle };
        };
        const releaseActualSack = (data: WireReceipt) => {
            const selected = heldSacks.filter(item => item.row.nextReceive === ((data.sequence! + 1) & 255));
            expect(selected.length).toBeGreaterThan(0);
            current = mainThread;
            for (const item of selected) {
                expect(item.row.source).toBe(1); expect(item.row.kind).toBe("ack");
                expect(item.row.delivered).toBe(false);
                item.deliver();
                expect(item.row.delivered).toBe(true);
                expect(item.row.deliveredWhileReceiveHeld).toBe(true);
                expect(item.row.deliveryOrder).toBeGreaterThan(activeReceive!.enteredOrder);
                heldSacks.splice(heldSacks.indexOf(item), 1);
            }
            return selected.map(item => item.row);
        };
        const e1 = () => wire.filter(row => row.source === 1 && row.coreCommand === 0xe1);

        phase = "ordinary"; holdPeerSacks = true;
        const ordinaryPayload = Uint8Array.of(0x41, 0, 0x7f, 0x21);
        const ordinary = observe(host.sendDpn(receiver.localId, 8, ordinaryPayload));
        const ordinaryData = wire.find(row => row.phase === phase && row.source === 0 &&
            row.kind === "data" && !(row.command & DN.USER1) && row.payload.every((byte, i) => byte === ordinaryPayload[i]) &&
            row.payload.length === ordinaryPayload.length)!;
        expect(ordinaryData).toBeTruthy();
        expect(ordinaryData.command & (DN.RELIABLE | DN.NEW_MESSAGE | DN.END_MESSAGE))
            .toBe(DN.RELIABLE | DN.NEW_MESSAGE | DN.END_MESSAGE);
        const ordinaryReceive = receive(ordinaryPayload);
        await turns(); expect(ordinary.values).toEqual([]);
        expect(ordinaryReceive.invocation.returnCalls).toBe(0); expect(e1()).toEqual([]);
        releaseActualSack(ordinaryData);
        await turns(); expect(ordinary.values).toEqual([DPN.OK]);
        expect(await ordinary.promise).toBe(DPN.OK);
        expect(ordinaryReceive.invocation.returnCalls).toBe(0);
        expect(Mem.readBytes(ordinaryReceive.pointer, ordinaryReceive.size)).toEqual(ordinaryPayload);
        expect(frees).not.toContain(ordinaryReceive.allocation);
        returned(ordinaryReceive.invocation, DPN.OK); activeReceive = undefined;
        expect(frees.filter(pointer => pointer === ordinaryReceive.allocation)).toHaveLength(1);
        expect(heldSacks).toHaveLength(0); expect(e1()).toEqual([]);

        phase = "cop";
        const copPayload = Uint8Array.of(0x42, 0, 0x81, 0x22, 0xff);
        const cop = observe(host.sendDpn(receiver.localId, 12, copPayload));
        const envelope = wire.find(row => row.phase === phase && row.source === 0 && row.coreCommand === 0xe0)!;
        expect(envelope).toBeTruthy(); expect(envelope.coreHandle).toBeGreaterThan(0);
        expect(envelope.payload.slice(8)).toEqual(copPayload);
        expect(envelope.command & (DN.RELIABLE | DN.NEW_MESSAGE | DN.END_MESSAGE))
            .toBe(DN.RELIABLE | DN.NEW_MESSAGE | DN.END_MESSAGE);
        const retained = receive(copPayload);
        await turns(); expect(cop.values).toEqual([]);
        const sacks = releaseActualSack(envelope);
        // These are actual SACK bytes already delivered to the original Host, not a turn count.
        expect(sacks.every(row => row.delivered)).toBe(true);
        await turns(); expect(cop.values).toEqual([]);
        expect(retained.invocation.returnCalls).toBe(0); expect(e1()).toEqual([]);
        expect(Mem.readBytes(retained.pointer, retained.size)).toEqual(copPayload);
        expect(frees).not.toContain(retained.allocation);

        returned(retained.invocation, DPN.PENDING);
        await turns();
        const completions = e1();
        expect(completions).toHaveLength(1);
        expect(completions[0].payload.length).toBe(8);
        expect(completions[0].coreHandle).toBe(envelope.coreHandle);
        expect(completions[0].delivered).toBe(true);
        expect(completions[0].callbackReturnCallsAtSend).toBe(1);
        expect(completions[0].sentOrder).toBeGreaterThan(retained.invocation.returnOrder);
        expect(cop.values).toEqual([DPN.OK]); expect(await cop.promise).toBe(DPN.OK);
        expect(Mem.readUint32(retained.allocation + 12)).toBe(retained.pointer);
        expect(Mem.readUint32(retained.allocation + 20)).toBe(retained.handle);
        expect(Mem.readBytes(retained.pointer, retained.size)).toEqual(copPayload);
        expect(frees).not.toContain(retained.allocation);

        current = mainThread;
        expect(current).not.toBe(retained.invocation.thread);
        expect(executor.inCallback).toBe(false);
        expect(callbacks.returnBuffer(retained.handle)).toBe(DPN.OK);
        expect(frees.filter(pointer => pointer === retained.allocation)).toHaveLength(1);
        expect(callbacks.returnBuffer(retained.handle)).toBe(DPN.INVALIDHANDLE);
        expect(frees.filter(pointer => pointer === retained.allocation)).toHaveLength(1);
        await turns();
        expect(cop.values).toEqual([DPN.OK]); expect(e1()).toHaveLength(1);
        expect(retained.invocation.returnCalls).toBe(1);
        // No retained-pointer reads after ReturnBuffer.
        activeReceive = undefined;
    } finally {
        // Reset discards any failed-test active invocation before restoring fixture globals.
        try { callbacks?.close(); } finally {
            try { executor?.reset(); } finally {
                try { receiver?.dispose(); } finally {
                    try { host?.dispose(); } finally {
                        addresses?.reset();
                        for (const net of nets) net.attach(null);
                        scheduler.createThread = original.create;
                        scheduler.getThreadIdByHandle = original.id;
                        scheduler.getCurrentThreadId = original.current;
                        system.process = original.process;
                        Mem.bind(() => system.process?.getCurrentMemory() ?? empty);
                    }
                }
            }
        }
    }
}, 5000);
