/**
 * Base relocations of an image already copied to `mem` at `baseAddress`.
 *
 * A location is fixed up once, however many times the table names it. Windows maps a DLL at
 * its preferred ImageBase whenever that VA is free, so a linker that wrote its .reloc blocks
 * twice (old GNU ld does this) ships a DLL that works there and was never run rebased. Our
 * layout often cannot host the preferred base and has to rebase; applying the second copy
 * would add the delta twice and turn every absolute operand into a wild pointer. No image can
 * depend on a double fixup — it would be wrong at every base but the preferred one.
 */
export interface RelocationResult {
    applied: number;
    duplicates: number;
}

const IMAGE_REL_BASED_HIGHLOW = 3;

export function applyBaseRelocations(
    mem: Uint8Array,
    baseAddress: number,
    relocDirRVA: number,
    relocDirSize: number,
    delta: number,
): RelocationResult {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const fixed = new Set<number>();
    let applied = 0;
    let duplicates = 0;
    let blockOffset = relocDirRVA;
    const relocEnd = relocDirRVA + relocDirSize;

    while (blockOffset < relocEnd) {
        const blockAddr = baseAddress + blockOffset;
        if (blockAddr + 8 > mem.length) break;
        const pageRVA = view.getUint32(blockAddr, true);
        const blockSize = view.getUint32(blockAddr + 4, true);
        if (blockSize < 8) break;

        const entryCount = (blockSize - 8) >>> 1;
        for (let i = 0; i < entryCount; i++) {
            const entryOffset = blockAddr + 8 + i * 2;
            if (entryOffset + 2 > mem.length) break;
            const entry = view.getUint16(entryOffset, true);
            if ((entry >>> 12) !== IMAGE_REL_BASED_HIGHLOW) continue;
            const rva = pageRVA + (entry & 0xfff);
            const targetAddr = baseAddress + rva;
            if (targetAddr + 4 > mem.length) continue;
            if (fixed.has(rva)) {
                duplicates++;
                continue;
            }
            fixed.add(rva);
            view.setUint32(targetAddr, (view.getUint32(targetAddr, true) + delta) >>> 0, true);
            applied++;
        }
        blockOffset += blockSize;
    }
    return { applied, duplicates };
}
