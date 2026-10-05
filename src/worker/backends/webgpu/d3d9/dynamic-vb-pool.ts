/**
 * DynamicVbPool — a reuse pool for the transient vertex buffers that back
 * DrawPrimitiveUP-style draws.
 *
 * Why: every DrawPrimitiveUP previously did `device.createBuffer({...})` +
 * `buffer.destroy()` per call. NFSU's car-select menu issues ~36K UP draws/sec,
 * so that's ~36K GPU buffer create+destroy pairs/sec — pure driver/allocator
 * churn plus a `new Uint8Array(data)` staging copy per draw feeding the GC.
 *
 * This pool sub-buckets free buffers by their allocated capacity (rounded up to a
 * power of two, min 256 B) and hands back a buffer >= the requested size. After
 * the frame is submitted, the device returns each buffer here for reuse instead
 * of destroying it. WebGPU queue ordering makes reuse safe without a fence: a
 * `writeBuffer` into a recycled buffer is sequenced after the prior frame's draws
 * that read it (all on the one device queue), so the GPU never sees a torn write.
 *
 * Buffers are VERTEX | COPY_DST (the exact usage the old per-draw path used).
 * A per-bucket cap bounds idle VRAM; overflow buffers are destroyed.
 */

const MIN_BUCKET = 256;
const MAX_FREE_PER_BUCKET = 64;

/** Round up to the next power of two, with a 256 B floor. */
function bucketFor(size: number): number {
    let b = MIN_BUCKET;
    while (b < size) b <<= 1;
    return b;
}

export class DynamicVbPool {
    private device: GPUDevice;
    /** capacity (pow2 bytes) -> stack of free buffers of exactly that capacity. */
    private free = new Map<number, GPUBuffer[]>();

    // Telemetry (read via the device for diagnostics if needed).
    acquires = 0;
    creates = 0;
    releases = 0;
    destroys = 0;

    constructor(device: GPUDevice) {
        this.device = device;
    }

    /** Get a buffer with capacity >= size (VERTEX | COPY_DST | COPY_SRC — the executor's
     *  robustness padding copies out of whatever a draw binds). */
    acquire(size: number): GPUBuffer {
        this.acquires++;
        const cap = bucketFor(size);
        const list = this.free.get(cap);
        if (list && list.length > 0) {
            return list.pop()!;
        }
        this.creates++;
        return this.device.createBuffer({
            size: cap,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
    }

    /** Return a buffer for reuse. Buckets by its allocated capacity (buffer.size). */
    release(buffer: GPUBuffer): void {
        this.releases++;
        const cap = buffer.size;
        let list = this.free.get(cap);
        if (!list) {
            list = [];
            this.free.set(cap, list);
        }
        if (list.length >= MAX_FREE_PER_BUCKET) {
            this.destroys++;
            buffer.destroy();
            return;
        }
        list.push(buffer);
    }

    /** Drop and destroy all pooled buffers (device teardown / reset). */
    dispose(): void {
        for (const list of this.free.values()) {
            for (const b of list) b.destroy();
        }
        this.free.clear();
    }
}
