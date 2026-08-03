/**
 * Kernel32 Memory Management functions
 *
 * Atomic implementation for memory operations
 */

import { FastPathImplementation, ThunkImplementation, type X86Context } from '../../core/thunking/thunk-dispatcher';
import type { ThunkMemoryRegions } from '../../core/thunking/thunk-memory-manager';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { type RegionPerms } from '../../core/memory/address-space';
import { Mem } from '../../core/memory/mem-accessor';
import { registerGuestCommitNotifier } from '../../core/memory/guest-page-commit';
import { profiler } from '../../core/profiler';
import { hypercallDataManager } from '../../core/cpu/hypercall-data';
import {
    MEM_HEAP_BASE,
    MEM_THUNK_DATA_BASE,
    MEM_THUNK_DATA_SIZE,
    MEM_ROM_BASE,
    MEM_SURFACE_BASE,
    MEM_SURFACE_SIZE,
    MAX_ALLOC_BYTES,
} from '../../core/cpu/emulator-config';
const HEAP_ZERO_MEMORY_FLAG = 0x00000008;
const HEAP_OOM_ERROR = 8;
const HEAP_FAST_PATH_MAX_ALLOC = 0x20000000;
const DEBUG_FORCE_ZERO_HEAP_FAST_PATH = false;
export const HEAP_SMALL_ALLOC_MAX = 0x1000; // 4KB — the slab fast path covers blocks up to this
const HEAP_ALLOC_GRANULARITY = 16;   // small allocs rounded up (Win32 heap granularity)

const alignSmallAlloc = (size: number): number =>
    (size + (HEAP_ALLOC_GRANULARITY - 1)) & ~(HEAP_ALLOC_GRANULARITY - 1);

// ---------------------------------------------------------------------------
// Heap-handle registry + faithful HeapWalk state.
//
// Third-party heap managers that coexist with the Win32 heap (SmartHeap/Shw32
// in Blade of Darkness) validate a pointer on free() by walking the OS heap:
// GetProcessHeaps() to list heaps, then HeapWalk() per heap to ask "is this a
// raw HeapAlloc block?". When that fails they raise MEM_BAD_POINTER. Reporting
// only the default heap (never HeapCreate'd ones) and enumerating nothing
// rejects every HLE-handed-out HEAP-bucket buffer (Miles audio buffers;
// SmartHeap-delegated large blocks). Report all created heaps and enumerate
// real HEAP-bucket allocations so validation succeeds.
//
// All HEAP-bucket allocations share one underlying allocator regardless of which
// heap handle HeapAlloc was given (the handle is ignored), so every recognized
// heap walks the same snapshot. Fine for validation (membership test, not
// accounting): the pointer is found under whichever heap the manager checks.
// ---------------------------------------------------------------------------
const PROCESS_HEAP_HANDLE_CONST = 0x12345678;
const HEAP_CREATE_HANDLE_BASE = 0x12345679;
const createdHeaps = new Set<number>();
let nextCreatedHeapHandle = HEAP_CREATE_HANDLE_BASE;
let heapManagerOwnerProcess: any = null;

// HeapWalk is stateful: the caller zeroes the entry, calls once to get the first
// block, then feeds the same entry back to advance. We cache a sorted snapshot
// per walk and remember (entry buffer ptr, last index) so a linear walk costs
// O(1) per call instead of re-scanning the live set each time.
interface HeapWalkState {
    entryPtr: number;
    snapshot: Array<{ addr: number; size: number; busy: boolean }>;
    index: number;
}
let heapWalkState: HeapWalkState | null = null;

const ensureHeapManagerProcess = (): void => {
    const currentProcess = System.getInstance().process;
    if (currentProcess === heapManagerOwnerProcess) return;
    heapManagerOwnerProcess = currentProcess;
    createdHeaps.clear();
    nextCreatedHeapHandle = HEAP_CREATE_HANDLE_BASE;
    heapWalkState = null;
};

const isRecognizedHeapHandle = (handle: number): boolean =>
    handle === PROCESS_HEAP_HANDLE_CONST || createdHeaps.has(handle >>> 0);

/**
 * Free a guest heap block — the single non-HeapFree free funnel (LocalFree/GlobalFree/
 * VirtualFree/HeapReAlloc/CRT free). Small blocks now live on the atomic slab freelist
 * (its busy/free header rejects double-frees) and `MemoryManager.free` no-ops on any
 * pointer that isn't a live root allocation, so a double-free — or a free of a slab
 * sub-pointer — is a safe no-op. No JS lookaside / park-state needed (the Gamebryo
 * double-hand-out the old park guarded is now structurally impossible).
 */
export function freeHeapBlock(process: any, ptr: number): boolean {
    const p = ptr >>> 0;
    if (!p) return false;
    process.memory.free(p);
    return true;
}

// ---------------------------------------------------------------------------
// WASM heap arena slab — pre-allocated contiguous memory for fast WASM-side alloc
//
// Growth strategy: geometric (4 MB → 8 MB → 16 MB → 32 MB → 64 MB cap) so games
// with wildly different allocation profiles share one mechanism. Each generation
// replaces the *current* slab in the GUEST-RAM slab control block (inline x86 stub,
// Rust hypercall and JS all read BASE/END/BUMP/FREELIST from there — see
// hypercall-data setSlabControlAddr), so updating those fields repoints the fast path.
//
// Retired slabs are kept in `slabRanges` but are no longer reachable from the
// inline stub's freelist — blocks allocated there stay *live* (guest still holds
// pointers), but frees against them become no-ops in the JS slow path. Total
// leak is bounded: the sum of retired-slab capacities is at most ~the current
// slab size (geometric series), capped hard at HEAP_SLAB_TOTAL_MAX.
//
// Why not a single fixed-size slab? Too-small exhausts quickly (NB — the reason
// we're here); too-large steals guest VA from MapViewOfFile / large textures at
// boot. Geometric growth converges to "just right" within a few steps.
// ---------------------------------------------------------------------------
const HEAP_SLAB_INITIAL_SIZE = 4 * 1024 * 1024;    // 4 MB
const HEAP_SLAB_MAX_SIZE     = 64 * 1024 * 1024;   // 64 MB per slab
const HEAP_SLAB_TOTAL_MAX    = 256 * 1024 * 1024;  // 256 MB total across all generations
const HEAP_SLAB_GROW_HEADROOM = 256 * 1024;        // grow when < 256 KB remaining in active slab
const SLAB_BIN_SIZES = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
const SLAB_MAGIC = 0x534C4100; // BUSY slab block ('SLA'); low nibble = bin

// FREE slab block ('SLF'): the inline free stub flips header byte [ptr-3] 'A'(0x41)→'F'(0x46)
// so any re-free is rejected (faithful busy/free bit — see thunk-memory-manager.ts). Both
// markers carry the same bin nibble, so size/bin are recoverable either way. Header-walkers
// must accept BOTH (a freed block is still a real slab sub-allocation, not end-of-arena).
const SLAB_MAGIC_FREE = 0x534C4600;
/** True if a slab header dword is a valid slab marker (BUSY or FREE). */
const isSlabHeader = (header: number): boolean => {
    const m = header & 0xFFFFFF00;
    return m === SLAB_MAGIC || m === SLAB_MAGIC_FREE;
};
let _dblFreeLogCount = 0; // DIAG: rate-limit [DBLFREE] backtrace logging
let slabRanges: Array<{ base: number; end: number }> = [];
let totalSlabBytes = 0;
let nextSlabSize = HEAP_SLAB_INITIAL_SIZE;
let slabGrowLastAttempt = 0; // performance.now() of last grow attempt (throttle)

// VirtualAlloc roots (base -> size). Same MemoryManager bucket as HeapAlloc, but they
// are NOT heap blocks: HeapSize must return (SIZE_T)-1 and HeapWalk must omit them,
// or third-party heaps (SmartHeap) treat a VirtualAlloc pool as HeapAlloc memory,
// HeapFree the pool base, and reuse sub-allocations still held by the CRT (_piob UAF).
const virtualAllocRegions: Map<number, number> = new Map();

function isVirtualAllocBase(ptr: number): boolean {
    return virtualAllocRegions.has(ptr >>> 0);
}

function isInVirtualAllocRegion(ptr: number): boolean {
    const p = ptr >>> 0;
    if (virtualAllocRegions.has(p)) return true;
    for (const [base, size] of virtualAllocRegions) {
        if (p >= base && p < base + size) return true;
    }
    return false;
}

/** Low-level: allocate one slab of `size` bytes and install it as the active one. */
function installNewSlab(size: number): boolean {
    const process = System.getInstance().process;
    if (!process) return false;
    if (totalSlabBytes + size > HEAP_SLAB_TOTAL_MAX) {
        Logger.warn(LogCategory.KERNEL32,
            `Heap slab grow refused: would exceed total cap ${HEAP_SLAB_TOTAL_MAX / 1024 / 1024}MB ` +
            `(current=${totalSlabBytes / 1024 / 1024}MB, requested=+${size / 1024 / 1024}MB)`);
        return false;
    }
    let addr: number;
    try {
        // Top-down placement (grows down from the HEAP limit) so guest addresses stay
        // identical to the no-slab layout and don't displace large MapViewOfFile/textures.
        addr = process.memory.allocSlabArena(size);
    } catch (e) {
        Logger.warn(LogCategory.KERNEL32, `Heap slab alloc failed (size=${size}): ${e}`);
        return false;
    }
    if (!addr) return false;
    const end = addr + size;
    slabRanges.push({ base: addr, end });
    totalSlabBytes += size;
    const mem = process.getCurrentMemory();
    mem.fill(0, addr, end);
    hypercallDataManager.initializeHeapSlab(addr, end);
    Logger.log(LogCategory.KERNEL32,
        `Heap slab gen${slabRanges.length}: 0x${addr.toString(16)}-0x${end.toString(16)} ` +
        `(${size / 1024}KB, total=${totalSlabBytes / 1024 / 1024}MB, ${slabRanges.length} generations live)`);
    return true;
}

/** Initial slab allocation — called lazily by tick hook after boot pressure subsides. */
export function allocateHeapSlab(): void {
    if (slabRanges.length > 0) return; // already initialized
    if (installNewSlab(nextSlabSize)) {
        nextSlabSize = Math.min(nextSlabSize * 2, HEAP_SLAB_MAX_SIZE);
    }
}

/**
 * Grow slab if the active generation is running low. Called from the JS HeapAlloc
 * slow path — by the time we reach JS for a sub-4KB non-zero-flag alloc, it means
 * the inline stub's bump pointer overran SLAB_END, so the whole arena is full.
 *
 * Retired slabs are NOT reclaimed; their live pointers remain valid in guest memory.
 * Frees against retired-slab pointers become no-ops (see HeapFree below).
 */
export function maybeGrowHeapSlab(): void {
    if (slabRanges.length === 0) {
        // First slab hasn't been lazily allocated yet (<500 ticks). Force it now
        // so subsequent calls hit the inline stub instead of JS.
        allocateHeapSlab();
        return;
    }
    if (totalSlabBytes >= HEAP_SLAB_TOTAL_MAX) return;

    const stats = hypercallDataManager.getSlabStats();
    if (stats.capacity === 0) return;
    const remaining = stats.capacity - stats.used;
    if (remaining > HEAP_SLAB_GROW_HEADROOM) return;

    // Throttle: don't re-attempt grow on every slow-path call within a short window
    // (e.g., when TOTAL_MAX is reached — we don't want to spam process.memory.alloc).
    const now = performance.now();
    if (now - slabGrowLastAttempt < 250) return;
    slabGrowLastAttempt = now;

    if (installNewSlab(nextSlabSize)) {
        nextSlabSize = Math.min(nextSlabSize * 2, HEAP_SLAB_MAX_SIZE);
    }
}

/** True iff `ptr` lies within any live slab generation (current or retired). */
function isInAnySlab(ptr: number): boolean {
    for (const r of slabRanges) {
        if (ptr >= r.base && ptr < r.end) return true;
    }
    return false;
}

// Slab block layout — authoritative, from vendor/v86/src/rust/cpu/hypercall.rs
// handle_heap_alloc: a block is [16-byte header zone][size_class data]; the user
// pointer is blockStart+16, the magic header (SLAB_MAGIC|bin) sits at user-4
// (= blockStart+12), and the bump advances by 16+size_class. handle_heap_free
// links the per-bin free list through the freed block's first DATA word (at the
// user pointer). The inline free stub flips the header's busy/free byte
// ('A'->'F') but keeps the bin nibble, so a linear header walk (via isSlabHeader,
// which accepts BUSY and FREE) still traverses every block with no chain breaks.
const SLAB_HEADER_ZONE = 16;

interface HeapBlock { addr: number; size: number; busy: boolean; }

/** Gather currently-free slab user-pointers by following the 9 per-bin free
 *  lists (each linked through the freed block's first data word). */
function collectSlabFreeSet(view: DataView): Set<number> {
    const free = new Set<number>();
    const heads = hypercallDataManager.getSlabFreelistHeads();
    for (const head of heads) {
        let p = head >>> 0;
        // Cycle/bound guard: the free list can't be longer than the arena has blocks.
        for (let guard = 0; p !== 0 && guard < (1 << 21); guard++) {
            if (free.has(p) || p + 4 > view.byteLength) break;
            free.add(p);
            p = view.getUint32(p, true) >>> 0; // next link lives in the freed block's data
        }
    }
    return free;
}

/**
 * Build the faithful per-block view of our HEAP that a third-party heap walker
 * (SmartHeap/Shw32) expects from HeapWalk:
 *   1. Every live slab sub-allocation as its own PROCESS_HEAP_ENTRY (busy/free
 *      flagged from the free lists). Without this, slab blocks are interior
 *      pointers invisible to a walker that only sees the one big arena root, and
 *      SmartHeap's exact-base-match free validation raises MEM_BAD_POINTER (BoD).
 *   2. Standalone HEAP allocations (Miles buffers, large/delegated blocks, COM,
 *      etc.), excluding the slab arena roots themselves (covered by #1).
 */
function buildHeapWalkSnapshot(view: DataView): HeapBlock[] {
    const out: HeapBlock[] = [];
    const process = System.getInstance().process;
    if (!process) return out;

    // 1) Slab sub-allocations — walk each generation by the allocator's own layout.
    const freeSet = collectSlabFreeSet(view);
    const activeUsed = hypercallDataManager.getSlabStats().used >>> 0;
    for (let gi = 0; gi < slabRanges.length; gi++) {
        const r = slabRanges[gi];
        const isActive = gi === slabRanges.length - 1;
        // Active generation is filled up to bump (base+used); retired ones are full.
        const limit = isActive ? r.base + activeUsed : r.end;
        let cursor = r.base;
        while (cursor + SLAB_HEADER_ZONE <= limit) {
            const header = view.getUint32(cursor + 12, true) >>> 0;
            if (!isSlabHeader(header)) break; // contiguous arena → bad header (busy/free) = end
            const bin = header & 0x0F;
            if (bin > 8) break;
            const size = SLAB_BIN_SIZES[bin];
            const user = cursor + SLAB_HEADER_ZONE;
            out.push({ addr: user, size, busy: !freeSet.has(user) });
            cursor = user + size;
        }
    }

    // 2) Standalone HEAP allocations (newest-first), minus the slab arena roots
    //    and VirtualAlloc regions (those are not HeapAlloc blocks — see virtualAllocRegions).
    const standalone = process.memory.snapshotHeapAllocations();
    for (const b of standalone) {
        if (isVirtualAllocBase(b.addr)) continue;
        if (!isInAnySlab(b.addr)) out.push({ addr: b.addr, size: b.size, busy: true });
    }
    return out;
}

/** Reset slab state on process cleanup. */
export function resetHeapSlab(): void {
    slabRanges = [];
    totalSlabBytes = 0;
    nextSlabSize = HEAP_SLAB_INITIAL_SIZE;
    slabGrowLastAttempt = 0;
    virtualAllocRegions.clear();
    hypercallDataManager.resetHeapSlab();
    createdHeaps.clear();
    nextCreatedHeapHandle = HEAP_CREATE_HANDLE_BASE;
    heapWalkState = null;
    heapManagerOwnerProcess = null;
}

/**
 * DevTools diagnostic: dump slab-arena stats. Call from the worker console as
 * `getSlabReport()`. Shows active bump, bin free-list occupancy, fallback-to-JS
 * count (Rust hypercall's view), and the per-generation retired-slab history.
 * Useful when chasing "why is HeapAlloc hitting JS so often?" questions — a
 * healthy session keeps fallback near zero and lives in gen 1 or 2.
 */
/**
 * DevTools diagnostic: dump per-bucket address-space stats. Useful to debug
 * "SURFACE bucket overflow" crashes — compares used/free for HEAP, SURFACE,
 * THUNK_CODE, etc. and counts free-list blocks (nonzero = frees happening).
 */
(globalThis as any).getHighHeapReport = () => {
    const process = System.getInstance().process;
    return process?.memory?.getHighHeapReport?.() ?? null;
};

(globalThis as any).getMemReport = () => {
    const process = System.getInstance().process;
    if (!process) return null;
    const stats = (process.memory as any).getBucketStats?.() as any[] | undefined;
    if (!stats) return null;
    return stats.map(s => {
        const total = s.limit - s.base;
        return {
            kind: s.kind,
            range: `0x${s.base.toString(16)}..0x${s.limit.toString(16)}`,
            bumpMB: +(s.used / 1024 / 1024).toFixed(2),
            liveMB: +(s.liveUsed / 1024 / 1024).toFixed(2),
            fragMB: +((s.used - s.liveUsed) / 1024 / 1024).toFixed(2),
            freeMB: +(s.free / 1024 / 1024).toFixed(2),
            freeBlocks: s.freeBlocks,
            freePct: +(100 * s.free / total).toFixed(1),
        };
    });
};


/**
 * DevTools diagnostic: audit the 9 per-bin slab free-lists for corruption.
 * Call from the worker console as `slabFreelistAudit()`.
 *
 * The slab free-list is INTRUSIVE (a freed block's first user word = next free
 * pointer; see handle_heap_free in hypercall.rs) and UNGUARDED — there is no
 * per-block FREE bit, so a double-free (or an app UAF write into a still-free
 * block's word0) silently poisons the list. The classic failure is a double-free
 * of the current head H: `write32(H, old_head=H)` makes `H.next == H` (a 1-cycle),
 * after which every alloc of that bin returns H forever, and once H's owner writes
 * its word0 (e.g. a list node's `next = some LIVE node`) the free list inherits a
 * pointer to a LIVE allocation → that live block gets handed out again → corruption
 * of a still-live object (NFSU audio callback-list crash, 2026-06-22).
 *
 * This walks each bin's chain and flags the independent corruption signatures
 * (no busy-set needed — they're all header/topology based):
 *   - selfPtr  : a node whose next == itself (the double-free 1-cycle). ★primary
 *   - cycle    : the chain revisits a node (corrupted/double-freed).
 *   - badHeader: a free-list node whose [addr-4] header lacks SLAB_MAGIC, or whose
 *                embedded bin != the list's bin → the list points at non-free /
 *                wrong-bin memory (poisoned with a live-object pointer).
 *   - oob      : next points outside [slab_base, slab_end) of every generation.
 * `ok:true` means all 9 lists are clean acyclic NULL-terminated chains.
 */
(globalThis as any).slabFreelistAudit = () => {
    const process = System.getInstance().process;
    if (!process) return null;
    const mem = process.getCurrentMemory();
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const heads = hypercallDataManager.getSlabFreelistHeads();
    const hx = (v: number) => "0x" + (v >>> 0).toString(16);
    const inSlab = (p: number) => slabRanges.some(r => p >= r.base && p < r.end);

    const bins = heads.map((rawHead, bin) => {
        const head = rawHead >>> 0;
        const seen = new Set<number>();
        const chain: Array<{ addr: string; next: string; hdrBin: number; badHeader: boolean; oob: boolean; self: boolean }> = [];
        let p = head, cycle = false, selfPtr = false, badHeader = 0, oob = 0;
        for (let guard = 0; p !== 0 && guard < (1 << 20); guard++) {
            if (seen.has(p)) { cycle = true; break; }
            seen.add(p);
            const header = p >= 4 ? (view.getUint32(p - 4, true) >>> 0) : 0;
            const validMagic = isSlabHeader(header);
            const hdrBin = header & 0x0F;
            const bad = !validMagic || hdrBin !== bin;
            if (bad) badHeader++;
            const next = p + 4 <= mem.length ? (view.getUint32(p, true) >>> 0) : 0;
            const self = next === p;
            if (self) selfPtr = true;
            const outOfBounds = next !== 0 && !inSlab(next);
            if (outOfBounds) oob++;
            if (chain.length < 16) chain.push({ addr: hx(p), next: hx(next), hdrBin, badHeader: bad, oob: outOfBounds, self });
            if (self || outOfBounds) break;
            p = next;
        }
        return { bin, size: SLAB_BIN_SIZES[bin], head: hx(head), len: seen.size, cycle, selfPtr, badHeader, oob, chain };
    }).filter(b => b.head !== "0x0" || b.len > 0);

    const corrupt = bins.filter(b => b.cycle || b.selfPtr || b.badHeader > 0 || b.oob > 0);
    return { ok: corrupt.length === 0, corruptBins: corrupt.map(b => b.bin), bins };
};

/** Classify a guest heap pointer: slab membership, header magic (BUSY/FREE), bin
 *  size, and whether it's a JS-tracked standalone allocation. Used by the #DE
 *  diagnostic to tell "slab block double-handed-out" from "non-slab / D2-internal
 *  use-after-free of a Fog descriptor". */
(globalThis as any).classifyHeapPtr = (addr: number) => {
    const p = addr >>> 0;
    const process = System.getInstance().process;
    if (!process) return { addr: "0x" + p.toString(16), err: "no-process" };
    const mem = process.getCurrentMemory();
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const inSlab = slabRanges.some(r => p >= r.base && p < r.end);
    const header = p >= 4 ? (view.getUint32(p - 4, true) >>> 0) : 0;
    const hi = header & 0xFFFFFF00;
    const isBusy = hi === SLAB_MAGIC;
    const isFree = hi === SLAB_MAGIC_FREE;
    let trackedSize: number | undefined;
    try {
        const allocs = process.memory.snapshotHeapAllocations?.() ?? [];
        const hit = allocs.find((a: any) => a.addr === p);
        if (hit) trackedSize = hit.size;
    } catch { /* best-effort */ }
    return {
        addr: "0x" + p.toString(16),
        inSlab,
        header: "0x" + header.toString(16),
        slabState: isBusy ? "BUSY" : isFree ? "FREE" : "non-slab-header",
        bin: (isBusy || isFree) ? (header & 0x0F) : undefined,
        slabSize: (isBusy || isFree) && (header & 0x0F) <= 8 ? SLAB_BIN_SIZES[header & 0x0F] : undefined,
        trackedLargeAlloc: trackedSize !== undefined ? trackedSize : false,
    };
};

/** Full lifecycle history of large (≥64KB) blocks near an address — the alloc/free
 *  SEQUENCE + per-event caller backtrace. Disambiguates UAF-reuse (alloc→free→alloc)
 *  from double-hand-out (alloc→alloc, no free) from corruption (one allocator only),
 *  for the D2 Fog-descriptor / Storm-MPQ overlap. */
(globalThis as any).largeAllocHistory = (addr: number, radius?: number) => {
    const process = System.getInstance().process;
    if (!process) return null;
    return process.memory.getLargeAllocHistory?.(addr >>> 0, radius ?? 0x20000) ?? null;
};

export function slabReport() {
    const live = hypercallDataManager.getSlabStats();
    return {
        current: {
            allocs: live.allocs,
            frees: live.frees,
            fallbacks: live.fallbacks,
            used: live.used,
            capacity: live.capacity,
            freePct: live.capacity ? +(100 * (live.capacity - live.used) / live.capacity).toFixed(1) : 0,
        },
        generations: slabRanges.map((r, i) => ({
            gen: i + 1,
            active: i === slabRanges.length - 1,
            base: `0x${r.base.toString(16)}`,
            end: `0x${r.end.toString(16)}`,
            sizeKB: (r.end - r.base) / 1024,
        })),
        totalBytes: totalSlabBytes,
        totalMB: +(totalSlabBytes / 1024 / 1024).toFixed(2),
        totalCap: HEAP_SLAB_TOTAL_MAX,
        nextSlabSizeKB: nextSlabSize / 1024,
    };
}

(globalThis as any).getSlabReport = slabReport;

/** If ptr is within a slab, return its size class. Used by HeapSize/HeapReAlloc. */
export function getSlabSizeForPtr(ptr: number): number | undefined {
    for (const range of slabRanges) {
        if (ptr >= range.base + 16 && ptr < range.end) {
            const mem = System.getInstance().process?.getCurrentMemory();
            if (!mem) return undefined;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const header = view.getUint32(ptr - 4, true) >>> 0;
            // Accept ONLY BUSY (0x534C41xx). A FREE-marked block (0x534C46xx) is currently
            // on a per-bin free list — NOT a live allocation: every alloc-pop path (WASM
            // handle_heap_alloc, inline writeHeapSlabStubs / writeCrtSlabStubs) re-stamps BUSY,
            // so no live block ever carries the FREE marker. Reporting a free-listed block as a
            // sized, live allocation made HeapSize/HeapReAlloc-in-place/realloc/_msize hand the
            // SAME free-listed block back to its old owner while the next malloc popped it for a
            // new owner → two owners, one block (D2: a Storm MPQ handle stomped the Fog region
            // table → elemSize=0 → 0/0 #DE). isSlabHeader (BUSY|FREE) stays correct for the
            // linear header-WALK consumers (buildHeapWalkEntries / analyzeSlabFreelist), which
            // legitimately traverse free blocks.
            if ((header & 0xFFFFFF00) !== SLAB_MAGIC) return undefined;
            const bin = header & 0x0F;
            if (bin > 8) return undefined;
            return SLAB_BIN_SIZES[bin];
        }
    }
    return undefined;
}

const formatCallSite = (
    ctx: any,
    mem: Uint8Array,
    stackWords = 4,
    extraOffsets: number[] = [],
    searchValues: number[] = [],
    codeWindowBefore = 32,
    codeWindowAfter = 8
): string => {
    const eip = ctx?.eip ?? 0;
    const esp = ctx?.esp ?? 0;
    let ret = 0;
    let stack = "";
    let bytes = "";
    let retOff = "";
    let extra = "";
    if (esp >= 0 && esp + 16 <= mem.length) {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        ret = view.getUint32(esp, true);
        const words: string[] = [];
        const maxWords = Math.min(stackWords, Math.floor((mem.length - (esp + 4)) / 4));
        for (let i = 0; i < maxWords; i++) {
            words.push(`0x${view.getUint32(esp + 4 + i * 4, true).toString(16)}`);
        }
        stack = ` STK=[${words.join(", ")}]`;
        if (extraOffsets.length > 0) {
            const extras: string[] = [];
            for (const offset of extraOffsets) {
                if (offset >= 0 && esp + offset + 4 <= mem.length) {
                    extras.push(`esp+0x${offset.toString(16)}=0x${view.getUint32(esp + offset, true).toString(16)}`);
                }
            }
            if (extras.length > 0) {
                extra = ` EXTRA=[${extras.join(", ")}]`;
            }
        }
        if (searchValues.length > 0) {
            const hits: string[] = [];
            const maxSearch = Math.min(64, Math.floor((mem.length - esp) / 4));
            for (let i = 0; i < maxSearch; i++) {
                const value = view.getUint32(esp + i * 4, true);
                for (const target of searchValues) {
                    if ((value >>> 0) === (target >>> 0)) {
                        hits.push(`0x${target.toString(16)}@+0x${(i * 4).toString(16)}`);
                    }
                }
            }
            if (hits.length > 0) {
                extra += `${extra ? " " : ""}FIND=[${hits.join(", ")}]`;
            }
        }
    }
    if (ret >= 0 && ret + codeWindowAfter <= mem.length) {
        const start = ret >= codeWindowBefore ? ret - codeWindowBefore : 0;
        const end = Math.min(mem.length, ret + codeWindowAfter);
        const slice = mem.slice(start, end);
        bytes = Array.from(slice).map((b) => b.toString(16).padStart(2, "0")).join(" ");
        bytes = ` CODE=[${bytes}]`;
    }
    if (ret >= 0x400000) {
        retOff = ` RET_OFF=0x${(ret - 0x400000).toString(16)}`;
    }
    return `EIP=0x${eip.toString(16)} ESP=0x${esp.toString(16)} RET=0x${ret.toString(16)}${retOff}${stack}${extra}${bytes}`;
};

const scanMemoryForValue = (mem: Uint8Array, target: number): string[] => {
    const hits: string[] = [];
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const step = 4;
    // Scan with step 1 to find unaligned values if needed, but usually counts are aligned
    for (let i = 0; i < mem.length - 4; i += step) {
        if (view.getUint32(i, true) === target) {
            hits.push(`0x${i.toString(16)}`);
        }
    }
    return hits;
};

// ---------------------------------------------------------------------------
// Reusable heap-watch — diagnose allocator type-confusion (e.g. unreal-gold's
// MSVC CRT _aligned_realloc storing its base pointer at [ptr-4], then a recycled
// base region breaking that header). OFF by default. Enable from the worker:
//   globalThis.__heapWatch = { lo: 0x26adc00, hi: 0x26ade00 }
// Every HeapAlloc / HeapReAlloc / HeapFree whose pointer (old or new) lands in
// [lo,hi) logs the op, the pointers, the caller RET (distinguishes the CRT's
// aligned vs plain realloc paths), and the 8 bytes at ptr-4 (the would-be
// aligned-malloc base slot). Costs nothing when __heapWatch is unset.
// ---------------------------------------------------------------------------
const heapWatch = (op: string, ctx: any, mem: Uint8Array, ptrs: number[], extra = ''): void => {
    const w = (globalThis as any).__heapWatch;
    if (!w) return;
    const lo = w.lo >>> 0;
    const hi = w.hi >>> 0;
    if (!ptrs.some((p) => (p >>> 0) >= lo && (p >>> 0) < hi)) return;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const esp = ctx?.esp >>> 0;
    const ret = esp && esp + 4 <= mem.length ? view.getUint32(esp, true) >>> 0 : 0;
    const slots = ptrs
        .map((p) => {
            const a = (p >>> 0) - 4;
            if (a >= 0 && a + 8 <= mem.length) {
                return `[0x${p.toString(16)}-4]=0x${view.getUint32(a, true).toString(16)} [0x${p.toString(16)}]=0x${view.getUint32(p, true).toString(16)}`;
            }
            return `0x${p.toString(16)}=?`;
        })
        .join(' ');
    Logger.warn(LogCategory.KERNEL32,
        `[HEAPWATCH] ${op} ${ptrs.map((p) => '0x' + (p >>> 0).toString(16)).join('->')} ${extra} RET=0x${ret.toString(16)} ${slots}`);
};

export const exports: Record<string, ThunkImplementation> = (() => {
    const exports: Record<string, ThunkImplementation> = {};

    // Track reserved pages (address -> size in bytes)
    const reservedPages: Map<number, number> = new Map();

    // virtualAllocRegions is module-scoped (shared with HeapWalk/HeapSize).

    // Track decommitted page ranges within reserved regions.
    // Key = page-aligned address, Value = size in bytes.
    // Storm.dll SBH allocator depends on decommit/recommit cycle:
    //   1. VirtualAlloc(MEM_RESERVE) — reserve 64KB block
    //   2. VirtualAlloc(MEM_COMMIT) — commit pages on demand (zeroed)
    //   3. VirtualFree(MEM_DECOMMIT) — decommit freed pages
    //   4. VirtualAlloc(MEM_COMMIT) — recommit = re-zero pages
    // Without tracking, decommit is a no-op and recommit skips zeroing,
    // leaving stale heap metadata that causes heap corruption.
    const decommittedPages: Map<number, number> = new Map();

    // Remove a committed range from decommittedPages, handling partial overlaps.
    // Storm often decommits a multi-page range then recommits individual pages.
    // Without splitting, stale entries cause VirtualQuery to report MEM_RESERVE
    // for pages that are actually committed.
    function clearDecommittedRange(commitBase: number, commitSize: number): void {
        const commitEnd = commitBase + commitSize;
        const toDelete: number[] = [];
        const toAdd: Array<[number, number]> = [];

        for (const [dcBase, dcSize] of decommittedPages) {
            const dcEnd = dcBase + dcSize;

            // No overlap — skip
            if (dcEnd <= commitBase || dcBase >= commitEnd) continue;

            // This entry overlaps the commit range — remove it
            toDelete.push(dcBase);

            // Re-add the non-overlapping parts (split)
            // Left remainder: [dcBase, commitBase)
            if (dcBase < commitBase) {
                toAdd.push([dcBase, commitBase - dcBase]);
            }
            // Right remainder: [commitEnd, dcEnd)
            if (dcEnd > commitEnd) {
                toAdd.push([commitEnd, dcEnd - commitEnd]);
            }
        }

        for (const key of toDelete) decommittedPages.delete(key);
        for (const [base, size] of toAdd) decommittedPages.set(base, size);
    }

    registerGuestCommitNotifier(clearDecommittedRange);

    /**
     * MEM_COMMIT over a range that may already be committed. Win32: "if the memory is
     * already committed, the function does not change its contents" — only pages that
     * were never committed (or were decommitted) come back zeroed. Blanket-zeroing here
     * destroys live data for the very common allocator shape that re-commits its whole
     * arena from the base on every bump (Quake II's Hunk_Alloc: each allocation wipes
     * everything loaded before it), while the decommit→recommit cycle storm.dll's SBH
     * depends on still re-zeroes.
     */
    function commitPreservingCommitted(base: number, size: number): void {
        const proc = System.getInstance().process;
        if (!proc) return;
        const ptm = proc.pageTableManager;
        if (ptm?.isPagingEnabled()) {
            ptm.ensurePagesCommitted(base, size);   // zeroes only non-present pages
            return;
        }
        // No page tables to consult: the decommit map is the only record of which pages
        // lost their contents. Reserved-but-never-committed memory is already zero (the
        // allocator hands out zeroed blocks), so zeroing the rest would only destroy data.
        const end = base + size;
        for (const [dcBase, dcSize] of decommittedPages) {
            const from = Math.max(base, dcBase);
            const to = Math.min(end, dcBase + dcSize);
            if (from < to) proc.addressSpace.fill(from, to - from, 0);
        }
    }

    function findTrackedAllocRange(address: number, size: number): [number, number] | null {
        const end = address + size;
        for (const [base, regionSize] of virtualAllocRegions) {
            if (address >= base && end <= base + regionSize) {
                return [base, regionSize];
            }
        }
        return null;
    }

    // Process heap handle constant (returned by GetProcessHeap)
    const PROCESS_HEAP_HANDLE = 0x12345678;
    const CURRENT_PROCESS = 0xFFFFFFFF;
    const ERROR_INVALID_PARAMETER = 87;
    const ERROR_INVALID_HANDLE = 6;
    const ERROR_INVALID_ADDRESS = 487;
    const THUNK_GENERATOR_REGION_SIZE = 1024 * 1024;
    const PAGE_NOACCESS = 0x01;
    const PAGE_READONLY = 0x02;
    const PAGE_READWRITE = 0x04;
    const PAGE_WRITECOPY = 0x08;
    const PAGE_EXECUTE = 0x10;
    const PAGE_EXECUTE_READ = 0x20;
    const PAGE_EXECUTE_READWRITE = 0x40;
    const PAGE_EXECUTE_WRITECOPY = 0x80;

    // Debug: Force ZeroMemory for all heap allocations (diagnostic override; the faithful
    // fresh-page zeroing now lives in MemoryManager.allocateInBucket).
    const DEBUG_FORCE_ZERO_HEAP = false;

    // Win32 moveable local/global memory (Wine kernelbase mem_entry model).
    // LMEM_MOVEABLE / GMEM_MOVEABLE return handle = &mem_entry.ptr (desc+4 on 32-bit);
    // LocalLock/GlobalLock dereference to the data pointer and bump the lock count.
    const LMEM_MOVEABLE = 0x0002;
    const LMEM_ZEROINIT = 0x0040;
    const MEM_FLAG_USED = 0x0001;
    const MEM_FLAG_MOVEABLE = 0x0002;
    const MEM_FLAG_DISCARDABLE = 0x0004;
    const MEM_FLAG_DISCARDED = 0x0008;
    const MEM_ENTRY_SIZE = 8;
    const MOVEABLE_HANDLE_TAG = 4; // (sizeof(void*) on 32-bit) — low 3 bits of handle
    const ERROR_NOT_LOCKED = 190;
    const ERROR_DISCARDED = 166;

    let moveableOwnerProcess: typeof System.prototype.process | null = null;
    /** User-requested payload size keyed by moveable handle (desc+4). */
    const moveableDataSize = new Map<number, number>();
    /** Data pointer → moveable handle for GlobalHandle reverse lookup. */
    const dataPtrToMoveableHandle = new Map<number, number>();
    /** Fixed handles returned from LocalAlloc/GlobalAlloc (GMEM_FIXED / LMEM_FIXED). */
    const fixedLocalHandles = new Set<number>();
    /** User-requested size for fixed local/global blocks (may be < alloc capacity). */
    const fixedLocalUserSizes = new Map<number, number>();

    const resetMoveableTables = (): void => {
        const currentProcess = System.getInstance().process;
        if (currentProcess === moveableOwnerProcess) return;
        moveableOwnerProcess = currentProcess;
        moveableDataSize.clear();
        dataPtrToMoveableHandle.clear();
        fixedLocalHandles.clear();
        fixedLocalUserSizes.clear();
    };

    const isRegisteredMoveableHandle = (
        handle: number,
        process: NonNullable<typeof System.prototype.process>,
    ): boolean => {
        if (moveableDataSize.has(handle)) return true;
        if (!handle || (handle & 7) !== MOVEABLE_HANDLE_TAG) return false;
        const desc = moveableDescFromHandle(handle);
        if (process.memory.getSize(desc) !== MEM_ENTRY_SIZE) return false;
        const flags = Mem.readUint16(desc) ?? 0;
        return (flags & (MEM_FLAG_USED | MEM_FLAG_MOVEABLE)) === (MEM_FLAG_USED | MEM_FLAG_MOVEABLE);
    };

    const ensureMoveableRegistered = (
        handle: number,
        process: NonNullable<typeof System.prototype.process>,
    ): boolean => {
        if (!isRegisteredMoveableHandle(handle, process)) return false;
        if (!moveableDataSize.has(handle)) {
            const dataPtr = Mem.readUint32(handle) ?? 0;
            const size = dataPtr ? (process.memory.getSize(dataPtr) ?? 0) : 0;
            moveableDataSize.set(handle, size);
            if (dataPtr) dataPtrToMoveableHandle.set(dataPtr, handle);
        }
        return true;
    };

    const isMoveableHandle = (handle: number): boolean => {
        const process = System.getInstance().process;
        if (!process || !handle) return false;
        return isRegisteredMoveableHandle(handle, process);
    };

    const moveableDescFromHandle = (handle: number): number => handle - 4;

    const getFixedBlockCapacity = (
        process: NonNullable<typeof System.prototype.process>,
        ptr: number,
    ): number | undefined => {
        const slabSize = getSlabSizeForPtr(ptr);
        if (slabSize !== undefined) return slabSize;
        return process.memory.getSize(ptr);
    };

    const isFixedHeapPointer = (process: NonNullable<typeof System.prototype.process>, ptr: number): boolean =>
        fixedLocalHandles.has(ptr);

    const registerFixedLocalHandle = (ptr: number, userBytes: number): void => {
        fixedLocalHandles.add(ptr);
        fixedLocalUserSizes.set(ptr, userBytes);
    };

    const unregisterFixedLocalHandle = (ptr: number): void => {
        fixedLocalHandles.delete(ptr);
        fixedLocalUserSizes.delete(ptr);
    };

    const allocMoveableBlock = (
        process: NonNullable<typeof System.prototype.process>,
        mem: Uint8Array,
        uBytes: number,
        zeroInit: boolean,
    ): number => {
        const desc = process.memory.alloc(MEM_ENTRY_SIZE);
        let dataPtr = 0;
        if (uBytes > 0) {
            dataPtr = process.memory.alloc(uBytes);
            if (zeroInit || DEBUG_FORCE_ZERO_HEAP) {
                mem.fill(0, dataPtr, dataPtr + uBytes);
            }
        }
        Mem.writeUint16(desc, MEM_FLAG_USED | MEM_FLAG_MOVEABLE | (uBytes === 0 ? MEM_FLAG_DISCARDED : 0));
        Mem.writeUint8(desc + 2, 0);
        Mem.writeUint32(desc + 4, dataPtr);
        const handle = desc + 4;
        if (uBytes > 0) {
            moveableDataSize.set(handle, uBytes);
            if (dataPtr) dataPtrToMoveableHandle.set(dataPtr, handle);
        }
        return handle;
    };

    const freeMoveableBlock = (process: NonNullable<typeof System.prototype.process>, handle: number): void => {
        const desc = moveableDescFromHandle(handle);
        const dataPtr = Mem.readUint32(handle) ?? 0;
        moveableDataSize.delete(handle);
        if (dataPtr) dataPtrToMoveableHandle.delete(dataPtr);
        if (dataPtr && !isInAnySlab(dataPtr)) {
            freeHeapBlock(process, dataPtr);
        }
        freeHeapBlock(process, desc);
    };

    const lockMoveableOrFixed = (hMem: number, mem: Uint8Array): number => {
        const system = System.getInstance();
        const process = system.process;
        if (!process || !hMem) {
            if (!hMem) system.scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }
        resetMoveableTables();

        if (ensureMoveableRegistered(hMem, process)) {
            const desc = moveableDescFromHandle(hMem);
            const flags = Mem.readUint16(desc) ?? 0;
            if (!(flags & MEM_FLAG_USED)) {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return 0;
            }

            const dataPtr = Mem.readUint32(hMem) ?? 0;
            if (!dataPtr) {
                system.scheduler.setLastError(ERROR_DISCARDED);
                return 0;
            }

            const lock = Mem.readUint8(desc + 2) ?? 0;
            if (lock === 255) {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return 0;
            }
            Mem.writeUint8(desc + 2, lock + 1);
            return dataPtr;
        }

        if (fixedLocalHandles.has(hMem)) {
            return hMem;
        }

        Logger.warn(LogCategory.KERNEL32,
            `GlobalLock/LocalLock: invalid handle 0x${hMem.toString(16)} (not a local/global allocation)`);
        system.scheduler.setLastError(ERROR_INVALID_HANDLE);
        return 0;
    };

    const unlockMoveableOrFixed = (hMem: number): number => {
        const system = System.getInstance();
        const process = system.process;
        if (!process || !hMem) {
            system.scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }
        resetMoveableTables();

        if (fixedLocalHandles.has(hMem)) {
            // Fixed blocks: GlobalUnlock/LocalUnlock are no-ops that succeed (Win32).
            return 1;
        }

        if (!ensureMoveableRegistered(hMem, process)) {
            system.scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }

        const desc = moveableDescFromHandle(hMem);
        if (process.memory.getSize(desc) !== MEM_ENTRY_SIZE) {
            system.scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }

        const lock = Mem.readUint8(desc + 2) ?? 0;
        if (!lock) {
            system.scheduler.setLastError(ERROR_NOT_LOCKED);
            return 0;
        }

        const remaining = lock - 1;
        Mem.writeUint8(desc + 2, remaining);
        return remaining > 0 ? 1 : 0;
    };

    const sizeOfGlobalOrLocal = (hMem: number): number => {
        const process = System.getInstance().process;
        if (!process || !hMem) return 0;
        resetMoveableTables();

        if (isMoveableHandle(hMem)) {
            return moveableDataSize.get(hMem) ?? 0;
        }

        if (fixedLocalHandles.has(hMem)) {
            return fixedLocalUserSizes.get(hMem) ?? getFixedBlockCapacity(process, hMem) ?? 0;
        }

        return 0;
    };

    const reallocMoveableBlock = (
        process: NonNullable<typeof System.prototype.process>,
        mem: Uint8Array,
        handle: number,
        newBytes: number,
        zeroInit: boolean,
    ): number => {
        const desc = moveableDescFromHandle(handle);
        const oldDataPtr = Mem.readUint32(handle) ?? 0;
        const oldSize = moveableDataSize.get(handle) ?? 0;

        let newDataPtr = 0;
        if (newBytes > 0) {
            try {
                newDataPtr = process.memory.alloc(newBytes);
            } catch {
                return 0;
            }
        }

        const copySize = Math.min(oldSize, newBytes);
        if (oldDataPtr && newDataPtr && copySize > 0) {
            mem.copyWithin(newDataPtr, oldDataPtr, oldDataPtr + copySize);
        }
        if (zeroInit && newDataPtr && newBytes > copySize) {
            mem.fill(0, newDataPtr + copySize, newDataPtr + newBytes);
        }

        if (oldDataPtr) {
            dataPtrToMoveableHandle.delete(oldDataPtr);
            if (!isInAnySlab(oldDataPtr)) {
                freeHeapBlock(process, oldDataPtr);
            }
        }

        const flags = Mem.readUint16(desc) ?? 0;
        Mem.writeUint16(desc, (flags & ~MEM_FLAG_DISCARDED) | MEM_FLAG_USED | MEM_FLAG_MOVEABLE);
        Mem.writeUint32(handle, newDataPtr);
        if (newBytes > 0) {
            moveableDataSize.set(handle, newBytes);
            if (newDataPtr) dataPtrToMoveableHandle.set(newDataPtr, handle);
        } else {
            moveableDataSize.delete(handle);
        }
        return handle;
    };

    const discardMoveableBlock = (
        process: NonNullable<typeof System.prototype.process>,
        handle: number,
    ): number => {
        const desc = moveableDescFromHandle(handle);
        const dataPtr = Mem.readUint32(handle) ?? 0;
        if (dataPtr) {
            dataPtrToMoveableHandle.delete(dataPtr);
            if (!isInAnySlab(dataPtr)) {
                freeHeapBlock(process, dataPtr);
            }
        }
        moveableDataSize.delete(handle);
        const flags = Mem.readUint16(desc) ?? 0;
        Mem.writeUint16(desc, flags | MEM_FLAG_DISCARDED);
        Mem.writeUint32(handle, 0);
        return handle;
    };

    let cachedThunkRegions: ThunkMemoryRegions | null | undefined = undefined; // undefined = not yet cached

    const overlapsThunkRegion = (address: number, size: number): boolean => {
        if (cachedThunkRegions === undefined) {
            const process = System.getInstance().process;
            try {
                cachedThunkRegions = process?.thunkMemoryManager?.getRegions() ?? null;
            } catch {
                cachedThunkRegions = null;
            }
        }
        const regions = cachedThunkRegions;
        if (!regions) return false;

        const end = address + size;
        const callbackEnd = regions.callbackStubPoolBase + regions.callbackStubPoolSize;
        const spinEnd = regions.spinLoopAddress + regions.spinLoopSize;
        const thunkEnd = regions.thunkGeneratorBase + regions.thunkGeneratorSize;

        if (address < callbackEnd && end > regions.callbackStubPoolBase) return true;
        if (address < spinEnd && end > regions.spinLoopAddress) return true;
        if (address < thunkEnd && end > regions.thunkGeneratorBase) return true;

        // Backstop for older serialized regions without thunkGeneratorSize.
        if (!regions.thunkGeneratorSize) {
            const legacyThunkEnd = regions.thunkGeneratorBase + THUNK_GENERATOR_REGION_SIZE;
            if (address < legacyThunkEnd && end > regions.thunkGeneratorBase) return true;
        }

        return false;
    };

    const mapProtectToPerms = (protect: number): RegionPerms => {
        if (protect & PAGE_NOACCESS) {
            return "noaccess";
        }
        const isWrite = Boolean(protect & (PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY));
        const isExec = Boolean(protect & (PAGE_EXECUTE | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY));
        const isRead = Boolean(protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)) || isExec;

        let perms = "";
        if (isRead || isExec) perms += "r";
        if (isWrite) perms += "w";
        if (isExec) perms += "x";
        if (perms === "") {
            perms = "rw";
        }
        return perms as RegionPerms;
    };

    exports['VirtualQuery'] = (ctx, mem, args) => {
        const lpAddress = args[0] >>> 0;
        const lpBuffer = args[1];
        const dwLength = args[2];

        if (lpBuffer && dwLength >= 28) { // sizeof(MEMORY_BASIC_INFORMATION) = 28
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const system = System.getInstance();
            const moduleRegistry = system.process?.moduleRegistry;

            // MEM states / types
            const MEM_COMMIT = 0x1000, MEM_RESERVE = 0x2000, MEM_FREE = 0x10000;
            const MEM_PRIVATE = 0x20000, MEM_IMAGE = 0x01000000;
            const PAGE_EXECUTE_READ_C = 0x20;
            // FREE-coalesce ceiling = backed guest RAM. GetSystemInfo still reports
            // 0x7FFEFFFF (Win32 userspace), but advertising MEM_FREE for the unbacked
            // hole [mem.length .. 0x7FFF0000) made SmartHeap MemPoolPreAllocate that
            // entire remnant (~800MB TOP_DOWN VirtualAlloc) and MessageBox OOM.
            const memLen = mem.length >>> 0;
            const MAX_APP_ADDR = memLen;

            const pageBase = (lpAddress & ~0xFFF) >>> 0;
            if (pageBase >= memLen) {
                return 0;
            }

            let baseAddress = pageBase;
            let allocationBase = pageBase;
            let regionSize = 0x1000;
            let protect = PAGE_READWRITE;
            let memType = MEM_PRIVATE;
            let state = MEM_COMMIT;

            // Committed/reserved layout intervals. A page is "backed" if it falls in one.
            // keep committed regions page-granular (the old behaviour) — third-party
            // heap managers (SmartHeap/Shw32 in BoD) validate a pointer by VirtualQuery-ing it
            // and comparing AllocationBase/Type against their pool registry; coalescing the whole
            // heap into one region with AllocationBase=HEAP_BASE makes SmartHeap reject every
            // pointer as MEM_BAD_POINTER. We ONLY coalesce *free* gaps (see below).
            //
            // SURFACE is a large reserved pool (320MB) of which only the bump arena below the
            // frontier is real pixel memory; the virgin tail must NOT report per-page COMMIT or
            // a walker (addr = BaseAddress + RegionSize) storms every 4KB page of the pool. Only
            // pages below the SURFACE frontier are backed — the rest fall through to the free-gap
            // coalescing and are skipped in one MEM_FREE step (ROM stays whole-span: PE images
            // there are already coalesced by the MEM_IMAGE branch above).
            const surfaceEnd = MEM_SURFACE_BASE + MEM_SURFACE_SIZE;
            const surfaceFrontier = system.process?.memory?.getBucketFrontier('SURFACE') ?? surfaceEnd;
            const isBackedInterval = (a: number): boolean =>
                (a >= MEM_HEAP_BASE && a < MEM_THUNK_DATA_BASE + MEM_THUNK_DATA_SIZE) ||
                (a >= MEM_ROM_BASE && a < MEM_SURFACE_BASE) ||
                (a >= MEM_SURFACE_BASE && a < surfaceFrontier);

            // 1) PE module image — report the whole image as one MEM_IMAGE region.
            const mod = moduleRegistry?.getModuleContainingAddress(lpAddress) ?? null;
            if (mod) {
                allocationBase = mod.baseAddress;
                regionSize = mod.size - (pageBase - mod.baseAddress);
                protect = PAGE_EXECUTE_READ_C;
                memType = MEM_IMAGE;
                state = MEM_COMMIT;
            } else if (lpAddress >= 0x00400000 && lpAddress < 0x00500000) {
                // 2) Main EXE range (kept for parity with the old classifier).
                allocationBase = 0x00400000;
                memType = MEM_IMAGE;
                protect = PAGE_EXECUTE_READ_C;
                state = MEM_COMMIT;
            } else if (pageBase >= surfaceFrontier && pageBase < surfaceEnd) {
                // Virgin SURFACE tail: MEM_RESERVE (bucket reserved for pixels), not MEM_FREE.
                // Advertising it as FREE let SmartHeap MemPoolPreAllocate hundreds of MB via
                // MEM_TOP_DOWN VirtualAlloc and collide with the surface bump / OOM.
                // BaseAddress = frontier (region start), not pageBase — Win32 walkers step
                // Base+RegionSize; page-granular Base made TOP_DOWN walks crawl 4KB at a time.
                baseAddress = surfaceFrontier & ~0xFFF;
                allocationBase = MEM_SURFACE_BASE;
                regionSize = surfaceEnd - baseAddress;
                memType = MEM_PRIVATE;
                protect = PAGE_NOACCESS;
                state = MEM_RESERVE;
            } else {
                // 3) Generic memory. A backed page (heap/thunk/rom/surface bucket OR a tracked
                // VirtualAlloc region) stays page-granular COMMIT — exactly what it was before.
                // An UNBACKED page is MEM_FREE and, CRITICALLY, reports a RegionSize spanning the
                // whole gap to the next allocation. Returning per-page COMMIT for free memory (the
                // old behaviour) made guest address-space walkers (addr = BaseAddress + RegionSize)
                // advance 4KB at a time and never see MEM_FREE, scanning the entire 4GB one page at
                // a time — the BoD VirtualQuery storm (19k+ calls), 2026-06-12.
                // Tracked VirtualAlloc regions: Win32 reports AllocationBase = the
                // original VirtualAlloc base for every page in the reservation.
                // SmartHeap/Shw32 validates interior pointers against that base; page-
                // granular AllocationBase made every sub-page look like its own alloc.
                let vaBase = 0;
                let vaSize = 0;
                for (const [base, size] of virtualAllocRegions) {
                    if (pageBase >= base && pageBase < base + size) {
                        vaBase = base;
                        vaSize = size;
                        break;
                    }
                }

                if (vaSize !== 0) {
                    allocationBase = vaBase;
                    regionSize = vaBase + vaSize - pageBase;
                    memType = MEM_PRIVATE;
                    protect = PAGE_READWRITE;
                    state = MEM_COMMIT;
                } else if (isBackedInterval(pageBase)) {
                    // Page-granular COMMIT for the rest of the HEAP/thunk/rom buckets —
                    // coalescing the whole HEAP into AllocationBase=HEAP_BASE made
                    // SmartHeap reject every pointer as MEM_BAD_POINTER.
                    allocationBase = pageBase;
                    regionSize = 0x1000;
                    memType = MEM_PRIVATE;
                    protect = PAGE_READWRITE;
                    state = MEM_COMMIT;
                } else {
                    // Truly free: coalesce to the next allocation boundary so walkers skip the gap.
                    let nextBase = MAX_APP_ADDR;
                    const consider = (b: number) => { if (b > pageBase && b < nextBase) nextBase = b; };
                    consider(0x00400000);
                    consider(MEM_HEAP_BASE);
                    consider(MEM_ROM_BASE);
                    consider(MEM_SURFACE_BASE);
                    for (const [base] of virtualAllocRegions) consider(base);
                    allocationBase = 0;
                    regionSize = Math.max(0x1000, nextBase - pageBase);
                    protect = PAGE_NOACCESS;
                    memType = 0;
                    state = MEM_FREE;
                }
            }

            // Decommitted pages within a reserved/committed region read back as MEM_RESERVE.
            if (state === MEM_COMMIT) {
                for (const [dcBase, dcSize] of decommittedPages) {
                    if (pageBase >= dcBase && pageBase < dcBase + dcSize) {
                        state = MEM_RESERVE;
                        // Clip region to the decommitted run so the walker sees the boundary.
                        regionSize = Math.min(regionSize, dcBase + dcSize - pageBase);
                        break;
                    }
                }
            }

            const reportProtect = (state === MEM_RESERVE || state === MEM_FREE) ? PAGE_NOACCESS : protect;
            view.setUint32(lpBuffer, baseAddress, true);              // BaseAddress
            view.setUint32(lpBuffer + 4, allocationBase, true);       // AllocationBase
            view.setUint32(lpBuffer + 8, state === MEM_FREE ? 0 : protect, true); // AllocationProtect
            view.setUint32(lpBuffer + 12, regionSize, true);          // RegionSize
            view.setUint32(lpBuffer + 16, state, true);               // State
            view.setUint32(lpBuffer + 20, reportProtect, true);       // Protect
            view.setUint32(lpBuffer + 24, memType, true);             // Type

            const stateName = state === MEM_FREE ? 'FREE' : state === MEM_RESERVE ? 'RESERVE' : 'COMMIT';
            Logger.verbose(LogCategory.KERNEL32,
                `VirtualQuery(0x${lpAddress.toString(16)}) -> base=0x${baseAddress.toString(16)} alloc=0x${allocationBase.toString(16)} size=0x${regionSize.toString(16)} state=${stateName} type=0x${memType.toString(16)}`);

            return 28; // sizeof(MEMORY_BASIC_INFORMATION)
        }

        return 0;
    };

    exports['VirtualQueryEx'] = (ctx, mem, args) => {
        const hProcess = args[0] >>> 0;
        const lpAddress = args[1] >>> 0;
        const lpBuffer = args[2] >>> 0;
        const dwLength = args[3] >>> 0;

        if (hProcess !== CURRENT_PROCESS) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            Logger.warn(LogCategory.KERNEL32, `VirtualQueryEx: invalid process handle 0x${hProcess.toString(16)}`);
            return { value: 0, stackCleanup: 16 };
        }

        const result = exports['VirtualQuery']!(ctx, mem, [lpAddress, lpBuffer, dwLength]);
        if ((result as number) === 0) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
        }
        return { value: (result as number) >>> 0, stackCleanup: 16 };
    };

    exports['GetSystemInfo'] = (ctx, mem, args) => {
        const lpSystemInfo = args[0];
        if (!lpSystemInfo || lpSystemInfo + 36 > mem.length) {
            return 0;
        }

        // Cap lpMaximumApplicationAddress to backed guest RAM. Reporting the full
        // Win32 2GB userspace (0x7FFEFFFF) while VirtualQuery refuses / cannot back
        // [mem.length..2GB) made SmartHeap (MEM_TOP_DOWN walk / MemPoolPreAllocate)
        // VirtualAlloc a ~800MB phantom free remnant and MessageBox OOM.
        const maxAppAddr = mem.length > 0 ? ((mem.length - 1) >>> 0) : 0x7FFEFFFF;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint16(lpSystemInfo + 0, 0, true); // wProcessorArchitecture (x86)
        view.setUint16(lpSystemInfo + 2, 0, true); // wReserved
        view.setUint32(lpSystemInfo + 4, 0x1000, true); // dwPageSize
        view.setUint32(lpSystemInfo + 8, 0x00010000, true); // lpMinimumApplicationAddress
        view.setUint32(lpSystemInfo + 12, maxAppAddr, true); // lpMaximumApplicationAddress
        view.setUint32(lpSystemInfo + 16, 1, true); // dwActiveProcessorMask
        view.setUint32(lpSystemInfo + 20, 1, true); // dwNumberOfProcessors
        view.setUint32(lpSystemInfo + 24, 586, true); // dwProcessorType (Pentium)
        view.setUint32(lpSystemInfo + 28, 0x10000, true); // dwAllocationGranularity
        view.setUint16(lpSystemInfo + 32, 5, true); // wProcessorLevel
        view.setUint16(lpSystemInfo + 34, 0, true); // wProcessorRevision
        return 0;
    };

    exports['GetNativeSystemInfo'] = (ctx, mem, args) => {
        return exports['GetSystemInfo'](ctx, mem, args);
    };

    // BOOL GetNumaHighestNodeNumber(PULONG HighestNodeNumber)
    exports['GetNumaHighestNodeNumber'] = (_ctx, _mem, args) => {
        const highestNodeNumber = args[0] >>> 0;
        if (!highestNodeNumber) {
            System.getInstance().scheduler.setLastError(87); // ERROR_INVALID_PARAMETER
            return 0;
        }
        Mem.writeUint32(highestNodeNumber, 0);
        return 1;
    };

    exports['GlobalMemoryStatus'] = (ctx, mem, args) => {
        const lpBuffer = args[0];
        if (!lpBuffer || lpBuffer + 32 > mem.length) {
            return 0;
        }

        const system = System.getInstance();
        const total = system.process?.getCurrentMemory().length ?? (256 * 1024 * 1024);
        const avail = Math.max(0, Math.floor(total * 0.75));
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        view.setUint32(lpBuffer + 0, 32, true); // dwLength
        view.setUint32(lpBuffer + 4, Math.floor(((total - avail) / total) * 100), true); // dwMemoryLoad
        view.setUint32(lpBuffer + 8, total >>> 0, true); // dwTotalPhys
        view.setUint32(lpBuffer + 12, avail >>> 0, true); // dwAvailPhys
        view.setUint32(lpBuffer + 16, total >>> 0, true); // dwTotalPageFile
        view.setUint32(lpBuffer + 20, avail >>> 0, true); // dwAvailPageFile
        view.setUint32(lpBuffer + 24, total >>> 0, true); // dwTotalVirtual
        view.setUint32(lpBuffer + 28, avail >>> 0, true); // dwAvailVirtual

        return 0;
    };

    exports['GlobalMemoryStatusEx'] = (ctx, mem, args) => {
        const lpBuffer = args[0];
        if (!lpBuffer || lpBuffer + 64 > mem.length) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const length = view.getUint32(lpBuffer, true);
        if (length !== 64) {
            Logger.warn(LogCategory.KERNEL32, `GlobalMemoryStatusEx: unexpected length ${length}, filling anyway`);
        }

        const system = System.getInstance();
        const total = system.process?.getCurrentMemory().length ?? (256 * 1024 * 1024);
        const avail = Math.max(0, Math.floor(total * 0.75));
        const total64 = BigInt(total >>> 0);
        const avail64 = BigInt(avail >>> 0);

        view.setUint32(lpBuffer + 0, 64, true); // dwLength
        view.setUint32(lpBuffer + 4, Math.floor(((total - avail) / total) * 100), true); // dwMemoryLoad
        view.setBigUint64(lpBuffer + 8, total64, true); // ullTotalPhys
        view.setBigUint64(lpBuffer + 16, avail64, true); // ullAvailPhys
        view.setBigUint64(lpBuffer + 24, total64, true); // ullTotalPageFile
        view.setBigUint64(lpBuffer + 32, avail64, true); // ullAvailPageFile
        view.setBigUint64(lpBuffer + 40, total64, true); // ullTotalVirtual
        view.setBigUint64(lpBuffer + 48, avail64, true); // ullAvailVirtual
        view.setBigUint64(lpBuffer + 56, 0n, true); // ullAvailExtendedVirtual

        return 1;
    };

    exports['GetProcessHeap'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.KERNEL32, 'GetProcessHeap()');
        // Return the default process heap handle
        return PROCESS_HEAP_HANDLE;
    };

    exports['HeapCreate'] = (ctx, mem, args) => {
        const flOptions = args[0];
        const dwInitialSize = args[1];
        const dwMaximumSize = args[2];

        Logger.verbose(LogCategory.KERNEL32, `HeapCreate(0x${flOptions.toString(16)}, ${dwInitialSize}, ${dwMaximumSize})`);

        // Allocations against any heap share the one underlying allocator, but the
        // handle must be unique and tracked: GetProcessHeaps must report every
        // created heap so third-party heap managers (SmartHeap) can validate blocks
        // delegated to it. A fixed handle collided across HeapCreate calls and was
        // invisible to GetProcessHeaps — the BoD SmartHeap MEM_BAD_POINTER wall.
        ensureHeapManagerProcess();
        const handle = nextCreatedHeapHandle >>> 0;
        nextCreatedHeapHandle = (nextCreatedHeapHandle + 1) >>> 0;
        createdHeaps.add(handle);
        Logger.verbose(LogCategory.KERNEL32, `HeapCreate -> 0x${handle.toString(16)}`);
        return handle;
    };

    exports['HeapAlloc'] = (ctx, mem, args) => {
        const hHeap = args[0];
        const dwFlags = args[1];
        const dwBytes = args[2] >>> 0;

        Logger.verboseLazy(LogCategory.KERNEL32,
            () => `HeapAlloc(0x${hHeap.toString(16)}, 0x${dwFlags.toString(16)}, ${dwBytes})`);

        // For now, allocate from the process heap
        // This is a simplified implementation
        const system = System.getInstance();
        const process = system.process;
        if (process) {
            if (dwBytes === 0) {
                system.scheduler.setLastError(HEAP_OOM_ERROR);
                Logger.warn(LogCategory.KERNEL32, `HeapAlloc refused size 0 ${formatCallSite(ctx, mem, 4, [0x38, 0x44], [0])}`);
                return 0;
            }

            // If the slab arena is exhausted, grow it. Reaching JS for a sub-4KB
            // alloc is the signal: the inline x86 stub and the Rust hypercall both fall
            // through exactly when SLAB_END was overrun. After grow, the next call picks
            // the new slab via the guest-RAM control block (no guest-code restart needed). This one
            // still goes via process.memory.alloc below — it's cheaper than gambling on a
            // race between install and the current caller retrying.
            if (dwBytes <= HEAP_SMALL_ALLOC_MAX) {
                maybeGrowHeapSlab();
            }

            const zeroMemory = (dwFlags & HEAP_ZERO_MEMORY_FLAG) !== 0 || DEBUG_FORCE_ZERO_HEAP;
            const memSize = process.getCurrentMemory().length;
            if (dwBytes > memSize || dwBytes > HEAP_FAST_PATH_MAX_ALLOC) {
                system.scheduler.setLastError(HEAP_OOM_ERROR);
                const count = dwBytes >>> 7;
                const scale128 = (dwBytes & 0x7f) === 0 ? ` scale128=0x${count.toString(16)}` : "";

                let scanResult = "";
                if (scale128) {
                    const hits = scanMemoryForValue(mem, count);
                    if (hits.length > 0) {
                        scanResult = ` SCAN_COUNT_IN_MEM=[${hits.slice(0, 10).join(", ")}${hits.length > 10 ? "..." : ""}]`;
                    }
                }

                Logger.warn(LogCategory.KERNEL32, `HeapAlloc refused size ${dwBytes} (mem=0x${memSize.toString(16)})${scale128}${scanResult} ${formatCallSite(ctx, mem, 4, [0x38, 0x44], [dwBytes, count])}`);
                return 0;
            }
            try {
                const allocBytes = dwBytes <= HEAP_SMALL_ALLOC_MAX ? alignSmallAlloc(dwBytes) : dwBytes;
                const address = process.memory.alloc(allocBytes);

                if (zeroMemory) {
                    mem.fill(0, address, address + allocBytes);
                }

                heapWatch('alloc', ctx, mem, [address], `size=${dwBytes}`);
                Logger.verboseLazy(LogCategory.KERNEL32, () => `HeapAlloc -> 0x${address.toString(16)}`);
                return address;
            } catch (error) {
                system.scheduler.setLastError(HEAP_OOM_ERROR);
                Logger.warn(LogCategory.KERNEL32, `HeapAlloc failed: ${error}`);
            }
        }

        return 0; // NULL
    };

    exports['HeapFree'] = (ctx, mem, args) => {
        const hHeap = args[0];
        const dwFlags = args[1];
        const lpMem = args[2];

        Logger.verboseLazy(LogCategory.KERNEL32,
            () => `HeapFree(0x${hHeap.toString(16)}, 0x${dwFlags.toString(16)}, 0x${lpMem.toString(16)})`);

        const system = System.getInstance();
        const process = system.process;
        if (process && lpMem) {
            heapWatch('free', ctx, mem, [lpMem]);
            const p = lpMem >>> 0;
            // VirtualAlloc roots are not HeapAlloc blocks. Freeing them here would tear
            // down a SmartHeap/CRT pool while interior owners still hold pointers.
            if (isInVirtualAllocRegion(p)) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                Logger.warn(LogCategory.KERNEL32,
                    `HeapFree(0x${p.toString(16)}): refusing VirtualAlloc region (use VirtualFree)`);
                return 0;
            }
            // Retired-slab blocks: the inline stub validates against the *active* slab
            // only, so frees targeting a previous generation fall here. Treat as no-op
            // (the bytes stay "reserved" inside the retired slab until process reset).
            // Must run BEFORE process.memory.free — the pointer is an interior slab
            // offset, not a root allocation, and free would either throw or mistarget
            // the enclosing slab arena.
            if (isInAnySlab(p)) {
                // DIAG: a slab pointer reaching JS HeapFree was rejected by the WASM/inline
                // fast path. A FREE-marked header (0x534C46xx) means a DOUBLE-FREE — capture
                // the guest caller to find the load-bearing double-free source.
                const p = lpMem >>> 0;
                if (p >= 4 && p + 0 <= mem.length) {
                    const hdr = (mem[p - 4] | mem[p - 3] << 8 | mem[p - 2] << 16 | mem[p - 1] << 24) >>> 0;
                    if ((hdr & 0xFFFFFF00) === SLAB_MAGIC_FREE && _dblFreeLogCount < 40) {
                        _dblFreeLogCount++;
                        let bt = '';
                        try {
                            const d: any = (process as any).dispatcher;
                            if (d?.getGuestCallStack) {
                                const s = d.getGuestCallStack(undefined, 0x400, 8);
                                bt = s.frames.slice(0, 8).map((f: any) => f.moduleName ? `${f.moduleName}+0x${f.moduleOffset.toString(16)}` : `0x${f.retAddr.toString(16)}`).join(' <- ');
                            }
                        } catch { /* best-effort */ }
                        Logger.warn(LogCategory.KERNEL32,
                            `[DBLFREE] HeapFree on already-FREE slab block 0x${p.toString(16)} (bin=${hdr & 0x0F}) — double-free absorbed\n  bt: ${bt}`);
                    }
                }
                return 1;
            }
            process.memory.free(lpMem);
        }
        return 1; // TRUE
    };

    exports['HeapDestroy'] = (ctx, mem, args) => {
        const hHeap = args[0] >>> 0;
        Logger.verbose(LogCategory.KERNEL32, `HeapDestroy(0x${hHeap.toString(16)})`);
        // Drop the handle from the registry so GetProcessHeaps stops reporting it.
        // Blocks carved from it stay live in the shared allocator (we don't track
        // per-heap ownership) — harmless: HeapWalk just keeps validating them.
        createdHeaps.delete(hHeap);
        return 1; // TRUE
    };

    // LocalAlloc - allocate memory from the default process heap
    // In modern Windows, this is just a wrapper around HeapAlloc(GetProcessHeap(), ...)
    exports['LocalAlloc'] = (ctx, mem, args) => {
        const uFlags = args[0];
        const uBytes = args[1] >>> 0;

        Logger.verbose(LogCategory.KERNEL32, `LocalAlloc(0x${uFlags.toString(16)}, ${uBytes})`);

        // Use HeapAlloc with the default process heap
        const hHeap = PROCESS_HEAP_HANDLE;

        // Convert LocalAlloc flags to HeapAlloc flags
        const HEAP_ZERO_MEMORY = 0x00000008;
        let dwFlags = 0;
        if (uFlags & LMEM_ZEROINIT) {
            dwFlags |= HEAP_ZERO_MEMORY;
        }

        // Call HeapAlloc logic directly
        const system = System.getInstance();
        const process = system.process;
        if (process) {
            resetMoveableTables();

            if (uFlags & LMEM_MOVEABLE) {
                const memSize = process.getCurrentMemory().length;
                if (uBytes > memSize || uBytes > MAX_ALLOC_BYTES) {
                    system.scheduler.setLastError(8);
                    return 0;
                }
                try {
                    const handle = allocMoveableBlock(
                        process,
                        mem,
                        uBytes,
                        (dwFlags & HEAP_ZERO_MEMORY) !== 0,
                    );
                    Logger.verbose(LogCategory.KERNEL32, `LocalAlloc moveable(${uBytes}) -> handle=0x${handle.toString(16)}`);
                    return handle;
                } catch (error) {
                    system.scheduler.setLastError(8);
                    Logger.warn(LogCategory.KERNEL32, `LocalAlloc moveable failed: ${error}`);
                    return 0;
                }
            }

            // Windows allows LocalAlloc(0) - it returns a valid handle (not NULL)
            // We allocate minimum 4 bytes for alignment, but return it as valid handle
            const allocSize = uBytes === 0 ? 4 : uBytes;
            const memSize = process.getCurrentMemory().length;
            // memSize (total guest RAM) is the real ceiling; the absolute cap only rejects
            // obviously-garbage sizes. Shared with process.memory.alloc's guard so a legit
            // large request reaches the allocator instead of being refused here.
            if (allocSize > memSize || allocSize > MAX_ALLOC_BYTES) {
                system.scheduler.setLastError(8);
                const count = allocSize >>> 7;
                const scale128 = (allocSize & 0x7f) === 0 ? ` scale128=0x${count.toString(16)}` : "";

                let scanResult = "";
                if (scale128) {
                    const hits = scanMemoryForValue(mem, count);
                    if (hits.length > 0) {
                        scanResult = ` SCAN_COUNT_IN_MEM=[${hits.slice(0, 10).join(", ")}${hits.length > 10 ? "..." : ""}]`;
                    }
                }

                Logger.warn(LogCategory.KERNEL32, `LocalAlloc refused size ${allocSize} (mem=0x${memSize.toString(16)})${scale128}${scanResult} ${formatCallSite(ctx, mem, 4, [0x38, 0x44], [allocSize, count])}`);
                return 0;
            }
            try {
                const address = process.memory.alloc(allocSize);

                if (fixedLocalHandles.has(address)) {
                    Logger.error(LogCategory.KERNEL32,
                        `LocalAlloc: heap returned 0x${address.toString(16)} still registered as live ` +
                        `(req=${uBytes}, prevUser=${fixedLocalUserSizes.get(address) ?? "?"}) — overlapping GlobalAlloc`);
                }

                // Zero memory if requested or forced
                if ((dwFlags & HEAP_ZERO_MEMORY) || DEBUG_FORCE_ZERO_HEAP) {
                    mem.fill(0, address, address + allocSize);
                }

                Logger.verbose(LogCategory.KERNEL32, `LocalAlloc(${uBytes === 0 ? "0" : uBytes}) -> 0x${address.toString(16)}${uBytes === 0 ? " (allocated 4 bytes for alignment)" : ""}`);
                registerFixedLocalHandle(address, uBytes);
                return address;
            } catch (error) {
                system.scheduler.setLastError(8);
                Logger.warn(LogCategory.KERNEL32, `LocalAlloc failed: ${error}`);
            }
        }

        return 0; // NULL
    };

    // LocalFree - free memory allocated with LocalAlloc
    // In modern Windows, this is just a wrapper around HeapFree(GetProcessHeap(), 0, ...)
    exports['LocalFree'] = (ctx, mem, args) => {
        const hMem = args[0];

        Logger.verbose(LogCategory.KERNEL32, `LocalFree(0x${hMem.toString(16)})`);

        if (!hMem) {
            return 0; // NULL (already freed or invalid)
        }

        // Use HeapFree with the default process heap
        const system = System.getInstance();
        const process = system.process;
        if (process && hMem) {
            resetMoveableTables();
            if (isMoveableHandle(hMem)) {
                freeMoveableBlock(process, hMem);
                Logger.verbose(LogCategory.KERNEL32, `LocalFree: freed moveable handle 0x${hMem.toString(16)}`);
                return 0;
            }
            unregisterFixedLocalHandle(hMem);
            // Slab-resident blocks (LocalAlloc routes through HeapAlloc for small sizes)
            // must not be passed to process.memory.free — they're sub-allocations, freed
            // via the slab path. Everything else goes through the single free funnel.
            if (!isInAnySlab(hMem >>> 0)) {
                freeHeapBlock(process, hMem);
            }
            Logger.verbose(LogCategory.KERNEL32, `LocalFree: freed 0x${hMem.toString(16)}`);
        }
        return 0; // NULL on success
    };

    exports['HeapReAlloc'] = (ctx, mem, args) => {
        const hHeap = args[0];
        const dwFlags = args[1];
        const lpMem = args[2];
        const dwBytes = args[3] >>> 0;

        Logger.verbose(LogCategory.KERNEL32, `HeapReAlloc(0x${hHeap.toString(16)}, 0x${dwFlags.toString(16)}, 0x${lpMem.toString(16)}, ${dwBytes})`);

        // Simplified implementation - allocate new memory and copy
        const system = System.getInstance();
        const process = system.process;
        if (process) {
            if (dwBytes === 0) {
                system.scheduler.setLastError(8);
                Logger.warn(LogCategory.KERNEL32, `HeapReAlloc refused size 0 ${formatCallSite(ctx, mem, 4, [0x38, 0x44], [0])}`);
                return 0;
            }
            const memSize = process.getCurrentMemory().length;
            if (dwBytes > memSize || dwBytes > 0x20000000) {
                system.scheduler.setLastError(8);
                const count = dwBytes >>> 7;
                const scale128 = (dwBytes & 0x7f) === 0 ? ` scale128=0x${count.toString(16)}` : "";

                let scanResult = "";
                if (scale128) {
                    const hits = scanMemoryForValue(mem, count);
                    if (hits.length > 0) {
                        scanResult = ` SCAN_COUNT_IN_MEM=[${hits.slice(0, 10).join(", ")}${hits.length > 10 ? "..." : ""}]`;
                    }
                }

                Logger.warn(LogCategory.KERNEL32, `HeapReAlloc refused size ${dwBytes} (mem=0x${memSize.toString(16)})${scale128}${scanResult} ${formatCallSite(ctx, mem, 4, [0x38, 0x44], [dwBytes, count])}`);
                return 0;
            }

            // In-place realloc fast path. Real Windows HeapReAlloc keeps the pointer
            // stable whenever the existing block capacity can hold the new size; our
            // old behaviour (always alloc-new + copy + free-old) churned addresses on
            // every grow. That churn broke the MSVC statically-linked CRT aligned heap:
            // _aligned_realloc stores the underlying malloc base at [ptr-4] and calls
            // plain realloc/_msize on it. Rapid recycling let a just-freed base region
            // be handed to an unrelated plain alloc while a stale aligned pointer still
            // referenced it → [ptr-4] read 0 → __msize_base(NULL) →
            // STATUS_INVALID_CRUNTIME_PARAMETER (0xc0000417). unreal-gold (FMallocAnsi
            // → _aligned_*) terminated here. Keeping the block put when it already fits
            // removes the churn (and is a general allocation-throughput win).
            //
            // Capacity sources mirror HeapSize: slab bin size, else the (rounded-up)
            // tracked allocation size. process.memory rounds every alloc up to >=8 and
            // HeapAlloc pre-rounds small sizes to 16, so getSize() IS the usable
            // capacity — dwBytes <= capacity is safe to satisfy in place.
            if (lpMem) {
                let capacity = getSlabSizeForPtr(lpMem);
                if (capacity === undefined) capacity = process.memory.getSize(lpMem);
                if (capacity !== undefined && dwBytes <= capacity) {
                    heapWatch('realloc-inplace', ctx, mem, [lpMem], `size=${dwBytes} cap=${capacity}`);
                    Logger.verboseLazy(LogCategory.KERNEL32,
                        () => `HeapReAlloc in-place 0x${lpMem.toString(16)} (size=${dwBytes} <= cap=${capacity})`);
                    return lpMem >>> 0;
                }
                // HEAP_REALLOC_IN_PLACE_ONLY (0x10): caller forbids relocation. If we
                // know the block can't grow in place, fail rather than move it.
                if ((dwFlags & 0x10) && capacity !== undefined) {
                    system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                    Logger.verbose(LogCategory.KERNEL32,
                        `HeapReAlloc IN_PLACE_ONLY can't grow 0x${lpMem.toString(16)} (size=${dwBytes} > cap=${capacity})`);
                    return 0;
                }
            }
            try {
                const newAddress = process.memory.alloc(dwBytes);

                // Copy old data to new location. Size resolution must mirror HeapSize:
                // slab first (sub-allocations inside the 4MB WASM arena are NOT tracked in
                // process.memory.allocations — only the slab base is), then the allocations
                // map, then the address-space region as a coarse fallback. Without the slab
                // check HeapReAlloc on a hypercall-slab pointer loses all old content.
                if (lpMem && newAddress) {
                    let oldSize = getSlabSizeForPtr(lpMem);
                    if (oldSize === undefined) {
                        oldSize = process.memory.getSize(lpMem);
                    }
                    // Do NOT fall back to AddressSpace layout-bucket size: the HEAP bucket
                    // is hundreds of MB and would copy / "relocate" unrelated VirtualAlloc
                    // pool contents. Unknown size → copy nothing (same as a failed probe).
                    if (oldSize === undefined) {
                        Logger.warn(LogCategory.KERNEL32,
                            `HeapReAlloc DATA LOSS: size unknown for 0x${lpMem.toString(16)}! newSize=${dwBytes} newAddr=0x${newAddress.toString(16)} ${formatCallSite(ctx, mem, 4, [0x38, 0x44], [lpMem])}`);
                        oldSize = 0;
                    }
                    const copySize = Math.min(oldSize, dwBytes);
                    if (copySize > 0) {
                        mem.copyWithin(newAddress, lpMem, lpMem + copySize);
                    }

                    // HEAP_REALLOC_IN_PLACE_ONLY = 0x00000010
                    // If not in-place only, we just allocated a new block, so free the old one.
                    // Skip if the old block lives inside a slab arena — slab sub-allocations
                    // aren't root entries in process.memory.allocations, so free would either
                    // throw or mistarget the enclosing 4MB+ slab root.
                    if (!isInAnySlab(lpMem >>> 0)) {
                        freeHeapBlock(process, lpMem);
                    }
                }

                heapWatch('realloc-move', ctx, mem, [lpMem, newAddress], `size=${dwBytes}`);
                Logger.verbose(LogCategory.KERNEL32, `HeapReAlloc -> 0x${newAddress.toString(16)}`);
                return newAddress;
            } catch (error) {
                system.scheduler.setLastError(8);
                Logger.warn(LogCategory.KERNEL32, `HeapReAlloc failed: ${error}`);
            }
        }

        return 0; // NULL
    };

    exports['HeapSize'] = (ctx, mem, args) => {
        const hHeap = args[0];
        const dwFlags = args[1];
        const lpMem = args[2] >>> 0;

        Logger.verbose(LogCategory.KERNEL32, `HeapSize(0x${hHeap.toString(16)}, 0x${dwFlags.toString(16)}, 0x${lpMem.toString(16)})`);

        // VirtualAlloc memory is not a heap block — Win32 returns (SIZE_T)-1.
        if (!lpMem || isInVirtualAllocRegion(lpMem)) return 0xFFFFFFFF;

        // Check WASM slab first (most common for small allocations)
        const slabSize = getSlabSizeForPtr(lpMem);
        if (slabSize !== undefined) return slabSize;

        const process = System.getInstance().process;
        if (process) {
            const size = process.memory.getSize(lpMem);
            if (size !== undefined) return size;
        }

        // Exact HeapAlloc base only. Layout-bucket / dummy sizes lied to SmartHeap:
        // a VirtualAlloc pool base looked like a live HeapAlloc block → HeapFree of the
        // pool while CRT still held interior pointers (_piob).
        return 0xFFFFFFFF;
    };

    // UINT HeapCompact(HANDLE hHeap, DWORD dwFlags)
    // Returns the size of the largest committed free block; 0 on error.
    // Our heap does not support real compaction — return a plausible non-zero value so
    // callers that check for failure (return 0) continue normally.
    exports['HeapCompact'] = (ctx, mem, args) => {
        const hHeap = args[0];
        const dwFlags = args[1];
        Logger.verbose(LogCategory.KERNEL32, `HeapCompact(0x${hHeap.toString(16)}, 0x${dwFlags.toString(16)}) -> stub`);
        return 0x10000; // 64 KB — plausible "largest free block"
    };

    // BOOL HeapValidate(HANDLE hHeap, DWORD dwFlags, LPCVOID lpMem)
    // Returns TRUE — our heap is always "valid"
    exports['HeapValidate'] = () => 1;

    // BOOL HeapQueryInformation(HANDLE HeapHandle, HEAP_INFORMATION_CLASS HeapInformationClass,
    //   PVOID HeapInformation, SIZE_T HeapInformationLength, PSIZE_T ReturnLength)
    exports['HeapQueryInformation'] = (ctx, mem, args) => {
        const heapInfoClass = args[1]; // 0 = HeapCompatibilityInformation
        const heapInfo = args[2];
        const heapInfoLength = args[3];
        const returnLength = args[4];

        if (heapInfoClass === 0 && heapInfo && heapInfoLength >= 4) {
            // HeapCompatibilityInformation: return 0 (standard heap)
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(heapInfo, 0, true);
            if (returnLength) view.setUint32(returnLength, 4, true);
            return 1; // TRUE
        }

        // Unsupported class — return FALSE, set ERROR_INSUFFICIENT_BUFFER
        System.getInstance().scheduler.setLastError(122);
        return 0;
    };

    // VirtualAlloc - allocate virtual memory
    exports['VirtualAlloc'] = (ctx, mem, args) => {
        const lpAddress = args[0];
        const dwSize = args[1];
        const flAllocationType = args[2];
        const flProtect = args[3];

        const fail = (why: string): 0 => {
            Logger.warn(LogCategory.KERNEL32,
                `VirtualAlloc FAIL ${why} (lpAddr=0x${(lpAddress >>> 0).toString(16)}, size=0x${(dwSize >>> 0).toString(16)}, type=0x${(flAllocationType >>> 0).toString(16)}, prot=0x${(flProtect >>> 0).toString(16)})`);
            return 0;
        };

        Logger.verbose(LogCategory.KERNEL32, `VirtualAlloc(lpAddr=0x${lpAddress.toString(16)}, size=${dwSize}, type=0x${flAllocationType.toString(16)}, prot=0x${flProtect.toString(16)})`);

        const MEM_COMMIT = 0x1000;
        const MEM_RESERVE = 0x2000;
        const PAGE_SIZE = 0x1000; // 4KB page size
        const ALLOC_GRANULARITY = 0x10000; // 64KB — Windows allocation granularity

        if (!(flAllocationType & MEM_COMMIT) && !(flAllocationType & MEM_RESERVE)) {
            return fail('invalid allocation type');
        }

        const alignedSize = Math.ceil(dwSize / PAGE_SIZE) * PAGE_SIZE;
        // When lpAddress is non-zero but not page-aligned, round down to page boundary (Windows-compatible behavior)
        const effectiveAddress = lpAddress !== 0 ? (lpAddress & ~(PAGE_SIZE - 1)) : 0;

        if (effectiveAddress !== 0 && overlapsThunkRegion(effectiveAddress, alignedSize)) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_ADDRESS);
            return fail(`address overlaps thunk regions`);
        }

        const process = System.getInstance().process;
        if (!process) {
            Logger.error(LogCategory.KERNEL32, 'VirtualAlloc: Process not available');
            return 0;
        }

        const perms = mapProtectToPerms(flProtect);
        let address = effectiveAddress;
        const MEM_TOP_DOWN = 0x00100000;
        const ERROR_NOT_ENOUGH_MEMORY = 8;

        // MEM_COMMIT-only with specific address: commit pages within an already reserved region.
        // When lpAddress=0, Windows implicitly reserves+commits — fall through to the allocation path.
        const commitOnly = (flAllocationType & MEM_COMMIT) && !(flAllocationType & MEM_RESERVE) && effectiveAddress !== 0;
        if (commitOnly) {
            profiler.start("VirtualAlloc:reserveScan");
            let inReserved = false;
            for (const [base, size] of reservedPages) {
                if (effectiveAddress >= base && effectiveAddress < base + size) { inReserved = true; break; }
            }
            profiler.end("VirtualAlloc:reserveScan");
            if (inReserved) {
                profiler.start("VirtualAlloc:commitInReserved");
                commitPreservingCommitted(effectiveAddress, alignedSize);
                clearDecommittedRange(effectiveAddress, alignedSize);
                profiler.end("VirtualAlloc:commitInReserved");
                Logger.verbose(LogCategory.KERNEL32, `VirtualAlloc -> 0x${effectiveAddress.toString(16)} (COMMIT in reserved, size=${alignedSize})`);
                return effectiveAddress;
            }
            // Fallback: region may already be mapped by a prior RESERVE|COMMIT (reservedPages can be out of sync).
            const region = process.addressSpace.getRegion(effectiveAddress);
            if (region && region.kind === 'HEAP' && effectiveAddress + alignedSize <= region.base + region.size) {
                commitPreservingCommitted(effectiveAddress, alignedSize);
                clearDecommittedRange(effectiveAddress, alignedSize);
                Logger.verbose(LogCategory.KERNEL32, `VirtualAlloc -> 0x${effectiveAddress.toString(16)} (COMMIT in HEAP, size=${alignedSize})`);
                return effectiveAddress;
            }
            // Committing without prior reserve is invalid
            System.getInstance().scheduler.setLastError(ERROR_INVALID_ADDRESS);
            return fail(`MEM_COMMIT not within reserved region`);
        }

        profiler.start("VirtualAlloc:alloc");
        try {
            if (address === 0) {
                // Align to 64KB allocation granularity (not just 4KB page).
                // Windows VirtualAlloc always returns 64KB-aligned addresses.
                // FMallocWindows uses PoolIndirect[addr >> 16] for O(1) pool lookup.
                // If two pools share the same >> 16 index (within same 64KB chunk),
                // Free() decrements the WRONG pool's Taken counter → premature VirtualFree
                // → use-after-free of GNames/other critical data.
                //
                // MEM_TOP_DOWN (SmartHeap/Shw32, FastMM, …): highest available VA — share
                // the HEAP high frontier with the slab arena so pools stay segregated from
                // bottom-up HeapAlloc. Ignoring it handed low addresses and SmartHeap's
                // pool math eventually VirtualAlloc'd a multi-hundred-MB bogus size.
                if (flAllocationType & MEM_TOP_DOWN) {
                    address = process.memory.allocFromHigh(alignedSize, ALLOC_GRANULARITY);
                } else {
                    address = process.memory.alloc(alignedSize, 'HEAP', perms, ALLOC_GRANULARITY);
                }
            } else {
                process.memory.allocAt(address, alignedSize, 'HEAP', perms);
            }
        } catch (error) {
            profiler.end("VirtualAlloc:alloc");
            System.getInstance().scheduler.setLastError(ERROR_NOT_ENOUGH_MEMORY);
            const high = process.memory.getHighHeapReport?.();
            return fail(
                `Allocation failed: ${error}` +
                (high ? ` high={next=0x${high.next.toString(16)} slabTop=0x${high.slabTop.toString(16)} freeMB=${high.freeHighMB}}` : ''),
            );
        }
        profiler.end("VirtualAlloc:alloc");

        // allocFromHigh/alloc may round up to 64KB granularity — track the live block size.
        const committedSize = process.memory.getSize(address) ?? alignedSize;

        if (flAllocationType & MEM_RESERVE) {
            reservedPages.set(address, committedSize);
            Logger.verbose(LogCategory.KERNEL32, `VirtualAlloc: Reserved ${committedSize} bytes at 0x${address.toString(16)}`);
        }

        const trackedSize = virtualAllocRegions.get(address) ?? 0;
        if (committedSize > trackedSize) {
            virtualAllocRegions.set(address, committedSize);
        }

        if (flAllocationType & MEM_COMMIT) {
            profiler.start("VirtualAlloc:commit");
            const ptm = process.pageTableManager;
            if (ptm?.isPagingEnabled()) {
                ptm.commitPages(address, alignedSize);
            } else {
                process.addressSpace.fill(address, alignedSize, 0);
            }
            profiler.end("VirtualAlloc:commit");
            Logger.verbose(LogCategory.KERNEL32, `VirtualAlloc: Committed ${alignedSize} bytes at 0x${address.toString(16)} perms=${perms}`);
        }

        Logger.verbose(LogCategory.KERNEL32, `VirtualAlloc -> 0x${address.toString(16)} (size=${alignedSize})`);
        return address;
    };

    // VirtualAllocEx - ignore hProcess, delegate to VirtualAlloc (single-process emulator)
    exports['VirtualAllocEx'] = (ctx, mem, args) => {
        const innerArgs = [args[1], args[2], args[3], args[4]]; // skip hProcess
        const result = exports['VirtualAlloc'](ctx, mem, innerArgs);
        // VirtualAllocEx has 5 args = 20 bytes cleanup
        if (typeof result === 'object') return { ...result, stackCleanup: 20 };
        return { value: result, stackCleanup: 20 };
    };

    // VirtualFree - free virtual memory
    exports['VirtualFree'] = (ctx, mem, args) => {
        const lpAddress = args[0];
        const dwSize = args[1];
        const dwFreeType = args[2];

        Logger.verbose(LogCategory.KERNEL32, `VirtualFree(0x${lpAddress.toString(16)}, ${dwSize}, 0x${dwFreeType.toString(16)})`);

        const MEM_RELEASE = 0x8000;
        const MEM_DECOMMIT = 0x4000;
        const PAGE_SIZE = 0x1000;

        if (!lpAddress) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            Logger.warn(LogCategory.KERNEL32, 'VirtualFree: NULL address');
            return 0; // FALSE
        }

        if (dwFreeType !== MEM_RELEASE && dwFreeType !== MEM_DECOMMIT) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            Logger.warn(LogCategory.KERNEL32, `VirtualFree: invalid dwFreeType=0x${dwFreeType.toString(16)}`);
            return 0; // FALSE
        }

        const process = System.getInstance().process;
        if (!process) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            Logger.warn(LogCategory.KERNEL32, 'VirtualFree: process not available');
            return 0; // FALSE
        }

        if (dwFreeType === MEM_RELEASE) {
            // Win32: MEM_RELEASE requires dwSize == 0 and exact base from VirtualAlloc.
            if (dwSize !== 0) {
                System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
                Logger.warn(LogCategory.KERNEL32, `VirtualFree(MEM_RELEASE): dwSize must be 0, got ${dwSize}`);
                return 0; // FALSE
            }

            const trackedSize = virtualAllocRegions.get(lpAddress);
            if (trackedSize === undefined) {
                System.getInstance().scheduler.setLastError(ERROR_INVALID_ADDRESS);
                Logger.warn(LogCategory.KERNEL32,
                    `VirtualFree(MEM_RELEASE): 0x${lpAddress.toString(16)} is not a tracked VirtualAlloc base`);
                return 0; // FALSE
            }

            clearDecommittedRange(lpAddress, trackedSize);
            reservedPages.delete(lpAddress);
            virtualAllocRegions.delete(lpAddress);

            const allocSize = process.memory.getSize(lpAddress);
            if (allocSize === undefined) {
                Logger.warn(LogCategory.KERNEL32,
                    `VirtualFree(MEM_RELEASE): 0x${lpAddress.toString(16)} missing from allocations map`);
            } else {
                freeHeapBlock(process, lpAddress);
            }

            Logger.verbose(LogCategory.KERNEL32, `VirtualFree: Released and freed pages at 0x${lpAddress.toString(16)}`);
            return 1; // TRUE
        }

        // MEM_DECOMMIT path
        // Win32: dwSize must be non-zero.
        if (dwSize === 0) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            Logger.warn(LogCategory.KERNEL32, 'VirtualFree(MEM_DECOMMIT): dwSize must be non-zero');
            return 0; // FALSE
        }

        const alignedAddress = lpAddress & ~(PAGE_SIZE - 1);
        const alignedSize = Math.ceil((dwSize + (lpAddress - alignedAddress)) / PAGE_SIZE) * PAGE_SIZE;
        const trackedRange = findTrackedAllocRange(alignedAddress, alignedSize);
        if (!trackedRange) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_ADDRESS);
            Logger.warn(LogCategory.KERNEL32,
                `VirtualFree(MEM_DECOMMIT): range 0x${alignedAddress.toString(16)}..0x${(alignedAddress + alignedSize).toString(16)} is not tracked`);
            return 0; // FALSE
        }

        const ptm = process.pageTableManager;
        if (ptm?.isPagingEnabled()) {
            // Clear Present bit in PTEs; access will fault via #PF.
            ptm.decommitPages(alignedAddress, alignedSize);
        } else {
            // Fallback: poison bytes (pre-paging or paging disabled)
            process.addressSpace.fill(alignedAddress, alignedSize, 0xFE);
        }

        // Merge with existing decommitted entries to keep the map compact.
        // Remove any existing entries that overlap, then add the union range.
        let mergeBase = alignedAddress;
        let mergeEnd = alignedAddress + alignedSize;
        const toRemove: number[] = [];
        for (const [dcBase, dcSize] of decommittedPages) {
            const dcEnd = dcBase + dcSize;
            // Check if adjacent or overlapping
            if (dcEnd >= mergeBase && dcBase <= mergeEnd) {
                mergeBase = Math.min(mergeBase, dcBase);
                mergeEnd = Math.max(mergeEnd, dcEnd);
                toRemove.push(dcBase);
            }
        }
        for (const key of toRemove) decommittedPages.delete(key);
        decommittedPages.set(mergeBase, mergeEnd - mergeBase);

        Logger.verbose(LogCategory.KERNEL32,
            `VirtualFree: Decommitted ${alignedSize} bytes at 0x${alignedAddress.toString(16)}`);
        return 1; // TRUE
    };
    // VirtualProtect - change memory protection on a region
    exports['VirtualProtect'] = (ctx, mem, args) => {
        const lpAddress = args[0];
        const dwSize = args[1];
        const flNewProtect = args[2];
        const lpflOldProtect = args[3]; // OUT pointer

        const PAGE_SIZE = 0x1000;

        // Windows rounds lpAddress DOWN to page boundary and adjusts size to cover
        // the full range [alignedAddr, lpAddress + dwSize), rounded up to page size.
        const alignedAddr = lpAddress & ~(PAGE_SIZE - 1);
        const alignedSize = Math.ceil((dwSize + (lpAddress - alignedAddr)) / PAGE_SIZE) * PAGE_SIZE;
        const process = System.getInstance().process;
        if (!process) {
            Logger.error(LogCategory.KERNEL32, 'VirtualProtect: No active process');
            return 0;
        }

        // Get current region for old perms
        const region = process.addressSpace.getRegion(alignedAddr);
        if (!region) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_ADDRESS);
            Logger.warn(LogCategory.KERNEL32,
                `VirtualProtect: Invalid address 0x${alignedAddr.toString(16)}`);
            return 0;
        }

        // Write old protect flags back (if pointer valid)
        if (lpflOldProtect && lpflOldProtect + 4 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            let oldProtect = PAGE_NOACCESS;
            if (region.perms.includes('w')) {
                oldProtect = PAGE_READWRITE;
            } else if (region.perms.includes('x')) {
                oldProtect = PAGE_EXECUTE_READ;
            } else if (region.perms.includes('r')) {
                oldProtect = PAGE_READONLY;
            }
            view.setUint32(lpflOldProtect, oldProtect, true);
        }

        // Map new protect to perms using existing helper
        const newPerms = mapProtectToPerms(flNewProtect);

        // Apply protection. protect() requires exact (base, size) match; PE sub-pages
        // (e.g. 0x41f000 inside module at 0x400000) don't match, so it fails.
        const success = process.addressSpace.protect(alignedAddr, alignedSize, newPerms);
        if (!success) {
            const ptm = process.pageTableManager;
            if (ptm?.isPagingEnabled()) {
                ptm.setProtection(alignedAddr, alignedSize, flNewProtect);
            }
            // Fake success for sub-region (e.g. page inside PE). App expects TRUE;
            // otherwise CRT aborts via INT 0x29. We already wrote lpflOldProtect.
            Logger.verbose(LogCategory.KERNEL32,
                `VirtualProtect(0x${alignedAddr.toString(16)}, ${alignedSize}) faked success (sub-region)`);
            return 1;
        }

        // Also update PTEs if paging is active. The read map is updated by the
        // PTE-level operation itself.
        const ptm = process.pageTableManager;
        if (ptm?.isPagingEnabled()) {
            ptm.setProtection(alignedAddr, alignedSize, flNewProtect, false);
        }

        Logger.verbose(LogCategory.KERNEL32,
            `VirtualProtect(0x${alignedAddr.toString(16)}, ${alignedSize}) -> ${newPerms}`);

        return 1; // TRUE
    };

    // VirtualLock - Lock pages in memory to prevent paging (no-op in emulator)
    exports['VirtualLock'] = (ctx, mem, args) => {
        const lpAddress = args[0];
        const dwSize = args[1];

        Logger.verbose(LogCategory.KERNEL32,
            `VirtualLock(0x${lpAddress.toString(16)}, ${dwSize}) - no-op`);

        // We don't page memory, so this is always successful
        return 1; // TRUE
    };

    // VirtualUnlock - Unlock pages in memory (no-op in emulator)
    exports['VirtualUnlock'] = (ctx, mem, args) => {
        const lpAddress = args[0];
        const dwSize = args[1];

        Logger.verbose(LogCategory.KERNEL32,
            `VirtualUnlock(0x${lpAddress.toString(16)}, ${dwSize}) - no-op`);

        // We don't page memory, so this is always successful
        return 1; // TRUE
    };

    // SetHandleCount - set handle count (legacy function, mostly no-op)
    exports['SetHandleCount'] = (ctx, mem, args) => {
        const uNumber = args[0];

        Logger.log(LogCategory.KERNEL32, `SetHandleCount called: uNumber=${uNumber}`);

        // This is a legacy function from 16-bit Windows
        // In 32-bit Windows, it's mostly a no-op but returns the current handle count
        // Return a reasonable default value
        return 512; // Default handle count
    };

    // RtlZeroMemory - fill memory with zeros (ntdll function, exported from kernel32)
    // Note: This is the SAME as ZeroMemory macro, which is defined as:
    // #define ZeroMemory(Destination,Length) RtlZeroMemory((Destination),(Length))
    exports['RtlZeroMemory'] = (ctx, mem, args) => {
        const dest = args[0];
        const length = args[1];

        if (!dest || length === 0) return 0;

        Logger.verbose(LogCategory.KERNEL32, `RtlZeroMemory called: dest=0x${dest.toString(16)} length=${length}`);

        // Use efficient chunk-based zeroing (same as msvcrt.memset)
        const size = length >>> 0;
        const chunk = new Uint8Array(Math.min(4096, size));
        let offset = 0;
        while (offset < size) {
            const slice = chunk.subarray(0, Math.min(chunk.length, size - offset));
            Mem.writeBytes(dest + offset, slice);
            offset += slice.length;
        }
        return 0;
    };

    // RtlFillMemory - fill memory with a byte value (ntdll function)
    // Note: FillMemory macro is defined as:
    // #define FillMemory(Destination,Length,Fill) RtlFillMemory((Destination),(Length),(Fill))
    exports['RtlFillMemory'] = (ctx, mem, args) => {
        const dest = args[0];
        const length = args[1];
        const fill = args[2] & 0xff;

        if (!dest || length === 0) return 0;

        Logger.verbose(LogCategory.KERNEL32, `RtlFillMemory called: dest=0x${dest.toString(16)} length=${length} fill=0x${fill.toString(16)}`);

        const size = length >>> 0;
        const chunk = new Uint8Array(Math.min(4096, size));
        chunk.fill(fill);
        let offset = 0;
        while (offset < size) {
            const slice = chunk.subarray(0, Math.min(chunk.length, size - offset));
            Mem.writeBytes(dest + offset, slice);
            offset += slice.length;
        }
        return 0;
    };

    // LocalLock - Lock local memory object and return pointer
    exports['LocalLock'] = (ctx, mem, args) => {
        const hMem = args[0];

        if (!hMem) {
            Logger.warn(LogCategory.KERNEL32, 'LocalLock: NULL handle');
            return 0;
        }

        const ptr = lockMoveableOrFixed(hMem, mem);
        Logger.verbose(LogCategory.KERNEL32, `LocalLock: hMem=0x${hMem.toString(16)} -> 0x${ptr.toString(16)}`);
        return ptr;
    };

    // LocalUnlock - Unlock local memory object
    exports['LocalUnlock'] = (ctx, mem, args) => {
        const hMem = args[0];

        if (!hMem) {
            Logger.warn(LogCategory.KERNEL32, 'LocalUnlock: NULL handle');
            return 0;
        }

        const ret = unlockMoveableOrFixed(hMem);
        Logger.verbose(LogCategory.KERNEL32, `LocalUnlock: hMem=0x${hMem.toString(16)} -> ${ret}`);
        return ret;
    };

    // LocalReAlloc - Reallocate local memory
    exports['LocalReAlloc'] = (ctx, mem, args) => {
        const hMem = args[0];
        const uBytes = args[1] >>> 0;
        const uFlags = args[2];
        const LMEM_MODIFY = 0x0080;
        const LMEM_DISCARDABLE = 0x0100;
        const HEAP_ZERO_MEMORY = 0x00000008;

        if (!hMem) {
            Logger.warn(LogCategory.KERNEL32, 'LocalReAlloc: NULL handle');
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }

        Logger.log(LogCategory.KERNEL32, `LocalReAlloc: hMem=0x${hMem.toString(16)}, size=${uBytes}, flags=0x${uFlags.toString(16)}`);

        const system = System.getInstance();
        const process = system.process;
        if (!process) {
            Logger.warn(LogCategory.KERNEL32, 'LocalReAlloc: No process instance');
            return 0;
        }

        resetMoveableTables();
        const zeroInit = (uFlags & LMEM_ZEROINIT) !== 0;

        if (isMoveableHandle(hMem)) {
            const desc = moveableDescFromHandle(hMem);
            if (process.memory.getSize(desc) !== MEM_ENTRY_SIZE) {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return 0;
            }
            const flags = Mem.readUint16(desc) ?? 0;
            if (!(flags & MEM_FLAG_USED)) {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return 0;
            }
            const lock = Mem.readUint8(desc + 2) ?? 0;

            if (uFlags & LMEM_MODIFY) {
                if (uFlags & LMEM_DISCARDABLE) {
                    Mem.writeUint16(desc, flags | MEM_FLAG_DISCARDABLE);
                }
                return hMem;
            }
            if (uFlags & LMEM_DISCARDABLE) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            if (uBytes > 0) {
                const ret = reallocMoveableBlock(process, mem, hMem, uBytes, zeroInit);
                if (!ret) system.scheduler.setLastError(8);
                Logger.log(LogCategory.KERNEL32, `LocalReAlloc moveable: handle=0x${ret.toString(16)}`);
                return ret;
            }
            if ((uFlags & LMEM_MOVEABLE) && !lock) {
                const ret = discardMoveableBlock(process, hMem);
                Logger.log(LogCategory.KERNEL32, `LocalReAlloc moveable discard: handle=0x${ret.toString(16)}`);
                return ret;
            }
            system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        // Fixed pointer — same contract as HeapReAlloc on the underlying block.
        if (!fixedLocalHandles.has(hMem)) {
            system.scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }
        if (uFlags & LMEM_MODIFY) {
            return hMem;
        }
        if (uFlags & LMEM_DISCARDABLE) {
            system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        const oldUserSize = fixedLocalUserSizes.get(hMem) ?? uBytes;
        const ret = exports['HeapReAlloc'](ctx, mem, [
            PROCESS_HEAP_HANDLE,
            zeroInit ? HEAP_ZERO_MEMORY : 0,
            hMem,
            uBytes,
        ]) as number;
        if (ret && ret !== hMem) {
            unregisterFixedLocalHandle(hMem);
            registerFixedLocalHandle(ret, uBytes > 0 ? uBytes : oldUserSize);
        } else if (ret && uBytes > 0) {
            fixedLocalUserSizes.set(ret, uBytes);
        }
        return ret;
    };

    // GlobalAlloc - allocate global memory (Win32: mostly wrapper around LocalAlloc/HeapAlloc)
    exports['GlobalAlloc'] = (ctx, mem, args) => {
        const uFlags = args[0];
        let dwBytes = args[1] >>> 0;

        Logger.verbose(LogCategory.KERNEL32, `GlobalAlloc(0x${uFlags.toString(16)}, ${dwBytes})`);

        // GlobalAlloc rejects 0-byte fixed blocks; LocalAlloc allows them.
        if (!(uFlags & LMEM_MOVEABLE) && dwBytes === 0) {
            dwBytes = 1;
        }

        // GMEM_ZEROINIT shares bit with LMEM_ZEROINIT
        const handle = exports['LocalAlloc'](ctx, mem, [uFlags, dwBytes]) as number;
        Logger.log(LogCategory.KERNEL32,
            `GlobalAlloc(flags=0x${(uFlags >>> 0).toString(16)}, ${dwBytes}) -> 0x${(handle >>> 0).toString(16)}`);
        return handle;
    };

    // GlobalFree - free global memory (returns NULL on success)
    exports['GlobalFree'] = (ctx, mem, args) => {
        const hMem = args[0];
        const userSize = fixedLocalUserSizes.get(hMem);
        Logger.log(LogCategory.KERNEL32,
            `GlobalFree(0x${(hMem >>> 0).toString(16)}${userSize !== undefined ? ` userSize=${userSize}` : ""})`);
        return exports['LocalFree'](ctx, mem, [hMem]) as number;
    };

    // GlobalReAlloc - reallocate global memory
    exports['GlobalReAlloc'] = (ctx, mem, args) => {
        const hMem = args[0];
        const dwBytes = args[1] >>> 0;
        const uFlags = args[2];
        const GMEM_MODIFY = 0x0080;
        const GMEM_DISCARDABLE = 0x0100;

        Logger.verbose(LogCategory.KERNEL32, `GlobalReAlloc(0x${hMem.toString(16)}, ${dwBytes}, 0x${uFlags.toString(16)})`);

        if (!(uFlags & GMEM_MODIFY) && isMoveableHandle(hMem)) {
            resetMoveableTables();
            const process = System.getInstance().process;
            if (process) {
                const desc = moveableDescFromHandle(hMem);
                if (process.memory.getSize(desc) === MEM_ENTRY_SIZE) {
                    const lock = Mem.readUint8(desc + 2) ?? 0;
                    if (lock && (!dwBytes || (uFlags & GMEM_DISCARDABLE))) {
                        return 0;
                    }
                }
            }
        }

        return exports['LocalReAlloc'](ctx, mem, [hMem, dwBytes, uFlags]) as number;
    };

    // GlobalLock - lock global memory handle and return pointer
    exports['GlobalLock'] = (ctx, mem, args) => {
        const hMem = args[0];
        if (!hMem) {
            Logger.warn(LogCategory.KERNEL32, 'GlobalLock: NULL handle');
            return 0;
        }
        const ptr = lockMoveableOrFixed(hMem, mem);
        Logger.log(LogCategory.KERNEL32,
            `GlobalLock(hMem=0x${(hMem >>> 0).toString(16)}) -> 0x${(ptr >>> 0).toString(16)}`);
        return ptr;
    };

    // GlobalUnlock - unlock global memory handle
    exports['GlobalUnlock'] = (ctx, mem, args) => {
        const hMem = args[0];
        if (!hMem) {
            Logger.warn(LogCategory.KERNEL32, 'GlobalUnlock: NULL handle');
            return 0;
        }
        const ret = unlockMoveableOrFixed(hMem);
        Logger.verbose(LogCategory.KERNEL32, `GlobalUnlock: hMem=0x${hMem.toString(16)} -> ${ret}`);
        return ret;
    };

    // GlobalFlags - Get flags and lock count for global memory
    exports['GlobalFlags'] = (ctx, mem, args) => {
        const hMem = args[0];

        if (!hMem) {
            Logger.warn(LogCategory.KERNEL32, 'GlobalFlags: NULL handle');
            return 0xFFFFFFFF; // GMEM_INVALID_HANDLE
        }

        resetMoveableTables();
        const process = System.getInstance().process;
        if (!process) return 0xFFFFFFFF;

        if (isMoveableHandle(hMem)) {
            const desc = moveableDescFromHandle(hMem);
            if (process.memory.getSize(desc) !== MEM_ENTRY_SIZE) {
                return 0xFFFFFFFF;
            }
            const flags = Mem.readUint16(desc) ?? 0;
            if (!(flags & MEM_FLAG_USED)) return 0xFFFFFFFF;
            const lock = Mem.readUint8(desc + 2) ?? 0;
            Logger.verbose(LogCategory.KERNEL32, `GlobalFlags: hMem=0x${hMem.toString(16)} -> lock=${lock}`);
            return lock & 0xFF;
        }

        if (!isFixedHeapPointer(process, hMem)) {
            return 0xFFFFFFFF;
        }

        Logger.verbose(LogCategory.KERNEL32, `GlobalFlags: hMem=0x${hMem.toString(16)} -> 0`);
        return 0;
    };

    // GlobalSize - size of a global memory block
    exports['GlobalSize'] = (ctx, mem, args) => {
        const hMem = args[0];
        if (!hMem) {
            Logger.warn(LogCategory.KERNEL32, 'GlobalSize: NULL handle');
            return 0;
        }
        const size = sizeOfGlobalOrLocal(hMem);
        Logger.verbose(LogCategory.KERNEL32, `GlobalSize: hMem=0x${hMem.toString(16)} -> ${size}`);
        return size;
    };

    // GlobalCompact - Win16 legacy; on Win32 a no-op that reports the size of the largest free
    // block (games call it to ask "how much can I allocate?"). dwMinFree is ignored (it was a
    // Win16 "try to free at least N bytes" hint). Return a generous value consistent with
    // GlobalMemoryStatus' available-physical figure so feasibility/allocation checks pass.
    exports['GlobalCompact'] = (_ctx, _mem, args) => {
        const total = System.getInstance().process?.getCurrentMemory().length ?? (256 * 1024 * 1024);
        const largestFree = Math.max(0, Math.floor(total * 0.75)) >>> 0;
        Logger.verbose(LogCategory.KERNEL32, `GlobalCompact(dwMinFree=0x${(args[0] >>> 0).toString(16)}) -> ${largestFree}`);
        return largestFree;
    };

    // GlobalHandle - Get handle from memory pointer
    exports['GlobalHandle'] = (ctx, mem, args) => {
        const pMem = args[0];

        if (!pMem) {
            Logger.warn(LogCategory.KERNEL32, 'GlobalHandle: NULL pointer');
            return 0;
        }

        resetMoveableTables();
        const handle = dataPtrToMoveableHandle.get(pMem);
        if (handle !== undefined) {
            Logger.verbose(LogCategory.KERNEL32, `GlobalHandle: pMem=0x${pMem.toString(16)} -> handle=0x${handle.toString(16)}`);
            return handle;
        }

        const process = System.getInstance().process;
        if (process && isFixedHeapPointer(process, pMem)) {
            Logger.verbose(LogCategory.KERNEL32, `GlobalHandle: pMem=0x${pMem.toString(16)} -> handle=0x${pMem.toString(16)}`);
            return pMem;
        }

        Logger.warn(LogCategory.KERNEL32, `GlobalHandle: unknown pointer 0x${pMem.toString(16)}`);
        return 0;
    };

    // Helper: check if any byte in [addr, addr+size) falls in a decommitted page.
    // On real Windows, accessing decommitted pages triggers an access violation.
    const isInDecommittedRange = (addr: number, size: number): boolean => {
        const end = addr + size;
        for (const [dcBase, dcSize] of decommittedPages) {
            const dcEnd = dcBase + dcSize;
            if (addr < dcEnd && end > dcBase) return true;
        }
        return false;
    };

    // IsBadReadPtr - test whether the calling process has read access to a memory range
    // Returns FALSE (0) if readable, TRUE (non-zero) if not
    exports['IsBadReadPtr'] = (ctx, mem, args) => {
        const lp = args[0] >>> 0;
        const ucb = args[1] >>> 0;

        // NULL pointer with zero size is valid per Windows docs
        if (ucb === 0) return 0;
        // NULL pointer with non-zero size is bad
        if (lp === 0) return 1;
        // Check bounds against guest memory
        if (lp + ucb > mem.length) return 1;
        // Decommitted pages are inaccessible on real Windows
        if (isInDecommittedRange(lp, ucb)) return 1;

        return 0; // Readable
    };

    // IsBadWritePtr - test whether the calling process has write access to a memory range
    exports['IsBadWritePtr'] = (ctx, mem, args) => {
        const lp = args[0] >>> 0;
        const ucb = args[1] >>> 0;

        if (ucb === 0) return 0;
        if (lp === 0) return 1;
        if (lp + ucb > mem.length) return 1;
        // Decommitted pages are inaccessible on real Windows
        if (isInDecommittedRange(lp, ucb)) return 1;

        return 0; // Writable
    };

    // Obsolete 16-bit compatibility aliases — on 32-bit Windows behave like IsBadReadPtr/IsBadWritePtr.
    exports['IsBadHugeReadPtr'] = exports['IsBadReadPtr'];
    exports['IsBadHugeWritePtr'] = exports['IsBadWritePtr'];

    // IsBadCodePtr - test whether the calling process has read access to the specified address
    exports['IsBadCodePtr'] = (ctx, mem, args) => {
        const lp = args[0] >>> 0;

        if (lp === 0) return 1;
        if (lp >= mem.length) return 1;

        return 0; // Valid code pointer
    };

    // IsBadStringPtrA - test whether the calling process has read access to a string
    // Reads until null terminator or ucchMax characters
    exports['IsBadStringPtrA'] = (ctx, mem, args) => {
        const lpsz = args[0] >>> 0;
        const ucchMax = args[1] >>> 0;

        if (lpsz === 0) return 1; // Bad pointer
        if (lpsz >= mem.length) return 1;

        // Check that we can read up to ucchMax chars or null terminator
        const end = Math.min(lpsz + ucchMax, mem.length);
        if (end > mem.length) return 1;

        return 0; // Valid string pointer
    };

    // IsBadStringPtrW - wide-char variant of IsBadStringPtrA (ucchMax is in WCHARs)
    exports['IsBadStringPtrW'] = (ctx, mem, args) => {
        const lpsz = args[0] >>> 0;
        const ucchMax = args[1] >>> 0;

        if (lpsz === 0) return 1;
        if (lpsz >= mem.length) return 1;

        const end = Math.min(lpsz + ucchMax * 2, mem.length);
        if (end > mem.length) return 1;

        return 0;
    };

    // BOOL HeapLock(HANDLE hHeap)
    exports['HeapLock'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.KERNEL32, `HeapLock(0x${args[0].toString(16)}) -> stub`);
        return 1; // TRUE
    };

    // BOOL HeapUnlock(HANDLE hHeap)
    exports['HeapUnlock'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.KERNEL32, `HeapUnlock(0x${args[0].toString(16)}) -> stub`);
        return 1; // TRUE
    };

    // BOOL HeapWalk(HANDLE hHeap, LPPROCESS_HEAP_ENTRY lpEntry)
    //
    // Enumerates live HEAP-bucket allocations as PROCESS_HEAP_ENTRY_BUSY blocks so
    // third-party heap managers (SmartHeap/Shw32) can validate a free()'d pointer
    // against the OS heap instead of raising MEM_BAD_POINTER. Stateful per the
    // Win32 contract: lpData==0 starts a fresh walk; otherwise advance from the
    // block the caller fed back.
    //
    // sizeof(PROCESS_HEAP_ENTRY) on x86 = 28 bytes:
    //   +0  PVOID lpData
    //   +4  DWORD cbData
    //   +8  BYTE  cbOverhead
    //   +9  BYTE  iRegionIndex
    //   +10 WORD  wFlags          (PROCESS_HEAP_ENTRY_BUSY = 0x0004)
    //   +12 union { Block{ hMem; dwReserved[3] } | Region{...} }  (16 bytes)
    const PROCESS_HEAP_ENTRY_BUSY = 0x0004;
    const ERROR_NO_MORE_ITEMS = 259;

    const writeHeapEntry = (
        view: DataView,
        lpEntry: number,
        block: { addr: number; size: number; busy: boolean },
    ): void => {
        view.setUint32(lpEntry + 0, block.addr >>> 0, true);   // lpData
        view.setUint32(lpEntry + 4, block.size >>> 0, true);   // cbData
        view.setUint8(lpEntry + 8, 0);                          // cbOverhead
        view.setUint8(lpEntry + 9, 0);                          // iRegionIndex
        // Busy blocks carry PROCESS_HEAP_ENTRY_BUSY; free blocks report wFlags=0
        // (matches Win32/RtlWalkHeap — see wine kernelbase HeapWalk).
        view.setUint16(lpEntry + 10, block.busy ? PROCESS_HEAP_ENTRY_BUSY : 0, true); // wFlags
        // Block union: hMem + dwReserved[3]
        view.setUint32(lpEntry + 12, 0, true);
        view.setUint32(lpEntry + 16, 0, true);
        view.setUint32(lpEntry + 20, 0, true);
        view.setUint32(lpEntry + 24, 0, true);
    };

    exports['HeapWalk'] = (ctx, mem, args) => {
        const hHeap = args[0] >>> 0;
        const lpEntry = args[1] >>> 0;
        const system = System.getInstance();
        const process = system.process;

        if (!lpEntry || !process || lpEntry + 28 > mem.length) {
            system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        ensureHeapManagerProcess();
        if (!isRecognizedHeapHandle(hHeap)) {
            system.scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const prevLpData = view.getUint32(lpEntry, true) >>> 0;

        let nextIndex: number;
        if (prevLpData === 0) {
            // Fresh walk — rebuild the snapshot for this heap.
            heapWalkState = { entryPtr: lpEntry, snapshot: buildHeapWalkSnapshot(view), index: -1 };
            nextIndex = 0;
        } else if (
            heapWalkState &&
            heapWalkState.entryPtr === lpEntry &&
            heapWalkState.snapshot[heapWalkState.index]?.addr === prevLpData
        ) {
            // Linear continuation of the cached walk — O(1).
            nextIndex = heapWalkState.index + 1;
        } else {
            // State lost (interleaved walk / re-entered) — relocate prevLpData.
            const snapshot = buildHeapWalkSnapshot(view);
            let found = -1;
            for (let i = 0; i < snapshot.length; i++) {
                if (snapshot[i].addr === prevLpData) { found = i; break; }
            }
            heapWalkState = { entryPtr: lpEntry, snapshot, index: found };
            nextIndex = found + 1;
        }

        const snapshot = heapWalkState!.snapshot;
        if (nextIndex < 0 || nextIndex >= snapshot.length) {
            heapWalkState = null;
            system.scheduler.setLastError(ERROR_NO_MORE_ITEMS);
            return 0; // FALSE — walk complete
        }

        heapWalkState!.index = nextIndex;
        writeHeapEntry(view, lpEntry, snapshot[nextIndex]);
        return 1; // TRUE
    };

    // DWORD GetProcessHeaps(DWORD NumberOfHeaps, PHANDLE ProcessHeaps)
    // Reports the default heap plus every live HeapCreate'd heap. SmartHeap walks
    // each to validate delegated blocks, so an undercount (the old "always 1") hid
    // Python's HeapCreate'd heap and broke validation.
    exports['GetProcessHeaps'] = (ctx, mem, args) => {
        const numberOfHeaps = args[0] >>> 0;
        const processHeaps = args[1] >>> 0;
        ensureHeapManagerProcess();

        const handles = [PROCESS_HEAP_HANDLE, ...createdHeaps];
        const total = handles.length;

        // Only fill the buffer if it can hold every handle (Win32 contract: when
        // the return value exceeds NumberOfHeaps the buffer is left untouched and
        // the caller is expected to retry with a larger array).
        if (processHeaps && numberOfHeaps >= total) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            for (let i = 0; i < total; i++) {
                view.setUint32(processHeaps + i * 4, handles[i] >>> 0, true);
            }
        }
        Logger.verbose(LogCategory.KERNEL32, `GetProcessHeaps(${numberOfHeaps}) -> ${total} heaps`);
        return total;
    };

    // HLOCAL LocalHandle(LPCVOID pMem)
    // In our implementation handles ARE pointers, so just return the pointer
    exports['LocalHandle'] = (ctx, mem, args) => {
        const pMem = args[0];
        Logger.verbose(LogCategory.KERNEL32, `LocalHandle(0x${pMem.toString(16)}) -> 0x${pMem.toString(16)}`);
        return pMem || 0;
    };

    return exports;
})();

/**
 * DevTools/harness: walk VirtualQuery the way SmartHeap does (addr += RegionSize)
 * and report GetSystemInfo max + largest FREE/RESERVE. Diagnoses phantom TOP_DOWN
 * MemPoolPreAllocate sizes (BoD ~807MB OOM).
 */
(globalThis as any).getVaMap = () => {
    const process = System.getInstance().process;
    if (!process) return null;
    const mem = process.getCurrentMemory();
    const memLen = mem.length >>> 0;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const buf = process.memory.alloc(0x1000, 'HEAP');
    const ctx: X86Context = {
        eax: 0, ecx: 0, edx: 0, ebx: 0,
        esp: 0, ebp: 0, esi: 0, edi: 0,
        eip: 0, eflags: 0,
    };
    try {
        const gsi = exports['GetSystemInfo'];
        const vq = exports['VirtualQuery'];
        if (typeof gsi === 'function') gsi(ctx, mem, [buf]);
        const minApp = view.getUint32(buf + 8, true) >>> 0;
        const maxApp = view.getUint32(buf + 12, true) >>> 0;

        const MEM_FREE = 0x10000, MEM_RESERVE = 0x2000, MEM_COMMIT = 0x1000;
        const row = () => {
            const base = view.getUint32(buf + 0, true) >>> 0;
            const allocBase = view.getUint32(buf + 4, true) >>> 0;
            const regionSize = view.getUint32(buf + 12, true) >>> 0;
            const state = view.getUint32(buf + 16, true) >>> 0;
            const type = view.getUint32(buf + 24, true) >>> 0;
            const stateName = state === MEM_FREE ? 'FREE' : state === MEM_RESERVE ? 'RESERVE' : state === MEM_COMMIT ? 'COMMIT' : `0x${state.toString(16)}`;
            return {
                base: `0x${base.toString(16)}`,
                allocBase: `0x${allocBase.toString(16)}`,
                size: regionSize,
                sizeHex: `0x${regionSize.toString(16)}`,
                sizeMB: +(regionSize / 1048576).toFixed(2),
                state: stateName,
                type: `0x${type.toString(16)}`,
            };
        };
        const probe = (a: number) => {
            const rc = typeof vq === 'function' ? (vq(ctx, mem, [a, buf, 28]) as number) : 0;
            if (!rc) return { addr: `0x${a.toString(16)}`, rc: 0 };
            return { addr: `0x${a.toString(16)}`, rc, ...row() };
        };
        // TOP_DOWN walk (SmartHeap MemPoolPreAllocate style): start at maxApp, step by RegionSize down.
        const topDown: Array<Record<string, unknown>> = [];
        let addr = maxApp >>> 0;
        let steps = 0;
        while (steps < 4096) {
            steps++;
            const rc = typeof vq === 'function' ? (vq(ctx, mem, [addr, buf, 28]) as number) : 0;
            if (!rc) {
                topDown.push({ addr: `0x${addr.toString(16)}`, rc: 0 });
                // Skip into backed RAM if we're still above memLen
                if (addr >= memLen) {
                    addr = memLen > 0 ? ((memLen - 1) >>> 0) : 0;
                    continue;
                }
                break;
            }
            const r = row();
            topDown.push({ addr: `0x${addr.toString(16)}`, ...r });
            const base = parseInt(String(r.base).slice(2), 16) >>> 0;
            if (base === 0) break;
            addr = (base - 1) >>> 0;
            if (addr >= 0x90000000) break; // wrapped
        }
        const freeish = topDown
            .filter((r) => r.state === 'FREE' || r.state === 'RESERVE')
            .slice()
            .sort((a, b) => (b.size as number) - (a.size as number));
        return {
            memLen,
            memLenHex: `0x${memLen.toString(16)}`,
            minApp: `0x${minApp.toString(16)}`,
            maxApp: `0x${maxApp.toString(16)}`,
            high: process.memory.getHighHeapReport?.() ?? null,
            steps,
            topDownHead: topDown.slice(0, 24),
            topFreeOrReserve: freeish.slice(0, 16),
            largestFreeMB: freeish.find((r) => r.state === 'FREE')?.sizeMB ?? 0,
            largestReserveMB: freeish.find((r) => r.state === 'RESERVE')?.sizeMB ?? 0,
            probes: {
                atMemLen: probe(memLen),
                atMemLenMinusPage: probe(memLen > 0x1000 ? memLen - 0x1000 : 0),
                at2GB: probe(0x7FFE0000),
                atSurface: probe(MEM_SURFACE_BASE),
                atSurfacePlus8M: probe(MEM_SURFACE_BASE + 0x800000),
                at0x0D904000: probe(0x0D904000),
            },
        };
    } finally {
        try { process.memory.free(buf); } catch { /* ignore */ }
    }
};

/**
 * Register fast-path implementations for high-frequency heap operations.
 * Keeps heap bookkeeping in JS AddressSpace/MemoryManager, but bypasses full thunk marshalling.
 *
 * These run INSTEAD of exports['HeapAlloc'/'HeapFree'], so every slab invariant those
 * carry has to be honoured here as well or it is silently gone: the fast path is the
 * tier that actually serves a slab fallthrough.
 */
export function registerFastPathHeapFunctions(dispatcher: any): void {
    if (!dispatcher || typeof dispatcher.registerFastPath !== 'function') return;

    // A refused allocation is what the guest turns into std::bad_alloc, so it must be
    // as loud here as in the slow path — the fast path is the tier that actually serves
    // the call, and a silent 0 leaves the resulting crash with no cause in the log.
    let refusalLogCount = 0;
    const reportFastPathAllocFailure = (dwBytes: number, why: string, view: DataView, esp: number): void => {
        if (refusalLogCount >= 40) return;
        refusalLogCount++;
        // [ESP] is the guest return address — the only thing that names WHICH code asked
        // for the size. The thunk stub's own EIP is the same for every caller.
        let caller = 0;
        try { caller = view.getUint32(esp, true) >>> 0; } catch { /* torn stack */ }
        const process = System.getInstance().process;
        const registry: any = process?.moduleRegistry;
        const sym = registry?.resolveAddress?.(caller) ?? "";
        // The immediate caller is always the CRT allocator, and the frame-pointer walk is
        // unreliable over FPO code (it invents repeated frames). Scan raw stack words
        // instead and keep the ones that land in a loaded module — those are the real
        // return addresses, in order.
        const chain: string[] = [];
        try {
            for (let off = 0; off < 0x200 && chain.length < 14; off += 4) {
                const w = view.getUint32(esp + off, true) >>> 0;
                const s = registry?.resolveAddress?.(w);
                if (s) chain.push(`+0x${off.toString(16)}:${s}`);
            }
        } catch { /* torn stack */ }
        // The size came from an API the guest called just before; the ring names which.
        let recent = "";
        try {
            const d: any = (process as any)?.dispatcher;
            recent = (d?.getLastWinApiCalls?.(24) ?? []).join(" | ");
        } catch { /* best-effort */ }
        Logger.warn(LogCategory.KERNEL32,
            `HeapAlloc (fast path) refused ${dwBytes} bytes (0x${dwBytes.toString(16)}, ${why}) ` +
            `caller=0x${caller.toString(16)}${sym ? ` ${sym}` : ""}\n  stack: ${chain.join(" | ")}` +
            `\n  recent: ${recent}`);
    };

    const heapAllocFastPath: FastPathImplementation = (cpu, mem8, _mem32, view) => {
        const esp = cpu.reg32[4] >>> 0;
        if (esp + 16 > mem8.length) return null;

        const dwFlags = view.getUint32(esp + 8, true) >>> 0;
        const dwBytes = view.getUint32(esp + 12, true) >>> 0;
        const system = System.getInstance();
        const process = system.process;
        if (!process) return null;

        if (dwBytes === 0) {
            system.scheduler.setLastError(HEAP_OOM_ERROR);
            return 0;
        }

        // A sub-4KB alloc reaching JS at all means the inline stub and the WASM hypercall
        // both fell through, i.e. the arena is full. This is the ONLY signal the arena has
        // to grow, and it arrives here — not at the slow path below us.
        if (dwBytes <= HEAP_SMALL_ALLOC_MAX) maybeGrowHeapSlab();

        const zeroMemory = (dwFlags & HEAP_ZERO_MEMORY_FLAG) !== 0 || DEBUG_FORCE_ZERO_HEAP_FAST_PATH;
        const memSize = process.getCurrentMemory().length >>> 0;
        if (dwBytes > memSize || dwBytes > HEAP_FAST_PATH_MAX_ALLOC) {
            system.scheduler.setLastError(HEAP_OOM_ERROR);
            reportFastPathAllocFailure(dwBytes, "size", view, esp);
            return 0;
        }

        try {
            const allocBytes = dwBytes <= HEAP_SMALL_ALLOC_MAX ? alignSmallAlloc(dwBytes) : dwBytes;
            const address = process.memory.alloc(allocBytes) >>> 0;
            if (zeroMemory) {
                mem8.fill(0, address, address + allocBytes);
            }
            return address;
        } catch (e) {
            system.scheduler.setLastError(HEAP_OOM_ERROR);
            reportFastPathAllocFailure(dwBytes, `alloc: ${e}`, view, esp);
            return 0;
        }
    };

    const heapFreeFastPath: FastPathImplementation = (cpu, mem8, _mem32, view) => {
        const esp = cpu.reg32[4] >>> 0;
        const system = System.getInstance();
        const process = system.process;
        if (!process) return null;
        if (esp + 16 > mem8.length) return null;

        const lpMem = view.getUint32(esp + 12, true) >>> 0;
        // A slab-resident pointer is an interior offset, not a root allocation:
        // process.memory.free would mistarget the enclosing arena. The slow path owns
        // that case (retired-generation no-op + double-free diagnostics) — defer to it.
        // VirtualAlloc regions also need the slow path (refuse with ERROR_INVALID_PARAMETER).
        if (lpMem !== 0) {
            if (isInAnySlab(lpMem) || isInVirtualAllocRegion(lpMem)) return null;
            process.memory.free(lpMem);
        }
        return 1;
    };

    dispatcher.registerFastPath('kernel32', 'HeapAlloc', heapAllocFastPath, { trivial: true });
    dispatcher.registerFastPath('kernel32', 'HeapFree', heapFreeFastPath, { trivial: true });
    Logger.log(LogCategory.KERNEL32, 'Registered fast path for heap functions');
}

