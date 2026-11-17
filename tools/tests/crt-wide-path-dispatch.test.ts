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
for (const name of ["_wfullpath", "_wmakepath_s", "_wsplitpath_s"]) {
    for (const mode of ["valid", "character", "terminator", "clearing"] as const) {
        test(name + " dispatches " + mode + " output through the cdecl boundary", () => {
            f = crtDispatchFixture(name);
            const dst = f.put(0x11000, "keep"), path = f.put(0x12000, "C:\\xy");
            const output = name === "_wfullpath" ? "C:\\xy" : "xy";
            const bad = mode === "terminator" ? dst + output.length * 2 : dst;
            f.dv.setUint16(dst + output.length * 2, 0x5555, true);
            if (mode !== "valid") f.deny(bad);
            const size = mode === "clearing" ? 1 : 32;
            const args = name === "_wfullpath" ? [dst, path, size] : name === "_wmakepath_s" ?
                [dst, size, 0, 0, f.put(0x12200, "xy"), 0] : [path, 0, 0, 0, 0, dst, size, 0, 0];
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
    const path = f.put(0x12000, "C:\\xy"), drive = f.put(0x11000, "keep"), dir = f.put(0x11100, "keep");
    f.deny(dir); f.call([path, drive, 3, dir, 8, 0, 0, 0, 0]); f.expectFault(dir);
    expect([0, 2, 4].map(i => f!.dv.getUint16(drive + i, true))).toEqual([67, 58, 0]);
    expect(f.dv.getUint16(dir, true)).toBe(107);
});

test("guest ContinueExecution retries the failed cdecl call with its caller frame intact", () => {
    f = crtDispatchFixture("_wfullpath"); const path = f.put(0x12000, "C:\\xy");
    f.deny(0x11000); f.call([0x11000, path, 32]);
    f.expectFault(0x11000); f.expectRetry();
});

test("_wsplitpath_s stops clearing at a refused component on invalid input", () => {
    f = crtDispatchFixture("_wsplitpath_s");
    const drive = f.put(0x11000, "keep"), dir = f.put(0x11100, "keep"), file = f.put(0x11200, "keep");
    f.deny(dir); f.call([0, drive, 8, dir, 8, file, 8, 0, 0]); f.expectFault(dir);
    expect(f.dv.getUint16(drive, true)).toBe(0);
    expect(f.dv.getUint16(dir, true)).toBe(107); expect(f.dv.getUint16(file, true)).toBe(107);
});

// Permissions below come from AddressSpace; accessors are not mocked.
for (const [name, component] of [["_wfullpath", "path"], ["_wsplitpath_s", "path"],
    ["_wmakepath_s", "drive"], ["_wmakepath_s", "directory"], ["_wmakepath_s", "filename"], ["_wmakepath_s", "extension"]]) {
    test(name + " faults on a protected " + component + " input", () => {
        f = crtDispatchFixture(name!); const dst = f.put(0x11000, "keep"), input = f.put(0x13000, "xy");
        f.protect(input + 2, 2, "noaccess");
        const args = name === "_wfullpath" ? [dst, input, 32] : name === "_wsplitpath_s" ?
            [input, 0, 0, 0, 0, dst, 32, 0, 0] : [dst, 32, ...["drive", "directory", "filename", "extension"].map(k => k === component ? input : 0)];
        f.call(args); f.expectFault(input + 2, "r");
        expect(f.writes).toEqual([]); expect(f.dv.getUint16(dst, true)).toBe(107);
    });
}
for (const name of ["_wfullpath", "_wmakepath_s", "_wsplitpath_s"]) test(name + " attributes a crossing input read to the protected byte", () => {
    f = crtDispatchFixture(name); const input = f.put(0x11fff, "x"); f.protect(0x12000, 0x1000, "noaccess");
    f.call(name === "_wfullpath" ? [0x15000, input, 32] : name === "_wmakepath_s" ? [0x15000, 32, 0, 0, input, 0] :
        [input, 0, 0, 0, 0, 0x15000, 32, 0, 0]); f.expectFault(0x12000, "r"); expect(f.writes).toEqual([]);
});

test("_wfullpath reports the first inaccessible byte of a crossing WCHAR store (r)", () => {
    f = crtDispatchFixture("_wfullpath"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x12000, 0x1000, "r");
    f.call([dst, input, 32]); f.expectFault(0x12000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("_wfullpath reports the first inaccessible byte of a crossing WCHAR store (noaccess)", () => {
    f = crtDispatchFixture("_wfullpath"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x12000, 0x1000, "noaccess");
    f.call([dst, input, 32]); f.expectFault(0x12000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("_wfullpath reports the first byte when the first page is read-only", () => {
    f = crtDispatchFixture("_wfullpath"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x11000, 0x1000, "r"); f.call([dst, input, 32]); f.expectFault(dst);
});

test("_wmakepath_s reports the first inaccessible byte of a crossing WCHAR store (r)", () => {
    f = crtDispatchFixture("_wmakepath_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x12000, 0x1000, "r");
    f.call([dst, 32, 0, 0, input, 0]); f.expectFault(0x12000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("_wmakepath_s reports the first inaccessible byte of a crossing WCHAR store (noaccess)", () => {
    f = crtDispatchFixture("_wmakepath_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x12000, 0x1000, "noaccess");
    f.call([dst, 32, 0, 0, input, 0]); f.expectFault(0x12000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("_wmakepath_s reports the first byte when the first page is read-only", () => {
    f = crtDispatchFixture("_wmakepath_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x11000, 0x1000, "r"); f.call([dst, 32, 0, 0, input, 0]); f.expectFault(dst);
});

test("_wsplitpath_s reports the first inaccessible byte of a crossing WCHAR store (r)", () => {
    f = crtDispatchFixture("_wsplitpath_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x12000, 0x1000, "r");
    f.call([input, 0, 0, 0, 0, dst, 32, 0, 0]); f.expectFault(0x12000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("_wsplitpath_s reports the first inaccessible byte of a crossing WCHAR store (noaccess)", () => {
    f = crtDispatchFixture("_wsplitpath_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x12000, 0x1000, "noaccess");
    f.call([input, 0, 0, 0, 0, dst, 32, 0, 0]); f.expectFault(0x12000);
    expect(f.dv.getUint8(dst)).toBe(0); expect(f.dv.getUint8(dst + 1)).toBe(0);
});

test("_wsplitpath_s reports the first byte when the first page is read-only", () => {
    f = crtDispatchFixture("_wsplitpath_s"); const dst = f.put(0x11fff, ""), input = f.put(0x14000, "xy");
    f.protect(0x11000, 0x1000, "r"); f.call([input, 0, 0, 0, 0, dst, 32, 0, 0]); f.expectFault(dst);
});

// Process uses Mem.bind(getMemory), with no injected validator or data routes.
for (const name of ["_wfullpath", "_wmakepath_s", "_wsplitpath_s"]) {
    for (const mode of ["valid", "character", "terminator", "clearing", "crossing", "noaccess", "input"] as const) {
        test(name + " enforces CRT pointer admission with the production binding: " + mode, () => {
            f = crtDispatchFixture(name); f.useProductionBinding();
            const dst = mode === "crossing" ? 0x20fff : 0x20000;
            const input = f.put(0x22000, "xy"); f.put(dst, "");
            f.put(input, "C:\\xy");
            let bad = dst;
            const length = name === "_wfullpath" ? 5 : 2;
            if (mode === "terminator") { bad = dst + length * 2; f.dv.setUint16(bad, 0x5555, true); }
            if (mode === "crossing") { bad = 0x21000; f.protect(bad, 0x1000, "r"); }
            else if (mode === "noaccess") f.protect(dst, 2, "noaccess");
            else if (["character", "terminator", "clearing"].includes(mode)) f.protect(bad, 2, "r");
            else if (mode === "input") { bad = input + (name === "_wmakepath_s" ? 8 : 2); f.protect(bad, 2, "noaccess"); }
            f.call(name === "_wfullpath" ? [dst, input, mode === "clearing" ? 1 : 32] : name === "_wmakepath_s" ? [dst, mode === "clearing" ? 1 : 32, 0, 0, input + 6, 0] : [input, 0, 0, 0, 0, dst, mode === "clearing" ? 1 : 32, 0, 0]);
            expect(f.reads).toEqual([]); expect(f.writes).toEqual([]);
            if (mode === "valid") {
                f.expectReturn(name === "_wfullpath" ? dst : 0); expect(f.dv.getUint16(dst, true)).toBe(name === "_wfullpath" ? 67 : 120);
            } else {
                f.expectFault(bad, mode === "input" ? "r" : "w");
                if (mode === "terminator") expect(f.dv.getUint16(bad, true)).toBe(0x5555);
                else if (mode === "character" || mode === "clearing" || mode === "crossing" || mode === "noaccess") expect(f.dv.getUint16(dst, true)).toBe(0);
                else expect(f.dv.getUint16(dst, true)).toBe(0);
            }
        });
    }
}

test("CRT admission does not globally restrict privileged HLE writes", () => {
    f = crtDispatchFixture("_wfullpath"); f.useProductionBinding();
    const dst = 0x20000, input = f.put(0x22000, "xy"); f.protect(dst, 2, "r");
    expect(Mem.writeUint16(dst, 0x77)).toBe(true);
    f.call([dst, input, 32]); f.expectFault(dst);
    expect(f.dv.getUint16(dst, true)).toBe(0x77);
});

for (const component of [0, 1, 2, 3]) test("_wmakepath_s checks component " + component + " with the production binding", () => {
    f = crtDispatchFixture("_wmakepath_s"); f.useProductionBinding();
    const dst = f.put(0x20000, "keep"), input = f.put(0x22000, "xy");
    f.protect(input + 2, 2, "noaccess"); f.call([dst, 32, ...[0, 1, 2, 3].map(i => i === component ? input : 0)]);
    f.expectFault(input + 2, "r"); expect(f.dv.getUint16(dst, true)).toBe(107);
});
