import { ApcKind, WAIT_IO_COMPLETION, type PendingApc } from './types';
import type { Scheduler } from './scheduler';
import type { CallbackManager } from '../thunking/callback-manager';
import type { X86Context, ThunkResult } from '../thunking/thunk-dispatcher';

/** NT user APC signatures differ: QueueUserAPC=1, file/NT=3, Winsock=4. */
export function apcArguments(apc: PendingApc): number[] {
    if (apc.kind === ApcKind.USER32_QUEUE_USER_APC) return [apc.arg0];
    if (apc.kind === ApcKind.WSA_COMPLETION) return [apc.arg0, apc.arg1, apc.arg2, apc.arg3 ?? 0];
    return [apc.arg0, apc.arg1, apc.arg2];
}

/** Called only from a guest thunk on the alertable thread that owns the queue. */
export function dispatchThreadApcs(
    sched: Scheduler, callbackManager: CallbackManager | null | undefined,
    ctx: X86Context, label: string, stackCleanup: number,
    alertedValue: () => number = () => WAIT_IO_COMPLETION,
): ThunkResult | null {
    const tid = sched.getCurrentThread()?.id ?? 0;
    if (!tid || !callbackManager) return null;
    const first = sched.takePendingApc(tid);
    if (!first) return null;
    const frameId = callbackManager.saveSuspendedThunkContext(ctx, stackCleanup, label);
    if (!frameId) { sched.restorePendingApc(tid, first); return null; }
    const next = (): number | null => {
        const apc = sched.takePendingApc(tid);
        if (!apc) return alertedValue();
        const args = apcArguments(apc);
        callbackManager.invokeCallback(apc.routine, args, args.length * 4, next, false, label, frameId);
        return null;
    };
    const args = apcArguments(first);
    const { callbackId } = callbackManager.invokeCallback(
        first.routine, args, args.length * 4, next, false, label, frameId);
    return { value: WAIT_IO_COMPLETION, suspendedForCallback: true, callbackId, stackCleanup };
}
