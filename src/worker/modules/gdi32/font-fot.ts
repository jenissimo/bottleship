/**
 * .FOT font resource files: the 16-bit NE wrapper CreateScalableFontResource writes so a TrueType
 * file can be installed with AddFontResource. The FOT holds no glyphs — it names the TTF (a custom
 * resource carrying the path) and the face ("FONTRES:<face>" in the non-resident name table).
 */

const NE_RT_FONTDIR = 0x8007;
const NE_RT_PATH = 0x80cc;
const NE_SHIFT = 4;
const FONT_FILE = /\.(ttf|otf|ttc)$/i;
const MZ_STUB = "This is a TrueType font, not a program.";

const ascii = (bytes: Uint8Array): string => {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
};

export interface FotReference {
    /** The font file path as the FOT recorded it (possibly absolute on a drive that no longer exists). */
    fontPath: string;
    face: string | null;
}

function neHeaderOffset(data: Uint8Array, dv: DataView): number {
    if (data.byteLength < 0x40 || dv.getUint16(0, true) !== 0x5a4d) return 0;
    const ne = dv.getUint32(0x3c, true);
    if (ne + 0x40 > data.byteLength || dv.getUint16(ne, true) !== 0x454e) return 0;
    return ne;
}

/** The TTF a FOT points at, or null when `data` is not a FOT. */
export function parseFot(data: Uint8Array): FotReference | null {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const ne = neHeaderOffset(data, dv);
    if (!ne) return null;

    const rsrc = ne + dv.getUint16(ne + 0x24, true);
    const resNames = ne + dv.getUint16(ne + 0x26, true);
    if (rsrc + 2 > data.byteLength || resNames > data.byteLength) return null;

    let fontPath: string | null = null;
    const shift = dv.getUint16(rsrc, true);
    if (shift > 15 || resNames < rsrc + 2) return null;
    for (let p = rsrc + 2; p + 8 <= resNames;) {
        const type = dv.getUint16(p, true);
        if (type === 0) break;
        const count = dv.getUint16(p + 2, true);
        p += 8;
        for (let i = 0; i < count && p + 12 <= resNames; i++, p += 12) {
            if (type !== NE_RT_PATH) continue;
            const off = dv.getUint16(p, true) * 2 ** shift;
            const len = dv.getUint16(p + 2, true) * 2 ** shift;
            if (off + len > data.byteLength) continue;
            const raw = ascii(data.subarray(off, off + len));
            const nul = raw.indexOf("\0");
            const candidate = nul < 0 ? raw : raw.slice(0, nul);
            if (FONT_FILE.test(candidate)) fontPath = candidate;
        }
    }
    if (!fontPath) return null;

    let face: string | null = null;
    const nonResident = dv.getUint32(ne + 0x2c, true);
    const nonResidentLen = dv.getUint16(ne + 0x20, true);
    if (nonResident && nonResident + nonResidentLen <= data.byteLength) {
        for (let p = nonResident; p < nonResident + nonResidentLen;) {
            const n = data[p];
            if (!n) break;
            const name = ascii(data.subarray(p + 1, p + 1 + n)).replace(/\0+$/, "");
            if (name.startsWith("FONTRES:")) face = name.slice("FONTRES:".length);
            p += 1 + n + 2;
        }
    }
    return { fontPath, face };
}

const align = (n: number, to: number): number => Math.ceil(n / to) * to;

/**
 * A FOT referencing `fontPath`. Only what parseFot and the sfnt-driven font install consume is
 * populated: the FONTDIR resource is reserved but carries no metrics, because GDI takes the face
 * and metrics from the TTF at install time.
 */
export function buildFot(fontPath: string, face: string): Uint8Array {
    const enc = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
    const moduleName = enc(face.replace(/[^A-Za-z0-9_]/g, "").slice(0, 8) || "FONT");
    const nonResident = [...enc(`FONTRES:${face}`)];

    const NE = 0x80;
    const rsrcOff = 0x40;
    const resNamesOff = rsrcOff + 2 + 8 * 3 + 12 * 2;
    const resident = [moduleName.length, ...moduleName, 0, 0, 0, 0, 0];
    const nonResidentTable = [nonResident.length, ...nonResident, 0, 0, 0];
    const pathBytes = enc(fontPath);
    const dirLen = align(0x10, 1 << NE_SHIFT);
    const pathLen = align(pathBytes.length + 1, 1 << NE_SHIFT);

    const tablesEnd = NE + resNamesOff + resident.length;
    const nonResidentAt = align(tablesEnd, 2);
    const dirAt = align(nonResidentAt + nonResidentTable.length, 1 << NE_SHIFT);
    const pathAt = dirAt + dirLen;
    const out = new Uint8Array(pathAt + pathLen);
    const dv = new DataView(out.buffer);

    dv.setUint16(0, 0x5a4d, true);
    dv.setUint32(0x3c, NE, true);
    out.set(enc(`!${MZ_STUB}`), 0x40);

    dv.setUint16(NE, 0x454e, true);
    dv.setUint16(NE + 0x0c, 0x8000, true); // library module
    dv.setUint16(NE + 0x20, nonResidentTable.length, true);
    dv.setUint16(NE + 0x24, rsrcOff, true);
    dv.setUint16(NE + 0x26, resNamesOff, true);
    dv.setUint16(NE + 0x28, resNamesOff + resident.length, true); // module-reference table
    dv.setUint16(NE + 0x2a, resNamesOff + resident.length, true); // imported-names table
    dv.setUint32(NE + 0x2c, nonResidentAt, true);
    dv.setUint16(NE + 0x30, 0, true);
    dv.setUint16(NE + 0x32, NE_SHIFT, true);
    out[NE + 0x36] = 2; // Windows

    let p = NE + rsrcOff;
    dv.setUint16(p, NE_SHIFT, true);
    p += 2;
    const entry = (type: number, off: number, len: number, id: number): void => {
        dv.setUint16(p, type, true);
        dv.setUint16(p + 2, 1, true);
        p += 8;
        dv.setUint16(p, off >> NE_SHIFT, true);
        dv.setUint16(p + 2, len >> NE_SHIFT, true);
        dv.setUint16(p + 4, 0x0c50, true);
        dv.setUint16(p + 6, id, true);
        p += 12;
    };
    entry(NE_RT_FONTDIR, dirAt, dirLen, 0x8001);
    entry(NE_RT_PATH, pathAt, pathLen, 0x8002);
    dv.setUint16(p, 0, true);

    out.set(resident, NE + resNamesOff);
    out.set(nonResidentTable, nonResidentAt);
    out.set(pathBytes, pathAt);
    return out;
}
