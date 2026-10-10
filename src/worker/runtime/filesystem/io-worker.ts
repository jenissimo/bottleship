import { HttpRangeSource, type ReadHint } from "@bottleship/formats/zip";
import * as P from "./sab-io-protocol";
import { SparseWgbCache } from "./sparse-wgb-cache";
import { StreamIoRuntime } from "./stream-io-runtime";

let ctl: Int32Array;
let meta: Float64Array;
let data: Uint8Array;
let runtime: StreamIoRuntime | null = null;
let shuttingDown = false;
let lastDiskError: string | null = null;

const post = (message: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(message, transfer);

function publishStats(): void {
    if (!runtime) return;
    const s = runtime.stats;
    if (runtime.diskError && runtime.diskError !== lastDiskError) {
        lastDiskError = runtime.diskError;
        post({ type: "log", msg: `disk cache warning: ${runtime.diskError}` });
    }
    const values: Array<[number, number]> = [
        [P.CTL_IO_DISK_COMPLETE, runtime.disk?.promoted ? 1 : 0], [P.CTL_IO_NET_FETCHES, s.netFetches], [P.CTL_IO_PREFETCHES, s.prefetches],
        [P.CTL_REQS, s.requests], [P.CTL_IO_CHUNKS_NEEDED, s.chunksNeeded],
        [P.CTL_IO_CHUNKS_RESIDENT_HIT, s.chunksResidentHit], [P.CTL_IO_CHUNKS_DISK_HIT, s.chunksDiskHit],
        [P.CTL_IO_CHUNKS_JOINED_INFLIGHT, s.chunksJoinedInflight], [P.CTL_IO_CHUNKS_FETCHED_COLD, s.chunksFetchedCold],
        [P.CTL_IO_CHUNKS_REFETCHED_AFTER_EVICT, s.chunksRefetchedAfterEvict],
        [P.CTL_IO_REQS_ALL_RESIDENT, s.requestsAllResident], [P.CTL_IO_REQS_NO_NEW_FETCH, s.requestsNoNewFetch],
        [P.CTL_IO_EVICTIONS, s.evictions], [P.CTL_IO_RESIDENT_KB, s.residentBytes / 1024],
        [P.CTL_IO_NET_KB, s.netBytes / 1024], [P.CTL_IO_PREFETCH_EVICTED_UNREAD_KB, s.prefetchEvictedUnreadBytes / 1024],
        [P.CTL_IO_ASYNC_REQS, s.asyncRequests], [P.CTL_IO_FILL_FETCHES, s.fillFetches],
        [P.CTL_IO_FILL_KB, s.fillBytes / 1024], [P.CTL_IO_DISK_WRITE_FAILURES, s.diskWriteFailures], [P.CTL_IO_DISK_CHUNKS, runtime.disk?.downloadedChunks ?? 0],
    ];
    for (const [index, value] of values) Atomics.store(ctl, index, value | 0);
}

async function initialize(msg: any): Promise<void> {
    const mismatch = P.layoutMismatch(msg.layout);
    if (mismatch) throw new Error(`SAB layout mismatch (${mismatch})`);
    ctl = new Int32Array(msg.sab, 0, P.CTL_WORDS);
    meta = new Float64Array(msg.sab, P.META_OFFSET_BYTES, P.META_WORDS);
    data = new Uint8Array(msg.sab, P.DATA_OFFSET_BYTES, P.DATA_BYTES);
    const tune = msg.tune ?? {};
    const chunkBytes = Math.max(64, tune.chunkKB ?? 1024) * 1024;
    const maxInflight = Math.max(1, tune.maxInflight ?? 6);
    const cacheBytes = (tune.cacheMB ? Math.max(16, tune.cacheMB) * 1024 * 1024 : maxInflight * chunkBytes * 8);
    const prefetchChunks = Math.max(0, tune.prefetchChunks ?? 2);
    const source = await HttpRangeSource.create(msg.url);
    if (!source.etag) { source.close(); throw new Error("WGB streaming requires a strong ETag"); }
    if (msg.expected && (source.etag !== msg.expected.etag || source.size !== msg.expected.size)) {
        source.close();
        throw new Error("WGB version changed while restarting I/O worker");
    }
    const residencySab = new SharedArrayBuffer(Math.ceil(Math.ceil(source.size / chunkBytes) / 32) * 4);
    const residency = new Int32Array(residencySab);
    const disk = tune.disk === false ? null : await SparseWgbCache.open({ url: msg.url, size: source.size, etag: source.etag ?? "" }, chunkBytes, residency);
    if (disk && disk.downloadedChunks === disk.chunkCount) {
        try { await disk.promote(); } catch (error) { post({ type: "log", msg: `promotion failed: ${error}` }); }
    }
    runtime = new StreamIoRuntime(source, { chunkBytes, maxInflight, cacheBytes, prefetchChunks }, disk, publishStats);
    Atomics.store(ctl, P.CTL_IO_CFG_CHUNK_KB, chunkBytes / 1024);
    Atomics.store(ctl, P.CTL_IO_CFG_CACHE_MB, cacheBytes / (1024 * 1024));
    Atomics.store(ctl, P.CTL_IO_CFG_PREFETCH_CHUNKS, prefetchChunks);
    Atomics.store(ctl, P.CTL_IO_CFG_MAX_INFLIGHT, maxInflight);
    Atomics.store(ctl, P.CTL_IO_DISK_ARMED, disk ? 1 : 0);
    Atomics.store(ctl, P.CTL_IO_ARMED, 1);
    publishStats();
    Atomics.store(ctl, P.CTL_IO_HEARTBEAT, Date.now() | 0);
    setInterval(() => Atomics.store(ctl, P.CTL_IO_HEARTBEAT, Date.now() | 0), 250);
    post({ type: "ready", size: source.size, chunkBytes, residencySab, etag: source.etag });
}

async function request(hint?: ReadHint): Promise<void> {
    const off = meta[P.META_REQ_OFF], len = meta[P.META_REQ_LEN], seq = meta[P.META_REQ_SEQ];
    try {
        const buf = await runtime!.read(off, len, hint);
        P.publishResponse(ctl, data, seq, Atomics.load(ctl, P.CTL_REQ_SEQ), buf);
    } catch (error) {
        P.publishResponse(ctl, data, seq, Atomics.load(ctl, P.CTL_REQ_SEQ), null);
        post({ type: "log", msg: `read failed off=${off} len=${len}: ${error}` });
    }
}

async function asyncRequest(msg: any): Promise<void> {
    try {
        const buf = await runtime!.read(msg.off, msg.len, msg.hint, true);
        post({ type: "aresp", id: msg.id, ok: true, buf: buf.buffer }, [buf.buffer as ArrayBuffer]);
    } catch (error) {
        post({ type: "aresp", id: msg.id, ok: false, message: String(error) });
    }
}

self.onmessage = (event: MessageEvent) => {
    const msg = event.data;
    if (shuttingDown) return;
    if (msg?.type === "init") {
        void initialize(msg).catch(error => post({ type: "error", message: String(error) }));
    } else if (msg?.type === "req") {
        void request(msg.hint);
    } else if (msg?.type === "areq") {
        void asyncRequest(msg);
    } else if (msg?.type === "fill") {
        runtime?.startFill(msg.order);
    } else if (msg?.type === "close") {
        shuttingDown = true;
        runtime?.close();
        void (async () => {
            await runtime?.disk?.close();
            post({ type: "closed" });
            self.close();
        })();
    }
};
