import { describe, expect, test } from "bun:test";
import { encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { CPU_FIELDS, captureCpu, restoreCpu, type V86Cpu } from "../../src/worker/savestate/participants/cpu";
import { TimerWheel } from "../../src/worker/core/scheduler/timer-wheel";
import { TimerKind, ThreadState, WaitReason, type Thread } from "../../src/worker/core/scheduler/types";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import { AddressSpace } from "../../src/worker/core/memory/address-space";
import { MemoryManager } from "../../src/worker/core/process";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { ResourceTable } from "../../src/worker/core/resource-table";
import { newObjectGraph, restoreObjectGraph } from "../../src/worker/savestate/object-codecs";
import { registerCoreParticipants, touchedModules } from "../../src/worker/savestate/core-participants";
import { savestateParticipants, schemaHash, uncoveredModules } from "../../src/worker/savestate/participant";
import { captureKernel32State, restoreKernel32State } from "../../src/worker/modules/kernel32/savestate";
import { namedObjects } from "../../src/worker/modules/kernel32/named-objects";
import { captureAtoms } from "../../src/worker/modules/kernel32/atom";
import { consoleScreenBuffers } from "../../src/worker/modules/kernel32/console-screen-buffer";
import { System } from "../../src/worker/core/system";
import { TimeService } from "../../src/worker/runtime/time";

const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return { json: e.json, blobs: e.blobs.map(b => [...b]) };
};

function roundTrip<S>(capture: () => S, restore: (s: S) => void): void {
    const first = capture();
    const encoded = bytes(first);
    restore(structuredClone(first));
    expect(bytes(capture())).toEqual(encoded);
}

function fakeCpu(): V86Cpu {
    const cpu: Record<string, unknown> = {};
    let n = 1;
    for (const name of Object.keys(CPU_FIELDS)) {
        const arr = name === 'current_tsc' ? new Int32Array(2)
            : name === 'fpu_st' || name === 'last_result' ? new Float64Array(8)
            : name === 'sreg' || name === 'segment_access_bytes' ? new Uint16Array(8) : new Int32Array(8);
        for (let i = 0; i < arr.length; i++) arr[i] = (n++ * 7) % 251;
        cpu[name] = arr;
    }
    (cpu.memory_size as Int32Array)[0] = 1 << 20;
    let tsc: [number, number] = [0, 0];
    cpu.store_current_tsc = () => { (cpu.current_tsc as Int32Array).set(tsc); };
    cpu.set_tsc = (lo: number, hi: number) => { tsc = [lo, hi]; (cpu.current_tsc as Int32Array).set(tsc); };
    cpu.update_state_flags = () => {};
    cpu.full_clear_tlb = () => {};
    cpu.jit_clear_cache = () => {};
    cpu.fw_value = null;
    return cpu as unknown as V86Cpu;
}

function mkThread(id: number, state: ThreadState): Thread {
    return {
        id, handle: 0x1000 + id, state, context: null,
        stackBase: 0x00200000, stackSize: 0x00100000, stackTop: 0x00300000, startAddress: 0x00401000, parameter: id,
        waitInfo: null, exitCode: null, tlsValues: new Map([[1, 0x1234 + id]]), lastError: 5, suspendCount: 0, priority: 1,
        lastSwitchTime: 0, lastSwitchInsn: 0, tebAddress: 0x7ffd0000 - id * 0x1000, kernelPinCount: 0,
        apcQueue: [], quitPosted: false, quitExitCode: 0, asyncParkGeneration: 3,
    };
}

describe("capture → restore → capture is byte-identical", () => {
    test("cpu registers", () => {
        const a = fakeCpu();
        const saved = captureCpu(a);
        const b = fakeCpu();
        for (const name of Object.keys(CPU_FIELDS)) if (name !== 'memory_size') (b as unknown as Record<string, Int32Array>)[name].fill(0);
        restoreCpu(b, structuredClone(saved));
        expect(bytes(captureCpu(b))).toEqual(bytes(saved));
    });

    test("timer wheel keeps ids, deadlines, kinds and order", () => {
        const wheel = new TimerWheel();
        wheel.add(20, true, TimerKind.WINMM_TIMER, 0, 1000);
        wheel.add(5, false, TimerKind.USER32_TIMER, 0x10010, 1000);
        const cancelled = wheel.add(7, false, TimerKind.SLEEP_TIMEOUT, 2, 1000);
        wheel.cancel(cancelled);
        const fresh = new TimerWheel();
        roundTrip(() => wheel.captureState(), s => fresh.restoreState(s));
        expect(bytes(fresh.captureState())).toEqual(bytes(wheel.captureState()));
    });

    test("time continues from the saved clock", () => {
        const time = TimeService.getInstance();
        const saved = time.captureClock();
        time.restoreClock({ nowMs: saved.nowMs + 60_000 });
        expect(time.nowMs()).toBeGreaterThanOrEqual(saved.nowMs + 60_000);
        time.restoreClock({ nowMs: saved.nowMs });
    });

    test("address space and memory manager", () => {
        const mem = new Uint8Array(8 * 1024 * 1024);
        const space = new AddressSpace(() => mem);
        space.registerRegion({ base: 0x100000, size: 6 * 1024 * 1024, kind: "HEAP", perms: "rw", owner: "Layout" });
        const manager = new MemoryManager(space);
        manager.refreshLayoutBuckets();
        const a = manager.alloc(100, "HEAP", "rw");
        manager.alloc(5000, "HEAP", "rw");
        manager.free(a);
        manager.allocSystemBlock(48);

        const space2 = new AddressSpace(() => mem);
        const manager2 = new MemoryManager(space2);
        roundTrip(() => space.captureState(), s => space2.restoreState(s));
        roundTrip(() => manager.captureState(), s => manager2.restoreState(s));
        expect(bytes(space2.captureState())).toEqual(bytes(space.captureState()));
        expect(bytes(manager2.captureState())).toEqual(bytes(manager.captureState()));
    });

    test("thunk generator stubs, names and data exports", () => {
        const gen = new ThunkGenerator();
        gen.setBaseAddress(0x21046000);
        gen.generateStubDll("kernel32.dll", [{ name: "GetTickCount", argCount: 0 }, { name: "Sleep", argCount: 1 }]);
        gen.registerDataExport("msvcrt.dll", "_iob", 0x500000);
        const fresh = new ThunkGenerator();
        fresh.setBaseAddress(0x21046000);
        roundTrip(() => gen.captureState(), s => fresh.restoreState(s));
        expect(bytes(fresh.captureState())).toEqual(bytes(gen.captureState()));
    });

    test("scheduler threads, run queue and TLS", () => {
        const s = new Scheduler();
        const any = s as unknown as { threads: Map<number, Thread>; runQueue: number[]; currentThreadId: number | null; nextThreadId: number };
        const t1 = mkThread(1, ThreadState.RUNNING);
        t1.context = { eax: 1, ebx: 2, ecx: 3, edx: 4, esi: 5, edi: 6, ebp: 7, esp: 0x2ff000, eip: 0x401234, eflags: 0x202 } as Thread['context'];
        const t2 = mkThread(2, ThreadState.READY);
        t2.apcQueue.push({ routine: 0x401500, arg0: 1, arg1: 0, arg2: 0, kind: 0 } as Thread['apcQueue'][number]);
        any.threads.set(1, t1);
        any.threads.set(2, t2);
        any.runQueue.push(2);
        any.currentThreadId = 1;
        any.nextThreadId = 3;
        const graph = newObjectGraph();
        const saved = s.captureState((o, w) => graph.ref(o, w));
        const fresh = new Scheduler();
        fresh.restoreState(structuredClone(saved), r => restoreObjectGraph(graph.objects).object(r));
        expect(bytes(fresh.captureState((o, w) => graph.ref(o, w)))).toEqual(bytes(saved));
    });

    test("resource table entries restore to the same handles", () => {
        const table = new ResourceTable<{ v: number }>();
        const h1 = 0x10004, h2 = 0x10008;
        table.create(h1, { v: 1 });
        table.create(h2, { v: 2 });
        table.create(0x1000c, { v: 3 });
        table.release(h2);
        const entries = table.entries().map(([h, o]) => [h, o.v]);
        const fresh = new ResourceTable<{ v: number }>();
        for (const [h, v] of entries) fresh.create(h, { v });
        expect(fresh.entries().map(([h, o]) => [h, o.v])).toEqual(entries);
        expect(fresh.getByHandle(h1)?.v).toBe(1);
    });

    test("kernel32 module state", () => {
        namedObjects.reset();
        namedObjects.register("mutex", "Global\\Single", 0x120, { initialState: false });
        namedObjects.acquire("mutex", "Global\\Single");
        consoleScreenBuffers.createScreenBuffer(40, 10);
        const saved = captureKernel32State();
        namedObjects.reset();
        consoleScreenBuffers.reset();
        restoreKernel32State(structuredClone(saved));
        expect(bytes(captureKernel32State())).toEqual(bytes(saved));
        expect(namedObjects.peek("mutex", "Global\\Single")).toBe(0x120);
        expect(captureAtoms().atoms).toEqual(saved.atoms.atoms);
        namedObjects.reset();
        consoleScreenBuffers.reset();
    });
});

describe("kernel records", () => {
    test("a kernel object keeps exactly its policy fields through the object graph", () => {
        registerCoreParticipants();
        const graph = newObjectGraph();
        const event = { kind: 'event' as const, manualReset: true, signaled: false, pendingWake: true };
        const mutex = { kind: 'mutex' as const, ownerThreadId: 2, recursion: 1, abandoned: false };
        const ids = [graph.ref(event, 'event'), graph.ref(mutex, 'mutex'), graph.ref(event, 'event again')];
        expect(ids[2]).toBe(ids[0]);
        const ctx = restoreObjectGraph(structuredClone(graph.objects));
        expect(ctx.object(ids[0])).toEqual(event);
        expect(ctx.object(ids[1])).toEqual(mutex);
        expect(ctx.object(ids[0])).toBe(ctx.object(ids[0]));
    });

    test("an object without a codec is refused with its path", () => {
        registerCoreParticipants();
        const graph = newObjectGraph();
        class Opaque { x = 1; }
        expect(() => graph.ref(new Opaque(), 'gdi 0x40')).toThrow(/gdi 0x40: no savestate codec for Opaque/);
    });
});

describe("participant schemas", () => {
    test("each participant reports its version and a hash of its field policy", () => {
        registerCoreParticipants();
        const schemas = savestateParticipants.schemas();
        expect(schemas.scheduler!.version).toBe(1);
        expect(schemas.scheduler!.schemaHash).toMatch(/^[0-9a-f]{16}$/);
        expect(schemas.scheduler!.schemaHash).not.toBe(schemas.cpu!.schemaHash);
        expect(schemaHash({ a: "save", b: "host" })).toBe(schemaHash({ b: "host", a: "save" }));
        expect(schemaHash({ a: "save", b: "host" })).not.toBe(schemaHash({ a: "save", b: "save" }));
    });
});

describe("module coverage", () => {
    test("names every touched module that no participant captures", () => {
        expect(uncoveredModules(["KERNEL32.dll", "user32.dll", "C:\\GAME\\ddraw.DLL", "ntdll"], new Set(["kernel32", "ntdll"])))
            .toEqual(["ddraw", "user32"]);
    });

    test("core participants cover kernel32, and touched modules come from the thunk table", () => {
        registerCoreParticipants();
        const covered = savestateParticipants.coveredModules();
        expect(covered.has("kernel32")).toBe(true);
        expect(covered.has("user32")).toBe(false);
        const system = System.getInstance();
        const previous = system.process;
        const gen = new ThunkGenerator();
        gen.setBaseAddress(0x21046000);
        gen.generateStubDll("KERNEL32.dll", [{ name: "GetTickCount", argCount: 0 }]);
        gen.generateStubDll("USER32.dll", [{ name: "GetMessageA", argCount: 4 }]);
        system.process = { thunkGenerator: gen } as never;
        try {
            expect(uncoveredModules(touchedModules(), covered)).toEqual(["user32"]);
        } finally {
            system.process = previous;
        }
    });
});

describe("restartable park rewind", () => {
    test("a thread parked in GetMessage is captured at the call: stub EIP, return address on the stack, spin bytes put back", async () => {
        registerCoreParticipants();
        const { ramPatches } = await import("../../src/worker/savestate/session");
        const { snapshotRam } = await import("../../src/worker/savestate/ram");
        const system = System.getInstance();
        const previous = { process: system.process, scheduler: system.scheduler };
        const sched = new Scheduler();
        const any = sched as unknown as { threads: Map<number, Thread>; currentThreadId: number | null };
        const t = mkThread(1, ThreadState.WAITING);
        t.context = { eax: 0, ebx: 0, ecx: 0, edx: 0, esi: 0, edi: 0, ebp: 0, esp: 0x2fff00, eip: 0x7000, eflags: 0x202 } as Thread['context'];
        t.waitInfo = { reason: WaitReason.MESSAGE, handles: [], waitAll: false, timeoutTimerId: 0, alertable: false, csAddress: 0, srwWantExclusive: false } as unknown as Thread['waitInfo'];
        any.threads.set(1, t);
        any.currentThreadId = 1;
        system.scheduler = sched;
        system.process = {
            dispatcher: { restartableParks: () => [{ threadId: 1, functionId: 9, esp: 0x2fff00, returnAddr: 0x401234, spinAddr: 0x7000, spinBytes: [0xeb, 0xfe] }] },
            thunkGenerator: { getStubById: (id: number) => id === 9 ? { address: 0x21046090 } : undefined },
        } as never;
        ramPatches.length = 0;
        try {
            const participant = savestateParticipants.all().find(p => p.id === 'scheduler')!;
            const graph = newObjectGraph();
            const state = participant.capture(graph) as unknown as { threads: Array<{ id: number; state: number; waitInfo: unknown; context: { eip: number; esp: number } }>; runQueue: number[] };
            const saved = state.threads.find(x => x.id === 1)!;
            expect(saved.context.eip).toBe(0x21046090);
            expect(saved.context.esp).toBe(0x2fff00);
            expect(saved.state).toBe(ThreadState.READY);
            expect(saved.waitInfo).toBeNull();
            expect(state.runQueue).toContain(1);
            expect(ramPatches).toEqual([
                { address: 0x2fff00, bytes: [0x34, 0x12, 0x40, 0x00] },
                { address: 0x7000, bytes: [0xeb, 0xfe] },
            ]);
            const guest = new Uint8Array(4 * 1024 * 1024);
            guest.fill(0x90, 0x2fff00, 0x2fff04);
            const snap = await snapshotRam(guest, new Set(), ramPatches.splice(0));
            const at = 0x2fff00 % 65536;
            const stack = snap.pending.get(snap.manifest.chunks.find(([i]) => i === Math.floor(0x2fff00 / 65536))![1])!;
            expect([...stack.subarray(at, at + 4)]).toEqual([0x34, 0x12, 0x40, 0x00]);
            const low = snap.pending.get(snap.manifest.chunks.find(([i]) => i === 0)![1])!;
            expect([...low.subarray(0x7000, 0x7002)]).toEqual([0xeb, 0xfe]);
            expect(guest[0x2fff00]).toBe(0x90);
        } finally {
            ramPatches.length = 0;
            system.process = previous.process;
            system.scheduler = previous.scheduler;
        }
    });
});
