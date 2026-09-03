/**
 * codeScene — which guest CODE is executing, as the identity of the current scene.
 *
 * The pixel-based `sceneProbe` answers "is anything moving", which is game-agnostic but
 * fuzzy: an animated menu and a race both move, and a load screen and a paused game are both
 * still. Code is sharper. A front end and a race run DIFFERENT functions, so the set of
 * 4 KiB pages the guest is executing in is a fingerprint of the scene that needs no
 * thresholds about brightness and cannot be fooled by a spinning logo.
 *
 * WHAT THE SAMPLER ACTUALLY RANKS, and why this verb is about identity and not about heat.
 * The sampler is the one v86's tick hook already runs (emulator.worker.ts, `__eipSampOn`):
 * it reads EIP once per do_tick, BETWEEN JIT batches. That is a tick BOUNDARY, so the
 * histogram ranks the places the guest is standing when a batch ends — its EXIT POINTS —
 * not the places it spends cycles. The two can diverge sharply: a guest that traps often
 * parks in a thunk stub often, so the stub arena's share of samples can dwarf its share of
 * executed JIT time. Reading a share here as "hot code" is the exact trap this project keeps
 * paying for — a high sample share has turned out to be a trap-heavy entry point, not work.
 *
 * So: use this to tell one SCENE from another — a front end and a race exit through
 * different functions, which is a fingerprint and needs no thresholds. For where the time
 * goes, use a CDP trace (`harness trace` + analyze-trace's GUEST ATTRIBUTION), which
 * attributes executed JIT-block samples rather than boundary positions.
 *
 * `exitPoints` below makes the bias legible instead of documented: the share of samples that
 * landed in OUR thunk/callback/spin regions is, by construction, parking and not work.
 *
 * Compare two windows with `codeSceneCompare`: overlap of the hot page sets, weighted by
 * how much time each page took. That is the question an A/B actually needs answered, and
 * unlike a pixel distance it says WHERE the two runs diverged — a page number that `re
 * resolve` turns into a function.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { symbolize } from "../serialize";
import { System } from "../../core/system";
import type { RegionKind } from "../../core/memory/address-space";

/** Regions that are boundary parking, never guest work: a sample here is an exit point. */
const EXIT_POINT_KINDS: ReadonlySet<RegionKind> = new Set<RegionKind>([
    "THUNK_CODE", "CALLBACK_STUB", "SPIN_LOOP",
]);

/** Which region a code page belongs to, when the address space can say. */
function pageKind(page: number): string | null {
    try {
        return System.getInstance().process?.addressSpace?.getRegion(page)?.kind ?? null;
    } catch {
        return null;
    }
}

interface EipHist { hist: Record<string, number>; n: number }

const g = () => globalThis as unknown as { __eipSampOn?: boolean; __eipSamp?: EipHist };

/** `t<tid>@<page-hex>` — the key the worker's sampler writes. */
function parseKey(k: string): { tid: number; page: number } | null {
    const m = /^t(-?\d+)@([0-9a-f]+)$/.exec(k);
    return m ? { tid: Number(m[1]), page: parseInt(m[2]!, 16) } : null;
}

export function registerCodeSceneCommands(svc: HarnessService): void {
    /**
     * codeScene({ ms }) — sample which code pages the guest executes over a window.
     *
     * Returns pages by share of samples, symbolised where the module registry can name them.
     * The window is wall-clock: a guest that is stalled produces few samples, and that shows
     * as a low `samples` rather than as an empty scene.
     */
    svc.register("codeScene", async (args) => {
        const opts = (args[0] ?? {}) as { ms?: number; top?: number };
        const ms = Math.max(200, Math.min(opts.ms ?? 3000, 60_000));
        const top = Math.max(1, Math.min(opts.top ?? 12, 64));

        const gg = g();
        const wasOn = !!gg.__eipSampOn;
        gg.__eipSamp = { hist: {}, n: 0 };
        gg.__eipSampOn = true;
        const t0 = performance.now();
        await new Promise((r) => setTimeout(r, ms));
        const spanMs = performance.now() - t0;
        const snap = gg.__eipSamp ?? { hist: {}, n: 0 };
        if (!wasOn) gg.__eipSampOn = false;

        const byPage = new Map<number, number>();
        for (const [k, v] of Object.entries(snap.hist)) {
            const p = parseKey(k);
            if (p) byPage.set(p.page, (byPage.get(p.page) ?? 0) + v);
        }
        const total = snap.n || 1;
        const pages = [...byPage.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, top)
            .map(([page, hits]) => {
                const kind = pageKind(page);
                return {
                    page: `0x${page.toString(16)}`,
                    hits,
                    pct: +((hits / total) * 100).toFixed(2),
                    symbol: symbolize(page),
                    kind,
                    // Named per row so a big share cannot be read as a hot function by
                    // someone skimming the table.
                    exitPoint: kind !== null && EXIT_POINT_KINDS.has(kind as RegionKind),
                };
            });

        if (snap.n === 0) {
            throw new HarnessError(
                `no EIP samples in ${spanMs | 0}ms — the guest is not running (paused, stopped, or every `
                + "tick died before the after-hook). An empty page set is not an empty scene.",
                HarnessErrorCode.INTERNAL);
        }
        let exitHits = 0;
        for (const [page, hits] of byPage) {
            const kind = pageKind(page);
            if (kind !== null && EXIT_POINT_KINDS.has(kind as RegionKind)) exitHits += hits;
        }
        const exitPct = +((exitHits / total) * 100).toFixed(2);
        return {
            spanMs: +spanMs.toFixed(1),
            samples: snap.n,
            distinctPages: byPage.size,
            pages,
            exitPoints: {
                pct: exitPct,
                note: "share of samples taken inside our thunk / callback-stub / spin-loop "
                    + "regions. Parking, by construction — it measures how often the guest "
                    + "TRAPS, never how much code there runs.",
            },
            note: "EIP is read at a TICK BOUNDARY, so this ranks EXIT POINTS, not hot code — a "
                + "page's share says how often the guest was standing there when a JIT batch "
                + "ended. Use it to tell one scene from another (codeSceneCompare); for where "
                + "time actually goes use a CDP trace's guest attribution. It is also a SAMPLE, "
                + "not a census: an absent page means 'not caught', never 'not executed'.",
        };
    });

    /**
     * codeSceneCompare(a, b) — did two windows run the same code?
     *
     * The score is the overlap of the two page distributions (sum of the smaller share per
     * page): 1.0 means the same code in the same proportions, 0 means nothing in common.
     * `onlyInA` / `onlyInB` name the pages that differ, which is what turns "different scene"
     * into an address worth resolving.
     */
    svc.register("codeSceneCompare", (args) => {
        const a = args[0] as { pages?: Array<{ page: string; pct: number }> } | undefined;
        const b = args[1] as { pages?: Array<{ page: string; pct: number }> } | undefined;
        if (!a?.pages || !b?.pages) {
            throw new HarnessError("codeSceneCompare needs two codeScene results", HarnessErrorCode.BAD_ARGS);
        }
        const ma = new Map(a.pages.map((p) => [p.page, p.pct]));
        const mb = new Map(b.pages.map((p) => [p.page, p.pct]));
        let overlap = 0;
        for (const [k, va] of ma) overlap += Math.min(va, mb.get(k) ?? 0);
        // Shares are of the sampled total and the lists are truncated to `top`, so the
        // maximum achievable overlap is the smaller of the two listed masses — normalise
        // against it rather than against 100, or a long tail reads as a scene change.
        const massA = [...ma.values()].reduce((x, y) => x + y, 0);
        const massB = [...mb.values()].reduce((x, y) => x + y, 0);
        const score = overlap / Math.max(1e-9, Math.min(massA, massB));
        return {
            score: +score.toFixed(3),
            overlapPct: +overlap.toFixed(2),
            listedMass: { a: +massA.toFixed(2), b: +massB.toFixed(2) },
            onlyInA: a.pages.filter((p) => !mb.has(p.page)).slice(0, 8),
            onlyInB: b.pages.filter((p) => !ma.has(p.page)).slice(0, 8),
            verdict: score > 0.8 ? "same-code" : score > 0.4 ? "overlapping" : "different-code",
            note: "score is the shared mass of the two page distributions, normalised by the smaller "
                + "listed mass. 'different-code' means the two windows ran different functions, so any "
                + "timing compared between them is about two different things.",
        };
    });
}
