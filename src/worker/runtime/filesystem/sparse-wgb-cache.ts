import { hasZipEocd } from "./wgb-cache-integrity";
import type { SyncAccessHandleLike } from "@bottleship/formats/zip";
import { WgbCache } from "./wgb-cache";
import { sameWgbVersion, urlToCacheKey, type WgbVersion } from "./wgb-cache-identity";

type SyncFile = FileSystemFileHandle & {
    createSyncAccessHandle(): Promise<SyncAccessHandleLike>;
    move?(name: string): Promise<void>;
};

function writeAll(handle: SyncAccessHandleLike, bytes: Uint8Array, at: number): void {
    let written = 0;
    while (written < bytes.length) {
        const n = handle.write(bytes.subarray(written), { at: at + written });
        if (n <= 0) throw new Error("Sparse WGB cache short write");
        written += n;
    }
}

/** Only flushed disk chunks publish residency. RAM eviction can never invalidate a bit. */
export class SparseWgbCache {
    private complete = false;
    private bitmapOffset = 0;
    private downloaded = 0;
    private promotion: Promise<boolean> | null = null;
    private readonly bits: Uint8Array;

    private constructor(
        readonly version: WgbVersion, readonly chunkBytes: number,
        private readonly dir: FileSystemDirectoryHandle, private readonly file: SyncFile,
        private disk: SyncAccessHandleLike, private readonly bitmap: SyncAccessHandleLike,
        private readonly residency: Int32Array,
    ) {
        this.bits = new Uint8Array(Math.ceil(Math.ceil(version.size / chunkBytes) / 8));
    }

    static async open(version: WgbVersion, chunkBytes: number, residency: Int32Array,
        directory?: FileSystemDirectoryHandle): Promise<SparseWgbCache | null> {
        // A mutable URL with no strong validator cannot safely resume old chunks.
        if (!version.etag || version.etag.startsWith("W/")) return null;
        let disk: SyncAccessHandleLike | undefined;
        let bitmap: SyncAccessHandleLike | undefined;
        try {
            const key = urlToCacheKey(version.url);
            const dir = directory ?? await WgbCache.prepareSparseCache(version.size, key);
            if (!dir) return null;
            const file = await dir.getFileHandle(`${key}.sparse`, { create: true }) as SyncFile;
            disk = await file.createSyncAccessHandle();
            const bitFile = await dir.getFileHandle(`${key}.bitmap`, { create: true }) as SyncFile;
            bitmap = await bitFile.createSyncAccessHandle();
            const cache = new SparseWgbCache(version, chunkBytes, dir, file, disk, bitmap, residency);
            cache.restore();
            return cache;
        } catch {
            // Initialization has not published this SAB to the guest yet.
            residency.fill(0);
            try { disk?.close(); } catch {}
            try { bitmap?.close(); } catch {}
            return null;
        }
    }

    private restore(): void {
        let valid = false;
        try {
            const lengthBytes = new Uint8Array(4);
            if (this.bitmap.read(lengthBytes, { at: 0 }) === 4) {
                const length = new DataView(lengthBytes.buffer).getUint32(0, true);
                if (length > 0 && length < 16_384 && this.bitmap.getSize() === 4 + length + this.bits.length) {
                    const json = new Uint8Array(length);
                    if (this.bitmap.read(json, { at: 4 }) !== length) throw new Error("short metadata");
                    const info = JSON.parse(new TextDecoder().decode(json));
                    valid = sameWgbVersion(info, this.version) && info.chunkBytes === this.chunkBytes;
                    this.bitmapOffset = 4 + length;
                    if (valid && this.bitmap.read(this.bits, { at: this.bitmapOffset }) !== this.bits.length) valid = false;
                }
            }
        } catch { valid = false; }
        if (!valid) {
            this.disk.truncate(0);
            this.disk.flush();
            this.bits.fill(0);
            const json = new TextEncoder().encode(JSON.stringify({ ...this.version, chunkBytes: this.chunkBytes }));
            const length = new Uint8Array(4);
            new DataView(length.buffer).setUint32(0, json.length, true);
            this.bitmap.truncate(0);
            writeAll(this.bitmap, length, 0);
            writeAll(this.bitmap, json, 4);
            this.bitmapOffset = 4 + json.length;
            writeAll(this.bitmap, this.bits, this.bitmapOffset);
            this.bitmap.flush();
        }
        const size = this.disk.getSize();
        for (let ci = 0; ci < this.chunkCount; ci++) {
            if (!this.has(ci)) continue;
            if (Math.min(this.version.size, (ci + 1) * this.chunkBytes) > size) {
                // A torn or externally truncated data file cannot advertise its old bits.
                this.bits[ci >> 3] &= ~(1 << (ci & 7));
                writeAll(this.bitmap, this.bits.subarray(ci >> 3, (ci >> 3) + 1), this.bitmapOffset + (ci >> 3));
            } else {
                this.downloaded++;
                this.publish(ci);
            }
        }
        this.bitmap.flush();
    }

    get promoted(): boolean { return this.complete; }
    get chunkCount(): number { return Math.ceil(this.version.size / this.chunkBytes); }
    get downloadedChunks(): number { return this.downloaded; }
    has(ci: number): boolean { return (this.bits[ci >> 3] & (1 << (ci & 7))) !== 0; }
    private publish(ci: number): void { Atomics.or(this.residency, ci >> 5, 1 << (ci & 31)); }

    read(ci: number): Uint8Array | null {
        if (!this.has(ci)) return null;
        const start = ci * this.chunkBytes;
        const out = new Uint8Array(Math.min(this.chunkBytes, this.version.size - start));
        let got = 0;
        while (got < out.length) {
            const n = this.disk.read(out.subarray(got), { at: start + got });
            if (n <= 0) throw new Error(`Sparse WGB cache truncated at ${start + got}`);
            got += n;
        }
        return out;
    }

    async readAsync(ci: number): Promise<Uint8Array | null> {
        if (this.promotion) await this.promotion;
        return this.read(ci);
    }

    write(ci: number, bytes: Uint8Array): void {
        if (this.has(ci)) return;
        const want = Math.min(this.chunkBytes, this.version.size - ci * this.chunkBytes);
        if (bytes.length !== want) throw new Error(`Sparse WGB cache short chunk ${ci}`);
        writeAll(this.disk, bytes, ci * this.chunkBytes);
        this.disk.flush();
        const bit = this.bits[ci >> 3] | (1 << (ci & 7));
        writeAll(this.bitmap, new Uint8Array([bit]), this.bitmapOffset + (ci >> 3));
        this.bitmap.flush();
        this.bits[ci >> 3] = bit;
        this.downloaded++;
        this.publish(ci);
    }

    promote(): Promise<boolean> {
        return this.promotion ??= this.promoteImpl();
    }

    private async promoteImpl(): Promise<boolean> {
        if (this.complete || this.downloaded !== this.chunkCount || !this.file.move) return this.complete;
        if (this.disk.getSize() !== this.version.size || !hasZipEocd(this.disk, this.version.size)) throw new Error("Completed sparse cache is not a ZIP");
        const key = urlToCacheKey(this.version.url);
        this.disk.close();
        try {
            await this.file.move(key);
            await WgbCache.storeVersion(this.version, this.dir);
            this.complete = true;
        } finally {
            // Keep the current session disk-backed even after promotion to the final key.
            this.disk = await this.file.createSyncAccessHandle();
        }
        return this.complete;
    }

    async close(): Promise<void> {
        try { await this.promotion; } catch {}
        this.disk.close();
        this.bitmap.close();
    }
}
