/**
 * Vista+ kernel32 exports commonly resolved via GetProcAddress (CRT / modern runtimes):
 * one-time initialization and the thread pool.
 */

import { ThunkImplementation, ThunkResult, X86Context } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { TimeService } from '../../runtime/time';
import {
    INFINITE, TimerKind, WAIT_BLOCKED_NO_SWITCH, WAIT_OBJECT_0, WAIT_TIMEOUT,
} from '../../core/scheduler/types';
import { resolveHleExportAddress } from '../../core/thunking/export-resolver';
import { resetSrwLock } from './srw-lock';
import { exports as moduleExports } from './module/module';

const ERROR_INVALID_PARAMETER = 87;
const ERROR_GEN_FAILURE = 31;
const ERROR_NOT_ENOUGH_MEMORY = 8;

// INIT_ONCE is one pointer. Its low two bits are the state and, once done, the upper
// bits are the context the initializer published.
const ONCE_STATE_MASK = 3;
const ONCE_IDLE = 0;
const ONCE_RUNNING = 1;
const ONCE_DONE = 2;
const ONCE_RUNNING_ASYNC = 3;
const INIT_ONCE_CHECK_ONLY = 1;
const INIT_ONCE_ASYNC = 2;
const INIT_ONCE_INIT_FAILED = 4;

type OnceBegin =
    | { kind: 'done'; context: number }
    | { kind: 'pending' }
    | { kind: 'wait' }
    | { kind: 'error'; win32: number };

/** RtlRunOnceBeginInitialize, less the wait: 'wait' means another thread is initializing. */
function onceBegin(once: number, flags: number): OnceBegin {
    const val = Mem.readUint32(once) ?? 0;
    const state = val & ONCE_STATE_MASK;
    if (flags & INIT_ONCE_CHECK_ONLY) {
        if (flags & INIT_ONCE_ASYNC) return { kind: 'error', win32: ERROR_INVALID_PARAMETER };
        return state === ONCE_DONE
            ? { kind: 'done', context: (val & ~ONCE_STATE_MASK) >>> 0 }
            : { kind: 'error', win32: ERROR_GEN_FAILURE };
    }
    switch (state) {
        case ONCE_IDLE:
            Mem.writeUint32(once, (flags & INIT_ONCE_ASYNC) ? ONCE_RUNNING_ASYNC : ONCE_RUNNING);
            return { kind: 'pending' };
        case ONCE_RUNNING:
            return (flags & INIT_ONCE_ASYNC) ? { kind: 'error', win32: ERROR_INVALID_PARAMETER } : { kind: 'wait' };
        case ONCE_DONE:
            return { kind: 'done', context: (val & ~ONCE_STATE_MASK) >>> 0 };
        default:
            return (flags & INIT_ONCE_ASYNC) ? { kind: 'pending' } : { kind: 'error', win32: ERROR_INVALID_PARAMETER };
    }
}

/** RtlRunOnceComplete. Returns 0 on success, else the Win32 error. */
function onceComplete(once: number, flags: number, context: number): number {
    if (context & ONCE_STATE_MASK) return ERROR_INVALID_PARAMETER;
    const failed = (flags & INIT_ONCE_INIT_FAILED) !== 0;
    if (failed && (context || (flags & INIT_ONCE_ASYNC))) return ERROR_INVALID_PARAMETER;
    const next = failed ? ONCE_IDLE : (context | ONCE_DONE) >>> 0;

    const state = (Mem.readUint32(once) ?? 0) & ONCE_STATE_MASK;
    if (state === ONCE_RUNNING) {
        if (flags & INIT_ONCE_ASYNC) return ERROR_INVALID_PARAMETER;
        Mem.writeUint32(once, next);
        const evt = onceWaitEvents.get(once);
        if (evt) System.getInstance().scheduler.wakeConditionVariable(evt, true);
        return 0;
    }
    if (state === ONCE_RUNNING_ASYNC) {
        if (!(flags & INIT_ONCE_ASYNC)) return ERROR_INVALID_PARAMETER;
        Mem.writeUint32(once, next);
        return 0;
    }
    return ERROR_GEN_FAILURE;
}

/** INIT_ONCE address -> the event its waiters park on while another thread initializes. */
const onceWaitEvents = new Map<number, number>();

const callerRegs = (ctx: X86Context) =>
    ({ ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags });

/**
 * Park the caller until the INIT_ONCE's initializer completes, then run the same call again
 * from the top — RtlRunOnceBeginInitialize's own loop, so a waiter that finds the attempt
 * failed takes ownership exactly as on Windows. The dispatcher points a parked caller's
 * return slot at the spin loop; the wake puts the real return address back first.
 */
function parkUntilOnceCompletes(ctx: X86Context, once: number, exportName: string, cleanup: number): ThunkResult | null {
    const system = System.getInstance();
    const sched = system.scheduler;
    const stub = resolveHleExportAddress(system.process?.dispatcher, 'kernel32', exportName);
    const esp = ctx.esp >>> 0;
    const returnAddr = Mem.readUint32(esp) ?? 0;
    if (!stub || !returnAddr) return null;

    let evt = onceWaitEvents.get(once);
    if (!evt) {
        evt = sched.createEvent(false, false);
        onceWaitEvents.set(once, evt);
    }
    const result = sched.waitForObjectsWithContext(
        [evt], false, INFINITE, stub, esp, callerRegs(ctx), false,
        () => {
            Mem.writeUint32(esp, returnAddr);
            return { value: 0 };
        },
    );
    return result === WAIT_BLOCKED_NO_SWITCH ? { value: 0, blockedNoSwitch: true, stackCleanup: cleanup } : null;
}

// ─── Thread pool ───────────────────────────────────────────────────────────────

/**
 * A PTP_CALLBACK_INSTANCE: one callback invocation. Opaque to the guest; the only
 * state it carries is what the callback asked to happen once it returns.
 */
interface TpInstance {
    freeLibrary: number;
}

/** A pool object's callbacks that are queued or running, and who is running one inline. */
interface TpTracked {
    callback: number;
    context: number;
    outstanding: number;
    /** Manual-reset, signalled while nothing is outstanding. */
    idleEvent: number;
    runningOn: Set<number>;
}

interface TpTimer extends TpTracked {
    wheelId: number | null;
}

interface TpWait extends TpTracked {
    pollId: number | null;
}

type TpWork = TpTracked;

const tpTimers = new Map<number, TpTimer>();
const tpWaits = new Map<number, TpWait>();
const tpWork = new Map<number, TpWork>();
const tpInstances = new Map<number, TpInstance>();
let nextTpHandle = 0x00080000;
let nextTpInstance = 0x000C0000;

/** How often a thread-pool wait re-checks its object, in virtual milliseconds. */
const TP_WAIT_POLL_MS = 1;

function newTracked(callback: number, context: number): TpTracked {
    return {
        callback, context, outstanding: 0,
        idleEvent: System.getInstance().scheduler.createEvent(true, true),
        runningOn: new Set(),
    };
}

function beginInstance(): number {
    const id = nextTpInstance++;
    tpInstances.set(id, { freeLibrary: 0 });
    return id;
}

function endInstance(id: number): void {
    const inst = tpInstances.get(id);
    tpInstances.delete(id);
    if (inst?.freeLibrary) {
        moduleExports['FreeLibrary']({} as X86Context, Mem.getView() ?? new Uint8Array(0), [inst.freeLibrary]);
    }
}

function trackStart(obj: TpTracked): void {
    if (obj.outstanding++ === 0) System.getInstance().scheduler.resetEvent(obj.idleEvent);
}

function trackEnd(obj: TpTracked): void {
    if (obj.outstanding > 0 && --obj.outstanding === 0) System.getInstance().scheduler.setEvent(obj.idleEvent);
}

/** Queue `obj`'s callback on a pool thread with (Instance, Context, Object, ...extra). */
function postPoolCallback(obj: TpTracked, handle: number, extra: number[]): void {
    const instance = beginInstance();
    trackStart(obj);
    const posted = System.getInstance().scheduler.postTimerCallback(
        obj.callback, [instance, obj.context, handle, ...extra],
        () => {
            endInstance(instance);
            trackEnd(obj);
        },
    );
    if (!posted) {
        tpInstances.delete(instance);
        trackEnd(obj);
    }
}

/** Drop `obj`'s callbacks that have not started yet. */
function cancelPendingCallbacks(obj: TpTracked, handle: number): void {
    const winmm = System.getInstance().process?.getModule('winmm') as
        { cancelPostedGuestCallbacks?(m: (cb: { callbackAddr: number; args?: number[] }) => boolean): Array<{ args?: number[] }> } | undefined;
    const removed = winmm?.cancelPostedGuestCallbacks?.(
        (cb) => cb.callbackAddr === obj.callback && cb.args?.[2] === handle) ?? [];
    for (const cb of removed) {
        tpInstances.delete(cb.args?.[0] ?? 0);
        trackEnd(obj);
    }
}

/**
 * WaitForThreadpool*Callbacks: optionally cancel what has not started, then block until the
 * rest has returned. A callback the CALLER is itself running cannot finish while it waits
 * (Windows deadlocks there), and the pool's only worker cannot wait on work queued behind
 * it — both return at once rather than hang the process.
 */
function waitForPoolCallbacks(
    ctx: X86Context, obj: TpTracked | undefined, handle: number, cancelPending: boolean,
): ThunkResult {
    const done: ThunkResult = { value: 0, stackCleanup: 8 };
    if (!obj) return done;
    if (cancelPending) cancelPendingCallbacks(obj, handle);
    if (obj.outstanding === 0) return done;

    const sched = System.getInstance().scheduler;
    const tid = sched.getCurrentThreadId();
    const winmm = System.getInstance().process?.getModule('winmm') as { timerThreadId?: number } | undefined;
    if (obj.runningOn.has(tid) || tid === (winmm?.timerThreadId ?? 0)) return done;

    const returnAddr = Mem.readUint32(ctx.esp) ?? 0;
    const result = sched.waitForObjectsWithContext(
        [obj.idleEvent], false, INFINITE, returnAddr, ctx.esp + 12, callerRegs(ctx));
    return result === WAIT_BLOCKED_NO_SWITCH ? { value: 0, blockedNoSwitch: true, stackCleanup: 8 } : done;
}

/**
 * A FILETIME due time as a delay: negative is relative (100 ns units), positive is an
 * absolute system time, zero is now.
 */
function fileTimeToDelayMs(pft: number): number {
    const low = Mem.readUint32(pft) ?? 0;
    const high = Mem.readUint32(pft + 4) ?? 0;
    const raw = (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
    const signed = raw >= 0x8000000000000000n ? raw - 0x10000000000000000n : raw;
    if (signed < 0n) return Number(-signed / 10000n);
    const nowFt = (BigInt(Math.floor(TimeService.getInstance().nowUnixMs())) + 11644473600000n) * 10000n;
    return signed > nowFt ? Number((signed - nowFt) / 10000n) : 0;
}

function stopWaitPoll(entry: TpWait): void {
    if (entry.pollId !== null) {
        System.getInstance().scheduler.timerWheel.cancel(entry.pollId);
        entry.pollId = null;
    }
}

export function resetVistaRuntimeState(): void {
    onceWaitEvents.clear();
    tpTimers.clear();
    tpWaits.clear();
    tpWork.clear();
    tpInstances.clear();
}

function initVistaRuntime(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // BOOL InitOnceExecuteOnce(PINIT_ONCE, PINIT_ONCE_FN InitFn, PVOID Parameter, LPVOID *Context)
    exports['InitOnceExecuteOnce'] = (ctx, _mem, args) => {
        const lpInitOnce = args[0] >>> 0;
        const pfnInitFn = args[1] >>> 0;
        const parameter = args[2] >>> 0;
        const lpContext = args[3] >>> 0;
        const STACK_CLEANUP = 16;

        if (!lpInitOnce) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: STACK_CLEANUP };
        }

        const begin = onceBegin(lpInitOnce, 0);
        if (begin.kind === 'done') {
            if (lpContext) Mem.writeUint32(lpContext, begin.context);
            return { value: 1, stackCleanup: STACK_CLEANUP };
        }
        if (begin.kind === 'wait') {
            return parkUntilOnceCompletes(ctx, lpInitOnce, 'InitOnceExecuteOnce', STACK_CLEANUP)
                ?? { value: 0, stackCleanup: STACK_CLEANUP };
        }
        if (begin.kind === 'error') return { value: 0, stackCleanup: STACK_CLEANUP };

        const finish = (ok: boolean): number => {
            if (!ok) {
                onceComplete(lpInitOnce, INIT_ONCE_INIT_FAILED, 0);
                return 0;
            }
            const context = lpContext ? (Mem.readUint32(lpContext) ?? 0) : 0;
            return onceComplete(lpInitOnce, 0, context) === 0 ? 1 : 0;
        };

        const callbackManager = System.getInstance().process?.dispatcher?.callbackManager;
        if (!pfnInitFn || !callbackManager) {
            return { value: finish(true), stackCleanup: STACK_CLEANUP };
        }

        callbackManager.saveSuspendedThunkContext(ctx, STACK_CLEANUP);
        const { callbackId } = callbackManager.invokeCallback(
            pfnInitFn,
            [lpInitOnce, parameter, lpContext],
            12,
            (ret) => finish(ret !== 0),
            false,
            'InitOnceExecuteOnce',
        );

        return { value: 0, suspendedForCallback: true, callbackId, stackCleanup: STACK_CLEANUP };
    };

    // BOOL InitOnceBeginInitialize(LPINIT_ONCE, DWORD dwFlags, PBOOL fPending, LPVOID *lpContext)
    exports['InitOnceBeginInitialize'] = (ctx, _mem, args) => {
        const lpInitOnce = args[0] >>> 0;
        const dwFlags = args[1] >>> 0;
        const fPending = args[2] >>> 0;
        const lpContext = args[3] >>> 0;
        const STACK_CLEANUP = 16;
        const sched = System.getInstance().scheduler;

        if (!lpInitOnce || (dwFlags & ~(INIT_ONCE_CHECK_ONLY | INIT_ONCE_ASYNC))) {
            sched.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: STACK_CLEANUP };
        }
        const begin = onceBegin(lpInitOnce, dwFlags);
        switch (begin.kind) {
            case 'done':
                if (fPending) Mem.writeUint32(fPending, 0);
                if (lpContext) Mem.writeUint32(lpContext, begin.context);
                return { value: 1, stackCleanup: STACK_CLEANUP };
            case 'pending':
                if (fPending) Mem.writeUint32(fPending, 1);
                return { value: 1, stackCleanup: STACK_CLEANUP };
            case 'wait':
                return parkUntilOnceCompletes(ctx, lpInitOnce, 'InitOnceBeginInitialize', STACK_CLEANUP)
                    ?? { value: 0, stackCleanup: STACK_CLEANUP };
            case 'error':
                sched.setLastError(begin.win32);
                return { value: 0, stackCleanup: STACK_CLEANUP };
        }
    };

    // BOOL InitOnceComplete(LPINIT_ONCE, DWORD dwFlags, LPVOID lpContext)
    exports['InitOnceComplete'] = (_ctx, _mem, args) => {
        const lpInitOnce = args[0] >>> 0;
        const dwFlags = args[1] >>> 0;
        const lpContext = args[2] >>> 0;
        const sched = System.getInstance().scheduler;
        if (!lpInitOnce || (dwFlags & ~(INIT_ONCE_ASYNC | INIT_ONCE_INIT_FAILED))) {
            sched.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 12 };
        }
        const error = onceComplete(lpInitOnce, dwFlags, lpContext);
        if (error) sched.setLastError(error);
        return { value: error ? 0 : 1, stackCleanup: 12 };
    };

    exports['InitializeConditionVariable'] = (_ctx, _mem, args) => {
        const cv = args[0] >>> 0;
        if (cv) Mem.writeUint32(cv, 0);
        return 0;
    };

    // SleepConditionVariableCS lives in kernel32/sync.ts alongside the CS + CV machinery.

    exports['InitializeSRWLock'] = (_ctx, _mem, args) => {
        resetSrwLock(args[0] >>> 0);
        return 0;
    };

    exports['FlushProcessWriteBuffers'] = () => 0;

    // VOID FreeLibraryWhenCallbackReturns(PTP_CALLBACK_INSTANCE pci, HMODULE mod)
    exports['FreeLibraryWhenCallbackReturns'] = (_ctx, _mem, args) => {
        const inst = tpInstances.get(args[0] >>> 0);
        if (inst) inst.freeLibrary = args[1] >>> 0;
        return { value: 0, stackCleanup: 8 };
    };

    exports['GetCurrentProcessorNumber'] = () => 0;

    exports['GetCurrentPackageId'] = (_ctx, _mem, args) => {
        const APPMODEL_ERROR_NO_PACKAGE = 15700;
        const bufferLength = args[0] >>> 0;
        if (bufferLength) Mem.writeUint32(bufferLength, 0);
        System.getInstance().scheduler.setLastError(APPMODEL_ERROR_NO_PACKAGE);
        return APPMODEL_ERROR_NO_PACKAGE;
    };

    // BOOL TrySubmitThreadpoolCallback(PTP_SIMPLE_CALLBACK pfns, PVOID pv, PTP_CALLBACK_ENVIRON pcbe)
    exports['TrySubmitThreadpoolCallback'] = (_ctx, _mem, args) => {
        const pfns = args[0] >>> 0;
        const pv = args[1] >>> 0;
        const sched = System.getInstance().scheduler;
        if (!pfns) {
            sched.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 12 };
        }
        const instance = beginInstance();
        // PTP_SIMPLE_CALLBACK(Instance, Context)
        if (!sched.postTimerCallback(pfns, [instance, pv], () => endInstance(instance))) {
            tpInstances.delete(instance);
            sched.setLastError(ERROR_NOT_ENOUGH_MEMORY);
            return { value: 0, stackCleanup: 12 };
        }
        return { value: 1, stackCleanup: 12 };
    };

    exports['CreateThreadpoolTimer'] = (_ctx, _mem, args) => {
        const handle = nextTpHandle++;
        tpTimers.set(handle, { ...newTracked(args[0] >>> 0, args[1] >>> 0), wheelId: null });
        System.getInstance().scheduler.ensureTimerPumpThread();
        return handle;
    };

    // VOID SetThreadpoolTimer(PTP_TIMER pti, PFILETIME pftDueTime, DWORD msPeriod, DWORD msWindowLength)
    // A NULL due time stops the timer; the window is a coalescing hint.
    exports['SetThreadpoolTimer'] = (_ctx, _mem, args) => {
        const handle = args[0] >>> 0;
        const pftDueTime = args[1] >>> 0;
        const msPeriod = args[2] >>> 0;
        const entry = tpTimers.get(handle);
        if (!entry) return 0;

        const wheel = System.getInstance().scheduler.timerWheel;
        if (entry.wheelId !== null) {
            wheel.cancel(entry.wheelId);
            entry.wheelId = null;
        }
        if (!pftDueTime) return 0;

        const dueMs = fileTimeToDelayMs(pftDueTime);
        const fire = () => {
            const timer = tpTimers.get(handle);
            if (!timer || !timer.callback) return;
            // PTP_TIMER_CALLBACK(PTP_CALLBACK_INSTANCE Instance, PVOID Context, PTP_TIMER Timer).
            postPoolCallback(timer, handle, []);
        };
        const arm = (delayMs: number, periodic: boolean, onFire: () => void) => wheel.add(
            Math.max(1, delayMs), periodic, TimerKind.WAITABLE_TIMER, onFire, TimeService.getInstance().nowMs());

        if (msPeriod > 0 && dueMs !== msPeriod) {
            // First expiry at the due time, then every period.
            entry.wheelId = arm(dueMs, false, () => {
                fire();
                const timer = tpTimers.get(handle);
                if (timer) timer.wheelId = arm(msPeriod, true, fire);
            });
        } else {
            entry.wheelId = arm(dueMs, msPeriod > 0, fire);
        }
        return 0;
    };

    // VOID WaitForThreadpoolTimerCallbacks(PTP_TIMER pti, BOOL fCancelPendingCallbacks)
    exports['WaitForThreadpoolTimerCallbacks'] = (ctx, _mem, args) =>
        waitForPoolCallbacks(ctx, tpTimers.get(args[0] >>> 0), args[0] >>> 0, args[1] !== 0);

    exports['CloseThreadpoolTimer'] = (_ctx, _mem, args) => {
        const handle = args[0] >>> 0;
        const entry = tpTimers.get(handle);
        if (entry?.wheelId !== null && entry?.wheelId !== undefined) {
            System.getInstance().scheduler.timerWheel.cancel(entry.wheelId);
        }
        tpTimers.delete(handle);
        return 0;
    };

    exports['CreateThreadpoolWait'] = (_ctx, _mem, args) => {
        const handle = nextTpHandle++;
        tpWaits.set(handle, { ...newTracked(args[0] >>> 0, args[1] >>> 0), pollId: null });
        System.getInstance().scheduler.ensureTimerPumpThread();
        return handle;
    };

    // VOID SetThreadpoolWait(PTP_WAIT pwa, HANDLE h, PFILETIME pftTimeout)
    // One-shot: the callback is queued once, with WAIT_OBJECT_0 or WAIT_TIMEOUT, and the wait
    // must be set again to fire again. A NULL handle stops waiting.
    exports['SetThreadpoolWait'] = (_ctx, _mem, args) => {
        const handle = args[0] >>> 0;
        const hObject = args[1] >>> 0;
        const pftTimeout = args[2] >>> 0;
        const entry = tpWaits.get(handle);
        if (!entry) return 0;
        stopWaitPoll(entry);
        if (!hObject) return 0;

        const sched = System.getInstance().scheduler;
        const time = TimeService.getInstance();
        const deadline = pftTimeout ? time.nowMs() + fileTimeToDelayMs(pftTimeout) : Infinity;
        const winmm = System.getInstance().process?.getModule('winmm') as { timerThreadId?: number } | undefined;

        const check = (): boolean => {
            const current = tpWaits.get(handle);
            if (current !== entry) return true;
            // The wait is satisfied on behalf of the pool thread that will run the callback.
            const signalled = sched.tryConsumeWait(hObject, winmm?.timerThreadId ?? 0);
            if (signalled === null) return true;
            if (signalled || time.nowMs() >= deadline) {
                stopWaitPoll(entry);
                // PTP_WAIT_CALLBACK(Instance, Context, Wait, WaitResult)
                postPoolCallback(entry, handle, [signalled ? WAIT_OBJECT_0 : WAIT_TIMEOUT]);
                return true;
            }
            return false;
        };
        if (!check()) {
            entry.pollId = sched.timerWheel.add(
                TP_WAIT_POLL_MS, true, TimerKind.WAITABLE_TIMER, () => { check(); }, time.nowMs());
        }
        return 0;
    };

    // VOID WaitForThreadpoolWaitCallbacks(PTP_WAIT pwa, BOOL fCancelPendingCallbacks)
    exports['WaitForThreadpoolWaitCallbacks'] = (ctx, _mem, args) =>
        waitForPoolCallbacks(ctx, tpWaits.get(args[0] >>> 0), args[0] >>> 0, args[1] !== 0);

    exports['CloseThreadpoolWait'] = (_ctx, _mem, args) => {
        const entry = tpWaits.get(args[0] >>> 0);
        if (entry) stopWaitPoll(entry);
        tpWaits.delete(args[0] >>> 0);
        return 0;
    };

    exports['CreateThreadpoolWork'] = (_ctx, _mem, args) => {
        const handle = nextTpHandle++;
        tpWork.set(handle, newTracked(args[0] >>> 0, args[1] >>> 0));
        return handle;
    };

    exports['SubmitThreadpoolWork'] = (ctx, _mem, args) => {
        const handle = args[0] >>> 0;
        const entry = tpWork.get(handle);
        if (!entry?.callback) return 0;

        const callbackManager = System.getInstance().process?.dispatcher?.callbackManager;
        if (!callbackManager) return 0;

        const STACK_CLEANUP = 4;
        const tid = System.getInstance().scheduler.getCurrentThreadId();
        const instance = beginInstance();
        trackStart(entry);
        entry.runningOn.add(tid);
        callbackManager.saveSuspendedThunkContext(ctx, STACK_CLEANUP);
        // PTP_WORK_CALLBACK(Instance, Context, Work)
        const { callbackId } = callbackManager.invokeCallback(
            entry.callback,
            [instance, entry.context, handle],
            12,
            () => {
                entry.runningOn.delete(tid);
                endInstance(instance);
                trackEnd(entry);
                return 0;
            },
            false,
            'SubmitThreadpoolWork',
        );

        return { value: 0, suspendedForCallback: true, callbackId, stackCleanup: STACK_CLEANUP };
    };

    // VOID WaitForThreadpoolWorkCallbacks(PTP_WORK pwk, BOOL fCancelPendingCallbacks)
    exports['WaitForThreadpoolWorkCallbacks'] = (ctx, _mem, args) =>
        waitForPoolCallbacks(ctx, tpWork.get(args[0] >>> 0), args[0] >>> 0, args[1] !== 0);

    exports['CloseThreadpoolWork'] = (_ctx, _mem, args) => {
        tpWork.delete(args[0] >>> 0);
        return 0;
    };

    return exports;
}

export const exports: Record<string, ThunkImplementation> = initVistaRuntime();
