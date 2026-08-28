/**
 * HeapSize / HeapReAlloc: the fast tier must answer for BOTH allocators.
 *
 * A block lives either in the WASM slab (its header dword carries the bin) or in the JS
 * heap (a MemoryManager allocation), and a VirtualAlloc reservation is neither — Win32
 * answers (SIZE_T)-1 there. Getting that reconciliation wrong is not a slow answer, it is
 * a wrong one, so every case below is differenced against the slow-path body that has
 * always owned it.
 *
 * The load-bearing one is the FREE-marked slab block: reporting a free-listed block as a
 * live sized allocation hands the same block to two owners.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import {
    exports as memExports,
    heapSizeFastPath,
    heapReAllocFastPath,
    allocateHeapSlab,
    resetHeapSlab,
} from "../../src/worker/modules/kernel32/memory";

const MEM_SIZE = 0x02000000;         // 32 MB
const SLAB_BASE = 0x01C00000;        // 4 MB slab, ending exactly at MEM_SIZE
const SLAB_MAGIC_BUSY = 0x534C4100;  // 'SLA'
const SLAB_MAGIC_FREE = 0x534C4600;  // 'SLF'
const SLAB_BIN_SIZES = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096];

const PAGE_READWRITE = 0x04;
const MEM_COMMIT = 0x1000;
const MEM_RESERVE = 0x2000;
const MEM_RELEASE = 0x8000;
const HEAP_REALLOC_IN_PLACE_ONLY = 0x10;
const HEAP_ZERO_MEMORY = 0x08;
const ERROR_INVALID_PARAMETER = 87;
const SIZE_T_MINUS_ONE = 0xFFFFFFFF;

describe("HeapSize / HeapReAlloc fast path == slow path", () => {
    let mem: Uint8Array;
    let view: DataView;
    let allocations: Map<number, number>;
    let allocNext: number;
    let lastError: number;

    const FAKE_ESP = 0x01700000;
    const cpu = { reg32: new Uint32Array(8) } as any;
    const ctx = { eax: 0, ecx: 0, edx: 0, ebx: 0, esp: FAKE_ESP, ebp: 0, esi: 0, edi: 0, eip: 0, eflags: 0 } as any;
    const HHEAP = 0x12345678;

    // The System singleton is shared with every other test file in this process:
    // leaving a stripped-down mock behind breaks whoever runs next.
    let savedProcess: unknown;
    let savedScheduler: unknown;

    beforeEach(() => {
        savedProcess = (System.getInstance() as any).process;
        savedScheduler = (System.getInstance() as any).scheduler;
        mem = new Uint8Array(MEM_SIZE);
        view = new DataView(mem.buffer);
        allocations = new Map();
        allocNext = 0x01100000;
        lastError = 0;

        const memoryManager: any = {
            alloc: (size: number, _kind?: string, _perms?: string, granularity = 0x10) => {
                const align = Math.max(granularity, 0x10);
                const addr = (allocNext + align - 1) & ~(align - 1);
                allocNext = addr + ((size + 0xFFF) & ~0xFFF);
                allocations.set(addr, size);
                return addr;
            },
            allocAt: (addr: number, size: number) => { allocations.set(addr, size); return addr; },
            allocFromHigh: (size: number) => memoryManager.alloc(size, "HEAP", "rw", 0x10000),
            allocSlabArena: () => SLAB_BASE,
            free: (addr: number) => { allocations.delete(addr); },
            getSize: (addr: number) => allocations.get(addr >>> 0),
            getBucketFrontier: () => undefined,
            getBucketStats: () => [],
        };

        const system = System.getInstance() as any;
        system.process = {
            memory: memoryManager,
            addressSpace: {
                fill: (addr: number, size: number, value: number) => { mem.fill(value, addr, addr + size); },
                getRegion: () => undefined,
            },
            moduleRegistry: undefined,
            pageTableManager: undefined,
            getCurrentMemory: () => mem,
        };
        system.scheduler = { setLastError: (e: number) => { lastError = e; } };

        cpu.reg32[4] = FAKE_ESP;
        resetHeapSlab();
        allocateHeapSlab();
    });

    afterEach(() => {
        resetHeapSlab();
        (System.getInstance() as any).process = savedProcess;
        (System.getInstance() as any).scheduler = savedScheduler;
    });

    /** Stamp a slab block header and return the user pointer. */
    const slabBlock = (offset: number, bin: number, busy = true): number => {
        const ptr = SLAB_BASE + offset;
        view.setUint32(ptr - 4, (busy ? SLAB_MAGIC_BUSY : SLAB_MAGIC_FREE) | bin, true);
        return ptr;
    };

    const pushArgs = (args: number[]): void => {
        view.setUint32(FAKE_ESP, 0xDEADBEEF, true);
        for (let i = 0; i < args.length; i++) view.setUint32(FAKE_ESP + 4 + i * 4, args[i]!, true);
    };

    const fastSize = (lpMem: number): number | null => {
        pushArgs([HHEAP, 0, lpMem]);
        return heapSizeFastPath(cpu, mem, new Uint32Array(mem.buffer), view) as number | null;
    };
    const slowSize = (lpMem: number): number =>
        (memExports["HeapSize"] as any)(ctx, mem, [HHEAP, 0, lpMem]) as number;

    const fastReAlloc = (flags: number, lpMem: number, bytes: number): number | null => {
        pushArgs([HHEAP, flags, lpMem, bytes]);
        return heapReAllocFastPath(cpu, mem, new Uint32Array(mem.buffer), view) as number | null;
    };
    const slowReAlloc = (flags: number, lpMem: number, bytes: number): number =>
        (memExports["HeapReAlloc"] as any)(ctx, mem, [HHEAP, flags, lpMem, bytes]) as number;

    // ── HeapSize ──────────────────────────────────────────────────────────────
    test("a BUSY slab block reports its bin size, on both tiers", () => {
        for (let bin = 0; bin < SLAB_BIN_SIZES.length; bin++) {
            const ptr = slabBlock(0x1000 + bin * 0x2000, bin);
            expect(fastSize(ptr)).toBe(SLAB_BIN_SIZES[bin]!);
            expect(slowSize(ptr)).toBe(SLAB_BIN_SIZES[bin]!);
        }
    });

    test("a FREE-marked slab block is NOT a live sized allocation, on both tiers", () => {
        const ptr = slabBlock(0x40000, 3, false);
        expect(fastSize(ptr)).toBe(SIZE_T_MINUS_ONE);
        expect(slowSize(ptr)).toBe(SIZE_T_MINUS_ONE);
    });

    test("a JS-heap block reports its tracked size, on both tiers", () => {
        const ptr = (System.getInstance() as any).process.memory.alloc(200) as number;
        expect(fastSize(ptr)).toBe(200);
        expect(slowSize(ptr)).toBe(200);
    });

    test("a VirtualAlloc reservation is not a heap block, on both tiers", () => {
        const base = (memExports["VirtualAlloc"] as any)(
            ctx, mem, [0, 0x20000, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE]) as number;
        for (const p of [base, base + 0x1000, base + 0x1fff0]) {
            expect(fastSize(p)).toBe(SIZE_T_MINUS_ONE);
            expect(slowSize(p)).toBe(SIZE_T_MINUS_ONE);
        }
        (memExports["VirtualFree"] as any)(ctx, mem, [base, 0, MEM_RELEASE]);
    });

    test("an unknown pointer and NULL both report (SIZE_T)-1, on both tiers", () => {
        for (const p of [0, 0x00900000]) {
            expect(fastSize(p)).toBe(SIZE_T_MINUS_ONE);
            expect(slowSize(p)).toBe(SIZE_T_MINUS_ONE);
        }
    });

    // ── HeapReAlloc ───────────────────────────────────────────────────────────
    test("a shrink or fit inside a slab bin keeps the pointer, on both tiers", () => {
        const ptr = slabBlock(0x80000, 4); // 256-byte bin
        expect(fastReAlloc(0, ptr, 256)).toBe(ptr);
        expect(fastReAlloc(0, ptr, 17)).toBe(ptr);
        expect(slowReAlloc(0, ptr, 256)).toBe(ptr);
    });

    test("a fit inside a JS-heap block keeps the pointer, on both tiers", () => {
        const ptr = (System.getInstance() as any).process.memory.alloc(512) as number;
        expect(fastReAlloc(0, ptr, 512)).toBe(ptr);
        expect(slowReAlloc(0, ptr, 300)).toBe(ptr);
    });

    test("a grow past the bin defers — the move is the slow tier's to make", () => {
        const ptr = slabBlock(0x90000, 2); // 64-byte bin
        expect(fastReAlloc(0, ptr, 65)).toBeNull();
        const moved = slowReAlloc(0, ptr, 65);
        expect(moved).toBeGreaterThan(0);
        expect(moved).not.toBe(ptr);
    });

    test("IN_PLACE_ONLY refuses a grow with ERROR_INVALID_PARAMETER, on both tiers", () => {
        const ptr = slabBlock(0xA0000, 1); // 32-byte bin
        expect(fastReAlloc(HEAP_REALLOC_IN_PLACE_ONLY, ptr, 33)).toBe(0);
        expect(lastError).toBe(ERROR_INVALID_PARAMETER);
        lastError = 0;
        expect(slowReAlloc(HEAP_REALLOC_IN_PLACE_ONLY, ptr, 33)).toBe(0);
        expect(lastError).toBe(ERROR_INVALID_PARAMETER);
    });

    test("a FREE-marked slab block is never resized in place", () => {
        const ptr = slabBlock(0xB0000, 5, false);
        expect(fastReAlloc(0, ptr, 16)).toBeNull();
    });

    test("size 0 and an oversize request defer to the slow tier's diagnostics", () => {
        const ptr = slabBlock(0xC0000, 0);
        expect(fastReAlloc(0, ptr, 0)).toBeNull();
        expect(fastReAlloc(0, ptr, 0x20000001)).toBeNull();
        expect(slowReAlloc(0, ptr, 0)).toBe(0);
        expect(lastError).toBe(8);
    });

    test("a VirtualAlloc pointer is never resized in place by the fast tier", () => {
        const base = (memExports["VirtualAlloc"] as any)(
            ctx, mem, [0, 0x20000, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE]) as number;
        // The reservation IS a MemoryManager allocation, so capacity resolves — the fast
        // tier may only keep the pointer put, exactly as the slow body does.
        expect(fastReAlloc(0, base, 0x10000)).toBe(slowReAlloc(0, base, 0x10000));
        (memExports["VirtualFree"] as any)(ctx, mem, [base, 0, MEM_RELEASE]);
    });

    test("an unknown pointer defers rather than inventing a capacity", () => {
        expect(fastReAlloc(0, 0x00900000, 32)).toBeNull();
    });

    // ── HEAP_ZERO_MEMORY ──────────────────────────────────────────────────────
    // The caller is entitled to zeros over [oldSize, dwBytes). Neither tier holds the
    // caller's PREVIOUS requested size — `capacity` is the rounded allocation — so the
    // fast tier must not answer at all, and the slow tier owns the zeroing.
    test("the fast tier declines HEAP_ZERO_MEMORY instead of keeping the block put", () => {
        const ptr = slabBlock(0xD0000, 4); // 256-byte bin
        expect(fastReAlloc(0, ptr, 128)).toBe(ptr);
        expect(fastReAlloc(HEAP_ZERO_MEMORY, ptr, 128)).toBeNull();
    });

    test("the slow tier zeroes the grown tail when the block has to move", () => {
        const ptr = (System.getInstance() as any).process.memory.alloc(64) as number;
        // Dirty the arena the relocation will land in: a destination that happens to be
        // zero already would make this test pass without anything zeroing it.
        mem.fill(0xEE, 0x01100000, 0x01300000);
        mem.fill(0x5A, ptr, ptr + 64);
        const grown = slowReAlloc(HEAP_ZERO_MEMORY, ptr, 512);
        expect(grown).not.toBe(0);
        expect(grown).not.toBe(ptr);
        // The old contents survive, and everything past them reads as zero.
        expect([...mem.subarray(grown, grown + 64)]).toEqual(new Array(64).fill(0x5A));
        for (let i = 64; i < 512; i++) {
            expect(`+${i}:${mem[grown + i]}`).toBe(`+${i}:0`);
        }
    });
});
