/** Classify, stage, inspect and finalize bundles without booting the guest. */

import {
    BufferSource,
    type InnoParseResult,
} from "@bottleship/formats/inno";
import { detectFormat, detectSourceFormat, sniffBlobHead, type DetectedFormat } from "@bottleship/repack/detect";
import { buildInstallerOnDisk, blobRandomAccess } from "./installer-opfs";
import { writeZipStream, type ZipStreamEntry } from "@bottleship/formats/wgb/zip-stream";
import { buildZip } from "@bottleship/formats/wgb/zip-build";
import {
    guessCacheKey,
    parseGogGameInfo,
    synthesizeManifest,
    type SynthOptions,
} from "@bottleship/repack/manifest-synth";
import { loadOverrides, getOverride, type GogOverridesDb } from "@bottleship/repack/overrides";
import { isGogJunk, detectExeFromPaths } from "@bottleship/repack/gog-filter";
import { detectInstallShield, extractInstallerFromFiles } from "@bottleship/repack/container-extract";
import { IsoImage, detectSectorLayout, extractIsoToMap } from "@bottleship/formats/iso";
import { extract7z } from "../archive/unpack-buffered";
import { ZipArchive, BlobSource, BufferSource as ZipBufferSource, unzipToMap, type ZipEntry } from "@bottleship/formats/zip";
import { resolveGameId, gameIdToContainerDir, manifestToWgbFilename } from "@bottleship/formats/wgb/container-id";
import { getBottleshipRoot } from "./container-store";
import { WgbCache } from "./wgb-cache";
import { Logger, LogCategory } from "../../core/logger";
import { asWriteChunk } from "../../../dom-buffer";

// --- public types ----------------------------------------------------------------

export type SourceKind =
    | "wgb"
    | "gog-installer"
    | "installshield"
    | "archive-7z"
    | "iso9660"
    | "installer-zip"
    | "installer-sfx"
    | "game-folder"
    | "unknown";

/** Normalized build input. The worker maps the postMessage payload into one of these shapes. */
export interface BuildSource {
    /** Single dropped file (a `.wgb`, a GOG `setup.exe`, or a plain `.zip`). */
    blob?: Blob;
    /** Multi-part GOG installer: `setup.exe` + every `setup-*.bin` slice. */
    blobs?: File[];
    /** A folder of already-extracted game files (host-enumerated → rel-path → bytes). */
    files?: Map<string, Uint8Array>;
    /** Read-only directory access; payloads are read by range in the worker. */
    directory?: FileSystemDirectoryHandle;
    directoryMode?: "installed" | "gog-installer";
    /** Cached bundle URL (existing `.wgb` served from /apps/...). */
    url?: string;
    /** Manifest-synthesis overrides forwarded from the wizard form (name/exe/os/...). */
    cli?: SynthOptions["cli"];
}

export interface SourceDetection {
    kind: SourceKind;
    /** All `.exe` candidates discovered (so the wizard can disambiguate the entrypoint). */
    exeCandidates: string[];
    /** Best-guess entrypoint relative path (forward slashes), if one stands out. */
    suggestedEntrypoint?: string;
    /** GOG product id, when the payload carries a goggame-*.info. */
    gogGameId?: string;
    /** Human-readable note (e.g. multiple exes found, unsupported Inno version). */
    note?: string;
    /** Raw format the byte sniffer reported (debugging aid). */
    detectedFormat?: DetectedFormat;
}

export interface StagedEntry {
    name: string;
    size: number;
    isDirectory: boolean;
}

export interface BuildResult {
    /** OPFS path of the staged bundle, `bottleship/_wizard/<id>.wgb`. */
    stagedPath: string;
    manifest: Record<string, unknown>;
    entries: StagedEntry[];
    gameId: string;
    detections: SourceDetection;
}

export interface InspectResult {
    manifest: Record<string, unknown>;
    entries: StagedEntry[];
}

export type FinalizeDestination = "play" | "library" | "download";

export type FinalizeProgressFn = (percent: number, label: string) => void;

export interface FinalizeArgs {
    stagedPath: string;
    manifest: Record<string, unknown>;
    /** Optional edited registry (RegistrySeed | RegistrySeed[]); when omitted the staged one is kept. */
    registry?: unknown;
    /**
     * Inline-edited text files keyed by bundle entry path (e.g. `rom/Game/foo.ini`).
     * Their UTF-8 text overwrites the corresponding staged entry bytes before re-pack.
     */
    editedFiles?: Record<string, string>;
    destination: FinalizeDestination;
    onProgress?: FinalizeProgressFn;
}

export interface FinalizeResult {
    destination: FinalizeDestination;
    gameId: string;
    /** Legacy buffered output; current browser finalization returns file. */
    bytes?: Uint8Array;
    /** Disk-backed output; structured cloning a File does not copy its payload into RAM. */
    file?: File;
    /** OPFS cache key the library copy was persisted under (`library`). */
    cacheKey?: string;
    suggestedFilename: string;
}

export interface BuildProgress {
    phase: "reading" | "detecting" | "installing" | "unzipping" | "packing" | "staging" | "done";
    percent: number;
    label: string;
}

export type ProgressFn = (phase: BuildProgress["phase"], percent: number, label: string) => void;

const WIZARD_DIR = "_wizard";

/** Enumerate snapshots and relative names; never read payloads while walking a folder. */
export async function readDirectoryFiles(directory: FileSystemDirectoryHandle): Promise<Map<string, File>> {
    const files = new Map<string, File>();
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
        const iterable = dir as FileSystemDirectoryHandle & {
            entries(): AsyncIterable<[string, FileSystemHandle]>;
        };
        for await (const [name, handle] of iterable.entries()) {
            const path = prefix + name;
            if (handle.kind === "directory") await walk(handle as FileSystemDirectoryHandle, path + "/");
            else files.set(path, await (handle as FileSystemFileHandle).getFile());
        }
    };
    await walk(directory, "");
    if (!files.size) throw new Error("That folder is empty");
    return files;
}

async function installerDirectorySource(source: BuildSource): Promise<BuildSource> {
    const dir = source.directory! as FileSystemDirectoryHandle & {
        entries(): AsyncIterable<[string, FileSystemHandle]>;
    };
    const files: File[] = [];
    for await (const [name, handle] of dir.entries()) {
        if (handle.kind === "file" && /\.(exe|bin)$/i.test(name)) files.push(await (handle as FileSystemFileHandle).getFile());
    }
    const setups = files.filter(f => /\.exe$/i.test(f.name));
    if (setups.length !== 1) throw new Error("Choose the folder for one GOG offline installer, containing one setup.exe and its .bin parts. Use Choose files to select a specific installer from a larger folder.");
    const base = setups[0]!.name.replace(/\.exe$/i, "").toLowerCase() + "-";
    return { blobs: [setups[0]!, ...files.filter(f => /\.bin$/i.test(f.name) && f.name.toLowerCase().startsWith(base))], cli: source.cli };
}

async function buildDirectoryBundle(source: BuildSource, onProgress?: ProgressFn): Promise<BuildResult> {
    const files = await readDirectoryFiles(source.directory!);
    if (detectInstallShield(files.keys()).stem) throw new Error("This folder contains an InstallShield installer. Choose its archive, or select the already installed game folder.");
    const metadata = new Map<string, Uint8Array>();
    for (const [name, file] of files) {
        const meta = /(^|\/)goggame-.*\.(info|script)$/i.test(name) || /(^|\/)setup\.ini$/i.test(name);
        if (meta && file.size > 16 * 1024 * 1024) throw new Error("Game metadata exceeds 16 MB");
        metadata.set(name, meta ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array(0));
    }
    const db = await loadOverrides();
    const synth = synthFromFiles(metadata, withSynthName(source.cli, source, metadata), db);
    const manifest = synth.manifest;
    const gameId = resolveGameId(manifest);
    const bs = await getBottleshipRoot(true);
    if (!bs) throw new Error("Browser storage unavailable");
    const dir = await bs.getDirectoryHandle(WIZARD_DIR, { create: true });
    const key = crypto.randomUUID() + ".wgb";
    const handle = await dir.getFileHandle(key, { create: true });
    const writable = await handle.createWritable();
    const enc = new TextEncoder();
    const entries: ZipStreamEntry[] = [
        { name: "manifest.json", source: new ZipBufferSource(enc.encode(JSON.stringify(manifest, null, 2))) },
        { name: "registry.json", source: new ZipBufferSource(enc.encode(JSON.stringify(synth.registry, null, 2))) },
        ...[...files].filter(([name]) => !isGogJunk(name)).map(([name, file]) => ({
            name: "rom/" + name, source: { size: file.size, readRange: async (a: number, b: number) => new Uint8Array(await file.slice(a, b).arrayBuffer()) },
        })),
    ];
    const total = entries.reduce((n, e) => n + e.source.size, 0);
    try {
        await writeZipStream(entries, { write: async (bytes, at) => { await writable.seek(at); await writable.write(asWriteChunk(bytes)); } },
            done => onProgress?.("packing", Math.min(99, total ? Math.round(done / total * 100) : 0), "Packaging game folder to browser storage"));
        await writable.close();
    } catch (error) {
        try { await writable.abort(); } catch { /* Preserve the write error. */ }
        try { await dir.removeEntry(key); } catch { /* Storage can clean abandoned files. */ }
        if ((error as DOMException).name === "QuotaExceededError") throw new Error("Browser storage is full. Free cached files in Settings → Storage and try again.");
        throw error;
    }
    const detections = { kind: "game-folder" as const, ...collectExeDetections(files.keys()),
        gogGameId: parseGogGameInfo(metadata).gameId, note: `${files.size} files in ${source.directory!.name}` };
    const stagedPath = `${WIZARD_DIR}/${key}`;
    const result = await inspectStaged(stagedPath);
    onProgress?.("done", 100, "Ready");
    return { stagedPath, manifest, gameId, entries: result.entries, detections };
}

// --- pure helpers (unit-tested) ---------------------------------------------------

/** Classify a single payload's leading bytes. Mirrors detect.ts but folds head + full sniff. */
export function detectFromBytes(data: Uint8Array): DetectedFormat {
    // A `.wgb` and a plain `.zip` both lead with PK\x03\x04 — detectFormat reports both as "wgb".
    return detectFormat(data);
}

/** True when a ZIP central directory holds a manifest.json (→ it's a finished `.wgb`, not a raw zip). */
export function looksLikeWgb(entryNames: Iterable<string>): boolean {
    for (const n of entryNames) {
        if (n === "manifest.json") return true;
    }
    return false;
}

/**
 * Collect `.exe` candidates + a suggested entrypoint from a set of relative paths
 * (forward slashes). Pure — drives the wizard's entrypoint disambiguation.
 */
export function collectExeDetections(paths: Iterable<string>): {
    exeCandidates: string[];
    suggestedEntrypoint?: string;
} {
    const list = [...paths].map((p) => p.replace(/\\/g, "/"));
    const exeCandidates = list.filter((p) => /\.exe$/i.test(p) && !isGogJunk(p));
    const suggestedEntrypoint = detectExeFromPaths(list) ?? exeCandidates[0];
    return { exeCandidates, suggestedEntrypoint };
}

/** Deep-merge `patch` onto `base` (plain objects merged, everything else replaced). Pure, immutable. */
export function mergeManifest(
    base: Record<string, unknown>,
    patch: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(patch)) {
        const cur = out[k];
        if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
            out[k] = mergeManifest(cur as Record<string, unknown>, v as Record<string, unknown>);
        } else if (v !== undefined) {
            out[k] = v;
        }
    }
    return out;
}

// `detectInstallShield` + the installer extraction recursion now live in
// `@bottleship/repack/container-extract` (shared with the headless `iso-to-wgb` CLI).
// Re-exported here for callers/tests that import it from the build service.
export { detectInstallShield };

/** 7z archive signature: `37 7A BC AF 27 1C`. */
function is7zHead(head: Uint8Array): boolean {
    return (
        head.length >= 6 &&
        head[0] === 0x37 &&
        head[1] === 0x7a &&
        head[2] === 0xbc &&
        head[3] === 0xaf &&
        head[4] === 0x27 &&
        head[5] === 0x1c
    );
}

/** Read every STORED (or DEFLATE) entry of a ZIP buffer into a rel-path → bytes Map. */
export const unzipStored = unzipToMap;

/**
 * Probe a PE executable for an appended/embedded ZIP archive — i.e. a self-extractor
 * (WinZip SFX, 7z-SFX-as-zip, …). Returns the inner entry names when present, else null.
 * `ZipArchive` locates the EOCD by scanning from the file end and recovers the stub prefix,
 * so this works regardless of how large the PE stub is. Never throws.
 */
export async function sfxZipEntries(data: Uint8Array): Promise<string[] | null> {
    try {
        const archive = new ZipArchive(new ZipBufferSource(data));
        await archive.init();
        const names = archive.listEntries().map((e) => e.name);
        return names.length ? names : null;
    } catch {
        return null;
    }
}

function entriesFromZip(zipEntries: ZipEntry[]): StagedEntry[] {
    return zipEntries.map((e) => ({
        name: e.name,
        size: e.uncompressedSize,
        isDirectory: e.isDirectory,
    }));
}

// --- WASM loader (Inno LZMA) ------------------------------------------------------

let _lzmaWasm: ArrayBuffer | null = null;
async function getLzmaWasm(): Promise<ArrayBuffer> {
    if (_lzmaWasm) return _lzmaWasm;
    const resp = await fetch("/unpack-streaming.wasm");
    _lzmaWasm = await resp.arrayBuffer();
    return _lzmaWasm;
}

// --- detection --------------------------------------------------------------------

/**
 * Classify a dropped payload. Reads only the bytes it needs (a 64-B head for blobs; the
 * full buffer when it must walk an Inno offsets table or a ZIP central directory).
 */
export async function detectSource(source: BuildSource): Promise<SourceDetection> {
    if (source.directory) {
        if (source.directoryMode === "gog-installer") {
            return detectSource(await installerDirectorySource(source));
        }
        const files = await readDirectoryFiles(source.directory);
        const { exeCandidates, suggestedEntrypoint } = collectExeDetections(files.keys());
        return { kind: "game-folder", exeCandidates, suggestedEntrypoint,
            note: `${files.size} files in ${source.directory.name}` };
    }
    // Folder of already-extracted files.
    if (source.files) {
        const is = detectInstallShield(source.files.keys());
        if (is.stem) {
            return {
                kind: "installshield",
                exeCandidates: [],
                note: "InstallShield cabinet — extracting game files",
            };
        }
        const { exeCandidates, suggestedEntrypoint } = collectExeDetections(source.files.keys());
        const gog = parseGogGameInfo(source.files);
        return {
            kind: "game-folder",
            exeCandidates,
            suggestedEntrypoint,
            gogGameId: gog.gameId,
            note: exeCandidates.length > 1 ? `${exeCandidates.length} executables found` : undefined,
        };
    }

    // Multi-part GOG installer.
    if (source.blobs && source.blobs.length) {
        const exe = source.blobs.find((f) => !f.name.toLowerCase().endsWith(".bin"));
        if (!exe) return { kind: "unknown", exeCandidates: [], note: "no setup.exe among dropped files" };
        const fmt = await detectBlobFormat(exe);
        if (fmt === "inno") return { kind: "gog-installer", exeCandidates: [], detectedFormat: fmt };
        return {
            kind: "unknown",
            exeCandidates: [],
            detectedFormat: fmt,
            note: fmt === "inno-unsupported" ? "unsupported Inno Setup version" : "not a supported GOG installer",
        };
    }

    // Cached bundle URL — always a finished `.wgb`.
    if (source.url) {
        return { kind: "wgb", exeCandidates: [], detectedFormat: "wgb" };
    }

    // Single blob: head-sniff, then full classify.
    if (source.blob) {
        const head = new Uint8Array(await source.blob.slice(0, 64).arrayBuffer());
        // 7z archive (magic "7z\xBC\xAF\x27\x1C") — unwrap it, then re-detect the contents.
        if (is7zHead(head)) {
            return { kind: "archive-7z", exeCandidates: [], note: "7z archive — extracting" };
        }
        const headKind = sniffBlobHead(head);
        if (headKind === "wgb") {
            // PK — either a finished `.wgb` (has manifest.json) or a plain installer `.zip`.
            const archive = new ZipArchive(new BlobSource(source.blob));
            await archive.init();
            const names = archive.listEntries().map((e) => e.name);
            if (looksLikeWgb(names)) {
                return { kind: "wgb", exeCandidates: [], detectedFormat: "wgb" };
            }
            const is = detectInstallShield(names);
            if (is.stem) {
                return {
                    kind: "installshield",
                    exeCandidates: [],
                    note: "InstallShield cabinet — extracting game files",
                };
            }
            const { exeCandidates, suggestedEntrypoint } = collectExeDetections(names);
            const gog = parseGogGameInfo(await zipToMap(archive));
            return {
                kind: "installer-zip",
                exeCandidates,
                suggestedEntrypoint,
                gogGameId: gog.gameId,
                note: exeCandidates.length > 1 ? `${exeCandidates.length} executables found` : undefined,
            };
        }
        if (headKind === "mz") {
            const fmt = await detectBlobFormat(source.blob);
            if (fmt === "inno") return { kind: "gog-installer", exeCandidates: [], detectedFormat: fmt };
            // Not Inno — maybe a self-extractor (WinZip SFX etc.): a PE stub with a ZIP
            // appended. Unwrap it like any other container and recurse into the payload.
            const sfxArchive = new ZipArchive(new BlobSource(source.blob));
            const sfxNames = await sfxArchive.init().then(() => sfxArchive.listEntries().map(e => e.name)).catch(() => null);
            if (sfxNames) {
                if (looksLikeWgb(sfxNames)) return { kind: "wgb", exeCandidates: [], detectedFormat: "wgb" };
                const { exeCandidates, suggestedEntrypoint } = collectExeDetections(sfxNames);
                return {
                    kind: "installer-sfx",
                    exeCandidates,
                    suggestedEntrypoint,
                    detectedFormat: fmt,
                    note: "self-extracting archive — extracting",
                };
            }
            return {
                kind: "unknown",
                exeCandidates: [],
                detectedFormat: fmt,
                note: fmt === "inno-unsupported" ? "unsupported Inno Setup version" : "executable is not an Inno installer",
            };
        }
        // No PK/MZ head magic — a disc image hides its filesystem at sector 16. Probe the
        // volume-descriptor region (covers every CD framing) without reading the whole disc.
        const isoProbe = new Uint8Array(await source.blob.slice(0, ISO_PROBE_BYTES).arrayBuffer());
        if (detectSectorLayout(new BufferSource(isoProbe))) {
            return { kind: "iso9660", exeCandidates: [], note: "disc image — mounting filesystem" };
        }
        return { kind: "unknown", exeCandidates: [], detectedFormat: "unknown" };
    }

    return { kind: "unknown", exeCandidates: [], note: "empty source" };
}

/**
 * Bytes to slice off a disc image for sector-layout detection. The first volume
 * descriptor sits at logical sector 16; the largest candidate framing (MODE2/2352)
 * puts its user-data window near byte 37 656, so 64 KiB safely covers all of them.
 */
const ISO_PROBE_BYTES = 64 * 1024;

async function zipToMap(archive: ZipArchive): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    for (const entry of archive.listEntries()) {
        if (entry.isDirectory) continue;
        // Only the small metadata files matter for detection; skip multi-MB payloads.
        const base = entry.name.split("/").pop() ?? "";
        if (/^goggame-.*\.(info|script)$/i.test(base)) out.set(entry.name, await archive.readEntry(entry));
    }
    return out;
}

// --- build ------------------------------------------------------------------------

/** Pack a rel-path → bytes Map of game files into a `.wgb` Map (manifest + registry + rom/*). */
function packGameFiles(
    gameFiles: Map<string, Uint8Array>,
    manifest: Record<string, unknown>,
    registry: unknown,
): Map<string, Uint8Array> {
    const files = new Map<string, Uint8Array>();
    files.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
    files.set("registry.json", new TextEncoder().encode(JSON.stringify(registry, null, 2)));
    for (const [rel, data] of gameFiles) {
        if (isGogJunk(rel)) continue;
        files.set(`rom/${rel.replace(/\\/g, "/")}`, data);
    }
    return files;
}

/**
 * Build a bundle from a "container" file map (an InstallShield/Inno installer's loose
 * files, a 7z payload, or a mounted disc tree). Recurse into any embedded installer via
 * the shared `extractInstallerFromFiles` seam, then synth + pack the resulting game tree.
 *
 * `containerFiles` are the pre-extraction files (used for SETUP.INI name detection); the
 * returned bundle is built from whatever the installer recursion yielded (or the same
 * files when no installer was present).
 */
async function buildFromContainer(
    containerFiles: Map<string, Uint8Array>,
    source: BuildSource,
    db: GogOverridesDb,
    detections: SourceDetection,
    onProgress: ProgressFn | undefined,
    installBasePct: number,
): Promise<{ wgbBytes: Uint8Array; manifest: Record<string, unknown>; gameId: string }> {
    const extracted = await extractInstallerFromFiles(containerFiles, {
        innoWasm: await getLzmaWasm(),
        onProgress: (pct, label) =>
            onProgress?.("installing", installBasePct + Math.round((pct / 100) * (78 - installBasePct)), label),
    });
    const gameFiles = extracted.gameFiles;

    onProgress?.("packing", 80, "Building bundle");
    const synth = synthFromFiles(gameFiles, withSynthName(source.cli, source, containerFiles), db);
    const manifest = synth.manifest;
    const gameId = resolveGameId(manifest as { gameId?: string; name?: string; entrypoint?: string });
    const wgbBytes = buildZip(packGameFiles(gameFiles, synth.manifest, synth.registry));

    detections.gogGameId = detections.gogGameId ?? synth.gameId;
    const ep = (manifest as { entrypoint?: string }).entrypoint;
    if (ep) detections.suggestedEntrypoint = ep;
    detections.exeCandidates = collectExeDetections(gameFiles.keys()).exeCandidates;
    if (extracted.via !== "none") detections.note = `extracted via ${extracted.note}`;
    return { wgbBytes, manifest, gameId };
}

/** Read `[Startup] AppName=` from a SETUP.INI among installer/extracted files, if present. */
function parseSetupIniAppName(files: Map<string, Uint8Array>): string | undefined {
    for (const [rel, data] of files) {
        const base = (rel.split(/[\\/]/).pop() ?? rel).toLowerCase();
        if (base === "setup.ini") {
            const text = new TextDecoder("latin1").decode(data.subarray(0, 4096));
            const m = text.match(/^\s*AppName\s*=\s*(.+?)\s*$/im);
            if (m && m[1]?.trim()) return m[1].trim();
        }
    }
    return undefined;
}

/** Worst-case display name: the source file's basename (sans extension). */
function sourceBaseName(source: BuildSource): string | undefined {
    if (source.directory) return source.directory.name;
    let n: string | undefined;
    const named = source.blob as File | undefined;
    if (named && typeof named.name === "string") n = named.name;
    else if (source.blobs && source.blobs[0]) n = source.blobs[0].name;
    else if (source.url) n = source.url.split(/[?#]/)[0]!.split("/").pop();
    if (!n) return undefined;
    const stem = n.replace(/\.[^.]+$/, "").trim();
    return stem || undefined;
}

/**
 * Resolve the manifest display name with sensible fallbacks so we never emit the generic
 * "GOG Game" for a real drop: explicit cli.name → installer SETUP.INI AppName → source filename.
 */
function withSynthName(
    cli: SynthOptions["cli"] | undefined,
    source: BuildSource,
    iniFiles?: Map<string, Uint8Array>,
): SynthOptions["cli"] | undefined {
    if (cli?.name) return cli;
    if (iniFiles && parseGogGameInfo(iniFiles).name) return cli;
    const name = (iniFiles ? parseSetupIniAppName(iniFiles) : undefined) ?? sourceBaseName(source);
    return name ? { ...(cli ?? {}), name } : cli;
}

/** Synthesize a manifest+registry for a folder/zip of extracted game files (no Inno header). */
function synthFromFiles(
    gameFiles: Map<string, Uint8Array>,
    cli: SynthOptions["cli"] | undefined,
    db: GogOverridesDb,
): { manifest: Record<string, unknown>; registry: unknown; gameId?: string } {
    // synthesizeManifest needs a parsed Inno result; for raw files there isn't one. Build a
    // minimal stand-in (no Inno registry/icons) so the same synth path applies the same
    // entrypoint detection + override merge logic.
    const emptyParsed = {
        files: [],
        icons: [],
        registryEntries: [],
        header: { appName: undefined, appVersion: "" },
        version: { isUnicode: () => true },
    } as unknown as InnoParseResult;
    const gog = parseGogGameInfo(gameFiles);
    const override = getOverride(db, gog.gameId);
    const synth = synthesizeManifest({ parsed: emptyParsed, gameFiles, override, cli });
    return { manifest: synth.manifest, registry: synth.registry, gameId: synth.gameId };
}

/** Write a staged `.wgb` to OPFS `bottleship/_wizard/<id>.wgb` and return its path. */
async function writeStaged(id: string, bytes: Uint8Array): Promise<string> {
    const bs = await getBottleshipRoot(true);
    if (!bs) throw new Error("OPFS unavailable — cannot stage bundle");
    const wizard = await bs.getDirectoryHandle(WIZARD_DIR, { create: true });
    const key = `${gameIdToContainerDir(id)}.wgb`;
    const fh = await wizard.getFileHandle(key, { create: true });
    const createSah = (fh as unknown as { createSyncAccessHandle?: () => Promise<any> }).createSyncAccessHandle;
    if (typeof createSah === "function") {
        const sah = await createSah.call(fh);
        try {
            sah.truncate(0);
            let pos = 0;
            while (pos < bytes.byteLength) {
                const n = sah.write(bytes.subarray(pos), { at: pos });
                if (n <= 0) throw new Error("SAH short write");
                pos += n;
            }
            sah.flush();
        } finally {
            try { sah.close(); } catch { /* ignore */ }
        }
    } else {
        const w = await fh.createWritable();
        await w.write(asWriteChunk(bytes));
        await w.close();
    }
    return `${WIZARD_DIR}/${key}`;
}

/**
 * Build a staged (un-booted) `.wgb`: extract → synthesize manifest+registry → buildZip →
 * write to OPFS `bottleship/_wizard/<id>.wgb`. Posts progress via `onProgress`.
 */
export async function buildStagedBundle(source: BuildSource, onProgress?: ProgressFn): Promise<BuildResult> {
    if (source.directory) {
        onProgress?.("detecting", 0, `Reading ${source.directory.name}`);
        if (source.directoryMode === "gog-installer") {
            return buildStagedBundle(await installerDirectorySource(source), onProgress);
        }
        return buildDirectoryBundle(source, onProgress);
    }
    onProgress?.("detecting", 0, "Inspecting source");
    const detections = await detectSource(source);
    const db = await loadOverrides();

    let wgbBytes: Uint8Array;
    let manifest: Record<string, unknown>;
    let gameId: string;

    if (detections.kind === "wgb") {
        onProgress?.("reading", 10, "Reading bundle");
        const blob = await readSourceBlob(source);
        const archive = new ZipArchive(new BlobSource(blob));
        await archive.init();
        const manEntry = archive.getEntry("manifest.json");
        if (!manEntry) throw new Error("not a WGB bundle (no manifest.json)");
        manifest = JSON.parse(new TextDecoder().decode(await archive.readEntry(manEntry)));
        gameId = resolveGameId(manifest as { gameId?: string; name?: string; entrypoint?: string });
        const bs = await getBottleshipRoot(true);
        if (!bs) throw new Error("Browser storage unavailable");
        const dir = await bs.getDirectoryHandle(WIZARD_DIR, { create: true });
        const key = crypto.randomUUID() + ".wgb";
        const writable = await (await dir.getFileHandle(key, { create: true })).createWritable();
        try {
            for (let at = 0; at < blob.size; at += 256 * 1024) {
                await writable.write(blob.slice(at, Math.min(blob.size, at + 256 * 1024)));
                onProgress?.("staging", Math.round(Math.min(blob.size, at + 256 * 1024) / blob.size * 100), "Staging bundle on disk");
            }
            await writable.close();
        } catch (err) {
            await writable.abort();
            await dir.removeEntry(key);
            throw err;
        }
        return { stagedPath: `${WIZARD_DIR}/${key}`, manifest, entries: entriesFromZip(archive.listEntries()), gameId, detections };
    } else if (detections.kind === "gog-installer") {
        const result = await buildInstallerOnDisk(source, db, onProgress);
        manifest = result.manifest;
        gameId = resolveGameId(manifest);
        detections.gogGameId = result.gameId;
        const entries = (await inspectStaged(result.stagedPath)).entries;
        Object.assign(detections, collectExeDetections(entries.map(e => e.name.replace(/^rom\//, ""))));
        onProgress?.("done", 100, "Ready");
        return { stagedPath: result.stagedPath, manifest, entries, gameId, detections };
    } else if (detections.kind === "installshield") {
        // InstallShield 5/6 cabinet (inside a zip, or a folder of installer files) →
        // recurse into the installer (data*.hdr+data*.cab → real game tree), then synth
        // from THOSE files (not the raw installer scaffolding).
        let installerFiles: Map<string, Uint8Array>;
        if (source.files) {
            installerFiles = source.files;
        } else {
            onProgress?.("unzipping", 0, "Unzipping installer");
            installerFiles = await unzipStored(await readSourceBytes(source));
        }
        onProgress?.("installing", 10, "Extracting installer");
        ({ wgbBytes, manifest, gameId } = await buildFromContainer(installerFiles, source, db, detections, onProgress, 10));
    } else if (detections.kind === "archive-7z") {
        // 7z archive (e.g. archive.org demo) → unwrap via the unpack-buffered wasm lib, then
        // recurse one level: the payload is usually an InstallShield/Inno installer,
        // sometimes a raw game tree.
        onProgress?.("unzipping", 0, "Extracting 7z archive");
        const extracted = await extract7z(await readSourceBytes(source));
        onProgress?.("installing", 10, "Extracting installer");
        ({ wgbBytes, manifest, gameId } = await buildFromContainer(extracted, source, db, detections, onProgress, 10));
    } else if (detections.kind === "installer-sfx") {
        // Self-extracting archive (WinZip SFX etc.) → unwrap the embedded ZIP, then recurse:
        // the payload is usually an installer (e.g. an EA `compressed.zip` + `common_filelist.txt`),
        // occasionally a raw game tree (packaged as-is).
        onProgress?.("unzipping", 0, "Extracting self-extractor");
        const sfxFiles = await unzipStored(await readSourceBytes(source));
        onProgress?.("installing", 10, "Checking installer payload");
        ({ wgbBytes, manifest, gameId } = await buildFromContainer(sfxFiles, source, db, detections, onProgress, 10));
    } else if (detections.kind === "iso9660") {
        // CD/DVD image → mount the ISO9660 filesystem, then recurse: a disc is just
        // another container, usually holding an InstallShield/Inno installer (run it),
        // occasionally a pre-installed game tree (package as-is).
        onProgress?.("reading", 0, "Reading disc image");
        const discBytes = await readSourceBytes(source);
        const image = IsoImage.mount(new BufferSource(discBytes));
        onProgress?.("unzipping", 5, `Mounting disc filesystem (${image.layout.label})`);
        const discFiles = extractIsoToMap(image);
        onProgress?.("installing", 10, "Checking disc for installer");
        ({ wgbBytes, manifest, gameId } = await buildFromContainer(discFiles, source, db, detections, onProgress, 10));
    } else if (detections.kind === "installer-zip" || detections.kind === "game-folder") {
        // Plain zip / folder of extracted files → unzip (if needed) → synth → buildZip.
        let gameFiles: Map<string, Uint8Array>;
        if (detections.kind === "game-folder") {
            gameFiles = source.files!;
        } else {
            onProgress?.("unzipping", 0, "Unzipping");
            gameFiles = await unzipStored(await readSourceBytes(source));
        }
        onProgress?.("packing", 60, "Building bundle");
        const synth = synthFromFiles(gameFiles, withSynthName(source.cli, source, gameFiles), db);
        manifest = synth.manifest;
        gameId = resolveGameId(manifest as { gameId?: string; name?: string; entrypoint?: string });
        wgbBytes = buildZip(packGameFiles(gameFiles, synth.manifest, synth.registry));
        detections.gogGameId = detections.gogGameId ?? synth.gameId;
    } else {
        throw new Error(`unsupported source: ${detections.note ?? detections.kind}`);
    }

    onProgress?.("staging", 95, "Writing staged bundle");
    const stagedPath = await writeStaged(gameId, wgbBytes);

    // List the staged bundle's entries for the wizard's content tree.
    const archive = new ZipArchive(new ZipBufferSource(wgbBytes));
    await archive.init();
    const entries = entriesFromZip(archive.listEntries());

    onProgress?.("done", 100, "Ready");
    Logger.log(LogCategory.SYSTEM, `WGB build: staged "${stagedPath}" gameId="${gameId}" (${entries.length} entries)`);
    return { stagedPath, manifest, entries, gameId, detections };
}

/** Inspect an existing `.wgb` (list entries + read manifest.json) WITHOUT a full extraction. */
export async function inspectBundle(source: BuildSource): Promise<InspectResult> {
    const archive = new ZipArchive(new BlobSource(await readSourceBlob(source)));
    await archive.init();
    const manEntry = archive.getEntry("manifest.json");
    if (!manEntry) throw new Error("not a WGB bundle (no manifest.json)");
    const manifest = JSON.parse(new TextDecoder().decode(await archive.readEntry(manEntry)));
    return { manifest, entries: entriesFromZip(archive.listEntries()) };
}

/**
 * Read a single entry's raw bytes out of a staged `.wgb` (for the wizard's inline text
 * editor). `name` is the bundle entry path (e.g. `rom/Game/foo.ini`). Throws if the
 * staged bundle or the entry is missing.
 */
export async function readStagedEntry(stagedPath: string, name: string): Promise<Uint8Array> {
    const archive = new ZipArchive(new BlobSource(await stagedFile(stagedPath)));
    await archive.init();
    const entry = archive.getEntry(name);
    if (!entry) throw new Error(`entry "${name}" not found in staged bundle`);
    if (entry.uncompressedSize > 16 * 1024 * 1024) throw new Error("Text editor supports files up to 16 MB");
    return archive.readEntry(entry);
}

/**
 * Finalize a staged bundle: read its entries, swap the (possibly edited) manifest.json /
 * registry.json, re-pack, and route by destination.
 *   - `play`     → persist to the library, then launch by cache URL.
 *   - `library`  → persist into the OPFS WGB cache (keyed by gameId container dir).
 *   - `download` → return a disk-backed File for the host to save.
 */
export async function finalizeBundle(args: FinalizeArgs): Promise<FinalizeResult> {
    const report = (percent: number, label: string) => args.onProgress?.(percent, label);

    report(0, "Reading staged bundle…");
    const archive = new ZipArchive(new BlobSource(await stagedFile(args.stagedPath)));
    await archive.init();
    const enc = new TextEncoder();
    const replacements = new Map<string, Uint8Array>([
        ["manifest.json", enc.encode(JSON.stringify(args.manifest, null, 2))],
    ]);
    if (args.registry !== undefined) replacements.set("registry.json", enc.encode(JSON.stringify(args.registry, null, 2)));
    for (const [name, text] of Object.entries(args.editedFiles ?? {})) {
        if (archive.getEntry(name)) replacements.set(name, enc.encode(text));
    }
    const sources: ZipStreamEntry[] = [];
    for (const entry of archive.listEntries()) {
        if (entry.isDirectory || replacements.has(entry.name)) continue;
        if (entry.compression !== 0) throw new Error("WGB finalization requires store-only entries");
        sources.push({ name: entry.name, source: { size: entry.uncompressedSize,
            readRange: (start, end) => archive.readEntryRange(entry, start, end - start) } });
    }
    for (const [name, bytes] of replacements) sources.push({ name, source: new ZipBufferSource(bytes) });
    const gameId = resolveGameId(args.manifest);
    const suggestedFilename = manifestToWgbFilename(args.manifest);
    const bs = await getBottleshipRoot(true);
    if (!bs) throw new Error("Browser storage unavailable");
    const cacheKey = gameIdToContainerDir(gameId) + ".wgb";
    const dir = await bs.getDirectoryHandle(args.destination === "download" ? WIZARD_DIR : "wgb-cache", { create: true });
    const handle = await dir.getFileHandle(args.destination === "download" ? "export-" + crypto.randomUUID() + ".wgb" : cacheKey, { create: true });
    const writable = await handle.createWritable();
    const total = sources.reduce((n, e) => n + e.source.size, 0);
    try {
        await writeZipStream(sources, { write: async (bytes, at) => { await writable.seek(at); await writable.write(asWriteChunk(bytes)); } },
            done => report(Math.min(99, total ? Math.round(done / total * 100) : 0), "Saving package to browser storage…"));
        await writable.close();
    } catch (err) {
        try { await writable.abort(); } catch { /* Preserve the write error. */ }
        if ((await handle.getFile()).size === 0) await dir.removeEntry(handle.name);
        if ((err as DOMException).name === "QuotaExceededError") {
            throw new Error("Browser storage is full. Free cached files in Settings → Storage and try again.");
        }
        throw err;
    }
    const file = await handle.getFile();
    if (args.destination !== "download") await removeStagedBundle(args.stagedPath);
    report(100, "Done");
    return { destination: args.destination, gameId, suggestedFilename, file,
        ...(args.destination === "download" ? {} : { cacheKey }) };
}

export async function stagedFile(stagedPath: string): Promise<File> {
    const parts = stagedPath.split("/");
    if (!(parts[0] === WIZARD_DIR && parts.length === 2) && !(parts[0] === "_imports" && parts.length === 3)) throw new Error("Invalid staging path");
    if (parts.some(p => !p || p === "." || p === ".." || p.includes("\\"))) throw new Error("Invalid staging path");
    let dir = await getBottleshipRoot(false);
    if (!dir) throw new Error("Browser storage unavailable");
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    return (await dir.getFileHandle(parts[parts.length - 1]!)).getFile();
}

export async function removeStagedBundle(path: string): Promise<void> {
    // Validate before deleting; staging never owns saves or cached library bundles.
    await stagedFile(path);
    const root = await getBottleshipRoot(false);
    if (!root) return;
    const parts = path.split("/");
    const dir = await root.getDirectoryHandle(parts[0]!);
    await dir.removeEntry(parts[1]!, parts[0] === "_imports" ? { recursive: true } : undefined);
}

async function inspectStaged(path: string): Promise<InspectResult> {
    const archive = new ZipArchive(new BlobSource(await stagedFile(path)));
    await archive.init();
    const manifest = JSON.parse(new TextDecoder().decode(await archive.readEntry(archive.getEntry("manifest.json")!)));
    return { manifest, entries: entriesFromZip(archive.listEntries()) };
}

// --- source byte readers ----------------------------------------------------------

async function readSourceBlob(source: BuildSource): Promise<Blob> {
    if (source.blob) return source.blob;
    if (source.url) {
        const cached = await WgbCache.getBlob(source.url);
        if (cached) return cached;
        const response = await fetch(source.url);
        if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${source.url}`);
        return response.blob();
    }
    throw new Error("source has no readable blob or URL");
}

async function detectBlobFormat(blob: Blob): Promise<DetectedFormat> {
    if (typeof (globalThis as { FileReaderSync?: unknown }).FileReaderSync === "function") {
        return detectSourceFormat(blobRandomAccess(blob));
    }
    return detectFormat(new Uint8Array(await blob.arrayBuffer()));
}

async function readSourceBytes(source: BuildSource): Promise<Uint8Array> {
    if (source.blob) return new Uint8Array(await source.blob.arrayBuffer());
    if (source.url) {
        const cached = await WgbCache.get(source.url);
        if (cached) return cached;
        const resp = await fetch(source.url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${source.url}`);
        return new Uint8Array(await resp.arrayBuffer());
    }
    throw new Error("source has no readable bytes (expected blob or url)");
}

// Re-export for the cache-key guess (used by callers that want to dedupe Inno builds).
export { guessCacheKey };
