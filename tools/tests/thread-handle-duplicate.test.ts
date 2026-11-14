/**
 * A duplicated thread handle names the same thread. Boehm GC (Unity's mono.dll) keeps
 * DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), …) for every registered thread and
 * stops the world with SuspendThread/GetThreadContext/ResumeThread on it; the scheduler only
 * recognised the creation handle, so SuspendThread failed and the GC dropped the thread.
 */
import { expect, test } from "bun:test";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import { ThreadState } from "../../src/worker/core/scheduler/types";

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
    return { s, mem };
}

test("SuspendThread, ResumeThread and GetExitCodeThread work through a duplicate of the thread handle", () => {
    const { s, mem } = setup();
    const handle = s.createThread(0x401000, 0, 1 << 20, 0, 0, mem);
    const rp = (s as any).resourceProvider;
    const dup = rp.registerKernelObject(rp.getKernelObject(handle)) >>> 0;
    expect(dup).not.toBe(handle);
    const t = (s as any).threads.get((s as any).nextThreadId - 1);
    expect(s.suspendThread(dup)).toBe(0);
    expect(t.suspendCount).toBe(1);
    expect(t.state).toBe(ThreadState.SUSPENDED);
    expect(s.resumeThread(dup)).toBe(1);
    expect(t.suspendCount).toBe(0);
    expect(s.getThreadInfoByHandle(dup)?.state).toBe(ThreadState.READY);
});

test("a handle that is no thread object still fails", () => {
    const { s } = setup();
    expect(s.suspendThread(0x12344)).toBe(0xFFFFFFFF);
});
