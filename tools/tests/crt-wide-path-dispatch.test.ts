import {afterEach, beforeEach, expect, spyOn, test} from "bun:test";
import {Logger} from "../../src/worker/core/logger";
import {crtDispatchFixture} from "./helpers/crt-dispatch-fixture";

let f: ReturnType<typeof crtDispatchFixture> | undefined;
let log: ReturnType<typeof spyOn>, error: ReturnType<typeof spyOn>;
beforeEach(() => {
    log = spyOn(Logger, "log").mockImplementation(() => {});
    error = spyOn(Logger, "error").mockImplementation(() => {});
});
afterEach(() => { f?.restore(); f = undefined; log.mockRestore(); error.mockRestore(); });
for (const name of ["_wfullpath", "_wmakepath_s", "_wsplitpath_s"]) {
    for (const mode of ["valid", "character", "terminator", "clearing"] as const) {
        test(name + " dispatches " + mode + " output through the cdecl boundary", () => {
            f = crtDispatchFixture(name);
            const dst = f.put(0x1000, "keep"), path = f.put(0x2000, "C:\\xy");
            const output = name === "_wfullpath" ? "C:\\xy" : "xy";
            const bad = mode === "terminator" ? dst + output.length * 2 : dst;
            f.dv.setUint16(dst + output.length * 2, 0x5555, true);
            if (mode !== "valid") f.deny(bad);
            const size = mode === "clearing" ? 1 : 32;
            const args = name === "_wfullpath" ? [dst, path, size] : name === "_wmakepath_s" ?
                [dst, size, 0, 0, f.put(0x2200, "xy"), 0] : [path, 0, 0, 0, 0, dst, size, 0, 0];
            f.call(args);
            if (mode === "valid") {
                f.expectReturn(name === "_wfullpath" ? dst : 0);
                expect(Array.from({length: output.length + 1}, (_, i) => f!.dv.getUint16(dst + i * 2, true)))
                    .toEqual([...output].map(c => c.charCodeAt(0)).concat(0));
            } else {
                f.expectFault(bad); expect(f.writes.at(-1)).toBe(bad);
                expect(f.dv.getUint16(bad, true)).toBe(mode === "terminator" ? 0x5555 : 107);
                if (mode === "terminator") expect(Array.from({length: output.length}, (_, i) => f!.dv.getUint16(dst + i * 2, true)))
                    .toEqual([...output].map(c => c.charCodeAt(0)));
            }
        });
    }
}
test("_wsplitpath_s preserves earlier components and stops at a later refused output", () => {
    f = crtDispatchFixture("_wsplitpath_s");
    const path = f.put(0x2000, "C:\\xy"), drive = f.put(0x1000, "keep"), dir = f.put(0x1100, "keep");
    f.deny(dir); f.call([path, drive, 3, dir, 8, 0, 0, 0, 0]); f.expectFault(dir);
    expect([0, 2, 4].map(i => f!.dv.getUint16(drive + i, true))).toEqual([67, 58, 0]);
    expect(f.dv.getUint16(dir, true)).toBe(107);
});

test("guest ContinueExecution retries the failed cdecl call with its caller frame intact", () => {
    f = crtDispatchFixture("_wfullpath"); const path = f.put(0x2000, "C:\\xy");
    f.deny(0x1000); f.call([0x1000, path, 32]);
    f.expectFault(0x1000); f.expectRetry();
});

test("_wsplitpath_s stops clearing at a refused component on invalid input", () => {
    f = crtDispatchFixture("_wsplitpath_s");
    const drive = f.put(0x1000, "keep"), dir = f.put(0x1100, "keep"), file = f.put(0x1200, "keep");
    f.deny(dir); f.call([0, drive, 8, dir, 8, file, 8, 0, 0]); f.expectFault(dir);
    expect(f.dv.getUint16(drive, true)).toBe(0);
    expect(f.dv.getUint16(dir, true)).toBe(107); expect(f.dv.getUint16(file, true)).toBe(107);
});
