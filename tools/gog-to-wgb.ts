#!/usr/bin/env bun
/**
 * gog-to-wgb: Extract GOG Inno installers or old Inno + numbered independent RAR payloads.
 *
 * Usage:
 *   bun tools/gog-to-wgb.ts <gog-installer.exe> <output.wgb> [options]
 *
 * --extract-dir <new-dir> stages files on the selected disk (kept when explicitly set).
 * --extract-only writes files and lists paths without packing or reloading payload bytes.
 * --keep-gog retains GOG support metadata in the final bundle.
 * --name/--exe/--args/--width/--height/--bpp/--ram/--os override synthesized settings.
 * --reg-path/--reg-hive/--reg-install override the installer registry seed.
 * --language selects an installer locale; --skip-video is opt-in.
 * --native is a deprecated no-op: the project's WASM parser is always used.
 * EXE/BIN reads are ranged; extraction and ZIP packing are disk-backed.
 * RAR decoding still buffers one verified member/solid group (GOG limit: 1 GiB).
 */
import { readdirSync, statSync, readFileSync, existsSync, mkdirSync, rmSync, openSync, writeSync, closeSync } from "fs";
import { join, basename, extname, dirname, resolve } from "path";
import { randomBytes } from "crypto";
import { extractInno, parseInnoHeader, parseSliceSource, MultiSliceReader, detectInstallerLanguages, defaultLanguage,
    type SliceData, type SliceSource, type InnoParseResult } from "@bottleship/formats/inno";
import { UnpackDecoder } from "@bottleship/formats/unpack";
import { FileSource } from "./internal/file-source";
import { createInnoAssemblyStore } from "./internal/inno-assembly-store";
import { resolveArchiveExtractPath } from "./internal/archive-extract-path";
import { collectGamePaths, discoverGogRarParts, planGogRarLayout, installGogRar, synthesizeInstalledGog, packInstalledGog } from "./internal/gog-rar";
import { isGogJunk, detectExeFromPaths } from "@bottleship/repack/gog-filter";

const isTTY = process.stdout.isTTY;

function step(n: number, total: number, label: string) {
    process.stdout.write(`\n[${n}/${total}] ${label}\n`);
}

function progress(msg: string) {
    if (!isTTY) return;
    const cols = process.stdout.columns ?? 80;
    const line = msg.length > cols ? msg.slice(0, cols - 1) : msg.padEnd(cols - 1);
    process.stdout.write(`\r${line}`);
}

function progressDone(msg: string) {
    if (isTTY) process.stdout.write(`\r${msg}\n`);
    else process.stdout.write(`${msg}\n`);
}

function progressBar(done: number, total: number, width = 24): string {
    // doneBytes counts every byte streamed (incl. skipped/unwanted); total only the wanted payload,
    // so done can exceed total \u2014 clamp to keep the bar (and repeat counts) in range.
    const ratio = total > 0 && Number.isFinite(done / total) ? done / total : 0;
    const pct = Math.max(0, Math.min(1, ratio));
    const filled = Math.max(0, Math.min(width, Math.round(pct * width)));
    const bar = "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
    return `[${bar}] ${Math.round(pct * 100)}%`;
}

function parseArgs(argv: string[]) {
    const args = argv.slice(2);
    const has = (flag: string) => args.includes(flag);

    if (has("--help") || args.length === 0) {
        const src = readFileSync(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "utf8");
        const match = src.match(/\/\*\*([\s\S]*?)\*\//);
        if (match) console.log(match[1].replace(/^ \* ?/gm, ""));
        process.exit(0);
    }

    const flagsWithValue = new Set([
        "--name", "--exe", "--args", "--width", "--height", "--bpp", "--ram", "--os",
        "--reg-hive", "--reg-path", "--reg-install", "--extract-dir",
        "--language",
    ]);
    const positionals: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a.startsWith("--")) {
            if (flagsWithValue.has(a)) i++;
            continue;
        }
        positionals.push(a);
    }
    if (positionals.length < 2) {
        console.error("Usage: bun tools/gog-to-wgb.ts <gog-installer.exe> <output.wgb> [options]");
        process.exit(1);
    }

    const installer = positionals[0]!;
    const output = positionals[1]!;
    const get = (flag: string) => {
        const i = args.indexOf(flag);
        return i !== -1 ? args[i + 1] : undefined;
    };

    return { installer, output, get, has };
}

function readGogMetadataFromDir(appDir: string) {
    try {
        for (const entry of readdirSync(appDir)) {
            if (/^goggame-.*\.(info|script)$/i.test(entry)) {
                const metadataPath = join(appDir, entry);
                if (statSync(metadataPath).size > 1024 * 1024) throw new Error("Oversized GOG installer metadata");
                const raw = readFileSync(metadataPath, "utf8");
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object") {
                    return { name: parsed.name ?? parsed.gameTitle, gameId: parsed.gameId };
                }
            }
        }
    } catch { /* ignore */ }
    return {};
}

function gatherSlices(installerPath: string, parsed: InnoParseResult): SliceSource | undefined {
    if (parsed.offsets.dataOffset) return undefined;
    const dir = dirname(installerPath);
    const base = basename(installerPath, extname(installerPath));
    const slicesPerDisk = Math.max(1, parsed.header.slicesPerDisk || 1);
    const sliceName = (i: number): string => {
        if (slicesPerDisk <= 1) return `${base}-${i + 1}.bin`;
        const major = Math.floor(i / slicesPerDisk) + 1;
        const minor = i % slicesPerDisk;
        return `${base}-${major}${String.fromCharCode(97 + minor)}.bin`;
    };
    const slices: SliceData[] = [];
    for (let i = 0; ; i++) {
        const p = join(dir, sliceName(i));
        if (!existsSync(p)) break;
        slices.push(parseSliceSource(new FileSource(p)));
    }
    if (slices.length === 0) {
        throw new Error(`multi-part installer — no slices found next to ${basename(installerPath)} (expected ${sliceName(0)})`);
    }
    console.log(`  slices: ${slices.length}`);
    return new MultiSliceReader(slices);
}


async function extractNative(source: FileSource, parsed: InnoParseResult, codec: UnpackDecoder,
    sliceSource: SliceSource | undefined, outDir: string, keepGog: boolean, language?: string): Promise<string> {
    const appDir = join(outDir, "app");
    mkdirSync(appDir, { recursive: true });
    let count = 0;
    const open = new Set<number>();
    try {
        await extractInno(source, {
            // Keep only the tiny metadata needed for manifest/registry synthesis, even
            // when it is filtered from the final WGB. Never reload other payload files.
            wantFile: rel => /^goggame-.*\.(info|script)$/i.test(basename(rel)) || keepGog || !isGogJunk(rel),
            onProgress: (done, total) => progress(`  ${progressBar(done, total)} extracting`),
            language,
            createAssemblyStore: size => createInnoAssemblyStore(outDir, size),
        }, relPath => {
            const dest = resolveArchiveExtractPath(appDir, relPath);
            let fd: number | undefined; // Per sink: deduplicated files can be open together.
            return {
                begin() { mkdirSync(dirname(dest), { recursive: true }); fd = openSync(dest, "wx"); open.add(fd); },
                data(bytes) {
                    if (fd === undefined) throw new Error("Inno output sink is not open");
                    for (let at = 0; at < bytes.length;) {
                        const written = writeSync(fd, bytes, at, bytes.length - at);
                        if (written <= 0) throw new Error("Inno output write made no progress");
                        at += written;
                    }
                },
                end(ok) {
                    if (fd !== undefined) { closeSync(fd); open.delete(fd); fd = undefined; }
                    if (!ok) throw new Error("Inno output checksum mismatch");
                    count++;
                },
            };
        }, codec, parsed, sliceSource);
    } finally {
        for (const fd of open) { try { closeSync(fd); } catch { /* retain original error */ } }
    }
    progressDone(`  extracted ${count} files`);
    return appDir;
}

async function run() {
    const { installer, output, get, has } = parseArgs(process.argv);
    if (!existsSync(installer)) throw new Error("Installer not found");
    const extractOnly = has("--extract-only"), keepGog = has("--keep-gog");
    if (!extractOnly && existsSync(output)) throw new Error("Output already exists; choose a new path");
    const explicitDir = get("--extract-dir");
    const destination = explicitDir ?? join(dirname(resolve(output)), `.gog-stage-${randomBytes(6).toString("hex")}`);
    if (existsSync(destination)) throw new Error("Extraction destination already exists; inspect it before continuing");

    const wasm = readFileSync(join(import.meta.dir, "../public/unpack-streaming.wasm"));
    const codec = new UnpackDecoder();
    await codec.init(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
    const source = new FileSource(installer); // Never read a multi-GB EXE into one Buffer.
    const parsed = await parseInnoHeader(source, codec);
    const languages = detectInstallerLanguages(parsed.files);
    const language = get("--language") ?? defaultLanguage(languages);
    const rarParts = parsed.offsets.dataOffset ? discoverGogRarParts(installer) : null;
    let appDir: string;
    step(1, 2, `Extracting ${rarParts ? "GOG RAR payloads" : "Inno payload"} to ${destination}`);
    if (rarParts) {
        const layout = planGogRarLayout(rarParts); // Preflight every part before mkdir/write.
        appDir = await installGogRar(rarParts, layout, destination, codec);
    } else {
        appDir = await extractNative(source, parsed, codec, gatherSlices(installer, parsed), destination, keepGog, language);
    }
    const gogMeta = readGogMetadataFromDir(appDir);
    if (gogMeta.name) console.log(`  game name: ${gogMeta.name}`);
    if (extractOnly) {
        const paths: string[] = [];
        collectGamePaths(appDir, "", paths, !keepGog);
        const exe = get("--exe") ?? detectExeFromPaths(paths);
        if (exe) console.log(`  exe:       ${exe}`);
        console.log("\n--- Extracted files (after GOG filter) ---");
        for (const path of paths) console.log(`  ${path}`);
        console.log(`\nExtracted to: ${appDir}`);
        return;
    }
    const num = (flag: string) => { const value = get(flag); return value === undefined ? undefined : parseInt(value, 10); };
    const overridesPath = join(import.meta.dir, "../public/gog-overrides.json");
    const overrides = existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, "utf8")) : undefined;
    const synth = await synthesizeInstalledGog(appDir, parsed, {
        name: get("--name"), exe: get("--exe"), args: get("--args"),
        width: num("--width"), height: num("--height"), bpp: num("--bpp"), ramMB: num("--ram"),
        os: get("--os"), regPath: get("--reg-path"), regHive: get("--reg-hive"), regInstall: get("--reg-install"),
        skipVideo: has("--skip-video"),
    }, overrides);
    step(2, 2, "Packing disk-backed WGB");
    const packed = await packInstalledGog(appDir, output, synth, keepGog);
    console.log(`Created ${output} (${packed.entries} files, ${(packed.bytes / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`  name: ${String(synth.manifest.name)}\n  gameId: ${String(synth.manifest.gameId)}\n  entrypoint: ${String(synth.manifest.entrypoint)}`);
    if (languages.length) console.log(`  language: ${language ?? "(none)"} (available: ${languages.join(", ")})`);
    if (!explicitDir) rmSync(destination, { recursive: true }); // Only our random staging dir, after final publication.
}

run().catch(error => { console.error(`GOG import failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
