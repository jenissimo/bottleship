#!/usr/bin/env bun
/**
 * Extract an MPQ archive — including one appended to a Blizzard self-extracting
 * installer (`.exe`), which is how Warcraft/Diablo/StarCraft-era demos shipped.
 *
 * Usage:
 *   bun tools/mpq-extract.ts <archive.mpq|installer.exe> <out-dir> [--list]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { resolveArchiveExtractPath } from "./internal/archive-extract-path";
import { MpqArchive } from "../packages/formats/src/mpq";

const [input, outDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const listOnly = process.argv.includes("--list");

if (!input || (!outDir && !listOnly)) {
    console.error("usage: bun tools/mpq-extract.ts <archive.mpq|installer.exe> <out-dir> [--list]");
    process.exit(1);
}

const data = new Uint8Array(await Bun.file(input).arrayBuffer());
const archive = new MpqArchive(data);
const h = archive.header;
console.log(
    `MPQ at 0x${h.base.toString(16)}: v${h.formatVersion}, ${h.blockTableCount} blocks, ` +
        `sector ${h.sectorSize}, archive ${h.archiveSize} bytes`,
);

const entries = archive.listFiles();
if (entries.length === 0) {
    // A Blizzard installer payload has no (listfile) — MPQ stores hashes, not
    // names. Dump by block index instead; the names live in the install script
    // among these blocks.
    console.log("no (listfile) — extracting by block index");
    if (listOnly) {
        for (let i = 0; i < archive.header.blockTableCount; i++) {
            const info = archive.blockInfo(i);
            console.log(`${String(i).padStart(4)}  ${String(info.size).padStart(12)}  ${String(info.compressedSize).padStart(12)}  0x${info.flags.toString(16)}`);
        }
        process.exit(0);
    }
    let count = 0;
    let blockFailures = 0;
    for (let i = 0; i < archive.header.blockTableCount; i++) {
        const target = join(outDir, `block${String(i).padStart(4, "0")}.bin`);
        try {
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, archive.readBlockByIndex(i));
            count++;
        } catch (err) {
            blockFailures++;
            console.error(`  FAILED block ${i}: ${(err as Error).message}`);
        }
    }
    console.log(`extracted ${count}/${archive.header.blockTableCount} blocks to ${outDir}`);
    // Same exit contract as the named path — a caller scripting this must not read a
    // partial extraction as success.
    process.exit(blockFailures ? 3 : 0);
}

if (listOnly) {
    for (const e of entries) {
        console.log(`${String(e.size).padStart(12)}  ${String(e.compressedSize).padStart(12)}  0x${e.flags.toString(16).padStart(8, "0")}  ${e.name}`);
    }
    console.log(`${entries.length} files`);
    process.exit(0);
}

let written = 0;
let failed = 0;
for (const e of entries) {
    let target: string;
    try {
        target = resolveArchiveExtractPath(outDir, e.name);
        const bytes = archive.readFile(e.name);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
        written++;
        if (bytes.length !== e.size) console.warn(`  short: ${e.name} (${bytes.length}/${e.size})`);
    } catch (err) {
        failed++;
        console.error(`  FAILED ${e.name}: ${(err as Error).message}`);
    }
}
console.log(`extracted ${written} files to ${outDir}${sep}${failed ? `, ${failed} failed` : ""}`);
if (failed) process.exit(3);
