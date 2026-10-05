/**
 * Two memory invariants whose breakage is invisible without a focused test:
 *
 *  1. Fastmem reads use a PTE-derived per-page map. A readable identity page is fast;
 *     decommit/NOACCESS must clear it synchronously, while RO remains readable. This
 *     preserves #PF semantics without invalidating every compiled JIT module.
 *
 *  2. `Mem.memmove` must stay overlap-correct. It is the fast path (one native
 *     `copyWithin`, no staging copy) that replaced a read + fresh-Uint8Array + write; the
 *     temporary was what made overlap safe, so a future "optimisation" back to a plain
 *     ascending copy would silently corrupt exactly the overlapping case memmove exists for.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

describe("Mem.memmove — overlap correctness of the allocation-free path", () => {
    let mem: Uint8Array;
    beforeEach(() => {
        mem = new Uint8Array(0x1000);
        Mem.bind(() => mem);            // no validator: every range is accessible
    });

    test("forward overlap (dst > src) does not eat its own source", () => {
        for (let i = 0; i < 8; i++) mem[0x10 + i] = i + 1;      // 1..8
        expect(Mem.memmove(0x12, 0x10, 8)).toBe(true);
        expect([...mem.subarray(0x12, 0x1a)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    test("backward overlap (dst < src) copies correctly", () => {
        for (let i = 0; i < 8; i++) mem[0x20 + i] = i + 1;
        expect(Mem.memmove(0x1e, 0x20, 8)).toBe(true);
        expect([...mem.subarray(0x1e, 0x26)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    test("disjoint ranges copy, and a zero length is a no-op", () => {
        mem.set([9, 8, 7], 0x40);
        expect(Mem.memmove(0x80, 0x40, 3)).toBe(true);
        expect([...mem.subarray(0x80, 0x83)]).toEqual([9, 8, 7]);
        expect(Mem.memmove(0x90, 0x40, 0)).toBe(true);
        expect(mem[0x90]).toBe(0);
    });

    test("a rejected range reports failure instead of copying a partial result", () => {
        Mem.bind(() => mem, (address) => address < 0x100);       // only the first page is legal
        mem.set([1, 2, 3, 4], 0x10);
        expect(Mem.memmove(0x200, 0x10, 4)).toBe(false);         // destination refused
        expect([...mem.subarray(0x200, 0x204)]).toEqual([0, 0, 0, 0]);
    });
});
