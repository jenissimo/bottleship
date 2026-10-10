#!/usr/bin/env bun
/** Extract an installer (or a ZIP wrapping one) through the shared self-hosted format registry. */
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { extractInstallerFromFiles } from '@bottleship/repack/container-extract';
import { unzipToMap } from '@bottleship/formats/zip';
import { resolveArchiveExtractPath } from './internal/archive-extract-path';

const args = process.argv.slice(2);
const reportAt = args.indexOf('--report');
const report = reportAt >= 0 ? args[reportAt + 1] : undefined;
const positional = args.filter((arg, i) => !arg.startsWith('--') && !(reportAt >= 0 && i === reportAt + 1));
const [input, destination] = positional;
const list = args.includes('--list');
if (!input || (!destination && !list) || (reportAt >= 0 && !report)) {
    console.error('Usage: bun tools/installer-extract.ts <installer.exe|archive.zip|data.z> <out-dir> [--list] [--report evidence.json]');
    process.exit(1);
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = new Uint8Array(await Bun.file(input).arrayBuffer());
const files = bytes[0] === 0x50 && bytes[1] === 0x4b
    ? await unzipToMap(bytes) : new Map([[basename(input), bytes]]);
const result = await extractInstallerFromFiles(files, {
    innoWasm: await Bun.file(new URL('../public/unpack-streaming.wasm', import.meta.url)).arrayBuffer(),
    inflateRaw: chunk => new Uint8Array(inflateRawSync(chunk)),
    cabInflateBlock: (chunk, dictionary) => new Uint8Array(inflateRawSync(chunk, { dictionary })),
});
if (result.via === 'none') throw new Error(`No supported installer payload: ${result.note}`);
const output = destination ? resolve(destination) : '';
const entries = [...result.gameFiles].map(([name, data]) => ({ name, data,
    path: resolveArchiveExtractPath(output || '.', name), directory: name.endsWith('/') }));
const seen = new Set<string>();
for (const e of entries) {
    const key = e.path.toLowerCase();
    if (seen.has(key)) throw new Error(`Installer destination collision: ${e.name}`);
    seen.add(key);
}
if (!list) {
    if (existsSync(output) && readdirSync(output).length) throw new Error('Extraction directory must be empty');
    mkdirSync(output, { recursive: true });
    for (const e of entries) {
        mkdirSync(e.directory ? e.path : dirname(e.path), { recursive: true });
        if (!e.directory) writeFileSync(e.path, e.data, { flag: 'wx' });
    }
} else {
    for (const e of entries) console.log(`${e.directory ? '<DIR>' : e.data.length}\t${e.name}`);
}
const fileEntries = entries.filter(e => !e.directory);
const evidence = {
    source: resolve(input), sourceBytes: bytes.length, sourceSha256: sha256(bytes),
    via: result.via, note: result.note, files: fileEntries.length,
    directories: entries.length - fileEntries.length,
    extractedBytes: fileEntries.reduce((n, e) => n + e.data.length, 0),
    entries: entries.map(e => ({ name: e.name, bytes: e.data.length,
        ...(e.directory ? { directory: true } : { sha256: sha256(e.data) }) })),
};
if (report) {
    mkdirSync(dirname(resolve(report)), { recursive: true });
    writeFileSync(report, JSON.stringify(evidence, null, 2) + '\n');
}
console.log(`${result.note}: ${evidence.files} files, ${evidence.directories} directories, ${evidence.extractedBytes} bytes`);
