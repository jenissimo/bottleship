/**
 * Scheduler Types — Clean-Room Rewrite
 *
 * Core type definitions for the scheduler system.
 * Single source of truth for thread state, CPU context, sync objects, and wait reasons.
 */

// ─── Thread State Machine ───────────────────────────────────────────────────────

export const enum ThreadState {
    CREATED = 0,
    READY = 1,
    RUNNING = 2,
    WAITING = 3,
    SUSPENDED = 4,
    TERMINATED = 5,
}

/** Win32 `MAXIMUM_SUSPEND_COUNT`. A SuspendThread that would push the count past this
 *  fails with `(DWORD)-1` / ERROR_SIGNAL_REFUSED instead of counting on — engines that use
 *  Suspend/Resume as a spin-sync primitive can otherwise accumulate an unbounded count that
 *  no number of Resumes can drain, and a count real Windows never produces is a state the
 *  guest was never written against. */
export const MAXIMUM_SUSPEND_COUNT = 127;

/** RtlNtStatusToDosError(STATUS_SUSPEND_COUNT_EXCEEDED). */
export const ERROR_SIGNAL_REFUSED = 156;

export const THREAD_STATE_NAMES: Record<ThreadState, string> = {
    [ThreadState.CREATED]: 'CREATED',
    [ThreadState.READY]: 'READY',
    [ThreadState.RUNNING]: 'RUNNING',
    [ThreadState.WAITING]: 'WAITING',
    [ThreadState.SUSPENDED]: 'SUSPENDED',
    [ThreadState.TERMINATED]: 'TERMINATED',
};

// ─── Thunk Boundary ─────────────────────────────────────────────────────────────
// Tells the scheduler *exactly* where the CPU is so context save is deterministic.

export const enum ThunkBoundaryKind {
    /** Between OUT and RET N — construct post-return context */
    THUNK_STUB = 0,
    /** At JMP $ (async thunk) — forceSave, EIP is valid resume point */
    SPIN_LOOP = 1,
    /** At callback return stub — forceSave */
    CALLBACK_STUB = 2,
    /** Normal guest code (from onTickBoundary) — standard save */
    GUEST_CODE = 3,
}

// ─── Wait Reasons ───────────────────────────────────────────────────────────────

export const enum WaitReason {
    NONE = 0,
    SLEEP = 1,
    SINGLE_OBJECT = 2,
    MULTIPLE_OBJECTS = 3,
    MESSAGE = 4,
    CRITICAL_SECTION = 5,
    ASYNC_THUNK = 6,
    SRW_LOCK = 7,
}

export const WAIT_REASON_NAMES: Record<WaitReason, string> = {
    [WaitReason.NONE]: 'NONE',
    [WaitReason.SLEEP]: 'SLEEP',
    [WaitReason.SINGLE_OBJECT]: 'SINGLE_OBJECT',
    [WaitReason.MULTIPLE_OBJECTS]: 'MULTIPLE_OBJECTS',
    [WaitReason.MESSAGE]: 'MESSAGE',
    [WaitReason.CRITICAL_SECTION]: 'CRITICAL_SECTION',
    [WaitReason.ASYNC_THUNK]: 'ASYNC_THUNK',
    [WaitReason.SRW_LOCK]: 'SRW_LOCK',
};

// ─── CPU Context ────────────────────────────────────────────────────────────────

export interface CpuContext {
    eax: number;
    ecx: number;
    edx: number;
    ebx: number;
    esp: number;
    ebp: number;
    esi: number;
    edi: number;
    eip: number;
    eflags: number;
    /** Execution domain for strict restore/save policy checks. */
    domain?: CpuContextDomain;
    /** Generation tag for transient SEH runtime contexts. */
    domainGen?: number;
    /** Full x87 FPU snapshot (fpu-helper FPU_SNAPSHOT_BYTES). Guest threads share
     *  one v86 FPU; without this a thread preempted mid-computation resumes with
     *  another thread's FPU stack — garbage dot products → UE1 BSP visibility
     *  flips → random one-frame surface flicker. */
    fpu?: Uint8Array;
    /** Full SSE snapshot: MXCSR + 8 XMM registers (XMM0-7; fpu-helper SIMD_SNAPSHOT_BYTES).
     *  Same shared-register-file hazard as `fpu` but via the SSE path (D3DX math,
     *  CRT, engine SIMD) — a thread preempted mid-SSE-computation or with a custom
     *  MXCSR rounding mode otherwise resumes with another thread's XMM/MXCSR. */
    simd?: Uint8Array;
}

export type CpuContextDomain = 'guest' | 'transient_seh' | 'thunk_stub' | 'spin' | 'callback';

export type CriticalRuntimeSection = 'seh_dispatch';

export type TransientExecRangeKind =
    | 'seh_dispatch_stub'
    | 'seh_filter_stub'
    | 'seh_scratch_stack'
    | 'seh_trampoline';

// ─── Wait Info ──────────────────────────────────────────────────────────────────

export interface WaitInfo {
    reason: WaitReason;
    handles: number[];
    waitAll: boolean;
    timeoutTimerId: number;  // TimerWheel timer id, 0 = INFINITE
    alertable: boolean;
    csAddress: number;       // For CRITICAL_SECTION / SRW_LOCK waits
    srwWantExclusive: boolean; // For SRW_LOCK waits
    /** SleepConditionVariableSRW: map WAIT_OBJECT_0→1, WAIT_TIMEOUT→0 after wake. */
    boolReturn?: boolean;
    /** SleepConditionVariableCS: on wake, re-acquire the critical section at csAddress
     *  (instead of the SRW lock) and map WAIT_OBJECT_0→1, WAIT_TIMEOUT→0. */
    cvReacquireCs?: boolean;
    /** EAX to deliver on the FINAL wake when a CV wake was requeued as a contended
     *  SRW acquire (the CV BOOL result must survive the second wait). */
    pendingEax?: number;
    /** MsgWaitForMultipleObjects*: the thread's message queue is an extra wait slot
     *  alongside `handles`, and this is the result its leg delivers (WAIT_OBJECT_0 +
     *  nCount). Set means "arriving input also ends this wait", whatever the reason. */
    messageWakeResult?: number;
}

// ─── APC ────────────────────────────────────────────────────────────────────────

export const enum ApcKind {
    USER32_QUEUE_USER_APC = 1,
    NTDLL_NT_QUEUE_APC = 2,
    /** FILE_IO_COMPLETION_ROUTINE(dwErrorCode, dwBytesTransferred, lpOverlapped) —
     *  ReadFileEx/WriteFileEx. Three args, cdecl-free stdcall, cleanup 12. */
    IO_COMPLETION = 3,
}

export interface PendingApc {
    routine: number;
    arg0: number;
    arg1: number;
    arg2: number;
    kind: ApcKind;
}

// ─── Thread Record ──────────────────────────────────────────────────────────────

export interface Thread {
    // Identity
    readonly id: number;
    readonly handle: number;

    // State
    state: ThreadState;

    // Context (null when RUNNING — state is in CPU registers)
    context: CpuContext | null;

    // Last known per-thread FP/SIMD state. Kept even while RUNNING so a clean
    // dirty-bit save can reuse it without re-copying the shared v86 register file.
    lastFpuState?: Uint8Array;
    lastSimdState?: Uint8Array;

    // Stack info
    readonly stackBase: number;
    readonly stackSize: number;
    readonly stackTop: number;

    // Entry point
    readonly startAddress: number;
    readonly parameter: number;

    // Wait info (null when not WAITING)
    waitInfo: WaitInfo | null;

    // Exit
    exitCode: number | null;

    // TLS
    tlsValues: Map<number, number>;

    // Per-thread error
    lastError: number;

    // Suspend count
    suspendCount: number;

    // Priority
    priority: number;

    // Timing — wall-clock stamp (diagnostics / timer-thread fairness budget).
    lastSwitchTime: number;
    // Retired-instruction stamp at the last switch. Preemption quantum is measured against this
    // (deterministic guest clock) instead of wall-clock, so the switch point is platform-independent.
    lastSwitchInsn: number;

    // TEB guest memory address
    tebAddress: number;

    // HLE kernel pin — prevents preemptive switch when > 0
    kernelPinCount: number;

    // APC queue (inline, no separate store)
    apcQueue: PendingApc[];

    // Per-thread WM_QUIT state (PostQuitMessage sets flag, GetMessage synthesizes)
    quitPosted: boolean;
    quitExitCode: number;

    // Monotonic token for async HLE parking. A pending async restore is valid
    // only for the same thread id and generation that produced it.
    asyncParkGeneration: number;
}

// ─── State Transition Validation ────────────────────────────────────────────────

const _validTransitions = new Set<string>([
    // CREATED
    `${ThreadState.CREATED}:${ThreadState.READY}`,
    `${ThreadState.CREATED}:${ThreadState.SUSPENDED}`,
    // READY
    `${ThreadState.READY}:${ThreadState.RUNNING}`,
    `${ThreadState.READY}:${ThreadState.WAITING}`,    // Thread blocked before first run (e.g. timer thread)
    `${ThreadState.READY}:${ThreadState.SUSPENDED}`,
    `${ThreadState.READY}:${ThreadState.TERMINATED}`,
    // RUNNING
    `${ThreadState.RUNNING}:${ThreadState.READY}`,
    `${ThreadState.RUNNING}:${ThreadState.WAITING}`,
    `${ThreadState.RUNNING}:${ThreadState.SUSPENDED}`,
    `${ThreadState.RUNNING}:${ThreadState.TERMINATED}`,
    // WAITING
    `${ThreadState.WAITING}:${ThreadState.READY}`,
    `${ThreadState.WAITING}:${ThreadState.SUSPENDED}`,
    `${ThreadState.WAITING}:${ThreadState.TERMINATED}`,
    // SUSPENDED
    `${ThreadState.SUSPENDED}:${ThreadState.READY}`,
    `${ThreadState.SUSPENDED}:${ThreadState.TERMINATED}`,
]);

export function isValidTransition(from: ThreadState, to: ThreadState): boolean {
    if (from === ThreadState.TERMINATED) return to === ThreadState.TERMINATED;
    return _validTransitions.has(`${from}:${to}`);
}

// ─── Windows API Constants ──────────────────────────────────────────────────────

export const WAIT_OBJECT_0 = 0x00000000;
export const WAIT_IO_COMPLETION = 0x000000C0;
export const WAIT_TIMEOUT = 0x00000102;
export const WAIT_FAILED = 0xFFFFFFFF;
export const WAIT_ABANDONED = 0x00000080;
/** Internal sentinel: thread blocked, redirect EIP to spin loop */
export const WAIT_BLOCKED_NO_SWITCH = 0xFFFFFFFE;
export const INFINITE = 0xFFFFFFFF;
export const CREATE_SUSPENDED = 0x00000004;

// ─── Wait Decision ──────────────────────────────────────────────────────────────

export interface WaitDecision {
    ready: boolean;
    result: number;
    consumeAutoReset: number[];
    consumeSemaphores: number[];
    consumeMutexes: number[];
    /** Manual-reset events whose pendingWake latch is consumed by this wait. */
    consumePendingWake?: number[];
}

// ─── Kernel Objects ─────────────────────────────────────────────────────────────

export interface KernelThreadObject {
    kind: 'thread';
    threadId: number;
    /** Set when the thread terminates; survives scheduler reaping. */
    terminated?: boolean;
    /** Exit code, preserved after the Thread record is reaped. */
    exitCode?: number;
}

export interface KernelEventObject {
    kind: 'event';
    manualReset: boolean;
    signaled: boolean;
    /** Manual-reset: SetEvent sets this; ResetEvent clears signaled but not this until a wait consumes it. */
    pendingWake?: boolean;
}

export interface KernelSemaphoreObject {
    kind: 'semaphore';
    count: number;
    max: number;
}

export interface KernelMutexObject {
    kind: 'mutex';
    ownerThreadId: number | null;
    recursion: number;
    abandoned: boolean;
}

export type KernelSyncObject = KernelEventObject | KernelSemaphoreObject | KernelMutexObject;
export type KernelObject = KernelThreadObject | KernelSyncObject;

// ─── v86 CPU Interface ──────────────────────────────────────────────────────────

export interface V86Cpu {
    reg32: Int32Array;
    instruction_pointer: Int32Array;
    flags: Int32Array;
    sreg: Int16Array;
    is_jumping?: boolean;
    update_seg?(index: number): void;
    segment_offsets?: Int32Array;
    /** Monotonic count of retired guest instructions (32-bit, wraps). v86 advances this as it
     *  executes; it is the deterministic clock the scheduler uses to drive preemption (instead
     *  of wall-clock) and that hypercall-data.ts uses for instruction-based virtual time. */
    instruction_counter?: Int32Array;
    /** v86-exported 1-byte FPU/SIMD dirty flag. */
    fpu_simd_dirty?: Uint8Array;
    /** v86 lazy-flags dirty mask: which arithmetic EFLAGS bits are pending
     *  materialization from last_op1/last_result/last_op_size (cpu.js@100).
     *  Guest threads share the single v86 flag state; a context switch that
     *  leaves this nonzero makes the resumed thread compute ZF/CF/SF/OF/PF/AF
     *  from ANOTHER thread's last ALU result — wrong branch → random memory
     *  corruption (same shared-register-file class as fpu/simd). */
    flags_changed?: Int32Array;
    /** v86 WASM export: materialize full EFLAGS (folds the lazy arithmetic
     *  flags into the returned value; side-effect-free). */
    get_eflags?(): number;
}

// ─── Timer Kinds ────────────────────────────────────────────────────────────────

export const enum TimerKind {
    SLEEP_TIMEOUT = 0,
    WAIT_TIMEOUT = 1,
    USER32_TIMER = 2,
    WINMM_TIMER = 3,
    WAITABLE_TIMER = 4,
    DSOUND_NOTIFY = 5,
    MSS_TIMER = 6,
    QUARTZ_VIDEO = 7,
}

// ─── Scheduler Configuration ────────────────────────────────────────────────────

export interface SchedulerConfig {
    enabled: boolean;
    minQuantumMs: number;
    debugLogging: boolean;
    /**
     * When true, async thunks transition their thread to WAITING so v86
     * skips the parked spin loop. When false, the legacy behaviour applies
     * (thread stays RUNNING, v86 burns a full quantum at JMP $).
     */
    asyncHleWaitEnabled: boolean;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
    enabled: true,
    // NT's client quantum is ~15.6 ms (two clock ticks). A 1 ms quantum preempts ~15x
    // more often than the OS these titles were written against, which turns a benign
    // guest race into a reliable one: a thread that seeks then reads a shared file
    // handle gets split by a peer far more often than it ever would on Windows.
    // Measured on Natalie Brooks, 6 level loads per arm: crashed 4/6 at 1 ms vs 0/6
    // at 16 ms; corrupted archive reads per load 2.8 -> 1.7 mean. Preemption frequency
    // is part of faithfulness, not just a tuning knob.
    minQuantumMs: 16,
    debugLogging: false,
    asyncHleWaitEnabled: true,
};
