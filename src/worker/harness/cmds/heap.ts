/**
 * heap — guest allocator health over the harness RPC.
 *
 * The kernel32 heap has three tiers: an inline x86 slab stub in guest code, the
 * Rust hypercall, and the JS HeapAlloc thunk. Only the last one costs microseconds
 * per call, and it is reached exactly when the slab arena is exhausted — so a load
 * phase that suddenly runs at a fraction of its speed looks identical to "the guest
 * got slower" unless you can see `fallbacks` climbing. heapSlab() makes that tier
 * split observable, and heapSlabRates() turns the monotonic counters into the rate
 * the question is actually about.
 */

import type { HarnessService } from "../service";
import { slabReport, queryVirtualMemory } from "../../modules/kernel32/memory";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys } from "../serialize";

export function registerHeapCommands(svc: HarnessService): void {
    /** vaQuery(addr) — the MEMORY_BASIC_INFORMATION the GUEST would get for `addr`.
     *  Reading our own AddressSpace answers a different question than the guest asked;
     *  when a heap manager, a stack-bounds helper or a pointer validator misbehaves, this
     *  is the answer it actually saw.
     *
     *  vaQuery("stacks") runs it over every thread's [stackBase, stackTop) midpoint and
     *  judges the answer: Win32 describes a stack by its RESERVATION, so AllocationBase
     *  must be the stack base and RegionSize the whole run — a page-granular answer hands
     *  every stack-bounds helper inverted or 4KB-wide bounds. */
    svc.register("vaQuery", (args) => {
        const target = args[0];
        if (target !== "stacks") {
            const addr = typeof target === "string" ? Number.parseInt(target, 16) : Number(target);
            if (!Number.isFinite(addr)) throw new HarnessError("vaQuery expects an address or \"stacks\"", HarnessErrorCode.BAD_ARGS);
            return queryVirtualMemory(addr >>> 0);
        }
        const scheduler = (sys() as any).scheduler;
        if (!scheduler?.threads) throw new HarnessError("no scheduler", HarnessErrorCode.NO_PROCESS);
        const rows = [];
        for (const t of scheduler.threads.values()) {
            const base = t.stackBase >>> 0, top = t.stackTop >>> 0;
            if (!(top > base)) continue;
            const mbi = queryVirtualMemory((base + Math.floor((top - base) / 2)) & ~0xFFF);
            const reservationReported = mbi?.allocationBase === `0x${base.toString(16)}`
                && (mbi?.regionSize as number) === top - base;
            rows.push({
                thread: t.id,
                stackBase: `0x${base.toString(16)}`,
                stackTop: `0x${top.toString(16)}`,
                mbi,
                reservationReported,
            });
        }
        return { threads: rows, allReportReservation: rows.length > 0 && rows.every((r) => r.reservationReported) };
    });

    /** heapSlab() — slab arena snapshot: alloc/free/fallback counters, active-slab
     *  occupancy, and the retired-generation history. `current.fallbacks` climbing
     *  means allocation has dropped to the JS thunk; `totalMB` near `totalCap` means
     *  it can never climb back out. */
    svc.register("heapSlab", () => slabReport());

    /** heapSlabRates({ms?=2000}) — the same counters as deltas/sec over a wall-clock
     *  window, plus the growth the arena took during it. allocsPerSec vs fallbacksPerSec
     *  is the tier split: a fallbacksPerSec in the thousands with allocsPerSec at zero is
     *  an exhausted arena serving every small alloc from the JS thunk.
     *
     *  The counters live in the active slab's control block, so installing a new
     *  generation resets them to zero. A window that spans a grow reports rates as null
     *  rather than the negative numbers that subtraction would produce — `arenaGrewMB`
     *  is what that window actually measured. */
    svc.register("heapSlabRates", async (args) => {
        const ms = ((args[0] ?? {}) as { ms?: number }).ms ?? 2000;
        const a = slabReport();
        const t0 = performance.now();
        await new Promise((r) => setTimeout(r, ms));
        const b = slabReport();
        const dtSec = (performance.now() - t0) / 1000;
        const grew = b.generations.length !== a.generations.length;
        const rate = (x: number, y: number) => (grew ? null : Math.round(((y - x) / dtSec) * 10) / 10);
        return {
            windowSec: Math.round(dtSec * 100) / 100,
            allocsPerSec: rate(a.current.allocs, b.current.allocs),
            freesPerSec: rate(a.current.frees, b.current.frees),
            fallbacksPerSec: rate(a.current.fallbacks, b.current.fallbacks),
            countersReset: grew,
            arenaGrewMB: +(b.totalMB - a.totalMB).toFixed(2),
            generations: b.generations.length,
            totalMB: b.totalMB,
            capMB: b.totalCap / 1024 / 1024,
            activeFreePct: b.current.freePct,
        };
    });
}
