/**
 * PreemptionManager — controls the writable cycle limit in WASM's HYPERCALL_PAGE.
 *
 * In single-thread mode, cycle_limit matches the original LOOP_COUNTER (100_003).
 * In multi-thread mode, it's lowered to a quantum (~50K instructions) so
 * do_many_cycles_native() exits early and the JS tick hook can preempt.
 */

import { EmulatorConfig } from "../emulator-config-manager";
import { canonicalizeFpuSnapshotForMode } from "../fpu-helper";

const OFF_CYCLE_LIMIT = 0x000;

export class PreemptionManager {
    private hpBase = 0;
    private wasmMemory: ArrayBuffer | null = null;
    private view: DataView | null = null;
    /** WebAssembly.Memory — .buffer changes on grow, but the object itself is stable. */
    private wasmMemoryObj: any = null;
    private wasmExports: any = null;
    private multiThread = false;
    private initialized = false;

    /** Raw v86 wasm exports (set_jit_config, dbg_*, etc.) — used by the guest debugger. */
    getWasmExports(): any { return this.wasmExports; }

    /** Single source of truth for relaxed-FPU. Re-applied on every v86 init (per game
     *  load) so it survives the wasm flag reset; toggled live by dbg.relaxedFpu(). */
    private relaxedFpuEnabled = true;

    /** JIT dead-flag elision. Default ON; kill-switch via setDeadFlagElision(false)
     *  or globalThis.DISABLE_JIT_DEAD_FLAG_ELISION before first v86 boot. */
    private deadFlagElisionEnabled = true;

    /** Retired read-fastmem is unavailable. All remaining choices are re-applied per v86 init.
     *  Kill-switches: setX87Locals/setPushRunCoalescing(false) or the
     *  dbg.*(false) verbs (which route through these setters, so the choice survives a
     *  game reload). The read map preserves #PF semantics per page.
     *  x87-locals is a no-op under strict/PC=24 FPU (codegen self-gates). */
    /** idx 10 — default OFF until representative FP scenes clear the decision gate. */
    private x87LocalsEnabled = false;           // config idx 10
    private pushRunCoalescingEnabled = true;    // config idx 11

    /** Fastmem WRITES behind the per-page writability map (config idx 19).
     *  Default OFF until the in-game gate passes. The
     *  map must be authoritatively (re)built from region-intent ∩ PTE-state before enabling
     *  (a stale/all-zero map is safe = all-slow, but a wrong bit0 is corruption) — the
     *  dbg.fastmemWrites verb does that rebuild before flipping this on. Kill-switch:
     *  setFastmemWrites(false) / dbg.fastmemWrites(false). */
    private fastmemWritesEnabled = false;       // config idx 19

    /** Lazy-flag tuple in wasm locals (config idx 21). Default OFF — the gate has now RUN and
     *  it is a LOSS on FP-heavy code: tools/bench-v86 nbench (relaxed FPU, prod flags) gives
     *  FOURIER 5617 vs 6362 and LU 180.3 vs 199.4 with it on, i.e. −10…−12 %, far outside the
     *  ~3.6 % noise floor. Don't re-flip it without an integer-workload case.
     *  Kill-switch: setFlagLocals(false) / dbg.flagLocals(false). Toggle clears the JIT cache
     *  (shape baked into modules). */
    private flagLocalsEnabled = false;          // config idx 21

    /** Wasm branch hints on guard slow paths (config idx 22) — a BITMASK of hint groups,
     *  not a boolean: bit0 = memory/TLB guards, bit1 = x87 guards. Only the optimizing tier
     *  reads the hint section, so the payoff tracks the Turboshaft share (dbg.jitTierStats).
     *  Default is bit0 only; bit1 is unmeasured on its own. Baked into emitted modules ⇒
     *  toggle clears the JIT cache. Kill-switch: dbg.branchHints(0). */
    private branchHintMask = 1;                 // config idx 22

    /** Dynamic dispatch wave, default ON. Both paths respect the
     *  budget/in_hlt guard so async-park is honored. Kill-switches:
     *  setRetChaining/setRetSpeculation(false) or dbg.jitRetChain/jitRetSpec(false). */
    private retChainingEnabled = true;          // config idx 12
    private retSpeculationEnabled = true;       // config idx 13

    /** Experimental hotness tiering (config idx 15 = per-module retired-instruction
     *  threshold, 0 = OFF). The retired-instruction census and bounded replacement
     *  policy are available for workload A/Bs, but expanded modules regressed the
     *  corrected mixed RE benchmark, so production defaults to OFF. Enable with
     *  dbg.jitTier2(19200000); disable with dbg.jitTier2(0) — both are routed through
     *  setTier2Threshold so the choice survives a game reload. Generated modules
     *  account before exits and chained tail calls, so long loops and fragmented
     *  code compete in the same unit. */
    private tier2Threshold = 0;                 // config idx 15 (experimental, opt-in)

    /** Walks every PARKED thread's saved x87 snapshot. Registered by the Scheduler
     *  (which owns the thread table and already depends on this module), same provider
     *  seam as stack-write-guard's setParkedStackProvider. */
    private savedFpuStateProvider: ((visit: (snap: Uint8Array) => void) => void) | null = null;

    setSavedFpuStateProvider(provider: ((visit: (snap: Uint8Array) => void) => void) | null): void {
        this.savedFpuStateProvider = provider;
    }

    /** Set the relaxed-FPU mode authoritatively: stores the desired state (so the NEXT
     *  v86 init boots with it) AND applies it live + clears the JIT cache so FPU-bearing
     *  blocks recompile. on=false → strict F80 (diagnostic A/B). */
    setRelaxedFpu(on: boolean): void {
        this.relaxedFpuEnabled = on;
        const ex = this.wasmExports;
        // The LIVE wasm flag decides whether the mode actually flips — a manifest
        // fpuStrict boot leaves wasm strict while relaxedFpuEnabled is true.
        const wasRelaxed = typeof ex?.get_relaxed_fpu === "function"
            ? (ex.get_relaxed_fpu() >>> 0) !== 0
            : on;
        if (ex?.set_relaxed_fpu) ex.set_relaxed_fpu(on ? 1 : 0);
        // set_relaxed_fpu canonicalizes only the LIVE register file; the parked threads'
        // saved snapshots are the same shared register file under the OLD tag rules and
        // would be restored as garbage. Boot (initialize) calls the export directly and
        // never pays for this — there are no meaningful saved contexts at init.
        if (wasRelaxed !== on) this.canonicalizeSavedFpuStates(on);
        if (ex?.jit_clear_cache_js) ex.jit_clear_cache_js();
    }

    /** A thread's context.fpu and lastFpuState routinely alias one buffer — visit each
     *  distinct snapshot once. */
    private canonicalizeSavedFpuStates(toRelaxed: boolean): void {
        const provider = this.savedFpuStateProvider;
        if (!provider) return;
        const seen = new Set<Uint8Array>();
        let converted = 0;
        provider((snap) => {
            if (seen.has(snap)) return;
            seen.add(snap);
            if (canonicalizeFpuSnapshotForMode(snap, toRelaxed)) converted++;
        });
        console.log(`[PERF] relaxed-FPU → ${toRelaxed ? "relaxed" : "strict"}: re-encoded ${converted}/${seen.size} saved x87 snapshots`);
    }

    /** Current desired relaxed-FPU state (the single authority). */
    isRelaxedFpuEnabled(): boolean { return this.relaxedFpuEnabled; }

    private applyJitConfig(ex: any, index: number, value: number): boolean {
        if (typeof ex?.set_jit_config !== "function") return false;
        const status = ex.set_jit_config(index >>> 0, value >>> 0);
        if (status !== 0) {
            throw new Error(`set_jit_config(${index}, ${value}) failed with status ${status}`);
        }
        return true;
    }

    /** JIT dead-flag elision — authoritative toggle (survives game reload). */
    setDeadFlagElision(on: boolean): void {
        this.deadFlagElisionEnabled = on;
        const ex = this.wasmExports;
        this.applyJitConfig(ex, 5, on ? 1 : 0);
        if (ex?.jit_clear_cache_js) ex.jit_clear_cache_js();
    }

    isDeadFlagElisionEnabled(): boolean { return this.deadFlagElisionEnabled; }

    /** Fastmem-wave authoritative toggles (survive game reload). Each stores the
     *  desired state (re-applied on next v86 init) AND applies live + clears the JIT
     *  cache so affected blocks recompile. */
    /** Fastmem writes (config idx 19). Authoritative toggle (survives
     *  game reload). The CALLER (dbg.fastmemWrites) must rebuild the write map before
     *  enabling — this only flips the flag + clears the JIT cache so stores recompile. */
    setFastmemWrites(on: boolean): void {
        this.fastmemWritesEnabled = on;
        const ex = this.wasmExports;
        this.applyJitConfig(ex, 19, on ? 1 : 0);
        if (ex?.jit_clear_cache_js) ex.jit_clear_cache_js();
    }
    isFastmemWritesEnabled(): boolean { return this.fastmemWritesEnabled; }

    /** Flag-tuple in wasm locals (idx 21). Authoritative (survives
     *  game reload); clears the JIT cache so flag-bearing blocks recompile. */
    setFlagLocals(on: boolean): void {
        this.flagLocalsEnabled = on;
        const ex = this.wasmExports;
        this.applyJitConfig(ex, 21, on ? 1 : 0);
        if (ex?.jit_clear_cache_js) ex.jit_clear_cache_js();
    }
    isFlagLocalsEnabled(): boolean { return this.flagLocalsEnabled; }

    /** Branch-hint mask (idx 22). Authoritative (survives game reload); clears the JIT
     *  cache so guard-bearing blocks re-emit with/without the hint section. */
    setBranchHints(mask: number): void {
        this.branchHintMask = mask >>> 0;
        const ex = this.wasmExports;
        this.applyJitConfig(ex, 22, this.branchHintMask);
        if (ex?.jit_clear_cache_js) ex.jit_clear_cache_js();
    }
    getBranchHintMask(): number { return this.branchHintMask; }

    setX87Locals(on: boolean): void {
        this.x87LocalsEnabled = on;
        const ex = this.wasmExports;
        this.applyJitConfig(ex, 10, on ? 1 : 0);
        if (ex?.jit_clear_cache_js) ex.jit_clear_cache_js();
    }
    isX87LocalsEnabled(): boolean { return this.x87LocalsEnabled; }

    setPushRunCoalescing(on: boolean): void {
        this.pushRunCoalescingEnabled = on;
        const ex = this.wasmExports;
        this.applyJitConfig(ex, 11, on ? 1 : 0);
        if (ex?.jit_clear_cache_js) ex.jit_clear_cache_js();
    }
    isPushRunCoalescingEnabled(): boolean { return this.pushRunCoalescingEnabled; }

    setRetChaining(on: boolean): void {
        this.retChainingEnabled = on;
        const ex = this.wasmExports;
        this.applyJitConfig(ex, 12, on ? 1 : 0);
        if (ex?.jit_clear_cache_js) ex.jit_clear_cache_js();
    }
    isRetChainingEnabled(): boolean { return this.retChainingEnabled; }

    setRetSpeculation(on: boolean): void {
        this.retSpeculationEnabled = on;
        const ex = this.wasmExports;
        this.applyJitConfig(ex, 13, on ? 1 : 0);
        if (ex?.jit_clear_cache_js) ex.jit_clear_cache_js();
    }
    isRetSpeculationEnabled(): boolean { return this.retSpeculationEnabled; }

    /** Hotness-tiering authoritative toggle (survives game reload). Nonzero threshold changes
     *  apply to future crossings; zero is a real kill switch and clears compiled JIT state. */
    setTier2Threshold(threshold: number): void {
        this.tier2Threshold = threshold >>> 0;
        const ex = this.wasmExports;
        this.applyJitConfig(ex, 15, this.tier2Threshold);
    }
    getTier2Threshold(): number { return this.tier2Threshold; }

    /** 5× original LOOP_COUNTER — reduces postMessage round-trips from ~1K/s to ~200/s.
     *  Each do_many_cycles_native() runs ~5ms instead of ~1ms, matching TIME_PER_FRAME=1ms
     *  (inner loop exits immediately after first iteration since 5ms > 1ms threshold).
     *  GetTickCount/QPC stay accurate via WASM instruction-count interpolation. */
    static readonly SINGLE_THREAD_LIMIT = 500_003;
    /** ~0.5ms at 100 MIPS */
    static readonly MULTI_THREAD_QUANTUM = 50_000;

    initialize(cpu: any): void {
        this.wasmExports = cpu.wm?.exports;
        if (!this.wasmExports?.get_hypercall_page_ptr) {
            return;
        }
        this.hpBase = this.wasmExports.get_hypercall_page_ptr();
        this.refreshViews(cpu);
        this.setCycleLimit(PreemptionManager.SINGLE_THREAD_LIMIT);

        // Relaxed FPU — inline x87 path matches helpers (see vendor/v86/tests/fpu-relaxed-diff.mjs).
        // SINGLE SOURCE OF TRUTH: `this.relaxedFpuEnabled` (default true). v86 is re-created per
        // game load and the wasm flag resets to its codegen default, so we MUST re-apply the
        // desired state here every init. dbg.relaxedFpu()/setRelaxedFpu() update this flag, so a
        // pre-load `setRelaxedFpu(false)` makes the guest boot strict-F80 (valid OFF-from-boot
        // A/B — a post-boot toggle can't undo boot-time relaxed-FPU corruption).
        // A bundle may declare `manifest.emulator.fpuStrict` (precision-sensitive titles, e.g.
        // OGG Vorbis audio — see EmulatorConfig.fpuStrict). That forces strict F80 at boot
        // regardless of the global relaxed-FPU default, WITHOUT mutating relaxedFpuEnabled (so a
        // later dbg.relaxedFpu() toggle / a non-strict bundle still honors the user/default).
        const fpuStrict = EmulatorConfig.getInstance().fpuStrict === true;
        const relaxedEffective = fpuStrict ? false : this.relaxedFpuEnabled;
        if (this.wasmExports.set_relaxed_fpu) {
            this.wasmExports.set_relaxed_fpu(relaxedEffective ? 1 : 0);
            console.log(`[PERF] relaxed-FPU mode ${relaxedEffective ? "enabled" : "DISABLED (strict F80)"}${fpuStrict ? " [manifest fpuStrict]" : ""}`);
        } else {
            console.warn("[PERF] relaxed-FPU export missing — vendor/v86 may need rebuild. FPU ops will pay full 80-bit biasing cost.");
        }

        if (this.wasmExports.set_jit_config) {
            this.applyJitConfig(this.wasmExports, 5, this.deadFlagElisionEnabled ? 1 : 0);
            console.log(`[PERF] JIT dead-flag elision ${this.deadFlagElisionEnabled ? "enabled" : "DISABLED"}`);

            // Codegen wave (idx 10/11) — re-applied per init because v86
            // resets the wasm flags to their codegen default (OFF) on every game load.
            this.applyJitConfig(this.wasmExports, 10, this.x87LocalsEnabled ? 1 : 0);
            this.applyJitConfig(this.wasmExports, 11, this.pushRunCoalescingEnabled ? 1 : 0);
            // Fastmem-writes idx 19 — re-applied per init. Default OFF; when enabled the
            // write map is rebuilt by the enable path (dbg.fastmemWrites), not here (regions
            // may not be registered yet at v86 init). A fresh wasm instance starts with an
            // all-zero map = all-slow = safe, so re-applying the flag alone can't corrupt.
            this.applyJitConfig(this.wasmExports, 19, this.fastmemWritesEnabled ? 1 : 0);
            // Flag-locals idx 21 — re-applied per init (wasm default OFF). Applied at
            // boot = cold cache, recompile free.
            this.applyJitConfig(this.wasmExports, 21, this.flagLocalsEnabled ? 1 : 0);
            // Branch hints idx 22 — re-applied per init (wasm default OFF). Applied at
            // boot = cold cache, so the implied re-emit is free.
            this.applyJitConfig(this.wasmExports, 22, this.branchHintMask);
            console.log(`[PERF] fastmem-wave: reads=retired x87Locals=${this.x87LocalsEnabled ? "on" : "off"} pushRun=${this.pushRunCoalescingEnabled ? "on" : "off"} writes=${this.fastmemWritesEnabled ? "on" : "off"} flagLocals=${this.flagLocalsEnabled ? "on" : "off"} branchHints=${this.branchHintMask || "off"}`);

            // Dynamic-dispatch wave (idx 12/13) — default ON, re-applied per init (wasm
            // codegen defaults are OFF). Applied at boot = cold cache, so the implied
            // recompile is free (no mid-run cache clear).
            this.applyJitConfig(this.wasmExports, 12, this.retChainingEnabled ? 1 : 0);
            this.applyJitConfig(this.wasmExports, 13, this.retSpeculationEnabled ? 1 : 0);
            console.log(`[PERF] dynamic dispatch: retChain=${this.retChainingEnabled ? "on" : "off"} retSpec=${this.retSpeculationEnabled ? "on" : "off"}`);

            // Hotness tiering (idx 15) — re-applied every init; the TS field is the
            // authority (wasm statics reset per game load).
            this.applyJitConfig(this.wasmExports, 15, this.tier2Threshold);
            console.log(`[PERF] B3 tiering: retiredThreshold=${this.tier2Threshold || "OFF"}`);
        }

        // Re-apply any active guest-debugger config onto this (fresh) wasm instance.
        // v86 is re-created per game load, which clears the wasm dbg_* statics; the
        // debugger keeps its intended config in dbg-commands and re-applies it here.
        try { (globalThis as any).__applyDbgConfig?.(this.wasmExports); } catch { /* debugger optional */ }

        this.initialized = true;
    }

    isInitialized(): boolean {
        return this.initialized;
    }

    getHypercallPageBase(): number {
        return this.hpBase;
    }

    /** Refresh DataView if WASM memory grew (old buffer detached on grow). */
    private refreshViews(cpu?: any): void {
        // Prefer the stable Memory object — its .buffer is always current.
        const mem = cpu?.wasm_memory ?? this.wasmMemoryObj ?? this.wasmExports?.memory;
        if (mem && this.wasmMemoryObj !== mem) this.wasmMemoryObj = mem;
        const buf: ArrayBuffer | undefined = this.wasmMemoryObj?.buffer;
        if (!buf) return;
        if (buf !== this.wasmMemory) {
            this.wasmMemory = buf;
            this.view = new DataView(buf);
        }
    }

    private setCycleLimit(limit: number): void {
        if (this.hpBase === 0) return;
        // WASM memory grow detaches the old ArrayBuffer, invalidating our DataView.
        // Detect via byteLength===0 (detached buffers report 0) and rebuild.
        if (!this.view || !this.wasmMemory || this.wasmMemory.byteLength === 0) {
            this.refreshViews();
            if (!this.view) return;
        }
        try {
            this.view.setUint32(this.hpBase + OFF_CYCLE_LIMIT, limit, true);
        } catch {
            this.refreshViews();
            this.view?.setUint32(this.hpBase + OFF_CYCLE_LIMIT, limit, true);
        }
    }

    /**
     * Force v86 to exit its current cycle loop as soon as possible.
     * Writes 0 to the hypercall page cycle-limit slot so the next read
     * in WASM's do_many_cycles_native breaks the inner loop immediately.
     *
     * Callers use this after transitioning the current thread to WAITING
     * (e.g. async thunk parking) to avoid burning the full quantum in the
     * spin loop. prepareForExecution() restores the normal limit on the
     * next tick.
     */
    requestImmediateExit(): void {
        if (!this.initialized) return;
        this.setCycleLimit(0);
    }

    /**
     * Cap the NEXT slice at `insns` retired instructions (block-granular, so at least
     * one block always runs). Distinct from requestImmediateExit(), whose limit of 0
     * retires nothing: this is for a caller that needs bounded forward progress and
     * then control back — MemWriteTrap closing a write-trap window before more stores
     * can slip through it. `do_many_cycles_native` reads the limit ONCE per slice, so
     * this only binds a slice that has not started yet: call it from a tick hook, not
     * from inside a thunk. One JS round trip per `insns` — diagnostic use only.
     * A limit already at 0 (async-park urgent exit) is left alone.
     */
    requestBoundedSlice(insns: number): void {
        if (!this.initialized) return;
        if (this.getCycleLimit() === 0) return;
        this.setCycleLimit(Math.max(1, insns | 0));
    }

    /** Read back the live cycle-limit slot (diagnostic). -1 if unavailable. A RUNNING
     *  thread observed with cycle_limit===0 means a per-tick prepareForExecution restore
     *  was missed after an async-park requestImmediateExit → v86 retires 0 instructions
     *  while is_running() stays true (silent freeze). */
    getCycleLimit(): number {
        if (this.hpBase === 0) return -1;
        if (!this.view || !this.wasmMemory || this.wasmMemory.byteLength === 0) {
            this.refreshViews();
            if (!this.view) return -1;
        }
        try {
            return this.view.getUint32(this.hpBase + OFF_CYCLE_LIMIT, true) >>> 0;
        } catch {
            return -1;
        }
    }

    /** Restore the normal single-thread cycle budget. Used by the watchdog self-heal when a
     *  RUNNING thread is found with a 0 budget (missed restore). */
    rearmCycleBudget(): void {
        if (!this.initialized) return;
        this.setCycleLimit(PreemptionManager.SINGLE_THREAD_LIMIT);
    }

    /**
     * Called before main_loop() — set cycle limit for this tick.
     *
     * If `urgentExit` is true (e.g. current guest thread is WAITING on an
     * async thunk), emit cycle_limit=0 so v86 leaves do_many_cycles_native
     * after at most one instruction. Otherwise v86 would honestly execute
     * the spin loop JIT block for a full 500K-cycle quantum before any
     * tick_hooks_after / preemptAtTickBoundary yield can fire.
     */
    prepareForExecution(cpu?: any, urgentExit = false): void {
        if (!this.initialized) return;
        if (cpu) this.refreshViews(cpu);
        // Use SINGLE_THREAD_LIMIT (100K ~1ms) for all modes.
        // Tick-boundary preemption (preemptAtTickBoundary) fires every tick,
        // so even at 100K cycles we get ~1ms preemption granularity.
        // MULTI_THREAD_QUANTUM (50K ~0.5ms) can be enabled later for more
        // responsive scheduling once the tick-boundary path is battle-tested.
        this.setCycleLimit(urgentExit ? 0 : PreemptionManager.SINGLE_THREAD_LIMIT);
    }

    /** Called after main_loop() returns — check if preemption should fire */
    checkPreemption(_cpu?: any): boolean {
        // Disabled — preemption via tick_hooks caused multithreading breakage.
        // The setInterval scheduler (EMU_SCHEDULER_INTERVAL_MS) and
        // onThunkComplete() handle context switching instead.
        return false;
    }

    setMultiThread(enabled: boolean): void {
        this.multiThread = enabled;
    }

    isMultiThread(): boolean {
        return this.multiThread;
    }
}

export const preemptionManager = new PreemptionManager();
