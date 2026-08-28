/**
 * VirtualQuery's fast tier must be a pure accelerator of the full body.
 *
 * It answers exactly one branch of the classifier (a committed, page-granular private
 * page inside the HEAP/THUNK_DATA span) and defers everything else — so the only property
 * worth testing is the differential one: over a table of addresses that lands in EVERY
 * branch, either the fast path defers, or it writes byte-for-byte what the full body
 * writes. A fast path that answers a case it was not entitled to reads as a plausible
 * MEMORY_BASIC_INFORMATION for the whole session; this is what makes that visible.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { ModuleRegistry } from "../../src/worker/core/module-registry";
import {
    exports as memExports,
    __virtualQueryFastPathForTests,
    virtualQueryFastStats,
    resetVirtualQueryFastStats,
} from "../../src/worker/modules/kernel32/memory";

const MEM_HEAP_BASE = 0x01000000;
const PAGE_READWRITE = 0x04;
const MEM_COMMIT = 0x1000;
const MEM_RESERVE = 0x2000;
const MEM_DECOMMIT = 0x4000;

const MEM_SIZE = 0x02000000; // 32 MB — covers the EXE range and the low HEAP bucket

/** Where the mock allocator hands blocks out from (well inside HEAP, page aligned). */
const ALLOC_START = 0x01800000;

describe("VirtualQuery fast path == full body", () => {
    let mem: Uint8Array;
    let view: DataView;
    let registry: ModuleRegistry;
    let stacks: Array<{ base: number; top: number }>;
    let allocNext: number;
    let allocations: Map<number, number>;
    let lastError: number;

    const ctx = {
        eax: 0, ecx: 0, edx: 0, ebx: 0, esp: 0, ebp: 0, esi: 0, edi: 0, eip: 0, eflags: 0,
    } as any;

    /** Guest stack the fast path reads its arguments from: [ret][arg0][arg1][arg2]. */
    const FAKE_ESP = 0x01700000;
    const FAST_BUF = 0x01710000;
    const SLOW_BUF = 0x01720000;

    const cpu = { reg32: new Uint32Array(8) } as any;

    // The System singleton is shared with every other test file in this process:
    // leaving a stripped-down mock behind breaks whoever runs next.
    let savedProcess: unknown;
    let savedScheduler: unknown;

    beforeEach(() => {
        savedProcess = (System.getInstance() as any).process;
        savedScheduler = (System.getInstance() as any).scheduler;
        mem = new Uint8Array(MEM_SIZE);
        view = new DataView(mem.buffer);
        registry = new ModuleRegistry();
        stacks = [];
        allocNext = ALLOC_START;
        allocations = new Map();
        lastError = 0;

        const memoryManager = {
            alloc: (size: number, _kind?: string, _perms?: string, granularity = 0x1000) => {
                const align = Math.max(granularity, 0x1000);
                const addr = (allocNext + align - 1) & ~(align - 1);
                allocNext = addr + ((size + 0xFFF) & ~0xFFF);
                allocations.set(addr, size);
                return addr;
            },
            allocAt: (addr: number, size: number) => { allocations.set(addr, size); return addr; },
            allocFromHigh: (size: number) => memoryManager.alloc(size),
            free: (addr: number) => { allocations.delete(addr); },
            getSize: (addr: number) => allocations.get(addr >>> 0),
            getBucketFrontier: () => undefined,
        };

        const addressSpace = {
            fill: (addr: number, size: number, value: number) => { mem.fill(value, addr, addr + size); },
            getRegion: () => undefined,
        };

        const system = System.getInstance() as any;
        system.process = {
            memory: memoryManager,
            addressSpace,
            moduleRegistry: registry,
            pageTableManager: undefined,
            getCurrentMemory: () => mem,
        };
        system.scheduler = {
            setLastError: (e: number) => { lastError = e; },
            findStackReservation: (addr: number) => {
                const a = addr >>> 0;
                for (const s of stacks) if (a >= s.base && a < s.top) return s;
                return null;
            },
        };
        cpu.reg32[4] = FAKE_ESP;
        resetVirtualQueryFastStats();
    });

    afterEach(() => {
        (System.getInstance() as any).process = savedProcess;
        (System.getInstance() as any).scheduler = savedScheduler;
    });

    const callSlow = (addr: number, buf: number): number =>
        (memExports["VirtualQuery"] as any)(ctx, mem, [addr, buf, 28]) as number;

    const callFast = (addr: number, buf: number): number | null => {
        view.setUint32(FAKE_ESP, 0xDEADBEEF, true); // return address
        view.setUint32(FAKE_ESP + 4, addr, true);
        view.setUint32(FAKE_ESP + 8, buf, true);
        view.setUint32(FAKE_ESP + 12, 28, true);
        return __virtualQueryFastPathForTests(cpu, mem, new Uint32Array(mem.buffer), view) as number | null;
    };

    const mbi = (buf: number): number[] => {
        const out: number[] = [];
        for (let off = 0; off < 28; off += 4) out.push(view.getUint32(buf + off, true) >>> 0);
        return out;
    };

    /** Runs both tiers over `addr`; returns whether the fast tier served it. */
    const differential = (addr: number): { served: boolean; fast: number[]; slow: number[] } => {
        mem.fill(0, FAST_BUF, FAST_BUF + 28);
        mem.fill(0, SLOW_BUF, SLOW_BUF + 28);
        const fastRc = callFast(addr, FAST_BUF);
        const slowRc = callSlow(addr, SLOW_BUF);
        if (fastRc === null) return { served: false, fast: [], slow: mbi(SLOW_BUF) };
        expect(fastRc).toBe(slowRc);
        return { served: true, fast: mbi(FAST_BUF), slow: mbi(SLOW_BUF) };
    };

    test("a plain committed heap page is served, and matches the full body", () => {
        const heapPage = 0x01100000;
        const r = differential(heapPage);
        expect(r.served).toBe(true);
        expect(r.fast).toEqual(r.slow);
        expect(r.fast).toEqual([heapPage, heapPage, PAGE_READWRITE, 0x1000, MEM_COMMIT, PAGE_READWRITE, 0x20000]);
        expect(virtualQueryFastStats().hits).toBe(1);
    });

    test("an unaligned address inside a heap page answers for the page", () => {
        const r = differential(0x01100abc);
        expect(r.served).toBe(true);
        expect(r.fast).toEqual(r.slow);
    });

    test("a PE image page defers (the image branch reports MEM_IMAGE per-section)", () => {
        registry.register({
            name: "engine", path: "c:\\engine.dll",
            baseAddress: 0x01200000, size: 0x20000, entryPoint: 0,
            exports: new Map(), ordinalExports: new Map(),
            isRealDll: true, initialized: true,
            sections: [
                { name: ".text", virtualAddress: 0x1000, virtualSize: 0x8000, rawSize: 0x8000, characteristics: 0x60000020 },
                { name: ".data", virtualAddress: 0x9000, virtualSize: 0x2000, rawSize: 0x2000, characteristics: 0xC0000040 },
            ],
        });
        const r = differential(0x01201000);
        expect(r.served).toBe(false);
        expect(r.slow[6]).toBe(0x01000000); // MEM_IMAGE
        expect(r.slow[1]).toBe(0x01200000); // AllocationBase = image base
    });

    test("a thread-stack page defers (the stack branch reports the whole reservation)", () => {
        stacks.push({ base: 0x01300000, top: 0x01340000 });
        const r = differential(0x01320000);
        expect(r.served).toBe(false);
        expect(r.slow[1]).toBe(0x01300000);
        expect(r.slow[3]).toBe(0x40000);
    });

    test("a VirtualAlloc'd page defers (AllocationBase is the reservation base)", () => {
        const base = (memExports["VirtualAlloc"] as any)(
            ctx, mem, [0, 0x20000, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE]) as number;
        expect(base).toBeGreaterThan(0);
        const r = differential(base + 0x1000);
        expect(r.served).toBe(false);
        expect(r.slow[1]).toBe(base);
        (memExports["VirtualFree"] as any)(ctx, mem, [base, 0, 0x8000 /* MEM_RELEASE */]);
    });

    test("a decommitted page defers (it reads back MEM_RESERVE, not MEM_COMMIT)", () => {
        const base = (memExports["VirtualAlloc"] as any)(
            ctx, mem, [0, 0x20000, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE]) as number;
        const ok = (memExports["VirtualFree"] as any)(ctx, mem, [base + 0x1000, 0x1000, MEM_DECOMMIT]) as number;
        expect(ok).toBe(1);
        const r = differential(base + 0x1000);
        expect(r.served).toBe(false);
        expect(r.slow[4]).toBe(MEM_RESERVE);
        (memExports["VirtualFree"] as any)(ctx, mem, [base, 0, 0x8000]);
    });

    test("a free gap below the heap defers and coalesces to the next allocation", () => {
        const r = differential(0x00300000);
        expect(r.served).toBe(false);
        expect(r.slow[4]).toBe(0x10000);           // MEM_FREE
        expect(r.slow[3]).toBe(0x00400000 - 0x00300000);
    });

    test("the main-EXE range defers (MEM_IMAGE at 0x400000)", () => {
        const r = differential(0x00401000);
        expect(r.served).toBe(false);
        expect(r.slow[6]).toBe(0x01000000);
    });

    test("past backed RAM the body reports the tail RESERVED, so a walk can step over it", () => {
        // Wine's fill_basic_memory_info answers fake_reserved space with
        // MEM_RESERVE|PAGE_NOACCESS. The canonical walk is p = BaseAddress + RegionSize, so a
        // refusal here hands it no size to advance by and it re-asks the same address for
        // ever; MEM_FREE would instead invite an allocator to take a remnant it cannot have.
        const addr = MEM_SIZE + 0x1000;
        expect(callFast(addr, FAST_BUF)).toBeNull();
        expect(callSlow(addr, SLOW_BUF)).toBe(28);
        const info = mbi(SLOW_BUF);
        expect(info[0]).toBe(addr);            // BaseAddress
        expect(info[1]).toBe(MEM_SIZE);        // AllocationBase — the tail starts at backed RAM
        expect(info[3]).toBe(0x7FFF0000 - addr); // RegionSize reaches the user-space limit
        expect(info[4]).toBe(0x2000);          // MEM_RESERVE
        expect(info[5]).toBe(0x01);            // PAGE_NOACCESS
        expect(info[6]).toBe(0x20000);         // MEM_PRIVATE
        // The walk terminates where Windows terminates it, and not before.
        expect(callSlow(0x7FFF0000, SLOW_BUF)).toBe(0);
        expect(callSlow(0x7FFEF000, SLOW_BUF)).toBe(28);
    });

    test("a too-small output buffer defers to the body's own refusal", () => {
        view.setUint32(FAKE_ESP, 0xDEADBEEF, true);
        view.setUint32(FAKE_ESP + 4, 0x01100000, true);
        view.setUint32(FAKE_ESP + 8, FAST_BUF, true);
        view.setUint32(FAKE_ESP + 12, 4, true);
        expect(__virtualQueryFastPathForTests(cpu, mem, new Uint32Array(mem.buffer), view)).toBeNull();
        expect((memExports["VirtualQuery"] as any)(ctx, mem, [0x01100000, FAST_BUF, 4])).toBe(0);
    });

    test("the audit flag differences every served answer and stays silent when they agree", () => {
        (globalThis as any).__virtualQueryFastAudit = true;
        try {
            for (const addr of [0x01100000, 0x01101000, 0x01102000]) differential(addr);
            const stats = virtualQueryFastStats();
            expect(stats.auditArmed).toBe(true);
            expect(stats.auditChecked).toBe(3);
            expect(stats.auditMismatches).toBe(0);
        } finally {
            (globalThis as any).__virtualQueryFastAudit = false;
        }
    });

    test("stats separate the tier that served from the tier that deferred", () => {
        differential(0x01100000);
        differential(0x00300000);
        const stats = virtualQueryFastStats();
        expect(stats.hits).toBe(1);
        expect(stats.defers).toBe(1);
        expect(lastError).toBe(0);
    });
});
