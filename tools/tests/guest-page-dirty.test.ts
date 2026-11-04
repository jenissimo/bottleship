import { afterEach, describe, expect, it } from "bun:test";
import {
    adoptFreshGuestMemory, forgetGuestMemory, guestPageDirtyStats, isGuestRangeKnownZero,
    markGuestPagesClean, markGuestPagesDirty, verifyCleanGuestPages, zeroGuestRange,
} from "../../src/worker/core/memory/guest-page-dirty";
import { PageTableManager } from "../../src/worker/core/memory/page-table-manager";
import { AddressSpace } from "../../src/worker/core/memory/address-space";
import { MemoryManager } from "../../src/worker/core/process";
import { MEM_HEAP_BASE, MEM_PAGETABLE_BASE } from "../../src/worker/core/cpu/emulator-config";

const PAGE = 0x1000;
const PTE_PRESENT = 0x01;
const PTE_RW = 0x02;
const PTE_DEFAULT = 0x07;

/** Count every byte written through `mem.fill` — the zeroing primitive all sites use. */
function spyFill(mem: Uint8Array): { bytes: () => number; calls: () => number } {
    let bytes = 0, calls = 0;
    const native = mem.fill.bind(mem);
    (mem as unknown as { fill: typeof mem.fill }).fill = ((value: number, start = 0, end = mem.length) => {
        calls++; bytes += Math.max(0, Math.min(end, mem.length) - start);
        return native(value, start, end);
    }) as typeof mem.fill;
    return { bytes: () => bytes, calls: () => calls };
}

afterEach(() => {
    forgetGuestMemory();
    delete (globalThis as Record<string, unknown>).preemption;
});

describe("guest-page-dirty: zeroGuestRange", () => {
    it("is a plain fill on memory nobody adopted (fails closed)", () => {
        const mem = new Uint8Array(16 * PAGE);
        mem[5 * PAGE] = 7;
        const spy = spyFill(mem);
        expect(zeroGuestRange(mem, 4 * PAGE, 4 * PAGE)).toBe(4 * PAGE);
        expect(spy.bytes()).toBe(4 * PAGE);
        expect(mem[5 * PAGE]).toBe(0);
    });

    it("writes nothing over fresh pages, and only the dirty pages of a mixed span", () => {
        const mem = new Uint8Array(64 * PAGE);
        adoptFreshGuestMemory(mem, 0);
        const spy = spyFill(mem);
        expect(zeroGuestRange(mem, 8 * PAGE, 16 * PAGE)).toBe(0);
        expect(spy.calls()).toBe(0);

        markGuestPagesDirty(10 * PAGE + 100, 10);  // one page
        mem[10 * PAGE + 100] = 0xaa;
        expect(zeroGuestRange(mem, 8 * PAGE, 16 * PAGE)).toBe(PAGE);
        expect(mem[10 * PAGE + 100]).toBe(0);
        // The page is whole inside the span and now zero: clean again.
        expect(isGuestRangeKnownZero(mem, 10 * PAGE, PAGE)).toBe(true);
    });

    it("keeps a partially covered page dirty (its other bytes may belong to someone)", () => {
        const mem = new Uint8Array(8 * PAGE);
        adoptFreshGuestMemory(mem, 0);
        markGuestPagesDirty(2 * PAGE, PAGE);
        mem[2 * PAGE + 10] = 1;   // outside the zeroed span
        mem[2 * PAGE + 2000] = 2; // inside
        zeroGuestRange(mem, 2 * PAGE + 1000, 2000);
        expect(mem[2 * PAGE + 10]).toBe(1);
        expect(mem[2 * PAGE + 2000]).toBe(0);
        expect(isGuestRangeKnownZero(mem, 2 * PAGE, PAGE)).toBe(false);
    });

    it("keeps everything below dirtyBelow dirty (v86 BIOS images)", () => {
        const mem = new Uint8Array(512 * PAGE);
        adoptFreshGuestMemory(mem, 256 * PAGE);
        expect(isGuestRangeKnownZero(mem, 255 * PAGE, PAGE)).toBe(false);
        expect(isGuestRangeKnownZero(mem, 256 * PAGE, PAGE)).toBe(true);
    });

    it("markGuestPagesClean only clears whole pages", () => {
        const mem = new Uint8Array(8 * PAGE);
        adoptFreshGuestMemory(mem, 8 * PAGE); // all dirty
        markGuestPagesClean(mem, PAGE + 1, 3 * PAGE);
        expect(isGuestRangeKnownZero(mem, PAGE, PAGE)).toBe(false);
        expect(isGuestRangeKnownZero(mem, 2 * PAGE, 2 * PAGE)).toBe(true);
    });

    it("follows guest RAM across a wasm memory growth (buffer replaced, window unchanged)", () => {
        const wasm = new WebAssembly.Memory({ initial: 2, maximum: 8 });
        const view = () => new Uint8Array(wasm.buffer, PAGE, 16 * PAGE);
        adoptFreshGuestMemory(view(), 0);
        wasm.grow(1); // detaches the old ArrayBuffer
        const after = view();
        const spy = spyFill(after);
        zeroGuestRange(after, 0, 16 * PAGE);
        expect(spy.calls()).toBe(0);
        expect(guestPageDirtyStats().tracked).toBe(true);
    });

    it("verify reports a clean-marked page that holds bytes", () => {
        const mem = new Uint8Array(8 * PAGE);
        adoptFreshGuestMemory(mem, 0);
        mem[3 * PAGE + 5] = 9; // an unobserved writer
        const v = verifyCleanGuestPages(mem, true);
        expect(v.violations).toBe(1);
        expect(v.samples).toEqual(["0x3000"]);
        expect(mem[3 * PAGE + 5]).toBe(0);
    });
});

/** Linear memory holding the page tables plus a few PTEs past them. */
const MEM_BYTES = MEM_PAGETABLE_BASE + 0x20000;

function pteOffset(page: number): number {
    return MEM_PAGETABLE_BASE + PAGE + (page >>> 10) * PAGE + (page & 0x3ff) * 4;
}

function ptmHarness(adopt: boolean) {
    const mem = new Uint8Array(new ArrayBuffer(MEM_BYTES));
    const writeMap: string[] = [];
    (globalThis as Record<string, unknown>).preemption = {
        getWasmExports: () => ({ fastmem_write_map_set_base: (p: number, n: number, w: number) => writeMap.push(`${p}+${n}=${w}`) }),
    };
    let clears = 0;
    const ptm = new PageTableManager(() => mem, () => ({ full_clear_tlb: () => { clears++; } }));
    (ptm as unknown as { pagingEnabled: boolean }).pagingEnabled = true;
    if (adopt) adoptFreshGuestMemory(mem, 0);
    const view = new DataView(mem.buffer);
    // Identity-map the test window, as initialize() does for all 4 GB.
    for (let p = 0x400; p < 0x440; p++) view.setUint32(pteOffset(p), (p * PAGE) | PTE_DEFAULT, true);
    return { mem, view, ptm, writeMap, clears: () => clears };
}

describe("PageTableManager: lazy zero on commit", () => {
    const base = 0x400000;

    it("commit of fresh pages does not write guest memory", () => {
        const { mem, ptm } = ptmHarness(true);
        ptm.decommitPages(base, 8 * PAGE); // MEM_RESERVE shape
        const spy = spyFill(mem);
        ptm.commitPages(base, 8 * PAGE);
        expect(spy.bytes()).toBe(0);
    });

    it("decommit -> recommit after a write still reads zero", () => {
        const { mem, ptm } = ptmHarness(true);
        ptm.commitPages(base, 4 * PAGE);
        mem[base + PAGE + 3] = 0x5a; // the guest writes committed memory
        ptm.decommitPages(base, 4 * PAGE);
        const spy = spyFill(mem);
        ptm.commitPages(base, 4 * PAGE);
        expect(mem[base + PAGE + 3]).toBe(0);
        expect(spy.bytes()).toBe(4 * PAGE); // the whole committed span was exposed
    });

    it("ensurePagesCommitted recommit zeroes a written page and skips a fresh one", () => {
        const { mem, ptm } = ptmHarness(true);
        ptm.commitPages(base, PAGE);
        mem[base + 8] = 1;
        ptm.decommitPages(base, 2 * PAGE); // page 0 written, page 1 never exposed
        const spy = spyFill(mem);
        ptm.ensurePagesCommitted(base, 2 * PAGE);
        expect(mem[base + 8]).toBe(0);
        expect(spy.bytes()).toBe(PAGE);
    });

    it("contentsZero skips even exposed pages, but they stay dirty for the next recommit", () => {
        const { mem, ptm } = ptmHarness(true);
        markGuestPagesDirty(base, PAGE);
        const spy = spyFill(mem);
        ptm.commitPages(base, PAGE, true);
        expect(spy.bytes()).toBe(0);
        mem[base] = 3;
        ptm.decommitPages(base, PAGE);
        ptm.commitPages(base, PAGE);
        expect(mem[base]).toBe(0);
    });

    it("PTEs, TLB flushes and write-map updates are identical with and without tracking", () => {
        const run = (adopt: boolean) => {
            const h = ptmHarness(adopt);
            h.ptm.decommitPages(base, 8 * PAGE);
            h.ptm.commitPages(base, 4 * PAGE);
            h.ptm.setProtection(base + PAGE, PAGE, 0x02); // PAGE_READONLY
            h.ptm.ensurePagesCommitted(base, 8 * PAGE);
            h.ptm.setProtection(base + 2 * PAGE, PAGE, 0x01); // PAGE_NOACCESS
            const ptes = [];
            for (let p = 0x400; p < 0x408; p++) ptes.push(h.view.getUint32(pteOffset(p), true));
            return { ptes, writeMap: h.writeMap.join(","), clears: h.clears() };
        };
        const tracked = run(true), untracked = run(false);
        expect(tracked).toEqual(untracked);
        expect(tracked.ptes[1]! & (PTE_PRESENT | PTE_RW)).toBe(PTE_PRESENT); // RO kept
        expect(tracked.ptes[2]! & PTE_PRESENT).toBe(0);                     // NOACCESS kept
    });
});

describe("MemoryManager: zeroed handouts without touching fresh memory", () => {
    function mm(adopt: boolean) {
        const mem = new Uint8Array(new ArrayBuffer(MEM_HEAP_BASE + 0x01000000));
        if (adopt) adoptFreshGuestMemory(mem, 0x00100000);
        const space = new AddressSpace(() => mem);
        space.initializeLayout(mem.length);
        const manager = new MemoryManager(space);
        manager.refreshLayoutBuckets();
        return { mem, manager };
    }

    it("a virgin bump allocation is not written", () => {
        const { mem, manager } = mm(true);
        const spy = spyFill(mem);
        manager.alloc(0x200000, "HEAP", "rw", 0x10000);
        expect(spy.bytes()).toBe(0);
    });

    it("re-handing out a freed block returns zeros", () => {
        const { mem, manager } = mm(true);
        const a = manager.alloc(0x100000, "HEAP", "rw", 0x10000);
        manager.alloc(0x1000, "HEAP"); // pin the frontier so `a` goes to a free list
        mem.fill(0x77, a, a + 0x100000);
        manager.free(a);
        const b = manager.alloc(0x100000, "HEAP", "rw", 0x10000);
        expect(b).toBe(a);
        expect(mem.subarray(b, b + 0x100000).every((x) => x === 0)).toBe(true);
    });

    it("a virgin bump over pages an untracked-by-allocator writer dirtied is zeroed", () => {
        const { mem, manager } = mm(true);
        const at = MEM_HEAP_BASE + 0x300000;
        mem[at + 4] = 9;
        markGuestPagesDirty(at, PAGE); // e.g. a PE image once mapped there
        manager.alloc(0x300000, "HEAP", "rw", 0x10000);
        const b = manager.alloc(0x10000, "HEAP", "rw", 0x10000);
        expect(b).toBe(at);
        expect(mem[at + 4]).toBe(0);
    });

    it("a re-carve at the slab frontier returns zeros", () => {
        const { mem, manager } = mm(true);
        const a = manager.allocFromHigh(0x20000);
        mem.fill(0x31, a, a + 0x20000);
        manager.free(a);
        const b = manager.allocFromHigh(0x20000);
        expect(b).toBe(a);
        expect(mem.subarray(b, b + 0x20000).every((x) => x === 0)).toBe(true);
    });
});
