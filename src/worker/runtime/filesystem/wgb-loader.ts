import { BlobSource, BufferSource, HttpRangeSource, SyncHttpRangeSource, ZipArchive, ZipEntry } from "@bottleship/formats/zip";
import type { ZipSource } from "@bottleship/formats/zip";
import { CachedSource, computeAdaptiveMaxBytes } from "./cached-source";
import { SabIoSource } from "./sab-io-source";
import { Logger, LogCategory } from "../../core/logger";
import { WgbCache } from "./wgb-cache";

/**
 * Wrap a source in an LRU block-cache where that makes the guest's SYNCHRONOUS
 * read path viable without a per-read cost:
 *  - HttpRangeSource (async-only): cached so warm blocks are sync-readable; cold
 *    blocks still bail to the async-park path.
 *  - BlobSource: has a sync read (FileReaderSync) but it's a per-call syscall on a
 *    slice, so it MUST keep the block cache — otherwise hot streaming (msvcrt
 *    getc) would do one FileReaderSync per byte. CachedSource faults a whole 256
 *    KiB block in synchronously, then serves the rest from RAM.
 *  - BufferSource / SyncAccessHandleSource: already cheap-sync (RAM / OPFS SAH) —
 *    returned untouched; caching would only duplicate already-fast bytes.
 */
/** 256 KiB cache blocks per 1 MiB I/O-worker chunk — the unit the blocking read and
 *  the speculative run below are both expressed in, so they follow the transport's
 *  granularity instead of drifting from it. */
const SAB_BLOCKS_PER_CHUNK = 4;

function withBlockCache(source: ZipSource): ZipSource {
    // Cheap-sync sources (RAM BufferSource, OPFS SyncAccessHandleSource) are returned
    // untouched. BlobSource (FileReaderSync) and SyncHttpRangeSource (a sync-XHR round
    // trip per call) have a *sync* read but an expensive one, so they MUST get the
    // block cache — otherwise hot streaming (msvcrt getc) pays that cost per byte.
    // SabIoSource's readRangeSync is a SAB round-trip to the I/O worker — cheap
    // vs a network XHR, but not free, so it still wants a guest-local block cache
    // for hot reads; only cold misses then cross to the I/O worker.
    const expensiveSync = source instanceof BlobSource || source instanceof SyncHttpRangeSource || source instanceof SabIoSource;
    if (typeof source.readRangeSync === "function" && !expensiveSync) {
        return source;
    }
    const maxBytes = computeAdaptiveMaxBytes(source.size);
    const name = source instanceof BlobSource ? "blob" : source instanceof SyncHttpRangeSource ? "sync-http" : source instanceof SabIoSource ? "sab-io" : "range";
    if (maxBytes > 64 * 1024 * 1024) {
        Logger.log(
            LogCategory.SYSTEM,
            `WGB: block-cache budget ${(maxBytes / 1024 / 1024) | 0} MB for ${name} source (${(source.size / 1024 / 1024).toFixed(1)} MB archive)`,
        );
    }
    // One cold sync miss faults a run of consecutive blocks in ONE inner call
    // (32 × 256 KiB = 8 MiB per sync XHR / FileReaderSync slice): a sequential
    // guest scan (msvcrt getc pre-menu grind) pays per-run, not per-block, while
    // random reads and LRU keep 256 KiB granularity. A self-sustaining prefetch
    // window keeps prefetchDepthRuns × 8 MiB fetched ahead of the read cursor
    // (refilled on hits, chained on completion), so the scan streams off RAM and
    // stops blocking on cold sync faults. Depth 4 = up to 4 concurrent range
    // fetches, leaving connection-pool room for the critical blocking sync read.
    // Over a SabIoSource the two halves of that trade separate, because prefetch now
    // runs on the ASYNC channel (postMessage + transferred response, no Atomics.wait)
    // and is real background work. So the BLOCKING half is sized to the transport's
    // own fetch granularity — one I/O-worker chunk, 1 MiB / SAB_BLOCKS_PER_CHUNK below
    // — because a blocking read that spans more chunks than it needs waits on transfer
    // it will not use, and a seek into a new file (a station switch) is the one read
    // nobody can prefetch. The SPECULATIVE half stays ahead of the cursor on the async
    // channel in runs of twice that, deep enough that one run lands while another is
    // being consumed. This is also the layer that gets the cursor hint, so it is the
    // only one that speculates: the I/O worker below reads ahead only inside the entry
    // the hint names.
    const overSabIo = source instanceof SabIoSource;
    const dev = (globalThis as unknown as { __wgbTune?: { depth?: number; readahead?: number; budgetMB?: number } }).__wgbTune;
    const cache = new CachedSource(source, {
        maxBytes: dev?.budgetMB ? dev.budgetMB * 1024 * 1024 : maxBytes,
        name,
        syncReadaheadBlocks: dev?.readahead ?? (overSabIo ? SAB_BLOCKS_PER_CHUNK : 32),
        prefetchAheadBlocks: overSabIo ? SAB_BLOCKS_PER_CHUNK * 2 : 32,
        prefetchDepthRuns: overSabIo ? 2 : (dev?.depth ?? 4),
    });
    // Dev-only diagnostic handle: `worker-eval globalThis.__wgbBlockCache.stats()`
    // exposes the getc↔streaming interplay (blockingFaults vs syncHits/prefetchRuns).
    if (import.meta.env?.DEV) (globalThis as unknown as { __wgbBlockCache?: ZipSource }).__wgbBlockCache = cache;
    return cache;
}
import type { QualityConfig } from "../../core/quality-config";

/** Presentation metadata baseline carried in the bundle (overridable by the editorial catalog / user). */
export interface WgbMeta {
    developer?: string;
    /** Release year. */
    year?: number;
    /** ROM-relative path to a cover image inside the bundle (e.g. "cover.png"). */
    cover?: string;
    genre?: string;
}

export interface WgbManifest {
    /** 1 = legacy (no gameId); 2 = namespaced gameId + meta + persist/ephemeral policy. */
    formatVersion: number;
    /**
     * Stable game identity = the per-game container / save key. Survives re-download / patch / ?v=2 /
     * region. Namespaced "<scheme>:<id>" (PURL/URN pattern): `gog:<productId>`, `steam:<appid>`,
     * `app:<reverse-dns>`, or `sha256:<trunc>` (BYO-unknown fallback). REQUIRED for authored v2 bundles;
     * resolveGameId() derives an `app:`/`sha256:` id when absent (v1 bundles, raw BYO drops).
     * See container-id.ts.
     */
    gameId?: string;
    /** Human display label (was overloaded onto `name`). Falls back to `name`. */
    title?: string;
    name: string;
    /** Presentation baseline; enriched by editorial catalog / user overrides keyed by gameId. */
    meta?: WgbMeta;
    entrypoint: string;
    args?: string;
    rom?: string;
    registry?: string;
    emulator?: {
        osVersion?: {
            major: number;
            minor: number;
            build?: number;
            platformId?: number; // VER_PLATFORM_WIN32_WINDOWS (0x1) or VER_PLATFORM_WIN32_NT (0x2)
        };
        screenResolution?: {
            width: number;
            height: number;
            bpp?: number;
            refreshRate?: number;
            refresh?: number;
        };
        /** List of resolutions to report in EnumDisplayModes. If not set, only screenResolution is reported. */
        supportedResolutions?: Array<{
            width: number;
            height: number;
            bpp?: number;
            refreshRate?: number;
            refresh?: number;
        }>;
        screenBackgroundColor?: {
            r: number;
            g: number;
            b: number;
            a?: number;
        };
        memory?: {
            ram?: number; // in bytes
            vram?: number; // in bytes
        };
        d3dCaps?: {
            // Partial override for D3D caps (only changeable fields)
            dwMaxTextureWidth?: number;
            dwMaxTextureHeight?: number;
            dwMaxAnisotropy?: number;
            dwMaxTextureRepeat?: number;
            dwMaxTextureAspectRatio?: number;
            dwMaxVertexCount?: number;
            wMaxTextureBlendStages?: number;
            wMaxSimultaneousTextures?: number;
        };
        ddrawCaps?: {
            dwCaps?: number;
            dwCaps2?: number;
            dwVidMemTotal?: number;
            dwVidMemFree?: number;
        };
        /** Windows ANSI code page (GetACP). Default 1252. Use 1251 for Cyrillic, 1250 for Central European, etc. */
        codepage?: number;
        /** Windows OEM code page (GetOEMCP). Default 437. Use 866 for Cyrillic OEM. */
        oemCodepage?: number;
        /** Windows locale identifier (LCID). Default 0x0409 (English US). Use 0x0419 for Russian, etc. */
        lcid?: number;
        /** Skip video playback (BinkOpen/SmackOpen return stubs). For debugging video→menu transitions. */
        skipVideo?: boolean;
        /**
         * Boot with strict x87 FPU (relaxed-FPU f64 fast path disabled → full 80-bit precision).
         * For titles precision-sensitive at the default PC=64 control word — e.g. OGG Vorbis / float
         * audio codecs whose MDCT/synthesis diverges under the f64 relaxed path and corrupts decode
         * (NatalieBrooksSTH music jumps). Mirrors real per-process x87 precision policy.
         */
        fpuStrict?: boolean;
        /**
         * Per-game graphics quality overrides (anisotropy, brightness/contrast/saturation,
         * aspect/integer scaling, post-FX, MSAA/internal-res…). Layered on top of the global
         * user preference at load. See src/worker/core/quality-config.ts (QualityConfig).
         */
        quality?: Partial<QualityConfig>;
        /**
         * Redirect the CD-ROM drive (D:\) to a guest path inside the bundle (typically the install
         * dir holding the CD folders). Run-from-CD games scan D:\ for their data; this aliases
         * D:\<rest> → <cdPath>\<rest> so a single C:-mounted bundle serves both install and "CD".
         * Example: "C:\\Discworld Noir" makes D:\CD1 resolve to C:\Discworld Noir\CD1.
         */
        cdPath?: string;
        /**
         * Case-insensitive LoadLibrary* deny-list for per-game driver toggles.
         * Supports names, paths and wildcard patterns ("opengl3z", "opengl3z.dll", "drivers/opengl3/*").
         */
        disabledDlls?: string[];
        /**
         * DLL names whose copy in the game directory must win over our HLE module, as
         * Windows' search order does (application directory before System32). Needed by
         * games that ship a wrapper/proxy DLL next to the exe — ASI loaders, Glide and
         * ddraw wrappers — which never execute while the HLE answers first.
         * Same rule syntax as disabledDlls ("ddraw", "ddraw.dll", wildcards).
         */
        appDirDlls?: string[];
        /** Glob patterns for files to eagerly prefetch during startup (e.g. ["*.dll", "data/sprites.vga"]) */
        prefetch?: string[];
        /** Fake ShellExecuteA subprocess results: when parameters match `match`, create `createFiles` in VFS */
        shellExecFake?: Array<{
            match: string;
            /** ifAbsent: only create if the target doesn't already exist (so a game-written
             *  copy — e.g. a config with the user's resolution — survives across launches). */
            createFiles: Array<{ path: string; content?: string; copyFrom?: string; ifAbsent?: boolean }>;
        }>;
        /** VFS paths to delete from CoW overlay on every boot (e.g. crash-sentinel files like Running.ini) */
        deleteOnBoot?: string[];
        /**
         * Files written into the VFS on every boot — a data-driven home for per-game
         * config overrides that used to live as hardcoded compatibility patches.
         * Exactly one content form per entry: `text` (UTF-8), `base64`, or `leDwords`
         * (little-endian uint32 sequence, handy for binary config blobs). When
         * `ifAbsent` is true the file is written only if it does not already exist.
         */
        writeFiles?: Array<{
            path: string;
            text?: string;
            base64?: string;
            leDwords?: number[];
            ifAbsent?: boolean;
        }>;
        /**
         * Directories created (mkdir -p) in the VFS on every boot — recreates the empty
         * directory tree a real installer lays down, which store-only ZIP packing loses
         * (a WGB has no dir entries; VFS derives ROM dirs from file paths). Games gate on
         * these: e.g. Max Payne checks `<install>\data` exists before allowing a save and
         * writes its autosave state under data\database\levels\autosave.
         */
        createDirs?: string[];
        /**
         * Persist/ephemeral policy (the ".gitignore" analog). Default is PERSIST: every guest
         * write survives unless its (overlay-relative, case-insensitive) path matches a global default
         * or one of these glob patterns — those are kept ephemeral (scratch / wiped, never written to
         * OPFS). Losing a save is unrecoverable, so persist is the safe default; junk is just evictable.
         * Examples: ["*.log", "Temp/**", "DxCache/**"]. See path-policy.ts.
         */
        ephemeral?: string[];
        /**
         * Opt-in escape hatch: flip to allowlist mode — ONLY paths matching `persist` patterns (plus the
         * global save defaults) are persisted, everything else is ephemeral. For games that write a known
         * small save set amid lots of churn. Off by default.
         */
        persistOnly?: boolean;
        /** Allowlist patterns when `persistOnly` is true. */
        persist?: string[];
        /**
         * Authored on-screen touch controls. `layout` is a preset id from
         * src/input/controls/presets.ts or a full ControlLayout object (validated
         * host-side by validateLayout — kept structural here so the worker carries no
         * UI type). Host-only data: it rides `bundle_meta` and is deliberately NOT
         * routed through EmulatorConfig.applyFromManifest, which the worker would then
         * have to remember to clear in reset() (the cdPath precedent).
         */
        touch?: {
            layout?: string | Record<string, unknown>;
            mode?: "auto" | "direct" | "trackpad";
        };
    };
}

export type WgbWriteFileSpec = NonNullable<NonNullable<WgbManifest["emulator"]>["writeFiles"]>[number];

export interface RegistrySeed {
    root: string;
    path: string;
    values: Array<{ name: string; type: string; data: string | number }>;
}

export interface WgbBundle {
    manifest: WgbManifest;
    archive: ZipArchive;
    entrypointBytes: Uint8Array;
    registry?: RegistrySeed | RegistrySeed[];
}

export class WgbLoader {
    /** Build a bundle from any ZipSource (sync OPFS handle, in-memory buffer, blob, or HTTP range). */
    static async fromSource(source: ZipSource, onStage?: (label: string) => void): Promise<WgbBundle> {
        onStage?.("Reading index");
        const archive = new ZipArchive(withBlockCache(source));
        await archive.init();
        return this.loadFromArchive(archive, onStage);
    }

    static async fromUrl(url: string): Promise<WgbBundle> {
        // DEV: stream on-demand straight from the dev server via synchronous XHR range
        // reads — instant start, NO blocking OPFS full-copy (the slow part of opening a
        // fresh multi-GB bundle). Gated on the server honoring Range: create() probes
        // for 206, so a server that ignores Range throws and we fall through to staging.
        if (import.meta.env?.DEV) {
            // A prior background stage makes repeat dev launches OPFS-fast.
            const staged = await WgbCache.openSyncSourceForUrl(url);
            if (staged) {
                Logger.log(LogCategory.SYSTEM, `WGB: dev cache hit for "${url}" — OPFS sync handle`);
                return this.fromSource(staged);
            }
            // `__wgbForceCache` skips the streaming source so the same bundle can be
            // A/B'd against the OPFS-staged one — the two differ in their read/prefetch
            // machinery, which is exactly what a wrong-offset bug hunt needs to isolate.
            if ((globalThis as { __wgbForceCache?: unknown }).__wgbForceCache === true) {
                Logger.log(LogCategory.SYSTEM, `WGB: __wgbForceCache — skipping dev sync-XHR, staging "${url}" to OPFS`);
            } else try {
                const sync = await SyncHttpRangeSource.create(url);
                Logger.log(LogCategory.SYSTEM, `WGB: dev-streaming "${url}" via sync-XHR range (no OPFS copy)`);
                return await this.fromSource(sync);
            } catch (e) {
                Logger.log(LogCategory.SYSTEM, `WGB: dev sync-stream unavailable (${(e as Error).message}) — staging to OPFS`);
            }
        }

        // Fastest path: a cached bundle read SYNCHRONOUSLY off disk (no RAM copy).
        const syncSource = await WgbCache.openSyncSourceForUrl(url);
        if (syncSource) return this.fromSource(syncSource);

        // Fallback: cached but no sync-access handle → in-memory buffer.
        const cached = await WgbCache.get(url);
        if (cached) return this.fromSource(new BufferSource(cached));

        // Cache miss: start immediately via HTTP range requests, then cache full file in background.
        Logger.log(LogCategory.SYSTEM, `WGB: range-loading "${url}" (first run, caching in background)`);
        return this.fromSource(await HttpRangeSource.create(url));
    }

    static async fromBuffer(data: Uint8Array): Promise<WgbBundle> {
        return this.fromSource(new BufferSource(data));
    }

    static async fromBlob(
        blob: Blob,
        onCacheProgress?: (done: number, total: number) => void,
    ): Promise<WgbBundle> {
        // Staged path (preferred): materialize the File into OPFS wgb-cache once
        // (streamed, progress-reported) and read via FileSystemSyncAccessHandle
        // pread — the SAME steady state as the URL path (downloadToSyncSource), so
        // both ingestion routes converge on one fast sync source. The copy is keyed
        // by filename and reused on later loads (size match), so the multi-GB write
        // happens once per bundle, not per launch. Quota pressure is resolved by
        // WgbCache's LRU eviction of other cache entries (never saves).
        try {
            const syncSource = await WgbCache.mountBlobSync(blob, onCacheProgress);
            if (syncSource) return await this.fromSource(syncSource);
        } catch (err) {
            Logger.warn(LogCategory.SYSTEM, `WGB: OPFS staging failed (${(err as Error).message}) — falling back to no-copy blob`);
        }

        // Fallback (no OPFS/SAH, or quota too tight even after eviction): no-copy
        // CachedSource(BlobSource). FileReaderSync block faults keep every sync
        // consumer (inlined-getc decompressors, GetPrivateProfileString, mmioOpen)
        // correct, but each cold block costs an alloc+copy through FileReader
        // machinery — measured ~25% of worker CPU on a 2.5GB bundle whose working
        // set outgrows the block cache. Correctness fallback, not a fast path.
        Logger.warn(LogCategory.SYSTEM, `WGB: no OPFS sync mount — using no-copy CachedSource(BlobSource) (${blob.size} bytes)`);
        return this.fromSource(new BlobSource(blob));
    }

    private static async loadFromArchive(archive: ZipArchive, onStage?: (label: string) => void): Promise<WgbBundle> {
        const manifestEntry = findEntry(archive, "manifest.json");
        if (!manifestEntry) {
            throw new Error("manifest.json not found");
        }
        const manifestBytes = await archive.readEntry(manifestEntry);
        const manifestText = new TextDecoder("utf-8").decode(manifestBytes);
        let manifest: WgbManifest;
        try {
            manifest = JSON.parse(manifestText) as WgbManifest;
        } catch (err) {
            const error = err as Error;
            const preview = manifestText.substring(0, Math.min(200, manifestText.length));
            const lines = manifestText.split('\n');
            const errorLine = error.message.match(/line (\d+)/)?.[1];
            const context = errorLine ? lines[parseInt(errorLine) - 1] : 'N/A';
            throw new Error(
                `Failed to parse manifest.json: ${error.message}\n` +
                `File: manifest.json\n` +
                `Preview (first 200 chars): ${preview}\n` +
                `Error line context: ${context}`
            );
        }

        onStage?.(`Loading ${manifest.entrypoint.split(/[\\/]/).pop() ?? "game"}`);
        const entrypointBytes = await readEntrypointBytes(archive, manifest.entrypoint);

        let registry: RegistrySeed | RegistrySeed[] | undefined;
        if (manifest.registry) {
            const regPath = normalizeZipPath(manifest.registry);
            const regEntry = findEntry(archive, regPath);
            if (regEntry) {
                const regBytes = await archive.readEntry(regEntry);
                const regText = new TextDecoder("utf-8").decode(regBytes);
                try {
                    registry = JSON.parse(regText) as RegistrySeed | RegistrySeed[];
                } catch (err) {
                    const error = err as Error;
                    const preview = regText.substring(0, Math.min(200, regText.length));
                    const lines = regText.split('\n');
                    const errorLine = error.message.match(/line (\d+)/)?.[1];
                    const context = errorLine ? lines[parseInt(errorLine) - 1] : 'N/A';
                    throw new Error(
                        `Failed to parse registry file: ${error.message}\n` +
                        `File: ${regPath}\n` +
                        `Preview (first 200 chars): ${preview}\n` +
                        `Error line context: ${context}`
                    );
                }
            }
        }

        return { manifest, archive, entrypointBytes, registry };
    }
}

/**
 * Resolve and read the entrypoint EXE bytes from the archive for a given entrypoint
 * path. Exported so a UI-authored manifest override (which is merged onto the bundle
 * AFTER the loader already read the original entrypoint) can re-read the EXE when the
 * override changes `manifest.entrypoint`. Throws (listing available entries) if missing.
 */
export async function readEntrypointBytes(archive: ZipArchive, entrypoint: string): Promise<Uint8Array> {
    const entrypointPath = normalizeZipPath(entrypoint);
    const entry = findEntry(archive, entrypointPath);
    if (!entry) {
        const available = archive.listEntries().map((e) => e.name).join(", ");
        throw new Error(`entrypoint missing: ${entrypointPath}. entries: ${available}`);
    }
    return archive.readEntry(entry);
}

export function buildRomIndex(archive: ZipArchive, romRoot: string): Map<string, ZipEntry> {
    const normalized = normalizeZipPath(romRoot);
    const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
    const index = new Map<string, ZipEntry>();

    const allEntries = archive.listEntries().map(e => e.name);
    Logger.log(LogCategory.SYSTEM, `VFS: buildRomIndex scanning ${allEntries.length} entries, prefix="${prefix}"`);
    // Logger.verbose(LogCategory.SYSTEM, `VFS: All ZIP entries: ${allEntries.join(", ")}`);

    for (const entry of archive.listEntries()) {
        const entryName = normalizeZipPath(entry.name);
        if (!entryName.startsWith(prefix) || entry.isDirectory) continue;
        const rel = entryName.slice(prefix.length);
        index.set(rel, entry);
    }
    if (index.size === 0) {
        Logger.warn(LogCategory.SYSTEM,
            `VFS: ROM index is EMPTY for prefix="${prefix}". ` +
            `Check manifest.rom and bundle layout (e.g. rom/...).`
        );
        Logger.verbose(LogCategory.SYSTEM, `VFS: ZIP entries sample: ${allEntries.slice(0, 20).join(", ")}`);
    } else {
        const sample = Array.from(index.keys()).slice(0, 30);
        Logger.log(LogCategory.SYSTEM, `VFS: ROM index sample (${sample.length}/${index.size}): ${sample.join(", ")}`);
    }
    return index;
}

function normalizeZipPath(path: string): string {
    return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\/+/, "");
}

function findEntry(archive: ZipArchive, path: string): ZipEntry | undefined {
    const normalized = normalizeZipPath(path);
    const direct = archive.getEntry(normalized);
    if (direct) return direct;
    const lower = normalized.toLowerCase();
    return archive.listEntries().find(entry => normalizeZipPath(entry.name).toLowerCase() === lower);
}
