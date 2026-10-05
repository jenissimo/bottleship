/**
 * ZIP64 in the RUNTIME zip reader.
 *
 * A `.wgb` past 4 GiB (Assassin's Creed is 7.1 GiB) has 0xFFFFFFFF sentinels in its EOCD
 * and central directory, with the real values in the ZIP64 records. The writer
 * (tools/internal/zip-store-writer.ts) has always emitted them; `ZipArchive` could not
 * read them, so such a bundle failed at mount with no hint that size was the reason.
 *
 * The archives here are built byte-by-byte rather than by writing 4 GiB: the code under
 * test is the SENTINEL path, and a small archive carrying sentinels exercises exactly it.
 */
import { describe, expect, test } from 'bun:test';
import { BufferSource, ZipArchive } from '../../packages/formats/src/zip';

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

interface Member { name: string; data: Uint8Array }

/**
 * A store-only ZIP. `zip64` forces the sentinel spelling for the EOCD and for each
 * entry's local-header offset — the shape a >4 GiB archive has.
 */
function buildZip(members: Member[], zip64: boolean): Uint8Array {
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    let offset = 0;
    const central: Array<{ name: Uint8Array; size: number; offset: number }> = [];

    for (const m of members) {
        const name = enc.encode(m.name);
        const lfh = new Uint8Array(30 + name.length);
        const v = new DataView(lfh.buffer);
        v.setUint32(0, 0x04034b50, true);
        v.setUint16(4, zip64 ? 45 : 20, true);
        v.setUint32(18, m.data.length, true);
        v.setUint32(22, m.data.length, true);
        v.setUint16(26, name.length, true);
        lfh.set(name, 30);
        central.push({ name, size: m.data.length, offset });
        parts.push(lfh, m.data);
        offset += lfh.length + m.data.length;
    }

    const cdOffset = offset;
    for (const e of central) {
        const extra = zip64 ? 12 : 0;   // header(4) + 64-bit local-header offset(8)
        const cdh = new Uint8Array(46 + e.name.length + extra);
        const v = new DataView(cdh.buffer);
        v.setUint32(0, 0x02014b50, true);
        v.setUint16(4, zip64 ? 45 : 20, true);
        v.setUint16(6, zip64 ? 45 : 20, true);
        v.setUint32(20, e.size, true);
        v.setUint32(24, e.size, true);
        v.setUint16(28, e.name.length, true);
        v.setUint16(30, extra, true);
        v.setUint32(42, zip64 ? U32_MAX : e.offset, true);
        cdh.set(e.name, 46);
        if (zip64) {
            const p = 46 + e.name.length;
            v.setUint16(p, 0x0001, true);
            v.setUint16(p + 2, 8, true);
            v.setBigUint64(p + 4, BigInt(e.offset), true);
        }
        parts.push(cdh);
        offset += cdh.length;
    }
    const cdSize = offset - cdOffset;

    if (zip64) {
        const z = new Uint8Array(56);
        const zv = new DataView(z.buffer);
        zv.setUint32(0, 0x06064b50, true);
        zv.setBigUint64(4, 44n, true);
        zv.setUint16(12, 45, true);
        zv.setUint16(14, 45, true);
        zv.setBigUint64(24, BigInt(central.length), true);
        zv.setBigUint64(32, BigInt(central.length), true);
        zv.setBigUint64(40, BigInt(cdSize), true);
        zv.setBigUint64(48, BigInt(cdOffset), true);
        parts.push(z);
        const loc = new Uint8Array(20);
        const lv = new DataView(loc.buffer);
        lv.setUint32(0, 0x07064b50, true);
        lv.setBigUint64(8, BigInt(offset), true);
        lv.setUint32(16, 1, true);
        parts.push(loc);
        offset += 56 + 20;
    }

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, zip64 ? U16_MAX : central.length, true);
    ev.setUint16(10, zip64 ? U16_MAX : central.length, true);
    ev.setUint32(12, zip64 ? U32_MAX : cdSize, true);
    ev.setUint32(16, zip64 ? U32_MAX : cdOffset, true);
    parts.push(eocd);

    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
}

const MEMBERS: Member[] = [
    { name: 'manifest.json', data: new TextEncoder().encode('{"formatVersion":2}') },
    { name: 'rom/big.bin', data: new Uint8Array(4096).map((_, i) => i & 0xff) },
];

for (const zip64 of [false, true]) {
    describe(`ZipArchive (${zip64 ? 'ZIP64 sentinels' : 'plain'})`, () => {
        test('lists every entry', async () => {
            const a = new ZipArchive(new BufferSource(buildZip(MEMBERS, zip64)));
            await a.init();
            expect(a.listEntries().map((e) => e.name).sort()).toEqual(
                MEMBERS.map((m) => m.name).sort(),
            );
        });

        test('reads an entry back byte for byte', async () => {
            const a = new ZipArchive(new BufferSource(buildZip(MEMBERS, zip64)));
            await a.init();
            const entry = a.getEntry('rom/big.bin')!;
            expect(entry.uncompressedSize).toBe(4096);
            expect(Array.from(await a.readEntry(entry))).toEqual(Array.from(MEMBERS[1]!.data));
        });
    });
}

describe('ZipArchive rejects a broken ZIP64 archive', () => {
    test('sentinels with no locator are refused, not read as offset 0', async () => {
        const bytes = buildZip(MEMBERS, true);
        // Corrupt the locator signature: the EOCD still says "look in ZIP64".
        const locOffset = bytes.length - 22 - 20;
        new DataView(bytes.buffer).setUint32(locOffset, 0xdeadbeef, true);
        const a = new ZipArchive(new BufferSource(bytes));
        await expect(a.init()).rejects.toThrow(/ZIP64 EOCD locator/);
    });
});
