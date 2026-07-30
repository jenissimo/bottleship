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
import { slabReport } from "../../modules/kernel32/memory";

export function registerHeapCommands(svc: HarnessService): void {
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
