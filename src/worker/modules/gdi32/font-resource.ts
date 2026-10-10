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

// The worker owns one guest process, so its FontFaceSet also scopes FR_PRIVATE fonts.
const installedFonts = new Map<string, { face: FontFace; family: string; references: Map<number, number> }>();
const pendingFonts = new Map<string, Promise<FontFace | null>>();

/**
 * Register a guest font file with the worker's FontFaceSet. Returns the number
 * of fonts added. Repeated registrations hold independent references keyed by their flags.
 */
export async function addFontResource(resolvedPath: string, data: Uint8Array, flags = 0): Promise<number> {
    if (flags & ~0x30) return 0;
    const key = resolvedPath.toLowerCase();
    let entry = installedFonts.get(key);
    if (!entry) {
        let pending = pendingFonts.get(key);
        if (!pending) {
            pending = loadFontResource(resolvedPath, data);
            pendingFonts.set(key, pending);
        }
        const face = await pending;
        pendingFonts.delete(key);
        if (!face) return 0;
        entry = installedFonts.get(key);
        if (!entry) {
            entry = { face, family: parseSfntFamilyName(data)!, references: new Map() };
            installedFonts.set(key, entry);
        }
    }
    entry.references.set(flags, (entry.references.get(flags) ?? 0) + 1);
    return 1;
}

/** FR_NOT_ENUM is scoped to each registration, independently of FR_PRIVATE. */
export function registeredFontFamilies(): string[] {
    return [...installedFonts.values()]
        .filter(entry => [...entry.references.keys()].some(flags => !(flags & 0x20)))
        .map(entry => entry.family);
}

async function loadFontResource(resolvedPath: string, data: Uint8Array): Promise<FontFace | null> {
    const family = parseSfntFamilyName(data);
    if (!family) {
        Logger.warn(LogCategory.GDI32,
            `AddFontResource: unsupported font resource "${resolvedPath}"`);
        return null;
    }

    // FontFace wants a plain ArrayBuffer; VFS data may view a SharedArrayBuffer.
    const buf = new ArrayBuffer(data.byteLength);
    new Uint8Array(buf).set(data);
    try {
        const face = new FontFace(family, buf);
        await face.load();
        (self as unknown as { fonts: FontFaceSet }).fonts.add(face);
        Logger.log(LogCategory.GDI32, `AddFontResource: installed '${family}' from "${resolvedPath}"`);
        return face;
    } catch (e) {
        Logger.warn(LogCategory.GDI32, `AddFontResource: FontFace load failed for "${resolvedPath}": ${e}`);
        return null;
    }
}

/** Uninstall a font previously added by addFontResource. Returns false when the
 *  path was never added (RemoveFontResource returns FALSE in that case). */
export function removeFontResource(resolvedPath: string, flags = 0): boolean {
    const key = resolvedPath.toLowerCase();
    const entry = installedFonts.get(key);
    const refs = entry?.references.get(flags) ?? 0;
    if (!entry || refs === 0) return false;
    if (refs > 1) entry.references.set(flags, refs - 1);
    else entry.references.delete(flags);
    if (entry.references.size > 0) return true;
    (self as unknown as { fonts: FontFaceSet }).fonts.delete(entry.face);
    installedFonts.delete(key);
    return true;
}
