/**
 * AddFontResource/RemoveFontResource — install guest font files (TTF/OTF/TTC)
 * into the worker's FontFaceSet so canvas text rendering resolves the game's
 * own faces. The family and full names are read from the sfnt 'name' table (what
 * GDI matches lfFaceName against), so a later CreateFont("SeaWolf") finds the
 * FontFace registered here.
 */
import { Logger, LogCategory } from "../../core/logger";
import { invalidateTextExtentCache } from "./text-extent-cache";

const SFNT_TTCF = 0x74746366; // 'ttcf'
const SFNT_V1 = 0x00010000;
const SFNT_OTTO = 0x4f54544f; // 'OTTO'
const SFNT_TRUE = 0x74727565; // 'true'
const TAG_NAME = 0x6e616d65;  // 'name'
const TAG_OS2 = 0x4f532f32;   // 'OS/2'
const TAG_CMAP = 0x636d6170;  // 'cmap'
const NAME_ID_FAMILY = 1;
const NAME_ID_FULL = 4;

/** Offset of table `tag` in the (first) font of a TTF/OTF/TTC blob; 0 if absent or not sfnt. */
function sfntTable(data: Uint8Array, tag: number): number {
    if (data.byteLength < 12) return 0;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let base = 0;
    if (dv.getUint32(0) === SFNT_TTCF) {
        // Font collection: use the first subfont (FontFace gets the whole blob anyway).
        if (data.byteLength < 16 || dv.getUint32(8) < 1) return 0;
        base = dv.getUint32(12);
        if (base + 12 > data.byteLength) return 0;
    }
    const ver = dv.getUint32(base);
    if (ver !== SFNT_V1 && ver !== SFNT_OTTO && ver !== SFNT_TRUE) return 0;
    const numTables = dv.getUint16(base + 4);
    for (let i = 0; i < numTables; i++) {
        const rec = base + 12 + i * 16;
        if (rec + 16 > data.byteLength) return 0;
        if (dv.getUint32(rec) === tag) return dv.getUint32(rec + 8);
    }
    return 0;
}

/** One string of the sfnt 'name' table, preferring the Windows en-US record GDI uses. */
function parseSfntName(data: Uint8Array, nameId: number): string | null {
    const nameOff = sfntTable(data, TAG_NAME);
    if (!nameOff || nameOff + 6 > data.byteLength) return null;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

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
        const id = dv.getUint16(r + 6);
        const len = dv.getUint16(r + 8);
        const off = strBase + dv.getUint16(r + 10);
        if (id !== nameId || len === 0 || off + len > data.byteLength) continue;

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
        const score = (platform === 3 ? 2 : 1) + (platform === 3 && language === 0x409 ? 1 : 0);
        if (score > bestScore) {
            best = s;
            bestScore = score;
        }
    }
    return best;
}

export interface SfntFace {
    /** Name ID 1: what lfFaceName matches first. */
    family: string;
    /** Name ID 4 ("Andy Bold"): GDI matches a face name against it as well. */
    fullName: string | null;
    /** OS/2 usWeightClass, 400 when the table is absent. */
    weight: number;
    italic: boolean;
}

/** The names and style GDI selects a font file by. */
export function parseSfntFace(data: Uint8Array): SfntFace | null {
    const family = parseSfntName(data, NAME_ID_FAMILY);
    if (!family) return null;
    const os2 = sfntTable(data, TAG_OS2);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const hasOs2 = !!os2 && os2 + 64 <= data.byteLength;
    return {
        family,
        fullName: parseSfntName(data, NAME_ID_FULL),
        weight: hasOs2 ? dv.getUint16(os2 + 4) || 400 : 400,
        // fsSelection bit 0: ITALIC.
        italic: hasOs2 ? (dv.getUint16(os2 + 62) & 1) !== 0 : false,
    };
}

// The worker owns one guest process, so its FontFaceSet also scopes FR_PRIVATE fonts.
interface InstalledFont { faces: FontFace[]; family: string; fullName: string | null; references: Map<number, number> }
const installedFonts = new Map<string, InstalledFont>();
const pendingFonts = new Map<string, Promise<InstalledFont | null>>();
let fontGeneration = 0;

/** A new guest container must not inherit installed faces or pending loads from the old one. */
export function resetFontResources(): void {
    fontGeneration++;
    for (const entry of installedFonts.values()) {
        for (const face of entry.faces) (self as unknown as { fonts: FontFaceSet }).fonts.delete(face);
    }
    invalidateTextExtentCache();
    installedFonts.clear();
    pendingFonts.clear();
}

/**
 * Register a guest font file with the worker's FontFaceSet. Returns the number
 * of fonts added. Repeated registrations hold independent references keyed by their flags.
 */
export async function addFontResource(resolvedPath: string, data: Uint8Array, flags = 0): Promise<number> {
    if (flags & ~0x30) return 0;
    const generation = fontGeneration;
    const key = resolvedPath.toLowerCase();
    let entry = installedFonts.get(key);
    if (!entry) {
        let pending = pendingFonts.get(key);
        if (!pending) {
            pending = loadFontResource(resolvedPath, data, fontGeneration);
            pendingFonts.set(key, pending);
        }
        const loaded = await pending;
        if (pendingFonts.get(key) === pending) pendingFonts.delete(key);
        if (!loaded || generation !== fontGeneration) return 0;
        entry = installedFonts.get(key);
        if (!entry) {
            entry = loaded;
            for (const face of entry.faces) (self as unknown as { fonts: FontFaceSet }).fonts.add(face);
            invalidateTextExtentCache();
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

async function loadFontResource(resolvedPath: string, data: Uint8Array, generation: number): Promise<InstalledFont | null> {
    const face = parseSfntFace(data);
    if (!face) {
        Logger.warn(LogCategory.GDI32,
            `AddFontResource: unsupported font resource "${resolvedPath}"`);
        return null;
    }

    // FontFace wants a plain ArrayBuffer; VFS data may view a SharedArrayBuffer.
    const buf = new ArrayBuffer(data.byteLength);
    new Uint8Array(buf).set(data);
    clearUnicodeCmapLanguages(new Uint8Array(buf));
    // The file's weight and slant ride along, so a LOGFONT asking for the family in bold
    // finds the bold file, and one asking for "Andy Bold" in bold is not emboldened twice.
    // GDI matches the full name as a face of its own.
    const descriptors: FontFaceDescriptors = { weight: String(face.weight), style: face.italic ? 'italic' : 'normal' };
    const names = [face.family];
    if (face.fullName && face.fullName.toLowerCase() !== face.family.toLowerCase()) names.push(face.fullName);
    try {
        const faces = names.map(name => new FontFace(name, buf, descriptors));
        await Promise.all(faces.map(f => f.load()));
        if (generation !== fontGeneration) return null;
        Logger.log(LogCategory.GDI32,
            `AddFontResource: installed '${names.join("' / '")}' from "${resolvedPath}"`);
        return { faces, family: face.family, fullName: face.fullName, references: new Map() };
    } catch (e) {
        Logger.warn(LogCategory.GDI32, `AddFontResource: FontFace load failed for "${resolvedPath}": ${e}`);
        return null;
    }
}

/**
 * The browser's font sanitizer (OTS) refuses a whole font whose format-4 cmap carries
 * a language id, which only means something on the Macintosh platform and which GDI
 * ignores. Shipping Windows fonts set it on their Windows subtable, so clear it there.
 * OTS does not verify table checksums, so the edit needs no fix-up.
 */
export function clearUnicodeCmapLanguages(data: Uint8Array): void {
    const cmap = sfntTable(data, TAG_CMAP);
    if (!cmap || cmap + 4 > data.byteLength) return;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = dv.getUint16(cmap + 2);
    for (let i = 0; i < count; i++) {
        const rec = cmap + 4 + i * 8;
        if (rec + 8 > data.byteLength) return;
        const platform = dv.getUint16(rec);
        const sub = cmap + dv.getUint32(rec + 4);
        if ((platform === 0 || platform === 3) && sub + 6 <= data.byteLength && dv.getUint16(sub) === 4) {
            dv.setUint16(sub + 4, 0);
        }
    }
}

/** Whether `faceName` names an installed font, by family or by full name. */
export function isInstalledFontName(faceName: string): boolean {
    const name = faceName.toLowerCase();
    for (const entry of installedFonts.values()) {
        if (entry.family.toLowerCase() === name || entry.fullName?.toLowerCase() === name) return true;
    }
    return false;
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
    for (const face of entry.faces) (self as unknown as { fonts: FontFaceSet }).fonts.delete(face);
    invalidateTextExtentCache();
    installedFonts.delete(key);
    return true;
}
