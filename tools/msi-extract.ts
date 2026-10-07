#!/usr/bin/env bun
/** Read an MSI installed tree using our CFB/MSI/CAB readers; no installer execution. */
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {inflateRawSync} from 'node:zlib';
import {MsiDatabase, msiFilePaths} from '@bottleship/formats/msi';
import {extractMsiPayload} from '@bottleship/repack/msi-extract';
import {resolveArchiveExtractPath} from './internal/archive-extract-path';
const [input, output, ...args] = process.argv.slice(2);
if (!input || !output) {
    console.error('Usage: bun tools/msi-extract.ts <installer.msi> <output-dir> [--root INSTALLDIR] [--list]'); process.exit(1);
}
const index = args.indexOf('--root');
const installDirectory = index >= 0 ? args[index + 1] : 'INSTALLDIR';
if (!installDirectory) throw new Error('--root requires an MSI Directory key');
const msi = readFileSync(input);
if (args.includes('--list')) {
    for (const file of msiFilePaths(new MsiDatabase(msi), installDirectory)) console.log(`${file.size}\t${file.path}\t${file.key}`);
} else {
    const base = dirname(resolve(input));
    const files = await extractMsiPayload(msi, name => {
        const path = resolveArchiveExtractPath(base, name);
        return readFileSync(path);
    }, {installDirectory, inflateBlock: (chunk, dictionary) => inflateRawSync(chunk, {dictionary})});
    let size = 0;
    for (const [name, bytes] of files) {
        const path = resolveArchiveExtractPath(output, name); mkdirSync(dirname(path), {recursive: true}); writeFileSync(path, bytes); size += bytes.length;
    }
    console.log(`Extracted ${files.size} files, ${size} bytes into ${output}`);
}
