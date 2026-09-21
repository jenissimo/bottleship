/**
 * Thread-stack release.
 *
 * Windows deallocates a thread's stack when the thread terminates; holding it for the life
 * of the process is the deviation, and at 8 MB of SizeOfStackReserve a handful of dead
 * threads exhaust the guest heap. Releasing introduces address REUSE, though — the leak was
 * accidentally protective — so these pin BOTH halves: the footprint stops growing, AND every
 * reference we cannot prove dead still blocks the release.
 */

import { describe, expect, test } from "bun:test";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import {
    ThreadState, STACK_SIZE_PARAM_IS_A_RESERVATION, type Thread,
} from "../../src/worker/core/scheduler/types";
import {
    guestCodeInvalidationStats, resetGuestCodeInvalidationState,
} from "../../src/worker/core/memory/guest-code";

const MB = 1024 * 1024;
const GUARD = 0x1000;
const PAGE_NOACCESS = 0x01;
const PAGE_READWRITE = 0x04;
const MEM_BYTES = 64 * MB;
const REAP_AFTER = 1e12; // far past REAP_GRACE_MS for any terminatedAt

/** Bump allocator with an exact-fit free list — enough shape that a released block really
 *  can come back, which is what makes the guard-page reset observable. */
class FakeMemory {
    next = 0x00100000;
    live = new Map<number, number>();
    freed: number[] = [];
    allocs: Array<{ addr: number; size: number; kind?: string }> = [];
    private free_: Array<{ addr: number; size: number }> = [];

    alloc(size: number, kind?: string, _perms?: string, alignment?: number): number {
        const align = alignment ?? 8;
        for (let i = 0; i < this.free_.length; i++) {
            if (this.free_[i].size === size && this.free_[i].addr % align === 0) {
                const addr = this.free_.splice(i, 1)[0].addr;
                this.live.set(addr, size);
                this.allocs.push({ addr, size, kind });
                return addr;
            }
        }
        const addr = (this.next + align - 1) & ~(align - 1);
        this.next = addr + size;
        if (this.next > MEM_BYTES) throw new Error("FakeMemory: exhausted");
        this.live.set(addr, size);
        this.allocs.push({ addr, size, kind });
        return addr;
    }

    free(ptr: number): void {
        const size = this.live.get(ptr);
        if (size === undefined) return;
        this.live.delete(ptr);
        this.freed.push(ptr);
        this.free_.push({ addr: ptr, size });
    }

    /** Stack allocations only — the exit stub lands in THUNK_DATA. */
    stackAllocs(): Array<{ addr: number; size: number }> {
        return this.allocs.filter(a => a.kind === undefined);
    }
}

class FakePtm {
    calls: Array<{ base: number; size: number; protect: number }> = [];
    isPagingEnabled(): boolean { return true; }
    setProtection(base: number, size: number, protect: number): void {
        this.calls.push({ base, size, protect });
    }
    /** Live protection of the page containing `addr`, as the PTEs would answer. */
    protectionOf(addr: number): number {
        let p = PAGE_READWRITE;
        for (const c of this.calls) {
            if (addr >= c.base && addr < c.base + c.size) p = c.protect;
        }
        return p;
    }
}

function setup(opts: { asyncThreads?: Set<number>; suspendedFrames?: Set<number> } = {}) {
    const s = new Scheduler();
    const mem = new Uint8Array(MEM_BYTES);
    const memory = new FakeMemory();
    const ptm = new FakePtm();
    const segment_offsets = new Int32Array(8);
    const cpu = {
        reg32: new Int32Array(8), instruction_pointer: new Int32Array(1),
        flags: new Int32Array(1), sreg: new Int16Array(8), segment_offsets,
        instruction_counter: new Int32Array(1),
    };
    const dispatcher = {
        hasActiveAsyncThunkForThread: (id: number | null) =>
            id !== null && (opts.asyncThreads?.has(id) ?? false),
    };
    (s as any).process = {
        memory, pageTableManager: ptm, dispatcher,
        getCurrentMemory: () => mem,
        v86: { cpu },
    };
    s.onThreadOwnsSuspendedFrame = (id: number) => opts.suspendedFrames?.has(id) ?? false;
    // Nothing is current: the reaper refuses to reap the thread it still considers running.
    (s as any).currentThreadId = 0;
    return { s, mem, memory, ptm, segment_offsets };
}

/** One thread with an exact `size` reserve. Returns its scheduler id. */
function spawn(s: Scheduler, mem: Uint8Array, size = 1 * MB): number {
    const before = (s as any).nextThreadId;
    s.createThread(0x00401000, 0, size, STACK_SIZE_PARAM_IS_A_RESERVATION, 0, mem);
    expect((s as any).nextThreadId).toBeGreaterThan(before);
    return (s as any).nextThreadId - 1;
}

function kill(s: Scheduler, id: number): void {
    (s as any).terminateThread(id, 0);
}

function reap(s: Scheduler): void {
    (s as any).reapTerminatedThreads(REAP_AFTER);
}

function thread(s: Scheduler, id: number): Thread {
    return (s as any).threads.get(id);
}

describe("scheduler/thread-stack release — footprint", () => {
    test("create/exit churn does not grow the stack footprint without bound", () => {
        const { s, mem, memory } = setup();
        const oneStack = 1 * MB + GUARD;

        for (let i = 0; i < 200; i++) {
            const id = spawn(s, mem);
            kill(s, id);
            reap(s);
            expect(thread(s, id)).toBeUndefined();
        }

        // Exactly ONE stack of address space was ever taken, and it is idle in the pool.
        expect(memory.stackAllocs().length).toBe(1);
        const f = s.getStackFootprint();
        expect(f.reservedBytes).toBe(oneStack);
        expect(f.pooledBytes).toBe(oneStack);
        expect(f.liveBytes).toBe(0);
        expect(f.stats.fresh).toBe(1);
        expect(f.stats.reused).toBe(199);
        expect(f.stats.pooled).toBe(200);
    });

    test("concurrent threads each get their own stack; the pool holds the peak, not the total", () => {
        const { s, mem, memory } = setup();
        const ids = [0, 1, 2, 3].map(() => spawn(s, mem));
        expect(memory.stackAllocs().length).toBe(4);
        expect(s.getStackFootprint().liveBytes).toBe(4 * (1 * MB + GUARD));

        for (const id of ids) { kill(s, id); }
        reap(s);
        expect(s.getStackFootprint().pooledBlocks).toBe(4);

        // A second wave reuses all four — the footprint is peak concurrency, not churn.
        for (let i = 0; i < 4; i++) spawn(s, mem);
        expect(memory.stackAllocs().length).toBe(4);
        expect(s.getStackFootprint().pooledBlocks).toBe(0);
    });

    test("a reused stack comes back at the same base, zeroed, with its JIT blocks dropped", () => {
        const { s, mem } = setup();
        const id = spawn(s, mem);
        const base = thread(s, id).stackBase;
        mem[base + 64] = 0xcc; // a byte the dead thread left behind

        kill(s, id);
        reap(s);

        // A fresh stack does NOT need an invalidation (virgin VA); a recycled one does —
        // guests execute SEH trampolines on their own stacks. Differential, because
        // writeThreadExitStub invalidates on every CreateThread either way.
        resetGuestCodeInvalidationState();
        const id2 = spawn(s, mem);
        const reusedRanges = guestCodeInvalidationStats().deferred;
        resetGuestCodeInvalidationState();
        spawn(s, mem);
        const freshRanges = guestCodeInvalidationStats().deferred;
        resetGuestCodeInvalidationState();

        expect(thread(s, id2).stackBase).toBe(base);
        expect(mem[base + 64]).toBe(0);
        expect(reusedRanges).toBe(freshRanges + 1);
    });

    test("past the pool ceiling the VA really goes back to the allocator", () => {
        const { s, mem, memory } = setup();
        // Two of these already exceed STACK_POOL_MAX_BYTES (16 MB), so only the first is
        // cached and the rest go back to the allocator.
        const size = 8 * MB;
        const ids = [0, 1, 2].map(() => spawn(s, mem, size));
        const bases = ids.map(id => thread(s, id).stackBase - GUARD);
        for (const id of ids) kill(s, id);
        reap(s);

        const f = s.getStackFootprint();
        expect(f.pooledBlocks).toBe(1);
        expect(f.stats.released).toBe(2);
        expect(memory.freed).toEqual([bases[1], bases[2]]);
        expect(f.reservedBytes).toBe(size + GUARD);
    });
});

describe("scheduler/thread-stack release — guard page", () => {
    test("a pooled stack keeps its guard page, and it never lands inside the next tenant", () => {
        const { s, mem, ptm } = setup();
        const id = spawn(s, mem);
        const t = thread(s, id);
        const guardBase = t.stackBase - GUARD;
        expect(ptm.protectionOf(guardBase)).toBe(PAGE_NOACCESS);

        kill(s, id);
        reap(s);
        const id2 = spawn(s, mem);
        const t2 = thread(s, id2);

        // Same block, same layout: the guard is still below the usable stack, and no page
        // of the stack the new thread will run on is unmapped.
        expect(t2.stackBase).toBe(t.stackBase);
        expect(ptm.protectionOf(guardBase)).toBe(PAGE_NOACCESS);
        for (const probe of [t2.stackBase, t2.stackBase + GUARD, t2.stackTop - 1]) {
            expect(ptm.protectionOf(probe)).toBe(PAGE_READWRITE);
        }
    });

    test("a block handed back to the allocator does not carry PAGE_NOACCESS into its next owner", () => {
        const { s, mem, memory, ptm } = setup();
        const size = 8 * MB;
        const ids = [0, 1, 2].map(() => spawn(s, mem, size));
        for (const id of ids) kill(s, id);
        reap(s);
        expect(memory.freed.length).toBe(2);
        const evicted = memory.freed[0];

        // The next owner of that VA (any allocation, not a stack) must see plain RW.
        expect(ptm.protectionOf(evicted)).toBe(PAGE_READWRITE);
        const reAlloc = memory.alloc(size + GUARD, undefined, undefined, GUARD);
        expect(reAlloc).toBe(evicted);
        for (const probe of [reAlloc, reAlloc + GUARD, reAlloc + size]) {
            expect(ptm.protectionOf(probe)).toBe(PAGE_READWRITE);
        }
    });
});

describe("scheduler/thread-stack release — stale-reference gates", () => {
    test("an in-flight async thunk pins the stack of the thread it parked", () => {
        const asyncThreads = new Set<number>();
        const { s, mem, memory } = setup({ asyncThreads });
        const id = spawn(s, mem);
        const base = thread(s, id).stackBase;
        asyncThreads.add(id);

        kill(s, id);
        reap(s);

        // The Thread record is gone, but the stack is NOT pooled — the completion may still
        // write into the frame it parked on.
        expect(thread(s, id)).toBeUndefined();
        expect(s.getStackFootprint().pooledBlocks).toBe(0);
        expect(s.getStackFootprint().stats.heldAsyncInFlight).toBe(1);
        expect(memory.freed).toEqual([]);

        // …and nothing hands that VA to the next thread.
        const id2 = spawn(s, mem);
        expect(thread(s, id2).stackBase).not.toBe(base);
    });

    test("a live suspended-thunk frame pins the stack it will be resumed from", () => {
        const suspendedFrames = new Set<number>();
        const { s, mem } = setup({ suspendedFrames });
        const id = spawn(s, mem);
        suspendedFrames.add(id);
        kill(s, id);
        reap(s);
        expect(s.getStackFootprint().pooledBlocks).toBe(0);
        expect(s.getStackFootprint().stats.heldSuspendedFrame).toBe(1);
    });

    test("a surviving thread parked on the dead thread's stack pins it", () => {
        const { s, mem } = setup();
        const dead = spawn(s, mem);
        const alive = spawn(s, mem);
        const dt = thread(s, dead);
        // Guests switch ESP onto stacks they did not allocate (fibers, coroutine runtimes).
        thread(s, alive).context = { esp: dt.stackBase + 0x100 } as any;

        kill(s, dead);
        reap(s);
        expect(s.getStackFootprint().pooledBlocks).toBe(0);
        expect(s.getStackFootprint().stats.heldForeignEsp).toBe(1);
    });

    test("FS still selecting the dead thread's TEB pins its stack", () => {
        const { s, mem, segment_offsets } = setup();
        const id = spawn(s, mem);
        const t = thread(s, id);
        t.tebAddress = 0x00090000;
        segment_offsets[4] = t.tebAddress;

        kill(s, id);
        reap(s);
        expect(s.getStackFootprint().pooledBlocks).toBe(0);
        expect(s.getStackFootprint().stats.heldLiveFsBase).toBe(1);
    });

    test("the gate lets go once the reference does", () => {
        const asyncThreads = new Set<number>();
        const { s, mem } = setup({ asyncThreads });
        const id = spawn(s, mem);
        const base = thread(s, id).stackBase;
        asyncThreads.add(id);
        kill(s, id);
        // Reap while pinned would drop the Thread record with the stack still held, so
        // exercise the gate through the release entry point directly, as the reaper does.
        const t = thread(s, id);
        (s as any).releaseStack(t);
        expect(s.getStackFootprint().pooledBlocks).toBe(0);

        asyncThreads.delete(id);
        (s as any).releaseStack(t);
        expect(s.getStackFootprint().pooledBlocks).toBe(1);
        expect(spawnBase(s, mem)).toBe(base);
    });

    test("a stack the scheduler did not allocate is never released", () => {
        const { s, mem, memory } = setup();
        // The main thread's stack comes from the bootloader (setMainStackInfo), not from us.
        const foreign: Thread = {
            ...thread(s, spawn(s, mem)),
            id: 999, stackBase: 0x00f00000, stackSize: 1 * MB, stackTop: 0x00f00000 + 1 * MB,
            state: ThreadState.TERMINATED,
        };
        (s as any).threads.set(999, foreign);
        const pooledBefore = s.getStackFootprint().pooledBlocks;
        (s as any).releaseStack(foreign);
        expect(s.getStackFootprint().pooledBlocks).toBe(pooledBefore);
        expect(memory.freed).toEqual([]);
    });
});

function spawnBase(s: Scheduler, mem: Uint8Array): number {
    return thread(s, spawn(s, mem)).stackBase;
}
