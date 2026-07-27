/**
 * VS_VERSIONINFO reader for a raw PE image (on-disk bytes, not a mapped module).
 *
 * Needed when an HLE module stands in for a DLL the bundle still ships: the DLL's
 * version identifies the SDK release, and with it the ABI (struct layouts) the
 * game was compiled against. The mapped-module reader in kernel32/resource.ts
 * cannot help there — an HLE'd DLL is never mapped.
 */

const RT_VERSION = 16;

function align4(n: number): number {
    return (n + 3) & ~3;
}

/** Read a NUL-terminated UTF-16LE string; returns the text and the offset past the NUL. */
function readUtf16(buf: Uint8Array, view: DataView, off: number, end: number): { text: string; next: number } {
    let s = '';
    let p = off;
    while (p + 1 < end) {
        const c = view.getUint16(p, true);
        p += 2;
        if (c === 0) break;
        s += String.fromCharCode(c);
    }
    void buf;
    return { text: s, next: p };
}

interface VersionBlock {
    /** Total block length in bytes (header + key + value + children). */
    length: number;
    key: string;
    /** Offset of the block's value (may be zero-length). */
    valueOff: number;
    /** Value length in BYTES (wValueLength is in words for text blocks). */
    valueBytes: number;
    /** Offset of the first child block. */
    childrenOff: number;
}

/**
 * Parse one VS_VERSIONINFO-family block header:
 *   WORD wLength; WORD wValueLength; WORD wType; WCHAR szKey[]; padding; value; children
 * wValueLength counts WORDs when wType==1 (text) and BYTES when wType==0 (binary).
 */
function readVersionBlock(buf: Uint8Array, view: DataView, off: number, end: number): VersionBlock | null {
    if (off + 6 > end) return null;
    const length = view.getUint16(off, true);
    const valueLen = view.getUint16(off + 2, true);
    const type = view.getUint16(off + 4, true);
    if (length < 6 || off + length > end) return null;
    const { text: key, next } = readUtf16(buf, view, off + 6, off + length);
    const valueOff = align4(next);
    const valueBytes = type === 1 ? valueLen * 2 : valueLen;
    return { length, key, valueOff, valueBytes, childrenOff: align4(valueOff + valueBytes) };
}

function* versionChildren(buf: Uint8Array, view: DataView, parent: VersionBlock, parentOff: number): Generator<{ block: VersionBlock; off: number }> {
    const end = parentOff + parent.length;
    let p = parent.childrenOff;
    while (p < end) {
        const block = readVersionBlock(buf, view, p, end);
        if (!block) return;
        yield { block, off: p };
        p = align4(p + block.length);
    }
}

/** Map an RVA to a file offset using the PE section table. */
function rvaToFileOffset(view: DataView, peOff: number, rva: number): number | null {
    const numSections = view.getUint16(peOff + 6, true);
    const optSize = view.getUint16(peOff + 20, true);
    const secTable = peOff + 24 + optSize;
    for (let i = 0; i < numSections; i++) {
        const s = secTable + i * 40;
        const vaddr = view.getUint32(s + 12, true);
        const vsize = view.getUint32(s + 8, true);
        const rawSize = view.getUint32(s + 16, true);
        const rawPtr = view.getUint32(s + 20, true);
        const span = Math.max(vsize, rawSize);
        if (rva >= vaddr && rva < vaddr + span) {
            const delta = rva - vaddr;
            return delta < rawSize ? rawPtr + delta : null;
        }
    }
    return null;
}

/** File offset + byte size of the first RT_VERSION resource, or null. */
function findVersionResource(buf: Uint8Array, view: DataView): { off: number; size: number } | null {
    if (buf.length < 0x40 || view.getUint16(0, true) !== 0x5a4d) return null;
    const peOff = view.getUint32(0x3c, true);
    if (peOff + 24 > buf.length || view.getUint32(peOff, true) !== 0x00004550) return null;

    const magic = view.getUint16(peOff + 24, true);
    const dirOff = peOff + 24 + (magic === 0x20b ? 112 : 96);
    const resRva = view.getUint32(dirOff + 2 * 8, true);
    if (!resRva) return null;
    const resBase = rvaToFileOffset(view, peOff, resRva);
    if (resBase === null) return null;

    // Three levels: type -> name -> language. Take RT_VERSION, then the first entry at
    // each remaining level (a PE carries at most one version block in practice).
    const firstEntry = (dirOff2: number, wantId: number | null): number | null => {
        if (dirOff2 + 16 > buf.length) return null;
        const named = view.getUint16(dirOff2 + 12, true);
        const ids = view.getUint16(dirOff2 + 14, true);
        for (let i = 0; i < named + ids; i++) {
            const e = dirOff2 + 16 + i * 8;
            if (e + 8 > buf.length) return null;
            const nameOrId = view.getUint32(e, true);
            if (wantId !== null && ((nameOrId & 0x80000000) !== 0 || nameOrId !== wantId)) continue;
            return view.getUint32(e + 4, true);
        }
        return null;
    };

    const typeEntry = firstEntry(resBase, RT_VERSION);
    if (typeEntry === null || (typeEntry & 0x80000000) === 0) return null;
    const nameEntry = firstEntry(resBase + (typeEntry & 0x7fffffff), null);
    if (nameEntry === null || (nameEntry & 0x80000000) === 0) return null;
    const langEntry = firstEntry(resBase + (nameEntry & 0x7fffffff), null);
    if (langEntry === null || (langEntry & 0x80000000) !== 0) return null;

    const dataEntry = resBase + langEntry;
    if (dataEntry + 8 > buf.length) return null;
    const dataRva = view.getUint32(dataEntry, true);
    const size = view.getUint32(dataEntry + 4, true);
    const off = rvaToFileOffset(view, peOff, dataRva);
    if (off === null || off + size > buf.length) return null;
    return { off, size };
}

/**
 * Read one StringFileInfo value (e.g. "FileVersion", "ProductVersion") from a raw
 * PE image. Returns null when the image has no version resource or no such key.
 */
export function readPeVersionString(image: Uint8Array, key: string): string | null {
    let res: { off: number; size: number } | null;
    try {
        const probe = new DataView(image.buffer, image.byteOffset, image.byteLength);
        res = findVersionResource(image, probe);
    } catch {
        return null;
    }
    if (!res) return null;

    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    const end = res.off + res.size;
    const root = readVersionBlock(image, view, res.off, end);
    if (!root) return null;

    for (const { block: sfi, off: sfiOff } of versionChildren(image, view, root, res.off)) {
        if (sfi.key !== 'StringFileInfo') continue;
        for (const { block: table, off: tableOff } of versionChildren(image, view, sfi, sfiOff)) {
            for (const { block: entry } of versionChildren(image, view, table, tableOff)) {
                if (entry.key !== key) continue;
                const { text } = readUtf16(image, view, entry.valueOff, entry.valueOff + entry.valueBytes);
                return text;
            }
        }
    }
    return null;
}
