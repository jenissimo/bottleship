/**
 * Build a PE32 file view of the linked image for WebWindows' wwt_translate_pe C ABI.
 * The compiler is WebWindows, distributed under MIT OR Apache-2.0.
 * Loading, relocation and imports remain owned by BottleShip's PE loader.
 */
const MAX_FILE_SIZE = 32 << 20;
const IMAGE_FILE_MACHINE_I386 = 0x14c;
const EXECUTE = 0x20000000;
const IMPORT_DIRECTORY = 1;
const SECURITY_DIRECTORY = 4;
const BOUND_IMPORT_DIRECTORY = 11;

function align(value: number, alignment: number): number {
    return Math.ceil(value / alignment) * alignment;
}

export function packMappedPe(image: Uint8Array, originalFile: Uint8Array, imageBase: number): Uint8Array<ArrayBuffer> {
    if (originalFile.length < 64 || originalFile.length > MAX_FILE_SIZE ||
        image.length > MAX_FILE_SIZE || imageBase % 0x10000 !== 0 ||
        imageBase < 0x10000 || imageBase + image.length > 2 ** 32) {
        throw new Error("Unsupported AOT image size or address");
    }

    const original = new DataView(originalFile.buffer, originalFile.byteOffset, originalFile.byteLength);
    const pe = original.getUint32(0x3c, true);
    if (original.getUint16(0, true) !== 0x5a4d || pe + 24 > originalFile.length ||
        original.getUint32(pe, true) !== 0x4550 || original.getUint16(pe + 4, true) !== IMAGE_FILE_MACHINE_I386) {
        throw new Error("Expected an i386 PE image");
    }
    const sectionCount = original.getUint16(pe + 6, true);
    const optionalSize = original.getUint16(pe + 20, true);
    const optional = pe + 24;
    const sectionTable = optional + optionalSize;
    const headerEnd = sectionTable + sectionCount * 40;
    if (!sectionCount || optionalSize < 96 || headerEnd > originalFile.length ||
        original.getUint16(optional, true) !== 0x10b) throw new Error("Incomplete PE32 headers");

    const alignment = original.getUint32(optional + 36, true);
    if (alignment < 0x200 || alignment > 0x10000 || (alignment & (alignment - 1)) !== 0) {
        throw new Error("Unsupported PE file alignment");
    }
    const headerLength = align(Math.max(headerEnd, original.getUint32(optional + 60, true)), alignment);
    if (headerLength > image.length || headerLength > MAX_FILE_SIZE) throw new Error("Invalid AOT header range");
    let cursor = headerLength;
    const sections: { header: number; address: number; length: number; fileOffset: number; fileLength: number }[] = [];
    for (let i = 0; i < sectionCount; i++) {
        const at = sectionTable + i * 40;
        const virtualSize = original.getUint32(at + 8, true);
        const address = original.getUint32(at + 12, true);
        const rawSize = original.getUint32(at + 16, true);
        const executable = (original.getUint32(at + 36, true) & EXECUTE) !== 0;
        const originalLength = executable ? Math.max(virtualSize, rawSize) : rawSize;
        if (originalLength && address >= image.length) throw new Error("AOT section is outside mapped RAM");
        const length = Math.min(originalLength, image.length - address);
        if (length <= 0) continue;
        const fileLength = align(length, alignment);
        sections.push({ header: at, address, length, fileOffset: cursor, fileLength });
        cursor += fileLength;
        if (cursor > MAX_FILE_SIZE) throw new Error("AOT packed PE exceeds the size limit");
    }

    const packed = new Uint8Array(cursor);
    packed.set(originalFile.subarray(0, Math.min(headerEnd, originalFile.length)));
    const header = new DataView(packed.buffer);
    header.setUint32(optional + 28, imageBase, true);
    header.setUint32(optional + 56, image.length, true);
    header.setUint32(optional + 60, headerLength, true);
    header.setUint32(optional + 64, 0, true); // CheckSum
    // The linked IAT may also have been the lookup table. Keep its linked bytes
    // for code discovery, without attempting to parse them as import names.
    const directoryCount = Math.min(original.getUint32(optional + 92, true), (optionalSize - 96) >>> 3);
    for (const directory of [IMPORT_DIRECTORY, SECURITY_DIRECTORY, BOUND_IMPORT_DIRECTORY]) {
        if (directory >= directoryCount) continue;
        header.setUint32(optional + 96 + directory * 8, 0, true);
        header.setUint32(optional + 100 + directory * 8, 0, true);
    }
    for (let i = 0; i < sectionCount; i++) {
        const at = sectionTable + i * 40;
        header.setUint32(at + 16, 0, true);
        header.setUint32(at + 20, 0, true);
    }
    for (const section of sections) {
        packed.set(image.subarray(section.address, section.address + section.length), section.fileOffset);
        header.setUint32(section.header + 16, section.fileLength, true);
        header.setUint32(section.header + 20, section.fileOffset, true);
    }
    return packed;
}
