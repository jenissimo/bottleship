/**
 * Scheduler — Clean-Room Rewrite
 *
 * Key principles:
 * 1. Single source of truth: thread.context is null when RUNNING (state is in CPU)
 * 2. All state changes go through transitionTo() for validation
 * 3. onThunkBoundary() is the ONLY context switch point
 * 4. ThunkBoundaryKind eliminates context-save guessing
 * 5. TimerWheel centralizes ALL timers
 * 6. WaitEngine indexes waiters for push-based wakeup
 * 7. No circular dependencies — one-way data flow
 */

import { Logger, LogCategory } from '../logger';
import { invalidateGuestCode } from '../memory/guest-code';
import { Process } from '../process';
import { preemptionManager } from '../cpu/preemption-manager';
import { MEM_THUNK_CODE_BASE, MEM_ROM_BASE } from '../cpu/emulator-config';
import { hypercallDataManager } from '../cpu/hypercall-data';
import { System, type ImplicitTlsEntry } from '../system';
import { SystemResourceProvider } from '../resources/system-resource-provider';
import { TimeService } from '../../runtime/time';
import { clearAllActiveExceptions } from '../seh-dispatch';
import { Mem } from '../memory/mem-accessor';
import { ERROR_INVALID_HANDLE } from '../thunking/thunk-errors';
import { setParkedStackProvider, guardStackWrite } from '../memory/stack-write-guard';
import { TebManager } from '../teb-manager';
import {
    clearFpuSimdDirty,
    createDefaultFpuSnapshot,
    createDefaultSimdSnapshot,
    fpuRestore,
    fpuSnapshot,
    hasFpuSimdDirtyFlag,
    isFpuSimdDirty,
    simdRestore,
    simdSnapshot,
} from '../fpu-helper';
import { TimerWheel } from './timer-wheel';
import { SyncObjectManager } from './sync-objects';
import { WaitEngine } from './wait-engine';
import { CallbackCoordinator } from './callback-coord';
import { TARGET_INSN_PER_MS } from './timing';
import { setFsBase } from './fs-base';
import { framePacer } from '../frame-pacer';
import { frameVarianceDiagnostics } from '../frame-variance-diagnostics';
import {
    Thread, ThreadState, THREAD_STATE_NAMES,
    WaitReason, WAIT_REASON_NAMES, WaitInfo, CpuContext, V86Cpu,
    ThunkBoundaryKind, TimerKind, ApcKind, PendingApc,
    CriticalRuntimeSection, TransientExecRangeKind,
    isValidTransition,
    KernelThreadObject,
    SchedulerConfig, DEFAULT_SCHEDULER_CONFIG,
    WAIT_OBJECT_0, WAIT_IO_COMPLETION, WAIT_TIMEOUT, WAIT_FAILED,
    WAIT_BLOCKED_NO_SWITCH, INFINITE, CREATE_SUSPENDED,
    MAXIMUM_SUSPEND_COUNT, ERROR_SIGNAL_REFUSED,
} from './types';
import {
    isValidGuestEip,
    saveCpuContext,
    createInitialContext,
    createPostReturnContext,
} from './scheduler-context';
import {
    hx,
    boundaryKindName,
    formatThreadSnapshot,
    formatPendingAsyncRestoreQueue,
    formatDetailedThreadInfo,
    diagnoseWaiters as diagnoseWaitersDiag,
    detectDeadlock as detectDeadlockDiag,
    buildYieldReport,
} from './scheduler-diagnostics';
import { PF_HALT_TARGET } from '../bootloader';
import { grantSrwOnWake, ensureSrwWaitEvent } from '../../modules/kernel32/srw-lock';
import type { WinMM } from '../../modules/winmm';

// Max virtual-time advance per idle pollTimeouts() pump. Bounds the jump when the
// idle anchor is stale after a pause / background-throttle gap. See pollTimeouts().
const IDLE_PUMP_MAX_MS = 250;

/** Sole-runnable Sleep(ms): credit+yield only for short pump sleeps; longer → blockThread. */
const SOLE_RUNNABLE_SLEEP_CREDIT_MAX_MS = 50;

// Fairness budget for the winmm timer thread before its queued callbacks are deferred.
// The software audio mixer runs as a timeSetEvent callback on this thread, and cutting it
// short chops the per-tick drain across many scheduler rounds → bursty PCM production →
// SAB underrun → audible crackle. It needs a few ms to finish one tick.
//
// DERIVED, never a bare constant: this budget must never fall BELOW the general quantum,
// or the thread that needs the most headroom becomes the one preempted soonest. That is
// what a bare 4 silently became when minQuantumMs moved 1 → 16 — the relation the budget
// exists to express inverted while the number stayed put.
const WINMM_TIMER_QUANTUM_MS = Math.max(4, DEFAULT_SCHEDULER_CONFIG.minQuantumMs);

interface TimerNoFpuProfile {
    clean: number;
    dirty: number;
    eligible: boolean;
    disabled: boolean;
}

interface TimerFpuBorrow {
    threadId: number;
    callbackAddr: number;
    previousOwnerThreadId: number;
}

export class Scheduler {
    private process: Process | null = null;
    public config: SchedulerConfig;

    // Thread storage
    private threads = new Map<number, Thread>();
    private currentThreadId: number | null = null;
    private nextThreadId = 1;
    private runQueue: number[] = [];

    // TLS
    private tlsSlots = new Set<number>();
    private nextTlsIndex = 0;

    // Owned subsystems
    public timerWheel = new TimerWheel();
    public syncObjects = new SyncObjectManager();
    public waitEngine = new WaitEngine();
    public callbackCoord = new CallbackCoordinator();
    public tebManager = new TebManager();

    private resourceProvider = SystemResourceProvider.getInstance();
    private timeService = TimeService.getInstance();

    // Main thread stack info
    private mainStackBase = 0;
    private mainStackTop = 0;

    // Thread exit stub
    private readonly threadExitFunctionId = 0x7fff0001;
    // Allocated from the reserved THUNK_DATA bucket on first use (see writeThreadExitStub).
    // MUST NOT be a hardcoded HEAP address: the previous value (0x01f90000) sat inside the
    // HEAP bump range but was never reserved, so the allocator handed it to guest COM-struct
    // allocations; the per-CreateThread stub rewrite then clobbered that struct's vtable →
    // use-after-free when the guest released it (Diablo 2 boot crash "escaped to bootloader
    // at 0x7c07").
    private threadExitStubAddr = 0;
    private readonly threadExitStubSize = 32;
    private readonly defaultStackSize = 1024 * 1024;

    // Thunk region boundaries for context save
    private thunkStubBase = 0;
    private thunkStubEnd = 0;
    private spinLoopBase = 0;
    private spinLoopEnd = 0;
    /** Count of times the async-park safety net fired. Non-zero → a thunk path missed markThreadAsyncParked. */
    private spinLoopMissedWaitCount = 0;
    /** Wall-clock of the last SAFETY_NET warn — throttles the log so a long idle-park (e.g. a modal
     *  dialog waiting for input, which can spin >1M times) emits one line/sec instead of thousands.
     *  The unthrottled flood was itself starving the worker's RPC/input pump. */
    private spinLoopLastWarnMs = 0;
    /** Per-thread count of tick boundaries observed with the thread RUNNING inside the
     *  spin-loop page. Before the park-exit wasm fix each hit ≈ one tick of burned JMP $
     *  execution; with it armed, hits are the expected cheap early-exits. See
     *  preemptAtTickBoundary. */
    public spinBoundaryHits = new Map<number, number>();
    /** One-shot latch for telling the wasm cycle loop the park address (set_park_eip).
     *  Armed lazily at the first tick boundary because wasm exports are not reliably
     *  available during initialize(). */
    private parkEipArmed = false;
    /** True while a winmm timer callback is executing under its atomic-execution pin.
     *  A dedicated single-token pin (one kernelPinCount increment over its lifetime) so it
     *  composes with any nested suspended-frame/SEH pin the callback itself may take. See
     *  pinTimerCallbackThread / unpinTimerCallbackThread (callback-chain pin). */
    private timerCallbackPinActive = false;
    /** Telemetry: why the winmm timer-thread callback dispatch did/didn't fire.
     *  deferStreak = current consecutive fairness-defers (reset on invoke);
     *  maxDeferStreak = worst observed run. A high streak = the mixer callback is
     *  being starved across many rounds (bursty production → audio underrun). */
    public timerDispatchStats = { invoked: 0, empty: 0, deferred: 0, eipGuard: 0, spinInFlight: 0, notTimerThread: 0, calls: 0, deferStreak: 0, maxDeferStreak: 0,
        /** Pre-guard: dispatch entry attempted (includes fast rejects). */
        gateCalls: 0,
        /** Pre-guard: no winmm timer thread configured yet. */
        gateNoTimerThread: 0,
        /** Pre-guard: current thread is not the cached timer thread (cheap reject). */
        gateNotTimerThread: 0,
        /** Pre-guard: current thread is timer thread but EIP is not at the spin loop. */
        gateEipNotAtSpin: 0,
        /** Inner safety: cache/current mismatch after passing pre-guard (should stay 0). */
        gateCacheMismatch: 0,
        // timerStalePinCleared: safety-net force-cleared a stale timer-callback pin (should stay 0).
        timerStalePinCleared: 0,
        // maxInflightSeen: peak in-flight winmm_timer callbacks seen at dispatch. With the
        // atomic-execution pin this should stay ~0-1; a climbing value means a residual leak.
        // asyncParkTimer: times the timer thread was ever async-parked (should be 0 — the
        // storm callback has no async thunk; nonzero would mean a new async path appeared).
        // pendRestoreDeferred: dispatch/re-block deferred because a pending async restore
        // exists for the timer thread (each hit = one avoided abandonment/deadlock).
        // notRunning: dispatch skipped because the timer thread was current but not RUNNING
        // (each hit = one avoided callback-slot leak — the root of the 256-slot crash).
        // cbReturnImmediateExit: cycle-slice force-exits after a timer-callback return
        // (see onWinmmTimerCallbackReturned) — should track invoked ~1:1.
        maxInflightSeen: 0, asyncParkTimer: 0, pendRestoreDeferred: 0, notRunning: 0, cbReturnImmediateExit: 0 };
    /** Cached winmm timer-thread metadata — avoids getModule() on every scheduler boundary. */
    private cachedWinmmTimerThreadId = 0;
    private cachedWinmmTimerWakeEvent = 0;
    private cachedWinmmModule: import('../../modules/winmm').WinMM | null = null;
    /** Ring buffer of timer-thread lifecycle events (invoke/asyncPark/restoreQueued/wake/
     *  block/restoreApplied/cbReturn). Instrument for winmm callback-abandonment bugs:
     * on a frozen boot it shows the exact event order around a lost mid-callback context.
     * Surfaced via dbg.timers(). */
    public timerThreadTrace: string[] = [];
    private traceTimerThread(evt: string): void {
        this.timerThreadTrace.push(
            `w${Math.round(performance.now())}/v${Math.round(this.timeService.nowMs())} ${evt}`);
        if (this.timerThreadTrace.length > 128) this.timerThreadTrace.splice(0, 64);
    }
    /** Trace `evt` iff `threadId` is the winmm timer thread (for hooks outside the scheduler). */
    traceTimerEvent(threadId: number, evt: string): void {
        const tid = this.getTimerThreadId();
        if (tid && threadId === tid) this.traceTimerThread(evt);
    }

    noteWinmmTimerCallbackReturn(threadId: number, callbackAddr: number): void {
        const tid = this.getTimerThreadId();
        if (!tid || threadId !== tid || callbackAddr === 0) return;
        const cpu = this.getCpu();
        if (!cpu || !hasFpuSimdDirtyFlag({ cpu })) return;
        this.noteTimerNoFpuProfile(callbackAddr >>> 0, isFpuSimdDirty({ cpu }));
    }

    /** A winmm timer-callback return is NOT a scheduler boundary: after the return stub's
     *  `pop eax; ret` the timer thread lands back on the JMP $ spin loop and v86 honestly
     *  JIT-executes it until the next tick boundary (the async-park failure mode, at
     *  100-200 returns/s — measured in-race on NFSU as 1.8B spin block-execs / 15 s, the
     *  bulk of the timer thread's whole CPU share). Force the cycle slice to end now: the
     *  tick boundary that follows immediately runs tryDispatchTimerThreadCallbacks, which
     *  either invokes the next pending callback or blocks the thread on its wake event
     *  (empty queue). Costs one extra main-loop round-trip per timer callback — noise
     *  against ~500 boundary round-trips/s. */
    onWinmmTimerCallbackReturned(): void {
        this.timerDispatchStats.cbReturnImmediateExit++;
        preemptionManager.requestImmediateExit();
    }
    /** Idle-pump activity — how many wall-paced idle pumps ran and
     *  how many WINMM timers they fired (the storm fires WINMM timers from the idle
     *  pump at wall-rate). lastNextFireInMs = ms to next timer at the last idle poll. */
    public idlePumpStats = { pumps: 0, winmmFires: 0, lastNextFireInMs: 0 };
    /** Sole-runnable Sleep virtual-time credits (see creditVirtualTimeForSoleRunnableSleep). */
    public soleRunnableSleepStats = { credits: 0, msCredited: 0 };
    /** Which sleepWithContext branch handled non-zero Sleep (diagnostics). */
    public sleepPathStats = { soleRunnableYield: 0, blockedWait: 0 };
    /** Round-trip characterisation (block-chaining ROI investigation).
     *  Splits *why* the scheduler returns to JS main_loop so we can tell honest-quantum exits
     *  (irrecoverable) from urgent-exits / self-reschedules (potentially recoverable):
     *  - ticks: tick_hooks_before calls (≈ do_many_cycles round-trips).
     *  - urgentTicks: ticks where the scheduled thread is WAITING → cycle_limit=0 (the budgetExit
     *    proxy: a chainable edge in its spin sees limit==0 and bails). Honest 1ms-quantum exits are
     *    the complement (urgentExit=false runs that reach ~100K instr).
     *  - urgentNoReady: urgentTicks where runQueue is empty → we're resuming a WAITING thread with
     *    NOTHING else READY → should have idle-slept instead. Pure recoverable waste (case (c)).
     *  - selfReschedule: performSwitch picked the same thread back (self-restore fast path) → the
     *    round-trip produced no switch. Recoverable waste.
     *  - realSwitch: performSwitch switched to a different thread (legitimate). noRunnable: nothing. */
    public roundTripStats = { ticks: 0, urgentTicks: 0, urgentNoReady: 0, selfReschedule: 0, realSwitch: 0, noRunnable: 0 };
    /** Suspend-vs-wait interaction census. Every counter sits on a COLD branch (a suspend that
     *  targets a waiter, a wake that lands on a suspended thread) — never on the ~1.4M/s
     *  Suspend/Resume spin itself — so it costs nothing and makes an otherwise invisible,
     *  non-deterministic class observable: `suspendOnWaiting` is the only input the
     *  orthogonality rules change, so a zero there means a title cannot be affected by them.
     *  Surfaced in the harness `threads` state (report(), state(["threads"])). */
    public suspendWaitStats = {
        suspendOnWaiting: 0, suspendOnAsyncPark: 0, suspendRefused: 0,
        wakeWhileSuspended: 0, skippedSuspendedWaiter: 0,
        reevalOnResume: 0, reevalSatisfied: 0,
    };
    /** Per-thread wall-clock attribution: ms of worker time spent while each thread was
     *  the CURRENT thread (guest execution + its thunks' JS time). Accumulated on every
     *  performSwitch entry — the single switch primitive — so it covers all switch paths.
     *  Read via getThreadCpuMs(); answers "which guest thread consumes the worker" without
     *  the EIP-sampler's yield-point bias. */
    private threadCpuMs = new Map<number, number>();
    private threadCpuMarkMs = 0;

    /** Attribute wall time since the last mark to the outgoing current thread. */
    private accumThreadCpu(): void {
        const now = performance.now();
        if (this.threadCpuMarkMs > 0 && this.currentThreadId !== null) {
            const id = this.currentThreadId;
            this.threadCpuMs.set(id, (this.threadCpuMs.get(id) ?? 0) + (now - this.threadCpuMarkMs));
        }
        this.threadCpuMarkMs = now;
    }

    /** Snapshot of per-thread worker-time attribution (ms, monotonic totals). */
    public getThreadCpuMs(): Record<number, number> {
        this.accumThreadCpu(); // fold in the in-progress slice
        const out: Record<number, number> = {};
        for (const [id, ms] of this.threadCpuMs) out[id] = Math.round(ms * 100) / 100;
        return out;
    }
    public fpuSwitchStats = {
        saves: 0,
        savesSkippedClean: 0,
        savesDirty: 0,
        savesNoDirtyFlag: 0,
        savesNoCachedState: 0,
        restores: 0,
        restoresSkippedOwner: 0,
        restoresNoState: 0,
        timerNoFpuWarmupClean: 0,
        timerNoFpuDirty: 0,
        timerNoFpuEligible: 0,
        timerNoFpuRestoreSkipped: 0,
        timerNoFpuBorrowedSave: 0,
        timerNoFpuDisabled: 0,
    };
    private fpuLiveOwnerThreadId: number | null = null;
    private readonly timerNoFpuWarmupCleanRequired = 16;
    private readonly timerNoFpuProfiles = new Map<number, TimerNoFpuProfile>();
    private timerFpuRestoreSkipPending: TimerFpuBorrow | null = null;
    private timerFpuBorrowActive: TimerFpuBorrow | null = null;
    /** Called from tick_hooks_before with the urgentExit decision (current thread WAITING). */
    public noteRoundTripTick(urgentExit: boolean): void {
        this.roundTripStats.ticks++;
        if (urgentExit) {
            this.roundTripStats.urgentTicks++;
            if (this.runQueue.length === 0) this.roundTripStats.urgentNoReady++;
        }
    }
    private callbackStubBase = 0;
    private callbackStubEnd = 0;

    // One-way callbacks to ThunkDispatcher
    public onThreadSwitchCallback: ((oldId: number, newId: number) => void) | null = null;
    /** Called at tick/thunk boundaries to process pending async restores.
     *  Returns true if a restore was applied (CPU state modified). */
    public onPollAsyncRestores: ((cpu: V86Cpu, source?: string) => boolean) | null = null;
    public onHasPendingAsyncRestores: (() => boolean) | null = null;
    /** True when the thread owns a live suspended-thunk frame (a JS-driven pump like
     *  DialogBoxParamA). Lets the spin-loop safety net park such a thread WAITING between
     *  pump callbacks — the pump's next invokeCallback wakes it via
     *  wakeCurrentThreadForCallbackDispatch, so the park has a guaranteed wake source. */
    public onThreadOwnsSuspendedFrame: ((threadId: number) => boolean) | null = null;
    /** Fired once when a thread spins at PF_HALT_TARGET (an unhandled guest access
     *  violation parked at the #PF halt stub). The host turns this into a clean
     *  process crash instead of an infinite scheduler-monopolizing spin. */
    public onUnhandledGuestFault: ((threadId: number, eip: number) => void) | null = null;
    private unhandledFaultFired = false;
    private mainThreadId = 0;

    // Switch request flag
    private switchRequested = false;

    /** Wall-clock bound on the callback pin's power to defer a switch (below). */
    private static readonly PIN_STARVATION_MAX_MS = 8;
    /** When the pin first refused a switch with peers already queued (0 = not deferring). */
    private pinDeferSinceMs = 0;
    private pinDeferCount = 0;
    public pinStarvationForced = 0;
    /** Why the last tick boundary did NOT switch. Numeric so the hot path stays a store.
     *  1=asyncRestore 2=timerThread 3=yieldPending 4=allBlockedOrSpin 5=switched
     *  6=pinDefer 7=quantumNotExpired 8=nonPreemptible 9=criticalDefer 10=noRunQueue */
    lastTickExit = 0;

    /**
     * Does the callback pin justify skipping THIS switch?
     *
     * The pin exists so a JS-invoked guest callback (WndProc, EnumWindows, …) is not
     * preempted mid-chain. It was never meant to stop OTHER threads: on Windows a
     * synchronous callback runs on the calling thread, it does not make the machine
     * single-threaded. UE1 runs its whole engine tick inside DispatchMessage, so the pin
     * is held for the entire frame — and when guest code inside that callback waits on a
     * peer (Core.dll's `while(lock) Sleep(0)` spinlock), deferring forever is a deadlock:
     * the holder can never be scheduled to release it. Observed on Harry Potter CoS as a
     * hard freeze with runQueue=[3,2] and ZERO context switches.
     *
     * So the deferral is BOUNDED, the same shape as the non-preemptible-stub valve below:
     * a fast callback (microseconds) is never split, while a callback that starves queued
     * peers past PIN_STARVATION_MAX_MS loses the privilege. The switch is safe at this
     * point for the same reason it is safe for a pinned thread that blocked — per-thread
     * context and the frame's own thread-keyed bookkeeping survive the round trip.
     */
    private pinDefersSwitch(current: Thread): boolean {
        if (current.kernelPinCount <= 0 || current.state !== ThreadState.RUNNING) {
            this.pinDeferSinceMs = 0;
            this.pinDeferCount = 0;
            return false;
        }
        const now = performance.now();
        if (this.pinDeferSinceMs === 0) {
            this.pinDeferSinceMs = now;
            this.pinDeferCount = 1;
            return true;
        }
        this.pinDeferCount++;
        if (now - this.pinDeferSinceMs < Scheduler.PIN_STARVATION_MAX_MS) return true;

        Logger.warn(LogCategory.THREAD,
            `PIN_STARVATION: T${current.id} held the callback pin for ` +
            `${(now - this.pinDeferSinceMs).toFixed(1)}ms over ${this.pinDeferCount} deferred switches ` +
            `while ${this.runQueue.length} thread(s) were READY — forcing the switch`);
        this.pinStarvationForced++;
        this.pinDeferSinceMs = 0;
        this.pinDeferCount = 0;
        // REQUEST the switch, don't merely permit it. The caller's next test is
        // `switchRequested || quantumExpired`, so returning false alone does nothing on a
        // tick where the quantum has not expired — and this window has just been reset, so
        // the pin defers for another full PIN_STARVATION_MAX_MS. A thread holding the pin
        // continuously (a guest spin-wait inside a callback) then starves READY peers
        // forever while this counter happily ticks up: the bound fires and nothing moves.
        // Observed on HP CoS's boot — pinStarvationForced climbing ~28/5s with realSwitch
        // frozen and window.dll READY the whole time.
        this.switchRequested = true;
        return false;
    }

    /** New threads run until their first blocking wait so SetEvent cannot be missed. */
    private bootstrapUntilFirstWait = new Set<number>();

    // Yield-to-host (duration in ms, consumed by tick boundary)
    private yieldToHostMs = 0;
    public intentionalYield = false;

    // Yield-to-host source telemetry: which call path (Sleep(0), WaitForObject,
    // all-threads-blocked, spin-loop safety net, …) accounts for the worker idle.
    // This is the idle-attribution instrument — the worker idle is yieldToHost time,
    // and this map says WHY we yield. Always-on; one Map.get/set per yield.
    private pendingYieldSource = "req";
    private yieldStats = new Map<string, { count: number; totalMs: number; reqMs: number; maxMs: number }>();
    private yieldStatsSince = performance.now();

    private recordYield(source: string, actualMs: number, requestedMs: number): void {
        let s = this.yieldStats.get(source);
        if (!s) { s = { count: 0, totalMs: 0, reqMs: 0, maxMs: 0 }; this.yieldStats.set(source, s); }
        s.count++;
        s.totalMs += actualMs;
        s.reqMs += requestedMs;
        if (actualMs > s.maxMs) s.maxMs = actualMs;
    }

    /** Idle-attribution report: yieldToHost wall-clock grouped by source. */
    getYieldReport(): ReturnType<typeof buildYieldReport> {
        return buildYieldReport(this.yieldStats, this.yieldStatsSince);
    }

    resetYieldStats(): void {
        this.yieldStats.clear();
        this.yieldStatsSince = performance.now();
    }

    // Deadlock detection
    private lastDeadlockCheckMs = 0;

    // Wall-clock anchor for advancing virtual time while fully idle (v86 stopped).
    // 0 = not currently idle; set on first idle poll, advanced incrementally after.
    private idleAnchorWallMs = 0;

    // Critical section owner tracking
    private criticalSectionOwners = new Map<number, number>();
    private csLockSemaphores = new Map<number, number>();

    // ── TEMP DIAGNOSTIC (crash-hunt): watch a guest doubly-linked-list head across
    // context switches. Set via setDebugHeadWatch() from the harness. On every
    // performSwitch we snapshot head[addr]; we log when we switch AWAY from a thread
    // whose resume EIP is inside the list-mutation function [loEip,hiEip) (i.e. we
    // interrupted a splice), or whenever the head reads 0 (the torn state that faults
    // the walker). This discriminates: (A) head goes 0 while ONE thread owns the whole
    // window = exclusion hole; (B) head torn at a switch-out mid-splice = the switch
    // itself corrupted the in-flight mutation. Remove once root-caused.
    private debugHeadWatch: { headAddr: number; loEip: number; hiEip: number } | null = null;
    debugHeadWatchLog: string[] = [];              // switch-time events (read via RPC headWatchDump)
    debugHeadZeroSnaps: string[] = [];             // per-tick "head flipped to 0" snapshots (the writer)
    private debugHeadWatchPrevHead = -1;           // last per-tick head sample (detect the 0-flip edge)
    setDebugHeadWatch(headAddr: number, loEip: number, hiEip: number): void {
        this.debugHeadWatch = headAddr ? { headAddr: headAddr >>> 0, loEip: loEip >>> 0, hiEip: hiEip >>> 0 } : null;
        this.debugHeadWatchLog = [];
        this.debugHeadZeroSnaps = [];
        this.debugHeadWatchPrevHead = -1;
    }
    getDebugHeadWatchLog(): string[] { return this.debugHeadWatchLog; }
    getDebugHeadZeroSnaps(): string[] { return this.debugHeadZeroSnaps; }

    /** Per-tick head sample: record the EDGE where the guest list head flips to/from 0.
     *  The current thread + live EIP at the flip-to-0 IS the corrupting writer. Cheap
     *  (one dword read per ~100k-insn tick). Called at the TOP of preemptAtTickBoundary. */
    private sampleDebugHeadWatch(cpu: V86Cpu): void {
        if (!this.debugHeadWatch) return;
        const head = (Mem.readUint32(this.debugHeadWatch.headAddr) ?? 0) >>> 0;
        if (head === this.debugHeadWatchPrevHead) return;
        const prev = this.debugHeadWatchPrevHead;
        this.debugHeadWatchPrevHead = head;
        if ((head === 0 || prev === 0) && this.debugHeadZeroSnaps.length < 2000) {
            const eip = cpu.instruction_pointer[0] >>> 0;
            this.debugHeadZeroSnaps.push(
                `head 0x${(prev >>> 0).toString(16)}->0x${head.toString(16)} ` +
                `cur=T${this.currentThreadId ?? 0}@0x${eip.toString(16)} insn=${this.retiredInsns(cpu) >>> 0}`);
        }
    }

    // Deferred thread reaping — terminated threads stay briefly for GetExitCodeThread / WaitForSingleObject
    private reapQueue: Array<{ threadId: number; terminatedAt: number }> = [];
    private reapHead = 0;
    private lastReapCheckMs = 0;
    private static readonly REAP_GRACE_MS = 5000;
    private static readonly REAP_THROTTLE_MS = 250;

    // MessageChannel for sub-ms yields
    private yieldPort: MessagePort | null = null;
    private yieldPortResolve: (() => void) | null = null;
    // In-flight setTimeout-based idle yield (allBlocked etc.) — tracked so an async
    // thunk completion can resume it early instead of waiting out the ~50ms timer.
    private idleYieldTimer: ReturnType<typeof setTimeout> | null = null;
    private idleYieldResume: (() => void) | null = null;
    private idleYieldResumeActive = false;

    // Critical runtime isolation (SEH dispatch, etc.)
    private activeCriticalRuntime: { section: CriticalRuntimeSection; ownerThreadId: number; generation: number } | null = null;
    private transientExecRanges = new Map<TransientExecRangeKind, { base: number; end: number }>();
    // Non-preemptible THUNK_CODE critical sections (inline heap/CRT slab stubs). While a
    // guest thread's EIP is inside one of these straight-line stubs, preemptAtTickBoundary
    // defers the switch so two threads can't interleave a non-atomic free-list pop/push/bump
    // → "two owners, one block" (D2 Fog/Storm corruption). Faithful single-core analogue of
    // RtlAllocateHeap's per-heap serialization. Bounded: the stub is ~tens of instrs ≪ 1 quantum.
    private nonPreemptibleRanges: Array<{ base: number; end: number }> = [];
    private nonPreemptibleDeferCount = 0;
    private nonPreemptibleDeferEip = 0;
    private nonPreemptibleConsecutive = 0;
    private sehDeferredSwitchCount = 0;
    private sehDeniedRestoreCount = 0;
    private sehUnbalancedExitCount = 0;
    private readonly asyncRestoreTrace: string[] = [];

    constructor(config: Partial<SchedulerConfig> = {}) {
        this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };

        // Pre-allocate MessageChannel for sub-ms yields (bypasses setTimeout 4ms floor)
        const ch = new MessageChannel();
        this.yieldPort = ch.port2;
        ch.port1.onmessage = () => {
            const resolve = this.yieldPortResolve;
            if (resolve) {
                this.yieldPortResolve = null;
                resolve();
            }
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Initialization
    // ═══════════════════════════════════════════════════════════════════════

    initialize(process: Process): void {
        this.process = process;
        this.writeThreadExitStub();

        // Parked-stack write guard (stack-write-guard.ts): expose every non-running
        // thread's LIVE stack range [savedEsp+4, stackTop) so machinery write-sites can
        // tripwire the "corruption planted into a parked thread's stack" class at write
        // time (0x7c07 escape family). Zero-alloc visitor over the thread table; threads
        // on fiber/alt stacks (ESP outside the registered range) get a 64K window above
        // the saved ESP instead.
        setParkedStackProvider((visit) => {
            for (const t of this.threads.values()) {
                if (t.id === this.currentThreadId) continue;
                if (t.state === ThreadState.RUNNING || t.state === ThreadState.TERMINATED
                    || t.state === ThreadState.CREATED) continue;
                const ctx = t.context;
                if (!ctx) continue;
                const esp = ctx.esp >>> 0;
                if (!esp) continue;
                let top = t.stackTop >>> 0;
                if (!(esp >= (t.stackBase >>> 0) && esp < top)) top = (esp + 0x10000) >>> 0;
                const lo = (esp + 4) >>> 0;
                if (lo < top && visit(t.id, lo, top, esp, THREAD_STATE_NAMES[t.state])) return;
            }
        }, () => this.currentThreadId ?? -1);

        // Relaxed-FPU is a global tag convention over the SHARED x87 register file, so a
        // live mode toggle must re-encode every thread's SAVED snapshot too — the wasm
        // set_relaxed_fpu export reaches only the live registers. Includes the running
        // thread's cached lastFpuState: a clean dirty-bit save promotes it to ctx.fpu
        // without re-snapshotting.
        preemptionManager.setSavedFpuStateProvider((visit) => {
            for (const t of this.threads.values()) {
                if (t.context?.fpu) visit(t.context.fpu);
                if (t.lastFpuState) visit(t.lastFpuState);
            }
        });

        if (process.memory) {
            this.tebManager.initProcess(() => process.getCurrentMemory(), process.memory);
        }

        // Read thunk region bounds from dispatcher
        const dispatcher = process.dispatcher;
        if (dispatcher) {
            const thunkMemMgr = (dispatcher as any).thunkMemoryManager;
            if (thunkMemMgr) {
                const regions = thunkMemMgr.getRegions();
                this.thunkStubBase = regions.thunkGeneratorBase;
                this.thunkStubEnd = regions.thunkGeneratorBase + regions.thunkGeneratorSize;
                this.spinLoopBase = regions.spinLoopAddress;
                this.spinLoopEnd = regions.spinLoopAddress + regions.spinLoopSize;
                this.parkEipArmed = false; // (re)arm lazily at the first tick boundary — wasm
                // exports are not reliably wired yet at initialize() time (a silent miss here
                // costs 2× FPS: the cycle loop keeps honestly executing JMP $ slice tails).
                this.callbackStubBase = regions.callbackStubPoolBase ?? 0;
                this.callbackStubEnd = regions.callbackStubPoolBase
                    ? regions.callbackStubPoolBase + (regions.callbackStubPoolSize ?? 0)
                    : 0;
            }
        }

        this.ensureMainThread();
    }

    setMainStackInfo(stackPointer: number, stackSize: number): void {
        this.mainStackTop = stackPointer;
        this.mainStackBase = stackPointer - stackSize;
    }

    reset(): void {
        for (const thread of this.threads.values()) {
            this.resourceProvider.unregisterKernelObject(thread.handle);
        }
        this.syncObjects.reset();
        this.timerWheel.reset();
        this.waitEngine.reset();
        this.callbackCoord.reset();
        this.threads.clear();
        this.runQueue = [];
        this.currentThreadId = null;
        this.mainThreadId = 0;
        this.nextThreadId = 1;
        this.unhandledFaultFired = false;
        this.tlsSlots.clear();
        this.nextTlsIndex = 0;
        this.switchRequested = false;
        this.bootstrapUntilFirstWait.clear();
        this.idleAnchorWallMs = 0;
        this.criticalSectionOwners.clear();
        this.csLockSemaphores.clear();
        this.reapQueue.length = 0;
        this.reapHead = 0;
        this.lastReapCheckMs = 0;
        this.activeCriticalRuntime = null;
        this.transientExecRanges.clear();
        // Stubs are regenerated after reset() (pe-loader re-runs writeHeapSlabStubs), which
        // re-registers the ranges — so drop the stale ones here.
        this.nonPreemptibleRanges.length = 0;
        this.nonPreemptibleDeferEip = 0;
        this.nonPreemptibleConsecutive = 0;
        this.sehDeferredSwitchCount = 0;
        this.sehDeniedRestoreCount = 0;
        this.sehUnbalancedExitCount = 0;
        this.asyncRestoreTrace.length = 0;
        this.cachedWinmmTimerThreadId = 0;
        this.cachedWinmmTimerWakeEvent = 0;
        this.cachedWinmmModule = null;
        // process.reset() (called after us) clears THUNK_DATA and resets the bump allocator.
        // If we keep a stale threadExitStubAddr, the next writeThreadExitStub() (CreateThread)
        // overwrites guest HEAP/COM memory at that address → vtable corruption → EIP 0x7c07.
        this.threadExitStubAddr = 0;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // THE Context Switch Point — called by ThunkDispatcher
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Unhandled-fault halt: a thread whose unrecoverable #PF found no SEH/UEF
     * handler has its IRET redirected to PF_HALT_TARGET (CLI;HLT;JMP $) and now
     * spins there RUNNING — monopolizing the cooperative scheduler so no other
     * thread runs (a total freeze). On real Windows an unhandled access violation
     * TERMINATES THE PROCESS; mirror that with a clean crash instead of an infinite
     * spin. Fired once; the host stops v86 + tears the process down.
     * PF_HALT_TARGET points at the CLI; the thread then runs CLI;HLT;JMP $-1 and
     * SPINS at the JMP (PF_HALT_TARGET+2), so match the whole 4-byte halt stub.
     * Returns true if the halt fired (the caller must return immediately).
     */
    private handleUnhandledFaultHalt(cpu: V86Cpu, source: string): boolean {
        const eip0 = cpu.instruction_pointer[0] >>> 0;
        if (this.unhandledFaultFired ||
            eip0 < (PF_HALT_TARGET >>> 0) || eip0 > ((PF_HALT_TARGET + 3) >>> 0)) {
            return false;
        }
        this.unhandledFaultFired = true;
        const cur = this.getCurrentThread();
        Logger.error(LogCategory.THREAD,
            `UNHANDLED GUEST FAULT [${source}]: T${cur?.id ?? -1} parked at PF halt stub ` +
            `(0x${eip0.toString(16)}) — unhandled access violation, crashing process ` +
            `(was an infinite scheduler-monopolizing spin)`);
        this.onUnhandledGuestFault?.(cur?.id ?? -1, eip0);
        return true;
    }

    /**
     * v86 retires ~TARGET_INSN_PER_MS instructions per virtual millisecond — the same shared
     * constant the instruction-based virtual-time model uses. Preemption is driven by this
     * RETIRED-INSTRUCTION count, NOT performance.now().
     *
     * Why: a wall-clock quantum makes the preemption point fall on different guest-instruction
     * boundaries on different machines (a fast Mac retires more instructions per wall-ms than a
     * slower PC, and vice-versa), so the moment a thread is switched out — and therefore which
     * JIT block / OUT+RET-N window the switch lands in — is a function of platform speed. That
     * platform-dependent interleaving is the root of the Re-Volt mac wild-ESP/EBP corruption.
     * Measuring the quantum in retired instructions makes the switch point a function of
     * deterministic guest state instead, so Mac and PC switch at the same instruction boundary.
     */
    /** Retired guest instructions (v86 32-bit counter; wraps ~every 42 s at target MIPS, so
     *  callers must use an unsigned `>>> 0` delta over a sub-quantum window). */
    private retiredInsns(cpu: V86Cpu): number {
        return (cpu?.instruction_counter?.[0] ?? 0) >>> 0;
    }

    /** True once `thread` has retired a full quantum's worth of guest instructions since its last
     *  switch. Deterministic — independent of wall-clock and platform speed. */
    private quantumExpired(thread: Thread, cpu: V86Cpu): boolean {
        const quantumInsns = (this.config.minQuantumMs * TARGET_INSN_PER_MS) >>> 0;
        if (quantumInsns === 0) return true; // degenerate config → always eligible (matches old <=0 ms)
        const delta = this.insnsSinceSwitch(thread, cpu);
        return delta >= quantumInsns;
    }

    /** Retired guest instructions since `thread`'s last switch, as an unsigned sub-quantum
     *  delta (the v86 counter wraps ~every 42 s, so callers must stay within one quantum). */
    private insnsSinceSwitch(thread: Thread, cpu: V86Cpu): number {
        return (this.retiredInsns(cpu) - (thread.lastSwitchInsn >>> 0)) >>> 0;
    }

    /**
     * True once `thread` has retired at least `fraction` of one minimum quantum's worth of
     * guest instructions since its last switch. This is the instruction-based (deterministic,
     * platform-independent) analogue of a `performance.now() - lastSwitchTime >= minQuantumMs`
     * wall-clock gate — used by the ThunkDispatcher time-poll force-switch. Measuring the gate
     * in retired instructions instead of wall-ms keeps the switch point a function of guest
     * state, not host speed (same rationale as quantumExpired / the Re-Volt mac fix).
     *
     * The budget is a FRACTION OF THE QUANTUM, so retuning minQuantumMs retunes every caller
     * with it — a spin-waiter yields at half the quantum whatever that quantum is, which is
     * the intended relation. Callers wanting an absolute latency bound must not use this.
     */
    insnQuantumFraction(thread: Thread, fraction: number): boolean {
        const cpu = this.getCpu();
        if (!cpu) return false;
        const budget = ((this.config.minQuantumMs * fraction) * TARGET_INSN_PER_MS) >>> 0;
        if (budget === 0) return true;
        return this.insnsSinceSwitch(thread, cpu) >= budget;
    }

    /**
     * Called by ThunkDispatcher on every thunk completion.
     * This is the ONLY place context switches happen.
     */
    onThunkBoundary(cpu: V86Cpu, kind: ThunkBoundaryKind, cleanup: number): void {
        if (!this.process) return;

        if (this.handleUnhandledFaultHalt(cpu, "onThunkBoundary")) return;

        // 1. Process pending async restores (highest priority — unblocks spin-loop threads)
        if (this.onPollAsyncRestores?.(cpu, "onThunkBoundary")) return;

        // 2. Poll timers
        const now = this.timeService.nowMs();
        this.timerWheel.poll(now);

        // 2b. Reap terminated threads (throttled)
        if (now - this.lastReapCheckMs >= Scheduler.REAP_THROTTLE_MS) {
            this.lastReapCheckMs = now;
            this.reapTerminatedThreads(now);
        }

        // 3a. Dispatch timer thread callback if we ARE the timer thread
        if (this.tryDispatchTimerThreadCallbacks(cpu)) { this.lastTickExit = 2; return; }

        // 3b. Dispatch one queued callback if safe
        this.callbackCoord.dispatchOne();

        // 4. Check quantum expiry → request switch (retired-instruction quantum, not wall-clock)
        if (!this.switchRequested && this.runQueue.length > 0) {
            const current = this.getCurrentThread();
            if (current && this.quantumExpired(current, cpu)) {
                this.switchRequested = true;
            }
        }

        // 5. Perform switch if requested (but respect callback chain pin)
        if (this.switchRequested) {
            const current = this.getCurrentThread();
            // Pin defers PREEMPTIVE switches mid callback-chain (keeps the callback's
            // stack intact). But a thread that has voluntarily BLOCKED (WAITING) has
            // already yielded the CPU — its peers (e.g. Storm's async-I/O worker that
            // must SetEvent the read-completion event) MUST be allowed to run, or the
            // wait can never complete. Without this, a blocking SFileReadFile inside a
            // pinned WndProc deadlocks: the switch is deferred, WaitForSingleObject's
            // RET resumes guest code on the WAITING thread, and the read returns short
            // → D2 "File Read Error / Archive.cpp:143". Only defer while RUNNING.
            if (current && this.pinDefersSwitch(current)) {
                // Pinned for callback chain — defer preemptive switch until chain completes
                // (bounded: see pinDefersSwitch). Same-thread async restores are handled at
                // step 1 above.
                return;
            }
            if (this.shouldDeferSwitchForCriticalRuntime(cpu, kind)) {
                return;
            }
            this.performSwitch(cpu, kind, cleanup);
            this.switchRequested = false;
            // 5b. If we just switched TO the timer thread, dispatch its callback immediately
            // rather than waiting for the next tick boundary (~5ms latency reduction).
            this.tryDispatchTimerThreadCallbacks(cpu);
        }
    }

    /**
     * Called when entering a thunk (lazy main thread init).
     */
    onThunkEnter(): void {
        if (!this.process) return;
        this.ensureMainThread();
    }

    /**
     * Ensure the main thread has a valid TEB with FS base set.
     * Must be called before game code starts — the CRT prologue does
     * `push fs:[0]; mov fs:[0], esp` to install SEH, which requires
     * FS to point to a valid TEB (otherwise it reads from the null guard page).
     */
    initializeMainThreadTeb(): void {
        if (!this.process) return;
        this.ensureMainThread();
    }

    /**
     * Called from tick_hooks_after — clean instruction boundary.
     */
    preemptAtTickBoundary(cpu: V86Cpu): void {
        if (!this.process) return;

        if (this.debugHeadWatch) this.sampleDebugHeadWatch(cpu); // TEMP crash-hunt

        if (this.handleUnhandledFaultHalt(cpu, "preemptAtTickBoundary")) return;

        // Lazy one-shot: arm the wasm park-exit (see set_park_eip in v86 hypercall.rs).
        // Done here, not in initialize(): wasm exports are not reliably wired that early,
        // and a silent miss costs 2× in-race FPS (measured — the cycle loop honestly
        // executes JMP $ slice tails without it).
        if (!this.parkEipArmed && this.spinLoopBase > 0) {
            const ex = preemptionManager.getWasmExports?.();
            if (ex?.set_park_eip) {
                ex.set_park_eip(this.spinLoopBase >>> 0);
                // E2b safety: indirect-region growth must never pull targets from the
                // thunk/callback/spin bucket (stub pages full of OUT traps → wasm trap
                // when compiled into a guest superblock).
                ex.jit_set_region_exclusion?.(MEM_THUNK_CODE_BASE >>> 0, MEM_ROM_BASE >>> 0);
                this.parkEipArmed = true;
                Logger.log(LogCategory.SYSTEM, `[scheduler] wasm park-exit armed @0x${this.spinLoopBase.toString(16)}`);
            }
        }

        // Spin-residency attribution: each boundary where the current RUNNING thread sits
        // inside the spin-loop page is ~one tick of v86 honestly executing JMP $ (the
        // async-park failure class). The step-6 safety net below only looks when runQueue is EMPTY,
        // so with other threads runnable this is otherwise invisible — measured in-race
        // as 1.8B spin block-execs/15s with zero SAFETY_NET hits. Read via dbg/harness.
        {
            const cur = this.getCurrentThread();
            if (cur && cur.state === ThreadState.RUNNING) {
                const eip = cpu.instruction_pointer[0] >>> 0;
                if (this.spinLoopBase > 0 && eip >= this.spinLoopBase && eip < this.spinLoopEnd) {
                    this.spinBoundaryHits.set(cur.id, (this.spinBoundaryHits.get(cur.id) ?? 0) + 1);
                }
            }
        }

        // 1. Process pending async restores (highest priority — unblocks spin-loop threads)
        if (this.onPollAsyncRestores?.(cpu, "preemptAtTickBoundary")) { this.lastTickExit = 1; return; }

        // 2. Poll timers
        const now = this.timeService.nowMs();
        this.timerWheel.poll(now);

        // 3a. Dispatch timer thread callback if we ARE the timer thread
        if (this.tryDispatchTimerThreadCallbacks(cpu)) return;

        // 3b. Dispatch one queued callback if safe
        this.callbackCoord.dispatchOne();

        // 4. Deadlock detection
        this.detectDeadlock();

        // 5. Handle yield-to-host
        if (this.yieldToHostMs > 0) {
            const ms = this.yieldToHostMs;
            this.yieldToHostMs = 0;
            this.lastTickExit = 3;
            this.yieldToHost(cpu, ms);
            return;
        }

        // 6. Check if all threads are waiting or sole thread stuck at spin loop — yield to browser
        if (this.runQueue.length === 0) {
            const current = this.getCurrentThread();
            if (current && current.state === ThreadState.WAITING) {
                this.yieldToHost(cpu, this.computeYieldMs(4), "allBlocked");
                return;
            }
            // The current thread has EXITED (TERMINATED, or null after the reaper
            // deleted it) and nothing is runnable. Park the worker instead of letting
            // v86 busy-spin with is_running()===true — a spinning v86 disables the
            // startScheduler restart backstop (it only restarts a *stopped* v86), so a
            // later survivor wake would never be serviced. yieldToHost re-arms that
            // backstop (and wakeEarlyFromIdleYield) so the survivor resumes promptly.
            // (Root of the Re-Volt random hang after a sibling thread terminates.)
            if (!current || current.state === ThreadState.TERMINATED) {
                this.yieldToHost(cpu, this.computeYieldMs(4), "currentExited");
                return;
            }
            // Sole RUNNING thread at spin loop: yield to allow macro-task promises
            // (e.g. GPU readback) to resolve. Without this, v86's microtask chain
            // starves the event loop and async thunk promises never complete.
            //
            // Safety net: the async-thunk parking path is supposed to transition
            // the thread to WAITING (via markThreadAsyncParked). If we find a
            // RUNNING thread at the exact spinLoopBase, someone parked without
            // calling the transition. Retro-mark it when there is a matching
            // pending async restore; otherwise fall back to the 1 ms yield.
            //
            // Strict equality on spinLoopBase — SEH stubs live at +2/+4/+0x200
            // and must keep running, so the wider range check stays yield-only.
            if (current && current.state === ThreadState.RUNNING) {
                const eip = cpu.instruction_pointer[0] >>> 0;
                if (this.spinLoopBase > 0 && eip === this.spinLoopBase) {
                    // A thread that owns a live suspended-thunk frame (dialog pump) lands
                    // here after EVERY intermediate callback return — park it WAITING; the
                    // pump's next invokeCallback / direct-restore is the wake source.
                    // Without this the thread burns a 1 ms host yield per tick boundary
                    // for the dialog's whole lifetime (millions of yields per minute).
                    const ownsFrame = this.onThreadOwnsSuspendedFrame?.(current.id) ?? false;
                    if (!ownsFrame) {
                        this.spinLoopMissedWaitCount++;
                        const nowMs = performance.now();
                        if (nowMs - this.spinLoopLastWarnMs >= 1000) {
                            this.spinLoopLastWarnMs = nowMs;
                            Logger.warn(LogCategory.THREAD,
                                `SAFETY_NET: T${current.id} at spinLoopAddress but state=RUNNING (count=${this.spinLoopMissedWaitCount}) — async park path missed markThreadAsyncParked`);
                        }
                    }
                    if (this.config.asyncHleWaitEnabled &&
                        (ownsFrame || this.onHasPendingAsyncRestores?.())) {
                        if (this.markThreadAsyncParked(current.id, cpu)) {
                            this.yieldToHost(cpu, this.computeYieldMs(4), ownsFrame ? "pumpPark" : "spinLoopPark");
                            return;
                        }
                    }
                    this.lastTickExit = 4;
                    this.yieldToHost(cpu, 1, "spinLoop");
                    return;
                }
                if (this.spinLoopBase > 0 && eip > this.spinLoopBase && eip < this.spinLoopEnd) {
                    // Inside SEH stub range — yield only, never retro-transition.
                    this.yieldToHost(cpu, 1, "spinLoopSEH");
                    return;
                }
            }
        }

        // 7. Check quantum or switchRequested → switch
        if (this.runQueue.length > 0) {
            const current = this.getCurrentThread();
            // The current thread has EXITED (TERMINATED, or null after reap) while a
            // runnable thread is queued — switch to it unconditionally. Without this,
            // the `if (current)` gate below skipped the switch entirely once the dead
            // thread was reaped (currentThreadId still pointed at it → getCurrentThread()
            // null), so a survivor that became READY after a sibling's exit was NEVER
            // scheduled → worker stranded with is_running()===true → 12 s watchdog hang
            // (Re-Volt T3-death). performSwitch already tolerates a null/terminated current.
            if (!current || current.state === ThreadState.TERMINATED) {
                this.switchRequested = false;
                this.performSwitch(cpu, ThunkBoundaryKind.GUEST_CODE, 0);
                this.tryDispatchTimerThreadCallbacks(cpu);
                return;
            }
            // A non-RUNNING current has yielded the CPU and retires 0 instructions at the spin
            // loop, so the retired-instruction quantum below never expires — switch unconditionally
            // (peers are runnable, the parked thread's context is already saved). WAITING: async-
            // parked / blocked (NFS Porsche: T-main in async GetMessageA starved READY peers).
            // READY: the SOLE thread woken WAITING→READY via the wait-engine/timer-wheel path (no
            // async restore) is re-queued but still currentThreadId; with no peer, wakeThread skips
            // requestSwitch() and it's never promoted → frozen at the spin loop with is_running()
            // stuck true (HoMM3-demo Sleep boot freeze). Async-restore wakes are handled at step 1.
            if (current.state === ThreadState.WAITING || current.state === ThreadState.READY) {
                this.switchRequested = false;
                this.performSwitch(cpu, ThunkBoundaryKind.GUEST_CODE, 0);
                this.tryDispatchTimerThreadCallbacks(cpu);
                return;
            }
            if (current) {
                // Pin blocks PREEMPTIVE switches during callback chains (EnumTextureFormats,
                // EnumWindows, etc.) to keep the callback's stack intact. Cross-thread async
                // restores are deferred until the chain finishes and releaseFrame unpins the
                // thread. Same-thread async restores (e.g. GetMessage inside a callback) are
                // handled at step 1 (onPollAsyncRestores) which runs before this check.
                // Exception: a thread that voluntarily BLOCKED (WAITING) has yielded the CPU
                // and cannot run — its peers must be allowed to proceed (see onThunkBoundary).
                // The deferral is bounded so a frame-long callback cannot starve them (see
                // pinDefersSwitch).
                if (this.pinDefersSwitch(current)) { this.lastTickExit = 6; return; }
                // Retired-instruction quantum (deterministic), not wall-clock — see quantumExpired().
                // The quantum is measured in RETIRED GUEST INSTRUCTIONS, and a thread sitting
                // on the spin loop's `JMP $` advances cpu.instruction_counter by nothing the
                // scheduler can see — so quantumExpired() is false forever. That is fine for a
                // properly parked thread (WAITING, skipped entirely), but an ORPHAN left
                // RUNNING at the park address (async park that lost its restore) then blocks
                // EVERY switch while peers sit READY: the guest freezes with a non-empty run
                // queue and `lastTickExit=7` on every tick. It is spinning, not working —
                // request the switch so peers run. It stays runnable, so a late restore still
                // resumes it. (HP CoS: froze at the boot splash with window.dll READY.)
                if (this.spinLoopBase > 0 && (cpu.instruction_pointer[0] >>> 0) === this.spinLoopBase) {
                    this.switchRequested = true;
                }
                if (!(this.switchRequested || this.quantumExpired(current, cpu))) this.lastTickExit = 7;
                if (this.switchRequested || this.quantumExpired(current, cpu)) {
                    if (this.shouldDeferSwitchForCriticalRuntime(cpu, ThunkBoundaryKind.GUEST_CODE)) {
                        this.switchRequested = true;
                        return;
                    }
                    // Non-preemptible inline slab-stub critical section: defer the switch so
                    // a guest thread mid free-list pop/push/bump (a non-atomic RMW on shared
                    // slab state) cannot be interleaved by another thread → "two owners, one
                    // block" (D2 Fog/Storm corruption). The stub is straight-line and exits
                    // within a few instructions, so the defer is bounded to the next tick.
                    const eip = cpu.instruction_pointer[0] >>> 0;
                    if (this.isEipNonPreemptible(eip)) {
                        // Safety valve: a straight-line stub leaves the range within a handful
                        // of instructions, so a thread "stuck" at the same EIP across many
                        // deferrals signals a bug — force the switch rather than freeze.
                        if (eip === this.nonPreemptibleDeferEip && this.nonPreemptibleConsecutive >= 256) {
                            Logger.warn(LogCategory.THREAD,
                                `NONPREEMPT_SAFETY: T${current.id} stuck at eip=0x${eip.toString(16)} ` +
                                `in non-preemptible range for ${this.nonPreemptibleConsecutive} defers — forcing switch`);
                            this.nonPreemptibleConsecutive = 0;
                            this.nonPreemptibleDeferEip = 0;
                        } else {
                            this.nonPreemptibleConsecutive = (eip === this.nonPreemptibleDeferEip)
                                ? this.nonPreemptibleConsecutive + 1 : 1;
                            this.nonPreemptibleDeferEip = eip;
                            this.nonPreemptibleDeferCount++;
                            this.switchRequested = true;
                            return;
                        }
                    }
                    this.switchRequested = false;
                    this.lastTickExit = 5;
                    this.performSwitch(cpu, ThunkBoundaryKind.GUEST_CODE, 0);
                    // 7b. If we just switched TO the timer thread, dispatch its callback immediately
                    this.tryDispatchTimerThreadCallbacks(cpu);
                }
            }
        }
    }

    /**
     * Called from onTickHook — WASM hypercall compensation.
     */
    onTickHook(cpu: V86Cpu): void {
        if (this.handleUnhandledFaultHalt(cpu, "onTickHook")) return;

        // Process pending async restores (highest priority)
        if (this.onPollAsyncRestores?.(cpu, "onTickHook")) return;

        // Timer polling and timeout checks at tick granularity
        const now = this.timeService.nowMs();
        this.timerWheel.poll(now);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // EIP Validation Helpers
    // ═══════════════════════════════════════════════════════════════════════

    /** Returns true if eip is inside the spin loop (async thunk parking spot). */
    isSpinLoopAddress(eip: number): boolean {
        return this.spinLoopBase > 0 && eip >= this.spinLoopBase && eip < this.spinLoopEnd;
    }

    /** True if a thread is READY to run (in the run queue). Used by the idle
     *  scheduler poll to decide whether a stopped v86 must be restarted. */
    hasRunnableThread(): boolean {
        return this.runQueue.length > 0;
    }

    /** True if the current thread is RUNNING **at a valid guest EIP** — it has live guest work, so a
     *  stopped (non-intentional) v86 MUST be restarted to resume it. The current thread is NOT in
     *  runQueue, so hasRunnableThread() misses it: a v86 that exits its cycle loop while a thread is
     *  mid-computation (e.g. DWN's pow-LUT loop in core.dll) with an empty run queue + no pending
     *  restore would otherwise never restart → frozen (the DWN black-screen, masked before by
     *  set_relaxed_fpu(0)).
     *
     *  Note: the EIP gate excludes a thread parked/dormant at the spin loop (e.g. winmm's timer
     *  thread is `createThread(spinLoopAddress)` → it sits at 0x21…0000 doing nothing until triggered).
     *  Restarting v86 for THAT executes the spin-loop/thunk region with an uninitialised context →
     *  guest fault (e.g. Exception 0xee). isValidGuestEip is true only for real guest code (modules/
     *  heap-exec), false for the spin-loop/thunk region — exactly the dormant-vs-working distinction. */
    hasRunningThread(eip: number): boolean {
        const c = this.getCurrentThread();
        return c !== null && c.state === ThreadState.RUNNING && isValidGuestEip(eip >>> 0);
    }

    /** Returns true if eip is valid guest code OR inside the spin loop region. */
    private isValidEipForRestore(eip: number): boolean {
        if (isValidGuestEip(eip)) return true;
        if (this.spinLoopBase > 0 && eip >= this.spinLoopBase && eip < this.spinLoopEnd) return true;
        // Stack-based code (SEH unwind trampolines generated by dispatchCxxException)
        const current = this.getCurrentThread();
        if (current && eip >= current.stackBase && eip < current.stackTop) return true;
        return this.isValidRuntimeTransientEip(eip);
    }

    private isValidRuntimeTransientEip(eip: number): boolean {
        for (const range of this.transientExecRanges.values()) {
            if (eip >= range.base && eip < range.end) return true;
        }
        return false;
    }

    private shouldDeferSwitchForCriticalRuntime(cpu: V86Cpu, kind: ThunkBoundaryKind): boolean {
        const rt = this.activeCriticalRuntime;
        if (!rt || rt.section !== 'seh_dispatch') return false;
        const current = this.getCurrentThread();
        if (!current) return false;
        if (current.id !== rt.ownerThreadId) return false;

        // During active SEH dispatch, allow only explicit transient/control boundaries.
        if (kind === ThunkBoundaryKind.GUEST_CODE || kind === ThunkBoundaryKind.THUNK_STUB) {
            const eip = cpu.instruction_pointer[0] >>> 0;
            this.sehDeferredSwitchCount++;
            const kindName = kind === ThunkBoundaryKind.GUEST_CODE ? 'GUEST_CODE' : 'THUNK_STUB';
            Logger.warn(LogCategory.THREAD,
                `SWITCH_DEFERRED_SEH_RUNTIME: kind=${kindName} ` +
                `eip=0x${eip.toString(16)} owner=T${rt.ownerThreadId} gen=${rt.generation}`);
            return true;
        }
        return false;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Context Save/Restore (inlined from old ContextManager)
    // ═══════════════════════════════════════════════════════════════════════

    private rememberThreadFpuSimdState(thread: Thread | null | undefined, ctx: CpuContext): void {
        if (!thread) return;
        if (ctx.fpu) thread.lastFpuState = ctx.fpu;
        if (ctx.simd) thread.lastSimdState = ctx.simd;
    }

    private ensureContextHasFpuSimdState(thread: Thread, ctx: CpuContext): void {
        if (ctx.fpu && ctx.simd) {
            this.rememberThreadFpuSimdState(thread, ctx);
            return;
        }

        const cpu = this.currentThreadId === thread.id && thread.state === ThreadState.RUNNING ? this.getCpu() : null;
        if (cpu) {
            this.fillContextFpuSimdState(cpu, thread, ctx);
            return;
        }

        ctx.fpu = ctx.fpu ?? thread.lastFpuState ?? createDefaultFpuSnapshot();
        ctx.simd = ctx.simd ?? thread.lastSimdState ?? createDefaultSimdSnapshot();
        this.rememberThreadFpuSimdState(thread, ctx);
    }

    private clearFpuSimdDirtyFlag(cpu: V86Cpu): void {
        clearFpuSimdDirty({ cpu });
    }

    private getTimerNoFpuProfile(callbackAddr: number): TimerNoFpuProfile {
        const addr = callbackAddr >>> 0;
        let profile = this.timerNoFpuProfiles.get(addr);
        if (!profile) {
            profile = { clean: 0, dirty: 0, eligible: false, disabled: false };
            this.timerNoFpuProfiles.set(addr, profile);
        }
        return profile;
    }

    private noteTimerNoFpuProfile(callbackAddr: number, dirty: boolean): void {
        const profile = this.getTimerNoFpuProfile(callbackAddr);
        if (dirty) {
            profile.dirty++;
            this.fpuSwitchStats.timerNoFpuDirty++;
            if (!profile.disabled) {
                profile.disabled = true;
                profile.eligible = false;
                this.fpuSwitchStats.timerNoFpuDisabled++;
                this.traceTimerThread(`noFpu disabled cb=0x${(callbackAddr >>> 0).toString(16)}`);
            }
            return;
        }

        if (profile.disabled) return;
        profile.clean++;
        this.fpuSwitchStats.timerNoFpuWarmupClean++;
        if (!profile.eligible && profile.clean >= this.timerNoFpuWarmupCleanRequired) {
            profile.eligible = true;
            this.fpuSwitchStats.timerNoFpuEligible++;
            this.traceTimerThread(
                `noFpu eligible cb=0x${(callbackAddr >>> 0).toString(16)} clean=${profile.clean}`);
        }
    }

    private isTimerNoFpuEligible(callbackAddr: number): boolean {
        const profile = this.timerNoFpuProfiles.get(callbackAddr >>> 0);
        return !!profile && profile.eligible && !profile.disabled;
    }

    private tryArmTimerNoFpuRestoreSkip(cpu: V86Cpu, thread: Thread, ctx: CpuContext): void {
        this.timerFpuRestoreSkipPending = null;
        if (this.timerFpuBorrowActive) return;
        if (this.fpuLiveOwnerThreadId === null || this.fpuLiveOwnerThreadId === thread.id) return;
        if (!hasFpuSimdDirtyFlag({ cpu }) || isFpuSimdDirty({ cpu })) return;
        if (this.spinLoopBase <= 0 || ctx.eip < this.spinLoopBase || ctx.eip >= this.spinLoopEnd) return;

        const winmm = this.process?.getModule('winmm') as import('../../modules/winmm').WinMM | undefined;
        if (!winmm || thread.id !== winmm.timerThreadId) return;
        const cb = winmm.peekPendingCallback?.();
        const callbackAddr = (cb?.callbackAddr ?? 0) >>> 0;
        if (!callbackAddr || !this.isTimerNoFpuEligible(callbackAddr)) return;

        this.timerFpuRestoreSkipPending = {
            threadId: thread.id,
            callbackAddr,
            previousOwnerThreadId: this.fpuLiveOwnerThreadId,
        };
    }

    private trySaveBorrowedTimerFpuState(cpu: V86Cpu, thread: Thread | null, ctx: CpuContext): boolean {
        const borrow = this.timerFpuBorrowActive;
        if (!borrow || !thread || thread.id !== borrow.threadId) return false;

        this.timerFpuBorrowActive = null;
        const dirtyFlagAvailable = hasFpuSimdDirtyFlag({ cpu });
        const dirty = dirtyFlagAvailable ? isFpuSimdDirty({ cpu }) : true;

        ctx.fpu = ctx.fpu ?? thread.lastFpuState ?? createDefaultFpuSnapshot();
        ctx.simd = ctx.simd ?? thread.lastSimdState ?? createDefaultSimdSnapshot();
        this.rememberThreadFpuSimdState(thread, ctx);
        this.fpuSwitchStats.timerNoFpuBorrowedSave++;

        if (!dirtyFlagAvailable || dirty) {
            const profile = this.getTimerNoFpuProfile(borrow.callbackAddr);
            if (!profile.disabled) this.noteTimerNoFpuProfile(borrow.callbackAddr, true);
            this.fpuLiveOwnerThreadId = null;
            if (dirtyFlagAvailable) this.clearFpuSimdDirtyFlag(cpu);
            this.traceTimerThread(
                `noFpu violation cb=0x${borrow.callbackAddr.toString(16)} dirty=${dirty ? 1 : 0}`);
            return true;
        }

        this.fpuLiveOwnerThreadId = borrow.previousOwnerThreadId;
        return true;
    }

    private fillContextFpuSimdState(cpu: V86Cpu, thread: Thread | null, ctx: CpuContext): void {
        if (ctx.fpu && ctx.simd) {
            this.rememberThreadFpuSimdState(thread, ctx);
            return;
        }

        if (this.trySaveBorrowedTimerFpuState(cpu, thread, ctx)) return;

        const dirtyFlagAvailable = hasFpuSimdDirtyFlag({ cpu });
        const dirty = dirtyFlagAvailable ? isFpuSimdDirty({ cpu }) : true;
        const ownerMatches = thread !== null && this.fpuLiveOwnerThreadId === thread.id;

        if (dirtyFlagAvailable && ownerMatches && !dirty && thread?.lastFpuState && thread.lastSimdState) {
            ctx.fpu = thread.lastFpuState;
            ctx.simd = thread.lastSimdState;
            this.fpuSwitchStats.savesSkippedClean++;
            return;
        }

        if (!dirtyFlagAvailable) this.fpuSwitchStats.savesNoDirtyFlag++;
        else if (dirty) this.fpuSwitchStats.savesDirty++;
        else this.fpuSwitchStats.savesNoCachedState++;

        ctx.fpu = fpuSnapshot({ cpu }) ?? ctx.fpu;
        ctx.simd = simdSnapshot({ cpu }) ?? ctx.simd;
        if (ctx.fpu || ctx.simd) this.fpuSwitchStats.saves++;
        this.rememberThreadFpuSimdState(thread, ctx);
        if (dirtyFlagAvailable) this.clearFpuSimdDirtyFlag(cpu);
    }

    private saveCurrentThreadContext(
        cpu: V86Cpu,
        domain: CpuContext["domain"] = 'guest',
        domainGen: number = 0,
    ): CpuContext {
        const ctx = saveCpuContext(cpu, domain, domainGen, { snapshotFpuSimd: false });
        this.fillContextFpuSimdState(cpu, this.getCurrentThread(), ctx);
        return ctx;
    }

    private restoreFpuSimdState(cpu: V86Cpu, ctx: CpuContext, ownerThreadId?: number): void {
        const pendingTimerSkip = this.timerFpuRestoreSkipPending;
        if (pendingTimerSkip && ownerThreadId === pendingTimerSkip.threadId) {
            this.timerFpuRestoreSkipPending = null;
            if (
                (ctx.fpu || ctx.simd) &&
                hasFpuSimdDirtyFlag({ cpu }) &&
                !isFpuSimdDirty({ cpu }) &&
                this.isTimerNoFpuEligible(pendingTimerSkip.callbackAddr)
            ) {
                this.timerFpuBorrowActive = pendingTimerSkip;
                this.fpuSwitchStats.timerNoFpuRestoreSkipped++;
                this.traceTimerThread(
                    `noFpu restore skipped T${ownerThreadId} cb=0x${pendingTimerSkip.callbackAddr.toString(16)} ` +
                    `owner=T${pendingTimerSkip.previousOwnerThreadId}`);
                return;
            }
        } else if (pendingTimerSkip) {
            this.timerFpuRestoreSkipPending = null;
        }

        if (!ctx.fpu && !ctx.simd) {
            this.fpuLiveOwnerThreadId = null;
            this.fpuSwitchStats.restoresNoState++;
            return;
        }

        if (
            ownerThreadId !== undefined &&
            hasFpuSimdDirtyFlag({ cpu }) &&
            this.fpuLiveOwnerThreadId === ownerThreadId
        ) {
            this.fpuSwitchStats.restoresSkippedOwner++;
            return;
        }

        let restored = false;
        if (ctx.fpu) restored = fpuRestore({ cpu }, ctx.fpu) || restored;
        if (ctx.simd) restored = simdRestore({ cpu }, ctx.simd) || restored;
        if (!restored) {
            this.fpuLiveOwnerThreadId = null;
            this.fpuSwitchStats.restoresNoState++;
            return;
        }

        this.fpuSwitchStats.restores++;
        this.fpuLiveOwnerThreadId = ownerThreadId ?? null;
        if (hasFpuSimdDirtyFlag({ cpu })) this.clearFpuSimdDirtyFlag(cpu);
    }

    private saveContext(cpu: V86Cpu, kind: ThunkBoundaryKind, cleanup: number): CpuContext | null {
        switch (kind) {
            case ThunkBoundaryKind.THUNK_STUB: {
                // Between OUT and RET N → construct post-return context
                const mem = this.process!.getCurrentMemory();
                const esp = cpu.reg32[4] >>> 0;
                if (esp < 4 || esp + 4 > mem.length) return this.saveCurrentThreadContext(cpu, 'thunk_stub');

                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const returnAddr = view.getUint32(esp, true);

                if (!isValidGuestEip(returnAddr)) {
                    return this.saveCurrentThreadContext(cpu, 'thunk_stub');
                }

                // Same live register/FPU/SSE snapshot as any save, but resumed at the
                // RET target with ESP past the popped args + caller cleanup.
                const ctx = this.saveCurrentThreadContext(cpu, 'thunk_stub');
                ctx.eip = returnAddr;
                ctx.esp = (esp + 4 + cleanup) >>> 0;
                return ctx;
            }

            case ThunkBoundaryKind.SPIN_LOOP:
            case ThunkBoundaryKind.CALLBACK_STUB:
                // Valid resume points — just save raw CPU state
                return this.saveCurrentThreadContext(cpu, kind === ThunkBoundaryKind.SPIN_LOOP ? 'spin' : 'callback');

            case ThunkBoundaryKind.GUEST_CODE: {
                // Normal guest code — validate EIP range
                const eip = cpu.instruction_pointer[0] >>> 0;
                if (isValidGuestEip(eip)) {
                    return this.saveCurrentThreadContext(cpu, 'guest');
                }

                // Accept EIPs on current thread's stack (SEH unwind trampoline code).
                // x86-32 without NX can execute code on stack — this is intentional for
                // trampolines generated by dispatchCxxException in seh-dispatch.ts.
                const current = this.getCurrentThread();
                if (current && eip >= current.stackBase && eip < current.stackTop) {
                    Logger.verbose(LogCategory.THREAD,
                        `saveContext: EIP=0x${eip.toString(16)} on stack of T${current.id} (trampoline)`);
                    return this.saveCurrentThreadContext(cpu, 'guest');
                }

                const rt = this.activeCriticalRuntime;
                if (this.isValidRuntimeTransientEip(eip) && rt?.section === 'seh_dispatch') {
                    return this.saveCurrentThreadContext(cpu, 'transient_seh', rt.generation);
                }

                Logger.error(LogCategory.THREAD,
                    `saveContext: invalid guest EIP=0x${eip.toString(16)}`);
                return null;
            }
        }
    }

    private restoreContext(cpu: V86Cpu, ctx: CpuContext, ownerThreadId?: number): boolean {
        const domain = ctx.domain ?? 'guest';
        if (domain === 'transient_seh') {
            const rt = this.activeCriticalRuntime;
            const ctxGen = (ctx.domainGen ?? 0) >>> 0;
            if (!rt || rt.section !== 'seh_dispatch' || ctxGen !== (rt.generation >>> 0)) {
                this.sehDeniedRestoreCount++;
                Logger.error(LogCategory.THREAD,
                    `RESTORE_DENIED_DOMAIN_MISMATCH: eip=0x${ctx.eip.toString(16)} ` +
                    `ctxGen=${ctxGen} rtGen=${rt?.generation ?? 0}`);
                return false;
            }
        }

        if (!this.isValidEipForRestore(ctx.eip)) {
            Logger.error(LogCategory.THREAD,
                `restoreContext: invalid EIP=0x${ctx.eip.toString(16)}`);
            return false;
        }

        this.applyContextState(cpu, ctx, ctx.esp, ownerThreadId);
        cpu.instruction_pointer[0] = ctx.eip;
        if (cpu.is_jumping !== undefined) cpu.is_jumping = true;

        return true;
    }

    /**
     * Apply a saved context's GPRs (with the given ESP), EFLAGS, x87 FPU and SSE
     * (XMM+MXCSR) to the live CPU. Shared by both restore mechanisms —
     * restoreContext (direct write, esp = ctx.esp) and stackBasedRestore (RET-trick,
     * esp = adjustedEsp) — so the full register set (incl. FPU/SSE)
     * is restored identically on either path. EIP + is_jumping are the caller's job:
     * the direct path writes EIP, the stack path lets RET N pop it off the stack.
     */
    private applyContextState(cpu: V86Cpu, ctx: CpuContext, esp: number, ownerThreadId?: number): void {
        const reg = cpu.reg32;
        reg[0] = ctx.eax; reg[1] = ctx.ecx; reg[2] = ctx.edx; reg[3] = ctx.ebx;
        reg[4] = esp; reg[5] = ctx.ebp; reg[6] = ctx.esi; reg[7] = ctx.edi;
        cpu.flags[0] = ctx.eflags;
        // Mirror v86's update_eflags/popf: the written EFLAGS is authoritative —
        // clear the lazy-flags dirty mask so the resumed thread does NOT recompute
        // arithmetic flags from the OUTGOING thread's last ALU result (shared
        // register file, same hazard class as fpu/simd below).
        if (cpu.flags_changed) cpu.flags_changed[0] = 0;
        this.restoreFpuSimdState(cpu, ctx, ownerThreadId);
    }

    private handleUnsaveableCurrentThread(thread: Thread, cpu: V86Cpu, kind: ThunkBoundaryKind, cleanup: number, source: string): boolean {
        const eip = cpu.instruction_pointer[0] >>> 0;
        const esp = cpu.reg32[4] >>> 0;
        const detail =
            `cannot-save T${thread.id},state=${THREAD_STATE_NAMES[thread.state]},` +
            `eip=${hx(eip)},esp=${hx(esp)},cleanup=${cleanup}`;
        this.traceAsyncRestore(source, cpu, detail);
        this.dumpSchedulerAsyncState(source, cpu, kind, detail, 'error');

        if (this.isMainThread(thread.id)) {
            Logger.error(LogCategory.THREAD,
                `performSwitch: cannot save MAIN T${thread.id} at EIP=${hx(eip)} ESP=${hx(esp)}; fatal guard`);
            this.reportFatalGuard(0x4100, eip, thread.id);
            return false;
        }

        Logger.error(LogCategory.THREAD,
            `performSwitch: cannot save worker T${thread.id} at EIP=${hx(eip)} ESP=${hx(esp)}; terminating thread to stop scheduler death spiral`);
        this.terminateThread(thread.id, 0xC0000005);
        return true;
    }


    // ═══════════════════════════════════════════════════════════════════════
    // Context Switch
    // ═══════════════════════════════════════════════════════════════════════

    private performSwitch(cpu: V86Cpu, kind: ThunkBoundaryKind, cleanup: number): boolean {
        this.accumThreadCpu();
        let current = this.getCurrentThread();
        this.traceAsyncRestore("performSwitch", cpu, `boundary=${boundaryKindName(kind)},cleanup=${cleanup}`);

        // Save current thread context if RUNNING
        if (current && current.state === ThreadState.RUNNING) {
            // Sync lastError from WASM hypercall page
            if (hypercallDataManager.isInitialized()) {
                current.lastError = hypercallDataManager.readLastError();
            }

            const context = this.saveContext(cpu, kind, cleanup);
            if (!context) {
                const canContinue = this.handleUnsaveableCurrentThread(current, cpu, kind, cleanup, "performSwitch");
                if (!canContinue) return false;
                current = this.getCurrentThread();
                if (current?.state === ThreadState.TERMINATED) current = null;
            } else {
                this.transitionTo(current, ThreadState.READY, null, context);
            }
        } else if (current && this.currentThreadId === current.id && current.context === null &&
                   current.state === ThreadState.SUSPENDED) {
            // The current thread suspended ITSELF (SuspendThread(self)) while running — its
            // live CPU context was nulled when it went RUNNING and never re-saved, because
            // suspendThread sets the state directly, bypassing the RUNNING save above.
            // Capture it now (keep it SUSPENDED) so a later ResumeThread can restore it.
            // Without this the thread re-enters the run queue with no context and
            // performSwitch spins "T<id> has no context". (WAITING/async-park threads manage
            // their own resume via the async-restore path, so they're intentionally excluded.)
            if (hypercallDataManager.isInitialized()) {
                current.lastError = hypercallDataManager.readLastError();
            }
            const context = this.saveContext(cpu, kind, cleanup);
            if (context) current.context = context;
        }

        // Pick next thread
        const next = this.pickNextRunnable(current?.id);
        if (!next) { this.roundTripStats.noRunnable++; return false; }

        // ── TEMP DIAGNOSTIC (crash-hunt): see setDebugHeadWatch/debugHeadWatchLog above.
        // Hot path is cheap: compute midMutation from outEip (no mem), read one dword for
        // `torn`. Build a string + push ONLY on the rare discriminating events (torn or
        // switching out mid-splice) — nothing on ordinary switches, so timing is undisturbed.
        if (this.debugHeadWatch) {
            const outEip = (current?.context?.eip ?? cpu.instruction_pointer[0]) >>> 0;
            const midMutation = outEip >= this.debugHeadWatch.loEip && outEip < this.debugHeadWatch.hiEip;
            const head = (Mem.readUint32(this.debugHeadWatch.headAddr) ?? 0) >>> 0;
            if ((head === 0 || midMutation) && this.debugHeadWatchLog.length < 4000) {
                const c = current?.context;
                const gpr = c ? ` OUT{esi=0x${(c.esi >>> 0).toString(16)} esp=0x${(c.esp >>> 0).toString(16)} edi=0x${(c.edi >>> 0).toString(16)} ebx=0x${(c.ebx >>> 0).toString(16)}}` : "";
                this.debugHeadWatchLog.push(
                    `T${current?.id ?? 0}@0x${outEip.toString(16)}->T${next.id} head=0x${head.toString(16)}` +
                    `${head === 0 ? " *TORN*" : ""}${midMutation ? " *MID-SPLICE*" : ""} bnd=${boundaryKindName(kind)}${gpr}`);
            }
        }

        // Self-restore optimization
        if (current && next.id === current.id) {
            // If at spin loop with saved context pointing elsewhere, must restore
            const eip = cpu.instruction_pointer[0] >>> 0;
            const atSpinLoop = this.spinLoopBase > 0 && eip >= this.spinLoopBase && eip < this.spinLoopEnd;
            if (atSpinLoop && next.context && next.context.eip !== eip) {
                // Fall through to full restore
            } else {
                // CPU state is correct, just mark as RUNNING — the whole round-trip was a no-op switch.
                this.roundTripStats.selfReschedule++;
                this.transitionTo(next, ThreadState.RUNNING, null, null);
                return false;
            }
        }
        this.roundTripStats.realSwitch++;

        // Full context restore
        if (!next.context) {
            Logger.error(LogCategory.THREAD, `performSwitch: T${next.id} has no context`);
            return false;
        }

        const savedCtx = next.context;
        this.ensureContextHasFpuSimdState(next, savedCtx);
        this.tryArmTimerNoFpuRestoreSkip(cpu, next, savedCtx);
        this.transitionTo(next, ThreadState.RUNNING, null, null);

        // Determine restore method based on current EIP location
        const currentEip = cpu.instruction_pointer[0] >>> 0;
        const inThunkRegion = (currentEip >= this.thunkStubBase && currentEip < this.thunkStubEnd) ||
            (this.callbackStubBase > 0 && currentEip >= this.callbackStubBase && currentEip < this.callbackStubEnd);

        if (inThunkRegion && kind === ThunkBoundaryKind.THUNK_STUB) {
            // Stack-based restore: compute adjusted ESP, write target EIP, let RET N pop naturally
            this.stackBasedRestore(cpu, savedCtx, cleanup, next.id);
        } else {
            // Direct restore
            this.restoreContext(cpu, savedCtx, next.id);
        }

        // ── TEMP DIAGNOSTIC (crash-hunt): restore-IN into the splice function. Compare the
        // SAVED context GPRs against the LIVE cpu regs after restore — a mismatch is our
        // save/restore losing a register (esi=0 hypothesis). Method = which restore path ran.
        if (this.debugHeadWatch && savedCtx.eip >= this.debugHeadWatch.loEip && savedCtx.eip < this.debugHeadWatch.hiEip) {
            const r = cpu.reg32;
            const method = (inThunkRegion && kind === ThunkBoundaryKind.THUNK_STUB) ? "stack" : "direct";
            const mism = ((r[6] >>> 0) !== (savedCtx.esi >>> 0)) || ((r[4] >>> 0) !== (savedCtx.esp >>> 0)) ||
                         ((r[7] >>> 0) !== (savedCtx.edi >>> 0)) || ((r[3] >>> 0) !== (savedCtx.ebx >>> 0));
            if (this.debugHeadZeroSnaps.length < 2000) {
                this.debugHeadZeroSnaps.push(
                    `IN T${next.id}@0x${(savedCtx.eip >>> 0).toString(16)} [${method}] ` +
                    `saved{esi=0x${(savedCtx.esi >>> 0).toString(16)} esp=0x${(savedCtx.esp >>> 0).toString(16)} edi=0x${(savedCtx.edi >>> 0).toString(16)} ebx=0x${(savedCtx.ebx >>> 0).toString(16)}} ` +
                    `live{esi=0x${(r[6] >>> 0).toString(16)} esp=0x${(r[4] >>> 0).toString(16)} edi=0x${(r[7] >>> 0).toString(16)} ebx=0x${(r[3] >>> 0).toString(16)}}` +
                    `${mism ? " *** REG MISMATCH ***" : ""}${(savedCtx.esi >>> 0) === 0 ? " [saved esi=0]" : ""}`);
            }
        }

        // Update FS segment for new thread's TEB
        if (next.tebAddress > 0) {
            setFsBase(cpu, next.tebAddress);
        }

        // Sync thread data to WASM hypercall page
        if (hypercallDataManager.isInitialized()) {
            hypercallDataManager.syncThreadData(next.id, next.lastError, next.tebAddress);
        }

        // Notify ThunkDispatcher
        const oldId = current?.id ?? 0;
        if (this.onThreadSwitchCallback) {
            this.onThreadSwitchCallback(oldId, next.id);
        }

        next.lastSwitchTime = performance.now();
        next.lastSwitchInsn = this.retiredInsns(cpu); // deterministic quantum baseline for the resumed thread
        return true;
    }

    /**
     * Stack-based restore: works around v86 JIT is_jumping unreliability.
     * Write target EIP at adjusted ESP position, let RET N pop it naturally.
     */
    private stackBasedRestore(cpu: V86Cpu, target: CpuContext, cleanup: number, ownerThreadId?: number): void {
        // Validate target EIP before writing it to the stack.
        // restoreContext() validates via isValidEipForRestore, but stackBasedRestore
        // writes blindly — a bad target.eip would be pushed onto the stack and then
        // popped by RET N, sending the CPU to an invalid/dangerous address.
        if (!this.isValidEipForRestore(target.eip)) {
            Logger.error(LogCategory.THREAD,
                `stackBasedRestore: target EIP=0x${target.eip.toString(16)} out of valid range, ` +
                `target.esp=0x${target.esp.toString(16)}, cleanup=${cleanup} — falling back to restoreContext`);
            this.restoreContext(cpu, target, ownerThreadId);
            return;
        }

        const mem = this.process!.getCurrentMemory();
        const adjustedEsp = (target.esp - 4 - cleanup) >>> 0;

        if (adjustedEsp < 4 || adjustedEsp + 4 > mem.length) {
            // Fallback to direct restore
            this.restoreContext(cpu, target, ownerThreadId);
            return;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        // Tripwire: this write belongs in the TARGET thread's dead zone (below its saved
        // ESP). Hitting another parked thread's live range = the stale-ESP corruption class.
        guardStackWrite(adjustedEsp, 4, 'sched:stackBasedRestore', target.eip);
        view.setUint32(adjustedEsp, target.eip, true);

        // GPRs (ESP = adjustedEsp, RET N pops EIP off the stack) + EFLAGS + FPU + SSE.
        // EIP is delivered via the stack; don't set is_jumping — let RET N execute naturally.
        this.applyContextState(cpu, target, adjustedEsp, ownerThreadId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Thread Lifecycle
    // ═══════════════════════════════════════════════════════════════════════

    createThread(
        startAddress: number, parameter: number, stackSize: number,
        creationFlags: number, outThreadId: number, memory: Uint8Array
    ): number {
        if (!this.process) return 0;
        this.writeThreadExitStub();

        const size = stackSize > 0 ? stackSize : this.defaultStackSize;
        let stackBase: number;
        try {
            stackBase = this.process.memory.alloc(size);
        } catch (e) {
            Logger.error(LogCategory.THREAD, `CreateThread failed: ${e}`);
            return 0;
        }

        const stackTop = stackBase + size;
        memory.fill(0, stackBase, stackTop);

        // Set up stack: [parameter, exitStubAddr]
        const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
        let esp = stackTop;
        esp -= 4; view.setUint32(esp, parameter >>> 0, true);
        esp -= 4; view.setUint32(esp, this.threadExitStubAddr >>> 0, true);

        const threadId = this.nextThreadId++;
        const handle = this.resourceProvider.registerKernelObject({
            kind: 'thread', threadId,
        } as KernelThreadObject);

        const isSuspended = (creationFlags & CREATE_SUSPENDED) !== 0;
        const context = createInitialContext(startAddress, esp);

        let tebAddress = 0;
        if (this.process.memory) {
            tebAddress = this.tebManager.allocateTeb(threadId, stackBase, stackTop, this.process.memory);
        }

        const thread: Thread = {
            id: threadId, handle,
            state: isSuspended ? ThreadState.SUSPENDED : ThreadState.READY,
            context,
            stackBase, stackSize: size, stackTop,
            startAddress, parameter,
            waitInfo: null, exitCode: null,
            tlsValues: new Map(), lastError: 0,
            suspendCount: isSuspended ? 1 : 0,
            priority: 0, lastSwitchTime: 0, lastSwitchInsn: 0,
            tebAddress, kernelPinCount: 0,
            apcQueue: [],
            quitPosted: false, quitExitCode: 0,
            asyncParkGeneration: 0,
        };

        this.threads.set(threadId, thread);
        if (!isSuspended) this.runQueue.push(threadId);

        // Initialize implicit TLS data for the new thread.
        // Each PE module with __declspec(thread) vars needs its own TLS data copy.
        this.initImplicitTlsForThread(threadId, thread, memory);

        Logger.log(LogCategory.THREAD,
            `CreateThread: id=${threadId} start=0x${startAddress.toString(16)} stack=0x${stackBase.toString(16)} state=${isSuspended ? 'SUSPENDED' : 'READY'}`);

        if (outThreadId && outThreadId + 4 <= memory.length) {
            view.setUint32(outThreadId, threadId >>> 0, true);
        }

        this.updateMultiThreadMode();
        // Don't requestSwitch here — on real Windows, CreateThread does NOT
        // preempt the calling thread. The new thread is queued and scheduled
        // when the creator yields or its quantum expires. Eager switching
        // causes races (e.g. a counter thread exits because activeFlag
        // isn't set yet by the creating thread).
        //
        // Prefer bootstrap threads at the next natural switch; manual-reset
        // SetEvent-before-wait is covered by pendingWake in sync-objects.
        if (!isSuspended) {
            this.enqueueBootstrapToFirstWait(threadId);
        }

        return handle;
    }

    /**
     * Prefer scheduling a new thread until it blocks at its first wait/sleep.
     * Does not preempt the creator (CreateThread invariant); the child runs at
     * the next quantum, yield, or voluntary wait on the creator thread.
     */
    enqueueBootstrapToFirstWait(threadId: number): void {
        if (!this.threads.has(threadId)) return;
        this.bootstrapUntilFirstWait.add(threadId);
        this.removeFromRunQueue(threadId);
        this.runQueue.unshift(threadId);
    }

    exitThread(exitCode: number): void {
        const thread = this.getCurrentThread();
        if (!thread) return;
        this.terminateThread(thread.id, exitCode);
        this.requestSwitch();
    }

    /**
     * Unhandled CPU exception (#GP/#UD) on a worker thread: terminate ONLY the
     * faulting thread (exit code = NT status) and reschedule. The dispatcher has
     * already redirected the fault frame's IRET to the spin loop, so the dead
     * thread never executes guest code again; performSwitch skips a TERMINATED
     * current and picks the next runnable at the next boundary.
     */
    terminateCurrentThreadForFault(exitCode: number, detail: string): void {
        const thread = this.getCurrentThread();
        if (!thread || thread.state === ThreadState.TERMINATED) return;
        Logger.error(LogCategory.THREAD,
            `terminateCurrentThreadForFault: T${thread.id} ${detail} — ` +
            `terminating with exit code 0x${(exitCode >>> 0).toString(16)}`);
        this.terminateThread(thread.id, exitCode);
        this.requestSwitch();
    }

    /**
     * Terminate EVERY thread of the process — the faithful Win32 ExitProcess
     * semantics. ExitProcess (unlike ExitThread) tears down the whole process:
     * all threads stop, not just the caller. Without this the worker-pool /
     * winmm-timer / audio threads keep running after the main thread exits,
     * leaving the worker spinning a frozen frame (a pseudo-hang) instead of a
     * clean shutdown. With no runnable threads left, v86 leaves its run loop.
     */
    terminateAllThreads(exitCode: number): void {
        for (const id of Array.from(this.threads.keys())) {
            this.terminateThread(id, exitCode);
        }
        this.requestSwitch();
    }

    private terminateThread(threadId: number, exitCode: number): void {
        const thread = this.threads.get(threadId);
        if (!thread || thread.state === ThreadState.TERMINATED) return;

        Logger.log(LogCategory.THREAD,
            `terminateThread: T${threadId} ${THREAD_STATE_NAMES[thread.state]} -> TERMINATED`);

        // Unregister from wait engine if waiting
        if (thread.state === ThreadState.WAITING) {
            this.waitEngine.unregisterWait(thread);
        }

        const safeExitCode = exitCode >>> 0;
        this.setThreadState(thread, ThreadState.TERMINATED);
        thread.exitCode = safeExitCode;
        thread.waitInfo = null;
        thread.context = null;
        thread.apcQueue.length = 0;

        this.removeFromRunQueue(threadId);

        // Persist exit metadata into the kernel object so GetExitCodeThread /
        // WaitForSingleObject can still work after the Thread record is reaped.
        const kobj = this.resourceProvider.getKernelObject(thread.handle) as KernelThreadObject | null;
        if (kobj && kobj.kind === 'thread') {
            kobj.terminated = true;
            kobj.exitCode = safeExitCode;
        }

        // Release owned mutexes
        const releasedMutexes = this.syncObjects.releaseAllMutexesForThread(threadId);
        for (const h of releasedMutexes) this.wakeWaitingThreadsForHandle(h);

        // Release owned critical sections
        this.releaseAllCriticalSectionsForThread(threadId);

        // Clean up per-thread SEH active exception state (re-throw support).
        // Thread teardown must drop the full nested-exception stack for this TEB.
        if (thread.tebAddress > 0) {
            clearAllActiveExceptions(thread.tebAddress);
        }

        // Wake threads waiting on this thread handle
        this.wakeWaitingThreadsForHandle(thread.handle);

        // Enqueue for deferred reaping (preserves Thread record for a grace period)
        this.reapQueue.push({ threadId, terminatedAt: this.timeService.nowMs() });

        this.updateMultiThreadMode();
    }

    /** Reap threads that have been TERMINATED for longer than the grace period. 
     *  Uses index-based head to avoid Array.shift() overhead. */
    private reapTerminatedThreads(now: number): void {
        const q = this.reapQueue;
        while (this.reapHead < q.length) {
            const entry = q[this.reapHead];
            if (now - entry.terminatedAt < Scheduler.REAP_GRACE_MS) break;
            // Never reap the thread the scheduler still considers current — currentThreadId
            // is only reassigned when another thread goes RUNNING, so until a switch happens
            // it points here. Deleting it would make getCurrentThread() return null and the
            // step-7 switch path (gated on a non-null current historically) strand a later
            // survivor wake. Leave it queued; it gets reaped once a switch moves `current` on.
            if (entry.threadId === this.currentThreadId) break;
            const thread = this.threads.get(entry.threadId);
            if (thread && thread.state === ThreadState.TERMINATED) {
                this.threads.delete(entry.threadId);
            }
            this.reapHead++;
        }
        // Compact: once head reaches a reasonable threshold, trim consumed entries
        if (this.reapHead > 32) {
            this.reapQueue = q.slice(this.reapHead);
            this.reapHead = 0;
        }
    }

    terminateThreadByHandle(handle: number, exitCode: number): boolean {
        const thread = this.getThreadByHandle(this.resolveHandle(handle));
        if (!thread) return false;
        this.terminateThread(thread.id, exitCode);
        if (this.currentThreadId === thread.id) this.requestSwitch();
        return true;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Sleep / Wait / Yield
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Sole-runnable short Sleep: thread stays RUNNING while v86 yields to host, so no insn-based
     * virtual-time tick. Credit the requested sleep in guest-ms (A/B: __noSleepVirtualCredit).
     * Polls the timer wheel immediately so due waiters wake before guest resumes.
     */
    private creditVirtualTimeForSoleRunnableSleep(ms: number): void {
        if (ms <= 0 || ms === INFINITE) return;
        if ((globalThis as any).__noSleepVirtualCredit) return;
        if (!this.timeService.isVirtualTimeActive()) return;
        // Clamp against wall (creditIdleMs) rather than raw advanceVirtualTime: a game
        // that pumps Sleep(1-2) thousands of times/sec would otherwise run virtual time
        // unbounded-ly ahead of wall, then updateTimeData's own clamp zeroes the
        // instruction clock → slow-motion + audio desync (Sea Dogs). See creditIdleMs.
        const credited = this.timeService.creditIdleMs(ms);
        this.timerWheel.poll(this.timeService.nowMs());
        this.soleRunnableSleepStats.credits++;
        this.soleRunnableSleepStats.msCredited += credited;
    }

    sleepWithContext(
        ms: number, returnAddr: number, postReturnEsp: number,
        callerCtx: { ecx: number; edx: number; ebx: number; ebp: number; esi: number; edi: number; eflags: number },
        alertable: boolean = false
    ): number {
        const thread = this.getCurrentThread();
        if (!thread) return 0;

        // Notify frame pacer: game is self-throttling via Sleep — skip rAF wait on next Flip
        if (ms >= 5) framePacer.notifySleep(ms);

        // Alertable: check pending APCs
        if (alertable && thread.apcQueue.length > 0) {
            return WAIT_IO_COMPLETION;
        }

        // Validate returnAddr before saving as resume EIP.
        if (!isValidGuestEip(returnAddr)) {
            Logger.error(LogCategory.THREAD,
                `sleepWithContext: invalid returnAddr=0x${returnAddr.toString(16)} T${thread.id}`);
            return 0; // Return immediately without blocking — caller continues from bad address anyway
        }

        if (ms === 0) {
            if (!this.hasOtherRunnableThreads(thread.id)) {
                this.requestYieldToHost(this.computeYieldMs(1), "sleep0");
                return 0;
            }
            const context = createPostReturnContext(returnAddr, postReturnEsp, callerCtx, 0);
            this.transitionTo(thread, ThreadState.READY, null, context);
            this.requestSwitch();
            return 0;
        }

        if (!this.hasOtherRunnableThreads(thread.id)) {
            // Short sole-runnable Sleep: stay RUNNING, credit virtual time, yield to host.
            // Virtual-time gap: no guest instructions during yield → updateTimeData() never ticks;
            // timeGetTime-paced loops (NFSU audio pump EDI+=10) see a frozen clock without
            // credit. Idle-pump in pollTimeouts() is gated off while any thread is RUNNING.
            // A/B kill-switch: globalThis.__noSleepVirtualCredit = true
            //
            // Long sole-runnable Sleep(>50): blockThread + timer wheel — crediting full `ms`
            // while host yield is capped at 50ms would fast-forward virtual time (menu/loading).
            if (ms !== INFINITE && ms <= SOLE_RUNNABLE_SLEEP_CREDIT_MAX_MS) {
                this.sleepPathStats.soleRunnableYield++;
                this.creditVirtualTimeForSoleRunnableSleep(ms);
                this.requestYieldToHost(ms, "sleepN");
                return 0;
            }
            if (ms !== INFINITE) {
                const context = createPostReturnContext(returnAddr, postReturnEsp, callerCtx, 0);
                this.sleepPathStats.blockedWait++;
                this.blockThread(thread, WaitReason.SLEEP, [], false, ms, alertable, 0, context);
                this.requestYieldToHost(this.computeYieldMs(ms), "sleepNLong");
                return WAIT_BLOCKED_NO_SWITCH;
            }
            return 0;
        }

        const context = createPostReturnContext(returnAddr, postReturnEsp, callerCtx, 0);
        this.sleepPathStats.blockedWait++;
        this.blockThread(thread, WaitReason.SLEEP, [], false, ms === INFINITE ? null : ms, alertable, 0, context);
        this.requestSwitch();
        return WAIT_BLOCKED_NO_SWITCH;
    }

    /**
     * Park a synchronous HLE call until a short deadline and resume it as if it
     * returned zero. Unlike sleepWithContext(), this never turns a sole-runnable
     * wait into an immediate return plus host yield: callers use it to collapse a
     * hot polling API into one scheduler wait while preserving a synchronous guest
     * call/return boundary.
     */
    parkCurrentThreadUntil(
        delayMs: number, returnAddr: number, postReturnEsp: number,
        callerCtx: { ecx: number; edx: number; ebx: number; ebp: number; esi: number; edi: number; eflags: number },
    ): number {
        const thread = this.getCurrentThread();
        if (!thread) return 0;

        if (!isValidGuestEip(returnAddr)) {
            Logger.error(LogCategory.THREAD,
                `parkCurrentThreadUntil: invalid returnAddr=0x${returnAddr.toString(16)} T${thread.id}`);
            return 0;
        }

        const waitMs = Math.max(1, Number.isFinite(delayMs) ? delayMs : 1);
        const context = createPostReturnContext(returnAddr, postReturnEsp, callerCtx, 0);
        this.blockThread(thread, WaitReason.SLEEP, [], false, waitMs, false, 0, context);

        if (this.hasOtherRunnableThreads(thread.id)) {
            this.requestSwitch();
        } else {
            this.requestYieldToHost(this.computeYieldMs(waitMs), "hleDeadline");
        }
        return WAIT_BLOCKED_NO_SWITCH;
    }

    waitForMessage(
        returnAddr: number,
        postReturnEsp: number,
        callerCtx: { ecx: number; edx: number; ebx: number; ebp: number; esi: number; edi: number; eflags: number },
    ): boolean {
        const thread = this.getCurrentThread();
        if (!thread) return false;

        if (!isValidGuestEip(returnAddr)) {
            Logger.error(LogCategory.THREAD,
                `waitForMessage: invalid returnAddr=0x${returnAddr.toString(16)} T${thread.id}`);
            return false;
        }

        const context = createPostReturnContext(returnAddr, postReturnEsp, callerCtx, 1);
        this.blockThread(thread, WaitReason.MESSAGE, [], false, null, false, 0, context);
        if (this.hasOtherRunnableThreads(thread.id)) {
            this.requestSwitch();
        } else {
            // Sole thread: yield to host so input/timers/posted messages can arrive.
            this.requestYieldToHost(this.computeYieldMs(50), "waitMsg");
        }
        return true;
    }

    wakeMessageWaiters(targetThreadId?: number): void {
        for (const thread of this.threads.values()) {
            if (thread.state !== ThreadState.WAITING) continue;
            if (thread.waitInfo?.reason !== WaitReason.MESSAGE) continue;
            if (targetThreadId !== undefined && thread.id !== targetThreadId) continue;
            this.wakeThread(thread, 1); // TRUE — WaitMessage return value
        }
    }

    /** PostQuitMessage sets the per-thread quit flag (Windows semantics). */
    postQuitForCurrentThread(exitCode: number): void {
        const thread = this.getCurrentThread();
        if (!thread) return;
        thread.quitPosted = true;
        thread.quitExitCode = exitCode;
        Logger.log(LogCategory.THREAD, `T${thread.id} PostQuitMessage(${exitCode}) - per-thread flag set`);
    }

    /** Check quit state for a thread. Returns null if thread not found. */
    getQuitState(threadId: number): { posted: boolean; exitCode: number } | null {
        const thread = this.threads.get(threadId);
        if (!thread) return null;
        return { posted: thread.quitPosted, exitCode: thread.quitExitCode };
    }

    /** Clear the quit flag after WM_QUIT has been consumed by GetMessage/PeekMessage. */
    clearQuitFlag(threadId: number): void {
        const thread = this.threads.get(threadId);
        if (thread) {
            thread.quitPosted = false;
            thread.quitExitCode = 0;
        }
    }

    waitForObjectsWithContext(
        handles: number[], waitAll: boolean, timeoutMs: number,
        returnAddr: number, postReturnEsp: number,
        callerCtx: { ecx: number; edx: number; ebx: number; ebp: number; esi: number; edi: number; eflags: number },
        alertable: boolean = false
    ): number {
        const thread = this.getCurrentThread();
        if (!thread) return WAIT_FAILED;

        const resolved = this.resolveHandles(handles, thread);
        if (!this.syncObjects.validateHandles(resolved)) return WAIT_FAILED;

        const decision = this.syncObjects.checkWait(resolved, waitAll, thread.id, (tid) => this.threads.get(tid) ?? null);
        if (decision.ready) { this.syncObjects.consumeWait(decision, thread.id); return decision.result; }

        if (alertable && thread.apcQueue.length > 0) return WAIT_IO_COMPLETION;
        if (timeoutMs === 0) {
            // A zero-timeout wait is only a probe: preserve WAIT_TIMEOUT and never
            // park the caller.  On Windows the polling thread is still preemptible,
            // though.  In the emulator a tight loop of WFSO(event, 0) can otherwise
            // cross thousands of thunk boundaries without retiring enough guest
            // instructions to expire its quantum, starving the READY thread that is
            // supposed to SetEvent (TLJ's loader/audio workers are one such pattern).
            // Requesting the normal thunk-boundary switch restores that fairness; it
            // does not consume/signals the object or change the observable result.
            if (this.hasOtherRunnableThreads(thread.id)) this.requestSwitch();
            return WAIT_TIMEOUT;
        }

        // Debug: Log when a thread blocks on INFINITE wait (helps trace unsignaled events)
        if (timeoutMs === INFINITE) {
            const handleDescs = resolved.map(h => {
                const obj = this.syncObjects.describeHandle(h);
                return `0x${h.toString(16)}(${obj})`;
            });
            Logger.verbose(LogCategory.THREAD,
                `T${thread.id} BLOCKING INFINITE on ${handleDescs.join(',')} ret=0x${returnAddr.toString(16)}`);
        }

        // Validate returnAddr before saving it as the thread's resume EIP.
        // A bad returnAddr (e.g. bootloader address, null) would cause a crash when
        // the thread is later restored and stackBasedRestore writes it to the stack.
        if (!isValidGuestEip(returnAddr)) {
            Logger.error(LogCategory.THREAD,
                `waitForObjectsWithContext: invalid returnAddr=0x${returnAddr.toString(16)} T${thread.id} — returning WAIT_FAILED`);
            return WAIT_FAILED;
        }

        const context = createPostReturnContext(returnAddr, postReturnEsp, callerCtx, WAIT_OBJECT_0);

        // Nothing else can run: park on the timer wheel anyway. A finite timeout must be
        // CONSUMED, not answered — WAIT_TIMEOUT before the deadline is guest-measurable.
        // Blade of Darkness derives its whole game clock from the RDTSC delta across
        // WaitForSingleObject(sem, 100) and scales every frame by it. While parked no
        // thread is READY/RUNNING, so pollTimeouts' idle pump paces virtual time in wall
        // time and the wheel entry blockThread registers delivers the WAIT_TIMEOUT.
        if (!this.hasOtherRunnableThreads(thread.id)) {
            this.blockThread(thread, waitAll ? WaitReason.MULTIPLE_OBJECTS : WaitReason.SINGLE_OBJECT,
                resolved, waitAll, timeoutMs === INFINITE ? null : timeoutMs, alertable, 0, context);
            this.requestYieldToHost(this.computeYieldMs(timeoutMs), "waitObj");
            return WAIT_BLOCKED_NO_SWITCH;
        }

        this.blockThread(thread, waitAll ? WaitReason.MULTIPLE_OBJECTS : WaitReason.SINGLE_OBJECT,
            resolved, waitAll, timeoutMs === INFINITE ? null : timeoutMs, alertable, 0, context);
        this.requestSwitch();
        // Must NOT return WAIT_OBJECT_0 to the sync thunk — the thread is WAITING with a
        // saved post-return context; stub RET would resume guest code on a parked thread
        // (SS2 boot: T2 WFSO + T1 continues → stack corruption → 0x7c07).
        return WAIT_BLOCKED_NO_SWITCH;
    }

    waitForObjectsExWithContext(
        handles: number[], waitAll: boolean, timeoutMs: number, alertable: boolean,
        returnAddr: number, postReturnEsp: number,
        callerCtx: { ecx: number; edx: number; ebx: number; ebp: number; esi: number; edi: number; eflags: number }
    ): number {
        return this.waitForObjectsWithContext(handles, waitAll, timeoutMs, returnAddr, postReturnEsp, callerCtx, !!alertable);
    }

    waitForSingleObjectWithContext(
        handle: number, timeoutMs: number,
        returnAddr: number, postReturnEsp: number,
        callerCtx: { ecx: number; edx: number; ebx: number; ebp: number; esi: number; edi: number; eflags: number },
        alertable: boolean = false
    ): number {
        return this.waitForObjectsWithContext([handle], false, timeoutMs, returnAddr, postReturnEsp, callerCtx, alertable);
    }

    waitForSingleObjectExWithContext(
        handle: number, timeoutMs: number, alertable: boolean,
        returnAddr: number, postReturnEsp: number,
        callerCtx: { ecx: number; edx: number; ebx: number; ebp: number; esi: number; edi: number; eflags: number }
    ): number {
        return this.waitForObjectsWithContext([handle], false, timeoutMs, returnAddr, postReturnEsp, callerCtx, !!alertable);
    }

    yield(cpu: V86Cpu): void {
        const thread = this.getCurrentThread();
        if (!thread || !this.hasOtherRunnableThreads(thread.id)) return;
        this.requestSwitch();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Timer Thread Support (WinMM dedicated timer thread)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Block the timer thread on its wake event. Called by WinMM after creation
     * and by dispatchTimerThreadCallbacks when no more work.
     */
    blockTimerThread(timerThreadId: number, wakeEvent: number): void {
        const thread = this.threads.get(timerThreadId);
        if (!thread) return;

        // Check if event is already signaled (race: setEvent fired while T was not WAITING).
        // If so, consume the signal (auto-reset) and don't block — stay runnable.
        const decision = this.syncObjects.checkWait(
            [wakeEvent], false, thread.id,
            (tid) => this.threads.get(tid) ?? null
        );
        if (decision.ready) {
            this.syncObjects.consumeWait(decision, thread.id);
            this.traceTimerThread(`blockTimer T${thread.id}: wake event pre-signaled, staying runnable`);
            return;
        }

        // If the thread is RUNNING (current), save CPU state
        if (thread.state === ThreadState.RUNNING) {
            const cpu = this.getCpu();
            if (!cpu) return;
            const ctx = this.saveCurrentThreadContext(cpu);
            this.traceTimerThread(
                `blockTimer T${thread.id} savedEip=0x${ctx.eip.toString(16)} → WAITING on 0x${wakeEvent.toString(16)}`);
            this.blockThread(thread, WaitReason.SINGLE_OBJECT, [wakeEvent], false, null, false, 0, ctx);
            this.requestSwitch();
        } else if (thread.state === ThreadState.READY && thread.context) {
            // Thread is READY (just created, not yet scheduled) — block it directly
            this.blockThread(thread, WaitReason.SINGLE_OBJECT, [wakeEvent], false, null, false, 0, thread.context);
        }
    }

    /**
     * WinMM calls this when the dedicated timer thread is created or torn down.
     * Keeps a hot-path cache so non-timer threads skip getModule() on every boundary.
     */
    notifyWinmmTimerThread(timerThreadId: number, wakeEvent: number): void {
        this.cachedWinmmTimerThreadId = timerThreadId >>> 0;
        this.cachedWinmmTimerWakeEvent = wakeEvent >>> 0;
        if (timerThreadId === 0) {
            this.cachedWinmmModule = null;
        } else {
            this.cachedWinmmModule = (this.process?.getModule('winmm') as import('../../modules/winmm').WinMM | undefined) ?? null;
        }
    }

    /**
     * Cheap pre-guard before timer-thread dispatch. ~98% of historical calls were on
     * non-timer threads and only incremented notTimerThread after getModule().
     */
    private tryDispatchTimerThreadCallbacks(cpu: V86Cpu): boolean {
        this.timerDispatchStats.gateCalls++;
        const tid = this.cachedWinmmTimerThreadId;
        if (tid === 0) {
            this.timerDispatchStats.gateNoTimerThread++;
            return false;
        }
        if (this.currentThreadId !== tid) {
            this.timerDispatchStats.gateNotTimerThread++;
            return false;
        }
        return this.dispatchTimerThreadCallbacks(cpu);
    }

    /**
     * Dispatch a pending timer callback if the current thread is the WinMM timer thread.
     * Returns true if a callback was dispatched (CPU state modified).
     */
    private dispatchTimerThreadCallbacks(cpu: V86Cpu): boolean {
        const winmm = this.cachedWinmmModule;
        if (!winmm || winmm.timerThreadId === 0) return false;
        if (winmm.timerThreadId !== this.cachedWinmmTimerThreadId) {
            this.notifyWinmmTimerThread(winmm.timerThreadId, winmm.timerWakeEvent);
        }
        this.timerDispatchStats.calls++;

        const currentThread = this.getCurrentThread();
        if (!currentThread || currentThread.id !== this.cachedWinmmTimerThreadId) {
            this.timerDispatchStats.gateCacheMismatch++;
            return false;
        }

        // Dispatch ONLY on a RUNNING timer thread. The timer thread can still be
        // "current" at a boundary right after blockTimerThread parked it (WAITING), or
        // right after a same-boundary timer fire setEvent-woke it (READY — switch not
        // yet performed). Invoking a callback then writes the callback EIP into the
        // live CPU of a thread performSwitch will NOT re-save (only RUNNING current
        // threads are saved) — the next thread's restore overwrites it, the callback
        // never executes, and its slot leaks permanently. ~0.5% of dispatches under
        // load → 256 slots → "CallbackError: Pending callback slots exhausted".
        // Caught live via dbg.timers().trace:
        // invoke#N with NO cbReturn, then empty→block with inFlight incremented, with
        // asyncParkTimer=0 and pendRestore=0. Returning false is safe and lossless —
        // a READY timer thread is in the runQueue; performSwitch runs it and the
        // post-switch dispatch (5b/7b) re-enters here with the thread properly RUNNING.
        if (currentThread.state !== ThreadState.RUNNING) {
            this.timerDispatchStats.notRunning++;
            return false;
        }

        // Fairness guard: if other threads are runnable and this timer thread has
        // already consumed its budget, do not dispatch another timer callback on this
        // boundary. Let regular switch logic run first, otherwise repeated timer
        // callbacks can starve the game thread. The budget is WINMM_TIMER_QUANTUM_MS,
        // which is never below the general quantum, so the software audio mixer can
        // finish a tick's drain before yielding — deferring mid-drain fragments PCM
        // production into bursts and underruns the audio SAB (audible crackle).
        if (this.hasOtherRunnableThreads(currentThread.id)) {
            // Instruction-based budget (deterministic, platform-independent) — this gate steers
            // the T3-audio-timer vs game-thread interleaving, so a wall-clock (performance.now)
            // measure would fragment the interleaving differently per host speed. Mirror
            // quantumExpired: budget = WINMM_TIMER_QUANTUM_MS worth of retired instructions.
            const budgetInsns = (WINMM_TIMER_QUANTUM_MS * TARGET_INSN_PER_MS) >>> 0;
            const elapsedInsns = this.insnsSinceSwitch(currentThread, cpu);
            if (elapsedInsns >= budgetInsns) {
                Logger.verbose(
                    LogCategory.THREAD,
                    `dispatchTimerCallback: defer on T${currentThread.id} for fairness ` +
                    `(insns=${elapsedInsns}, budget=${budgetInsns})`
                );
                this.switchRequested = true;
                this.timerDispatchStats.deferred++;
                this.timerDispatchStats.deferStreak++;
                if (this.timerDispatchStats.deferStreak > this.timerDispatchStats.maxDeferStreak) {
                    this.timerDispatchStats.maxDeferStreak = this.timerDispatchStats.deferStreak;
                }
                return false;
            }
        }

        // Only dispatch when timer thread is at spin loop (not mid-callback).
        // Without this guard, tick boundaries fire timerWheel.poll() → onTimerFire
        // → dispatchTimerThreadCallbacks while a previous callback is still executing,
        // causing nested callbacks that defer the counter-incrementing epilogue.
        const eip = cpu.instruction_pointer[0] >>> 0;
        if (this.spinLoopBase > 0 && (eip < this.spinLoopBase || eip >= this.spinLoopEnd)) {
            this.timerDispatchStats.eipGuard++;
            return false;
        }

        const cbMgr = this.process!.dispatcher?.callbackManager;
        if (!cbMgr) return false;

        // SAFETY NET for the timer-callback pin: we are at the spin loop (eipGuard passed),
        // so no winmm callback is mid-execution. If the pin is still held yet nothing is
        // in flight, a previous unpin path was missed — force-clear it now so a stale pin
        // can never permanently defer switches (starvation). Self-heals within one cycle.
        if (this.timerCallbackPinActive && (cbMgr.getWinmmInFlight?.() ?? 0) === 0) {
            this.unpinTimerCallbackThread();
            this.timerDispatchStats.timerStalePinCleared++;
            Logger.warn(LogCategory.THREAD,
                `[winmm] stale timer-callback pin cleared (count=${this.timerDispatchStats.timerStalePinCleared})`);
        }

        // Non-blocking telemetry: the timer thread is at the spin loop while it still
        // holds an in-flight callback — the abandonment signature. We must NOT block
        // dispatch on this: the abandoned callback is NOT resumed by the async-restore
        // machinery (live data: no pending restore exists; the thread is RUNNING at the
        // spin loop with the slot still held). Blocking deadlocks the whole timer
        // subsystem — observed as startup freeze during a perf-calibration timer storm
        // (winmmInFlight stuck at 1, this counter climbing, only the cursor rendering).
        // The real bug is on the context-SAVE side: the timer thread must not be saved
        // with EIP=spinLoop while mid-callback (so it resumes mid-callback and RETs
        // through its return stub → releaseCallback). This counter measures how often
        // the abandonment signature occurs.
        if (cbMgr.hasInFlightCallbacksForThread(currentThread.id)) {
            this.timerDispatchStats.spinInFlight++;
        }

        // A pending async restore for this thread means it is parked MID-CALLBACK at the
        // spin loop (the async-park context saves EIP=spinLoop) and was woken to RESUME
        // the in-flight callback — not for new timer work. Do not dispatch a new callback
        // on top of the parked frame, and above all do not re-block on the wake event:
        // that strands the restore — every thread goes WAITING, virtual time freezes, the
        // next timer tick never fires, the wake event is never signaled again → permanent
        // boot deadlock (e.g. intro splash freeze, T1 blocked on a mixer CS that the
        // abandoned callback still owns). Reachable via the post-performSwitch dispatch
        // call sites (5b/7b), which run before the next boundary's onPollAsyncRestores.
        // Returning false lets that step-1 apply the restore at the very next boundary —
        // canApply is unconditionally true at the spin loop, so unlike a reverted in-flight
        // guard this defer is bounded and cannot deadlock the timer subsystem.
        if (this.process?.dispatcher?.hasPendingAsyncRestoreForThread?.(currentThread.id)) {
            this.timerDispatchStats.pendRestoreDeferred++;
            this.traceTimerThread(`dispatch deferred: pending async restore for T${currentThread.id}`);
            return false;
        }

        // Dispatch one pending callback
        const cb = winmm.shiftPendingCallback();
        if (!cb) {
            // No more work — re-block on wake event
            this.timerDispatchStats.empty++;
            const inFlight = cbMgr.getWinmmInFlight?.() ?? 0;
            if (inFlight > 0 || this.process?.dispatcher?.hasPendingAsyncRestoreForThread?.(currentThread.id)) {
                this.traceTimerThread(
                    `empty→block T${currentThread.id} eip=0x${eip.toString(16)} inFlight=${inFlight} ` +
                    `pendRestore=${this.process?.dispatcher?.hasPendingAsyncRestoreForThread?.(currentThread.id) ? 1 : 0}`);
            }
            this.blockTimerThread(currentThread.id, this.cachedWinmmTimerWakeEvent || winmm.timerWakeEvent);
            return false;
        }
        this.timerDispatchStats.invoked++;
        this.traceTimerThread(
            `invoke#${this.timerDispatchStats.invoked} cb=0x${cb.callbackAddr.toString(16)} ` +
            `esp=0x${(cpu.reg32[4] >>> 0).toString(16)} inFlight=${cbMgr.getWinmmInFlight?.() ?? 0}`);
        this.timerDispatchStats.deferStreak = 0;

        Logger.verbose(LogCategory.THREAD,
            `dispatchTimerCallback: T${currentThread.id} cb=0x${cb.callbackAddr.toString(16)} timerId=${cb.timerId} EIP=0x${(cpu.instruction_pointer[0] >>> 0).toString(16)} ESP=0x${(cpu.reg32[4] >>> 0).toString(16)}`);

        // Track the peak in-flight winmm_timer count (cheap). With the atomic-execution pin
        // the previous callback always returns before we dispatch here, so this stays ~0-1;
        // a climbing value is the signature of a residual abandonment leak.
        {
            const inFlightBefore = cbMgr.getWinmmInFlight?.() ?? 0;
            if (inFlightBefore > this.timerDispatchStats.maxInflightSeen) {
                this.timerDispatchStats.maxInflightSeen = inFlightBefore;
            }
        }

        // Pin the timer thread so the callback runs atomically: its internal SetEvent wakes
        // the waiter and requests a switch, but the pin defers that switch until the callback
        // RETs through its return stub (→ handleCallbackReturn → releaseCallback + unpin).
        // This removes the fragile mid-callback save/restore that leaked slots. Unpin on a
        // thrown invoke so a failed dispatch never leaks the pin.
        this.pinTimerCallbackThread();
        try {
            cbMgr.invokeCallback(
                cb.callbackAddr,
                cb.args || [cb.timerId, 0, cb.dwUser, 0, 0],
                0,                          // callerCleanup (stdcall timer callback cleans own args)
                undefined,                  // no completeThunk
                false,                      // not cdecl
                'winmm_timer',             // source
                undefined,                  // no frameId
                { forceSyntheticReturnEip: true }  // return to spin loop after callback
            );
        } catch (e) {
            this.unpinTimerCallbackThread();
            throw e;
        }
        return true;  // callback dispatched, let v86 execute it
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Critical Sections
    // ═══════════════════════════════════════════════════════════════════════

    enterCriticalSectionWithContext(
        lpCriticalSection: number,
        lockSemHandle: number,
        returnAddr: number, postReturnEsp: number,
        callerCtx: { ecx: number; edx: number; ebx: number; ebp: number; esi: number; edi: number; eflags: number }
    ): boolean {
        const thread = this.getCurrentThread();
        if (!thread) return false;

        // In our cooperative model, no other thread runs between JS statements.
        // Check if event is already signaled before blocking (avoids RUNNING→WAITING→READY→RUNNING dance).
        const decision = this.syncObjects.checkWait(
            [lockSemHandle], false, thread.id,
            (tid) => this.threads.get(tid) ?? null
        );
        if (decision.ready) {
            // Event already signaled — acquire CS directly, no state transitions needed
            this.syncObjects.consumeWait(decision, thread.id);
            Mem.writeUint32((lpCriticalSection + 4) >>> 0, 0);          // LockCount = 0 (locked)
            Mem.writeUint32((lpCriticalSection + 8) >>> 0, 1);          // RecursionCount = 1
            Mem.writeUint32((lpCriticalSection + 12) >>> 0, thread.id >>> 0); // OwningThread
            this.registerCriticalSectionOwner(lpCriticalSection, thread.id);
            return true;
        }

        // Event not signaled — block and wait
        if (!isValidGuestEip(returnAddr)) {
            Logger.error(LogCategory.THREAD,
                `enterCriticalSectionWithContext: invalid returnAddr=0x${returnAddr.toString(16)} T${thread.id}`);
            return false; // Caller (EnterCriticalSection) treats false as "use spin loop"
        }
        const context = createPostReturnContext(returnAddr, postReturnEsp, callerCtx, 0);
        this.blockThread(thread, WaitReason.CRITICAL_SECTION, [lockSemHandle], false, null, false, lpCriticalSection, context);

        if (!this.hasOtherRunnableThreads(thread.id)) {
            // No runnable peers (CS owner is sleeping) — yield to browser so
            // the sleep timer can fire, wake the owner, and release the CS.
            // Return false so EnterCriticalSection redirects EIP to spin loop
            // instead of resuming guest code while this thread is WAITING.
            this.requestYieldToHost(this.computeYieldMs(50), "enterCS");
            return false;
        }

        this.requestSwitch();
        return true;
    }

    waitOnAddress(cpu: V86Cpu, address: number): boolean {
        const thread = this.getCurrentThread();
        if (!thread) return false;

        const eip = cpu.instruction_pointer[0] >>> 0;
        if (!this.isValidEipForRestore(eip)) return false;
        const context = this.saveCurrentThreadContext(cpu);

        this.blockThread(thread, WaitReason.CRITICAL_SECTION, [], false, null, false, address, context);
        this.requestSwitch();
        return true;
    }

    enterSrwLockWithContext(
        lockPtr: number,
        wantExclusive: boolean,
        waitEvent: number,
        returnAddr: number, postReturnEsp: number,
        callerCtx: { ecx: number; edx: number; ebx: number; ebp: number; esi: number; edi: number; eflags: number }
    ): boolean {
        const thread = this.getCurrentThread();
        if (!thread) return false;

        if (grantSrwOnWake(lockPtr, thread.id, wantExclusive)) {
            return true;
        }

        const decision = this.syncObjects.checkWait(
            [waitEvent], false, thread.id,
            (tid) => this.threads.get(tid) ?? null
        );
        if (decision.ready) {
            this.syncObjects.consumeWait(decision, thread.id);
            if (grantSrwOnWake(lockPtr, thread.id, wantExclusive)) {
                return true;
            }
        }

        if (!isValidGuestEip(returnAddr)) {
            Logger.error(LogCategory.THREAD,
                `enterSrwLockWithContext: invalid returnAddr=0x${returnAddr.toString(16)} T${thread.id}`);
            return false;
        }

        const context = createPostReturnContext(returnAddr, postReturnEsp, callerCtx, 0);
        this.blockThread(
            thread, WaitReason.SRW_LOCK, [waitEvent], false, null, false, lockPtr, context, wantExclusive,
        );

        if (!this.hasOtherRunnableThreads(thread.id)) {
            this.requestYieldToHost(this.computeYieldMs(50), "enterSRW");
            return false;
        }

        this.requestSwitch();
        return true;
    }

    sleepConditionVariableSrwWithContext(
        cvEvent: number,
        lockPtr: number,
        sharedHeld: boolean,
        timeoutMs: number,
        returnAddr: number, postReturnEsp: number,
        callerCtx: { ecx: number; edx: number; ebx: number; ebp: number; esi: number; edi: number; eflags: number },
    ): number {
        const thread = this.getCurrentThread();
        if (!thread) return 0;

        const wantExclusive = !sharedHeld;
        const reacquire = (): boolean =>
            wantExclusive
                ? grantSrwOnWake(lockPtr, thread.id, true)
                : grantSrwOnWake(lockPtr, thread.id, false);

        const decision = this.syncObjects.checkWait(
            [cvEvent], false, thread.id,
            (tid) => this.threads.get(tid) ?? null,
        );
        if (decision.ready) {
            this.syncObjects.consumeWait(decision, thread.id);
            return reacquire() ? 1 : 0;
        }

        if (timeoutMs === 0) {
            return reacquire() ? 0 : 0;
        }

        if (!isValidGuestEip(returnAddr)) {
            Logger.error(LogCategory.THREAD,
                `sleepConditionVariableSrwWithContext: invalid returnAddr=0x${returnAddr.toString(16)} T${thread.id}`);
            return reacquire() ? 0 : 0;
        }

        const context = createPostReturnContext(returnAddr, postReturnEsp, callerCtx, 0);
        this.blockThread(
            thread, WaitReason.SINGLE_OBJECT, [cvEvent], false,
            timeoutMs === INFINITE ? null : timeoutMs,
            false, lockPtr, context, wantExclusive, true,
        );

        if (!this.hasOtherRunnableThreads(thread.id)) {
            // The thread is already parked (blockThread above) — the guest must NOT
            // keep executing past the wait, or the eventual wake would rewind it onto
            // a stack it has since overwritten. Always report the park; the timeout
            // wheel delivers the timed-out wake.
            this.requestYieldToHost(this.computeYieldMs(timeoutMs), "sleepCV");
            return WAIT_BLOCKED_NO_SWITCH;
        }

        this.requestSwitch();
        return WAIT_BLOCKED_NO_SWITCH;
    }

    /**
     * SleepConditionVariableCS: block on the CV event after the caller released the CS,
     * re-acquiring the CS on wake. Mirrors sleepConditionVariableSrwWithContext, but blocks
     * with reason=CRITICAL_SECTION so wakeThread's CS branch transfers ownership back to the
     * woken thread. Re-acquire uses the uncontended fast path — under the cooperative model
     * the CS is normally free at the wake instant. Returns 1 (TRUE) on signal, 0 on timeout;
     * WAIT_BLOCKED_NO_SWITCH when parked.
     */
    sleepConditionVariableCsWithContext(
        cvEvent: number,
        csPtr: number,
        timeoutMs: number,
        returnAddr: number, postReturnEsp: number,
        callerCtx: { ecx: number; edx: number; ebx: number; ebp: number; esi: number; edi: number; eflags: number },
    ): number {
        const thread = this.getCurrentThread();
        if (!thread) return 0;

        const reacquireCs = (): void => {
            Mem.writeUint32((csPtr + 4) >>> 0, 0);                 // LockCount = 0 (locked)
            Mem.writeUint32((csPtr + 8) >>> 0, 1);                 // RecursionCount = 1
            Mem.writeUint32((csPtr + 12) >>> 0, thread.id >>> 0);  // OwningThread
            this.registerCriticalSectionOwner(csPtr, thread.id);
        };

        const decision = this.syncObjects.checkWait(
            [cvEvent], false, thread.id,
            (tid) => this.threads.get(tid) ?? null,
        );
        if (decision.ready) {
            this.syncObjects.consumeWait(decision, thread.id);
            reacquireCs();
            return 1;
        }

        if (timeoutMs === 0) {
            reacquireCs();
            return 0;
        }

        if (!isValidGuestEip(returnAddr)) {
            Logger.error(LogCategory.THREAD,
                `sleepConditionVariableCsWithContext: invalid returnAddr=0x${returnAddr.toString(16)} T${thread.id}`);
            reacquireCs();
            return 0;
        }

        const context = createPostReturnContext(returnAddr, postReturnEsp, callerCtx, 0);
        // reason=SINGLE_OBJECT (registers on cvEvent); boolReturn + cvReacquireCs make
        // wakeThread re-take the CS and normalise the BOOL result on wake.
        this.blockThread(
            thread, WaitReason.SINGLE_OBJECT, [cvEvent], false,
            timeoutMs === INFINITE ? null : timeoutMs,
            false, csPtr, context, false, true, true,
        );

        if (!this.hasOtherRunnableThreads(thread.id)) {
            // Same park contract as the SRW variant: the thread is already blocked,
            // so the guest must not run past the wait.
            this.requestYieldToHost(this.computeYieldMs(timeoutMs), "sleepCVcs");
            return WAIT_BLOCKED_NO_SWITCH;
        }

        this.requestSwitch();
        return WAIT_BLOCKED_NO_SWITCH;
    }

    /**
     * Wake condition-variable waiters blocked on `cvEvent`. `all=false` wakes one
     * (WakeConditionVariable); `all=true` wakes every current waiter
     * (WakeAllConditionVariable) — a real broadcast the single auto-reset setEvent path
     * cannot do. Each woken thread re-acquires its associated SRW lock / CS via wakeThread's
     * reason-specific branch. The CV carries no persistent state, so the event is left
     * unsignaled (a wake with no waiter is correctly lost, per the CV contract).
     */
    wakeConditionVariable(cvEvent: number, all: boolean): number {
        const waiterIds = this.waitEngine.getHandleWaiters(cvEvent);
        let woken = 0;
        for (const tid of waiterIds) {
            const t = this.threads.get(tid);
            if (!t || t.state !== ThreadState.WAITING || !t.waitInfo) continue;
            if (!t.waitInfo.handles.includes(cvEvent)) continue;
            this.wakeThread(t, WAIT_OBJECT_0);
            woken++;
            if (!all) break;
        }
        this.syncObjects.resetEvent(cvEvent);
        return woken;
    }

    /** Ensure the shared timer-pump thread exists (created in a thunk context). */
    ensureTimerPumpThread(): void {
        const winmm = this.process?.getModule('winmm') as WinMM | undefined;
        winmm?.ensureCallbackPumpThread();
    }

    /**
     * Route a guest timer/thread-pool callback (WAITORTIMERCALLBACK / PTP_TIMER_CALLBACK)
     * onto the shared timer-pump thread so it runs as real guest code, decoupled from the
     * wheel-fire JS context. Reuses the WinMM timer thread + queue + dispatch machinery.
     */
    postTimerCallback(callbackAddr: number, args: number[]): void {
        if (!callbackAddr) return;
        const winmm = this.process?.getModule('winmm') as WinMM | undefined;
        winmm?.postGuestCallback(callbackAddr, args);
    }

    /** @deprecated Use setEvent on the CS LockSemaphore handle instead */
    wakeAddress(_address: number): boolean {
        // No-op — CS wake is now handled via LockSemaphore events.
        // Kept as stub for any leftover callers during transition.
        return false;
    }

    registerCriticalSectionOwner(address: number, ownerThreadId: number): void {
        this.criticalSectionOwners.set(address >>> 0, ownerThreadId >>> 0);
    }

    /** Track every CS that ever grew a LockSemaphore (i.e. ever had contention).
     *  Needed because the WASM EnterCriticalSection fast path acquires ownership by
     *  writing guest memory only — criticalSectionOwners doesn't see it. On thread
     *  termination we sweep these by reading the owner field from guest memory. */
    registerCsLockSemaphore(address: number, semHandle: number): void {
        this.csLockSemaphores.set(address >>> 0, semHandle >>> 0);
    }

    unregisterCsLockSemaphore(address: number): void {
        this.csLockSemaphores.delete(address >>> 0);
    }

    /** True if the thread exists and is not TERMINATED. Thread ids are never reused. */
    isThreadAlive(threadId: number): boolean {
        const t = this.threads.get(threadId);
        return t !== undefined && t.state !== ThreadState.TERMINATED;
    }

    getCriticalSectionOwner(address: number): number | null {
        const owner = this.criticalSectionOwners.get(address >>> 0);
        return owner === undefined ? null : (owner >>> 0);
    }

    clearCriticalSectionOwner(address: number, expectedOwnerThreadId?: number): boolean {
        const addr = address >>> 0;
        const existing = this.criticalSectionOwners.get(addr);
        if (existing === undefined) return expectedOwnerThreadId === undefined;
        if (expectedOwnerThreadId !== undefined && existing !== (expectedOwnerThreadId >>> 0)) return false;
        this.criticalSectionOwners.delete(addr);
        return true;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Sync Object Delegation
    // ═══════════════════════════════════════════════════════════════════════

    createEvent(manualReset: boolean, initialState: boolean): number {
        return this.syncObjects.createEvent(manualReset, initialState);
    }

    setEvent(handle: number): boolean {
        const ok = this.syncObjects.setEvent(handle);
        if (ok && this.waitEngine.getHandleWaiters(handle).length > 0) {
            this.wakeWaitingThreadsForHandle(handle);
        }
        return ok;
    }

    resetEvent(handle: number): boolean {
        return this.syncObjects.resetEvent(handle);
    }

    /** PulseEvent: signal, wake waiters while signaled, then reset — single JS orchestration. */
    pulseEvent(handle: number): boolean {
        const ok = this.syncObjects.setEvent(handle);
        if (!ok) return false;
        if (this.waitEngine.getHandleWaiters(handle).length > 0) {
            this.wakeWaitingThreadsForHandle(handle);
        }
        return this.syncObjects.resetEvent(handle);
    }

    /** Check if any threads are currently waiting on the given handle. */
    hasWaitersForHandle(handle: number): boolean {
        return this.waitEngine.getHandleWaiters(handle).length > 0;
    }

    createSemaphore(initialCount: number, maxCount: number): number {
        return this.syncObjects.createSemaphore(initialCount, maxCount);
    }

    releaseSemaphore(handle: number, releaseCount: number): { ok: boolean; previousCount: number } {
        const result = this.syncObjects.releaseSemaphore(handle, releaseCount);
        if (result.ok) this.wakeWaitingThreadsForHandle(handle);
        return result;
    }

    createMutex(initialOwner: boolean): number {
        const thread = this.getCurrentThread();
        return this.syncObjects.createMutex(initialOwner, thread?.id ?? 0);
    }

    releaseMutex(handle: number): boolean {
        const thread = this.getCurrentThread();
        if (!thread) return false;
        const ok = this.syncObjects.releaseMutex(handle, thread.id);
        if (ok) this.wakeWaitingThreadsForHandle(handle);
        return ok;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Thread Management
    // ═══════════════════════════════════════════════════════════════════════

    resumeThread(handle: number): number {
        const thread = this.getThreadByHandle(this.resolveHandle(handle));
        if (!thread) return 0xFFFFFFFF;

        const prev = thread.suspendCount;
        if (thread.suspendCount > 0) thread.suspendCount--;
        if (thread.suspendCount > 0) return prev;

        if (thread.state === ThreadState.SUSPENDED) {
            // SUSPENDED means "nothing left to wait for" — either it never waited, or its
            // wait was satisfied while suspended and wakeThread parked the result in EAX.
            this.setThreadState(thread, ThreadState.READY);
            if (!this.runQueue.includes(thread.id)) this.runQueue.push(thread.id);
        } else if (thread.state === ThreadState.WAITING && prev > 0) {
            // `prev > 0`: only a call that actually RELEASED the last suspend re-evaluates.
            // A stray Resume on a thread that was never suspended must stay free (engines that
            // spin Suspend/Resume issue millions of them).
            this.reevaluateWaitAfterResume(thread);
        }

        return prev;
    }

    /**
     * Last resume of a thread whose wait is still outstanding. While suspended it was skipped
     * by wakeWaitingThreadsForHandle, so a signal may have arrived and been taken by nobody;
     * re-evaluate now — NT re-enters the wait when the suspend APC returns, which re-reads the
     * object state. A wait with no object predicate (SLEEP/MESSAGE/ASYNC_THUNK) is left alone:
     * its own waker (timer wheel / message post / async-restore FIFO) still owns it, and those
     * wakes are delivered while suspended rather than skipped.
     */
    private reevaluateWaitAfterResume(thread: Thread): void {
        const info = thread.waitInfo;
        if (!info || info.handles.length === 0) return;
        if (info.reason === WaitReason.SLEEP || info.reason === WaitReason.MESSAGE) return;

        this.suspendWaitStats.reevalOnResume++;
        const decision = this.syncObjects.checkWait(
            info.handles, info.waitAll, thread.id, (tid) => this.threads.get(tid) ?? null);
        if (!decision.ready) return;
        this.suspendWaitStats.reevalSatisfied++;
        this.syncObjects.consumeWait(decision, thread.id);
        this.wakeThread(thread, decision.result);
    }

    /** Win32 SuspendThread: previous suspend count, or 0xFFFFFFFF on failure (last error set
     *  here, since the caller cannot tell an invalid handle from a refused signal). */
    suspendThread(handle: number): number {
        const thread = this.getThreadByHandle(this.resolveHandle(handle));
        if (!thread || thread.state === ThreadState.TERMINATED) {
            this.setLastError(ERROR_INVALID_HANDLE);
            return 0xFFFFFFFF;
        }

        const prev = thread.suspendCount;
        if (prev >= MAXIMUM_SUSPEND_COUNT) {
            this.suspendWaitStats.suspendRefused++;
            this.setLastError(ERROR_SIGNAL_REFUSED);
            return 0xFFFFFFFF;
        }
        thread.suspendCount++;

        if (thread.state === ThreadState.READY || thread.state === ThreadState.RUNNING) {
            this.setThreadState(thread, ThreadState.SUSPENDED);
            const idx = this.runQueue.indexOf(thread.id);
            if (idx >= 0) this.runQueue.splice(idx, 1);
        } else if (thread.state === ThreadState.WAITING &&
                   thread.waitInfo?.reason === WaitReason.ASYNC_THUNK) {
            this.suspendWaitStats.suspendOnAsyncPark++;
            // An async park is not a guest wait — it is resumed by the dispatcher's
            // pendingAsyncRestores FIFO, which retries until the thread is runnable and so
            // cannot lose a completion. Keep the historical flip; the FIFO's own guards
            // (isThreadAsyncParked, canApplyCurrentThreadRestore) are written against it.
            this.setThreadState(thread, ThreadState.SUSPENDED);
        } else if (thread.state === ThreadState.WAITING) {
            this.suspendWaitStats.suspendOnWaiting++;
        }
        // A real wait stays WAITING, with its waitInfo, its timeout timer and its WaitEngine
        // registration intact: suspension is a SEPARATE condition from the wait (NT carries it
        // on the suspend APC, and the object still satisfies the wait underneath). suspendCount
        // alone keeps the thread off the CPU — wakeThread parks a satisfied wait in SUSPENDED,
        // and resumeThread re-evaluates one that is still outstanding.

        return prev;
    }

    /**
     * Fast-path SuspendThread for the kernel32 FastPath dispatch tier. Some engines use
     * SuspendThread/ResumeThread of a worker thread as a spin-sync primitive (Tin3/Discworld
     * Noir: ~1.4M calls/s) — the cost is entirely in the generic slow-dispatch swarm, not in
     * this cheap state flip. Returns the previous suspend count, or NULL to signal "defer to
     * the slow path" for the cases the inline fast path must NOT handle: a self-suspend (the
     * current thread must context-switch away), a non-scheduler handle (manager-owned → slow
     * path tries the virtual process manager), or a terminated/unknown thread (slow path sets
     * last error). See registerFastPathProcessFunctions.
     */
    suspendThreadFast(handle: number): number | null {
        const thread = this.getThreadByHandle(this.resolveHandle(handle));
        if (!thread || thread.state === ThreadState.TERMINATED) return null;
        // A refusal at MAXIMUM_SUSPEND_COUNT is answered HERE, not deferred: suspendThread
        // sets the last error itself and setLastError syncs the hypercall page GetLastError
        // is served from, so nothing about the failure needs the slow path. Deferring it put
        // an engine that spins Suspend/Resume — which is exactly the engine that saturates the
        // count — permanently into the slow-dispatch swarm this fast path exists to avoid,
        // at ~1.4M calls/s (Discworld Noir, with a NORMAL log line each).
        // Self-suspend (the Tin3 handshake: thread suspends ITSELF to yield to the driver
        // thread) is handled here too: suspendThread() flips the current thread RUNNING→
        // SUSPENDED, and the FastPath's NON-deferred thunk boundary then runs performSwitch,
        // which detects the self-suspend (scheduler.ts self-suspend branch) and saves/switches
        // away exactly as the slow path would. EAX (prev count) is set by the dispatcher before
        // the boundary, so it's captured in the saved context. The SuspendThread FastPath MUST
        // be registered non-trivial so the boundary is not deferred (else a SUSPENDED thread
        // keeps running). Non-scheduler / terminated handles still fall through (null).
        return this.suspendThread(handle);
    }

    /** Fast-path ResumeThread companion to suspendThreadFast. NULL → defer to slow path
     *  (non-scheduler handle / terminated). Resuming another thread needs no context switch. */
    resumeThreadFast(handle: number): number | null {
        const thread = this.getThreadByHandle(this.resolveHandle(handle));
        if (!thread || thread.state === ThreadState.TERMINATED) return null;
        return this.resumeThread(handle);
    }

    setThreadPriority(handle: number, priority: number): boolean {
        const thread = this.getThreadByHandle(this.resolveHandle(handle));
        if (!thread || priority < -15 || priority > 15) return false;
        thread.priority = priority;
        return true;
    }

    getThreadPriority(handle: number): number | null {
        const thread = this.getThreadByHandle(this.resolveHandle(handle));
        if (!thread) return null;
        return thread.priority;
    }

    getThreadContext(handle: number): CpuContext | null {
        const thread = this.getThreadByHandle(this.resolveHandle(handle));
        if (!thread) return null;

        // If this is the currently running thread, read live CPU registers
        if (thread.state === ThreadState.RUNNING) {
            const cpu = this.getCpu();
            if (!cpu) return null;
            return saveCpuContext(cpu);
        }

        // Non-running threads have saved context
        return thread.context;
    }

    setThreadContext(handle: number, ctx: Partial<CpuContext>, flags: number): boolean {
        const thread = this.getThreadByHandle(this.resolveHandle(handle));
        if (!thread) return false;

        // Can only set context on suspended/waiting threads (not running)
        if (thread.state === ThreadState.RUNNING) return false;
        if (!thread.context) return false;

        const CONTEXT_INTEGER = 0x00010002;
        const CONTEXT_CONTROL = 0x00010001;

        if (flags & CONTEXT_INTEGER) {
            if (ctx.eax !== undefined) thread.context.eax = ctx.eax;
            if (ctx.ecx !== undefined) thread.context.ecx = ctx.ecx;
            if (ctx.edx !== undefined) thread.context.edx = ctx.edx;
            if (ctx.ebx !== undefined) thread.context.ebx = ctx.ebx;
            if (ctx.esi !== undefined) thread.context.esi = ctx.esi;
            if (ctx.edi !== undefined) thread.context.edi = ctx.edi;
        }
        if (flags & CONTEXT_CONTROL) {
            if (ctx.ebp !== undefined) thread.context.ebp = ctx.ebp;
            if (ctx.esp !== undefined) thread.context.esp = ctx.esp;
            if (ctx.eip !== undefined) thread.context.eip = ctx.eip;
            if (ctx.eflags !== undefined) thread.context.eflags = ctx.eflags;
        }

        return true;
    }

    getThreadInfoByHandle(handle: number): { state: ThreadState; exitCode: number | null } | null {
        const resolved = this.resolveHandle(handle);
        const thread = this.getThreadByHandle(resolved);
        if (thread) return { state: thread.state, exitCode: thread.exitCode };

        // Thread already reaped from scheduler — check kernel object for exit metadata
        const kobj = this.resourceProvider.getKernelObject(resolved) as KernelThreadObject | null;
        if (kobj && kobj.kind === 'thread' && kobj.terminated) {
            return { state: ThreadState.TERMINATED, exitCode: kobj.exitCode ?? 0 };
        }
        return null;
    }

    getAllThreadInfo(): Array<{ id: number; priority: number }> {
        const result: Array<{ id: number; priority: number }> = [];
        for (const t of this.threads.values()) {
            if (t.state !== ThreadState.TERMINATED) result.push({ id: t.id, priority: t.priority });
        }
        return result;
    }

    getThreadSummary(): { total: number; running: number; ready: number; waiting: number; suspended: number; terminated: number; created: number } {
        let running = 0, ready = 0, waiting = 0, suspended = 0, terminated = 0, created = 0;
        for (const t of this.threads.values()) {
            switch (t.state) {
                case ThreadState.CREATED: created++; break;
                case ThreadState.RUNNING: running++; break;
                case ThreadState.READY: ready++; break;
                case ThreadState.WAITING: waiting++; break;
                case ThreadState.SUSPENDED: suspended++; break;
                case ThreadState.TERMINATED: terminated++; break;
            }
        }
        return { total: this.threads.size, running, ready, waiting, suspended, terminated, created };
    }

    getThreadCount(): number {
        let count = 0;
        for (const t of this.threads.values()) {
            if (t.state !== ThreadState.TERMINATED) count++;
        }
        return count;
    }

    getCurrentThreadId(): number {
        const t = this.getCurrentThread();
        return t ? t.id : 1;
    }

    getCurrentThreadHandle(): number { return 0xFFFFFFFE; }

    getThreadStateById(threadId: number): { state: ThreadState; stateName: string } | null {
        const t = this.threads.get(threadId);
        if (!t) return null;
        return { state: t.state, stateName: THREAD_STATE_NAMES[t.state] };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TLS
    // ═══════════════════════════════════════════════════════════════════════

    tlsAlloc(): number {
        while (this.tlsSlots.has(this.nextTlsIndex)) {
            this.nextTlsIndex++;
            if (this.nextTlsIndex >= 64) {
                this.nextTlsIndex = 0;
                if (this.tlsSlots.size >= 64) return 0xFFFFFFFF;
            }
        }
        const index = this.nextTlsIndex;
        this.tlsSlots.add(index);
        this.nextTlsIndex = index + 1;
        return index;
    }

    tlsFree(index: number): boolean {
        if (!this.tlsSlots.has(index)) return false;
        this.tlsSlots.delete(index);
        for (const t of this.threads.values()) t.tlsValues.delete(index);
        return true;
    }

    tlsGetValue(index: number): number {
        const t = this.getCurrentThread();
        return t ? (t.tlsValues.get(index) ?? 0) : 0;
    }

    tlsSetValue(index: number, value: number): boolean {
        const t = this.getCurrentThread();
        if (!t || !this.tlsSlots.has(index)) return false;
        t.tlsValues.set(index, value >>> 0);
        this.tebManager.syncTlsSlot(t.id, index, value >>> 0);
        return true;
    }

    /**
     * Initialize implicit TLS data for a new thread.
     * Copies TLS template data for each PE module that uses __declspec(thread).
     */
    /** Give ONE thread its private copy of ONE module's TLS template. */
    private materializeTlsEntry(
        threadId: number,
        thread: Thread,
        entry: ImplicitTlsEntry,
        memory: Uint8Array,
        memManager: { alloc(size: number): number },
    ): void {
        const totalSize = entry.templateSize + entry.zeroFillSize;
        const tlsDataAddr = memManager.alloc(Math.max(totalSize, 16));

        // Copy template data
        if (entry.templateSize > 0 && entry.templateStart > 0) {
            memory.copyWithin(tlsDataAddr, entry.templateStart, entry.templateStart + entry.templateSize);
        }
        // Zero fill
        if (entry.zeroFillSize > 0) {
            memory.fill(0, tlsDataAddr + entry.templateSize, tlsDataAddr + totalSize);
        }

        // Store in thread's TLS values and sync to guest memory
        thread.tlsValues.set(entry.tlsIndex, tlsDataAddr >>> 0);
        this.tebManager.syncTlsSlot(threadId, entry.tlsIndex, tlsDataAddr >>> 0);

        Logger.log(LogCategory.THREAD,
            `  TLS slot ${entry.tlsIndex} (${entry.moduleName}): data=0x${tlsDataAddr.toString(16)} ` +
            `(${totalSize} bytes, template@0x${entry.templateStart.toString(16)}) for T${threadId}`);
    }

    /**
     * A module with static TLS just loaded — give every ALREADY-RUNNING thread its copy.
     *
     * Registering the entry only serves threads created later, and a DLL loaded through
     * LoadLibrary (every mod/plugin DLL) arrives when the threads that will run its code
     * already exist. Windows' loader allocates the block for all of them at load time; skip
     * it and `ThreadLocalStoragePointer[index]` stays NULL, so the module's first
     * `__declspec(thread)` access — which MSVC also emits for C++ magic statics, i.e. almost
     * immediately — dereferences a small offset off zero.
     */
    initImplicitTlsEntryForExistingThreads(entry: ImplicitTlsEntry): void {
        const memManager = System.getInstance().process?.memory;
        const memory = System.getInstance().process?.getCurrentMemory?.();
        if (!memManager || !memory) return;
        for (const [threadId, thread] of this.threads) {
            if (thread.tlsValues.has(entry.tlsIndex)) continue;
            this.materializeTlsEntry(threadId, thread, entry, memory, memManager);
        }
    }

    private initImplicitTlsForThread(threadId: number, thread: Thread, memory: Uint8Array): void {
        const system = System.getInstance();
        const entries = system.implicitTlsEntries;
        if (entries.length === 0) {
            Logger.warn(LogCategory.THREAD, `Thread ${threadId}: initImplicitTls — no entries`);
            return;
        }

        const memManager = system.process?.memory;
        if (!memManager) {
            Logger.warn(LogCategory.THREAD, `Thread ${threadId}: initImplicitTls — no memManager`);
            return;
        }

        const tebAddr = this.tebManager.getTebAddress(threadId);
        const tlsArrayAddr = this.tebManager.getTlsArrayAddress(threadId);
        Logger.log(LogCategory.THREAD,
            `Thread ${threadId}: initImplicitTls — ${entries.length} entries, ` +
            `TEB=0x${(tebAddr ?? 0).toString(16)}, TLS array=0x${(tlsArrayAddr ?? 0).toString(16)}`);

        for (const entry of entries) {
            this.materializeTlsEntry(threadId, thread, entry, memory, memManager);
        }

        // Verify: read back FS:[0x2C] equivalent (TEB+0x2C) and TLS slot values
        if (tebAddr && tebAddr > 0) {
            try {
                const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
                const storedTlsPtr = view.getUint32(tebAddr + 0x2C, true);
                Logger.log(LogCategory.THREAD,
                    `  Verify: TEB+0x2C (FS:[0x2C]) = 0x${storedTlsPtr.toString(16)} ` +
                    `(expected 0x${(tlsArrayAddr ?? 0).toString(16)})`);
                if (storedTlsPtr && storedTlsPtr > 0) {
                    for (const entry of entries) {
                        const slotVal = view.getUint32(storedTlsPtr + entry.tlsIndex * 4, true);
                        Logger.log(LogCategory.THREAD,
                            `  Verify: TLS[${entry.tlsIndex}] @ 0x${(storedTlsPtr + entry.tlsIndex * 4).toString(16)} = 0x${slotVal.toString(16)}`);
                    }
                }
            } catch (e) {
                Logger.warn(LogCategory.THREAD, `  Verify failed: ${e}`);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Error / Pin / APC
    // ═══════════════════════════════════════════════════════════════════════

    setLastError(code: number): void {
        const t = this.getCurrentThread();
        if (t) {
            t.lastError = code >>> 0;
            if (t.tebAddress > 0) this.tebManager.syncLastError(t.id, code >>> 0);
        }
        if (this.process) this.process.lastError = code >>> 0;
        // Keep the WASM hypercall page in sync: GetLastError is served from that
        // page (hpBase+OFF_HC_LAST_ERROR), which is otherwise only refreshed on a
        // context switch. A JS thunk that fails and then the guest immediately
        // calls GetLastError (no switch) would otherwise read a stale code.
        if (hypercallDataManager.isInitialized()) {
            hypercallDataManager.writeLastError(code >>> 0);
        }
    }

    getLastError(): number {
        const t = this.getCurrentThread();
        return t ? t.lastError >>> 0 : (this.process?.lastError ?? 0);
    }

    pinCurrentThread(): void {
        const t = this.getCurrentThread();
        if (t) t.kernelPinCount++;
    }

    unpinCurrentThread(): void {
        const t = this.getCurrentThread();
        if (t && t.kernelPinCount > 0) t.kernelPinCount--;
    }

    /** Release a pin taken by a specific thread. Callers that pin a thread and release the
     *  pin later MUST use this: the current thread at release time is not necessarily the
     *  one that was pinned (a pinned thread that blocks still switches away), and unpinning
     *  "current" then leaves the owner pinned for the rest of its life — permanently
     *  unpreemptible, which starves every peer. */
    unpinThread(threadId: number): void {
        const t = this.threads.get(threadId >>> 0);
        if (t && t.kernelPinCount > 0) t.kernelPinCount--;
    }

    /**
     * Pin the WinMM timer thread for the duration of ONE timer callback so it runs
     * atomically: an internal SetEvent (which wakes the waiter and requests a switch)
     * is DEFERRED until the callback RETs through its return stub and unpins — bringing
     * the timer callback into conformance with the "JS-invoked guest callbacks run
     * pinned" invariant (the same pin the suspended-frame path takes for Enum APIs / WndProc).
     * Without this the callback is preempted mid-flight at its SetEvent thunk and ~0.5%
     * of resumes land at the spin loop without releasing the slot → 256-slot exhaustion.
     * Idempotent single-token pin → exactly one kernelPinCount increment over its life,
     * so it composes additively with any nested suspended-frame/SEH pin.
     */
    pinTimerCallbackThread(): void {
        if (this.timerCallbackPinActive) return;
        const t = this.getCurrentThread();
        if (!t) return;
        this.timerCallbackPinActive = true;
        t.kernelPinCount++;
    }

    /** Release the timer-callback pin (idempotent). Resolves the timer thread by id so it
     *  is correct whether called from handleCallbackReturn (timer thread is current) or the
     *  dispatch-time safety net. */
    unpinTimerCallbackThread(): void {
        if (!this.timerCallbackPinActive) return;
        this.timerCallbackPinActive = false;
        const tid = this.getTimerThreadId();
        const t = tid ? this.threads.get(tid) : this.getCurrentThread();
        if (t && t.kernelPinCount > 0) t.kernelPinCount--;
    }

    queueUserApcByHandle(threadHandle: number, routine: number, arg0: number): boolean {
        const thread = this.getThreadByHandle(this.resolveHandle(threadHandle >>> 0));
        if (!thread || thread.state === ThreadState.TERMINATED || !routine) return false;
        thread.apcQueue.push({ routine: routine >>> 0, arg0: arg0 >>> 0, arg1: 0, arg2: 0, kind: ApcKind.USER32_QUEUE_USER_APC });
        return true;
    }

    queueNtApcByHandle(threadHandle: number, routine: number, arg0: number, arg1: number, arg2: number): number {
        const thread = this.getThreadByHandle(this.resolveHandle(threadHandle >>> 0));
        if (!thread || thread.state === ThreadState.TERMINATED) return 0xC0000008; // STATUS_INVALID_HANDLE
        if (!routine) return 0xC0000001; // STATUS_UNSUCCESSFUL
        thread.apcQueue.push({ routine: routine >>> 0, arg0: arg0 >>> 0, arg1: arg1 >>> 0, arg2: arg2 >>> 0, kind: ApcKind.NTDLL_NT_QUEUE_APC });
        return 0; // STATUS_SUCCESS
    }

    hasPendingApcForThread(threadId: number): boolean {
        const t = this.threads.get(threadId);
        return t ? t.apcQueue.length > 0 : false;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Async Completion (ThunkDispatcher interface)
    // ═══════════════════════════════════════════════════════════════════════

    wakeThreadForAsyncCompletion(threadId: number): boolean {
        const thread = this.threads.get(threadId);
        if (!thread) return false;
        if (thread.state !== ThreadState.WAITING) {
            return thread.state === ThreadState.READY || thread.state === ThreadState.RUNNING;
        }
        if (!thread.context) return false;

        this.traceTimerEvent(threadId,
            `asyncWake T${threadId} reason=${thread.waitInfo?.reason ?? -1} ` +
            `ctxEip=0x${(thread.context.eip >>> 0).toString(16)}`);
        this.traceAsyncRestore("onPollAsyncRestores", null,
            `wake T${threadId},state=${THREAD_STATE_NAMES[thread.state]},gen=${thread.asyncParkGeneration >>> 0},` +
            `savedEip=${hx(thread.context.eip)},savedEsp=${hx(thread.context.esp)}`);
        this.wakeThread(thread, 0);
        return true;
    }

    /**
     * Transition the current thread to WAITING because an async thunk parked
     * its EIP at `spinLoopAddress`. After this call the scheduler will not
     * pick the thread for execution; the paired `wakeThreadForAsyncCompletion`
     * (from `_onAsyncComplete` → `pendingAsyncRestores` drain) flips it back
     * to READY when the Promise resolves.
     *
     * Must be followed by `preemptionManager.requestImmediateExit()` so v86
     * leaves its current cycle loop instead of burning the quantum at JMP $.
     *
     * Returns false on guard failures (feature disabled, unexpected state,
     * etc.) so the caller can keep the legacy spin behaviour as a fallback.
     */
    /** Current winmm timer thread id (0 if none). Used by the timer-callback pin helpers. */
    private getTimerThreadId(): number {
        if (this.cachedWinmmTimerThreadId !== 0) return this.cachedWinmmTimerThreadId;
        const w = this.process?.getModule?.('winmm') as any;
        return (w?.timerThreadId ?? 0) >>> 0;
    }

    /** True when the thread is parked WAITING on an async thunk (markThreadAsyncParked).
     *  Such a thread is not executing — its live-CPU EIP is residue of the OUT that
     *  started the async (often inside a thunk/callback stub), not an active frame. */
    isThreadAsyncParked(threadId: number): boolean {
        const t = this.threads.get(threadId);
        return !!t && t.state === ThreadState.WAITING && t.waitInfo?.reason === WaitReason.ASYNC_THUNK;
    }

    markThreadAsyncParked(threadId: number, cpu: V86Cpu): boolean {
        if (!this.config.asyncHleWaitEnabled) return false;
        const thread = this.threads.get(threadId);
        if (!thread) return false;
        if (thread.state === ThreadState.SUSPENDED) {
            if (this.config.debugLogging) {
                Logger.log(LogCategory.THREAD, `markThreadAsyncParked: T${threadId} is SUSPENDED, skipping`);
            }
            return false;
        }
        if (thread.state === ThreadState.WAITING) {
            Logger.warn(LogCategory.THREAD,
                `markThreadAsyncParked: T${threadId} already WAITING (nested async park?) — skipping`);
            return false;
        }
        if (thread.state !== ThreadState.RUNNING) {
            Logger.error(LogCategory.THREAD,
                `markThreadAsyncParked: T${threadId} unexpected state ${THREAD_STATE_NAMES[thread.state]}`);
            return false;
        }

        // Diagnostic: the winmm timer thread should NEVER be async-parked (the storm callback
        // has no async thunk; the atomic-execution pin keeps it non-preemptible mid-callback).
        // A nonzero asyncParkTimer means a new async path appeared on the timer thread.
        if (threadId === this.getTimerThreadId()) {
            this.timerDispatchStats.asyncParkTimer++;
            this.traceTimerThread(
                `asyncPark T${threadId} eip=0x${(cpu.instruction_pointer[0] >>> 0).toString(16)} ` +
                `esp=0x${(cpu.reg32[4] >>> 0).toString(16)}`);
        }

        const waitInfo: WaitInfo = {
            reason: WaitReason.ASYNC_THUNK,
            handles: [],
            waitAll: false,
            timeoutTimerId: 0,
            alertable: false,
            csAddress: 0,
            srwWantExclusive: false,
        };
        const context = this.saveCurrentThreadContext(cpu, 'spin');
        // Override EIP/ESP to the "post-RET" state: when the thunk handler's
        // RET pops spinLoopAddress off the guest stack, execution will land
        // at spinLoopBase with ESP advanced by 4. Saving this state means a
        // later restoreContext puts the CPU exactly where RET would have.
        // Skip when EIP is ALREADY at the spin loop (retro-park from the tick-boundary
        // safety net) — the RET has executed and ESP is final; +4 would skew it.
        if (this.spinLoopBase > 0 && (cpu.instruction_pointer[0] >>> 0) !== this.spinLoopBase) {
            context.eip = this.spinLoopBase >>> 0;
            context.esp = (cpu.reg32[4] + 4) >>> 0;
        }

        const nextAsyncParkGeneration = (((thread.asyncParkGeneration >>> 0) + 1) >>> 0) || 1;
        const result = this.transitionTo(thread, ThreadState.WAITING, waitInfo, context);
        if (!result.success) {
            Logger.error(LogCategory.THREAD,
                `markThreadAsyncParked: transitionTo failed for T${threadId}: ${result.error ?? 'unknown'}`);
            return false;
        }
        thread.asyncParkGeneration = nextAsyncParkGeneration;
        this.traceAsyncRestore("parkThreadAsync", cpu,
            `parked T${threadId},gen=${nextAsyncParkGeneration},savedEip=${hx(context.eip)},savedEsp=${hx(context.esp)}`);
        // NOTE: intentionally no waitEngine.registerWait — async thunks are
        // woken by the pendingAsyncRestores FIFO, not by handle signals.
        return true;
    }

    /**
     * Same-thread fast path for async restore. `wakeThreadForAsyncCompletion`
     * flips WAITING → READY (adds to runQueue), but when the current thread
     * is also the target, we don't want to go through performSwitch because
     * CPU registers are already live and `applyAsyncRestoreCpuState` will
     * overwrite EIP/ESP/EAX immediately. This brings the thread to RUNNING
     * without a context restore, preserving the "RUNNING ⇔ context in CPU"
     * invariant.
     */
    /**
     * Wake the current thread from a pump park (spin-loop safety net parked it WAITING
     * while its suspended-thunk frame idled) so a callback can be dispatched onto its
     * live registers. WAITING(ASYNC_THUNK) → READY → RUNNING with no context restore —
     * the caller (invokeCallback / direct-restore) overwrites EIP/ESP immediately after.
     * Also resumes an in-flight idle yield so v86 restarts within a microtask.
     */
    wakeCurrentThreadForCallbackDispatch(): boolean {
        const thread = this.getCurrentThread();
        if (!thread) return false;
        if (thread.state === ThreadState.RUNNING) return true;
        if (thread.state !== ThreadState.WAITING || thread.waitInfo?.reason !== WaitReason.ASYNC_THUNK) {
            return false;
        }
        const toReady = this.transitionTo(thread, ThreadState.READY, null, thread.context);
        if (!toReady.success) return false;
        const toRunning = this.transitionTo(thread, ThreadState.RUNNING, null, null);
        if (!toRunning.success) return false;
        this.traceAsyncRestore("wakeCurrentThreadForCallbackDispatch", null,
            `woke T${thread.id} for pump callback dispatch`);
        this.wakeEarlyFromIdleYield();
        return true;
    }

    markThreadRunningAfterAsyncWake(threadId: number): boolean {
        const thread = this.threads.get(threadId);
        if (!thread) return false;
        if (thread.state !== ThreadState.READY) return false;
        if (this.currentThreadId !== thread.id) return false;
        const result = this.transitionTo(thread, ThreadState.RUNNING, null, null);
        return result.success;
    }

    applyAsyncRestoreCpuState(
        cpu: V86Cpu,
        eip: number,
        esp: number,
        eax: number,
        source: string,
        target?: {
            threadId: number;
            asyncParkGeneration: number;
            completionName?: string;
            functionId?: number;
            cleanupBytes?: number;
        },
    ): boolean {
        if (target) {
            const valid = this.validateAsyncRestoreTarget({
                threadId: target.threadId,
                asyncParkGeneration: target.asyncParkGeneration,
                returnAddr: eip,
                newEsp: esp,
                source,
                completionName: target.completionName,
                functionId: target.functionId,
                cleanupBytes: target.cleanupBytes,
            });
            if (!valid.ok) {
                this.rejectAsyncRestore(
                    target.threadId,
                    valid.reason ?? 'invalid-async-restore',
                    source,
                    cpu,
                    `name=${target.completionName ?? '?'},fn=${hx(target.functionId)},ret=${hx(eip)},newEsp=${hx(esp)},cleanup=${target.cleanupBytes ?? 0}`,
                );
                return false;
            }
        }

        this.traceAsyncRestore(source, cpu,
            `apply eip=${hx(eip)},esp=${hx(esp)},eax=${hx(eax)},target=T${target?.threadId ?? this.currentThreadId ?? 0}/g${target?.asyncParkGeneration ?? 0}`);
        cpu.reg32[0] = eax >>> 0;
        cpu.reg32[4] = esp >>> 0;
        if (cpu.is_jumping !== undefined) cpu.is_jumping = true;
        cpu.instruction_pointer[0] = eip >>> 0;
        if (target) this.consumeAsyncParkGeneration(target.threadId, target.asyncParkGeneration, source, cpu);
        return true;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Thread Exit Stub
    // ═══════════════════════════════════════════════════════════════════════

    isThreadExitId(functionId: number): boolean {
        return functionId === this.threadExitFunctionId;
    }

    handleThreadExitStub(cpu: V86Cpu, mem: Uint8Array): void {
        const thread = this.getCurrentThread();
        if (!thread || thread.state === ThreadState.TERMINATED) return;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const esp = cpu.reg32[4] >>> 0;
        if (esp + 4 > mem.length) return;

        const exitCode = view.getUint32(esp, true);
        Logger.log(LogCategory.THREAD, `Thread ${thread.id} returned via exitStub, exitCode=0x${exitCode.toString(16)}`);
        this.terminateThread(thread.id, exitCode);
        this.requestSwitch();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Request / Yield / Diagnostics
    // ═══════════════════════════════════════════════════════════════════════

    enterCriticalRuntime(section: CriticalRuntimeSection, ownerThreadId: number, generation: number): boolean {
        const owner = ownerThreadId >>> 0;
        const gen = generation >>> 0;
        if (owner === 0) return false;

        const active = this.activeCriticalRuntime;
        if (active) {
            if (active.section === section && active.ownerThreadId === owner && active.generation === gen) {
                return true;
            }
            this.sehUnbalancedExitCount++;
            Logger.error(LogCategory.THREAD,
                `SEH_RUNTIME_LEAK_DETECTED: replacing active runtime section=${active.section} ` +
                `owner=T${active.ownerThreadId} gen=${active.generation}`);
        }

        this.activeCriticalRuntime = { section, ownerThreadId: owner, generation: gen };
        Logger.log(LogCategory.THREAD, `SEH_RUNTIME_ENTER: section=${section} owner=T${owner} gen=${gen}`);
        return true;
    }

    exitCriticalRuntime(section: CriticalRuntimeSection, ownerThreadId: number, generation: number, reason: string): boolean {
        const active = this.activeCriticalRuntime;
        const owner = ownerThreadId >>> 0;
        const gen = generation >>> 0;
        if (!active) return false;

        if (active.section !== section || active.ownerThreadId !== owner || active.generation !== gen) {
            this.sehUnbalancedExitCount++;
            Logger.error(LogCategory.THREAD,
                `SEH_RUNTIME_LEAK_DETECTED: unbalanced exit section=${section} owner=T${owner} gen=${gen} ` +
                `(active section=${active.section} owner=T${active.ownerThreadId} gen=${active.generation})`);
            this.activeCriticalRuntime = null;
            return false;
        }

        this.activeCriticalRuntime = null;
        Logger.log(LogCategory.THREAD,
            `SEH_RUNTIME_EXIT: section=${section} owner=T${owner} gen=${gen} reason=${reason}`);
        return true;
    }

    registerTransientExecRange(kind: TransientExecRangeKind, base: number, end: number): void {
        const lo = base >>> 0;
        const hi = end >>> 0;
        if (hi <= lo) return;
        this.transientExecRanges.set(kind, { base: lo, end: hi });
    }

    unregisterTransientExecRange(kind: TransientExecRangeKind): void {
        this.transientExecRanges.delete(kind);
    }

    /**
     * Register a THUNK_CODE region as a non-preemptible critical section. While a guest
     * thread's EIP is inside, preemptAtTickBoundary defers the thread switch (see field
     * doc). Used for the inline heap/CRT slab stubs whose free-list pop/push/bump are
     * multi-instruction non-atomic RMWs on shared slab state. Idempotent.
     */
    registerNonPreemptibleRange(base: number, end: number): void {
        const lo = base >>> 0, hi = end >>> 0;
        if (hi <= lo) return;
        if (this.nonPreemptibleRanges.some(r => r.base === lo && r.end === hi)) return;
        this.nonPreemptibleRanges.push({ base: lo, end: hi });
        Logger.log(LogCategory.THREAD,
            `Registered non-preemptible range [0x${lo.toString(16)}, 0x${hi.toString(16)})`);
    }

    /** True iff eip is inside a registered non-preemptible stub region. */
    private isEipNonPreemptible(eip: number): boolean {
        for (let i = 0; i < this.nonPreemptibleRanges.length; i++) {
            const r = this.nonPreemptibleRanges[i];
            if (eip >= r.base && eip < r.end) return true;
        }
        return false;
    }

    /** Diagnostic: how many preemptions have been deferred for slab-stub atomicity. */
    getNonPreemptibleDeferCount(): number { return this.nonPreemptibleDeferCount; }

    getCriticalRuntimeSnapshot(): {
        active: boolean;
        section: CriticalRuntimeSection | null;
        ownerThreadId: number;
        generation: number;
        deferredSwitchCount: number;
        deniedRestoreCount: number;
        unbalancedExitCount: number;
    } {
        const rt = this.activeCriticalRuntime;
        return {
            active: !!rt,
            section: rt?.section ?? null,
            ownerThreadId: rt?.ownerThreadId ?? 0,
            generation: rt?.generation ?? 0,
            deferredSwitchCount: this.sehDeferredSwitchCount,
            deniedRestoreCount: this.sehDeniedRestoreCount,
            unbalancedExitCount: this.sehUnbalancedExitCount,
        };
    }

    requestSwitch(): void { this.switchRequested = true; }

    requestSwitchToThread(threadId: number): void {
        // Simple: just request a switch. Round-robin will get there.
        this.switchRequested = true;
    }

    requestYieldToHost(ms: number = 1, source: string = "req"): void {
        if (ms > this.yieldToHostMs) this.pendingYieldSource = source;
        this.yieldToHostMs = Math.max(this.yieldToHostMs, ms);
    }

    pollTimeouts(): void {
        // When every thread is blocked, v86 is stopped, so updateTimeData() never advances
        // instruction-based virtual time. Timer deadlines (Sleep / WaitFor) live in virtual
        // time, so a frozen clock means they NEVER come due and the game hangs (e.g. a thread
        // sleeps while holding a CS another is blocked on). Advance virtual time by real
        // wall-clock elapsed — but only while genuinely idle (shouldPumpIdleVirtualTime),
        // since while v86 runs updateTimeData() owns the clock and wall-clock dt would make
        // games accelerate.
        let pumpedIdle = false;
        if (this.timeService.isVirtualTimeActive() && this.shouldPumpIdleVirtualTime()) {
            pumpedIdle = true;
            const wallNow = performance.now();
            if (this.idleAnchorWallMs === 0) {
                this.idleAnchorWallMs = wallNow;
            } else {
                // Clamp per pump: a real idle advances ~1ms/pump (this runs every ~1ms) and
                // never clamps. The clamp only bites when the anchor went stale across a gap
                // where this poll stopped — tab paused (the `isPaused` early-return skips
                // this) or backgrounded (setInterval throttled). Without it, the first pump
                // after such a gap would leap virtual time by the whole gap, defeating
                // notifyPauseResume()'s re-anchor; the deficit instead drains over a few pumps.
                const elapsed = Math.min(wallNow - this.idleAnchorWallMs, IDLE_PUMP_MAX_MS);
                if (elapsed > 0) {
                    this.timeService.advanceVirtualTime(elapsed);
                    frameVarianceDiagnostics.recordIdleTime('hlt', elapsed);
                }
                // Re-anchor unconditionally so a stale anchor can't accumulate a later jump.
                this.idleAnchorWallMs = wallNow;
            }
        } else {
            this.idleAnchorWallMs = 0;
        }

        const now = this.timeService.nowMs();
        // Telemetry: count WINMM timers fired by a wall-paced idle pump.
        const winmmFiredBefore = this.timerWheel.firedByKind[TimerKind.WINMM_TIMER];
        this.timerWheel.poll(now);
        if (pumpedIdle) {
            this.idlePumpStats.pumps++;
            this.idlePumpStats.winmmFires += this.timerWheel.firedByKind[TimerKind.WINMM_TIMER] - winmmFiredBefore;
            this.idlePumpStats.lastNextFireInMs = this.timerWheel.nextFireIn(now);
        }
    }

    /**
     * True when no thread can make progress on its own (nothing READY/RUNNING) yet at
     * least one non-async waiter has a pending timeout that a clock advance would fire.
     * Gates idle virtual-time pumping in pollTimeouts() — see there for the rationale.
     */
    private shouldPumpIdleVirtualTime(): boolean {
        // Pending async restores will be woken by their JS promises; their wait path
        // advances time itself and runs every frame. Don't credit wall-clock dt here.
        if (this.onHasPendingAsyncRestores?.()) return false;
        let needsIdlePump = false;
        let anyNonAsyncWaiter = false;
        for (const t of this.threads.values()) {
            if (t.state === ThreadState.READY || t.state === ThreadState.RUNNING) return false;
            if (t.state === ThreadState.WAITING && t.waitInfo) {
                if (t.waitInfo.reason === WaitReason.ASYNC_THUNK) continue;
                anyNonAsyncWaiter = true;
                // MESSAGE waits have no per-wait timeout, but USER32 SetTimer callbacks
                // are driven by virtual time — pump while blocked in WaitMessage/GetMessage
                // idle so WM_TIMER can post and wake the waiter (GOG video player, modals).
                if (t.waitInfo.timeoutTimerId || t.waitInfo.reason === WaitReason.MESSAGE) {
                    needsIdlePump = true;
                }
            }
        }
        // Reaching here means every thread is blocked (we never returned early on a
        // READY/RUNNING thread). If the timer wheel still holds active entries, those
        // periodic pumps — winmm waveOut completion, dsound IDirectSoundNotify, MSS
        // mixer/heartbeat — are the ONLY source of forward progress: they SetEvent the
        // very objects these threads wait on (INFINITE, no timeoutTimerId, so the clauses
        // above miss them). They used to run on a host setInterval (real wall-clock) and
        // fired regardless of guest virtual time; now they live on the virtual-time wheel,
        // so a fully-idle guest freezes virtual time → the wheel never advances → the
        // completion event never fires → permanent deadlock. detectDeadlock() trusts
        // activeCount>0 to break it, so the hang would be silent. Pump wall-clock virtual
        // time so the wheel fires at native cadence — faithful, since these pumps are
        // wall-clock-paced on real Windows.
        if (anyNonAsyncWaiter && this.timerWheel.activeCount > 0) {
            needsIdlePump = true;
        }
        return needsIdlePump;
    }

    getSwitchIntentSnapshot(): { active: boolean; targetThreadId: number | null; ageMs: number; deferrals: number; lastBlockReason: string } {
        const rt = this.activeCriticalRuntime;
        const reason = rt ? `critical:${rt.section}` : 'none';
        return {
            active: this.switchRequested,
            targetThreadId: rt?.ownerThreadId ?? null,
            ageMs: 0,
            deferrals: this.sehDeferredSwitchCount,
            lastBlockReason: reason,
        };
    }
    reportFatalGuard(code: number, arg: number = 0, threadId: number = 0): void {
        Logger.error(LogCategory.THREAD, `FATAL GUARD: code=0x${code.toString(16)} arg=0x${arg.toString(16)} thread=${threadId}`);
        const sys = System.getInstance();
        const cpu = this.getCpu();
        const eip = (cpu?.instruction_pointer?.[0] ?? arg) >>> 0;
        this.dumpSchedulerAsyncState(`fatalGuard:0x${code.toString(16)}`, cpu, undefined,
            `code=${hx(code)},arg=${hx(arg)},thread=T${threadId}`, 'error');
        sys.reportGuestCrash({
            reason: `Scheduler fatal guard 0x${code.toString(16)}`,
            eip,
            threadId: threadId || this.currentThreadId,
            fault: {
                faultAddr: arg >>> 0,
                errorCode: code >>> 0,
            },
        });
    }
    reportCallbackReturnFatal(returnAddr: number, threadId: number): void {
        this.reportFatalGuard(0x3002, returnAddr, threadId);
    }
    reportCallbackFrameFatal(callbackId: number, threadId: number): void {
        this.reportFatalGuard(0x3003, callbackId, threadId);
    }
    /** True if any NON-RUNNING thread's saved EIP falls inside [lo, hi).
     *  Used by the thunk dispatcher's WBUF drain: a thread preempted MID-TRAMPOLINE
     *  (ring entry written, head not yet bumped) holds a stale head in a register —
     *  resetting the guest head under it would orphan its entry (lost SetTexture/
     *  SetRenderState → one-frame surface flicker) and desync the ring. The RUNNING
     *  thread is excluded: it is at an OUT trap and its stored context may be stale. */
    hasParkedThreadInRange(lo: number, hi: number): boolean {
        for (const t of this.threads.values()) {
            if (t.state === ThreadState.RUNNING || t.state === ThreadState.TERMINATED) continue;
            const eip = t.context ? (t.context.eip >>> 0) : 0;
            if (eip >= lo && eip < hi) return true;
        }
        return false;
    }

    /** Stack bounds [base, top) for a thread, or null if unknown. Used by the thunk
     *  dispatcher's ESP-sanity tripwire (cached per thread switch, not hot-path). */
    getThreadStackBounds(threadId: number): { base: number; top: number } | null {
        const t = this.threads.get(threadId);
        if (!t || !(t.stackTop > t.stackBase)) return null;
        return { base: t.stackBase >>> 0, top: t.stackTop >>> 0 };
    }

    /** The thread-stack reservation containing `addr`, or null. VirtualQuery needs this:
     *  Win32 reports a stack as ONE region whose AllocationBase is the reservation base,
     *  and stack-bounds helpers (Delphi's, a scanning GC's, a guard-page grower's) derive
     *  their bounds from exactly those two fields. Called from a query storm, so it stays a
     *  plain scan over the (small) thread map. */
    findStackReservation(addr: number): { base: number; top: number } | null {
        const a = addr >>> 0;
        for (const t of this.threads.values()) {
            const base = t.stackBase >>> 0;
            const top = t.stackTop >>> 0;
            if (top > base && a >= base && a < top) return { base, top };
        }
        return null;
    }

    getDetailedThreadInfo(): string {
        return formatDetailedThreadInfo(
            this.threads, this.currentThreadId, this.runQueue, this.process?.getCurrentMemory());
    }

    traceAsyncRestore(source: string, cpu?: V86Cpu | null, detail: string = ''): void {
        const current = this.getCurrentThread();
        const live = cpu
            ? `liveEip=${hx(cpu.instruction_pointer[0])},liveEsp=${hx(cpu.reg32[4])}`
            : 'live=?';
        const entry = `t=${Math.round(performance.now())} source=${source} ${live} ${formatThreadSnapshot(current)} ${detail}`.trim();
        this.asyncRestoreTrace.push(entry);
        if (this.asyncRestoreTrace.length > 128) this.asyncRestoreTrace.splice(0, 64);
        Logger.verbose(LogCategory.THREAD, `[ASYNC-SCHED] ${entry}`);
    }

    getAsyncRestoreTrace(): string[] {
        return this.asyncRestoreTrace.slice();
    }

    private dumpSchedulerAsyncState(source: string, cpu: V86Cpu | null, kind?: ThunkBoundaryKind, detail: string = '', level: 'warn' | 'error' = 'error'): void {
        const current = this.getCurrentThread();
        const live = cpu
            ? `liveEip=${hx(cpu.instruction_pointer[0])},liveEsp=${hx(cpu.reg32[4])}`
            : 'live=?';
        const message =
            `[ASYNC-SCHED-DUMP] source=${source},boundary=${boundaryKindName(kind)},${live},` +
            `${formatThreadSnapshot(current)},detail=${detail},pending=${formatPendingAsyncRestoreQueue(this.process?.dispatcher)},` +
            `threads=${this.getDetailedThreadInfo()},traceTail=${this.asyncRestoreTrace.slice(-8).join(' || ')}`;
        if (level === 'warn') Logger.warn(LogCategory.THREAD, message);
        else Logger.error(LogCategory.THREAD, message);
    }

    getAsyncParkGeneration(threadId: number): number {
        return (this.threads.get(threadId)?.asyncParkGeneration ?? 0) >>> 0;
    }

    private consumeAsyncParkGeneration(threadId: number, generation: number, source: string, cpu?: V86Cpu | null): void {
        const thread = this.threads.get(threadId >>> 0);
        if (!thread) return;
        const expected = generation >>> 0;
        if ((thread.asyncParkGeneration >>> 0) !== expected) return;
        thread.asyncParkGeneration = (((expected + 1) >>> 0) || 1) >>> 0;
        this.traceAsyncRestore(source, cpu ?? null,
            `consume T${threadId}/g${expected}->g${thread.asyncParkGeneration >>> 0}`);
    }

    isMainThread(threadId: number): boolean {
        return threadId === this.mainThreadId || (this.mainThreadId === 0 && threadId === 1);
    }

    validateAsyncRestoreTarget(args: {
        threadId: number;
        asyncParkGeneration: number;
        returnAddr: number;
        newEsp: number;
        source: string;
        completionName?: string;
        functionId?: number;
        cleanupBytes?: number;
    }): { ok: boolean; reason?: string } {
        const thread = this.threads.get(args.threadId >>> 0);
        if (!thread) return { ok: false, reason: `missing-thread T${args.threadId}` };
        if (thread.state === ThreadState.TERMINATED) return { ok: false, reason: `terminated-thread T${thread.id}` };

        const expectedGen = args.asyncParkGeneration >>> 0;
        const actualGen = thread.asyncParkGeneration >>> 0;
        if (expectedGen !== actualGen) {
            return { ok: false, reason: `stale-generation expected=${expectedGen} actual=${actualGen} T${thread.id}` };
        }

        const returnAddr = args.returnAddr >>> 0;
        if (!this.isValidEipForRestore(returnAddr)) {
            return { ok: false, reason: `invalid-returnAddr ${hx(returnAddr)} T${thread.id}` };
        }

        const newEsp = args.newEsp >>> 0;
        if ((newEsp & 3) !== 0) {
            return { ok: false, reason: `unaligned-newEsp ${hx(newEsp)} T${thread.id}` };
        }

        // ESP need not stay inside the thread's *registered* stack: guests run on
        // alternate stacks (fibers, VM/coroutine stacks, the Watcom runtime stack)
        // carved from their own heap and switch ESP to them. Validate against
        // committed writable memory instead — a real wild ESP (Re-Volt 0x3f6418f8)
        // lands in unmapped/RO memory and is still rejected.
        if (!this.isEspInWritableMemory(newEsp)) {
            const lo = thread.stackBase >>> 0;
            const hi = thread.stackTop >>> 0;
            return {
                ok: false,
                reason: `newEsp-not-writable ${hx(newEsp)} stack=[${hx(lo)},${hx(hi)}) T${thread.id}`,
            };
        }

        return { ok: true };
    }

    // A plausible stack pointer points into committed writable guest memory. The
    // registered thread stack is only a sub-range of that (guests switch stacks).
    // No address space (very early boot) → don't block.
    private isEspInWritableMemory(esp: number): boolean {
        const as = this.process?.addressSpace;
        if (!as) return true;
        return as.validateRange(esp >>> 0, 4, "rw");
    }

    rejectAsyncRestore(threadId: number, reason: string, source: string, cpu?: V86Cpu | null, detail: string = ''): void {
        const thread = this.threads.get(threadId >>> 0) ?? null;
        this.traceAsyncRestore(source, cpu ?? null, `reject T${threadId} reason=${reason} ${detail}`);
        this.dumpSchedulerAsyncState(source, cpu ?? null, undefined, `reject T${threadId}: ${reason} ${detail}`, 'error');

        if (!thread) return;
        if (reason.startsWith('stale-generation') || reason.startsWith('terminated-thread')) return;
        if (thread.waitInfo?.reason !== WaitReason.ASYNC_THUNK && thread.state !== ThreadState.RUNNING) return;

        if (this.isMainThread(thread.id)) {
            this.reportFatalGuard(0x4101, thread.id, thread.id);
            return;
        }

        Logger.error(LogCategory.THREAD,
            `ASYNC_RESTORE_REJECT: terminating worker T${thread.id} after invalid async restore (${reason})`);
        this.terminateThread(thread.id, 0xC0000005);
        if (this.currentThreadId === thread.id) this.requestSwitch();
    }

    getApcTelemetry(): { pendingApcTotal: number; pendingApcByCurrent: number; apcDispatchOnResume: number; pendingApcTargetThreadId: number } {
        const cur = this.getCurrentThread();
        return {
            pendingApcTotal: 0,
            pendingApcByCurrent: cur ? cur.apcQueue.length : 0,
            apcDispatchOnResume: 0,
            pendingApcTargetThreadId: 0,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Internal Helpers
    // ═══════════════════════════════════════════════════════════════════════

    getCurrentThread(): Thread | null {
        if (this.currentThreadId === null) return null;
        return this.threads.get(this.currentThreadId) ?? null;
    }

    /** Read-only wait diagnosis for the freeze watchdog — see scheduler-diagnostics.ts. */
    diagnoseWaiters(): Array<{ id: number; reason: string; handles: string[]; satisfiable: boolean; result: number }> {
        return diagnoseWaitersDiag(this.threads, this.syncObjects);
    }

    private blockThread(
        thread: Thread, reason: WaitReason, handles: number[],
        waitAll: boolean, timeoutMs: number | null,
        alertable: boolean, csAddress: number, context: CpuContext,
        srwWantExclusive = false,
        boolReturn = false,
        cvReacquireCs = false,
    ): void {
        // Create timeout timer if needed
        let timerId = 0;
        if (timeoutMs !== null) {
            const tid = thread.id;
            timerId = this.timerWheel.add(timeoutMs, false, TimerKind.SLEEP_TIMEOUT, () => {
                const t = this.threads.get(tid);
                if (t && t.state === ThreadState.WAITING) {
                    const wakeResult = t.waitInfo?.reason === WaitReason.SLEEP ? 0 : WAIT_TIMEOUT;
                    this.wakeThread(t, wakeResult);
                }
            }, this.timeService.nowMs());
        }

        const waitInfo: WaitInfo = {
            reason, handles, waitAll,
            timeoutTimerId: timerId,
            alertable, csAddress,
            srwWantExclusive,
            boolReturn: boolReturn || undefined,
            cvReacquireCs: cvReacquireCs || undefined,
        };

        this.transitionTo(thread, ThreadState.WAITING, waitInfo, context);
        this.waitEngine.registerWait(thread);

        // ── Lost-wakeup guard (auto-reset event SetEvent/Wait race) ─────────────────
        // The caller pre-checked the wait (checkWait) and found it not ready, THEN we
        // registered. In the window between those two steps EVT_HAS_WAITERS was not yet
        // set, so a SetEvent arriving there is handled entirely in WASM (hypercall.rs
        // handle_set_event latches EVT_SIGNALED and returns true — no JS fall-through,
        // hence no wake). Now that registerWait has set EVT_HAS_WAITERS (so every FUTURE
        // SetEvent falls through to JS), re-evaluate ONCE: checkWait reads the live WASM
        // mirror (_getEventState → readEventMirrorState), so it sees that latched signal.
        // If satisfied, consume + wake instead of blocking forever on an already-signalled
        // object. Same primitives as wakeWaitingThreadsForHandle, so consume/CS-ownership
        // semantics are identical. SLEEP/MESSAGE waits carry no handles → skipped.
        if (handles.length > 0 &&
            reason !== WaitReason.SLEEP && reason !== WaitReason.MESSAGE) {
            const recheck = this.syncObjects.checkWait(
                handles, waitAll, thread.id, (tid) => this.threads.get(tid) ?? null);
            if (recheck.ready) {
                this.syncObjects.consumeWait(recheck, thread.id);
                this.wakeThread(thread, recheck.result);
            }
        }
    }

    /** A woken thread whose SRW lock is contended stays WAITING, re-registered
     *  on the lock's wait event; the eventual ReleaseSRWLock* wake retries the
     *  grant. `pendingEax` preserves a CV BOOL result across the second wait. */
    private requeueSrwWait(thread: Thread, lockPtr: number, exclusive: boolean, pendingEax?: number): void {
        this.waitEngine.unregisterWait(thread);
        const waitEvent = ensureSrwWaitEvent(lockPtr, this);
        thread.waitInfo = {
            reason: WaitReason.SRW_LOCK,
            handles: [waitEvent],
            waitAll: false,
            timeoutTimerId: 0,
            alertable: false,
            csAddress: lockPtr,
            srwWantExclusive: exclusive,
            pendingEax: pendingEax ?? thread.waitInfo?.pendingEax,
        };
        this.waitEngine.registerWait(thread);
        Logger.verbose(LogCategory.THREAD,
            `wakeThread: SRW contended on wake — T${thread.id} requeued on lock=0x${lockPtr.toString(16)} (exclusive=${exclusive})`);
    }

    private wakeThread(thread: Thread, result: number): void {
        if (!thread.context) {
            Logger.error(LogCategory.THREAD, `wakeThread: T${thread.id} has no context`);
            return;
        }

        // Cancel timeout timer
        if (thread.waitInfo?.timeoutTimerId) {
            this.timerWheel.cancel(thread.waitInfo.timeoutTimerId);
        }

        // Transfer CS ownership BEFORE unregistering wait
        const reason = thread.waitInfo?.reason;
        if (reason === WaitReason.CRITICAL_SECTION && thread.waitInfo?.csAddress) {
            const csAddr = thread.waitInfo.csAddress;
            Mem.writeUint32((csAddr + 4) >>> 0, 0);          // LockCount = 0
            Mem.writeUint32((csAddr + 8) >>> 0, 1);          // RecursionCount = 1
            Mem.writeUint32((csAddr + 12) >>> 0, thread.id >>> 0); // OwningThread
            this.registerCriticalSectionOwner(csAddr, thread.id);
        } else if (reason === WaitReason.SRW_LOCK && thread.waitInfo?.csAddress) {
            const lockPtr = thread.waitInfo.csAddress;
            const exclusive = thread.waitInfo.srwWantExclusive;
            if (!grantSrwOnWake(lockPtr, thread.id, exclusive)) {
                this.requeueSrwWait(thread, lockPtr, exclusive);
                return;
            }
            if (thread.waitInfo.pendingEax !== undefined) result = thread.waitInfo.pendingEax;
        } else if (thread.waitInfo?.cvReacquireCs && thread.waitInfo?.csAddress) {
            // SleepConditionVariableCS wake: re-take the critical section (uncontended fast
            // path) and return TRUE on signal / FALSE on timeout.
            const csAddr = thread.waitInfo.csAddress;
            Mem.writeUint32((csAddr + 4) >>> 0, 0);           // LockCount = 0 (locked)
            Mem.writeUint32((csAddr + 8) >>> 0, 1);           // RecursionCount = 1
            Mem.writeUint32((csAddr + 12) >>> 0, thread.id >>> 0); // OwningThread
            this.registerCriticalSectionOwner(csAddr, thread.id);
            result = result === WAIT_OBJECT_0 ? 1 : 0;
        } else if (thread.waitInfo?.boolReturn && thread.waitInfo?.csAddress) {
            const lockPtr = thread.waitInfo.csAddress;
            const exclusive = thread.waitInfo.srwWantExclusive;
            if (!grantSrwOnWake(lockPtr, thread.id, exclusive)) {
                // SleepConditionVariableSRW returns only WITH the lock re-taken:
                // morph the CV wake into a contended SRW acquire, carrying the BOOL.
                this.requeueSrwWait(thread, lockPtr, exclusive, result === WAIT_OBJECT_0 ? 1 : 0);
                return;
            }
            result = result === WAIT_OBJECT_0 ? 1 : 0;
        }

        // Unregister from wait engine
        this.waitEngine.unregisterWait(thread);

        // Set return value
        thread.context.eax = result >>> 0;

        // A suspended thread's wait is satisfied exactly like anyone else's — it just does not
        // get to run yet. Park it in SUSPENDED with the result already in EAX; the last
        // ResumeThread releases it to READY. Nothing became runnable, so no switch is requested.
        if (thread.suspendCount > 0) {
            this.suspendWaitStats.wakeWhileSuspended++;
            this.transitionTo(thread, ThreadState.SUSPENDED, null, thread.context);
            Logger.verbose(LogCategory.THREAD,
                `wakeThread: T${thread.id} ${reason !== undefined ? WAIT_REASON_NAMES[reason] : '?'} satisfied while suspended ` +
                `(count=${thread.suspendCount}) -> SUSPENDED, result=0x${result.toString(16)}`);
            return;
        }

        this.transitionTo(thread, ThreadState.READY, null, thread.context);

        Logger.verbose(LogCategory.THREAD,
            `wakeThread: T${thread.id} ${reason !== undefined ? WAIT_REASON_NAMES[reason] : '?'} -> READY, result=0x${result.toString(16)}`);

        if (this.currentThreadId !== null && this.currentThreadId !== thread.id) {
            this.requestSwitch();
        }
        // If the worker is parked in a setTimeout idle-yield (all threads were blocked)
        // and this wake came from a host-event callback — event/mutex/semaphore signal,
        // thread-exit waiter wake, overlapped-I/O completion — none of which otherwise
        // kick the run loop, resume promptly instead of waiting out the ~50 ms idle timer.
        // No-op when v86 is running or a resume is already in flight (guarded internally).
        this.wakeEarlyFromIdleYield();
    }

    private wakeWaitingThreadsForHandle(triggerHandle: number): void {
        const waiterIds = this.waitEngine.getHandleWaiters(triggerHandle);
        for (const threadId of waiterIds) {
            const thread = this.threads.get(threadId);
            if (!thread || thread.state !== ThreadState.WAITING || !thread.waitInfo) continue;
            if (thread.waitInfo.reason === WaitReason.SLEEP) continue;
            // A suspended waiter cannot act on the signal, and these decisions CONSUME it
            // (auto-reset event, semaphore count, mutex, CS lock semaphore). NT unlinks a
            // suspended thread's wait block for exactly that reason, so the signal reaches a
            // waiter that can use it; the last ResumeThread re-evaluates instead.
            if (thread.suspendCount > 0) { this.suspendWaitStats.skippedSuspendedWaiter++; continue; }

            const decision = this.syncObjects.checkWait(
                thread.waitInfo.handles, thread.waitInfo.waitAll, thread.id,
                (tid) => this.threads.get(tid) ?? null
            );

            if (decision.ready) {
                this.syncObjects.consumeWait(decision, thread.id);
                this.wakeThread(thread, decision.result);
                if (decision.consumeAutoReset.length > 0) break;
            }
        }
    }

    private transitionTo(thread: Thread, newState: ThreadState, waitInfo: WaitInfo | null, context: CpuContext | null): { success: boolean; error?: string } {
        if (!isValidTransition(thread.state, newState)) {
            const err = `Invalid transition: T${thread.id} ${THREAD_STATE_NAMES[thread.state]} -> ${THREAD_STATE_NAMES[newState]}`;
            Logger.error(LogCategory.THREAD, err);
            return { success: false, error: err };
        }

        const oldState = thread.state;
        if (context) this.ensureContextHasFpuSimdState(thread, context);

        // Remove from run queue if leaving READY
        if (oldState === ThreadState.READY && newState !== ThreadState.READY) {
            this.removeFromRunQueue(thread.id);
        }

        this.setThreadState(thread, newState);
        thread.waitInfo = waitInfo;

        if (newState === ThreadState.WAITING || newState === ThreadState.TERMINATED) {
            this.bootstrapUntilFirstWait.delete(thread.id);
        }
        if (newState === ThreadState.TERMINATED && this.fpuLiveOwnerThreadId === thread.id) {
            this.fpuLiveOwnerThreadId = null;
        }

        if (newState === ThreadState.RUNNING) {
            thread.context = null; // Context is in CPU now
            this.currentThreadId = thread.id;
        } else if (context) {
            thread.context = context;
        }

        // Add to run queue if becoming READY
        if (newState === ThreadState.READY && !this.runQueue.includes(thread.id)) {
            this.runQueue.push(thread.id);
        }

        return { success: true };
    }

    /**
     * The single place `thread.state` is ever assigned. Asserts the transition is
     * legal (isValidTransition) and logs a loud error on violation, but still
     * performs the write so behavior matches a raw `thread.state =` assignment.
     * transitionTo() delegates its post-validation write here too, so every
     * state change flows through one validated chokepoint — the
     * state-machine invariant is enforced by code, not discipline
     * (tools/tests/scheduler-state-machine.test.ts).
     *
     * Paths that bypass transitionTo (suspend/resume/terminate) do so to manage
     * their own side effects (runQueue/context/wait teardown) — they still route
     * the state write through here for validation.
     */
    private setThreadState(thread: Thread, newState: ThreadState): void {
        if (!isValidTransition(thread.state, newState)) {
            Logger.error(LogCategory.THREAD,
                `Illegal state write: T${thread.id} ${THREAD_STATE_NAMES[thread.state]} -> ${THREAD_STATE_NAMES[newState]}`);
        }
        thread.state = newState;
    }

    /** Runnable ⇔ READY *and* not suspended. suspendCount is the authority on whether a
     *  thread may execute — state alone is not, now that a suspended thread can sit in
     *  WAITING with a live wait (see suspendThread). */
    private isRunnable(t: Thread | undefined): t is Thread {
        return !!t && t.state === ThreadState.READY && t.suspendCount === 0;
    }

    private pickNextRunnable(excludeId?: number): Thread | null {
        if (this.runQueue.length === 0) return null;

        // Bootstrap threads must reach their first wait before the creator can monopolize CPU
        // during long thunks (e.g. MCI intro decode).
        for (const id of this.bootstrapUntilFirstWait) {
            if (id !== excludeId) {
                const t = this.threads.get(id);
                if (this.isRunnable(t)) return t;
            }
        }

        // Prefer a different thread than excludeId
        for (let i = 0; i < this.runQueue.length; i++) {
            const id = this.runQueue[i];
            if (id !== excludeId) {
                const t = this.threads.get(id);
                if (this.isRunnable(t)) return t;
            }
        }

        // No different thread — return any ready thread
        for (let i = 0; i < this.runQueue.length; i++) {
            const t = this.threads.get(this.runQueue[i]);
            if (this.isRunnable(t)) return t;
        }

        return null;
    }

    private removeFromRunQueue(threadId: number): void {
        const idx = this.runQueue.indexOf(threadId);
        if (idx >= 0) this.runQueue.splice(idx, 1);
    }

    hasOtherRunnableThreads(excludeId: number): boolean {
        for (const t of this.threads.values()) {
            if (t.id === excludeId) continue;
            if (t.state === ThreadState.READY || t.state === ThreadState.RUNNING) return true;
        }
        return false;
    }

    private resolveHandles(handles: number[], thread: Thread): number[] {
        return handles.map(h => h === 0xFFFFFFFE ? thread.handle : h);
    }

    private resolveHandle(handle: number): number {
        if (handle === 0xFFFFFFFE) {
            const t = this.getCurrentThread();
            return t ? t.handle : handle;
        }
        return handle;
    }

    private getThreadByHandle(handle: number): Thread | null {
        for (const t of this.threads.values()) {
            if (t.handle === handle) return t;
        }
        return null;
    }

    private computeYieldMs(requestedMs: number, maxMs = 50): number {
        const nextTimer = this.timerWheel.nextFireIn(this.timeService.nowMs());
        if (nextTimer < Infinity) return Math.min(nextTimer, maxMs);
        return Math.min(requestedMs, maxMs);
    }

    detectDeadlock(): void {
        const now = performance.now();
        if (now - this.lastDeadlockCheckMs < 2000) return;
        this.lastDeadlockCheckMs = now;

        detectDeadlockDiag({
            threads: this.threads,
            mem: this.process?.getCurrentMemory(),
            hasPendingAsyncRestores: this.onHasPendingAsyncRestores,
            timerActiveCount: this.timerWheel.activeCount,
            wakeThread: (thread, result) => this.wakeThread(thread, result),
        });
    }

    private updateMultiThreadMode(): void {
        let alive = 0;
        for (const t of this.threads.values()) {
            if (t.state !== ThreadState.TERMINATED) alive++;
        }
        preemptionManager.setMultiThread(alive > 1);
    }

    private yieldToHost(cpu: V86Cpu, ms: number, source?: string): void {
        if (ms <= 0) return;
        const yieldSource = source ?? this.pendingYieldSource;
        this.pendingYieldSource = "req";
        this.intentionalYield = true;
        const yieldStartMs = performance.now();
        // Use the INNER engine, not the V86 starter wrapper: starter.stop() registers a
        // one-shot "emulator-stopped" bus listener per call, and on the short-yield path
        // resume()/run() lands before do_tick processes the stop — the event never fires
        // and the listener leaks. Millions of spin-loop yields → a multi-million listener
        // list → the first real emulator-stop iterates it with O(n) unregisters (O(n²))
        // and wedges the worker. engine.stop() just sets the stopping flag.
        const starter = this.process?.v86;
        const v86 = starter?.v86 ?? starter;
        if (v86?.stop) v86.stop();

        const resume = () => {
            if (this.idleYieldResumeActive) {
                this.traceAsyncRestore("wakeEarlyFromIdleYield", cpu, "resume re-entry suppressed");
                return;
            }
            this.idleYieldResumeActive = true;
            // Clear the yield flag BEFORE the diagnostics below (which could throw). If
            // intentionalYield stayed true, the startScheduler restart backstop (gated on
            // !intentionalYield) and the heartbeat "v86 not running" warn are permanently
            // disabled → silent hang. A reYield re-sets it via the nested yieldToHost.
            this.intentionalYield = false;
            const actual = performance.now() - yieldStartMs;
            try {
                frameVarianceDiagnostics.recordIdleTime('yield', actual);
                this.recordYield(yieldSource, actual, ms);
                // Drain pending async restores BEFORE restarting v86. Without this,
                // v86 resumes at spinLoopAddress and spins for a full quantum
                // (~5 ms / 500K cycles) until tick_hooks_after eventually fires.
                // Applying here moves EIP to returnAddr so resume is productive.
                if (this.onPollAsyncRestores) {
                    // May need multiple passes if several restores queued for current thread.
                    // Cap the loop to avoid any unexpected reentry.
                    for (let i = 0; i < 8; i++) {
                        if (!this.onPollAsyncRestores(cpu, "yieldToHost.resume")) break;
                    }
                }
                // If after draining the current thread is still WAITING and no
                // other thread can run, re-yield instead of restarting v86 — its
                // only runnable target would be the spin loop. Each iteration is
                // scheduled via setTimeout/MessageChannel (a macrotask), so this
                // cannot blow the stack.
                const current = this.getCurrentThread();
                if (current && current.state === ThreadState.WAITING && this.runQueue.length === 0) {
                    // Clamp to ≥1: a 0 from computeYieldMs (overdue timer) would make the
                    // nested yieldToHost early-return with v86 stopped and NO resume scheduled.
                    this.yieldToHost(cpu, Math.max(1, this.computeYieldMs(4)), "reYield");
                    return;
                }
                if (v86?.run && !System.getInstance().isExiting) v86.run();
            } finally {
                this.idleYieldResumeActive = false;
            }
        };

        // For very short yields (≤1ms), use MessageChannel to bypass the
        // browser's 4ms setTimeout floor. This reduces spin-loop yield
        // overhead from ~4ms to ~0.1ms.
        if (ms <= 1 && this.yieldPort && !this.yieldPortResolve) {
            this.yieldPortResolve = resume;
            this.yieldPort.postMessage(null);
        } else {
            // Track the timer + resume so an async-thunk completion (which queues a
            // restore that makes a thread runnable) can resume immediately instead of
            // sleeping out the full idle interval — see wakeEarlyFromIdleYield().
            // Clear any prior in-flight timer first so its handle isn't leaked (the
            // v86.stop() window can re-enter yieldToHost before the first resume fires).
            if (this.idleYieldTimer !== null) clearTimeout(this.idleYieldTimer);
            this.idleYieldResume = resume;
            this.idleYieldTimer = setTimeout(() => {
                this.idleYieldTimer = null;
                this.idleYieldResume = null;
                resume();
            }, ms);
        }
    }

    /**
     * Resume an in-flight setTimeout-based idle yield (e.g. "allBlocked") right now.
     *
     * When every thread is blocked the scheduler parks the worker in a yieldToHost
     * setTimeout that computeYieldMs caps at ~50ms (the next guest timer). But an
     * async thunk (e.g. a video-decode wait) can complete at any moment and queue a
     * restore that makes a thread runnable; without this, that completion waits out
     * the full ~50ms timer (observed on a Smacker-driven menu: ~95% of wall-clock
     * stuck in ~50ms allBlocked yields → single-digit FPS). The dispatcher's
     * async-completion path calls this so the worker resumes within a microtask of
     * the Promise resolving.
     * No-op (returns false) for the MessageChannel fast-path, which already resumes
     * in ~0.1ms, or when no setTimeout yield is in flight.
     */
    wakeEarlyFromIdleYield(): boolean {
        if (this.idleYieldTimer === null || !this.idleYieldResume) return false;
        if (this.idleYieldResumeActive) {
            this.traceAsyncRestore("wakeEarlyFromIdleYield", null, "early wake ignored: resume active");
            return false;
        }
        const resume = this.idleYieldResume;
        clearTimeout(this.idleYieldTimer);
        this.idleYieldTimer = null;
        this.idleYieldResume = null;
        this.traceAsyncRestore("wakeEarlyFromIdleYield", null, "early wake resume");
        resume();
        return true;
    }

    private releaseAllCriticalSectionsForThread(threadId: number): void {
        const mem = this.process?.getCurrentMemory();
        if (!mem) return;

        // Candidates come from BOTH maps: criticalSectionOwners only sees JS-path
        // acquisitions — the WASM EnterCriticalSection fast path writes ownership
        // straight into guest memory. csLockSemaphores tracks every CS that ever
        // had contention (the only ones that can have parked waiters), so sweeping
        // it by guest-memory owner catches WASM-acquired CSes too. Missing one
        // leaves a waiter parked forever on a dead thread's CS (boot deadlock).
        const candidates = new Set<number>();
        for (const [addr, ownerId] of this.criticalSectionOwners) {
            if (ownerId === threadId) candidates.add(addr);
        }
        for (const addr of this.csLockSemaphores.keys()) candidates.add(addr);

        for (const addr of candidates) {
            if (addr + 24 > mem.length) continue;

            const memOwner = Mem.readUint32((addr + 12) >>> 0);
            if (memOwner !== null && memOwner === threadId) {
                const lockSem = Mem.readUint32((addr + 16) >>> 0) ?? 0;
                const hasWaiters = lockSem !== 0 && this.hasWaitersForHandle(lockSem);
                if (hasWaiters) {
                    // Active waiters — keep locked. wakeThread handles ownership transfer.
                    Mem.writeUint32((addr + 8) >>> 0, 0);
                    this.clearCriticalSectionOwner(addr, threadId);
                    this.setEvent(lockSem);
                    Logger.warn(LogCategory.THREAD,
                        `releaseAllCriticalSectionsForThread: T${threadId} died owning CS 0x${addr.toString(16)} — transferred to waiter`);
                } else {
                    // No waiters — fully release
                    Mem.writeUint32((addr + 4) >>> 0, 0xffffffff);
                    Mem.writeUint32((addr + 8) >>> 0, 0);
                    Mem.writeUint32((addr + 12) >>> 0, 0);
                    this.clearCriticalSectionOwner(addr, threadId);
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Initialization Helpers
    // ═══════════════════════════════════════════════════════════════════════

    private ensureMainThread(): void {
        if (!this.process) return;
        if (this.currentThreadId !== null && this.threads.has(this.currentThreadId)) return;

        const cpu = this.getCpu();
        if (!cpu) return;

        const threadId = this.nextThreadId++;
        const handle = this.resourceProvider.registerKernelObject({
            kind: 'thread', threadId,
        } as KernelThreadObject);

        const stackBase = this.mainStackBase || 0;
        const stackSize = this.mainStackTop > 0 ? this.mainStackTop - stackBase : 0;
        const stackTop = this.mainStackTop || (cpu.reg32[4] >>> 0);

        let tebAddress = 0;
        if (this.process.memory && stackTop > 0) {
            tebAddress = this.tebManager.allocateTeb(threadId, stackBase, stackTop, this.process.memory);
            if (tebAddress > 0) {
                setFsBase(cpu, tebAddress);
            }
        }

        const thread: Thread = {
            id: threadId, handle,
            state: ThreadState.RUNNING,
            context: null,
            stackBase, stackSize, stackTop,
            startAddress: cpu.instruction_pointer[0] >>> 0,
            parameter: 0,
            waitInfo: null, exitCode: null,
            tlsValues: new Map(), lastError: 0,
            suspendCount: 0, priority: 0,
            lastSwitchTime: performance.now(),
            lastSwitchInsn: (cpu?.instruction_counter?.[0] ?? 0) >>> 0,
            tebAddress, kernelPinCount: 0,
            apcQueue: [],
            quitPosted: false, quitExitCode: 0,
            asyncParkGeneration: 0,
        };

        this.threads.set(threadId, thread);
        this.currentThreadId = threadId;
        this.mainThreadId = threadId;

        // Initialize implicit TLS data for the main thread.
        // PE loader recorded TLS entries during loading, but the TLS array may have
        // been recreated since then (ensureMainThread creates a fresh TEB/TLS array).
        {
            const mem = this.process.getCurrentMemory();
            if (mem && mem.length > 0) {
                this.initImplicitTlsForThread(threadId, thread, mem);
            } else {
                Logger.warn(LogCategory.THREAD, `ensureMainThread: cannot get memory for TLS init`);
            }
        }

        if (hypercallDataManager.isInitialized()) {
            hypercallDataManager.syncThreadData(threadId, 0, tebAddress);
        }

        Logger.log(LogCategory.THREAD, `Main thread initialized (id=${threadId}, TEB=0x${tebAddress.toString(16)})`);
    }

    private getCpu(): V86Cpu | null {
        if (!this.process) return null;
        return this.process.v86?.cpu || this.process.v86?.v86?.cpu;
    }

    private writeThreadExitStub(): void {
        if (!this.process) return;
        const mem = this.process.getCurrentMemory();
        // Lazily allocate the stub in the reserved THUNK_DATA bucket (registered as a region,
        // separate bump range from HEAP, identity-mapped so executable). This guarantees no
        // guest HEAP allocation can ever overlap it — see the threadExitStubAddr field comment.
        if (this.threadExitStubAddr === 0) {
            try {
                this.threadExitStubAddr = this.process.memory.alloc(this.threadExitStubSize, 'THUNK_DATA') >>> 0;
            } catch (e) {
                Logger.error(LogCategory.THREAD, `Failed to allocate thread-exit stub: ${e}`);
                return;
            }
            Logger.log(LogCategory.THREAD, `Thread-exit stub allocated at 0x${this.threadExitStubAddr.toString(16)} (THUNK_DATA)`);
        }
        if (this.threadExitStubAddr + this.threadExitStubSize > mem.length) return;

        let off = 0;
        mem[this.threadExitStubAddr + off++] = 0x50; // PUSH EAX
        mem[this.threadExitStubAddr + off++] = 0xB8; // MOV EAX, imm32
        mem[this.threadExitStubAddr + off++] = this.threadExitFunctionId & 0xFF;
        mem[this.threadExitStubAddr + off++] = (this.threadExitFunctionId >> 8) & 0xFF;
        mem[this.threadExitStubAddr + off++] = (this.threadExitFunctionId >> 16) & 0xFF;
        mem[this.threadExitStubAddr + off++] = (this.threadExitFunctionId >> 24) & 0xFF;
        mem[this.threadExitStubAddr + off++] = 0xBA; // MOV EDX, imm32
        mem[this.threadExitStubAddr + off++] = 0x77;
        mem[this.threadExitStubAddr + off++] = 0xB0;
        mem[this.threadExitStubAddr + off++] = 0x00;
        mem[this.threadExitStubAddr + off++] = 0x00;
        mem[this.threadExitStubAddr + off++] = 0xEF; // OUT DX, EAX
        while (off < this.threadExitStubSize) mem[this.threadExitStubAddr + off++] = 0x90; // NOP
        invalidateGuestCode(this.threadExitStubAddr, this.threadExitStubSize);
    }
}
