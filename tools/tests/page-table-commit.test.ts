import { describe, expect, it } from "bun:test";
import { PageTableManager } from "../../src/worker/core/memory/page-table-manager";
import { takeGuestCodeAuditPages } from "../../src/worker/core/memory/guest-code";
import { MEM_PAGETABLE_BASE } from "../../src/worker/core/cpu/emulator-config";

const PAGE = 0x1000;
const PTE_PRESENT = 0x01;
const PTE_DEFAULT = 0x07;
const PTE_ACCESSED_DIRTY = 0x60;
/** Enough linear memory to hold the page tables themselves plus a few PTEs past them. */
const MEM_BYTES = MEM_PAGETABLE_BASE + 0x20000;

function pteOffset(page: number): number {
    return MEM_PAGETABLE_BASE + PAGE + (page >>> 10) * PAGE + (page & 0x3ff) * 4;
}

function harness() {
    const mem = new Uint8Array(new ArrayBuffer(MEM_BYTES));
    let tlbClears = 0;
    const ptm = new PageTableManager(
        () => mem,
        () => ({ full_clear_tlb: () => { tlbClears++; } }),
        MEM_PAGETABLE_BASE,
    );
    const view = new DataView(mem.buffer);
    return { mem, view, ptm, clears: () => tlbClears };
}

describe("PageTableManager.commitPages", () => {
    it("does not flush the TLB when every PTE already maps the page", () => {
        const { view, ptm, clears } = harness();
        const base = 0x400000;
        view.setUint32(pteOffset(base >>> 12), base | PTE_DEFAULT, true);

        ptm.commitPages(base, PAGE);

        expect(clears()).toBe(0);
    });

    it("preserves the walker's accessed/dirty bits on an unchanged mapping", () => {
        const { view, ptm, clears } = harness();
        const base = 0x400000;
        const page = base >>> 12;
        view.setUint32(pteOffset(page), base | PTE_DEFAULT | PTE_ACCESSED_DIRTY, true);

        ptm.commitPages(base, PAGE);

        // A/D describe use, not mapping: rewriting them is a lie to the walker and,
        // worse, would read as a remap and throw away every compiled block.
        expect(view.getUint32(pteOffset(page), true)).toBe(base | PTE_DEFAULT | PTE_ACCESSED_DIRTY);
        expect(clears()).toBe(0);
    });

    it("flushes once when a page actually becomes present", () => {
        const { view, ptm, clears } = harness();
        const base = 0x400000;
        const page = base >>> 12;
        view.setUint32(pteOffset(page), base | (PTE_DEFAULT & ~PTE_PRESENT), true);

        ptm.commitPages(base, PAGE);

        expect(view.getUint32(pteOffset(page), true)).toBe(base | PTE_DEFAULT);
        expect(clears()).toBe(1);
    });

    it("invalidates compiled blocks over the span it zeroes", () => {
        const { mem, view, ptm } = harness();
        const base = 0x400000;
        view.setUint32(pteOffset(base >>> 12), base | PTE_DEFAULT, true);
        mem[base] = 0xcc;

        takeGuestCodeAuditPages(true);
        ptm.commitPages(base, PAGE);
        const covered = takeGuestCodeAuditPages(false);

        // The span may have held guest code before it was decommitted, and a TLB flush
        // does not drop v86's compiled blocks — only the §3.1 chokepoint does.
        expect(covered).toContain(base >>> 12);
        expect(mem[base]).toBe(0);
    });
});
