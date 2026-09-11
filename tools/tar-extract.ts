#!/usr/bin/env bun
/**
 * tar-extract: list or extract a `.tar`, `.tar.xz` or `.xz` with our own readers
 * (`packages/formats/src/xz` + `packages/formats/src/tar`) — the shape a Linux game drop
 * (a whole Wine prefix in one tarball) arrives as.
 *
 * Both layers stream, so a multi-GB archive never lands on the heap: xz blocks are decoded
 * one at a time and their output is fed straight through the tar parser to the filesystem.
 *
 * Symlinks are NOT recreated (Windows needs a privilege for that, and a bundle has no use
 * for them) — they are counted and listed at the end so a tree that depends on one is
 * visible rather than quietly incomplete.
 *
 * Usage:
 *   bun tools/tar-extract.ts <archive.tar[.xz]> <out-dir> [--list] [--filter <substr>]
 *                            [--strip <n>] [--quiet] [--no-verify]
 */
import { openSync, writeSync, closeSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { FileSource } from "./internal/file-source";
import { UnpackDecoder } from "@bottleship/formats/unpack";
import { detectXz, parseXz, decodeXz } from "@bottleship/formats/xz";
import { TarStream, type TarEntry, type TarSink } from "@bottleship/formats/tar";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positional = argv.filter((a) => !a.startsWith("--"));
function flagValue(name: string): string | undefined {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
}
// A flag's value is positional-looking; drop it from the positional list.
const consumed = new Set([flagValue("--filter"), flagValue("--strip")].filter(Boolean) as string[]);
const args = positional.filter((a) => !consumed.has(a));

if (args.length < 1) {
    console.error("Usage: bun tools/tar-extract.ts <archive.tar[.xz]> <out-dir> [--list] [--filter s] [--strip n]");
    process.exit(1);
}
const archivePath = resolve(args[0]!);
const listOnly = flags.has("--list");
const quiet = flags.has("--quiet");
const verify = !flags.has("--no-verify");
const filter = flagValue("--filter")?.toLowerCase();
const strip = Number(flagValue("--strip") ?? 0);
if (!listOnly && !args[1]) {
    console.error("An output directory is required unless --list is given.");
    process.exit(1);
}
const outDir = args[1] ? resolve(args[1]!) : "";

function human(n: number): string {
    const units = ["B", "KiB", "MiB", "GiB"];
    let v = n;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) {
        v /= 1024;
        u++;
    }
    return `${v.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
}

/** Strip leading path components and reject anything that escapes the output root. */
function outPathFor(name: string): string | null {
    const parts = name.replace(/\\/g, "/").split("/").filter((p) => p !== "" && p !== ".");
    if (parts.some((p) => p === "..")) return null;
    const kept = parts.slice(strip);
    if (kept.length === 0) return null;
    return join(outDir, ...kept);
}

const stats = { files: 0, dirs: 0, bytes: 0, symlinks: [] as string[], other: [] as string[], skipped: 0 };
const madeDirs = new Set<string>();
function ensureDir(dir: string): void {
    if (madeDirs.has(dir)) return;
    mkdirSync(dir, { recursive: true });
    madeDirs.add(dir);
}

function onEntry(entry: TarEntry): TarSink | null {
    const wanted = !filter || entry.name.toLowerCase().includes(filter);
    if (entry.kind === "symlink" || entry.kind === "hardlink") {
        stats.symlinks.push(`${entry.name} -> ${entry.linkName}`);
        return null;
    }
    if (entry.kind === "other") {
        stats.other.push(`${entry.name} (typeflag '${entry.typeFlag}')`);
        return null;
    }
    if (!wanted) {
        stats.skipped++;
        return null;
    }
    if (entry.kind === "dir") {
        stats.dirs++;
        if (!listOnly) {
            const path = outPathFor(entry.name);
            // An empty directory is invisible in a .wgb ZIP later; materialize it here so
            // make-wgb's auto-detect can see it and seed emulator.createDirs.
            if (path) ensureDir(path);
        }
        if (listOnly && !quiet) console.log(`d ${entry.name}`);
        return null;
    }

    stats.files++;
    stats.bytes += entry.size;
    if (listOnly) {
        if (!quiet) console.log(`- ${entry.name}  ${human(entry.size)}`);
        return null;
    }
    const path = outPathFor(entry.name);
    if (!path) {
        stats.skipped++;
        return null;
    }
    ensureDir(dirname(path));
    const fd = openSync(path, "w");
    let written = 0;
    return {
        write(chunk) {
            let off = 0;
            while (off < chunk.length) off += writeSync(fd, chunk, off, chunk.length - off);
            written += chunk.length;
        },
        end() {
            closeSync(fd);
            if (written !== entry.size) {
                throw new Error(`${entry.name}: wrote ${written} bytes, header says ${entry.size}`);
            }
        },
    };
}

const src = new FileSource(archivePath);
const tar = new TarStream({ onEntry });
const head = src.readRangeSync(0, 12);

if (detectXz(head)) {
    const stream = parseXz(src);
    if (!quiet) {
        console.log(
            `xz: ${stream.blocks.length} block(s), ${human(src.size)} compressed → ${human(stream.uncompressedSize)}` +
                ` (check ${stream.checkSize * 8}-bit${verify ? "" : ", NOT verified"})`,
        );
    }
    const wasmBytes = readFileSync(resolve(import.meta.dir, "../public/unpack-streaming.wasm"));
    const decoder = new UnpackDecoder();
    await decoder.init(wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength));
    const started = Date.now();
    decodeXz(src, decoder, stream, (bytes) => tar.push(bytes), {
        verify,
        onBlock: (i, b) => {
            if (quiet) return;
            const secs = (Date.now() - started) / 1000;
            process.stderr.write(
                `\rblock ${i + 1}/${stream.blocks.length}  ${human(i * b.uncompressedSize)} done  ${secs.toFixed(0)}s`,
            );
        },
    });
    if (!quiet) process.stderr.write("\n");
} else {
    // Plain tar — stream it in windows rather than reading a multi-GB file whole.
    const CHUNK = 8 << 20;
    for (let off = 0; off < src.size; off += CHUNK) {
        tar.push(src.readRangeSync(off, Math.min(off + CHUNK, src.size)));
    }
}
tar.end();

console.log(
    `${listOnly ? "listed" : "extracted"} ${stats.files} file(s), ${human(stats.bytes)}, ${stats.dirs} dir(s)` +
        (stats.skipped ? `, ${stats.skipped} skipped` : ""),
);
if (stats.symlinks.length) {
    console.log(`${stats.symlinks.length} link(s) NOT recreated:`);
    for (const s of stats.symlinks.slice(0, 40)) console.log(`  ${s}`);
    if (stats.symlinks.length > 40) console.log(`  … ${stats.symlinks.length - 40} more`);
}
if (stats.other.length) {
    console.log(`${stats.other.length} unsupported entry type(s) skipped:`);
    for (const s of stats.other.slice(0, 20)) console.log(`  ${s}`);
}
