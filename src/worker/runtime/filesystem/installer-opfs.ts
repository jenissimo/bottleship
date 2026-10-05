/** GOG import workspace: one disk arena for extracted data, one streamed WGB output. */
import {
    extractInno, parseInnoHeader, parseSliceSource, MultiSliceReader,
    detectInstallerLanguages, defaultLanguage, type AssemblyStore, type RandomAccessSource,
} from "@bottleship/formats/inno";
import { UnpackDecoder } from "@bottleship/formats/unpack";
import { BlobSource, BufferSource, type ZipSource } from "@bottleship/formats/zip";
import { writeZipStream } from "@bottleship/formats/wgb/zip-stream";
import { synthesizeManifest, parseGogGameInfo } from "@bottleship/repack/manifest-synth";
import { isGogJunk } from "@bottleship/repack/gog-filter";
import { getOverride, type GogOverridesDb } from "@bottleship/repack/overrides";
import type { BuildSource, ProgressFn } from "./wgb-build";
import { getBottleshipRoot } from "./container-store";

interface SyncFile {
    read(bytes: Uint8Array, options: { at: number }): number;
    write(bytes: Uint8Array, options: { at: number }): number;
    truncate(size: number): void;
    flush(): void;
    close(): void;
}

export function blobRandomAccess(blob: Blob): RandomAccessSource {
    const source = new BlobSource(blob);
    return { size: blob.size, readRangeSync(start, end) {
        const bytes = source.readRangeSync(start, end);
        if (!bytes) throw new Error("Installer range reads require a browser worker with FileReaderSync");
        return bytes;
    } };
}

export function writeSyncFile(file: SyncFile, bytes: Uint8Array, at: number): void {
    let done = 0;
    while (done < bytes.length) {
        const n = file.write(bytes.subarray(done), { at: at + done });
        if (n <= 0 || n > bytes.length - done) throw new Error("Incomplete OPFS write");
        done += n;
    }
}

/** Allocate independent extents, including interleaved Galaxy assembly segments. */
export class ExtractionArena {
    private next = 0;
    constructor(private file: SyncFile) {}
    reserve(size: number): AssemblyStore & ZipSource {
        if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid installer file size");
        const base = this.next;
        if (!Number.isSafeInteger(base + size)) throw new Error("Installer workspace exceeds supported size");
        this.next += size;
        this.file.truncate(this.next);
        const readRangeSync = (start: number, end: number) => {
            if (start < 0 || end < start || end > size) throw new Error("Installer workspace read out of bounds");
            const bytes = new Uint8Array(end - start);
            let done = 0;
            while (done < bytes.length) {
                const n = this.file.read(bytes.subarray(done), { at: base + start + done });
                if (n <= 0 || n > bytes.length - done) throw new Error("Incomplete OPFS read");
                done += n;
            }
            return bytes;
        };
        return { size, readRangeSync, readRange: async (start, end) => readRangeSync(start, end),
            writeAt: (bytes, at) => {
                if (at < 0 || at + bytes.length > size) throw new Error("Installer workspace write out of bounds");
                writeSyncFile(this.file, bytes, base + at);
            }, close() {} };
    }
}

async function openSyncFile(dir: FileSystemDirectoryHandle, name: string): Promise<SyncFile> {
    const handle = await dir.getFileHandle(name, { create: true });
    const create = (handle as unknown as { createSyncAccessHandle?: () => Promise<SyncFile> }).createSyncAccessHandle;
    if (!create) throw new Error("Disk-backed installer import is unavailable in this browser");
    const file = await create.call(handle);
    file.truncate(0);
    return file;
}

export async function buildInstallerOnDisk(source: BuildSource, db: GogOverridesDb, onProgress?: ProgressFn) {
    if (source.blobs && (source.blobs.filter(f => /\.exe$/i.test(f.name)).length !== 1 || source.blobs.some(f => !/\.(exe|bin)$/i.test(f.name)))) {
        throw new Error("Select one setup.exe and all of its .bin parts");
    }
    const setup = source.blobs?.find((f) => /\.exe$/i.test(f.name)) ?? source.blob;
    if (!setup) throw new Error("Drop the setup.exe together with every setup-*.bin part");
    const input = blobRandomAccess(setup);
    const wasmResponse = await fetch("/unpack-streaming.wasm");
    if (!wasmResponse.ok) throw new Error(`Decoder download failed: HTTP ${wasmResponse.status}`);
    const decoder = new UnpackDecoder();
    await decoder.init(await wasmResponse.arrayBuffer());
    const parsed = await parseInnoHeader(input, decoder);
    const bins = orderInstallerParts((source.blobs ?? []).filter(f => /\.bin$/i.test(f.name)),
        (setup as File).name ?? "setup.exe", parsed.header.slicesPerDisk,
        parsed.offsets.dataOffset ? 0 : Math.max(0, ...parsed.dataEntries.map(e => e.lastSlice)) + 1);
    const slices = bins.length ? new MultiSliceReader(bins.map((f) => parseSliceSource(blobRandomAccess(f)))) : undefined;
    const language = defaultLanguage(detectInstallerLanguages(parsed.files));
    const root = await getBottleshipRoot(true);
    if (!root) throw new Error("Browser storage is unavailable");
    const imports = await root.getDirectoryHandle("_imports", { create: true });
    const id = crypto.randomUUID();
    const dir = await imports.getDirectoryHandle(id, { create: true });
    let payload: SyncFile | undefined;
    let output: SyncFile | undefined;
    try {
        payload = await openSyncFile(dir, "payload");
        const arena = new ExtractionArena(payload);
        const files = new Map<string, { name: string; source: ZipSource }>();
        onProgress?.("installing", 0, "Extracting to browser storage");
        await extractInno(input, {
            language,
            wantFile: (path) => /^goggame-.*\.(info|script)$/i.test(path.split("/").pop() ?? "") || !isGogJunk(path),
            createAssemblyStore: (size) => arena.reserve(size),
            onProgress: (done, total) => onProgress?.("installing", Math.min(99, total ? Math.round(done / total * 100) : 0), "Extracting to browser storage"),
        }, (path) => {
            let extent: ReturnType<ExtractionArena["reserve"]>;
            let pos = 0;
            return {
                begin(_path, size) { extent = arena.reserve(size); },
                data(bytes) { extent.writeAt(bytes, pos); pos += bytes.length; },
                end(ok) {
                    if (!ok || pos !== extent.size) throw new Error(`Incomplete installer file: ${path}`);
                    files.set(path.toLowerCase(), { name: path, source: extent });
                },
            };
        }, decoder, parsed, slices);
        const metadata = new Map<string, Uint8Array>();
        for (const { name, source: file } of files.values()) {
            const meta = /^goggame-.*\.(info|script)$/i.test(name.split("/").pop() ?? "");
            if (meta && file.size > 16 * 1024 * 1024) throw new Error("Installer metadata exceeds 16 MB");
            metadata.set(name, meta ? await file.readRange(0, file.size) : new Uint8Array(0));
        }
        const gog = parseGogGameInfo(metadata);
        const synth = synthesizeManifest({ parsed, gameFiles: metadata, override: getOverride(db, gog.gameId), cli: source.cli });
        output = await openSyncFile(dir, "game.wgb");
        const entries = [
            { name: "manifest.json", source: new BufferSource(new TextEncoder().encode(JSON.stringify(synth.manifest, null, 2))) },
            { name: "registry.json", source: new BufferSource(new TextEncoder().encode(JSON.stringify(synth.registry, null, 2))) },
            ...[...files.values()].filter((f) => !isGogJunk(f.name)).map((f) => ({ name: `rom/${f.name}`, source: f.source })),
        ];
        const total = entries.reduce((n, e) => n + e.source.size, 0);
        onProgress?.("packing", 0, "Building WGB on disk");
        await writeZipStream(entries, { write: (bytes, at) => writeSyncFile(output!, bytes, at) },
            (done) => onProgress?.("packing", Math.min(99, total ? Math.round(done / total * 100) : 0), "Building WGB on disk"));
        output.flush(); output.close(); output = undefined;
        payload.close(); payload = undefined;
        await dir.removeEntry("payload");
        return { stagedPath: `_imports/${id}/game.wgb`, manifest: synth.manifest, gameId: synth.gameId };
    } catch (err) {
        try { output?.close(); } catch { /* Preserve the import error. */ }
        try { payload?.close(); } catch { /* Preserve the import error. */ }
        try { await imports.removeEntry(id, { recursive: true }); } catch { /* Storage UI can remove abandoned imports. */ }
        if ((err as DOMException).name === "QuotaExceededError") throw new Error("Browser storage is full. Free cached files in Settings → Storage and try again.");
        throw err;
    }
}

/** Inno's slice_filename convention gives each selected part its physical slice index. */
export function orderInstallerParts<T extends { name: string }>(parts: T[], setupName: string, perDisk: number, expected: number): T[] {
    const base = setupName.replace(/\.exe$/i, "");
    const byName = new Map(parts.map(p => [p.name.toLowerCase(), p]));
    const ordered: T[] = [];
    for (let i = 0; i < expected; i++) {
        const suffix = perDisk <= 1 ? String(i + 1) : `${Math.floor(i / perDisk) + 1}${String.fromCharCode(97 + i % perDisk)}`;
        const name = `${base}-${suffix}.bin`;
        const part = byName.get(name.toLowerCase());
        if (!part) throw new Error(`Missing installer part: ${name}. Select setup.exe and every .bin part together.`);
        ordered.push(part);
    }
    if (parts.length !== expected || byName.size !== parts.length) throw new Error("Selected .bin files do not belong to this installer");
    return ordered;
}
