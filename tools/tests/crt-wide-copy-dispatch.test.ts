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
for (const name of ["wcscpy_s", "wcscat_s", "wcsncpy_s", "wcsncat_s"]) {
    for (const mode of ["valid", "character", "terminator", "clearing"] as const) {
        test(name + " dispatches " + mode + " output through the cdecl boundary", () => {
            f = crtDispatchFixture(name);
            const dst = 0x11000, src = f.put(0x12000, "xy");
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
    f = crtDispatchFixture("wcscpy_s"); const src = f.put(0x12000, "xy");
    f.deny(0x11000); f.call([0x11000, 8, src]);
    f.expectFault(0x11000); f.expectRetry();
});

// Permissions below come from AddressSpace; accessors are not mocked.
for (const name of ["wcscpy_s", "wcscat_s", "wcsncpy_s", "wcsncat_s"]) {
    test(name + " preserves output and errno when a later source WCHAR is NOACCESS", () => {
        f = crtDispatchFixture(name); const src = f.put(0x13000, "xy"), dst = f.put(0x11000, name.includes("cat") ? "a" : "keep");
        f.protect(src + 2, 2, "noaccess"); f.call([dst, 8, src, 2]); f.expectFault(src + 2, "r");
        expect(f.reads).not.toContain(src + 2);
        const offset = name.includes("cat") ? 2 : 0;
        expect(f.dv.getUint16(dst + offset, true)).toBe(120);
        expect(f.dv.getUint16(dst + offset + 2, true)).toBe(name.includes("cat") ? 0 : 101);
    });
    test(name + " attributes a crossing source read to the protected second byte", () => {
        f = crtDispatchFixture(name); const src = f.put(0x11fff, "x"), dst = f.put(0x14000, "");
        f.protect(0x12000, 0x1000, "noaccess"); f.call([dst, 8, src, 2]); f.expectFault(0x12000, "r");
        expect(f.writes).toEqual([]);
    });
}
for (const name of ["wcscat_s", "wcsncat_s"]) test(name + " faults while scanning a protected destination", () => {
    f = crtDispatchFixture(name); const dst = f.put(0x11000, "ab"), src = f.put(0x13000, "x");
    f.protect(dst + 2, 2, "noaccess"); f.call([dst, 8, src, 2]); f.expectFault(dst + 2, "r");
    expect(f.writes).toEqual([]); expect(f.dv.getUint16(dst, true)).toBe(97);
});

test("wcscpy_s reports the first inaccessible byte of a crossing WCHAR store (r)", () => {
    f = crtDispatchFixture("wcscpy_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x12000, 0x1000, "r");
    f.call([dst, 8, input, 2]); f.expectFault(0x12000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("wcscpy_s reports the first inaccessible byte of a crossing WCHAR store (noaccess)", () => {
    f = crtDispatchFixture("wcscpy_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x12000, 0x1000, "noaccess");
    f.call([dst, 8, input, 2]); f.expectFault(0x12000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("wcscpy_s reports the first byte when the first page is read-only", () => {
    f = crtDispatchFixture("wcscpy_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x11000, 0x1000, "r"); f.call([dst, 8, input, 2]); f.expectFault(dst);
});

test("wcscat_s reports the first inaccessible byte of a crossing WCHAR store (r)", () => {
    f = crtDispatchFixture("wcscat_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x12000, 0x1000, "r");
    f.call([dst, 8, input, 2]); f.expectFault(0x12000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("wcscat_s reports the first byte when the first page is read-only", () => {
    f = crtDispatchFixture("wcscat_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x11000, 0x1000, "r"); f.call([dst, 8, input, 2]); f.expectFault(dst);
});

test("wcsncpy_s reports the first inaccessible byte of a crossing WCHAR store (r)", () => {
    f = crtDispatchFixture("wcsncpy_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x12000, 0x1000, "r");
    f.call([dst, 8, input, 2]); f.expectFault(0x12000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("wcsncpy_s reports the first inaccessible byte of a crossing WCHAR store (noaccess)", () => {
    f = crtDispatchFixture("wcsncpy_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x12000, 0x1000, "noaccess");
    f.call([dst, 8, input, 2]); f.expectFault(0x12000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("wcsncpy_s reports the first byte when the first page is read-only", () => {
    f = crtDispatchFixture("wcsncpy_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x11000, 0x1000, "r"); f.call([dst, 8, input, 2]); f.expectFault(dst);
});

test("wcsncat_s reports the first inaccessible byte of a crossing WCHAR store (r)", () => {
    f = crtDispatchFixture("wcsncat_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x12000, 0x1000, "r");
    f.call([dst, 8, input, 2]); f.expectFault(0x12000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("wcsncat_s reports the first byte when the first page is read-only", () => {
    f = crtDispatchFixture("wcsncat_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x11000, 0x1000, "r"); f.call([dst, 8, input, 2]); f.expectFault(dst);
});

// Process uses Mem.bind(getMemory), with no injected validator or data routes.
for (const name of ["wcscpy_s", "wcscat_s", "wcsncpy_s", "wcsncat_s"]) {
    for (const mode of ["valid", "character", "terminator", "clearing", "crossing", "noaccess", "input"] as const) {
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
            else if (mode === "input") { bad = input + 2; f.protect(bad, 2, "noaccess"); }
            f.call([dst, mode === "clearing" ? 1 : 16, input, 2]);
            expect(f.reads).toEqual([]); expect(f.writes).toEqual([]);
            if (mode === "valid") {
                f.expectReturn(0); expect(f.dv.getUint16(dst, true)).toBe(120);
            } else {
                f.expectFault(bad, mode === "input" || (mode === "noaccess" && name.includes("cat")) ? "r" : "w");
                if (mode === "terminator") expect(f.dv.getUint16(bad, true)).toBe(0x5555);
                else if (mode === "character" || mode === "clearing" || mode === "crossing" || mode === "noaccess") expect(f.dv.getUint16(dst, true)).toBe(0);
                else if (mode === "input") expect(f.dv.getUint16(dst, true)).toBe(120);
            }
        });
    }
}

test("CRT admission does not globally restrict privileged HLE writes", () => {
    f = crtDispatchFixture("wcscpy_s"); f.useProductionBinding();
    const dst = 0x20000, input = f.put(0x22000, "xy"); f.protect(dst, 2, "r");
    expect(Mem.writeUint16(dst, 0x77)).toBe(true);
    f.call([dst, 8, input]); f.expectFault(dst);
    expect(f.dv.getUint16(dst, true)).toBe(0x77);
});

for (const name of ["wcscat_s", "wcsncat_s"]) test(name + " checks append-position reads with the production binding", () => {
    f = crtDispatchFixture(name); f.useProductionBinding();
    const dst = f.put(0x20000, "ab"), input = f.put(0x22000, "xy");
    f.protect(dst + 2, 2, "noaccess"); f.call([dst, 16, input, 2]); f.expectFault(dst + 2, "r");
    expect(f.dv.getUint16(dst, true)).toBe(97);
});
