/**
 * ISO9660 volume + directory parsing (with Joliet support).
 *
 * Layout we rely on:
 *   - Volume descriptors live at consecutive logical sectors starting at LBA 16,
 *     each 2048 bytes, terminated by a type-255 descriptor.
 *       type 1  = Primary Volume Descriptor (PVD)      — 8-bit / d-characters names
 *       type 2  = Supplementary Volume Descriptor (SVD) — Joliet uses UCS-2 BE names
 *       type 255 = terminator
 *   - The root directory record sits at byte 156 within the (P/S)VD.
 *   - Directory records are a packed list within a directory's extent; a record
 *     length of 0 means "skip to the next logical sector".
 *
 * We prefer the Joliet tree when present (long/Unicode filenames), falling back
 * to the primary tree otherwise. Extraction yields forward-slash relative paths.
 */

import { IsoImage, LOGICAL_BLOCK_SIZE } from "./sector-source";

const VD_PRIMARY = 1;
const VD_SUPPLEMENTARY = 2;
const VD_TERMINATOR = 255;

const ROOT_DIR_RECORD_OFFSET = 156; // byte offset of root dir record inside a VD
const ESCAPE_SEQUENCES_OFFSET = 88; // SVD escape sequences (32 bytes)

const FLAG_DIRECTORY = 0x02;
const FLAG_MULTI_EXTENT = 0x80;

export interface IsoFileEntry {
    /** Forward-slash relative path, e.g. "res/sub/file.txt". */
    path: string;
    /** Logical block address of the file's extent. */
    lba: number;
    /** File size in bytes. */
    size: number;
}

export interface IsoFilesystem {
    volumeName: string;
    /** The drive label Windows reports for this disc — see readVolumeLabel. */
    volumeLabel: string;
    /** True when names came from a Joliet supplementary descriptor. */
    joliet: boolean;
    files: IsoFileEntry[];
}

interface DirRecord {
    lba: number;
    size: number;
    flags: number;
    name: string;
}

interface RootDescriptor {
    rootLba: number;
    rootSize: number;
    volumeName: string;
    joliet: boolean;
}

function readUint32LE(buf: Uint8Array, off: number): number {
    return (buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16) | (buf[off + 3]! << 24)) >>> 0;
}

/** Joliet escape sequences are "%/@", "%/C" or "%/E" (UCS-2 levels 1/2/3). */
function isJolietEscape(vd: Uint8Array): boolean {
    const e = vd.subarray(ESCAPE_SEQUENCES_OFFSET, ESCAPE_SEQUENCES_OFFSET + 3);
    return e[0] === 0x25 && e[1] === 0x2f && (e[2] === 0x40 || e[2] === 0x43 || e[2] === 0x45);
}

function decodeName(raw: Uint8Array, joliet: boolean): string {
    let name = joliet
        ? new TextDecoder("utf-16be").decode(raw)
        : new TextDecoder("latin1").decode(raw);
    // Strip the ISO9660 version suffix ";1".
    const semi = name.lastIndexOf(";");
    if (semi >= 0) name = name.slice(0, semi);
    // Some authoring tools leave a trailing dot on extension-less names.
    if (name.endsWith(".")) name = name.slice(0, -1);
    return name;
}

/**
 * The volume label a mounted disc reports, by the rules of Wine's mount manager
 * (dlls/mountmgr.sys/device.c: VOLUME_FindCdRomDataBestVoldesc, VOLUME_GetSuperblockLabel):
 * of the descriptors in sectors 16..19 before the terminator, the one of highest type (the
 * first on a tie, so a supplementary beats the primary); 16 UCS-2 characters when it carries
 * a Joliet escape, else 32 single-byte ones; trailing spaces dropped, ending at the first NUL.
 */
export function readVolumeLabel(image: IsoImage): string {
    let best: Uint8Array | undefined;
    for (let i = 16; i <= 19; i++) {
        const vd = image.readBlock(i);
        if (vd.length < LOGICAL_BLOCK_SIZE || vd[0] === VD_TERMINATOR) break;
        if (vd[0]! > (best?.[0] ?? 0)) best = vd;
    }
    if (!best || best[1] !== 0x43 || best[2] !== 0x44 || best[3] !== 0x30 || best[4] !== 0x30 || best[5] !== 0x31) return "";
    const label = isJolietEscape(best)
        ? new TextDecoder("utf-16be").decode(best.subarray(40, 72))
        : new TextDecoder("latin1").decode(best.subarray(40, 72));
    return label.replace(/ +$/, "").split("\0")[0]!;
}

/** Pick the volume descriptor we will read names from (Joliet preferred). */
function selectRootDescriptor(image: IsoImage): RootDescriptor {
    let primary: RootDescriptor | undefined;
    let joliet: RootDescriptor | undefined;

    for (let i = 0; i < 32; i++) {
        const vd = image.readBlock(16 + i);
        if (vd.length < LOGICAL_BLOCK_SIZE) break;
        const type = vd[0]!;
        // Magic "CD001" already validated by layout detection; guard anyway.
        if (vd[1] !== 0x43 || vd[2] !== 0x44 || vd[3] !== 0x30 || vd[4] !== 0x30 || vd[5] !== 0x31) break;
        if (type === VD_TERMINATOR) break;
        if (type !== VD_PRIMARY && type !== VD_SUPPLEMENTARY) continue;

        const root = vd.subarray(ROOT_DIR_RECORD_OFFSET, ROOT_DIR_RECORD_OFFSET + 34);
        const isJoliet = type === VD_SUPPLEMENTARY && isJolietEscape(vd);
        const volIdRaw = vd.subarray(40, 72);
        const volumeName = (isJoliet
            ? new TextDecoder("utf-16be").decode(volIdRaw)
            : new TextDecoder("latin1").decode(volIdRaw)).trim();
        const desc: RootDescriptor = {
            rootLba: readUint32LE(root, 2),
            rootSize: readUint32LE(root, 10),
            volumeName,
            joliet: isJoliet,
        };
        if (type === VD_PRIMARY) primary = desc;
        else if (isJoliet) joliet = desc;
    }

    const chosen = joliet ?? primary;
    if (!chosen) throw new Error("ISO9660: no primary or Joliet volume descriptor found");
    return chosen;
}

/** Parse a directory extent into its child records (skipping "." and ".."). */
function parseDirRecords(image: IsoImage, lba: number, size: number, joliet: boolean): DirRecord[] {
    const blocks = Math.ceil(size / LOGICAL_BLOCK_SIZE);
    const data = image.readBlocks(lba, blocks);
    const out: DirRecord[] = [];
    let p = 0;
    while (p < size) {
        const len = data[p]!;
        if (len === 0) {
            // Records never span a logical sector — advance to the next one.
            const next = (Math.floor(p / LOGICAL_BLOCK_SIZE) + 1) * LOGICAL_BLOCK_SIZE;
            if (next <= p) break;
            p = next;
            continue;
        }
        const rec = data.subarray(p, p + len);
        const extLba = readUint32LE(rec, 2);
        const extSize = readUint32LE(rec, 10);
        const flags = rec[25]!;
        const nameLen = rec[32]!;
        const nameRaw = rec.subarray(33, 33 + nameLen);

        // Special entries: "." (0x00) and ".." (0x01) — single byte identifiers.
        const isSpecial = nameLen === 1 && (nameRaw[0] === 0x00 || nameRaw[0] === 0x01);
        if (!isSpecial) {
            out.push({ lba: extLba, size: extSize, flags, name: decodeName(nameRaw, joliet) });
        }
        p += len;
    }
    return out;
}

/**
 * Mount and walk an ISO9660 image, returning every file with its extent.
 * Directories are traversed depth-first; multi-extent files are not split
 * (rare on game discs — flagged via a thrown error if encountered).
 */
export function parseIso9660(image: IsoImage): IsoFilesystem {
    const root = selectRootDescriptor(image);
    const files: IsoFileEntry[] = [];

    const visit = (lba: number, size: number, prefix: string, depth: number): void => {
        if (depth > 64) throw new Error("ISO9660: directory nesting too deep (cyclic image?)");
        for (const rec of parseDirRecords(image, lba, size, root.joliet)) {
            const childPath = prefix ? `${prefix}/${rec.name}` : rec.name;
            if (rec.flags & FLAG_DIRECTORY) {
                visit(rec.lba, rec.size, childPath, depth + 1);
            } else {
                if (rec.flags & FLAG_MULTI_EXTENT) {
                    throw new Error(`ISO9660: multi-extent file not supported: ${childPath}`);
                }
                files.push({ path: childPath, lba: rec.lba, size: rec.size });
            }
        }
    };

    visit(root.rootLba, root.rootSize, "", 0);
    return { volumeName: root.volumeName, volumeLabel: readVolumeLabel(image), joliet: root.joliet, files };
}

/**
 * Convenience: parse an image and read every file into memory as a path → bytes
 * map. For large discs prefer streaming each entry via `IsoImage.readExtentChunked`.
 */
export function extractIsoToMap(image: IsoImage): Map<string, Uint8Array> {
    const fs = parseIso9660(image);
    const out = new Map<string, Uint8Array>();
    for (const f of fs.files) {
        out.set(f.path, image.readExtent(f.lba, f.size));
    }
    return out;
}
