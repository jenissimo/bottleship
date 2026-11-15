import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { crc32 } from '../../packages/formats/src/installer/binary';
import { BufferSource, ZipArchive } from '@bottleship/formats/zip';
import type { InnoParseResult } from '@bottleship/formats/inno';
import type { UnpackDecoder } from '@bottleship/formats/unpack';
import { discoverGogRarParts, planGogRarLayout, installGogRar, synthesizeInstalledGog, packInstalledGog, publishGogBundle } from '../internal/gog-rar';

const text = (s: string) => new TextEncoder().encode(s);
const u16 = (n: number) => [n & 255, n >>> 8 & 255];
const u32 = (n: number) => [...u16(n), ...u16(n >>> 16)];
interface File { name: string; body?: string; directory?: boolean; flags?: number; }
function rar(entries: File[], mainFlags = 0) {
    const block = (type: number, flags: number, body: number[]) => {
        const tail = Uint8Array.from([type, ...u16(flags), ...u16(body.length + 7), ...body]);
        return [...u16(crc32(tail) & 65535), ...tail];
    };
    const files = entries.flatMap(e => {
        const data = text(e.body ?? ''), name = text(e.name);
        return [...block(0x74, 0x8000 | (e.directory ? 0xe0 : 0) | (e.flags ?? 0),
            [...u32(data.length), ...u32(data.length), 2, ...u32(crc32(data)), ...u32(0), 29, 0x30,
                ...u16(name.length), ...u32(e.directory ? 16 : 0), ...name]), ...data];
    });
    return Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 7, 0,
        ...block(0x73, mainFlags, [0, 0, 0, 0, 0, 0]), ...files, ...block(0x7b, 0, [])]);
}
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'gog-rar-'));
    const installer = join(dir, 'setup_fixture.exe');
    writeFileSync(installer, 'Inno metadata supplied by the parser fixture');
    return { dir, installer, part: (number: number, entries: File[], flags = 0) => writeFileSync(join(dir, `setup_fixture-${number}.bin`), rar(entries, flags)) };
}
const codec = {} as UnpackDecoder; // Stored fixtures never request the real PPM backend.
const parsed = {
    header: { appName: 'Installer Name', appVersion: '1', appPublisher: 'Fixture Publisher' },
    files: [],
    version: { isUnicode: () => true },
    registryEntries: [{ hive: 2, key: 'Software\\Fixture', name: 'Location', type: 1, value: new Uint8Array(Buffer.from('{app}\\\0', 'utf16le')) }],
    directories: [{ name: '{app}\\emptyFromInstaller' }],
    icons: [{ filename: '{app}\\game.exe', parameters: '--icon-argument' }],
} as unknown as InnoParseResult;

test('old GOG independent RAR parts install game + support/app overlay, preserve dirs and use installer metadata', async () => {
    const f = fixture();
    try {
        f.part(1, [
            { name: 'game/game.exe', body: 'game' }, { name: 'game/options.ini', body: 'old' },
            { name: 'game/emptyFromArchive', directory: true },
            { name: 'game/goggame-123.info', body: JSON.stringify({ name: 'Metadata Name', gameId: '123', playTasks: [{ isPrimary: true, path: 'game.exe', arguments: '--info-argument' }] }) },
            { name: '__unpacker/helper.exe', body: 'must not install' },
        ]);
        f.part(2, [{ name: 'support/app/options.ini', body: 'installed bytes' }, { name: 'support/alternative/options.ini', body: 'not the default' }]);
        const parts = discoverGogRarParts(f.installer)!;
        expect(parts.map(p => p.path.endsWith('-1.bin') || p.path.endsWith('-2.bin'))).toEqual([true, true]);
        const app = await installGogRar(parts, planGogRarLayout(parts), join(f.dir, 'extract'), codec);
        expect(readFileSync(join(app, 'options.ini'), 'utf8')).toBe('installed bytes');
        expect(existsSync(join(app, '__unpacker'))).toBe(false);
        expect(existsSync(join(app, 'support'))).toBe(false);
        const synth = await synthesizeInstalledGog(app, parsed, { os: 'winxp', ramMB: 256 }, {
            '123': { manifest: { emulator: { screenResolution: { width: 800, height: 600, bpp: 32 } } } },
        });
        expect(synth.manifest.entrypoint).toBe('rom/game.exe');
        expect(synth.manifest.args).toBe('--info-argument');
        expect(synth.manifest.gameId).toBe('gog:123');
        expect(synth.manifest.name).toBe('Metadata Name');
        expect((synth.manifest.emulator as any).createDirs).toEqual(['emptyFromArchive', 'emptyFromInstaller']);
        expect((synth.manifest.emulator as any).screenResolution.width).toBe(800);
        expect(synth.registry).toEqual([{ root: 'HKLM', path: 'Software\\Fixture', values: [{ name: 'Location', type: 'REG_SZ', data: 'C:\\' }] }]);
        const output = join(f.dir, 'game.wgb');
        await packInstalledGog(app, output, synth, false);
        const original = readFileSync(output);
        const zip = new ZipArchive(new BufferSource(original)); await zip.init();
        expect(new TextDecoder().decode(await zip.readEntry(zip.getEntry('rom/options.ini')!))).toBe('installed bytes');
        expect(zip.getEntry('rom/goggame-123.info')).toBeUndefined();
        expect(JSON.parse(new TextDecoder().decode(await zip.readEntry(zip.getEntry('manifest.json')!)))).toEqual(synth.manifest);
        await expect(packInstalledGog(app, output, synth, false)).rejects.toThrow('already exists');
        expect(readFileSync(output)).toEqual(original);
        await expect(installGogRar(parts, planGogRarLayout(parts), join(f.dir, 'extract'), codec)).rejects.toThrow('already exists');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('missing/duplicate parts, true volumes, split members and helper-only layouts are refused before publication', () => {
    for (const which of ['gap', 'duplicate', 'volume', 'split', 'helpers', 'collision']) {
        const f = fixture();
        try {
            f.part(which === 'gap' ? 2 : 1, [{ name: which === 'helpers' ? '__unpacker/helper.exe' : 'game/game.exe', body: 'game', flags: which === 'split' ? 1 : 0 }], which === 'volume' ? 1 : 0);
            if (which === 'duplicate') writeFileSync(join(f.dir, 'setup_fixture-01.bin'), rar([{ name: 'game/other.exe', body: 'x' }]));
            if (which === 'collision') f.part(2, [{ name: 'game/GAME.EXE', body: 'different' }]);
            expect(() => { const parts = discoverGogRarParts(f.installer)!; planGogRarLayout(parts); }).toThrow();
            expect(existsSync(join(f.dir, 'extract'))).toBe(false);
        } finally { rmSync(f.dir, { recursive: true, force: true }); }
    }
});

test('standard Inno BIN siblings are left to the existing Inno path; icons remain the fallback without GOG metadata', async () => {
    const f = fixture();
    try {
        writeFileSync(join(f.dir, 'setup_fixture-1.bin'), 'not RAR: standard Inno slice');
        expect(discoverGogRarParts(f.installer)).toBeNull();
        rmSync(join(f.dir, 'setup_fixture-1.bin'));
        f.part(1, [{ name: 'game/game.exe', body: 'game' }]);
        const parts = discoverGogRarParts(f.installer)!;
        const app = await installGogRar(parts, planGogRarLayout(parts), join(f.dir, 'extract'), codec);
        const synth = await synthesizeInstalledGog(app, parsed, {}, {});
        expect(synth.manifest.args).toBe('--icon-argument');
        expect(synth.manifest.entrypoint).toBe('rom/game.exe');
        const missing = { ...parsed, icons: [{ filename: '{app}\\missing.exe', parameters: '' }] } as unknown as InnoParseResult;
        await expect(synthesizeInstalledGog(app, missing, {}, {})).rejects.toThrow('entrypoint is absent');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('installation folds parent directory casing and omits absent createDirs', async () => {
    const f = fixture();
    try {
        f.part(1, [{ name: 'game/game.exe', body: 'game' }, { name: 'game/Data/a.bin', body: 'a' }, { name: 'game/data/b.bin', body: 'b' }]);
        const parts = discoverGogRarParts(f.installer)!;
        const layout = planGogRarLayout(parts);
        expect(layout.files).toContain('Data/a.bin');
        expect(layout.files).toContain('Data/b.bin');
        const app = await installGogRar(parts, layout, join(f.dir, 'extract'), codec);
        expect(readdirSync(app).filter(name => name.toLowerCase() === 'data')).toEqual(['Data']);
        const synth = await synthesizeInstalledGog(app, { ...parsed, directories: [] }, {}, {});
        expect(Object.hasOwn(synth.manifest.emulator as object, 'createDirs')).toBe(false);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('native exclusive publication supports Unicode and refuses a concurrent stale output unchanged', async () => {
    const f = fixture();
    try {
        const pending = join(f.dir, 'черновик-游戏.partial'), output = join(f.dir, 'готово-游戏.wgb');
        writeFileSync(pending, 'complete fixture bytes');
        await publishGogBundle(pending, output);
        expect(readFileSync(output, 'utf8')).toBe('complete fixture bytes');
        expect(existsSync(pending)).toBe(false);
        writeFileSync(pending, 'must never replace existing bytes');
        await expect(publishGogBundle(pending, output)).rejects.toThrow();
        expect(readFileSync(output, 'utf8')).toBe('complete fixture bytes');
        expect(readFileSync(pending, 'utf8')).toBe('must never replace existing bytes');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('failed disk pack closes its writer and removes only its private partial file', async () => {
    const f = fixture();
    try {
        const output = join(f.dir, 'failed.wgb');
        const synth = { manifest: {}, registry: [], paths: ['missing.bin'] } as unknown as Awaited<ReturnType<typeof synthesizeInstalledGog>>;
        await expect(packInstalledGog(f.dir, output, synth, false)).rejects.toThrow();
        expect(existsSync(output)).toBe(false);
        expect(readdirSync(f.dir).filter(name => name.includes('.partial-'))).toEqual([]);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
