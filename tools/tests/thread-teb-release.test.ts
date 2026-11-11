/**
 * TEB + TLS-array release at thread reap.
 *
 * NT deletes a thread's TEB at thread teardown; the scheduler used to keep every dead
 * thread's TEB page and its TEB+0x2C TLS array (4352 bytes, every TlsAlloc index) forever.
 * They now go back to the allocator where the stack does (tryReap), behind the same gates
 * plus their own: never while FS or the hypercall page still name the TEB, never the main
 * thread's, never during process exit. These pin that the memory really returns, that the
 * walks over the TEB maps (TlsFree, LastError) cannot reach a freed block that has a new
 * owner, that live threads keep their TLS, that the thread handle still answers, and that a
 * savestate taken after the deaths round-trips.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import { STACK_SIZE_PARAM_IS_A_RESERVATION, type Thread, type KernelThreadObject } from "../../src/worker/core/scheduler/types";
import { TLS_INDEX_LIMIT } from "../../src/worker/core/teb-manager";
import { hypercallDataManager } from "../../src/worker/core/cpu/hypercall-data";
import { System } from "../../src/worker/core/system";
import { newObjectGraph, restoreObjectGraph } from "../../src/worker/savestate/object-codecs";
import { encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { registerCoreParticipants } from "../../src/worker/savestate/core-participants";

const MB = 1024 * 1024;
const MEM_BYTES = 64 * MB;
const TEB_SIZE = 0x1000;
const TLS_ARRAY_BYTES = TLS_INDEX_LIMIT * 4;

/** Bump allocator with an exact-fit free list, so a released block really comes back. */
class FakeMemory {
    next = 0x00100000;
    live = new Map<number, number>();
    freed: number[] = [];
    private free_: Array<{ addr: number; size: number }> = [];

    alloc(size: number, _kind?: string, _perms?: string, alignment?: number): number {
        const align = alignment ?? 8;
        for (let i = 0; i < this.free_.length; i++) {
            if (this.free_[i]!.size === size && this.free_[i]!.addr % align === 0) {
                const addr = this.free_.splice(i, 1)[0]!.addr;
                this.live.set(addr, size);
                return addr;
            }
        }
        const addr = (this.next + align - 1) & ~(align - 1);
        this.next = addr + size;
        if (this.next > MEM_BYTES) throw new Error("FakeMemory: exhausted");
        this.live.set(addr, size);
        return addr;
    }

    free(ptr: number): void {
        const size = this.live.get(ptr);
        if (size === undefined) throw new Error(`FakeMemory: free of a block that is not live: 0x${ptr.toString(16)}`);
        this.live.delete(ptr);
        this.freed.push(ptr);
        this.free_.push({ addr: ptr, size });
    }

    liveOfSize(size: number): number {
        let n = 0;
        for (const s of this.live.values()) if (s === size) n++;
        return n;
    }
}

const system = System.getInstance();
let savedExiting = false;
beforeEach(() => { savedExiting = system.isExiting; system.isExiting = false; });
afterEach(() => { system.isExiting = savedExiting; });

function setup() {
    const s = new Scheduler();
    const mem = new Uint8Array(MEM_BYTES);
    const view = new DataView(mem.buffer);
    const memory = new FakeMemory();
    const segment_offsets = new Int32Array(8);
    const cpu = {
        reg32: new Int32Array(8), instruction_pointer: new Int32Array(1),
        flags: new Int32Array(1), sreg: new Int16Array(8), segment_offsets,
        instruction_counter: new Int32Array(1),
    };
    (s as any).process = {
        memory, pageTableManager: null, dispatcher: { hasActiveAsyncThunkForThread: () => false },
        getCurrentMemory: () => mem, v86: { cpu },
    };
    s.tebManager.initProcess(() => mem, memory);
    (s as any).currentThreadId = 0;
    return { s, mem, view, memory, segment_offsets };
}

function spawn(s: Scheduler, mem: Uint8Array): number {
    s.createThread(0x00401000, 0, 1 * MB, STACK_SIZE_PARAM_IS_A_RESERVATION, 0, mem);
    return (s as any).nextThreadId - 1;
}
const kill = (s: Scheduler, id: number, code = 0) => (s as any).terminateThread(id, code);
const reap = (s: Scheduler) => (s as any).reapTerminatedThreads();
const thread = (s: Scheduler, id: number): Thread | undefined => (s as any).threads.get(id);

describe("scheduler: a reaped thread's TEB and TLS array go back to the allocator", () => {
    test("create/exit churn reuses one TEB and one TLS array instead of growing", () => {
        const { s, mem, memory } = setup();
        const tebs = new Set<number>(), arrays = new Set<number>();
        (s as any).writeThreadExitStub();                            // the one-time exit stub is not per thread
        const baseline = memory.live.size;
        for (let i = 0; i < 100; i++) {
            const id = spawn(s, mem);
            tebs.add(s.tebManager.getTebAddress(id)!);
            arrays.add(s.tebManager.getTlsArrayAddress(id)!);
            expect(memory.live.size).toBe(baseline + 3);          // stack + TEB + TLS array
            kill(s, id);
            reap(s);
            expect(thread(s, id)).toBeUndefined();
            expect(s.tebManager.getTebAddress(id)).toBeUndefined();
            expect(s.tebManager.getTlsArrayAddress(id)).toBeUndefined();
        }
        expect([tebs.size, arrays.size]).toEqual([1, 1]);
        expect(memory.liveOfSize(TEB_SIZE)).toBe(0);
        expect(memory.liveOfSize(TLS_ARRAY_BYTES)).toBe(0);
        expect(s.tebManager.getAllTebs().size).toBe(0);
    });

    test("negative control: the churn measurement sees the leak when the release is skipped", () => {
        const { s, mem, memory } = setup();
        (s as any).releaseTeb = () => true;                          // the old behaviour: drop the record only
        for (let i = 0; i < 10; i++) { const id = spawn(s, mem); kill(s, id); reap(s); }
        expect(memory.liveOfSize(TEB_SIZE)).toBe(10);
        expect(memory.liveOfSize(TLS_ARRAY_BYTES)).toBe(10);
    });

    test("live threads keep their TEB and TLS while dead ones are freed and their blocks reused", () => {
        const { s, mem, view } = setup();
        const live = [spawn(s, mem), spawn(s, mem)];
        const dead = [spawn(s, mem), spawn(s, mem)];
        for (const id of [...live, ...dead]) {
            for (const i of [0, 5, 64, TLS_INDEX_LIMIT - 1]) s.tebManager.syncTlsSlot(id, i, (id << 16) | i);
            s.tebManager.syncLastError(id, 0x1000 + id);
        }
        const deadTebs = dead.map(id => s.tebManager.getTebAddress(id)!);
        for (const id of dead) kill(s, id);
        reap(s);
        // Two new threads take the freed blocks (exact fit) and zero them.
        const fresh = [spawn(s, mem), spawn(s, mem)];
        expect(fresh.map(id => s.tebManager.getTebAddress(id)).sort()).toEqual([...deadTebs].sort());
        for (const id of live) {
            for (const i of [0, 5, 64, TLS_INDEX_LIMIT - 1]) expect(s.tebManager.readTlsSlot(id, i)).toBe((id << 16) | i);
            expect(s.tebManager.readLastError(id)).toBe(0x1000 + id);
            expect(view.getUint32(s.tebManager.getTebAddress(id)! + 0x2c, true)).toBe(s.tebManager.getTlsArrayAddress(id)!);
        }
        for (const id of fresh) for (const i of [0, 5, 64, TLS_INDEX_LIMIT - 1]) expect(s.tebManager.readTlsSlot(id, i)).toBe(0);
    });

    test("TlsFree and LastError after a thread died never touch its freed TLS array or TEB", () => {
        const { s, mem, view, memory } = setup();
        const index = s.tlsAlloc();
        const id = spawn(s, mem);
        const array = s.tebManager.getTlsArrayAddress(id)!, teb = s.tebManager.getTebAddress(id)!;
        kill(s, id);
        reap(s);
        // Another owner takes both blocks and fills them.
        expect(memory.alloc(TLS_ARRAY_BYTES)).toBe(array);
        expect(memory.alloc(TEB_SIZE)).toBe(teb);
        mem.fill(0x5a, array, array + TLS_ARRAY_BYTES);
        mem.fill(0x5a, teb, teb + TEB_SIZE);
        expect(s.tlsFree(index)).toBe(true);                       // clearTlsSlotAllThreads walks the maps
        s.setLastErrorForThread(id, 0x77);                          // a late completion for the dead thread
        expect(view.getUint32(array + index * 4, true)).toBe(0x5a5a5a5a);
        expect(view.getUint32(teb + 0x34, true)).toBe(0x5a5a5a5a);
    });

    test("the dead thread's handle still answers its exit code; its TEB address reads as 0", () => {
        const { s, mem } = setup();
        const id = spawn(s, mem);
        const handle = thread(s, id)!.handle;
        kill(s, id, 0x1234);
        expect(s.getThreadBasicInformation(handle)!.tebAddress).not.toBe(0);   // record still there
        reap(s);
        expect(thread(s, id)).toBeUndefined();
        const info = s.getThreadBasicInformation(handle)!;
        expect(info.exitStatus).toBe(0x1234);
        expect(info.tebAddress).toBe(0);
        const kobj = (s as any).resourceProvider.getKernelObject(handle) as KernelThreadObject;
        expect([kobj.terminated, kobj.exitCode]).toEqual([true, 0x1234]);
    });
});

describe("scheduler: TEB release gates", () => {
    test("held while FS still selects the TEB, released on a later pass once it moves", () => {
        const { s, mem, memory, segment_offsets } = setup();
        const id = spawn(s, mem);
        const teb = s.tebManager.getTebAddress(id)!;
        segment_offsets[4] = teb;
        kill(s, id);
        reap(s);
        expect(thread(s, id)).toBeDefined();
        expect(memory.live.has(teb)).toBe(true);
        expect(s.tebManager.getTebAddress(id)).toBe(teb);
        segment_offsets[4] = 0;
        reap(s);
        expect(thread(s, id)).toBeUndefined();
        expect(memory.live.has(teb)).toBe(false);
    });

    test("held while the hypercall page still publishes the TEB", () => {
        const { s, mem, memory } = setup();
        const id = spawn(s, mem);
        const teb = s.tebManager.getTebAddress(id)!;
        const manager = hypercallDataManager as unknown as { readTebBase: () => number };
        const saved = manager.readTebBase;
        manager.readTebBase = () => teb;
        try {
            kill(s, id);
            reap(s);
            expect(memory.live.has(teb)).toBe(true);
            expect(thread(s, id)).toBeDefined();
        } finally {
            manager.readTebBase = saved;
        }
        reap(s);
        expect(memory.live.has(teb)).toBe(false);
    });

    test("never the current thread's, never the main thread's, never during process exit", () => {
        const { s, mem, memory } = setup();
        const cur = spawn(s, mem), main = spawn(s, mem), exiting = spawn(s, mem);
        const tebOf = (id: number) => s.tebManager.getTebAddress(id)!;
        const [tc, tm, tx] = [tebOf(cur), tebOf(main), tebOf(exiting)];
        (s as any).currentThreadId = cur;
        (s as any).mainThreadId = main;
        kill(s, cur); kill(s, main);
        reap(s);
        expect(memory.live.has(tc)).toBe(true);                     // still current
        expect(memory.live.has(tm)).toBe(true);                     // main thread: kept
        expect(thread(s, main)).toBeUndefined();                    // its record is reaped as before
        system.isExiting = true;
        kill(s, exiting);
        reap(s);
        expect(memory.live.has(tx)).toBe(true);
    });

    test("a second reap of the same thread frees nothing twice", () => {
        const { s, mem, memory } = setup();
        const id = spawn(s, mem);
        kill(s, id);
        reap(s);
        const freed = memory.freed.length;
        expect(s.tebManager.releaseTeb(id, memory)).toBe(false);    // FakeMemory.free throws on a double free
        reap(s);
        expect(memory.freed.length).toBe(freed);
    });
});

describe("savestate after thread deaths", () => {
    test("a scheduler captured after reaping restores byte-identically and names no freed TEB", () => {
        registerCoreParticipants();                                  // kernel-object codecs
        const { s, mem } = setup();
        const alive = spawn(s, mem);
        const dead = [spawn(s, mem), spawn(s, mem)];
        const deadTebs = dead.map(id => s.tebManager.getTebAddress(id)!);
        for (const id of dead) kill(s, id);
        reap(s);
        const graph = newObjectGraph();
        const saved = s.captureState((o, w) => graph.ref(o, w));
        const tebState = (saved as unknown as { teb: { tebs: number[][]; tls: number[][] } }).teb;
        expect(tebState.tebs.map(([t]) => t)).toEqual([alive]);
        expect(tebState.tls.map(([t]) => t)).toEqual([alive]);
        expect(tebState.tebs.some(([, a]) => deadTebs.includes(a!))).toBe(false);
        const fresh = new Scheduler();
        fresh.restoreState(structuredClone(saved), r => restoreObjectGraph(graph.objects).object(r));
        const bytes = (v: unknown) => Array.from(encodeValue(v as SaveValue));
        expect(bytes(fresh.captureState((o, w) => graph.ref(o, w)))).toEqual(bytes(saved));
        expect(fresh.tebManager.getTebAddress(alive)).toBe(s.tebManager.getTebAddress(alive));
        for (const id of dead) expect(fresh.tebManager.getTebAddress(id)).toBeUndefined();
    });
});
