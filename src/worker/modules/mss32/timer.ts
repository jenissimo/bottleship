import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { System } from "../../core/system";
import { TimerKind } from "../../core/scheduler/types";
import { TimeService } from "../../runtime/time";
import { MSSContext } from "./context";

export function createTimerExports(ctx: MSSContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

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
            const cbArgs = [0];
            const onReturn = () => { timer.inFlight = false; };
            timer.timerId = scheduler.timerWheel.add(
                periodMs, true, TimerKind.MSS_TIMER,
                () => {
                    if (!timer.active || !cb) return;
                    if (!system.process || system.isExiting) return;
                    if (timer.inFlight) return;
                    timer.inFlight = true;
                    cbArgs[0] = timer.user;
                    if (!scheduler.postTimerCallback(cb, cbArgs, onReturn)) {
                        timer.inFlight = false;
                        ctx.pendingTimerCallbacks.push({ callback: cb, user: timer.user });
                    }
                },
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
        }
        return 0;
    };

    // _AIL_release_timer_handle@4
    exports["_AIL_release_timer_handle@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        const timer = ctx.timers.get(handle);
        if (timer?.timerId) {
            System.getInstance().scheduler?.timerWheel.cancel(timer.timerId);
        }
        ctx.timers.delete(handle);
        return 0;
    };

    return exports;
}
