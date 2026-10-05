/**
 * Inno Setup file extractor — ported from innoextract cli/extract.cpp chunk loop (1122-1280).
 */

import { Inflate } from "pako";
import { filterExtractableFiles } from "./collisions";
import { checkAllowsLanguage } from "./check-lang";
import { createChecksumHasher, verifyChecksum } from "../unpack/checksums";
import { needsExeFilter, InnoExeDecoder5309 } from "./exe-filter";
import {
    chunkMapKey,
    decompressChunkStream,
    describeChunk,
    EmbeddedSliceReader,
    type ChunkDescriptor,
    type SliceSource,
} from "./chunk-reader";
import type { DataEntry } from "./entries/data";
import type { FileEntry } from "./entries/file";
import { encryptionUsed } from "./header";
import { InnoFormatError } from "./errors";
import type { UnpackDecoder } from "../unpack";
import { CaseInsensitivePathMap } from "./path-map";
import { normalizeInnoDestination } from "./paths";
import { parseInnoHeader, type InnoParseResult } from "./parser";
import type { RandomAccessSource } from "../unpack/source";

export { normalizeInnoDestination } from "./paths";

export interface ExtractSink {
    /** `bytes` is valid only for the duration of this call — implementations must copy if retained. */
    begin(relPath: string, size: number): void;
    data(bytes: Uint8Array): void;
    end(checksumOk: boolean): void;
}

export interface ExtractOptions {
    wantFile(relPath: string): boolean;
    onProgress?(doneBytes: number, totalBytes: number): void;
    /** Locale (e.g. "en-US") for a multi-language installer. Files whose Inno `Check:` names
     *  a language set that EXCLUDES this locale are skipped — so per-language variants of the
     *  same path (e.g. the 5 `system\Default.ini` in GOG XIII) collapse to the one chosen
     *  language instead of last-write-wins. Files with no language Check always install.
     *  Omit to keep the legacy behaviour (extract every variant). */
    language?: string;
    /** Optional disk-backed workspace for GOG Galaxy files assembled from segments. */
    createAssemblyStore?(size: number): AssemblyStore;
}

export interface AssemblyStore extends RandomAccessSource {
    writeAt(bytes: Uint8Array, offset: number): void;
    close(): void;
}

interface PlannedOutput {
    relPaths: string[];
    dataIndex: number;
    fileOffset: number;
    fileSize: number;
    want: boolean;
    zlibFilter: boolean;
    outputOffset: number;
    outputSize: number;
    assemblyKey: string | null;
    assemblyTotal: number;
    galaxyMd5: Uint8Array | null;
    isLastSegment: boolean;
}

interface AssemblyState {
    /** Every destination sharing this assembled data (Inno dedups identical bytes across paths). */
    relPaths: string[];
    size: number;
    store?: AssemblyStore;
    hasher: ReturnType<typeof createChecksumHasher>;
    expectedMd5: Uint8Array | null;
    segmentsLeft: number;
    finalized: boolean;
}

interface ActiveWrite {
    relPaths: string[];
    sinks: ExtractSink[];
    remaining: number;
    fileSize: number;
    hasher: ReturnType<typeof createChecksumHasher>;
    expected: Uint8Array;
    checksumType: DataEntry["checksumType"];
    exeFilter: InnoExeDecoder5309 | null;
    zlibFilter: boolean;
    outputOffset: number;
    outputSize: number;
    assemblyKey: string | null;
    isLastSegment: boolean;
    galaxyInflate?: Inflate;
    outputWritten: number;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
    return new Uint8Array(bytes);
}

function isAssemblyFile(file: FileEntry, dataEntries: DataEntry[]): boolean {
    if (file.additionalLocations.length > 0) return true;
    const data = dataEntries[file.location];
    return data?.zlibFilter ?? false;
}

function replanWithHeaderCompression(
    selected: ReturnType<typeof filterExtractableFiles>,
    dataEntries: DataEntry[],
    headerCompression: number,
    wantFile: (relPath: string) => boolean,
): {
    chunks: Map<string, { chunk: ChunkDescriptor; files: PlannedOutput[] }>;
    totalBytes: number;
    assemblies: Map<string, AssemblyState>;
} {
    const chunks = new Map<string, { chunk: ChunkDescriptor; files: PlannedOutput[] }>();
    const assemblies = new Map<string, AssemblyState>();
    let totalBytes = 0;

    const byLocation = new Map<number, PlannedOutput>();

    // Inno dedups identical bytes: several FileEntries can point at the same DataEntry (or set of
    // additionalLocations). The non-assembly path below merges these via byLocation + relPaths
    // fan-out so every destination is written. Mirror that for assembly (GOG-Galaxy zlib-filtered)
    // files: aggregate all destinations sharing one data signature up front, so the single decoded
    // buffer is written to ALL of them and the segment reads are planned exactly once. Without this
    // the chunk stream ends at the first copy's boundary and later dedup'd copies are silently
    // dropped (e.g. Morrowind's title track exists as both Explore\ and Special\ → only one survived).
    const assemblySig = (file: FileEntry): string =>
        `asm:${[file.location, ...file.additionalLocations].join(",")}`;
    const assemblyDests = new Map<string, { relPaths: string[]; want: boolean }>();
    for (const { file, relPath } of selected) {
        if (!isAssemblyFile(file, dataEntries)) continue;
        const sig = assemblySig(file);
        let g = assemblyDests.get(sig);
        if (!g) {
            g = { relPaths: [], want: false };
            assemblyDests.set(sig, g);
        }
        if (!g.relPaths.includes(relPath)) g.relPaths.push(relPath);
        g.want = g.want || wantFile(relPath);
    }

    for (const { file, relPath } of selected) {
        const assembly = isAssemblyFile(file, dataEntries);
        const locations = [file.location, ...file.additionalLocations];
        const assemblyKey = assembly ? assemblySig(file) : null;
        // Assembly want is the OR across every dedup'd destination; non-assembly want is per-file
        // (merged later via byLocation). This gates whether the chunk gets read at all.
        const want = assemblyKey ? assemblyDests.get(assemblyKey)!.want : wantFile(relPath);

        let assemblyTotal = Number(file.assemblySize);
        if (assemblyTotal <= 0) {
            assemblyTotal = 0;
            for (const loc of locations) {
                const d = dataEntries[loc];
                if (!d) continue;
                assemblyTotal += Number(d.zlibFilter ? d.uncompressedSize : d.fileSize);
            }
        }

        if (assemblyKey) {
            // A dedup'd copy sharing this data — its destination is already in dest.relPaths and the
            // segment reads were planned by the first copy. Don't re-plan (would collide / be dropped).
            if (assemblies.has(assemblyKey)) continue;
            assemblies.set(assemblyKey, {
                relPaths: assemblyDests.get(assemblyKey)!.relPaths,
                size: assemblyTotal,
                hasher: createChecksumHasher("md5"),
                expectedMd5: file.galaxyChecksumType === "md5" && file.galaxyChecksum.byteLength === 16
                    ? file.galaxyChecksum
                    : null,
                segmentsLeft: locations.length,
                finalized: false,
            });
        }

        let outputOffset = 0;
        for (let i = 0; i < locations.length; i++) {
            const loc = locations[i]!;
            const data = dataEntries[loc];
            if (!data) continue;

            const outputSize = Number(data.zlibFilter ? data.uncompressedSize : data.fileSize);
            const planned: PlannedOutput = {
                relPaths: [relPath],
                dataIndex: loc,
                fileOffset: Number(data.fileOffset),
                fileSize: Number(data.fileSize),
                want,
                zlibFilter: data.zlibFilter,
                outputOffset,
                outputSize,
                assemblyKey,
                assemblyTotal,
                galaxyMd5: file.galaxyChecksumType === "md5" ? file.galaxyChecksum : null,
                isLastSegment: i === locations.length - 1,
            };
            outputOffset += outputSize;

            if (assembly) {
                const chunk = describeChunk(data, headerCompression);
                const key = chunkMapKey(chunk);
                let group = chunks.get(key);
                if (!group) {
                    group = { chunk, files: [] };
                    chunks.set(key, group);
                }
                group.files.push(planned);
                if (want) totalBytes += planned.fileSize;
                continue;
            }

            let merged = byLocation.get(loc);
            if (!merged) {
                merged = planned;
                byLocation.set(loc, merged);
            } else {
                if (!merged.relPaths.includes(relPath)) merged.relPaths.push(relPath);
                merged.want = merged.want || want;
            }
        }
    }

    for (const planned of byLocation.values()) {
        const data = dataEntries[planned.dataIndex]!;
        const chunk = describeChunk(data, headerCompression);
        const key = chunkMapKey(chunk);
        let group = chunks.get(key);
        if (!group) {
            group = { chunk, files: [] };
            chunks.set(key, group);
        }
        group.files.push(planned);
        if (planned.want) totalBytes += planned.fileSize;
    }

    for (const group of chunks.values()) {
        group.files.sort((a, b) => a.fileOffset - b.fileOffset);
    }

    return { chunks, totalBytes, assemblies };
}

/** Independent per-path sink — each path owns its buffer (fan-out). */
function createPathExtractSink(store: CaseInsensitivePathMap, relPath: string): ExtractSink {
    const chunks: Uint8Array[] = [];
    let total = 0;

    return {
        begin(_relPath: string, _size: number): void {
            chunks.length = 0;
            total = 0;
        },
        data(bytes: Uint8Array): void {
            chunks.push(copyBytes(bytes));
            total += bytes.byteLength;
        },
        end(checksumOk: boolean): void {
            if (!checksumOk) return;
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) {
                out.set(c, off);
                off += c.byteLength;
            }
            store.set(relPath, out);
        },
    };
}

function finishAssemblySegment(
    active: ActiveWrite,
    assemblies: Map<string, AssemblyState>,
    sinkFactory: (relPath: string) => ExtractSink,
    createStore: (size: number) => AssemblyStore,
): void {
    const key = active.assemblyKey;
    if (!key) return;
    const assembly = assemblies.get(key);
    if (!assembly) return;

    const store = assembly.store ??= createStore(assembly.size);
    if (active.outputWritten !== active.outputSize) throw new InnoFormatError("GOG Galaxy segment size mismatch");
    if (active.galaxyInflate && (active.galaxyInflate.err || !active.galaxyInflate.ended)) throw new InnoFormatError("Incomplete GOG Galaxy zlib segment");
    assembly.segmentsLeft--;

    if (!assembly.finalized && assembly.segmentsLeft === 0) {
        assembly.finalized = true;
        const expected = assembly.expectedMd5;
        for (let at = 0; at < store.size; at += 256 * 1024) {
            assembly.hasher.update(store.readRangeSync(at, Math.min(store.size, at + 256 * 1024)));
        }
        const ok = !expected || verifyChecksum(assembly.hasher.digest(), expected, "md5");
        if (!ok) {
            throw new InnoFormatError(
                `checksum mismatch for "${assembly.relPaths[0]}" (corrupt download?)`,
            );
        }
        // Fan the assembled buffer out to every destination that shares this data (Inno dedup).
        for (const rel of assembly.relPaths) {
            const sink = sinkFactory(rel);
            sink.begin(rel, store.size);
            for (let at = 0; at < store.size; at += 256 * 1024) {
                sink.data(store.readRangeSync(at, Math.min(store.size, at + 256 * 1024)));
            }
            sink.end(true);
        }
        store.close();
        assembly.store = undefined;
    }
}

function processChunkGroup(
    group: { chunk: ChunkDescriptor; files: PlannedOutput[] },
    info: InnoParseResult,
    slice: SliceSource,
    lzma: UnpackDecoder,
    sinkFactory: (relPath: string) => ExtractSink,
    assemblies: Map<string, AssemblyState>,
    reportProgress: (n: number) => void,
    createStore: (size: number) => AssemblyStore,
): void {
    let streamPos = 0;
    let fileIdx = 0;
    let active: ActiveWrite | null = null;
    let pendingSkip = 0;

    const finishActive = () => {
        if (!active) return;
        if (active.remaining !== 0) throw new InnoFormatError("truncated file data in installer chunk");

        if (active.assemblyKey) {
            finishAssemblySegment(active, assemblies, sinkFactory, createStore);
            streamPos += active.remaining === 0 ? active.fileSize : 0;
            active = null;
            return;
        }

        if (active.exeFilter) {
            const tail = active.exeFilter.finish();
            if (tail.byteLength > 0) {
                const copied = copyBytes(tail);
                active.hasher.update(copied);
                for (const s of active.sinks) s.data(copied);
            }
        }

        const ok = verifyChecksum(active.hasher.digest(), active.expected, active.checksumType);
        for (let i = 0; i < active.sinks.length; i++) {
            active.sinks[i]!.end(ok);
            if (!ok) {
                throw new InnoFormatError(
                    `checksum mismatch for "${active.relPaths[i]}" (corrupt download?)`,
                );
            }
        }
        streamPos += active.remaining === 0 ? active.fileSize : 0;
        active = null;
    };

    const queueNext = () => {
        while (fileIdx < group.files.length && !active && pendingSkip === 0) {
            const planned = group.files[fileIdx]!;
            if (planned.fileOffset > streamPos) {
                pendingSkip = planned.fileOffset - streamPos;
                return;
            }
            if (planned.fileOffset < streamPos) {
                throw new InnoFormatError(
                    `bad file offset in chunk @ slice+0x${group.chunk.sortOffset.toString(16)}: ` +
                    `file start ${planned.fileOffset} < stream ${streamPos}`,
                );
            }
            fileIdx++;
            if (planned.want) {
                const data = info.dataEntries[planned.dataIndex]!;
                if (planned.assemblyKey) {
                    active = {
                        relPaths: planned.relPaths,
                        sinks: [],
                        remaining: planned.fileSize,
                        fileSize: planned.fileSize,
                        hasher: createChecksumHasher(data.checksumType),
                        expected: data.checksum,
                        checksumType: data.checksumType,
                        exeFilter: null,
                        zlibFilter: planned.zlibFilter,
                        outputOffset: planned.outputOffset,
                        outputSize: planned.outputSize,
                        assemblyKey: planned.assemblyKey,
                        isLastSegment: planned.isLastSegment,
                        outputWritten: 0,
                    };
                } else {
                    const sinks = planned.relPaths.map((rel) => {
                        const s = sinkFactory(rel);
                        s.begin(rel, planned.fileSize);
                        return s;
                    });
                    active = {
                        relPaths: planned.relPaths,
                        sinks,
                        remaining: planned.fileSize,
                        fileSize: planned.fileSize,
                        hasher: createChecksumHasher(data.checksumType),
                        expected: data.checksum,
                        checksumType: data.checksumType,
                        exeFilter: needsExeFilter(data.options) ? new InnoExeDecoder5309() : null,
                        zlibFilter: false,
                        outputOffset: 0,
                        outputSize: planned.fileSize,
                        assemblyKey: null,
                        isLastSegment: true,
                        outputWritten: 0,
                    };
                }
            } else {
                pendingSkip = planned.fileSize;
            }
        }
    };

    const consumeBytes = (bytes: Uint8Array): boolean => {
        let off = 0;
        while (off < bytes.byteLength) {
            if (active) {
                const take = Math.min(active.remaining, bytes.byteLength - off);
                let sliceBytes = copyBytes(bytes.subarray(off, off + take));

                if (active.assemblyKey) {
                    const write = (bytes: Uint8Array) => {
                        const assembly = assemblies.get(active!.assemblyKey!)!;
                        const store = assembly.store ??= createStore(assembly.size);
                        if (active!.outputWritten + bytes.length > active!.outputSize) throw new InnoFormatError("Galaxy segment exceeds declared size");
                        store.writeAt(bytes, active!.outputOffset + active!.outputWritten);
                        active!.outputWritten += bytes.length;
                    };
                    if (active.zlibFilter) {
                        if (!active.galaxyInflate) {
                            active.galaxyInflate = new Inflate({ chunkSize: 64 * 1024 });
                            active.galaxyInflate.onData = write;
                        }
                        active.galaxyInflate.push(sliceBytes, active.remaining === take);
                        if (active.galaxyInflate.err) throw new InnoFormatError("GOG Galaxy zlib decode failed");
                    } else write(sliceBytes);
                } else {
                    if (active.exeFilter) {
                        sliceBytes = active.exeFilter.push(sliceBytes);
                    }
                    active.hasher.update(sliceBytes);
                    for (const s of active.sinks) s.data(sliceBytes);
                }

                active.remaining -= take;
                off += take;
                if (active.remaining === 0) finishActive();
                continue;
            }
            if (pendingSkip > 0) {
                const take = Math.min(pendingSkip, bytes.byteLength - off);
                pendingSkip -= take;
                streamPos += take;
                off += take;
                if (pendingSkip === 0) queueNext();
                continue;
            }
            queueNext();
            if (!active && pendingSkip === 0 && fileIdx >= group.files.length) {
                off = bytes.byteLength;
                break;
            }
        }
        reportProgress(bytes.byteLength);
        return true;
    };

    queueNext();
    decompressChunkStream(slice, group.chunk, lzma, consumeBytes);
    if (active) finishActive();
}

export async function extractInno(
    source: RandomAccessSource,
    opts: ExtractOptions,
    sinkFactory: (relPath: string) => ExtractSink,
    lzma: UnpackDecoder,
    parsed?: InnoParseResult,
    /** External `.bin` slices for multi-part installers (when offsets.dataOffset === 0). */
    sliceSource?: SliceSource,
): Promise<void> {
    const info = parsed ?? await parseInnoHeader(source, lzma);

    if (encryptionUsed(info.header.options)) {
        throw new InnoFormatError("encrypted installer — password-protected Inno setups are not supported");
    }

    // Embedded data lives in the exe tail (single-file); dataOffset === 0 means the data
    // is split across external setup-*.bin slices, which the caller must supply.
    let slice: SliceSource;
    if (info.offsets.dataOffset) {
        slice = new EmbeddedSliceReader(source, info.offsets.dataOffset);
    } else if (sliceSource) {
        slice = sliceSource;
    } else {
        throw new InnoFormatError(
            "multi-part installer detected (data in external .bin files) — drop setup.exe and every setup-*.bin together",
        );
    }

    // Language-aware filter: drop per-language file variants whose Inno Check excludes the
    // chosen locale, so multi-language installers don't collapse to a last-write-wins (wrong)
    // language. No-op when language is unset or the file has no language Check.
    const lang = opts.language;
    const selected = filterExtractableFiles(
        info.files,
        info.dataEntries,
        lang ? (file) => checkAllowsLanguage(file.check, lang) : undefined,
    );
    const { chunks, totalBytes, assemblies } = replanWithHeaderCompression(
        selected,
        info.dataEntries,
        info.header.compression,
        opts.wantFile,
    );
    let doneBytes = 0;
    let lastProgress = 0;

    const reportProgress = (n: number) => {
        doneBytes += n;
        const now = performance.now();
        if (opts.onProgress && now - lastProgress >= 100) {
            opts.onProgress(doneBytes, totalBytes);
            lastProgress = now;
        }
    };

    const sortedChunks = [...chunks.values()].sort((a, b) => {
        if (a.chunk.firstSlice !== b.chunk.firstSlice) return a.chunk.firstSlice - b.chunk.firstSlice;
        return a.chunk.sortOffset - b.chunk.sortOffset;
    });

    const createStore = opts.createAssemblyStore ?? ((size: number): AssemblyStore => {
        const bytes = new Uint8Array(size);
        return { size, readRangeSync: (start, end) => bytes.subarray(start, end),
            writeAt: (data, offset) => bytes.set(data, offset), close() {} };
    });
    try {
        for (const group of sortedChunks) {
            processChunkGroup(group, info, slice, lzma, sinkFactory, assemblies, reportProgress, createStore);
        }
        if ([...assemblies.values()].some((a) => a.store && !a.finalized)) {
            throw new InnoFormatError("incomplete assembled installer file");
        }
    } finally {
        for (const assembly of assemblies.values()) assembly.store?.close();
    }

    opts.onProgress?.(doneBytes, totalBytes);
}

export async function extractInnoToMap(
    source: RandomAccessSource,
    opts: ExtractOptions,
    lzma: UnpackDecoder,
    parsed?: InnoParseResult,
    sliceSource?: SliceSource,
): Promise<Map<string, Uint8Array>> {
    const store = new CaseInsensitivePathMap();
    await extractInno(
        source,
        opts,
        (relPath) => createPathExtractSink(store, relPath),
        lzma,
        parsed,
        sliceSource,
    );
    return store.toMap();
}
