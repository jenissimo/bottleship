export type TimeMode = "realtime" | "manual";

export class TimeService {
    private static instance: TimeService | null = null;
    private mode: TimeMode = "realtime";
    private manualNowMs = 0;
    private manualUnixMs = 0;

    // Instruction-based virtual time: decouples game time from wall-clock.
    // When active, time advances proportionally to CPU instructions executed,
    // preventing large dt spikes when the emulator runs slower than real-time.
    // No drift correction — after a lag, virtual time stays behind wall-clock
    // permanently. The game sees consistent dt every frame (no rubber-banding).
    private virtualTimeActive = false;
    private virtualTimeMs = 0;

    static getInstance(): TimeService {
        if (!TimeService.instance) {
            TimeService.instance = new TimeService();
        }
        return TimeService.instance;
    }

    setMode(mode: TimeMode, nowMs?: number, unixMs?: number): void {
        this.mode = mode;
        if (mode === "manual") {
            if (nowMs !== undefined) {
                this.manualNowMs = nowMs;
            }
            if (unixMs !== undefined) {
                this.manualUnixMs = unixMs;
            } else if (nowMs !== undefined) {
                const delta = nowMs - this.nowMsRealtime();
                this.manualUnixMs = Date.now() + delta;
            }
        }
    }

    setManualTime(nowMs: number, unixMs?: number): void {
        this.mode = "manual";
        this.manualNowMs = nowMs;
        if (unixMs !== undefined) {
            this.manualUnixMs = unixMs;
        } else {
            const delta = nowMs - this.nowMsRealtime();
            this.manualUnixMs = Date.now() + delta;
        }
    }

    advanceByMs(delta: number): void {
        if (this.mode !== "manual") return;
        this.manualNowMs += delta;
        this.manualUnixMs += delta;
    }

    /**
     * Enable instruction-based virtual time.
     * Initializes virtual clock to current wall-clock to avoid discontinuity.
     */
    enableVirtualTime(): void {
        if (this.virtualTimeActive) return;
        this.virtualTimeActive = true;
        this.virtualTimeMs = performance.now();
    }

    /**
     * Advance virtual time by the given delta (in ms).
     * Called from HypercallDataManager.updateTimeData() each v86 tick.
     * Pure instruction-based — no drift correction, no rubber-banding.
     *
     * RAW primitive: callers that credit *measured wall elapsed* (updateTimeData's
     * clamped instruction delta, video-decode elapsed, heavy-thunk deficit, the idle
     * pump's wall delta) are self-bounded by real time and use this directly. Callers
     * that credit a *requested* amount not tied to elapsed wall (sole-runnable Sleep)
     * MUST use creditIdleMs() instead — see the runaway note there.
     *
     * ONE carve-out from that rule: the monotonicity floor in HypercallDataManager's
     * publishClock() credits an amount that is not wall-derived either, and still must use
     * this primitive. That amount has already been SERVED to the guest by the WASM
     * interpolation; clamping it to the wall leash would leave TimeService below the page and
     * make the next publish recompute the same backwards step. It is self-limiting: virtual
     * then leads wall, so updateTimeData's own clamp holds the clock still until wall catches up.
     */
    advanceVirtualTime(deltaMs: number): void {
        if (!this.virtualTimeActive) return;
        this.virtualTimeMs += deltaMs;
    }

    /**
     * Credit virtual time for a guest-requested idle that generated no instructions
     * (sole-runnable Sleep), clamped so virtual never leads wall by > MAX_AHEAD_MS —
     * the SAME ceiling updateTimeData() enforces on the instruction clock.
     *
     * Why the clamp is load-bearing: a game whose main loop pumps Sleep(1-2) thousands
     * of times/sec (Storm engine / Sea Dogs) would, with a raw advanceVirtualTime(ms),
     * accumulate an unbounded virtual-ahead-of-wall lead. Once virtual leads wall,
     * updateTimeData's `maxAllowed = wall + MAX_AHEAD - virtual` goes negative and
     * zeroes ALL instruction-based advance — stranding the guest clock on this trickle
     * credit alone (~2ms/frame) while the audio DAC runs on wall → 3D in slow motion,
     * audio at real time. Clamping here keeps every advance path servo'd to wall, so
     * a stalled clock still unfreezes (NFSU pump) but a fast one can't run away.
     * Returns the ms actually credited.
     */
    creditIdleMs(ms: number): number {
        if (!this.virtualTimeActive || ms <= 0) return 0;
        const headroom = performance.now() + TimeService.MAX_AHEAD_MS - this.virtualTimeMs;
        const credit = Math.max(0, Math.min(ms, headroom));
        this.virtualTimeMs += credit;
        return credit;
    }

    /** True wall-clock time for non-game use (diagnostics, frame pacing). */
    wallClockMs(): number {
        return performance.now();
    }

    /**
     * Re-anchor virtual time to wall-clock after a pause/resume cycle.
     * Without this, the gap between wall-clock (which advanced during pause)
     * and virtual time (which froze) causes updateTimeData() to allow
     * accelerated catch-up on resume.
     */
    notifyPauseResume(): void {
        this.reanchorForward();
    }

    /**
     * Re-anchor virtual time to wall-clock after a heavy sync thunk.
     * On real hardware, no WinAPI call takes >2ms. If a sync thunk takes longer,
     * that's pure emulation overhead — virtual time should pretend it never happened.
     * Prevents catch-up acceleration (death spiral) after slow JS implementations.
     */
    reanchorToWallClock(): void {
        this.reanchorForward();
    }

    /**
     * Close a virtual-behind-wall deficit — and only ever forwards. In steady state virtual
     * LEADS wall by up to MAX_AHEAD_MS, so a plain `= performance.now()` is a backwards step
     * of the clock every guest elapsed-time API reads; an unsigned DWORD delta over that reads
     * as ~2^32 ms. Anchoring to the max of the two keeps the catch-up these callers want
     * without ever un-serving a value the guest could already have observed.
     */
    private reanchorForward(): void {
        if (!this.virtualTimeActive) return;
        this.virtualTimeMs = Math.max(this.virtualTimeMs, this.lastReturnedMs, performance.now());
    }

    isVirtualTimeActive(): boolean {
        return this.virtualTimeActive;
    }

    /** Drop harness/manual/replay time state so the next game starts from a clean clock. */
    resetForGameSwitch(): void {
        this.mode = "realtime";
        this.manualNowMs = 0;
        this.manualUnixMs = 0;
        this.lastReturnedMs = 0;
        if (this.virtualTimeActive) {
            this.virtualTimeMs = performance.now();
        }
    }

    private lastReturnedMs = 0;
    // MAX_DELTA_MS: catch catastrophic spikes only (e.g. tab backgrounded, heavy I/O).
    // With drift correction removed, normal frame-to-frame dt is instruction-based
    // and inherently stable — this is a safety net, not a regular path.
    private static readonly MAX_DELTA_MS = 60_000; // Effectively disabled — games handle their own dt clamping
    private static readonly CLAMP_DELTA_MS = 16.666;
    // Shared invariant: virtual time must never lead wall clock by more than this.
    // Enforced by BOTH updateTimeData()'s instruction clamp and creditIdleMs() so no
    // single advance path can run the guest clock away from wall (which strands the
    // updateTimeData clamp at 0 → frozen instruction clock → slow-motion + audio desync).
    // Must stay in sync with hypercall-data.ts's MAX_AHEAD_MS (updateTimeData's clamp).
    static readonly MAX_AHEAD_MS = 2;

    nowMs(): number {
        let currentMs: number;
        if (this.mode === "manual") {
            currentMs = this.manualNowMs;
        } else if (this.virtualTimeActive) {
            currentMs = this.virtualTimeMs;
        } else {
            currentMs = this.nowMsRealtime();
        }

        // Safety net: clamp catastrophic dt spikes (tab backgrounded, heavy I/O).
        // With instruction-based time this should rarely fire — it's a last resort.
        if (this.lastReturnedMs > 0 && this.mode !== "manual") {
            const delta = currentMs - this.lastReturnedMs;
            if (delta > TimeService.MAX_DELTA_MS) {
                // Use console.warn instead of Logger.warn to avoid infinite recursion,
                // as Logger calls nowMs() to timestamp its entries.
                console.warn(
                    `[TimeService] Delta spike detected: ${delta.toFixed(2)}ms. Clamping to ${TimeService.CLAMP_DELTA_MS}ms.`
                );
                currentMs = this.lastReturnedMs + TimeService.CLAMP_DELTA_MS;
                // Sync virtual time to clamped value so we don't accumulate a gap
                if (this.virtualTimeActive) {
                    this.virtualTimeMs = currentMs;
                }
            }
        }

        // Monotonic floor. Everything the guest reads as ELAPSED time comes through here —
        // the GetTickCount/timeGetTime/QPC fast paths, CRT clock(), GetMessageTime, every
        // timer deadline — and every one of those is compared with an unsigned subtract by
        // the guest, so a backwards step of a millisecond reads as ~2^32 units rather than a
        // small negative. Placing the floor at the single accessor is what makes it
        // unbypassable; the WASM tier enforces the same invariant on its own representation
        // in HypercallDataManager.publishClock. Manual mode is exempt: the harness sets the
        // clock deliberately and is entitled to rewind it.
        if (this.mode !== "manual" && currentMs < this.lastReturnedMs) {
            currentMs = this.lastReturnedMs;
            if (this.virtualTimeActive) this.virtualTimeMs = currentMs;
        }

        this.lastReturnedMs = currentMs;
        return currentMs;
    }

    nowUnixMs(): number {
        if (this.mode === "manual") {
            return this.manualUnixMs;
        }
        return Date.now();
    }

    nowMicros(): number {
        return Math.floor(this.nowMs() * 1000);
    }

    getMode(): TimeMode {
        return this.mode;
    }

    private nowMsRealtime(): number {
        return performance.now();
    }

    /**
     * Fast path implementations for high-frequency time functions
     * These bypass the normal thunk marshaling for better performance.
     *
     * They are the tier BELOW the WASM hypercalls, which serve the same four APIs from
     * HYPERCALL_PAGE as `base + retired-insn interpolation`. These read the published base
     * only, so a value served here can trail the WASM answer by up to one publish interval —
     * they must not be the primary tier for a clock the WASM tier is also serving.
     */

    static fastPathGetTickCount(cpu: any, memory: Uint8Array): number {
        const timeService = TimeService.getInstance();
        return timeService.nowMs() | 0;
    }

    static fastPathQueryPerformanceCounter(cpu: any, memory: Uint8Array): number {
        const timeService = TimeService.getInstance();
        const esp = cpu.reg32[4]; // ESP register
        const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);

        // Read argument from stack (first argument at ESP + 4)
        let lpPerformanceCount = 0;
        if (esp + 4 + 4 <= memory.length) {
            lpPerformanceCount = view.getUint32(esp + 4, true);
        }

        if (lpPerformanceCount !== 0 && lpPerformanceCount + 8 <= memory.length) {
            const now = BigInt(timeService.nowMicros());
            view.setBigUint64(lpPerformanceCount, now, true);
        }
        return 1; // TRUE
    }

    static fastPathQueryPerformanceFrequency(cpu: any, memory: Uint8Array): number {
        const esp = cpu.reg32[4]; // ESP register
        const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);

        // Read argument from stack (first argument at ESP + 4)
        let lpFrequency = 0;
        if (esp + 4 + 4 <= memory.length) {
            lpFrequency = view.getUint32(esp + 4, true);
        }

        if (lpFrequency !== 0 && lpFrequency + 8 <= memory.length) {
            const freq = BigInt(1000000); // 1 MHz
            view.setBigUint64(lpFrequency, freq, true);
        }
        return 1; // TRUE
    }
}
