#!/usr/bin/env bun
import { closeSync, existsSync, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "fs";
import {
    BLOCK_STREAM_END, deflateRawBlock, encodeBlockIndex, unixToDosDateTime, WGB_BLOCK_INDEX_ENTRY, WGB_BLOCK_INDEX_VERSION, ZipArchive,
    type BlockIndexRow, type ZipSource,
} from "@bottleship/formats/zip";
import { crc32, ZipStoreWriter } from "./internal/zip-store-writer";

const ALWAYS_STORED = ["manifest.json", "registry.json"];
const PRECOMPRESSED = new Set(["ogg", "mp3", "wma", "flac", "bik", "bk2", "smk", "avi", "wmv", "mpg", "mpeg", "xmv", "mp4", "webm", "jpg", "jpeg", "png", "gif", "cab", "zip", "7z", "rar", "gz"]);
const MAX_MEMBER_BYTES = 2 ** 31 - 1;

export interface CompressOptions {
    blockKiB?: number;
    level?: number;
    minSavingPct?: number;
    store?: readonly string[];
    verify?: boolean;
    compressAll?: boolean;
}

export interface CompressReport {
    inputBytes: number;
    outputBytes: number;
    entries: number;
    deflated: number;
    stored: number;
    blockKiB: number;
    level: number;
    blocks: number;
    seconds: number;
}

class FdSource implements ZipSource {
    readonly size: number;
    constructor(private readonly fd: number) {
        this.size = Number(fstatSync(fd, { bigint: true }).size);
    }
    readRangeSync(start: number, end: number): Uint8Array {
        const len = Math.max(0, Math.min(end, this.size) - start);
        const out = new Uint8Array(len);
        let got = 0;
        while (got < len) {
            const n = readSync(this.fd, out, got, len - got, start + got);
            if (n <= 0) break;
            got += n;
        }
        return got === len ? out : out.subarray(0, got);
    }
    async readRange(start: number, end: number): Promise<Uint8Array> {
        return this.readRangeSync(start, end);
    }
}

export function withBlockIndexRef(manifest: Uint8Array): Uint8Array {
    const m = JSON.parse(new TextDecoder().decode(manifest)) as Record<string, unknown>;
    m.blockIndex = { member: WGB_BLOCK_INDEX_ENTRY, version: WGB_BLOCK_INDEX_VERSION };
    return new TextEncoder().encode(JSON.stringify(m, null, 2));
}

export function deflateBlocks(data: Uint8Array, blockSize: number, level: number): { parts: Uint8Array[]; lengths: number[] } {
    const parts: Uint8Array[] = [];
    const lengths: number[] = [];
    for (let off = 0; off < data.byteLength; off += blockSize) {
        const block = deflateRawBlock(data.subarray(off, Math.min(data.byteLength, off + blockSize)), level);
        parts.push(block);
        lengths.push(block.byteLength);
    }
    parts.push(BLOCK_STREAM_END);
    return { parts, lengths };
}

export async function compressWgb(input: string, output: string, options: CompressOptions = {}): Promise<CompressReport> {
    const started = performance.now();
    const blockKiB = options.blockKiB ?? 64;
    const shift = Math.log2(blockKiB * 1024);
    if (!Number.isInteger(shift) || shift < 12 || shift > 24) throw new Error(`--block-kib must be a power of two between 4 and 16384 (got ${blockKiB})`);
    const blockSize = 2 ** shift;
    const level = options.level ?? 9;
    const minSaving = (options.minSavingPct ?? 5) / 100;
    const keep = new Set([...ALWAYS_STORED, ...(options.store ?? [])].map(n => n.toLowerCase()));
    const skipExt = options.compressAll ? new Set<string>() : PRECOMPRESSED;

    const fd = openSync(input, "r");
    const tmp = `${output}.tmp-${process.pid}`;
    let report: CompressReport;
    try {
        const source = new FdSource(fd);
        const archive = new ZipArchive(source, { blockCacheBytes: 0 });
        await archive.init();
        const entries = archive.listEntries()
            .filter(e => e.name !== WGB_BLOCK_INDEX_ENTRY)
            .sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
        const writer = new ZipStoreWriter(tmp);
        const rows: BlockIndexRow[] = [];
        let deflated = 0, stored = 0, blocks = 0;
        for (const entry of entries) {
            const stamp = entry.modified === undefined ? 0 : unixToDosDateTime(entry.modified);
            if (entry.uncompressedSize > MAX_MEMBER_BYTES) throw new Error(`${entry.name}: members of 2 GiB or more are not supported (each member is packed in RAM)`);
            let data = entry.isDirectory ? new Uint8Array(0) : await archive.readEntry(entry);
            let crc = crc32(data);
            if (entry.crc32 !== undefined && !entry.isDirectory && crc !== entry.crc32) {
                throw new Error(`${entry.name}: CRC mismatch in input`);
            }
            if (entry.name.toLowerCase() === "manifest.json") {
                data = withBlockIndexRef(data);
                crc = crc32(data);
            }
            const ext = entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase();
            if (entry.isDirectory || data.byteLength === 0 || keep.has(entry.name.toLowerCase()) || skipExt.has(ext)) {
                writer.addStored(entry.name, data, stamp, crc);
                stored++;
                continue;
            }
            const { parts, lengths } = deflateBlocks(data, blockSize, level);
            let compressedSize = 0;
            for (const p of parts) compressedSize += p.byteLength;
            if (data.byteLength - compressedSize < Math.max(4096, data.byteLength * minSaving)) {
                writer.addStored(entry.name, data, stamp, crc);
                stored++;
                continue;
            }
            const localHeaderOffset = writer.addDeflated(entry.name, parts, data.byteLength, crc, stamp);
            rows.push({ name: entry.name, localHeaderOffset, uncompressedSize: data.byteLength, compressedSize, crc32: crc, shift, blockLengths: lengths });
            deflated++;
            blocks += lengths.length;
        }
        writer.addStored(WGB_BLOCK_INDEX_ENTRY, encodeBlockIndex(rows));
        const { bytes } = writer.finish();
        report = { inputBytes: source.size, outputBytes: bytes, entries: entries.length, deflated, stored, blockKiB, level, blocks, seconds: 0 };
        if (options.verify !== false) await verifyWgb(input, tmp);
    } catch (e) {
        if (existsSync(tmp)) unlinkSync(tmp);
        throw e;
    } finally {
        closeSync(fd);
    }
    renameSync(tmp, output);
    report.seconds = (performance.now() - started) / 1000;
    return report;
}

export async function verifyWgb(original: string, packed: string): Promise<void> {
    const fa = openSync(original, "r"), fb = openSync(packed, "r");
    try {
        const a = new ZipArchive(new FdSource(fa), { blockCacheBytes: 0 });
        const b = new ZipArchive(new FdSource(fb), { blockCacheBytes: 0 });
        await a.init();
        await b.init();
        if (b.blockIndexState !== "loaded") throw new Error(`verify: block index ${b.blockIndexState} (${b.blockIndexError ?? ""})`);
        for (const ea of a.listEntries()) {
            if (ea.name === WGB_BLOCK_INDEX_ENTRY) continue;
            const eb = b.getEntry(ea.name);
            if (!eb) throw new Error(`verify: ${ea.name} missing`);
            if (ea.isDirectory) continue;
            if (eb.compression === 8 && !eb.blocks) throw new Error(`verify: ${ea.name} is deflated without a block index`);
            const want = ea.name.toLowerCase() === "manifest.json" ? withBlockIndexRef(await a.readEntry(ea)) : await a.readEntry(ea);
            const whole = await b.readEntry(eb);
            if (Buffer.compare(Buffer.from(want), Buffer.from(whole)) !== 0) throw new Error(`verify: ${ea.name} differs (whole)`);
            if (!eb.blocks) continue;
            const ranged = b.readEntryRangeSync(eb, 0, eb.uncompressedSize);
            if (!ranged || Buffer.compare(Buffer.from(want), Buffer.from(ranged)) !== 0) throw new Error(`verify: ${ea.name} differs (block range)`);
        }
    } finally {
        closeSync(fa);
        closeSync(fb);
    }
}

function parseArgs(argv: string[]): { input: string; output: string; options: CompressOptions; json?: string } {
    const pos: string[] = [];
    const options: CompressOptions = {};
    const store: string[] = [];
    let json: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--block-kib") options.blockKiB = Number(argv[++i]);
        else if (a === "--level") options.level = Number(argv[++i]);
        else if (a === "--min-saving-pct") options.minSavingPct = Number(argv[++i]);
        else if (a === "--store") store.push(argv[++i]);
        else if (a === "--no-verify") options.verify = false;
        else if (a === "--compress-all") options.compressAll = true;
        else if (a === "--json") json = argv[++i];
        else pos.push(a);
    }
    if (pos.length !== 2) {
        console.error("usage: bun tools/wgb-compress.ts <in.wgb> <out.wgb> [--block-kib 64] [--level 9] [--min-saving-pct 5] [--store <entry>]... [--compress-all] [--no-verify] [--json <report.json>]\nMembers are packed in RAM one at a time; members of 2 GiB or more are not supported.");
        process.exit(2);
    }
    options.store = store;
    return { input: pos[0], output: pos[1], options, json };
}

if (import.meta.main) {
    const { input, output, options, json } = parseArgs(process.argv.slice(2));
    const r = await compressWgb(input, output, options);
    const mb = (n: number) => (n / 1048576).toFixed(1);
    console.log(`${input}: ${mb(r.inputBytes)} MiB -> ${mb(r.outputBytes)} MiB (${((r.outputBytes / r.inputBytes - 1) * 100).toFixed(1)} %), ${r.deflated} deflated / ${r.stored} stored, ${r.blocks} blocks of ${r.blockKiB} KiB, ${r.seconds.toFixed(1)} s`);
    if (json) writeFileSync(json, JSON.stringify(r, null, 1));
}
