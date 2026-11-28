const SECTOR_SIZE = 512;
const MINI_SECTOR_SIZE = 64;
const MINI_CUTOFF = 4096;
const FAT_ENTRIES = SECTOR_SIZE / 4;
const HEADER_FAT_ENTRIES = 109;
const END = 0xfffffffe;
const FREE = 0xffffffff;
const FAT = 0xfffffffd;
const DIFAT = 0xfffffffc;

export function compoundNameKey(name: string): string {
    return name.toUpperCase();
}

export function isCompoundStreamName(name: string): boolean {
    return name.length > 0 && name.length <= 31 && !/[\\/:!\x00]/.test(name);
}

interface DirectoryEntry {
    name: string;
    bytes: Uint8Array;
    first: number;
    left: number;
    right: number;
    red: boolean;
}

function linkDirectoryTree(entries: DirectoryEntry[], low: number, high: number, depth: number, lastDepth: number): number {
    if (low >= high) return FREE;
    const id = Math.floor((low + high) / 2);
    const entry = entries[id]!;
    entry.left = linkDirectoryTree(entries, low, id, depth + 1, lastDepth);
    entry.right = linkDirectoryTree(entries, id + 1, high, depth + 1, lastDepth);
    entry.red = depth > 0 && depth === lastDepth;
    return id + 1;
}

function writeChain(table: DataView, start: number, count: number): void {
    for (let i = 0; i < count; i++) table.setUint32((start + i) * 4, i + 1 === count ? END : start + i + 1, true);
}

export function writeCompoundStreams(streams: ReadonlyMap<string, Uint8Array>): Uint8Array {
    const seen = new Set<string>();
    const entries = Array.from(streams, ([name, bytes]): DirectoryEntry => {
        const key = compoundNameKey(name);
        if (!isCompoundStreamName(name) || seen.has(key)) throw new Error('Invalid or duplicate CFB stream name');
        seen.add(key);
        return {name, bytes, first: END, left: FREE, right: FREE, red: false};
    });
    entries.sort((a, b) => {
        const left = compoundNameKey(a.name);
        const right = compoundNameKey(b.name);
        return a.name.length - b.name.length || Number(left > right) - Number(left < right);
    });

    let standardSectors = 0;
    let miniSectors = 0;
    for (const entry of entries) {
        if (!entry.bytes.length) continue;
        if (entry.bytes.length < MINI_CUTOFF) {
            entry.first = miniSectors;
            miniSectors += Math.ceil(entry.bytes.length / MINI_SECTOR_SIZE);
        } else {
            entry.first = standardSectors;
            standardSectors += Math.ceil(entry.bytes.length / SECTOR_SIZE);
        }
    }

    const miniBytes = miniSectors * MINI_SECTOR_SIZE;
    const miniStreamSectors = Math.ceil(miniBytes / SECTOR_SIZE);
    const miniFatSectors = Math.ceil(miniSectors / FAT_ENTRIES);
    const miniStreamStart = standardSectors;
    const miniFatStart = miniStreamStart + miniStreamSectors;
    const directoryStart = miniFatStart + miniFatSectors;
    const directorySectors = Math.ceil((entries.length + 1) * 128 / SECTOR_SIZE);
    const fatStart = directoryStart + directorySectors;
    let fatSectors = Math.ceil(fatStart / FAT_ENTRIES);
    let difatSectors = 0;
    for (;;) {
        const nextDifat = Math.max(0, Math.ceil((fatSectors - HEADER_FAT_ENTRIES) / (FAT_ENTRIES - 1)));
        const nextFat = Math.ceil((fatStart + fatSectors + nextDifat) / FAT_ENTRIES);
        if (nextFat === fatSectors && nextDifat === difatSectors) break;
        fatSectors = nextFat;
        difatSectors = nextDifat;
    }
    const difatStart = fatStart + fatSectors;
    const sectorOffset = (id: number): number => (id + 1) * SECTOR_SIZE;
    const bytes = new Uint8Array(sectorOffset(difatStart + difatSectors));
    const view = new DataView(bytes.buffer);
    const table = (start: number, count: number): DataView => {
        bytes.fill(0xff, sectorOffset(start), sectorOffset(start + count));
        return new DataView(bytes.buffer, sectorOffset(start), count * SECTOR_SIZE);
    };
    const fat = table(fatStart, fatSectors);
    const miniFat = table(miniFatStart, miniFatSectors);

    view.setUint32(0, 0xe011cfd0, true);
    view.setUint32(4, 0xe11ab1a1, true);
    view.setUint16(24, 0x003e, true);
    view.setUint16(26, 3, true);
    view.setUint16(28, 0xfffe, true);
    view.setUint16(30, 9, true);
    view.setUint16(32, 6, true);
    view.setUint32(44, fatSectors, true);
    view.setUint32(48, directoryStart, true);
    view.setUint32(56, MINI_CUTOFF, true);
    view.setUint32(60, miniFatSectors ? miniFatStart : END, true);
    view.setUint32(64, miniFatSectors, true);
    view.setUint32(68, difatSectors ? difatStart : END, true);
    view.setUint32(72, difatSectors, true);
    for (let i = 0; i < HEADER_FAT_ENTRIES; i++) {
        view.setUint32(76 + i * 4, i < fatSectors ? fatStart + i : FREE, true);
    }
    for (let i = 0; i < difatSectors; i++) {
        const offset = sectorOffset(difatStart + i);
        for (let j = 0; j < FAT_ENTRIES - 1; j++) {
            const index = HEADER_FAT_ENTRIES + i * (FAT_ENTRIES - 1) + j;
            view.setUint32(offset + j * 4, index < fatSectors ? fatStart + index : FREE, true);
        }
        view.setUint32(offset + SECTOR_SIZE - 4, i + 1 < difatSectors ? difatStart + i + 1 : END, true);
        fat.setUint32((difatStart + i) * 4, DIFAT, true);
    }
    for (let i = 0; i < fatSectors; i++) fat.setUint32((fatStart + i) * 4, FAT, true);

    for (const entry of entries) {
        const length = entry.bytes.length;
        if (length === 0) continue;
        if (length < MINI_CUTOFF) {
            bytes.set(entry.bytes, sectorOffset(miniStreamStart) + entry.first * MINI_SECTOR_SIZE);
            writeChain(miniFat, entry.first, Math.ceil(length / MINI_SECTOR_SIZE));
        } else {
            bytes.set(entry.bytes, sectorOffset(entry.first));
            writeChain(fat, entry.first, Math.ceil(length / SECTOR_SIZE));
        }
    }
    writeChain(fat, miniStreamStart, miniStreamSectors);
    writeChain(fat, miniFatStart, miniFatSectors);
    writeChain(fat, directoryStart, directorySectors);

    const rootChild = linkDirectoryTree(entries, 0, entries.length, 0, Math.floor(Math.log2(entries.length)));
    const directory = sectorOffset(directoryStart);
    const writeDirectoryEntry = (index: number, name: string, type: number, color: number,
                                 left: number, right: number, child: number, first: number, size: number): void => {
        const offset = directory + index * 128;
        for (let i = 0; i < name.length; i++) view.setUint16(offset + i * 2, name.charCodeAt(i), true);
        view.setUint16(offset + 64, name ? (name.length + 1) * 2 : 0, true);
        view.setUint8(offset + 66, type);
        view.setUint8(offset + 67, color);
        view.setUint32(offset + 68, left, true);
        view.setUint32(offset + 72, right, true);
        view.setUint32(offset + 76, child, true);
        view.setUint32(offset + 116, first, true);
        view.setUint32(offset + 120, size, true);
    };
    writeDirectoryEntry(0, 'Root Entry', 5, 1, FREE, FREE, rootChild, miniBytes ? miniStreamStart : END, miniBytes);
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        writeDirectoryEntry(i + 1, entry.name, 2, entry.red ? 0 : 1, entry.left, entry.right, FREE, entry.first, entry.bytes.length);
    }
    for (let i = entries.length + 1; i < directorySectors * 4; i++) {
        writeDirectoryEntry(i, '', 0, 0, FREE, FREE, FREE, 0, 0);
    }
    return bytes;
}
