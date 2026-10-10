#!/usr/bin/env bun
/**
 * iso-to-wgb: Repack a CD/DVD image (ISO9660 or BIN+CUE) into a .wgb bundle.
 *
 * The disc filesystem is read through packages/formats/src/iso (the same reusable reader
 * the browser ingestion uses) and streamed straight into a store-only zip, so a
 * multi-GB disc never has to live in RAM.
 *
 * Usage:
 *   bun tools/iso-to-wgb.ts <image...> <output.wgb> [options]
 *
 * Inputs (one or more, mixed):
 *   game.iso                 plain ISO9660 or raw-sector (.iso/.img/.bin) image
 *   game.cue                 cue sheet — its data-track BIN is read alongside it
 *   discs.zip                archive containing an .iso (or .cue + .bin)
 *
 * Multiple images = a multi-disc title: their trees are merged into one rom/.
 * By default identical paths collapse (first disc wins, conflicts reported); pass
 * --disc-dirs to keep each disc under disc1/ disc2/ … instead.
 *
 * Options:
 *   --name <str>          Display name        (default: volume label of disc 1)
 *   --exe  <str>          Entrypoint exe relative to rom/ (default: auto-detect)
 *   --args <str>          Command-line args
 *   --width/--height/--bpp/--ram/--os    same as make-wgb (def 640x480x16, 64MB, win98)
 *   --game-id <scheme:id> Stable save key (default: app:<slug(name)>)
 *   --reg-hive/--reg-path/--reg-install   optional InstallPath registry seed
 *   --skip-video          Set emulator.skipVideo=true
 *   --cd-path <str>       Guest path the CD-ROM drive (D:\) aliases to, for a title that
 *                         checks for its disc: "C:\" (the disc root), or "C:\discN" with
 *                         --disc-dirs. D: then reports that disc's own volume label.
 *   --cd-label <str>      Override the volume label D: reports
 *   --disc-dirs           Keep each disc in its own rom/discN/ subtree
 *   --list                Parse + list disc contents, do not pack
 */

import { openSync, readSync, writeSync, closeSync, statSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join, dirname, basename, extname } from "path";
import { inflateRawSync } from "zlib";
import type { RandomAccessSource } from "@bottleship/formats/unpack/source";
import { BufferSource } from "@bottleship/formats/unpack/source";
import { IsoImage, parseIso9660, parseCue, type IsoFileEntry } from "@bottleship/formats/iso";
import { detectExeFromPaths } from "@bottleship/repack/gog-filter";
import { discLabelForCdPath } from "@bottleship/repack/disc-label";
import { detectInstallShield, extractInstallerFromFiles } from "@bottleship/repack/container-extract";
import { isValidGameId, deriveGameId, KNOWN_GAME_ID_SCHEMES } from "@bottleship/formats/wgb/container-id";

// ---------------------------------------------------------------------------
// File-backed random-access source (no full-file load)
// ---------------------------------------------------------------------------

class FileSource implements RandomAccessSource {
    readonly size: number;
    private readonly fd: number;
    private readonly base: number;

    constructor(path: string, base = 0, size?: number) {
        this.fd = openSync(path, "r");
        this.base = base;
        this.size = size ?? statSync(path).size - base;
    }

    readRangeSync(start: number, end: number): Uint8Array {
        const s = Math.max(0, Math.min(start, this.size));
        const e = Math.max(s, Math.min(end, this.size));
        const len = e - s;
        const buf = Buffer.allocUnsafe(len);
        let got = 0;
        while (got < len) {
            const n = readSync(this.fd, buf, got, len - got, this.base + s + got);
            if (n <= 0) break;
            got += n;
        }
        return got === len ? buf : buf.subarray(0, got);
    }

    close(): void { closeSync(this.fd); }
}

// ---------------------------------------------------------------------------
// Streaming store-only ZIP writer (seek-back CRC patch)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c; }
    return t;
})();
function crcUpdate(crc: number, data: Uint8Array): number {
    for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
    return crc >>> 0;
}

const U32_MAX = 0xffffffff;

interface CdEntry { nameBytes: Uint8Array; crc: number; size: number; offset: number; }

class StreamingStoreZip {
    private readonly fd: number;
    private offset = 0;
    private readonly entries: CdEntry[] = [];

    constructor(path: string) { this.fd = openSync(path, "w"); }

    private write(buf: Uint8Array): void {
        writeSync(this.fd, buf, 0, buf.length, this.offset);
        this.offset += buf.length;
    }

    /** Add a file whose bytes are produced by `produce(writeChunk)`. */
    addStreaming(name: string, totalSize: number, produce: (writeChunk: (c: Uint8Array) => void) => void): void {
        if (totalSize > U32_MAX) throw new Error(`zip: file "${name}" exceeds 4 GiB (ZIP64 not supported)`);
        const nameBytes = new TextEncoder().encode(name);
        const lfhOffset = this.offset;
        if (lfhOffset > U32_MAX) throw new Error("zip: archive exceeds 4 GiB (ZIP64 not supported)");

        const lfh = new Uint8Array(30);
        const dv = new DataView(lfh.buffer);
        dv.setUint32(0, 0x04034b50, true);
        dv.setUint16(4, 20, true);
        dv.setUint16(8, 0, true);              // method 0 = store
        dv.setUint32(18, totalSize, true);     // compressed size
        dv.setUint32(22, totalSize, true);     // uncompressed size
        dv.setUint16(26, nameBytes.length, true);
        this.write(lfh);
        this.write(nameBytes);

        let crc = 0xffffffff;
        let written = 0;
        produce((chunk) => {
            crc = crcUpdate(crc, chunk);
            this.write(chunk);
            written += chunk.length;
        });
        crc = (crc ^ 0xffffffff) >>> 0;
        if (written !== totalSize) throw new Error(`zip: "${name}" produced ${written} bytes, expected ${totalSize}`);

        // Patch CRC into the local file header now that we have it.
        const crcBuf = new Uint8Array(4);
        new DataView(crcBuf.buffer).setUint32(0, crc, true);
        writeSync(this.fd, crcBuf, 0, 4, lfhOffset + 14);

        this.entries.push({ nameBytes, crc, size: totalSize, offset: lfhOffset });
    }

    addBuffer(name: string, data: Uint8Array): void {
        this.addStreaming(name, data.length, (w) => w(data));
    }

    finish(): void {
        const cdOffset = this.offset;
        for (const e of this.entries) {
            const cdh = new Uint8Array(46);
            const dv = new DataView(cdh.buffer);
            dv.setUint32(0, 0x02014b50, true);
            dv.setUint16(4, 20, true);
            dv.setUint16(6, 20, true);
            dv.setUint32(16, e.crc, true);
            dv.setUint32(20, e.size, true);
            dv.setUint32(24, e.size, true);
            dv.setUint16(28, e.nameBytes.length, true);
            dv.setUint32(42, e.offset, true);
            this.write(cdh);
            this.write(e.nameBytes);
        }
        const cdSize = this.offset - cdOffset;
        const eocd = new Uint8Array(22);
        const dv = new DataView(eocd.buffer);
        dv.setUint32(0, 0x06054b50, true);
        dv.setUint16(8, this.entries.length, true);
        dv.setUint16(10, this.entries.length, true);
        dv.setUint32(12, cdSize, true);
        dv.setUint32(16, cdOffset, true);
        this.write(eocd);
        closeSync(this.fd);
    }
}

// ---------------------------------------------------------------------------
// ZIP member reader (for ISO/CUE packed inside a .zip archive)
// ---------------------------------------------------------------------------

interface ZipMember { name: string; method: number; compSize: number; size: number; dataOffset: number; }

/** Read an archive's central directory and locate its members (no extraction). */
function readZipMembers(archivePath: string): ZipMember[] {
    const fd = openSync(archivePath, "r");
    try {
        const fileSize = statSync(archivePath).size;
        const tailLen = Math.min(fileSize, 65557); // EOCD + max comment
        const tail = Buffer.allocUnsafe(tailLen);
        readSync(fd, tail, 0, tailLen, fileSize - tailLen);
        let eocd = -1;
        for (let i = tailLen - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error(`${basename(archivePath)}: not a zip (no EOCD)`);
        const count = tail.readUInt16LE(eocd + 10);
        const cdSize = tail.readUInt32LE(eocd + 12);
        const cdOffset = tail.readUInt32LE(eocd + 16);
        const cd = Buffer.allocUnsafe(cdSize);
        readSync(fd, cd, 0, cdSize, cdOffset);
        const members: ZipMember[] = [];
        let p = 0;
        for (let i = 0; i < count; i++) {
            if (cd.readUInt32LE(p) !== 0x02014b50) break;
            const method = cd.readUInt16LE(p + 10);
            const compSize = cd.readUInt32LE(p + 20);
            const size = cd.readUInt32LE(p + 24);
            const nameLen = cd.readUInt16LE(p + 28);
            const extraLen = cd.readUInt16LE(p + 30);
            const commentLen = cd.readUInt16LE(p + 32);
            const lfhOffset = cd.readUInt32LE(p + 42);
            const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
            // Resolve the data offset by reading the local file header's own var-length fields.
            const lfh = Buffer.allocUnsafe(30);
            readSync(fd, lfh, 0, 30, lfhOffset);
            const lfhNameLen = lfh.readUInt16LE(26);
            const lfhExtraLen = lfh.readUInt16LE(28);
            members.push({ name, method, compSize, size, dataOffset: lfhOffset + 30 + lfhNameLen + lfhExtraLen });
            p += 46 + nameLen + extraLen + commentLen;
        }
        return members;
    } finally {
        closeSync(fd);
    }
}

function readZipMemberBytes(archivePath: string, m: ZipMember): Uint8Array {
    const fd = openSync(archivePath, "r");
    try {
        const comp = Buffer.allocUnsafe(m.compSize);
        readSync(fd, comp, 0, m.compSize, m.dataOffset);
        if (m.method === 0) return comp;
        if (m.method === 8) return inflateRawSync(comp);
        throw new Error(`${m.name}: unsupported zip compression method ${m.method}`);
    } finally {
        closeSync(fd);
    }
}

// ---------------------------------------------------------------------------
// Resolve a CLI input to a mounted IsoImage
// ---------------------------------------------------------------------------

interface MountedDisc { image: IsoImage; files: IsoFileEntry[]; volumeName: string; volumeLabel: string; label: string; }

function mountIso(input: string): MountedDisc {
    const ext = extname(input).toLowerCase();

    if (ext === ".cue") {
        const sheet = parseCue(readFileSync(input, "utf8"));
        if (!sheet.dataTrack || !sheet.dataTrack.layout) {
            throw new Error(`${basename(input)}: no data track found in cue sheet`);
        }
        const binPath = join(dirname(input), sheet.dataTrack.file);
        if (!existsSync(binPath)) throw new Error(`${basename(input)}: referenced BIN not found: ${sheet.dataTrack.file}`);
        const src = new FileSource(binPath);
        const image = new IsoImage(src, sheet.dataTrack.layout, sheet.dataTrack.byteOffsetInFile);
        const fs = parseIso9660(image);
        return { image, files: fs.files, volumeName: fs.volumeName, volumeLabel: fs.volumeLabel, label: `${basename(input)} → ${sheet.dataTrack.file} [${sheet.dataTrack.layout.label}]` };
    }

    if (ext === ".zip") {
        return mountFromArchive(input);
    }

    // Plain .iso/.img/.bin — auto-detect framing.
    const src = new FileSource(input);
    const image = IsoImage.mount(src);
    const fs = parseIso9660(image);
    return { image, files: fs.files, volumeName: fs.volumeName, volumeLabel: fs.volumeLabel, label: `${basename(input)} [${image.layout.label}]` };
}

/** Find and mount an ISO (or CUE+BIN) packed inside a .zip archive. */
function mountFromArchive(archivePath: string): MountedDisc {
    const members = readZipMembers(archivePath);
    const byExt = (e: string) => members.filter((m) => m.name.toLowerCase().endsWith(e));

    const isoMember = byExt(".iso")[0] ?? byExt(".img")[0];
    if (isoMember) {
        // Stored (uncompressed) members can be mounted in place; deflated ones are inflated to RAM.
        if (isoMember.method === 0) {
            const src = new FileSource(archivePath, isoMember.dataOffset, isoMember.compSize);
            const image = IsoImage.mount(src);
            const fs = parseIso9660(image);
            return { image, files: fs.files, volumeName: fs.volumeName, volumeLabel: fs.volumeLabel, label: `${basename(archivePath)}:${isoMember.name} [${image.layout.label}, in-place]` };
        }
        const image = IsoImage.mount(new BufferSource(readZipMemberBytes(archivePath, isoMember)));
        const fs = parseIso9660(image);
        return { image, files: fs.files, volumeName: fs.volumeName, volumeLabel: fs.volumeLabel, label: `${basename(archivePath)}:${isoMember.name} [${image.layout.label}, inflated]` };
    }

    const cueMember = byExt(".cue")[0];
    if (cueMember) {
        const sheet = parseCue(new TextDecoder().decode(readZipMemberBytes(archivePath, cueMember)));
        if (!sheet.dataTrack?.layout) throw new Error(`${basename(archivePath)}: cue has no data track`);
        const binMember = members.find((m) => basename(m.name).toLowerCase() === sheet.dataTrack!.file.toLowerCase());
        if (!binMember) throw new Error(`${basename(archivePath)}: BIN ${sheet.dataTrack.file} not in archive`);
        const src = binMember.method === 0
            ? new FileSource(archivePath, binMember.dataOffset, binMember.compSize)
            : new BufferSource(readZipMemberBytes(archivePath, binMember));
        const image = new IsoImage(src, sheet.dataTrack.layout, sheet.dataTrack.byteOffsetInFile);
        const fs = parseIso9660(image);
        return { image, files: fs.files, volumeName: fs.volumeName, volumeLabel: fs.volumeLabel, label: `${basename(archivePath)}:${cueMember.name}+${sheet.dataTrack.file}` };
    }

    throw new Error(`${basename(archivePath)}: no .iso/.img or .cue member found in archive`);
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const OS_PRESETS: Record<string, { major: number; minor: number; build: number; platformId: number }> = {
    win95: { major: 4, minor: 0, build: 950, platformId: 1 },
    win98: { major: 4, minor: 10, build: 2222, platformId: 1 },
    winnt: { major: 4, minor: 0, build: 1381, platformId: 2 },
    win2k: { major: 5, minor: 0, build: 2195, platformId: 2 },
    winxp: { major: 5, minor: 1, build: 2600, platformId: 2 },
};

const IMAGE_EXTS = new Set([".iso", ".img", ".bin", ".cue", ".zip"]);

function parseArgs(argv: string[]) {
    const args = argv.slice(2);
    if (args.includes("--help") || args.length === 0) {
        const src = readFileSync(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "utf8");
        const m = src.match(/\/\*\*([\s\S]*?)\*\//);
        if (m) console.log(m[1]!.replace(/^ \* ?/gm, ""));
        process.exit(0);
    }
    const flagsWithValue = new Set([
        "--name", "--exe", "--args", "--width", "--height", "--bpp", "--ram", "--os",
        "--game-id", "--reg-hive", "--reg-path", "--reg-install", "--cd-path", "--cd-label",
    ]);
    const positionals: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a.startsWith("--")) { if (flagsWithValue.has(a)) i++; continue; }
        positionals.push(a);
    }
    const get = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : undefined; };
    const has = (f: string) => args.includes(f);

    if (positionals.length < (has("--list") ? 1 : 2)) {
        console.error("Usage: bun tools/iso-to-wgb.ts <image...> <output.wgb> [options]");
        process.exit(1);
    }
    let inputs: string[];
    let output: string | undefined;
    if (has("--list")) {
        inputs = positionals;
    } else {
        output = positionals[positionals.length - 1];
        inputs = positionals.slice(0, -1);
        // Tolerate the output being given before inputs by picking the lone .wgb.
        if (!output!.toLowerCase().endsWith(".wgb")) {
            const wgbIdx = positionals.findIndex((p) => p.toLowerCase().endsWith(".wgb"));
            if (wgbIdx >= 0) { output = positionals[wgbIdx]; inputs = positionals.filter((_, i) => i !== wgbIdx); }
        }
    }
    return { inputs, output, get, has };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { inputs, output, get, has } = parseArgs(process.argv);

for (const inp of inputs) {
    if (!existsSync(inp)) { console.error(`Error: input not found: ${inp}`); process.exit(1); }
    if (!IMAGE_EXTS.has(extname(inp).toLowerCase())) {
        console.error(`Error: unsupported input "${inp}" (expected .iso/.img/.bin/.cue/.zip)`);
        process.exit(1);
    }
}

const discDirs = has("--disc-dirs") && inputs.length > 1;

console.log(`\nMounting ${inputs.length} disc image(s)…`);
const discs: MountedDisc[] = [];
for (const inp of inputs) {
    const d = mountIso(inp);
    discs.push(d);
    console.log(`  • ${d.label} — ${d.files.length} files, "${d.volumeName}"`);
}

// Build the merged file list (path → {disc, entry}). First disc wins on collision.
interface PackItem { romPath: string; disc: MountedDisc; entry: IsoFileEntry; }
const packItems: PackItem[] = [];
const seen = new Set<string>();
let conflicts = 0;
discs.forEach((disc, di) => {
    const prefix = discDirs ? `disc${di + 1}/` : "";
    for (const entry of disc.files) {
        const romPath = prefix + entry.path;
        const key = romPath.toLowerCase();
        if (seen.has(key)) { conflicts++; continue; }
        seen.add(key);
        packItems.push({ romPath, disc, entry });
    }
});
if (conflicts > 0) console.log(`  (${conflicts} duplicate path(s) across discs collapsed; pass --disc-dirs to keep separate)`);

if (has("--list")) {
    for (const it of packItems) console.log(`  ${it.romPath}  (${it.entry.size} bytes)`);
    const totalBytes = packItems.reduce((s, it) => s + it.entry.size, 0);
    console.log(`\n${packItems.length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB total`);
    process.exit(0);
}

// ---------------------------------------------------------------------------
// Installer detection — a disc usually carries an installer, not a runnable tree.
// Mirrors the browser pipeline (wgb-build.ts) via the shared container-extract seam:
// detect an InstallShield cabinet / self-contained Inno setup.exe on the disc and, if
// found, extract its real game files. Otherwise keep streaming the raw disc filesystem.
// ---------------------------------------------------------------------------

/** Read a single disc entry fully into memory (to feed the installer extractor). */
function readPackItem(it: PackItem): Uint8Array {
    return it.disc.image.readExtent(it.entry.lba, it.entry.size);
}

const unpackWasmPath = join(import.meta.dir, "..", "public", "unpack-streaming.wasm");

async function extractInstallerFromDisc(): Promise<{ files: Map<string, Uint8Array>; via: string } | null> {
    const is = detectInstallShield(packItems.map((it) => it.romPath));

    // Materialize what the extractor needs: InstallShield .hdr/.cab volumes; FreeArc payload
    // archives (.pak/.arc/.bin carrying the "ArC\x01" magic — probed cheaply by 4 bytes before
    // loading the whole, possibly >1 GiB, file); every .exe (so the Inno scanner can probe it)
    // when there's no cabinet; plus any setup.ini.
    const installerFiles = new Map<string, Uint8Array>();
    let needWasm = false;
    for (const it of packItems) {
        const base = (it.romPath.split("/").pop() ?? it.romPath).toLowerCase();
        const isCab = is.stem != null && /\.(hdr|cab)$/i.test(base);
        const isExe = base.endsWith(".exe");
        const isIni = base === "setup.ini";
        let isArc = false;
        if (/\.(pak|arc|bin)$/i.test(base)) {
            const h = it.disc.image.readExtent(it.entry.lba, 4);
            isArc = h[0] === 0x41 && h[1] === 0x72 && h[2] === 0x43 && h[3] === 0x01; // "ArC\x01"
        }
        if (!(isCab || isArc || isIni || (isExe && !is.stem))) continue;
        if (isExe && it.entry.size > 256 * 1024 * 1024) continue; // too big to be an installer header
        installerFiles.set(it.romPath, readPackItem(it));
        if (isArc || (isExe && !is.stem)) needWasm = true; // Inno + FreeArc both use the LZMA WASM
    }
    if (installerFiles.size === 0) return null;

    let innoWasm: ArrayBuffer | undefined;
    if (needWasm && existsSync(unpackWasmPath)) {
        const b = readFileSync(unpackWasmPath);
        innoWasm = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    }

    const result = await extractInstallerFromFiles(installerFiles, {
        innoWasm,
        // Bun has no `DecompressionStream("deflate-raw")`, which the InstallShield
        // reader defaults to; feed it node/bun's zlib raw-inflate instead.
        inflateRaw: (chunk) => new Uint8Array(inflateRawSync(chunk)),
        // Some cabinets reference loose media files they don't pack (dataOffset=0) —
        // Max Payne's x_level{1,2,3}.ras sit loose in Disk1/Levels/ on the CD. Resolve
        // them straight off the disc by base name + expected size (read on demand, so
        // the streaming build never pre-loads them).
        resolveExternalFile: (name, size) => {
            const lc = name.toLowerCase();
            const hit = packItems.find(
                (p) => (p.romPath.split("/").pop() ?? p.romPath).toLowerCase() === lc && p.entry.size === size,
            );
            return hit ? readPackItem(hit) : null;
        },
        onProgress: (pct, label) => {
            if (process.stdout.isTTY) process.stdout.write(`\r  ${label}… ${pct}%        `);
        },
    });
    if (process.stdout.isTTY) process.stdout.write("\r" + " ".repeat(60) + "\r");
    if (result.via === "none" || result.gameFiles.size === 0) return null;
    return { files: result.gameFiles, via: result.via };
}

console.log("\nProbing disc for an installer…");
const installed = await extractInstallerFromDisc();
if (installed) console.log(`  → ${installed.via} installer: ${installed.files.size} game files extracted`);
else console.log("  → no recognized installer; packaging the disc filesystem as-is");

// A pack entry resolves either to in-memory bytes (extracted) or a streamed disc extent.
interface PackEntry { romPath: string; size: number; write: (writeChunk: (c: Uint8Array) => void) => void; }
const entries: PackEntry[] = installed
    ? [...installed.files].map(([rel, data]) => ({
        romPath: rel.replace(/\\/g, "/"),
        size: data.length,
        write: (w) => w(data),
    }))
    : packItems.map((it) => ({
        romPath: it.romPath,
        size: it.entry.size,
        write: (w) => it.disc.image.readExtentChunked(it.entry.lba, it.entry.size, w),
    }));

// --- manifest synthesis ---
const relPaths = entries.map((e) => e.romPath);
const exeName = get("--exe") ?? detectExeFromPaths(relPaths);
if (!exeName) { console.error("Error: no entrypoint .exe found; pass --exe <relative path>"); process.exit(1); }
const name = get("--name") ?? (discs[0]!.volumeName || basename(output!, ".wgb"));
const osKey = get("--os") ?? "win98";
const osVer = OS_PRESETS[osKey];
if (!osVer) { console.error(`Error: unknown --os "${osKey}" (valid: ${Object.keys(OS_PRESETS).join(", ")})`); process.exit(1); }

// A title that checks its disc reads D:'s label, so D: carries the label of the disc it is.
const cdPath = get("--cd-path");
const cdLabel = get("--cd-label")
    ?? (cdPath ? discLabelForCdPath(cdPath, discs.map((d) => d.volumeLabel), discDirs) : undefined);
if (cdPath) console.log(`  D: → ${cdPath}${cdLabel ? `, label "${cdLabel}"` : " (not a disc root: no label)"}`);

const entrypoint = `rom/${exeName.replace(/\\/g, "/")}`;
let gameId = get("--game-id");
if (gameId && !isValidGameId(gameId)) {
    console.error(`Error: invalid --game-id "${gameId}". Use "<scheme>:<id>" with scheme in {${KNOWN_GAME_ID_SCHEMES.join(", ")}}.`);
    process.exit(1);
}
if (!gameId) gameId = deriveGameId({ name, entrypoint });

const manifest: Record<string, unknown> = {
    formatVersion: 2,
    gameId,
    name,
    entrypoint,
    rom: "rom",
    registry: "registry.json",
    emulator: {
        osVersion: osVer,
        screenResolution: {
            width: parseInt(get("--width") ?? "640", 10),
            height: parseInt(get("--height") ?? "480", 10),
            bpp: parseInt(get("--bpp") ?? "16", 10),
        },
        memory: { ram: parseInt(get("--ram") ?? "64", 10) * 1024 * 1024 },
        ...(has("--skip-video") ? { skipVideo: true } : {}),
        ...(cdPath ? { cdPath } : {}),
        ...(cdLabel ? { cdLabel } : {}),
    },
};
const gameArgs = get("--args");
if (gameArgs) manifest.args = gameArgs;

const regPath = get("--reg-path");
const registry = regPath
    ? { root: get("--reg-hive") ?? "HKLM", path: regPath, values: [{ name: "InstallPath", type: "REG_SZ", data: get("--reg-install") ?? "C:\\" }] }
    : { root: "HKLM", path: "Software", values: [] };

// --- stream-pack ---
const outDir = dirname(output!);
if (outDir && outDir !== "." && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });

console.log(`\nPacking → ${output}`);
const totalBytes = entries.reduce((s, e) => s + e.size, 0);
const zip = new StreamingStoreZip(output!);
zip.addBuffer("manifest.json", new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
zip.addBuffer("registry.json", new TextEncoder().encode(JSON.stringify(registry, null, 2)));

let doneBytes = 0;
let lastPct = -1;
for (const e of entries) {
    zip.addStreaming(`rom/${e.romPath}`, e.size, (writeChunk) => {
        e.write((chunk) => {
            writeChunk(chunk);
            doneBytes += chunk.length;
            const pct = Math.floor((doneBytes / Math.max(1, totalBytes)) * 100);
            if (pct !== lastPct && process.stdout.isTTY) {
                lastPct = pct;
                process.stdout.write(`\r  ${pct}%  ${(doneBytes / 1024 / 1024).toFixed(0)}/${(totalBytes / 1024 / 1024).toFixed(0)} MB`);
            }
        });
    });
}
zip.finish();

const finalSize = statSync(output!).size;
console.log(`\n\nCreated ${output}`);
console.log(`  name:       ${name}`);
console.log(`  entrypoint: ${entrypoint}`);
console.log(`  gameId:     ${gameId}`);
console.log(`  source:     ${installed ? `${installed.via} installer` : "raw disc filesystem"}`);
console.log(`  files:      ${entries.length + 2}`);
console.log(`  size:       ${(finalSize / 1024 / 1024).toFixed(1)} MB`);
