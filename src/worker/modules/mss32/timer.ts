import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { System } from "../../core/system";
import { TimerKind } from "../../core/scheduler/types";
import { setTimerHandler } from "../../core/scheduler/timer-wheel";
import { TimeService } from "../../runtime/time";
import { MSSContext } from "./context";
import { MSSTimer } from "./types";

/**
 * Withdraw ticks of `timer` that have not run yet: the one queued on the timer pump and any
 * in the AIL_serve fallback queue. Real Miles serialises AIL_stop_timer /
 * AIL_release_timer_handle with the callback on its timer mutex, so no callback is seen
 * after either returns. A tick already running cannot be recalled; it finishes on its own.
 */
function withdrawPendingTicks(ctx: MSSContext, timer: MSSTimer): void {
    const onReturn = timer.pumpOnReturn;
    if (onReturn) {
        System.getInstance().scheduler?.cancelTimerCallbacks((cb) => cb.onReturn === onReturn);
    }
    timer.pumpOnReturn = undefined;
    timer.inFlight = false;
    const queue = ctx.pendingTimerCallbacks;
    for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].handle === timer.handle) queue.splice(i, 1);
    }
}

export function armTimerPump(timer: MSSTimer): void {
    const onReturn = () => { if (timer.pumpOnReturn === onReturn) timer.inFlight = false; };
    timer.pumpOnReturn = onReturn;
    timer.inFlight = false;
}

export function createTimerExports(ctx: MSSContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    setTimerHandler(TimerKind.MSS_TIMER, (handle, _arg, wheelId) => {
        const timer = ctx.timers.get(handle);
        if (!timer || timer.timerId !== wheelId) return;
        const system = System.getInstance();
        const scheduler = system.scheduler;
        const cb = timer.callback;
        const onReturn = timer.pumpOnReturn;
        if (!timer.active || !cb || !onReturn) return;
        if (!system.process || system.isExiting) return;
        // Coalesce while our tick is queued or running. If it was lost without
        // returning (pump queue reset, pump thread gone) stop waiting for it.
        if (timer.inFlight && scheduler.isTimerCallbackPending((posted) => posted.onReturn === onReturn)) return;
        timer.inFlight = true;
        if (!scheduler.postTimerCallback(cb, [timer.user], onReturn)) {
            timer.inFlight = false;
            ctx.pendingTimerCallbacks.push({ callback: cb, user: timer.user, handle });
        }
    });

    // _AIL_register_timer@4
    exports["_AIL_register_timer@4"] = (ctxThunk, mem, args) => {
        const callback = args[0];
        const handle = ctx.nextTimerId++;
        ctx.timers.set(handle, { handle, callback, user: 0, freq: 0, period: 0, active: false });
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_register_timer@4 -> ${handle} (cb=0x${callback.toString(16)})`);
        return handle;
    };

    // _AIL_set_timer_user@8
    exports["_AIL_set_timer_user@8"] = (ctxThunk, mem, args) => {
        const timer = ctx.timers.get(args[0]);
        if (timer) timer.user = args[1];
        return 0;
    };

    // _AIL_set_timer_frequency@8
    exports["_AIL_set_timer_frequency@8"] = (ctxThunk, mem, args) => {
        const timer = ctx.timers.get(args[0]);
        if (timer) timer.freq = args[1];
        return args[1];
    };

    // _AIL_set_timer_period@8
    exports["_AIL_set_timer_period@8"] = (ctxThunk, mem, args) => {
        const timer = ctx.timers.get(args[0]);
        if (timer) timer.period = args[1];
        return args[1];
    };

    // _AIL_start_timer@4
    exports["_AIL_start_timer@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        const timer = ctx.timers.get(handle);
        if (timer) {
            timer.active = true;
            if (timer.timerId) {
                return 0;
            }
            const periodMs = timer.freq > 0 ? Math.max(1, Math.floor(1000 / timer.freq)) : Math.max(1, timer.period || 15);
            const system = System.getInstance();
            const scheduler = system.scheduler;
            if (!scheduler) {
                Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_start_timer@4 handle=${handle} — scheduler unavailable, timer disabled`);
                return 0;
            }
            const cb = timer.callback;
            // Miles AIL timer = the software-mixer/stream service clock. Driven by the scheduler
            // virtual-time timer wheel, NOT host setInterval — a busy-spinning guest thread starves
            // host macrotasks, so the mixer would never be serviced → audio stall + audio-gated game
            // logic stall (Re-Volt mac). The wheel is polled in-band with guest execution.
            // Miles runs timer callbacks on its own background thread, independent of whether
            // the app ever calls AIL_serve, so ticks go to the shared timer-pump thread; the
            // AIL_serve queue is only the fallback when no pump thread can be created.
            scheduler.ensureTimerPumpThread();
            // A tick posted by an earlier start (still running after a stop) must not clear
            // this start's coalescing flag, hence the identity check.
            armTimerPump(timer);
            timer.timerId = scheduler.timerWheel.add(
                periodMs, true, TimerKind.MSS_TIMER, handle,
                TimeService.getInstance().nowMs(),
            );
            Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_start_timer@4 started handle=${handle} period=${periodMs}ms cb=0x${cb.toString(16)}`);
        }
        return 0;
    };

    // _AIL_stop_timer@4
    exports["_AIL_stop_timer@4"] = (ctxThunk, mem, args) => {
        const timer = ctx.timers.get(args[0]);
        if (timer) {
            timer.active = false;
            if (timer.timerId) {
                System.getInstance().scheduler?.timerWheel.cancel(timer.timerId);
                timer.timerId = undefined;
            }
            withdrawPendingTicks(ctx, timer);
        }
        return 0;
    };

    // _AIL_release_timer_handle@4
    exports["_AIL_release_timer_handle@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        const timer = ctx.timers.get(handle);
        if (timer) {
            timer.active = false;
            if (timer.timerId) {
                System.getInstance().scheduler?.timerWheel.cancel(timer.timerId);
                timer.timerId = undefined;
            }
            withdrawPendingTicks(ctx, timer);
        }
        ctx.timers.delete(handle);
        return 0;
    };

    return exports;
}
