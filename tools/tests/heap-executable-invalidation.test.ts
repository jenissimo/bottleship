/**
 * The allocator's JIT-invalidation chokepoint is decided by PERMISSION, not by bucket.
 *
 * MemoryManager is one of the two allocators that hand out executable guest memory, and
 * the structural guarantee (an emitter cannot obtain executable memory without the
 * invalidation happening) only holds if it covers every way that memory is obtained.
 * VirtualAlloc passes the guest's own flProtect through as `perms` against kind HEAP, so
 * a guest PAGE_EXECUTE_READWRITE arena arrives here as heap-kind executable memory — and
 * a heap block re-handed from the free list may still carry blocks v86 compiled for its
 * previous tenant.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { AddressSpace } from "../../src/worker/core/memory/address-space";
import { MemoryManager } from "../../src/worker/core/process";
import { resetGuestCodeInvalidationState } from "../../src/worker/core/memory/guest-code";
import { preemptionManager } from "../../src/worker/core/cpu/preemption-manager";
import { MEM_THUNK_CODE_BASE } from "../../src/worker/core/cpu/emulator-config";

const MEM_SIZE = 0x40000000; // 1 GB — enough for the fixed layout's THUNK_CODE bucket.

let dirtied: Array<[number, number]>;
let savedExports: unknown;

function makeManager(): MemoryManager {
    const mem = new Uint8Array(MEM_SIZE);
    const space = new AddressSpace(() => mem);
    space.initializeLayout(MEM_SIZE);
    const manager = new MemoryManager(space);
    manager.refreshLayoutBuckets();
    return manager;
}

/** Did the allocator drop v86's blocks for every byte it just handed out? */
function covers(address: number, length: number): boolean {
    return dirtied.some(([lo, hi]) => lo <= address && hi >= address + length);
}

beforeEach(() => {
    dirtied = [];
    savedExports = (preemptionManager as unknown as { wasmExports: unknown }).wasmExports;
    resetGuestCodeInvalidationState();
    (preemptionManager as unknown as { wasmExports: unknown }).wasmExports = {
        jit_dirty_cache: (start: number, end: number) => {
            if (!(start < end)) throw new Error(`jit_dirty_cache called with start >= end (${start}, ${end})`);
            dirtied.push([start >>> 0, end >>> 0]);
        },
        jit_clear_cache_js: () => { /* a full clear also covers the range */ },
    };
});

afterEach(() => {
    (preemptionManager as unknown as { wasmExports: unknown }).wasmExports = savedExports;
    resetGuestCodeInvalidationState();
});

test("a guest PAGE_EXECUTE_READWRITE arena is invalidated although its bucket is HEAP", () => {
    const manager = makeManager();
    const size = 0x4000;
    const addr = manager.alloc(size, "HEAP", "rwx");
    expect(covers(addr, size)).toBe(true);
});

test("PAGE_EXECUTE_READ out of the heap bucket is invalidated too", () => {
    const manager = makeManager();
    const size = 0x2000;
    const addr = manager.alloc(size, "HEAP", "rx");
    expect(covers(addr, size)).toBe(true);
});

test("allocAt takes the same decision as alloc — one chokepoint, not two", () => {
    const manager = makeManager();
    const first = manager.alloc(0x1000, "HEAP", "rw");
    dirtied = [];
    const size = 0x1000;
    const addr = manager.allocAt(first + 0x10000, size, "HEAP", "rwx");
    expect(covers(addr, size)).toBe(true);
});

test("a plain HeapAlloc stays on the silent path — this runs on every allocation", () => {
    const manager = makeManager();
    const addr = manager.alloc(0x1000);
    expect(covers(addr, 0x1000)).toBe(false);
    expect(dirtied).toHaveLength(0);
});

test("THUNK_CODE is still invalidated by kind, whatever its permissions say", () => {
    const manager = makeManager();
    const size = 0x400;
    const addr = manager.allocAt(MEM_THUNK_CODE_BASE + 0x20000, size, "THUNK_CODE", "rx");
    expect(covers(addr, size)).toBe(true);
});
