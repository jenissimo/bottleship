import {expect, test} from 'bun:test';
import {extractInstallerFromFiles} from '@bottleship/repack/container-extract';
import {findCabinet} from '@bottleship/formats/cab';

function storedCabSfx(name: string, payload: Uint8Array): Uint8Array {
    const filename = new TextEncoder().encode(name + '\0');
    const dataOffset = 44 + 16 + filename.length;
    const cabSize = dataOffset + 8 + payload.length;
    const stubSize = 128;
    const out = new Uint8Array(stubSize + cabSize);
    out.set(new TextEncoder().encode('MZ'), 0);
    // Real stubs carry the signature in machine code as well as at the archive boundary.
    out.set(new TextEncoder().encode('MSCF'), 20);
    const dv = new DataView(out.buffer, stubSize);
    dv.setUint32(0, 0x4643534d, true);
    dv.setUint32(8, cabSize, true); dv.setUint32(16, 44, true);
    dv.setUint8(24, 3); dv.setUint8(25, 1);
    dv.setUint16(26, 1, true); dv.setUint16(28, 1, true);
    dv.setUint32(36, dataOffset, true); dv.setUint16(40, 1, true);
    dv.setUint32(44, payload.length, true);
    out.set(filename, stubSize + 60);
    dv.setUint16(dataOffset + 4, payload.length, true);
    dv.setUint16(dataOffset + 6, payload.length, true);
    out.set(payload, stubSize + dataOffset + 8);
    return out;
}

test('CAB SFX unwraps a direct payload without an InstallShield script', async () => {
    const data = new TextEncoder().encode('MZguest-image');
    const exe = storedCabSfx('Bin\\demo.exe', data);
    expect(findCabinet(exe)).toBe(128);
    const result = await extractInstallerFromFiles(new Map([['download.exe', exe]]));
    expect(result.via).toBe('cab-sfx');
    expect([...result.gameFiles.keys()]).toEqual(['Bin/demo.exe']);
    expect(result.gameFiles.get('Bin/demo.exe')).toEqual(data);
});

test('truncated appended CAB is not treated as a valid self-extractor', async () => {
    const exe = storedCabSfx('game.exe', new Uint8Array([1, 2, 3]));
    const truncated = exe.subarray(0, exe.length - 1);
    expect(findCabinet(truncated)).toBeNull();
    const result = await extractInstallerFromFiles(new Map([['download.exe', truncated]]));
    expect(result.via).toBe('none');
});
