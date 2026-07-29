/**
 * Two invariants that between them cost Harry Potter CoS a 20x frame time, and whose
 * breakage is invisible without a measurement:
 *
 *  1. A commit-class page-table change must NOT bump the fastmem generation. That
 *     generation is a global version tag and every fastmem-speculating JIT module carries
 *     an entry guard on it (`fastmem_deopt_jit_unit` + exit to the interpreter), so ONE
 *     bump throws away the whole compiled working set. A guest allocator committing a few
 *     times a second then de-optimises the JIT a few times a second — measured 1.4 fps
 *     with the bump vs 30.6 fps without, and ~128k speculated load sites re-emitted per
 *     6 s. Only present → absent (decommit) or RW → RO (protect) can make a speculated
 *     load wrong; those still bump.
 *
 *  2. `Mem.memmove` must stay overlap-correct. It is the fast path (one native
 *     `copyWithin`, no staging copy) that replaced a read + fresh-Uint8Array + write; the
 *     temporary was what made overlap safe, so a future "optimisation" back to a plain
 *     ascending copy would silently corrupt exactly the overlapping case memmove exists for.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { PageTableManager } from "../../src/worker/core/memory/page-table-manager";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { MEM_PAGETABLE_BASE } from "../../src/worker/core/cpu/emulator-config";

/** Records every fastmem_bump_generation(source) the manager issues. */
function fakeExports() {
    const bumps: number[] = [];
    return {
        bumps,
        exports: {
            fastmem_bump_generation: (source: number) => { bumps.push(source >>> 0); },
            full_clear_tlb: () => {},
            fastmem_write_map_set_base: () => {},
        },
    };
}

const RAM = 4 * 1024 * 1024;
// The manager writes PTEs at MEM_PAGETABLE_BASE, so the fake address space has to reach
// past the tables. The pages we never touch are never resident, so this stays cheap.
const FAKE_SPACE = MEM_PAGETABLE_BASE + 0x401000;

function makePtm() {
    const mem = new Uint8Array(FAKE_SPACE);
    const { bumps, exports } = fakeExports();
    const ptm = new PageTableManager(() => mem, () => exports);
    return { ptm, mem, bumps };
}

describe("fastmem generation — commit must not invalidate the compiled world", () => {
    test("commitPages does not bump", () => {
        const { ptm, bumps } = makePtm();
        ptm.initialize(RAM);
        bumps.length = 0;
        ptm.commitPages(0x100000, 0x4000);
        expect(bumps).toEqual([]);
    });

    test("ensurePagesCommitted does not bump, even when it recommits", () => {
        const { ptm, bumps } = makePtm();
        ptm.initialize(RAM);
        ptm.decommitPages(0x100000, 0x4000);   // makes them absent (this one MAY bump)
        bumps.length = 0;
        ptm.ensurePagesCommitted(0x100000, 0x4000);
        expect(bumps).toEqual([]);
    });

    test("decommit DOES bump — present → absent is what invalidates a speculated load", () => {
        const { ptm, bumps } = makePtm();
        ptm.initialize(RAM);
        bumps.length = 0;
        ptm.decommitPages(0x100000, 0x4000);
        expect(bumps.length).toBeGreaterThan(0);
    });
});

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
