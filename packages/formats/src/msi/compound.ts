/** Read-only Microsoft Compound File Binary (MS-CFB), including mini streams. */
const END = 0xfffffffe;
const FREE = 0xffffffff;

export function readCompoundStreams(bytes: Uint8Array): Map<string, Uint8Array> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 512 || view.getUint32(0, true) !== 0xe011cfd0 || view.getUint32(4, true) !== 0xe11ab1a1) {
        throw new Error('Not a Compound File Binary document');
    }
    const major = view.getUint16(26, true);
    const sectorSize = 2 ** view.getUint16(30, true);
    if (view.getUint16(28, true) !== 0xfffe || !((major === 3 && sectorSize === 512) || (major === 4 && sectorSize === 4096)) || view.getUint16(32, true) !== 6) {
        throw new Error('Unsupported CFB header');
    }
    const sectorCount = Math.ceil(bytes.length / sectorSize) - 1;
    const sector = (id: number): Uint8Array => {
        if (id >= sectorCount) throw new Error(`CFB sector outside file: ${id}`);
        return bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize);
    };
    const words = (data: Uint8Array): number[] => {
        if (data.length % 4) throw new Error('Truncated CFB allocation table');
        const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
        return Array.from({length: data.length / 4}, (_, i) => v.getUint32(i * 4, true));
    };
    const fatIds = Array.from({length: 109}, (_, i) => view.getUint32(76 + i * 4, true)).filter(id => id !== FREE);
    let difatId = view.getUint32(68, true);
    const seenDifat = new Set<number>();
    const difatCount = view.getUint32(72, true);
    if (difatCount > sectorCount) throw new Error('CFB DIFAT count outside file');
    for (let i = 0; i < difatCount; i++) {
        if (seenDifat.has(difatId)) throw new Error('CFB cyclic DIFAT');
        seenDifat.add(difatId);
        const ids = words(sector(difatId));
        difatId = ids.pop()!;
        fatIds.push(...ids.filter(id => id !== FREE));
    }
    const fatCount = view.getUint32(44, true);
    if (fatCount > sectorCount || fatIds.length < fatCount || new Set(fatIds.slice(0, fatCount)).size !== fatCount) throw new Error('Invalid CFB FAT');
    const fat = fatIds.slice(0, fatCount).flatMap(id => words(sector(id)));
    const chain = (first: number, table: number[], unitSize: number, read: (id: number) => Uint8Array, size?: number): Uint8Array => {
        if (size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > bytes.length)) throw new Error('CFB stream size outside file');
        const parts: Uint8Array[] = [];
        const seen = new Set<number>();
        let id = first;
        while (id !== END) {
            if (id >= table.length || seen.has(id)) throw new Error('Invalid or cyclic CFB sector chain');
            seen.add(id); parts.push(read(id)); id = table[id]!;
        }
        const length = parts.length * unitSize;
        const available = parts.length ? (parts.length - 1) * unitSize + parts.at(-1)!.length : 0;
        if (size !== undefined && (size > length || length - size >= unitSize)) throw new Error('CFB stream length does not match sector chain');
        // Some installer databases omit unused padding at EOF. Stream bytes must still be present.
        if ((size ?? length) > available) throw new Error('Truncated CFB stream');
        const out = new Uint8Array(size ?? length);
        for (let i = 0; i < parts.length; i++) out.set(parts[i]!.subarray(0, Math.max(0, Math.min(unitSize, out.length - i * unitSize))), i * unitSize);
        return out;
    };
    const directory = chain(view.getUint32(48, true), fat, sectorSize, sector);
    const dv = new DataView(directory.buffer);
    const entries: Array<{name: string; type: number; first: number; size: number}> = [];
    for (let p = 0; p + 128 <= directory.length; p += 128) {
        const type = directory[p + 66]!;
        if (type !== 2 && type !== 5) continue;
        const nameSize = dv.getUint16(p + 64, true);
        if (nameSize < 2 || nameSize > 64 || nameSize % 2 || dv.getUint16(p + nameSize - 2, true) !== 0) throw new Error('Invalid CFB stream name');
        const size = Number(dv.getBigUint64(p + 120, true) & (major === 3 ? 0xffffffffn : 0xffffffffffffffffn));
        entries.push({name: new TextDecoder('utf-16le').decode(directory.subarray(p, p + nameSize - 2)), type, first: dv.getUint32(p + 116, true), size});
    }
    const root = entries.find(e => e.type === 5);
    if (!root) throw new Error('CFB root storage missing');
    const miniStream = root.size ? chain(root.first, fat, sectorSize, sector, root.size) : new Uint8Array();
    const miniFatCount = view.getUint32(64, true);
    const miniFat = miniFatCount ? words(chain(view.getUint32(60, true), fat, sectorSize, sector, miniFatCount * sectorSize)) : [];
    const cutoff = view.getUint32(56, true);
    if (cutoff !== 4096) throw new Error('Unsupported CFB mini stream cutoff');
    const streams = new Map<string, Uint8Array>();
    for (const entry of entries) {
        if (entry.type !== 2) continue;
        if (streams.has(entry.name)) throw new Error(`Ambiguous nested CFB stream: ${entry.name}`);
        const data = entry.size === 0 ? new Uint8Array() : entry.size < cutoff
            ? chain(entry.first, miniFat, 64, id => {
                if ((id + 1) * 64 > miniStream.length) throw new Error('CFB mini sector outside root stream');
                return miniStream.subarray(id * 64, (id + 1) * 64);
            }, entry.size)
            : chain(entry.first, fat, sectorSize, sector, entry.size);
        streams.set(entry.name, data);
    }
    return streams;
}
