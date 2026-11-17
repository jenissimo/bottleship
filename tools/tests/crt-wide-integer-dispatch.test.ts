import {Mem} from "../../src/worker/core/memory/mem-accessor";
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
            const dst = f.put(0x11000, "keep"), bad = mode === "terminator" ? dst + 4 : dst;
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
    f = crtDispatchFixture("_ltow_s"); const dst = f.put(0x11000, "keep");
    f.deny(dst); f.call([12, dst, 1, 10]); f.expectFault(dst);
    expect(f.dv.getUint16(dst, true)).toBe(107);
});

test("guest ContinueExecution retries the failed cdecl call with its caller frame intact", () => {
    f = crtDispatchFixture("_ltow_s");
    f.deny(0x11000); f.call([12, 0x11000, 8, 10]);
    f.expectFault(0x11000); f.expectRetry();
});

// Permissions below come from AddressSpace; accessors are not mocked.

test("_ltow reports the first inaccessible byte of a crossing WCHAR store (r)", () => {
    f = crtDispatchFixture("_ltow"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x12000, 0x1000, "r");
    f.call([12, dst, 10]); f.expectFault(0x12000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("_ltow reports the first inaccessible byte of a crossing WCHAR store (noaccess)", () => {
    f = crtDispatchFixture("_ltow"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x12000, 0x1000, "noaccess");
    f.call([12, dst, 10]); f.expectFault(0x12000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("_ltow reports the first byte when the first page is read-only", () => {
    f = crtDispatchFixture("_ltow"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x11000, 0x1000, "r"); f.call([12, dst, 10]); f.expectFault(dst);
});

test("_ltow_s reports the first inaccessible byte of a crossing WCHAR store (r)", () => {
    f = crtDispatchFixture("_ltow_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x12000, 0x1000, "r");
    f.call([12, dst, 8, 10]); f.expectFault(0x12000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("_ltow_s reports the first inaccessible byte of a crossing WCHAR store (noaccess)", () => {
    f = crtDispatchFixture("_ltow_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x12000, 0x1000, "noaccess");
    f.call([12, dst, 8, 10]); f.expectFault(0x12000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("_ltow_s reports the first byte when the first page is read-only", () => {
    f = crtDispatchFixture("_ltow_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x11000, 0x1000, "r"); f.call([12, dst, 8, 10]); f.expectFault(dst);
});

// Process uses Mem.bind(getMemory), with no injected validator or data routes.
for (const name of ["_ltow", "_ltow_s"]) {
    for (const mode of ["valid", "character", "terminator", "clearing", "crossing", "noaccess"] as const) {
        test(name + " enforces CRT pointer admission with the production binding: " + mode, () => {
            f = crtDispatchFixture(name); f.useProductionBinding();
            const dst = mode === "crossing" ? 0x20fff : 0x20000;
            const input = f.put(0x22000, "xy"); f.put(dst, "");
            let bad = dst;
            const length = 2;
            if (mode === "terminator") { bad = dst + length * 2; f.dv.setUint16(bad, 0x5555, true); }
            if (mode === "crossing") { bad = 0x21000; f.protect(bad, 0x1000, "r"); }
            else if (mode === "noaccess") f.protect(dst, 2, "noaccess");
            else if (["character", "terminator", "clearing"].includes(mode)) f.protect(bad, 2, "r");
            f.call([12, dst, ...(name.endsWith("_s") ? [16] : []), mode === "clearing" ? 1 : 10]);
            expect(f.reads).toEqual([]); expect(f.writes).toEqual([]);
            if (mode === "valid") {
                f.expectReturn(name === "_ltow" ? dst : 0); expect(f.dv.getUint16(dst, true)).toBe(49);
            } else {
                f.expectFault(bad, "w");
                if (mode === "terminator") expect(f.dv.getUint16(bad, true)).toBe(0x5555);
                else if (mode === "character" || mode === "clearing" || mode === "crossing" || mode === "noaccess") expect(f.dv.getUint16(dst, true)).toBe(0);
            }
        });
    }
}

test("CRT admission does not globally restrict privileged HLE writes", () => {
    f = crtDispatchFixture("_ltow"); f.useProductionBinding();
    const dst = 0x20000, input = f.put(0x22000, "xy"); f.protect(dst, 2, "r");
    expect(Mem.writeUint16(dst, 0x77)).toBe(true);
    f.call([12, dst, 10]); f.expectFault(dst);
    expect(f.dv.getUint16(dst, true)).toBe(0x77);
});
