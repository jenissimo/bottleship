/**
 * Frame Pacer — rAF-driven presentation throttle.
 *
 * Prevents the emulator from generating frames faster than the display
 * can present. Does NOT manipulate virtual time — the spin loop (JMP $)
 * that runs during async thunk waits naturally advances instruction-based
 * time at the correct rate (~100K insn/ms = ~1ms/tick).
 *
 * Architecture:
 * - A requestAnimationFrame loop issues one "permit" per display refresh.
 * - waitForFrameSlot() awaits the next permit (blocking mode for Flip).
 * - Fast path: if rAF already fired (game slower than display), returns immediately.
 * - Non-blocking mode: for Blt-to-primary games that issue many Blts per
 *   visual frame, yields at most once per rAF cycle (12ms cooldown).
 * - waitForPresentInterval(n) is the PRESENT-side entry point: the swap interval the app
 *   asked for, expressed as refreshes to hold (see PRESENT_INTERVAL_* below).
 *
 * Enabled by default. Adapts to any display refresh rate (60 Hz, 144 Hz, etc.)
 * with sub-millisecond precision (no setTimeout jitter).
 */

import { Logger, LogCategory } from "./logger";
import { frameVarianceDiagnostics } from "./frame-variance-diagnostics";
import { debugSession } from "./debug/debug-session";
import { recordGpuError } from "./gpu-error-log";

/**
 * A present's swap interval, in display refreshes to hold it for. Every legacy API
 * spells the same three requests differently — D3DPRESENT_INTERVAL_*,
 * DDFLIP_NOVSYNC/DDFLIP_INTERVALn, grBufferSwap's argument — so they all reduce to
 * this one number: 0 = "don't wait for a retrace", N = "wait N retraces".
 */
export const PRESENT_INTERVAL_IMMEDIATE = 0;
export const PRESENT_INTERVAL_ONE = 1;

/**
 * D3DPRESENT_INTERVAL_* → refresh count. d3d8caps.h and d3d9types.h use the identical
 * encoding, so one decoder serves both backends and they cannot drift. DEFAULT (0) means
 * ONE, as it does on a real runtime; a value we never advertise falls back to ONE rather
 * than inventing a cadence the app did not ask for.
 */
export function decodeD3DPresentInterval(raw: number): number {
    const v = raw >>> 0;
    if (v & 0x80000000) return PRESENT_INTERVAL_IMMEDIATE; // D3DPRESENT_INTERVAL_IMMEDIATE
    switch (v) {
        case 0x00000002: return 2; // D3DPRESENT_INTERVAL_TWO
        case 0x00000004: return 3; // D3DPRESENT_INTERVAL_THREE
        case 0x00000008: return 4; // D3DPRESENT_INTERVAL_FOUR
        default: return PRESENT_INTERVAL_ONE; // DEFAULT (0) and ONE (1)
    }
}

/**
 * IMMEDIATE work bound: the compositor puts exactly one image on screen per refresh, so
 * presents past this count inside a single refresh cannot be seen — they only consume the
 * worker thread the guest CPU runs on. Far above any rate a period title's own logic gates
 * on, so the bound is not guest-observable; `__noPresentBackstop` removes it entirely.
 */
const IMMEDIATE_PRESENTS_PER_REFRESH = 8;

/**
 * How long a frame-slot wait may hold when no rAF arrives. Far above any real refresh
 * interval (so a foreground tab never reaches it and pacing is unchanged), far below the
 * point where a stalled guest reads as a hang. See parkForPermit.
 */
const STALL_RELEASE_MS = 250;

export type FramePacerStats = {
    enabled: boolean;
    frameSlotBusy: boolean;
    totalWaits: number;
    totalWaitTimeMs: number;
    currentWaitStartMs: number;
    /** Presents released without a retrace wait (interval IMMEDIATE). */
    immediatePresents: number;
    /** Extra refreshes held for interval >= TWO (does not count the first). */
    heldRefreshes: number;
    /** Permits the watchdog released because no frame arrived (hidden tab, occluded
     *  window, stalled compositor). Nonzero means the display stopped, not the guest. */
    stalledReleases: number;
};

class FramePacerImpl {
    private enabled = true;  // Enabled by default
    private running = false;

    /** Everyone parked on the next frame permit. A Blt-to-primary and the present it
     *  triggers can be in flight together, so this is a QUEUE, not a slot: a second
     *  waiter must neither strand the first (a permanent stall) nor release it early
     *  (pacing silently off — the guest then free-runs at hundreds of "FPS" with the
     *  spikes of an unpaced present loop). */
    private waiters: Array<() => void> = [];
    /** Watchdog for the parked waiters — see parkForPermit. */
    private waiterWatchdog: ReturnType<typeof setTimeout> | null = null;
    /** Permits released by the watchdog because no frame arrived (reported in stats). */
    private stalledReleases = 0;

    // Per-frame callbacks: fired once per rAF, synchronized with display refresh.
    // Used by THRASH auto-presenter and other subsystems that need frame-boundary events.
    private frameCallbacks: Set<() => void> = new Set();

    // Pre-queued permit: if rAF fires while no one is waiting, save it.
    // Next waitForFrameSlot() returns immediately instead of blocking until NEXT rAF.
    private permitAvailable = false;

    // Non-blocking cooldown: for Blt-to-primary games that issue many Blts per
    // visual frame, yield at most once per rAF cycle (skip if < cooldown).
    private lastYieldTime = 0;

    // Adaptive cooldown: measure actual rAF interval and use 85% as cooldown.
    // Handles 60Hz (16.6ms → 14.1ms cooldown), 144Hz (6.9ms → 5.9ms), etc.
    private rAfInterval = 16.67;  // default 60Hz
    private lastRafTime = 0;

    // Sleep coordination: skip rAF wait if game already self-throttled via Sleep(N)
    private recentSleepMs = 0;
    private recentSleepTime = 0;

    // Stats
    private totalWaits = 0;
    private totalWaitTimeMs = 0;
    private currentWaitStartMs = 0;
    private slotBusy = false;
    private immediatePresents = 0;
    private heldRefreshes = 0;

    // IMMEDIATE backstop bookkeeping: presents released inside the current vsync (rafTick).
    private immediateTick = -1;
    private immediateCount = 0;

    // Adaptive smooth-pacing (opt-in via setPacingMode('smooth')). A sub-refresh guest
    // (~23 FPS on 60 Hz) otherwise lands each frame at an arbitrary phase → held 2 or 3
    // vsyncs irregularly = pulldown judder. Smooth mode holds each present a STEADY integer
    // number of vsyncs (guest rate snapped to a refresh divisor), killing the 2↔3 flap.
    // Reuses the rAF-wait path (virtual time unaffected). Default off — no behavior change.
    private pacingMode: 'off' | 'vsync' | 'smooth' = 'off';
    private lastSlotReturnMs = 0;
    private guestIntervalEma = 42; // ms, EMA of the guest's INTRINSIC frame interval (excl. our hold)
    // Grid-locked smooth pacing: hold each present a STEADY integer number of vsyncs, anchored
    // to the actual vsync grid (rafTick) rather than a free-running wall-clock accumulator.
    // The old accumulator only re-anchored when it fell BEHIND, so on frames that snapped to a
    // shorter hold it drifted AHEAD ~1 vsync/frame and compounded into 6–7-vsync (100ms+) holds
    // = the "14-FPS collapse". Anchoring to rafTick bounds every hold to exactly smoothVsyncs.
    private rafTick = 0;            // monotonic vsync counter, incremented once per rAF (onFrame)
    private smoothReleaseTick = -1; // rafTick at the last present (the cadence anchor)
    private smoothVsyncs = 0;       // current steady hold count (0 = uninitialised), hysteresis below

    /** Start the rAF loop. Call once after v86 initialization. */
    start(): void {
        if (this.running || !this.enabled) return;
        this.running = true;
        this.scheduleNext();
        Logger.log(LogCategory.SYSTEM, `[FramePacer] Started rAF loop`);
    }

    /** Stop the rAF loop (e.g. on emulator teardown). */
    stop(): void {
        this.running = false;
        // Release anyone blocked so they don't hang forever
        this.releaseWaiters();
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (enabled && !this.running) {
            this.start();
        }
        // Release anyone blocked — nothing will grant a permit once disabled.
        if (!enabled) this.releaseWaiters();
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    /**
     * Called by Flip()/Present() before submitting a frame.
     *
     * Virtual time is NOT manipulated here. During the rAF wait, v86
     * continues executing the spin loop (JMP $, 0xEB 0xFE), which naturally
     * advances the instruction counter at ~100K insn/ms. This produces
     * correct instruction-based virtual time (~1ms per tick) without
     * explicit pause/compensate logic that caused:
     * - Re-Volt jitter (lump-sum 16ms compensation between smooth 1ms ticks)
     * - HoMM3 speed-up (multiple compensations per visual frame)
     *
     * Fast path: if rAF already fired (game slower than display refresh),
     * returns immediately.
     *
     * Options:
     * - nonBlocking: if true, only yield if we haven't yielded recently
     *   (cooldown). Used by Blt-to-primary games that issue many Blts
     *   per visual frame — prevents 16ms stall on each Blt.
     */
    /**
     * Notify the pacer that the game called Sleep(N).
     * If N >= 5ms, the next Flip can skip the rAF wait — game is self-throttling.
     */
    notifySleep(ms: number): void {
        if (ms >= 5) {
            this.recentSleepMs = ms;
            this.recentSleepTime = performance.now();
        }
    }

    async waitForFrameSlot(options?: { nonBlocking?: boolean }): Promise<void> {
        if (!this.enabled || !this.running) return;

        // Smooth pacing: enforce a steady inter-present cadence (opt-in).
        if (this.pacingMode === 'smooth' && !options?.nonBlocking) {
            return this.waitSmooth();
        }

        // Vsync-lock (faithful) pacing: release every present on a FRESH vsync edge so the
        // present phase is pinned to the grid (opt-in). Unlike 'off' this deliberately ignores
        // both the self-throttle skip and the pre-queued stale permit, since either releases at
        // an arbitrary sub-vsync phase — the exact jitter that turns a self-limited guest's clean
        // 3:2 cadence into a 2↔3 flap. Native rate preserved (no hold count), one present per
        // edge → honest pull-up. Costs up to one vsync of latency vs 'off'.
        if (this.pacingMode === 'vsync' && !options?.nonBlocking) {
            return this.waitVsync();
        }

        // If the game recently slept >= 5ms, it's self-throttling — skip rAF wait.
        // The 20ms staleness window covers one full frame at ~50+ FPS.
        if (this.recentSleepMs >= 5 && (performance.now() - this.recentSleepTime) < 20) {
            this.recentSleepMs = 0;
            this.totalWaits++;
            return;
        }

        // Fast path: rAF already fired while we were rendering → no wait needed.
        if (this.permitAvailable) {
            this.permitAvailable = false;
            this.totalWaits++;
            return;
        }

        // Non-blocking mode: skip yield if we yielded recently.
        // Prevents Blt-to-primary games from stalling 16ms on every Blt call.
        if (options?.nonBlocking) {
            const now = performance.now();
            if (now - this.lastYieldTime < this.yieldCooldownMs) {
                return;
            }
        }

        // Slow path: game is faster than display refresh. Yield until next rAF.
        this.slotBusy = true;
        const wallBefore = performance.now();
        this.currentWaitStartMs = wallBefore;
        this.totalWaits++;

        // Wait for the next rAF permit
        await this.parkForPermit();

        const wallElapsed = performance.now() - wallBefore;
        this.totalWaitTimeMs += wallElapsed;
        this.slotBusy = false;
        this.lastYieldTime = performance.now();

        // Record display-bound idle for diagnostics.
        frameVarianceDiagnostics.recordIdleTime('raf_wait', wallElapsed);
    }

    /**
     * Present-side pacing: hold this present for `refreshes` display refreshes.
     *
     * 1 (D3DPRESENT_INTERVAL_ONE/DEFAULT, a plain Flip, grBufferSwap(1)) IS the
     * waitForFrameSlot() path verbatim; >1 holds that many further refreshes on top;
     * 0 is IMMEDIATE (waitImmediate). `__forcePresentInterval` overrides every caller
     * globally — the one escape hatch, never a per-title branch.
     */
    waitForPresentInterval(refreshes: number): Promise<void> {
        if (!this.enabled || !this.running) return Promise.resolve();
        const forced = (globalThis as Record<string, unknown>).__forcePresentInterval;
        const n = Math.max(0, (typeof forced === 'number' ? forced : refreshes) | 0);
        if (n === PRESENT_INTERVAL_IMMEDIATE) return this.waitImmediate();
        // NOT `async`, and interval 1 RETURNS waitForFrameSlot rather than awaiting it.
        // An async wrapper costs a microtask turn before the wait even begins, and a
        // present that fits the refresh by a hair (this title clears it by ~0.7ms) then
        // crosses the deadline and loses a WHOLE refresh — measured as a hard lock to
        // half rate, with the worker idle half the time. The common path must add nothing.
        if (n <= PRESENT_INTERVAL_ONE) return this.waitForFrameSlot();
        return this.holdRefreshes(n);
    }

    private async holdRefreshes(n: number): Promise<void> {
        await this.waitForFrameSlot();
        for (let i = 1; i < n && this.enabled && this.running; i++) {
            this.heldRefreshes++;
            await this.awaitRafPermit();
        }
    }

    /**
     * IMMEDIATE: the app asked us not to wait for a retrace, so we don't — an unbounded
     * rate is the contract. The only intervention is the invisible-work bound
     * (IMMEDIATE_PRESENTS_PER_REFRESH), which degrades to a single-refresh wait. An
     * explicitly selected pacing mode wins: 'vsync'/'smooth' exist to force a cadence.
     */
    private async waitImmediate(): Promise<void> {
        this.immediatePresents++;
        if (this.pacingMode !== 'off') return this.waitForFrameSlot();

        if (this.immediateTick !== this.rafTick) {
            this.immediateTick = this.rafTick;
            this.immediateCount = 0;
        }
        if (++this.immediateCount <= IMMEDIATE_PRESENTS_PER_REFRESH ||
            (globalThis as Record<string, unknown>).__noPresentBackstop) {
            return;
        }
        await this.waitForFrameSlot();
    }

    setPacingMode(mode: 'off' | 'vsync' | 'smooth'): void {
        this.pacingMode = mode;
        this.lastSlotReturnMs = 0;
        this.smoothReleaseTick = -1;
        this.smoothVsyncs = 0;
        Logger.log(LogCategory.SYSTEM, `[FramePacer] pacing mode = ${mode}`);
    }

    getPacingMode(): 'off' | 'vsync' | 'smooth' {
        return this.pacingMode;
    }

    /**
     * Vsync-lock wait (mode A / faithful): block until the NEXT rAF edge, deliberately
     * discarding any pre-queued permit so the release lands on a real vsync boundary rather
     * than whatever sub-vsync phase the guest happened to finish at. Native rate is untouched
     * (no hold count) — the guest's frame interval simply rounds up to the next grid edge,
     * yielding a phase-clean 3:2 cadence instead of the 'off' path's drifting 2↔3 flap.
     */
    private async waitVsync(): Promise<void> {
        this.totalWaits++;
        // Drop the stale permit: we want a fresh edge, not an immediate return at an arbitrary phase.
        this.permitAvailable = false;
        this.slotBusy = true;
        const wallBefore = performance.now();
        this.currentWaitStartMs = wallBefore;
        await this.parkForPermit();
        const wallElapsed = performance.now() - wallBefore;
        this.totalWaitTimeMs += wallElapsed;
        this.slotBusy = false;
        this.lastYieldTime = performance.now();
        frameVarianceDiagnostics.recordIdleTime('raf_wait', wallElapsed);
    }

    /** Await exactly one rAF permit (fast-path the pre-queued one). */
    private awaitRafPermit(): Promise<void> {
        if (this.permitAvailable) { this.permitAvailable = false; return Promise.resolve(); }
        return this.parkForPermit();
    }

    /**
     * Park until the next frame — but never longer than STALL_RELEASE_MS.
     *
     * The permit comes from requestAnimationFrame, and rAF is DELIVERY-CONDITIONAL: a hidden
     * tab, a window another window covers (Chrome's native occlusion), a compositor that
     * stops for any other reason — and callbacks simply stop arriving, with
     * `document.visibilityState` still reporting "visible". A pacer that only ever wakes on
     * rAF then holds its waiter forever, and because a Blt/Flip to the primary is an ASYNC
     * THUNK, the guest thread that issued it stays parked with it: the emulator does not slow
     * down, it stops, and only starts again when someone looks at the tab. Pacing to a display
     * that is not producing frames is meaningless anyway — releasing is the honest answer.
     *
     * Everyone parked here is waiting for the SAME thing — the next frame — so a frame
     * releases all of them, and a late arrival joins the queue instead of displacing whoever
     * is already in it.
     */
    private parkForPermit(): Promise<void> {
        return new Promise<void>((resolve) => {
            this.waiters.push(resolve);
            if (this.waiterWatchdog === null) {
                this.waiterWatchdog = setTimeout(() => {
                    this.waiterWatchdog = null;
                    if (!this.waiters.length) return;
                    this.stalledReleases++;
                    this.releaseWaiters();
                }, STALL_RELEASE_MS);
            }
        });
    }

    /** Hand the permit to everyone parked (from rAF, the watchdog, or teardown). */
    private releaseWaiters(): void {
        if (this.waiterWatchdog !== null) {
            clearTimeout(this.waiterWatchdog);
            this.waiterWatchdog = null;
        }
        if (!this.waiters.length) return;
        const pending = this.waiters;
        this.waiters = [];
        for (const resolve of pending) resolve();
    }

    /**
     * Smooth-pacing wait: hold each present a STEADY integer number of vsyncs so a sub-refresh
     * guest presents on a regular cadence instead of a juddery 2↔3 flap. The hold count is
     * chosen as the smallest integer of vsyncs that fits the guest's measured frame time
     * (ceil, clamped 2..4) with hysteresis to avoid flip-flopping at a boundary; HP (~44ms)
     * → a steady 3 vsyncs = 50ms = 20 FPS, stddev ≈ 0.
     *
     * Crucially the cadence is anchored to the actual vsync grid via rafTick, NOT a wall-clock
     * accumulator: each present is released exactly `smoothVsyncs` vsyncs after the previous
     * one. A guest that overran its budget (stall) is already past the target tick → it passes
     * straight through; we never lengthen a stall, and the hold can never drift/compound.
     */
    private async waitSmooth(): Promise<void> {
        const entry = performance.now();
        this.totalWaits++;

        // Measure the guest's INTRINSIC frame time = time since we released the last present
        // (excludes our own hold). Using the paced inter-request interval instead feeds back
        // on our output and ratchets the rate down — that bug locked HP to a steady 15 FPS.
        if (this.lastSlotReturnMs > 0) {
            const work = entry - this.lastSlotReturnMs;
            // Ignore stall outliers (>80ms): a one-off hitch must NOT inflate the hold count.
            if (work > 2 && work < 80) this.guestIntervalEma = this.guestIntervalEma * 0.85 + work * 0.15;
        }

        // Fast guest (> ~43 FPS): present as ready — never cap.
        if (this.guestIntervalEma < this.rAfInterval * 1.4) {
            this.smoothVsyncs = 0;
            await this.awaitRafPermit();
            this.lastSlotReturnMs = performance.now();
            this.smoothReleaseTick = this.rafTick;
            return;
        }

        // Choose the steady hold count = ceil(guestInterval / refresh), clamped 2..4, with a
        // hysteresis band so noise near a vsync boundary doesn't reintroduce a 2↔3 flap.
        const ratio = this.guestIntervalEma / this.rAfInterval;
        let v = this.smoothVsyncs;
        if (v < 2) {
            v = Math.max(2, Math.min(4, Math.ceil(ratio - 0.05)));
        } else if (ratio > v + 0.15) {
            v = Math.min(4, v + 1);        // guest got heavier → hold one more vsync
        } else if (ratio < v - 1.15) {
            v = Math.max(2, v - 1);        // guest comfortably fits a shorter hold
        }
        this.smoothVsyncs = v;

        // Hold until `v` vsyncs have elapsed since the last present (grid-locked, bounded).
        if (this.smoothReleaseTick < 0) this.smoothReleaseTick = this.rafTick;
        let guard = 0;
        while (this.rafTick - this.smoothReleaseTick < v && guard++ < v + 3) {
            await this.awaitRafPermit();
        }
        this.lastSlotReturnMs = performance.now();
        this.smoothReleaseTick = this.rafTick;
        frameVarianceDiagnostics.recordIdleTime('raf_wait', 0);
    }

    /**
     * Register a callback to be called once per rAF frame, synchronized with display refresh.
     * Returns an unregister function. Safe to call before start().
     */
    registerOnFrame(cb: () => void): () => void {
        this.frameCallbacks.add(cb);
        return () => this.frameCallbacks.delete(cb);
    }

    /**
     * No-op — kept for API compatibility with existing call sites.
     * The rAF loop handles pacing; no explicit reserve/release needed.
     */
    reserveFrameSlot(): void {
        // no-op
    }

    /**
     * No-op — kept for API compatibility with existing call sites.
     */
    releaseFrameSlot(): void {
        // no-op
    }

    /**
     * Check if frame slot is available (for diagnostics).
     */
    isFrameSlotAvailable(): boolean {
        return !this.slotBusy;
    }

    getStats(): FramePacerStats {
        return {
            enabled: this.enabled,
            frameSlotBusy: this.slotBusy,
            totalWaits: this.totalWaits,
            totalWaitTimeMs: this.totalWaitTimeMs,
            currentWaitStartMs: this.currentWaitStartMs,
            immediatePresents: this.immediatePresents,
            heldRefreshes: this.heldRefreshes,
            stalledReleases: this.stalledReleases,
        };
    }

    resetStats(): void {
        this.totalWaits = 0;
        this.totalWaitTimeMs = 0;
        this.currentWaitStartMs = 0;
        this.immediatePresents = 0;
        this.heldRefreshes = 0;
        this.stalledReleases = 0;
    }

    // --- Internal ---

    private scheduleNext(): void {
        if (!this.running) return;
        requestAnimationFrame(() => this.onFrame());
    }

    /** Adaptive cooldown = 85% of measured rAF interval. */
    private get yieldCooldownMs(): number {
        return this.rAfInterval * 0.85;
    }

    private onFrame(): void {
        if (!this.running) return;

        // Monotonic vsync counter — the anchor for grid-locked smooth pacing (waitSmooth).
        this.rafTick++;

        // Measure actual rAF interval (EMA smoothing)
        const now = performance.now();
        if (this.lastRafTime > 0) {
            const measured = now - this.lastRafTime;
            // Only incorporate reasonable intervals (3ms-50ms) to filter outliers
            if (measured > 3 && measured < 50) {
                this.rAfInterval = this.rAfInterval * 0.9 + measured * 0.1;

                // Record rAF interval for diagnostics
                if (frameVarianceDiagnostics.isEnabled()) {
                    frameVarianceDiagnostics.recordRafWait(0, now); // Will calculate interval internally
                }
            }
        }
        this.lastRafTime = now;

        // Grant the permit: release the waiting Flip/Present
        if (this.waiters.length) {
            // Record the actual wait time for diagnostics
            if (frameVarianceDiagnostics.isEnabled() && this.currentWaitStartMs > 0) {
                const waitMs = now - this.currentWaitStartMs;
                frameVarianceDiagnostics.recordRafWait(waitMs, now);
                frameVarianceDiagnostics.recordEvent('frame_pacer_wait', undefined, waitMs);
            }
            this.releaseWaiters();
        } else {
            // No one waiting — queue one permit for next waitForFrameSlot().
            // Only one permit queued at a time (no accumulation).
            this.permitAvailable = true;
        }

        // Fire per-frame callbacks (e.g. THRASH auto-presenter). Guarded individually:
        // scheduleNext() below is the ONLY thing that re-arms rAF, so a throw escaping here
        // stops the pacer for the rest of the session with `running` still true — a freeze
        // that reads as a guest hang and leaves no trace of what threw.
        for (const cb of this.frameCallbacks) {
            try {
                cb();
            } catch (e) {
                recordGpuError("callback", "framePacer.frameCallback", String(e));
                Logger.error(LogCategory.SYSTEM, `[FRAME-PACER] frame callback threw: ${e}`);
            }
        }

        // Poll debug session memory watches (~60Hz, zero-cost when disabled).
        // A debug watch is user-provided code and must not be able to strand the
        // pacer with `running === true`; scheduleNext() is the one re-arm point.
        try {
            debugSession.pollMemWatches();
        } catch (e) {
            recordGpuError("callback", "framePacer.pollMemWatches", String(e));
            Logger.error(LogCategory.SYSTEM, `[FRAME-PACER] memory watch threw: ${e}`);
        }

        this.scheduleNext();
    }
}

export const framePacer = new FramePacerImpl();
