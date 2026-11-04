/**
 * Guest-RAM "known zero" tracking — which 4 KiB pages may hold non-zero bytes.
 *
 * Why it exists: on iOS the WebContent process is killed by its per-process memory limit, and
 * that limit counts DIRTY pages (pages something has written to), not the wasm reservation.
 * Fresh wasm memory is already zero, and writing zeros over it is not free: `mem.fill(0)` over
 * a fresh range makes every page of it resident. Before this map the emulator did that to ~all
 * of guest RAM (Process.reset clearing every layout bucket on the very first boot, every
 * VirtualAlloc commit, every heap slab), so a 1.5 GB guest cost ~1.5 GB of footprint before the
 * game had touched anything.
 *
 * The contract is one bit per page: CLEAR = the page is known to read all zeros; SET = it may
 * not (it is "dirty"). Zeroing sites call {@link zeroGuestRange}, which writes only the dirty
 * pages of the span; handout sites call {@link markGuestPagesDirty} once a range is given to
 * anyone who may write it (MemoryManager handouts, AddressSpace region registrations, PE image
 * mappings, a committed VirtualAlloc range).
 *
 * The map is OPT-IN per memory: until {@link adoptFreshGuestMemory} is called for a buffer —
 * at v86 creation, before anything writes guest RAM — every page counts as dirty and every
 * zeroing site behaves exactly as an unconditional `fill(0)`. A different buffer (a recreated
 * v86, a test's fake memory) is likewise untracked. Failing closed is the point: the cost of a
 * missed opportunity is footprint, the cost of a wrong "clean" bit is a guest reading garbage.
 *
 * Trust boundary (stated, not hidden): a page is only made dirty by the writers above. A guest
 * store to RAM nobody ever handed out (a wild pointer into the unused middle of HEAP) is not
 * observed. MemoryManager already relied on exactly that ("virgin bump territory is zero") for
 * HeapAlloc before this map existed; the map extends the same trust to VirtualAlloc commits and
 * to Process.reset. `verifyCleanGuestPages` (harness `footprint({verify:true})`) audits it.
 */

const PAGE_SHIFT = 12;
const PAGE_SIZE = 1 << PAGE_SHIFT;
const MAX_PAGES = 0x100000; // 4 GiB

let dirtyBits: Uint32Array | null = null;
let trackedBuffer: ArrayBufferLike | null = null;
let trackedOffset = 0;
let trackedLength = 0;

const stats = {
    /** Bytes zeroing sites asked for. */
    requestedBytes: 0,
    /** Bytes actually written (dirty pages only). */
    writtenBytes: 0,
    /** Bytes skipped because their pages were known zero. */
    skippedBytes: 0,
};

/**
 * Same guest RAM? Guest RAM is a fixed window (offset, length) inside the wasm memory, but the
 * memory's ArrayBuffer is REPLACED whenever wasm memory grows (the JIT and the Rust heap grow
 * it after guest RAM is placed): the old buffer is detached, or for a shared memory left at
 * its smaller length. Follow that hand-over; anything else is a different memory.
 */
function isTracked(mem: Uint8Array): boolean {
    if (dirtyBits === null || mem.byteOffset !== trackedOffset || mem.length !== trackedLength) return false;
    const buffer = mem.buffer;
    if (buffer === trackedBuffer) return true;
    const old = trackedBuffer as (ArrayBufferLike & { detached?: boolean }) | null;
    if (!old) return false;
    const detached = old.detached === true || old.byteLength === 0;
    const grewShared = typeof SharedArrayBuffer !== "undefined" && old instanceof SharedArrayBuffer &&
        buffer instanceof SharedArrayBuffer && buffer.byteLength > old.byteLength;
    if (!detached && !grewShared) return false;
    trackedBuffer = buffer;
    return true;
}

/** Is `mem` the memory the map vouches for? (False = every page counts as dirty.) */
export function isGuestMemoryTracked(mem: Uint8Array): boolean {
    return isTracked(mem);
}

function isDirtyPage(page: number): boolean {
    return (dirtyBits![page >>> 5] & (1 << (page & 31))) !== 0;
}

function setPages(first: number, end: number, dirty: boolean): void {
    const bits = dirtyBits!;
    let p = first;
    while (p < end && (p & 31) !== 0) {
        if (dirty) bits[p >>> 5] |= 1 << (p & 31); else bits[p >>> 5] &= ~(1 << (p & 31));
        p++;
    }
    while (p + 32 <= end) { bits[p >>> 5] = dirty ? 0xffffffff : 0; p += 32; }
    while (p < end) {
        if (dirty) bits[p >>> 5] |= 1 << (p & 31); else bits[p >>> 5] &= ~(1 << (p & 31));
        p++;
    }
}

/**
 * Start tracking `mem`, which the caller asserts is FRESH: nothing has written it since the
 * wasm memory was created except below `dirtyBelow` (v86 loads its BIOS images into low
 * memory). Pages from `dirtyBelow` to the end of `mem` start clean; everything below is dirty.
 */
export function adoptFreshGuestMemory(mem: Uint8Array, dirtyBelow: number): void {
    const pages = Math.min(MAX_PAGES, Math.ceil(mem.length / PAGE_SIZE));
    dirtyBits = new Uint32Array(Math.ceil(MAX_PAGES / 32));
    trackedBuffer = mem.buffer;
    trackedOffset = mem.byteOffset;
    trackedLength = mem.length;
    // Beyond guest RAM nothing is ours to vouch for; below `dirtyBelow` v86 already wrote.
    setPages(0, Math.min(pages, Math.ceil(dirtyBelow / PAGE_SIZE)), true);
    setPages(pages, MAX_PAGES, true);
    stats.requestedBytes = stats.writtenBytes = stats.skippedBytes = 0;
}

/** Stop tracking (everything counts as dirty again). */
export function forgetGuestMemory(): void {
    dirtyBits = null;
    trackedBuffer = null;
    trackedOffset = trackedLength = 0;
}

/** `[base, base+size)` may now hold non-zero bytes. No-op for an untracked memory. */
export function markGuestPagesDirty(base: number, size: number): void {
    if (dirtyBits === null || size <= 0) return;
    const first = Math.floor(base / PAGE_SIZE);
    const end = Math.min(MAX_PAGES, Math.ceil((base + size) / PAGE_SIZE));
    if (first < end) setPages(first, end, true);
}

/**
 * `[base, base+size)` is known to read zero AND nobody can write it before the next handout
 * (e.g. a just-zeroed range that is immediately made non-present). Only whole pages inside
 * the span become clean: a partial page may hold someone else's bytes.
 */
export function markGuestPagesClean(mem: Uint8Array, base: number, size: number): void {
    if (!isTracked(mem) || size <= 0) return;
    const first = Math.ceil(base / PAGE_SIZE);
    const end = Math.min(MAX_PAGES, Math.floor((base + size) / PAGE_SIZE));
    if (first < end) setPages(first, end, false);
}

/** True when every page touching `[base, base+size)` is known zero. */
export function isGuestRangeKnownZero(mem: Uint8Array, base: number, size: number): boolean {
    if (!isTracked(mem)) return false;
    if (size <= 0) return true;
    const first = Math.floor(base / PAGE_SIZE);
    const end = Math.min(MAX_PAGES, Math.ceil((base + size) / PAGE_SIZE));
    for (let p = first; p < end; p++) if (isDirtyPage(p)) return false;
    return true;
}

/**
 * Make `[base, base+size)` read zero, writing only pages that may be non-zero. Afterwards every
 * whole page inside the span is clean. Returns the number of bytes actually written.
 * Untracked memory: a plain `fill(0)` over the span.
 *
 * JIT coherence is the CALLER's concern exactly as with a raw fill: skipped pages keep their
 * bytes (all zero), so any block compiled from them is still a block compiled from them.
 */
export function zeroGuestRange(mem: Uint8Array, base: number, size: number): number {
    const start = Math.max(0, base);
    const end = Math.min(base + size, mem.length);
    if (end <= start) return 0;
    stats.requestedBytes += end - start;
    if (!isTracked(mem)) {
        mem.fill(0, start, end);
        stats.writtenBytes += end - start;
        return end - start;
    }
    const bits = dirtyBits!;
    const lastPage = Math.floor((end - 1) / PAGE_SIZE);
    let written = 0;
    let page = Math.floor(start / PAGE_SIZE);
    while (page <= lastPage) {
        // Skip whole clean words quickly — a 1 GB clean span is 8K word reads.
        if ((page & 31) === 0 && bits[page >>> 5] === 0) { page += 32; continue; }
        if (!isDirtyPage(page)) { page++; continue; }
        let runEnd = page + 1;
        while (runEnd <= lastPage && isDirtyPage(runEnd)) runEnd++;
        const s = Math.max(start, page * PAGE_SIZE);
        const e = Math.min(end, runEnd * PAGE_SIZE);
        mem.fill(0, s, e);
        written += e - s;
        page = runEnd;
    }
    stats.writtenBytes += written;
    stats.skippedBytes += (end - start) - written;
    const firstWhole = Math.ceil(start / PAGE_SIZE);
    const endWhole = Math.floor(end / PAGE_SIZE);
    if (firstWhole < endWhole) setPages(firstWhole, endWhole, false);
    return written;
}

/** Diagnostic snapshot for harness `footprint`. */
export function guestPageDirtyStats(): {
    tracked: boolean; trackedBytes: number; dirtyBytes: number; cleanBytes: number;
    zeroRequestedBytes: number; zeroWrittenBytes: number; zeroSkippedBytes: number;
} {
    let dirtyPages = 0;
    const pages = Math.ceil(trackedLength / PAGE_SIZE);
    if (dirtyBits) {
        for (let p = 0; p < pages; p++) if (isDirtyPage(p)) dirtyPages++;
    }
    return {
        tracked: dirtyBits !== null,
        trackedBytes: trackedLength,
        dirtyBytes: dirtyBits ? dirtyPages * PAGE_SIZE : trackedLength,
        cleanBytes: dirtyBits ? (pages - dirtyPages) * PAGE_SIZE : 0,
        zeroRequestedBytes: stats.requestedBytes,
        zeroWrittenBytes: stats.writtenBytes,
        zeroSkippedBytes: stats.skippedBytes,
    };
}

/**
 * Audit the trust boundary: read every page marked clean and report those holding non-zero
 * bytes. Reading makes pages resident (on every OS), so this is a desktop diagnostic only.
 * `repair` zeroes the offenders (after which "clean" is true again).
 */
export function verifyCleanGuestPages(mem: Uint8Array, repair = false, maxSamples = 32): {
    tracked: boolean; checkedPages: number; violations: number; samples: string[];
} {
    if (!isTracked(mem)) return { tracked: false, checkedPages: 0, violations: 0, samples: [] };
    const words = new Int32Array(mem.buffer, mem.byteOffset, mem.length >>> 2);
    const pages = Math.floor(mem.length / PAGE_SIZE);
    let checked = 0, violations = 0;
    const samples: string[] = [];
    for (let p = 0; p < pages; p++) {
        if (isDirtyPage(p)) continue;
        checked++;
        const w0 = p * (PAGE_SIZE >>> 2);
        for (let i = w0; i < w0 + (PAGE_SIZE >>> 2); i++) {
            if (words[i] !== 0) {
                violations++;
                if (samples.length < maxSamples) samples.push('0x' + (p * PAGE_SIZE).toString(16));
                if (repair) { mem.fill(0, p * PAGE_SIZE, (p + 1) * PAGE_SIZE); }
                break;
            }
        }
    }
    return { tracked: true, checkedPages: checked, violations, samples };
}
