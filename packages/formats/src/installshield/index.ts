/**
 * InstallShield Cabinet (ISc) reader — browser-safe core.
 *
 * A self-contained TypeScript port of the file-reading core of `unshield`
 * (twogood/unshield) covering BOTH InstallShield version 5 AND version 6+
 * cabinets (signature "ISc(", major_version 5..13). Reads the <name>1.hdr
 * header + <name>{1,2,...}.cab data volumes, decompresses (per-chunk
 * raw-deflate), de-obfuscates, follows LINK_PREV dedup links (v6+), handles
 * volume-split files, and validates each file against its stored expanded
 * size and MD5 when present (early v5 descriptors omit the digest).
 *
 * No Node `fs`/`zlib`/`crypto`: operates on `Uint8Array` inputs, raw-inflate
 * via the platform `DecompressionStream("deflate-raw")` (Chromium — the wizard
 * is Chromium-gated), MD5 via the shared ts implementation.
 *
 * Reference (verbatim layouts the offsets below mirror):
 *   - lib/file.c `unshield_read_file_descriptor` (v5 `case 5` vs v6 `default`)
 *   - lib/file.c `unshield_reader_open_volume` (VOLUME_HEADER_SIZE_V5=40 vs V6=64)
 *   - lib/file.c `unshield_deobfuscate` (ror8(b ^ 0xd5, 2) - (seed % 0x47))
 *   - lib/libunshield.c `unshield_get_cab_descriptor` / `unshield_get_file_table`
 */

import { Md5 } from "../unpack/checksums";
import { asBufferSource } from "../dom-buffer";

// ---- flags (cabfile.h) ----
export const FILE_SPLIT = 1;
export const FILE_OBFUSCATED = 2;
export const FILE_COMPRESSED = 4;
export const FILE_INVALID = 8;
export const LINK_PREV = 1;

const CAB_SIGNATURE = 0x28635349; // "ISc("
const COMMON_HEADER_SIZE = 20;
const VOLUME_HEADER_SIZE_V5 = 40;
const VOLUME_HEADER_SIZE_V6 = 64;

// Component / file-group offset tables in the cab descriptor (cabfile.h):
//   file_group_offsets[71] @ cdOff+0x3e, component_offsets[71] @ cdOff+0x15a.
// Each table entry is the head of an OffsetList chain: {name_offset u32@0,
// descriptor_offset u32@4, next_offset u32@8} (all relative to cdOff).
const MAX_FILE_GROUP_COUNT = 71;
const MAX_COMPONENT_COUNT = 71;
const FILE_GROUP_OFFSETS_REL = 0x3e;
const COMPONENT_OFFSETS_REL = 0x15a;

/** A file group is a runtime/scaffolding group (not real game data) if named `<…>`. */
function isRuntimeFileGroup(name: string): boolean {
    return name.startsWith("<"); // <Support>…, <Engine>…, <Disk1>…
}

/**
 * Resolve a raw InstallShield destination string to a relative install dir:
 * strip a leading `<TARGETDIR>\` or `..\`, convert `\`→`/`, drop a leading slash.
 * `<TARGETDIR>` / `..` / "" → "" (root).
 */
export function resolveInstallDestination(dest: string): string {
    let s = dest;
    // strip leading <TARGETDIR> (with or without a following separator)
    if (s.startsWith("<TARGETDIR>")) s = s.slice("<TARGETDIR>".length);
    // strip any number of leading `..\` / `../` (parent-relative to install root)
    while (s.startsWith("..\\") || s.startsWith("../")) s = s.slice(3);
    if (s === "..") s = "";
    s = s.replace(/\\/g, "/");
    while (s.startsWith("/")) s = s.slice(1);
    while (s.endsWith("/")) s = s.slice(0, -1);
    return s;
}

export interface InstallShieldFile {
    index: number;
    name: string;
    dir: string;
    dirIndex: number;
    flags: number;
    expanded: number;
    compressed: number;
    dataOffset: number;
    md5: Uint8Array | null;
    volume: number;
    linkPrev: number;
    linkNext: number;
    linkFlags: number;
}

/**
 * A file-group descriptor: a named, contiguous `[firstFile, lastFile]` range of
 * file indices (mirrors unshield `read_file_group`). Game file groups are named
 * `Component_1`…`Component_N`; InstallShield's own runtime uses `<Support>…`,
 * `<Engine>…`, `<Disk1>…` groups.
 */
export interface InstallShieldFileGroup {
    name: string;
    firstFile: number;
    lastFile: number;
}

/**
 * A component descriptor with the bit upstream unshield ignores: its install
 * destination string (e.g. `<TARGETDIR>\System`, `..\Textures`). Each component
 * references one or more file groups; the union of those groups' file ranges all
 * install into `destination`.
 */
export interface InstallShieldComponent {
    name: string;
    /** Raw destination string as stored (`<TARGETDIR>\System`, `..\Textures`, …). */
    destination: string;
    fileGroupNames: string[];
}

export interface InstallShieldInfo {
    major: number;
    dirs: string[];
    files: InstallShieldFile[];
    /** Parsed file groups (may be empty for very old/odd headers). */
    fileGroups: InstallShieldFileGroup[];
    /** Parsed components carrying install destinations (may be empty). */
    components: InstallShieldComponent[];
    /**
     * file-index → resolved relative install dir (forward slashes, no leading
     * `<TARGETDIR>\`/`..\`; root → ""). Only contains entries the component→
     * destination mapping could resolve; absent indices fall back to the cabinet
     * `dir`. `null` value = file belongs to an InstallShield runtime group and
     * should be skipped.
     */
    installDirByIndex: Map<number, string | null>;
    /**
     * True when the cabinet's own per-file directory table carries NO layout for
     * the game files (every installed file sits in cabinet dir ""). Only then is
     * the component→destination overlay authoritative for placement; when the
     * cabinet DOES carry real directories (Max Payne: help\html, movies, e2driver,
     * …) the per-file `dir` is the faithful (unshield) install path and the
     * component destination is just an organizational label that must NOT relocate
     * a root file (e.g. `x_level1.ras`, cabinet dir "" but component "Levels").
     */
    cabinetIsFlat: boolean;
}

interface VolumeHeaderView {
    dataOffset: number;
    firstFileIndex: number;
    lastFileIndex: number;
    firstFileOffset: number;
    firstFileSizeExpanded: number;
    firstFileSizeCompressed: number;
    lastFileOffset: number;
    lastFileSizeExpanded: number;
    lastFileSizeCompressed: number;
}

export interface ExtractOptions {
    /** Verify each file against its stored expanded size (default true). */
    verifySize?: boolean;
    /** Verify each file against its stored MD5 if present (default true). */
    verifyMd5?: boolean;
    /** Called per extracted file (for progress reporting). */
    onProgress?: (done: number, total: number, name: string) => void;
    /**
     * Raw-deflate inflater override. Defaults to the platform
     * `DecompressionStream("deflate-raw")` (Chromium worker). Tests/Node may
     * inject a sync zlib-backed implementation.
     */
    inflateRaw?: (chunk: Uint8Array) => Promise<Uint8Array> | Uint8Array;
    /**
     * Resolve an EXTERNAL (loose-on-media) file the cabinet references but does not
     * pack. Such a file descriptor has `dataOffset === 0` and no cab data — the real
     * installer copies its bytes verbatim from a loose file on the media (Max Payne's
     * x_level{1,2,3}.ras live in Disk1/Levels/ on the CD, not inside data2.cab). The
     * caller owns the container, so it supplies the bytes here (by base name / size).
     * Return null when it can't be found → the file is skipped (prior silent behavior).
     */
    resolveExternal?: (
        fd: InstallShieldFile,
        outPath: string,
    ) => Promise<Uint8Array | null> | Uint8Array | null;
}

/** True when a 16-byte MD5 field is all-zero (i.e. "no checksum stored"). */
function isZeroMd5(md5: Uint8Array): boolean {
    for (let i = 0; i < md5.length; i++) if (md5[i] !== 0) return false;
    return true;
}

/** Little-endian readers over a Uint8Array (DataView-backed). */
function reader(buf: Uint8Array) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return {
        u8: (o: number) => buf[o]!,
        u16: (o: number) => dv.getUint16(o, true),
        u32: (o: number) => dv.getUint32(o, true),
        u64: (o: number) => Number(dv.getBigUint64(o, true)),
        cstr: (o: number) => {
            let j = o;
            while (j < buf.length && buf[j] !== 0) j++;
            // latin1: every byte maps 1:1 to a code unit
            let s = "";
            for (let k = o; k < j; k++) s += String.fromCharCode(buf[k]!);
            return s;
        },
    };
}

/** Decode the major version from the common-header version dword. */
function decodeMajor(versionRaw: number): number {
    if (versionRaw >>> 24 === 1) return (versionRaw >>> 12) & 0xf;
    if (versionRaw >>> 24 === 2 || versionRaw >>> 24 === 4) {
        let m = versionRaw & 0xffff;
        if (m) m = Math.floor(m / 100);
        return m;
    }
    return 0;
}

/**
 * Parse the header (`.hdr`) bytes into the directory + file tables.
 * Mirrors unshield_get_cab_descriptor / unshield_get_file_table /
 * unshield_read_file_descriptor.
 */
export function parseInstallShieldHeader(hdr: Uint8Array): InstallShieldInfo {
    const r = reader(hdr);
    if (r.u32(0) !== CAB_SIGNATURE) throw new Error("Not an ISc cabinet (bad signature)");

    const major = decodeMajor(r.u32(4));
    if (major !== 0 && major !== 5 && major < 6) throw new Error(`Unsupported cabinet version ${major}`);
    const cdOff = r.u32(12);
    if (!cdOff) throw new Error("No CAB descriptor available");

    // ---- cabinet descriptor (offsets identical for v5/v6) ----
    // p = cdOff; p += 0xc; file_table_offset@+0xc; (skip4); file_table_size@+0x14;
    // file_table_size2@+0x18; directory_count@+0x1c; (skip8); file_count@+0x28;
    // file_table_offset2@+0x2c.
    const fileTableOffset = r.u32(cdOff + 0x0c);
    const directoryCount = r.u32(cdOff + 0x1c);
    const fileCount = r.u32(cdOff + 0x28);
    const fileTableOffset2 = r.u32(cdOff + 0x2c);
    const base = cdOff + fileTableOffset;

    // ---- file_table: (directory_count + file_count) u32 entries at `base` ----
    // First `directory_count` = directory name offsets (relative to `base`).
    // For v5, the next `file_count` entries are per-file descriptor offsets.
    const tableCount = directoryCount + fileCount;
    const fileTable = new Uint32Array(tableCount);
    for (let i = 0; i < tableCount; i++) fileTable[i] = r.u32(base + i * 4);

    const dirs: string[] = [];
    for (let d = 0; d < directoryCount; d++) dirs.push(r.cstr(base + fileTable[d]!));

    const files: InstallShieldFile[] = [];
    // Early IS5 stores 0x2a-byte descriptors, later IS5 appends a 16-byte digest.
    // Bound each record by the next descriptor/string, so a missing digest cannot
    // consume the following file's metadata as a checksum (lib/file.c case 0/5).
    const recordBoundaries = [...fileTable];
    if (major <= 5) {
        for (let i = 0; i < fileCount; i++) recordBoundaries.push(r.u32(base + fileTable[directoryCount + i]!));
    }
    recordBoundaries.sort((a, b) => a - b);
    for (let i = 0; i < fileCount; i++) {
        let fd: InstallShieldFile;
        if (major <= 5) {
            // unshield_read_file_descriptor case 5:
            //   p = base + file_table[directory_count + index]
            //   name_offset u32@0; dir_index u16@4; skip2; flags u16@8;
            //   expanded u32@0xa; compressed u32@0xe; skip 0x14; data_offset u32@0x26;
            //   md5[16]@0x2a (ends 0x3a). No volume/link fields.
            const p = base + fileTable[directoryCount + i]!;
            const flags = r.u16(p + 0x08);
            const next = recordBoundaries.find(off => base + off > p) ?? (hdr.length - base);
            const md5 = major === 5 && !(flags & FILE_INVALID) && base + next >= p + 0x3a
                ? hdr.subarray(p + 0x2a, p + 0x3a) : null;
            fd = {
                index: i,
                name: r.cstr(base + r.u32(p + 0x00)),
                dirIndex: r.u16(p + 0x04),
                flags,
                expanded: r.u32(p + 0x0a),
                compressed: r.u32(p + 0x0e),
                dataOffset: r.u32(p + 0x26),
                md5: md5 && md5.length === 16 ? md5 : null,
                volume: 1, // v5: file always in the header's own volume (index 1)
                linkPrev: 0,
                linkNext: 0,
                linkFlags: 0,
                dir: "",
            };
        } else {
            // unshield_read_file_descriptor default (v6+): fixed 0x57 stride
            //   p = base + file_table_offset2 + index*0x57
            //   flags u16@0; expanded u64@2; compressed u64@0xa; data_offset u64@0x12;
            //   md5[16]@0x1a; skip 0x10; name_offset u32@0x3a; dir_index u16@0x3e;
            //   (==0x40) skip 0xc; link_prev u32@0x4c; link_next u32@0x50;
            //   link_flags u8@0x54; volume u16@0x55 (==0x57).
            const p = base + fileTableOffset2 + i * 0x57;
            fd = {
                index: i,
                flags: r.u16(p + 0x00),
                expanded: r.u64(p + 0x02),
                compressed: r.u64(p + 0x0a),
                dataOffset: r.u64(p + 0x12),
                md5: hdr.subarray(p + 0x1a, p + 0x2a),
                name: r.cstr(base + r.u32(p + 0x3a)),
                dirIndex: r.u16(p + 0x3e),
                linkPrev: r.u32(p + 0x4c),
                linkNext: r.u32(p + 0x50),
                linkFlags: r.u8(p + 0x54),
                volume: r.u16(p + 0x55),
                dir: "",
            };
        }
        fd.dir = dirs[fd.dirIndex] ?? `?${fd.dirIndex}`;
        files.push(fd);
    }

    // ---- components + file groups → file-index install-destination map ----
    // Upstream unshield reads both tables but ignores the component DESTINATION;
    // we need it to place files for "flat" installers (HP1 demo: every file in
    // cabinet dir "" but the game needs System/, Maps/, Textures/, …). Parsed
    // defensively: any absence/old-format quirk yields an empty map → callers
    // fall back to the cabinet `dir`. Never throws.
    const { fileGroups, components, installDirByIndex } = parseComponentLayout(
        r,
        hdr,
        cdOff,
        major,
        fileCount,
    );

    // The cabinet is "flat" only if NONE of the files it actually installs (i.e.
    // not the InstallShield runtime files the component map marks null) carries a
    // non-empty cabinet directory. A flat cabinet gives us no per-file layout, so
    // the component→destination overlay is the only placement signal; a structured
    // cabinet is authoritative and the overlay must not move its files.
    const cabinetIsFlat = files.every(
        (f) => installDirByIndex.get(f.index) === null || !f.dir,
    );

    return { major, dirs, files, fileGroups, components, installDirByIndex, cabinetIsFlat };
}

type Reader = ReturnType<typeof reader>;

/**
 * Parse the component + file-group tables and build a file-index → install-dir
 * map. Best-effort: returns empty structures on any malformed/old-format header
 * rather than throwing (the caller falls back to cabinet `dir`).
 *
 * Layout (offsets relative to `cdOff`, confirmed against real IS5 NFS-Porsche
 * and IS6 HP1-demo `data1.hdr`):
 *   - file_group_offsets[71] @ cdOff+0x3e, component_offsets[71] @ cdOff+0x15a.
 *   - OffsetList node: name_offset u32@0, descriptor_offset u32@4, next_offset u32@8.
 *   - FileGroup descriptor: name_offset u32@0; skip (v5: 0x48 / v6+: 0x12);
 *     first_file i32; last_file i32.
 *   - Component descriptor: name_offset u32@0; **destination string_offset u32@0x1c**
 *     (the field upstream skips); then skip to file_group_count u16
 *     (v5 @ +0x6e / v6+ @ +0x6f) and file_group_table_offset u32 right after.
 *     The file-group table is `count` u32 string-offsets naming the groups.
 */
function parseComponentLayout(
    r: Reader,
    hdr: Uint8Array,
    cdOff: number,
    major: number,
    fileCount: number,
): {
    fileGroups: InstallShieldFileGroup[];
    components: InstallShieldComponent[];
    installDirByIndex: Map<number, string | null>;
} {
    const fileGroups: InstallShieldFileGroup[] = [];
    const components: InstallShieldComponent[] = [];
    const installDirByIndex = new Map<number, string | null>();

    // string/buffer pointers in these tables are all relative to cdOff.
    const inBounds = (o: number) => o >= 0 && o < hdr.length;
    const str = (rel: number) => (inBounds(cdOff + rel) ? r.cstr(cdOff + rel) : "");

    try {
        // ---- file groups: name + [firstFile, lastFile] range ----
        const fgByName = new Map<string, InstallShieldFileGroup>();
        for (let i = 0; i < MAX_FILE_GROUP_COUNT; i++) {
            let next = r.u32(cdOff + FILE_GROUP_OFFSETS_REL + i * 4);
            // OffsetList chain; guard against cycles with a hop cap.
            for (let hops = 0; next && hops < 4096; hops++) {
                const nodeBase = cdOff + next;
                if (!inBounds(nodeBase + 8)) break;
                const descOff = r.u32(nodeBase + 4);
                const nextOff = r.u32(nodeBase + 8);
                const d = cdOff + descOff;
                if (inBounds(d)) {
                    const name = str(r.u32(d));
                    const skip = major <= 5 ? 0x48 : 0x12;
                    const first = (r.u32(d + 4 + skip) | 0);
                    const last = (r.u32(d + 4 + skip + 4) | 0);
                    const fg: InstallShieldFileGroup = { name, firstFile: first, lastFile: last };
                    fileGroups.push(fg);
                    if (name && !fgByName.has(name)) fgByName.set(name, fg);
                }
                next = nextOff;
            }
        }

        // ---- components: name + destination + referenced file-group names ----
        for (let i = 0; i < MAX_COMPONENT_COUNT; i++) {
            let next = r.u32(cdOff + COMPONENT_OFFSETS_REL + i * 4);
            for (let hops = 0; next && hops < 4096; hops++) {
                const nodeBase = cdOff + next;
                if (!inBounds(nodeBase + 8)) break;
                const descOff = r.u32(nodeBase + 4);
                const nextOff = r.u32(nodeBase + 8);
                const d = cdOff + descOff;
                if (inBounds(d + 0x71 + 4)) {
                    const name = str(r.u32(d));
                    const destination = str(r.u32(d + 0x1c));
                    // file_group_count / table are version-dependent (v5 skips 0x6c, v6+ 0x6b)
                    const fgCountOff = major <= 5 ? 0x6e : 0x6f;
                    const fgCount = r.u16(d + fgCountOff);
                    const fgTableOff = r.u32(d + fgCountOff + 2);
                    const fileGroupNames: string[] = [];
                    if (fgCount > 0 && fgCount <= MAX_FILE_GROUP_COUNT) {
                        const tBase = cdOff + fgTableOff;
                        for (let k = 0; k < fgCount; k++) {
                            if (!inBounds(tBase + k * 4 + 4)) break;
                            fileGroupNames.push(str(r.u32(tBase + k * 4)));
                        }
                    }
                    const comp: InstallShieldComponent = { name, destination, fileGroupNames };
                    components.push(comp);

                    // Resolve this component's destination for every file index it owns.
                    const resolved = resolveInstallDestination(destination);
                    for (const fgn of fileGroupNames) {
                        const fg = fgByName.get(fgn);
                        if (!fg) continue;
                        const lo = Math.max(0, fg.firstFile);
                        const hi = Math.min(fileCount - 1, fg.lastFile);
                        const runtime = isRuntimeFileGroup(fgn);
                        for (let idx = lo; idx <= hi; idx++) {
                            // First writer wins; runtime groups mark the file for skipping
                            // (value null) unless a real component already claimed it.
                            if (installDirByIndex.has(idx)) continue;
                            installDirByIndex.set(idx, runtime ? null : resolved);
                        }
                    }
                }
                next = nextOff;
            }
        }
    } catch {
        // Old/odd header format — abandon the component layout, fall back to dirs.
        return { fileGroups, components, installDirByIndex: new Map() };
    }

    return { fileGroups, components, installDirByIndex };
}

/** Read a v5 (40-byte) or v6 (64-byte) volume header from a `.cab` buffer. */
function readVolumeHeader(cab: Uint8Array, major: number): VolumeHeaderView {
    const r = reader(cab);
    const p = COMMON_HEADER_SIZE;
    if (major <= 5) {
        // VOLUME_HEADER_SIZE_V5 = 40 (no _high fields, one "unknown" dword @+4)
        const v: VolumeHeaderView = {
            dataOffset: r.u32(p + 0),
            firstFileIndex: r.u32(p + 8),
            lastFileIndex: r.u32(p + 12),
            firstFileOffset: r.u32(p + 16),
            firstFileSizeExpanded: r.u32(p + 20),
            firstFileSizeCompressed: r.u32(p + 24),
            lastFileOffset: r.u32(p + 28),
            lastFileSizeExpanded: r.u32(p + 32),
            lastFileSizeCompressed: r.u32(p + 36),
        };
        if (v.lastFileOffset === 0) v.lastFileOffset = 0x7fffffff;
        return v;
    }
    // VOLUME_HEADER_SIZE_V6 = 64 (interleaved low/high dwords; we take the low)
    return {
        dataOffset: r.u32(p + 0),
        firstFileIndex: r.u32(p + 8),
        lastFileIndex: r.u32(p + 12),
        firstFileOffset: r.u32(p + 16),
        firstFileSizeExpanded: r.u32(p + 24),
        firstFileSizeCompressed: r.u32(p + 32),
        lastFileOffset: r.u32(p + 40),
        lastFileSizeExpanded: r.u32(p + 48),
        lastFileSizeCompressed: r.u32(p + 56),
    };
}

/** unshield_deobfuscate: ror8(b ^ 0xd5, 2) - (seed % 0x47), seed advances per byte. */
function deobfuscate(buf: Uint8Array): void {
    let seed = 0;
    for (let i = 0; i < buf.length; i++, seed++) {
        const x = buf[i]! ^ 0xd5;
        const ror = ((x >>> 2) | (x << 6)) & 0xff;
        buf[i] = (ror - (seed % 0x47)) & 0xff;
    }
}

/** raw-inflate one chunk via the platform DecompressionStream("deflate-raw"). */
async function inflateRawPlatform(chunk: Uint8Array): Promise<Uint8Array> {
    if (typeof DecompressionStream === "undefined") {
        throw new Error("DecompressionStream unavailable — pass opts.inflateRaw");
    }
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    void writer.write(asBufferSource(chunk));
    void writer.close();
    const reader2 = ds.readable.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader2.read();
        if (done) break;
        if (value) {
            parts.push(value);
            total += value.length;
        }
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const part of parts) {
        out.set(part, o);
        o += part.length;
    }
    return out;
}

/**
 * Read `size` raw (possibly split across volumes, possibly de-obfuscated)
 * bytes for a file. `compressed` selects which volume-header size field to
 * follow for split continuation.
 */
function readRaw(
    fd: InstallShieldFile,
    size: number,
    compressed: boolean,
    volumes: Map<number, Uint8Array>,
    major: number,
): Uint8Array {
    const out = new Uint8Array(size);
    let written = 0;
    let vol = fd.volume;

    let pos: number;
    let volLeft: number;
    if (fd.flags & FILE_SPLIT) {
        const vh = readVolumeHeader(getVol(volumes, vol), major);
        pos = vh.lastFileOffset;
        volLeft = compressed ? vh.lastFileSizeCompressed : vh.lastFileSizeExpanded;
    } else {
        pos = fd.dataOffset;
        volLeft = size;
    }

    while (written < size) {
        const b = getVol(volumes, vol);
        const want = Math.min(size - written, volLeft);
        if (pos < 0 || pos + want > b.length) throw new Error(`Truncated cabinet volume ${vol} (${fd.name})`);
        out.set(b.subarray(pos, pos + want), written);
        written += want;
        pos += want;
        volLeft -= want;
        if (written >= size) break;
        vol++;
        const vh = readVolumeHeader(getVol(volumes, vol), major);
        pos = vh.firstFileOffset;
        volLeft = compressed ? vh.firstFileSizeCompressed : vh.firstFileSizeExpanded;
    }

    if (fd.flags & FILE_OBFUSCATED) deobfuscate(out);
    return out;
}

function getVol(volumes: Map<number, Uint8Array>, vol: number): Uint8Array {
    const b = volumes.get(vol);
    if (!b) throw new Error(`Missing cabinet volume ${vol}`);
    return b;
}

/** Extract a single file's bytes (following LINK_PREV for v6+). */
async function extractFile(
    fd: InstallShieldFile,
    files: InstallShieldFile[],
    volumes: Map<number, Uint8Array>,
    major: number,
    inflate: (c: Uint8Array) => Promise<Uint8Array> | Uint8Array,
): Promise<Uint8Array | null> {
    if ((fd.flags & FILE_INVALID) || fd.dataOffset === 0 || !fd.name) return null;
    if (fd.linkFlags & LINK_PREV) {
        const prev = files[fd.linkPrev];
        return prev ? extractFile(prev, files, volumes, major, inflate) : null;
    }

    if (!(fd.flags & FILE_COMPRESSED)) {
        return readRaw(fd, fd.expanded, false, volumes, major);
    }

    // compressed: stream of [u16 len][len bytes raw-deflate] chunks
    // (the default `unshield_file_save` path — applies to both v5 and v6).
    const raw = readRaw(fd, fd.compressed, true, volumes, major);
    const rv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const parts: Uint8Array[] = [];
    let off = 0;
    let produced = 0;
    while (produced < fd.expanded) {
        if (off + 2 > raw.length) throw new Error(`chunk header past end (${fd.name})`);
        const len = rv.getUint16(off, true);
        off += 2;
        if (len === 0) throw new Error(`zero chunk len (${fd.name})`);
        if (off + len > raw.length) throw new Error(`chunk data past end (${fd.name})`);
        const chunk = raw.subarray(off, off + len);
        off += len;
        const dec = await inflate(chunk);
        parts.push(dec);
        produced += dec.length;
    }
    const out = new Uint8Array(produced);
    let o = 0;
    for (const part of parts) {
        out.set(part, o);
        o += part.length;
    }
    return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/** Build the relative path (`dir/name`) for a file descriptor. */
export function fileRelPath(fd: InstallShieldFile): string {
    return (fd.dir ? fd.dir + "/" : "") + fd.name;
}

/**
 * Resolve the install-relative output path for a file, preferring the
 * component→destination mapping over the cabinet `directory_index`.
 *
 * Returns `null` when the file belongs to an InstallShield runtime group
 * (`<Support>`/`<Engine>`/`<Disk1>` — isrt.dll, ikernel.exe, setup.inx, …) and
 * must be skipped.
 *
 * Policy: the component map only WINS for a FLAT cabinet — one whose per-file
 * directory table carries no layout for the game files (`info.cabinetIsFlat`).
 * That routes flat installers (HP1 demo — every file in cabinet dir "") into
 * System/, Maps/, Textures/, … from the component destinations, while installers
 * that DO carry real cabinet directories (NFS-Porsche — Drivers/, FEDATA/,
 * GameData/; Max Payne — help\html, movies, e2driver) keep their authoritative
 * cabinet layout untouched. Crucially this stops a component destination from
 * relocating a genuine ROOT file: Max Payne's x_level{1,2,3}.ras have cabinet dir
 * "" but belong to the "Levels" component — the game mounts its *.ras archives
 * from the install root, so pushing them into Levels/ leaves the level databases
 * (part0_level1.ldb, … live INSIDE x_level1.ras) unmounted → "Levelfile not found".
 */
export function resolveInstallPath(fd: InstallShieldFile, info: InstallShieldInfo): string | null {
    const mapped = info.installDirByIndex.get(fd.index);
    if (mapped === null) return null; // runtime/scaffolding file → skip
    if (mapped !== undefined && !fd.dir && info.cabinetIsFlat) {
        // flat cabinet (no per-file layout) + a component destination → place by destination.
        return mapped ? `${mapped}/${fd.name}` : fd.name;
    }
    // real cabinet directory present (or no component info) → cabinet layout.
    return fileRelPath(fd);
}

/**
 * Extract an InstallShield cabinet.
 *
 * @param volumes map of volume number → bytes. The header lives in the `.hdr`
 *   beside `<stem>1.cab`; pass the header bytes as `headerBytes` and the `.cab`
 *   volume(s) keyed by their volume number (1-based). Volume 1 is the primary
 *   `data1.cab`.
 * @returns map of relative path (`dir/name`, forward slashes) → file bytes.
 */
export async function extractInstallShield(
    headerBytes: Uint8Array,
    volumes: Map<number, Uint8Array>,
    opts: ExtractOptions = {},
): Promise<Map<string, Uint8Array>> {
    const verifySize = opts.verifySize ?? true;
    const verifyMd5 = opts.verifyMd5 ?? true;
    const inflate = opts.inflateRaw ?? inflateRawPlatform;
    const info = parseInstallShieldHeader(headerBytes);

    const result = new Map<string, Uint8Array>();
    // An install file is a candidate whether its bytes live in the cabinet
    // (dataOffset !== 0) OR loose on the media (dataOffset === 0, resolved via the
    // resolveExternal hook). Only FILE_INVALID / nameless / runtime files are excluded.
    const live = info.files.filter(
        (f) =>
            !(f.flags & FILE_INVALID) &&
            f.name &&
            resolveInstallPath(f, info) !== null,
    );
    let done = 0;
    for (const fd of info.files) {
        if ((fd.flags & FILE_INVALID) || !fd.name) continue;
        const outPath = resolveInstallPath(fd, info);
        if (outPath === null) continue; // InstallShield runtime file — not game data

        let data: Uint8Array | null;
        if (fd.dataOffset === 0 && !(fd.linkFlags & LINK_PREV)) {
            // External/loose media file — bytes are not in the cabinet; ask the caller.
            data = opts.resolveExternal ? await opts.resolveExternal(fd, outPath) : null;
        } else {
            data = await extractFile(fd, info.files, volumes, info.major, inflate);
        }
        if (!data) {
            // Unresolved external file (no resolveExternal hook, or not found on media):
            // still count it against the total so progress reaches 100% instead of
            // stalling below it — this file was a planned member of `live`.
            done++;
            opts.onProgress?.(done, live.length, outPath);
            continue;
        }
        if (verifySize && data.length !== fd.expanded) {
            throw new Error(
                `Size mismatch ${outPath}: got ${data.length} want ${fd.expanded}`,
            );
        }
        if (verifyMd5 && fd.md5 && !isZeroMd5(fd.md5)) {
            const h = new Md5();
            h.update(data);
            if (!bytesEqual(h.finalize(), fd.md5)) {
                throw new Error(`MD5 mismatch ${outPath}`);
            }
        }
        result.set(outPath, data);
        done++;
        opts.onProgress?.(done, live.length, outPath);
    }
    return result;
}

/**
 * InstallShield engine support cabinets that ship beside the real game data
 * cabinet. These hold the setup runtime (Corecomp.ini, Ctl3d32.dll, _isres.dll,
 * IsUninst.Exe, _isuser.dll, ...) — NOT the game. A multi-cabinet installer zip
 * (e.g. NFS Porsche: data1 + _sys1 + _user1) must extract `data`, never these,
 * or the wizard pulls 4 scaffolding files and picks IsUninst.Exe as the entry.
 */
const IS_ENGINE_STEMS = new Set(["_sys", "_user"]);

/**
 * Detect whether a set of files (by lowercased base name) looks like an
 * InstallShield 5/6 installer. Returns the header stem (e.g. "data") of the
 * GAME data cabinet if so.
 *
 * When several `<stem>1.hdr`/`<stem>1.cab` pairs are present, the InstallShield
 * engine support cabinets (`_sys`, `_user`, and any other underscore-prefixed
 * stem) are skipped in favor of the real game cabinet — preferring the canonical
 * `data` stem, then any non-underscore stem, and only falling back to an
 * underscore/engine stem if nothing else qualifies.
 */
export function detectInstallShieldStem(names: string[]): string | null {
    const lower = new Map<string, string>();
    for (const n of names) {
        const base = n.split(/[\\/]/).pop() ?? n;
        lower.set(base.toLowerCase(), base);
    }
    // Collect every <stem> that has BOTH <stem>1.hdr and <stem>1.cab.
    const stems: string[] = [];
    for (const [low] of lower) {
        const m = /^(.*)1\.hdr$/.exec(low);
        if (m && lower.has(`${m[1]}1.cab`)) stems.push(m[1]!);
    }
    if (stems.length === 0) return null;
    if (stems.length === 1) return stems[0]!;

    // Multiple cabinets: pick the game cabinet, never an engine/support one.
    const isEngine = (s: string) => IS_ENGINE_STEMS.has(s) || s.startsWith("_");
    return (
        stems.find((s) => s === "data") ??
        stems.find((s) => !isEngine(s)) ??
        stems[0]!
    );
}
