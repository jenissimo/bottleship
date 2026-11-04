import { afterEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { createTimerExports } from "../../src/worker/modules/mss32/timer";
import type { MSSContext } from "../../src/worker/modules/mss32/context";

type Posted = { callbackAddr: number; args: number[]; onReturn?: () => void };
const CB = 0x401000, USER = 0x1234;
const system = System.getInstance();
const saved = { scheduler: system.scheduler, process: system.process, isExiting: system.isExiting };
afterEach(() => Object.assign(system, saved));

/** A scheduler whose timer pump is a plain queue; `pump: false` = no pump thread. */
function rig(pump = true) {
    const fires = new Map<number, () => void>();
    let queue: Posted[] = [];
    let nextWheelId = 1;
    const scheduler = {
        timerWheel: {
            add: (_ms: number, _periodic: boolean, _kind: unknown, fn: () => void) => { fires.set(nextWheelId, fn); return nextWheelId++; },
            cancel: (id: number) => fires.delete(id),
        },
        ensureTimerPumpThread: () => {},
        postTimerCallback: (callbackAddr: number, args: number[], onReturn?: () => void) =>
            pump && (queue.push({ callbackAddr, args: [...args], onReturn }), true),
        cancelTimerCallbacks: (m: (cb: Posted) => boolean) => { const n = queue.length; queue = queue.filter((cb) => !m(cb)); return n - queue.length; },
        isTimerCallbackPending: (m: (cb: Posted) => boolean) => queue.some(m),
    };
    Object.assign(system, { scheduler, process: {}, isExiting: false });
    const ctx = { timers: new Map(), nextTimerId: 1, pendingTimerCallbacks: [] } as unknown as MSSContext;
    const api = createTimerExports(ctx);
    const call = (name: string, ...args: number[]) => api[name]!({} as never, new Uint8Array(0), args);
    const tick = () => [...fires.values()].forEach((fn) => fn());
    /** Run the pump: deliver every queued callback and report what ran. */
    const drain = () => { const ran = queue; queue = []; ran.forEach((cb) => cb.onReturn?.()); return ran; };
    const h = call("_AIL_register_timer@4", CB);
    call("_AIL_set_timer_user@8", h, USER);
    call("_AIL_set_timer_frequency@8", h, 100);
    return { ctx, call, tick, drain, h, lose: () => { queue = []; } };
}

describe("MSS32 AIL timer on the timer pump", () => {
    test("posts with the user arg and coalesces ticks until the callback returns", () => {
        const r = rig();
        r.call("_AIL_start_timer@4", r.h);
        r.tick(); r.tick(); r.tick();
        expect(r.drain().map((cb) => [cb.callbackAddr, cb.args[0]])).toEqual([[CB, USER]]);
        r.tick();
        expect(r.drain()).toHaveLength(1);
    });

    test("falls back to the AIL_serve queue without a pump thread", () => {
        const r = rig(false);
        r.call("_AIL_start_timer@4", r.h);
        r.tick(); r.tick();
        expect(r.ctx.pendingTimerCallbacks.map((p) => p.user)).toEqual([USER, USER]);
        r.call("_AIL_stop_timer@4", r.h);
        expect(r.ctx.pendingTimerCallbacks).toHaveLength(0);
    });

    test("no callback after stop; a restart ticks again", () => {
        const r = rig();
        r.call("_AIL_start_timer@4", r.h);
        r.tick();
        r.call("_AIL_stop_timer@4", r.h);
        expect(r.drain()).toHaveLength(0);
        r.call("_AIL_start_timer@4", r.h);
        r.tick();
        expect(r.drain()).toHaveLength(1);
    });

    test("no callback after release", () => {
        const r = rig();
        r.call("_AIL_start_timer@4", r.h);
        r.tick();
        r.call("_AIL_release_timer_handle@4", r.h);
        expect(r.drain()).toHaveLength(0);
    });

    test("a tick lost without returning does not silence the timer", () => {
        const r = rig();
        r.call("_AIL_start_timer@4", r.h);
        r.tick();
        r.lose();
        r.tick();
        expect(r.drain()).toHaveLength(1);
    });
});
