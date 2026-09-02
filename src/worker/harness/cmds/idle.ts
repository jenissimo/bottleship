/**
 * idleMark / idleReport — what the worker's wall-clock was spent on over a window,
 * and specifically WHICH mechanism produced the idle the Far Cry trace showed
 * (docs/performance/sota-roadmap/08-io-idle.md).
 *
 * A trace can say "12% of samples were idle" but not whether the thread was parked in
 * `Atomics.wait` inside a synchronous SAB read or waiting for the next macrotask between
 * v86 ticks. Those have opposite fixes (readahead versus tick length), so this verb
 * splits them and refuses to guess:
 *
 *   window = inTick + attributed non-tick + unattributed
 *
 * `inTick` is do_tick — guest execution plus HLE — of which the SAB source's own
 * `waitMs` is the part where the thread was blocked rather than working. Non-tick time is
 * only what is bracketed by name (the rAF present chain, host messages). Everything else
 * — unbracketed JS between ticks plus true idle — is `unattributedMs`, reported as its
 * own line because the roadmap's success criterion is stated on that residual.
 *
 * The arithmetic lives in `computeIdlePartition` as a pure function over two snapshots so
 * the refusals below are testable without a live emulator: a window with no ticks, a
 * window that starts before accounting saw its first tick, and an unbalanced bracket are
 * each an explicit refusal rather than a plausible-looking zero.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import {
    workerTime, NON_TICK_KINDS, TICK_BUCKET_EDGES_MS,
    type NonTickKind, type WorkerTimeSnapshot,
} from "../../core/worker-time-accounting";
import type { SabIoSource } from "../../runtime/filesystem/sab-io-source";

type IoSnapshot = ReturnType<SabIoSource["stats"]>;

/** The SAB slice of a window, or null when no SAB source exists to count it. */
export interface SabDelta { waitMs: number; requests: number }

interface IdleMark { time: WorkerTimeSnapshot; io: IoSnapshot | null }

let mark: IdleMark | null = null;

function sabIo(): SabIoSource | null {
    return (globalThis as unknown as { __wgbSabIo?: SabIoSource }).__wgbSabIo ?? null;
}

const round = (v: number, d = 2): number => +v.toFixed(d);

export type IdlePartition =
    | { ok: false; refuse: string; code: string }
    | { ok: true; armed: false; windowMs: number; reason: string }
    | { ok: true; armed: true; report: Record<string, unknown> };

/**
 * The whole readout as a function of two ledger snapshots. Kept pure (no globals, no
 * clock) so every refusal path has a test.
 */
export function computeIdlePartition(
    before: WorkerTimeSnapshot, after: WorkerTimeSnapshot, sab: SabDelta | null,
): IdlePartition {
    const windowMs = after.atMs - before.atMs;
    const ticks = after.ticks - before.ticks;
    if (windowMs <= 0) {
        return {
            ok: false, code: HarnessErrorCode.BAD_ARGS,
            refuse: "idleReport window is empty — mark and report in different turns",
        };
    }
    if (ticks === 0) {
        return {
            ok: true, armed: false, windowMs: round(windowMs),
            reason: "no v86 tick completed in this window: the emulator is paused, stopped, or parked in a "
                + "single tick longer than the window. Nothing below would be a share of guest execution.",
        };
    }
    // Accounting only covers time after its first observed tick. A window opened before
    // the emulator started would otherwise report that pre-start time as idle.
    if (before.firstTickAtMs < 0 || before.atMs < before.firstTickAtMs) {
        return {
            ok: false, code: HarnessErrorCode.BAD_ARGS,
            refuse: "idleMark predates the first v86 tick — the window would count pre-start time as idle; re-mark",
        };
    }
    if (after.unbalancedExits !== before.unbalancedExits) {
        return {
            ok: false, code: HarnessErrorCode.INTERNAL,
            refuse: `non-tick bracket imbalance (${after.unbalancedExits - before.unbalancedExits} unmatched exits): `
                + "a region was exited without being entered, so every attribution below is skewed",
        };
    }

    const inTickMs = after.inTickMs - before.inTickMs;
    const nonTick: Record<string, { ms: number; calls: number }> = {};
    let nonTickTotal = 0;
    for (const k of NON_TICK_KINDS as readonly NonTickKind[]) {
        const ms = after.nonTickMs[k] - before.nonTickMs[k];
        nonTick[k] = { ms: round(ms), calls: after.nonTickCalls[k] - before.nonTickCalls[k] };
        nonTickTotal += ms;
    }
    const unattributedMs = windowMs - inTickMs - nonTickTotal;
    const requestedSleepMs = after.requestedSleepMs - before.requestedSleepMs;
    const hist = after.tickHistogram.map((v, i) => ({
        upToMs: Number.isFinite(TICK_BUCKET_EDGES_MS[i]!) ? TICK_BUCKET_EDGES_MS[i]! : null,
        n: v - before.tickHistogram[i]!,
    })).filter((b) => b.n > 0);

    // Naming the dominant mechanism is the verb's job; a report that hands back four
    // numbers and no verdict is how the last campaign picked the wrong target.
    const sabShare = sab ? sab.waitMs / windowMs : 0;
    const idleShare = unattributedMs / windowMs;
    const verdict = sab && sabShare >= 0.05 && sab.waitMs >= unattributedMs
        ? "sab-io"
        : idleShare >= 0.05
            ? "between-ticks"
            : "neither-dominant";

    return {
        ok: true, armed: true,
        report: {
            armed: true,
            windowMs: round(windowMs),
            ticks,
            ticksPerSecond: round((ticks * 1000) / windowMs, 1),

            inTick: {
                ms: round(inTickMs),
                sharePct: round((inTickMs / windowMs) * 100, 1),
                msPerTick: round(inTickMs / ticks, 3),
                maxTickMs: round(after.maxTickMs, 3),   // lifetime high-water, not windowed
                histogram: hist,
                // Of the time inside a tick, the part the thread spent parked rather than
                // executing. null means no SAB source exists (OPFS/blob bundle), which is
                // "nothing was counting", not "no I/O happened".
                sabWaitMs: sab ? round(sab.waitMs) : null,
                sabRequests: sab ? sab.requests : null,
                sabSharePct: sab ? round((sab.waitMs / windowMs) * 100, 1) : null,
            },

            nonTick,

            // Non-tick JS nobody brackets, plus genuine waiting for the next macrotask.
            // This is the number 08's success criterion is stated on.
            unattributedMs: round(unattributedMs),
            unattributedSharePct: round((unattributedMs / windowMs) * 100, 1),
            unattributedMsPerTick: round(unattributedMs / ticks, 3),

            // What v86 ASKED to sleep. A residual that matches this is the main loop
            // parking on purpose; a residual far above it is scheduling latency.
            requestedSleepMs: round(requestedSleepMs),
            requestedSleepSharePct: round((requestedSleepMs / windowMs) * 100, 1),

            verdict,
            partition: "windowMs = inTick.ms + sum(nonTick.ms) + unattributedMs, exactly; "
                + "inTick.sabWaitMs is a SLICE of inTick.ms, not a fourth term.",
        },
    };
}

export function registerIdleCommands(svc: HarnessService): void {
    /** idleMark() — open the window. The ledgers are monotonic, so a report is a
     *  difference; without a mark, boot's own multi-second stalls dominate every read. */
    svc.register("idleMark", () => {
        const src = sabIo();
        mark = { time: workerTime.snapshot(), io: src ? src.stats() : null };
        return { marked: true, atMs: round(mark.time.atMs), ticks: mark.time.ticks, sabIoArmed: !!src };
    });

    /** idleReport() — the partition since idleMark(). */
    svc.register("idleReport", () => {
        if (!mark) throw new HarnessError("idleReport with no idleMark", HarnessErrorCode.BAD_ARGS);
        const src = sabIo();
        const io = src ? src.stats() : null;
        const sab: SabDelta | null = io && mark.io
            ? { waitMs: io.wait.waitMs - mark.io.wait.waitMs, requests: io.wait.requests - mark.io.wait.requests }
            : null;
        const out = computeIdlePartition(mark.time, workerTime.snapshot(), sab);
        if (!out.ok) throw new HarnessError(out.refuse, out.code);
        return out.armed ? out.report : { armed: false, windowMs: out.windowMs, reason: out.reason };
    });
}
