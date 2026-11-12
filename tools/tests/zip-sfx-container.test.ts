/**
 * A ZIP appended to a Win32 stub (GTA's Rockstar Classics installer: an InstallShield 5
 * disk set behind a small self-extractor) unwraps through the format registry, like the
 * CAB self-extractors do. The archive keeps either offset convention: relative to its own
 * start, or absolute in the exe as that installer writes them.
 */
import { expect, test } from 'bun:test';
import { extractInstallerFromFiles } from '@bottleship/repack/container-extract';
import { buildZip } from '@bottleship/formats/wgb/zip-build';

function sfx(zip: Uint8Array): Uint8Array {
    const stub = new Uint8Array(512);
    stub.set(new TextEncoder().encode('MZ'), 0);
    const out = new Uint8Array(stub.length + zip.length);
    out.set(stub); out.set(zip, stub.length);
    return out;
}

test('ZIP SFX unwraps the archive behind the stub', async () => {
    const data = new TextEncoder().encode('MZguest-image');
    const exe = sfx(buildZip(new Map([['GAME/game.exe', data], ['GAME/readme.txt', new Uint8Array([1, 2])]])));
    const result = await extractInstallerFromFiles(new Map([['setup.exe', exe]]));
    expect(result.via).toBe('zip-sfx');
    expect(result.gameFiles.get('GAME/game.exe')).toEqual(data);
    expect(result.gameFiles.get('GAME/readme.txt')).toEqual(new Uint8Array([1, 2]));
});

test('an exe without an appended archive is left alone', async () => {
    const exe = new Uint8Array(4096);
    exe.set(new TextEncoder().encode('MZ'), 0);
    const result = await extractInstallerFromFiles(new Map([['tool.exe', exe]]));
    expect(result.via).toBe('none');
});
