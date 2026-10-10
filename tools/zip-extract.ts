#!/usr/bin/env bun
/** Extract ZIPs, including executable SFX prefixes, with the shared format reader. */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ZipArchive, BufferSource } from '@bottleship/formats/zip';
import { resolveArchiveExtractPath } from './internal/archive-extract-path';

const [input, destination, ...options] = process.argv.slice(2);
const list = options.includes('--list');
if (!input || !destination) {
    console.error('Usage: bun tools/zip-extract.ts <archive.zip|sfx.exe> <out-dir> [--list]');
    process.exit(1);
}
const archive = new ZipArchive(new BufferSource(new Uint8Array(await Bun.file(input).arrayBuffer())));
await archive.init();
const output = resolve(destination);
const entries = archive.listEntries().map(entry => ({ entry, path: resolveArchiveExtractPath(output, entry.name) }));
const seen = new Set<string>();
for (const { entry, path } of entries) {
    if (seen.has(path.toLowerCase())) throw new Error(`ZIP destination collision: ${entry.name}`);
    seen.add(path.toLowerCase());
}
if (!list && existsSync(output) && readdirSync(output).length) throw new Error('Extraction directory must be empty');
for (const { entry, path } of entries) {
    if (list) console.log(`${entry.isDirectory ? '<DIR>' : entry.uncompressedSize}\t${entry.name}`);
    else {
        mkdirSync(entry.isDirectory ? path : dirname(path), { recursive: true });
        if (!entry.isDirectory) writeFileSync(path, await archive.readEntry(entry), { flag: 'wx' });
    }
}
console.log(`${entries.length} ZIP entries ${list ? 'listed' : 'extracted'}`);
