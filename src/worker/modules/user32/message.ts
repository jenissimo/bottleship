/**
 * User32 Message functions
 *
 * Atomic implementation for message queue operations
 */

import { ThunkImplementation, FastPathImplementation, ThunkResult, X86Context } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Marshaler } from '../../core/memory/marshaler';
import { System } from '../../core/system';
import { TimeService } from '../../runtime/time';
import { TimerKind } from '../../core/scheduler/types';
import { hypercallDataManager } from '../../core/cpu/hypercall-data';
import { installHook, uninstallHook, getHooksOfType, getNextHookInChain, hasHooksOfType, pushActiveHook, popActiveHook, currentActiveHook, WH_KEYBOARD, WH_GETMESSAGE, WH_CBT, HC_ACTION, HC_NOREMOVE } from './hooks';
import { isSentinelWndProc } from './dialog';
import { handleSystemControlMessage, isContentChangingMessage } from './dialog-control-messages';
import { tryRichEditStreamMessage } from './rich-edit-stream';
import { eraseControlOverlayRect, repaintDialogAfterContentChange } from './dialog-paint';
import { handleAnimateMessage } from './animate-control';
import { windows, buttonCheckStates, registerWindowTimerKiller, finalizeWindowDestroy, getAbsoluteWindowPosition, getWindowByHandle, isEffectivelyVisible } from './shared-state';
import { validateWindow } from './paint-region';
import { repaintChildControls, isButtonSystemControl, hitTestSystemControlAtClient } from './controls';
import { isOwnerDrawButton } from './owner-draw';
import { runOwnerDrawButtonPaint } from './window';
import {
    handleSystemControlMouseAtScreen,
    handleSystemControlWheel,
    handleSystemControlKey,
    takePendingControlNotification,
} from './control-interaction';
import { encodeAnsi } from '../codepage-utils';
import { paintTraceEnabled, logPaintMsgDelivered, logPaintPendingBlocked, logPaintTrace } from './paint-trace';
import { isValidGuestEip } from '../../core/scheduler/scheduler-context';
import { WAIT_FAILED, WAIT_BLOCKED_NO_SWITCH } from '../../core/scheduler/types';
import { deliverPendingApcs } from '../kernel32/sync';

// MsgWaitForMultipleObjectsEx flags + the shared wait vocabulary.
const MWMO_WAITALL = 0x0001;
const MWMO_ALERTABLE = 0x0002;
const MWMO_INPUTAVAILABLE = 0x0004;
const MAXIMUM_WAIT_OBJECTS = 64;
const WAIT_OBJECT_0 = 0;
const ERROR_INVALID_PARAMETER = 87;

const WM_TIMER = 0x0113;
const WM_PAINT = 0x000F;
const USER_TIMER_MINIMUM = 10;

type TimerMessage = { hwnd: number; message: number; wParam: number; lParam: number };
let noteFastPathTimerDelivery: ((msg: TimerMessage, removed: boolean) => void) | null = null;

/**
 * Synchronously invoke a window's guest WndProc via the suspended-thunk callback
 * chain (the JS→x86 re-entry mechanism). Shared by DispatchMessage and SendMessage
 * so both use the SAME re-entry path (no second mechanism). The WndProc's return
 * value (LRESULT) is delivered back to the guest through `onReturn`, which maps it
 * to the value EAX receives when the suspended thunk resumes.
 *
 * @param stackCleanup stdcall bytes the *calling* thunk must pop
 *                     (DispatchMessage(lpMsg)=4; SendMessage(hwnd,msg,w,l)=16).
 * @param onReturn     maps the WndProc LRESULT to the guest-visible return value.
 * @returns a suspended-callback ThunkResult on success, or null when no callback
 *          manager is available (caller falls back to its default return).
 */
export function invokeGuestWndProcSync(
    ctx: X86Context,
    mem: Uint8Array,
    wndProc: number,
    hwnd: number,
    message: number,
    wParam: number,
    lParam: number,
    stackCleanup: number,
    tag: string,
    onReturn: (wndRet: number) => number | null,
): ThunkResult | null {
    const system = System.getInstance();
    const callbackManager = system.process?.dispatcher?.callbackManager;
    if (!callbackManager) return null;

    const msgView = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const thunkReturnAddr = msgView.getUint32(ctx.esp, true);
    const stubRange = callbackManager.getStubPoolRange();
    const reusedFrame = thunkReturnAddr >= stubRange.base && thunkReturnAddr < stubRange.end;
    const frameId = reusedFrame
        ? callbackManager.getActiveSuspendedFrameId()
        : callbackManager.saveSuspendedThunkContext(
            { ...ctx, returnAddr: thunkReturnAddr },
            stackCleanup,
            tag,
        );
    if (frameId === 0) {
        Logger.error(LogCategory.USER32,
            `${tag}: failed to save suspended context for msg=0x${message.toString(16)} hwnd=0x${hwnd.toString(16)}`);
        return { value: 0, stackCleanup };
    }

    const first = callbackManager.invokeCallback(
        wndProc,
        [hwnd, message, wParam, lParam],
        0,
        onReturn,
        false,
        tag,
        frameId,
    );
    if (first.callbackId === 0) {
        Logger.error(LogCategory.USER32,
            `${tag}: invokeCallback failed for msg=0x${message.toString(16)} hwnd=0x${hwnd.toString(16)}`);
        return { value: 0, stackCleanup };
    }

    return {
        value: 0,
        suspendedForCallback: true,
        callbackId: first.callbackId,
        stackCleanup,
        skipStackCheck: true,
        preserveCallbackReturnAddress: reusedFrame,
    };
}

/** Send a message synchronously when hwnd has a guest-visible WndProc. */
export function invokeWindowMessageSync(
    ctx: X86Context,
    mem: Uint8Array,
    hwnd: number,
    message: number,
    wParam: number,
    lParam: number,
    stackCleanup: number,
    tag: string,
    onReturn: (wndRet: number) => number | null,
): ThunkResult | null {
    const win = windows.get(hwnd);
    if (!win?.wndProc || isSentinelWndProc(win.wndProc)) return null;
    if (win.isSystemControl && !win.wndProcSubclassed) return null;
    return invokeGuestWndProcSync(
        ctx, mem, win.wndProc, hwnd, message, wParam, lParam,
        stackCleanup, tag, onReturn,
    );
}

export function createMessageExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    const WM_QUIT = 0x0012;
    const WM_NULL = 0x0000;
    const PM_NOREMOVE = 0x0000;
    const PM_REMOVE = 0x0001;
    const ERROR_TIMEOUT = 1460;
    const ERROR_INVALID_WINDOW_HANDLE = 1400;
    const SMTO_ABORTIFHUNG = 0x0002;
    const SMTO_ERRORONEXIT = 0x0020;
    let lastPeekLog = 0;
    let peekCalls = 0;
    let peekHits = 0;

    interface TimerState {
        wheelTimerId: number;
        hWnd: number;
        timerId: number;
        timerFunc: number;
        intervalMs: number;
        pendingTicks: number;
    }

    interface TimerDiagCounters {
        ticks: number;
        skippedV86: number;
        skippedAsync: number;
        skippedCallbackBusy: number;
        posted: number;
        delivered: number;
        dispatched: number;
        callbackInvoked: number;
        wakeWaiters: number;
        pendingQueued: number;
        pendingFlushed: number;
        pendingDropped: number;
    }

    const timerDiagConfig = {
        enabled: false,
        queueSkippedMessageTimers: false,
        flushMaxPerTick: 4,
        logIntervalMs: 500,
    };

    const timerDiag: TimerDiagCounters = {
        ticks: 0,
        skippedV86: 0,
        skippedAsync: 0,
        skippedCallbackBusy: 0,
        posted: 0,
        delivered: 0,
        dispatched: 0,
        callbackInvoked: 0,
        wakeWaiters: 0,
        pendingQueued: 0,
        pendingFlushed: 0,
        pendingDropped: 0,
    };
    let timerDiagLastLogMs = performance.now();
    let timerDiagLastHcCallCount = hypercallDataManager.getCallCount();

    // Keyed by "hwnd:id" — timer ids are PER-WINDOW in Win32, so two windows may each
    // own a timer with the same id (e.g. HL's menu buttons all SetTimer(hwnd, 1, ...)).
    // Keying by id alone made the second SetTimer overwrite the first's map entry while
    // its timer kept running orphaned (unkillable) → runaway hover-glow repaints.
    const timers: Map<string, TimerState> = new Map();
    const timerKey = (hWnd: number, id: number) => `${hWnd >>> 0}:${id >>> 0}`;
    let nextTimerId = 1;

    function cancelTimerState(state: TimerState): void {
        System.getInstance().scheduler?.timerWheel.cancel(state.wheelTimerId);
    }

    function armTimerState(state: TimerState): void {
        state.wheelTimerId = System.getInstance().scheduler.timerWheel.add(
            state.intervalMs,
            false,
            TimerKind.USER32_TIMER,
            () => {
                const system = System.getInstance();
                if (system.isExiting || timers.get(timerKey(state.hWnd, state.timerId)) !== state) return;
                timerDiag.ticks++;

                // USER timers are synthesized messages, not periodic host callbacks.
                // Once due, Win32 keeps one timer in the expired set and restarts it
                // only when Get/PeekMessage removes that WM_TIMER (Wine queue.c:
                // find_expired_timer -> restart_timer). Reposting while the previous
                // tick is pending can leave an MFC modal loop permanently non-idle.
                postTimerMessages(system, state, 1);
                maybeLogTimerDiag();
            },
            TimeService.getInstance().nowMs(),
        );
    }

    function restartRemovedTimer(msg: { hwnd: number; message: number; wParam: number; lParam: number }): void {
        if (msg.message !== WM_TIMER) return;
        const state = timers.get(timerKey(msg.hwnd, msg.wParam));
        if (!state || state.timerFunc !== (msg.lParam >>> 0)) return;
        armTimerState(state);
    }

    noteFastPathTimerDelivery = (msg, removed) => {
        timerDiag.delivered++;
        if (removed) restartRemovedTimer(msg);
    };

    // Win32: DestroyWindow destroys all timers owned by that window. Called from
    // window.ts DestroyWindow via the shared-state hook. Without this, a destroyed
    // window's orphaned timer keeps posting WM_TIMER to the dead hwnd (e.g.
    // HL owner-draw skill button with a live hover timer killed by EndDialog) →
    // MFC pre-translates it → FromHandlePermanent returns the freed CWnd → garbage
    // vtable call → crash.
    function killTimersForWindow(hWnd: number): void {
        const prefix = `${hWnd >>> 0}:`;
        for (const [key, state] of timers) {
            if (key.startsWith(prefix)) {
                cancelTimerState(state);
                if (state.pendingTicks > 0) {
                    timerDiag.pendingDropped += state.pendingTicks;
                    state.pendingTicks = 0;
                }
                timers.delete(key);
            }
        }
    }
    registerWindowTimerKiller(killTimersForWindow);

    // Last owner-draw child we forwarded a WM_MOUSEMOVE to, so we only re-post on ENTER
    // (the child's own hover timer then polls the cursor) instead of on every move.
    let lastHoverChildHwnd = 0;

    function getTotalPendingTicks(): number {
        let total = 0;
        for (const t of timers.values()) total += t.pendingTicks;
        return total;
    }

    function resetTimerDiagCounters(): void {
        timerDiag.ticks = 0;
        timerDiag.skippedV86 = 0;
        timerDiag.skippedAsync = 0;
        timerDiag.skippedCallbackBusy = 0;
        timerDiag.posted = 0;
        timerDiag.delivered = 0;
        timerDiag.dispatched = 0;
        timerDiag.callbackInvoked = 0;
        timerDiag.wakeWaiters = 0;
        timerDiag.pendingQueued = 0;
        timerDiag.pendingFlushed = 0;
        timerDiag.pendingDropped = 0;
    }

    function maybeLogTimerDiag(): void {
        return;
    }

    function postTimerMessages(system: System, state: TimerState, basePosts: number): void {
        let toPost = basePosts;
        if (state.pendingTicks > 0) {
            if (timerDiagConfig.queueSkippedMessageTimers) {
                const flushBudget = Math.max(0, timerDiagConfig.flushMaxPerTick | 0);
                const flushed = Math.min(state.pendingTicks, flushBudget);
                if (flushed > 0) {
                    state.pendingTicks -= flushed;
                    timerDiag.pendingFlushed += flushed;
                    toPost += flushed;
                }
            } else {
                timerDiag.pendingDropped += state.pendingTicks;
                state.pendingTicks = 0;
            }
        }

        for (let i = 0; i < toPost; i++) {
            system.windowManager.postMessage(state.hWnd, WM_TIMER, state.timerId, state.timerFunc);
            timerDiag.posted++;
        }
        if (toPost > 0) {
            system.scheduler.wakeMessageWaiters();
            timerDiag.wakeWaiters++;
        }
    }

    const diagApi = globalThis as Record<string, any>;
    const bindMsgTimerDiag = (prefix: string) => {
        diagApi[`${prefix}SetEnabled`] = (enabled: boolean): boolean => {
            timerDiagConfig.enabled = !!enabled;
            return timerDiagConfig.enabled;
        };
        diagApi[`${prefix}SetIntervalMs`] = (value: number): number => {
            const parsed = Number.isFinite(value) ? Math.max(100, value | 0) : timerDiagConfig.logIntervalMs;
            timerDiagConfig.logIntervalMs = parsed;
            return timerDiagConfig.logIntervalMs;
        };
        diagApi[`${prefix}SetQueueSkipped`] = (enabled: boolean): boolean => {
            timerDiagConfig.queueSkippedMessageTimers = !!enabled;
            return timerDiagConfig.queueSkippedMessageTimers;
        };
        diagApi[`${prefix}SetFlushMax`] = (value: number): number => {
            const parsed = Number.isFinite(value) ? Math.max(0, value | 0) : timerDiagConfig.flushMaxPerTick;
            timerDiagConfig.flushMaxPerTick = parsed;
            return timerDiagConfig.flushMaxPerTick;
        };
        diagApi[`${prefix}GetConfig`] = (): Record<string, number | boolean> => ({
            enabled: timerDiagConfig.enabled,
            queueSkippedMessageTimers: timerDiagConfig.queueSkippedMessageTimers,
            flushMaxPerTick: timerDiagConfig.flushMaxPerTick,
            logIntervalMs: timerDiagConfig.logIntervalMs,
            pendingTicks: getTotalPendingTicks(),
        });
        diagApi[`${prefix}LogNow`] = (): void => {
            timerDiagLastLogMs = 0;
            maybeLogTimerDiag();
        };
    };
    bindMsgTimerDiag("msgTimerDiag");
    bindMsgTimerDiag("h3TimerDiag"); // deprecated alias

    function writeMsgToMemory(mem: Uint8Array, lpMsg: number, msg: any) {
        if (lpMsg) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lpMsg, msg.hwnd, true);      // hwnd
            view.setUint32(lpMsg + 4, msg.message, true); // message
            view.setUint32(lpMsg + 8, msg.wParam, true);  // wParam
            view.setUint32(lpMsg + 12, msg.lParam, true); // lParam
            view.setUint32(lpMsg + 16, msg.time, true);   // time
            // pt (POINT) is 8 bytes at offset 20 - screen coordinates
            const ptX = msg.ptX ?? 0;
            const ptY = msg.ptY ?? 0;
            view.setInt32(lpMsg + 20, ptX | 0, true);    // pt.x
            view.setInt32(lpMsg + 24, ptY | 0, true);    // pt.y
        }
    }

    /** Check whether WM_QUIT (0x0012) passes the message filter range. */
    function isQuitInFilterRange(wMsgFilterMin: number, wMsgFilterMax: number): boolean {
        if (wMsgFilterMin === 0 && wMsgFilterMax === 0) return true; // No filter
        return WM_QUIT >= wMsgFilterMin && WM_QUIT <= wMsgFilterMax;
    }

    /** WH_KEYBOARD fires only for raw key up/down retrieval, not char messages. */
    function isKeyboardHookMessage(message: number): boolean {
        return message === 0x0100 || message === 0x0101 || message === 0x0104 || message === 0x0105;
    }

    /** WH_KEYBOARD hooks visible to the calling thread (dwThreadId 0 = all). */
    function keyboardHooksFor(threadId: number) {
        if (!hasHooksOfType(WH_KEYBOARD)) return [];
        return getHooksOfType(WH_KEYBOARD).filter(h => h.dwThreadId === 0 || h.dwThreadId === threadId);
    }

    /** WH_GETMESSAGE hooks visible to the calling thread (dwThreadId 0 = all). */
    function getMessageHooksFor(threadId: number) {
        if (!hasHooksOfType(WH_GETMESSAGE)) return [];
        return getHooksOfType(WH_GETMESSAGE).filter(h => h.dwThreadId === 0 || h.dwThreadId === threadId);
    }

    /**
     * Invoke a hook proc while marking it as the active hook, so CallNextHookEx can
     * locate the current hook even when the guest passes NULL for hhk. The push is
     * balanced by a pop in the wrapped completeThunk (fires when the proc returns) and
     * by a pop on invoke failure. Mirrors callbackManager.invokeCallback's return shape.
     */
    function invokeHookProc(
        callbackManager: any,
        handle: number,
        lpfn: number,
        args: number[],
        completeThunk: (ret: number) => number | null,
        frameId: number,
        label: string,
    ): { callbackId: number } {
        pushActiveHook(handle);
        const res = callbackManager.invokeCallback(
            lpfn, args, 0,
            (ret: number) => { popActiveHook(); return completeThunk(ret); },
            false, label, frameId,
        );
        if (!res.callbackId) popActiveHook();
        return res;
    }

    /** Read a MSG struct back from guest memory (inverse of writeMsgToMemory). */
    function readMsgFromMemory(mem: Uint8Array, lpMsg: number) {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        return {
            hwnd: view.getUint32(lpMsg, true),
            message: view.getUint32(lpMsg + 4, true),
            wParam: view.getUint32(lpMsg + 8, true),
            lParam: view.getUint32(lpMsg + 12, true),
            time: view.getUint32(lpMsg + 16, true),
            ptX: view.getInt32(lpMsg + 20, true),
            ptY: view.getInt32(lpMsg + 24, true),
        };
    }

    /**
     * Fire the topmost WH_GETMESSAGE hook on the message that Get/PeekMessage is
     * about to return. Unlike WH_KEYBOARD this is NOT a filter — the hook return is
     * ignored and the message cannot be discarded — but the hook receives a POINTER
     * to the MSG (lParam) and may rewrite its fields in place (MFC, shells, macro
     * recorders, accessibility tools use it for exactly this). Contract (per
     * USER32 xxxCallHook / input.c): nCode = HC_ACTION when removing (PM_REMOVE) or
     * HC_NOREMOVE on a PM_NOREMOVE peek; wParam = the remove flag; lParam = &MSG.
     *
     * The caller must have already written `m` to guest `lpMsg` (so the hook sees
     * it). On the hook's return we RE-READ `lpMsg` — the delivered message is
     * whatever the hook left there — and map it through `finishValue`. We do NOT
     * rewrite lpMsg (that would clobber the hook's edits).
     *
     * Returns a number (message delivered directly — no hook installed / callback
     * machinery declined) or { callbackId } when the guest hook proc was queued on
     * `frameId` and the thunk must stay suspended.
     */
    function applyGetMessageHook(
        frameId: number,
        m: any | null,
        remove: boolean,
        threadId: number,
        lpMsg: number,
        finishValue: (msg: any | null) => number,
        label: string,
        callbackManager: any,
        freshMem: () => Uint8Array | null,
    ): number | { callbackId: number } {
        if (!m || !lpMsg) return finishValue(m);
        const hooks = getMessageHooksFor(threadId);
        if (hooks.length === 0) return finishValue(m);
        const hook = hooks[0]; // topmost; further chaining is the hook's CallNextHookEx
        const nCode = remove ? HC_ACTION : HC_NOREMOVE;
        const removeFlag = remove ? PM_REMOVE : PM_NOREMOVE;
        const res = invokeHookProc(
            callbackManager, hook.handle, hook.lpfn, [nCode, removeFlag, lpMsg],
            (_hookRet: number): number => {
                // Return value is ignored; re-read the (possibly rewritten) MSG.
                const mem = freshMem();
                const delivered = mem ? readMsgFromMemory(mem, lpMsg) : m;
                return finishValue(delivered);
            },
            frameId, label,
        );
        if (!res.callbackId) return finishValue(m);
        Logger.verbose(LogCategory.USER32,
            `${label}: WH_GETMESSAGE hook 0x${hook.lpfn.toString(16)} nCode=${nCode} msg=0x${m.message.toString(16)}`);
        return { callbackId: res.callbackId };
    }

    /**
     * Standalone WH_GETMESSAGE dispatch for the case where no WH_KEYBOARD chain ran
     * on this message (non-key message, or no keyboard hook). Suspends the current
     * thunk, writes the message to guest lpMsg, runs the hook, and re-reads on
     * completion. Returns a suspended ThunkResult, or null when the caller should
     * deliver normally (no hooks / callback machinery unavailable / null lpMsg).
     */
    function dispatchGetMessageHook(
        ctx: any,
        msg: any,
        remove: boolean,
        threadId: number,
        lpMsg: number,
        stackCleanup: number,
        finishValue: (msg: any | null) => number,
        label: string,
    ): any | null {
        const system = System.getInstance();
        const callbackManager = system.process?.dispatcher?.callbackManager;
        if (!callbackManager || !lpMsg || !msg) return null;
        if (getMessageHooksFor(threadId).length === 0) return null;

        const frameId = callbackManager.saveSuspendedThunkContext(ctx, stackCleanup, label);
        if (!frameId) return null;

        const freshMem = (): Uint8Array | null => {
            const v86 = system.process?.v86;
            return v86?.mem8 || (v86?.v86 && v86.v86.cpu?.mem8) || null;
        };
        const mem = freshMem();
        if (mem) writeMsgToMemory(mem, lpMsg, msg);

        const r = applyGetMessageHook(frameId, msg, remove, threadId, lpMsg, finishValue, label, callbackManager, freshMem);
        if (typeof r === 'number') return null; // hook declined to queue; caller delivers normally
        return { value: 0, suspendedForCallback: true, callbackId: r.callbackId, stackCleanup };
    }

    /**
     * Real USER32 invokes the topmost WH_KEYBOARD hook proc from INSIDE
     * GetMessage/PeekMessage whenever a WM_(SYS)KEY(DOWN|UP) is about to be
     * returned: nCode = HC_ACTION (removing) or HC_NOREMOVE (PM_NOREMOVE peek),
     * wParam = VK, lParam = keystroke flags. A nonzero hook return discards the
     * message and retrieval continues with the next one. Games hang whole input
     * layers off this (Max Payne reads ESC/F5/console solely via its hook), so
     * delivering the message without firing the hook silently kills those keys.
     *
     * Suspends the current thunk to run the guest hook proc; returns the
     * suspension object to return from the export, or null when the caller
     * should deliver normally (no hooks / callback machinery unavailable).
     * `finishValue(msg)` maps the finally-delivered message (null = queue ran
     * dry after a discard) to the thunk's return value.
     */
    function dispatchKeyboardHookChain(
        ctx: any,
        firstMsg: any,
        remove: boolean,
        wMsgFilterMin: number,
        wMsgFilterMax: number,
        threadId: number,
        lpMsg: number,
        stackCleanup: number,
        finishValue: (msg: any | null) => number,
        label: string,
    ): any | null {
        const system = System.getInstance();
        const callbackManager = system.process?.dispatcher?.callbackManager;
        if (!callbackManager) return null;
        const hooks = keyboardHooksFor(threadId);
        if (hooks.length === 0) return null;
        const hook = hooks[0]; // topmost; chain propagation is the hook's CallNextHookEx call

        const frameId = callbackManager.saveSuspendedThunkContext(ctx, stackCleanup, label);
        if (!frameId) return null;

        const freshMem = (): Uint8Array | null => {
            const v86 = system.process?.v86;
            return v86?.mem8 || (v86?.v86 && v86.v86.cpu?.mem8) || null;
        };
        const nCode = remove ? HC_ACTION : HC_NOREMOVE;
        let current = firstMsg;

        // A keyboard-hook-approved message is the one Get/PeekMessage will return, so
        // it must ALSO pass through any WH_GETMESSAGE hook before delivery (real USER32
        // fires WH_GETMESSAGE on the finally-selected message). Write it to lpMsg, then
        // let applyGetMessageHook run the getmsg hook (reusing frameId) — returning null
        // keeps the thunk suspended for that second callback. null message = queue ran
        // dry after a discard (nothing to fire WH_GETMESSAGE on).
        const deliver = (m: any | null): number | null => {
            const mem = freshMem();
            if (mem && m) writeMsgToMemory(mem, lpMsg, m);
            const r = applyGetMessageHook(frameId, m, remove, threadId, lpMsg, finishValue, label, callbackManager, freshMem);
            return typeof r === 'number' ? r : null;
        };

        const completeThunk = (hookRet: number): number | null => {
            if (hookRet === 0) {
                return deliver(current);
            }
            // Nonzero -> discard. PM_NOREMOVE left it queued; consume it now.
            Logger.log(LogCategory.USER32,
                `${label}: WH_KEYBOARD hook discarded msg=0x${current.message.toString(16)} vk=0x${current.wParam.toString(16)}`);
            if (!remove) system.windowManager.peekMessage(true, wMsgFilterMin, wMsgFilterMax, threadId);
            const next = system.windowManager.peekMessage(remove, wMsgFilterMin, wMsgFilterMax, threadId);
            if (next && isKeyboardHookMessage(next.message)) {
                current = next;
                invokeHookProc(
                    callbackManager, hook.handle, hook.lpfn, [nCode, next.wParam, next.lParam],
                    completeThunk, frameId, label,
                );
                return null;
            }
            return deliver(next ?? null);
        };

        const first = invokeHookProc(
            callbackManager, hook.handle, hook.lpfn, [nCode, firstMsg.wParam, firstMsg.lParam],
            completeThunk, frameId, label,
        );
        if (!first.callbackId) return null;
        Logger.verbose(LogCategory.USER32,
            `${label}: WH_KEYBOARD hook 0x${hook.lpfn.toString(16)} nCode=${nCode} vk=0x${firstMsg.wParam.toString(16)}`);
        // value is ignored for suspended thunks (EAX is set from completeThunk's
        // return when the callback unwinds); the real return flows through finishValue.
        return { value: 0, suspendedForCallback: true, callbackId: first.callbackId, stackCleanup };
    }

    /** Write a synthesized WM_QUIT MSG struct to guest memory. */
    function writeQuitMsg(mem: Uint8Array, lpMsg: number, exitCode: number): void {
        if (!lpMsg) return;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lpMsg, 0, true);             // hwnd = NULL
        view.setUint32(lpMsg + 4, WM_QUIT, true);   // message = WM_QUIT
        view.setUint32(lpMsg + 8, exitCode, true);   // wParam = exit code
        view.setUint32(lpMsg + 12, 0, true);         // lParam = 0
        view.setUint32(lpMsg + 16, TimeService.getInstance().nowMs() | 0, true); // time
        view.setInt32(lpMsg + 20, 0, true);          // pt.x
        view.setInt32(lpMsg + 24, 0, true);          // pt.y
    }

    exports['GetMessageW'] = (ctx, mem, args) => {
        const lpMsg = args[0];
        const hWnd = args[1];
        const wMsgFilterMin = args[2];
        const wMsgFilterMax = args[3];

        const system = System.getInstance();

        // Flush any pending SAB input into the queue before waiting.
        system.inputManager.poll(true);

        // Sync fast path: try to dequeue a message without going async.
        const currentThreadId = system.scheduler.getCurrentThreadId();
        const msg = system.windowManager.peekMessage(true, wMsgFilterMin, wMsgFilterMax, currentThreadId);
        if (msg) {
            restartRemovedTimer(msg);
            const retVal = msg.message === WM_QUIT ? 0 : 1;
            if (paintTraceEnabled) logPaintMsgDelivered('GetMessageW(sync)', msg.hwnd, msg.message, {
                ret: retVal,
                filterMin: wMsgFilterMin,
                filterMax: wMsgFilterMax,
            });
            Logger.verboseLazy(LogCategory.USER32, () =>
                `GetMessageW(sync): msg=0x${msg.message.toString(16)} hwnd=0x${msg.hwnd.toString(16)} -> ${retVal} thread=${currentThreadId}`);
            if (isKeyboardHookMessage(msg.message)) {
                // GetMessage blocking semantics vs discard-to-empty: delivering
                // WM_NULL would be wrong, but a hook that discards is expected to
                // have consumed the keystroke; falling back to retVal 1 with the
                // already-written previous MSG content matches "discarded" closely
                // enough that we accept it (finishValue(null) -> 1 + untouched lpMsg
                // never happens for well-behaved hooks; logged in the chain).
                const suspended = dispatchKeyboardHookChain(
                    ctx, msg, true, wMsgFilterMin, wMsgFilterMax, currentThreadId,
                    lpMsg, 16, (delivered) => (delivered ? (delivered.message === WM_QUIT ? 0 : 1) : 1), 'GetMessage:WH_KEYBOARD',
                );
                // Keyboard chain applies WH_GETMESSAGE internally on delivery.
                if (suspended) return suspended;
            }
            // WH_GETMESSAGE fires on the message about to be returned (any message,
            // not just keys) unless a keyboard chain already handled it above.
            const gm = dispatchGetMessageHook(
                ctx, msg, true, currentThreadId, lpMsg, 16,
                (delivered) => (delivered ? (delivered.message === WM_QUIT ? 0 : 1) : 1), 'GetMessage:WH_GETMESSAGE',
            );
            if (gm) return gm;
            writeMsgToMemory(mem, lpMsg, msg);
            return { value: retVal, stackCleanup: 16 };
        }

        // Queue empty — synthesize WM_QUIT if the per-thread flag is set
        if (isQuitInFilterRange(wMsgFilterMin, wMsgFilterMax)) {
            const quitState = system.scheduler.getQuitState(currentThreadId);
            if (quitState && quitState.posted) {
                system.scheduler.clearQuitFlag(currentThreadId);
                Logger.log(LogCategory.USER32, `GetMessageW(sync): synthesizing WM_QUIT exitCode=${quitState.exitCode} for thread=${currentThreadId}`);
                writeQuitMsg(mem, lpMsg, quitState.exitCode);
                return { value: 0, stackCleanup: 16 };
            }
        }

        // Async slow path: no message available, must block.
        Logger.verbose(LogCategory.USER32, `GetMessageW(0x${lpMsg.toString(16)}, 0x${hWnd.toString(16)}, ${wMsgFilterMin}, ${wMsgFilterMax}) - waiting...`);

        const asyncBody = async () => {
            // Loop until we get a REAL message. waitForMessage returns WM_NULL as
            // an idle timeout signal (4ms), but real Windows GetMessage blocks until
            // a genuine message arrives. Returning WM_NULL with hwnd=0 to the game
            // causes crashes when null messages are processed (e.g. some galaxy.dll builds).
            let waitMsg: { hwnd: number; message: number; wParam: number; lParam: number; time: number; ptX?: number; ptY?: number };
            for (;;) {
                waitMsg = await system.windowManager.waitForMessage(currentThreadId);

                // If paused, block return to v86 until unpaused.
                while (system.isPaused) {
                    await new Promise(resolve => setTimeout(resolve, 30));
                }

                // WM_NULL from timeout — check quit flag, otherwise keep waiting
                if (waitMsg.message === WM_NULL && waitMsg.hwnd === 0) {
                    if (isQuitInFilterRange(wMsgFilterMin, wMsgFilterMax)) {
                        const quitState = system.scheduler.getQuitState(currentThreadId);
                        if (quitState && quitState.posted) {
                            system.scheduler.clearQuitFlag(currentThreadId);
                            // Note: Get fresh memory reference after async operation!
                            const process = system.process;
                            const v86 = process?.v86;
                            const freshMem = v86?.mem8 || (v86?.v86 && v86.v86.cpu?.mem8);
                            if (!freshMem) {
                                Logger.error(LogCategory.USER32, `GetMessageW: cannot get fresh memory reference!`);
                                return { value: 0, stackCleanup: 16 };
                            }
                            Logger.log(LogCategory.USER32, `GetMessageW(async): synthesizing WM_QUIT exitCode=${quitState.exitCode} for thread=${currentThreadId}`);
                            writeQuitMsg(freshMem, lpMsg, quitState.exitCode);
                            return { value: 0, stackCleanup: 16 };
                        }
                    }
                    // No quit pending — keep blocking (real Windows behavior)
                    continue;
                }

                // Got a real message — break out
                break;
            }

            restartRemovedTimer(waitMsg);

            // Note: Get fresh memory reference after async operation!
            const process = system.process;
            const v86 = process?.v86;
            const freshMem = v86?.mem8 || (v86?.v86 && v86.v86.cpu?.mem8);
            if (!freshMem) {
                Logger.error(LogCategory.USER32, `GetMessageW: cannot get fresh memory reference!`);
                return { value: 0, stackCleanup: 16 };
            }

            const keyHookPending = isKeyboardHookMessage(waitMsg.message) && keyboardHooksFor(currentThreadId).length > 0;
            const getMsgHookPending = getMessageHooksFor(currentThreadId).length > 0;
            if (keyHookPending || getMsgHookPending) {
                // Async wake path can't suspend for a guest callback (thunk context
                // already transformed). Rare for WH_KEYBOARD: MFC-style pumps only call
                // GetMessage after PeekMessage(PM_NOREMOVE) said a message exists, which
                // routes through the sync branch above. WH_GETMESSAGE (fires on every
                // message) surfaces here more often — a known gap on the blocking path.
                Logger.warn(LogCategory.USER32,
                    `GetMessageW(async): delivering msg=0x${waitMsg.message.toString(16)} WITHOUT ` +
                    `${keyHookPending ? 'WH_KEYBOARD' : 'WH_GETMESSAGE'} hook dispatch`);
            }
            const retVal = waitMsg.message === WM_QUIT ? 0 : 1;
            if (paintTraceEnabled) logPaintMsgDelivered('GetMessageW(async)', waitMsg.hwnd, waitMsg.message, {
                ret: retVal,
                filterMin: wMsgFilterMin,
                filterMax: wMsgFilterMax,
            });
            Logger.verboseLazy(LogCategory.USER32, () =>
                `GetMessageW(async): msg=0x${waitMsg.message.toString(16)} hwnd=0x${waitMsg.hwnd.toString(16)} -> ${retVal} thread=${currentThreadId}`);

            writeMsgToMemory(freshMem, lpMsg, waitMsg);
            return { value: retVal, stackCleanup: 16 };
        };

        return asyncBody();
    };

    exports['GetMessageA'] = exports['GetMessageW'];

    exports['WaitMessage'] = (ctx, mem, args) => {
        const system = System.getInstance();
        const currentThreadId = system.scheduler.getCurrentThreadId();

        // Flush SAB input before checking — same as GetMessage.
        system.inputManager.poll(true);

        if (system.windowManager.hasMessages(0, 0, currentThreadId)) {
            return 1; // TRUE — queue already has a message
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const returnAddr = view.getUint32(ctx.esp >>> 0, true) >>> 0;
        const postReturnEsp = (ctx.esp + 4) >>> 0;

        if (!isValidGuestEip(returnAddr)) {
            Logger.warn(LogCategory.USER32,
                `WaitMessage: bad returnAddr=0x${returnAddr.toString(16)} ESP=0x${ctx.esp.toString(16)}`);
            return 1;
        }

        Logger.verbose(LogCategory.USER32, `WaitMessage() - blocking thread=${currentThreadId}`);

        const blocked = system.scheduler.waitForMessage(
            returnAddr,
            postReturnEsp,
            { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags },
        );
        if (!blocked) {
            return 1;
        }

        // Thread is WAITING(MESSAGE); park at spin loop until postMessage wakes it.
        return { value: 1, blockedNoSwitch: true, stackCleanup: 0 };
    };

    /**
     * MsgWaitForMultipleObjects(Ex) — wait on handles OR on this thread's input queue.
     *
     * Win32 implements it by appending the thread's message-queue handle to the array
     * and doing an ordinary wait over nCount+1 objects, which is why the queue's leg is
     * reported as WAIT_OBJECT_0 + nCount; the scheduler mirrors that shape. Callers
     * routinely branch on the exact value (LS3D's worker loop re-waits on anything that
     * is not WAIT_OBJECT_0), so an out-of-contract return is not a soft failure — it
     * sends the guest down a path Windows never produces.
     *
     * MWMO_INPUTAVAILABLE decides whether input ALREADY queued satisfies the wait;
     * without it only input arriving after the call does. `dwWakeMask` is honoured only
     * as "any input" — the queue does not carry per-QS_* class bits — which over-reports
     * for a narrow mask. That direction is the safe one: the caller pumps, finds nothing
     * it wants, and waits again, whereas under-reporting would hang it.
     */
    const msgWaitForMultipleObjects = (
        ctx: X86Context, mem: Uint8Array,
        nCount: number, lpHandles: number, dwMilliseconds: number, dwWakeMask: number, dwFlags: number,
    ): ThunkResult | number => {
        const system = System.getInstance();
        const sched = system.scheduler;
        const stackCleanup = 20; // 5 stdcall args, both entry points

        // Windows caps the array one below MAXIMUM_WAIT_OBJECTS: the queue takes a slot.
        if (nCount > MAXIMUM_WAIT_OBJECTS - 1 || (nCount > 0 && lpHandles === 0)) {
            sched.setLastError(ERROR_INVALID_PARAMETER);
            return WAIT_FAILED;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        if (nCount > 0 && lpHandles + nCount * 4 > mem.length) {
            sched.setLastError(ERROR_INVALID_PARAMETER);
            return WAIT_FAILED;
        }
        const handles: number[] = [];
        for (let i = 0; i < nCount; i++) handles.push(view.getUint32(lpHandles + i * 4, true) >>> 0);

        const waitAll = (dwFlags & MWMO_WAITALL) !== 0;
        const alertable = (dwFlags & MWMO_ALERTABLE) !== 0;
        const inputResult = WAIT_OBJECT_0 + nCount;
        const currentThreadId = sched.getCurrentThreadId();

        // Flush SAB input into the queue first — same as GetMessage/WaitMessage, so
        // "is there input" is asked of a queue that is up to date.
        system.inputManager.poll(true);
        if ((dwFlags & MWMO_INPUTAVAILABLE) !== 0
            && system.windowManager.hasMessages(0, 0, currentThreadId)) {
            return inputResult;
        }

        if (alertable) {
            const apcResult = deliverPendingApcs(ctx, 'MsgWaitForMultipleObjectsEx:APC', stackCleanup);
            if (apcResult) return apcResult;
        }

        const returnAddr = view.getUint32(ctx.esp >>> 0, true) >>> 0;
        const postReturnEsp = (ctx.esp + 4 + stackCleanup) >>> 0;

        const result = sched.waitForObjectsOrMessageWithContext(
            handles, waitAll, dwMilliseconds, inputResult,
            returnAddr, postReturnEsp,
            { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags },
            alertable,
        );

        if (result === WAIT_BLOCKED_NO_SWITCH) {
            return { value: 0, blockedNoSwitch: true, stackCleanup };
        }
        return result;
    };

    exports['MsgWaitForMultipleObjects'] = (ctx, mem, args) => msgWaitForMultipleObjects(
        ctx, mem, args[0] >>> 0, args[1] >>> 0, args[3] >>> 0, args[4] >>> 0,
        args[2] !== 0 ? MWMO_WAITALL : 0,
    );

    exports['MsgWaitForMultipleObjectsEx'] = (ctx, mem, args) => msgWaitForMultipleObjects(
        ctx, mem, args[0] >>> 0, args[1] >>> 0, args[2] >>> 0, args[3] >>> 0, args[4] >>> 0,
    );

    exports['WaitForInputIdle'] = (ctx, mem, args) => {
        const hProcess = args[0] >>> 0;
        const dwMilliseconds = args[1] >>> 0;
        Logger.verbose(
            LogCategory.USER32,
            `WaitForInputIdle(hProcess=0x${hProcess.toString(16)}, timeout=${dwMilliseconds}) -> WAIT_OBJECT_0`
        );
        // Minimal compatibility behavior: current process is considered input-idle.
        return 0; // WAIT_OBJECT_0
    };

    exports['PeekMessageW'] = (ctx, mem, args) => {
        const lpMsg = args[0];
        const hWnd = args[1];
        const wMsgFilterMin = args[2];
        const wMsgFilterMax = args[3];
        const wRemoveMsg = args[4];

        const system = System.getInstance();

        // Poll input from SAB so mouse/keyboard events are available in the queue.
        // During synchronous v86 execution, setInterval can't fire, making this
        // the only opportunity to read fresh input.
        system.inputManager.poll();
        maybeLogTimerDiag();

        const callerThreadId = system.scheduler.getCurrentThreadId();
        const msg = system.windowManager.peekMessage(wRemoveMsg !== 0, wMsgFilterMin, wMsgFilterMax, callerThreadId);
        const now = performance.now();
        peekCalls++;
        if (msg) peekHits++;
        if (now - lastPeekLog >= 1000) {
            Logger.log(
                LogCategory.USER32,
                `PeekMessageW(hwnd=0x${hWnd.toString(16)}, min=${wMsgFilterMin}, max=${wMsgFilterMax}, remove=${wRemoveMsg}) calls=${peekCalls} hits=${peekHits}`
            );
            lastPeekLog = now;
            peekCalls = 0;
            peekHits = 0;
        }

        if (!msg) {
            if (paintTraceEnabled && system.windowManager.hasMessages(WM_PAINT, WM_PAINT, callerThreadId)) {
                logPaintPendingBlocked('PeekMessageW', wMsgFilterMin, wMsgFilterMax, wRemoveMsg !== 0);
            }
            // Queue empty — synthesize WM_QUIT if per-thread flag is set
            if (isQuitInFilterRange(wMsgFilterMin, wMsgFilterMax)) {
                const quitState = system.scheduler.getQuitState(callerThreadId);
                if (quitState && quitState.posted) {
                    if (wRemoveMsg !== 0) {
                        system.scheduler.clearQuitFlag(callerThreadId);
                    }
                    Logger.log(LogCategory.USER32, `PeekMessageW: synthesizing WM_QUIT exitCode=${quitState.exitCode} for thread=${callerThreadId}`);
                    writeQuitMsg(mem, lpMsg, quitState.exitCode);
                    return 1; // TRUE
                }
            }
            return 0; // FALSE
        }

        if (msg.message === WM_TIMER) {
            timerDiag.delivered++;
            if (wRemoveMsg !== 0) restartRemovedTimer(msg);
        }
        if (paintTraceEnabled) logPaintMsgDelivered('PeekMessageW', msg.hwnd, msg.message, {
            remove: wRemoveMsg,
            filterMin: wMsgFilterMin,
            filterMax: wMsgFilterMax,
        });

        // Log each message found for debugging thread exit issues
        const sched = System.getInstance().scheduler;
        const threadId = sched?.getCurrentThreadId?.() ?? 0;
        Logger.verboseLazy(
            LogCategory.USER32,
            () => `PeekMessageW: thread=${threadId} found msg=0x${msg.message.toString(16)} hwnd=0x${msg.hwnd.toString(16)} wParam=0x${msg.wParam.toString(16)} lParam=0x${msg.lParam.toString(16)}`
        );

        if (isKeyboardHookMessage(msg.message)) {
            const suspended = dispatchKeyboardHookChain(
                ctx, msg, wRemoveMsg !== 0, wMsgFilterMin, wMsgFilterMax, callerThreadId,
                lpMsg, 20, (delivered) => (delivered ? 1 : 0), 'PeekMessage:WH_KEYBOARD',
            );
            // Keyboard chain applies WH_GETMESSAGE internally on delivery.
            if (suspended) return suspended;
        }

        // WH_GETMESSAGE fires on any message about to be returned unless the keyboard
        // chain already handled it above.
        const gm = dispatchGetMessageHook(
            ctx, msg, wRemoveMsg !== 0, callerThreadId, lpMsg, 20,
            (delivered) => (delivered ? 1 : 0), 'PeekMessage:WH_GETMESSAGE',
        );
        if (gm) return gm;

        writeMsgToMemory(mem, lpMsg, msg);
        return 1; // TRUE
    };

    exports['PeekMessageA'] = exports['PeekMessageW'];

    exports['DispatchMessageW'] = (ctx, mem, args) => {
        const lpMsg = args[0];

        if (lpMsg) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const hwnd = view.getUint32(lpMsg, true);
            const message = view.getUint32(lpMsg + 4, true);
            const wParam = view.getUint32(lpMsg + 8, true);
            const lParam = view.getUint32(lpMsg + 12, true);
            const time = view.getUint32(lpMsg + 16, true);

            Logger.verboseLazy(LogCategory.USER32, () =>
                `DispatchMessageW: msg=0x${message.toString(16)} hwnd=0x${hwnd.toString(16)} wParam=0x${wParam.toString(16)} lParam=0x${lParam.toString(16)}`);
            if (paintTraceEnabled && message === WM_PAINT) {
                logPaintTrace('DispatchMessageW', `enter hwnd=0x${hwnd.toString(16)} thread=${System.getInstance().scheduler.getCurrentThreadId()}`);
            }
            if (message === WM_TIMER) {
                timerDiag.dispatched++;
            }

            // Posted WM_PAINT is suppressed once the window (or an ancestor) is
            // hidden. A stale paint queued before a page switch must not resurrect
            // that page's owner-draw controls on the shared overlay.
            const paintWindow = message === WM_PAINT ? windows.get(hwnd) : undefined;
            if (paintWindow && !isEffectivelyVisible(paintWindow)) {
                validateWindow(hwnd, null);
                return { value: 0, stackCleanup: 4 };
            }

            // WM_TIMER with a callback: call the callback instead of the window procedure.
            // This is faithful to Win32 and fixes the WaitMessage deadlock for callback timers.
            if (message === WM_TIMER && lParam !== 0) {
                const system = System.getInstance();
                const callbackManager = system.process?.dispatcher?.callbackManager;
                if (callbackManager) {
                    const stackCleanup = 4;
                    const msgView = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                    const thunkReturnAddr = msgView.getUint32(ctx.esp, true);
                    const frameId = callbackManager.saveSuspendedThunkContext(
                        { ...ctx, returnAddr: thunkReturnAddr },
                        stackCleanup,
                        'DispatchMessageW_TimerProc'
                    );
                    if (frameId === 0) return { value: 0, stackCleanup: 4 };

                    const first = callbackManager.invokeCallback(
                        lParam,
                        [hwnd, message, wParam, time],
                        0,
                        (ret: number) => 0, // DispatchMessage returns 0 for callback timers
                        false,
                        'DispatchMessageW_TimerProc',
                        frameId
                    );
                    if (first.callbackId !== 0) {
                        return {
                            value: 0,
                            suspendedForCallback: true,
                            callbackId: first.callbackId,
                            stackCleanup,
                            skipStackCheck: true,
                        };
                    }
                }
                return { value: 0, stackCleanup: 4 };
            }

            // Mouse hit-test for JS-managed system controls (Button/ListBox/ComboBox/
            // Trackbar — shared implementation in control-interaction.ts). lParam
            // carries client coordinates relative to hwnd (Win32 contract).
            // Skip when guest painted custom UI — dlgProc handles clicks itself.
            const WM_LBUTTONDOWN = 0x0201;
            const WM_LBUTTONUP = 0x0202;
            const WM_MOUSEWHEEL = 0x020A;
            const BS_TYPEMASK = 0x000F;
            const BS_OWNERDRAW = 0x000B;
            const isControlMouseMsg = message === WM_LBUTTONDOWN || message === WM_LBUTTONUP
                || message === 0x0200 /* WM_MOUSEMOVE: trackbar drag */;
            if (isControlMouseMsg) {
                const target = getWindowByHandle(hwnd);
                // Faithful WindowFromPoint routing (input-manager) delivers mouse messages
                // to the LEAF control under the cursor — a dialog's OK BUTTON has no children.
                // The control-class behavior (click → WM_COMMAND(BN_CLICKED), trackbar drag,
                // listbox select) is hit-tested over a CONTAINER's subtree, so when the message
                // landed directly on a leaf system control, resolve the host up to its parent.
                // Tiberian Sun's Select Campaign dialog pumps its own modal loop and dispatches
                // straight to the button — without this the click is silently dropped.
                const host = (target && target.children.length === 0 && target.isSystemControl && target.parent)
                    ? getWindowByHandle(target.parent)
                    : target;
                if (target && host && host.children.length > 0) {
                    const clientX = lParam & 0xFFFF;
                    const clientY = (lParam >>> 16) & 0xFFFF;
                    // lParam client coords are relative to the message's own hwnd (target);
                    // convert to screen, then re-express relative to the host for the hit-test.
                    const tAbs = getAbsoluteWindowPosition(target);
                    const screenX = tAbs.x + clientX;
                    const screenY = tAbs.y + clientY;
                    // Guest-custom-paint launchers (e.g. HL) normally route raw clicks to the
                    // dlgProc rather than letting JS synthesize button behavior. BUT owner-draw
                    // buttons are standard BUTTON-class controls whose click→WM_COMMAND(BN_CLICKED)
                    // is the control class's responsibility (= ours); the guest only DRAWS them via
                    // WM_DRAWITEM and never hit-tests the click itself. So always handle owner-draw
                    // button clicks here, even on a custom-painted launcher.
                    if (handleSystemControlMouseAtScreen(host.handle, message, wParam, screenX, screenY)) {
                        const notification = takePendingControlNotification();
                        if (notification) {
                            const parent = windows.get(notification.hwnd);
                            if (parent?.wndProc && !isSentinelWndProc(parent.wndProc)) {
                                const sync = invokeGuestWndProcSync(
                                    ctx, mem, parent.wndProc, notification.hwnd,
                                    notification.msg, notification.wParam, notification.lParam,
                                    4, 'DispatchMessageW:control-notify', () => 0,
                                );
                                if (sync) return sync;
                            }
                        }
                        return { value: 0, stackCleanup: 4 };
                    }
                }
            }

            // Keyboard for a JS-managed system control. DispatchMessage delivers the key
            // to the FOCUS window, and for a control we manage that window's wndProc is
            // our sentinel — so the class's own keyboard behaviour (listbox arrows,
            // scrollbar SB_LINE*, Space on a button) has to run here, exactly as the
            // mouse does above. Subclassed controls are skipped: their guest wndProc
            // sees the key first and reaches the class proc through DefWindowProc.
            const WM_KEYDOWN_MSG = 0x0100, WM_KEYUP_MSG = 0x0101;
            if (message === WM_KEYDOWN_MSG || message === WM_KEYUP_MSG) {
                const target = getWindowByHandle(hwnd);
                if (target?.isSystemControl && !target.wndProcSubclassed
                    && handleSystemControlKey(target, message, wParam & 0xFF)) {
                    const notification = takePendingControlNotification();
                    if (notification) {
                        const parent = windows.get(notification.hwnd);
                        if (parent?.wndProc && !isSentinelWndProc(parent.wndProc)) {
                            const sync = invokeGuestWndProcSync(
                                ctx, mem, parent.wndProc, notification.hwnd,
                                notification.msg, notification.wParam, notification.lParam,
                                4, 'DispatchMessageW:control-key-notify', () => 0,
                            );
                            if (sync) return sync;
                        }
                    }
                    return { value: 0, stackCleanup: 4 };
                }
            }

            // WM_MOUSEWHEEL over a listbox / open combo dropdown scrolls it.
            // NOTE: wheel lParam is in SCREEN coordinates already (Win32 contract).
            if (message === WM_MOUSEWHEEL) {
                const target = getWindowByHandle(hwnd);
                // Same leaf-vs-container resolution as the click path: a wheel delivered
                // straight to a leaf listbox must scroll via its parent's subtree hit-test.
                const host = (target && target.children.length === 0 && target.isSystemControl && target.parent)
                    ? getWindowByHandle(target.parent)
                    : target;
                if (host && host.children.length > 0) {
                    const wheelDelta = (wParam >> 16) << 16 >> 16; // signed HIWORD
                    const screenX = lParam & 0xFFFF;
                    const screenY = (lParam >>> 16) & 0xFFFF;
                    if (handleSystemControlWheel(host.handle, wheelDelta, screenX, screenY)) {
                        return { value: 0, stackCleanup: 4 };
                    }
                }
            }

            // WM_MOUSEMOVE: deliver to the owner-draw child under the cursor so its
            // subclassed wndProc (HL's CButton) runs — that's what arms the hover-glow
            // timer (SetTimer on the BUTTON hwnd). Windows delivers moves to the window
            // under the cursor; our routing sends them only to the top-level dialog, so
            // without this the child buttons never see a move and never start hovering.
            // We forward only on ENTER (child changes); the button's timer then polls the
            // cursor itself via GetCursorPos and self-stops once it leaves. The parent
            // still processes its own move (we fall through).
            const WM_MOUSEMOVE = 0x0200;
            if (message === WM_MOUSEMOVE) {
                const parent = getWindowByHandle(hwnd);
                if (parent && parent.children.length > 0) {
                    const clientX = lParam & 0xFFFF;
                    const clientY = (lParam >>> 16) & 0xFFFF;
                    const child = hitTestSystemControlAtClient(hwnd, clientX, clientY);
                    const isOwnerDrawBtn = child !== undefined
                        && (child.style & BS_TYPEMASK) === BS_OWNERDRAW
                        && isButtonSystemControl(child)
                        && !!child.wndProcSubclassed && !!child.wndProc
                        && !isSentinelWndProc(child.wndProc);
                    if (isOwnerDrawBtn && child!.handle !== lastHoverChildHwnd) {
                        // Coords are button-class-irrelevant (its move handler only arms a
                        // timer); pass the parent lParam through unchanged.
                        System.getInstance().windowManager.postMessage(
                            child!.handle, WM_MOUSEMOVE, wParam, lParam);
                        System.getInstance().scheduler.wakeMessageWaiters();
                        lastHoverChildHwnd = child!.handle;
                    } else if (!child) {
                        lastHoverChildHwnd = 0;
                    }
                }
            }

            // WM_NCDESTROY is the last message a window receives; once it has been
            // delivered to the wndProc (so MFC's OnNcDestroy detaches the CWnd), the
            // window is finalized (removed from the maps). See window.ts DestroyWindow
            // (deferred-destroy).
            const WM_NCDESTROY = 0x0082;

            const window = getWindowByHandle(hwnd);
            // The BUTTON class proc's WM_PAINT: a BS_OWNERDRAW button is drawn by ONE
            // WM_DRAWITEM to its parent (Wine button.c OB_Paint), which is a guest
            // callback — so this is where an InvalidateRect/UpdateWindow on such a button
            // finally reaches the guest. A subclassed one gets the message first and
            // arrives here only through CallWindowProc (window.ts).
            if (message === WM_PAINT && window?.isSystemControl && !window.wndProcSubclassed
                && isOwnerDrawButton(window)) {
                try {
                    const repaint = runOwnerDrawButtonPaint(
                        ctx, mem, window, 'DispatchMessage', 4);
                    if (repaint) return repaint;
                } catch (err) {
                    Logger.error(LogCategory.USER32,
                        `DispatchMessage owner-draw paint failed hwnd=0x${hwnd.toString(16)}: ${err}`);
                }
                return { value: 0, stackCleanup: 4 };
            }
            if (window?.isSystemControl && !window.wndProcSubclassed) {
                const result = handleSystemControlMessage(window, message, wParam, lParam, mem);
                if (isContentChangingMessage(window, message)) {
                    repaintDialogAfterContentChange(window.parent ?? hwnd);
                }
                if (message === WM_NCDESTROY) finalizeWindowDestroy(hwnd);
                return { value: result >>> 0, stackCleanup: 4 };
            }
            if (window && window.wndProc) {
                // Sentinel WndProc: system control, handle in JS — do NOT call into x86
                if (isSentinelWndProc(window.wndProc)) {
                    if (message === WM_NCDESTROY) finalizeWindowDestroy(hwnd);
                    return { value: 0, stackCleanup: 4 };
                }

                // Win32 contract: DispatchMessage returns the LRESULT produced by WndProc.
                // Re-enter the guest WndProc via the shared suspended-thunk mechanism so
                // EAX receives the actual callback return value. DispatchMessage(lpMsg)
                // is stdcall with a single argument → 4 bytes of stack cleanup.
                const dispatchResult = invokeGuestWndProcSync(
                    ctx, mem, window.wndProc, hwnd, message, wParam, lParam,
                    4, 'DispatchMessageW',
                    (wndRet: number): number | null => {
                        // Finalize a deferred-destroy window only after its wndProc has
                        // processed WM_NCDESTROY (MFC OnNcDestroy → detach).
                        if (message === WM_NCDESTROY) finalizeWindowDestroy(hwnd);
                        return wndRet >>> 0;
                    },
                );
                if (dispatchResult) return dispatchResult;
            }

            // Window has no wndProc (or was already gone) — no guest delivery happens, so
            // finalize a deferred-destroy window here instead of waiting for a wndProc that
            // will never run.
            if (message === WM_NCDESTROY) finalizeWindowDestroy(hwnd);
        }

        maybeLogTimerDiag();

        // No callback path (invalid hwnd / no wndProc): return 0 as Win32 does.
        return { value: 0, stackCleanup: 4 };
    };

    exports['DispatchMessageA'] = exports['DispatchMessageW'];

    // VK-to-character mapping for TranslateMessage (US keyboard layout)
    const VK_SHIFT = 0x10;
    const VK_CAPITAL = 0x14;

    function vkToChar(vk: number, keyStates: Uint8Array): number {
        const shiftDown = (keyStates[VK_SHIFT] & 0x80) !== 0;
        // CapsLock toggle state: bit 0 of keyState (we approximate with pressed state)
        const capsLock = (keyStates[VK_CAPITAL] & 0x80) !== 0;
        const upper = shiftDown !== capsLock; // XOR: shift or caps, not both

        // Letters A-Z (VK 0x41-0x5A)
        if (vk >= 0x41 && vk <= 0x5A) {
            return upper ? vk : (vk + 32); // 'A'=65, 'a'=97
        }

        // Digits 0-9 (VK 0x30-0x39)
        if (vk >= 0x30 && vk <= 0x39) {
            if (shiftDown) {
                const shiftDigits = ')!@#$%^&*(';
                return shiftDigits.charCodeAt(vk - 0x30);
            }
            return vk; // '0'=0x30 .. '9'=0x39
        }

        // Numpad 0-9 (VK 0x60-0x69)
        if (vk >= 0x60 && vk <= 0x69) return 0x30 + (vk - 0x60);

        // Numpad operators
        if (vk === 0x6A) return 0x2A; // *
        if (vk === 0x6B) return 0x2B; // +
        if (vk === 0x6D) return 0x2D; // -
        if (vk === 0x6E) return 0x2E; // .
        if (vk === 0x6F) return 0x2F; // /

        // Common keys
        if (vk === 0x20) return 0x20; // Space
        if (vk === 0x0D) return 0x0D; // Enter
        if (vk === 0x08) return 0x08; // Backspace
        if (vk === 0x09) return 0x09; // Tab
        if (vk === 0x1B) return 0x1B; // Escape

        // OEM keys (US layout)
        const oemMap: Record<number, [number, number]> = {
            0xBA: [0x3B, 0x3A], // ;  :
            0xBB: [0x3D, 0x2B], // =  +
            0xBC: [0x2C, 0x3C], // ,  <
            0xBD: [0x2D, 0x5F], // -  _
            0xBE: [0x2E, 0x3E], // .  >
            0xBF: [0x2F, 0x3F], // /  ?
            0xC0: [0x60, 0x7E], // `  ~
            0xDB: [0x5B, 0x7B], // [  {
            0xDC: [0x5C, 0x7C], // \  |
            0xDD: [0x5D, 0x7D], // ]  }
            0xDE: [0x27, 0x22], // '  "
        };
        const oem = oemMap[vk];
        if (oem) return shiftDown ? oem[1] : oem[0];

        return 0; // No character for this VK (arrows, F-keys, etc.)
    }

    exports['TranslateMessage'] = (ctx, mem, args) => {
        const lpMsg = args[0];
        if (!lpMsg) return 0;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const message = view.getUint32(lpMsg + 4, true);

        // Only translate WM_KEYDOWN (0x0100) and WM_SYSKEYDOWN (0x0104)
        if (message !== 0x0100 && message !== 0x0104) return 0;

        const hwnd = view.getUint32(lpMsg, true);
        const vk = view.getUint32(lpMsg + 8, true) & 0xFF;

        const charCode = vkToChar(vk, System.getInstance().inputManager.keyStates);
        if (charCode === 0) return 0;

        // Post WM_CHAR (or WM_SYSCHAR for SYSKEYDOWN)
        const charMsg = message === 0x0104 ? 0x0106 : 0x0102; // WM_SYSCHAR : WM_CHAR
        System.getInstance().windowManager.postMessage(hwnd, charMsg, charCode, view.getUint32(lpMsg + 12, true));
        return 1; // TRUE - message was translated
    };

    exports['PostQuitMessage'] = (ctx, mem, args) => {
        const nExitCode = args[0];
        const system = System.getInstance();
        const threadId = system.scheduler.getCurrentThreadId();
        Logger.log(LogCategory.USER32, `PostQuitMessage(${nExitCode}) thread=${threadId} - setting per-thread quit flag`);
        // Windows semantics: PostQuitMessage sets a per-thread flag.
        // GetMessage/PeekMessage synthesize WM_QUIT when the queue is empty.
        // This prevents cross-thread WM_QUIT leakage.
        system.scheduler.postQuitForCurrentThread(nExitCode);
        // Force WASM PeekMessage fast path to fall through to JS so it can check the quit flag
        hypercallDataManager.updateMessageQueueFlag(true);
        return 0;
    };

    exports['SetTimer'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const nIDEvent = args[1];
        const uElapse = args[2];
        const lpTimerFunc = args[3];

        const timerId = nIDEvent || nextTimerId++;
        Logger.verbose(LogCategory.USER32,
            `SetTimer(hwnd=0x${hWnd.toString(16)}, id=${timerId}, elapse=${uElapse}ms, func=0x${lpTimerFunc.toString(16)}) ` +
            `- ${lpTimerFunc ? 'callback' : 'message'} mode`
        );

        const timerState: TimerState = {
            wheelTimerId: 0,
            hWnd,
            timerId,
            timerFunc: lpTimerFunc >>> 0,
            intervalMs: Math.max(uElapse, USER_TIMER_MINIMUM),
            pendingTicks: 0,
        };

        // Win32: SetTimer with an existing (hwnd, id) RESETS that timer — cancel the
        // old wheel entry first so we don't leak an orphaned one.
        const key = timerKey(hWnd, timerId);
        const existing = timers.get(key);
        if (existing) cancelTimerState(existing);

        timers.set(key, timerState);
        armTimerState(timerState);

        return timerId;
    };

    exports['KillTimer'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const uIDEvent = args[1];
        const key = timerKey(hWnd, uIDEvent);
        const timerState = timers.get(key);
        if (timerState) {
            cancelTimerState(timerState);
            if (timerState.pendingTicks > 0) {
                timerDiag.pendingDropped += timerState.pendingTicks;
                timerState.pendingTicks = 0;
            }
            timers.delete(key);
            maybeLogTimerDiag();
            return 1; // TRUE
        }
        return 0; // FALSE
    };

    // SendMessage - sends a message to a window procedure and waits for it to process.
    // `allowGuestDispatch` gates the synchronous re-entry into the guest WndProc: the
    // direct SendMessage entry points enable it, while wrappers that cannot thread a
    // suspended-thunk result back to the guest (SendMessageTimeout) pass false and only
    // use the JS-handled subset (see note at the call site).
    const sendMessageImpl = (ctx: X86Context, mem: Uint8Array, args: number[], allowGuestDispatch: boolean): number | ThunkResult => {
        const hWnd = args[0];
        const msg = args[1];
        const wParam = args[2];
        const lParam = args[3];
        Logger.verbose(LogCategory.USER32, `SendMessageW(hwnd=0x${hWnd.toString(16)}, msg=0x${msg.toString(16)}, wParam=0x${wParam.toString(16)}, lParam=0x${lParam.toString(16)})`);

        const targetWindow = getWindowByHandle(hWnd);

        // Route known control messages to JS handler for any window
        const WM_SETTEXT = 0x000C;
        const WM_GETTEXT = 0x000D;
        const WM_GETTEXTLENGTH = 0x000E;
        const WM_SETFONT = 0x0030;
        const WM_GETFONT = 0x0031;
        const WM_ENABLE = 0x000A;
        const WM_SHOWWINDOW = 0x0018;
        const BM_GETCHECK = 0x00F0;
        const BM_SETCHECK = 0x00F1;
        const readAnsiOrWideString = (ptr: number): string => {
            if (!ptr) return '';
            const maxProbeChars = 16;
            let probed = 0;
            let zeroHighBytes = 0;
            for (let i = 0; i < maxProbeChars; i++) {
                const loIdx = ptr + i * 2;
                const hiIdx = loIdx + 1;
                if (hiIdx >= mem.length) break;
                const lo = mem[loIdx];
                const hi = mem[hiIdx];
                if (lo === 0 && hi === 0) break;
                probed++;
                if (hi === 0) zeroHighBytes++;
            }
            const looksWide = probed > 0 && (zeroHighBytes / probed) >= 0.75;
            return looksWide ? Marshaler.readWideString(mem, ptr) : Marshaler.readString(mem, ptr);
        };

        if (targetWindow) {
            const animateResult = handleAnimateMessage(hWnd, msg, wParam, lParam, mem);
            if (animateResult !== null) return animateResult;

            // System controls: delegate all messages to our built-in control behavior —
            // UNLESS the guest has subclassed the control (SetWindowLong GWL_WNDPROC). Once
            // subclassed, the control's window procedure IS the guest's; SendMessage must
            // invoke it so app-defined messages (e.g. MFC message-map broadcasts via
            // SendMessageToDescendants) reach the guest. Mirrors the `!wndProcSubclassed`
            // guard the DispatchMessage/postMessage path uses.
            if (targetWindow.isSystemControl && !targetWindow.wndProcSubclassed) {
                // EM_STREAMIN/OUT call back into the guest, so they need this thunk's
                // return frame — the generic sink below has no way to suspend. Gated on
                // allowGuestDispatch for the same reason the WndProc re-entry below is:
                // the SendMessageTimeout wrapper cannot thread a suspended result back.
                const stream = allowGuestDispatch
                    ? tryRichEditStreamMessage(ctx, mem, targetWindow, msg, wParam, lParam, 16, 'SendMessage')
                    : null;
                if (stream) return stream;

                const result = handleSystemControlMessage(targetWindow, msg, wParam, lParam, mem);
                // Repaint content changes done outside the HLE modal pump (games that
                // pump their own messages and SendMessage TBM_SETPOS / LB_ADDSTRING /
                // WM_SETTEXT etc. at runtime — e.g. TS dialog init from its dlgProc).
                if (isContentChangingMessage(targetWindow, msg)) {
                    // Drop the control's OLD pixels first. On a guest-painted parent the
                    // repaint below can only STAMP the control — it cannot restore what was
                    // under it — so a changed caption renders on top of the previous one and
                    // both stay readable (a front-end that reuses one Static across pages
                    // ends up with two overlaid sentences). Erased AFTER the message applied,
                    // so the repair this triggers re-stamps the NEW text, not the old.
                    eraseControlOverlayRect(targetWindow);
                    repaintDialogAfterContentChange(targetWindow.parent ?? hWnd);
                }
                return result;
            }

            // Non-system windows: handle common messages in JS
            switch (msg) {
                case WM_SETTEXT:
                    if (lParam) {
                        targetWindow.title = readAnsiOrWideString(lParam);
                        Logger.log(LogCategory.USER32, `SendMessage WM_SETTEXT hwnd=0x${hWnd.toString(16)} -> "${targetWindow.title}"`);
                        // Sync tab title for top-level windows (matches SetWindowTextA/W behavior)
                        if (!targetWindow.parent) {
                            System.getInstance().notifyWindowTitle(targetWindow.title, 'WM_SETTEXT');
                        } else {
                            // A caption change invalidates the window on Win32. This branch also
                            // serves SUBCLASSED system controls (UE1 wraps its statics), whose
                            // pixels we still stamp — so without erasing first, the new caption
                            // lands on top of the old one and both stay readable.
                            eraseControlOverlayRect(targetWindow);
                            repaintDialogAfterContentChange(targetWindow.parent);
                        }
                    }
                    return 1;
                case WM_GETTEXT:
                    if (lParam && wParam > 0) {
                        const text = targetWindow.title;
                        const encoded = encodeAnsi(text);
                        const writeLen = Math.min(encoded.length, wParam - 1);
                        mem.set(encoded.subarray(0, writeLen), lParam);
                        mem[lParam + writeLen] = 0;
                        return writeLen;
                    }
                    return 0;
                case WM_GETTEXTLENGTH:
                    return targetWindow.title.length;
                case WM_SETFONT:
                    targetWindow.fontHandle = wParam >>> 0;
                    if (lParam) repaintDialogAfterContentChange(hWnd);
                    return 0;
                case WM_GETFONT:
                    return targetWindow.fontHandle ?? 0;
                case WM_ENABLE:
                    return 0;
                case WM_SHOWWINDOW:
                    targetWindow.visible = !!wParam;
                    return 0;
                case BM_SETCHECK:
                    buttonCheckStates.set(hWnd, wParam);
                    return 0;
                case BM_GETCHECK:
                    return buttonCheckStates.get(hWnd) ?? 0;
                default: {
                    // Listbox/Combobox/Static messages: route through handleSystemControlMessage
                    if ((msg >= 0x0140 && msg <= 0x0160) || (msg >= 0x0170 && msg <= 0x0174) || (msg >= 0x0180 && msg <= 0x01A0)) {
                        return handleSystemControlMessage(targetWindow, msg, wParam, lParam, mem);
                    }
                    break;
                }
            }

            // Win32 contract: SendMessage delivers the message SYNCHRONOUSLY to the target
            // window's WndProc and returns its LRESULT. Messages not short-circuited above
            // (which emulate DefWindowProc for a handful of well-known messages) must reach
            // the guest's own WndProc — DispatchMessage already does exactly this via the
            // shared suspended-thunk re-entry. SendMessage(hwnd,msg,wParam,lParam) is stdcall
            // with 4 args → 16 bytes of stack cleanup. The WndProc's return value becomes the
            // SendMessage LRESULT.
            if (allowGuestDispatch && targetWindow.wndProc && !isSentinelWndProc(targetWindow.wndProc)) {
                const dispatchResult = invokeGuestWndProcSync(
                    ctx, mem, targetWindow.wndProc, hWnd, msg, wParam, lParam,
                    16, 'SendMessageW',
                    (wndRet: number): number | null => wndRet >>> 0,
                );
                if (dispatchResult) return dispatchResult;
            }
        }

        return 0;
    };
    exports['SendMessageW'] = (ctx, mem, args) => sendMessageImpl(ctx, mem, args, true);
    exports['SendMessageA'] = exports['SendMessageW'];

    // BOOL InSendMessage(void) — TRUE when processing a synchronously sent message.
    // NOTE: SendMessage now re-enters the guest WndProc synchronously (via the shared
    // suspended-thunk chain); tracking an in-send-message depth counter for a faithful
    // TRUE return is a follow-up refinement and is intentionally left out of scope here.
    exports['InSendMessage'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, 'InSendMessage() -> FALSE');
        return 0;
    };

    // PostMessage - posts a message to a window's message queue
    exports['PostMessageW'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const msg = args[1];
        const wParam = args[2];
        const lParam = args[3];
        Logger.log(LogCategory.USER32, `PostMessageW(hwnd=0x${hWnd.toString(16)}, msg=0x${msg.toString(16)}, wParam=0x${wParam.toString(16)}, lParam=0x${lParam.toString(16)})`);
        const system = System.getInstance();
        system.windowManager.postMessage(hWnd, msg, wParam, lParam);
        // Wake any threads blocked in GetMessage/WaitMessage
        system.scheduler.wakeMessageWaiters();
        return 1; // TRUE
    };
    exports['PostMessageA'] = exports['PostMessageW'];

    exports['PostThreadMessageA'] = (ctx, mem, args) => {
        const threadId = args[0];
        const msg = args[1];
        const wParam = args[2];
        const lParam = args[3];
        const system = System.getInstance();
        Logger.verbose(LogCategory.USER32, `PostThreadMessageA(tid=${threadId}, msg=0x${msg.toString(16)}, wParam=0x${wParam.toString(16)}, lParam=0x${lParam.toString(16)})`);
        // Tag message with target thread ID so only that thread's GetMessage dequeues it
        system.windowManager.postMessage(0, msg, wParam, lParam, 0, 0, threadId);
        if (threadId !== 0) {
            system.scheduler.wakeMessageWaiters(threadId);
        } else {
            system.scheduler.wakeMessageWaiters();
        }
        return 1;
    };
    exports['PostThreadMessageW'] = exports['PostThreadMessageA'];

    exports['SendMessageTimeoutA'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const msg = args[1];
        const wParam = args[2];
        const lParam = args[3];
        const fuFlags = args[4];
        const uTimeout = args[5];
        const lpdwResult = args[6];
        const system = System.getInstance();
        Logger.verbose(
            LogCategory.USER32,
            `SendMessageTimeoutA(hwnd=0x${hWnd.toString(16)}, msg=0x${msg.toString(16)}, flags=0x${fuFlags.toString(16)}, timeout=${uTimeout}, lpdwResult=0x${lpdwResult.toString(16)})`,
        );

        if ((fuFlags & SMTO_ABORTIFHUNG) !== 0 && uTimeout === 0) {
            system.scheduler.setLastError(ERROR_TIMEOUT);
            return 0;
        }

        if (hWnd !== 0 && !getWindowByHandle(hWnd)) {
            if ((fuFlags & SMTO_ERRORONEXIT) !== 0) {
                system.scheduler.setLastError(ERROR_INVALID_WINDOW_HANDLE);
                return 0;
            }
            if (lpdwResult !== 0) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(lpdwResult, 0, true);
            }
            system.scheduler.setLastError(0);
            return 1;
        }

        // allowGuestDispatch=false: SendMessageTimeout returns via lpdwResult and cannot
        // thread a suspended-thunk result back to the guest, so it uses only the JS-handled
        // (DefWindowProc-equivalent) subset. A synchronous guest-WndProc re-entry through the
        // timeout wrapper is a follow-up; the direct SendMessage path handles it.
        const raw = sendMessageImpl(ctx, mem, [hWnd, msg, wParam, lParam], false);
        const result = (typeof raw === 'number' ? raw : (raw.value ?? 0)) >>> 0;
        if (lpdwResult !== 0) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lpdwResult, result, true);
        }
        system.scheduler.setLastError(0);
        return 1; // TRUE
    };
    exports['SendMessageTimeoutW'] = exports['SendMessageTimeoutA'];

    exports['SendNotifyMessageA'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const msg = args[1];
        const wParam = args[2];
        const lParam = args[3];
        Logger.verbose(LogCategory.USER32, `SendNotifyMessageA(hwnd=0x${hWnd.toString(16)}, msg=0x${msg.toString(16)})`);
        System.getInstance().windowManager.postMessage(hWnd, msg, wParam, lParam);
        return 1;
    };

    exports['SetWindowsHookExA'] = (ctx, mem, args) => {
        const idHook = args[0];
        const lpfn = args[1];
        const hMod = args[2];
        const dwThreadId = args[3];
        const handle = installHook(idHook, lpfn, hMod, dwThreadId);
        Logger.log(LogCategory.USER32, `SetWindowsHookExA(id=${idHook}, lpfn=0x${lpfn.toString(16)}, hMod=0x${hMod.toString(16)}, tid=${dwThreadId}) -> 0x${handle.toString(16)}`);
        return handle;
    };

    exports['SetWindowsHookExW'] = exports['SetWindowsHookExA'];

    exports['CallNextHookEx'] = (ctx, mem, args) => {
        const hhk = args[0] >>> 0;
        const nCode = args[1] | 0;
        const wParam = args[2] >>> 0;
        const lParam = args[3] >>> 0;
        const system = System.getInstance();
        const threadId = system.scheduler.getCurrentThreadId();

        // Pass control to the next hook in this chain (the one installed just before the
        // caller). We identify the CALLING hook from the active-hook stack — pushed
        // around every hook-proc invocation (invokeHookProc) — so this works even when
        // the guest passes NULL for hhk (the modern "hhk is ignored" idiom; real Windows
        // tracks the current hook per-thread internally, not via hhk). Fall back to the
        // hhk argument if the stack is empty (hook invoked outside our tracked paths).
        const current = currentActiveHook() || hhk;
        const next = getNextHookInChain(current, threadId);

        // WH_CBT chaining is driven by our CreateWindow dispatcher, which walks every CBT
        // hook itself (window.ts/dialog.ts fireCreateWindowCallbacks) rather than relying
        // on CallNextHookEx. Invoking the next CBT hook here too would double-fire it, so
        // CallNextHookEx is intentionally inert for CBT (that dispatcher already ignores
        // the hooks' return values). No next hook (single-hook chain — the common case —
        // or end of chain) likewise returns the documented default, 0.
        if (!next || !next.lpfn || next.idHook === WH_CBT) {
            Logger.verbose(LogCategory.USER32,
                `CallNextHookEx(hhk=0x${hhk.toString(16)}, cur=0x${current.toString(16)}, code=${nCode}) -> end of chain`);
            return 0;
        }

        const callbackManager = system.process?.dispatcher?.callbackManager;
        if (!callbackManager) return 0;

        // Suspend this thunk and run the next hook proc via the shared JS→x86 re-entry
        // path (same mechanism as dispatchKeyboardHookChain). Its LRESULT becomes the
        // return value of CallNextHookEx. Nested CallNextHookEx calls from that hook
        // chain further down naturally (each suspends its own frame, and invokeHookProc
        // tracks it as the new active hook). CallNextHookEx is stdcall(hhk,nCode,wParam,
        // lParam) → 16 bytes of stack cleanup.
        const frameId = callbackManager.saveSuspendedThunkContext(ctx, 16, 'CallNextHookEx');
        if (!frameId) return 0;

        const invoked = invokeHookProc(
            callbackManager, next.handle, next.lpfn, [nCode, wParam, lParam],
            (hookRet: number): number => hookRet >>> 0,
            frameId, 'CallNextHookEx',
        );
        if (!invoked.callbackId) return 0;
        Logger.verbose(LogCategory.USER32,
            `CallNextHookEx -> next hook 0x${next.lpfn.toString(16)} (idHook=${next.idHook}) code=${nCode}`);
        return { value: 0, suspendedForCallback: true, callbackId: invoked.callbackId, stackCleanup: 16 };
    };

    exports['UnhookWindowsHookEx'] = (ctx, mem, args) => {
        const hhk = args[0];
        const existed = uninstallHook(hhk);
        Logger.verbose(LogCategory.USER32, `UnhookWindowsHookEx(0x${hhk.toString(16)}) -> ${existed ? 1 : 0}`);
        return existed ? 1 : 0;
    };

    return exports;
}

/**
 * Register JS fast path for PeekMessageA/W (Tier 2).
 * Called when WASM handler falls through (queue non-empty or starvation limit).
 * Reads args directly from stack, avoids marshaling overhead.
 */
export function registerFastPathMessageFunctions(dispatcher: any): void {
    if (!dispatcher || typeof dispatcher.registerFastPath !== 'function') return;

    const WM_QUIT = 0x0012;

    const fastPathPeekMessage: FastPathImplementation = (
        cpu: any,
        mem8: Uint8Array,
        _mem32: Uint32Array,
        dataView: DataView
    ): number | null => {
        const esp = cpu.reg32[4]; // ESP

        // PeekMessageA/W(lpMsg, hWnd, wMsgFilterMin, wMsgFilterMax, wRemoveMsg)
        // stdcall: args at ESP+4 through ESP+20
        const lpMsg = dataView.getUint32(esp + 4, true);
        // hWnd at ESP+8 - ignored for now (single-window HLE)
        const wMsgFilterMin = dataView.getUint32(esp + 12, true);
        const wMsgFilterMax = dataView.getUint32(esp + 16, true);
        const wRemoveMsg = dataView.getUint32(esp + 20, true);

        const system = System.getInstance();

        // Note: Poll input from SAB before checking the queue.
        // During synchronous v86 execution, setInterval callbacks can't fire,
        // so InputManager.poll() never runs. This is the only opportunity to
        // read fresh mouse/keyboard data from the SharedArrayBuffer and inject
        // WM_MOUSEMOVE / WM_KEYDOWN etc. into the message queue.
        system.inputManager.poll();

        const callerThreadId = system.scheduler.getCurrentThreadId();

        // WH_KEYBOARD / WH_GETMESSAGE dispatch needs the thunk machinery — bail to the
        // slow path BEFORE removing the message. One non-removing peek covers both:
        // WH_GETMESSAGE fires on ANY pending message, WH_KEYBOARD only on key messages.
        if (hasHooksOfType(WH_KEYBOARD) || hasHooksOfType(WH_GETMESSAGE)) {
            const nx = system.windowManager.peekMessage(false, wMsgFilterMin, wMsgFilterMax, callerThreadId);
            if (nx && (hasHooksOfType(WH_GETMESSAGE)
                || nx.message === 0x0100 || nx.message === 0x0101 || nx.message === 0x0104 || nx.message === 0x0105)) {
                return null;
            }
        }

        const msg = system.windowManager.peekMessage(wRemoveMsg !== 0, wMsgFilterMin, wMsgFilterMax, callerThreadId);

        // dbg.peekstats() diagnostic: histogram of dequeued message ids + empty-return count
        if ((globalThis as any).__peekDiagEnabled === true) {
            const peekDiag = ((globalThis as any).__peekDiag ??= { ret0: 0, ret1: 0, byMsg: {} as Record<string, number> });
            if (msg) {
                peekDiag.ret1++;
                const k = `0x${msg.message.toString(16)}`;
                peekDiag.byMsg[k] = (peekDiag.byMsg[k] ?? 0) + 1;
            } else peekDiag.ret0++;
        }

        if (!msg) {
            if (paintTraceEnabled && system.windowManager.hasMessages(WM_PAINT, WM_PAINT, callerThreadId)) {
                logPaintPendingBlocked('PeekMessageW(fastpath)', wMsgFilterMin, wMsgFilterMax, wRemoveMsg !== 0);
            }
            // Queue empty — check per-thread quit flag before returning FALSE
            if (wMsgFilterMin === 0 && wMsgFilterMax === 0 || (WM_QUIT >= wMsgFilterMin && WM_QUIT <= wMsgFilterMax)) {
                const quitState = system.scheduler.getQuitState(callerThreadId);
                if (quitState && quitState.posted) {
                    if (wRemoveMsg !== 0) {
                        system.scheduler.clearQuitFlag(callerThreadId);
                    }
                    // Write synthesized WM_QUIT MSG
                    if (lpMsg && lpMsg + 28 <= mem8.length) {
                        dataView.setUint32(lpMsg, 0, true);             // hwnd = NULL
                        dataView.setUint32(lpMsg + 4, WM_QUIT, true);   // message
                        dataView.setUint32(lpMsg + 8, quitState.exitCode, true); // wParam
                        dataView.setUint32(lpMsg + 12, 0, true);        // lParam
                        dataView.setUint32(lpMsg + 16, 0, true);        // time
                        dataView.setInt32(lpMsg + 20, 0, true);         // pt.x
                        dataView.setInt32(lpMsg + 24, 0, true);         // pt.y
                    }
                    return 1; // TRUE
                }
            }
            // No quit pending — keep flag set if paint/mouse still pending
            hypercallDataManager.updateMessageQueueFlag(
                system.windowManager.hasMessages(wMsgFilterMin, wMsgFilterMax, callerThreadId),
            );
            return 0;
        }

        // Match the slow PeekMessage path: USER restarts a synthesized timer when
        // its WM_TIMER is removed from the queue. Omitting this in the fast path
        // made hover timers one-shot in tight MFC pumps (Half-Life launcher).
        if (msg.message === WM_TIMER) {
            noteFastPathTimerDelivery?.(msg, wRemoveMsg !== 0);
        }

        // Write MSG struct (28 bytes) to guest memory
        if (lpMsg && lpMsg + 28 <= mem8.length) {
            dataView.setUint32(lpMsg, msg.hwnd, true);        // hwnd
            dataView.setUint32(lpMsg + 4, msg.message, true);  // message
            dataView.setUint32(lpMsg + 8, msg.wParam, true);   // wParam
            dataView.setUint32(lpMsg + 12, msg.lParam, true);  // lParam
            dataView.setUint32(lpMsg + 16, msg.time, true);    // time
            dataView.setInt32(lpMsg + 20, (msg as any).ptX ?? 0, true);  // pt.x
            dataView.setInt32(lpMsg + 24, (msg as any).ptY ?? 0, true);  // pt.y
        }

        if (paintTraceEnabled) logPaintMsgDelivered('PeekMessageW(fastpath)', msg.hwnd, msg.message, {
            remove: wRemoveMsg,
            filterMin: wMsgFilterMin,
            filterMax: wMsgFilterMax,
        });

        // Update shared flag after dequeue (unfiltered check - any message means queue non-empty)
        hypercallDataManager.updateMessageQueueFlag(system.windowManager.hasMessages(0, 0, callerThreadId));

        return 1; // TRUE
    };

    dispatcher.registerFastPath('user32', 'PeekMessageA', fastPathPeekMessage);
    dispatcher.registerFastPath('user32', 'PeekMessageW', fastPathPeekMessage);

    // GetMessageA/W fast path: sync dequeue when message available, null → async slow path
    const fastPathGetMessage: FastPathImplementation = (
        cpu: any,
        mem8: Uint8Array,
        _mem32: Uint32Array,
        dataView: DataView
    ): number | null => {
        const esp = cpu.reg32[4]; // ESP

        // GetMessageA/W(lpMsg, hWnd, wMsgFilterMin, wMsgFilterMax)
        const lpMsg = dataView.getUint32(esp + 4, true);
        const wMsgFilterMin = dataView.getUint32(esp + 12, true);
        const wMsgFilterMax = dataView.getUint32(esp + 16, true);

        const system = System.getInstance();
        system.inputManager.poll(true);

        const callerThreadId = system.scheduler.getCurrentThreadId();

        // Same WH_KEYBOARD / WH_GETMESSAGE bail as the PeekMessage fast path (see above).
        if (hasHooksOfType(WH_KEYBOARD) || hasHooksOfType(WH_GETMESSAGE)) {
            const nx = system.windowManager.peekMessage(false, wMsgFilterMin, wMsgFilterMax, callerThreadId);
            if (nx && (hasHooksOfType(WH_GETMESSAGE)
                || nx.message === 0x0100 || nx.message === 0x0101 || nx.message === 0x0104 || nx.message === 0x0105)) {
                return null;
            }
        }

        const msg = system.windowManager.peekMessage(true, wMsgFilterMin, wMsgFilterMax, callerThreadId);
        if (!msg) {
            // Queue empty — check per-thread quit flag before falling to async
            if (wMsgFilterMin === 0 && wMsgFilterMax === 0 || (WM_QUIT >= wMsgFilterMin && WM_QUIT <= wMsgFilterMax)) {
                const quitState = system.scheduler.getQuitState(callerThreadId);
                if (quitState && quitState.posted) {
                    system.scheduler.clearQuitFlag(callerThreadId);
                    if (lpMsg && lpMsg + 28 <= mem8.length) {
                        dataView.setUint32(lpMsg, 0, true);
                        dataView.setUint32(lpMsg + 4, WM_QUIT, true);
                        dataView.setUint32(lpMsg + 8, quitState.exitCode, true);
                        dataView.setUint32(lpMsg + 12, 0, true);
                        dataView.setUint32(lpMsg + 16, 0, true);
                        dataView.setInt32(lpMsg + 20, 0, true);
                        dataView.setInt32(lpMsg + 24, 0, true);
                    }
                    Logger.log(LogCategory.USER32, `GetMessageW(fastpath): WM_QUIT exitCode=${quitState.exitCode} thread=${callerThreadId} lpMsg=0x${lpMsg.toString(16)}`);
                    return 0; // GetMessage returns 0 for WM_QUIT
                }
            }
            return null; // No message → fall through to async slow path
        }

        // GetMessage always removes the returned message, so an expired USER
        // timer becomes eligible for its next interval here as on the slow path.
        if (msg.message === WM_TIMER) {
            noteFastPathTimerDelivery?.(msg, true);
        }

        // Write MSG struct (28 bytes) to guest memory
        if (lpMsg && lpMsg + 28 <= mem8.length) {
            dataView.setUint32(lpMsg, msg.hwnd, true);
            dataView.setUint32(lpMsg + 4, msg.message, true);
            dataView.setUint32(lpMsg + 8, msg.wParam, true);
            dataView.setUint32(lpMsg + 12, msg.lParam, true);
            dataView.setUint32(lpMsg + 16, msg.time, true);
            dataView.setInt32(lpMsg + 20, (msg as any).ptX ?? 0, true);
            dataView.setInt32(lpMsg + 24, (msg as any).ptY ?? 0, true);
        }

        const retVal = msg.message === WM_QUIT ? 0 : 1;
        if (paintTraceEnabled) logPaintMsgDelivered('GetMessageW(fastpath)', msg.hwnd, msg.message, {
            ret: retVal,
            filterMin: wMsgFilterMin,
            filterMax: wMsgFilterMax,
        });
        return retVal;
    };

    dispatcher.registerFastPath('user32', 'GetMessageA', fastPathGetMessage);
    dispatcher.registerFastPath('user32', 'GetMessageW', fastPathGetMessage);
    Logger.log(LogCategory.USER32, 'Registered fast path for PeekMessage and GetMessage');
}
