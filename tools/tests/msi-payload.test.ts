import {expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {ZipArchive, BufferSource} from '@bottleship/formats/zip';
import {decodeMsi1251} from '../../packages/formats/src/msi/codepage';
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

function fixture(cycle = false, options: {alias?: boolean; size?: number; hash?: Uint8Array; embedded?: Uint8Array; loose?: boolean; source?: boolean; filename?: string; codepage?: number; attributes?: number; sourceRoot?: string} = {}): Uint8Array {
    const strings: string[] = [];
    const str = (s: string) => {let i = strings.indexOf(s); if (i < 0) {i = strings.length; strings.push(s);} return i + 1;};
    const data = (columns: number[][], widths = columns.map(() => 2)) => {
        const out = new Uint8Array(columns.reduce((n, c, i) => n + c.length * widths[i]!, 0)); const dv = new DataView(out.buffer); let p = 0;
        columns.forEach((col, i) => col.forEach(value => {if (widths[i] === 4) dv.setUint32(p, value, true); else dv.setUint16(p, value, true); p += widths[i]!;})); return out;
    };
    const schema: Array<[string, string, number]> = [
        ['Directory', 'Directory', 0x800], ['Directory', 'Directory_Parent', 0x800], ['Directory', 'DefaultDir', 0x800],
        ['Component', 'Component', 0x800], ['Component', 'Directory_', 0x800],
        ['File', 'File', 0x800], ['File', 'Component_', 0x800], ['File', 'FileName', 0x800], ['File', 'FileSize', 4], ['File', 'Sequence', 2], ['File', 'Attributes', 2],
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
        ['SourceDir', options.alias ? '.' : options.source ? 'DEMO~1|Demo:' + (options.sourceRoot ?? 'SRCROOT') : 'DEMO~1|Demo',
            options.source ? 'BINARY~1|Binaries:SOURCE~1|Source Files' : 'BINARY~1|Binaries', 'System', 'Demo'].map(str),
    ]));
    streams.set('Component', data([['App', 'Runtime'].map(str), ['BIN', 'SystemFolder'].map(str)]));
    streams.set('File', data([
        ['GUID_GAME', 'GUID_RUNTIME'].map(str), ['App', 'Runtime'].map(str), [options.filename ?? 'DEMO~1.EXE|Demo.exe', 'runtime.dll'].map(str),
        [0x80000000 + (options.size ?? 11), 0x80000004], [0x8001, 0x8002], [0x8000 + (options.attributes ?? 0), 0x8000],
    ], [2, 2, 2, 4, 2, 2]));
    streams.set('Media', data([[0x8002], [options.loose ? 0 : str(options.embedded ? '#Payload' : 'Data1.cab')]]));
    if (options.embedded) streams.set('Payload', options.embedded);
    if (options.hash) {
        const digest = new DataView(options.hash.buffer, options.hash.byteOffset, 16);
        streams.set('MsiFileHash', data([[str('GUID_GAME')], [0x8000], ...[0, 1, 2, 3].map(i => [(digest.getInt32(i * 4, true) + 0x80000000) >>> 0])], [2, 2, 4, 4, 4, 4]));
    }
    const encoded = strings.map(s => options.codepage === 1251
        ? Uint8Array.from([...s], c => c.charCodeAt(0) >= 0x410 ? c.charCodeAt(0) - 0x350 : c.charCodeAt(0))
        : new TextEncoder().encode(s));
    const pool = new Uint8Array((strings.length + 1) * 4); const pv = new DataView(pool.buffer); pv.setUint16(0, options.codepage ?? 1252, true);
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

test('MSI loose media resolves source directories and short names, preserving installed long names and hashes', async () => {
    const payload = new TextEncoder().encode('Hello world');
    const hash = Uint8Array.from(Buffer.from('3e25960a79dbc69b674cd4ec67a72c62', 'hex'));
    const msi = fixture(false, {loose: true, source: true, hash});
    const requests: string[] = [];
    const files = await extractMsiPayload(msi, path => {
        requests.push(path);
        return path === 'SRCROOT/SOURCE~1/DEMO~1.EXE' ? payload : null;
    });
    expect(requests).toEqual(['SRCROOT/Source Files/Demo.exe', 'SRCROOT/SOURCE~1/DEMO~1.EXE']);
    expect(files.get('Binaries/Demo.exe')).toEqual(payload);
    await expect(extractMsiPayload(msi, () => null)).rejects.toThrow('loose file missing');
    await expect(extractMsiPayload(msi, () => new Uint8Array(10))).rejects.toThrow('size mismatch');
    await expect(extractMsiPayload(msi, () => new TextEncoder().encode('Hello wrong'))).rejects.toThrow('checksum mismatch');
    const result = await extractInstallerFromFiles(new Map([['Setup/Game.msi', msi]]), {
        resolveInstallerFile: path => path.toLowerCase() === 'setup/srcroot/source~1/demo~1.exe' ? payload : null,
    });
    expect(result.via).toBe('msi');
    expect(result.gameFiles).toEqual(files);
});

test('MSI decodes Windows-1251 names without runtime encoding support', () => {
    const db = new MsiDatabase(fixture(false, {codepage: 1251, filename: 'Игра.exe'}));
    expect(msiFilePaths(db, 'INSTALLDIR')[0].path).toBe('Binaries/Игра.exe');
    expect(decodeMsi1251(new Uint8Array([0x41, 0x88, 0xa8, 0xb8, 0xa5, 0xb4, 0xb9, 0xc0, 0xff]))).toBe('A€ЁёҐґ№Ая');
    expect(() => decodeMsi1251(new Uint8Array([0x98]))).toThrow('Invalid Windows-1251');
});

test('accepting stale MSI hashes is explicit and reports expected and actual digests', async () => {
    const payload = new TextEncoder().encode('Hello world');
    const msi = fixture(false, {hash: new Uint8Array(16), loose: true});
    await expect(extractMsiPayload(msi, () => payload)).rejects.toThrow('checksum mismatch');
    const mismatches: string[][] = [];
    const files = await extractMsiPayload(msi, () => payload, {
        onHashMismatch: (...values) => {mismatches.push(values);},
    });
    expect(mismatches).toEqual([['Binaries/Demo.exe', '00000000000000000000000000000000', '3e25960a79dbc69b674cd4ec67a72c62']]);
    expect(files.get('Binaries/Demo.exe')).toEqual(payload);
});

function isoFiles(files: Map<string, Uint8Array>) {
    const block = 2048, root = 20;
    let next = root + 1;
    const extents = [...files].map(([name, bytes]) => {
        const entry = {name, bytes, lba: next}; next += Math.ceil(bytes.length / block);
        return entry;
    });
    const out = new Uint8Array(next * block);
    const record = (name: Uint8Array, lba: number, size: number, directory: boolean) => {
        const bytes = new Uint8Array((33 + name.length + 1) & ~1), dv = new DataView(bytes.buffer);
        bytes[0] = bytes.length; dv.setUint32(2, lba, true); dv.setUint32(6, lba, false);
        dv.setUint32(10, size, true); dv.setUint32(14, size, false);
        bytes[25] = directory ? 2 : 0; bytes[32] = name.length; bytes.set(name, 33);
        return bytes;
    };
    const text = (s: string) => new TextEncoder().encode(s);
    out[16 * block] = 1; out.set(text('CD001'), 16 * block + 1); out[16 * block + 6] = 1;
    out.set(record(new Uint8Array([0]), root, block, true), 16 * block + 156);
    out[17 * block] = 255; out.set(text('CD001'), 17 * block + 1);
    let at = root * block;
    for (const entry of [record(new Uint8Array([0]), root, block, true), record(new Uint8Array([1]), root, block, true),
        ...extents.map(e => record(text(e.name + ';1'), e.lba, e.bytes.length, false))]) {
        out.set(entry, at); at += entry.length;
    }
    for (const e of extents) out.set(e.bytes, e.lba * block);
    return out;
}

test('container recursion unwraps an ISO and then its MSI payload', async () => {
    const payload = new TextEncoder().encode('Hello world');
    const image = isoFiles(new Map([['GAME.MSI', fixture()], ['DATA1.CAB', cabinet(payload)]]));
    const result = await extractInstallerFromFiles(new Map([['Game.iso', image]]));
    expect(result.via).toBe('iso');
    expect(result.note).toContain('MSI');
    expect(result.gameFiles.get('Binaries/Demo.exe')).toEqual(payload);
    await expect(extractInstallerFromFiles(new Map([['One.iso', image], ['Two.iso', image]]))).rejects.toThrow('Multiple ISO');
    const installed = new Map([['Game.exe', new Uint8Array([77, 90])], ['Disc.iso', image]]);
    const untouched = await extractInstallerFromFiles(installed);
    expect(untouched.via).toBe('none');
    expect(untouched.gameFiles).toBe(installed);
});

test('MSI file attributes select loose media and reject missing or conflicting compression metadata', async () => {
    const payload = new TextEncoder().encode('Hello world');
    const files = await extractMsiPayload(fixture(false, {attributes: 0x2000}), path => {
        expect(path).toBe('Demo/Binaries/Demo.exe'); return payload;
    });
    expect(files.get('Binaries/Demo.exe')).toEqual(payload);
    await expect(extractMsiPayload(fixture(false, {loose: true, attributes: 0x4000}), () => payload)).rejects.toThrow('no cabinet');
    await expect(extractMsiPayload(fixture(false, {attributes: 0x6000}), () => payload)).rejects.toThrow('Conflicting');
    for (const sourceRoot of ['..', 'C', 'bad/name']) {
        const invalid = fixture(false, {loose: true, source: true, sourceRoot: sourceRoot === 'C' ? 'C:/bad' : sourceRoot});
        await expect(extractMsiPayload(invalid, () => {throw new Error('Resolver must not run');})).rejects.toThrow('Unsafe');
    }
});

test('iso-to-wgb discovers MSI media and packs installed filenames', async () => {
    const logs = resolve('logs'); mkdirSync(logs, {recursive: true});
    const dir = mkdtempSync(join(logs, 'iso-msi-'));
    try {
        const payload = new TextEncoder().encode('Hello world');
        const image = join(dir, 'disc.iso'), output = join(dir, 'game.wgb');
        writeFileSync(image, isoFiles(new Map([['GAME.MSI', fixture()], ['DATA1.CAB', cabinet(payload)]])));
        const result = Bun.spawnSync([process.execPath, 'tools/iso-to-wgb.ts', image, output, '--exe', 'Binaries/Demo.exe', '--name', 'Test MSI'], {stdout: 'pipe', stderr: 'pipe'});
        expect({exitCode: result.exitCode, stderr: result.exitCode ? new TextDecoder().decode(result.stderr) : ''}).toEqual({exitCode: 0, stderr: ''});
        const zip = new ZipArchive(new BufferSource(readFileSync(output))); await zip.init();
        expect(await zip.readEntry(zip.getEntry('rom/Binaries/Demo.exe')!)).toEqual(payload);
        expect(zip.getEntry('rom/GAME.MSI')).toBeUndefined();
    } finally {rmSync(dir, {recursive: true, force: true});}
});
