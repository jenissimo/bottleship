/**
 * A fiber stack is a thread stack in every way the hardware can see: it gets the same
 * NOACCESS guard page below it (an overflow faults instead of landing in the neighbouring
 * allocation) and comes from, and goes back to, the scheduler's stack pool, so a reused
 * block is zeroed and keeps its guard. Real Scheduler + real PageTableManager PTEs.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import { PageTableManager } from "../../src/worker/core/memory/page-table-manager";
import { MEM_PAGETABLE_BASE } from "../../src/worker/core/cpu/emulator-config";
import { resetCpuViews } from "../../src/worker/core/cpu/cpu-views";
import { exports as fiber, resetFiberState } from "../../src/worker/modules/kernel32/fiber";

const PAGE = 0x1000;
const PTE_PRESENT = 0x01;
const PTE_DEFAULT = 0x07;
const MAPPED_BYTES = 64 << 20;
const TEB = 0x3000;
const system = System.getInstance() as any;
const saved = { process: system.process, scheduler: system.scheduler };

let mem: Uint8Array, dv: DataView, cpu: any, sched: Scheduler, allocs: number[];

const pteOffset = (addr: number) => {
    const page = addr >>> 12;
    return MEM_PAGETABLE_BASE + PAGE + (page >>> 10) * PAGE + (page & 0x3ff) * 4;
};
const present = (addr: number) => (dv.getUint32(pteOffset(addr), true) & PTE_PRESENT) !== 0;
const u32 = (a: number) => dv.getUint32(a, true);
const call = (name: string, ...args: number[]) => (fiber[name] as any)({}, mem, args);

beforeEach(() => {
    mem = new Uint8Array(MEM_PAGETABLE_BASE + 0x20000);
    dv = new DataView(mem.buffer);
    for (let a = 0; a < MAPPED_BYTES; a += PAGE) dv.setUint32(pteOffset(a), a | PTE_DEFAULT, true);
    Mem.bind(() => mem);
    resetCpuViews();
    const ptm = new PageTableManager(() => mem, () => null);
    (ptm as any).pagingEnabled = true;
    let next = 0x100000;
    allocs = [];
    const memory = {
        alloc: (n: number, kind?: string, _p?: unknown, align = 8) => {
            next = (next + align - 1) & ~(align - 1);
            const p = next; next += n;
            if (kind === undefined && align === PAGE) allocs.push(p);
            return p;
        },
        free: () => {},
    };
    cpu = {
        reg32: new Int32Array(8), instruction_pointer: new Int32Array(1), flags: new Int32Array(1),
        sreg: new Int16Array(8), segment_offsets: new Int32Array([0, 0, 0, 0, TEB, 0, 0, 0]),
        instruction_counter: new Int32Array(1),
    };
    sched = new Scheduler();
    system.process = { v86: { cpu }, resetGeneration: 0, memory, pageTableManager: ptm, getCurrentMemory: () => mem };
    (sched as any).process = system.process;
    (sched as any).currentThreadId = 0;
    system.scheduler = sched;
    resetFiberState();
    dv.setUint32(TEB + 4, 0x40000, true);
    dv.setUint32(TEB + 8, 0x20000, true);
    cpu.reg32[4] = 0x3FF00;
    call("ConvertThreadToFiber", 0);
});
afterEach(() => {
    system.process = saved.process; system.scheduler = saved.scheduler;
    resetFiberState(); resetCpuViews();
});

test("a fiber stack has a not-present guard page directly below it", () => {
    const f = call("CreateFiber", 0, 0x401000, 0);
    const limit = u32(f + 0x0C), base = u32(f + 0x08);
    expect(base - limit).toBe(0x100000);
    expect(present(limit - PAGE)).toBe(false);
    for (const probe of [limit, limit + PAGE, base - PAGE]) expect(present(probe)).toBe(true);
});

test("DeleteFiber pools the stack; the next fiber gets the same block, zeroed, guard intact", () => {
    const f = call("CreateFiber", 0, 0x401000, 0);
    const limit = u32(f + 0x0C);
    mem[limit + 64] = 0xCC;
    expect(call("DeleteFiber", f)).toBe(0);
    expect(sched.getStackFootprint().pooledBlocks).toBe(1);

    const g = call("CreateFiber", 0, 0x402000, 0);
    expect(u32(g + 0x0C)).toBe(limit);
    expect(mem[limit + 64]).toBe(0);
    expect(present(limit - PAGE)).toBe(false);
    expect(allocs.length).toBe(1);
    const stats = sched.getStackFootprint().stats;
    expect([stats.fresh, stats.reused, stats.pooled]).toEqual([1, 1, 1]);
});

test("a fiber stack another thread is parked on is not handed out again", () => {
    const f = call("CreateFiber", 0, 0x401000, 0);
    const limit = u32(f + 0x0C);
    (sched as any).threads.set(7, { id: 7, state: 1 /* READY */, context: { esp: limit + 0x800 } });
    call("DeleteFiber", f);
    expect(sched.getStackFootprint().pooledBlocks).toBe(0);
    expect(u32(call("CreateFiber", 0, 0x401000, 0) + 0x0C)).not.toBe(limit);
});

test("the deleting thread's own stale saved ESP does not pin a fiber stack it has left", () => {
    const f = call("CreateFiber", 0, 0x401000, 0);
    const limit = u32(f + 0x0C);
    (sched as any).currentThreadId = 7;
    (sched as any).threads.set(7, { id: 7, state: 1 /* READY */, context: { esp: limit + 0x800 } });
    call("DeleteFiber", f);
    expect(sched.getStackFootprint().pooledBlocks).toBe(1);
});
