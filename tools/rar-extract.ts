#!/usr/bin/env bun
/**
 * rar-extract: List or extract a RAR5 archive using our own reader
 * (`packages/formats/src/rar/`). STORED entries only — game drops are routinely a
 * store-only `.rar` around an installer, and that is the case this exists to unwrap;
 * a compressed/encrypted/solid entry is refused by name rather than mis-extracted.
 *
 * Multi-volume sets (`name.part1.rar`, `name.part2.rar`, …) are followed automatically
 * from the first volume, and a file split across volumes is concatenated in order.
 *
 * Usage:
 *   bun tools/rar-extract.ts <archive.rar> <out-dir> [--list] [--quiet] [--no-verify]
 */
import { openSync, writeSync, closeSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { parseRar, assertExtractable, volumeName, RarError, type RarEntry } from "@bottleship/formats/rar";
import { Crc32 } from "@bottleship/formats/unpack";
import { FileSource } from "./internal/file-source";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
if (positional.length < 1) {
    console.error("Usage: bun tools/rar-extract.ts <archive.rar> <out-dir> [--list] [--quiet] [--no-verify]");
    process.exit(1);
}
const [archivePath, outDirArg] = positional as [string, string | undefined];
const listOnly = flags.has("--list");
const quiet = flags.has("--quiet");
const verify = !flags.has("--no-verify");
if (!listOnly && !outDirArg) {
    console.error("An output directory is required unless --list is given.");
    process.exit(1);
}
const outDir = outDirArg ? resolve(outDirArg) : "";

const CHUNK = 8 << 20;

function human(n: number): string {
    const units = ["B", "KiB", "MiB", "GiB"];
    let v = n, u = 0;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
    return `${v.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
}

/** Every volume of the set, in order, starting from the given file. */
function volumePaths(first: string): string[] {
    const paths = [first];
    for (let i = 1; ; i++) {
        const next = volumeName(first, i);
        if (!next || !existsSync(next)) break;
        paths.push(next);
    }
    return paths;
}

interface VolumeEntries {
    path: string;
    source: FileSource;
    entries: RarEntry[];
}

const volumes: VolumeEntries[] = [];
try {
    for (const path of volumePaths(archivePath)) {
        const source = new FileSource(path);
        const archive = parseRar(source);
        volumes.push({ path, source, entries: archive.entries });
        if (!archive.multiVolume) break;
    }
} catch (err) {
    fail(err);
}

/** Join split parts: an entry with splitBefore continues the previous volume's last file. */
interface Job {
    name: string;
    isDirectory: boolean;
    unpackedSize: number;
    crc32: number | null;
    /** Why extraction would refuse this entry, for `--list`. null = extractable. */
    why: string | null;
    parts: { source: FileSource; offset: number; length: number }[];
}

const jobs: Job[] = [];
for (const vol of volumes) {
    for (const entry of vol.entries) {
        if (entry.service) continue;
        // Every part is checked, continuation included: a set can turn compressed or
        // encrypted at the volume boundary, and only the first part would be seen otherwise.
        if (!listOnly) assertExtractableOrExit(entry);
        const part = { source: vol.source, offset: entry.dataOffset, length: entry.packedSize };
        const previous = jobs[jobs.length - 1];
        if (entry.splitBefore && previous && previous.name === entry.name) {
            previous.parts.push(part);
            continue;
        }
        jobs.push({
            name: entry.name,
            isDirectory: entry.isDirectory,
            unpackedSize: entry.unpackedSize,
            crc32: entry.crc32,
            why: whyNotExtractable(entry),
            parts: entry.isDirectory ? [] : [part],
        });
    }
}

/** The reason this entry cannot be extracted, or null. Same authority as the refusal. */
function whyNotExtractable(entry: RarEntry): string | null {
    if (entry.isDirectory) return null;
    try {
        assertExtractable(entry);
        return null;
    } catch (err) {
        return err instanceof RarError ? err.message : String(err);
    }
}

function assertExtractableOrExit(entry: RarEntry): void {
    if (entry.isDirectory) return;
    try {
        assertExtractable(entry);
    } catch (err) {
        fail(err);
    }
}

/** Every failure leaves by this door: one message shape, one exit code, no stack dump. */
function fail(err: unknown): never {
    console.error(err instanceof RarError ? `rar: ${err.message}` : `rar: ${err}`);
    process.exit(1);
}

if (listOnly) {
    let refused = 0;
    for (const job of jobs) {
        const size = job.isDirectory ? "  <DIR>" : String(job.unpackedSize).padStart(12);
        // A listing that hides the refusal invites "it listed fine, why won't it extract".
        if (job.why) refused++;
        console.log(`${size}  ${job.name}${job.why ? `   [NOT EXTRACTABLE: ${job.why}]` : ""}`);
    }
    console.log(`--- ${jobs.length} entries across ${volumes.length} volume(s)`
        + (refused ? `, ${refused} NOT extractable` : ""));
    process.exit(0);
}

/** Reject an entry name that would escape the output directory (`..`, absolute, drive). */
function safeJoin(base: string, name: string): string {
    const target = resolve(base, name.replace(/\\/g, "/"));
    if (target !== base && !target.startsWith(base + sep)) {
        throw new RarError(`entry "${name}" escapes the output directory`);
    }
    return target;
}

mkdirSync(outDir, { recursive: true });
let written = 0;

for (const job of jobs) {
    let target: string;
    try {
        target = safeJoin(outDir, job.name);
    } catch (err) {
        fail(err);
    }
    if (job.isDirectory) {
        mkdirSync(target, { recursive: true });
        continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    const crc = new Crc32();
    const fd = openSync(target, "w");
    let done = 0;
    let ended: unknown = null;
    try {
        for (const part of job.parts) {
            for (let at = 0; at < part.length; ) {
                const want = Math.min(CHUNK, part.length - at);
                const chunk = part.source.readRangeSync(part.offset + at, part.offset + at + want);
                if (chunk.length === 0) { ended = new RarError(`"${job.name}": archive ended early`); break; }
                writeSync(fd, chunk, 0, chunk.length);
                if (verify) crc.update(chunk);
                at += chunk.length;
                done += chunk.length;
                if (!quiet && job.unpackedSize > CHUNK) {
                    process.stdout.write(`\r  ${job.name}  ${human(done)} / ${human(job.unpackedSize)}   `);
                }
            }
            if (ended) break;
        }
    } finally {
        closeSync(fd);
    }
    if (!quiet && job.unpackedSize > CHUNK) process.stdout.write("\r");
    if (ended) fail(ended);
    if (done !== job.unpackedSize) {
        console.error(`\nrar: "${job.name}" wrote ${done} bytes, header says ${job.unpackedSize}`);
        process.exit(1);
    }
    if (verify && job.crc32 !== null && crc.finalize() !== job.crc32) {
        console.error(`\nrar: "${job.name}" CRC32 mismatch (archive damaged)`);
        process.exit(1);
    }
    written++;
    if (!quiet) console.log(`  ${job.name}  ${human(job.unpackedSize)}${verify && job.crc32 !== null ? "  crc ok" : ""}`);
}

console.log(`Extracted ${written} file(s) to ${outDir}`);
