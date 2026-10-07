import { BinaryReader, payloadPath } from '../installer/binary';
import { explode } from '../mpq/explode';

export interface InstallShield3Entry { name: string; packedSize: number; unpackedSize: number; dataOffset: number; }
export interface InstallShield3Archive { entries: InstallShield3Entry[]; directories: string[]; }

export function isInstallShield3(bytes: Uint8Array): boolean {
    return bytes.length >= 255 && bytes[0] === 0x13 && bytes[1] === 0x5d && bytes[2] === 0x65 && bytes[3] === 0x8c;
}

/** InstallShield 3's Stirling table groups file records by directory; payloads use PKWARE DCL. */
export function parseInstallShield3(bytes: Uint8Array): InstallShield3Archive {
    if (!isInstallShield3(bytes)) throw new Error('Not an InstallShield 3 archive');
    const r = new BinaryReader(bytes, 'InstallShield 3');
    const count = r.view.getUint16(12, true), directoryCount = r.view.getUint16(49, true);
    const table = r.view.getUint32(41, true);
    if (r.view.getUint32(18, true) !== bytes.length || table < 255) throw new Error('InstallShield 3: split/truncated archive');
    r.pos = table;
    const groups: { name: string; count: number }[] = [];
    for (let i = 0; i < directoryCount; i++) {
        const start = r.pos, files = r.u16(), size = r.u16(), length = r.u16();
        if (size < 6 || length > size - 6) throw new Error('InstallShield 3: invalid directory record');
        r.check(start, size);
        const name = r.text(length);
        groups.push({ name: name ? payloadPath(name) : '', count: files });
        r.pos = start + size;
    }
    if (groups.reduce((n, g) => n + g.count, 0) !== count) throw new Error('InstallShield 3: directory/file count mismatch');
    const entries: InstallShield3Entry[] = [];
    for (const group of groups) for (let i = 0; i < group.count; i++) {
        const p = r.pos;
        r.check(p, 30);
        const size = r.view.getUint16(p + 23, true), length = bytes[p + 29];
        if (size < 30 + length) throw new Error('InstallShield 3: invalid file record');
        r.check(p, size);
        r.pos = p + 30;
        const name = payloadPath([group.name, r.text(length)].filter(Boolean).join('/'));
        const packedSize = r.view.getUint32(p + 7, true), unpackedSize = r.view.getUint32(p + 3, true);
        const dataOffset = r.view.getUint32(p + 11, true);
        if (dataOffset < 255 || dataOffset + packedSize > table) throw new Error(`InstallShield 3: invalid payload ${name}`);
        entries.push({ name, packedSize, unpackedSize, dataOffset });
        r.pos = p + size;
    }
    return { entries, directories: groups.map(g => g.name).filter(Boolean) };
}

export function extractInstallShield3(bytes: Uint8Array): Map<string, Uint8Array> {
    const archive = parseInstallShield3(bytes), out = new Map<string, Uint8Array>();
    const names = new Set<string>();
    for (const dir of archive.directories) out.set(`${dir}/`, new Uint8Array(0));
    for (const e of archive.entries) {
        const key = e.name.toLowerCase();
        if (names.has(key) || e.unpackedSize > 512 * 1024 * 1024) throw new Error(`InstallShield 3: duplicate/oversize file ${e.name}`);
        names.add(key);
        const input = bytes.subarray(e.dataOffset, e.dataOffset + e.packedSize);
        out.set(e.name, e.unpackedSize === 0 ? new Uint8Array(0) : explode(input, e.unpackedSize));
    }
    return out;
}
