import { expect, test } from 'bun:test';
import { buildZip } from '../../packages/formats/src/wgb/zip-build';
import { extractInstallShieldSfx, isInstallShieldSfx } from '../../packages/formats/src/installshield-sfx';

const encode = (text: string) => new TextEncoder().encode(text);
function stub(): Uint8Array {
    const bytes = new Uint8Array(512);
    const view = new DataView(bytes.buffer);
    bytes.set([0x4d, 0x5a]); view.setUint32(60, 128, true); view.setUint16(128, 0x454e, true);
    bytes.set(encode('InstallShield Self-Extracting Stub Program'), 160);
    return bytes;
}
function zip(name: string, text: string): Uint8Array { return buildZip(new Map([[name, encode(text)]])); }
function join(...parts: Uint8Array[]): Uint8Array {
    const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
}
const gap = encode('installer directory metadata');

test('NE self-extractor preserves every independently terminated ZIP, including empty files', async () => {
    const bytes = join(stub(), zip('first.txt', 'first'), gap, zip('dir/empty.dat', ''), gap, zip('last.exe', 'last'));
    expect(isInstallShieldSfx(bytes)).toBe(true);
    const files = await extractInstallShieldSfx(bytes);
    expect([...files.keys()]).toEqual(['first.txt', 'dir/empty.dat', 'last.exe']);
    expect([...files.values()].map(data => new TextDecoder().decode(data))).toEqual(['first', '', 'last']);
});

test('CRC corruption of an early record cannot be hidden by a valid final ZIP', async () => {
    const first = zip('first.txt', 'first'); first[30 + 'first.txt'.length] ^= 1;
    await expect(extractInstallShieldSfx(join(stub(), first, gap, zip('last.exe', 'last')))).rejects.toThrow('CRC mismatch');
});

test('a truncated final record refuses the entire extraction', async () => {
    const bytes = join(stub(), zip('first.txt', 'first'), gap, zip('last.exe', 'last'));
    await expect(extractInstallShieldSfx(bytes.subarray(0, bytes.length - 4))).rejects.toThrow('truncated');
});

test('invalid record headers and multi-file records are refused', async () => {
    const damaged = zip('first.txt', 'first'); damaged[0] = 0;
    await expect(extractInstallShieldSfx(join(stub(), damaged, zip('last.exe', 'last')))).rejects.toThrow('damaged ZIP record');
    const multiple = buildZip(new Map([['a', encode('a')], ['b', encode('b')]]));
    await expect(extractInstallShieldSfx(join(stub(), multiple))).rejects.toThrow('one-file');
});

test('unsafe paths and case-insensitive destination collisions are refused', async () => {
    await expect(extractInstallShieldSfx(join(stub(), zip('../outside', 'a')))).rejects.toThrow('Unsafe');
    await expect(extractInstallShieldSfx(join(stub(), zip('File', 'a'), gap, zip('file', 'b')))).rejects.toThrow('duplicate');
});

test('plain ZIPs and unrelated NE executables are not InstallShield self-extractors', () => {
    expect(isInstallShieldSfx(zip('file', 'data'))).toBe(false);
    const bytes = stub(); bytes.fill(0, 160);
    expect(isInstallShieldSfx(bytes)).toBe(false);
});
