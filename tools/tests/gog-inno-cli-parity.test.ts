import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { BufferSource, ZipArchive } from '@bottleship/formats/zip';
import { MultiSliceReader, parseSliceSource, type InnoParseResult } from '@bottleship/formats/inno';
import { CompressionMethod } from '@bottleship/formats/inno/header';
import { installerToWgb } from '@bottleship/repack/installer-to-wgb';
import { crc32 } from '../../packages/formats/src/installer/binary';

const bytes = (s: string) => Buffer.from(s);
function file(destination: string, location: number, check = '') {
    return { source: '', destination: '{app}\\' + destination, installFontName: '', strongAssemblyName: '',
        components: '', tasks: '', languages: '', check, afterInstall: '', beforeInstall: '', location,
        attributes: 0, externalSize: 0n, permission: -1, options: 0, type: 0, additionalLocations: [],
        assemblySize: 0n, galaxyChecksumType: 'none', galaxyChecksum: new Uint8Array(0) };
}
function fixture(external: boolean, galaxy: boolean) {
    const rows = [
        ['game.exe', 'executable'], ['strings.ini', 'English'], ['strings.ini', 'Deutsch'],
        ['goggame-1207659963.info', JSON.stringify({ gameId: '1207659963', name: 'Fixture Name',
            playTasks: [{ isPrimary: true, path: 'game.exe', arguments: '--metadata' }] })],
        ['goggame-1207659963.script', JSON.stringify({ actions: [{ languages: ['*'], install: {
            action: 'setRegistry', arguments: { root: 'HKEY_LOCAL_MACHINE', subkey: 'Software\\ScriptFixture',
                valueName: 'Executable', valueType: 'string', valueData: '{app}\\game.exe' } } }] })],
        ['gog.ico', 'junk-icon'],
    ];
    const payloads = rows.map(row => bytes(row[1]!));
    const total = payloads.reduce((n, b) => n + b.length, 0);
    let offset = 0;
    const dataEntries = payloads.map(body => {
        const checksum = new Uint8Array(4); new DataView(checksum.buffer).setUint32(0, crc32(body), true);
        const entry = { firstSlice: 0, lastSlice: external ? 1 : 0, sortOffset: external ? 12 : 0,
            fileOffset: BigInt(offset), fileSize: BigInt(body.length), chunkSize: BigInt(total),
            uncompressedSize: BigInt(body.length), checksum, checksumType: 'crc32', timestamp: 0n,
            fileVersion: 0n, options: 0, sign: 0, chunkCompressed: false, zlibFilter: false };
        offset += body.length; return entry;
    });
    const files = rows.map((row, i) => file(row[0]!, i, i === 1 ? "check_if_install('en-US#','32#64#','')"
        : i === 2 ? "check_if_install('de-DE#','32#64#','')" : ''));
    files.push(file('alias/game.exe', 0)); // One location fans out to simultaneously open sinks.
    if (galaxy) {
        // The same exact bytes become a Galaxy assembly with two out-of-order writes.
        const first = bytes('assembly-A'), second = bytes('assembly-B');
        const start = total;
        const assembled = Buffer.concat([first, second]);
        for (const [i, body] of [first, second].entries()) {
            const checksum = new Uint8Array(4); new DataView(checksum.buffer).setUint32(0, crc32(body), true);
            dataEntries.push({ ...dataEntries[0]!, fileOffset: BigInt(start + (i ? first.length : 0)),
                fileSize: BigInt(body.length), uncompressedSize: BigInt(body.length), checksum,
                zlibFilter: false });
        }
        const assembly = file('assembled.bin', rows.length);
        assembly.additionalLocations = [rows.length + 1] as never[];
        assembly.assemblySize = BigInt(assembled.length);
        assembly.galaxyChecksumType = 'md5';
        assembly.galaxyChecksum = new Uint8Array(createHash('md5').update(assembled).digest());
        files.push(assembly);
        payloads.push(first, second);
        for (const entry of dataEntries) entry.chunkSize = BigInt(total + assembled.length);
    }
    const chunk = Buffer.concat([new Uint8Array([0x7a, 0x6c, 0x62, 0x1a]), ...payloads]);
    const parsed = { header: { appName: 'Installer Name', compression: CompressionMethod.Stored, options: 0, slicesPerDisk: 2 },
        offsets: { dataOffset: external ? 0 : 1 }, version: { isUnicode: () => true },
        files, dataEntries, directories: [], icons: [{ filename: '{app}\\game.exe', parameters: '--icon' }],
        registryEntries: [{ hive: 2, key: 'Software\\Fixture', name: 'InstallDir', type: 1,
            value: new Uint8Array(Buffer.from('{app}\\\0', 'utf16le')) }] } as unknown as InnoParseResult;
    const cut = Math.floor(chunk.length / 2);
    const slices = [chunk.subarray(0, cut), chunk.subarray(cut)].map(part => {
        const header = Buffer.alloc(12); header.set(bytes('idska32\x1a')); header.writeUInt32LE(12 + part.length, 8);
        return Buffer.concat([header, part]);
    });
    return { parsed, input: Buffer.concat([new Uint8Array([0]), chunk]), slices };
}
async function members(input: Uint8Array) {
    const zip = new ZipArchive(new BufferSource(input)); await zip.init();
    const out: Record<string, Uint8Array> = {};
    for (const entry of zip.listEntries()) out[entry.name] = await zip.readEntry(entry);
    return out;
}
async function compare(external: boolean, german: boolean, galaxy: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'gog-inno-parity-'));
    try {
        const f = fixture(external, galaxy), installer = join(dir, 'setup.exe'), output = join(dir, 'game.wgb'), stage = join(dir, 'stage');
        writeFileSync(installer, external ? bytes('header fixture') : f.input);
        if (external) f.slices.forEach((part, i) => writeFileSync(join(dir, 'setup-1' + String.fromCharCode(97 + i) + '.bin'), part));
        const wasm = readFileSync('public/unpack-streaming.wasm');
        const synth = german ? { args: '--cli', os: 'winxp', ramMB: 256 } : {};
        const expected = await installerToWgb({ source: new BufferSource(f.input),
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
            parsed: f.parsed, sliceSource: external ? new MultiSliceReader(f.slices.map(p => parseSliceSource(new BufferSource(p)))) : undefined,
            keepGog: german, language: german ? 'de-DE' : undefined, synth,
            overrides: JSON.parse(readFileSync('public/gog-overrides.json', 'utf8')) });
        const serial = JSON.stringify(f.parsed, (_key, value) => typeof value === 'bigint' ? { bigint: String(value) }
            : value instanceof Uint8Array ? { uint8: [...value] } : value);
        const cli = resolve('tools/gog-to-wgb.ts');
        const runner = `
            import { mock } from 'bun:test';
            import * as fs from 'node:fs';
            import * as inno from '@bottleship/formats/inno';
            import { resolve, sep, basename } from 'node:path';
            const original = { ...fs }, formats = { ...inno };
            const parsed = JSON.parse(${JSON.stringify(serial)}, (_key, value) => value?.bigint !== undefined ? BigInt(value.bigint)
                : value?.uint8 ? new Uint8Array(value.uint8) : value);
            parsed.version.isUnicode = () => true;
            const inputPath = resolve(${JSON.stringify(installer)}), root = resolve(${JSON.stringify(stage)}, 'app') + sep;
            mock.module('fs', () => ({ ...original, readFileSync(path, ...args) {
                const full = resolve(String(path));
                if (full === inputPath || /^setup-.*\\.bin$/i.test(basename(full))) throw new Error('WHOLE_INSTALLER_READ');
                if (full.startsWith(root) && !/^goggame-.*\\.(info|script)$/i.test(basename(full))) throw new Error('PAYLOAD_RELOAD');
                return original.readFileSync(path, ...args);
            } }));
            mock.module('@bottleship/formats/inno', () => ({ ...formats, parseInnoHeader: async source => {
                if (source.constructor.name !== 'FileSource') throw new Error('NOT_RANGE_BACKED');
                return parsed;
            } }));
            process.argv = ['bun', ${JSON.stringify(cli)}, ${JSON.stringify(installer)}, ${JSON.stringify(output)},
                '--extract-dir', ${JSON.stringify(stage)}, ...${JSON.stringify(german ? ['--keep-gog', '--language', 'de-DE', '--args', '--cli', '--os', 'winxp', '--ram', '256'] : [])}];
            await import(${JSON.stringify(cli)});
        `;
        const child = Bun.spawnSync([process.execPath, '--eval', runner], { stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
        const log = new TextDecoder().decode(child.stdout) + new TextDecoder().decode(child.stderr);
        expect(log).not.toContain('WHOLE_INSTALLER_READ');
        expect(log).not.toContain('PAYLOAD_RELOAD');
        expect({ exit: child.exitCode, error: child.exitCode ? log : '' }).toEqual({ exit: 0, error: '' });
        const actual = await members(readFileSync(output)), reference = await members(expected.wgb);
        expect(Object.keys(actual).sort()).toEqual(Object.keys(reference).sort());
        for (const name of Object.keys(reference)) expect(actual[name]).toEqual(reference[name]);
        const manifest = JSON.parse(new TextDecoder().decode(actual['manifest.json']));
        expect(Object.hasOwn(manifest.emulator, 'createDirs')).toBe(false);
        expect(manifest.emulator.screenResolution).toEqual({ width: 640, height: 480, bpp: 16 });
        expect(new TextDecoder().decode(actual['rom/strings.ini'])).toBe(german ? 'Deutsch' : 'English');
        expect(readFileSync(join(stage, 'app', 'alias', 'game.exe'))).toEqual(bytes('executable'));
        expect(readdirSync(stage)).toEqual(['app']); // Assembly scratch must be closed/unlinked.
    } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('single-file Inno disk CLI preserves existing manifest/registry/content and auto-English selection', () => compare(false, false, false));
test('lettered standard Inno slices preserve language, keep-GOG, CLI args and curation', () => compare(true, true, false));
test('Galaxy assembly stays disk-backed and preserves the existing WGB bytes', () => compare(false, false, true));
