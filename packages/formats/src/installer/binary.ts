import { Crc32 } from '../unpack/checksums';

export class BinaryReader {
    readonly view: DataView;
    pos = 0;
    constructor(readonly bytes: Uint8Array, readonly label: string) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    check(offset: number, size: number): void {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > this.bytes.length) {
            throw new Error(`${this.label}: invalid extent ${offset}+${size}`);
        }
    }
    skip(size: number): void { this.check(this.pos, size); this.pos += size; }
    u8(): number { this.check(this.pos, 1); return this.bytes[this.pos++]; }
    u16(): number { this.check(this.pos, 2); const n = this.view.getUint16(this.pos, true); this.pos += 2; return n; }
    u32(): number { this.check(this.pos, 4); const n = this.view.getUint32(this.pos, true); this.pos += 4; return n; }
    text(size: number): string {
        this.check(this.pos, size);
        const s = new TextDecoder('windows-1252').decode(this.bytes.subarray(this.pos, this.pos + size));
        this.pos += size;
        return s.replace(/\0.*$/s, '');
    }
    string16(): string { return this.text(this.u16()); }
}

export function crc32(bytes: Uint8Array): number { const c = new Crc32(); c.update(bytes); return c.finalize(); }

export function payloadPath(name: string): string {
    const path = name.replace(/\\/g, '/');
    if (!path || path.includes('\0') || path.startsWith('/') || path.includes(':') || path.split('/').includes('..')) {
        throw new Error(`Unsafe installer path: ${JSON.stringify(name)}`);
    }
    const normalized = path.split('/').filter(p => p && p !== '.').join('/');
    if (!normalized) throw new Error('Empty installer path');
    return normalized;
}

export function peOverlay(bytes: Uint8Array): number | null {
    if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return null;
    const r = new BinaryReader(bytes, 'PE');
    const pe = r.view.getUint32(60, true);
    r.check(pe, 24);
    if (r.view.getUint32(pe, true) !== 0x4550) return null;
    const count = r.view.getUint16(pe + 6, true);
    const start = pe + 24 + r.view.getUint16(pe + 20, true);
    r.check(start, count * 40);
    let end = start + count * 40;
    for (let i = 0; i < count; i++) {
        const p = start + i * 40;
        const size = r.view.getUint32(p + 16, true), offset = r.view.getUint32(p + 20, true);
        r.check(offset, size);
        end = Math.max(end, offset + size);
    }
    return end;
}

/**
 * File extent of an Authenticode signature (the security data directory, whose address is a
 * FILE offset, not an RVA), or null when the image carries none. Signing appends it after
 * any overlay, so an overlay format that runs "to EOF" really runs to this offset.
 */
export function peCertificateTable(bytes: Uint8Array): { offset: number; size: number } | null {
    if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pe = view.getUint32(60, true);
    if (pe + 24 + 2 > bytes.length || view.getUint32(pe, true) !== 0x4550) return null;
    const opt = pe + 24;
    const magic = view.getUint16(opt, true);
    const dirs = magic === 0x10b ? opt + 96 : magic === 0x20b ? opt + 112 : -1;
    if (dirs < 0 || dirs + 5 * 8 > bytes.length || view.getUint32(dirs - 4, true) < 5) return null;
    const offset = view.getUint32(dirs + 4 * 8, true), size = view.getUint32(dirs + 4 * 8 + 4, true);
    if (!offset || !size || offset + size > bytes.length) return null;
    return { offset, size };
}
