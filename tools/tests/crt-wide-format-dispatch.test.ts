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
for (const name of ["swprintf_s", "_snwprintf_s"]) {
    for (const mode of ["valid", "character", "terminator", "clearing", "overflow clearing"] as const) {
        test(name + " dispatches " + mode + " output through the cdecl boundary", () => {
            f = crtDispatchFixture(name);
            const dst = f.put(0x1000, "keep"), fmt = f.put(0x2000, mode === "clearing" ? "%q" : "xy");
            const bad = mode === "terminator" ? dst + 4 : dst;
            if (mode !== "valid") f.deny(bad);
            const size = mode === "overflow clearing" ? 1 : 8;
            f.call([dst, size, ...(name.startsWith("_") ? [0xffffffff] : []), fmt]);
            if (mode === "valid") {
                f.expectReturn(2);
                expect([0, 2, 4].map(i => f!.dv.getUint16(dst + i, true))).toEqual([120, 121, 0]);
            } else {
                f.expectFault(bad);
                expect(f.writes.at(-1)).toBe(bad);
                expect(f.dv.getUint16(bad, true)).toBe(mode === "terminator" ? 101 : 107);
                if (mode === "terminator") expect([f.dv.getUint16(dst, true), f.dv.getUint16(dst + 2, true)]).toEqual([120, 121]);
            }
        });
    }
}

test("guest ContinueExecution retries the failed cdecl call with its caller frame intact", () => {
    f = crtDispatchFixture("swprintf_s"); const fmt = f.put(0x2000, "xy");
    f.deny(0x1000); f.call([0x1000, 8, fmt]);
    f.expectFault(0x1000); f.expectRetry();
});

for (const name of ["swprintf_s", "_snwprintf_s"]) test(name + " dispatches an unreadable format unit", () => {
    f = crtDispatchFixture(name); const fmt = f.put(0x2000, "xy");
    f.denyRead(fmt + 2); f.call([0x1000, 8, ...(name.startsWith("_") ? [7] : []), fmt]);
    f.expectFault(fmt + 2, "r"); expect(f.writes).toEqual([]);
});
