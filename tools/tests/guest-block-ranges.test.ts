/**
 * The counted guest-block census gained a named-range roll-up and a real denominator
 * (`sharePctOfGuest`). Both exist to answer a go/no-go, so both are load-bearing: a
 * roll-up that silently misses a page, or a denominator that loses 4.3e9 instructions
 * to a counter wrap, produces a plausible number for the wrong question — which is the
 * failure mode this project keeps rediscovering.
 */
import { describe, expect, it } from "bun:test";
import { pagesForRanges, retiredDelta, rollUpRanges, type CountedBlockSample } from "../../src/worker/harness/cmds/perf";

describe("pagesForRanges", () => {
    it("covers every page a range touches, including the last one", () => {
        // inflate_fast in House of 1,000 Doors: fbnfilesystem+0xfc88..0x102f2 — it STRADDLES a
        // page boundary, so a naive `from & ~0xfff` would arm 0xf000 and lose the tail.
        expect(pagesForRanges([{ name: "inflate_fast", from: 0x2404fc88, to: 0x240502f2 }]))
            .toEqual([0x2404f000, 0x24050000]);
    });

    it("does not arm a page the range only abuts", () => {
        expect(pagesForRanges([{ name: "x", from: 0x1000, to: 0x2000 }])).toEqual([0x1000]);
    });

    it("de-duplicates pages shared by two ranges", () => {
        expect(pagesForRanges([
            { name: "a", from: 0x1100, to: 0x1200 },
            { name: "b", from: 0x1300, to: 0x1400 },
        ])).toEqual([0x1000]);
    });
});

describe("rollUpRanges", () => {
    const blocks: CountedBlockSample[] = [
        { addr: 0x1000, exec: 10, ins: 5 },   // 50, in "a"
        { addr: 0x1500, exec: 20, ins: 5 },   // 100, in "a"
        { addr: 0x2000, exec: 3, ins: 10 },   // 30, in "b"
        { addr: 0x9000, exec: 4, ins: 5 },    // 20, in nothing
    ];
    const ranges = [
        { name: "a", from: 0x1000, to: 0x2000 },
        { name: "b", from: 0x2000, to: 0x3000 },
    ];

    it("sums blocks by entry address and states the remainder", () => {
        const r = rollUpRanges(blocks, ranges, 200, 400);
        expect(r.rows[0]).toMatchObject({ name: "a", blocks: 2, exec: 30, weightedIns: 150, sharePct: 75, sharePctOfGuest: 37.5 });
        expect(r.rows[1]).toMatchObject({ name: "b", blocks: 1, exec: 3, weightedIns: 30, sharePct: 15 });
        // The whole point of reporting it: shares are of a stated whole, not of a remainder
        // nobody wrote down.
        expect(r.unattributed).toEqual({ weightedIns: 20, sharePct: 10 });
        expect(r.rows.reduce((s, x) => s + x.weightedIns, 0) + r.unattributed.weightedIns).toBe(200);
    });

    it("charges a block to the FIRST matching range only, so overlaps never double-count", () => {
        const r = rollUpRanges(blocks, [{ name: "wide", from: 0, to: 0x3000 }, { name: "inner", from: 0x1000, to: 0x2000 }], 200, 0);
        expect(r.rows[0].weightedIns).toBe(180);
        expect(r.rows[1].weightedIns).toBe(0);
    });

    it("names a range an earlier range shadows, so its 0 cannot be read as 'did not run'", () => {
        const r = rollUpRanges(blocks, [{ name: "wide", from: 0, to: 0x3000 }, { name: "inner", from: 0x1000, to: 0x2000 }], 200, 0);
        expect(r.shadowed).toEqual(["inner"]);
        expect(r.note).toContain("shadowed");
    });

    it("does not cry shadow over ranges that merely abut", () => {
        const r = rollUpRanges(blocks, [{ name: "a", from: 0, to: 0x1000 }, { name: "b", from: 0x1000, to: 0x2000 }], 200, 0);
        expect(r.shadowed).toBeUndefined();
    });

    it("reports sharePctOfGuest as null rather than 0 when there is no denominator", () => {
        // A missing CPU counter must not read as "this code is free".
        expect(rollUpRanges(blocks, ranges, 200, 0).rows[0].sharePctOfGuest).toBeNull();
    });

    it("excludes a block that ends inside a range but was entered before it", () => {
        const r = rollUpRanges([{ addr: 0x0fff, exec: 100, ins: 10 }], ranges, 1000, 0);
        expect(r.rows[0].blocks).toBe(0);
        expect(r.unattributed.weightedIns).toBe(1000);
    });
});

describe("retiredDelta", () => {
    it("is a plain difference when the counter did not wrap", () => {
        expect(retiredDelta(1000, 4000)).toBe(3000);
    });

    it("carries the full 2^32 across a wrap", () => {
        // The bug this guards: `now - prev` here is -0xfffffffe, and clamping it to 0 loses
        // 4 294 967 294 instructions from the denominator while still returning a number.
        expect(retiredDelta(0xffff_ffff, 1)).toBe(2);
        expect(retiredDelta(0xffff_f000, 0x1000)).toBe(0x2000);
    });
});
