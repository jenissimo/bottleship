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
for (const name of ["wcscpy_s", "wcscat_s", "wcsncpy_s", "wcsncat_s"]) {
    for (const mode of ["valid", "character", "terminator", "clearing"] as const) {
        test(name + " dispatches " + mode + " output through the cdecl boundary", () => {
            f = crtDispatchFixture(name);
            const dst = 0x1000, src = f.put(0x2000, "xy");
            f.put(dst, ""); f.dv.setUint16(dst + 4, 0x5555, true);
            const bad = mode === "terminator" ? dst + 4 : dst;
            if (mode !== "valid") f.deny(bad);
            f.call([dst, 8, mode === "clearing" ? 0 : src, 2]);
            if (mode === "valid") {
                f.expectReturn(0);
                expect([0, 2, 4].map(i => f!.dv.getUint16(dst + i, true))).toEqual([120, 121, 0]);
            } else {
                f.expectFault(bad);
                expect(f.writes.at(-1)).toBe(bad);
                expect(f.dv.getUint16(bad, true)).toBe(mode === "terminator" ? 0x5555 : 0);
                if (mode === "terminator") expect([f.dv.getUint16(dst, true), f.dv.getUint16(dst + 2, true)]).toEqual([120, 121]);
            }
        });
    }
}

test("guest ContinueExecution retries the failed cdecl call with its caller frame intact", () => {
    f = crtDispatchFixture("wcscpy_s"); const src = f.put(0x2000, "xy");
    f.deny(0x1000); f.call([0x1000, 8, src]);
    f.expectFault(0x1000); f.expectRetry();
});
