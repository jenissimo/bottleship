import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AddressSpace } from "../../src/worker/core/memory/address-space";
import { isValidUserAddress } from "../../src/worker/core/memory/address-guard";
import { MemoryManager } from "../../src/worker/core/process";
import { ModuleRegistry } from "../../src/worker/core/module-registry";
import { System } from "../../src/worker/core/system";
import { exports as api, resetHeapSlab, __virtualQueryFastPathForTests } from "../../src/worker/modules/kernel32/memory";
import { MEM_HEAP_BASE } from "../../src/worker/core/cpu/emulator-config";

const PAGE = 0x1000, GRANULARITY = 0x10000, RW = 4, RO = 2, NONE = 1;
const COMMIT = 0x1000, RESERVE = 0x2000, DECOMMIT = 0x4000, RELEASE = 0x8000, FREE = 0x10000;
const OUT = 0x10000, QUERY = 0x10100, ESP = 0x10200;

// Native references: win32-virtual-memory-state (97), virtual-protect-state (80),
// and virtual-protect-output-v2 (144). Use actual allocation/permission metadata.
describe("Win32 logical virtual memory lifetime", () => {
    let savedProcess: unknown, savedScheduler: unknown;
    let mem: Uint8Array, view: DataView, space: AddressSpace, memory: MemoryManager, error: number;
    const call = (name: string, args: number[]) => (api[name] as any)({} as any, mem, args) as number;
    const alloc = (size = 3 * PAGE, protection = RW, type = RESERVE | COMMIT, address = 0) =>
        call("VirtualAlloc", [address, size, type, protection]);
    const protect = (address: number, size: number, protection: number, output = OUT) =>
        call("VirtualProtect", [address, size, protection, output]);
    const query = (address: number) => {
        expect(call("VirtualQuery", [address, QUERY, 28])).toBe(28);
        return Array.from({ length: 7 }, (_, i) => view.getUint32(QUERY + i * 4, true));
    };
    beforeEach(() => {
        const system = System.getInstance() as any;
        savedProcess = system.process; savedScheduler = system.scheduler;
        resetHeapSlab(); (globalThis as any).vaCacheEnable(false);
        mem = new Uint8Array(MEM_HEAP_BASE + 0x200000); view = new DataView(mem.buffer);
        space = new AddressSpace(() => mem); space.initializeLayout(mem.length);
        memory = new MemoryManager(space); memory.refreshLayoutBuckets();
        error = 0;
        system.process = { addressSpace: space, memory, moduleRegistry: new ModuleRegistry(), getCurrentMemory: () => mem };
        system.scheduler = { setLastError: (value: number) => { error = value; }, findStackReservation: () => null };
    });
    afterEach(() => {
        resetHeapSlab(); (globalThis as any).vaCacheEnable(true);
        const system = System.getInstance() as any;
        system.process = savedProcess; system.scheduler = savedScheduler;
    });
    test("reservation length is page-rounded, independently of 64KiB allocator capacity", () => {
        const base = alloc(3 * PAGE - 1, RW, RESERVE);
        expect(memory.getSize(base)).toBe(GRANULARITY);
        expect(query(base)).toEqual([base, base, RW, 3 * PAGE, RESERVE, 0, 0x20000]);
        expect(query(base + 3 * PAGE)).toEqual([base + 3 * PAGE, 0, 0, GRANULARITY - 3 * PAGE, FREE, NONE, 0]);
        expect(isValidUserAddress(mem, base, 4, "r")).toBe(false);
        expect(isValidUserAddress(mem, base + 3 * PAGE, 4, "r")).toBe(false);
    });
    test("commit changes every requested page's protection while preserving live bytes", () => {
        const base = alloc(3 * PAGE, RW, RESERVE);
        expect(alloc(PAGE, RW, COMMIT, base + PAGE)).toBe(base + PAGE);
        view.setUint32(base + PAGE, 0x11223344, true);
        expect(query(base).slice(3, 6)).toEqual([PAGE, RESERVE, 0]);
        expect(query(base + PAGE).slice(3, 6)).toEqual([PAGE, COMMIT, RW]);
        expect(alloc(3 * PAGE, RO, COMMIT, base)).toBe(base);
        expect(view.getUint32(base + PAGE, true)).toBe(0x11223344);
        expect(mem[base]).toBe(0); expect(mem[base + 2 * PAGE]).toBe(0);
        for (let i = 0; i < 3; i++) {
            expect(query(base + i * PAGE).slice(1, 6)).toEqual([base, RW, (3 - i) * PAGE, COMMIT, RO]);
            expect(isValidUserAddress(mem, base + i * PAGE, 4, "w")).toBe(false);
        }
        expect(alloc(PAGE, RW, COMMIT, base + 2 * PAGE)).toBe(base + 2 * PAGE);
        expect(query(base + PAGE).slice(2, 6)).toEqual([RW, PAGE, COMMIT, RO]);
        expect(query(base + 2 * PAGE).slice(2, 6)).toEqual([RW, PAGE, COMMIT, RW]);
    });
    test("decommit/recommit zeroes only newly committed pages without changing AllocationProtect", () => {
        const base = alloc();
        mem[base] = 0x66; mem[base + PAGE] = 0x77;
        expect(call("VirtualFree", [base + PAGE, PAGE, DECOMMIT])).toBe(1);
        expect(isValidUserAddress(mem, base, PAGE + 1, "r")).toBe(false);
        expect(alloc(2 * PAGE, RO, COMMIT, base)).toBe(base);
        expect(mem[base]).toBe(0x66); expect(mem[base + PAGE]).toBe(0);
        expect(query(base).slice(1, 6)).toEqual([base, RW, 2 * PAGE, COMMIT, RO]);
    });
    test("commit cannot extend past a logical reservation or revive a released range", () => {
        const base = alloc(3 * PAGE, RW, RESERVE);
        expect(alloc(2 * PAGE, RW, COMMIT, base + 2 * PAGE)).toBe(0);
        expect(error).toBe(487);
        expect(query(base).slice(3, 6)).toEqual([3 * PAGE, RESERVE, 0]);
        expect(call("VirtualFree", [base, 0, RELEASE])).toBe(1);
        expect(alloc(PAGE, RW, COMMIT, base)).toBe(0);
        expect(error).toBe(487);
    });
    test("release reports coalesced FREE capacity and its query fast path defers", () => {
        const base = alloc(), second = alloc();
        expect(second).toBe(base + GRANULARITY);
        expect(call("VirtualFree", [base, 0, RELEASE])).toBe(1);
        expect(call("VirtualFree", [second, 0, RELEASE])).toBe(1);
        expect(query(base)).toEqual([base, 0, 0, 2 * GRANULARITY, FREE, NONE, 0]);
        expect(space.findRegionsIntersecting(base, 2 * GRANULARITY)).toHaveLength(0);
        view.setUint32(ESP + 4, base, true); view.setUint32(ESP + 8, QUERY, true); view.setUint32(ESP + 12, 28, true);
        expect(__virtualQueryFastPathForTests(ESP, view, mem, new Uint32Array(mem.buffer), {} as any)).toBeNull();
        expect(isValidUserAddress(mem, base, 4, "w")).toBe(false);
    });
    test("implicit MemoryManager reuse clears FREE metadata even without paging", () => {
        const base = alloc(GRANULARITY);
        expect(call("VirtualFree", [base, 0, RELEASE])).toBe(1);
        expect(query(base)[4]).toBe(FREE);
        const heap = memory.alloc(PAGE);
        expect(heap).toBe(base);
        expect(query(heap).slice(3, 6)).toEqual([PAGE, COMMIT, RW]);
        expect(isValidUserAddress(mem, heap, PAGE, "w")).toBe(true);
        expect(query(heap + PAGE)[4]).toBe(FREE);
    });
    test("direct allocator reset drops logical/free indexes and cached physical ownership", () => {
        (globalThis as any).vaCacheEnable(true);
        const base = alloc(GRANULARITY);
        expect(call("VirtualFree", [base, 0, RELEASE])).toBe(1);
        memory.reset();
        expect(query(base)[4]).toBe(COMMIT);
        const next = alloc(PAGE);
        expect(next).toBe(base);
        expect(query(next).slice(3, 6)).toEqual([PAGE, COMMIT, RW]);
    });
    test("cache reuse has a fresh logical extent, cleared bytes and no stale permission spans", () => {
        (globalThis as any).vaCacheEnable(true);
        const base = alloc(3 * PAGE);
        mem.fill(0x77, base, base + 3 * PAGE);
        const id = space.getRegion(base)!.allocationId;
        expect(call("VirtualFree", [base, 0, RELEASE])).toBe(1);
        expect(space.findRegionsIntersecting(base, GRANULARITY)).toHaveLength(0);
        expect(alloc(PAGE)).toBe(base);
        expect(space.getRegion(base)!.allocationId).not.toBe(id);
        expect(mem[base]).toBe(0);
        expect(query(base).slice(3, 6)).toEqual([PAGE, COMMIT, RW]);
        expect(query(base + PAGE).slice(3, 6)).toEqual([GRANULARITY - PAGE, FREE, NONE]);
        expect(isValidUserAddress(mem, base + PAGE, 1, "r")).toBe(false);
        expect(alloc(PAGE, RW, COMMIT, base + PAGE)).toBe(0);
    });
    test("VirtualProtect publishes native failure outputs and leaves target protection atomic", () => {
        const base = alloc();
        expect(call("VirtualFree", [base + PAGE, PAGE, DECOMMIT])).toBe(1);
        for (const [size, flags, expectedError, expectedOld] of [
            [0, RO, 87, 0], [PAGE, 0x123450, 87, 0],
            [2 * PAGE, NONE, 487, NONE], [0x100000, NONE, 487, NONE],
        ]) {
            view.setUint32(OUT, 0xfeed, true);
            expect(protect(base, size!, flags!)).toBe(0);
            expect(error).toBe(expectedError);
            expect(view.getUint32(OUT, true)).toBe(expectedOld);
            expect(space.validateRange(base, PAGE, "w")).toBe(true);
        }
    });
    test("old-protection output is validated first, including partial pages, reserve and release", () => {
        const base = alloc(PAGE), out = alloc(2 * PAGE);
        const bad: number[] = [0, 1];
        expect(protect(out, PAGE, RO)).toBe(1); bad.push(out);
        expect(protect(out + PAGE, PAGE, NONE)).toBe(1); bad.push(out + PAGE, out + PAGE - 2);
        const reserved = alloc(PAGE, RW, RESERVE); bad.push(reserved);
        const dc = alloc(PAGE); expect(call("VirtualFree", [dc, PAGE, DECOMMIT])).toBe(1); bad.push(dc);
        const freed = alloc(PAGE); expect(call("VirtualFree", [freed, 0, RELEASE])).toBe(1); bad.push(freed);
        for (const output of bad) {
            expect(protect(base, 0, 0, output)).toBe(0);
            expect(error).toBe(998);
            expect(protect(base, PAGE, RO, output)).toBe(0);
            expect(error).toBe(998);
            expect(space.validateRange(base, PAGE, "w")).toBe(true);
        }
        error = 0x2345;
        expect(protect(base, PAGE, RO)).toBe(1);
        expect(error).toBe(0x2345); expect(view.getUint32(OUT, true)).toBe(RW);
    });
    test("successful protection can revoke its own old-protection output without a writeback", () => {
        for (const [size, protection, offset] of [
            [PAGE, RO, 16], [PAGE, NONE, 16], [PAGE, RO, PAGE - 2], [2 * PAGE, RO, PAGE - 2],
        ]) {
            const base = alloc(2 * PAGE), output = base + offset!;
            view.setUint32(output, 0xdeadbeef, true); error = 0x4567;
            expect(protect(base, size!, protection!, output)).toBe(1);
            expect(error).toBe(0x4567);
            expect(view.getUint32(output, true)).toBe(0xdeadbeef);
            expect(query(base)[5]).toBe(protection);
            expect(protect(base, 2 * PAGE, RW)).toBe(1);
            expect(view.getUint32(output, true)).toBe(0xdeadbeef);
        }
    });
    test("an initially RO output rejects a request that would make that output writable", () => {
        const base = alloc(PAGE), output = base + 16;
        view.setUint32(output, 0xdeadbeef, true);
        expect(protect(base, PAGE, RO)).toBe(1);
        expect(protect(base, PAGE, RW, output)).toBe(0);
        expect(error).toBe(998);
        expect(query(base)[5]).toBe(RO);
        expect(view.getUint32(output, true)).toBe(0xdeadbeef);
    });
});
