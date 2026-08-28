import { Logger, LogCategory } from "../logger";
import {
    MEM_HEAP_BASE,
    MEM_HEAP_SIZE,
    MEM_SURFACE_BASE,
    MEM_HEAP_HIGH_BASE,
    MEM_SURFACE_SIZE,
    MEM_THUNK_CODE_BASE,
    MEM_THUNK_CODE_SIZE,
    MEM_THUNK_DATA_BASE,
    MEM_THUNK_DATA_SIZE,
    MEM_GUARD_BASE,
    MEM_GUARD_SIZE,
    MEM_ROM_BASE,
    MEM_ROM_SIZE,
} from "../cpu/emulator-config";

export type RegionKind =
    | "LOW_MEM"
    | "HEAP"
    | "HEAP_HIGH"
    | "SURFACE"
    | "THUNK_CODE"
    | "THUNK_DATA"
    | "CALLBACK_STUB"
    | "SPIN_LOOP"
    | "ROM"
    | "OPFS"
    | "BORROWED"
    | "RESERVED";

export type RegionPerms = "r" | "rw" | "rx" | "rwx" | "noaccess";

export interface RegionEntry {
    id: number;
    base: number;
    size: number;
    perms: RegionPerms;
    kind: RegionKind;
    owner?: string;
    tag?: string;
    allowOverlap?: boolean;
    skipOverlapCheck?: boolean;
}

interface LayoutBucket {
    base: number;
    size: number;
    perms: RegionPerms;
    kind: RegionKind;
    owner?: string;
    tag?: string;
    allowOverlap?: boolean;
}

// ── fastmem write map (bit0 = base-writable) ──────────────────────
// Best-effort, never throws (AddressSpace stays usable in isolated tests). Sets/clears
// bit0 over a byte range. The Rust setter authoritatively
// clamps SET to the identity-RAM envelope (< ram, above low-mem, outside the guard zone),
// so an over-wide range is safe; callers still gate SET on writable-RAM kind + perms so
// non-RAM regions (ROM/THUNK_CODE/CALLBACK_STUB/…) never get marked.
const WRITE_MAP_FAST_KINDS: ReadonlySet<RegionKind> = new Set<RegionKind>([
    "HEAP",
    "HEAP_HIGH",
    "SURFACE",
    "THUNK_DATA",
]);

export function isWriteMapFastRegion(kind: RegionKind, perms: RegionPerms): boolean {
    return WRITE_MAP_FAST_KINDS.has(kind) && (perms === "rw" || perms === "rwx");
}

export function setWriteMapBase(base: number, size: number, writable: boolean): void {
    if (size <= 0) return;
    try {
        const exports = (globalThis as any).preemption?.getWasmExports?.();
        const fn = exports?.fastmem_write_map_set_base;
        if (!fn) return;
        const startPage = base >>> 12;
        const endPage = (base + size + 0xfff) >>> 12; // ceil to whole pages
        const count = endPage - startPage;
        if (count <= 0) return;
        fn(startPage >>> 0, count >>> 0, writable ? 1 : 0);
    } catch {
        // Optional; the store fast path is default-OFF and byte-precise on the slow path.
    }
}

export class AddressSpace {
    private regions: RegionEntry[] = [];
    private nextRegionId = 1;
    private mem8: Uint8Array | null = null;
    private layoutBucketMap: Map<RegionKind, RegionEntry> = new Map();

    constructor(private readonly memoryGetter: () => Uint8Array) {
        this.syncMemoryView();
        this.ensureLowMemRegion(0x00100000);
    }

    private syncMemoryView(): void {
        this.mem8 = this.memoryGetter();
    }

    getMemory(): Uint8Array {
        if (!this.mem8) {
            this.syncMemoryView();
        }
        return this.mem8!;
    }

    reset(): void {
        this.regions = [];
        this.invalidateRegionIndex();
        this.nextRegionId = 1;
        this.layoutBucketMap.clear();
        this.ensureLowMemRegion(0x00100000);
    }

    registerRegion(entry: Omit<RegionEntry, "id">): number {
        const newEntry: RegionEntry = {
            id: this.nextRegionId++,
            ...entry,
        };

        const conflict = newEntry.skipOverlapCheck ? undefined : this.regions.find(other =>
            this.overlaps(other.base, other.size, newEntry.base, newEntry.size) &&
            !other.allowOverlap &&
            !newEntry.allowOverlap
        );
        if (conflict) {
            const msg = `AddressSpace: region overlap detected (${entry.kind} @ 0x${entry.base.toString(16)}..${(entry.base + entry.size).toString(16)}) conflicts with ${conflict.kind} @ 0x${conflict.base.toString(16)}..${(conflict.base + conflict.size).toString(16)}`;
            Logger.error(LogCategory.SYSTEM, msg);
            throw new Error(msg);
        }

        this.regions.push(newEntry);
        this.noteRegionAdded(newEntry);
        if (entry.owner === "Layout") {
            this.layoutBucketMap.set(entry.kind, newEntry);
        }
        // Seed bit0 for writable-RAM regions (HEAP/SURFACE/THUNK_DATA);
        // clear for everything else so a re-registered VA can't inherit a stale fast bit.
        setWriteMapBase(newEntry.base, newEntry.size, isWriteMapFastRegion(newEntry.kind, newEntry.perms));
        return newEntry.id;
    }

    /**
     * Drop a region record. This is JS-side bookkeeping only: it clears no PTE, so
     * every page in the range stays present and identity-mapped and a fastmem-speculated
     * load over it stays architecturally correct (it reads freed-but-mapped memory, which
     * is what real hardware does until the OS decommits). The accessibility change that
     * CAN invalidate speculation — MEM_DECOMMIT / protect-down — goes through
     * PageTableManager, which bumps the generation itself.
     *
     * So: no bump here. The generation is global — one bump deoptimises the whole
     * compiled working set (see PageTableManager.noteCommitOnlyMappingChange) — and a
     * loading game frees non-HEAP blocks many times a second, which is a rate that keeps
     * the JIT permanently cold.
     */
    releaseRegion(base: number): boolean {
        const idx = this.regions.findIndex(region => region.base === base && region.owner !== "Layout");
        if (idx >= 0) {
            const released = this.regions[idx];
            this.regions.splice(idx, 1);
            this.noteRegionRemoved(released);
            // A released VA is no longer a known writable region — drop bit0.
            // (Data map, read per store, no generation guard — see codegen gen_safe_write.)
            setWriteMapBase(released.base, released.size, false);
            return true;
        }
        return false;
    }

    /**
     * Non-Layout regions that intersect [base, base+size).
     *
     * `releaseRegion` keys on an EXACT base, which is only the reload-in-place case. A
     * PE image whose VA the module registry has recycled can be handed a base BELOW a
     * record an unloaded image left behind, so the stale region sits INSIDE the new
     * span and the exact-base drop misses it — the mapping then fails the overlap check
     * and LoadLibrary answers ERROR_MOD_NOT_FOUND for a DLL that is present.
     */
    findRegionsIntersecting(base: number, size: number): RegionEntry[] {
        return this.regions.filter(r =>
            r.owner !== "Layout" && this.overlaps(r.base, r.size, base, size));
    }

    mapRegion(base: number, size: number, perms: RegionPerms, kind: RegionKind, owner?: string, tag?: string): number {
        return this.registerRegion({ base, size, perms, kind, owner, tag });
    }

    /** Writable-RAM region spans, the region-intent half of the
     *  write-map bit0 (intersected with per-PTE present+RW by PageTableManager). */
    getFastWritableRanges(): { base: number; size: number }[] {
        return this.regions
            .filter(r => isWriteMapFastRegion(r.kind, r.perms))
            .map(r => ({ base: r.base, size: r.size }));
    }

    protect(base: number, size: number, perms: RegionPerms): boolean {
        const region = this.regions.find(r => r.base === base && r.size === size);
        if (!region) return false;
        region.perms = perms;
        // Re-derive bit0 from the new perms + kind (RO/NOACCESS ⇒ clear).
        setWriteMapBase(region.base, region.size, isWriteMapFastRegion(region.kind, perms));
        return true;
    }

    initializeLayout(totalLinearSize: number): void {
        const linearSize = Math.min(totalLinearSize, this.getMemorySize());
        if (linearSize <= 0) {
            Logger.warn(LogCategory.SYSTEM, "AddressSpace: initializeLayout called with zero memory size");
            return;
        }

        this.layoutBucketMap.clear();

        const layoutBuckets: LayoutBucket[] = [];

        // HEAP: Main application heap (configurable via emulator-config.ts)
        const heapBase = MEM_HEAP_BASE;
        const heapLimit = Math.min(linearSize, MEM_HEAP_BASE + MEM_HEAP_SIZE);
        layoutBuckets.push({
            base: heapBase,
            size: Math.max(0, heapLimit - heapBase),
            perms: "rw",
            kind: "HEAP",
            owner: "Layout",
            tag: "heap",
            allowOverlap: true,
        });

        // THUNK_CODE: Executable thunk stubs
        // allowOverlap: true to allow ThunkMemoryManager sub-regions (CALLBACK_STUB, SPIN_LOOP, etc.)
        const thunkBase = MEM_THUNK_CODE_BASE;
        const thunkLimit = Math.min(linearSize, MEM_THUNK_CODE_BASE + MEM_THUNK_CODE_SIZE);
        layoutBuckets.push({
            base: thunkBase,
            size: Math.max(0, thunkLimit - thunkBase),
            perms: "rx",
            kind: "THUNK_CODE",
            owner: "Layout",
            tag: "thunk-code-bucket",
            allowOverlap: true,  // allow ThunkMemoryManager sub-regions
        });

        // THUNK_DATA: Thunk-related data structures
        const thunkDataBase = MEM_THUNK_DATA_BASE;
        const thunkDataLimit = Math.min(linearSize, MEM_THUNK_DATA_BASE + MEM_THUNK_DATA_SIZE);
        layoutBuckets.push({
            base: thunkDataBase,
            size: Math.max(0, thunkDataLimit - thunkDataBase),
            perms: "rw",
            kind: "THUNK_DATA",
            owner: "Layout",
            tag: "thunk-data-bucket",
            allowOverlap: true,  // Allow sub-allocations
        });

        // GUARD: Red zone between THUNK and MODULES. Its upper half also hosts the
        // page directory + page tables (MEM_PAGETABLE_BASE) — NOACCESS to the guest,
        // written only by PageTableManager's raw accessors and the CPU's page walker.
        const guardBase = MEM_GUARD_BASE;
        const guardLimit = Math.min(linearSize, MEM_GUARD_BASE + MEM_GUARD_SIZE);
        if (guardLimit > guardBase) {
            layoutBuckets.push({
                base: guardBase,
                size: guardLimit - guardBase,
                perms: "noaccess",
                kind: "RESERVED",
                owner: "Layout",
                tag: "thunk-module-guard",
            });
        }

        // MODULES/ROM: PE executables and DLLs
        const moduleBase = MEM_ROM_BASE;
        const moduleLimit = Math.min(linearSize, MEM_ROM_BASE + MEM_ROM_SIZE);
        layoutBuckets.push({
            base: moduleBase,
            size: Math.max(0, moduleLimit - moduleBase),
            perms: "r",
            kind: "ROM",
            owner: "Layout",
            tag: "modules",
            allowOverlap: true,  // PE modules can load at different addresses
        });

        // SURFACE_PIXELS: DirectDraw surface pixel data — placed LAST so it can
        // expand via expandLayoutBucket toward end-of-RAM when texture-heavy games
        // (Natalie Brooks hidden-object) exhaust the default budget.
        const surfaceBase = MEM_SURFACE_BASE;
        const surfaceLimit = Math.min(linearSize, MEM_SURFACE_BASE + MEM_SURFACE_SIZE);
        layoutBuckets.push({
            base: surfaceBase,
            size: Math.max(0, surfaceLimit - surfaceBase),
            perms: "rw",
            kind: "SURFACE",
            owner: "Layout",
            tag: "surface-pool",
            allowOverlap: true,
        });

        // HEAP_HIGH: heap overflow above the fixed 1GB layout, present only when the
        // bundle asked for more RAM than the layout spans. See MEM_HEAP_HIGH_BASE.
        if (linearSize > MEM_HEAP_HIGH_BASE) {
            layoutBuckets.push({
                base: MEM_HEAP_HIGH_BASE,
                size: linearSize - MEM_HEAP_HIGH_BASE,
                perms: "rw",
                kind: "HEAP_HIGH",
                owner: "Layout",
                tag: "heap-high",
                allowOverlap: true,
            });
        }

        for (const bucket of layoutBuckets) {
            if (bucket.size > 0) {
                this.registerRegion(bucket);
            }
        }
    }

    private ensureLowMemRegion(size: number): void {
        if (size <= 0) return;

        const existing = this.regions.find(region => region.kind === "LOW_MEM");
        if (existing) {
            existing.size = size;
            existing.perms = "rw";
            // A non-bucket region's `size` is baked into the index's prefix-max end, which the
            // index holds by VALUE (unlike `perms`/bucket sizes, read live through the
            // reference). Resizing one in place therefore has to drop the index.
            this.invalidateRegionIndex();
            return;
        }

        this.registerRegion({
            base: 0,
            size,
            perms: "rw",
            kind: "LOW_MEM",
            owner: "AddressSpace",
            tag: "reserved-low",
            allowOverlap: false,
        });
    }

    validateRange(address: number, size: number, requiredPerms: string = "rw"): boolean {
        if (address < 0 || size < 0) return false;

        // Layout buckets are coarse containers that DELIBERATELY overlap the real regions
        // registered inside them (allowOverlap), so "first containing region wins" answers
        // with the bucket's blanket perms — a write into a mapped DLL's .data reads as a
        // write into read-only ROM. The narrowest containing region is the one that actually
        // describes this address; the bucket is only the fallback when nothing finer exists.
        const best = this.findNarrowestContaining(address, address + size);
        if (!best) return false;

        if (best.perms === "noaccess") return false;
        if (requiredPerms.includes("w") && !best.perms.includes("w")) return false;
        if (requiredPerms.includes("x") && !best.perms.includes("x")) return false;
        return true;
    }

    // ── stabbing index ────────────────────────────────────────────────────────
    // validateRange is the mandated check on EVERY guest-supplied pointer, so it runs
    // hundreds of times per frame (two per D3D draw). A linear sweep makes that O(regions),
    // and `regions` scales with the game's surface count — a loaded Half-Life level
    // registers ~1900 of them, so the sweep, not the work it guards, became the cost.
    //
    // Split so the standard interval prune actually prunes: layout buckets span the whole
    // address space by design, and a prefix-max over a set containing them never terminates
    // early. They are few (one per kind) and checked directly; everything else is sorted by
    // base with a prefix max end, which for the near-disjoint real regions stops after a
    // couple of steps.
    //
    // The index holds REFERENCES, so `perms` (mutated by protect) and a bucket's `size`
    // (mutated by expandLayoutBucket) are always read live. Only MEMBERSHIP is cached —
    // which is why noteRegionAdded/noteRegionRemoved/invalidateRegionIndex belong at exactly
    // the three sites that add or remove a region, and nowhere else. Miss one and the index
    // answers from a stale membership; tools/tests/address-space-validate-range.test.ts
    // differences it against the sweep it replaced and fails on each such omission.
    //
    // The rebuild is AMORTIZED, not per-mutation: MemoryManager registers and releases
    // regions in tight alloc/free loops, and an O(n log n) sort on each one would trade a
    // per-draw cost for a per-allocation one. Recent additions are held in a short unsorted
    // list and removals as tombstones; both are folded in only once REBUILD_THRESHOLD of
    // them accumulate, which bounds the linear part of a query as well.
    private idxBuilt = false;
    private idxBuckets: RegionEntry[] = [];
    private idxSorted: RegionEntry[] = [];
    private idxMaxEnd = new Float64Array(0);
    /** Registered since the last build — scanned linearly, capped by REBUILD_THRESHOLD. */
    private idxRecent: RegionEntry[] = [];
    /** Released since the last build; the sorted array still holds them, so queries skip these. */
    private idxRemoved: Set<number> = new Set();
    private static readonly REBUILD_THRESHOLD = 64;

    /** Record a membership change. Cheap; the sort happens only when the deltas pile up. */
    private noteRegionAdded(entry: RegionEntry): void {
        if (!this.idxBuilt) return;                 // nothing built yet — nothing to patch
        this.idxRecent.push(entry);
        this.maybeRebuildRegionIndex();
    }

    private noteRegionRemoved(entry: RegionEntry): void {
        if (!this.idxBuilt) return;
        const i = this.idxRecent.indexOf(entry);
        if (i >= 0) this.idxRecent.splice(i, 1);
        else this.idxRemoved.add(entry.id);
        this.maybeRebuildRegionIndex();
    }

    private maybeRebuildRegionIndex(): void {
        if (this.idxRecent.length + this.idxRemoved.size >= AddressSpace.REBUILD_THRESHOLD) {
            this.rebuildRegionIndex();
        }
    }

    private invalidateRegionIndex(): void {
        this.idxBuilt = false;
        this.idxRecent.length = 0;
        this.idxRemoved.clear();
    }

    private rebuildRegionIndex(): void {
        const buckets: RegionEntry[] = [];
        const sorted: RegionEntry[] = [];
        for (const r of this.regions) (r.owner === "Layout" ? buckets : sorted).push(r);
        sorted.sort((a, b) => a.base - b.base);
        const maxEnd = new Float64Array(sorted.length);
        let m = -Infinity;
        for (let i = 0; i < sorted.length; i++) {
            const e = sorted[i].base + sorted[i].size;
            if (e > m) m = e;
            maxEnd[i] = m;
        }
        this.idxBuckets = buckets;
        this.idxSorted = sorted;
        this.idxMaxEnd = maxEnd;
        this.idxRecent.length = 0;
        this.idxRemoved.clear();
        this.idxBuilt = true;
    }

    /** Narrowest region wholly containing [start, end). Identical result to a full sweep. */
    private findNarrowestContaining(start: number, end: number): RegionEntry | undefined {
        if (!this.idxBuilt) this.rebuildRegionIndex();
        let best: RegionEntry | undefined;
        const consider = (r: RegionEntry): void => {
            if (start < r.base || end > r.base + r.size) return;
            if (!best || r.size < best.size) best = r;
        };
        const buckets = this.idxBuckets;
        for (let i = 0; i < buckets.length; i++) consider(buckets[i]);
        const recent = this.idxRecent;
        for (let i = 0; i < recent.length; i++) consider(recent[i]);

        const sorted = this.idxSorted;
        const maxEnd = this.idxMaxEnd;
        const removed = this.idxRemoved;
        const anyRemoved = removed.size > 0;
        // Last entry with base <= start; everything after it starts too late to contain start.
        let lo = 0, hi = sorted.length - 1, last = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (sorted[mid].base <= start) { last = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        for (let i = last; i >= 0; i--) {
            // Containment needs base + size >= end; maxEnd is the best any 0..i can offer.
            if (maxEnd[i] < end) break;
            const r = sorted[i];
            if (anyRemoved && removed.has(r.id)) continue;
            consider(r);
        }
        return best;
    }

    getLayoutBucket(kind: RegionKind): RegionEntry | null {
        return this.layoutBucketMap.get(kind) ?? null;
    }

    /**
     * Dynamically expand a layout bucket to accommodate larger allocations.
     * Returns the new size on success, or 0 if expansion failed.
     */
    expandLayoutBucket(kind: RegionKind, requestedSize: number): number {
        const bucket = this.layoutBucketMap.get(kind);
        if (!bucket) {
            Logger.warn(LogCategory.SYSTEM, `expandLayoutBucket: bucket ${kind} not found`);
            return 0;
        }

        const currentEnd = bucket.base + bucket.size;
        const newEnd = bucket.base + requestedSize;
        const expansionSize = newEnd - currentEnd;

        if (expansionSize <= 0) {
            return bucket.size;
        }

        const maxMemorySize = this.getMemorySize();
        if (newEnd > maxMemorySize) {
            Logger.warn(LogCategory.SYSTEM,
                `expandLayoutBucket: expansion exceeds total memory (0x${newEnd.toString(16)} > 0x${maxMemorySize.toString(16)})`);
            return 0;
        }

        // A layout bucket may not grow into the layout bucket above it. Every layout bucket
        // carries allowOverlap (its sub-allocations are not registered individually), so the
        // conflict filter below is blind to them — and SURFACE, the one bucket whose whole
        // design is to grow upward, now has HEAP_HIGH immediately above it.
        let ceiling = maxMemorySize;
        for (const other of this.layoutBucketMap.values()) {
            if (other.id !== bucket.id && other.base >= currentEnd && other.base < ceiling) {
                ceiling = other.base;
            }
        }
        if (newEnd > ceiling) {
            Logger.warn(LogCategory.SYSTEM,
                `expandLayoutBucket: ${kind} expansion blocked by the layout bucket at ` +
                `0x${ceiling.toString(16)} (wanted 0x${newEnd.toString(16)})`);
            return 0;
        }

        const conflicts = this.regions.filter(other =>
            other.id !== bucket.id &&
            !other.allowOverlap &&
            this.overlaps(currentEnd, expansionSize, other.base, other.size)
        );

        if (conflicts.length > 0) {
            const conflictInfo = conflicts.map(c =>
                `${c.kind}@0x${c.base.toString(16)}-0x${(c.base + c.size).toString(16)}`
            ).join(", ");
            Logger.warn(LogCategory.SYSTEM,
                `expandLayoutBucket: ${kind} expansion blocked by: ${conflictInfo}`);
            return 0;
        }

        const oldSize = bucket.size;
        bucket.size = requestedSize;

        Logger.log(LogCategory.SYSTEM,
            `[AddressSpace] Expanded ${kind} bucket: 0x${bucket.base.toString(16)}..0x${newEnd.toString(16)} ` +
            `(+${(expansionSize / 1024 / 1024).toFixed(1)} MB, total ${(requestedSize / 1024 / 1024).toFixed(1)} MB)`);

        return bucket.size;
    }

    /**
     * Find first region by kind (searches all regions, not just layout buckets)
     * Useful for finding THUNK_CODE region created by ThunkMemoryManager
     */
    findRegionByKind(kind: RegionKind): RegionEntry | null {
        return this.regions.find(region => region.kind === kind) ?? null;
    }

    getRegion(address: number): RegionEntry | null {
        return this.regions.find(region => address >= region.base && address < region.base + region.size) ?? null;
    }

    getRegions(): RegionEntry[] {
        return [...this.regions];
    }

    logMap(): void {
        const entries = this.getRegions()
            .map(region => {
                return `${region.kind.padEnd(12)} 0x${region.base.toString(16).padStart(8, "0")} 0x${(region.base + region.size).toString(16).padStart(8, "0")} ${region.perms} ${region.owner ?? "unnamed"}`;
            })
            .join("\n");
        Logger.log(LogCategory.SYSTEM, `AddressSpace map:\n${entries}`);
    }

    /**
     * Find the first region that would block a sub-allocation at [base, base+size).
     * Layout buckets and MemoryManager sub-allocations are excluded — only "foreign"
     * non-allowOverlap regions (e.g. PE images mapped by PELoader) are returned.
     */
    findBlockingRegion(base: number, size: number): RegionEntry | null {
        const end = base + size;
        return this.regions.find(r =>
            !r.allowOverlap &&
            r.owner !== 'Layout' &&
            r.owner !== 'MemoryManager' &&
            r.base < end &&
            r.base + r.size > base
        ) ?? null;
    }

    private overlaps(base1: number, size1: number, base2: number, size2: number): boolean {
        const end1 = base1 + size1;
        const end2 = base2 + size2;
        return base1 < end2 && base2 < end1;
    }

    getMemorySize(): number {
        return this.getMemory().length;
    }

    read(address: number, size: number): Uint8Array | null {
        if (!this.validateRange(address, size, "r")) return null;
        const mem = this.getMemory();
        return mem.subarray(address, address + size);
    }

    write(address: number, data: Uint8Array): number {
        if (!this.validateRange(address, data.length, "w")) return 0;
        const mem = this.getMemory();
        mem.set(data, address);
        return data.length;
    }

    fill(address: number, size: number, value: number = 0): boolean {
        if (!this.validateRange(address, size, "w")) return false;
        const mem = this.getMemory();
        mem.fill(value, address, address + size);
        return true;
    }

    private logInvalidAccess(address: number, size: number, perms: string): void {
        Logger.warn(LogCategory.SYSTEM, `Invalid AddressSpace access: addr=0x${address.toString(16)} size=0x${size.toString(16)} requiredPerms=${perms}`);
    }
}
