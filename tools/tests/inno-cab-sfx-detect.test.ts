/**
 * An Inno Setup installer is not a CAB self-extractor, even though its payload can hold a
 * complete, self-consistent cabinet (GOG installers store DirectX's dxdllreg cabinet).
 * Taking the first plausible MSCF for the archive sent such an installer into the CAB
 * reader, which then failed deep in LZX on bytes that were never its stream.
 */
import { expect, test } from 'bun:test';
import { extractInstallerFromFiles, isInnoSetupLoader } from '@bottleship/repack/container-extract';
import { findCabinet } from '@bottleship/formats/cab';

/** A one-file stored (uncompressed) cabinet. */
function storedCab(name: string, payload: Uint8Array): Uint8Array {
    const filename = new TextEncoder().encode(name + '\0');
    const dataOffset = 44 + 16 + filename.length;
    const cabSize = dataOffset + 8 + payload.length;
    const out = new Uint8Array(cabSize);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x4643534d, true);
    dv.setUint32(8, cabSize, true); dv.setUint32(16, 44, true);
    dv.setUint8(24, 3); dv.setUint8(25, 1);
    dv.setUint16(26, 1, true); dv.setUint16(28, 1, true);
    dv.setUint32(36, dataOffset, true); dv.setUint16(40, 1, true);
    dv.setUint32(44, payload.length, true);
    out.set(filename, 60);
    dv.setUint16(dataOffset + 4, payload.length, true);
    dv.setUint16(dataOffset + 6, payload.length, true);
    out.set(payload, dataOffset + 8);
    return out;
}

/** Inno 5.1.5+ setup-loader magic ("rDlPtS" + version bytes). */
const LOADER_MAGIC_5_1_5 = [0x72, 0x44, 0x6c, 0x50, 0x74, 0x53, 0xcd, 0xe6, 0xd7, 0x7b, 0x0b, 0x2a];

/**
 * MZ stub with the classic setup-loader pointer at 0x30 ("Inno", table, ~table), the
 * loader table, then `payload` where Inno keeps its compressed setup data.
 */
function innoLoaderExe(payload: Uint8Array): Uint8Array {
    const table = 0x100;
    const dataOffset = 0x200;
    const out = new Uint8Array(dataOffset + payload.length + 64);
    const dv = new DataView(out.buffer);
    out[0] = 0x4d; out[1] = 0x5a;
    dv.setUint32(0x30, 0x6f6e6e49, true);
    dv.setUint32(0x34, table, true);
    dv.setUint32(0x38, ~table >>> 0, true);
    out.set(LOADER_MAGIC_5_1_5, table);
    // 5.1.5 layout: revision, totalSize, exeOffset, exeUncompressedSize, exeCrc, then
    // headerOffset and dataOffset.
    dv.setUint32(table + 12, 1, true);
    dv.setUint32(table + 16, out.length, true);
    dv.setUint32(table + 32, dataOffset, true);
    dv.setUint32(table + 36, dataOffset, true);
    out.set(payload, dataOffset);
    return out;
}

test('a cabinet stored inside an Inno payload does not make the installer a CAB SFX', async () => {
    const cab = storedCab('dxdllreg_x86.inf', new TextEncoder().encode('[Version]'));
    const exe = innoLoaderExe(cab);
    // The trap is real: the cabinet parses and is the first MSCF in the file.
    expect(findCabinet(exe)).toBe(0x200);
    expect(isInnoSetupLoader(exe)).toBe(true);

    // No LZMA codec supplied, so the Inno reader cannot claim it either — the installer
    // must come back unrecognized, not unwrapped as a cabinet.
    const result = await extractInstallerFromFiles(new Map([['setup_game.exe', exe]]));
    expect(result.via).toBe('none');
});

test('an exe without a setup-loader table is not an Inno loader', () => {
    const cabSfx = new Uint8Array(128 + 128);
    cabSfx[0] = 0x4d; cabSfx[1] = 0x5a;
    cabSfx.set(storedCab('game.exe', new Uint8Array([1, 2, 3])), 128);
    expect(isInnoSetupLoader(cabSfx)).toBe(false);
    // A pointer whose complement check fails is not a loader table.
    const forged = innoLoaderExe(new Uint8Array(4));
    new DataView(forged.buffer).setUint32(0x38, 0, true);
    expect(isInnoSetupLoader(forged)).toBe(false);
});
