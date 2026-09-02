#!/usr/bin/env bun
/**
 * gog-to-wgb: Extract a GOG Inno Setup installer and pack it as a .wgb bundle.
 *
 * Usage:
 *   bun tools/gog-to-wgb.ts <gog-installer.exe> <output.wgb> [options]
 *
 * Options:
 *   --innoextract         Use the external innoextract tool (default: built-in WASM parser,
 *                         the same code path the browser UI uses)
 *   --native              Deprecated no-op alias (native WASM is now the default)
 *   --extract-only        Extract + filter only, don't pack
 *   ... see --help
 */

import {
    writeFileSync, readdirSync, statSync, readFileSync, existsSync,
    mkdirSync, rmSync, openSync, writeSync, closeSync,
} from "fs";
import { join, basename, extname, dirname } from "path";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import {
    BufferSource,
    extractInno,
    parseInnoHeader,
    parseSliceSource,
    MultiSliceReader,
    type SliceData,
    type SliceSource,
    type InnoParseResult,
} from "@bottleship/formats/inno";
import { UnpackDecoder } from "@bottleship/formats/unpack";
import { FileSource } from "./internal/file-source";
import { resolveArchiveExtractPath } from "./internal/archive-extract-path";
import { isGogJunk, SKIP_DIRS, detectExeFromPaths } from "@bottleship/repack/gog-filter";
import { buildZip } from "@bottleship/formats/wgb/zip-build";
import { OS_PRESETS } from "@bottleship/repack/manifest-synth";
import { installerBytesToWgb } from "@bottleship/repack/installer-to-wgb";
import { isValidGameId, deriveGameId, KNOWN_GAME_ID_SCHEMES } from "@bottleship/formats/wgb/container-id";

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
        "--reg-hive", "--reg-path", "--reg-install", "--extract-dir", "--extract-tool",
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
                const raw = readFileSync(join(appDir, entry), "utf8");
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object") {
                    return { name: parsed.name ?? parsed.gameTitle, gameId: parsed.gameId };
                }
            }
        }
    } catch { /* ignore */ }
    return {};
}

function collectGameFiles(
    dir: string,
    prefix: string,
    out: Map<string, Buffer>,
    filterGog: boolean,
    onFile?: (count: number, bytes: number, name: string) => void,
) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const relName = prefix + entry;
        if (statSync(full).isDirectory()) {
            if (filterGog && SKIP_DIRS.has(entry.toLowerCase())) continue;
            collectGameFiles(full, relName + "/", out, filterGog, onFile);
        } else {
            if (filterGog && isGogJunk(relName)) continue;
            const data = readFileSync(full);
            out.set(relName, data);
            let totalBytes = 0;
            for (const b of out.values()) totalBytes += b.length;
            onFile?.(out.size, totalBytes, relName);
        }
    }
}

function findInnoextract(explicitPath?: string): string | null {
    if (explicitPath) return existsSync(explicitPath) ? explicitPath : null;
    // innoextract is an optional external fallback (GPL); the default path is our
    // built-in WASM Inno parser. Resolve it from PATH — install it yourself to use.
    const cmd = process.platform === "win32" ? "innoextract.exe" : "innoextract";
    const where = spawnSync(process.platform === "win32" ? "where" : "which", [cmd],
        { encoding: "utf8", shell: true });
    if (where.status === 0 && where.stdout.trim()) {
        return where.stdout.trim().split("\n")[0]!.trim();
    }
    return null;
}

function extractWithInnoextract(installerPath: string, outDir: string, innoPath: string): string {
    console.log(`  tool:   ${innoPath}`);
    const result = spawnSync(innoPath, ["--output-dir", outDir, "--extract", installerPath], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`innoextract failed with exit code ${result.status}`);
    const appDir = join(outDir, "app");
    return existsSync(appDir) ? appDir : outDir;
}

/**
 * A multi-part installer keeps its payload in sibling `setup-*.bin` slices (header dataOffset === 0).
 * Both extraction paths need the same ordering, so gather them once.
 */
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

async function extractNative(
    installerPath: string, outDir: string, keepGog: boolean, language?: string,
): Promise<string> {
    const data = new Uint8Array(readFileSync(installerPath));
    const wasmPath = join(import.meta.dir, "../public/unpack-streaming.wasm");
    const wasmBytes = readFileSync(wasmPath);
    const lzma = new UnpackDecoder();
    await lzma.init(wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength));

    const source = new BufferSource(data);
    const parsed = await parseInnoHeader(source, lzma);
    const sliceSource = gatherSlices(installerPath, parsed);

    const appDir = join(outDir, "app");
    mkdirSync(appDir, { recursive: true });

    // Stream each file straight to disk — a modern GOG payload is several GB, far past what a
    // Map of Uint8Arrays can hold.
    const filterGog = !keepGog;
    let count = 0;
    // The descriptor lives in the per-file sink, not in a shared variable: an exception mid
    // file would otherwise leave it open and a truncated file on disk that packs looking whole.
    let open: { fd: number; dest: string } | null = null;
    try {
        await extractInno(source, {
            wantFile: (rel) => !filterGog || !isGogJunk(rel),
            onProgress: (done, total) => { progress(`  ${progressBar(done, total)} extracting`); },
            language,
        }, (relPath) => {
            const dest = resolveArchiveExtractPath(appDir, relPath);
            return {
                begin() {
                    mkdirSync(dirname(dest), { recursive: true });
                    open = { fd: openSync(dest, "w"), dest };
                },
                data(bytes) { if (open) writeSync(open.fd, bytes); },
                end() {
                    if (open) { closeSync(open.fd); open = null; }
                    count++;
                },
            };
        }, lzma, parsed, sliceSource);
    } finally {
        if (open) {
            const stray = open as { fd: number; dest: string };
            try { closeSync(stray.fd); } catch { /* already gone */ }
            console.error(`  extraction stopped inside ${stray.dest} — that file is TRUNCATED`);
        }
    }
    progressDone(`  extracted ${count} files`);

    return appDir;
}

const { installer, output, get, has } = parseArgs(process.argv);

if (!existsSync(installer)) {
    console.error(`Error: installer not found: ${installer}`);
    process.exit(1);
}

const extractOnly = has("--extract-only");
const keepGog = has("--keep-gog");
// Native WASM extraction is the default; `--innoextract` opts into the external tool. This keeps the
// CLI and the browser UI on the ONE Inno code path (packages/formats/src/inno) so behavior can't drift.
const useNative = !has("--innoextract");

// Default path: run the exact shared pipeline the browser UI uses (installerBytesToWgb) with no
// 1.5 GB on-disk roundtrip. `--innoextract` and `--extract-only` fall through to the legacy flow.
if (useNative && !extractOnly) {
    step(1, 1, `Extract + pack (native WASM) → ${output}`);
    const data = new Uint8Array(readFileSync(installer));
    const wasmPath = join(import.meta.dir, "../public/unpack-streaming.wasm");
    const wasmBytes = readFileSync(wasmPath);
    const wasmArrayBuf = wasmBytes.buffer.slice(
        wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength,
    );

    // Multi-part installers keep their payload in sibling setup-*.bin slices (header dataOffset === 0).
    // Gather + order them exactly like the browser worker so headless builds match the UI.
    const lzma = new UnpackDecoder();
    await lzma.init(wasmArrayBuf);
    const parsed = await parseInnoHeader(new BufferSource(data), lzma);
    let sliceSource: SliceSource | undefined;
    try {
        sliceSource = gatherSlices(installer, parsed);
    } catch (err: unknown) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
    }

    const num = (flag: string) => { const v = get(flag); return v !== undefined ? parseInt(v, 10) : undefined; };
    const result = await installerBytesToWgb(data, wasmArrayBuf, {
        parsed,
        sliceSource,
        keepGog,
        language: get("--language"),
        onProgress: (p) => progress(`  ${progressBar(p.doneBytes, p.totalBytes)} ${p.phase}`),
        synth: {
            name: get("--name"),
            exe: get("--exe"),
            args: get("--args"),
            width: num("--width"),
            height: num("--height"),
            bpp: num("--bpp"),
            ramMB: num("--ram"),
            os: get("--os"),
            regPath: get("--reg-path"),
            regHive: get("--reg-hive"),
            regInstall: get("--reg-install"),
            skipVideo: has("--skip-video"),
        },
    });
    const outDirPath = dirname(output);
    if (outDirPath && outDirPath !== ".") mkdirSync(outDirPath, { recursive: true });
    writeFileSync(output, result.wgb);
    progressDone(`\nCreated ${output}`);
    console.log(`  name:   ${result.name}`);
    console.log(`  gameId: ${result.gameId ? `gog:${result.gameId}` : "(derived)"}`);
    if (result.availableLanguages.length) {
        const others = result.availableLanguages.filter((l) => l !== result.language);
        console.log(`  language: ${result.language ?? "(none)"}${others.length ? `  (installer also offers: ${others.join(", ")} — pass --language to pick)` : ""}`);
    }
    process.exit(0);
}

let extractDir = get("--extract-dir");
let createdTmpDir = false;
if (!extractDir) {
    extractDir = join(tmpdir(), `gog-to-wgb-${randomBytes(6).toString("hex")}`);
    mkdirSync(extractDir, { recursive: true });
    createdTmpDir = true;
}

const TOTAL_STEPS = extractOnly ? 2 : 4;

step(1, TOTAL_STEPS, useNative ? "Extracting installer (native)..." : "Extracting installer...");

let appDir: string;

try {
    if (useNative) {
        appDir = await extractNative(installer, extractDir, keepGog, get("--language"));
    } else {
        const innoPath = findInnoextract(get("--extract-tool") ?? undefined);
        if (!innoPath) {
            console.error("Error: innoextract not found. Use --native or install innoextract.");
            process.exit(1);
        }
        appDir = extractWithInnoextract(installer, extractDir, innoPath);
    }
} catch (err: unknown) {
    console.error(`\nExtraction failed: ${err instanceof Error ? err.message : err}`);
    if (createdTmpDir) rmSync(extractDir, { recursive: true, force: true });
    process.exit(1);
}

step(2, TOTAL_STEPS, "Reading metadata...");

const gogMeta = readGogMetadataFromDir(appDir);
if (gogMeta.name) console.log(`  game name: ${gogMeta.name}`);

const paths = new Map<string, Buffer>();
collectGameFiles(appDir, "", paths, !keepGog);
const exeName = get("--exe") ?? detectExeFromPaths(paths.keys());
if (!exeName && !extractOnly) {
    console.error("Error: no .exe found; use --exe <name>");
    if (createdTmpDir) rmSync(extractDir, { recursive: true, force: true });
    process.exit(1);
}
if (exeName) console.log(`  exe:       ${exeName}`);

if (extractOnly) {
    console.log("\n--- Extracted files (after GOG filter) ---");
    for (const name of paths.keys()) console.log(`  ${name}`);
    console.log(`\nExtracted to: ${appDir}`);
    process.exit(0);
}

// innoextract path — pack from extracted dir
const name = get("--name") ?? gogMeta.name ?? basename(installer, extname(installer));
const osKey = get("--os") ?? "win98";
const osVer = OS_PRESETS[osKey];
if (!osVer) {
    console.error(`Error: unknown --os "${osKey}"`);
    process.exit(1);
}

// Container key (WGB v2): explicit --game-id wins; else GOG product id → gog:<id>; else derive.
const entrypoint = `rom/${exeName}`;
let gameId = get("--game-id");
if (gameId && !isValidGameId(gameId)) {
    console.error(`Error: invalid --game-id "${gameId}". Use "<scheme>:<id>" with scheme in {${KNOWN_GAME_ID_SCHEMES.join(", ")}}.`);
    process.exit(1);
}
if (!gameId) gameId = gogMeta.gameId ? `gog:${gogMeta.gameId}` : deriveGameId({ name, entrypoint });

const manifest: Record<string, unknown> = {
    formatVersion: 2,
    gameId,
    name,
    entrypoint,
    rom: "rom",
    registry: "registry.json",
    emulator: {
        osVersion: osVer,
        screenResolution: {
            width: parseInt(get("--width") ?? "640", 10),
            height: parseInt(get("--height") ?? "480", 10),
            bpp: parseInt(get("--bpp") ?? "16", 10),
        },
        memory: { ram: parseInt(get("--ram") ?? "64", 10) * 1024 * 1024 },
        ...(has("--skip-video") ? { skipVideo: true } : {}),
    },
};
const gameArgs = get("--args");
if (gameArgs) manifest.args = gameArgs;

const regPath = get("--reg-path");
const registry = regPath
    ? {
        root: get("--reg-hive") ?? "HKLM",
        path: regPath,
        values: [{ name: "InstallPath", type: "REG_SZ", data: get("--reg-install") ?? "C:\\" }],
    }
    : { root: "HKLM", path: "Software", values: [] };

step(3, TOTAL_STEPS, "Collecting game files...");
const files = new Map<string, Buffer>();
files.set("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
files.set("registry.json", Buffer.from(JSON.stringify(registry, null, 2), "utf8"));
collectGameFiles(appDir, "rom/", files, !keepGog, (count, bytes, lastName) => {
    progress(`  ${count} files  ${(bytes / 1024 / 1024).toFixed(1)} MB  ${basename(lastName)}`);
});
progressDone(`  ${files.size} files collected`);

step(4, TOTAL_STEPS, `Packing → ${output}`);
const zipEntries = new Map<string, Uint8Array>();
for (const [k, v] of files) zipEntries.set(k, new Uint8Array(v));
const zip = buildZip(zipEntries);
writeFileSync(output, zip);
console.log(`\nCreated ${output}`);
if (createdTmpDir) rmSync(extractDir, { recursive: true, force: true });
