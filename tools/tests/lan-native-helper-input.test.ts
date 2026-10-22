import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { NativeHelperSocket } from "../../packages/lan/src/native-helper";
import { TCP_WINDOW } from "../../packages/lan/src/tcp-protocol";

test("a stalled native input pipe bounds accepted control bytes and aborts visibly", () => {
    const helper = new NativeHelperSocket("unused"), failures: number[] = [];
    let killed = 0, peak = 0;
    const input = new Writable({ highWaterMark: 1, write(_data, _encoding, _complete) { /* consumer is blocked */ } });
    input.on("error", () => {});
    helper.on("error", error => failures.push((error as { code: number }).code));
    Object.assign(helper, { child: { stdin: input, stdout: { destroy() {} }, stderr: { destroy() {} }, kill() { killed++; } } });
    try {
        for (let index = 0; index < 40000 && !failures.length; index++) {
            helper.setNoDelay(!!(index & 1)); peak = Math.max(peak, input.writableLength);
        }
        expect(failures).toEqual([10055]); expect(killed).toBe(1);
        expect(peak).toBeGreaterThan(TCP_WINDOW); expect(peak).toBeLessThanOrEqual(TCP_WINDOW + 4096);
    } finally { helper.destroy(); }
});

test("input write callbacks return byte credit even when writable reports backpressure", () => {
    const helper = new NativeHelperSocket("unused"), callbacks: (() => void)[] = [], failures: number[] = [];
    let written = 0;
    const input = { writable: true, write(_bytes: Buffer, callback: () => void) { written++; callbacks.push(callback); return false; }, destroy() {} };
    helper.on("error", error => failures.push((error as { code: number }).code));
    Object.assign(helper, { child: { stdin: input, stdout: { destroy() {} }, stderr: { destroy() {} }, kill() {} } });
    try {
        for (let batch = 0; batch < 30; batch++) {
            for (let index = 0; index < 1000; index++) helper.setKeepAlive(!!(index & 1));
            for (const callback of callbacks.splice(0)) callback();
        }
        expect(written).toBe(30000); expect(failures).toEqual([]);
    } finally { helper.destroy(); }
    // Retired pipe callbacks cannot return credit to a later/closed child.
    for (const callback of callbacks.splice(0)) callback();
});
