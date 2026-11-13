/**
 * How fast this host actually runs the guest, for the stats overlay and the one-shot
 * "the game is running slowly" hint.
 *
 * The figure is BUSY MIPS: retired guest instructions (all guest threads — they share one v86
 * register file, so a per-thread rate would only describe the scheduler's split) per ms the
 * worker spent inside v86 ticks, minus the part of those ticks parked in a synchronous SAB
 * read. Dividing by wall time instead would read a guest in Sleep/WaitForSingleObject as a
 * slow host. A spin-wait is NOT excluded and need not be: it retires instructions at full
 * speed, so it reads high, never low.
 *
 * Busy time is NOT guest time: it also holds every synchronous thunk (HLE) and whatever the
 * presenter does inside a tick. Nothing always-on times thunks (frame-profiler does, only while
 * armed), so the figure cannot be split, and a title whose tick is mostly HLE — hundreds of
 * BltFast/DrawPrimitive per frame — reads a few MIPS at full speed with an idle host CPU
 * (issue #354). The overlay therefore shows busy MIPS as an upper bound on host trouble, and the
 * hint does not trust it alone: see SlowExecutionDetector for the two extra symptoms it needs.
 *
 * Cost: a sample is a handful of counter reads every SAMPLE_INTERVAL_MS, taken from the tick
 * exit hook behind one comparison. Nothing is added to the guest path, per thunk or per present:
 * the HLE-call and present counts are counters the dispatcher and RenderService already keep.
 */

export const SAMPLE_INTERVAL_MS = 500;

/** A window whose guest-busy share is below this says nothing about host speed: the guest
 *  was mostly idle, so the few instructions it ran are dominated by JS around them. */
export const MIN_BUSY_SHARE_FOR_MIPS = 0.2;

/** Time constant of the displayed MIPS average, in busy ms. */
const SMOOTH_TAU_MS = 2000;

/** JIT as the engine is running it right now, read back from v86's config slots. */
export type JitEffective = "on" | "off" | "notail" | "unknown";
/** Why: the page's policy (host-jit-policy.ts) or a runtime switch nobody asked the page for. */
export type JitReason = "default" | "query" | "ios-webkit-27" | "runtime";

export interface ExecCounters {
    atMs: number;
    /** v86's 32-bit retired-instruction counter, raw. */
    insns: number;
    /** Monotonic in-tick worker time (worker-time-accounting). */
    inTickMs: number;
    /** Monotonic synchronous SAB wait, a slice of inTickMs. */
    sabWaitMs: number;
    /** Monotonic count of HLE calls (OUT-trap thunks, fast and slow tier); absent = unknown. */
    hleCalls?: number;
    /** Monotonic count of presents the GUEST drove; absent = unknown. */
    presents?: number;
}

export interface ExecWindow {
    ms: number;
    busyMs: number;
    insns: number;
    /** busyMs / ms. */
    busyShare: number;
    /** SAB wait / ms — a guest loading from the bundle. */
    ioShare: number;
    /** Instructions per busy µs; null when the window was too idle to say. */
    busyMips: number | null;
    /** HLE calls per million retired guest instructions — a property of the WORKLOAD, not of
     *  host speed (a slow host runs the same code at the same call density). High means busy
     *  time is mostly thunks, so busyMips says little about the host. Null = unknown. */
    hlePerMInsn: number | null;
    /** Guest presents per wall second; null = unknown (no source, or the counter was reset). */
    presentsPerSec: number | null;
}

function delta(a: number | undefined, b: number | undefined): number | null {
    if (a === undefined || b === undefined) return null;
    const d = b - a;
    return d >= 0 ? d : null; // a reset counter (new game load) is not a negative rate
}

export function measureWindow(a: ExecCounters, b: ExecCounters): ExecWindow | null {
    const ms = b.atMs - a.atMs;
    if (!(ms > 0)) return null;
    const sab = Math.max(0, b.sabWaitMs - a.sabWaitMs);
    const busyMs = Math.max(0, b.inTickMs - a.inTickMs - sab);
    // Unsigned: the counter wraps every few seconds at game speed; a window is far shorter.
    const insns = (b.insns - a.insns) >>> 0;
    const busyShare = busyMs / ms;
    const hle = delta(a.hleCalls, b.hleCalls);
    const presents = delta(a.presents, b.presents);
    return {
        ms, busyMs, insns, busyShare,
        ioShare: sab / ms,
        busyMips: busyShare >= MIN_BUSY_SHARE_FOR_MIPS && busyMs > 0 ? insns / busyMs / 1000 : null,
        hlePerMInsn: hle !== null && insns > 0 ? hle / (insns / 1e6) : null,
        presentsPerSec: presents !== null ? presents * 1000 / ms : null,
    };
}

/** Busy-time-weighted exponential average; an idle window leaves it untouched. */
export function smoothMips(prev: number | null, w: ExecWindow): number | null {
    if (w.busyMips === null) return prev;
    if (prev === null) return w.busyMips;
    return prev + (w.busyMips - prev) * Math.min(1, w.busyMs / SMOOTH_TAU_MS);
}

/** v86 jit config slot 0 = JIT_DISABLED, slot 12 = RET chaining (`notail` clears it). */
export function effectiveJit(getJitConfig: ((i: number) => number) | undefined): JitEffective {
    if (typeof getJitConfig !== "function") return "unknown";
    if ((getJitConfig(0) >>> 0) !== 0) return "off";
    return (getJitConfig(12) >>> 0) === 0 ? "notail" : "on";
}

/** The page decided `policyMode`; anything the engine reports beyond that was switched at runtime. */
export function jitReason(policyMode: "on" | "off" | "notail", policyReason: Exclude<JitReason, "runtime">,
                          live: JitEffective): JitReason {
    if (live === "unknown" || live === policyMode) return policyReason;
    return "runtime";
}

/**
 * Below this busy MIPS, sustained, the guest is not getting the JIT a desktop host delivers.
 * Measured on NFSU in-game, desktop Chrome: JIT on ~480 busy MIPS, `?jit=0` (v86's own
 * interpreter, wasm still optimised) ~60-68. A host that also stopped optimising wasm/JS
 * lands far below the interpreter figure. 100 keeps ~5x margin under JIT and ~1.5x over
 * the best interpreter run.
 */
export const SLOW_MIPS_THRESHOLD = 100;
/** A window must climb this far above the threshold to clear accumulated slow time. */
export const SLOW_MIPS_RECOVER = 150;
/** `notail` is the iOS WebKit 27 policy: ~69 MIPS on an iPhone against ~37 with no
 *  compilation (host-jit-policy.ts), so its line sits between those two. */
export const SLOW_MIPS_THRESHOLD_NOTAIL = 50;
export const SLOW_MIPS_RECOVER_NOTAIL = 60;

export function slowThresholds(jit: JitEffective): { slow: number; recover: number } {
    return jit === "notail"
        ? { slow: SLOW_MIPS_THRESHOLD_NOTAIL, recover: SLOW_MIPS_RECOVER_NOTAIL }
        : { slow: SLOW_MIPS_THRESHOLD, recover: SLOW_MIPS_RECOVER };
}
/** Slow time required before the hint fires: long enough that a JIT warm-up or one heavy
 *  scene cannot trigger it. */
export const SLOW_SUSTAIN_MS = 10_000;
/** Windows mostly idle or mostly loading are neither slow nor fast evidence. */
export const SLOW_MIN_BUSY_SHARE = 0.5;
export const SLOW_MAX_IO_SHARE = 0.1;
/** Ignore this long after the first present: the JIT is still compiling the hot set. */
export const SLOW_WARMUP_MS = 5_000;

/**
 * Above this many HLE calls per million guest instructions the window is HLE-bound: low busy
 * MIPS there is our thunk time, not a slow host, and the window is no evidence either way.
 *
 * Why 500: at the SLOW_MIPS_THRESHOLD line (100 MIPS) a million instructions cost 10 ms of
 * guest time; 500 calls at <=10 us each are <=5 ms, so below this density the guest's own code
 * is still at least ~2/3 of busy time and a sub-100 reading really is the host. The Forge
 * (issue #354: ~26k BltFast + ~2.5k DrawPrimitive per 3 s, i.e. >=9.5k calls/s, at 7 busy
 * MIPS with busy share 0.5..1 = 3.5..7M insns/s) sits at >=1,350/M — 2.7x over the line.
 */
export const SLOW_MAX_HLE_PER_MINSN = 500;
/**
 * A window presenting at least this often is visibly running and CLEARS accumulated slow
 * time: a slow-host hint on a game at 37-60 fps is wrong whatever the MIPS say. 20 sits under
 * the 30 fps that 2D/turn-based titles pace themselves to by design, with room for a few
 * dropped frames, and over the ~10-15 fps a starved host actually delivers.
 */
export const SLOW_MAX_PRESENTS_PER_S = 20;

/**
 * Fires at most once: true from feed() on the window that completes SLOW_SUSTAIN_MS of slow,
 * busy, non-loading game time. A window is SLOW only when all three hold:
 *   1. busy MIPS below the JIT-mode line (the host is not running guest code fast);
 *   2. the guest's own code dominates busy time (HLE density <= SLOW_MAX_HLE_PER_MINSN) —
 *      otherwise (1) measures our thunks;
 *   3. presents below SLOW_MAX_PRESENTS_PER_S — the user can see it. A game presenting
 *      faster CLEARS, so a 30 fps-by-design title never accumulates.
 * Windows that cannot judge (idle, loading, before warm-up, HLE-bound) neither add nor clear;
 * a clearly fast window clears. An unknown density or present rate (no source) does not
 * block — the MIPS evidence stands alone as before #354.
 */
export class SlowExecutionDetector {
    private slowMs = 0;
    private fired = false;

    feed(w: ExecWindow, sinceFirstPresentMs: number | null, jit: JitEffective = "on"): boolean {
        if (this.fired) return false;
        if (sinceFirstPresentMs === null || sinceFirstPresentMs < SLOW_WARMUP_MS) return false;
        if (w.presentsPerSec !== null && w.presentsPerSec >= SLOW_MAX_PRESENTS_PER_S) { this.slowMs = 0; return false; }
        if (w.busyMips === null || w.busyShare < SLOW_MIN_BUSY_SHARE || w.ioShare > SLOW_MAX_IO_SHARE) return false;
        if (w.hlePerMInsn !== null && w.hlePerMInsn > SLOW_MAX_HLE_PER_MINSN) return false;
        const t = slowThresholds(jit);
        if (w.busyMips < t.slow) this.slowMs += w.ms;
        else if (w.busyMips >= t.recover) this.slowMs = 0;
        if (this.slowMs < SLOW_SUSTAIN_MS) return false;
        this.fired = true;
        return true;
    }

    get accumulatedSlowMs(): number { return this.slowMs; }
    get hasFired(): boolean { return this.fired; }
}

/** What the worker posts to the page when the detector fires. */
export interface PerfHintMessage {
    type: "perf_hint";
    jit: JitEffective;
    reason: JitReason;
    mips: number;
}

export interface ExecHealthSnapshot {
    /** Smoothed busy MIPS, null until a busy window was seen. */
    mips: number | null;
    /** Last window's busy share (0..1), null before the first window. */
    busyShare: number | null;
    /** Last window's HLE calls per million guest instructions (null = unknown). */
    hlePerMInsn: number | null;
    /** Last window's guest presents per second (null = unknown). */
    presentsPerSec: number | null;
    jit: JitEffective;
    reason: JitReason;
    slowMs: number;
    hinted: boolean;
}

export interface ExecHealthSources {
    readInsns(): number;
    readInTickMs(): number;
    readSabWaitMs(): number;
    /** Existing monotonic HLE-call counter (dispatcher). Optional: absent = density unknown. */
    readHleCalls?: () => number | undefined;
    /** Existing monotonic guest-present counter (RenderService). Optional. */
    readPresents?: () => number | undefined;
    getJitConfig?: (i: number) => number;
}

export class ExecutionHealth {
    private src: ExecHealthSources | null = null;
    private prev: ExecCounters | null = null;
    private nextAtMs = 0;
    private mips: number | null = null;
    private busyShare: number | null = null;
    private hlePerMInsn: number | null = null;
    private presentsPerSec: number | null = null;
    private firstPresentAtMs = -1;
    private detector = new SlowExecutionDetector();
    private jit: JitEffective = "unknown";
    private reason: JitReason = "default";
    private policyMode: "on" | "off" | "notail" = "on";
    private policyReason: Exclude<JitReason, "runtime"> = "default";
    private onHint: ((m: PerfHintMessage) => void) | null = null;
    private onUpdate: ((s: ExecHealthSnapshot) => void) | null = null;

    setPolicy(mode: "on" | "off" | "notail", reason: Exclude<JitReason, "runtime">): void {
        this.policyMode = mode;
        this.policyReason = reason;
    }

    getPolicyReason(): Exclude<JitReason, "runtime"> { return this.policyReason; }

    setSinks(onHint: (m: PerfHintMessage) => void, onUpdate: (s: ExecHealthSnapshot) => void): void {
        this.onHint = onHint;
        this.onUpdate = onUpdate;
    }

    /** Bind to a freshly initialised v86. A new session starts a new history. */
    attach(src: ExecHealthSources): void {
        this.src = src;
        this.prev = null;
        this.nextAtMs = 0;
        this.mips = null;
        this.busyShare = null;
        this.hlePerMInsn = null;
        this.presentsPerSec = null;
        this.firstPresentAtMs = -1;
        this.detector = new SlowExecutionDetector();
    }

    noteFirstPresent(nowMs: number): void {
        if (this.firstPresentAtMs < 0) this.firstPresentAtMs = nowMs;
    }

    /** Called at every tick exit with that tick's timestamp; samples once per interval. */
    maybeSample(nowMs: number): void {
        if (nowMs < this.nextAtMs || !this.src) return;
        this.nextAtMs = nowMs + SAMPLE_INTERVAL_MS;
        const src = this.src;
        const cur: ExecCounters = {
            atMs: nowMs, insns: src.readInsns() >>> 0,
            inTickMs: src.readInTickMs(), sabWaitMs: src.readSabWaitMs(),
            hleCalls: src.readHleCalls?.(), presents: src.readPresents?.(),
        };
        const prev = this.prev;
        this.prev = cur;
        this.jit = effectiveJit(src.getJitConfig);
        this.reason = jitReason(this.policyMode, this.policyReason, this.jit);
        if (!prev) return;
        const w = measureWindow(prev, cur);
        // A window spanning a pause or a backgrounded tab is not one period of execution.
        if (!w || w.ms > SAMPLE_INTERVAL_MS * 4) return;
        this.mips = smoothMips(this.mips, w);
        this.busyShare = w.busyShare;
        this.hlePerMInsn = w.hlePerMInsn;
        this.presentsPerSec = w.presentsPerSec;
        const since = this.firstPresentAtMs < 0 ? null : nowMs - this.firstPresentAtMs;
        if (this.detector.feed(w, since, this.jit) && this.onHint) {
            this.onHint({ type: "perf_hint", jit: this.jit, reason: this.reason, mips: Math.round(this.mips ?? w.busyMips ?? 0) });
        }
        this.onUpdate?.(this.snapshot());
    }

    snapshot(): ExecHealthSnapshot {
        return {
            mips: this.mips, busyShare: this.busyShare,
            hlePerMInsn: this.hlePerMInsn, presentsPerSec: this.presentsPerSec,
            jit: this.jit, reason: this.reason,
            slowMs: this.detector.accumulatedSlowMs, hinted: this.detector.hasFired,
        };
    }
}

// @transient(host-speed telemetry, not guest state; attach() restarts its history at every v86 init)
export const execHealth = new ExecutionHealth();
