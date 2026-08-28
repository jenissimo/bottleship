import { asBlobPart } from "../dom-buffer";

// Synchronous inflate — usable where DecompressionStream is not (guest traps).
export { adler32, inflateRawSync, inflateZlibSync } from "./inflate";
export type { InflateOutcome, InflateStatus } from "./inflate";

const EOCD_SIGNATURE = 0x06054b50;
const CEN_SIGNATURE = 0x02014b50;
const LOC_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 0x10000 + 22;

/**
 * What the layer that holds the FILE knows and the layers below it cannot infer:
 * which entry this read belongs to, where its cursor is, and whether the caller is
 * scanning. Everything below `ZipArchive` sees archive offsets only, so it cannot
 * tell "sequential through a 50 MB entry" from "two unrelated adjacent reads" —
 * which is the difference between a readahead that lands and one that evicts live
 * data. Mirrors NT's per-file shared cache map: `CcScheduleReadAhead` reads ahead
 * inside the file's extent, on the file object's own sequential state.
 *
 * All offsets are ARCHIVE offsets (the entry's data start, not 0), because that is
 * the coordinate space every consumer of this hint already works in.
 */
export interface ReadHint {
    /** Archive offset of the entry's first data byte. */
    entryStart: number;
    /** Archive offset one past the entry's last data byte. Readahead must not cross it. */
    entryEnd: number;
    /** Archive offset this read starts at (the file object's cursor). */
    cursor: number;
    /** FILE_FLAG_SEQUENTIAL_SCAN, or NT's heuristic: two consecutive contiguous
     *  requests on the same file object. Only a sequential caller is speculated on. */
    sequential: boolean;
    /** This read is itself readahead — nobody is waiting on it. Without the
     *  distinction a transport serves speculation and a caller's blocking read from
     *  the same connection budget, and the blocking one waits behind the guesses. */
    speculative?: boolean;
}

export interface ZipSource {
    size: number;
    readRange(start: number, end: number, hint?: ReadHint): Promise<Uint8Array>;
    /**
     * Optional sync range read. Returns the bytes when they can be served
     * synchronously (BufferSource / SAH always can), or `null` when a sync read
     * is not possible right now (e.g. a CachedSource block-cache miss) — callers
     * must then fall back to the async `readRange`. Existing always-sync sources
     * never return null, so this widening is behavior-preserving for them.
     */
    readRangeSync?(start: number, end: number, hint?: ReadHint): Uint8Array | null;
    /** False when `readRangeSync` exists but cannot fault a cold range in — a block
     *  cache over an async-only transport. Absent/true means a sync read can always be
     *  satisfied. Callers deciding whether an entry needs a RAM copy to be readable
     *  without awaiting must consult this, not the method's presence. */
    syncFaultCapable?: boolean;
}

export interface ZipEntry {
    name: string;
    compressedSize: number;
    uncompressedSize: number;
    compression: number;
    localHeaderOffset: number;
    isDirectory: boolean;
}

export class BufferSource implements ZipSource {
    size: number;
    private data: Uint8Array;

    constructor(data: Uint8Array) {
        this.data = data;
        this.size = data.byteLength;
    }

    async readRange(start: number, end: number): Promise<Uint8Array> {
        return this.readRangeSync(start, end);
    }

    readRangeSync(start: number, end: number): Uint8Array {
        const clampedStart = Math.max(0, Math.min(start, this.size));
        const clampedEnd = Math.max(clampedStart, Math.min(end, this.size));
        return this.data.subarray(clampedStart, clampedEnd);
    }
}

/**
 * `FileReaderSync` is a Worker-only global (declared in lib.webworker.d.ts). Our
 * tsconfig uses the DOM lib set, so declare the one method we use here. It lets a
 * Worker read a Blob slice SYNCHRONOUSLY — the key to serving the guest's sync
 * read path (GetPrivateProfileString, msvcrt fgetc, mmioOpen) straight off a
 * no-copy Blob without a false EOF.
 */
declare class FileReaderSync {
    readAsArrayBuffer(blob: Blob): ArrayBuffer;
}

export class BlobSource implements ZipSource {
    size: number;
    private blob: Blob;
    private syncReader?: FileReaderSync;

    constructor(blob: Blob) {
        this.blob = blob;
        this.size = blob.size;
    }

    async readRange(start: number, end: number): Promise<Uint8Array> {
        const clampedStart = Math.max(0, Math.min(start, this.size));
        const clampedEnd = Math.max(clampedStart, Math.min(end, this.size));
        const buf = await this.blob.slice(clampedStart, clampedEnd).arrayBuffer();
        return new Uint8Array(buf);
    }

    /**
     * Synchronous slice read via FileReaderSync (Worker-only). Lets the sync read
     * path serve real bytes off the Blob instead of a false EOF. It's a per-call
     * read of the requested range, so callers that stream should layer a block
     * cache on top (CachedSource) — see withBlockCache in wgb-loader. Returns null
     * on any failure so the caller falls back to the async path.
     */
    readRangeSync(start: number, end: number): Uint8Array | null {
        const clampedStart = Math.max(0, Math.min(start, this.size));
        const clampedEnd = Math.max(clampedStart, Math.min(end, this.size));
        if (clampedEnd <= clampedStart) return new Uint8Array(0);
        try {
            const reader = (this.syncReader ??= new FileReaderSync());
            const buf = reader.readAsArrayBuffer(this.blob.slice(clampedStart, clampedEnd));
            return new Uint8Array(buf);
        } catch {
            return null;
        }
    }
}

export class HttpRangeSource implements ZipSource {
    size: number;
    private url: string;

    private constructor(url: string, size: number) {
        this.url = url;
        this.size = size;
    }

    static async create(url: string): Promise<HttpRangeSource> {
        // Preferred path: HEAD + content-length.
        try {
            const head = await fetch(url, { method: "HEAD" });
            if (head.ok) {
                const length = head.headers.get("content-length");
                if (length) {
                    return new HttpRangeSource(url, Number(length));
                }
            }
        } catch {
            // Fall through to range probe.
        }

        // Fallback path: probe byte-range support and infer total size from Content-Range.
        const probe = await fetch(url, { headers: { Range: "bytes=0-0" } });
        if (probe.status !== 206) {
            // Avoid buffering potentially huge response body when range is unsupported.
            try { await probe.body?.cancel(); } catch {}
            throw new Error(`Range requests are required for WGB loading (expected 206, got ${probe.status})`);
        }
        const contentRange = probe.headers.get("content-range");
        if (!contentRange) {
            try { await probe.body?.cancel(); } catch {}
            throw new Error(`Missing Content-Range for ${url}`);
        }
        const match = contentRange.match(/\/(\d+)\s*$/);
        if (!match) {
            try { await probe.body?.cancel(); } catch {}
            throw new Error(`Invalid Content-Range "${contentRange}" for ${url}`);
        }
        try { await probe.body?.cancel(); } catch {}
        return new HttpRangeSource(url, Number(match[1]));
    }

    async readRange(start: number, end: number): Promise<Uint8Array> {
        const range = `bytes=${start}-${end - 1}`;
        const resp = await fetch(this.url, { headers: { Range: range } });
        if (resp.status !== 206) {
            try { await resp.body?.cancel(); } catch {}
            throw new Error(`Range request failed (${resp.status}) for ${this.url}`);
        }
        const buf = await resp.arrayBuffer();
        return new Uint8Array(buf);
    }
}

/**
 * Like {@link HttpRangeSource}, but serves the guest's SYNCHRONOUS reads directly
 * off the server via a synchronous XHR range request (allowed in Workers, unlike the
 * main thread). This is what lets a URL source run without first staging the whole
 * bundle into an OPFS SyncAccessHandle — the multi-GB blocking copy that makes the
 * first open of a big WGB slow. Each cold `readRangeSync` blocks the worker on a
 * range fetch from a local dev server (sub-ms/ms off disk); `withBlockCache` absorbs
 * repeats. Requires the server to honor Range (206) — `create` verifies it, so a
 * server that ignores Range throws here and the caller falls back to OPFS staging.
 * Dev-only ingestion path.
 */
export class SyncHttpRangeSource implements ZipSource {
    size: number;
    private url: string;

    private constructor(url: string, size: number) {
        this.url = url;
        this.size = size;
    }

    static async create(url: string): Promise<SyncHttpRangeSource> {
        // Probe Range support AND size in one request: a compliant server answers
        // bytes=0-0 with 206 + `Content-Range: bytes 0-0/<total>`.
        const probe = await fetch(url, { headers: { Range: "bytes=0-0" } });
        if (probe.status !== 206) {
            try { await probe.body?.cancel(); } catch {}
            throw new Error(`SyncHttpRangeSource requires Range (expected 206, got ${probe.status}) for ${url}`);
        }
        const contentRange = probe.headers.get("content-range");
        const match = contentRange?.match(/\/(\d+)\s*$/);
        try { await probe.body?.cancel(); } catch {}
        if (!match) throw new Error(`SyncHttpRangeSource: missing/invalid Content-Range for ${url}`);
        return new SyncHttpRangeSource(url, Number(match[1]));
    }

    async readRange(start: number, end: number): Promise<Uint8Array> {
        const resp = await fetch(this.url, { headers: { Range: `bytes=${start}-${end - 1}` } });
        if (resp.status !== 206) {
            try { await resp.body?.cancel(); } catch {}
            throw new Error(`Range request failed (${resp.status}) for ${this.url}`);
        }
        return new Uint8Array(await resp.arrayBuffer());
    }

    readRangeSync(start: number, end: number): Uint8Array {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", this.url, false); // synchronous — worker-only
        xhr.responseType = "arraybuffer"; // permitted for sync XHR inside a Worker
        xhr.setRequestHeader("Range", `bytes=${start}-${end - 1}`);
        xhr.send();
        if (xhr.status !== 206) {
            throw new Error(`sync range request failed (${xhr.status}) for ${this.url}`);
        }
        return new Uint8Array(xhr.response as ArrayBuffer);
    }
}

/**
 * Minimal subset of the OPFS `FileSystemSyncAccessHandle` surface we rely on.
 * Declared locally so we don't depend on the DOM lib shipping the type; the real
 * handle structurally satisfies this.
 */
export interface SyncAccessHandleLike {
    read(buffer: Uint8Array, options?: { at?: number }): number;
    write(buffer: Uint8Array, options?: { at?: number }): number;
    truncate(newSize: number): void;
    flush(): void;
    close(): void;
    getSize(): number;
}

/**
 * Sync ZipSource backed by an OPFS `FileSystemSyncAccessHandle` (worker-only).
 *
 * This is the key to loading large bundles from a disk Blob WITHOUT either holding
 * the whole file in RAM (BufferSource → OOM on 1.5GB bundles) or reading async
 * (BlobSource → `readRangeSync` returns null → fgetc sees a false EOF → games that
 * inline getc, e.g. Discworld Noir's LZSS decompressor, fail with "Decompression
 * error"). The SAH gives synchronous random-access reads straight off disk.
 */
export class SyncAccessHandleSource implements ZipSource {
    size: number;
    private sah: SyncAccessHandleLike;

    constructor(sah: SyncAccessHandleLike, size: number) {
        this.sah = sah;
        this.size = size;
    }

    async readRange(start: number, end: number): Promise<Uint8Array> {
        return this.readRangeSync(start, end);
    }

    readRangeSync(start: number, end: number): Uint8Array {
        const clampedStart = Math.max(0, Math.min(start, this.size));
        const clampedEnd = Math.max(clampedStart, Math.min(end, this.size));
        const len = clampedEnd - clampedStart;
        const out = new Uint8Array(len);
        if (len === 0) return out;
        let got = 0;
        // SAH.read may short-read; loop until the requested span is filled or EOF.
        while (got < len) {
            const n = this.sah.read(out.subarray(got), { at: clampedStart + got });
            if (n <= 0) break;
            got += n;
        }
        return got === len ? out : out.subarray(0, got);
    }

    close(): void {
        try { this.sah.close(); } catch { /* best-effort */ }
    }
}

export class ZipArchive {
    private source: ZipSource;
    private entries: Map<string, ZipEntry> = new Map();
    private localDataOffsets: Map<string, number> = new Map();
    /**
     * Byte offset of the actual ZIP data from the start of the source. Non-zero for a
     * self-extractor (a PE stub prepended to the archive): WinZip/7z SFX write the central
     * directory / local-header offsets relative to the START OF THE ZIP, not the file, so
     * every stored offset is short by the stub size. `init` recovers the prefix from ground
     * truth — the CD always sits immediately before the EOCD — and adds it to every offset.
     */
    private prefixDelta = 0;

    constructor(source: ZipSource) {
        this.source = source;
    }

    getEntry(name: string): ZipEntry | undefined {
        return this.entries.get(name);
    }

    listEntries(): ZipEntry[] {
        return Array.from(this.entries.values());
    }

    async init(): Promise<void> {
        const size = this.source.size;
        const tailSize = Math.min(size, MAX_EOCD_SEARCH);
        const tail = await this.source.readRange(size - tailSize, size);
        const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

        let eocdOffset = -1;
        for (let i = tail.length - 22; i >= 0; i--) {
            if (view.getUint32(i, true) === EOCD_SIGNATURE) {
                eocdOffset = i;
                break;
            }
        }
        if (eocdOffset < 0) {
            throw new Error("EOCD not found");
        }

        const cdSize = view.getUint32(eocdOffset + 12, true);
        const cdOffset = view.getUint32(eocdOffset + 16, true);

        // Recover the SFX prefix: the central directory always ends right where the EOCD
        // begins, so its true file offset is `eocdFileOffset - cdSize`. For a plain zip that
        // equals the stored `cdOffset` (delta 0); for a self-extractor it is larger by the
        // stub size. Negative (malformed) → fall back to 0 so we degrade to the old behavior.
        const eocdFileOffset = size - tailSize + eocdOffset;
        const delta = eocdFileOffset - cdSize - cdOffset;
        this.prefixDelta = delta > 0 ? delta : 0;

        const cdStart = cdOffset + this.prefixDelta;
        const cd = await this.source.readRange(cdStart, cdStart + cdSize);
        this.parseCentralDirectory(cd);
    }

    private parseCentralDirectory(cd: Uint8Array): void {
        const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
        const decoderUtf8 = new TextDecoder("utf-8");
        let offset = 0;

        while (offset + 46 <= cd.length) {
            const sig = view.getUint32(offset, true);
            if (sig !== CEN_SIGNATURE) {
                break;
            }

            const flags = view.getUint16(offset + 8, true);
            const compression = view.getUint16(offset + 10, true);
            const compressedSize = view.getUint32(offset + 20, true);
            const uncompressedSize = view.getUint32(offset + 24, true);
            const nameLen = view.getUint16(offset + 28, true);
            const extraLen = view.getUint16(offset + 30, true);
            const commentLen = view.getUint16(offset + 32, true);
            const localHeaderOffset = view.getUint32(offset + 42, true);

            const nameBytes = cd.slice(offset + 46, offset + 46 + nameLen);
            const name = (flags & 0x0800) ? decoderUtf8.decode(nameBytes) : decoderUtf8.decode(nameBytes);
            const isDirectory = name.endsWith("/");

            this.entries.set(name, {
                name,
                compressedSize,
                uncompressedSize,
                compression,
                localHeaderOffset,
                isDirectory,
            });

            offset += 46 + nameLen + extraLen + commentLen;
        }
    }

    /**
     * Can this entry be served at any offset by {@link readEntryRangeSync}? True only
     * for a STORED entry over a source with a synchronous range read.
     *
     * The distinction a speculative caller needs: such an entry is ALREADY
     * sync-readable, so pulling its whole body into a second RAM cache buys no
     * capability — it only duplicates bytes and forces the transport to move the
     * entire file for reads the caller may never make.
     */
    canRangeReadSync(entry: ZipEntry): boolean {
        if (entry.compression !== 0) return false;
        if (typeof this.source.readRangeSync !== "function") return false;
        // A decorator can EXPOSE readRangeSync and still fail it: a block cache over an
        // async-only transport answers null for a block it has not faulted. Taking the
        // method's presence as the answer would tell a caller a cold entry is
        // sync-readable when the first read of it returns null, which reads as EOF.
        return this.source.syncFaultCapable !== false;
    }

    async readEntry(entry: ZipEntry): Promise<Uint8Array> {
        if (entry.compression === 0) {
            return this.readEntryRange(entry, 0, entry.uncompressedSize);
        }

        const dataStart = await this.getEntryDataStart(entry);
        const dataEnd = dataStart + entry.compressedSize;
        const compressed = await this.source.readRange(dataStart, dataEnd);

        if (entry.compression === 8) {
            return inflateRaw(compressed);
        }
        throw new Error(`Unsupported compression ${entry.compression} for ${entry.name}`);
    }

    /**
     * Reads an uncompressed (STORED) entry range without loading the whole file.
     */
    async readEntryRange(entry: ZipEntry, offset: number, length: number, sequential = false): Promise<Uint8Array> {
        const sync = this.readEntryRangeSync(entry, offset, length, sequential);
        if (sync) return sync;
        if (entry.compression !== 0) {
            throw new Error(`Range read is supported only for STORED entries (${entry.name})`);
        }
        if (length <= 0 || offset >= entry.uncompressedSize) {
            return new Uint8Array();
        }

        const clampedOffset = Math.max(0, offset);
        const clampedEnd = Math.min(entry.uncompressedSize, clampedOffset + length);
        if (clampedOffset >= clampedEnd) {
            return new Uint8Array();
        }

        const dataStart = await this.getEntryDataStart(entry);
        return this.source.readRange(dataStart + clampedOffset, dataStart + clampedEnd, {
            entryStart: dataStart,
            entryEnd: dataStart + entry.uncompressedSize,
            cursor: dataStart + clampedOffset,
            sequential,
        });
    }

    /** Sync range read for STORED entries when ZipSource supports readRangeSync.
     *  `sequential` is the caller's own read-pattern state (it owns the file object);
     *  this is the layer that can turn it into an entry-bounded {@link ReadHint}. */
    readEntryRangeSync(entry: ZipEntry, offset: number, length: number, sequential = false): Uint8Array | null {
        if (entry.compression !== 0 || !this.source.readRangeSync) return null;
        if (length <= 0 || offset >= entry.uncompressedSize) return new Uint8Array();
        const clampedOffset = Math.max(0, offset);
        const clampedEnd = Math.min(entry.uncompressedSize, clampedOffset + length);
        if (clampedOffset >= clampedEnd) return new Uint8Array();
        const dataStart = this.getEntryDataStartSync(entry);
        if (dataStart === null) return null;
        const hint: ReadHint = {
            entryStart: dataStart,
            entryEnd: dataStart + entry.uncompressedSize,
            cursor: dataStart + clampedOffset,
            sequential,
        };
        return this.source.readRangeSync(dataStart + clampedOffset, dataStart + clampedEnd, hint);
    }

    private async getEntryDataStart(entry: ZipEntry): Promise<number> {
        const sync = this.getEntryDataStartSync(entry);
        if (sync !== null) return sync;
        const locStart = entry.localHeaderOffset + this.prefixDelta;
        const header = await this.source.readRange(locStart, locStart + 30);
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        if (view.getUint32(0, true) !== LOC_SIGNATURE) {
            throw new Error(`Local header missing for ${entry.name}`);
        }
        const nameLen = view.getUint16(26, true);
        const extraLen = view.getUint16(28, true);
        const dataStart = locStart + 30 + nameLen + extraLen;
        this.localDataOffsets.set(entry.name, dataStart);
        return dataStart;
    }

    private getEntryDataStartSync(entry: ZipEntry): number | null {
        const cached = this.localDataOffsets.get(entry.name);
        if (cached !== undefined) return cached;
        if (!this.source.readRangeSync) return null;
        const locStart = entry.localHeaderOffset + this.prefixDelta;
        const header = this.source.readRangeSync(locStart, locStart + 30);
        if (!header || header.length < 30) return null;
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        if (view.getUint32(0, true) !== LOC_SIGNATURE) return null;
        const nameLen = view.getUint16(26, true);
        const extraLen = view.getUint16(28, true);
        const dataStart = locStart + 30 + nameLen + extraLen;
        this.localDataOffsets.set(entry.name, dataStart);
        return dataStart;
    }
}

/**
 * Read every (STORED or DEFLATE) file entry of a ZIP buffer into a rel-path → bytes Map.
 * Transparently handles a self-extractor prefix (see {@link ZipArchive}). Directories are
 * skipped. Shared by the build service and the container-extract installer registry.
 */
export async function unzipToMap(data: Uint8Array): Promise<Map<string, Uint8Array>> {
    const archive = new ZipArchive(new BufferSource(data));
    await archive.init();
    const out = new Map<string, Uint8Array>();
    for (const entry of archive.listEntries()) {
        if (entry.isDirectory) continue;
        out.set(entry.name, await archive.readEntry(entry));
    }
    return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
    if (typeof DecompressionStream === "undefined") {
        throw new Error("DecompressionStream unavailable");
    }
    const stream = new Blob([asBlobPart(data)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
}
