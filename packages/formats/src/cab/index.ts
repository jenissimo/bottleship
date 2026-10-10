/**
 * Microsoft Cabinet (MSCF) reader — browser-safe core.
 *
 * Covers the cabinet variant used by InstallShield "PackageForTheWeb" (PFTW)
 * self-extractors (stub32i.exe / stub32z.exe): a single standard MS Cabinet
 * APPENDED to a small Win32 stub, holding the real InstallShield disk images
 * (data1.hdr + data{1,2,…}.cab + Setup.exe + setup.inx …). Unwrapping that
 * cabinet yields exactly the file map the InstallShield reader
 * (`../installshield`) then consumes — so a PFTW `.exe` chains
 * MSCF → InstallShield → game files.
 *
 * Compression support: NONE (0), MSZIP (1) and LZX (3). MSZIP is per-block:
 * each CFDATA block is `'CK'` + a raw-DEFLATE stream whose preset dictionary is
 * the previous block's last 32 KiB of output. That cross-block dictionary is why
 * decoding needs a dictionary-capable inflater (injected via `inflateBlock`; the
 * platform `DecompressionStream` alone cannot preset a dictionary). LZX is one
 * stream per folder (`./lzx.ts`), which is what Microsoft's own self-extracting
 * setups (IExpress, the Microsoft Games installer) emit. QUANTUM (2) is rejected.
 *
 * Layout reference (Microsoft `[MS-CAB]` / cabinet.h):
 *   CFHEADER  sig"MSCF" res1 u32, cbCabinet u32, res2 u32, coffFiles u32, res3 u32,
 *             verMinor u8, verMajor u8, cFolders u16, cFiles u16, flags u16,
 *             setID u16, iCabinet u16 [, cbCFHeader u16, cbCFFolder u8, cbCFData u8,
 *             abReserve …][, szCabinetPrev,szDiskPrev][, szCabinetNext,szDiskNext]
 *   CFFOLDER  coffCabStart u32, cCFData u16, typeCompress u16 [, abReserve …]
 *   CFFILE    cbFile u32, uoffFolderStart u32, iFolder u16, date u16, time u16,
 *             attribs u16, szName (NUL-terminated; UTF-8 when attrib 0x80 set)
 *   CFDATA    csum u32, cbData u16, cbUncomp u16 [, abReserve …], ab[cbData]
 */

import { decompressLzx, LZX_FRAME_SIZE } from "./lzx";

export { decompressLzx } from "./lzx";

const CAB_SIGNATURE = 0x4643534d; // "MSCF" little-endian

// CFHEADER.flags
const FLAG_PREV_CABINET = 0x0001;
const FLAG_NEXT_CABINET = 0x0002;
const FLAG_RESERVE_PRESENT = 0x0004;

// CFFOLDER.typeCompress (low nibble)
export const COMPRESS_NONE = 0;
export const COMPRESS_MSZIP = 1;
export const COMPRESS_QUANTUM = 2;
export const COMPRESS_LZX = 3;

const MSZIP_WINDOW = 32768;

export interface CabFolder {
    /** Absolute offset (from cab start) of this folder's first CFDATA block. */
    coffCabStart: number;
    /** Number of CFDATA blocks in this folder. */
    cCFData: number;
    /** Compression type (low nibble is the method; bits 8..12 are the LZX window exponent). */
    typeCompress: number;
}

export interface CabFile {
    /** File name (forward-slashed, leading separators stripped). */
    name: string;
    /** Index into CabInfo.folders. */
    folder: number;
    /** Byte offset of this file within its folder's decompressed stream. */
    offset: number;
    /** Uncompressed size in bytes. */
    size: number;
    attribs: number;
}

export interface CabInfo {
    /** Cabinet offset within the input buffer (0 for a bare .cab; >0 when appended to a stub). */
    cabOffset: number;
    /** Total cabinet size in bytes (CFHEADER.cbCabinet). */
    cbCabinet: number;
    folders: CabFolder[];
    files: CabFile[];
    /** Per-CFDATA reserved trailer size (0 unless the cabinet declares one). */
    dataReserve: number;
}

/** Inflater for one MSZIP block: raw DEFLATE with an optional 32 KiB preset dictionary. */
export type CabInflateBlock = (
    chunk: Uint8Array,
    dictionary: Uint8Array | undefined,
    expectedSize: number,
) => Promise<Uint8Array> | Uint8Array;

export interface CabExtractOptions {
    /** Required for MSZIP cabinets: a dictionary-capable raw-DEFLATE inflater. */
    inflateBlock?: CabInflateBlock;
    /** Called per extracted file (progress reporting). */
    onProgress?: (done: number, total: number, name: string) => void;
}

/**
 * Validate + parse a CFHEADER at `cabOff`. Returns null when the bytes at that
 * offset are not a self-consistent cabinet (used by `findCabinet` to reject the
 * stray "MSCF" byte sequences that occur inside a stub's own code/resources).
 */
export function parseCabHeader(buf: Uint8Array, cabOff = 0): CabInfo | null {
    if (cabOff + 36 > buf.length) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (dv.getUint32(cabOff, true) !== CAB_SIGNATURE) return null;

    const cbCabinet = dv.getUint32(cabOff + 8, true);
    const coffFiles = dv.getUint32(cabOff + 16, true);
    const verMajor = buf[cabOff + 25]!;
    const cFolders = dv.getUint16(cabOff + 26, true);
    const cFiles = dv.getUint16(cabOff + 28, true);
    const flags = dv.getUint16(cabOff + 30, true);

    // Plausibility: v1 cabinet that fits in the buffer with a sane folder/file table.
    if (verMajor !== 1) return null;
    if (cbCabinet < 36 || cabOff + cbCabinet > buf.length) return null;
    if (cFolders === 0 || cFolders > 0xffff) return null;
    if (cFiles === 0 || cFiles > 0xffff) return null;
    if (coffFiles < 36 || coffFiles >= cbCabinet) return null;

    let p = cabOff + 36;
    let dataReserve = 0;
    let folderReserve = 0;
    if (flags & FLAG_RESERVE_PRESENT) {
        const cbCFHeader = dv.getUint16(p, true);
        folderReserve = buf[p + 2]!;
        dataReserve = buf[p + 3]!;
        p += 4 + cbCFHeader;
    }
    const skipCString = () => { while (p < buf.length && buf[p] !== 0) p++; p++; };
    if (flags & FLAG_PREV_CABINET) { skipCString(); skipCString(); }
    if (flags & FLAG_NEXT_CABINET) { skipCString(); skipCString(); }

    const folders: CabFolder[] = [];
    for (let i = 0; i < cFolders; i++) {
        folders.push({
            coffCabStart: dv.getUint32(p, true),
            cCFData: dv.getUint16(p + 4, true),
            typeCompress: dv.getUint16(p + 6, true),
        });
        p += 8 + folderReserve;
    }

    const files: CabFile[] = [];
    let fp = cabOff + coffFiles;
    for (let i = 0; i < cFiles; i++) {
        if (fp + 16 > buf.length) return null;
        const size = dv.getUint32(fp, true);
        const offset = dv.getUint32(fp + 4, true);
        const iFolder = dv.getUint16(fp + 8, true);
        const attribs = dv.getUint16(fp + 14, true);
        fp += 16;
        let s = fp;
        while (s < buf.length && buf[s] !== 0) s++;
        const raw = buf.subarray(fp, s);
        // attrib 0x80 (_A_NAME_IS_UTF) → UTF-8, else code-page (treat as latin1).
        const name = new TextDecoder(attribs & 0x80 ? "utf-8" : "latin1").decode(raw);
        fp = s + 1;
        files.push({
            name: name.replace(/\\/g, "/").replace(/^\/+/, ""),
            folder: iFolder,
            offset,
            size,
            attribs,
        });
    }

    return { cabOffset: cabOff, cbCabinet, folders, files, dataReserve };
}

/**
 * Locate a cabinet in `buf` — a bare `.cab` (offset 0) or one APPENDED to a
 * Win32 stub (PackageForTheWeb). Scans for the "MSCF" signature and returns the
 * offset of the first byte sequence that parses as a self-consistent cabinet,
 * or null. The appended-cabinet case is unambiguous: `cabOffset + cbCabinet`
 * equals the file length, so a stray "MSCF" inside stub code (with a garbage
 * cbCabinet that overruns the buffer) is rejected by `parseCabHeader`.
 */
export function findCabinet(buf: Uint8Array): number | null {
    if (parseCabHeader(buf, 0)) return 0;
    for (let i = 1; i + 4 <= buf.length; i++) {
        if (buf[i] === 0x4d && buf[i + 1] === 0x53 && buf[i + 2] === 0x43 && buf[i + 3] === 0x46) {
            if (parseCabHeader(buf, i)) return i;
        }
    }
    return null;
}

/**
 * LZX folder: the CFDATA payloads are one continuous stream, each block one
 * 32 KiB frame of it (the folder's last block may be short).
 */
function decompressLzxFolder(buf: Uint8Array, info: CabInfo, folder: CabFolder): Uint8Array {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const blocks: Uint8Array[] = [];
    let compressed = 0;
    let uncompressed = 0;
    let dp = info.cabOffset + folder.coffCabStart;
    for (let b = 0; b < folder.cCFData; b++) {
        const cbData = dv.getUint16(dp + 4, true);
        const cbUncomp = dv.getUint16(dp + 6, true);
        const dataStart = dp + 8 + info.dataReserve;
        if (dataStart + cbData > buf.length) throw new Error("LZX cabinet folder is truncated");
        if (cbUncomp > LZX_FRAME_SIZE || (cbUncomp !== LZX_FRAME_SIZE && b !== folder.cCFData - 1)) {
            throw new Error(`LZX cabinet block ${b} holds ${cbUncomp} bytes, not one ${LZX_FRAME_SIZE}-byte frame`);
        }
        blocks.push(buf.subarray(dataStart, dataStart + cbData));
        compressed += cbData;
        uncompressed += cbUncomp;
        dp = dataStart + cbData;
    }
    const stream = new Uint8Array(compressed);
    let o = 0;
    for (const block of blocks) { stream.set(block, o); o += block.length; }
    return decompressLzx(stream, (folder.typeCompress >> 8) & 0x1f, uncompressed);
}

/** Decompress one folder's CFDATA chain into a single contiguous buffer. */
async function decompressFolder(
    buf: Uint8Array,
    info: CabInfo,
    folder: CabFolder,
    opts: CabExtractOptions,
): Promise<Uint8Array> {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const method = folder.typeCompress & 0x0f;
    if (method === COMPRESS_LZX) return decompressLzxFolder(buf, info, folder);
    if (method !== COMPRESS_NONE && method !== COMPRESS_MSZIP) {
        throw new Error(`unsupported cabinet compression type ${method} (only NONE/MSZIP/LZX)`);
    }
    if (method === COMPRESS_MSZIP && !opts.inflateBlock) {
        throw new Error("MSZIP cabinet needs a dictionary-capable inflater (opts.inflateBlock)");
    }

    const parts: Uint8Array[] = [];
    let dp = info.cabOffset + folder.coffCabStart;
    let dict: Uint8Array | undefined;
    for (let b = 0; b < folder.cCFData; b++) {
        const cbData = dv.getUint16(dp + 4, true);
        const cbUncomp = dv.getUint16(dp + 6, true);
        const dataStart = dp + 8 + info.dataReserve;
        const block = buf.subarray(dataStart, dataStart + cbData);
        dp = dataStart + cbData;

        if (method === COMPRESS_NONE) {
            parts.push(block.slice());
            continue;
        }
        // MSZIP: 'CK' magic, then raw DEFLATE against the previous block's tail.
        if (block[0] !== 0x43 || block[1] !== 0x4b) throw new Error("bad MSZIP block signature (expected 'CK')");
        const out = await opts.inflateBlock!(block.subarray(2), dict, cbUncomp);
        parts.push(out);
        dict = out.length > MSZIP_WINDOW ? out.subarray(out.length - MSZIP_WINDOW) : out;
    }

    let total = 0;
    for (const p of parts) total += p.length;
    const merged = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { merged.set(p, o); o += p.length; }
    return merged;
}

/**
 * Extract every file from a cabinet (bare `.cab` or one appended to a stub) into
 * a rel-path → bytes map. `bufOrOffset` locates the cabinet automatically when a
 * pre-parsed `CabInfo` isn't supplied.
 */
export async function extractCabToMap(
    buf: Uint8Array,
    opts: CabExtractOptions = {},
    info?: CabInfo,
): Promise<Map<string, Uint8Array>> {
    const cab = info ?? (() => {
        const off = findCabinet(buf);
        if (off == null) throw new Error("no Microsoft Cabinet (MSCF) found");
        return parseCabHeader(buf, off)!;
    })();

    // Decompress only the folders that actually back a file (usually just one).
    const folderCache = new Map<number, Uint8Array>();
    const out = new Map<string, Uint8Array>();
    for (let i = 0; i < cab.files.length; i++) {
        const f = cab.files[i]!;
        let fd = folderCache.get(f.folder);
        if (!fd) {
            fd = await decompressFolder(buf, cab, cab.folders[f.folder]!, opts);
            folderCache.set(f.folder, fd);
        }
        out.set(f.name, fd.subarray(f.offset, f.offset + f.size));
        opts.onProgress?.(i + 1, cab.files.length, f.name);
    }
    return out;
}
