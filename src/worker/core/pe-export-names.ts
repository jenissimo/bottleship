/**
 * Ordinal → export name, read from a real PE image's export directory.
 *
 * A thunked module can be imported by ordinal only. Ordinals are private to one build of a
 * DLL (SMACKW32.DLL, for one, renumbered its exports between releases), so a single static
 * `ordinal:` table in a descriptor binds the wrong function for every other build. When the
 * bundle ships the DLL, its own export directory is the authority: the ordinal maps to the
 * name that build exports, and the import then binds through our name-based descriptors.
 */

export interface ExportNameDirectory {
    /** IMAGE_FILE_HEADER.TimeDateStamp of the image the names were read from. */
    timeDateStamp: number;
    ordinalBase: number;
    /** Biased ordinal → exported name, as spelled in the directory. */
    names: Map<number, string>;
}

function rvaToOffset(view: DataView, e_lfanew: number, rva: number): number | null {
    const numberOfSections = view.getUint16(e_lfanew + 6, true);
    const sizeOfOptionalHeader = view.getUint16(e_lfanew + 20, true);
    const sectionTable = e_lfanew + 24 + sizeOfOptionalHeader;
    for (let i = 0; i < numberOfSections; i++) {
        const p = sectionTable + i * 40;
        if (p + 40 > view.byteLength) return null;
        const virtualSize = view.getUint32(p + 8, true);
        const virtualAddress = view.getUint32(p + 12, true);
        const rawSize = view.getUint32(p + 16, true);
        const rawPtr = view.getUint32(p + 20, true);
        const size = Math.max(virtualSize, rawSize);
        if (rva >= virtualAddress && rva < virtualAddress + size) return rawPtr + (rva - virtualAddress);
    }
    const sizeOfHeaders = view.getUint32(e_lfanew + 24 + 60, true);
    return rva < sizeOfHeaders ? rva : null;
}

/**
 * Parse the export directory of a PE file image (file layout, not mapped). Returns null
 * for anything that is not a well-formed PE32 image with an export directory; a truncated
 * or hostile file yields null or only the names that lie fully inside the buffer.
 */
export function readExportNameDirectory(image: Uint8Array): ExportNameDirectory | null {
    if (image.length < 0x40) return null;
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    if (view.getUint16(0, true) !== 0x5A4D) return null;
    const e_lfanew = view.getUint32(0x3C, true);
    if (e_lfanew + 24 + 104 > image.length || view.getUint32(e_lfanew, true) !== 0x00004550) return null;
    const optionalHeader = e_lfanew + 24;
    if (view.getUint16(optionalHeader, true) !== 0x10B) return null;
    const exportRva = view.getUint32(optionalHeader + 96, true);
    if (exportRva === 0) return null;
    const dir = rvaToOffset(view, e_lfanew, exportRva);
    if (dir === null || dir + 40 > image.length) return null;

    const ordinalBase = view.getUint32(dir + 16, true);
    const numberOfFunctions = view.getUint32(dir + 20, true);
    const numberOfNames = view.getUint32(dir + 24, true);
    const namesOffset = rvaToOffset(view, e_lfanew, view.getUint32(dir + 32, true));
    const nameOrdinalsOffset = rvaToOffset(view, e_lfanew, view.getUint32(dir + 36, true));
    const names = new Map<number, string>();
    if (namesOffset !== null && nameOrdinalsOffset !== null) {
        for (let i = 0; i < numberOfNames; i++) {
            if (namesOffset + i * 4 + 4 > image.length || nameOrdinalsOffset + i * 2 + 2 > image.length) break;
            const index = view.getUint16(nameOrdinalsOffset + i * 2, true);
            if (index >= numberOfFunctions) continue;
            const nameOffset = rvaToOffset(view, e_lfanew, view.getUint32(namesOffset + i * 4, true));
            if (nameOffset === null) continue;
            let end = nameOffset;
            while (end < image.length && image[end] !== 0) end++;
            if (end >= image.length) continue;
            let name = '';
            for (let j = nameOffset; j < end; j++) name += String.fromCharCode(image[j]);
            if (name) names.set(ordinalBase + index, name);
        }
    }
    return { timeDateStamp: view.getUint32(e_lfanew + 8, true), ordinalBase, names };
}

/**
 * Ordinal → name maps of the DLLs a process actually ships, keyed by module base name.
 * Filled while imports are bound, so GetProcAddress by ordinal on the same module agrees
 * with the import walk.
 */
export class ShippedExportNames {
    private readonly byModule = new Map<string, ExportNameDirectory>();

    set(moduleName: string, directory: ExportNameDirectory): void {
        this.byModule.set(normalize(moduleName), directory);
    }

    get(moduleName: string): ExportNameDirectory | undefined {
        return this.byModule.get(normalize(moduleName));
    }

    nameOf(moduleName: string, ordinal: number): string | undefined {
        return this.byModule.get(normalize(moduleName))?.names.get(ordinal);
    }

    clear(): void {
        this.byModule.clear();
    }
}

function normalize(moduleName: string): string {
    const base = moduleName.replace(/^.*[\\/]/, '').toLowerCase();
    return base.endsWith('.dll') ? base.slice(0, -4) : base;
}

export const shippedExportNames = new ShippedExportNames();

/**
 * Give every ordinal-only import the name the shipped DLL exports for that ordinal, when
 * our descriptors implement that name. Imports whose name we do not implement, and every
 * import when no directory is known, are left untouched (they keep binding as `ord_N`).
 * Returns the imports that were named.
 */
export function nameOrdinalImports(
    functions: Array<{ name?: string; ordinal?: number }>,
    directory: ExportNameDirectory,
    isImplemented: (name: string) => boolean,
): Array<{ ordinal: number; name: string }> {
    const named: Array<{ ordinal: number; name: string }> = [];
    for (const f of functions) {
        if (f.name !== undefined || f.ordinal === undefined) continue;
        const name = directory.names.get(f.ordinal);
        if (name === undefined || !isImplemented(name)) continue;
        f.name = name;
        named.push({ ordinal: f.ordinal, name });
    }
    return named;
}
