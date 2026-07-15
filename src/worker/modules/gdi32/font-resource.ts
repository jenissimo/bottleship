/**
 * AddFontResource/RemoveFontResource — install guest font files (TTF/OTF/TTC)
 * into the worker's FontFaceSet so canvas text rendering resolves the game's
 * own faces. The family name is read from the sfnt 'name' table (that is what
 * GDI matches lfFaceName against), so a later CreateFont("SeaWolf") finds the
 * FontFace registered here.
 */
import { Logger, LogCategory } from "../../core/logger";

const SFNT_TTCF = 0x74746366; // 'ttcf'
const SFNT_V1 = 0x00010000;
const SFNT_OTTO = 0x4f54544f; // 'OTTO'
const SFNT_TRUE = 0x74727565; // 'true'
const TAG_NAME = 0x6e616d65;  // 'name'
const NAME_ID_FAMILY = 1;

/** Extract the font family name (name ID 1) from a TTF/OTF/TTC blob; null if not sfnt. */
export function parseSfntFamilyName(data: Uint8Array): string | null {
    if (data.byteLength < 12) return null;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let base = 0;
    if (dv.getUint32(0) === SFNT_TTCF) {
        // Font collection: use the first subfont (FontFace gets the whole blob anyway).
        if (data.byteLength < 16 || dv.getUint32(8) < 1) return null;
        base = dv.getUint32(12);
        if (base + 12 > data.byteLength) return null;
    }
    const ver = dv.getUint32(base);
    if (ver !== SFNT_V1 && ver !== SFNT_OTTO && ver !== SFNT_TRUE) return null;

    const numTables = dv.getUint16(base + 4);
    let nameOff = 0;
    for (let i = 0; i < numTables; i++) {
        const rec = base + 12 + i * 16;
        if (rec + 16 > data.byteLength) return null;
        if (dv.getUint32(rec) === TAG_NAME) {
            nameOff = dv.getUint32(rec + 8);
            break;
        }
    }
    if (!nameOff || nameOff + 6 > data.byteLength) return null;

    const count = dv.getUint16(nameOff + 2);
    const strBase = nameOff + dv.getUint16(nameOff + 4);
    let best: string | null = null;
    let bestScore = -1;
    for (let i = 0; i < count; i++) {
        const r = nameOff + 6 + i * 12;
        if (r + 12 > data.byteLength) break;
        const platform = dv.getUint16(r);
        const encoding = dv.getUint16(r + 2);
        const language = dv.getUint16(r + 4);
        const nameId = dv.getUint16(r + 6);
        const len = dv.getUint16(r + 8);
        const off = strBase + dv.getUint16(r + 10);
        if (nameId !== NAME_ID_FAMILY || len === 0 || off + len > data.byteLength) continue;

        let s: string;
        if (platform === 3 || platform === 0) {
            // Windows / Unicode: UTF-16BE
            let out = '';
            for (let j = 0; j + 1 < len; j += 2) out += String.fromCharCode(dv.getUint16(off + j));
            s = out;
        } else if (platform === 1 && encoding === 0) {
            // Mac Roman (ASCII subset is what real fonts put here)
            let out = '';
            for (let j = 0; j < len; j++) out += String.fromCharCode(dv.getUint8(off + j));
            s = out;
        } else {
            continue;
        }
        s = s.trim();
        if (!s) continue;
        // Prefer the Windows-platform en-US record — that is the name GDI itself uses.
        const score = (platform === 3 ? 2 : 1) + (platform === 3 && language === 0x409 ? 1 : 0);
        if (score > bestScore) {
            best = s;
            bestScore = score;
        }
    }
    return best;
}

// resolved path (lowercased) -> installed FontFace, for RemoveFontResource.
const installedFonts = new Map<string, FontFace>();

/**
 * Register a guest font file with the worker's FontFaceSet. Returns the number
 * of fonts added (AddFontResource contract). Unsupported formats (.fon bitmap
 * fonts) still return 1 — the file exists and text falls back to bundled fonts,
 * matching the pre-existing lenient behavior so callers proceed.
 */
export async function addFontResource(resolvedPath: string, data: Uint8Array): Promise<number> {
    const key = resolvedPath.toLowerCase();
    if (installedFonts.has(key)) return 1;

    const family = parseSfntFamilyName(data);
    if (!family) {
        Logger.warn(LogCategory.GDI32,
            `AddFontResource: "${resolvedPath}" is not a TTF/OTF/TTC (bitmap .fon?) — using bundled fallback`);
        return 1;
    }

    // FontFace wants a plain ArrayBuffer; VFS data may view a SharedArrayBuffer.
    const buf = new ArrayBuffer(data.byteLength);
    new Uint8Array(buf).set(data);
    try {
        const face = new FontFace(family, buf);
        await face.load();
        (self as unknown as { fonts: FontFaceSet }).fonts.add(face);
        installedFonts.set(key, face);
        Logger.log(LogCategory.GDI32, `AddFontResource: installed '${family}' from "${resolvedPath}"`);
        return 1;
    } catch (e) {
        Logger.warn(LogCategory.GDI32, `AddFontResource: FontFace load failed for "${resolvedPath}": ${e}`);
        return 1;
    }
}

/** Uninstall a font previously added by addFontResource. Returns false when the
 *  path was never added (RemoveFontResource returns FALSE in that case). */
export function removeFontResource(resolvedPath: string): boolean {
    const key = resolvedPath.toLowerCase();
    const face = installedFonts.get(key);
    if (!face) return false;
    (self as unknown as { fonts: FontFaceSet }).fonts.delete(face);
    installedFonts.delete(key);
    return true;
}
