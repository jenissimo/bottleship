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
    /** Export name → the RVA of its body. Empty for a forwarder (there is no local body). */
    addresses: Map<string, number>;
    /** A declared table ran past the image or past the 16-bit ordinal space and was clamped. */
    truncated?: boolean;
}

/** Ordinals are 16-bit in the PE format, so a larger table is corrupt, not large. */
const MAX_EXPORT_ENTRIES = 0x10000;

/** Parse the export directory of an on-disk image (names, ordinals, forwarders). */
export function parsePeExports(image: Uint8Array, headers?: PeHeaders | null): PeExports {
    const h = headers ?? readPeHeaders(image);
    const out: PeExports = {
        dllName: "", names: new Set(), ordinals: new Map(), forwarders: new Map(), addresses: new Map(),
    };
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

    // `numFuncs`/`numNames` are unchecked uint32s out of the file, and each drives a loop that
    // also INSERTS into a Map — so a malformed header buys seconds of CPU and image-sized
    // memory. Clamp both to what the file can actually hold (and to the ordinal space), the
    // same shape as the `d > 512` guards on the import walks.
    const fitting = (off: number | null, stride: number) =>
        off === null ? 0 : Math.max(0, Math.floor((image.length - off) / stride));
    const funcCount = Math.min(numFuncs, MAX_EXPORT_ENTRIES, fitting(funcsOff, 4));
    const nameCount = Math.min(numNames, MAX_EXPORT_ENTRIES, fitting(namesOff, 4), fitting(nameOrdOff, 2));
    if (funcCount !== numFuncs || nameCount !== numNames) out.truncated = true;

    const funcRvaAt = (index: number): number => {
        if (funcsOff === null || index >= funcCount) return 0;
        const o = funcsOff + index * 4;
        return o + 4 <= image.length ? view.getUint32(o, true) : 0;
    };
    const inExportDir = (rva: number): boolean => rva >= dir.rva && rva < dir.rva + dir.size;

    for (let i = 0; i < funcCount; i++) {
        const rva = funcRvaAt(i);
        if (rva !== 0) out.ordinals.set(ordinalBase + i, null);
    }

    if (namesOff !== null && nameOrdOff !== null) {
        for (let i = 0; i < nameCount; i++) {
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
            } else if (target !== 0) {
                out.addresses.set(name, target);
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

/** Prefix bytes that may precede an opcode: operand/address size, lock, rep, segment. */
const X86_PREFIXES = new Set([0x66, 0x67, 0xf0, 0xf2, 0xf3, 0x2e, 0x36, 0x3e, 0x26, 0x64, 0x65]);

/** Immediate shapes, sized against the operand/address-size prefixes at decode time. */
const IMM_NONE = 0;
const IMM_B = 1;      // imm8
const IMM_W = 2;      // imm16 — RET/RETF only
const IMM_Z = 3;      // imm32, imm16 under 0x66
const IMM_PTR = 4;    // ptr16:32 far target
const IMM_MOFFS = 5;  // absolute address, address-size wide
const IMM_ENTER = 6;  // imm16 + imm8
const IMM_GRP3 = 7;   // F6/F7: an immediate only for the two TEST forms

interface OpTraits { modrm: boolean; imm: number }

function opTraits(modrm: boolean, imm: number): OpTraits {
    return { modrm, imm };
}

/** One-byte opcodes. Null = not modelled, which the walk must treat as "stop". */
function traitsOneByte(code: number): OpTraits | null {
    if (code < 0x40) {
        // ALU block; the segment-override bytes and 0x0F never reach here.
        const lo = code & 7;
        if (lo <= 3) return opTraits(true, IMM_NONE);
        if (lo === 4) return opTraits(false, IMM_B);
        if (lo === 5) return opTraits(false, IMM_Z);
        return opTraits(false, IMM_NONE);                             // push/pop seg, daa/das/aaa/aas
    }
    if (code <= 0x61) return opTraits(false, IMM_NONE);               // inc/dec, push/pop r32, pusha/popa
    if (code === 0x62 || code === 0x63) return opTraits(true, IMM_NONE);
    if (code === 0x68) return opTraits(false, IMM_Z);
    if (code === 0x69) return opTraits(true, IMM_Z);
    if (code === 0x6a) return opTraits(false, IMM_B);
    if (code === 0x6b) return opTraits(true, IMM_B);
    if (code <= 0x6f) return opTraits(false, IMM_NONE);               // ins/outs
    if (code <= 0x7f) return opTraits(false, IMM_B);                  // jcc rel8
    if (code === 0x81) return opTraits(true, IMM_Z);
    if (code <= 0x83) return opTraits(true, IMM_B);                   // 80/82/83 grp1 Ib
    if (code <= 0x8f) return opTraits(true, IMM_NONE);                // test/xchg/mov/lea/pop Ev
    if (code === 0x9a) return opTraits(false, IMM_PTR);
    if (code <= 0x9f) return opTraits(false, IMM_NONE);               // xchg eAX, cwde/cdq, pushf/popf
    if (code <= 0xa3) return opTraits(false, IMM_MOFFS);
    if (code <= 0xa7) return opTraits(false, IMM_NONE);               // movs/cmps
    if (code === 0xa8) return opTraits(false, IMM_B);
    if (code === 0xa9) return opTraits(false, IMM_Z);
    if (code <= 0xaf) return opTraits(false, IMM_NONE);               // stos/lods/scas
    if (code <= 0xb7) return opTraits(false, IMM_B);                  // mov r8, Ib
    if (code <= 0xbf) return opTraits(false, IMM_Z);                  // mov r32, Iv
    if (code <= 0xc1) return opTraits(true, IMM_B);                   // shift grp2, Ib
    if (code === 0xc2 || code === 0xca) return opTraits(false, IMM_W);
    if (code === 0xc3 || code === 0xcb) return opTraits(false, IMM_NONE);
    if (code === 0xc4 || code === 0xc5) return opTraits(true, IMM_NONE);   // les/lds
    if (code === 0xc6) return opTraits(true, IMM_B);
    if (code === 0xc7) return opTraits(true, IMM_Z);
    if (code === 0xc8) return opTraits(false, IMM_ENTER);
    if (code === 0xcd) return opTraits(false, IMM_B);                 // int Ib
    if (code === 0xc9 || code === 0xcc || code === 0xce || code === 0xcf) return opTraits(false, IMM_NONE);
    if (code <= 0xd3) return opTraits(true, IMM_NONE);                // shift grp2, 1/CL
    if (code === 0xd4 || code === 0xd5) return opTraits(false, IMM_B);     // aam/aad
    if (code === 0xd7) return opTraits(false, IMM_NONE);              // xlat
    if (code >= 0xd8 && code <= 0xdf) return opTraits(true, IMM_NONE);     // x87 escapes
    if (code >= 0xe0 && code <= 0xe7) return opTraits(false, IMM_B);  // loop/jecxz, in/out Ib
    if (code === 0xe8 || code === 0xe9) return opTraits(false, IMM_Z);     // call/jmp rel32
    if (code === 0xea) return opTraits(false, IMM_PTR);
    if (code === 0xeb) return opTraits(false, IMM_B);                 // jmp rel8
    if (code >= 0xec && code <= 0xef) return opTraits(false, IMM_NONE);    // in/out DX
    if (code === 0xf1 || code === 0xf4 || code === 0xf5) return opTraits(false, IMM_NONE);
    if (code === 0xf6 || code === 0xf7) return opTraits(true, IMM_GRP3);
    if (code >= 0xf8 && code <= 0xfd) return opTraits(false, IMM_NONE);    // flag setters
    if (code === 0xfe || code === 0xff) return opTraits(true, IMM_NONE);   // grp4/grp5
    return null;                                                      // 0xd6 (SALC) and any gap
}

/** Two-byte opcodes (after 0x0F). The 0x38/0x3A three-byte escapes are the caller's. */
function traitsTwoByte(code: number): OpTraits | null {
    if (code <= 0x03) return opTraits(true, IMM_NONE);                // grp6/grp7, lar/lsl
    if (code >= 0x05 && code <= 0x09) return opTraits(false, IMM_NONE);
    if (code === 0x0b || code === 0x0e) return opTraits(false, IMM_NONE);  // ud2, femms
    if (code === 0x0d) return opTraits(true, IMM_NONE);               // prefetch
    if (code >= 0x10 && code <= 0x2f) return opTraits(true, IMM_NONE);     // SSE moves, hints, cr/dr
    if (code >= 0x30 && code <= 0x37) return opTraits(false, IMM_NONE);    // rdtsc/rdmsr/cpuid-adjacent
    if (code >= 0x40 && code <= 0x6f) return opTraits(true, IMM_NONE);     // cmovcc, MMX/SSE
    if (code >= 0x70 && code <= 0x73) return opTraits(true, IMM_B);   // pshuf*, shift-imm groups
    if (code >= 0x74 && code <= 0x76) return opTraits(true, IMM_NONE);
    if (code === 0x77) return opTraits(false, IMM_NONE);              // emms
    if (code === 0x78 || code === 0x79) return opTraits(true, IMM_NONE);
    if (code >= 0x7c && code <= 0x7f) return opTraits(true, IMM_NONE);
    if (code >= 0x80 && code <= 0x8f) return opTraits(false, IMM_Z);  // jcc rel32
    if (code >= 0x90 && code <= 0x9f) return opTraits(true, IMM_NONE);     // setcc
    if (code === 0xa4 || code === 0xac) return opTraits(true, IMM_B);      // shld/shrd Ib
    if (code === 0xba) return opTraits(true, IMM_B);                  // grp8 bt* Ib
    if (code === 0xc2) return opTraits(true, IMM_B);                  // cmpps
    if (code >= 0xc4 && code <= 0xc6) return opTraits(true, IMM_B);   // pinsrw/pextrw/shufps
    if (code >= 0xa0 && code <= 0xa2) return opTraits(false, IMM_NONE);    // push/pop fs, cpuid
    if (code === 0xa8 || code === 0xa9 || code === 0xaa) return opTraits(false, IMM_NONE);
    if (code >= 0xa3 && code <= 0xc1) return opTraits(true, IMM_NONE);     // bt*, imul, xadd, movzx
    if (code === 0xc3 || code === 0xc7) return opTraits(true, IMM_NONE);   // movnti, grp9
    if (code >= 0xc8 && code <= 0xcf) return opTraits(false, IMM_NONE);    // bswap
    if (code >= 0xd0) return opTraits(true, IMM_NONE);                // MMX/SSE arithmetic
    return null;
}

/**
 * Length of a ModRM byte plus its SIB and displacement.
 *
 * 16-bit addressing (a 0x67 prefix) uses a different table entirely; refusing it keeps one
 * encoding model rather than a second, never-exercised one.
 */
function modrmLength(image: Uint8Array, at: number, limit: number, addr16: boolean): number | null {
    if (at >= limit || addr16) return null;
    const modrm = image[at];
    const mod = modrm >> 6;
    const rm = modrm & 7;
    if (mod === 3) return 1;
    let len = 1;
    let base = rm;
    if (rm === 4) {
        if (at + 1 >= limit) return null;
        base = image[at + 1] & 7;
        len += 1;
    }
    if (mod === 1) return len + 1;
    if (mod === 2) return len + 4;
    return base === 5 ? len + 4 : len;   // mod=00 with base/rm=101 → disp32 supplies the base
}

/**
 * Decode one instruction's LENGTH, and whether it is a near return.
 *
 * Length is the whole point: it keeps the walk on instruction boundaries, so a `C2`/`C3`
 * that is really an immediate, a displacement or a ModRM byte is never mistaken for a
 * return. An unrecognised opcode returns null — guessing a length would resynchronise the
 * stream onto whatever byte followed, which is the failure this decoder exists to avoid.
 */
function decodeInstruction(image: Uint8Array, start: number): { len: number; retPops: number | null } | null {
    const limit = image.length;
    let p = start;
    let opsize16 = false;
    let addr16 = false;
    for (let seen = 0; p < limit && X86_PREFIXES.has(image[p]); seen++) {
        if (seen >= 4) return null;      // more prefixes than any real encoding carries
        if (image[p] === 0x66) opsize16 = true;
        else if (image[p] === 0x67) addr16 = true;
        p++;
    }
    if (p >= limit) return null;
    const code = image[p++];
    let traits: OpTraits | null;
    if (code === 0x0f) {
        if (p >= limit) return null;
        const code2 = image[p++];
        if (code2 === 0x38 || code2 === 0x3a) {
            if (p >= limit) return null;
            p++;                          // three-byte escape carries one more opcode byte
            traits = opTraits(true, code2 === 0x3a ? IMM_B : IMM_NONE);
        } else {
            traits = traitsTwoByte(code2);
        }
    } else {
        traits = traitsOneByte(code);
    }
    if (!traits) return null;

    let regField = 0;
    if (traits.modrm) {
        if (p >= limit) return null;
        regField = (image[p] >> 3) & 7;
        const mlen = modrmLength(image, p, limit, addr16);
        if (mlen === null) return null;
        p += mlen;
    }

    let immLen: number;
    switch (traits.imm) {
        case IMM_NONE: immLen = 0; break;
        case IMM_B: immLen = 1; break;
        case IMM_W: immLen = 2; break;
        case IMM_Z: immLen = opsize16 ? 2 : 4; break;
        case IMM_PTR: immLen = (opsize16 ? 2 : 4) + 2; break;
        case IMM_MOFFS: immLen = addr16 ? 2 : 4; break;
        case IMM_ENTER: immLen = 3; break;
        // F6/F7 reg=0/1 are TEST Eb,Ib / TEST Ev,Iz; the other six forms carry no immediate.
        case IMM_GRP3: immLen = regField <= 1 ? (code === 0xf6 ? 1 : (opsize16 ? 2 : 4)) : 0; break;
        default: return null;
    }
    p += immLen;
    if (p > limit) return null;

    const retPops = code === 0xc3 ? 0
        : code === 0xc2 ? (image[p - 2] | (image[p - 1] << 8))
        : null;
    return { len: p - start, retPops };
}

/**
 * File offset of an export's real body, following at most one entry jump thunk.
 *
 * A hot-patched or shimmed export starts with a jump to the code that answers for it, so
 * one hop is followed — exactly one, since a chain would be an unbounded walk. `FF 25`
 * (jmp [abs32]) reads a slot the loader fills, which a file image cannot resolve; it is
 * refused rather than decoded as the zeroes on disk.
 */
function exportBodyOffset(image: Uint8Array, headers: PeHeaders, rva: number): number | null {
    const off = rvaToFileOffset(headers, rva);
    if (off === null || off >= image.length) return null;
    const view = viewOf(image);
    if (image[off] === 0xff && off + 1 < image.length && image[off + 1] === 0x25) return null;
    let target: number | null = null;
    if (image[off] === 0xe9 && off + 5 <= image.length) {
        target = (rva + 5 + view.getInt32(off + 1, true)) >>> 0;
    } else if (image[off] === 0xeb && off + 2 <= image.length) {
        target = (rva + 2 + ((image[off + 1] << 24) >> 24)) >>> 0;
    }
    return target === null ? off : rvaToFileOffset(headers, target);
}

/** Bound on the walk alongside `scanBytes`, so a mis-sized instruction cannot become a
 *  long spin over a large image. */
const MAX_DECODED_INSNS = 512;

/**
 * How many argument bytes does a stdcall export ACTUALLY pop?
 *
 * The `@N` in a decorated export name is what the header said when the DLL was built, and
 * vendors have shipped a changed ABI under the old name: Bink's `_BinkSetVolume@8` is
 * `(HBINK, volume)` and RET 8 in 0.8i and 1.0v, then `(HBINK, trackid, volume)` and RET 12
 * in 1.5v — same name, one more argument. Binding a caller of one generation to a stub
 * built for the other drifts ESP by 4, and the caller's own RET then jumps to whatever
 * dword the drift exposed, far from anything Bink-shaped.
 *
 * The body settles it: every return in a stdcall function pops the same N, so the first one
 * reached is the whole answer, and an early-out return in the same function carries the
 * same immediate. Finding it requires DECODING — a byte scan for `C2`/`C3` also matches an
 * immediate (`mov eax,0xC3`), a displacement (`add edx,imm32`, `call rel32`) or a ModRM
 * byte, and answers confidently wrong.
 *
 * Returns the byte count, 0 for a plain `RET` (nothing popped), or null when the export is
 * absent or forwarded, its entry is an unresolvable import thunk, an opcode is not
 * modelled, or no return was reached inside `scanBytes`. Callers must treat null as
 * "unknown" and say so out loud rather than fall back on the decoration silently.
 */
export function readStdcallRetBytes(
    image: Uint8Array,
    exportName: string,
    headers?: PeHeaders | null,
    scanBytes = 512,
): number | null {
    const h = headers ?? readPeHeaders(image);
    if (!h) return null;
    const rva = parsePeExports(image, h).addresses.get(exportName);
    if (rva === undefined) return null;
    const entry = exportBodyOffset(image, h, rva);
    if (entry === null) return null;
    const end = Math.min(entry + scanBytes, image.length);
    let p = entry;
    for (let n = 0; p < end && n < MAX_DECODED_INSNS; n++) {
        const insn = decodeInstruction(image, p);
        if (!insn || insn.len <= 0) return null;
        if (insn.retPops !== null) return insn.retPops;
        p += insn.len;
    }
    return null;
}
