/**
 * On-disk PE reader — headers, sections, imports (normal + delay-load), exports.
 *
 * The emulator's PELoader parses the image once it is MAPPED into guest memory; this
 * reader works on the raw file bytes, so it can answer "what does this binary link
 * against" for a `.wgb` we never boot. Shared by the API-coverage census and the
 * VS_VERSIONINFO reader (`src/worker/core/pe-version.ts`), which needs the same
 * section-table RVA→offset mapping.
 *
 * Self-contained: no DOM, no emulator, no third-party deps.
 */

const MZ_MAGIC = 0x5a4d;
const PE_MAGIC = 0x00004550;
const PE32_MAGIC = 0x10b;
const PE32PLUS_MAGIC = 0x20b;

const DIR_EXPORT = 0;
const DIR_IMPORT = 1;
const DIR_RESOURCE = 2;
const DIR_BOUND_IMPORT = 11;
const DIR_IAT = 12;
const DIR_DELAY_IMPORT = 13;

const IMAGE_FILE_DLL = 0x2000;
const IMAGE_SCN_MEM_EXECUTE = 0x20000000;

export interface PeSection {
    name: string;
    virtualAddress: number;
    virtualSize: number;
    rawPointer: number;
    rawSize: number;
    characteristics: number;
}

export interface PeDataDirectory {
    rva: number;
    size: number;
}

export interface PeHeaders {
    /** File offset of the PE signature. */
    peOff: number;
    machine: number;
    is64: boolean;
    imageBase: number;
    sizeOfImage: number;
    entryPointRva: number;
    subsystem: number;
    characteristics: number;
    isDll: boolean;
    sections: PeSection[];
    dataDirectories: PeDataDirectory[];
}

/** Cheap magic check — true when the buffer starts a PE image (MZ + valid e_lfanew + PE\0\0). */
export function isPeImage(image: Uint8Array): boolean {
    return readPeHeaders(image) !== null;
}

function viewOf(image: Uint8Array): DataView {
    return new DataView(image.buffer, image.byteOffset, image.byteLength);
}

/** Parse the DOS/COFF/optional headers and the section table. Returns null when not a PE. */
export function readPeHeaders(image: Uint8Array): PeHeaders | null {
    if (image.length < 0x40) return null;
    const view = viewOf(image);
    if (view.getUint16(0, true) !== MZ_MAGIC) return null;
    const peOff = view.getUint32(0x3c, true);
    if (peOff <= 0 || peOff + 24 > image.length) return null;
    if (view.getUint32(peOff, true) !== PE_MAGIC) return null;

    const machine = view.getUint16(peOff + 4, true);
    const numSections = view.getUint16(peOff + 6, true);
    const optSize = view.getUint16(peOff + 20, true);
    const characteristics = view.getUint16(peOff + 22, true);
    const optOff = peOff + 24;
    if (optOff + 2 > image.length) return null;

    const magic = view.getUint16(optOff, true);
    if (magic !== PE32_MAGIC && magic !== PE32PLUS_MAGIC) return null;
    const is64 = magic === PE32PLUS_MAGIC;
    if (optOff + (is64 ? 112 : 96) > image.length) return null;

    const entryPointRva = view.getUint32(optOff + 16, true);
    // PE32+ widens ImageBase to 8 bytes and drops BaseOfData, shifting everything after.
    const imageBase = is64 ? Number(view.getBigUint64(optOff + 24, true)) : view.getUint32(optOff + 28, true);
    const sizeOfImage = view.getUint32(optOff + 56, true);
    const subsystem = view.getUint16(optOff + 68, true);
    const dirCountOff = optOff + (is64 ? 108 : 92);
    const numDirs = dirCountOff + 4 <= image.length ? view.getUint32(dirCountOff, true) : 0;
    const dirBase = dirCountOff + 4;

    const dataDirectories: PeDataDirectory[] = [];
    for (let i = 0; i < Math.min(numDirs, 16); i++) {
        const off = dirBase + i * 8;
        if (off + 8 > image.length) break;
        dataDirectories.push({ rva: view.getUint32(off, true), size: view.getUint32(off + 4, true) });
    }

    const secTable = optOff + optSize;
    const sections: PeSection[] = [];
    for (let i = 0; i < numSections; i++) {
        const s = secTable + i * 40;
        if (s + 40 > image.length) break;
        let name = "";
        for (let j = 0; j < 8; j++) {
            const c = image[s + j];
            if (c === 0) break;
            name += String.fromCharCode(c);
        }
        sections.push({
            name,
            virtualSize: view.getUint32(s + 8, true),
            virtualAddress: view.getUint32(s + 12, true),
            rawSize: view.getUint32(s + 16, true),
            rawPointer: view.getUint32(s + 20, true),
            characteristics: view.getUint32(s + 36, true),
        });
    }

    return {
        peOff,
        machine,
        is64,
        imageBase,
        sizeOfImage,
        entryPointRva,
        subsystem,
        characteristics,
        isDll: (characteristics & IMAGE_FILE_DLL) !== 0,
        sections,
        dataDirectories,
    };
}

/**
 * Map an RVA to a file offset through the section table. Returns null when the RVA
 * falls in a section's uninitialised tail (VirtualSize > SizeOfRawData) or outside
 * every section — those bytes do not exist on disk.
 */
export function rvaToFileOffset(headers: PeHeaders, rva: number): number | null {
    for (const s of headers.sections) {
        const span = Math.max(s.virtualSize, s.rawSize);
        if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
            const delta = rva - s.virtualAddress;
            return delta < s.rawSize ? s.rawPointer + delta : null;
        }
    }
    // Headers themselves are identity-mapped in the first page.
    if (rva < (headers.sections[0]?.rawPointer ?? 0)) return rva;
    return null;
}

function readCString(image: Uint8Array, off: number, max = 512): string {
    if (off < 0 || off >= image.length) return "";
    let s = "";
    const end = Math.min(image.length, off + max);
    for (let p = off; p < end; p++) {
        const c = image[p];
        if (c === 0) break;
        s += String.fromCharCode(c);
    }
    return s;
}

export interface PeImportEntry {
    /** Import-by-name; undefined for an import-by-ordinal. */
    name?: string;
    /** Import-by-ordinal value; undefined for an import-by-name. */
    ordinal?: number;
    hint?: number;
    /** RVA of this function's IAT slot (the address the code calls through). */
    iatRva: number;
}

export interface PeImportedDll {
    /** DLL name exactly as written in the import descriptor. */
    dll: string;
    entries: PeImportEntry[];
    /** True for a delay-load descriptor (resolved lazily via __delayLoadHelper2). */
    delayLoad: boolean;
}

export interface PeImports {
    dlls: PeImportedDll[];
    /** The image carries a bound-import directory (its IAT is pre-baked). */
    bound: boolean;
    /** A descriptor table was present but unreadable (truncated / packed). */
    truncated: boolean;
}

const ORDINAL_FLAG32 = 0x80000000;

function parseThunkArray(
    image: Uint8Array,
    view: DataView,
    headers: PeHeaders,
    lookupRva: number,
    iatRva: number,
    rvaBias: number,
): PeImportEntry[] {
    const entries: PeImportEntry[] = [];
    const step = headers.is64 ? 8 : 4;
    let off = rvaToFileOffset(headers, lookupRva);
    if (off === null) return entries;

    for (let i = 0; ; i++) {
        if (off + step > image.length) break;
        const lo = view.getUint32(off, true);
        const hi = headers.is64 ? view.getUint32(off + 4, true) : 0;
        if (lo === 0 && hi === 0) break;
        if (i > 20000) break; // runaway guard on a malformed table

        const slotRva = iatRva + i * step;
        const isOrdinal = headers.is64 ? (hi & 0x80000000) !== 0 : (lo & ORDINAL_FLAG32) !== 0;
        if (isOrdinal) {
            entries.push({ ordinal: lo & 0xffff, iatRva: slotRva });
        } else {
            const nameRva = (lo & 0x7fffffff) - rvaBias;
            const nameOff = rvaToFileOffset(headers, nameRva);
            if (nameOff !== null && nameOff + 2 < image.length) {
                entries.push({
                    hint: view.getUint16(nameOff, true),
                    name: readCString(image, nameOff + 2),
                    iatRva: slotRva,
                });
            } else {
                entries.push({ iatRva: slotRva });
            }
        }
        off += step;
    }
    return entries;
}

/**
 * Every DLL/function the image links against: the normal import directory plus the
 * delay-load directory (delay-load descriptors are how a title links against an API
 * it can tolerate missing — invisible to a naive import walk).
 */
export function parsePeImports(image: Uint8Array, headers?: PeHeaders | null): PeImports {
    const h = headers ?? readPeHeaders(image);
    const out: PeImports = { dlls: [], bound: false, truncated: false };
    if (!h) return out;
    const view = viewOf(image);

    out.bound = (h.dataDirectories[DIR_BOUND_IMPORT]?.rva ?? 0) !== 0;

    // --- normal imports: IMAGE_IMPORT_DESCRIPTOR[] ---
    const impRva = h.dataDirectories[DIR_IMPORT]?.rva ?? 0;
    if (impRva) {
        const base = rvaToFileOffset(h, impRva);
        if (base === null) {
            out.truncated = true;
        } else {
            for (let d = 0; ; d++) {
                const off = base + d * 20;
                if (off + 20 > image.length) { out.truncated = true; break; }
                const iltRva = view.getUint32(off, true);
                const nameRva = view.getUint32(off + 12, true);
                const iatRva = view.getUint32(off + 16, true);
                if (nameRva === 0 && iltRva === 0 && iatRva === 0) break;
                if (d > 512) { out.truncated = true; break; }
                const nameOff = rvaToFileOffset(h, nameRva);
                const dll = nameOff === null ? "" : readCString(image, nameOff);
                if (!dll) { out.truncated = true; continue; }
                // A bound image zeroes nothing, but some linkers emit no ILT — the IAT
                // then doubles as the lookup table.
                const entries = parseThunkArray(image, view, h, iltRva || iatRva, iatRva || iltRva, 0);
                out.dlls.push({ dll, entries, delayLoad: false });
            }
        }
    }

    // --- delay-load imports: IMAGE_DELAYLOAD_DESCRIPTOR[] ---
    const delayRva = h.dataDirectories[DIR_DELAY_IMPORT]?.rva ?? 0;
    if (delayRva) {
        const base = rvaToFileOffset(h, delayRva);
        if (base === null) {
            out.truncated = true;
        } else {
            for (let d = 0; ; d++) {
                const off = base + d * 32;
                if (off + 32 > image.length) { out.truncated = true; break; }
                const attributes = view.getUint32(off, true);
                const nameField = view.getUint32(off + 4, true);
                const iltField = view.getUint32(off + 16, true);
                const iatField = view.getUint32(off + 12, true);
                if (nameField === 0 && iltField === 0) break;
                if (d > 512) { out.truncated = true; break; }
                // Attributes bit 0 (dlattrRva) set ⇒ the fields are RVAs. Old VC6-era
                // descriptors store VIRTUAL ADDRESSES instead, so subtract ImageBase.
                const bias = (attributes & 1) !== 0 ? 0 : h.imageBase;
                const nameOff = rvaToFileOffset(h, nameField - bias);
                const dll = nameOff === null ? "" : readCString(image, nameOff);
                if (!dll) { out.truncated = true; continue; }
                const entries = parseThunkArray(image, view, h, iltField - bias, iatField - bias, bias);
                out.dlls.push({ dll, entries, delayLoad: true });
            }
        }
    }

    return out;
}

export interface PeExports {
    /** The DLL's own recorded name (may differ from the file name). */
    dllName: string;
    /** Exported names (as written; case-sensitive). */
    names: Set<string>;
    /** Ordinal → name (null for a NONAME export). */
    ordinals: Map<number, string | null>;
    /** Export name → forwarder string ("NTDLL.RtlAllocateHeap") for forwarded exports. */
    forwarders: Map<string, string>;
}

/** Parse the export directory of an on-disk image (names, ordinals, forwarders). */
export function parsePeExports(image: Uint8Array, headers?: PeHeaders | null): PeExports {
    const h = headers ?? readPeHeaders(image);
    const out: PeExports = { dllName: "", names: new Set(), ordinals: new Map(), forwarders: new Map() };
    if (!h) return out;
    const dir = h.dataDirectories[DIR_EXPORT];
    if (!dir || !dir.rva) return out;
    const base = rvaToFileOffset(h, dir.rva);
    if (base === null || base + 40 > image.length) return out;
    const view = viewOf(image);

    const nameRva = view.getUint32(base + 12, true);
    const ordinalBase = view.getUint32(base + 16, true);
    const numFuncs = view.getUint32(base + 20, true);
    const numNames = view.getUint32(base + 24, true);
    const funcsRva = view.getUint32(base + 28, true);
    const namesRva = view.getUint32(base + 32, true);
    const nameOrdRva = view.getUint32(base + 36, true);

    const nameOff = rvaToFileOffset(h, nameRva);
    if (nameOff !== null) out.dllName = readCString(image, nameOff);

    const funcsOff = rvaToFileOffset(h, funcsRva);
    const namesOff = rvaToFileOffset(h, namesRva);
    const nameOrdOff = rvaToFileOffset(h, nameOrdRva);

    const funcRvaAt = (index: number): number => {
        if (funcsOff === null || index >= numFuncs) return 0;
        const o = funcsOff + index * 4;
        return o + 4 <= image.length ? view.getUint32(o, true) : 0;
    };
    const inExportDir = (rva: number): boolean => rva >= dir.rva && rva < dir.rva + dir.size;

    for (let i = 0; i < numFuncs; i++) {
        const rva = funcRvaAt(i);
        if (rva !== 0) out.ordinals.set(ordinalBase + i, null);
    }

    if (namesOff !== null && nameOrdOff !== null) {
        for (let i = 0; i < numNames; i++) {
            const strOff = rvaToFileOffset(h, view.getUint32(namesOff + i * 4, true));
            if (strOff === null) continue;
            const name = readCString(image, strOff);
            if (!name) continue;
            const ordIndex = view.getUint16(nameOrdOff + i * 2, true);
            out.names.add(name);
            out.ordinals.set(ordinalBase + ordIndex, name);
            const target = funcRvaAt(ordIndex);
            if (inExportDir(target)) {
                const fwdOff = rvaToFileOffset(h, target);
                if (fwdOff !== null) out.forwarders.set(name, readCString(image, fwdOff));
            }
        }
    }

    return out;
}

/**
 * Count indirect call/jump sites through each IAT slot: `FF 15 <abs32>` (call [mem])
 * and `FF 25 <abs32>` (jmp [mem], the pattern of an import thunk). This turns an
 * import-table entry — which appears exactly once no matter how heavily it is used —
 * into a usage weight, so a census can rank "needed 40 times" above "needed once".
 *
 * 32-bit images only: the operand is the slot's absolute VA (ImageBase + slotRva).
 * x64 uses RIP-relative operands, so counting is skipped there.
 */
export function countIatCallSites(image: Uint8Array, headers: PeHeaders, slotRvas: Iterable<number>): Map<number, number> {
    const counts = new Map<number, number>();
    if (headers.is64) return counts;

    const vaToRva = new Map<number, number>();
    for (const rva of slotRvas) {
        vaToRva.set((headers.imageBase + rva) >>> 0, rva);
        counts.set(rva, 0);
    }
    if (vaToRva.size === 0) return counts;

    const view = viewOf(image);
    for (const s of headers.sections) {
        if ((s.characteristics & IMAGE_SCN_MEM_EXECUTE) === 0) continue;
        const start = s.rawPointer;
        const end = Math.min(image.length, s.rawPointer + s.rawSize);
        for (let p = start; p + 6 <= end; p++) {
            if (image[p] !== 0xff) continue;
            const modrm = image[p + 1];
            // /2 = CALL r/m32, /4 = JMP r/m32, mod=00 rm=101 ⇒ disp32 absolute.
            if (modrm !== 0x15 && modrm !== 0x25) continue;
            const target = view.getUint32(p + 2, true);
            const rva = vaToRva.get(target);
            if (rva !== undefined) counts.set(rva, (counts.get(rva) ?? 0) + 1);
        }
    }
    return counts;
}

const PACKER_SECTIONS: Array<[RegExp, string]> = [
    [/^UPX[0-9!]/i, "UPX"],
    [/^\.aspack$/i, "ASPack"],
    [/^\.adata$/i, "ASPack"],
    [/^\.petite$/i, "Petite"],
    [/^PEC2/i, "PECompact"],
    [/^\.pec/i, "PECompact"],
    [/^\.nsp[0-9]/i, "NsPack"],
    [/^\.MPRESS/i, "MPRESS"],
    [/^\.svkp$/i, "SVKP"],
    [/^\.Themida$/i, "Themida"],
    [/^\.vmp[0-9]/i, "VMProtect"],
    [/^\.y0da/i, "yoda"],
];

/**
 * Name of the packer/protector this image looks wrapped in, or null. A packed image
 * hides its real imports (the stub resolves them at runtime via GetProcAddress), so a
 * static census over one is structurally incomplete and must say so.
 */
export function detectPacker(headers: PeHeaders): string | null {
    for (const s of headers.sections) {
        for (const [re, name] of PACKER_SECTIONS) {
            if (re.test(s.name)) return name;
        }
    }
    return null;
}

/**
 * Heuristic "the import table is suspiciously thin": a real Win32 program links
 * against dozens of exports. A handful (typically just LoadLibrary/GetProcAddress)
 * means the imports are resolved at runtime and a static census cannot see them.
 */
export function importsLookHidden(imports: PeImports): boolean {
    let total = 0;
    for (const d of imports.dlls) total += d.entries.length;
    return total > 0 && total < 12;
}

export const PE_DATA_DIRECTORY = {
    EXPORT: DIR_EXPORT,
    IMPORT: DIR_IMPORT,
    RESOURCE: DIR_RESOURCE,
    BOUND_IMPORT: DIR_BOUND_IMPORT,
    IAT: DIR_IAT,
    DELAY_IMPORT: DIR_DELAY_IMPORT,
} as const;
