import {expect, test} from 'bun:test';
import {MsiDatabase, msiFilePaths, readCompoundStreams, decodeMsiStreamName} from '@bottleship/formats/msi';
import {extractMsiPayload} from '@bottleship/repack/msi-extract';
import {extractInstallerFromFiles} from '@bottleship/repack/container-extract';

/** Fixture writer for small CFB documents: directory + FAT + miniFAT + root mini stream. */
function compound(streams: Map<string, Uint8Array>): Uint8Array {
    const entries = [...streams];
    const dirSectors = Math.ceil((entries.length + 1) * 128 / 512);
    const miniSectors = entries.reduce((n, [, b]) => n + Math.ceil(b.length / 64), 0);
    const rootSectors = Math.ceil(miniSectors * 64 / 512);
    const miniFatSectors = Math.max(1, Math.ceil(miniSectors / 128));
    const fatId = dirSectors;
    const miniFatId = fatId + 1;
    const rootId = miniFatId + miniFatSectors;
    const out = new Uint8Array((rootId + rootSectors + 1) * 512);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0xe011cfd0, true); dv.setUint32(4, 0xe11ab1a1, true);
    dv.setUint16(26, 3, true); dv.setUint16(28, 0xfffe, true); dv.setUint16(30, 9, true); dv.setUint16(32, 6, true);
    dv.setUint32(44, 1, true); dv.setUint32(48, 0, true); dv.setUint32(56, 4096, true);
    dv.setUint32(60, miniFatId, true); dv.setUint32(64, miniFatSectors, true); dv.setUint32(68, 0xfffffffe, true);
    for (let i = 0; i < 109; i++) dv.setUint32(76 + i * 4, i ? 0xffffffff : fatId, true);
    const fatOff = (fatId + 1) * 512;
    const miniFatOff = (miniFatId + 1) * 512;
    for (let i = 0; i < 128; i++) dv.setUint32(fatOff + i * 4, 0xffffffff, true);
    for (let i = 0; i < miniFatSectors * 128; i++) dv.setUint32(miniFatOff + i * 4, 0xffffffff, true);
    const fat = (id: number, next: number) => dv.setUint32(fatOff + id * 4, next, true);
    for (let i = 0; i < dirSectors; i++) fat(i, i + 1 === dirSectors ? 0xfffffffe : i + 1);
    fat(fatId, 0xfffffffd);
    for (let i = 0; i < miniFatSectors; i++) fat(miniFatId + i, i + 1 === miniFatSectors ? 0xfffffffe : miniFatId + i + 1);
    for (let i = 0; i < rootSectors; i++) fat(rootId + i, i + 1 === rootSectors ? 0xfffffffe : rootId + i + 1);
    const directory = (i: number, name: string, type: number, first: number, size: number) => {
        const p = 512 + i * 128;
        for (let j = 0; j < name.length; j++) dv.setUint16(p + j * 2, name.charCodeAt(j), true);
        dv.setUint16(p + 64, (name.length + 1) * 2, true); dv.setUint8(p + 66, type);
        dv.setUint32(p + 116, first, true); dv.setBigUint64(p + 120, BigInt(size), true);
    };
    directory(0, 'Root Entry', 5, rootId, miniSectors * 64);
    let cursor = 0;
    for (let i = 0; i < entries.length; i++) {
        const [name, bytes] = entries[i]!; const count = Math.ceil(bytes.length / 64);
        directory(i + 1, name, 2, count ? cursor : 0xfffffffe, bytes.length);
        for (let n = 0; n < count; n++) dv.setUint32(miniFatOff + (cursor + n) * 4, n + 1 === count ? 0xfffffffe : cursor + n + 1, true);
        out.set(bytes, (rootId + 1) * 512 + cursor * 64); cursor += count;
    }
    return out;
}

function fixture(cycle = false, options: {alias?: boolean; size?: number; hash?: Uint8Array; embedded?: Uint8Array} = {}): Uint8Array {
    const strings: string[] = [];
    const str = (s: string) => {let i = strings.indexOf(s); if (i < 0) {i = strings.length; strings.push(s);} return i + 1;};
    const data = (columns: number[][], widths = columns.map(() => 2)) => {
        const out = new Uint8Array(columns.reduce((n, c, i) => n + c.length * widths[i]!, 0)); const dv = new DataView(out.buffer); let p = 0;
        columns.forEach((col, i) => col.forEach(value => {if (widths[i] === 4) dv.setUint32(p, value, true); else dv.setUint16(p, value, true); p += widths[i]!;})); return out;
    };
    const schema: Array<[string, string, number]> = [
        ['Directory', 'Directory', 0x800], ['Directory', 'Directory_Parent', 0x800], ['Directory', 'DefaultDir', 0x800],
        ['Component', 'Component', 0x800], ['Component', 'Directory_', 0x800],
        ['File', 'File', 0x800], ['File', 'Component_', 0x800], ['File', 'FileName', 0x800], ['File', 'FileSize', 4], ['File', 'Sequence', 2],
        ['Media', 'LastSequence', 2], ['Media', 'Cabinet', 0x800],
    ];
    if (options.hash) schema.push(['MsiFileHash', 'File_', 0x800], ['MsiFileHash', 'Options', 2], ...[1, 2, 3, 4].map(i => ['MsiFileHash', `HashPart${i}`, 4] as [string, string, number]));
    const ordinals = new Map<string, number>();
    const metadata = schema.map(([table, name, type]) => {const n = (ordinals.get(table) ?? 0) + 1; ordinals.set(table, n); return [str(table), n + 0x8000, str(name), type + 0x8000];});
    const streams = new Map<string, Uint8Array>();
    streams.set('_Columns', data([0, 1, 2, 3].map(i => metadata.map(r => r[i]!))));
    streams.set('Directory', data([
        ['TARGETDIR', 'INSTALLDIR', 'BIN', 'SystemFolder', 'GAME_ROOT'].map(str),
        [0, str(options.alias ? 'GAME_ROOT' : 'TARGETDIR'), str(cycle ? 'BIN' : options.alias ? 'GAME_ROOT' : 'INSTALLDIR'), str('TARGETDIR'), str('TARGETDIR')],
        ['SourceDir', options.alias ? '.' : 'DEMO~1|Demo', 'BINARY~1|Binaries', 'System', 'Demo'].map(str),
    ]));
    streams.set('Component', data([['App', 'Runtime'].map(str), ['BIN', 'SystemFolder'].map(str)]));
    streams.set('File', data([
        ['GUID_GAME', 'GUID_RUNTIME'].map(str), ['App', 'Runtime'].map(str), ['DEMO~1.EXE|Demo.exe', 'runtime.dll'].map(str),
        [0x80000000 + (options.size ?? 11), 0x80000004], [0x8001, 0x8002],
    ], [2, 2, 2, 4, 2]));
    streams.set('Media', data([[0x8002], [str(options.embedded ? '#Payload' : 'Data1.cab')]]));
    if (options.embedded) streams.set('Payload', options.embedded);
    if (options.hash) {
        const digest = new DataView(options.hash.buffer, options.hash.byteOffset, 16);
        streams.set('MsiFileHash', data([[str('GUID_GAME')], [0x8000], ...[0, 1, 2, 3].map(i => [(digest.getInt32(i * 4, true) + 0x80000000) >>> 0])], [2, 2, 4, 4, 4, 4]));
    }
    const encoded = strings.map(s => new TextEncoder().encode(s));
    const pool = new Uint8Array((strings.length + 1) * 4); const pv = new DataView(pool.buffer); pv.setUint16(0, 1252, true);
    for (let i = 0; i < encoded.length; i++) {pv.setUint16((i + 1) * 4, encoded[i]!.length, true); pv.setUint16((i + 1) * 4 + 2, 1, true);}
    const stringsData = new Uint8Array(encoded.reduce((sum, b) => sum + b.length, 0)); let p = 0;
    for (const s of encoded) {stringsData.set(s, p); p += s.length;}
    streams.set('_StringPool', pool); streams.set('_StringData', stringsData);
    return compound(streams);
}

test('MSI joins cabinet keys to long filenames and nested target directories', () => {
    const db = new MsiDatabase(fixture());
    expect(db.table('File')[0]!.FileSize).toBe(11);
    expect(msiFilePaths(db, 'INSTALLDIR')).toEqual([{key: 'GUID_GAME', path: 'Binaries/Demo.exe', size: 11, sequence: 1}]);
});
test('MSI rejects cyclic Directory references and missing install roots', () => {
    expect(() => msiFilePaths(new MsiDatabase(fixture(true)), 'INSTALLDIR')).toThrow('Cyclic');
    expect(() => msiFilePaths(new MsiDatabase(fixture()), 'MISSING')).toThrow('missing');
});
test('CFB mini streams retain exact byte lengths across mini-sector boundaries', () => {
    const bytes = Uint8Array.from({length: 131}, (_, i) => i);
    const streams = readCompoundStreams(compound(new Map([['Payload', bytes], ['Empty', new Uint8Array()]])));
    expect(streams.get('Payload')).toEqual(bytes); expect(streams.get('Empty')!.length).toBe(0);
});
test('CFB rejects a cyclic allocation chain', () => {
    const bytes = compound(new Map([['Payload', new Uint8Array([1])]]));
    // Directory uses sector 0, FAT sector 1. Link directory back to itself.
    new DataView(bytes.buffer).setUint32(1024, 0, true);
    expect(() => readCompoundStreams(bytes)).toThrow('cyclic');
});
test('CFB rejects stream data truncated inside its declared extent', () => {
    const bytes = compound(new Map([['Payload', new Uint8Array(131)]]));
    expect(() => readCompoundStreams(bytes.subarray(0, bytes.length - 450))).toThrow('Truncated');
});
test('MSI packed stream names decode both two-character and single-character tokens', () => {
    expect(decodeMsiStreamName(String.fromCharCode(0x4840, 0x3f3f, 0x4577, 0x446c, 0x3b6a, 0x45e4, 0x4824))).toBe('_StringData');
});

/** Single uncompressed CAB member with an MSI File-table key rather than an installed name. */
function cabinet(payload: Uint8Array): Uint8Array {
    const name = new TextEncoder().encode('GUID_GAME\0');
    const dataOffset = 60 + name.length;
    const bytes = new Uint8Array(dataOffset + 8 + payload.length); const dv = new DataView(bytes.buffer);
    dv.setUint32(0, 0x4643534d, true); dv.setUint32(8, bytes.length, true); dv.setUint32(16, 44, true);
    dv.setUint8(24, 3); dv.setUint8(25, 1); dv.setUint16(26, 1, true); dv.setUint16(28, 1, true);
    dv.setUint32(36, dataOffset, true); dv.setUint16(40, 1, true); dv.setUint32(44, payload.length, true);
    bytes.set(name, 60); dv.setUint16(dataOffset + 4, payload.length, true); dv.setUint16(dataOffset + 6, payload.length, true);
    bytes.set(payload, dataOffset + 8); return bytes;
}

test('MSI INSTALLDIR alias includes sibling components under the same physical root', () => {
    expect(msiFilePaths(new MsiDatabase(fixture(false, {alias: true})), 'INSTALLDIR')).toEqual([{key: 'GUID_GAME', path: 'Binaries/Demo.exe', size: 11, sequence: 1}]);
});

test('MSI external and embedded cabinets restore filenames and validate FileHash', async () => {
    const payload = new TextEncoder().encode('Hello world');
    // Independently recorded MD5 of the fixture payload.
    const hash = Uint8Array.from(Buffer.from('3e25960a79dbc69b674cd4ec67a72c62', 'hex'));
    const requests: string[] = [];
    const external = await extractMsiPayload(fixture(false, {hash}), name => {requests.push(name); return cabinet(payload);});
    expect(requests).toEqual(['Data1.cab']); expect(external.get('Binaries/Demo.exe')).toEqual(payload);
    const embedded = await extractMsiPayload(fixture(false, {hash, embedded: cabinet(payload)}), () => {throw new Error('external resolver called');});
    expect(embedded).toEqual(external);
    await expect(extractMsiPayload(fixture(false, {hash}), () => cabinet(new TextEncoder().encode('Hello wrong')))).rejects.toThrow('checksum mismatch');
});

test('MSI zero-byte FileHash is four zero DWORDs; missing and wrong-size media fail', async () => {
    const empty = await extractMsiPayload(fixture(false, {size: 0, hash: new Uint8Array(16)}), () => cabinet(new Uint8Array()));
    expect(empty.get('Binaries/Demo.exe')!.length).toBe(0);
    await expect(extractMsiPayload(fixture(), () => null)).rejects.toThrow('cabinet missing');
    await expect(extractMsiPayload(fixture(), () => cabinet(new Uint8Array(10)))).rejects.toThrow('size mismatch');
});

test('container extraction detects a nested MSI and resolves adjacent cabinets case-insensitively', async () => {
    const payload = new TextEncoder().encode('Hello world');
    const files = new Map([
        ['Disc1/Setup/Game.MSI', fixture()],
        ['Disc1/Setup/DATA1.CAB', cabinet(payload)],
        ['Other/Data1.cab', cabinet(new Uint8Array(10))],
    ]);
    const result = await extractInstallerFromFiles(files);
    expect(result.via).toBe('msi');
    expect([...result.gameFiles.keys()]).toEqual(['Binaries/Demo.exe']);
    expect(result.gameFiles.get('Binaries/Demo.exe')).toEqual(payload);
});
