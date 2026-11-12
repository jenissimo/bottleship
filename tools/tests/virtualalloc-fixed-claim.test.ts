import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AddressSpace } from "../../src/worker/core/memory/address-space";
import { MemoryManager } from "../../src/worker/core/process";
import { ModuleRegistry } from "../../src/worker/core/module-registry";
import { System } from "../../src/worker/core/system";
import { exports as api, resetHeapSlab } from "../../src/worker/modules/kernel32/memory";
import { MEM_HEAP_BASE } from "../../src/worker/core/cpu/emulator-config";

const MB = 0x100000, PAGE = 0x1000, RW = 4;
const COMMIT = 0x1000, RESERVE = 0x2000, RELEASE = 0x8000, FREE = 0x10000, TOP_DOWN = 0x100000;
const QUERY = 0x10100;

// Blade of Darkness / SmartHeap: a pool grows in place with VirtualAlloc(lpAddress) into a
// range the guest itself released earlier. That claim must leave the released lists, or the
// next VirtualAlloc(NULL) is handed the same base and zeroes the live pool under it.
describe("VirtualAlloc at a fixed address claims the range from the anonymous allocator", () => {
    let savedProcess: unknown, savedScheduler: unknown;
    let mem: Uint8Array, view: DataView, memory: MemoryManager;
    const call = (name: string, args: number[]) => (api[name] as any)({} as any, mem, args) as number;
    const alloc = (size: number, type = RESERVE | COMMIT, address = 0) =>
        call("VirtualAlloc", [address, size, type, RW]) >>> 0;
    const state = (address: number) => {
        expect(call("VirtualQuery", [address, QUERY, 28])).toBe(28);
        return view.getUint32(QUERY + 16, true);
    };
    beforeEach(() => {
        const system = System.getInstance() as any;
        savedProcess = system.process; savedScheduler = system.scheduler;
        resetHeapSlab(); (globalThis as any).vaCacheEnable(false);
        mem = new Uint8Array(MEM_HEAP_BASE + 16 * MB); view = new DataView(mem.buffer);
        const space = new AddressSpace(() => mem); space.initializeLayout(mem.length);
        memory = new MemoryManager(space); memory.refreshLayoutBuckets();
        system.process = { addressSpace: space, memory, moduleRegistry: new ModuleRegistry(), getCurrentMemory: () => mem };
        system.scheduler = { setLastError: () => {}, findStackReservation: () => null };
    });
    afterEach(() => {
        resetHeapSlab(); (globalThis as any).vaCacheEnable(true);
        const system = System.getInstance() as any;
        system.process = savedProcess; system.scheduler = savedScheduler;
    });

    test("a released top-down range re-reserved by address is not handed out again", () => {
        // Two top-down pools; releasing the upper one (not at the high frontier) parks it
        // on the released-large list and VirtualQuery reports it MEM_FREE.
        const upper = alloc(MB, RESERVE | COMMIT | TOP_DOWN);
        const lower = alloc(MB, RESERVE | COMMIT | TOP_DOWN);
        expect(lower).toBe(upper - MB);
        expect(call("VirtualFree", [upper, 0, RELEASE])).toBe(1);
        expect(state(upper)).toBe(FREE);

        // The guest heap grows in place into the free run it found, and fills it.
        expect(alloc(MB, RESERVE | COMMIT, upper)).toBe(upper);
        for (let off = 0; off < MB; off += PAGE) view.setUint32(upper + off, 0x5348 + off, true);

        // An anonymous allocation of the same size must land elsewhere and leave it intact.
        const other = alloc(MB);
        expect(other).not.toBe(0);
        expect(other + MB <= upper || other >= upper + MB).toBe(true);
        for (let off = 0; off < MB; off += PAGE) expect(view.getUint32(upper + off, true)).toBe(0x5348 + off);
        expect(memory.getSize(upper)).toBe(MB);
    });

    test("a fixed claim in the top-down zone does not cross the bump and high frontiers", () => {
        const upper = alloc(MB, RESERVE | COMMIT | TOP_DOWN);
        alloc(MB, RESERVE | COMMIT | TOP_DOWN);
        expect(call("VirtualFree", [upper, 0, RELEASE])).toBe(1);
        const before = memory.getHighHeapReport()!;
        expect(alloc(MB, RESERVE | COMMIT, upper)).toBe(upper);
        const after = memory.getHighHeapReport()!;
        expect(after.next).toBe(before.next);
        expect(after.slabTop).toBe(before.slabTop);
        // Both frontiers still serve: a small bump block below, a top-down pool above it.
        const small = alloc(PAGE);
        expect(small).toBeLessThan(after.slabTop);
        const high = alloc(MB, RESERVE | COMMIT | TOP_DOWN);
        expect(high).toBe(after.slabTop - MB);
    });

    test("a fixed claim covering part of a released range keeps the remainder reusable", () => {
        const upper = alloc(2 * MB, RESERVE | COMMIT | TOP_DOWN);
        alloc(MB, RESERVE | COMMIT | TOP_DOWN);
        expect(call("VirtualFree", [upper, 0, RELEASE])).toBe(1);
        expect(alloc(MB, RESERVE | COMMIT, upper + MB)).toBe(upper + MB);
        view.setUint32(upper + MB, 0xC0FFEE, true);
        // The untouched lower half is still free and is what an anonymous 1MB gets.
        expect(alloc(MB)).toBe(upper);
        expect(view.getUint32(upper + MB, true)).toBe(0xC0FFEE);
    });

    test("a fixed reserve over a live heap block fails with ERROR_INVALID_ADDRESS and leaves it mapped", () => {
        let lastError = 0;
        (System.getInstance() as any).scheduler.setLastError = (e: number) => { lastError = e; };
        const pool = alloc(MB, RESERVE);
        expect(alloc(MB, COMMIT, pool)).toBe(pool);
        const block = call("LocalAlloc", [0, 0x644]) >>> 0;
        expect(block).toBe(pool + MB);
        view.setUint32(block + 0x274, 0xD5C, true);

        expect(alloc(MB, RESERVE, pool + MB)).toBe(0);
        expect(lastError).toBe(487);
        expect(state(block)).toBe(0x1000);
        expect(view.getUint32(block + 0x274, true)).toBe(0xD5C);

        const elsewhere = alloc(MB, RESERVE);
        expect(elsewhere).not.toBe(0);
        expect(elsewhere >= block + 0x644 || elsewhere + MB <= block).toBe(true);
    });

    test("a fixed reserve next to a heap block it does not cover still succeeds", () => {
        const pool = alloc(MB, RESERVE);
        const block = call("LocalAlloc", [0, 0x644]) >>> 0;
        const after = (block + 0x644 + 0xffff) & ~0xffff;
        expect(alloc(MB, RESERVE, after)).toBe(after);
        expect(pool).not.toBe(0);
    });

    test("with the free cache on, a released block re-reserved at its address is evicted from the cache, not aliased", () => {
        (globalThis as any).vaCacheEnable(true);
        const block = alloc(0x10000);
        expect(block).not.toBe(0);
        expect(call("VirtualFree", [block, 0, RELEASE])).toBe(1);
        expect((globalThis as any).vaCacheReport().parkedBytes).toBe(0x10000);
        expect(alloc(0x10000, RESERVE | COMMIT, block)).toBe(block);
        expect((globalThis as any).vaCacheReport().parkedBytes).toBe(0);
        view.setUint32(block, 0x5348, true);
        const next = alloc(0x10000);
        expect(next).not.toBe(0);
        expect(next).not.toBe(block);
        expect(view.getUint32(block, true)).toBe(0x5348);
        expect(memory.getSize(block)).toBe(0x10000);
    });
});
