import type { GpuVertexConversionResult } from "./compute/vertex-converter";

const MAX_RETAINED_RANGES = 1024;
const RETAINED_VERTEX_POOL_BYTES = 8 * 1024 * 1024;

export type RetainedGeometryKey = string;

export function newVertexReuseStats() {
    return {
        eligible: 0,
        eligibleBytes: 0,
        reused: 0,
        reusedBytes: 0,
        repeatedWithinEncoder: 0,
        repeatedWithinEncoderBytes: 0,
        repeatedAcrossEncoders: 0,
        repeatedAcrossEncoderBytes: 0,
        persistentHits: 0,
        promoted: 0,
        copiedBytes: 0,
    };
}

export const ffpRetainedVertexStats = {
    ...newVertexReuseStats(),
    declInterleaveHits: 0,
    declInterleaveBytesSaved: 0,
};

export const ffpRetainedIndexStats = {
    eligible: 0,
    scanHits: 0,
    uploadHits: 0,
    uploadBytesSaved: 0,
    declCopyHits: 0,
    declCopyBytesSaved: 0,
};

function rememberBounded<T>(entries: Map<RetainedGeometryKey, T>, key: RetainedGeometryKey, entry: T): void {
    entries.delete(key);
    entries.set(key, entry);
    if (entries.size > MAX_RETAINED_RANGES) entries.delete(entries.keys().next().value!);
}

type RetainedGeometryMode = boolean | "measure" | "persistent";

export function retainedVertexMode(defaultMode: RetainedGeometryMode = true): RetainedGeometryMode {
    const mode = (globalThis as { __ffpRetainedVertices?: RetainedGeometryMode }).__ffpRetainedVertices;
    return typeof mode === "boolean" || mode === "measure" || mode === "persistent" ? mode : defaultMode;
}

export function reuseRetainedGeometry(): boolean {
    const mode = retainedVertexMode();
    return mode === true || mode === "persistent";
}

interface BufferRange {
    readonly buffer: GPUBuffer;
    readonly offset: number;
    readonly size: number;
}

interface RecordedRange<T> {
    readonly epoch: number;
    readonly result: T | null;
}

interface PersistentRange<T> {
    readonly key: RetainedGeometryKey;
    readonly epoch: number;
    readonly result: T;
    committed: boolean;
}

/** Reuse short-lived ranges and promote repeatedly used ranges to an immutable GPU arena. */
export class RetainedVertexConversions<T extends BufferRange = GpuVertexConversionResult> {
    private readonly ranges = new Map<RetainedGeometryKey, RecordedRange<T>>();
    private readonly persistent = new Map<RetainedGeometryKey, PersistentRange<T>>();
    private readonly promotions = new Map<GPUCommandEncoder, PersistentRange<T>[]>();
    private readonly retired = new Map<GPUCommandEncoder, GPUBuffer>();
    private pool: GPUBuffer | undefined;
    private poolOffset = 0;

    constructor(
        private readonly stats: ReturnType<typeof newVertexReuseStats> = ffpRetainedVertexStats,
        private readonly defaultMode: RetainedGeometryMode = true,
    ) {}

    find(key: RetainedGeometryKey, encoderEpoch: number, sourceBytes: number): T | null {
        this.stats.eligible++;
        this.stats.eligibleBytes += sourceBytes;
        const mode = retainedVertexMode(this.defaultMode);
        if (mode === "persistent") {
            const entry = this.persistent.get(key);
            if (entry && (entry.committed || entry.epoch === encoderEpoch)) {
                this.stats.reused++;
                this.stats.reusedBytes += sourceBytes;
                this.stats.persistentHits++;
                return entry.result;
            }
        }
        const range = this.ranges.get(key);
        if (!range) return null;
        if (range.epoch !== encoderEpoch) {
            this.stats.repeatedAcrossEncoders++;
            this.stats.repeatedAcrossEncoderBytes += sourceBytes;
            return null;
        }
        this.stats.repeatedWithinEncoder++;
        this.stats.repeatedWithinEncoderBytes += sourceBytes;
        if (range.result && (mode === true || mode === "persistent")) {
            this.stats.reused++;
            this.stats.reusedBytes += sourceBytes;
            return range.result;
        }
        return null;
    }

    remember(
        key: RetainedGeometryKey,
        encoderEpoch: number,
        result: T,
        device: GPUDevice,
        owner: GPUCommandEncoder,
        copy: (buffer: GPUBuffer, offset: number) => void,
    ): void {
        const previous = this.ranges.get(key);
        const mode = retainedVertexMode(this.defaultMode);
        const retained = mode === true || mode === "persistent" ? result : null;
        rememberBounded(this.ranges, key, { epoch: encoderEpoch, result: retained });
        if (mode !== "persistent" || !previous || previous.epoch === encoderEpoch) return;

        const pool = this.reserve(device, owner, result.size);
        if (!pool) return;
        const offset = this.poolOffset;
        try { copy(pool, offset); } catch { return; }
        this.poolOffset += result.size;
        const entry: PersistentRange<T> = { key, epoch: encoderEpoch, result: { ...result, buffer: pool, offset }, committed: false };
        rememberBounded(this.persistent, key, entry);
        let pending = this.promotions.get(owner);
        if (!pending) this.promotions.set(owner, pending = []);
        pending.push(entry);
        this.stats.promoted++;
        this.stats.copiedBytes += result.size;
    }

    private reserve(device: GPUDevice, owner: GPUCommandEncoder, size: number): GPUBuffer | undefined {
        const capacity = Math.min(RETAINED_VERTEX_POOL_BYTES, device.limits.maxBufferSize);
        if (size <= 0 || size > capacity / 2) return undefined;
        if (this.pool && this.poolOffset + size <= capacity) return this.pool;
        if (this.retired.has(owner)) return undefined; // Bound simultaneous GPU memory during churn.
        let replacement: GPUBuffer;
        try {
            replacement = device.createBuffer({ size: capacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        } catch {
            return undefined;
        }
        if (this.pool) this.retired.set(owner, this.pool);
        this.pool = replacement;
        this.poolOffset = 0;
        this.persistent.clear();
        return replacement;
    }

    retire(owner: GPUCommandEncoder, submitted: boolean): void {
        for (const entry of this.promotions.get(owner) ?? []) {
            if (submitted) entry.committed = true;
            else if (this.persistent.get(entry.key) === entry) this.persistent.delete(entry.key);
        }
        this.promotions.delete(owner);
        this.retired.get(owner)?.destroy();
        this.retired.delete(owner);
    }

    reset(destroy: boolean): void {
        if (destroy) {
            this.pool?.destroy();
            for (const buffer of this.retired.values()) buffer.destroy();
        }
        this.pool = undefined;
        this.poolOffset = 0;
        this.persistent.clear();
        this.ranges.clear();
        this.promotions.clear();
        this.retired.clear();
    }
}

interface IndexBounds {
    readonly min: number;
    readonly max: number;
}

interface UploadedIndices {
    readonly epoch: number;
    readonly buffer: GPUBuffer;
    readonly offset: number;
}

export class RetainedIndexRanges {
    private readonly bounds = new Map<RetainedGeometryKey, IndexBounds>();
    private readonly uploads = new Map<RetainedGeometryKey, UploadedIndices>();

    findBounds(key: RetainedGeometryKey): IndexBounds | undefined {
        ffpRetainedIndexStats.eligible++;
        const bounds = this.bounds.get(key);
        if (!bounds || !reuseRetainedGeometry()) return undefined;
        ffpRetainedIndexStats.scanHits++;
        return bounds;
    }

    rememberBounds(key: RetainedGeometryKey, min: number, max: number): void {
        rememberBounded(this.bounds, key, { min, max });
    }

    findUpload(key: RetainedGeometryKey, epoch: number, bytes: number): UploadedIndices | undefined {
        const upload = this.uploads.get(key);
        if (upload?.epoch !== epoch || !reuseRetainedGeometry()) return undefined;
        ffpRetainedIndexStats.uploadHits++;
        ffpRetainedIndexStats.uploadBytesSaved += bytes;
        return upload;
    }

    rememberUpload(key: RetainedGeometryKey, epoch: number, buffer: GPUBuffer, offset: number): void {
        if (reuseRetainedGeometry()) rememberBounded(this.uploads, key, { epoch, buffer, offset });
    }

    reset(): void {
        this.bounds.clear();
        this.uploads.clear();
    }
}
