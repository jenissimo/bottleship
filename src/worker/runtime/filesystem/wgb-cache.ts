import { Logger, LogCategory } from "../../core/logger";
import { SyncAccessHandleSource } from "@bottleship/formats/zip";
import { asWriteChunk } from "../../../dom-buffer";
import type { SyncAccessHandleLike } from "@bottleship/formats/zip";

const CACHE_DIR = "wgb-cache";

/** Fallback OPFS key for a nameless Blob (a real File carries its filename → keyed by it,
 *  so a disk drop dedupes against the same game's URL cache entry). */
const BLOB_MOUNT_KEY = "_blob-mount.wgb";

/** Sidecar in wgb-cache mapping key → last-used ms; drives LRU eviction order. */
const LRU_META_FILE = "_cache-lru.json";

/** Free-space headroom targeted when staging a bundle into wgb-cache, so a stage
 *  never fills the origin to the brim (saves/overlay writes must keep working). */
const STAGE_QUOTA_MARGIN = 256 * 1024 * 1024;

/** 8 hex chars of FNV-1a — enough to separate bundles, short enough to keep a key readable. */
function shortHash(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * OPFS filename for a bundle URL.
 *
 * The last path segment alone is NOT an identity when the query string is where the
 * bundle is actually named: the dev sidecar serves every bundle from `/wgb?path=...`, so
 * a bare-basename key files all of them under "wgb" and the second game launched reads
 * the first one's bytes. A query therefore folds into the key as a hash. The classic
 * `/apps/<name>.wgb[?v=2]` shape keeps its plain filename so an existing cache entry —
 * and the dedupe against the same file dropped from disk — still match.
 */
function urlToCacheKey(url: string): string {
    const [path, query] = url.split("?");
    const parts = path.split("/");
    const base = parts[parts.length - 1] || "game.wgb";
    if (base.toLowerCase().endsWith(".wgb")) return base;
    const named = query ? `${base}-${shortHash(query)}` : base;
    return named.toLowerCase().endsWith(".wgb") ? named : `${named}.wgb`;
}

/** Bytes scanned from the tail for the EOCD record: 22-byte record + max 64K comment. */
const EOCD_SCAN_BYTES = 22 + 0xffff;
const EOCD_SIGNATURE = 0x06054b50;

/**
 * Does this file actually end in a ZIP end-of-central-directory record?
 *
 * The only checks the cache used to make were "non-empty" and "matches Content-Length",
 * and neither can tell a bundle from what a server hands back when something goes wrong:
 * an HTML error page is a perfectly well-formed 1.6 KB response, and once written under
 * the bundle's key it is served from cache forever, failing the loader with "EOCD not
 * found" on every later launch with no way for the user to know why. Reading the tail is
 * one seek and answers the question the loader is about to ask anyway — so a poisoned
 * entry is caught on write AND healed on read, including entries already on disk.
 */
function hasZipEocd(sah: SyncAccessHandleLike, size: number): boolean {
    if (size < 22) return false;
    const scan = Math.min(size, EOCD_SCAN_BYTES);
    const buf = new Uint8Array(scan);
    const got = sah.read(buf, { at: size - scan });
    if (got < 22) return false;
    const view = new DataView(buf.buffer, buf.byteOffset, got);
    for (let i = got - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === EOCD_SIGNATURE) return true;
    }
    return false;
}

/**
 * Simple OPFS-backed cache for WGB files.
 *
 * Layout: navigator.storage / "bottleship" / "wgb-cache" / "{filename}.wgb"
 *
 * Usage pattern:
 *   1. `get(url)` on startup — returns cached buffer or null.
 *   2. On cache miss: start game via HttpRangeSource, then call `downloadAndStore(url)` in background.
 *   3. Next launch: `get()` returns the full buffer → BufferSource (no network).
 */
export class WgbCache {
    private static cacheDir: FileSystemDirectoryHandle | null = null;
    /** Currently-open OPFS sync source (one SAH per file — closed before opening another). */
    private static currentSource: SyncAccessHandleSource | null = null;
    /** OPFS cache key (filename) for {@link currentSource}, if any. */
    private static currentSourceKey: string | null = null;

    /** Close the mounted bundle sync reader so OPFS writes to the same file can proceed. */
    static releaseMountedSource(): void {
        if (this.currentSource) {
            this.currentSource.close();
            this.currentSource = null;
        }
        this.currentSourceKey = null;
    }

    /**
     * Persist bytes to wgb-cache/{key}. Prefers SAH writes (same path as mountBlobSync).
     * Releases any mounted reader on the same key first — SAH and createWritable are
     * mutually exclusive on one OPFS file (NoModificationAllowedError).
     */
    private static async writeCacheFile(key: string, buffer: Uint8Array): Promise<void> {
        const dir = await this.getCacheDir();
        if (!dir) return;

        if (this.currentSourceKey === key) {
            this.releaseMountedSource();
        }

        const fileHandle = await dir.getFileHandle(key, { create: true });
        const createSah = (fileHandle as unknown as { createSyncAccessHandle?: () => Promise<SyncAccessHandleLike> }).createSyncAccessHandle;
        if (typeof createSah === "function") {
            const sah = await createSah.call(fileHandle);
            try {
                sah.truncate(0);
                let pos = 0;
                while (pos < buffer.byteLength) {
                    const n = sah.write(buffer.subarray(pos), { at: pos });
                    if (n <= 0) throw new Error("SAH short write");
                    pos += n;
                }
                sah.flush();
            } finally {
                try { sah.close(); } catch { /* ignore */ }
            }
            this.queueTouch(key);
            return;
        }

        const writable = await fileHandle.createWritable();
        try {
            await writable.write(asWriteChunk(buffer));
            await writable.close();
        } catch (e) {
            try { await writable.abort(); } catch { /* ignore */ }
            throw e;
        }
        this.queueTouch(key);
    }

    private static async getCacheDir(): Promise<FileSystemDirectoryHandle | null> {
        if (this.cacheDir) return this.cacheDir;
        try {
            const opfsRoot = await navigator.storage.getDirectory();
            const bottleship = await opfsRoot.getDirectoryHandle("bottleship", { create: true });
            this.cacheDir = await bottleship.getDirectoryHandle(CACHE_DIR, { create: true });
            return this.cacheDir;
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `WgbCache: OPFS unavailable: ${e}`);
            return null;
        }
    }

    // ---- LRU bookkeeping + quota-pressure eviction ------------------------------
    //
    // Cache entries are RECOVERABLE (the user still has the file; the server still
    // has the URL) while saves are not, so storage pressure is always resolved by
    // dropping least-recently-used wgb-cache entries — never by touching game
    // containers. Keeping our own usage low is also the practical defense against
    // the browser's origin-wide best-effort eviction (which would take saves too).

    /** Serializes best-effort LRU sidecar writes so touches don't clobber each other. */
    private static lruChain: Promise<void> = Promise.resolve();

    /** Fire-and-forget "this key was just used" (opened / mounted / written). */
    private static queueTouch(key: string): void {
        this.lruChain = this.lruChain.then(() => this.touchKey(key)).catch(() => { /* best-effort */ });
    }

    private static async touchKey(key: string): Promise<void> {
        const dir = await this.getCacheDir();
        if (!dir) return;
        const meta = await this.readLruMeta(dir);
        meta[key] = Date.now();
        await this.writeLruMeta(dir, meta);
    }

    private static async readLruMeta(dir: FileSystemDirectoryHandle): Promise<Record<string, number>> {
        try {
            const fh = await dir.getFileHandle(LRU_META_FILE);
            const parsed = JSON.parse(await (await fh.getFile()).text());
            return parsed && typeof parsed === "object" ? parsed as Record<string, number> : {};
        } catch {
            return {};
        }
    }

    private static async writeLruMeta(dir: FileSystemDirectoryHandle, meta: Record<string, number>): Promise<void> {
        try {
            const fh = await dir.getFileHandle(LRU_META_FILE, { create: true });
            const w = await fh.createWritable();
            await w.write(JSON.stringify(meta));
            await w.close();
        } catch { /* best-effort */ }
    }

    /**
     * Make room for `bytesNeeded` of new cache data by evicting least-recently-used
     * wgb-cache entries (skipping `excludeKey` and the currently-mounted bundle).
     * Returns false when even a drained cache cannot fit the bundle — the caller
     * then falls back to the no-copy blob path instead of thrashing the origin.
     */
    static async ensureSpaceFor(bytesNeeded: number, excludeKey?: string): Promise<boolean> {
        let est: { usage?: number; quota?: number } | null = null;
        try { est = await navigator.storage?.estimate?.() ?? null; } catch { /* unsupported */ }
        // No estimate → optimistic: a genuinely full disk fails the write loudly later.
        if (!est?.quota) return true;
        let free = est.quota - (est.usage ?? 0);
        if (free >= bytesNeeded + STAGE_QUOTA_MARGIN) return true;

        const dir = await this.getCacheDir();
        if (!dir) return false;
        const meta = await this.readLruMeta(dir);
        const victims: Array<{ key: string; size: number; used: number }> = [];
        for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
            if (handle.kind !== "file" || name === LRU_META_FILE) continue;
            if (name === excludeKey || name === this.currentSourceKey) continue;
            try {
                const size = (await (handle as FileSystemFileHandle).getFile()).size;
                victims.push({ key: name, size, used: meta[name] ?? 0 });
            } catch { /* locked — not evictable right now */ }
        }
        victims.sort((a, b) => a.used - b.used);
        for (const v of victims) {
            if (free >= bytesNeeded + STAGE_QUOTA_MARGIN) break;
            try {
                await dir.removeEntry(v.key);
                delete meta[v.key];
                free += v.size;
                Logger.log(LogCategory.SYSTEM,
                    `WgbCache: evicted LRU "${v.key}" (${(v.size / 1024 / 1024).toFixed(1)} MB) for ${(bytesNeeded / 1024 / 1024).toFixed(1)} MB stage`);
            } catch { /* locked/racing — skip */ }
        }
        await this.writeLruMeta(dir, meta);
        // The margin is a target, not a hard floor — fitting the bytes at all is enough.
        if (free >= bytesNeeded) return true;
        Logger.warn(LogCategory.SYSTEM,
            `WgbCache: cannot free ${(bytesNeeded / 1024 / 1024).toFixed(1)} MB (free ${(free / 1024 / 1024).toFixed(1)} MB after eviction)`);
        return false;
    }

    /** Returns the cached WGB as a buffer, or null if not cached. */
    static async get(url: string): Promise<Uint8Array | null> {
        return this.getByKey(urlToCacheKey(url));
    }

    /** Returns cached buffer by explicit OPFS filename key. */
    static async getByKey(key: string): Promise<Uint8Array | null> {
        const dir = await this.getCacheDir();
        if (!dir) return null;
        try {
            const fileHandle = await dir.getFileHandle(key);
            const file = await fileHandle.getFile();
            const buf = await file.arrayBuffer();
            Logger.log(LogCategory.SYSTEM,
                `WgbCache: hit "${key}" (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB)`);
            return new Uint8Array(buf);
        } catch {
            return null;
        }
    }

    /**
     * Returns the cached WGB as a disk-backed Blob (the OPFS File) WITHOUT reading it
     * into RAM. Slicing the returned File reads only the requested range from disk —
     * use this for very large bundles to avoid holding the whole thing in memory.
     */
    static async getBlob(url: string): Promise<Blob | null> {
        const dir = await this.getCacheDir();
        if (!dir) return null;
        try {
            const fileHandle = await dir.getFileHandle(urlToCacheKey(url));
            const file = await fileHandle.getFile();
            Logger.log(LogCategory.SYSTEM,
                `WgbCache: hit "${urlToCacheKey(url)}" (${(file.size / 1024 / 1024).toFixed(1)} MB, disk-backed)`);
            return file;
        } catch {
            return null;
        }
    }

    /** Persist a synthesized WGB buffer under an explicit key. */
    static async put(key: string, buffer: Uint8Array): Promise<void> {
        try {
            await this.writeCacheFile(key, buffer);
            Logger.log(LogCategory.SYSTEM,
                `WgbCache: put "${key}" (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB)`);
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `WgbCache: put failed for "${key}": ${e}`);
        }
    }

    /**
     * Downloads the WGB with streaming progress, saves it to OPFS, and returns the buffer.
     * Use this for the first-run (cache miss) flow so the caller can start the game immediately
     * without a second download.
     *
     * @param onProgress  Called repeatedly with (bytesLoaded, bytesTotal).
     *                    bytesTotal is 0 when Content-Length is unavailable.
     */
    static async downloadWithProgress(
        url: string,
        onProgress: (loaded: number, total: number) => void,
    ): Promise<Uint8Array> {
        const key = urlToCacheKey(url);

        Logger.log(LogCategory.SYSTEM, `WgbCache: downloading "${key}"`);
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

        const contentLength = Number(resp.headers.get("content-length") ?? "0");
        const body = resp.body;

        let buffer: Uint8Array;
        if (body) {
            const chunks: Uint8Array[] = [];
            let loaded = 0;
            const reader = body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                loaded += value.byteLength;
                onProgress(loaded, contentLength);
            }
            // Concatenate chunks into a single buffer
            buffer = new Uint8Array(loaded);
            let offset = 0;
            for (const chunk of chunks) {
                buffer.set(chunk, offset);
                offset += chunk.byteLength;
            }
        } else {
            // Fallback for environments without streaming body support
            const ab = await resp.arrayBuffer();
            buffer = new Uint8Array(ab);
            onProgress(buffer.byteLength, buffer.byteLength);
        }

        const mb = (buffer.byteLength / 1024 / 1024).toFixed(1);
        Logger.log(LogCategory.SYSTEM, `WgbCache: download done (${mb} MB), writing to OPFS`);

        // Persist to OPFS (best-effort — don't fail the launch if OPFS is unavailable or locked).
        try {
            await this.writeCacheFile(key, buffer);
            Logger.log(LogCategory.SYSTEM, `WgbCache: "${key}" cached (${mb} MB)`);
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `WgbCache: OPFS write failed for "${key}": ${e}`);
        }

        return buffer;
    }

    /**
     * Stream-download the WGB straight into OPFS via a FileSystemSyncAccessHandle and
     * return a {@link SyncAccessHandleSource} — the bytes are NEVER held in a single
     * contiguous RAM buffer. This is the only viable first-run (cache-miss) path for
     * very large bundles: {@link downloadWithProgress} concatenates the whole file into
     * one `Uint8Array`, which throws "Array buffer allocation failed" past V8's max
     * ArrayBuffer size (~2GB) — e.g. the 2.5GB XIII bundle.
     *
     * Returns null when OPFS / SAH / a streaming body is unavailable; the caller must
     * then fall back to the in-RAM download (only viable for bundles under the cap).
     * Throws on a network error (caller treats a throw the same as a null → RAM fallback).
     */
    static async downloadToSyncSource(
        url: string,
        onProgress: (loaded: number, total: number) => void,
    ): Promise<SyncAccessHandleSource | null> {
        const dir = await this.getCacheDir();
        if (!dir) return null;
        const key = urlToCacheKey(url);
        const partKey = `${key}.part`;

        // SAH and any prior reader on this file are mutually exclusive (one SAH per file).
        this.releaseMountedSource();

        // Stage under ".part" and promote only once the bytes check out, exactly as
        // stageInBackground does. Writing the live key directly means a torn stream — a
        // reload, a dropped connection, a quota wall mid-download — leaves a partial file
        // at the name every later launch reads, and the game never starts again.
        try { await dir.removeEntry(partKey); } catch { /* none */ }
        const fileHandle = await dir.getFileHandle(partKey, { create: true });
        const handleOps = fileHandle as unknown as {
            createSyncAccessHandle?: () => Promise<SyncAccessHandleLike>;
            move?: (name: string) => Promise<void>;
        };
        if (typeof handleOps.createSyncAccessHandle !== "function" || typeof handleOps.move !== "function") {
            try { await dir.removeEntry(partKey); } catch { /* best-effort */ }
            Logger.warn(LogCategory.SYSTEM, `WgbCache: createSyncAccessHandle/move unavailable — cannot stream "${key}"`);
            return null;
        }

        Logger.log(LogCategory.SYSTEM, `WgbCache: streaming "${key}" to OPFS (no RAM copy)`);
        const resp = await fetch(url);
        if (!resp.ok) {
            try { await dir.removeEntry(partKey); } catch { /* best-effort */ }
            throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }
        const contentLength = Number(resp.headers.get("content-length") ?? "0");
        const body = resp.body;
        if (!body) {
            try { await dir.removeEntry(partKey); } catch { /* best-effort */ }
            Logger.warn(LogCategory.SYSTEM, `WgbCache: no streaming body for "${key}" — cannot stream`);
            return null;
        }
        if (contentLength > 0 && !(await this.ensureSpaceFor(contentLength, key))) {
            try { await dir.removeEntry(partKey); } catch { /* best-effort */ }
            Logger.warn(LogCategory.SYSTEM, `WgbCache: quota too tight to stream "${key}" to OPFS`);
            return null;
        }

        const sah = await handleOps.createSyncAccessHandle();
        let size = 0;
        let complete = false;
        try {
            sah.truncate(0);
            let pos = 0;
            const reader = body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                let w = 0;
                while (w < value.byteLength) {
                    const n = sah.write(value.subarray(w), { at: pos + w });
                    if (n <= 0) throw new Error("SAH short write");
                    w += n;
                }
                pos += value.byteLength;
                onProgress(pos, contentLength);
            }
            sah.flush();
            size = sah.getSize();
            // Content-Length catches a truncated transfer; the EOCD scan catches a
            // complete transfer of something that is not a bundle (an HTML error page
            // arrives intact and would otherwise be cached under the bundle's name).
            complete = (contentLength <= 0 || size === contentLength) && hasZipEocd(sah, size);
        } finally {
            try { sah.close(); } catch { /* best-effort */ }
        }

        if (!complete) {
            try { await dir.removeEntry(partKey); } catch { /* best-effort */ }
            Logger.warn(LogCategory.SYSTEM,
                `WgbCache: streamed "${key}" is not a usable bundle (${size}/${contentLength} bytes) — discarded, not cached`);
            return null;
        }

        try { await dir.removeEntry(key); } catch { /* no prior entry */ }
        await handleOps.move(key);
        Logger.log(LogCategory.SYSTEM, `WgbCache: streamed "${key}" to OPFS (${(size / 1024 / 1024).toFixed(1)} MB, off-disk, no RAM copy)`);
        return this.openSyncSourceByKey(key);
    }

    /**
     * Background-stage a URL bundle into the cache WITHOUT disturbing the live
     * source: stream into "<key>.part", then promote with move() only after the
     * byte count checks out — a torn download (page reload mid-stream) leaves at
     * worst a stale .part, never a truncated file that would poison
     * openSyncSourceForUrl on every later launch. No-op if already cached.
     */
    static async stageInBackground(url: string): Promise<boolean> {
        const dir = await this.getCacheDir();
        if (!dir) return false;
        const key = urlToCacheKey(url);
        try { await dir.getFileHandle(key); return true; } catch { /* not cached yet */ }

        const partKey = `${key}.part`;
        try { await dir.removeEntry(partKey); } catch { /* none */ }

        const resp = await fetch(url);
        if (!resp.ok || !resp.body) return false;
        const contentLength = Number(resp.headers.get("content-length") ?? "0");
        if (contentLength > 0 && !(await this.ensureSpaceFor(contentLength, key))) {
            Logger.warn(LogCategory.SYSTEM, `WgbCache: quota too tight to background-stage "${key}"`);
            return false;
        }

        const fileHandle = await dir.getFileHandle(partKey, { create: true });
        const movable = fileHandle as unknown as { move?: (name: string) => Promise<void>; createSyncAccessHandle?: () => Promise<SyncAccessHandleLike> };
        if (typeof movable.createSyncAccessHandle !== "function" || typeof movable.move !== "function") {
            try { await dir.removeEntry(partKey); } catch { /* best-effort */ }
            return false;
        }

        const sah = await movable.createSyncAccessHandle();
        let size = 0;
        let isZip = false;
        try {
            sah.truncate(0);
            const reader = resp.body.getReader();
            let pos = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                let w = 0;
                while (w < value.byteLength) {
                    const n = sah.write(value.subarray(w), { at: pos + w });
                    if (n <= 0) throw new Error("SAH short write");
                    w += n;
                }
                pos += value.byteLength;
            }
            sah.flush();
            size = sah.getSize();
            isZip = hasZipEocd(sah, size);
        } finally {
            try { sah.close(); } catch { /* best-effort */ }
        }

        if (!isZip || (contentLength > 0 && size !== contentLength)) {
            try { await dir.removeEntry(partKey); } catch { /* best-effort */ }
            Logger.warn(LogCategory.SYSTEM,
                `WgbCache: background stage of "${key}" is not a usable bundle (${size}/${contentLength}) — discarded`);
            return false;
        }
        await movable.move(key);
        this.queueTouch(key);
        return true;
    }

    /**
     * Downloads the full WGB and writes it to OPFS.
     * Legacy method — kept for compatibility; prefer downloadWithProgress for new code.
     */
    static async downloadAndStore(url: string): Promise<void> {
        await this.downloadWithProgress(url, () => { /* no-op progress */ });
    }

    /**
     * Open an already-cached OPFS bundle as a SYNC ZipSource backed by a
     * FileSystemSyncAccessHandle — reads come straight off disk, so the bundle is
     * NOT held in worker RAM as a 1.5GB BufferSource. Returns null if the file isn't
     * cached or sync-access handles are unavailable (caller falls back to BufferSource).
     */
    static async openSyncSourceForUrl(url: string): Promise<SyncAccessHandleSource | null> {
        const key = urlToCacheKey(url);
        if (!(await this.cacheMatchesServer(url, key))) return null;
        return this.openSyncSourceByKey(key);
    }

    /**
     * Is the cached copy still the file this URL serves?
     *
     * A cache keyed by name has no way to notice the bundle behind that name changed, so a
     * rebuilt bundle keeps launching as the old one — silently, which is worse than failing.
     * One HEAD settles it. Every uncertain answer (no server, no Content-Length, a method
     * the server dislikes) keeps the cache: this must never turn an offline launch, or a
     * blob/relative URL that was never fetched over HTTP, into a failure.
     */
    private static async cacheMatchesServer(url: string, key: string): Promise<boolean> {
        const dir = await this.getCacheDir();
        if (!dir) return true;
        let cachedSize: number;
        try {
            cachedSize = (await (await dir.getFileHandle(key)).getFile()).size;
        } catch {
            return true; // not cached — nothing to invalidate
        }
        try {
            const resp = await fetch(url, { method: "HEAD" });
            if (!resp.ok) return true;
            const len = Number(resp.headers.get("content-length") ?? "0");
            if (!(len > 0) || len === cachedSize) return true;
            await dir.removeEntry(key);
            Logger.log(LogCategory.SYSTEM,
                `WgbCache: "${key}" changed on the server (${cachedSize} → ${len} bytes) — re-downloading`);
            return false;
        } catch {
            return true; // offline / non-HTTP URL — the cached copy is what we have
        }
    }

    private static async openSyncSourceByKey(key: string): Promise<SyncAccessHandleSource | null> {
        const dir = await this.getCacheDir();
        if (!dir) return null;
        // Release any prior source (exclusive: one SAH per file).
        this.releaseMountedSource();
        try {
            const fileHandle = await dir.getFileHandle(key); // no create — must already exist
            const createSah = (fileHandle as unknown as { createSyncAccessHandle?: () => Promise<SyncAccessHandleLike> }).createSyncAccessHandle;
            if (typeof createSah !== "function") return null;
            const sah = await createSah.call(fileHandle);
            const size = sah.getSize();
            // Reject anything that is not a ZIP. A truncated download, or a server's HTML
            // error page written under the bundle's key, both survive a size test and then
            // make the loader fail with "EOCD not found" on this and every later launch.
            // Dropping the entry here is what re-downloads it and heals a cache poisoned
            // before this check existed.
            if (!hasZipEocd(sah, size)) {
                try { sah.close(); } catch { /* best-effort */ }
                try { await dir.removeEntry(key); } catch { /* best-effort */ }
                Logger.warn(LogCategory.SYSTEM,
                    `WgbCache: discarded cache entry "${key}" (${size} bytes, no ZIP end-of-central-directory) — will re-download`);
                return null;
            }
            const source = new SyncAccessHandleSource(sah, size);
            this.currentSource = source;
            this.currentSourceKey = key;
            this.queueTouch(key);
            Logger.log(LogCategory.SYSTEM, `WgbCache: opened "${key}" as sync source (${(size / 1024 / 1024).toFixed(1)} MB, off-disk, no RAM copy)`);
            return source;
        } catch {
            return null; // not cached / SAH unavailable
        }
    }

    /**
     * Materialize a disk Blob into OPFS and return a SYNC ZipSource backed by a
     * FileSystemSyncAccessHandle. Large bundles (e.g. the 1.5GB Discworld Noir WGB)
     * read synchronously off disk — no 1.5GB ArrayBuffer (OOM) and no async BlobSource
     * (which makes readRangeSync return null → fgetc sees a false EOF → games that
     * inline getc fail with "Decompression error").
     *
     * Keyed by the File's filename (a real drag/picked File has one) so a disk drop
     * shares the SAME OPFS copy as that game's URL-cache entry — no duplicate. The
     * on-disk copy is reused when its size already matches. Returns null if OPFS /
     * sync-access handles are unavailable (caller falls back to an async BlobSource).
     */
    static async mountBlobSync(
        blob: Blob,
        onProgress?: (done: number, total: number) => void,
    ): Promise<SyncAccessHandleSource | null> {
        const dir = await this.getCacheDir();
        if (!dir) return null;

        // Release any prior source (exclusive: one SAH per file).
        this.releaseMountedSource();

        const name = (blob as File).name;
        const key = (typeof name === "string" && name) ? urlToCacheKey(name) : BLOB_MOUNT_KEY;

        try {
            const fileHandle = await dir.getFileHandle(key, { create: true });

            // Reuse the on-disk copy if it already matches this blob's size (fast repeat
            // loads, and dedupe vs a URL-cache copy of the same game).
            let needsWrite = true;
            try {
                const existing = await fileHandle.getFile();
                if (existing.size === blob.size && blob.size > 0) needsWrite = false;
            } catch { /* no existing file */ }

            if (needsWrite && !(await this.ensureSpaceFor(blob.size, key))) {
                // Don't leave the create:true placeholder behind — an empty entry
                // would shadow nothing useful and confuse later size checks.
                try {
                    if ((await fileHandle.getFile()).size === 0) await dir.removeEntry(key);
                } catch { /* best-effort */ }
                Logger.warn(LogCategory.SYSTEM, `WgbCache: quota too tight to stage "${key}" — falling back to async blob`);
                return null;
            }

            const createSah = (fileHandle as unknown as { createSyncAccessHandle?: () => Promise<SyncAccessHandleLike> }).createSyncAccessHandle;
            if (typeof createSah !== "function") {
                Logger.warn(LogCategory.SYSTEM, `WgbCache: createSyncAccessHandle unavailable — falling back to async blob`);
                return null;
            }
            const sah = await createSah.call(fileHandle);

            if (needsWrite) {
                const t0 = performance.now();
                sah.truncate(0);
                const CHUNK = 32 * 1024 * 1024; // 32 MB streamed copy (bounded RAM)
                let pos = 0;
                onProgress?.(0, blob.size);
                while (pos < blob.size) {
                    const end = Math.min(blob.size, pos + CHUNK);
                    const chunk = new Uint8Array(await blob.slice(pos, end).arrayBuffer());
                    let w = 0;
                    while (w < chunk.byteLength) {
                        const n = sah.write(chunk.subarray(w), { at: pos + w });
                        if (n <= 0) throw new Error("SAH short write");
                        w += n;
                    }
                    pos = end;
                    onProgress?.(pos, blob.size);
                }
                sah.flush();
                const mb = (blob.size / 1024 / 1024).toFixed(1);
                Logger.log(LogCategory.SYSTEM, `WgbCache: blob "${key}" mounted to OPFS (${mb} MB, ${(performance.now() - t0) | 0}ms, sync)`);
            } else {
                Logger.log(LogCategory.SYSTEM, `WgbCache: blob "${key}" reuse on-disk copy (${(blob.size / 1024 / 1024).toFixed(1)} MB, sync)`);
            }

            // The reuse branch trusts a size match, which an entry written by an older
            // build (or a half-finished copy of the same length) can satisfy without being
            // a bundle. Confirm before handing it to the loader; a failure here drops the
            // entry so the next attempt re-stages instead of failing identically forever.
            const size = sah.getSize();
            if (!hasZipEocd(sah, size)) {
                try { sah.close(); } catch { /* best-effort */ }
                try { await dir.removeEntry(key); } catch { /* best-effort */ }
                Logger.warn(LogCategory.SYSTEM,
                    `WgbCache: staged blob "${key}" (${size} bytes) has no ZIP end-of-central-directory — falling back to async blob`);
                return null;
            }

            const source = new SyncAccessHandleSource(sah, size);
            this.currentSource = source;
            this.currentSourceKey = key;
            this.queueTouch(key);
            return source;
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `WgbCache: mountBlobSync failed (${e}) — falling back to async blob`);
            return null;
        }
    }

    /** OPFS cache key (filename) for a bundle URL — exposed so callers can look up overrides. */
    static keyForUrl(url: string): string {
        return urlToCacheKey(url);
    }

    /**
     * Per-bundle manifest override authored in the UI (manifest editor), stored as
     * bottleship/_manifest-overrides.json keyed by cache filename. Returns the partial
     * override for `key` (deep-merged onto the bundle manifest at load) or null.
     */
    static async getManifestOverride(key: string): Promise<Record<string, unknown> | null> {
        try {
            const root = await navigator.storage.getDirectory();
            const bottleship = await root.getDirectoryHandle("bottleship");
            const fh = await bottleship.getFileHandle("_manifest-overrides.json");
            const db = JSON.parse(await (await fh.getFile()).text());
            const ov = db?.[key];
            return ov && typeof ov === "object" ? ov as Record<string, unknown> : null;
        } catch {
            return null; // no overrides file / unreadable
        }
    }

    /** Cache identity + poison rejection, exposed for tools/tests/wgb-cache-key.test.ts. */
    static readonly __testing = { urlToCacheKey, hasZipEocd };

    /** Removes a cached entry (e.g., for cache invalidation). */
    static async evict(url: string): Promise<void> {
        const dir = await this.getCacheDir();
        if (!dir) return;
        const key = urlToCacheKey(url);
        try {
            await dir.removeEntry(key);
            Logger.log(LogCategory.SYSTEM, `WgbCache: evicted "${key}"`);
        } catch { /* not cached, ignore */ }
    }
}
