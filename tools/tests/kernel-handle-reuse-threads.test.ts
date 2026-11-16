/**
 * Once a handle is closed its value can come back for any new kernel object. Host state that
 * still reads the old value as "that thread" must follow the object the value names now:
 * the scheduler's thread lookup, the native ResumeThread suspend table, and the producer
 * that is refused a handle when the table is full.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
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
