import { describe, expect, test } from "bun:test";
import { WinMM } from "../../src/worker/modules/winmm";
import { TimeService } from "../../src/worker/runtime/time";

const TIMERR_NOERROR = 0;

function timerExports() {
    const winmm = new WinMM();
    winmm.initialize({} as never);
    return (name: string, args: number[], mem = new Uint8Array(64)) =>
        (winmm.exports[name] as (c: unknown, m: Uint8Array, a: number[]) => number)({ esp: 0 }, mem, args);
}

describe("multimedia timer period range", () => {
    test("timeGetDevCaps reports the NT maximum and timeBeginPeriod accepts a coarse period", () => {
        const call = timerExports();
        const mem = new Uint8Array(64);
        expect(call("timeGetDevCaps", [8, 8], mem)).toBe(TIMERR_NOERROR);
        const max = new DataView(mem.buffer).getUint32(12, true);
        expect(max).toBe(1000000);
        expect(call("timeBeginPeriod", [0xffff])).toBe(TIMERR_NOERROR);
        expect(TimeService.getInstance().timerResolutionMs ?? TimeService.DEFAULT_TIMER_RESOLUTION_MS)
            .toBe(TimeService.DEFAULT_TIMER_RESOLUTION_MS);
        expect(call("timeEndPeriod", [0xffff])).toBe(TIMERR_NOERROR);
    });

    test("negative control: a period beyond the maximum is still refused", () => {
        const call = timerExports();
        expect(call("timeBeginPeriod", [1000001])).not.toBe(TIMERR_NOERROR);
        expect(call("timeBeginPeriod", [0])).not.toBe(TIMERR_NOERROR);
    });
});
