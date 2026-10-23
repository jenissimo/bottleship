import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AddressSpace } from "../../src/worker/core/memory/address-space";
import { MemoryManager } from "../../src/worker/core/process";
import { System } from "../../src/worker/core/system";
import { ModuleRegistry } from "../../src/worker/core/module-registry";
import { exports as api, resetHeapSlab, __virtualQueryFastPathForTests } from "../../src/worker/modules/kernel32/memory";
import { MEM_HEAP_BASE, MEM_PAGETABLE_BASE, MEM_PAGETABLE_SIZE } from "../../src/worker/core/cpu/emulator-config";
import { PageTableManager } from "../../src/worker/core/memory/page-table-manager";

const PAGE = 0x1000, RW = 4, RO = 2, NONE = 1, RWX = 0x40;
const OUT = 0x10000, QUERY = 0x10100;
describe("VirtualProtect page subranges", () => {
    let savedProcess: unknown, savedScheduler: unknown;
    let mem: Uint8Array, view: DataView, space: AddressSpace, memory: MemoryManager;
    let error: number;
    const ctx = {} as any;
    const call = (name: string, args: number[]) => (api[name] as any)(ctx, mem, args) as number;
    const alloc = (size = 2 * PAGE, protection = RW) => call("VirtualAlloc", [0, size, 0x3000, protection]);
    const protect = (base: number, size: number, protection: number, out = OUT) =>
        call("VirtualProtect", [base, size, protection, out]);
    const query = (base: number) => {
        expect(call("VirtualQuery", [base, QUERY, 28])).toBe(28);
        return Array.from({ length: 7 }, (_, i) => view.getUint32(QUERY + i * 4, true));
    };
    beforeEach(() => {
        const system = System.getInstance() as any;
        savedProcess = system.process; savedScheduler = system.scheduler;
        resetHeapSlab();
        (globalThis as any).vaCacheEnable(false);
        mem = new Uint8Array(MEM_HEAP_BASE + 0x200000);
        view = new DataView(mem.buffer);
        space = new AddressSpace(() => mem);
        space.initializeLayout(mem.length);
        memory = new MemoryManager(space);
        memory.refreshLayoutBuckets();
        error = 0;
        system.process = { addressSpace: space, memory, moduleRegistry: new ModuleRegistry(), getCurrentMemory: () => mem };
        system.scheduler = { setLastError: (value: number) => { error = value; }, findStackReservation: () => null };
    });
    afterEach(() => {
        resetHeapSlab();
        (globalThis as any).vaCacheEnable(true);
        const system = System.getInstance() as any;
        system.process = savedProcess; system.scheduler = savedScheduler;
    });

    test("a second-page RO protection rejects writes crossing the boundary", () => {
        const base = alloc();
        expect(base).toBeGreaterThan(0);
        expect(protect(base + PAGE, PAGE, RO)).toBe(1);
        expect(view.getUint32(OUT, true)).toBe(RW);
        expect(space.validateRange(base, PAGE, "rw")).toBe(true);
        expect(space.validateRange(base + PAGE, PAGE, "r")).toBe(true);
        expect(space.validateRange(base + PAGE, 1, "w")).toBe(false);
        expect(space.validateRange(base + PAGE - 4, 8, "w")).toBe(false);
        expect(space.write(base + PAGE - 4, new Uint8Array(8))).toBe(0);
        expect(space.validateRange(base + PAGE - 4, 8, "r")).toBe(true);
    });
    test("first-page NOACCESS rejects reads that cross into or out of it", () => {
        const base = alloc();
        expect(protect(base, PAGE, NONE)).toBe(1);
        expect(space.validateRange(base, 1, "r")).toBe(false);
        expect(space.validateRange(base + PAGE - 4, 8, "r")).toBe(false);
        expect(space.validateRange(base + PAGE, PAGE, "rw")).toBe(true);
        expect(space.read(base, 1)).toBeNull();
    });
    test("query keeps AllocationBase and original protection across protected spans", () => {
        const base = alloc();
        const size = memory.getSize(base)!;
        expect(protect(base + PAGE, PAGE, RO)).toBe(1);
        const first = query(base), second = query(base + PAGE);
        expect(first.slice(0, 6)).toEqual([base, base, RW, PAGE, 0x1000, RW]);
        expect(second.slice(0, 6)).toEqual([base + PAGE, base, RW, PAGE, 0x1000, RO]);
        if (size > 2 * PAGE) {
            expect(query(base + 2 * PAGE).slice(0, 6)).toEqual([base + 2 * PAGE, 0, 0, size - 2 * PAGE, 0x10000, NONE]);
        }
        expect(protect(base + PAGE, PAGE, RWX)).toBe(1);
        expect(view.getUint32(OUT, true)).toBe(RO);
        expect(protect(base + PAGE, PAGE, RW)).toBe(1);
        expect(view.getUint32(OUT, true)).toBe(RWX);
    });
    test("one call cannot protect pages in two adjacent reservations", () => {
        const base = alloc(0x10000), size = memory.getSize(base)!;
        const next = call("VirtualAlloc", [base + size, PAGE, 0x3000, RW]);
        expect(next).toBe(base + size);
        view.setUint32(OUT, 0xa5a5a5a5, true);
        expect(protect(base + size - PAGE, 2 * PAGE, RO)).toBe(0);
        expect(error).toBe(487);
        expect(view.getUint32(OUT, true)).toBe(NONE);
        expect(space.validateRange(base + size - PAGE, 2 * PAGE, "w")).toBe(true);
    });
    test("decommitted pages fail atomically without changing the committed neighbour", () => {
        const base = alloc();
        expect(call("VirtualFree", [base + PAGE, PAGE, 0x4000])).toBe(1);
        view.setUint32(OUT, 0xdeadbeef, true);
        expect(protect(base, 2 * PAGE, NONE)).toBe(0);
        expect(view.getUint32(OUT, true)).toBe(NONE);
        expect(space.validateRange(base, PAGE, "w")).toBe(true);
    });
    test("invalid size, protection and old-protection output fail without mutations", () => {
        const base = alloc();
        for (const [size, protection, out] of [[0, RO, OUT], [PAGE, 0, OUT], [PAGE, RO, 0], [PAGE, RO, mem.length - 2]]) {
            expect(protect(base, size!, protection!, out!)).toBe(0);
            expect(space.validateRange(base, PAGE, "w")).toBe(true);
        }
    });
    test("release removes every protected span and fixed-address reuse is RW", () => {
        const base = alloc(), size = memory.getSize(base)!;
        expect(protect(base, PAGE, NONE)).toBe(1);
        expect(protect(base + PAGE, PAGE, RO)).toBe(1);
        expect(call("VirtualFree", [base, 0, 0x8000])).toBe(1);
        expect(space.findRegionsIntersecting(base, size)).toHaveLength(0);
        expect(call("VirtualAlloc", [base, size, 0x3000, RW])).toBe(base);
        expect(space.validateRange(base, size, "rw")).toBe(true);
    });
    test("unaligned ranges protect every intersected page", () => {
        const base = alloc();
        expect(protect(base + PAGE - 1, 2, RO)).toBe(1);
        expect(space.validateRange(base, 2 * PAGE, "w")).toBe(false);
        expect(space.validateRange(base, 2 * PAGE, "r")).toBe(true);
    });
    test("recycled backing gets a fresh reservation on its next lifetime", () => {
        (globalThis as any).vaCacheEnable(true);
        const base = alloc(), size = memory.getSize(base)!;
        mem[base] = 0x77;
        const before = space.getRegion(base)!;
        expect(before.owner).toBe("VirtualAlloc");
        expect(call("VirtualFree", [base, 0, 0x8000])).toBe(1);
        expect(space.findRegionsIntersecting(base, size)).toHaveLength(0);
        expect(alloc()).toBe(base);
        expect(space.getRegion(base)?.allocationId).not.toBe(before.allocationId);
        expect(mem[base]).toBe(0);
        expect(protect(base + PAGE, PAGE, RO)).toBe(1);
        expect(space.validateRange(base + PAGE, 1, "w")).toBe(false);
        expect(query(base + PAGE)[1]).toBe(base);
        expect(call("VirtualFree", [base, 0, 0x8000])).toBe(1);
        expect(space.findRegionsIntersecting(base, size)).toHaveLength(0);
    });
    test("an initially read-only allocation never enters the plain-RW recycler", () => {
        (globalThis as any).vaCacheEnable(true);
        const base = alloc(2 * PAGE, RO), size = memory.getSize(base)!;
        mem[base] = 0x77; // trusted host setup; guest access is read-only
        expect(space.validateRange(base, 1, "w")).toBe(false);
        expect(call("VirtualFree", [base, 0, 0x8000])).toBe(1);
        expect(space.findRegionsIntersecting(base, size)).toHaveLength(0);
        const writable = alloc();
        expect(space.validateRange(writable, 2 * PAGE, "rw")).toBe(true);
        expect(mem[writable]).toBe(0);
    });
    test("heap protection changes only its pages and makes the query fast path defer", () => {
        const base = alloc();
        expect(protect(base, PAGE, RO)).toBe(1);
        const heap = memory.alloc(2 * PAGE);
        const previous = (globalThis as any).preemption;
        const changes: Array<{ start: number; count: number; value: number }> = [];
        (globalThis as any).preemption = { getWasmExports: () => ({
            fastmem_write_map_set_base: (start: number, count: number, value: number) => {
                changes.push({ start, count, value });
            },
        }) };
        try {
            expect(protect(heap, PAGE, RO)).toBe(1);
            expect(changes).toEqual([{ start: heap >>> 12, count: 1, value: 0 }]);
            expect(space.validateRange(base, 1, "w")).toBe(false);
            const esp = 0x9000;
            view.setUint32(esp + 4, heap, true); view.setUint32(esp + 8, QUERY, true);
            view.setUint32(esp + 12, 28, true);
            expect(__virtualQueryFastPathForTests(esp, view, mem, new Uint32Array(mem.buffer), {} as any)).toBeNull();
            expect(query(heap)[5]).toBe(RO);
        } finally { (globalThis as any).preemption = previous; }
    });
    test("expanded layout protection uses the new allocation bounds", () => {
        const fresh = new AddressSpace(() => mem);
        fresh.registerRegion({ base: MEM_HEAP_BASE, size: PAGE, kind: "HEAP", perms: "rw",
            owner: "Layout", allowOverlap: true });
        expect(fresh.expandLayoutBucket("HEAP", 3 * PAGE)).toBe(3 * PAGE);
        expect(fresh.protect(MEM_HEAP_BASE + 2 * PAGE, PAGE, "r")).toBe(true);
        expect(fresh.validateRange(MEM_HEAP_BASE + 2 * PAGE, 1, "w")).toBe(false);
    });
    test("a rejected AddressSpace protection publishes failure flags without changing PTEs", () => {
        const base = alloc();
        const original = space.protect;
        let calls = 0;
        (System.getInstance().process as any).pageTableManager = {
            isPagingEnabled: () => true, setProtection: () => { calls++; },
        };
        view.setUint32(OUT, 0x12345678, true);
        space.protect = () => false;
        try {
            expect(protect(base, PAGE, RO)).toBe(0);
            expect(error).toBe(487);
            expect(view.getUint32(OUT, true)).toBe(NONE);
            expect(calls).toBe(0);
        } finally { space.protect = original; }
    });
    test("PE sub-pages retain image ownership and release with the image", () => {
        const base = 0x400000, size = 0x4000;
        space.mapRegion(base, size, "rwx", "ROM", "PELoader");
        (System.getInstance().process as any).moduleRegistry.register({
            name: "sample", path: "c:\\sample.exe", baseAddress: base, size, entryPoint: base,
            exports: new Map(), ordinalExports: new Map(), isRealDll: true, initialized: true,
            sections: [{ name: ".text", virtualAddress: PAGE, virtualSize: 2 * PAGE,
                rawSize: 2 * PAGE, characteristics: 0x60000020 }],
        });
        expect(protect(base + PAGE, PAGE, RWX)).toBe(1);
        expect(view.getUint32(OUT, true)).toBe(0x20);
        expect(protect(base + 2 * PAGE, PAGE, NONE)).toBe(1);
        expect(space.validateRange(base + 2 * PAGE - 4, 8, "r")).toBe(false);
        const result = query(base + PAGE);
        expect(result[1]).toBe(base);
        expect(result[3]).toBe(PAGE);
        expect(result[5]).toBe(RWX);
        expect(result[6]).toBe(0x1000000);
        // PE sections belong to the same mapped image allocation, even when a
        // later call crosses the protection fragments created by earlier calls.
        expect(protect(base + PAGE, 2 * PAGE, RO)).toBe(1);
        const fragments = space.findRegionsIntersecting(base, size);
        expect(new Set(fragments.map(region => region.allocationId)).size).toBe(1);
        expect(fragments.every(region => region.allocationBase === base && region.allocationSize === size)).toBe(true);
        expect(space.validateRange(base + PAGE, 2 * PAGE, "r")).toBe(true);
        expect(space.validateRange(base + PAGE, 2 * PAGE, "w")).toBe(false);
        expect(space.releaseRegion(base)).toBe(true);
        expect(space.findRegionsIntersecting(base, size)).toHaveLength(0);
    });
    test("real PTEs and HLE validation agree for RW, RO, NOACCESS and restoration", () => {
        // The actual page-table manager exercises the CPU-side mapping, not a mock.
        const large = new Uint8Array(MEM_PAGETABLE_BASE + MEM_PAGETABLE_SIZE);
        large.set(mem);
        mem = large; view = new DataView(mem.buffer);
        space = new AddressSpace(() => mem); space.initializeLayout(mem.length);
        memory = new MemoryManager(space); memory.refreshLayoutBuckets();
        const system = System.getInstance() as any;
        const ptm = new PageTableManager(() => mem, () => ({ full_clear_tlb: () => {} }));
        ptm.initialize(mem.length);
        ptm.enablePaging({ cr: new Uint32Array(4) });
        system.process.addressSpace = space; system.process.memory = memory;
        system.process.getCurrentMemory = () => mem; system.process.pageTableManager = ptm;
        const base = alloc();
        const pte = (address: number) => view.getUint32(
            MEM_PAGETABLE_BASE + PAGE + (address >>> 12) * 4, true) & 7;
        expect(pte(base)).toBe(7);
        expect(protect(base + PAGE, PAGE, RO)).toBe(1);
        expect(pte(base)).toBe(7); expect(pte(base + PAGE)).toBe(5);
        expect(space.validateRange(base + PAGE - 4, 8, "w")).toBe(false);
        mem[base + PAGE] = 0x77;
        expect(protect(base + PAGE, PAGE, NONE)).toBe(1);
        expect(pte(base + PAGE) & 1).toBe(0);
        expect(space.validateRange(base + PAGE, 4, "r")).toBe(false);
        expect(call("VirtualAlloc", [base + PAGE, PAGE, 0x1000, RW])).toBe(base + PAGE);
        expect(mem[base + PAGE]).toBe(0x77);
        expect(protect(base + PAGE, PAGE, RW)).toBe(1);
        expect(pte(base + PAGE)).toBe(7);
        expect(space.validateRange(base, 2 * PAGE, "rw")).toBe(true);
        expect(protect(base + PAGE, PAGE, RO)).toBe(1);
        expect(call("VirtualFree", [base, 0, 0x8000])).toBe(1);
        expect(call("VirtualAlloc", [base, 2 * PAGE, 0x3000, RO])).toBe(base);
        expect(pte(base)).toBe(5);
        expect(space.validateRange(base, PAGE, "w")).toBe(false);
        expect(call("VirtualFree", [base, 0, 0x8000])).toBe(1);
        (globalThis as any).vaCacheEnable(true);
        const cached = alloc(3 * PAGE);
        expect(pte(cached + 3 * PAGE) & 1).toBe(0);
        expect(call("VirtualFree", [cached, 0, 0x8000])).toBe(1);
        expect(pte(cached) & 1).toBe(0);
        expect(alloc(PAGE)).toBe(cached);
        expect(pte(cached)).toBe(7);
        expect(pte(cached + PAGE) & 1).toBe(0);
    });
    test("reset discards all protection fragments", () => {
        const base = alloc();
        expect(protect(base, PAGE, NONE)).toBe(1);
        space.reset(); space.initializeLayout(mem.length);
        expect(space.validateRange(base, 2 * PAGE, "rw")).toBe(true);
    });
});
