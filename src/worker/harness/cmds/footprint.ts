/**
 * footprint({verify?}) — what the emulator itself holds, from the inside.
 *
 * On iOS the WebContent process dies at its per-process limit (~2 GB footprint = dirty plus
 * compressed pages) and no OS counter is readable from the page, so this verb is the
 * diagnostic there: it adds up the emulator's own large holdings by category. Desktop
 * private-working-set numbers (tools/probes) remain the ground truth where available.
 *
 * - `wasm`: the v86 linear memory (reserved/committed by the engine, NOT necessarily touched)
 *   and the guest RAM inside it.
 * - `guestDirty`: guest-page-dirty.ts's view — pages that may hold non-zero bytes. This is
 *   an UPPER BOUND on guest RAM made resident by us or the guest (zero pages that were only
 *   read are not in it, pages written by an untracked writer are). `zero*` counts how many
 *   bytes zeroing sites asked for vs. actually wrote. `verify:true` reads every clean page and
 *   reports non-zero ones — desktop only: reading makes the pages resident.
 * - `pageTable`: PTE census over guest RAM; `allocator`: MemoryManager live/peak bytes and per
 *   bucket frontiers ("handed out" = frontier - base, slab = limit - slabTop).
 * - `sab`: SharedArrayBuffers created in this worker at noted sites (the page's own census is
 *   merged in by the facade when called from the page).
 * - `gpu`: estimated bytes of live GPUBuffers/GPUTextures created on this worker's devices.
 * - `jsCaches`: the bundle block cache (JS heap); `jit`: live JIT module slots.
 */

import type { HarnessService } from "../service";
import { System } from "../../core/system";
import { guestPageDirtyStats, verifyCleanGuestPages } from "../../core/memory/guest-page-dirty";
import { sharedBufferCensus } from "../../../utils/shared-buffer-census";
import { gpuMemoryCensus } from "../../backends/webgpu/shared/gpu-memory-census";

const MB = 1024 * 1024;
const mb = (b: number | undefined | null): number | null => (typeof b === "number" ? Math.round((b / MB) * 10) / 10 : null);

/** v86 places JIT slot i at wasm_table[i + WASM_TABLE_OFFSET] (vendor/v86/src/const.js). */
const WASM_TABLE_OFFSET = 1024;
const WASM_TABLE_SIZE = 900;

export function collectFootprint(opts: { verify?: boolean; repair?: boolean } = {}): Record<string, unknown> {
    const process = System.getInstance().process;
    const v86 = process?.v86 as unknown as { cpu?: any; v86?: { cpu?: any } } | undefined;
    const cpu = v86?.cpu ?? v86?.v86?.cpu;
    const mem = process?.getCurrentMemory?.() as Uint8Array | undefined;
    const wasmBuffer = cpu?.wasm_memory?.buffer as ArrayBufferLike | undefined;

    const wasm = {
        linearMemoryMB: mb(wasmBuffer?.byteLength),
        shared: typeof SharedArrayBuffer !== "undefined" && wasmBuffer instanceof SharedArrayBuffer,
        guestRamMB: mb(mem?.length),
        guestRamOffset: mem?.byteOffset ?? null,
    };

    const dirty = guestPageDirtyStats();
    const guestDirty: Record<string, unknown> = {
        tracked: dirty.tracked,
        dirtyMB: mb(dirty.dirtyBytes),
        cleanMB: mb(dirty.cleanBytes),
        zeroRequestedMB: mb(dirty.zeroRequestedBytes),
        zeroWrittenMB: mb(dirty.zeroWrittenBytes),
        zeroSkippedMB: mb(dirty.zeroSkippedBytes),
    };
    if (opts.verify && mem) guestDirty.verify = verifyCleanGuestPages(mem, opts.repair === true);

    let pageTable: Record<string, unknown> | null = null;
    const ptm = process?.pageTableManager;
    if (ptm) {
        const c = ptm.pageCensus();
        pageTable = { pagingEnabled: c.pagingEnabled, presentRwMB: mb(c.presentRw * 4096),
            presentRoMB: mb(c.presentRo * 4096), notPresentMB: mb(c.notPresent * 4096) };
    }

    let allocator: Record<string, unknown> | null = null;
    if (process?.memory) {
        const m = process.memory.getMetrics();
        allocator = {
            liveMB: mb(m.currentBytes), peakMB: mb(m.peakBytes), allocations: m.allocationCount,
            buckets: process.memory.getBucketStats().map((b) => ({
                kind: b.kind,
                handedOutMB: mb(b.next - b.base),
                slabMB: mb(b.limit - b.slabTop),
                freeListMB: mb(b.freeBytes),
                sizeMB: mb(b.limit - b.base),
            })),
        };
    }

    let jit: Record<string, unknown> | null = null;
    const table = cpu?.wm?.wasm_table as WebAssembly.Table | undefined;
    if (table) {
        let live = 0;
        const end = Math.min(table.length, WASM_TABLE_OFFSET + WASM_TABLE_SIZE);
        for (let i = WASM_TABLE_OFFSET; i < end; i++) { try { if (table.get(i)) live++; } catch { /* */ } }
        // v86 counts every module it emits into __jitCompileStats (cpu.js codegen_finalize).
        // Live bytes are not tracked per slot, so the live figure is the mean emitted module
        // size times the live slot count: wasm bytes, before the engine compiles them to
        // machine code (typically a few times larger).
        const cs = (globalThis as { __jitCompileStats?: { count: number; bytes: number } }).__jitCompileStats;
        const mean = cs && cs.count > 0 ? cs.bytes / cs.count : 0;
        jit = { liveModules: live, slots: WASM_TABLE_SIZE - 1,
            compiledModules: cs?.count ?? null, compiledWasmMB: mb(cs?.bytes),
            meanModuleKB: cs ? Math.round(mean / 102.4) / 10 : null, liveWasmEstimateMB: mb(mean * live) };
    }

    const blockCache = (globalThis as { __wgbBlockCache?: { stats?: () => { residentBytes: number; blocks: number } } }).__wgbBlockCache;
    const bc = blockCache?.stats?.();
    const jsCaches = { bundleBlockCacheMB: mb(bc?.residentBytes), bundleBlocks: bc?.blocks ?? null };

    const sab = sharedBufferCensus();
    const gpu = gpuMemoryCensus();
    // Legacy D3D/DDraw geometry rings (grow on demand, see RingBufferManager).
    let ddrawRings: unknown = null;
    try {
        const dd = process?.getModule?.("ddraw") as { context?: { executor?: { ringBufferManager?: { getGeometryRingStats?: () => {
            vertexSizes: number[]; indexSizes: number[]; growths: unknown; retired: number } } } } } | undefined;
        const s = dd?.context?.executor?.ringBufferManager?.getGeometryRingStats?.();
        if (s) ddrawRings = { vertexMB: s.vertexSizes.map(mb), indexMB: s.indexSizes.map(mb), growths: s.growths, retired: s.retired };
    } catch { /* no ddraw executor */ }
    const perfMemory = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;

    // The rough "what we hold" sum: guest pages that may be resident + SABs + JS caches.
    // GPU bytes are reported apart: on iOS they live in the GPU process, not WebContent.
    const estimateMB = mb(dirty.dirtyBytes + sab.bytes + (bc?.residentBytes ?? 0)
        + (perfMemory?.usedJSHeapSize ?? 0));

    return {
        estimateMB,
        wasm,
        guestDirty,
        pageTable,
        allocator,
        sab: { count: sab.count, totalMB: mb(sab.bytes),
            byLabel: Object.fromEntries(Object.entries(sab.byLabel).map(([k, v]) => [k, { count: v.count, mb: mb(v.bytes) }])) },
        gpu: { buffers: gpu.buffers, bufferMB: mb(gpu.bufferBytes), textures: gpu.textures, textureMB: mb(gpu.textureBytes),
            created: { buffers: gpu.createdBuffers, textures: gpu.createdTextures },
            destroyed: { buffers: gpu.destroyedBuffers, textures: gpu.destroyedTextures },
            largeBuffers: gpu.largeBuffers.map((b) => ({ label: b.label, mb: mb(b.bytes), usage: '0x' + b.usage.toString(16) })),
            ddrawRings },
        jsCaches,
        jsHeap: perfMemory ? { usedMB: mb(perfMemory.usedJSHeapSize), totalMB: mb(perfMemory.totalJSHeapSize) } : null,
        jit,
    };
}

export function registerFootprintCommands(svc: HarnessService): void {
    // Arm v86's JIT compile counter for the life of the worker (one add per emitted module).
    // The aot `compileReset` verb restarts it; the census then counts from there.
    const g = globalThis as { __jitCompileStats?: { count: number; bytes: number } };
    g.__jitCompileStats ??= { count: 0, bytes: 0 };
    svc.register("footprint", (args) => collectFootprint((args[0] ?? {}) as { verify?: boolean; repair?: boolean }));
}
