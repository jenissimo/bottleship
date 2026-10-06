#!/usr/bin/env bun
/** Extract static NSIS 2 ANSI/non-solid zlib sections; installer actions never run. */
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {parseNsis, extractNsisFile} from '@bottleship/formats/nsis';
import {FileSource} from './internal/file-source';
import {resolveArchiveExtractPath} from './internal/archive-extract-path';

const [input, output, ...args] = process.argv.slice(2);
if (!input || !output) {
    console.error('Usage: bun tools/nsis-extract.ts <installer.exe> <output-dir> [--list]');
    process.exit(1);
}
const source = new FileSource(input), archive = parseNsis(source);
if (args.includes('--list')) {
    for (const file of archive.files) console.log(`${file.dataOffset}\t${file.path}`);
} else {
    for (const dir of archive.directories) mkdirSync(resolveArchiveExtractPath(output, dir), {recursive: true});
    let total = 0;
    for (const file of archive.files) {
        const dest = resolveArchiveExtractPath(output, file.path), bytes = extractNsisFile(source, archive, file);
        mkdirSync(dirname(dest), {recursive: true}); writeFileSync(dest, bytes); total += bytes.length;
        console.log(`${bytes.length}\t${file.path}`);
    }
    console.log(`Extracted ${archive.files.length} files, ${total} bytes into ${output}`);
}
