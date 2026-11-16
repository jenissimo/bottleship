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
for (const name of ["_ltow", "_ltow_s"]) {
    for (const mode of ["valid", "character", "terminator", "clearing"] as const) {
        test(name + " dispatches " + mode + " output through the cdecl boundary", () => {
            f = crtDispatchFixture(name);
            const dst = f.put(0x1000, "keep"), bad = mode === "terminator" ? dst + 4 : dst;
            if (mode !== "valid") f.deny(bad);
            f.call([12, dst, ...(name.endsWith("_s") ? [8] : []), mode === "clearing" ? 1 : 10]);
            if (mode === "valid") {
                f.expectReturn(name.endsWith("_s") ? 0 : dst);
                expect([0, 2, 4].map(i => f!.dv.getUint16(dst + i, true))).toEqual([49, 50, 0]);
            } else {
                f.expectFault(bad);
                expect(f.writes.at(-1)).toBe(bad);
                expect(f.dv.getUint16(bad, true)).toBe(mode === "terminator" ? 101 : 107);
                if (mode === "terminator") expect([f.dv.getUint16(dst, true), f.dv.getUint16(dst + 2, true)]).toEqual([49, 50]);
            }
        });
    }
}
test("_ltow_s dispatches a refused short-buffer clearing store", () => {
    f = crtDispatchFixture("_ltow_s"); const dst = f.put(0x1000, "keep");
    f.deny(dst); f.call([12, dst, 1, 10]); f.expectFault(dst);
    expect(f.dv.getUint16(dst, true)).toBe(107);
});

test("guest ContinueExecution retries the failed cdecl call with its caller frame intact", () => {
    f = crtDispatchFixture("_ltow_s");
    f.deny(0x1000); f.call([12, 0x1000, 8, 10]);
    f.expectFault(0x1000); f.expectRetry();
});

// Permissions below come from AddressSpace; accessors are not mocked.

test("_ltow reports the first inaccessible byte of a crossing WCHAR store (r)", () => {
    f = crtDispatchFixture("_ltow"); const dst = f.put(0x1fff, ""), input = f.put(0x4000, "xy");
    f.protect(0x2000, 0x1000, "r");
    f.call([12, dst, 10]); f.expectFault(0x2000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("_ltow reports the first inaccessible byte of a crossing WCHAR store (noaccess)", () => {
    f = crtDispatchFixture("_ltow"); const dst = f.put(0x1fff, ""), input = f.put(0x4000, "xy");
    f.protect(0x2000, 0x1000, "noaccess");
    f.call([12, dst, 10]); f.expectFault(0x2000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("_ltow reports the first byte when the first page is read-only", () => {
    f = crtDispatchFixture("_ltow"); const dst = f.put(0x1fff, ""), input = f.put(0x4000, "xy");
    f.protect(0x1000, 0x1000, "r"); f.call([12, dst, 10]); f.expectFault(dst);
});

test("_ltow_s reports the first inaccessible byte of a crossing WCHAR store (r)", () => {
    f = crtDispatchFixture("_ltow_s"); const dst = f.put(0x1fff, ""), input = f.put(0x4000, "xy");
    f.protect(0x2000, 0x1000, "r");
    f.call([12, dst, 8, 10]); f.expectFault(0x2000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("_ltow_s reports the first inaccessible byte of a crossing WCHAR store (noaccess)", () => {
    f = crtDispatchFixture("_ltow_s"); const dst = f.put(0x1fff, ""), input = f.put(0x4000, "xy");
    f.protect(0x2000, 0x1000, "noaccess");
    f.call([12, dst, 8, 10]); f.expectFault(0x2000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("_ltow_s reports the first byte when the first page is read-only", () => {
    f = crtDispatchFixture("_ltow_s"); const dst = f.put(0x1fff, ""), input = f.put(0x4000, "xy");
    f.protect(0x1000, 0x1000, "r"); f.call([12, dst, 8, 10]); f.expectFault(dst);
});
