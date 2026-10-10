#!/usr/bin/env bun
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { extractInstallShieldSfx } from '@bottleship/formats/installshield-sfx';
import { resolveArchiveExtractPath } from './internal/archive-extract-path';
const [input, destination, ...options] = process.argv.slice(2);
if (!input || !destination) {
    console.error('Usage: bun tools/installshield-sfx-extract.ts <installer.exe> <out-dir> [--list]');
    process.exit(1);
}
const files = await extractInstallShieldSfx(new Uint8Array(await Bun.file(input).arrayBuffer()));
const output = resolve(destination), list = options.includes('--list');
if (!list && existsSync(output) && readdirSync(output).length) throw new Error('Extraction directory must be empty');
for (const [name, bytes] of files) {
    const path = resolveArchiveExtractPath(output, name);
    if (list) console.log(`${bytes.length}\t${name}`);
    else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes, { flag: 'wx' }); }
}
console.log(`${files.size} InstallShield SFX files ${list ? 'listed' : 'extracted'}`);
