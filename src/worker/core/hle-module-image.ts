/**
 * Builder for the synthetic PE image that backs an HLE'd DLL's HMODULE.
 *
 * On Windows an HMODULE IS the ImageBase of a mapped PE, and guests act on it: pattern
 * scanners walk the section table, mod loaders read the export directory by hand, and
 * `dbghelp!ImageNtHeader` hands the NT headers straight back for the caller to
 * dereference — usually without a NULL check. A bare token handle therefore is not a
 * handle at all; it is a pointer the guest will follow.
 *
 * Pure function: takes a base and an export list, returns the bytes. No memory, no
 * System, no side effects — so the whole image publishes with ONE writeGuestCode call
 * (CLAUDE.md §3.1 requires the invalidation in the same JS turn as the write, and the
 * .text section here holds executable stub bodies).
 */

const IMAGE_DOS_SIGNATURE = 0x5a4d;         // 'MZ'
const IMAGE_NT_SIGNATURE = 0x00004550;      // 'PE\0\0'
const IMAGE_FILE_MACHINE_I386 = 0x014c;
const IMAGE_NT_OPTIONAL_HDR32_MAGIC = 0x10b;
const IMAGE_FILE_EXECUTABLE_IMAGE = 0x0002;
const IMAGE_FILE_32BIT_MACHINE = 0x0100;
const IMAGE_FILE_DLL = 0x2000;
const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const IMAGE_SCN_CNT_CODE = 0x00000020;
const IMAGE_SCN_CNT_INITIALIZED_DATA = 0x00000040;
const IMAGE_SCN_MEM_EXECUTE = 0x20000000;
const IMAGE_SCN_MEM_READ = 0x40000000;

const NT_HEADERS_OFFSET = 0x40;
const SIZEOF_OPTIONAL_HEADER32 = 0xe0;
const SIZEOF_SECTION_HEADER = 40;
const NUMBER_OF_SECTIONS = 2;
/** Section table sits right after the NT headers; .text starts at the first page. */
const SECTION_TABLE_OFFSET = NT_HEADERS_OFFSET + 4 + 20 + SIZEOF_OPTIONAL_HEADER32;
const SIZE_OF_HEADERS = 0x400;
const TEXT_RVA = 0x1000;
const SECTION_ALIGNMENT = 0x1000;
const FILE_ALIGNMENT = 0x200;
/** Each export body is one 16-byte OUT-trap stub, the same shape ThunkGenerator emits. */
const STUB_SIZE = 16;

export interface HleImageExport {
    name: string;
    /** Machine code for this export's body — 16 bytes from ThunkGenerator.allocateStubAt. */
    code: Uint8Array;
    /**
     * 1-based export ordinal, when the descriptor declares a real one (e.g. an
     * ordinal-only import table like twitchsdk's). Omit for sequential assignment
     * (array position + 1) — every by-name-only caller's existing behavior.
     */
    ordinal?: number;
}

export interface HleModuleImage {
    bytes: Uint8Array;
    /** Export name (as declared) -> absolute address of its body inside the image. */
    exportAddresses: Map<string, number>;
    /** 1-based export ordinal -> absolute address, matching the export directory. */
    ordinalAddresses: Map<number, number>;
    /** Absolute address each export body must be written to (== exportAddresses). */
    textBase: number;
}

function align(value: number, to: number): number {
    return Math.ceil(value / to) * to;
}

/** Which EAT slot (ordinal - base) each input export lands in; -1 marks a gap. */
interface OrdinalPlan {
    base: number;
    numberOfFunctions: number;
    slotToExportIndex: number[];
    /** The ordinal actually assigned to export i — exports[i].ordinal when declared. */
    assigned: number[];
}

/**
 * Real ordinals (e.g. twitchsdk's sparse [1,3,5,10,...]) size the export address table
 * (EAT) by ORDINAL RANGE, not export count, with a zero RVA at every gap — that's the only
 * way ordinal 3 resolves to export #2's body instead of whichever export happens to sit at
 * array index 2.
 *
 * A module can mix declared and undeclared ordinals (dsound/dplayx do: a handful of real,
 * documented ordinals alongside a majority of by-name-only exports nothing looks up by
 * number) — every undeclared export gets a synthesized ordinal past the highest declared
 * one, in array order, so it still lands in a real EAT slot without colliding with a real
 * one. Omitting ordinal on EVERY export keeps the fully sequential behavior (array
 * position + 1) every by-name-only module already had.
 */
function planOrdinals(exports: ReadonlyArray<{ ordinal?: number }>): OrdinalPlan {
    if (exports.length === 0) return { base: 1, numberOfFunctions: 0, slotToExportIndex: [], assigned: [] };
    const declared = exports.map(e => e.ordinal).filter((o): o is number => o !== undefined);
    if (declared.length === 0) {
        const assigned = exports.map((_, i) => i + 1);
        return { base: 1, numberOfFunctions: exports.length, slotToExportIndex: exports.map((_, i) => i), assigned };
    }
    for (const ordinal of declared) {
        if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 0xffff) {
            throw new Error(`Invalid export ordinal: ${ordinal}`);
        }
    }
    const base = Math.min(...declared);
    let nextFree = Math.max(...declared) + 1;
    const assigned = exports.map(e => e.ordinal ?? nextFree++);
    if (nextFree > 0x10000) throw new Error("Synthesized export ordinal exceeds 65535");
    const numberOfFunctions = Math.max(...assigned) - base + 1;
    const slotToExportIndex = new Array(numberOfFunctions).fill(-1);
    exports.forEach((_e, i) => {
        const slot = assigned[i] - base;
        if (slotToExportIndex[slot] === -1) slotToExportIndex[slot] = i;
    });
    return { base, numberOfFunctions, slotToExportIndex, assigned };
}

interface ImageLayout {
    textSize: number;
    edataRva: number;
    functionsRva: number;
    namesRva: number;
    ordinalsRva: number;
    dllNameRva: number;
    nameRvas: number[];
    dllNameBytes: Uint8Array;
    nameBytes: Uint8Array[];
    edataSize: number;
    imageSize: number;
    ordinalPlan: OrdinalPlan;
}

function layoutImage(
    moduleName: string,
    exportNames: readonly string[],
    exportsForOrdinals: ReadonlyArray<{ ordinal?: number }> = exportNames.map(() => ({})),
): ImageLayout {
    const textSize = align(Math.max(exportNames.length, 1) * STUB_SIZE, SECTION_ALIGNMENT);
    const edataRva = TEXT_RVA + textSize;

    const dllNameBytes = asciiz(`${moduleName}.dll`);
    const nameBytes = exportNames.map(asciiz);
    const ordinalPlan = planOrdinals(exportsForOrdinals);

    // IMAGE_EXPORT_DIRECTORY (40 bytes), then the three parallel arrays, then the strings.
    // AddressOfFunctions is sized by ordinal RANGE (NumberOfFunctions); the Name/NameOrdinal
    // arrays are sized by export COUNT (NumberOfNames) — a gap has no name.
    const exportDirSize = 40;
    const functionsRva = edataRva + exportDirSize;
    const namesRva = functionsRva + ordinalPlan.numberOfFunctions * 4;
    const ordinalsRva = namesRva + exportNames.length * 4;
    const stringsRva = ordinalsRva + exportNames.length * 2;
    let stringCursor = stringsRva;
    const dllNameRva = stringCursor;
    stringCursor += dllNameBytes.length;
    const nameRvas = nameBytes.map(b => {
        const rva = stringCursor;
        stringCursor += b.length;
        return rva;
    });
    const edataSize = align(stringCursor - edataRva, SECTION_ALIGNMENT);
    const imageSize = align(edataRva + edataSize, SECTION_ALIGNMENT);

    return {
        textSize, edataRva, functionsRva, namesRva, ordinalsRva,
        dllNameRva, nameRvas, dllNameBytes, nameBytes, edataSize, imageSize, ordinalPlan,
    };
}

/**
 * Bytes buildHleModuleImage would need for this export set. Callers check this BEFORE
 * allocating any stubs: a slot that cannot hold the image must leave no stub registered at
 * an address nothing ever publishes. Same layout code as the builder, so the two agree.
 */
export function hleModuleImageSize(
    moduleName: string,
    exports: ReadonlyArray<string | { name: string; ordinal?: number }>,
): number {
    const asObjects = exports.map(e => typeof e === "string" ? { name: e } : e);
    return layoutImage(moduleName, asObjects.map(e => e.name), asObjects).imageSize;
}

/**
 * Build the image. `exports` must already be sorted the way the caller wants ordinals
 * assigned; the export directory's name array is sorted independently, because the PE
 * spec requires AddressOfNames to be lexicographically ordered for binary search and a
 * loader that trusts that will silently mis-resolve an unsorted table.
 */
export function buildHleModuleImage(
    moduleName: string,
    base: number,
    slotSize: number,
    exports: HleImageExport[],
): HleModuleImage {
    const {
        textSize, edataRva, functionsRva, namesRva, ordinalsRva,
        dllNameRva, nameRvas, dllNameBytes, nameBytes, edataSize, imageSize, ordinalPlan,
    } = layoutImage(moduleName, exports.map(e => e.name), exports);

    if (imageSize > slotSize) {
        throw new Error(
            `[HleModuleImage] "${moduleName}" needs 0x${imageSize.toString(16)} bytes ` +
            `but the arena slot is 0x${slotSize.toString(16)} (${exports.length} exports)`);
    }

    // The whole slot is published, so the tail past the image is explicit zeroes rather
    // than whatever the previous process left in ROM.
    const bytes = new Uint8Array(slotSize);
    const view = new DataView(bytes.buffer);

    view.setUint16(0x00, IMAGE_DOS_SIGNATURE, true);
    view.setUint32(0x3c, NT_HEADERS_OFFSET, true);

    view.setUint32(NT_HEADERS_OFFSET, IMAGE_NT_SIGNATURE, true);
    const fh = NT_HEADERS_OFFSET + 4;
    view.setUint16(fh + 0, IMAGE_FILE_MACHINE_I386, true);
    view.setUint16(fh + 2, NUMBER_OF_SECTIONS, true);
    view.setUint16(fh + 16, SIZEOF_OPTIONAL_HEADER32, true);
    view.setUint16(fh + 18, IMAGE_FILE_EXECUTABLE_IMAGE | IMAGE_FILE_32BIT_MACHINE | IMAGE_FILE_DLL, true);

    const oh = fh + 20;
    view.setUint16(oh + 0x00, IMAGE_NT_OPTIONAL_HDR32_MAGIC, true);
    view.setUint8(oh + 0x02, 6);                                  // MajorLinkerVersion
    view.setUint32(oh + 0x04, textSize, true);                    // SizeOfCode
    // AddressOfEntryPoint stays 0: an HLE DLL has no DllMain, and 0 is the documented
    // "nothing to initialize" shape that stops anything calling into the image.
    view.setUint32(oh + 0x14, TEXT_RVA, true);                    // BaseOfCode
    view.setUint32(oh + 0x18, edataRva, true);                    // BaseOfData
    view.setUint32(oh + 0x1c, base >>> 0, true);                  // ImageBase
    view.setUint32(oh + 0x20, SECTION_ALIGNMENT, true);
    view.setUint32(oh + 0x24, FILE_ALIGNMENT, true);
    view.setUint16(oh + 0x28, 4, true);                           // MajorOperatingSystemVersion
    view.setUint16(oh + 0x30, 4, true);                           // MajorSubsystemVersion
    view.setUint32(oh + 0x38, imageSize, true);                   // SizeOfImage
    view.setUint32(oh + 0x3c, SIZE_OF_HEADERS, true);
    view.setUint16(oh + 0x44, IMAGE_SUBSYSTEM_WINDOWS_GUI, true);
    view.setUint32(oh + 0x5c, 16, true);                          // NumberOfRvaAndSizes
    view.setUint32(oh + 0x60, exports.length > 0 ? edataRva : 0, true);   // DataDirectory[EXPORT].VirtualAddress
    view.setUint32(oh + 0x64, exports.length > 0 ? edataSize : 0, true);  // DataDirectory[EXPORT].Size

    writeSection(view, bytes, SECTION_TABLE_OFFSET, ".text", TEXT_RVA, textSize,
        IMAGE_SCN_CNT_CODE | IMAGE_SCN_MEM_EXECUTE | IMAGE_SCN_MEM_READ);
    writeSection(view, bytes, SECTION_TABLE_OFFSET + SIZEOF_SECTION_HEADER, ".edata", edataRva, edataSize,
        IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ);

    // EAT index (0-based, AddressOfFunctions slot) for export i — its assigned ordinal
    // (declared or synthesized, see planOrdinals) biased by Base.
    const eatIndexOf = (i: number): number => ordinalPlan.assigned[i] - ordinalPlan.base;

    const exportAddresses = new Map<string, number>();
    const ordinalAddresses = new Map<number, number>();
    for (let i = 0; i < exports.length; i++) {
        // Stub BODIES stay packed sequentially in .text regardless of ordinal — only the
        // EAT's RVA slot (below) depends on it.
        const rva = TEXT_RVA + i * STUB_SIZE;
        bytes.set(exports[i].code.subarray(0, STUB_SIZE), rva);
        // Several names may alias one declared ordinal; the EAT and every name must agree.
        const target = ordinalPlan.slotToExportIndex[eatIndexOf(i)];
        exportAddresses.set(exports[i].name, (base + TEXT_RVA + target * STUB_SIZE) >>> 0);
    }
    for (let slot = 0; slot < ordinalPlan.numberOfFunctions; slot++) {
        const exportIndex = ordinalPlan.slotToExportIndex[slot];
        // A gap (an ordinal nothing declares) gets a zero RVA, same as a real PE's unused
        // EAT slot — never another export's address, which is what sequential assignment
        // handed out for every ordinal after the first gap.
        const rva = exportIndex >= 0 ? TEXT_RVA + exportIndex * STUB_SIZE : 0;
        view.setUint32(functionsRva + slot * 4, rva, true);
        if (exportIndex >= 0) ordinalAddresses.set(ordinalPlan.base + slot, (base + rva) >>> 0);
    }

    if (exports.length > 0) {
        view.setUint32(edataRva + 0x0c, dllNameRva, true);                   // Name
        view.setUint32(edataRva + 0x10, ordinalPlan.base, true);             // Base (first ordinal)
        view.setUint32(edataRva + 0x14, ordinalPlan.numberOfFunctions, true); // NumberOfFunctions
        view.setUint32(edataRva + 0x18, exports.length, true);               // NumberOfNames
        view.setUint32(edataRva + 0x1c, functionsRva, true);
        view.setUint32(edataRva + 0x20, namesRva, true);
        view.setUint32(edataRva + 0x24, ordinalsRva, true);

        const order = exports.map((e, i) => i).sort((a, b) =>
            exports[a].name < exports[b].name ? -1 : exports[a].name > exports[b].name ? 1 : 0);
        for (let slot = 0; slot < order.length; slot++) {
            const i = order[slot];
            view.setUint32(namesRva + slot * 4, nameRvas[i], true);
            view.setUint16(ordinalsRva + slot * 2, eatIndexOf(i), true);   // biased by Base, so 0-based
            bytes.set(nameBytes[i], nameRvas[i]);
        }
        bytes.set(dllNameBytes, dllNameRva);
    }

    return { bytes, exportAddresses, ordinalAddresses, textBase: (base + TEXT_RVA) >>> 0 };
}

function writeSection(
    view: DataView, bytes: Uint8Array, offset: number,
    name: string, rva: number, size: number, characteristics: number,
): void {
    for (let i = 0; i < Math.min(name.length, 8); i++) bytes[offset + i] = name.charCodeAt(i);
    view.setUint32(offset + 8, size, true);      // VirtualSize
    view.setUint32(offset + 12, rva, true);      // VirtualAddress
    view.setUint32(offset + 16, size, true);     // SizeOfRawData
    view.setUint32(offset + 20, rva, true);      // PointerToRawData — mapped image, so == RVA
    view.setUint32(offset + 36, characteristics, true);
}

function asciiz(text: string): Uint8Array {
    const out = new Uint8Array(text.length + 1);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
}
