#!/usr/bin/env bun
/**
 * arc-extract: list/extract a FreeArc archive (`ArC\x01` — srep+LZMA), the container
 * some retail and repack installers use for their payload.
 *
 * Usage:
 *   bun tools/arc-extract.ts <archive.arc|.pak> --list [--filter <substr>]
 *   bun tools/arc-extract.ts <archive.arc|.pak> <outDir> [--filter <substr>]
 *
 * Options:
 *   --list             parse the directory and print it; extract nothing
 *   --filter <substr>  keep only paths containing <substr> (case-insensitive)
 *   --verify           check each file against the directory checksum (usually WRONG —
 *                      see FreeArcExtractOptions.verifyCrc; off by default on purpose)
 *
 * Reads through a file descriptor (never readFileSync) — these archives run to gigabytes.
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveArchiveExtractPath } from "./internal/archive-extract-path";
import { UnpackDecoder } from "@bottleship/formats/unpack";
import { readFreeArcListing, extractFreeArc, detectFreeArc } from "@bottleship/formats/freearc";
import { FileSource } from "./internal/file-source";

function flag(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
    return process.argv.includes(name);
}

async function main(): Promise<void> {
    const positional = process.argv.slice(2).filter((a, i, all) => {
        if (a.startsWith("--")) return false;
        const prev = all[i - 1];
        return !(prev === "--filter");
    });
    const archivePath = positional[0];
    const outDir = positional[1];
    const listOnly = has("--list") || !outDir;
    if (!archivePath) {
        console.error("Usage: bun tools/arc-extract.ts <archive> [outDir] [--list] [--filter <substr>] [--verify]");
        process.exit(1);
    }

    const src = new FileSource(resolve(archivePath));
    if (!detectFreeArc(src.readRangeSync(0, 4))) {
        console.error(`${archivePath}: not a FreeArc archive (no ArC\\x01 signature)`);
        process.exit(1);
    }

    const wasmPath = resolve(import.meta.dir, "../public/unpack-streaming.wasm");
    const wasmBytes = readFileSync(wasmPath);
    const lzma = new UnpackDecoder();
    await lzma.init(wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength));

    const filter = flag("--filter")?.toLowerCase();
    const want = (p: string) => (filter ? p.toLowerCase().includes(filter) : true);

    if (listOnly) {
        const { files, blocks } = readFreeArcListing(src, lzma);
        let shown = 0;
        let bytes = 0;
        for (const f of files) {
            if (f.isDir || !want(f.path)) continue;
            shown++;
            bytes += f.size;
            console.log(`${String(f.size).padStart(12)}  blk${String(f.blockIndex).padStart(4)}  ${f.path}`);
        }
        console.log(`\n${shown} file(s), ${bytes} bytes, ${blocks.length} solid block(s)`);
        return;
    }

    const root = resolve(outDir!);
    let n = 0;
    extractFreeArc(src, lzma, (path, data) => {
        const dest = resolveArchiveExtractPath(root, path);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, data);
        n++;
        console.log(`  ${path} (${data.length} b)`);
    }, { wantFile: want, verifyCrc: has("--verify") });
    console.log(`Extracted ${n} file(s) -> ${root}`);
}

main().catch((e) => { console.error(String((e as Error).message ?? e)); process.exit(1); });
