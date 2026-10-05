/**
 * Retained vertex/index buffer uploads — the range math and its census, in one place because
 * they are one contract: every upload the D3D8/D3D9 backends issue for a Lock/Unlock-backed
 * buffer goes through here, so the instrument cannot be bypassed by a path that forgets it.
 *
 * WHY A RANGE. A dynamic vertex buffer is locked a few hundred bytes at a time (that is what
 * D3DLOCK_NOOVERWRITE is for) but lives for the process. Uploading the whole buffer per lock
 * therefore costs the buffer's SIZE per lock instead of the lock's size — amplification that
 * scales with how big the buffer is rather than with how much the guest changed.
 *
 * WHY THE RATIO IS THE MEASUREMENT. Bytes-per-frame alone cannot distinguish a guest that
 * rewrites a megabyte from one that rewrites two kilobytes into a megabyte-sized buffer. The
 * census owns both halves over one window and reports `amplification` itself, so the claim is
 * never assembled by hand out of two numbers measured over windows that never overlapped.
 * It is null when no guest writes were seen: a census that observed nothing knows nothing,
 * and "1.0x" would read as a clean bill of health.
 */

export type BufferUploadBackend = "d3d9" | "d3d8";

/**
 * WHY an upload carried the bytes it carried. `amplification` says how much surplus there is;
 * without the reason, any fix to the upload path is a guess about which of these dominates.
 *
 *  - `dirtySpan`     partial upload of [min(lock offsets), max(lock ends)). Surplus here is
 *                    the GAPS between disjoint locks — a buffer locked at both ends ships
 *                    everything in between.
 *  - `wholeRingNew`  a version-ring slot built this frame holds nothing, so its first upload
 *                    cannot be partial.
 *  - `wholeRenamed`  D3DLOCK_DISCARD renamed onto a fresh slot mid-frame; same reason.
 *  - `wholeNewBuffer` the store created the GPUBuffer now.
 *  - `wholeRestore`  a whole-buffer re-raise (device loss, or setDirty(true) by any owner).
 */
export type UploadReason =
    | "dirtySpan" | "wholeRingNew" | "wholeRenamed" | "wholeNewBuffer" | "wholeRestore";

const UPLOAD_REASONS: readonly UploadReason[] = [
    "dirtySpan", "wholeRingNew", "wholeRenamed", "wholeNewBuffer", "wholeRestore",
];

/**
 * Widen `[start, end)` to what `queue.writeBuffer` will accept against a buffer of
 * `gpuCapacity` bytes: both the destination offset and the length must be multiples of 4,
 * and the write must not run past the buffer. Widening is safe in both directions — the extra
 * bytes come from the same source shadow, so they re-write what is already there.
 * Returns a zero length when the range is empty.
 */
export function alignUploadRange(start: number, end: number, gpuCapacity: number):
    { offset: number; length: number } {
    if (end <= start) return { offset: 0, length: 0 };
    const offset = Math.max(0, start) & ~3;
    const alignedEnd = Math.min((end + 3) & ~3, gpuCapacity & ~3);
    if (alignedEnd <= offset) return { offset: 0, length: 0 };
    return { offset, length: alignedEnd - offset };
}

/**
 * Immediate ranged upload out of a CPU-side shadow. `data` is indexed in buffer coordinates,
 * so the destination offset and the source offset are the same number. Bytes past `data` are
 * zero-filled, which only happens in the tail padding of a non-multiple-of-4 buffer.
 */
export function writeDirtyRange(
    queue: GPUQueue,
    buffer: GPUBuffer,
    data: Uint8Array,
    start: number,
    end: number,
    backend: BufferUploadBackend,
    full = false,
): void {
    const { offset, length } = alignUploadRange(start, end, buffer.size);
    if (length === 0) return;
    const available = Math.max(0, Math.min(length, data.length - offset));
    if (available === length) {
        queue.writeBuffer(buffer, offset, data, offset, length);
    } else {
        const padded = new Uint8Array(length);
        if (available > 0) padded.set(data.subarray(offset, offset + available));
        queue.writeBuffer(buffer, offset, padded);
    }
    noteBufferUpload(backend, length, full);
}

// ── Census ────────────────────────────────────────────────────────────────

/** Upload size buckets. Boundaries are byte counts, ascending; the last bucket is unbounded. */
const BUCKET_LIMITS = [1024, 16384, 65536, 262144, 1048576] as const;
const BUCKET_NAMES = ["<1k", "1-16k", "16-64k", "64-256k", "256k-1M", ">1M"] as const;

interface BackendCensus {
    /** Lock/Unlock brackets observed, and the bytes inside them. */
    guestWrites: number;
    guestWroteBytes: number;
    /** queue.writeBuffer calls this path issued, and the bytes they carried. */
    uploads: number;
    uploadedBytes: number;
    /** Uploads that had to carry the whole buffer (new / renamed / re-created GPU buffer). */
    fullUploads: number;
    /** Uploads restricted to the range the guest rewrote. */
    partialUploads: number;
    buckets: Int32Array;
    /** Per-reason tally. `covered` is the bytes the guest actually locked since that buffer's
     *  previous upload, so `uploaded - covered` is the surplus this reason is responsible for. */
    reasonCount: Int32Array;
    reasonUploaded: Float64Array;
    reasonCovered: Float64Array;
}

function emptyBackend(): BackendCensus {
    return {
        guestWrites: 0, guestWroteBytes: 0,
        uploads: 0, uploadedBytes: 0,
        fullUploads: 0, partialUploads: 0,
        buckets: new Int32Array(BUCKET_NAMES.length),
        reasonCount: new Int32Array(UPLOAD_REASONS.length),
        reasonUploaded: new Float64Array(UPLOAD_REASONS.length),
        reasonCovered: new Float64Array(UPLOAD_REASONS.length),
    };
}

const census: Record<BufferUploadBackend, BackendCensus> = {
    d3d9: emptyBackend(),
    d3d8: emptyBackend(),
};
let windowStartMs = performance.now();

/** A guest Lock/Unlock bracket committed `bytes` into a retained buffer. */
export function noteGuestBufferWrite(backend: BufferUploadBackend, bytes: number): void {
    if (bytes <= 0) return;
    const c = census[backend];
    c.guestWrites++;
    c.guestWroteBytes += bytes;
}

/** One queue.writeBuffer of `bytes` into a retained vertex/index buffer. */
export function noteBufferUpload(backend: BufferUploadBackend, bytes: number, full: boolean): void {
    const c = census[backend];
    c.uploads++;
    c.uploadedBytes += bytes;
    if (full) c.fullUploads++; else c.partialUploads++;
    let b: number = BUCKET_LIMITS.length;
    for (let i = 0; i < BUCKET_LIMITS.length; i++) {
        if (bytes < BUCKET_LIMITS[i]!) { b = i; break; }
    }
    c.buckets[b]!++;
}

/**
 * WHY this upload carried `bytes`, and how many of them the guest had actually locked since
 * this buffer's previous upload. Called where the reason is known, which for the deferred
 * path is queue time, not drain time — so it is deliberately NOT the same call as
 * `noteBufferUpload`, and the two are cross-checked in the report rather than assumed equal.
 */
export function noteUploadReason(
    backend: BufferUploadBackend, bytes: number, reason: UploadReason, coveredBytes: number,
): void {
    if (bytes <= 0) return;
    const i = UPLOAD_REASONS.indexOf(reason);
    if (i < 0) return;
    const c = census[backend];
    c.reasonCount[i]!++;
    c.reasonUploaded[i]! += bytes;
    // Clamped: a lock wider than the upload (the guest locked a range we then clipped to the
    // buffer) would otherwise make surplus negative and hide a real one elsewhere in the sum.
    c.reasonCovered[i]! += Math.min(coveredBytes, bytes);
}

export function resetBufferUploadCensus(): void {
    census.d3d9 = emptyBackend();
    census.d3d8 = emptyBackend();
    windowStartMs = performance.now();
}

function snapshotBackend(c: BackendCensus): Record<string, unknown> {
    const buckets: Record<string, number> = {};
    for (let i = 0; i < BUCKET_NAMES.length; i++) {
        if (c.buckets[i]) buckets[BUCKET_NAMES[i]!] = c.buckets[i]!;
    }
    return {
        guestWrites: c.guestWrites,
        guestWroteMB: +(c.guestWroteBytes / 1048576).toFixed(2),
        uploads: c.uploads,
        uploadedMB: +(c.uploadedBytes / 1048576).toFixed(2),
        fullUploads: c.fullUploads,
        partialUploads: c.partialUploads,
        amplification: c.guestWroteBytes > 0
            ? Math.round((c.uploadedBytes / c.guestWroteBytes) * 10) / 10
            : null,
        buckets,
        byReason: reasonBreakdown(c),
    };
}

const mb = (b: number) => +(b / 1048576).toFixed(2);

/**
 * The surplus, split by cause, plus an explicit statement of how much of the window's bytes
 * this split actually accounts for. A breakdown that silently covered 12% of the traffic would
 * still look like an answer, so `accountedPct` and `unattributed` are part of the result, not
 * a footnote.
 */
function reasonBreakdown(c: BackendCensus): Record<string, unknown> {
    const rows: Record<string, unknown> = {};
    let accounted = 0;
    for (let i = 0; i < UPLOAD_REASONS.length; i++) {
        accounted += c.reasonUploaded[i]!;
        if (!c.reasonCount[i]) continue;
        const up = c.reasonUploaded[i]!, cov = c.reasonCovered[i]!;
        rows[UPLOAD_REASONS[i]!] = {
            count: c.reasonCount[i]!,
            // Raw bytes as well as MB: 0.06 MB and 0.00 MB are both "no surplus" to a reader,
            // and on this workload most uploads are under a kilobyte.
            uploadedBytes: up, coveredBytes: cov, surplusBytes: up - cov,
            uploadedMB: mb(up), coveredMB: mb(cov), surplusMB: mb(up - cov),
            amplification: cov > 0 ? Math.round((up / cov) * 10) / 10 : null,
            shareOfUploadedPct: c.uploadedBytes > 0 ? +((up / c.uploadedBytes) * 100).toFixed(1) : 0,
        };
    }
    const gap = c.uploadedBytes - accounted;
    return {
        rows,
        accountedPct: c.uploadedBytes > 0 ? +((accounted / c.uploadedBytes) * 100).toFixed(1) : 0,
        unattributedMB: mb(Math.max(0, gap)),
        verdict: c.uploads === 0 ? "no uploads in this window"
            : Math.abs(gap) <= c.uploadedBytes * 0.01 ? "complete"
            : `INCOMPLETE: ${mb(Math.abs(gap))} MB of ${mb(c.uploadedBytes)} MB reached a writeBuffer `
              + `${gap > 0 ? "with no reason attached" : "counted twice"} — an upload path this split does not model`,
    };
}

/**
 * The census over the window since the last reset. `amplification` near 1 means we upload
 * what the guest wrote; a large value is the whole-buffer-per-lock defect. null means nothing
 * was observed, which is NOT the same as 1.
 */
export function getBufferUploadCensus(): Record<string, unknown> {
    const observed = census.d3d9.guestWrites > 0 || census.d3d8.guestWrites > 0
        || census.d3d9.uploads > 0 || census.d3d8.uploads > 0;
    return {
        windowMs: Math.round(performance.now() - windowStartMs),
        observed,
        note: observed
            ? "amplification = bytes uploaded / bytes the guest wrote through Lock/Unlock; null = no guest writes seen"
            : "no retained-buffer traffic in this window — reset and run the guest before reading",
        d3d9: snapshotBackend(census.d3d9),
        d3d8: snapshotBackend(census.d3d8),
    };
}
