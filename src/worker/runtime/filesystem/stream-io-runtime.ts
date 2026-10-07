import { BundleVersionError, HttpRangeSource, type ReadHint, type ZipSource } from "@bottleship/formats/zip";
import { SparseWgbCache } from "./sparse-wgb-cache";

export interface StreamIoOptions {
    chunkBytes: number; maxInflight: number; cacheBytes: number; prefetchChunks: number;
}
type Job = { priority: number; run: () => Promise<void>; reject: (e: unknown) => void };

/** Transport scheduling is shared by demand, readahead and fill, including multi-chunk reads. */
export class StreamIoRuntime {
    diskError: string | null = null;
    readonly stats = {
        netFetches: 0, prefetches: 0, requests: 0, asyncRequests: 0, evictions: 0,
        netBytes: 0, residentBytes: 0, prefetchEvictedUnreadBytes: 0,
        chunksNeeded: 0, chunksResidentHit: 0, chunksDiskHit: 0, chunksJoinedInflight: 0,
        chunksFetchedCold: 0, requestsAllResident: 0, requestsNoNewFetch: 0,
        chunksRefetchedAfterEvict: 0, fillFetches: 0, fillBytes: 0, diskWriteFailures: 0,
    };
    private readonly chunks = new Map<number, Uint8Array>();
    private readonly pending = new Map<number, Promise<Uint8Array>>();
    private readonly jobsByChunk = new Map<number, Job>();
    private readonly unread = new Set<number>();
    private readonly evicted = new Set<number>();
    private readonly queue: Job[] = [];
    private active = 0;
    private speculativeActive = 0;
    private demands = 0;
    private filling = false;
    private fillBusy = false;
    private fillCursor = 0;
    private fillOrder: number[] = [];
    private closed: Error | null = null;
    private diskWritable = true;

    constructor(readonly source: ZipSource, readonly options: StreamIoOptions,
        readonly disk: SparseWgbCache | null, private readonly changed: () => void = () => {}) {}

    private pump(): void {
        if (this.closed) return;
        this.queue.sort((a, b) => a.priority - b.priority);
        const speculativeLimit = Math.max(1, this.options.maxInflight >> 1);
        while (this.active < this.options.maxInflight && this.queue.length) {
            const job = this.queue[0];
            if (job.priority > 0 && this.speculativeActive >= speculativeLimit) break;
            if (job.priority === 2 && (this.demands > 0 || this.active > 0)) break;
            this.queue.shift();
            const speculative = job.priority > 0;
            this.active++;
            if (speculative) this.speculativeActive++;
            void job.run().catch(error => job.reject(error)).finally(() => {
                this.active--;
                if (speculative) this.speculativeActive--;
                this.changed();
                this.pump();
                this.pumpFill();
            });
        }
    }

    private schedule<T>(priority: number, run: () => Promise<T>, bind: (job: Job) => void): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const job: Job = { priority, run: async () => { resolve(await run()); }, reject };
            bind(job);
            this.queue.push(job);
            this.pump();
        });
    }

    private remember(ci: number, bytes: Uint8Array, speculative: boolean): void {
        if (this.closed) return;
        if (!this.chunks.has(ci)) this.stats.residentBytes += bytes.length;
        this.chunks.delete(ci);
        this.chunks.set(ci, bytes);
        if (speculative) this.unread.add(ci);
        while (this.stats.residentBytes > this.options.cacheBytes && this.chunks.size > 1) {
            const victim = this.chunks.keys().next().value!;
            const data = this.chunks.get(victim)!;
            this.chunks.delete(victim);
            this.stats.residentBytes -= data.length;
            this.stats.evictions++;
            this.evicted.add(victim);
            if (this.evicted.size > 4096) this.evicted.delete(this.evicted.values().next().value!);
            if (this.unread.delete(victim)) this.stats.prefetchEvictedUnreadBytes += data.length;
        }
    }

    private persist(ci: number, bytes: Uint8Array): void {
        if (this.closed || !this.disk || !this.diskWritable) return;
        try { this.disk.write(ci, bytes); }
        catch (error) { this.diskWritable = false; this.filling = false; this.diskError = String(error); this.stats.diskWriteFailures++; }
        if (this.disk.downloadedChunks === this.disk.chunkCount) {
            void this.disk.promote().then(() => this.changed()).catch(error => {
                this.diskError = `promotion failed: ${error}`;
                this.changed();
            });
        }
    }

    private getChunk(ci: number, speculative: boolean): Promise<Uint8Array> {
        if (this.closed) return Promise.reject(this.closed);
        const resident = this.chunks.get(ci);
        if (resident) {
            this.chunks.delete(ci); this.chunks.set(ci, resident);
            return Promise.resolve(resident);
        }
        const joined = this.pending.get(ci);
        if (joined) {
            if (!speculative) {
                const job = this.jobsByChunk.get(ci);
                if (job) { job.priority = 0; this.pump(); }
            }
            return joined;
        }
        let promise: Promise<Uint8Array>;
        if (this.disk?.has(ci)) {
            promise = this.disk.readAsync(ci).then(bytes => {
                if (!bytes) throw new Error(`Missing disk chunk ${ci}`);
                this.remember(ci, bytes, false);
                return bytes;
            });
        } else {
            let scheduled!: Job;
            promise = this.schedule(speculative ? 1 : 0, async () => {
                const speculativeFetch = scheduled.priority > 0;
                const start = ci * this.options.chunkBytes;
                const end = Math.min(this.source.size, start + this.options.chunkBytes);
                if (speculativeFetch) this.stats.prefetches++; else this.stats.netFetches++;
                if (this.evicted.has(ci)) this.stats.chunksRefetchedAfterEvict++;
                const bytes = await this.source.readRange(start, end, {
                    entryStart: start, entryEnd: end, cursor: start, sequential: false, speculative: speculativeFetch,
                });
                if (bytes.length !== end - start) throw new Error(`Short network chunk ${ci}: ${bytes.length}/${end - start}`);
                this.stats.netBytes += bytes.length;
                this.persist(ci, bytes);
                this.remember(ci, bytes, speculative);
                return bytes;
            }, job => { scheduled = job; this.jobsByChunk.set(ci, job); });
        }
        const result = promise.catch(error => {
            if (error instanceof BundleVersionError) this.close(error);
            throw error;
        }).finally(() => {
            this.pending.delete(ci);
            this.jobsByChunk.delete(ci);
            this.changed();
        });
        this.pending.set(ci, result);
        return result;
    }

    async read(off: number, len: number, hint?: ReadHint, asyncChannel = false): Promise<Uint8Array> {
        if (this.closed) throw this.closed;
        if (!Number.isSafeInteger(off) || !Number.isSafeInteger(len) || off < 0 || len < 0 || off > this.source.size) {
            throw new Error("Invalid streamed range");
        }
        const end = Math.min(this.source.size, off + len);
        if (end === off) return new Uint8Array(0);
        const speculative = hint?.speculative === true;
        if (asyncChannel) this.stats.asyncRequests++;
        if (!speculative) { this.stats.requests++; this.demands++; }
        const first = Math.floor(off / this.options.chunkBytes), last = Math.floor((end - 1) / this.options.chunkBytes);
        if (!speculative) {
            let cold = 0, joined = 0;
            for (let ci = first; ci <= last; ci++) {
                this.stats.chunksNeeded++;
                if (this.chunks.has(ci)) this.stats.chunksResidentHit++;
                else if (this.disk?.has(ci)) this.stats.chunksDiskHit++;
                else if (this.pending.has(ci)) { this.stats.chunksJoinedInflight++; joined++; }
                else { this.stats.chunksFetchedCold++; cold++; }
                this.unread.delete(ci);
            }
            if (!cold && !joined) this.stats.requestsAllResident++;
            if (!cold) this.stats.requestsNoNewFetch++;
        }
        try {
            const need: Promise<Uint8Array>[] = [];
            for (let ci = first; ci <= last; ci++) need.push(this.getChunk(ci, speculative));
            const parts = await Promise.all(need);
            const out = new Uint8Array(end - off);
            let filled = 0;
            for (let ci = first; ci <= last; ci++) {
                const base = ci * this.options.chunkBytes;
                const s = Math.max(off, base), e = Math.min(end, base + parts[ci - first].length);
                out.set(parts[ci - first].subarray(s - base, e - base), s - off);
                filled += e - s;
                if (!speculative) this.unread.delete(ci);
            }
            if (filled !== out.length) throw new Error(`Short assembled range ${filled}/${out.length}`);
            if (hint?.sequential) this.prefetch(end, hint);
            return out;
        } finally {
            if (!speculative) this.demands--;
            this.changed(); this.pump(); this.pumpFill();
        }
    }

    private prefetch(from: number, hint: ReadHint): void {
        const first = Math.floor(from / this.options.chunkBytes);
        for (let ci = first; ci < first + this.options.prefetchChunks; ci++) {
            if (ci * this.options.chunkBytes >= Math.min(this.source.size, hint.entryEnd)) break;
            if (this.chunks.has(ci) || this.disk?.has(ci) || this.pending.has(ci)) continue;
            // Bound queued speculation as well as running speculation.
            if (this.speculativeActive + this.queue.filter(job => job.priority > 0).length >= Math.max(1, this.options.maxInflight >> 1)) break;
            void this.getChunk(ci, true).catch(() => {});
        }
    }

    startFill(order: number[] = []): void {
        this.fillOrder = [...new Set(order.filter(ci => Number.isInteger(ci) && ci >= 0 && ci < Math.ceil(this.source.size / this.options.chunkBytes)))];
        this.filling = this.disk !== null && this.diskWritable;
        this.pumpFill();
    }

    private pumpFill(): void {
        if (!this.filling || this.fillBusy || this.closed || this.demands || this.active || this.queue.length) return;
        const total = Math.ceil(this.source.size / this.options.chunkBytes);
        let ci = this.fillOrder.shift();
        while (ci !== undefined && (this.disk!.has(ci) || this.pending.has(ci))) ci = this.fillOrder.shift();
        if (ci === undefined) {
            while (this.fillCursor < total && (this.disk!.has(this.fillCursor) || this.pending.has(this.fillCursor))) this.fillCursor++;
            ci = this.fillCursor;
        }
        if (ci >= total) {
            this.filling = false;
            void this.disk!.promote().then(() => this.changed()).catch(() => {});
            return;
        }
        const first = ci;
        let last = first;
        const batchChunks = Math.max(1, Math.floor(8 * 1024 * 1024 / this.options.chunkBytes));
        while (last + 1 < total && last - first + 1 < batchChunks && !this.disk!.has(last + 1) && !this.pending.has(last + 1)) last++;
        this.fillBusy = true;
        const batch = this.schedule(2, async () => {
            const start = first * this.options.chunkBytes, end = Math.min(this.source.size, (last + 1) * this.options.chunkBytes);
            this.stats.fillFetches++;
            const bytes = await this.source.readRange(start, end, { entryStart: start, entryEnd: end, cursor: start, sequential: false, speculative: true });
            if (bytes.length !== end - start) throw new Error(`Short fill range ${bytes.length}/${end - start}`);
            this.stats.netBytes += bytes.length; this.stats.fillBytes += bytes.length;
            for (let n = first; n <= last; n++) {
                const part = bytes.slice((n - first) * this.options.chunkBytes, Math.min(bytes.length, (n - first + 1) * this.options.chunkBytes));
                this.persist(n, part);
            }
            return bytes;
        }, job => { for (let n = first; n <= last; n++) this.jobsByChunk.set(n, job); });
        for (let n = first; n <= last; n++) {
            const part = batch.then(bytes => bytes.slice((n - first) * this.options.chunkBytes, Math.min(bytes.length, (n - first + 1) * this.options.chunkBytes)))
                .finally(() => { this.pending.delete(n); this.jobsByChunk.delete(n); });
            this.pending.set(n, part);
            void part.catch(() => {});
        }
        void batch.catch(error => {
            this.filling = false;
            if (error instanceof BundleVersionError) this.close(error);
        }).finally(() => {
            this.fillBusy = false; this.changed();
            // Yield between batches so queued guest messages get priority over fill.
            setTimeout(() => this.pumpFill(), 0);
        });
    }

    close(error = new Error("Stream I/O closed")): void {
        if (this.closed) return;
        this.closed = error;
        this.filling = false;
        for (const job of this.queue.splice(0)) job.reject(error);
        if (this.source instanceof HttpRangeSource) this.source.close();
    }
}
