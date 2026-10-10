import { expect, test } from 'bun:test';
import { deflateRawSync } from 'node:zlib';
import { crc32, payloadPath } from '../../packages/formats/src/installer/binary';
import { extractWise } from '@bottleship/formats/wise';
import { extractVise, parseVise } from '@bottleship/formats/vise';
import { extractInstallShield3 } from '@bottleship/formats/installshield3';
import { extractRar4, findRar4, parseRar4 } from '@bottleship/formats/rar';
import { BufferSource, UnpackDecoder } from '@bottleship/formats/unpack';
import { decodeRar29 } from '../../packages/formats/src/rar/lz29';
import { inflateRawSync, inflateViseSync } from '../../packages/formats/src/zip/inflate';
import { extractInstallerFromFiles } from '@bottleship/repack/container-extract';
import { detectSource } from '../../src/worker/runtime/filesystem/wgb-build';

const text = (s: string) => new TextEncoder().encode(s);
const u16 = (n: number) => [n & 255, (n >>> 8) & 255];
const u32 = (n: number) => [...u16(n), ...u16(n >>> 16)];
const zeros = (n: number) => new Array<number>(n).fill(0);
const str = (s: string) => [...u16(s.length), ...text(s)];
const set32 = (bytes: Uint8Array, at: number, n: number) => new DataView(bytes.buffer).setUint32(at, n, true);

class BitWriter {
    bits: number[] = [];
    put(value: number, count: number, msb = true) {
        for (let i = 0; i < count; i++) this.bits.push((value >>> (msb ? count - 1 - i : i)) & 1);
    }
    bytes(msb = true) {
        const out = new Uint8Array(Math.ceil(this.bits.length / 8));
        this.bits.forEach((b, i) => out[i >>> 3] |= b << (msb ? 7 - (i & 7) : i & 7));
        return out;
    }
}

// A fixed canonical transcript: BL symbols use five bits; literals use nine.
function rarLz(data: Uint8Array, match = false) {
    const w = new BitWriter();
    w.put(0, 2);
    for (let i = 0; i < 20; i++) w.put(5, 4);
    for (let i = 0; i < 404; i++) w.put(i < 299 ? 9 : i < 359 ? 6 : 5, 5);
    for (const byte of data) w.put(byte, 9);
    if (match) { w.put(271, 9); w.put(0, 6); } // three-byte match at distance one
    w.put(256, 9); w.put(0, 2);
    w.put(0, 16);
    return w.bytes();
}

function rarArchive(name = 'game.bin', data = text('archive test'), flags = 0x8000, compressed = false) {
    const block = (type: number, flags: number, body: number[]) => {
        const tail = new Uint8Array([type, ...u16(flags), ...u16(body.length + 7), ...body]);
        return [...u16(crc32(tail) & 65535), ...tail];
    };
    const packed = compressed ? rarLz(data) : data;
    return new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 7, 0,
        ...block(0x73, 0, zeros(6)),
        ...block(0x74, flags, [...u32(packed.length), ...u32(data.length), 2, ...u32(crc32(data)),
            ...u32(0), 29, compressed ? 0x33 : 0x30, ...u16(name.length), ...u32(0), ...text(name)]),
        ...packed, ...block(0x7b, 0, [])]);
}

test('RAR4 SFX offsets, stored/LZ bytes and CRC agree with the independent transcript', () => {
    const data = text('literal archive');
    for (const compressed of [false, true]) {
        const bytes = new Uint8Array([...zeros(64), ...rarArchive('game.bin', data, 0x8000, compressed)]);
        expect(findRar4(bytes)).toBe(64);
        expect(extractRar4(new BufferSource(bytes), 64).get('game.bin')).toEqual(data);
    }
    expect(decodeRar29(rarLz(text('A'), true), 4)).toEqual(text('AAAA'));
    expect(() => decodeRar29(rarLz(text('A'), true), 3)).toThrow('invalid match');
    expect(() => decodeRar29(rarLz(new Uint8Array(), true), 3)).toThrow('invalid match');
});

test('RAR4 rejects damaged headers, payloads, solid/encrypted files and unsafe paths', () => {
    const badHeader = rarArchive(); badHeader[10] ^= 1;
    expect(() => parseRar4(new BufferSource(badHeader))).toThrow('header CRC');
    const badData = rarArchive(); const e = parseRar4(new BufferSource(badData)).entries[0]; badData[e.dataOffset] ^= 1;
    expect(() => extractRar4(new BufferSource(badData))).toThrow('CRC');
    for (const flag of [4, 16, 1]) expect(() => extractRar4(new BufferSource(rarArchive('a', text('x'), flag | 0x8000)))).toThrow();
    expect(() => extractRar4(new BufferSource(rarArchive('../a')))).toThrow('Unsafe');
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
});

test('RAR PPMd/LZ table switches retain the model and unfiltered history (libarchive oracle)', async () => {
    const codec = new UnpackDecoder();
    await codec.init(await Bun.file(new URL('../../public/unpack-streaming.wasm', import.meta.url)).arrayBuffer());
    const bytes = new Uint8Array(await Bun.file(new URL('./fixtures/rar/ppm-lz.rar.bin', import.meta.url)).arrayBuffer());
    let blocks = 0, closes = 0;
    const files = extractRar4(new BufferSource(bytes), 0, { createPpmSession: input => {
        const session = codec.createRarPpmSession(input);
        return {
            decodeBlock: (offset, out, base) => { blocks++; return session.decodeBlock(offset, out, base); },
            close: () => { closes++; session.close(); },
        };
    } });
    const data = files.get('ppmd_lzss_conversion_test.txt')!;
    expect(data.length).toBe(241647978); expect(blocks).toBe(3); expect(closes).toBe(1);
    expect(new TextDecoder().decode(data.subarray(data.length - 42))).toBe('gin-bottom: 0in"><BR>\n</P>\n</BODY>\n</HTML>');
    const invalid = codec.createRarPpmSession(new Uint8Array([0xa7, 255, 0, 0, 0, 0]));
    try { expect(() => invalid.decodeBlock(0, new Uint8Array(10), 0)).toThrow('model size'); }
    finally { invalid.close(); }
});

function dcl(data: Uint8Array) {
    const w = new BitWriter(); w.put(0, 8, false); w.put(4, 8, false);
    for (const byte of data) { w.put(0, 1, false); w.put(byte, 8, false); }
    w.put(1, 1, false); w.put(0, 7, false); w.put(255, 8, false);
    return w.bytes(false);
}

function is3(data = text('DCL literal payload'), filename = 'a.bin') {
    const packed = dcl(data), table = 255 + packed.length;
    const file = new Uint8Array(30 + filename.length);
    set32(file, 3, data.length); set32(file, 7, packed.length); set32(file, 11, 255);
    new DataView(file.buffer).setUint16(23, file.length, true); file[29] = filename.length; file.set(text(filename), 30);
    const dirs = [1, 0, 6, 0, 0, 0, 0, 0, 10, 0, 4, 0, ...text('save')];
    const bytes = new Uint8Array([...zeros(255), ...packed, ...dirs, ...file]);
    bytes.set([0x13, 0x5d, 0x65, 0x8c]); bytes[12] = 1; bytes[49] = 2;
    set32(bytes, 18, bytes.length); set32(bytes, 41, table);
    return bytes;
}

test('InstallShield 3 reconstructs files and empty directories, rejects count/extent errors', () => {
    const bytes = is3(), files = extractInstallShield3(bytes);
    expect(files.get('a.bin')).toEqual(text('DCL literal payload'));
    expect(files.has('save/')).toBe(true); expect(files.size).toBe(2);
    const bad = bytes.slice(); bad[12] = 2;
    expect(() => extractInstallShield3(bad)).toThrow('count mismatch');
    expect(() => extractInstallShield3(bytes.subarray(0, bytes.length - 1))).toThrow('truncated');
    expect(() => extractInstallShield3(is3(text('x'), '../escape'))).toThrow('Unsafe');
});

function viseStored(data: Uint8Array) {
    return new Uint8Array([1, 0, ...u16(data.length), ...u16(~data.length), ...data, ...(data.length & 1 ? [0] : [])]);
}
const swapWords = (b: Uint8Array) => { const out = b.slice(); for (let i = 0; i + 1 < out.length; i += 2) [out[i], out[i + 1]] = [out[i + 1], out[i]]; return out; };

function vise(data = text('VISE odd text')) {
    const compressed = swapWords(viseStored(data));
    const service = [1, 0, 1, 0x68, ...zeros(12), ...u32(compressed.length), ...compressed];
    const folder = [...u32(1), ...u32(1), ...zeros(96), ...str('Bin'), ...zeros(25)];
    const file = [...u32(2), ...u32(2), ...u32(1), ...zeros(92), ...str('a.bin'), ...zeros(4),
        ...u32(data.length), ...u32(compressed.length), ...zeros(4)];
    const offsetAt = file.length; file.push(...zeros(4), ...zeros(37), ...str(''), ...zeros(14), ...u32(crc32(data)), ...zeros(22));
    const header = [...text('ESIV'), ...zeros(12), 0, ...service, ...zeros(4), ...str(''), ...str(''), ...zeros(2),
        ...str(''), ...str(''), ...zeros(2), ...u32(0), 0, ...zeros(16), ...service, ...zeros(2), ...u32(2), ...folder];
    const offset = header.length + file.length;
    const bytes = new Uint8Array([...header, ...file, ...compressed, ...text('ESIV'), ...u32(0)]);
    set32(bytes, header.length + offsetAt, offset);
    return bytes;
}

test('VISE word alignment and odd padding differ from ordinary DEFLATE', () => {
    for (const data of [text('abc'), text('abcd')]) {
        const packed = viseStored(data), out = new Uint8Array(data.length);
        expect(inflateViseSync(packed, out).status).toBe('ok'); expect(out).toEqual(data);
        expect(inflateRawSync(packed, out).status).toBe('data-error');
    }
    const corrupt = viseStored(text('abc')); corrupt[4] ^= 1;
    expect(inflateViseSync(corrupt, new Uint8Array(3)).status).toBe('data-error');
});

test('VISE objects resolve parent folders and authenticate every payload', () => {
    const bytes = vise(), files = extractVise(bytes);
    expect(files.size).toBe(2); expect(files.has('Bin/')).toBe(true); expect(files.get('Bin/a.bin')).toEqual(text('VISE odd text'));
    const e = parseVise(bytes).entries.find(e => !e.service)!;
    const corrupt = bytes.slice(); corrupt[e.dataOffset + 6] ^= 1;
    expect(() => extractVise(corrupt)).toThrow('CRC');
    expect(() => extractVise(bytes.subarray(0, bytes.length - 1))).toThrow();
});

function wise(data = text('Wise payload'), badRecord = false) {
    const member = (data: Uint8Array) => new Uint8Array([...deflateRawSync(data), ...u32(crc32(data))]);
    const stub = new Uint8Array(128); stub.set(text('MZ')); set32(stub, 60, 64); set32(stub, 64, 0x4550); stub.set(text('WiseMain'), 96);
    const first = member(text('installer bitmap')), payload = member(data);
    const name = text('%MAINDIR%\\game.bin');
    const script = new Uint8Array(4 + 43 + name.length + 1); script[0] = 8; script.set(name, 47);
    set32(script, 7, 0); set32(script, 11, payload.length); set32(script, 19, data.length + (badRecord ? 1 : 0)); set32(script, 43, crc32(data));
    return new Uint8Array([...stub, ...first, ...member(script), ...payload]);
}

test('Wise script file extents bind names, and a damaged record cannot silently drop a file', () => {
    const files = extractWise(wise()); expect(files.size).toBe(1); expect(files.get('game.bin')).toEqual(text('Wise payload'));
    const broken = wise(); broken[broken.length - 1] ^= 1;
    expect(() => extractWise(broken)).toThrow('CRC');
    expect(() => extractWise(wise(text('data'), true))).toThrow('file records');
});

test('browser import detects original installers before trying the embedded ZIP route', async () => {
    const viseBytes = vise(), peVise = new Uint8Array([...text('MZ'), ...zeros(126), ...viseBytes]);
    set32(peVise, peVise.length - 4, 128);
    const peRar = new Uint8Array([...text('MZ'), ...zeros(126), ...rarArchive()]);
    for (const bytes of [wise(), peVise, peRar, rarArchive(), is3()]) {
        expect((await detectSource({ blob: new Blob([bytes]) })).kind).toBe('installer-payload');
    }
});

test('container registry selects the payload over a smaller InstallShield runtime archive', async () => {
    const r = await extractInstallerFromFiles(new Map([['data.z', is3()], ['_setup.lib', is3(text('x'))]]));
    expect(r.via).toBe('installshield3'); expect(r.gameFiles.get('a.bin')).toEqual(text('DCL literal payload'));
    expect((await extractInstallerFromFiles(new Map([['installer.exe', wise()]]))).via).toBe('wise');
    expect((await extractInstallerFromFiles(new Map([['installer.exe', vise()]]))).via).toBe('vise');
    expect((await extractInstallerFromFiles(new Map([['installer.exe', rarArchive()]]))).via).toBe('rar4');
    for (const path of ['../escape', 'C:/escape', '/escape', '.', 'a\0b']) expect(() => payloadPath(path)).toThrow();
});
