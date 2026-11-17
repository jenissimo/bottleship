import {afterEach, beforeEach, expect, spyOn, test} from "bun:test";
import {Logger} from "../../src/worker/core/logger";
import {crtDispatchFixture} from "./helpers/crt-dispatch-fixture";
import {crtCodeAudit} from "./helpers/crt-code-audit";

function dirtyPages(ranges: Array<{start: number; end: number}>): number[] {
    const pages = new Set<number>();
    for (const {start, end} of ranges) for (let page = start >>> 12; page <= (end - 1) >>> 12; page++) pages.add(page);
    return [...pages].sort((a, b) => a - b);
}

let f: ReturnType<typeof crtDispatchFixture> | undefined;
let audit: ReturnType<typeof crtCodeAudit> | undefined;
let log: ReturnType<typeof spyOn>, error: ReturnType<typeof spyOn>, warn: ReturnType<typeof spyOn>;
beforeEach(() => {
    log = spyOn(Logger, "log").mockImplementation(() => {});
    error = spyOn(Logger, "error").mockImplementation(() => {});
    warn = spyOn(Logger, "warn").mockImplementation(() => {});
});
afterEach(() => { audit?.restore(); audit = undefined; f?.restore(); f = undefined; log.mockRestore(); error.mockRestore(); warn.mockRestore(); });

for (const name of ["_wfullpath", "_wmakepath_s", "_wsplitpath_s"]) {
    for (const mode of ["executable", "data", "terminator", "clearing", "prefix fault", "refused", "code/data crossing", "data/code crossing"] as const) {
        test(name + " publishes code writes through the owner: " + mode, () => {
            f = crtDispatchFixture(name); f.useProductionBinding();
            const expected = name === "_wfullpath" ? "C:\\xy" : "xy";
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
            f.put(input, "C:\\xy");
            audit = crtCodeAudit(f.d);
            f.call(name === "_wfullpath" ? [dst, input, clearing ? 1 : 32] : name === "_wmakepath_s" ? [dst, clearing ? 1 : 32, 0, 0, input + 6, 0] : [input, 0, 0, 0, 0, dst, clearing ? 1 : 32, 0, 0]);
            if (mode === "prefix fault") {
                f.expectFault(0x21000);
                expect(f.dv.getUint16(dst, true)).toBe(expected.charCodeAt(0));
                expect(audit.beforeFault()).toEqual([0x20]);
                expect(audit.pages()).not.toContain(0x21);
                expect(dirtyPages(audit.beforeFaultRanges())).toEqual([0x20]);
            } else if (mode === "refused") {
                f.expectFault(dst);
                expect(audit.beforeFault()).toEqual([]); expect(audit.pages()).not.toContain(0x20);
                expect(audit.beforeFaultRanges()).toEqual([]);
            } else {
                f.expectReturn(clearing ? (name === "_wfullpath" ? 0 : 34) : (name === "_wfullpath" ? dst : 0), clearing ? (34) : 123);
                const output = clearing ? "" : expected;
                expect(Array.from({length: output.length + 1}, (_, i) => f!.dv.getUint16(dst + i * 2, true)))
                    .toEqual([...output].map(c => c.charCodeAt(0)).concat(0));
                const pages = audit.pages();
                expect(pages).toEqual(mode === "data" ? [] : mode === "terminator" || mode === "data/code crossing" ? [0x21] : [0x20]);
                expect(pages).not.toContain(0x22);
                expect(dirtyPages(audit.ranges)).toEqual(pages);
            }
        });
    }
}
