// Read-only dispatch-layout census. Call with the emulator stopped, outside all
// timing windows: this scans metadata and occupied slabs and disturbs host caches.
// Static occupancy is not access frequency, cache residency, or CPU time.
const CELLS_PER_SLAB = 0x1000;
const BYTES_PER_SLAB = CELLS_PER_SLAB * 2;
const META_PAGES = 1 << 20;
const MAX_TARGETS = 16_384;

function requireInteger(name, value, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer in [${min}, ${max}], got ${value}`);
    }
    return value;
}

function distribution(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const histogram = Object.fromEntries(
        ['0', '1', '2-4', '5-16', '17-64', '65-256', '257-1024', '1025-4096'].map(k => [k, 0]),
    );
    for (const n of values) {
        const key = n === 0 ? '0' : n === 1 ? '1' : n <= 4 ? '2-4' : n <= 16 ? '5-16'
            : n <= 64 ? '17-64' : n <= 256 ? '65-256' : n <= 1024 ? '257-1024' : '1025-4096';
        histogram[key]++;
    }
    const percentile = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
    return { count: sorted.length, min: sorted[0] ?? null, p50: percentile(0.5),
        p95: percentile(0.95), max: sorted.at(-1) ?? null, histogram };
}

/** Pure decoder for synthetic tests and already-captured views. Metadata contains
 * low/high u32 pairs; cells hold state+1, zero is a miss. The views are only read.
 * Targets are deterministic, stratified by uniquely-owned slab, and structurally
 * valid; they do not prove module liveness, generation validity, or execution heat.
 */
export function collectDispatchCensusFromViews(meta, cells, options = {}) {
    if (!(meta instanceof Uint32Array) || meta.length % 2 !== 0) {
        throw new Error('meta must be a Uint32Array of low/high word pairs');
    }
    if (!(cells instanceof Uint16Array) || cells.length % CELLS_PER_SLAB !== 0) {
        throw new Error('cells must be a Uint16Array containing whole 4096-cell slabs');
    }
    if (meta.length / 2 > META_PAGES) throw new Error('metadata exceeds the 32-bit guest page space');
    const slabCount = requireInteger('slab count', cells.length / CELLS_PER_SLAB, 2, 65_536);
    const maxTargets = requireInteger('maxTargets', options.maxTargets ?? MAX_TARGETS, 0, MAX_TARGETS);
    const metaBase = requireInteger('metaBase', options.metaBase ?? 0, 0, 0xffff_ffff);
    const slabsBase = requireInteger('slabsBase', options.slabsBase ?? 0, 0, 0xffff_ffff);
    if (metaBase % 8 || slabsBase % 2) throw new Error('metadata/slab bases must be aligned to 8/2 bytes');
    const owners = new Map(), metaLines = new Set();
    const invalidMetadata = [];
    let activePages = 0;
    for (let page = 0; page < meta.length / 2; page++) {
        const lo = meta[page * 2], flags = meta[page * 2 + 1];
        if (lo === 0 && flags === 0) continue;
        activePages++;
        metaLines.add(Math.floor((metaBase + page * 8) / 64));
        const slab = lo & 0xffff, tableIndex = lo >>> 16;
        if (slab === 0 || slab >= slabCount || tableIndex === 0) {
            invalidMetadata.push({ page, slab, tableIndex, stateFlags: flags });
            continue;
        }
        const owner = { page, tableIndex, stateFlags: flags };
        if (owners.has(slab)) owners.get(slab).push(owner);
        else owners.set(slab, [owner]);
    }
    const uniqueOwnerSlabs = [...owners].filter(([, list]) => list.length === 1);
    const eligibleSlabs = uniqueOwnerSlabs.length;
    const targetSlabs = new Set();
    // If there are more slabs than target slots, sample across the full slab list.
    for (let i = 0; i < Math.min(maxTargets, eligibleSlabs); i++) {
        targetSlabs.add(uniqueOwnerSlabs[Math.floor(i * eligibleSlabs / Math.min(maxTargets, eligibleSlabs))][0]);
    }
    const targets = [], liveLines = new Set(), liveCounts = [], pageLiveCounts = [];
    const duplicateSlabOwners = [];
    let liveCells = 0, sampledSlabOrdinal = 0;
    for (const [slab, list] of owners) {
        const offsets = [];
        for (let offset = 0; offset < CELLS_PER_SLAB; offset++) {
            if (cells[slab * CELLS_PER_SLAB + offset] === 0) continue;
            offsets.push(offset);
            liveLines.add(Math.floor((slabsBase + slab * BYTES_PER_SLAB + offset * 2) / 64));
        }
        liveCells += offsets.length;
        liveCounts.push(offsets.length);
        for (const _ of list) pageLiveCounts.push(offsets.length);
        if (list.length !== 1) {
            duplicateSlabOwners.push({ slab, owners: list });
            continue;
        }
        if (!targetSlabs.has(slab)) continue;
        const quota = Math.floor(maxTargets / targetSlabs.size)
            + (sampledSlabOrdinal++ < maxTargets % targetSlabs.size ? 1 : 0);
        const take = Math.min(quota, offsets.length), owner = list[0];
        for (let i = 0; i < take; i++) {
            const offset = offsets[Math.floor(i * offsets.length / take)];
            targets.push({ addr: (owner.page * 4096 + offset) >>> 0,
                tableIndex: owner.tableIndex, stateFlags: owner.stateFlags,
                expectedState: cells[slab * CELLS_PER_SLAB + offset] - 1 });
        }
    }
    return {
        schemaVersion: 1,
        interpretation: 'Static published occupancy; not a hot working set or CPU-time measurement. Targets require independent resolver/liveness checks.',
        metadata: { capacityPages: meta.length / 2, reservedBytes: meta.byteLength,
            activePages, activeCacheLines64: metaLines.size, invalidEntries: invalidMetadata.length },
        slabs: { capacity: slabCount, usableCapacity: slabCount - 1, reservedBytes: cells.byteLength,
            liveSlabs: owners.size, liveSlabBytes: owners.size * BYTES_PER_SLAB, liveCells,
            liveCellBytes: liveCells * 2, cellDensity: owners.size ? liveCells / (owners.size * CELLS_PER_SLAB) : null,
            liveCellCacheLines64: liveLines.size, emptyPublishedSlabs: liveCounts.filter(n => n === 0).length,
            cellsPerSlab: distribution(liveCounts), cellsPerPage: distribution(pageLiveCounts) },
        invalidMetadata, duplicateSlabOwners, targets,
        targetSampling: { maxTargets, count: targets.length, eligibleSlabs,
            sampledSlabs: new Set(targets.map(t => t.addr >>> 12)).size,
            excludesDuplicateOwners: true, provesExecutionHeat: false },
    };
}

/** Read existing exports and current memory synchronously, with no per-cell Wasm
 * calls and no saved view that could survive memory growth. Does not stop/start CPU.
 */
export function collectDispatchCensus(cpu, options = {}) {
    const w = cpu?.wm?.exports;
    for (const name of ['jit_get_dispatch_meta_ptr', 'jit_get_dispatch_slabs_ptr', 'jit_get_dispatch_slabs_len']) {
        if (typeof w?.[name] !== 'function') throw new Error(`Required export missing: ${name}`);
    }
    const metaBase = w.jit_get_dispatch_meta_ptr() >>> 0;
    const slabsBase = w.jit_get_dispatch_slabs_ptr() >>> 0;
    const slabsBytes = w.jit_get_dispatch_slabs_len() >>> 0;
    if (metaBase % 8 || slabsBase % 2 || slabsBytes % BYTES_PER_SLAB || slabsBytes < BYTES_PER_SLAB * 2) {
        throw new Error('Invalid dispatch pointer alignment or slab pool byte length');
    }
    const buffer = cpu?.wasm_memory?.buffer;
    if (!buffer || metaBase + META_PAGES * 8 > buffer.byteLength || slabsBase + slabsBytes > buffer.byteLength) {
        throw new Error('Dispatch metadata or slab range exceeds current Wasm memory');
    }
    if (metaBase < slabsBase + slabsBytes && slabsBase < metaBase + META_PAGES * 8) {
        throw new Error('Dispatch metadata and slab pool overlap');
    }
    const result = collectDispatchCensusFromViews(
        new Uint32Array(buffer, metaBase, META_PAGES * 2),
        new Uint16Array(buffer, slabsBase, slabsBytes / 2),
        { ...options, metaBase, slabsBase },
    );
    result.layout = { metaBase, slabsBase, slabsBytes, wasmMemoryBytes: buffer.byteLength };
    result.counters = {};
    for (const name of ['dispatch_slab_high_water', 'dispatch_slab_overflows', 'jit_debug_page_count',
        'jit_debug_module_count', 'jit_debug_hidden_count', 'jit_debug_free_slots', 'codegen_is_compiling']) {
        result.counters[name] = typeof w[name] === 'function' ? w[name]() : null;
    }
    return result;
}
