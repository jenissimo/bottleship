/**
 * Once a handle is closed its value can come back for any new kernel object. Host state that
 * still reads the old value as "that thread" must follow the object the value names now:
 * the scheduler's thread lookup, the native ResumeThread suspend table, and the producer
 * that is refused a handle when the table is full.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { Advapi32 } from "../../src/worker/modules/advapi32";
import { exports as processApi } from "../../src/worker/modules/kernel32/process/process";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import { ThreadState } from "../../src/worker/core/scheduler/types";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";
import { hypercallDataManager } from "../../src/worker/core/cpu/hypercall-data";
import { exports as fileIo } from "../../src/worker/modules/kernel32/file-io";

const rp = SystemResourceProvider.getInstance();

function setup() {
    const mem = new Uint8Array(16 << 20);
    let next = 0x100000;
    const memory = { alloc: (size: number, _k?: string, _p?: string, align = 8) => {
        const a = (next + align - 1) & ~(align - 1); next = a + size; return a; }, free: () => {} };
    const cpu = { reg32: new Int32Array(8), instruction_pointer: new Int32Array(1), flags: new Int32Array(1),
        sreg: new Int16Array(8), segment_offsets: new Int32Array(8), instruction_counter: new Int32Array(1) };
    const s = new Scheduler();
    (s as any).process = { memory, pageTableManager: null, dispatcher: { hasActiveAsyncThunkForThread: () => false },
        getCurrentMemory: () => mem, v86: { cpu } };
    s.tebManager.initProcess(() => mem, memory as any);
    (s as any).currentThreadId = 0;
    const create = () => {
        const h = s.createThread(0x401000, 0, 1 << 20, 0, 0, mem) >>> 0;
        return { h, t: h ? (s as any).threads.get((s as any).nextThreadId - 1) : null };
    };
    /** Hand out `value` next, as the allocator does once its cursor wraps onto a freed slot. */
    const nextValueIs = (value: number) => { (rp as any).nextKernelHandle = value; };
    return { s, mem, create, nextValueIs };
}

beforeEach(() => rp.cleanup());
afterEach(() => rp.cleanup());

test("a new thread that receives a closed creation handle's value is the one that value names", () => {
    const { s, create, nextValueIs } = setup();
    const a = create();
    rp.unregisterKernelObject(a.h);
    nextValueIs(a.h);
    const b = create();
    expect(b.h).toBe(a.h);
    expect(b.t.id).not.toBe(a.t.id);

    expect(s.suspendThread(b.h)).toBe(0);
    expect(b.t.suspendCount).toBe(1);
    expect(a.t.suspendCount).toBe(0);
    expect(s.resumeThread(b.h)).toBe(1);
    expect(a.t.state).toBe(ThreadState.READY);
});

test("an event that receives a closed creation handle's value is no thread", () => {
    const { s, create, nextValueIs } = setup();
    const a = create();
    rp.unregisterKernelObject(a.h);
    nextValueIs(a.h);
    const ev = rp.registerKernelObject({ kind: "event", manualReset: true, signaled: false }) >>> 0;
    expect(ev).toBe(a.h);

    expect(s.suspendThread(ev)).toBe(0xFFFFFFFF);
    expect(s.resumeThread(ev)).toBe(0xFFFFFFFF);
    expect(a.t.suspendCount).toBe(0);
    expect(s.getThreadInfoByHandle(ev)).toBeNull();
});

test("the pseudo handle and an open duplicate still name a thread whose creation handle is closed", () => {
    const { s, create } = setup();
    const a = create();
    const dup = rp.registerKernelObject(rp.getKernelObject(a.h)) >>> 0;
    rp.unregisterKernelObject(a.h);

    expect(s.suspendThread(dup)).toBe(0);
    expect(a.t.suspendCount).toBe(1);
    expect(s.resumeThread(dup)).toBe(1);

    (s as any).currentThreadId = a.t.id;
    expect(s.getThreadInfoByHandle(0xFFFFFFFE)?.state).toBe(a.t.state);
    expect(s.getThreadBasicInformation(0xFFFFFFFE)?.id).toBe(a.t.id);
});

test("the native suspend table never holds a closed creation handle's value", () => {
    const { s, create, nextValueIs } = setup();
    const set = spyOn(hypercallDataManager, "setThreadSuspendCount");
    const forget = spyOn(hypercallDataManager, "forgetThreadSuspendCount");
    try {
        const a = create();
        const dup = rp.registerKernelObject(rp.getKernelObject(a.h)) >>> 0;
        expect(fileIo.CloseHandle!({} as never, new Uint8Array(0x1000), [a.h])).toBeTruthy();
        expect(forget.mock.calls.some(([h]) => h === a.h)).toBe(true);

        set.mockClear();
        expect(s.suspendThread(dup)).toBe(0);
        expect(set.mock.calls.some(([h]) => h === a.h)).toBe(false);
        s.resumeThread(dup);

        nextValueIs(a.h);
        const b = create();
        expect(b.h).toBe(a.h);
        forget.mockClear();
        (s as any).terminateThread(a.t.id, 0);
        expect(forget.mock.calls.some(([h]) => h === a.h)).toBe(false);
    } finally {
        set.mockRestore();
        forget.mockRestore();
    }
});

test("CreateThread refused a handle leaves no thread, no runnable entry and no stack behind", () => {
    const { s, create } = setup();
    const before = (s as any).getStackFootprint();
    const ownedBefore = (s as any).ownedStackBases.size;
    const threadsBefore = (s as any).threads.size;
    const nextIdBefore = (s as any).nextThreadId;
    const held: number[] = [];
    for (;;) { const h = rp.registerKernelObject({ kind: "event" }); if (!h) break; held.push(h); }

    const errors: number[] = [];
    const saved = s.setLastError.bind(s);
    s.setLastError = (code: number) => { errors.push(code); };
    try {
        const r = create();
        expect(r.h).toBe(0);
    } finally {
        s.setLastError = saved;
    }
    expect(errors).toContain(1450);
    expect((s as any).threads.size).toBe(threadsBefore);
    expect((s as any).runQueue.length).toBe(0);
    expect((s as any).nextThreadId).toBe(nextIdBefore);
    const after = (s as any).getStackFootprint();
    expect(after.liveBytes).toBe(before.liveBytes);
    expect(after.heldBytes).toBe(before.heldBytes);
    expect((s as any).ownedStackBases.size).toBe(ownedBefore);

    rp.unregisterKernelObject(held[0]!);
    const ok = create();
    expect(ok.h).toBe(held[0]!);
    expect(ok.t.id).toBe(nextIdBefore);
});

describe("DuplicateHandle and other producers after reuse / with a full table", () => {
    const CURRENT_PROCESS = 0xFFFFFFFF, CURRENT_THREAD = 0xFFFFFFFE, OUT = 0x200000;
    const withSystem = <T>(s: Scheduler, mem: Uint8Array, run: () => T): T => {
        const system: any = System.getInstance();
        const saved = { scheduler: system.scheduler, process: system.process };
        system.scheduler = s;
        system.process = { ...(s as any).process, resourceProvider: rp };
        Mem.bind(() => mem);
        try { return run(); } finally { system.scheduler = saved.scheduler; system.process = saved.process; }
    };
    const dup = (mem: Uint8Array, source: number) =>
        processApi.DuplicateHandle!({ esp: 0 } as never, mem, [CURRENT_PROCESS, source, CURRENT_PROCESS, OUT, 0, 0, 2]);
    const value = (r: unknown) => (typeof r === "number" ? r : (r as { value: number }).value) >>> 0;

    test("GetCurrentThread() duplicates the running thread even when its creation handle now names an event", () => {
        const { s, mem, create, nextValueIs } = setup();
        const a = create();
        (s as any).currentThreadId = a.t.id;
        rp.unregisterKernelObject(a.h);
        nextValueIs(a.h);
        const ev = rp.registerKernelObject({ kind: "event", manualReset: true, signaled: false }) >>> 0;
        expect(ev).toBe(a.h);
        const r = withSystem(s, mem, () => dup(mem, CURRENT_THREAD));
        expect(value(r)).toBe(1);
        const h = new DataView(mem.buffer).getUint32(OUT, true);
        expect(rp.getKernelObject(h)?.kind).toBe("thread");
        expect((s as any).threadFromHandle(h)?.id).toBe(a.t.id);
    });

    test("with every slot held, DuplicateHandle fails with ERROR_NO_SYSTEM_RESOURCES and writes nothing", () => {
        const { s, mem, create } = setup();
        const a = create();
        (s as any).currentThreadId = a.t.id;
        const held: number[] = [];
        for (;;) { const h = rp.registerKernelObject({ kind: "event" }); if (!h) break; held.push(h); }
        new DataView(mem.buffer).setUint32(OUT, 0xdeadbeef, true);
        const errors: number[] = [];
        s.setLastError = (code: number) => { errors.push(code); };
        for (const source of [CURRENT_THREAD, held[0]!, a.h]) {
            expect(value(withSystem(s, mem, () => dup(mem, source)))).toBe(0);
            expect(new DataView(mem.buffer).getUint32(OUT, true)).toBe(0xdeadbeef);
        }
        expect(errors.filter(e => e === 1450).length).toBe(3);
    });

    test("with every slot held, RegOpenKeyExA returns ERROR_NO_SYSTEM_RESOURCES and leaves phkResult", () => {
        const mem = new Uint8Array(0x300000);
        Mem.bind(() => mem);
        const system: any = System.getInstance();
        system.registry.createKey("HKCU", "bottleship-full");
        const mod = new Advapi32();
        mod.initialize({ resourceProvider: rp } as any);
        const name = 0x100;
        "bottleship-full".split("").forEach((c, i) => { mem[name + i] = c.charCodeAt(0); });
        const held: number[] = [];
        for (;;) { const h = rp.registerKernelObject({ kind: "event" }); if (!h) break; held.push(h); }
        new DataView(mem.buffer).setUint32(OUT, 0xdeadbeef, true);
        const r = mod.exports["RegOpenKeyExA"]!({ esp: 0 } as never, mem, [0x80000001, name, 0, 0x20019, OUT]);
        expect(value(r)).toBe(1450);
        expect(new DataView(mem.buffer).getUint32(OUT, true)).toBe(0xdeadbeef);
        rp.unregisterKernelObject(held[0]!);
        const ok = mod.exports["RegOpenKeyExA"]!({ esp: 0 } as never, mem, [0x80000001, name, 0, 0x20019, OUT]);
        expect(value(ok)).toBe(0);
        expect(new DataView(mem.buffer).getUint32(OUT, true)).toBe(held[0]!);
    });
});
