/**
 * PageTableManager — x86 page directory + page tables for virtual memory protection.
 *
 * Enables real #PF on decommitted pages instead of zeroing memory (which corrupts
 * heap metadata in games like StarCraft's storm.dll SBH allocator).
 *
 * Identity-mapped: linear address = physical address. Only difference from flat mode
 * is that non-present pages now fault via #PF (vector 14).
 *
 * Maps the FULL 4GB address space (all 1024 PDEs). v86's WASM linear
 * memory is larger than the configured guest memory, so games may access addresses
 * beyond the configured size (e.g., reading uninitialized pointers). Without full
 * mapping, these accesses would #PF — but before paging they silently succeeded.
 *
 * Tables live at MEM_PAGETABLE_BASE (inside the NOACCESS red zone), never in the low
 * gap below HEAP: that gap is PE-image territory — an EXE at ImageBase 0x00400000 with
 * a multi-MB BSS reaches well past 11MB, and an overlap is silent and lethal (the
 * walker's A/D-bit writes land in the guest's globals, the guest's writes in our PTEs).
 * Layout: page directory 4KB, then 1024 page tables (4MB) covering the full 4GB.
 */

import { Logger, LogCategory } from '../logger';
import { setWriteMapBase } from './address-space';
import { MEM_THUNK_CODE_BASE, MEM_THUNK_CODE_SIZE, MEM_PAGETABLE_BASE, MEM_PAGETABLE_SIZE, MEM_GUARD_BASE, MEM_GUARD_SIZE } from '../cpu/emulator-config';

// Page table constants
const PAGE_DIR_ADDR = MEM_PAGETABLE_BASE;
const PAGE_TABLES_ADDR = MEM_PAGETABLE_BASE + 0x1000;
const PAGE_SIZE = 0x1000; // 4KB
const ENTRIES_PER_TABLE = 1024;
const PAGES_PER_TABLE = 1024; // Each PT covers 4MB
const FULL_PD_ENTRIES = 1024; // Always map full 4GB

// PTE/PDE flags
const PTE_PRESENT = 0x01;
const PTE_RW = 0x02;
const PTE_USER = 0x04;
const PTE_DEFAULT = PTE_PRESENT | PTE_RW | PTE_USER; // 0x07
// CR0 bits
const CR0_PG = 0x80000000; // Paging enable (bit 31)
const CR0_WP = 0x00010000; // Write protect (bit 16)

export class PageTableManager {
    private pagingEnabled = false;
    private totalMemoryBytes = 0;
    private getMemory: () => Uint8Array;
    private getWasmExports: () => any;

    constructor(getMemory: () => Uint8Array, getWasmExports: () => any) {
        this.getMemory = getMemory;
        this.getWasmExports = getWasmExports;
    }

    /** Update READ_OK for a page range. The Rust setter repeats the RAM/guard clamp,
     * so a stale or over-broad TS range can only make reads slower, never unsafe. */
    private setReadMap(baseAddr: number, sizeBytes: number, readable: boolean): void {
        if (sizeBytes <= 0) return;
        const fn = this.getWasmExports()?.fastmem_read_map_set;
        if (!fn) return;
        const startPage = baseAddr >>> 12;
        const endPage = (baseAddr + sizeBytes + PAGE_SIZE - 1) >>> 12;
        if (endPage > startPage) fn(startPage >>> 0, (endPage - startPage) >>> 0, readable ? 1 : 0);
    }

    private isReadMapEligible(page: number, pte: number): boolean {
        const base = page * PAGE_SIZE;
        const end = base + PAGE_SIZE;
        const guardEnd = MEM_GUARD_BASE + MEM_GUARD_SIZE;
        return (pte & PTE_PRESENT) !== 0
            && (pte & 0xFFFFF000) === (base >>> 0)
            && base >= 0x00100000
            && end <= this.totalMemoryBytes
            && (end <= MEM_GUARD_BASE || base >= guardEnd);
    }

    /**
     * Write page directory + page tables into guest memory.
     * Identity-maps ALL 4GB as Present + RW + User so that only explicitly
     * decommitted pages fault. This matches pre-paging behavior where all
     * memory accesses go directly to the WASM backing store.
     */
    initialize(totalMemoryBytes: number, win9x = false): void {
        this.totalMemoryBytes = totalMemoryBytes;
        const mem = this.getMemory();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        // The tables must stay inside their reserved window: anything else means the
        // layout moved under us and the PTEs would land in some other region's memory.
        const ptEnd = PAGE_TABLES_ADDR + FULL_PD_ENTRIES * PAGE_SIZE;
        if (PAGE_DIR_ADDR < MEM_PAGETABLE_BASE || ptEnd > MEM_PAGETABLE_BASE + MEM_PAGETABLE_SIZE) {
            throw new Error(
                `PageTableManager: tables 0x${PAGE_DIR_ADDR.toString(16)}-0x${ptEnd.toString(16)} ` +
                `outside reserved window 0x${MEM_PAGETABLE_BASE.toString(16)}+0x${MEM_PAGETABLE_SIZE.toString(16)}`);
        }

        // Zero page directory (4KB)
        mem.fill(0, PAGE_DIR_ADDR, PAGE_DIR_ADDR + PAGE_SIZE);

        // Write all 1024 PDEs — each points to a page table
        for (let i = 0; i < FULL_PD_ENTRIES; i++) {
            const ptAddr = PAGE_TABLES_ADDR + i * PAGE_SIZE;
            view.setUint32(PAGE_DIR_ADDR + i * 4, ptAddr | PTE_DEFAULT, true);
        }

        // Write page table entries — identity map full 4GB
        for (let pdIdx = 0; pdIdx < FULL_PD_ENTRIES; pdIdx++) {
            const ptBase = PAGE_TABLES_ADDR + pdIdx * PAGE_SIZE;
            for (let ptIdx = 0; ptIdx < ENTRIES_PER_TABLE; ptIdx++) {
                const physPage = (pdIdx * PAGES_PER_TABLE + ptIdx) * PAGE_SIZE;
                view.setUint32(ptBase + ptIdx * 4, physPage | PTE_DEFAULT, true);
            }
        }

        // NULL guard: unmap pages 0-6 (28KB, 0x00000000-0x00006FFF).
        // On real Windows NT/2000/XP+, the first 64KB is NOACCESS.
        // On Windows 9x the null page was accessible — skip the guard for Win9x
        // games that legitimately write to low addresses (e.g. Reflexive Arcade).
        // We guard up to page 6 max because the bootloader/GDT/IDT/handlers
        // live at 0x7C00-0x8700+ (pages 7-8) and must remain present.
        //
        // `__forceNullGuard` (harness setWorkerFlag, before load_bundle) overrides the Win9x
        // exemption. Without the guard a jump through a NULL pointer does not fault: it
        // executes `add [eax],al` across thousands of zero bytes until it reaches the
        // bootloader, and the crash then reports 0x7c07 with every register and the whole
        // call site long gone. Forcing it converts that into a fault at the offending
        // instruction with the caller's frame still on the stack.
        const forceNullGuard = (globalThis as Record<string, unknown>).__forceNullGuard === true;
        const NULL_GUARD_PAGES = (win9x && !forceNullGuard) ? 0 : 7;
        const pt0Base = PAGE_TABLES_ADDR; // First page table covers 0x00000000-0x003FFFFF
        for (let i = 0; i < NULL_GUARD_PAGES; i++) {
            view.setUint32(pt0Base + i * 4, 0, true); // Clear Present bit
        }

        const ptRegionSize = FULL_PD_ENTRIES * PAGE_SIZE + PAGE_SIZE; // PD + PTs
        Logger.log(LogCategory.SYSTEM,
            `[PageTableManager] Initialized: ${FULL_PD_ENTRIES} page tables (4GB identity-mapped), ` +
            `null guard 0x0-0x${(NULL_GUARD_PAGES * PAGE_SIZE).toString(16)}, ` +
            `PT region 0x${PAGE_DIR_ADDR.toString(16)}-0x${(PAGE_DIR_ADDR + ptRegionSize).toString(16)} ` +
            `(${(ptRegionSize / 1024).toFixed(0)}KB), guest memory=${(totalMemoryBytes / (1024 * 1024)).toFixed(0)}MB`);
    }

    /**
     * Enable x86 paging by setting CR3 and CR0.PG + CR0.WP.
     * Must be called after protected mode + IDT are set up.
     */
    enablePaging(cpu: any): void {
        if (this.pagingEnabled) return;

        // Set CR3 = page directory physical address
        cpu.cr[3] = PAGE_DIR_ADDR;

        // Set CR0.PG (paging) + CR0.WP (write protect for ring 0)
        cpu.cr[0] = (cpu.cr[0] | CR0_PG | CR0_WP) >>> 0;

        // The read map is rebuilt from the PTEs after paging is live. No JIT cache
        // invalidation is needed: each fast read checks its page byte at runtime.
        const exports = this.getWasmExports();
        if (exports?.full_clear_tlb) {
            exports.full_clear_tlb();
        }

        this.pagingEnabled = true;
        this.rebuildReadMap();

        Logger.log(LogCategory.SYSTEM,
            `[PageTableManager] Paging enabled: CR3=0x${PAGE_DIR_ADDR.toString(16)}, ` +
            `CR0=0x${(cpu.cr[0] >>> 0).toString(16)}`);
    }

    /**
     * Clear Present bit for pages in range — makes them fault on access.
     * Used by VirtualFree(MEM_DECOMMIT).
     */
    decommitPages(baseAddr: number, sizeBytes: number): void {
        const startPage = (baseAddr >>> 12);
        const endPage = ((baseAddr + sizeBytes + PAGE_SIZE - 1) >>> 12);
        const mem = this.getMemory();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        for (let page = startPage; page < endPage; page++) {
            const pteOffset = this._getPteOffset(page);
            const pte = view.getUint32(pteOffset, true);
            // Clear Present bit, keep physical address for recommit
            view.setUint32(pteOffset, pte & ~PTE_PRESENT, true);
        }

        // Drop READ_OK before the TLB flush: a compiled load must immediately take
        // the universal accessor and raise #PF for this now-absent page.
        const exports = this.getWasmExports();
        this.setReadMap(baseAddr, sizeBytes, false);
        if (exports?.full_clear_tlb) {
            exports.full_clear_tlb();
        }
        // Track 2b Phase W: decommitted pages must fault → drop bit0 (byte-precise slow path).
        setWriteMapBase(baseAddr, sizeBytes, false);

        Logger.verbose(LogCategory.SYSTEM,
            `[PageTableManager] Decommitted ${endPage - startPage} pages at 0x${baseAddr.toString(16)}`);
    }

    /**
     * Set Present + RW + User for pages in range, then zero the memory.
     * For a range being allocated fresh — VirtualAlloc(MEM_RESERVE|MEM_COMMIT) and
     * paging-enable. A commit over pages that may ALREADY be committed must go through
     * `ensurePagesCommitted`, which leaves present pages (and their protection) alone.
     */
    commitPages(baseAddr: number, sizeBytes: number): void {
        const startPage = (baseAddr >>> 12);
        const endPage = ((baseAddr + sizeBytes + PAGE_SIZE - 1) >>> 12);
        const mem = this.getMemory();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        // A page that is already present and NOT writable is being promoted RO → RW here.
        // That is a protect-class change, not a commit: `setWriteMapBase(.., true)` below
        // marks the whole span base-writable, and that map is consulted per store with no
        // generation guard — so a speculated store would start bypassing the slow path on
        // a page the guest asked to be read-only. Detect it and bump, rather than trusting
        // every future caller to honour the fresh-range contract above.
        let protectionRaised = false;
        for (let page = startPage; page < endPage; page++) {
            const physAddr = page * PAGE_SIZE;
            const pteOffset = this._getPteOffset(page);
            const pte = view.getUint32(pteOffset, true);
            if ((pte & PTE_PRESENT) !== 0 && (pte & PTE_RW) === 0) protectionRaised = true;
            view.setUint32(pteOffset, physAddr | PTE_DEFAULT, true);
        }

        // A present identity-mapped page becomes readable immediately. RO and RW
        // both have READ_OK; write permission remains the write-map's concern.
        const exports = this.getWasmExports();
        if (protectionRaised) {
            Logger.warn(LogCategory.SYSTEM,
                `[PageTableManager] commitPages raised protection on a present read-only page ` +
                `in 0x${baseAddr.toString(16)}+0x${sizeBytes.toString(16)} — caller should use ` +
                `ensurePagesCommitted`);
        }
        if (exports?.full_clear_tlb) {
            exports.full_clear_tlb();
        }
        // Track 2b Phase W: committed pages are present + RW → mark base-writable (Rust
        // clamps to the identity-RAM envelope and skips the THUNK_CODE exclusion band).
        setWriteMapBase(baseAddr, sizeBytes, true);
        this.setReadMap(baseAddr, sizeBytes, true);

        // Zero memory — Windows guarantees clean pages on recommit
        mem.fill(0, baseAddr, baseAddr + sizeBytes);

        Logger.verbose(LogCategory.SYSTEM,
            `[PageTableManager] Committed ${endPage - startPage} pages at 0x${baseAddr.toString(16)}`);
    }

    /**
     * Commit only pages that are not presently mapped (Present bit clear).
     * Zeros newly committed pages; leaves already-present pages untouched.
     * Used when MemoryManager reuses VA after VirtualFree(MEM_DECOMMIT).
     */
    ensurePagesCommitted(baseAddr: number, sizeBytes: number): void {
        const startPage = (baseAddr >>> 12);
        const endPage = ((baseAddr + sizeBytes + PAGE_SIZE - 1) >>> 12);
        const mem = this.getMemory();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let recommitted = 0;

        for (let page = startPage; page < endPage; page++) {
            const pteOffset = this._getPteOffset(page);
            const pte = view.getUint32(pteOffset, true);
            if ((pte & PTE_PRESENT) !== 0) continue;

            const physAddr = page * PAGE_SIZE;
            view.setUint32(pteOffset, physAddr | PTE_DEFAULT, true);
            const pageStart = physAddr;
            const pageEnd = Math.min(pageStart + PAGE_SIZE, mem.length);
            if (pageStart < mem.length) {
                mem.fill(0, pageStart, pageEnd);
            }
            // Track 2b Phase W: only the pages actually (re)committed here become RW —
            // present pages (possibly RO) are skipped, so mark bit0 per recommitted page.
            setWriteMapBase(physAddr, PAGE_SIZE, true);
            this.setReadMap(physAddr, PAGE_SIZE, true);
            recommitted++;
        }

        if (recommitted === 0) return;

        const exports = this.getWasmExports();
        if (exports?.full_clear_tlb) {
            exports.full_clear_tlb();
        }

        Logger.verbose(LogCategory.SYSTEM,
            `[PageTableManager] ensurePagesCommitted: ${recommitted} pages at 0x${baseAddr.toString(16)}`);
    }

    /**
     * Update PTE flags based on Windows protection constants.
     * Used by VirtualProtect.
     */
    setProtection(baseAddr: number, sizeBytes: number, protect: number, _bumpGeneration = true): void {
        const PAGE_NOACCESS = 0x01;
        const PAGE_READONLY = 0x02;
        const PAGE_READWRITE = 0x04;
        const PAGE_EXECUTE_READ = 0x20;
        const PAGE_EXECUTE_READWRITE = 0x40;

        let flags: number;
        if (protect === PAGE_NOACCESS) {
            flags = 0; // Not present
        } else if (protect === PAGE_READONLY || protect === PAGE_EXECUTE_READ) {
            flags = PTE_PRESENT | PTE_USER; // Present, read-only
        } else if (protect === PAGE_READWRITE || protect === PAGE_EXECUTE_READWRITE) {
            flags = PTE_DEFAULT; // Present + RW + User
        } else {
            // Default: present + RW for unknown protect values
            flags = PTE_DEFAULT;
        }

        const startPage = (baseAddr >>> 12);
        const endPage = ((baseAddr + sizeBytes + PAGE_SIZE - 1) >>> 12);
        const mem = this.getMemory();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        for (let page = startPage; page < endPage; page++) {
            const physAddr = page * PAGE_SIZE;
            const pteOffset = this._getPteOffset(page);
            if (flags === 0) {
                // NOACCESS: clear present, keep physical address
                const pte = view.getUint32(pteOffset, true);
                view.setUint32(pteOffset, pte & ~PTE_PRESENT, true);
            } else {
                view.setUint32(pteOffset, physAddr | flags, true);
            }
        }

        // No global generation exists: the read-map is the per-page validity check.
        const exports = this.getWasmExports();
        if (exports?.full_clear_tlb) {
            exports.full_clear_tlb();
        }
        // Track 2b Phase W: bit0 tracks present + RW at the PTE level. RW (PTE_DEFAULT)
        // ⇒ writable; RO/NOACCESS ⇒ clear. The Rust envelope + THUNK_CODE exclusion make
        // an over-broad range safe (this is the sole maintainer for PE sub-page protects,
        // where the AddressSpace exact-match protect() misses and only PTM runs).
        setWriteMapBase(baseAddr, sizeBytes, flags === PTE_DEFAULT);
        this.setReadMap(baseAddr, sizeBytes, flags !== 0);
    }

    isPagingEnabled(): boolean {
        return this.pagingEnabled;
    }

    /** Rebuild the complete READ_OK view from the page tables. This is used after
     * paging enable and is intentionally independent of AddressSpace bookkeeping:
     * freed-but-still-present memory is readable on real hardware as well. */
    rebuildReadMap(): void {
        const exports = this.getWasmExports();
        const reset = exports?.fastmem_read_map_reset;
        const set = exports?.fastmem_read_map_set;
        if (!reset || !set || !this.pagingEnabled) return;
        reset();
        const mem = this.getMemory();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const pageCount = Math.ceil(this.totalMemoryBytes / PAGE_SIZE);
        let runStart = -1;
        const flush = (endPage: number) => {
            if (runStart >= 0) {
                set(runStart >>> 0, (endPage - runStart) >>> 0, 1);
                runStart = -1;
            }
        };
        for (let page = 0; page < pageCount; page++) {
            const pte = view.getUint32(this._getPteOffset(page), true);
            if (this.isReadMapEligible(page, pte)) {
                if (runStart < 0) runStart = page;
            } else {
                flush(page);
            }
        }
        flush(pageCount);
    }

    /** Compare the map byte-for-byte with the PTE-derived identity-map contract.
     * `danger` is a correctness failure (fast read accepted where it must fault or
     * translate); `missing` is conservative and affects performance only. */
    auditReadMap(maxReport = 32): {
        readablePages: number; danger: number; missing: number; samples: Array<{ page: number; pte: number; map: number; expected: boolean }>;
    } | null {
        const exports = this.getWasmExports();
        if (!exports?.fastmem_read_map_get || !this.pagingEnabled) return null;
        const mem = this.getMemory();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const pageCount = Math.ceil(this.totalMemoryBytes / PAGE_SIZE);
        let readablePages = 0, danger = 0, missing = 0;
        const samples: Array<{ page: number; pte: number; map: number; expected: boolean }> = [];
        for (let page = 0; page < pageCount; page++) {
            const pte = view.getUint32(this._getPteOffset(page), true);
            const expected = this.isReadMapEligible(page, pte);
            const map = exports.fastmem_read_map_get(page) >>> 0;
            if (expected) readablePages++;
            if (map === 1 && !expected) danger++;
            if (map !== 1 && expected) missing++;
            if ((map === 1) !== expected && samples.length < maxReport) samples.push({ page, pte, map, expected });
        }
        return { readablePages, danger, missing, samples };
    }

    /**
     * Track 2b Phase W: authoritatively (re)build the fastmem write map from scratch.
     * bit0 (fast-writable) = (page in a writable-RAM region) AND (its PTE is present+RW).
     * The intersection is required: the identity map leaves ROM/THUNK_CODE PTEs RW, and
     * gameplay decommit/VirtualProtect flips individual PTEs — so neither region intent
     * nor PTE state alone is safe. Call this before enabling fastmem writes (a stale or
     * region-only map could fast-write a decommitted or RO sub-page = corruption). Rust
     * clamps to the identity-RAM envelope and skips the THUNK_CODE exclusion band as a
     * backstop. ranges = writable-RAM spans from AddressSpace.getFastWritableRanges().
     */
    rebuildWriteMap(ranges: { base: number; size: number }[]): void {
        const exports = this.getWasmExports();
        if (!exports?.fastmem_write_map_reset) return;
        exports.fastmem_write_map_reset();
        if (exports.fastmem_write_map_set_exclude) {
            exports.fastmem_write_map_set_exclude(
                (MEM_THUNK_CODE_BASE >>> 12) >>> 0,
                ((MEM_THUNK_CODE_BASE + MEM_THUNK_CODE_SIZE) >>> 12) >>> 0,
            );
        }
        const setBase = exports.fastmem_write_map_set_base;
        // Without paging the store fast path is never emitted (fastmem_writes_compile_enabled).
        if (!setBase || !this.pagingEnabled) return;

        const mem = this.getMemory();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const RW = PTE_PRESENT | PTE_RW;
        for (const { base, size } of ranges) {
            if (size <= 0) continue;
            const startPage = base >>> 12;
            const endPage = (base + size + PAGE_SIZE - 1) >>> 12;
            // Batch contiguous present+RW runs into single FFI calls.
            let runStart = -1;
            for (let page = startPage; page < endPage; page++) {
                const pte = view.getUint32(this._getPteOffset(page), true);
                const writable = (pte & RW) === RW;
                if (writable) {
                    if (runStart < 0) runStart = page;
                } else if (runStart >= 0) {
                    setBase(runStart >>> 0, (page - runStart) >>> 0, 1);
                    runStart = -1;
                }
            }
            if (runStart >= 0) setBase(runStart >>> 0, (endPage - runStart) >>> 0, 1);
        }
    }

    /**
     * Track 2b Phase W safety net. Scans every page the write map has marked base-writable
     * and asserts the one corruption invariant: bit0 == 1 ⇒ the page's PTE is present + RW
     * AND the page is not in the immutable THUNK_CODE band. A violation means a choke point
     * failed to clear bit0 on a decommit / protect-down (silent-corruption class) — a
     * release blocker. Bounded by the highest marked page; a manual verb, not a hot path.
     */
    auditWriteMap(maxReport = 32): {
        maxPage: number;
        base0Pages: number;
        danger: number;
        samples: { page: string; byte: number; pte: string; reason: string }[];
    } | null {
        const exports = this.getWasmExports();
        if (!exports?.fastmem_write_map_get) return null;
        const maxPage = exports.fastmem_write_map_max_page
            ? (exports.fastmem_write_map_max_page() >>> 0)
            : 0;
        const mem = this.getMemory();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const RW = PTE_PRESENT | PTE_RW;
        const thunkLo = MEM_THUNK_CODE_BASE >>> 12;
        const thunkHi = (MEM_THUNK_CODE_BASE + MEM_THUNK_CODE_SIZE) >>> 12;
        let danger = 0;
        let base0Pages = 0;
        const samples: { page: string; byte: number; pte: string; reason: string }[] = [];
        for (let page = 0; page <= maxPage; page++) {
            const b = exports.fastmem_write_map_get(page) >>> 0;
            if ((b & 1) === 0) continue; // only bit0-set pages can fast-write
            base0Pages++;
            const pte = view.getUint32(this._getPteOffset(page), true) >>> 0;
            const writable = (pte & RW) === RW;
            const inThunk = page >= thunkLo && page < thunkHi;
            if (!writable || inThunk) {
                danger++;
                if (samples.length < maxReport) {
                    samples.push({
                        page: '0x' + (page * PAGE_SIZE).toString(16),
                        byte: b,
                        pte: '0x' + pte.toString(16),
                        reason: inThunk ? 'THUNK_CODE' : ((pte & PTE_PRESENT) ? 'READONLY' : 'NOT_PRESENT'),
                    });
                }
            }
        }
        return { maxPage, base0Pages, danger, samples };
    }

    /**
     * Calculate the byte offset in guest memory of the PTE for a given page number.
     * Always valid for pages 0..1048575 (full 4GB / 4KB).
     */
    private _getPteOffset(pageNumber: number): number {
        const pdIndex = (pageNumber >>> 10); // pageNumber / 1024
        const ptIndex = pageNumber & 0x3FF;  // pageNumber % 1024
        return PAGE_TABLES_ADDR + pdIndex * PAGE_SIZE + ptIndex * 4;
    }
}
