/**
 * Synchronous WM_DESTROY / WM_NCDESTROY delivery for window teardown (DestroyWindow + EndDialog).
 *
 * Real Windows' DestroyWindow synchronously sends WM_DESTROY to the window and then to each
 * descendant, parent first, while every child still exists; WM_NCDESTROY then follows children
 * first. MFC's CWnd::OnNcDestroy (run on WM_NCDESTROY) detaches the CWnd from
 * afxMapHWND. We must do the same SYNCHRONOUSLY (re-entering the guest before the teardown
 * thunk returns) so MFC detaches BEFORE any later queued message (e.g. an owner-draw button's
 * hover WM_TIMER) is pumped — otherwise a pre-translate (CWnd::WalkPreTranslateTree) calls
 * FromHandlePermanent on a not-yet-detached, soon-freed CWnd and crashes (garbage vtable →
 * "memory access out of bounds").
 *
 * Posting the messages async (and finalizing on dispatch) is too late — the crashing timer
 * message wins the race. So we deliver via the suspended-thunk callback chain, exactly like
 * beginSyncActivationDelivery, and finalize each window right after its WM_NCDESTROY.
 */
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { windows } from './shared-state';
import { isSentinelWndProc } from './dialog';

const WM_DESTROY = 0x0002;
const WM_NCDESTROY = 0x0082;

interface DeliverAction {
    hwnd: number;
    msg: number;
    /** Finalize (remove from maps) this hwnd after the callback completes. */
    finalizeAfter: boolean;
    /** False for a window with no guest procedure: it is only finalized, in order. */
    deliver: boolean;
}

export interface SyncDestroySuspendResult {
    value: number;
    suspendedForCallback: true;
    callbackId: number;
    stackCleanup: number;
    skipStackCheck: boolean;
}

/**
 * Deliver WM_DESTROY (parent first) then WM_NCDESTROY (children first) to the rootHwnd
 * subtree, finalizing each window after its WM_NCDESTROY. Returns a suspend result when at
 * least one guest callback was scheduled; otherwise runs `afterAll` and returns null (the
 * caller should then just return).
 * `afterAll` (owner reactivation, etc.) runs once all destroy deliveries complete.
 */
export function beginSyncDestroyDelivery(
    ctx: any,
    mem: Uint8Array,
    rootHwnd: number,
    finalize: (hwnd: number) => void,
    stackCleanup: number,
    afterAll?: () => void,
): SyncDestroySuspendResult | null {
    if (!windows.get(rootHwnd)) { afterAll?.(); return null; }

    const system = System.getInstance();
    const callbackManager = system.process?.dispatcher?.callbackManager;
    if (!callbackManager) {
        finalizeSubtree(rootHwnd, finalize);
        afterAll?.();
        return null;
    }

    // A parent's WM_DESTROY handler may still read its children (an MFC dialog's OnDestroy
    // reading the selection of a combo it subclassed), so they are torn down only afterwards.
    const preOrder: number[] = [];
    const postOrder: number[] = [];
    const collect = (h: number) => {
        const wi = windows.get(h);
        if (!wi) return;
        preOrder.push(h);
        for (const c of [...wi.children]) collect(c);
        postOrder.push(h);
    };
    collect(rootHwnd);

    // JS-owned native controls use HLE DefWindowProc thunks; only subclassed controls
    // have a guest WNDPROC that needs WM_DESTROY/WM_NCDESTROY delivery.
    const hasGuestProc = (h: number): boolean => {
        const wi = windows.get(h);
        const wndProc = wi?.wndProc ?? 0;
        return !!wi && !!wndProc && !isSentinelWndProc(wndProc) && (!wi.isSystemControl || !!wi.wndProcSubclassed);
    };
    const actions: DeliverAction[] = [];
    for (const h of preOrder) {
        if (hasGuestProc(h)) actions.push({ hwnd: h, msg: WM_DESTROY, finalizeAfter: false, deliver: true });
    }
    for (const h of postOrder) {
        actions.push({ hwnd: h, msg: WM_NCDESTROY, finalizeAfter: true, deliver: hasGuestProc(h) });
    }

    if (!actions.some(a => a.deliver)) {
        for (const h of postOrder) finalize(h);
        afterAll?.();
        return null;
    }

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const thunkReturnAddr = view.getUint32(ctx.esp, true);
    const frameId = callbackManager.saveSuspendedThunkContext(
        { ...ctx, returnAddr: thunkReturnAddr }, stackCleanup, 'sync-destroy');
    if (frameId === 0) {
        Logger.warn(LogCategory.USER32,
            `beginSyncDestroyDelivery: failed to save frame for 0x${rootHwnd.toString(16)}`);
        finalizeSubtree(rootHwnd, finalize);
        afterAll?.();
        return null;
    }

    const procOf = (hwnd: number): number => windows.get(hwnd)?.wndProc ?? 0;

    let i = 0; // index of the action currently in flight
    const completeAndAdvance = (): number | null => {
        const finished = actions[i];
        if (finished?.finalizeAfter) finalize(finished.hwnd);
        i++;
        return runFrom();
    };
    const runFrom = (): number | null => {
        while (i < actions.length) {
            const a = actions[i]!;
            const wndProc = a.deliver ? procOf(a.hwnd) : 0;
            if (!wndProc) {
                if (a.finalizeAfter) finalize(a.hwnd);
                i++;
                continue;
            }
            Logger.verbose(LogCategory.USER32,
                `deliverDestroy: hwnd=0x${a.hwnd.toString(16)} msg=0x${a.msg.toString(16)} wndProc=0x${wndProc.toString(16)}`);
            callbackManager.invokeCallback(
                wndProc, [a.hwnd, a.msg, 0, 0], 0,
                completeAndAdvance, false, 'sync-destroy', frameId);
            return null;
        }
        afterAll?.();
        return 1;
    };

    // Find + invoke the first deliverable action to capture its callbackId.
    let firstCallbackId = 0;
    while (i < actions.length) {
        const a = actions[i]!;
        const wndProc = a.deliver ? procOf(a.hwnd) : 0;
        if (!wndProc) {
            if (a.finalizeAfter) finalize(a.hwnd);
            i++;
            continue;
        }
        Logger.verbose(LogCategory.USER32,
            `deliverDestroy: hwnd=0x${a.hwnd.toString(16)} msg=0x${a.msg.toString(16)} wndProc=0x${wndProc.toString(16)}`);
        const r = callbackManager.invokeCallback(
            wndProc, [a.hwnd, a.msg, 0, 0], 0,
            completeAndAdvance, false, 'sync-destroy', frameId);
        firstCallbackId = r.callbackId;
        break;
    }

    if (firstCallbackId === 0) {
        // Every action got skipped — nothing scheduled, the saved frame would dangle.
        afterAll?.();
        return null;
    }

    system.scheduler.wakeMessageWaiters();
    return {
        value: 1,
        suspendedForCallback: true,
        callbackId: firstCallbackId,
        stackCleanup,
        skipStackCheck: true,
    };
}

function finalizeSubtree(rootHwnd: number, finalize: (hwnd: number) => void): void {
    const order: number[] = [];
    const collect = (h: number) => {
        const wi = windows.get(h);
        if (!wi) return;
        for (const c of [...wi.children]) collect(c);
        order.push(h);
    };
    collect(rootHwnd);
    for (const h of order) finalize(h);
}
