import { BufferSource, ZipArchive } from '../zip';
import { Crc32 } from '../unpack/checksums';

function payloadPath(name: string): string {
    const path = name.replace(/\\/g, '/');
    if (!path || path.includes('\0') || path.startsWith('/') || path.includes(':') || path.split('/').includes('..'))
        throw new Error(`Unsafe installer path: ${JSON.stringify(name)}`);
    const normalized = path.split('/').filter(part => part && part !== '.').join('/');
    if (!normalized) throw new Error('Empty installer path');
    return normalized;
}

/** Early InstallShield NE self-extractors concatenate one complete ZIP per file. */
export function isInstallShieldSfx(bytes: Uint8Array): boolean {
    if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ne = view.getUint32(60, true);
    return ne + 2 <= bytes.length && view.getUint16(ne, true) === 0x454e
        && new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 65536)))
            .includes('InstallShield Self-Extracting Stub Program');
}

export async function extractInstallShieldSfx(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
    if (!isInstallShieldSfx(bytes)) throw new Error('Not an InstallShield NE self-extractor');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Map<string, Uint8Array>();
    const names = new Set<string>();
    let previousEnd = 0;
    for (let end = bytes.indexOf(0x50); end >= 0 && end + 22 <= bytes.length; end = bytes.indexOf(0x50, end + 1)) {
        if (view.getUint32(end, true) !== 0x06054b50) continue;
        const size = view.getUint32(end + 12, true), offset = view.getUint32(end + 16, true);
        const start = end - size - offset, finish = end + 22 + view.getUint16(end + 20, true);
        if (start < previousEnd || start < 0 || finish > bytes.length || size < 46) continue;
        if (view.getUint32(start, true) !== 0x04034b50 && view.getUint32(end - size, true) !== 0x02014b50) continue;
        if (view.getUint32(start, true) !== 0x04034b50 || view.getUint32(end - size, true) !== 0x02014b50)
            throw new Error('InstallShield SFX: damaged ZIP record');
        if (view.getUint32(end + 4, true) !== 0 || view.getUint16(end + 8, true) !== 1
            || view.getUint16(end + 10, true) !== 1) throw new Error('InstallShield SFX: expected one-file ZIP record');
        const archive = new ZipArchive(new BufferSource(bytes.subarray(start, finish)));
        await archive.init();
        const entries = archive.listEntries();
        if (entries.length !== 1 || entries[0]!.isDirectory) throw new Error('InstallShield SFX: invalid file record');
        const entry = entries[0]!, name = payloadPath(entry.name);
        if (names.has(name.toLowerCase())) throw new Error(`InstallShield SFX: duplicate file ${name}`);
        const data = await archive.readEntry(entry);
        const checksum = new Crc32();
        checksum.update(data);
        if (data.length !== entry.uncompressedSize || checksum.finalize() !== view.getUint32(end - size + 16, true))
            throw new Error(`InstallShield SFX: CRC mismatch for ${name}`);
        names.add(name.toLowerCase()); out.set(name, data); previousEnd = finish;
    }
    if (!out.size || previousEnd !== bytes.length) throw new Error('InstallShield SFX: missing or truncated final ZIP record');
    return out;
}
