import {afterEach, beforeEach, expect, spyOn, test} from "bun:test";
import {Logger} from "../../src/worker/core/logger";
import {crtDispatchFixture} from "./helpers/crt-dispatch-fixture";
import {crtCodeAudit} from "./helpers/crt-code-audit";

let f: ReturnType<typeof crtDispatchFixture> | undefined;
let audit: ReturnType<typeof crtCodeAudit> | undefined;
let log: ReturnType<typeof spyOn>, error: ReturnType<typeof spyOn>, warn: ReturnType<typeof spyOn>;
beforeEach(() => {
    log = spyOn(Logger, "log").mockImplementation(() => {});
    error = spyOn(Logger, "error").mockImplementation(() => {});
    warn = spyOn(Logger, "warn").mockImplementation(() => {});
});
afterEach(() => { audit?.restore(); audit = undefined; f?.restore(); f = undefined; log.mockRestore(); error.mockRestore(); warn.mockRestore(); });

for (const name of ["swprintf_s", "_snwprintf_s"]) {
    for (const mode of ["executable", "data", "terminator", "clearing", "prefix fault", "refused", "code/data crossing", "data/code crossing"] as const) {
        test(name + " publishes code writes through the owner: " + mode, () => {
            f = crtDispatchFixture(name); f.useProductionBinding();
            const expected = "xy";
            const dst = mode === "terminator" ? 0x21000 - expected.length * 2 :
                mode === "prefix fault" ? 0x20ffe : mode.includes("crossing") ? 0x20fff : 0x20000;
            const clearing = mode === "clearing";
            f.put(dst, clearing ? "keep" : "");
            const input = f.put(0x26000, "xy"), fmt = f.put(0x27000, clearing ? "%q" : "xy");
            if (!clearing) f.dv.setUint16(dst + expected.length * 2, 0x5555, true);
            if (mode === "data" || mode === "terminator" || mode === "data/code crossing") f.protect(0x20000, 0x1000, "rw");
            else f.protect(0x20000, 0x1000, mode === "refused" ? "rx" : "rwx");
            f.protect(0x21000, 0x1000, mode === "prefix fault" ? "noaccess" :
                mode === "terminator" || mode === "data/code crossing" ? "rwx" : "rw");
            f.protect(0x22000, 0x1000, "rwx"); // A neighbouring executable page is not part of the output.
            audit = crtCodeAudit(f.mem, f.d);
            f.call([dst, 32, ...(name.startsWith("_") ? [31] : []), fmt]);
            if (mode === "prefix fault") {
                f.expectFault(0x21000);
                expect(f.dv.getUint16(dst, true)).toBe(expected.charCodeAt(0));
                expect(audit.beforeFault()).toEqual([0x20]);
                expect(audit.pages()).not.toContain(0x21);
                expect(audit.ranges.map(r => [r.start, r.end])).toEqual([[dst, dst + 2]]);
            } else if (mode === "refused") {
                f.expectFault(dst);
                expect(audit.beforeFault()).toEqual([]); expect(audit.pages()).not.toContain(0x20);
                expect(audit.ranges).toEqual([]);
            } else {
                f.expectReturn(clearing ? (-1) : (expected.length), clearing ? (22) : 123);
                const output = clearing ? "" : expected;
                expect(Array.from({length: output.length + 1}, (_, i) => f!.dv.getUint16(dst + i * 2, true)))
                    .toEqual([...output].map(c => c.charCodeAt(0)).concat(0));
                const pages = audit.pages();
                expect(pages).toEqual(mode === "data" ? [] : mode === "terminator" || mode === "data/code crossing" ? [0x21] : [0x20]);
                expect(pages).not.toContain(0x22);
                if (mode === "executable" || clearing) {
                    expect(audit.ranges.map(r => [r.start, r.end])).toEqual(Array.from({length: output.length + 1}, (_, i) => [dst + i * 2, dst + i * 2 + 2]));
                    expect(audit.ranges.flatMap(r => r.bytes)).toEqual([...output].flatMap(c => [c.charCodeAt(0) & 255, c.charCodeAt(0) >>> 8]).concat(0, 0));
                } else if (mode === "terminator") expect(audit.ranges.map(r => [r.start, r.end])).toEqual([[0x21000, 0x21002]]);
                else if (mode === "code/data crossing") expect(audit.ranges.map(r => [r.start, r.end])).toEqual([[0x20fff, 0x21000]]);
                else if (mode === "data/code crossing") expect(audit.ranges[0]!.start).toBe(0x21000);
            }
        });
    }
}
