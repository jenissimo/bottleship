import {Mem} from "../../src/worker/core/memory/mem-accessor";
import {afterEach, beforeEach, expect, spyOn, test} from "bun:test";
import {EmulatorConfig} from "../../src/worker/core/emulator-config-manager";
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
            const dst = f.put(0x11000, "keep"), fmt = f.put(0x12000, mode === "clearing" ? "%q" : "xy");
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
    f = crtDispatchFixture("swprintf_s"); const fmt = f.put(0x12000, "xy");
    f.deny(0x11000); f.call([0x11000, 8, fmt]);
    f.expectFault(0x11000); f.expectRetry();
});

for (const name of ["swprintf_s", "_snwprintf_s"]) test(name + " dispatches an unreadable format unit", () => {
    f = crtDispatchFixture(name); const fmt = f.put(0x12000, "xy");
    f.denyRead(fmt + 2); f.call([0x11000, 8, ...(name.startsWith("_") ? [7] : []), fmt]);
    f.expectFault(fmt + 2, "r"); expect(f.writes).toEqual([]);
});

// Permissions below come from AddressSpace; accessors are not mocked.
for (const name of ["swprintf_s", "_snwprintf_s"]) {
    for (const spec of ["%s", "%ls", "%ws", "%lS", "%hs", "%S"]) {
        test(name + " faults on a protected " + spec + " argument through the production formatter", () => {
            f = crtDispatchFixture(name); const dst = f.put(0x11000, "keep"), fmt = f.put(0x14000, spec);
            const wide = !["%hs", "%S"].includes(spec), input = 0x13000;
            if (wide) f.put(input, "xy"); else f.mem.set([120, 121, 0], input);
            const bad = input + (wide ? 2 : 1); f.protect(bad, 1, "noaccess");
            f.call([dst, 16, ...(name.startsWith("_") ? [15] : []), fmt, input]); f.expectFault(bad, "r");
            expect(f.reads).not.toContain(bad); expect(f.writes).toEqual([]); expect(f.dv.getUint16(dst, true)).toBe(107);
        });
    }
    test(name + " attributes a crossing string argument read to the protected byte", () => {
        f = crtDispatchFixture(name); const input = f.put(0x11fff, "x"), fmt = f.put(0x14000, "%s");
        f.protect(0x12000, 0x1000, "noaccess");
        f.call([0x15000, 8, ...(name.startsWith("_") ? [7] : []), fmt, input]); f.expectFault(0x12000, "r");
        expect(f.writes).toEqual([]);
    });
    test(name + " retains null string argument behavior", () => {
        f = crtDispatchFixture(name); const fmt = f.put(0x14000, "%s");
        f.call([0x11000, 16, ...(name.startsWith("_") ? [15] : []), fmt, 0]); f.expectReturn(6);
    });
}
test("legacy swprintf keeps its existing reader behavior", () => {
    f = crtDispatchFixture("swprintf"); const input = f.put(0x13000, "xy"), fmt = f.put(0x14000, "%s");
    f.protect(input + 2, 2, "noaccess"); f.call([0x11000, fmt, input]); f.expectReturn(2);
    expect(f.dv.getUint16(0x11000, true)).toBe(120); expect(f.dv.getUint16(0x11002, true)).toBe(121);
});

test("swprintf_s reports the first inaccessible byte of a crossing WCHAR store (r)", () => {
    f = crtDispatchFixture("swprintf_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x12000, 0x1000, "r");
    f.call([dst, 8, input]); f.expectFault(0x12000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("swprintf_s reports the first inaccessible byte of a crossing WCHAR store (noaccess)", () => {
    f = crtDispatchFixture("swprintf_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x12000, 0x1000, "noaccess");
    f.call([dst, 8, input]); f.expectFault(0x12000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("swprintf_s reports the first byte when the first page is read-only", () => {
    f = crtDispatchFixture("swprintf_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x11000, 0x1000, "r"); f.call([dst, 8, input]); f.expectFault(dst);
});

test("_snwprintf_s reports the first inaccessible byte of a crossing WCHAR store (r)", () => {
    f = crtDispatchFixture("_snwprintf_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x12000, 0x1000, "r");
    f.call([dst, 8, 7, input]); f.expectFault(0x12000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("_snwprintf_s reports the first inaccessible byte of a crossing WCHAR store (noaccess)", () => {
    f = crtDispatchFixture("_snwprintf_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x12000, 0x1000, "noaccess");
    f.call([dst, 8, 7, input]); f.expectFault(0x12000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("_snwprintf_s reports the first byte when the first page is read-only", () => {
    f = crtDispatchFixture("_snwprintf_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x11000, 0x1000, "r"); f.call([dst, 8, 7, input]); f.expectFault(dst);
});

for (const name of ["swprintf_s", "_snwprintf_s"]) {
    for (const spec of ["%.1s", "%.1hs", "%.1S", "%.*s"]) test(name + " stops string reads at " + spec + " precision", () => {
        f = crtDispatchFixture(name); const input = 0x13000, fmt = f.put(0x14000, spec);
        const wide = !["%.1hs", "%.1S"].includes(spec);
        if (wide) f.dv.setUint16(input, 120, true); else f.mem[input] = 120;
        f.protect(input + (wide ? 2 : 1), 4, "noaccess");
        f.call([0x11000, 16, ...(name.startsWith("_") ? [15] : []), fmt, ...(spec === "%.*s" ? [1] : []), input]);
        f.expectReturn(1); expect(f.dv.getUint16(0x11000, true)).toBe(120);
    });
    test(name + " precision zero does not read a non-null protected string", () => {
        f = crtDispatchFixture(name); const input = 0x13000, fmt = f.put(0x14000, "%.0s");
        f.protect(input, 4, "noaccess"); f.call([0x11000, 16, ...(name.startsWith("_") ? [15] : []), fmt, input]);
        f.expectReturn(0); expect(f.reads).not.toContain(input);
    });
    test(name + " bounds multibyte input by decoded wide characters", () => {
        const config = EmulatorConfig.getInstance(), saved = config.ansiCodePage;
        try {
            f = crtDispatchFixture(name); config.ansiCodePage = 65001; const input = 0x13000, fmt = f.put(0x14000, "%.1hs");
            f.mem.set([0xe3, 0x81, 0x82], input); f.protect(input + 3, 2, "noaccess");
            f.call([0x11000, 16, ...(name.startsWith("_") ? [15] : []), fmt, input]); f.expectReturn(1);
            expect(f.dv.getUint16(0x11000, true)).toBe("あ".charCodeAt(0));
        } finally { config.ansiCodePage = saved; }
    });
}

for (const name of ["swprintf_s", "_snwprintf_s"]) test(name + " attributes a crossing format read to the protected byte", () => {
    f = crtDispatchFixture(name); const fmt = f.put(0x11fff, "x"); f.protect(0x12000, 0x1000, "noaccess");
    f.call([0x15000, 8, ...(name.startsWith("_") ? [7] : []), fmt]); f.expectFault(0x12000, "r");
    expect(f.writes).toEqual([]);
});

// Process uses Mem.bind(getMemory), with no injected validator or data routes.
for (const name of ["swprintf_s", "_snwprintf_s"]) {
    for (const mode of ["valid", "character", "terminator", "clearing", "crossing", "noaccess", "input", "format input", "ANSI input", "precision"] as const) {
        test(name + " enforces CRT pointer admission with the production binding: " + mode, () => {
            f = crtDispatchFixture(name); f.useProductionBinding();
            const dst = mode === "crossing" ? 0x20fff : 0x20000;
            const input = f.put(0x22000, "xy"); f.put(dst, "");
            const spec = mode === "format input" ? "xy" : mode === "clearing" ? "%q" : mode === "ANSI input" ? "%hs" : mode === "precision" ? "%.1s" : "%s";
            const fmt = f.put(0x24000, spec);
            if (mode === "ANSI input") f.mem.set([120, 121, 0], input);
            let bad = dst;
            const length = 2;
            if (mode === "terminator") { bad = dst + length * 2; f.dv.setUint16(bad, 0x5555, true); }
            if (mode === "crossing") { bad = 0x21000; f.protect(bad, 0x1000, "r"); }
            else if (mode === "noaccess") f.protect(dst, 2, "noaccess");
            else if (["character", "terminator", "clearing"].includes(mode)) f.protect(bad, 2, "r");
            else if (mode === "input") { bad = input + 2; f.protect(bad, 2, "noaccess"); }
            else if (mode === "ANSI input") { bad = input + 1; f.protect(bad, 1, "noaccess"); }
            else if (mode === "format input") { bad = fmt + 2; f.protect(bad, 2, "noaccess"); }
            else if (mode === "precision") f.protect(input + 2, 2, "noaccess");
            f.call([dst, 16, ...(name.startsWith("_") ? [15] : []), fmt, input]);
            expect(f.reads).toEqual([]); expect(f.writes).toEqual([]);
            if (mode === "precision") { f.expectReturn(1); expect(f.dv.getUint16(dst, true)).toBe(120); }
            else if (mode === "valid") {
                f.expectReturn(2); expect(f.dv.getUint16(dst, true)).toBe(120);
            } else {
                f.expectFault(bad, ["input", "format input", "ANSI input"].includes(mode) ? "r" : "w");
                if (mode === "terminator") expect(f.dv.getUint16(bad, true)).toBe(0x5555);
                else if (mode === "character" || mode === "clearing" || mode === "crossing" || mode === "noaccess") expect(f.dv.getUint16(dst, true)).toBe(0);
                else expect(f.dv.getUint16(dst, true)).toBe(0);
            }
        });
    }
}

test("CRT admission does not globally restrict privileged HLE writes", () => {
    f = crtDispatchFixture("swprintf_s"); f.useProductionBinding();
    const dst = 0x20000, input = f.put(0x22000, "xy"); f.protect(dst, 2, "r");
    expect(Mem.writeUint16(dst, 0x77)).toBe(true);
    f.call([dst, 8, input]); f.expectFault(dst);
    expect(f.dv.getUint16(dst, true)).toBe(0x77);
});
