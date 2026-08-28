#!/usr/bin/env bun
/**
 * Unified WGB archive tool.
 *
 * Usage:
 *   bun tools/wgb.ts list     <archive.wgb>                        — list all entries
 *   bun tools/wgb.ts cat      <archive.wgb> <entry>                — print entry to stdout
 *   bun tools/wgb.ts extract  <archive.wgb> <entry> <output-path>  — extract entry to file
 *   bun tools/wgb.ts replace  <archive.wgb> <entry> <input-path>   — replace entry from file
 *   bun tools/wgb.ts add-dir  <archive.wgb> <prefix> <local-dir>   — add/overwrite a tree in one rewrite
 *   bun tools/wgb.ts manifest <archive.wgb>                        — pretty-print manifest.json
 *   bun tools/wgb.ts set-manifest <archive.wgb> <manifest.json>    — replace manifest from file
 *   bun tools/wgb.ts patch-manifest <archive.wgb> <json-path> <value> — set a single JSON path
 *
 * WGB files are uncompressed (Store-only) ZIP archives.
 *
 * LARGE BUNDLES: this tool NEVER loads the whole archive into RAM. Reads go through
 * ranged file-descriptor reads (only the EOCD tail, the central directory, and the
 * requested entry's data are touched); writes stream entry-by-entry to a temp file.
 * Offsets are 64-bit (JS numbers, safe to 2^53) and ZIP64 (>4GB) is parsed and emitted.
 * This is what lets `cat`/`list`/`replace` work on multi-GB bundles (e.g. xiii.wgb,
 * 2.5GB) where the old readFileSync(whole file) path panicked ("cast negative value
 * to unsigned integer" — a >2GB Buffer length overflow).
 */

import { openSync, readSync, writeSync, closeSync, fstatSync, renameSync, unlinkSync, readdirSync } from "fs";
import { inflateRawSync } from "zlib";
import {
    crc32, lfhFor, cdhFor, type OutEntry,
    LFH_SIG, CDH_SIG, EOCD_SIG, EOCD64_SIG, EOCD64_LOC_SIG, U32_MAX, U16_MAX, COPY_CHUNK,
} from "./internal/zip-store-writer";

// ─── Ranged file I/O (64-bit safe; never loads the whole file) ───────────────

/** Read exactly `len` bytes from absolute byte `start`; returns the (possibly short) slice. */
function readRange(fd: number, start: number, len: number): Buffer {
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
        const n = readSync(fd, buf, got, len - got, start + got);
        if (n <= 0) break;
        got += n;
    }
    return got === len ? buf : buf.subarray(0, got);
}

/** ZIP64 reads store 64-bit little-endian; clamp to JS safe-int range (archives < 8 PiB). */
function readU64(buf: Buffer, off: number): number {
    const v = buf.readBigUInt64LE(off);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`ZIP64 value at +${off} exceeds 2^53`);
    return Number(v);
}

interface ZipEntry {
    name: string;
    compression: number;
    crc: number;
    compressedSize: number;
    /** Uncompressed (= compressed for Store) size */
    size: number;
    /** Offset of the Local File Header in the archive */
    lfhOffset: number;
}

/** Locate the central directory, following the ZIP64 locator when the EOCD fields are sentinels. */
function locateCentralDir(fd: number, fileSize: number): { cdOffset: number; cdSize: number; entryCount: number } {
    const tailLen = Math.min(fileSize, 65557); // 0xffff max comment + 22-byte EOCD
    const tail = readRange(fd, fileSize - tailLen, tailLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Not a ZIP file (EOCD not found)");

    let entryCount = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    // ZIP64: any sentinel means the real values live in the ZIP64 EOCD, found via the locator.
    if (cdOffset === U32_MAX || cdSize === U32_MAX || entryCount === U16_MAX) {
        const locRel = eocd - 20;
        if (locRel >= 0 && tail.readUInt32LE(locRel) === EOCD64_LOC_SIG) {
            const eocd64Off = readU64(tail, locRel + 8);
            const z = readRange(fd, eocd64Off, 56);
            if (z.length < 56 || z.readUInt32LE(0) !== EOCD64_SIG) throw new Error("ZIP64 EOCD signature missing");
            entryCount = readU64(z, 32);
            cdSize = readU64(z, 40);
            cdOffset = readU64(z, 48);
        }
    }
    return { cdOffset, cdSize, entryCount };
}

/** Parse the central directory into entries (ZIP64 extra fields resolved). No data is read. */
function parseCentralDir(fd: number, fileSize: number): ZipEntry[] {
    const { cdOffset, cdSize, entryCount } = locateCentralDir(fd, fileSize);
    const cd = readRange(fd, cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    let pos = 0;
    for (let i = 0; i < entryCount; i++) {
        if (cd.readUInt32LE(pos) !== CDH_SIG) throw new Error(`Bad CDH signature at CD+${pos}`);
        const compression = cd.readUInt16LE(pos + 10);
        const crc = cd.readUInt32LE(pos + 16);
        let compressedSize = cd.readUInt32LE(pos + 20);
        let size = cd.readUInt32LE(pos + 24);
        const nameLen = cd.readUInt16LE(pos + 28);
        const extraLen = cd.readUInt16LE(pos + 30);
        const commentLen = cd.readUInt16LE(pos + 32);
        let lfhOffset = cd.readUInt32LE(pos + 42);
        const name = cd.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");

        // ZIP64 extended info (0x0001): present fields appear in this fixed order, but ONLY
        // for the 32-bit fields that held the 0xffffffff sentinel.
        if (size === U32_MAX || compressedSize === U32_MAX || lfhOffset === U32_MAX) {
            let ex = pos + 46 + nameLen;
            const exEnd = ex + extraLen;
            while (ex + 4 <= exEnd) {
                const id = cd.readUInt16LE(ex);
                const dlen = cd.readUInt16LE(ex + 2);
                let dp = ex + 4;
                if (id === 0x0001) {
                    if (size === U32_MAX) { size = readU64(cd, dp); dp += 8; }
                    if (compressedSize === U32_MAX) { compressedSize = readU64(cd, dp); dp += 8; }
                    if (lfhOffset === U32_MAX) { lfhOffset = readU64(cd, dp); dp += 8; }
                    break;
                }
                ex += 4 + dlen;
            }
        }

        entries.push({ name, compression, crc, compressedSize, size, lfhOffset });
        pos += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

/** Absolute byte offset of an entry's data (resolved from its Local File Header). */
function dataOffsetOf(fd: number, e: ZipEntry): number {
    const lfh = readRange(fd, e.lfhOffset, 30);
    if (lfh.readUInt32LE(0) !== LFH_SIG) throw new Error(`Bad LFH at ${e.lfhOffset} for ${e.name}`);
    return e.lfhOffset + 30 + lfh.readUInt16LE(26) + lfh.readUInt16LE(28);
}

/** Read & return an entry's full uncompressed bytes (used for small entries: manifest, JSON, override). */
function readEntryData(fd: number, e: ZipEntry): Buffer {
    const off = dataOffsetOf(fd, e);
    const raw = readRange(fd, off, e.compressedSize);
    if (e.compression === 0) return raw;
    if (e.compression === 8) {
        const data = inflateRawSync(raw) as Buffer;
        if (data.length !== e.size) throw new Error(`Entry ${e.name}: inflated ${data.length} != CDH size ${e.size}`);
        return data;
    }
    throw new Error(`Entry ${e.name}: unsupported compression method ${e.compression}`);
}

/** Stream a Store entry's data out via `sink` in bounded chunks (no full-entry allocation). */
function streamStoreData(fd: number, e: ZipEntry, sink: (chunk: Buffer) => void): void {
    const off = dataOffsetOf(fd, e);
    let remaining = e.size;
    let at = off;
    const buf = Buffer.allocUnsafe(Math.min(COPY_CHUNK, remaining || 1));
    while (remaining > 0) {
        const want = Math.min(buf.length, remaining);
        const n = readSync(fd, buf, 0, want, at);
        if (n <= 0) throw new Error(`Short read on ${e.name} at ${at}`);
        sink(buf.subarray(0, n));
        at += n;
        remaining -= n;
    }
}

/**
 * Rebuild the archive as Store-only, streaming to a temp file then renaming over the source.
 * `dataFor(name)` returns an override Buffer for an entry, or null to copy the existing data.
 * Entries are taken from `srcEntries` (order preserved); any extra entries in `extraEntries`
 * (name → data) are appended.
 */
function rebuildStreaming(
    srcFd: number,
    srcEntries: ZipEntry[],
    outPath: string,
    dataFor: (name: string) => Buffer | null,
    extraEntries: { name: string; data: Buffer }[] = [],
): { bytes: number; entries: number } {
    const outFd = openSync(outPath, "w");
    try {
        const cd: OutEntry[] = [];
        let offset = 0;
        const writeAt = (b: Buffer) => { writeSync(outFd, b, 0, b.length); offset += b.length; };

        const emit = (name: string, getData: () => Buffer | null, copyFrom: ZipEntry | null) => {
            const nameBuf = Buffer.from(name, "utf8");
            const override = getData();
            const entryOffset = offset;
            if (override) {
                const crc = crc32(override);
                writeAt(lfhFor(nameBuf, override.length, crc));
                writeSync(outFd, override, 0, override.length); offset += override.length;
                cd.push({ nameBuf, size: override.length, crc, offset: entryOffset });
            } else if (copyFrom) {
                // Copy the existing Store entry verbatim (reuse its CRC; stream the data).
                writeAt(lfhFor(nameBuf, copyFrom.size, copyFrom.crc));
                streamStoreData(srcFd, copyFrom, (chunk) => { writeSync(outFd, chunk, 0, chunk.length); offset += chunk.length; });
                cd.push({ nameBuf, size: copyFrom.size, crc: copyFrom.crc, offset: entryOffset });
            }
        };

        for (const e of srcEntries) {
            if (e.compression !== 0) throw new Error(`Entry ${e.name} is compressed (method=${e.compression}); run: bun tools/wgb.ts repack <archive>`);
            emit(e.name, () => dataFor(e.name), e);
        }
        for (const x of extraEntries) emit(x.name, () => x.data, null);

        // Central directory
        const cdOffset = offset;
        for (const e of cd) writeAt(cdhFor(e));
        const cdSize = offset - cdOffset;

        const needsZip64 = cdOffset > U32_MAX || cdSize > U32_MAX || cd.length > U16_MAX;
        if (needsZip64) {
            const z = Buffer.alloc(56);
            z.writeUInt32LE(EOCD64_SIG, 0);
            z.writeBigUInt64LE(BigInt(44), 4); // size of remaining ZIP64 EOCD record
            z.writeUInt16LE(45, 12);
            z.writeUInt16LE(45, 14);
            z.writeBigUInt64LE(BigInt(cd.length), 24);
            z.writeBigUInt64LE(BigInt(cd.length), 32);
            z.writeBigUInt64LE(BigInt(cdSize), 40);
            z.writeBigUInt64LE(BigInt(cdOffset), 48);
            const eocd64Off = offset;
            writeAt(z);
            const loc = Buffer.alloc(20);
            loc.writeUInt32LE(EOCD64_LOC_SIG, 0);
            loc.writeBigUInt64LE(BigInt(eocd64Off), 8);
            loc.writeUInt32LE(1, 16);
            writeAt(loc);
        }

        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(EOCD_SIG, 0);
        eocd.writeUInt16LE(cd.length > U16_MAX ? U16_MAX : cd.length, 8);
        eocd.writeUInt16LE(cd.length > U16_MAX ? U16_MAX : cd.length, 10);
        eocd.writeUInt32LE(cdSize > U32_MAX ? U32_MAX : cdSize, 12);
        eocd.writeUInt32LE(cdOffset > U32_MAX ? U32_MAX : cdOffset, 16);
        writeAt(eocd);

        return { bytes: offset, entries: cd.length };
    } finally {
        closeSync(outFd);
    }
}

// ─── Commands ───────────────────────────────────────────────────────────────

function findEntry(entries: ZipEntry[], name: string): ZipEntry | undefined {
    return entries.find(e => e.name === name) ??
           entries.find(e => e.name.toLowerCase() === name.toLowerCase());
}

function withArchive<T>(wgbPath: string, fn: (fd: number, size: number, entries: ZipEntry[]) => T): T {
    const fd = openSync(wgbPath, "r");
    try {
        const size = fstatSync(fd).size;
        return fn(fd, size, parseCentralDir(fd, size));
    } finally {
        closeSync(fd);
    }
}

function cmdList(wgbPath: string) {
    withArchive(wgbPath, (_fd, size, entries) => {
        const maxSize = Math.max(...entries.map(e => e.size.toString().length), 4);
        for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
            console.log(`${e.size.toString().padStart(maxSize)}  ${e.name}`);
        }
        console.log(`\n${entries.length} entries, ${size} bytes total`);
    });
}

function cmdCat(wgbPath: string, entryName: string) {
    withArchive(wgbPath, (fd, _size, entries) => {
        const entry = findEntry(entries, entryName);
        if (!entry) { console.error(`Entry not found: ${entryName}`); process.exit(1); }
        if (entry.compression === 0) {
            streamStoreData(fd, entry, (chunk) => process.stdout.write(chunk));
        } else {
            process.stdout.write(readEntryData(fd, entry));
        }
    });
}

function cmdExtract(wgbPath: string, entryName: string, outputPath: string) {
    withArchive(wgbPath, (fd, _size, entries) => {
        const entry = findEntry(entries, entryName);
        if (!entry) { console.error(`Entry not found: ${entryName}`); process.exit(1); }
        const outFd = openSync(outputPath, "w");
        try {
            if (entry.compression === 0) streamStoreData(fd, entry, (c) => writeSync(outFd, c, 0, c.length));
            else { const d = readEntryData(fd, entry); writeSync(outFd, d, 0, d.length); }
        } finally { closeSync(outFd); }
        console.log(`Extracted ${entry.name} -> ${outputPath} (${entry.size} bytes)`);
    });
}

/** Rebuild `wgbPath` with `entryName` replaced/added by `newData`, streaming via a temp file. */
function writeOverride(wgbPath: string, entryName: string, newData: Buffer, outputPath?: string, label = "Replaced") {
    const dest = outputPath ?? wgbPath;
    const tmp = `${dest}.wgbtmp`;
    const result = withArchive(wgbPath, (fd, _size, entries) => {
        const target = findEntry(entries, entryName);
        const extra = target ? [] : [{ name: entryName, data: newData }];
        return rebuildStreaming(fd, entries, tmp, (n) => (target && n === target.name ? newData : null), extra);
    });
    renameSync(tmp, dest);
    console.log(`${label} ${entryName} (${newData.length} bytes) -> ${dest} [${result.entries} entries, ${result.bytes} bytes]`);
}

function cmdReplace(wgbPath: string, entryName: string, inputPath: string, outputPath?: string) {
    const ifd = openSync(inputPath, "r");
    let newData: Buffer;
    try { newData = readRange(ifd, 0, fstatSync(ifd).size); } finally { closeSync(ifd); }
    writeOverride(wgbPath, entryName, newData, outputPath);
}

/**
 * Add every file under `localDir` to the archive as `<entryPrefix>/<relative path>`, in ONE
 * rewrite. One-at-a-time `replace` would copy a multi-GB bundle once per file, which for a
 * shader cache (hundreds of small entries) is the difference between minutes and hours.
 * An entry that already exists is overwritten in place, so re-baking is idempotent.
 */
function cmdAddDir(wgbPath: string, entryPrefix: string, localDir: string) {
    const prefix = entryPrefix.replace(/[/]+$/, "");
    const files: { name: string; data: Buffer }[] = [];
    const walk = (dir: string, rel: string) => {
        for (const de of readdirSync(dir, { withFileTypes: true })) {
            const child = `${dir}/${de.name}`;
            const childRel = rel ? `${rel}/${de.name}` : de.name;
            if (de.isDirectory()) { walk(child, childRel); continue; }
            const fd = openSync(child, "r");
            try { files.push({ name: `${prefix}/${childRel}`, data: readRange(fd, 0, fstatSync(fd).size) }); }
            finally { closeSync(fd); }
        }
    };
    walk(localDir, "");
    if (files.length === 0) { console.error(`No files under ${localDir}`); process.exit(1); }

    const tmp = `${wgbPath}.wgbtmp`;
    const result = withArchive(wgbPath, (fd, _size, entries) => {
        const byName = new Map(files.map(f => [f.name, f.data]));
        const existing = new Set(entries.map(e => e.name));
        const extra = files.filter(f => !existing.has(f.name));
        return rebuildStreaming(fd, entries, tmp, (n) => byName.get(n) ?? null, extra);
    });
    renameSync(tmp, wgbPath);
    const bytes = files.reduce((n, f) => n + f.data.length, 0);
    console.log(`Added ${files.length} file(s) under ${prefix}/ (${bytes} bytes) -> ${wgbPath} [${result.entries} entries, ${result.bytes} bytes]`);
}

function cmdManifest(wgbPath: string) {
    withArchive(wgbPath, (fd, _size, entries) => {
        const entry = findEntry(entries, "manifest.json");
        if (!entry) { console.error("manifest.json not found in archive"); process.exit(1); }
        console.log(JSON.stringify(JSON.parse(readEntryData(fd, entry).toString("utf8")), null, 2));
    });
}

function cmdSetManifest(wgbPath: string, manifestPath: string) {
    const fd = openSync(manifestPath, "r");
    const newManifest = readRange(fd, 0, fstatSync(fd).size); closeSync(fd);
    JSON.parse(newManifest.toString("utf8")); // validate
    writeOverride(wgbPath, "manifest.json", newManifest);
}

function cmdRepack(wgbPath: string) {
    const tmp = `${wgbPath}.wgbtmp`;
    const fd = openSync(wgbPath, "r");
    try {
        const size = fstatSync(fd).size;
        const entries = parseCentralDir(fd, size);
        // Decompress any Deflate entries up front (Store entries stream-copy untouched).
        const overrides = new Map<string, Buffer>();
        let decompressed = 0;
        for (const e of entries) {
            if (e.compression === 0) continue;
            const data = readEntryData(fd, e); // inflates + validates size
            const actualCrc = crc32(data);
            if (actualCrc !== e.crc) throw new Error(`Entry ${e.name}: CRC mismatch (expected 0x${e.crc.toString(16)}, got 0x${actualCrc.toString(16)})`);
            overrides.set(e.name, data);
            decompressed++;
        }
        // Treat all entries as Store for the rebuild (compression flag normalized in emit()).
        const storeEntries = entries.map(e => ({ ...e, compression: 0 }));
        const r = rebuildStreaming(fd, storeEntries, tmp, (n) => overrides.get(n) ?? null);
        closeSync(fd);
        renameSync(tmp, wgbPath);
        console.log(`Repacked ${wgbPath}: ${r.entries} entries (${decompressed} decompressed), ${r.bytes} bytes, all Store-only`);
        return;
    } catch (e) {
        closeSync(fd);
        try { unlinkSync(tmp); } catch { /* ignore */ }
        throw e;
    }
}

function cmdPatchManifest(wgbPath: string, jsonPath: string, valueStr: string) {
    const manifest = withArchive(wgbPath, (fd, _size, entries) => {
        const entry = findEntry(entries, "manifest.json");
        if (!entry) { console.error("manifest.json not found"); process.exit(1); }
        return JSON.parse(readEntryData(fd, entry).toString("utf8"));
    });

    let value: unknown;
    try { value = JSON.parse(valueStr); } catch {
        // Looks like JSON but doesn't parse — almost always shell quoting mangling
        // (e.g. Git Bash on Windows collapsing \\ in argv). Storing it as a raw
        // string would silently break array/object manifest fields at load time.
        if (/^[[{"]/.test(valueStr.trim())) {
            console.error(`Value looks like JSON but failed to parse: ${valueStr}\n` +
                `Fix the shell quoting (tip: use forward slashes in paths) or pass a plain string.`);
            process.exit(1);
        }
        value = valueStr;
    }

    const keys = jsonPath.split(".");
    let obj = manifest;
    for (let i = 0; i < keys.length - 1; i++) {
        if (obj[keys[i]] === undefined) obj[keys[i]] = {};
        obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;

    writeOverride(wgbPath, "manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), undefined, "Patched");
    console.log(`  ${jsonPath} = ${JSON.stringify(value)}`);
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const USAGE = `WGB archive tool — uncompressed ZIP bundles for BottleShip (large-bundle safe, ZIP64)

Usage:
  bun tools/wgb.ts list          <archive.wgb>
  bun tools/wgb.ts cat           <archive.wgb> <entry>
  bun tools/wgb.ts extract       <archive.wgb> <entry> <output>
  bun tools/wgb.ts replace       <archive.wgb> <entry> <input> [output]
  bun tools/wgb.ts add-dir       <archive.wgb> <entry-prefix> <local-dir>  — add/overwrite a whole tree in one rewrite
  bun tools/wgb.ts repack        <archive.wgb>                    — rewrite as Store-only (decompress Deflate entries)
  bun tools/wgb.ts manifest      <archive.wgb>
  bun tools/wgb.ts set-manifest  <archive.wgb> <manifest.json>
  bun tools/wgb.ts patch-manifest <archive.wgb> <json.path> <value>`;

const cmd = process.argv[2];
const args = process.argv.slice(3);

if (!cmd) { console.log(USAGE); process.exit(0); }

switch (cmd) {
    case "list":
    case "ls":
        if (!args[0]) { console.error("Usage: wgb.ts list <archive>"); process.exit(1); }
        cmdList(args[0]);
        break;
    case "cat":
        if (!args[0] || !args[1]) { console.error("Usage: wgb.ts cat <archive> <entry>"); process.exit(1); }
        cmdCat(args[0], args[1]);
        break;
    case "extract":
    case "x":
        if (!args[0] || !args[1] || !args[2]) { console.error("Usage: wgb.ts extract <archive> <entry> <output>"); process.exit(1); }
        cmdExtract(args[0], args[1], args[2]);
        break;
    case "replace":
        if (!args[0] || !args[1] || !args[2]) { console.error("Usage: wgb.ts replace <archive> <entry> <input> [output]"); process.exit(1); }
        cmdReplace(args[0], args[1], args[2], args[3]);
        break;
    case "add-dir":
        if (!args[0] || !args[1] || !args[2]) { console.error("Usage: wgb.ts add-dir <archive> <entry-prefix> <local-dir>"); process.exit(1); }
        cmdAddDir(args[0], args[1], args[2]);
        break;
    case "repack":
        if (!args[0]) { console.error("Usage: wgb.ts repack <archive>"); process.exit(1); }
        cmdRepack(args[0]);
        break;
    case "manifest":
        if (!args[0]) { console.error("Usage: wgb.ts manifest <archive>"); process.exit(1); }
        cmdManifest(args[0]);
        break;
    case "set-manifest":
        if (!args[0] || !args[1]) { console.error("Usage: wgb.ts set-manifest <archive> <manifest.json>"); process.exit(1); }
        cmdSetManifest(args[0], args[1]);
        break;
    case "patch-manifest":
    case "pm":
        if (!args[0] || !args[1] || !args[2]) { console.error("Usage: wgb.ts patch-manifest <archive> <path> <value>"); process.exit(1); }
        cmdPatchManifest(args[0], args[1], args[2]);
        break;
    default:
        console.error(`Unknown command: ${cmd}\n`);
        console.log(USAGE);
        process.exit(1);
}
