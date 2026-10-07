#!/usr/bin/env bun
/** Opt-in real-distribution regression; installers stay outside the repository. */
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import { unzipToMap } from '@bottleship/formats/zip';
import { extractInstallerFromFiles } from '@bottleship/repack/container-extract';

const sourceDir = process.argv[2];
if (!sourceDir) throw new Error('Usage: bun tools/tests/legacy-demo-installers.smoke.ts <original-installer-directory>');
const wasm = await Bun.file(new URL('../../public/unpack-streaming.wasm', import.meta.url)).arrayBuffer();
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const cases = [
    { source: 'Cossacks.exe', sha: '942292714b1bfae09139ecf584117027b3ecf679b9c1e5119b0b6d88a096aabb',
        via: 'wise', files: 1322, bytes: 77175844, tree: '186bfe9a222c6aae19cc31098f60bfca93838bfbd410d588fd354ae011f4189a' },
    { source: 'Mafia.exe', sha: '54cacf5deb5883f9511fee64c5d47a4f853dc5301c1d6ac8b71474dc1d7eafd7',
        via: 'rar4', files: 27, bytes: 257336479, tree: 'e739c5b1409481ff0223897fc91c276dc6d3652a3c567fff76c80ed27af9f295' },
    { source: 'Carmageddon2Demo.zip', sha: '30e54dd63d450f0c78ae834586b42fbaa232974f0523b86bc36d49dd1f9a10ee',
        via: 'installshield3', files: 1605, bytes: 42359100, tree: '7f4e258365f884d656212633bb92c47322f4f107d97a51beca6fde27b701fbb7' },
    { source: 'Painkiller_SP_Demo2_Setup.exe', sha: 'acfaca1da2b2c663bc846aedf63a6e35122df49955d7b391c97c26762d48eda0',
        via: 'vise', files: 55, bytes: 176725712, tree: 'b1335e4d8ce9a25165ce1ab329d747a04a93dc3c321f30c8a0dd341a40b9adfe' },
    { source: 'wwp_demo.exe', sha: '870f44f7d6bbe38b6c4c71bfd157e1587566149a4ff13a47295a69cbcad7eb6e',
        via: 'rar4', files: 625, bytes: 20090383, tree: 'f065f41cf15549121cfa2134dd8b01f3e62c8ba444bc3e3ecbd4970925d04e41' },
];

for (const expected of cases) {
    const input = new Uint8Array(await Bun.file(join(sourceDir, expected.source)).arrayBuffer());
    if (sha256(input) !== expected.sha) throw new Error(`${expected.source}: source SHA256 differs from the reference distribution`);
    const wrapped = input[0] === 0x50 && input[1] === 0x4b
        ? await unzipToMap(input) : new Map([[expected.source, input]]);
    const result = await extractInstallerFromFiles(wrapped, {
        innoWasm: wasm,
        inflateRaw: data => new Uint8Array(inflateRawSync(data)),
        cabInflateBlock: (data, dictionary) => new Uint8Array(inflateRawSync(data, { dictionary })),
    });
    const files = [...result.gameFiles].filter(([name]) => !name.endsWith('/'))
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const bytes = files.reduce((total, [, data]) => total + data.length, 0);
    const tree = createHash('sha256');
    for (const [name, data] of files) tree.update(`${name}\0${data.length}\0${sha256(data)}\n`);
    if (result.via !== expected.via || files.length !== expected.files || bytes !== expected.bytes || tree.digest('hex') !== expected.tree) {
        throw new Error(`${expected.source}: extracted file transcript differs (${result.via}, ${files.length} files, ${bytes} bytes)`);
    }
    console.log(`${expected.source}: ${result.via}, ${files.length} files, ${bytes} bytes; SHA256 transcript verified`);
}
