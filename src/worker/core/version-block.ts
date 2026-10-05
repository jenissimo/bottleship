/**
 * VS_VERSIONINFO block model — build one, and answer VerQueryValue against one.
 *
 * A version block is a self-describing tree of {wLength, wValueLength, wType, szKey,
 * value, children} nodes, and VerQueryValue is nothing but a path walk over it. Keeping
 * that walk generic is what lets a guest query any sub-block we did not anticipate: the
 * block we hand it either came verbatim out of a PE's RT_VERSION resource or was built
 * here, and either way one walker serves both.
 *
 * Blocks come in two widths. A resource (and GetFileVersionInfoW) carries UTF-16 keys and
 * string values; GetFileVersionInfoA hands back the same tree with 1-byte characters. The
 * width is recoverable from the block itself — the second byte of the root key is NUL only
 * in the wide form — so the walker never needs to be told which it is.
 */

const VS_FFI_SIGNATURE = 0xfeef04bd;
export const VS_FIXEDFILEINFO_SIZE = 52;

const align4 = (n: number): number => (n + 3) & ~3;

export interface FixedFileInfo {
    fileVersionMS: number;
    fileVersionLS: number;
    productVersionMS: number;
    productVersionLS: number;
    fileFlagsMask: number;
    fileFlags: number;
    fileOS: number;
    fileType: number;
    fileSubtype: number;
}

export interface VersionStringTable {
    /** 8 hex digits: LANGID then code page, e.g. "040904B0". */
    langCodePage: string;
    values: Array<[key: string, value: string]>;
}

export interface VersionInfo {
    fixed: FixedFileInfo;
    strings: VersionStringTable[];
    /** LANGID/code-page pairs advertised under VarFileInfo\Translation. */
    translations: Array<{ lang: number; codePage: number }>;
}

interface Node {
    key: string;
    /** 0 = binary value (wValueLength counts bytes), 1 = text (counts characters). */
    type: 0 | 1;
    value: Uint8Array | string;
    children: Node[];
}

function encodeText(s: string, charSize: number): Uint8Array {
    const out = new Uint8Array((s.length + 1) * charSize);
    if (charSize === 1) {
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
        return out;
    }
    const view = new DataView(out.buffer);
    for (let i = 0; i < s.length; i++) view.setUint16(i * 2, s.charCodeAt(i), true);
    return out;
}

function emitNode(node: Node, charSize: number): Uint8Array {
    const keyBytes = encodeText(node.key, charSize);
    const valueBytes = typeof node.value === "string" ? encodeText(node.value, charSize) : node.value;
    // wValueLength counts characters for text nodes and bytes for binary ones.
    const valueLen = node.type === 1 ? valueBytes.length / charSize : valueBytes.length;

    const valueOff = align4(6 + keyBytes.length);
    const childBufs = node.children.map((c) => emitNode(c, charSize));

    let total = align4(valueOff + valueBytes.length);
    const childOffsets: number[] = [];
    for (const cb of childBufs) {
        total = align4(total);
        childOffsets.push(total);
        total += cb.length;
    }
    // wLength excludes any padding that would follow the block, so an empty-value node
    // with no children ends at its value, not at the next 4-byte boundary.
    const length = childBufs.length > 0 ? total : valueOff + valueBytes.length;

    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint16(0, length, true);
    view.setUint16(2, valueLen, true);
    view.setUint16(4, node.type, true);
    out.set(keyBytes, 6);
    out.set(valueBytes, valueOff);
    for (let i = 0; i < childBufs.length; i++) out.set(childBufs[i], childOffsets[i]);
    return out;
}

function fixedFileInfoBytes(f: FixedFileInfo): Uint8Array {
    const out = new Uint8Array(VS_FIXEDFILEINFO_SIZE);
    const view = new DataView(out.buffer);
    view.setUint32(0, VS_FFI_SIGNATURE, true);
    view.setUint32(4, 0x00010000, true);           // dwStrucVersion 1.0
    view.setUint32(8, f.fileVersionMS >>> 0, true);
    view.setUint32(12, f.fileVersionLS >>> 0, true);
    view.setUint32(16, f.productVersionMS >>> 0, true);
    view.setUint32(20, f.productVersionLS >>> 0, true);
    view.setUint32(24, f.fileFlagsMask >>> 0, true);
    view.setUint32(28, f.fileFlags >>> 0, true);
    view.setUint32(32, f.fileOS >>> 0, true);
    view.setUint32(36, f.fileType >>> 0, true);
    view.setUint32(40, f.fileSubtype >>> 0, true);
    // dwFileDateMS/LS stay 0 — the field is unset in virtually every real resource.
    return out;
}

/** Serialize a VS_VERSIONINFO block; `wide` picks the UTF-16 form GetFileVersionInfoW returns. */
export function buildVersionBlock(info: VersionInfo, wide: boolean): Uint8Array {
    const charSize = wide ? 2 : 1;
    const children: Node[] = [];

    if (info.strings.length > 0) {
        children.push({
            key: "StringFileInfo",
            type: 1,
            value: "",
            children: info.strings.map((table) => ({
                key: table.langCodePage,
                type: 1 as const,
                value: "",
                children: table.values.map(([key, value]) => ({
                    key, type: 1 as const, value, children: [] as Node[],
                })),
            })),
        });
    }

    if (info.translations.length > 0) {
        const value = new Uint8Array(info.translations.length * 4);
        const view = new DataView(value.buffer);
        info.translations.forEach((t, i) => {
            view.setUint16(i * 4, t.lang, true);
            view.setUint16(i * 4 + 2, t.codePage, true);
        });
        children.push({
            key: "VarFileInfo",
            type: 1,
            value: "",
            children: [{ key: "Translation", type: 0, value, children: [] }],
        });
    }

    return emitNode({
        key: "VS_VERSION_INFO",
        type: 0,
        value: fixedFileInfoBytes(info.fixed),
        children,
    }, charSize);
}

/**
 * Character width of an existing block. The root key is always "VS_VERSION_INFO", so its
 * second byte is the NUL half of 'V' in the wide form and 'S' in the narrow one.
 */
export function versionBlockIsWide(bytes: Uint8Array, base = 0): boolean {
    return bytes.length > base + 8 && bytes[base + 7] === 0;
}

interface ParsedNode {
    length: number;
    key: string;
    type: number;
    /** Offset of the value, relative to the same base the block was read from. */
    valueOff: number;
    valueLen: number;   // as stored: characters for text, bytes for binary
    valueBytes: number;
    childrenOff: number;
}

function readNode(bytes: Uint8Array, view: DataView, off: number, end: number, charSize: number): ParsedNode | null {
    if (off + 6 > end) return null;
    const length = view.getUint16(off, true);
    const valueLen = view.getUint16(off + 2, true);
    const type = view.getUint16(off + 4, true);
    if (length < 6 || off + length > end) return null;

    let p = off + 6;
    let key = "";
    while (p + charSize <= off + length) {
        const c = charSize === 2 ? view.getUint16(p, true) : bytes[p];
        p += charSize;
        if (c === 0) break;
        key += String.fromCharCode(c);
    }
    const valueOff = align4(p);
    const valueBytes = type === 1 ? valueLen * charSize : valueLen;
    return { length, key, type, valueOff, valueLen, valueBytes, childrenOff: align4(valueOff + valueBytes) };
}

function* children(bytes: Uint8Array, view: DataView, parent: ParsedNode, parentOff: number, charSize: number): Generator<{ node: ParsedNode; off: number }> {
    const end = parentOff + parent.length;
    let p = parent.childrenOff;
    while (p + 6 <= end) {
        const node = readNode(bytes, view, p, end, charSize);
        if (!node) return;
        yield { node, off: p };
        p = align4(p + node.length);
    }
}

export interface VersionQueryResult {
    /** Offset of the value within the block — add the guest block address for lplpBuffer. */
    offset: number;
    /** What VerQueryValue reports in puLen: characters for a string, bytes for binary. */
    len: number;
    /** String values are converted by VerQueryValueA; binary values stay in the source block. */
    type: 0 | 1;
}

/**
 * VerQueryValue's path walk. `subBlock` is "\", "\VarFileInfo\Translation" or
 * "\StringFileInfo\<langcp>\<key>"; segment matching is case-insensitive, as in the real
 * implementation. `base` lets the caller point at a block sitting inside a larger buffer.
 */
export function queryVersionBlock(bytes: Uint8Array, subBlock: string, base = 0): VersionQueryResult | null {
    if (base + 6 > bytes.length) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const charSize = versionBlockIsWide(bytes, base) ? 2 : 1;
    const root = readNode(bytes, view, base, bytes.length, charSize);
    if (!root) return null;

    const segments = subBlock.split(/[\\/]/).filter((s) => s.length > 0);
    let node = root;
    let off = base;
    for (const segment of segments) {
        let found: { node: ParsedNode; off: number } | null = null;
        for (const child of children(bytes, view, node, off, charSize)) {
            if (child.node.key.toLowerCase() === segment.toLowerCase()) { found = child; break; }
        }
        if (!found) return null;
        node = found.node;
        off = found.off;
    }
    return { offset: node.valueOff, len: node.valueLen, type: node.type === 1 ? 1 : 0 };
}

function toNode(bytes: Uint8Array, view: DataView, parsed: ParsedNode, off: number, charSize: number): Node {
    let value: Uint8Array | string;
    if (parsed.type === 1) {
        let s = "";
        for (let i = 0; i + charSize <= parsed.valueBytes; i += charSize) {
            const p = parsed.valueOff + i;
            const c = charSize === 2 ? view.getUint16(p, true) : bytes[p];
            if (c === 0) break;
            s += String.fromCharCode(c);
        }
        value = s;
    } else {
        value = bytes.slice(parsed.valueOff, parsed.valueOff + parsed.valueBytes);
    }
    const kids: Node[] = [];
    for (const child of children(bytes, view, parsed, off, charSize)) {
        kids.push(toNode(bytes, view, child.node, child.off, charSize));
    }
    return { key: parsed.key, type: parsed.type === 1 ? 1 : 0, value, children: kids };
}

/**
 * Re-emit a block at the other character width, preserving every node. This is what makes
 * GetFileVersionInfoA's block genuinely narrow: a resource is always UTF-16, and an app
 * that queried it through the A entry point expects to read ANSI strings out of the result.
 */
export function transcodeVersionBlock(bytes: Uint8Array, wide: boolean): Uint8Array | null {
    const sourceWide = versionBlockIsWide(bytes);
    if (sourceWide === wide) return bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const root = readNode(bytes, view, 0, bytes.length, sourceWide ? 2 : 1);
    if (!root) return null;
    return emitNode(toNode(bytes, view, root, 0, sourceWide ? 2 : 1), wide ? 2 : 1);
}
