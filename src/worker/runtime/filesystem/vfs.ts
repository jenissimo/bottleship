import { ZipArchive, ZipEntry } from "@bottleship/formats/zip";
import { LruCache } from "../../core/collections/lru-cache";
import { Logger, LogCategory } from "../../core/logger";
import { harnessBus } from "../../harness/event-bus";
import { getContainerDir } from "./container-store";
import { PathPolicy, DEFAULT_PATH_POLICY } from "./path-policy";
import { isVirtualHleSystemFile } from "../../core/hle-system-catalog";
import { expandFileLookupPaths } from "./guest-path-resolver";
import { asArrayBuffer } from "../../../dom-buffer";

export type VfsEntryKind = "file" | "dir";

export interface VfsEntry {
    path: string;
    name: string;
    kind: VfsEntryKind;
    size: number;
    source: "rom" | "overlay";
}

export interface VfsFileHandle {
    kind: "file";
    path: string;
    position: number;
    access: number;
    source: "rom" | "overlay";
    /** Sliding window buffer for sequential reads */
    buffer?: Uint8Array;
    /** File offset of buffer[0] */
    bufferOffset?: number;
    /** Epoch `buffer` was filled under — see VirtualFileSystem.windowEpoch. */
    bufferEpoch?: number;
    /** In-flight prefetch for next sequential chunk */
    prefetchPromise?: Promise<Uint8Array> | null;
    /** File offset where prefetched chunk starts */
    prefetchOffset?: number;
    /** Epoch the in-flight prefetch was issued under. */
    prefetchEpoch?: number;
    /** Serialises async reads on this handle — see `read()`. */
    io?: Promise<unknown>;
}

export interface VfsFindHandle {
    kind: "find";
    entries: VfsEntry[];
    index: number;
}

// Guest I/O trace, opt-in via __vfsTrace. Records (path,pos,len) for every read the
// guest makes through any API, so "which path does this file go through" is answerable
// without guessing which of kernel32/CRT the title happens to use.
const vfsTraceRecords: string[] = [];
(globalThis as { getVfsTrace?: () => string[] }).getVfsTrace = () => vfsTraceRecords.slice();
function vfsTrace(path: string, pos: number, len: number): void {
    if ((globalThis as { __vfsTrace?: unknown }).__vfsTrace !== true) return;
    if (vfsTraceRecords.length >= 20000) return;
    const tid = (globalThis as { __curTid?: () => number }).__curTid?.() ?? -1;
    vfsTraceRecords.push(`${path}|${pos}|${len}|T${tid}`);
}

export class VirtualFileSystem {
    private romArchive: ZipArchive | null = null;
    private romPrefix = "assets";
    private readonly ROM_CACHE_MAX_BYTES = 256 * 1024 * 1024; // 256MB LRU cache
    private readonly MAX_CACHE_ENTRY_SIZE = 64 * 1024 * 1024; // 64MB per file
    private romIndex: Map<string, ZipEntry> = new Map();
    /**
     * All directory paths present in the ROM (lowercased, "/"-separated, no trailing
     * slash), including every intermediate parent. Built once at mount so
     * directoryExists() is O(1) instead of scanning the whole index per call —
     * the hot path for GetFileAttributes / _access existence probes.
     */
    private romDirs: Set<string> = new Set();
    private romCache = new LruCache<string, Uint8Array>({
        maxBytes: this.ROM_CACHE_MAX_BYTES,
        sizeOf: (value) => value.byteLength,
    });
    private romWhiteouts: Set<string> = new Set();
    private romLoadPromises: Map<string, { generation: number; promise: Promise<Uint8Array> }> = new Map();
    private romGeneration = 0;
    /**
     * Un-evictable pin of small ROM files, consulted first by the sync read path.
     * Sync consumers (GetPrivateProfileString, msvcrt buffered fgetc) can't await,
     * so a romCache LRU eviction or a non-resident CachedSource block on the
     * no-copy loader makes readSync return null — a false EOF the game reads as an
     * empty file. Pinning keeps a file permanently sync-readable. Bounded by the
     * caps below; populated via pinRomFiles().
     */
    private romPinned: Map<string, Uint8Array> = new Map();
    private romPinnedBytes = 0;
    private readonly PIN_FILE_MAX = 1 * 1024 * 1024; // 1MB — configs/text are tiny
    private readonly PIN_TOTAL_MAX = 24 * 1024 * 1024; // 24MB total ceiling
    private overlay: OpfsOverlay | null = null;
    /** gameId the current overlay is rooted at — re-init when it changes (game switch). */
    private overlayGameId: string | null = null;
    /** Chunk size for readInto async path to avoid huge temp buffers (256KB) */
    private static readonly READ_INTO_CHUNK = 256 * 1024;
    /** Sequential read-ahead chunk size (512KB) */
    private static readonly PREFETCH_CHUNK_SIZE = 512 * 1024;
    /** Trigger prefetch when less than this many bytes remain in current window */
    private static readonly PREFETCH_TRIGGER_REMAINING = 256 * 1024;
    /** Align ROM/OPFS range reads to 4KB pages for steadier I/O behavior */
    private static readonly IO_ALIGN = 4096;

    /**
     * Bumped whenever a file is truncated, deleted or re-created. Read windows live on
     * the HANDLES, which the VFS does not own or track — a path-keyed truncate therefore
     * has no way to reach the window another open cursor is holding, and that window can
     * cover bytes that no longer exist. Stamping every window with the epoch and
     * rejecting a stale stamp is the reach, at the cost of one integer compare per read.
     *
     * Deliberately global rather than per-path: truncation is rare, the hot path is not,
     * and a per-path lookup would cost a key normalization on every buffered read.
     */
    private windowEpoch = 0;
    /** Rate limit for the stale-window tripwire (see reportStaleWindow). */
    private staleWindowReports = 0;

    currentDir = "C:\\";
    /** When set, D:\ (the CD-ROM drive) is redirected to this guest path. See manifest emulator.cdPath. */
    private cdRedirect: string | null = null;

    /**
     * Open the writable overlay for a game's container (bottleship/games/<containerDir>/overlay/).
     * On a game switch (different gameId) the previous overlay is closed and re-rooted, so game B
     * never sees game A's written files (per-game isolation). gameId is the namespaced container key.
     */
    async initOverlay(gameId: string): Promise<void> {
        if (this.overlay && this.overlayGameId === gameId) return;
        if (this.overlay) {
            try { await this.overlay.close(); } catch { /* best-effort */ }
        }
        this.overlay = new OpfsOverlay();
        await this.overlay.initialize(gameId);
        this.overlayGameId = gameId;
    }

    reset(): void {
        this.romGeneration++;
        this.romArchive = null;
        this.romIndex.clear();
        this.romDirs.clear();
        this.romCache.clear();
        this.romWhiteouts.clear();
        this.romLoadPromises.clear();
        this.romPinned.clear();
        this.romPinnedBytes = 0;
        // Per-game path state must not leak across a game switch.
        this.currentDir = "C:\\";
        this.cdRedirect = null;
    }

    mountRom(archive: ZipArchive, romPrefix: string, index: Map<string, ZipEntry>): void {
        this.romGeneration++;
        this.romArchive = archive;
        this.romPrefix = romPrefix.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
        
        // Build case-insensitive index
        this.romIndex.clear();
        this.romDirs.clear();
        this.romWhiteouts.clear();
        this.romPinned.clear();
        this.romPinnedBytes = 0;
        let compressedEntries = 0;
        let firstCompressedName: string | null = null;
        let firstCompressedMethod: number | null = null;
        for (const [key, entry] of index) {
            const lowerKey = key.toLowerCase();
            this.romIndex.set(lowerKey, entry);
            // Record every parent directory (and explicit dir entries) for O(1) lookup.
            const normKey = lowerKey.replace(/\/+$/, "");
            const dirPath = entry.isDirectory
                ? normKey
                : (normKey.includes("/") ? normKey.replace(/\/[^/]*$/, "") : "");
            let dir = dirPath;
            while (dir && !this.romDirs.has(dir)) {
                this.romDirs.add(dir);
                const slash = dir.lastIndexOf("/");
                dir = slash === -1 ? "" : dir.slice(0, slash);
            }
            if (!entry.isDirectory && entry.compression !== 0) {
                compressedEntries++;
                if (firstCompressedName === null) {
                    firstCompressedName = entry.name;
                    firstCompressedMethod = entry.compression;
                }
            }
        }
        
        if (compressedEntries > 0) {
            const message =
                `Invalid WGB archive: found ${compressedEntries} compressed ZIP entr` +
                `${compressedEntries === 1 ? "y" : "ies"} ` +
                `(first="${firstCompressedName ?? "n/a"}", method=${firstCompressedMethod ?? -1}). ` +
                `BottleShip expects WGB as ZIP STORED-only (method=0). ` +
                `Compressed entries force full decompression and break deterministic range reads. ` +
                `Repack archive with STORE-only entries and retry.`;
            Logger.error(LogCategory.SYSTEM, `VFS: ${message}`);
            throw new Error(message);
        }
        Logger.verbose(LogCategory.SYSTEM, `VFS: ROM mounted, prefix="${this.romPrefix}", index size=${this.romIndex.size}`);
        //const files = Array.from(this.romIndex.keys()).sort();
        //Logger.log(LogCategory.SYSTEM, `VFS: ROM files list (${files.length} files):`);
    }

    async ensureOverlayIndex(): Promise<void> {
        if (!this.overlay) return;
        await this.overlay.loadIndex();
    }

    /** Install the per-game persist/ephemeral policy on the active overlay. */
    setPathPolicy(policy: PathPolicy): void {
        if (this.overlay) this.overlay.setPolicy(policy);
    }

    resolvePath(path: string): string {
        const trimmed = path.trim().replace(/\//g, "\\");
        const driveRelative = trimmed.match(/^([A-Za-z]):(.*)$/);

        let absolute: string;
        if (driveRelative) {
            const drive = driveRelative[1].toUpperCase();
            const tail = driveRelative[2];

            if (tail.startsWith("\\")) {
                // Drive-rooted path, e.g. C:\foo
                absolute = `${drive}:${tail}`;
            } else {
                // Drive-relative path, e.g. C:foo -> current directory on drive C + foo
                const currentDirOnDrive = this.currentDir.toUpperCase().startsWith(`${drive}:\\`)
                    ? this.currentDir
                    : `${drive}:\\`;
                if (!tail) {
                    absolute = currentDirOnDrive;
                } else {
                    const base = currentDirOnDrive.endsWith("\\") ? currentDirOnDrive : `${currentDirOnDrive}\\`;
                    absolute = `${base}${tail}`;
                }
            }
        } else {
            absolute = trimmed.startsWith("\\")
                ? `C:${trimmed}`
                : `${this.currentDir}${trimmed}`;
        }
        // Redirect the CD-ROM drive: D:\<rest> → <cdRedirect>\<rest> (see manifest emulator.cdPath).
        // Lets one C:-mounted bundle serve both the install dir and the "CD" a run-from-CD game scans.
        if (this.cdRedirect && absolute.length >= 2 && (absolute[0] === "D" || absolute[0] === "d") && absolute[1] === ":") {
            absolute = this.cdRedirect + absolute.slice(2);
        }
        return normalizePath(absolute);
    }

    /** Redirect the CD-ROM drive (D:\) into the ROM at a guest path; null disables. */
    setCdRedirect(guestPath: string | null): void {
        this.cdRedirect = guestPath && guestPath.trim() ? guestPath.trim().replace(/[\\/]+$/, "") : null;
    }

    /**
     * Fast synchronous check if file exists in ROM
     * Used for fast-path in CreateFileA
     */
    hasRomFile(path: string): boolean {
        const full = this.resolvePath(path);
        const relRom = this.relRomPath(full);
        return !this.isRomWhiteout(full) && this.romIndex.has(relRom.toLowerCase());
    }

    /**
     * True when the path resolves to a stored file (ROM/overlay) or a virtual HLE system file.
     * Use for GetFileAttributes / _access / SearchPath instead of hasRomFile alone.
     */
    fileExists(path: string): boolean {
        const full = normalizePath(this.resolvePath(path));
        if (this.directoryExists(full)) return false;
        if (this.resolveStoredFile(full)) return true;
        return isVirtualHleSystemFile(full);
    }

    /** Resolve a stored file (ROM/overlay), trying Win9x/NT system-directory aliases. */
    resolveStoredFile(fullPath: string): { path: string; source: "rom" | "overlay" } | null {
        const normalized = normalizePath(fullPath);
        for (const candidate of expandFileLookupPaths(normalized)) {
            if (this.overlay?.hasFile(candidate)) {
                const resolved = this.overlay.resolveExistingPath(candidate) ?? candidate;
                return { path: resolved, source: "overlay" };
            }
            if (this.isRomWhiteout(candidate)) continue;
            const rel = this.relRomPath(candidate).toLowerCase();
            if (this.romIndex.has(rel)) {
                return { path: normalizePath(candidate), source: "rom" };
            }
        }
        return null;
    }

    /**
     * Synchronous open for CRT/Win16 paths. OPEN_EXISTING hits ROM/overlay directly;
     * create dispositions register the file in overlay immediately and flush to OPFS async.
     * Returns null when overlay is unavailable or CREATE_NEW would clobber an existing file.
     */
    openSync(path: string, access: number, disposition: number): VfsFileHandle | null {
        const full = this.resolvePath(path);
        const relRom = this.relRomPath(full);
        const existsInRom = !this.isRomWhiteout(full) && this.romIndex.has(relRom.toLowerCase());
        const createDisposition = disposition >>> 0;
        const hasOverlay = this.overlay?.hasFile(full) ?? false;

        if (createDisposition === 3) {
            if (!this.parentDirectoryExists(full)) {
                Logger.verbose(LogCategory.SYSTEM, `VFS: openSync("${path}") OPEN_EXISTING parent missing for "${full}"`);
                return null;
            }
            if (existsInRom && hasOverlay) {
                const overlayPath = this.overlay!.resolveExistingPath(full) ?? full;
                Logger.verbose(LogCategory.SYSTEM, `VFS: openSync("${path}") -> overlay (overlay takes priority over ROM)`);
                return { kind: "file" as const, path: overlayPath, position: 0, access, source: "overlay" };
            }
            if (hasOverlay) {
                const overlayPath = this.overlay!.resolveExistingPath(full) ?? full;
                Logger.verbose(LogCategory.SYSTEM, `VFS: openSync("${path}") -> found in overlay`);
                return { kind: "file" as const, path: overlayPath, position: 0, access, source: "overlay" };
            }
            if (existsInRom) {
                Logger.verbose(LogCategory.SYSTEM, `VFS: openSync("${path}") -> found in ROM as "${relRom}"`);
                return { kind: "file" as const, path: full, position: 0, access, source: "rom" };
            }
            Logger.verbose(LogCategory.SYSTEM, `VFS: openSync("${path}") -> NOT found (relRom="${relRom}", existsInRom=${existsInRom})`);
            return null;
        }

        if (!this.overlay) {
            Logger.verbose(LogCategory.SYSTEM, `VFS: openSync("${path}") create disposition=${createDisposition} failed: overlay not initialized`);
            return null;
        }

        if (!this.parentDirectoryExists(full)) {
            Logger.verbose(LogCategory.SYSTEM, `VFS: openSync("${path}") create disposition=${createDisposition} parent missing for "${full}"`);
            return null;
        }

        if (createDisposition === 1) {
            if (hasOverlay || existsInRom) {
                Logger.verbose(LogCategory.SYSTEM, `VFS: openSync("${path}") CREATE_NEW failed: file already exists`);
                return null;
            }
            this.clearRomWhiteout(full);
            this.resetOverlayFileSync(full);
            Logger.verbose(LogCategory.SYSTEM, `VFS: openSync("${path}") -> CREATE_NEW overlay`);
            return { kind: "file" as const, path: full, position: 0, access, source: "overlay" };
        }

        if (createDisposition === 2) {
            this.clearRomWhiteout(full);
            this.resetOverlayFileSync(full);
            // Truncation over a ROM file must mask it (empty read, overlay size). See shadowed set.
            if (existsInRom) this.overlay.markShadowed(full);
            Logger.verbose(LogCategory.SYSTEM, `VFS: openSync("${path}") -> CREATE_ALWAYS overlay`);
            return { kind: "file" as const, path: full, position: 0, access, source: "overlay" };
        }

        if (createDisposition === 4) {
            if (!hasOverlay && !existsInRom) {
                this.clearRomWhiteout(full);
                this.resetOverlayFileSync(full);
            }
            const source = hasOverlay ? "overlay" : (existsInRom ? "rom" : "overlay");
            const resolvedPath = source === "overlay"
                ? (this.overlay.resolveExistingPath(full) ?? full)
                : full;
            Logger.verbose(LogCategory.SYSTEM, `VFS: openSync("${path}") -> OPEN_ALWAYS source=${source}`);
            return { kind: "file" as const, path: resolvedPath, position: 0, access, source };
        }

        if (createDisposition === 5) {
            if (!hasOverlay && !existsInRom) {
                Logger.verbose(LogCategory.SYSTEM, `VFS: openSync("${path}") TRUNCATE_EXISTING failed: file not found`);
                return null;
            }
            this.clearRomWhiteout(full);
            this.resetOverlayFileSync(full);
            if (existsInRom) this.overlay.markShadowed(full);
            Logger.verbose(LogCategory.SYSTEM, `VFS: openSync("${path}") -> TRUNCATE_EXISTING overlay`);
            return { kind: "file" as const, path: full, position: 0, access, source: "overlay" };
        }

        return null;
    }

    /**
     * The two content-reset chokepoints (create-fresh / truncate-to-zero). Both bump the
     * window epoch: any read window another open handle holds on this path now describes
     * a file that no longer exists, and the VFS cannot reach those handles directly.
     */
    private resetOverlayFileSync(full: string): void {
        this.bumpWindowEpoch();
        this.overlay!.prepareCreateSync(full);
    }

    private async resetOverlayFile(overlay: OpfsOverlay, full: string): Promise<void> {
        this.bumpWindowEpoch();
        await overlay.truncateFile(full);
    }

    /** Parent directory must exist before CreateFile (Windows does not mkdir implicitly). */
    parentDirectoryExists(fullPath: string): boolean {
        const normalized = normalizePath(fullPath);
        const lastSlash = normalized.lastIndexOf("\\");
        if (lastSlash <= 2) {
            return true; // C:\file — drive root always exists
        }
        const parent = normalized.slice(0, lastSlash);
        return this.directoryExists(parent);
    }

    /**
     * Map a failed open to a Win32 error code (GetLastError after INVALID_HANDLE_VALUE).
     */
    classifyOpenFailure(path: string, disposition: number): number {
        const full = this.resolvePath(path);
        const disp = disposition >>> 0;
        if (!this.parentDirectoryExists(full)) {
            return 3; // ERROR_PATH_NOT_FOUND
        }
        if (!this.overlay && disp !== 3) {
            return 5; // ERROR_ACCESS_DENIED
        }
        const relRom = this.relRomPath(full).toLowerCase();
        const existsInRom = !this.isRomWhiteout(full) && this.romIndex.has(relRom);
        const hasOverlay = this.overlay?.hasFile(full) ?? false;
        if (disp === 3) {
            return 2; // ERROR_FILE_NOT_FOUND
        }
        if (disp === 1 && (hasOverlay || existsInRom)) {
            return 183; // ERROR_ALREADY_EXISTS
        }
        if (disp === 5 && !hasOverlay && !existsInRom) {
            return 2; // ERROR_FILE_NOT_FOUND
        }
        return 2;
    }

    /**
     * Synchronous CreateDirectory — registers the directory in overlay index immediately
     * (Windows-visible before the call returns). OPFS persistence is scheduled async.
     */
    createDirectorySync(path: string): { ok: true } | { ok: false; error: number } {
        const full = normalizePath(this.resolvePath(path));
        if (/^[A-Za-z]:\\$/.test(full)) {
            return { ok: false, error: 183 }; // ERROR_ALREADY_EXISTS
        }
        if (!this.parentDirectoryExists(full)) {
            return { ok: false, error: 3 }; // ERROR_PATH_NOT_FOUND
        }
        if (this.overlay?.hasFile(full)) {
            return { ok: false, error: 183 }; // path is a file
        }
        if (this.directoryExists(full)) {
            return { ok: false, error: 183 }; // ERROR_ALREADY_EXISTS
        }
        if (!this.overlay) {
            return { ok: false, error: 5 }; // ERROR_ACCESS_DENIED
        }
        this.overlay.registerDirectorySync(full);
        void this.overlay.ensureDirectory(full).catch((e) => {
            Logger.error(LogCategory.SYSTEM, `VFS: ensureDirectory("${full}") failed: ${e}`);
        });
        return { ok: true };
    }

    async createDirectory(path: string): Promise<boolean> {
        const result = this.createDirectorySync(path);
        if (!result.ok) {
            return false;
        }
        const full = this.resolvePath(path);
        if (this.overlay) {
            await this.overlay.ensureDirectory(full);
        }
        return true;
    }

    /**
     * mkdir -p for the PARENT directory of a file path: create the path's
     * directory and every missing ancestor. For EMULATOR-SIDE file injection
     * only (shellExecFake createFiles, manifest writeFiles) — i.e. setup-time
     * conveniences that mirror what a real installer would do. The guest's own
     * CreateFile path stays faithful Win32 (ERROR_PATH_NOT_FOUND when a parent
     * dir is missing); do NOT route guest calls through here.
     *
     * Walks components top-down so each parent exists before its child is
     * created; createDirectorySync is idempotent (ALREADY_EXISTS is ignored).
     */
    ensureParentDirsSync(filePath: string): void {
        const full = normalizePath(this.resolvePath(filePath));
        const lastSlash = full.lastIndexOf("\\");
        if (lastSlash <= 2) return; // file sits directly in the drive root
        this.ensureDirTreeSync(full.slice(0, lastSlash));
    }

    /**
     * mkdir -p for a DIRECTORY path: create it and every missing ancestor. Same
     * emulator-side-injection caveat as ensureParentDirsSync — recreates what a real
     * installer laid down (manifest createDirs); guest calls stay faithful Win32.
     */
    ensureDirTreeSync(dirPath: string): void {
        const full = normalizePath(this.resolvePath(dirPath));
        const driveMatch = full.match(/^([A-Za-z]:)\\(.+)$/);
        if (!driveMatch) return;
        let cur = driveMatch[1];
        for (const part of driveMatch[2].split("\\").filter(Boolean)) {
            cur += "\\" + part;
            this.createDirectorySync(cur); // idempotent: ALREADY_EXISTS is fine
        }
    }

    async open(path: string, access: number, disposition: number): Promise<VfsFileHandle | null> {
        Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}", access=0x${access.toString(16)}, disposition=0x${disposition.toString(16)}) starting`);
        try {
            // Try sync fast-path first
            const syncResult = this.openSync(path, access, disposition);
            if (syncResult !== null) {
                Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") completed via sync fast-path, source=${syncResult.source}`);
                return syncResult;
            }

            // Async path for other dispositions
            Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") using async path`);
            const full = this.resolvePath(path);
            const overlay = this.overlay;
            const relRom = this.relRomPath(full);
            const existsInOverlay = overlay?.hasFile(full) ?? false;
            const existsInRom = !this.isRomWhiteout(full) && this.romIndex.has(relRom.toLowerCase());
            const createDisposition = disposition >>> 0;

            if (createDisposition === 3 && !this.parentDirectoryExists(full)) {
                Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") OPEN_EXISTING parent missing`);
                return null;
            }
            if (createDisposition !== 3 && !this.parentDirectoryExists(full)) {
                Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") create disposition=${createDisposition} parent missing`);
                return null;
            }

            Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") -> full="${full}", relRom="${relRom}", existsInOverlay=${existsInOverlay}, existsInRom=${existsInRom}, disposition=${createDisposition}`);

            if (createDisposition === 1) {
                // CREATE_NEW
                if (existsInOverlay || existsInRom) {
                    Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") CREATE_NEW failed: file already exists`);
                    return null;
                }
                Logger.warn(LogCategory.SYSTEM, `VFS: open("${path}") CREATE_NEW not fully handled in async path`);
            }
            if (createDisposition === 2) {
                // CREATE_ALWAYS
                if (!overlay) {
                    Logger.error(LogCategory.SYSTEM, `VFS: open("${path}") CREATE_ALWAYS failed: overlay not initialized`);
                    return null;
                }
                Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") CREATE_ALWAYS: calling truncateFile`);
                this.clearRomWhiteout(full);
                await this.resetOverlayFile(overlay, full);
                if (existsInRom) overlay.markShadowed(full);
                Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") CREATE_ALWAYS: truncateFile completed`);
                return { kind: "file", path: full, position: 0, access, source: "overlay" };
            }
            if (createDisposition === 3) {
                // OPEN_EXISTING - must exist
                if (!existsInOverlay && !existsInRom) {
                    Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") OPEN_EXISTING failed: file not found`);
                    
                    // Diagnostic: Search for this filename in any ROM directory
                    const fileName = path.split(/[\\/]/).pop()?.toLowerCase();
                    if (fileName) {
                        const matches = Array.from(this.romIndex.keys()).filter(k => k.toLowerCase().endsWith("/" + fileName) || k.toLowerCase() === fileName);
                        if (matches.length > 0) {
                            Logger.verbose(LogCategory.SYSTEM, `VFS: Diagnostic - Found potential matches in ROM: ${matches.join(", ")}`);
                        }
                    }
                    
                    return null;
                }
                const source = existsInOverlay ? "overlay" : "rom";
                Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") OPEN_EXISTING: returning handle, source=${source}`);
                const resolvedPath = source === "overlay"
                    ? (overlay?.resolveExistingPath(full) ?? full)
                    : full;
                return { kind: "file", path: resolvedPath, position: 0, access, source };
            }

            if (createDisposition === 4) {
                // OPEN_ALWAYS - open if exists, create if not
                Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") OPEN_ALWAYS: checking if file exists`);
                if (!overlay) {
                    Logger.error(LogCategory.SYSTEM, `VFS: open("${path}") OPEN_ALWAYS failed: overlay not initialized`);
                    return null;
                }
                if (!existsInOverlay && !existsInRom) {
                    Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") OPEN_ALWAYS: file doesn't exist, creating via truncateFile`);
                    this.clearRomWhiteout(full);
                    await this.resetOverlayFile(overlay, full);
                    Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") OPEN_ALWAYS: truncateFile completed`);
                } else {
                    Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") OPEN_ALWAYS: file exists, opening without truncate`);
                }
                const source = existsInOverlay ? "overlay" : (existsInRom ? "rom" : "overlay");
                Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") OPEN_ALWAYS: returning handle, source=${source}`);
                const resolvedPath = source === "overlay"
                    ? (overlay.resolveExistingPath(full) ?? full)
                    : full;
                return { kind: "file", path: resolvedPath, position: 0, access, source };
            }
            if (createDisposition === 5) {
                // TRUNCATE_EXISTING - file must exist, truncate to 0
                Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") TRUNCATE_EXISTING: checking if file exists`);
                if (!overlay) {
                    Logger.error(LogCategory.SYSTEM, `VFS: open("${path}") TRUNCATE_EXISTING failed: overlay not initialized`);
                    return null;
                }
                if (!existsInOverlay && !existsInRom) {
                    Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") TRUNCATE_EXISTING failed: file doesn't exist`);
                    return null;
                }
                Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") TRUNCATE_EXISTING: calling truncateFile`);
                this.clearRomWhiteout(full);
                await this.resetOverlayFile(overlay, full);
                if (existsInRom) overlay.markShadowed(full);
                Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") TRUNCATE_EXISTING: truncateFile completed`);
                return { kind: "file", path: full, position: 0, access, source: "overlay" };
            }

            // Default case (shouldn't reach here for valid dispositions)
            Logger.warn(LogCategory.SYSTEM, `VFS: open("${path}") unhandled disposition=${createDisposition}, using default logic`);
            const source = existsInOverlay ? "overlay" : (existsInRom ? "rom" : "overlay");
            if (source === "overlay" && overlay && !existsInOverlay) {
                Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") default case: creating file via truncateFile`);
                this.clearRomWhiteout(full);
                await this.resetOverlayFile(overlay, full);
            }
            Logger.verbose(LogCategory.SYSTEM, `VFS: open("${path}") default case: returning handle, source=${source}`);
            const resolvedPath = source === "overlay"
                ? (overlay?.resolveExistingPath(full) ?? full)
                : full;
            return { kind: "file", path: resolvedPath, position: 0, access, source };
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `VFS: open("${path}", access=0x${access.toString(16)}, disposition=0x${disposition.toString(16)}) failed: ${e}`);
            throw e;
        }
    }

    /**
     * Synchronous version of read for fast-path scenarios (e.g. cached ROM files)
     */
    readSync(handle: VfsFileHandle, length: number): Uint8Array | null {
        const buffered = this.readFromHandleBuffer(handle, length);
        if (buffered !== null) {
            this.maybeSchedulePrefetch(handle);
            return buffered;
        }

        if (handle.source === "rom") {
            const rel = this.relRomPath(handle.path).toLowerCase();
            const cached = this.romPinned.get(rel) ?? this.romCache.get(rel);
            if (cached) {
                const offset = handle.position;
                const end = Math.min(cached.byteLength, offset + length);
                if (offset >= cached.byteLength) return new Uint8Array();
                const data = cached.subarray(offset, end);
                this.advanceCursor(handle, data.length);
                this.installWindow(handle, cached, 0, this.windowEpoch);
                return data;
            }

            // Large uncached STORED ROM entries: sync range read (BufferSource WGB cache).
            const entry = this.romIndex.get(rel);
            if (entry && this.romArchive && entry.compression === 0) {
                const data = this.romArchive.readEntryRangeSync(entry, handle.position, length);
                if (data) {
                    this.advanceCursor(handle, data.length);
                    return data;
                }
            }
        }

        // Overlay: try cached sync handle
        if (handle.source === "overlay" && this.overlay) {
            const merged = this.readOverlayRomUnderlaySync(handle.path, handle.position, length);
            if (merged !== null) {
                this.advanceCursor(handle, merged.length);
                return merged;
            }
            const data = this.overlay.readFileSyncVia(handle.path, handle.position, length);
            if (data !== null) {
                this.advanceCursor(handle, data.length);
                return data;
            }
        }
        return null;
    }

    /**
     * A handle's cursor, window and prefetch are shared mutable state, and the async
     * path below yields twice while holding a pre-await snapshot of the position. Two
     * guest threads on ONE handle (a loader on the level assets, an audio thread
     * streaming music out of the same archive) then double-advance the cursor and every
     * later read is served from further ahead — silently, at full length.
     *
     * NT makes this impossible: a synchronous file object serialises its I/O on the
     * file-object lock and updates CurrentByteOffset under it. Reproduce that. The SYNC
     * fast path stays outside the queue — it completes in one JS turn, so it cannot
     * interleave, and serialising it would cost without buying anything.
     */
    async read(handle: VfsFileHandle, length: number): Promise<Uint8Array> {
        if (length <= 0) {
            return new Uint8Array();
        }

        Logger.verbose(LogCategory.SYSTEM, `VFS: read(handle.path="${handle.path}", position=${handle.position}, length=${length}) starting`);
        const sync = this.readSync(handle, length);
        if (sync) {
            Logger.verbose(LogCategory.SYSTEM, `VFS: read("${handle.path}") completed via sync fast-path, read ${sync.length} bytes`);
            return sync;
        }

        const prior = handle.io ?? Promise.resolve();
        const mine = prior.then(() => this.readLocked(handle, length), () => this.readLocked(handle, length));
        handle.io = mine.catch(() => undefined);
        return mine;
    }

    private async readLocked(handle: VfsFileHandle, length: number): Promise<Uint8Array> {
        // Re-check the window: a read that queued behind another one may now be a hit.
        const sync = this.readSync(handle, length);
        if (sync) return sync;

        try {
            let offset = handle.position;

            if (handle.prefetchPromise && handle.prefetchOffset !== undefined && offset >= handle.prefetchOffset) {
                // The bytes come from the promise we had BEFORE the await; its offset must
                // come from the same instant. Anything that ran during the yield may have
                // invalidated the window and scheduled a different prefetch — installing
                // these bytes under that one's offset makes the window lie, and a lying
                // window is served silently at full length by readFromHandleBuffer.
                const pending = handle.prefetchPromise;
                const prefetchOffset = handle.prefetchOffset;
                const prefetchEpoch = handle.prefetchEpoch ?? this.windowEpoch;
                const prefetched = await pending;
                if (handle.prefetchPromise === pending) {
                    handle.prefetchPromise = null;
                    handle.prefetchOffset = undefined;
                    handle.prefetchEpoch = undefined;
                    // A truncate during the fetch makes these bytes stale; installWindow
                    // refuses them and the read falls through to a fresh fetchRange below.
                    const installed = this.installWindow(handle, prefetched, prefetchOffset, prefetchEpoch);

                    const buffered = installed ? this.readFromHandleBuffer(handle, length) : null;
                    if (buffered !== null) {
                        this.maybeSchedulePrefetch(handle);
                        Logger.verbose(LogCategory.SYSTEM, `VFS: read("${handle.path}") completed from prefetched window, read ${buffered.length} bytes, new position=${handle.position}`);
                        return buffered;
                    }
                }
            }

            // Re-read the cursor: the prefetch await above is a yield point, and the sync
            // read path is deliberately not serialised, so it may have moved.
            offset = handle.position;
            const fileSize = this.getFileSize(handle.path);
            const remaining = Math.max(0, fileSize - offset);
            if (remaining === 0) {
                return new Uint8Array();
            }

            // One-shot full-tail reads (e.g. startup asset loads) should not force
            // a 512KB prefetch window for small files.
            const isWholeTailRead = length >= remaining;
            const readSize = isWholeTailRead
                ? remaining
                : Math.max(length, VirtualFileSystem.PREFETCH_CHUNK_SIZE);
            const readEpoch = this.windowEpoch;
            const dataWindow = await this.fetchRange(handle, offset, readSize);
            this.installWindow(handle, dataWindow, offset, readEpoch);

            const data = dataWindow.subarray(0, Math.min(length, dataWindow.byteLength));
            this.advanceCursor(handle, data.length);
            this.maybeSchedulePrefetch(handle);

            Logger.verbose(
                LogCategory.SYSTEM,
                `VFS: read("${handle.path}") completed from ${handle.source === "overlay" ? "overlay" : "ROM"} window, read ${data.length} bytes, new position=${handle.position}`
            );
            return data;
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `VFS: read("${handle.path}", position=${handle.position}, length=${length}) failed: ${e}`);
            throw e;
        }
    }

    /**
     * Synchronous read-into for fast-path (cached ROM): writes into target, returns bytes read or null if async needed.
     */
    readIntoSync(handle: VfsFileHandle, target: Uint8Array, targetOffset: number, length: number): number | null {
        // Every file API the guest can use — kernel32 ReadFile and the CRT's fread alike —
        // funnels through here, so this is the only place that sees ALL of a guest's I/O.
        vfsTrace(handle.path, handle.position, length);
        // Check handle buffer first (works for both ROM and overlay)
        const buffered = this.readFromHandleBuffer(handle, length);
        if (buffered !== null) {
            target.set(buffered, targetOffset);
            this.maybeSchedulePrefetch(handle);
            return buffered.length;
        }

        if (handle.source === "rom") {
            const rel = this.relRomPath(handle.path).toLowerCase();
            const cached = this.romPinned.get(rel) ?? this.romCache.get(rel);
            if (cached) {
                const offset = handle.position;
                const end = Math.min(cached.byteLength, offset + length);
                if (offset >= cached.byteLength) return 0;
                const toCopy = end - offset;
                target.set(cached.subarray(offset, end), targetOffset);
                this.advanceCursor(handle, toCopy);
                this.installWindow(handle, cached, 0, this.windowEpoch);
                return toCopy;
            }

            const entry = this.romIndex.get(rel);
            if (entry && this.romArchive && entry.compression === 0) {
                const data = this.romArchive.readEntryRangeSync(entry, handle.position, length);
                if (data && data.length > 0) {
                    target.set(data, targetOffset);
                    this.advanceCursor(handle, data.length);
                    return data.length;
                }
            }
        }

        // Overlay: try cached sync handle (read directly into target — zero-copy)
        if (handle.source === "overlay" && this.overlay) {
            const merged = this.readOverlayRomUnderlayIntoSync(
                handle.path, handle.position, target, targetOffset, length,
            );
            if (merged !== null) {
                this.advanceCursor(handle, merged);
                return merged;
            }
            const data = this.overlay.readFileSyncVia(handle.path, handle.position, length);
            if (data !== null) {
                target.set(data, targetOffset);
                this.advanceCursor(handle, data.length);
                return data.length;
            }
        }
        return null;
    }

    /**
     * Read directly into target buffer (no intermediate allocation). Uses chunks on async path to limit temp buffer size.
     */
    async readInto(handle: VfsFileHandle, target: Uint8Array, targetOffset: number, length: number): Promise<number> {
        const sync = this.readIntoSync(handle, target, targetOffset, length);
        if (sync !== null) {
            Logger.verbose(LogCategory.SYSTEM, `VFS: readInto("${handle.path}") sync fast-path, read ${sync} bytes`);
            return sync;
        }

        const chunkSize = VirtualFileSystem.READ_INTO_CHUNK;
        let totalRead = 0;
        const startPos = handle.position;

        try {
            while (totalRead < length) {
                const chunk = Math.min(chunkSize, length - totalRead);
                const data = await this.read(handle, chunk);
                if (data.length === 0) break;
                target.set(data, targetOffset + totalRead);
                totalRead += data.length;
                if (data.length < chunk) break;
            }
            Logger.verbose(LogCategory.SYSTEM, `VFS: readInto("${handle.path}") async, read ${totalRead} bytes`);
            return totalRead;
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `VFS: readInto("${handle.path}", position=${startPos}, length=${length}) failed: ${e}`);
            throw e;
        }
    }

    /** Synchronous write for CRT _write paths — buffers to overlay and schedules OPFS flush. */
    writeSync(handle: VfsFileHandle, data: Uint8Array): number {
        if (!this.overlay || data.length === 0) {
            return data.length === 0 ? 0 : -1;
        }
        // Same first move as the async twin: the window predates this write, so leaving
        // it installed serves pre-write bytes to a read-after-write on this very handle
        // (fopen "r+b" → fread → fseek → fwrite → fseek → fread). Flipping `source` to
        // overlay under a still-installed whole-ROM-entry window is the same lie.
        this.invalidateReadWindow(handle);
        if (handle.source === "rom") {
            handle.source = "overlay";
        }
        try {
            const written = this.overlay.writeFileSync(handle.path, handle.position, data);
            if (written < 0) return -1;
            // Harness fileWritten event (gated — this is the hot guest-write path).
            if (harnessBus.fileEvents && written > 0) harnessBus.emit("fileWritten", { path: handle.path, offset: handle.position, length: written, sync: true });
            this.advanceCursor(handle, written);
            return written;
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `VFS: writeSync("${handle.path}") failed: ${e}`);
            return -1;
        }
    }

    async write(handle: VfsFileHandle, data: Uint8Array): Promise<number> {
        Logger.verbose(LogCategory.SYSTEM, `VFS: write(handle.path="${handle.path}", position=${handle.position}, size=${data.length}) starting`);
        this.invalidateReadWindow(handle);
        if (!this.overlay) {
            Logger.warn(LogCategory.SYSTEM, `VFS: write("${handle.path}") failed: overlay not initialized`);
            return 0;
        }
        try {
            const writeStart = performance.now();
            const written = await this.overlay.writeFile(handle.path, handle.position, data);
            const writeTime = performance.now() - writeStart;
            if (harnessBus.fileEvents && written > 0) harnessBus.emit("fileWritten", { path: handle.path, offset: handle.position, length: written, sync: false });
            this.advanceCursor(handle, written);
            // Promote source to overlay so subsequent reads from this handle see written data
            if (handle.source === "rom") handle.source = "overlay";
            Logger.verbose(LogCategory.SYSTEM, `VFS: write("${handle.path}") completed: wrote ${written} bytes in ${writeTime.toFixed(2)}ms, new position=${handle.position}`);
            return written;
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `VFS: write("${handle.path}", position=${handle.position}, size=${data.length}) failed: ${e}`);
            throw e;
        }
    }

    async flushFile(path: string): Promise<void> {
        if (!this.overlay) return;
        await this.overlay.flushFile(path);
    }

    async flushAll(): Promise<void> {
        if (!this.overlay) return;
        await this.overlay.flushAll();
    }

    async deleteFile(path: string): Promise<boolean> {
        const full = normalizePath(this.resolvePath(path));
        if (!this.overlay) return false;
        const rel = this.relRomPath(full).toLowerCase();
        const romEntry = rel ? this.romIndex.get(rel) : undefined;
        const hasRomFile = !!romEntry && !romEntry.isDirectory && !this.romWhiteouts.has(rel);
        this.bumpWindowEpoch(); // windows on a deleted (or now whited-out) file describe nothing
        const deletedOverlay = await this.overlay.deleteFile(full);
        if (hasRomFile) {
            this.romWhiteouts.add(rel);
            return true;
        }
        return deletedOverlay;
    }

    /**
     * Drop the user's copy-on-write copy of `path` and go back to the shipped ROM file.
     *
     * NOT the same as deleteFile, and the difference is load-bearing: a guest DeleteFile on a
     * ROM-shadowed file must leave a whiteout, or the shipped file would reappear and the
     * delete would be a lie. That is correct and stays. But "undo my override" is a different
     * operation with no spelling until now, and reaching for deleteFile to perform it leaves
     * the file GONE rather than shipped — which is silent, because the caller asked for a
     * delete and got one. Every fixture reset (a game's own written config shadowing the
     * bundle's) needs this, not that.
     *
     * Returns what actually happened, so a caller cannot mistake "nothing to revert" for
     * "reverted".
     */
    async revertToRom(path: string, timeoutMs = 4000): Promise<{ reverted: boolean; hadOverlay: boolean; hadWhiteout: boolean; romExists: boolean; blocked?: string }> {
        const full = normalizePath(this.resolvePath(path));
        const rel = this.relRomPath(full).toLowerCase();
        const romEntry = rel ? this.romIndex.get(rel) : undefined;
        const romExists = !!romEntry && !romEntry.isDirectory;
        const hadWhiteout = rel !== "" && this.romWhiteouts.has(rel);
        this.bumpWindowEpoch();
        // Settle the commit that may still be writing this file before removing it — a game
        // whose config is mid-flush is exactly when a fixture reset gets asked for, and racing
        // the commit leaves the delete waiting on a lock it cannot get.
        // OPFS hands `createWritable` an EXCLUSIVE lock, so settling the in-flight commit for a
        // file the RUNNING guest still holds — and then removing it — can wait indefinitely.
        // Answering "blocked" beats never answering: a verb that hangs takes the whole harness
        // chain with it and looks like a dead worker. The timeout covers BOTH steps, because the
        // settle is the one that actually stalls.
        let blocked: string | null = null;
        const overlay = this.overlay;
        const removal = overlay
            ? (async () => {
                await overlay.settlePendingFlush(full);
                return await overlay.deleteFile(full);
            })().catch((e: unknown) => {
                // The running guest still has the file open, so OPFS refuses removeEntry.
                blocked = String((e as { name?: string })?.name ?? e);
                return false;
            })
            : Promise.resolve(false);
        const hadOverlay = await Promise.race([
            removal,
            new Promise<boolean>((resolve) => setTimeout(() => { blocked = "timeout"; resolve(false); }, timeoutMs)),
        ]);
        if (hadWhiteout && !blocked) this.romWhiteouts.delete(rel);
        return {
            reverted: !blocked && romExists && (hadOverlay || hadWhiteout),
            hadOverlay, hadWhiteout, romExists,
            ...(blocked ? { blocked } : {}),
        };
    }

    /**
     * Faithful RemoveDirectory: the directory must exist, be empty (across ROM
     * and overlay), and be overlay-backed (there is no whiteout for ROM
     * directories — removing one would need per-dir whiteout plumbing).
     * Win32 error codes: 2 FILE_NOT_FOUND / 145 DIR_NOT_EMPTY / 5 ACCESS_DENIED.
     */
    async removeDirectory(path: string): Promise<{ ok: true } | { ok: false; error: number }> {
        const full = normalizePath(this.resolvePath(path));
        if (/^[A-Za-z]:\\$/.test(full)) {
            return { ok: false, error: 5 }; // ERROR_ACCESS_DENIED — drive root
        }
        if (!this.directoryExists(full)) {
            return { ok: false, error: 2 }; // ERROR_FILE_NOT_FOUND
        }
        if ((this.listDirectory(full) ?? []).length > 0) {
            return { ok: false, error: 145 }; // ERROR_DIR_NOT_EMPTY
        }
        const rel = this.relRomPath(full).toLowerCase();
        const romEntry = rel ? this.romIndex.get(rel) : undefined;
        if (romEntry?.isDirectory) {
            return { ok: false, error: 5 }; // ROM dir — no whiteout support
        }
        if (!this.overlay) {
            return { ok: false, error: 5 };
        }
        const deleted = await this.overlay.deleteDirectory(full);
        return deleted ? { ok: true } : { ok: false, error: 5 };
    }

    /**
     * Store the executable in the overlay so it can be accessed by the game
     * (e.g., for CRC checksum verification)
     */
    async storeExecutable(data: Uint8Array, filename: string = "app.exe"): Promise<void> {
        if (!this.overlay) {
            Logger.warn(LogCategory.SYSTEM, `VFS: storeExecutable failed: overlay not initialized`);
            return;
        }
        try {
            // Ensure the file doesn't exist or is truncated
            await this.resetOverlayFile(this.overlay, filename);
            await this.overlay.writeFile(filename, 0, data);
            Logger.verbose(LogCategory.SYSTEM, `VFS: Stored executable "${filename}" (${data.length} bytes)`);
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `VFS: storeExecutable("${filename}") failed: ${e}`);
        }
    }

    /**
     * Truncate a file to a specific size. Used by SetEndOfFile.
     */
    async truncateAt(path: string, size: number): Promise<void> {
        if (!this.overlay) throw new Error('VFS overlay not initialized');
        const full = this.resolvePath(path);
        // Every window taken before now may cover bytes past the new EOF, including
        // windows on handles this call cannot see. Bump BEFORE the await so a read that
        // interleaves with the truncate cannot install bytes under the old epoch.
        this.bumpWindowEpoch();
        await this.overlay.truncateFileAt(full, size);
        // SetEndOfFile sets the authoritative EOF; beyond it Windows reads zero, never ROM.
        // Once a ROM-backed file's end is set here, the overlay masks the ROM underlay.
        if (this.romUncompressedSize(normalizePath(full)) > 0) this.overlay.markShadowed(full);
    }

    /**
     * A second, INDEPENDENT cursor onto the same open file. Win32 operations that read a
     * file without being a read on the file object — MapViewOfFile populating a view,
     * FlushViewOfFile writing one back — must not disturb the guest's file pointer. The
     * cursor is per-handle state, so those paths take their own handle instead of
     * save/restoring the guest's around an await (during which the guest can legitimately
     * seek, and the restore then silently reverts it).
     */
    /** The handle's current byte offset (Win32 CurrentByteOffset / C ftell). */
    tell(handle: VfsFileHandle): number {
        return handle.position;
    }

    /**
     * The ONE cursor advance. Written as an explicit read-then-write because
     * tools/validate-file-cursor.ts bans `position +=` outright: a compound assignment
     * is a read-modify-write, and every double-advance bug in this file looked like one
     * — two paths each crediting the same bytes, silently, at full length.
     */
    private advanceCursor(handle: VfsFileHandle, bytes: number): void {
        handle.position = handle.position + bytes;
    }

    duplicateHandle(handle: VfsFileHandle, position = 0): VfsFileHandle {
        return {
            kind: "file",
            path: handle.path,
            position,
            access: handle.access,
            source: handle.source,
        };
    }

    setPosition(handle: VfsFileHandle, offset: number, method: number): number {
        vfsTrace(handle.path, offset, -1);
        const oldPosition = handle.position;
        let next = oldPosition;
        if (method === 0) {
            next = offset;
        } else if (method === 1) {
            next = oldPosition + offset;
        } else if (method === 2) {
            next = this.getFileSize(handle.path) + offset;
        }
        // Win32 would fail the call with ERROR_NEGATIVE_SEEK and leave the pointer
        // alone; clamping is the pre-existing behaviour and changing it is a contract
        // change across every seek caller (see the report accompanying this work).
        if (next < 0) next = 0;
        handle.position = next;
        if (handle.position !== oldPosition) {
            // Only invalidate if new position is outside the buffered range
            if (handle.buffer && handle.bufferOffset !== undefined) {
                const relPos = handle.position - handle.bufferOffset;
                if (relPos < 0 || relPos > handle.buffer.byteLength) {
                    this.invalidateReadWindow(handle);
                }
            } else {
                this.invalidateReadWindow(handle);
            }
        }
        return handle.position;
    }

    getFileSize(path: string): number {
        // Exact cwd-aware resolution first. The fuzzy media-path fallback matches any
        // ROM path by suffix, so consulting it first returns a different same-named
        // file's size for relative paths (e.g. "Pak\pf.pak" from C:\Maps\Casa hit
        // another map's pak).
        const fullExact = this.resolvePath(path);
        const romSizeExact = this.romUncompressedSize(fullExact);
        const overlaySizeExact = this.overlay?.getSize(fullExact);
        if (overlaySizeExact !== undefined) {
            // Shadowed (truncated/created-fresh) overlay size is authoritative — never report
            // the larger ROM size (that would be a phantom EOF the game reads past the data).
            if (romSizeExact > overlaySizeExact && !this.overlay!.isShadowed(fullExact)) {
                return romSizeExact;
            }
            return overlaySizeExact;
        }
        if (romSizeExact > 0) return romSizeExact;

        const resolved = this.resolveRomMediaPath(path);
        if (resolved !== null) {
            const full = this.resolvePath(resolved);
            const overlaySize = this.overlay?.getSize(full);
            const romSize = this.romUncompressedSize(full);
            if (overlaySize !== undefined) {
                if (romSize > overlaySize && !this.overlay!.isShadowed(full)) {
                    return romSize;
                }
                return overlaySize;
            }
            if (romSize > 0) return romSize;
        }
        return 0;
    }

    private romUncompressedSize(fullPath: string): number {
        if (this.isRomWhiteout(fullPath)) return 0;
        const entry = this.romIndex.get(this.relRomPath(fullPath).toLowerCase());
        return entry?.uncompressedSize ?? 0;
    }

    /**
     * Sparse/stale overlay entry is smaller than ROM — reads must continue from ROM
     * past overlay EOF. Equal-size overlay+ROM (e.g. engine.ini) uses overlay only.
     */
    private overlayHasRomUnderlay(path: string): boolean {
        if (!this.overlay?.hasFile(path)) return false;
        const full = this.resolvePath(path);
        // A truncated / created-fresh overlay file fully masks the ROM: reads past its EOF
        // are EOF, never stale ROM bytes. Only a partially-overwritten (never-truncated)
        // overlay file keeps the ROM underlay for its untouched tail.
        if (this.overlay.isShadowed(full)) return false;
        const overlaySize = this.overlay.getSize(full) ?? 0;
        const romSize = this.romUncompressedSize(full);
        return romSize > overlaySize;
    }

    /** Sync read for sparse overlay+ROM merge; null when direct overlay read suffices. */
    private readOverlayRomUnderlaySync(path: string, offset: number, length: number): Uint8Array | null {
        if (!this.overlayHasRomUnderlay(path) || length <= 0) return null;
        const fileSize = this.getFileSize(path);
        if (offset >= fileSize) return new Uint8Array(0);
        const toRead = Math.min(length, fileSize - offset);
        const out = new Uint8Array(toRead);
        const copied = this.fillOverlayRomUnderlay(path, offset, out, 0, toRead);
        if (copied === null) return null; // not serviceable synchronously — caller goes async
        return out.subarray(0, copied);
    }

    /** readIntoSync variant — returns bytes copied or null if not underlay. */
    private readOverlayRomUnderlayIntoSync(
        path: string,
        offset: number,
        target: Uint8Array,
        targetOffset: number,
        length: number,
    ): number | null {
        if (!this.overlayHasRomUnderlay(path) || length <= 0) return null;
        const fileSize = this.getFileSize(path);
        if (offset >= fileSize) return 0;
        const toRead = Math.min(length, fileSize - offset);
        return this.fillOverlayRomUnderlay(path, offset, target, targetOffset, toRead);
    }

    /**
     * Copy up to `toRead` bytes from overlay then ROM underlay into `target`. Returns the
     * byte count, or null when the overlay cannot be served synchronously at all (the
     * caller must retry on the async path — reporting 0 there would be a false EOF).
     *
     * The ROM underlay covers only the region PAST the overlay's EOF. A read that comes
     * up short INSIDE the overlay's own extent is a short read, not an EOF — filling that
     * gap from ROM hands back pre-write bytes in the middle of a file the guest already
     * overwrote. So the fall-through is gated on the cursor actually having reached
     * overlaySize, and a short overlay read returns short.
     */
    private fillOverlayRomUnderlay(
        path: string,
        offset: number,
        target: Uint8Array,
        targetOffset: number,
        toRead: number,
    ): number | null {
        const full = this.resolvePath(path);
        const overlaySize = this.overlay!.getSize(full) ?? 0;
        let copied = 0;

        if (offset < overlaySize) {
            const ovLen = Math.min(toRead, overlaySize - offset);
            const ov = this.overlay!.readFileSyncVia(full, offset, ovLen);
            if (ov === null) return null; // cannot be served synchronously — caller falls back
            const n = Math.min(ov.length, ovLen);
            if (n > 0) target.set(ov.subarray(0, n), targetOffset);
            copied += n;
            if (n < ovLen) return copied;
        }
        if (copied < toRead && offset + copied >= overlaySize) {
            const romOff = offset + copied;
            const romLen = toRead - copied;
            const romBuf = new Uint8Array(romLen);
            const fake: VfsFileHandle = {
                kind: "file",
                path: full,
                position: romOff,
                access: 0,
                source: "rom",
            };
            const romRead = this.readIntoSync(fake, romBuf, 0, romLen) ?? 0;
            if (romRead > 0) {
                target.set(romBuf.subarray(0, romRead), targetOffset + copied);
                copied += romRead;
            }
        }
        return copied;
    }

    private async readOverlayRomUnderlayAsync(path: string, offset: number, length: number): Promise<Uint8Array> {
        const fileSize = this.getFileSize(path);
        if (offset >= fileSize || length <= 0) return new Uint8Array(0);
        const toRead = Math.min(length, fileSize - offset);
        const full = this.resolvePath(path);
        const overlaySize = this.overlay?.getSize(full) ?? 0;
        const out = new Uint8Array(toRead);
        let copied = 0;

        if (offset < overlaySize && this.overlay) {
            const ovLen = Math.min(toRead, overlaySize - offset);
            const ov = await this.overlay.readFile(full, offset, ovLen);
            const n = Math.min(ov.length, ovLen);
            if (n > 0) out.set(ov.subarray(0, n), 0);
            copied += n;
            // Short INSIDE the overlay extent — a short read, not an EOF for ROM to patch.
            if (n < ovLen) return out.subarray(0, copied);
        }
        if (copied < toRead && offset + copied >= overlaySize) {
            const rom = await this.readRom(full, offset + copied, toRead - copied);
            out.set(rom.subarray(0, Math.min(rom.length, toRead - copied)), copied);
            copied += Math.min(rom.length, toRead - copied);
        }
        return out.subarray(0, copied);
    }

    /**
     * Resolve a guest media path to a ROM entry (case-insensitive).
     * Handles Windows paths like media\\logo.avi vs rom/media/logo.AVI in the bundle.
     */
    resolveRomMediaPath(requestedPath: string): string | null {
        const stripped = requestedPath.trim().replace(/\\/g, "/");
        const noDrive = stripped.replace(/^[A-Za-z]:/i, "").replace(/^\/+/, "");
        if (!noDrive) return null;

        const tryRel = (rel: string): string | null => {
            const key = rel.toLowerCase().replace(/\/+/g, "/").replace(/^\/+/, "");
            if (this.romIndex.has(key)) {
                return this.romPathFromRel(key);
            }
            return null;
        };

        let hit = tryRel(noDrive);
        if (hit) return hit;

        // Basename under media/ (e.g. logo.avi → media/logo.avi)
        const base = noDrive.split("/").pop();
        if (base) {
            hit = tryRel(`media/${base}`);
            if (hit) return hit;
        }

        // Any ROM path ending with the requested suffix
        const suffix = noDrive.toLowerCase();
        for (const key of this.romIndex.keys()) {
            if (key === suffix || key.endsWith(`/${suffix}`)) {
                return this.romPathFromRel(key);
            }
        }

        return null;
    }

    listDirectory(path: string): VfsEntry[] {
        const full = this.resolvePath(path);
        const entries = new Map<string, VfsEntry>();

        if (this.overlay) {
            for (const entry of this.overlay.listDirectory(full)) {
                entries.set(entry.name.toLowerCase(), entry);
            }
        }

        for (const entry of this.listRomDirectory(full)) {
            if (!entries.has(entry.name.toLowerCase())) {
                entries.set(entry.name.toLowerCase(), entry);
            }
        }

        return Array.from(entries.values());
    }

    /**
     * Exact-path stat for a single name (no wildcards). Resolves overlay-then-ROM
     * with the same precedence and dir-vs-file semantics as listDirectory(), but in
     * O(1)/O(children) instead of O(total-files). Returns null if nothing matches.
     *
     * This is the fast path for the extremely common "FindFirstFile as existence
     * check" idiom: enumerating the whole directory just to confirm one file exists
     * (e.g. Morrowind probing Data Files\*.esm on every load) scans the entire ROM
     * index per call. There is no whiteout for ROM files (overlay.deleteFile only
     * removes overlay entries), so "present in overlay OR present in ROM" is exactly
     * what listDirectory would surface.
     */
    statEntry(path: string): VfsEntry | null {
        const full = normalizePath(this.resolvePath(path));
        const basename = (p: string): string => {
            const parts = p.split("\\");
            return parts[parts.length - 1] ?? p;
        };

        // Overlay wins over ROM (mirrors the listDirectory merge order).
        if (this.overlay) {
            const ov = this.overlay.getEntry(full);
            if (ov) {
                return {
                    path: ov.path,
                    name: basename(ov.path),
                    kind: ov.kind,
                    size: ov.kind === "dir" ? 0 : ov.size,
                    source: "overlay",
                };
            }
            // Implicit overlay directory (a file exists under this prefix).
            if (this.overlay.hasDirectory(full)) {
                return { path: full, name: basename(full), kind: "dir", size: 0, source: "overlay" };
            }
        }

        // ROM is mounted as C:\ only.
        if (!full.startsWith("C:\\")) return null;
        const rel = this.relRomPath(full).toLowerCase();
        if (!rel) return null;

        const fileEntry = this.romIndex.get(rel);
        if (fileEntry && !fileEntry.isDirectory && !this.romWhiteouts.has(rel)) {
            const originalRel = this.romEntryOriginalRel(fileEntry, rel);
            return {
                path: this.romPathFromRel(originalRel),
                name: basename(originalRel.replace(/\//g, "\\")),
                kind: "file",
                size: fileEntry.uncompressedSize,
                source: "rom",
            };
        }

        // ROM directory. O(1) existence check first (keeps not-found probes cheap);
        // only when it really is a dir do we scan for a child to recover the
        // original-case segment (rare path — exact dir queries only).
        if (!this.romDirs.has(rel)) return null;
        const dirPrefix = `${rel}/`;
        const depth = rel.split("/").length - 1;
        for (const [key, entry] of this.romIndex.entries()) {
            if (!key.startsWith(dirPrefix)) continue;
            if (this.romWhiteouts.has(key)) continue;
            const originalRel = this.romEntryOriginalRel(entry, key);
            const name = originalRel.split("/")[depth] ?? basename(full);
            return { path: this.romPathFromRel(rel), name, kind: "dir", size: 0, source: "rom" };
        }

        return null;
    }

    directoryExists(path: string): boolean {
        const full = this.resolvePath(path);
        const normalized = normalizePath(full);
        if (/^[A-Za-z]:\\$/.test(normalized)) return true;

        if (this.overlay && this.overlay.hasDirectory(normalized)) {
            return true;
        }

        const rel = this.relRomPath(normalized).toLowerCase();
        if (rel === "") {
            return false;
        }
        // O(1): romDirs holds every directory (with all intermediate parents) seen at mount.
        return this.romDirs.has(rel.replace(/\/+$/, ""));
    }

    setCurrentDirectory(path: string): boolean {
        const resolved = this.resolvePath(path);
        if (!this.directoryExists(resolved)) {
            return false;
        }
        const normalized = normalizePath(resolved);
        this.currentDir = normalized.endsWith("\\") ? normalized : `${normalized}\\`;
        return true;
    }

    private listRomDirectory(path: string): VfsEntry[] {
        const normalizedPath = normalizePath(path);
        // ROM is mounted as C:\ only; other drives should not enumerate ROM root.
        if (!normalizedPath.startsWith("C:\\")) {
            return [];
        }

        const rel = this.relRomPath(path).toLowerCase();
        const prefix = rel ? `${rel}/` : "";
        const dirEntries: Map<string, VfsEntry> = new Map();

        for (const [relPath, entry] of this.romIndex.entries()) {
            if (prefix && !relPath.startsWith(prefix)) continue;
            if (this.romWhiteouts.has(relPath)) continue;
            // Derive names from the archive's original path, not the lowercased index
            // key. Guests can be case-sensitive about returned names: Python 1.5's
            // import check_case compares FindFirstFile's cFileName via strncmp, so a
            // lowercased "bladex.dll" makes Blade of Darkness `import Bladex` fail.
            const originalRel = this.romEntryOriginalRel(entry, relPath);
            const remainder = originalRel.slice(prefix.length);
            const parts = remainder.split("/");
            const name = parts[0];
            if (!name) continue;
            if (parts.length === 1) {
                dirEntries.set(name.toLowerCase(), {
                    path: this.romPathFromRel(originalRel),
                    name,
                    kind: "file",
                    size: entry.uncompressedSize,
                    source: "rom",
                });
            } else {
                if (!dirEntries.has(name.toLowerCase())) {
                    dirEntries.set(name.toLowerCase(), {
                        path: this.romPathFromRel(`${prefix}${name}`.replace(/\/+$/, "")),
                        name,
                        kind: "dir",
                        size: 0,
                        source: "rom",
                    });
                }
            }
        }

        return Array.from(dirEntries.values());
    }

    /**
     * Original-case ROM-relative path of an index entry (entry.name minus romPrefix).
     * Falls back to the lowercased index key if the structure unexpectedly differs.
     */
    private romEntryOriginalRel(entry: ZipEntry, lowerRel: string): string {
        let p = entry.name.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
        if (this.romPrefix && p.toLowerCase().startsWith(`${this.romPrefix.toLowerCase()}/`)) {
            p = p.slice(this.romPrefix.length + 1);
        }
        return p.toLowerCase() === lowerRel ? p : lowerRel;
    }

    private relRomPath(fullPath: string): string {
        const normalized = normalizePath(fullPath);
        if (!normalized.startsWith("C:\\")) return "";
        
        const relInVfs = normalized.slice(3); // remove "C:\"
        const rel = relInVfs.replace(/\\/g, "/");
            
        return rel.replace(/\/+/g, "/").replace(/^\/+/, "");
    }

    private romWhiteoutKey(path: string): string {
        return this.relRomPath(this.resolvePath(path)).toLowerCase();
    }

    private isRomWhiteout(path: string): boolean {
        const key = this.romWhiteoutKey(path);
        return key !== "" && this.romWhiteouts.has(key);
    }

    private clearRomWhiteout(path: string): void {
        const key = this.romWhiteoutKey(path);
        if (key) this.romWhiteouts.delete(key);
    }

    private romPathFromRel(rel: string): string {
        return normalizePath(`C:\\${rel.replace(/\//g, "\\")}`);
    }

    private async readRom(path: string, offset: number, length: number): Promise<Uint8Array> {
        const rel = this.relRomPath(path).toLowerCase();
        if (!rel || this.romWhiteouts.has(rel) || !this.romArchive) return new Uint8Array();
        const entry = this.romIndex.get(rel);
        if (!entry) return new Uint8Array();

        const cached = this.romCache.get(rel);
        let data = cached;
        if (!data) {
            // For uncompressed (STORED) large entries we read only requested range.
            // This avoids loading huge assets (e.g. videos) fully into memory.
            if (entry.compression === 0 && entry.uncompressedSize > this.MAX_CACHE_ENTRY_SIZE) {
                return this.romArchive.readEntryRange(entry, offset, length);
            }

            const pending = this.romLoadPromises.get(rel);
            if (pending) {
                data = await pending.promise;
            } else {
                const generation = this.romGeneration;
                const loadPromise = this.romArchive.readEntry(entry)
                    .finally(() => {
                        const current = this.romLoadPromises.get(rel);
                        if (current?.generation === generation && current.promise === loadPromise) {
                            this.romLoadPromises.delete(rel);
                        }
                    });
                this.romLoadPromises.set(rel, { generation, promise: loadPromise });
                data = await loadPromise;
            }

            this.addRomCache(rel, data);
        }

        const end = Math.min(data.byteLength, offset + length);
        if (offset >= data.byteLength) return new Uint8Array();
        return data.subarray(offset, end);
    }

    private addRomCache(rel: string, data: Uint8Array): void {
        if (data.byteLength === 0) return;
        if (data.byteLength > this.MAX_CACHE_ENTRY_SIZE) return;
        if (data.byteLength > this.ROM_CACHE_MAX_BYTES / 2) return;
        this.romCache.set(rel, data);
    }

    // -------------------------------------------------------------------------
    // Smart prefetch API (Phase 1 + Phase 2)
    // -------------------------------------------------------------------------

    /** Returns true if the ROM file is already in the in-memory cache. */
    isRomCached(rel: string): boolean {
        return this.romCache.has(rel.toLowerCase());
    }

    /**
     * Prefetch a single ROM entry into romCache with deduplication via romLoadPromises.
     * Skips files > MAX_CACHE_ENTRY_SIZE (served via range reads on demand).
     */
    private async _prefetchEntry(rel: string, entry: ZipEntry, generation = this.romGeneration, signal?: AbortSignal): Promise<void> {
        const key = rel.toLowerCase();
        if (signal?.aborted || generation !== this.romGeneration) return;
        if (this.romCache.has(key)) return;
        if (!this.romArchive) return;

        const existing = this.romLoadPromises.get(key);
        if (existing && existing.generation === generation) {
            await existing.promise;
            return;
        }

        const loadPromise = this.romArchive.readEntry(entry)
            .then(data => {
                if (!signal?.aborted && generation === this.romGeneration) {
                    this.addRomCache(key, data);
                }
                return data;
            })
            .finally(() => {
                const current = this.romLoadPromises.get(key);
                if (current?.generation === generation && current.promise === loadPromise) {
                    this.romLoadPromises.delete(key);
                }
            });

        this.romLoadPromises.set(key, { generation, promise: loadPromise });
        await loadPromise;
    }

    /**
     * Phase 1 — parallel prefetch of a specific set of files with bounded concurrency.
     * Returns the number of files successfully prefetched (not counting already-cached ones).
     *
     * `onProgress(processed, total)` fires after every item is handled (fetched OR skipped),
     * so the bar advances to `total` smoothly even when many files are already cached. The
     * callback is best-effort — throttle/snapshot on the receiving side as needed.
     */
    async prefetchRomFiles(
        rels: string[],
        concurrency = 8,
        onProgress?: (processed: number, total: number) => void,
        signal?: AbortSignal,
    ): Promise<number> {
        let prefetched = 0;
        let processed = 0;
        const total = rels.length;
        const queue = [...rels];
        const generation = this.romGeneration;
        const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
            while (queue.length > 0) {
                if (signal?.aborted || generation !== this.romGeneration) break;
                const rel = queue.shift()!;
                const key = rel.toLowerCase();
                const entry = this.romIndex.get(key);
                if (entry && !entry.isDirectory && entry.uncompressedSize <= this.MAX_CACHE_ENTRY_SIZE && !this.romCache.has(key)) {
                    try {
                        await this._prefetchEntry(rel, entry, generation, signal);
                        if (!signal?.aborted && generation === this.romGeneration && this.romCache.has(key)) prefetched++;
                    } catch (_) { /* best-effort — range request issues are non-fatal */ }
                }
                onProgress?.(++processed, total);
            }
        });
        await Promise.all(workers);
        return prefetched;
    }

    /**
     * Load (async) and pin a set of ROM files into `romPinned` so later reads are
     * sync-serveable. Per-file and total size are capped; oversize/missing entries
     * are skipped. Returns the number of files newly pinned. See romPinned.
     */
    async pinRomFiles(rels: string[], concurrency = 8): Promise<number> {
        if (!this.romArchive) return 0;
        let pinned = 0;
        const queue = [...rels];
        const tryPin = (key: string, data: Uint8Array): boolean => {
            if (this.romPinned.has(key)) return false;
            if (data.byteLength === 0 || data.byteLength > this.PIN_FILE_MAX) return false;
            if (this.romPinnedBytes + data.byteLength > this.PIN_TOTAL_MAX) return false;
            this.romPinned.set(key, data);
            this.romPinnedBytes += data.byteLength;
            return true;
        };
        const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
            while (queue.length > 0) {
                if (this.romPinnedBytes >= this.PIN_TOTAL_MAX) { queue.length = 0; break; }
                const rel = queue.shift()!;
                const key = rel.toLowerCase();
                if (this.romPinned.has(key)) continue;
                const entry = this.romIndex.get(key);
                if (!entry || entry.isDirectory || entry.uncompressedSize > this.PIN_FILE_MAX) continue;
                try {
                    const cached = this.romCache.get(key);
                    const data = cached ?? await this.romArchive!.readEntry(entry);
                    if (tryPin(key, data)) pinned++;
                } catch (_) { /* best-effort — a missing/short read just stays unpinned */ }
            }
        });
        await Promise.all(workers);
        if (pinned > 0) {
            Logger.log(LogCategory.SYSTEM, `VFS: pinned ${pinned} small ROM files for sync reads (${(this.romPinnedBytes / 1024) | 0} KB)`);
        }
        return pinned;
    }

    /**
     * Phase 2 — background progressive prefetch of all remaining non-cached ROM files.
     * Fire-and-forget; yields the event loop between each file so game I/O stays responsive.
     */
    startProgressivePrefetch(signal?: AbortSignal): void {
        this._runProgressivePrefetch(signal).catch(() => { /* best-effort */ });
    }

    private async _runProgressivePrefetch(signal?: AbortSignal): Promise<void> {
        const generation = this.romGeneration;
        // Sort by size ascending so small files fill cache quickly
        const entries = Array.from(this.romIndex.entries())
            .filter(([, e]) => !e.isDirectory && e.uncompressedSize <= this.MAX_CACHE_ENTRY_SIZE)
            .sort(([, a], [, b]) => a.uncompressedSize - b.uncompressedSize);

        Logger.log(LogCategory.SYSTEM, `VFS: starting progressive prefetch of ${entries.length} files`);

        for (const [rel, entry] of entries) {
            if (signal?.aborted || generation !== this.romGeneration) return;
            if (this.romCache.has(rel)) continue;
            try {
                await this._prefetchEntry(rel, entry, generation, signal);
            } catch (_) { /* best-effort */ }
            // Yield event loop so game I/O gets priority
            await new Promise<void>(r => setTimeout(r, 0));
        }

        Logger.log(LogCategory.SYSTEM, `VFS: progressive prefetch complete`);
    }

    private invalidateReadWindow(handle: VfsFileHandle): void {
        handle.buffer = undefined;
        handle.bufferOffset = undefined;
        handle.bufferEpoch = undefined;
        handle.prefetchPromise = null;
        handle.prefetchOffset = undefined;
        handle.prefetchEpoch = undefined;
    }

    /** A truncate/delete/re-create invalidates every window taken before this point. */
    private bumpWindowEpoch(): void {
        this.windowEpoch = (this.windowEpoch + 1) | 0;
    }

    /**
     * Tripwire for the whole "window lies" class: a window that outlived its bytes
     * would otherwise return plausible-looking stale data at full length, which is
     * indistinguishable from a correct read at every layer above. Say so out loud.
     */
    private reportStaleWindow(handle: VfsFileHandle): void {
        if (this.staleWindowReports >= 16) return;
        this.staleWindowReports++;
        Logger.warn(
            LogCategory.SYSTEM,
            `VFS: stale read window discarded for "${handle.path}" ` +
            `(window epoch=${handle.bufferEpoch}, current=${this.windowEpoch}, ` +
            `offset=${handle.bufferOffset}, position=${handle.position}) — ` +
            `the file was truncated/replaced while this handle held a window`,
        );
    }

    /**
     * Publish `data` as the handle's read window. `epoch` is the epoch the bytes were
     * READ under: a truncate that landed while the read was in flight makes them stale,
     * so they are dropped rather than installed.
     */
    private installWindow(handle: VfsFileHandle, data: Uint8Array, offset: number, epoch: number): boolean {
        if (epoch !== this.windowEpoch) return false;
        handle.buffer = data;
        handle.bufferOffset = offset;
        handle.bufferEpoch = epoch;
        return true;
    }

    private readFromHandleBuffer(handle: VfsFileHandle, length: number): Uint8Array | null {
        const buffer = handle.buffer;
        const bufferOffset = handle.bufferOffset;
        if (!buffer || bufferOffset === undefined) {
            return null;
        }
        if (handle.bufferEpoch !== this.windowEpoch) {
            this.reportStaleWindow(handle);
            this.invalidateReadWindow(handle);
            return null;
        }
        const relPos = handle.position - bufferOffset;
        if (relPos < 0 || relPos + length > buffer.byteLength) {
            return null;
        }
        const out = buffer.subarray(relPos, relPos + length);
        this.advanceCursor(handle, out.length);
        return out;
    }

    private maybeSchedulePrefetch(handle: VfsFileHandle): void {
        const buffer = handle.buffer;
        const bufferOffset = handle.bufferOffset;
        if (!buffer || bufferOffset === undefined) return;
        if (handle.prefetchPromise) return;

        const relPos = handle.position - bufferOffset;
        if (relPos < 0 || relPos > buffer.byteLength) return;
        const remaining = buffer.byteLength - relPos;
        if (remaining > VirtualFileSystem.PREFETCH_TRIGGER_REMAINING) return;

        const nextOffset = bufferOffset + buffer.byteLength;
        const fileSize = this.getFileSize(handle.path);
        if (nextOffset >= fileSize) return;

        handle.prefetchOffset = nextOffset;
        handle.prefetchEpoch = this.windowEpoch;
        handle.prefetchPromise = this.fetchRange(handle, nextOffset, VirtualFileSystem.PREFETCH_CHUNK_SIZE)
            .catch(() => new Uint8Array(0));
    }

    private async fetchRange(handle: VfsFileHandle, offset: number, length: number): Promise<Uint8Array> {
        if (length <= 0) {
            return new Uint8Array();
        }

        const fileSize = this.getFileSize(handle.path);
        if (offset >= fileSize) {
            return new Uint8Array();
        }

        const requestedEnd = Math.min(fileSize, offset + length);
        const alignedStart = this.alignDown(offset, VirtualFileSystem.IO_ALIGN);
        const alignedEnd = this.alignUp(requestedEnd, VirtualFileSystem.IO_ALIGN);
        const alignedLength = Math.max(0, alignedEnd - alignedStart);
        if (alignedLength <= 0) {
            return new Uint8Array();
        }

        const raw = (handle.source === "overlay" && this.overlay)
            ? (this.overlayHasRomUnderlay(handle.path)
                ? await this.readOverlayRomUnderlayAsync(handle.path, alignedStart, alignedLength)
                : await this.overlay.readFile(handle.path, alignedStart, alignedLength))
            : await this.readRom(handle.path, alignedStart, alignedLength);

        const begin = offset - alignedStart;
        if (begin >= raw.byteLength) {
            return new Uint8Array();
        }
        const end = Math.min(raw.byteLength, begin + (requestedEnd - offset));
        return raw.subarray(begin, end);
    }

    // Arithmetic, not bitwise: `&` coerces to int32, so any offset at or past 2 GiB
    // (reachable inside a single >2 GB ROM entry) would come back negative or wrapped.
    private alignDown(value: number, align: number): number {
        return Math.floor(value / align) * align;
    }

    private alignUp(value: number, align: number): number {
        return Math.ceil(value / align) * align;
    }
}

interface WriterCacheEntry {
    writer: FileSystemWritableFileStream | null;
    path: string;
    lastUsed: number;
    queue: Promise<void>;
    /** Open the next writable stream as a replacement/truncate, not as keep-existing-data. */
    replaceExisting?: boolean;
    // Memory buffer for sequential writes
    memoryBuffer: Uint8Array;
    bufferOffset: number;       // File offset where buffer starts
    flushTimer: number | null;  // Scheduled flush timer
    flushInFlight: Promise<void> | null;
}

class OpfsOverlay {
    private root: FileSystemDirectoryHandle | null = null;
    /** Container dir (parent of overlay/) — where the shadow-index sidecar lives. */
    private container: FileSystemDirectoryHandle | null = null;
    private entries: Map<string, { size: number; kind: VfsEntryKind; path: string }> = new Map();
    /**
     * CoW tombstone set (keys via toKey). A path is "shadowed" once it has been
     * TRUNCATED or CREATED-FRESH over a ROM underlay (CREATE_ALWAYS / TRUNCATE_EXISTING /
     * SetEndOfFile). While shadowed, the overlay file is the AUTHORITATIVE, complete file:
     * reads past the overlay EOF return EOF (never fall through to stale ROM bytes) and the
     * reported size is the overlay size, not the ROM size. This is what makes truncation
     * faithful — Windows has no "ROM underlay", so an emptied file must read empty.
     *
     * Contrast: a file merely opened OPEN_EXISTING and PARTIALLY overwritten (WriteFile /
     * mmap write-back) is NOT shadowed, so reads of its untouched tail still fall through to
     * ROM (the CoW sparse-overlay optimization). The distinction is exactly truncate-vs-patch.
     *
     * Persisted to a container sidecar so a relaunch re-opens the truncated state, not ROM.
     */
    private shadowed = new Set<string>();
    private shadowDirty = false;
    private writerCache: Map<string, WriterCacheEntry> = new Map();
    private writerCleanupTimer: number | null = null;
    private readonly writerIdleCloseMs = 1000;
    private readonly WRITE_BUFFER_THRESHOLD = 256 * 1024;  // 256KB
    private readonly WRITE_BUFFER_FLUSH_MS = 50;           // 50ms
    /** Cached FileSystemSyncAccessHandle instances for fast synchronous reads */
    private syncHandleCache = new Map<string, any /* FileSystemSyncAccessHandle */>();
    private syncHandleLru: string[] = [];
    private readonly MAX_SYNC_HANDLES = 32;
    /**
     * In-flight commit promises keyed by file. CloseHandle drives flushFile() as a
     * fire-and-forget task; a guest that immediately reopens + reads the same file
     * (UE1 launcher rewriting then re-reading HP.ini) must observe the committed bytes,
     * not the pre-write content. Reads await any pending flush for the path so the
     * write→close→read ordering holds despite the async commit.
     */
    private pendingFlushes = new Map<string, Promise<void>>();
    /**
     * In-memory authoritative content for overlay files written this session. OPFS
     * exposes WritableFileStream and FileSystemSyncAccessHandle as mutually-exclusive,
     * and a guest's write→close→reopen→read happens far faster than the async OPFS
     * commit settles — so reads served off OPFS handles can race the commit and return
     * stale/zero bytes. Serving reads from this cache makes read-after-write exact and
     * decouples correctness from OPFS handle lifecycle; OPFS writes remain a best-effort
     * persistence backing store. Bounded per file — larger files fall back to OPFS.
     */
    private contentCache = new Map<string, Uint8Array>();
    private readonly CONTENT_CACHE_MAX_FILE = 8 * 1024 * 1024;  // 8MB

    /**
     * Persist/ephemeral policy. Ephemeral files (logs/temp/cache by global default or per-game
     * manifest globs) are kept ONLY in `ephemeralFiles` (in-memory, session-scoped) and NEVER written
     * to OPFS — they are still readable/listable this session, then gone on next launch. Default is
     * persist-by-default (DEFAULT_PATH_POLICY); loadBundle installs the manifest's policy.
     */
    private policy: PathPolicy = DEFAULT_PATH_POLICY;
    private ephemeralFiles = new Map<string, Uint8Array>();

    setPolicy(policy: PathPolicy): void { this.policy = policy; }

    private ephemeralWrite(key: string, path: string, offset: number, data: Uint8Array): number {
        let buf = this.ephemeralFiles.get(key) ?? new Uint8Array(0);
        const end = offset + data.length;
        if (buf.length < end) { const grown = new Uint8Array(end); grown.set(buf, 0); buf = grown; }
        buf.set(data, offset);
        this.ephemeralFiles.set(key, buf);
        const existing = this.entries.get(key);
        this.entries.set(key, { size: Math.max(existing?.size ?? 0, end), kind: "file", path: normalizePath(path) });
        return data.length;
    }

    private ephemeralRead(key: string, offset: number, length: number): Uint8Array {
        const buf = this.ephemeralFiles.get(key);
        if (!buf || offset >= buf.length) return new Uint8Array(0);
        return buf.slice(offset, Math.min(buf.length, offset + length));
    }

    /** Start an authoritative in-memory content buffer for a file created/truncated this session. */
    private cacheReset(key: string): void {
        this.contentCache.set(key, new Uint8Array(0));
    }

    /**
     * Patch a write into the content cache. Only files with an existing cache entry
     * (created/truncated this session via cacheReset) are authoritative; partial writes
     * to pre-existing files are skipped so reads of their untouched regions fall to OPFS.
     */
    private cacheWrite(key: string, offset: number, data: Uint8Array): void {
        let buf = this.contentCache.get(key);
        if (!buf) return;  // not authoritative
        const end = offset + data.length;
        if (end > this.CONTENT_CACHE_MAX_FILE) {
            this.contentCache.delete(key);  // too large to keep — fall back to OPFS
            return;
        }
        if (buf.length < end) {
            const grown = new Uint8Array(end);
            grown.set(buf, 0);
            buf = grown;
            this.contentCache.set(key, buf);
        }
        buf.set(data, offset);
    }

    /** Serve a read from the content cache if the file is authoritative there. */
    private cacheRead(key: string, offset: number, length: number): Uint8Array | null {
        const buf = this.contentCache.get(key);
        if (!buf) return null;
        if (offset >= buf.length) return new Uint8Array(0);
        return buf.slice(offset, Math.min(buf.length, offset + length));
    }

    /** Root this overlay at the game's container: bottleship/games/<containerDir>/overlay/. */
    async initialize(gameId: string): Promise<void> {
        const container = await getContainerDir(gameId, true);
        if (!container) throw new Error("OPFS unavailable: cannot open game container");
        this.container = container;
        this.root = await container.getDirectoryHandle("overlay", { create: true });
        await this.loadShadowIndex();
    }

    /** True when the overlay file fully masks its ROM underlay (truncated / created-fresh). */
    isShadowed(path: string): boolean {
        return this.shadowed.has(toKey(path));
    }

    /** Record that `path` now fully masks any ROM underlay (truncate / create-fresh). */
    markShadowed(path: string): void {
        const key = toKey(path);
        if (!this.shadowed.has(key)) {
            this.shadowed.add(key);
            this.shadowDirty = true;
        }
    }

    private clearShadowed(key: string): void {
        if (this.shadowed.delete(key)) this.shadowDirty = true;
    }

    /** Load the persisted shadow (tombstone) set from the container sidecar. */
    private async loadShadowIndex(): Promise<void> {
        this.shadowed.clear();
        this.shadowDirty = false;
        if (!this.container) return;
        try {
            const fh = await this.container.getFileHandle(SHADOW_INDEX_FILE, { create: false });
            const file = await fh.getFile();
            const parsed = JSON.parse(await file.text()) as { shadowed?: string[] };
            if (Array.isArray(parsed.shadowed)) {
                for (const k of parsed.shadowed) this.shadowed.add(toKey(k));
            }
        } catch (e: any) {
            if (e?.name !== "NotFoundError") {
                Logger.warn(LogCategory.SYSTEM, `OPFS: loadShadowIndex failed: ${e}`);
            }
        }
    }

    /**
     * Persist the shadow set to the container sidecar (sibling of overlay/, so it is never
     * visible to the guest through C:\). Prunes tombstones whose overlay file is gone.
     */
    private async saveShadowIndex(): Promise<void> {
        if (!this.container || !this.shadowDirty) return;
        try {
            for (const k of Array.from(this.shadowed)) {
                const e = this.entries.get(k);
                if (!e || e.kind !== "file") this.shadowed.delete(k);
            }
            const fh = await this.container.getFileHandle(SHADOW_INDEX_FILE, { create: true });
            const writable = await fh.createWritable();
            await writable.write(JSON.stringify({ shadowed: Array.from(this.shadowed) }));
            await writable.close();
            this.shadowDirty = false;
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `OPFS: saveShadowIndex failed: ${e}`);
        }
    }

    /**
     * Tear the overlay down on a game switch: close cached sync handles + writers, drop caches.
     * Best-effort — a failed close must not block the switch.
     */
    async close(): Promise<void> {
        // Durably commit everything written this session BEFORE dropping the in-memory
        // caches. The old path closed open writers but never flushed lazy memoryBuffer
        // entries (the common write path) and never awaited pendingFlushes, so a game
        // switch / relaunch silently discarded recent writes. flushAll() now drains both.
        try { await this.flushAll(); } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `OPFS: close() flushAll failed: ${e}`);
        }
        if (this.writerCleanupTimer !== null) {
            clearTimeout(this.writerCleanupTimer);
            this.writerCleanupTimer = null;
        }
        this.writerCache.clear();
        for (const sah of this.syncHandleCache.values()) {
            try { sah.close(); } catch { /* ignore */ }
        }
        this.syncHandleCache.clear();
        this.syncHandleLru = [];
        this.contentCache.clear();
        this.ephemeralFiles.clear();
        this.entries.clear();
        this.pendingFlushes.clear();
        this.shadowed.clear();
        this.shadowDirty = false;
        this.root = null;
        this.container = null;
    }

    async loadIndex(): Promise<void> {
        if (!this.root) return;
        this.entries.clear();
        await this.scanDirectory(this.root, []);
    }

    hasFile(path: string): boolean {
        const entry = this.entries.get(toKey(path));
        return entry?.kind === "file";
    }

    /** Register a new directory synchronously in the overlay index (CreateDirectory). */
    registerDirectorySync(path: string): void {
        const normalized = normalizePath(path);
        this.entries.set(toKey(normalized), { size: 0, kind: "dir", path: normalized });
    }

    /** Register a new/truncated overlay file synchronously; persistence is serialized through writerCache. */
    prepareCreateSync(path: string): void {
        const key = toKey(path);
        if (this.policy.isEphemeral(path)) {
            this.ephemeralFiles.set(key, new Uint8Array(0));
            this.entries.set(key, { size: 0, kind: "file", path: normalizePath(path) });
            return;
        }
        this.closeSyncHandle(path);
        const staleWriter = this.writerCache.get(key);
        if (staleWriter) {
            this.writerCache.delete(key);
            if (staleWriter.flushTimer !== null) {
                clearTimeout(staleWriter.flushTimer);
                staleWriter.flushTimer = null;
            }
            if (staleWriter.writer) {
                // close() is async and holds OPFS's exclusive lock until it settles, so
                // it is registered as a pending commit rather than dropped: the next
                // writer for this path awaits it instead of failing to open (ensureWriter).
                const closing = staleWriter.writer.close().catch((e) => {
                    Logger.warn(LogCategory.SYSTEM, `OPFS: closing stale writer for "${path}" failed: ${e}`);
                });
                this.pendingFlushes.set(key, closing);
                const done = () => { if (this.pendingFlushes.get(key) === closing) this.pendingFlushes.delete(key); };
                closing.then(done, done);
            }
        }
        this.entries.set(key, { size: 0, kind: "file", path: normalizePath(path) });
        this.cacheReset(key);  // authoritative empty content for read-after-write
        this.writerCache.set(key, {
            writer: null,
            path,
            lastUsed: performance.now(),
            queue: Promise.resolve(),
            replaceExisting: true,
            memoryBuffer: new Uint8Array(0),
            bufferOffset: 0,
            flushTimer: null,
            flushInFlight: null,
        });
        this.scheduleWriterCleanup();
    }

    /**
     * Synchronous buffered write for CRT paths. Updates overlay index immediately;
     * OPFS persistence is scheduled via the same memory buffer as async writeFile.
     */
    writeFileSync(path: string, offset: number, data: Uint8Array): number {
        const key = toKey(path);
        if (this.policy.isEphemeral(path)) return this.ephemeralWrite(key, path, offset, data);
        this.cacheWrite(key, offset, data);  // authoritative in-memory copy for reads
        let cacheEntry = this.writerCache.get(key);
        if (!cacheEntry) {
            this.closeSyncHandle(path);
            cacheEntry = {
                writer: null,
                path,
                lastUsed: performance.now(),
                queue: Promise.resolve(),
                replaceExisting: false,
                memoryBuffer: new Uint8Array(0),
                bufferOffset: offset,
                flushTimer: null,
                flushInFlight: null,
            };
            this.writerCache.set(key, cacheEntry);
        }

        const isSequential = offset === cacheEntry.bufferOffset + cacheEntry.memoryBuffer.length;
        if (isSequential && cacheEntry.memoryBuffer.length + data.length < this.WRITE_BUFFER_THRESHOLD) {
            const newBuffer = new Uint8Array(cacheEntry.memoryBuffer.length + data.length);
            newBuffer.set(cacheEntry.memoryBuffer, 0);
            newBuffer.set(data, cacheEntry.memoryBuffer.length);
            cacheEntry.memoryBuffer = newBuffer;
            cacheEntry.lastUsed = performance.now();
            this.scheduleBufferFlush(cacheEntry, key);

            const existing = this.entries.get(key);
            const size = Math.max(existing?.size ?? 0, offset + data.length);
            this.entries.set(key, { size, kind: "file", path: normalizePath(path) });
            return data.length;
        }

        // Non-sequential write: the buffered run belongs to a different region and must be
        // committed before this one replaces the buffer. flushWriteBuffer takes it in this
        // same turn, so the overwrite below cannot race the commit.
        if (cacheEntry.memoryBuffer.length > 0) {
            void this.flushWriteBuffer(cacheEntry).catch((e) => {
                Logger.error(LogCategory.SYSTEM, `OPFS: writeFileSync("${path}") pre-flush failed: ${e}`);
            });
        }

        const buffered = new Uint8Array(data.length);
        buffered.set(data);
        cacheEntry.bufferOffset = offset;
        cacheEntry.memoryBuffer = buffered;
        cacheEntry.lastUsed = performance.now();
        this.scheduleBufferFlush(cacheEntry, key);

        const existing = this.entries.get(key);
        const size = Math.max(existing?.size ?? 0, offset + data.length);
        this.entries.set(key, { size, kind: "file", path: normalizePath(path) });
        return data.length;
    }

    resolveExistingPath(path: string): string | null {
        const entry = this.entries.get(toKey(path));
        return entry ? entry.path : null;
    }

    hasDirectory(path: string): boolean {
        const key = toKey(path);
        const entry = this.entries.get(key);
        if (entry?.kind === "dir") return true;
        for (const existing of this.entries.keys()) {
            if (existing.startsWith(`${key}\\`)) return true;
        }
        return false;
    }

    getSize(path: string): number | undefined {
        return this.entries.get(toKey(path))?.size;
    }

    /** Exact-path stat: the stored overlay entry (original-case path), if any. */
    getEntry(path: string): { kind: VfsEntryKind; size: number; path: string } | undefined {
        return this.entries.get(toKey(path));
    }

    listDirectory(path: string): VfsEntry[] {
        const normalizedPrefix = normalizePath(path);
        // The drive root normalizes to "C:\" — a trailing separator no other path has, so
        // both the prefix test and the depth test have to be built from segments rather
        // than from the raw string (`"C:\" + "\"` matches nothing, and split() yields a
        // phantom empty segment that makes every root child look too shallow). Getting
        // this wrong hides every guest-created file in the root from FindFirstFile while
        // statEntry still finds it.
        const prefixKey = toKey(normalizedPrefix);
        const prefix = prefixKey.endsWith("\\") ? prefixKey.slice(0, -1) : prefixKey;
        const prefixDepth = normalizedPrefix.split("\\").filter(Boolean).length;
        const out: VfsEntry[] = [];
        const seen = new Set<string>();

        for (const [key, entry] of this.entries.entries()) {
            if (!(key.startsWith(`${prefix}\\`))) continue;
            const entryParts = entry.path.split("\\").filter(Boolean);
            if (entryParts.length <= prefixDepth) continue;
            const name = entryParts[prefixDepth];
            const nameKey = name?.toLowerCase();
            if (!name || !nameKey || seen.has(nameKey)) continue;
            seen.add(nameKey);
            const isDir = entryParts.length > prefixDepth + 1 || entry.kind === "dir";
            out.push({
                path: normalizePath(`${normalizedPrefix}\\${name}`),
                name,
                kind: isDir ? "dir" : "file",
                size: isDir ? 0 : entry.size,
                source: "overlay",
            });
        }

        return out;
    }

    async ensureDirectory(path: string): Promise<void> {
        if (!this.root) {
            throw new Error("OPFS not initialized");
        }
        const segments = toOpfsSegments(path);
        let dir = this.root;
        for (const segment of segments) {
            try {
                dir = await dir.getDirectoryHandle(segment, { create: true });
            } catch (e: any) {
                if (e.name === 'TypeMismatchError') {
                    Logger.warn(LogCategory.SYSTEM, `VFS: Replacing file with directory at segment "${segment}" while ensuring directory "${path}"`);
                    await dir.removeEntry(segment);
                    dir = await dir.getDirectoryHandle(segment, { create: true });
                } else {
                    throw e;
                }
            }
        }
    }

    async truncateFile(path: string): Promise<void> {
        Logger.verbose(LogCategory.SYSTEM, `VFS: truncateFile("${path}") starting`);
        if (this.policy.isEphemeral(path)) {
            const key = toKey(path);
            this.ephemeralFiles.set(key, new Uint8Array(0));
            this.entries.set(key, { size: 0, kind: "file", path: normalizePath(path) });
            return;
        }
        try {
            // Evict stale writer — its writable stream references pre-truncate state
            const key = toKey(path);
            const staleWriter = this.writerCache.get(key);
            if (staleWriter) {
                this.writerCache.delete(key);
                if (staleWriter.flushTimer !== null) {
                    clearTimeout(staleWriter.flushTimer);
                    staleWriter.flushTimer = null;
                }
                // Don't flush — we're about to truncate anyway
                try { await staleWriter.writer?.close(); } catch {}
            }

            this.closeSyncHandle(path);
            const handle = await this.getFileHandle(path, true);
            Logger.verbose(LogCategory.SYSTEM, `VFS: truncateFile got file handle`);
            const writer = await handle.createWritable();
            Logger.verbose(LogCategory.SYSTEM, `VFS: truncateFile got writable stream`);
            await writer.truncate(0);
            Logger.verbose(LogCategory.SYSTEM, `VFS: truncateFile truncated`);
            await writer.close();
            Logger.verbose(LogCategory.SYSTEM, `VFS: truncateFile closed`);
            this.entries.set(toKey(path), { size: 0, kind: "file", path: normalizePath(path) });
            this.cacheReset(key);  // authoritative empty content for read-after-write
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `VFS: truncateFile("${path}") failed: ${e}`);
            throw e;
        }
    }

    /**
     * Truncate a file to a specific size (not necessarily 0).
     * Used by SetEndOfFile.
     */
    async truncateFileAt(path: string, size: number): Promise<void> {
        Logger.verbose(LogCategory.SYSTEM, `VFS: truncateFileAt("${path}", ${size}) starting`);
        if (size === 0) {
            return this.truncateFile(path);
        }
        if (this.policy.isEphemeral(path)) {
            const key = toKey(path);
            const cur = this.ephemeralFiles.get(key) ?? new Uint8Array(0);
            const next = new Uint8Array(size);
            next.set(cur.subarray(0, Math.min(cur.length, size)), 0);
            this.ephemeralFiles.set(key, next);
            this.entries.set(key, { size, kind: "file", path: normalizePath(path) });
            return;
        }
        try {
            const key = toKey(path);
            const staleWriter = this.writerCache.get(key);
            if (staleWriter) {
                this.writerCache.delete(key);
                if (staleWriter.flushTimer !== null) {
                    clearTimeout(staleWriter.flushTimer);
                    staleWriter.flushTimer = null;
                }
                try { await staleWriter.writer?.close(); } catch {}
            }
            this.closeSyncHandle(path);
            const handle = await this.getFileHandle(path, true);
            const writer = await handle.createWritable();
            await writer.truncate(size);
            await writer.close();
            this.entries.set(toKey(path), { size, kind: "file", path: normalizePath(path) });
            // Keep the in-memory content cache consistent with the new size.
            const buf = this.contentCache.get(key);
            if (buf) {
                if (size <= this.CONTENT_CACHE_MAX_FILE) {
                    const resized = new Uint8Array(size);
                    resized.set(buf.subarray(0, Math.min(buf.length, size)), 0);
                    this.contentCache.set(key, resized);
                } else {
                    this.contentCache.delete(key);
                }
            }
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `VFS: truncateFileAt("${path}", ${size}) failed: ${e}`);
            throw e;
        }
    }

    /**
     * Synchronous read using a cached FileSystemSyncAccessHandle.
     * Returns null if no sync handle is cached for this path.
     */
    readFileSyncVia(path: string, offset: number, length: number): Uint8Array | null {
        const key = toKey(path);

        if (this.policy.isEphemeral(path)) return this.ephemeralRead(key, offset, length);

        // Authoritative in-memory content (files written/truncated this session) — exact
        // read-after-write without touching OPFS handles.
        const cached = this.cacheRead(key, offset, length);
        if (cached !== null) return cached;

        // Check writer memory buffer first — sync handles can't see uncommitted writes
        const writerEntry = this.writerCache.get(key);
        if (writerEntry) {
            const bufStart = writerEntry.bufferOffset;
            const bufEnd = bufStart + writerEntry.memoryBuffer.length;
            if (writerEntry.memoryBuffer.length > 0 && offset >= bufStart && offset + length <= bufEnd) {
                const relOffset = offset - bufStart;
                return writerEntry.memoryBuffer.slice(relOffset, relOffset + length);
            }
            // Active writer but the buffer can't serve this range synchronously. Reading a
            // cached sync handle here would race the writer's uncommitted data, so defer to
            // the async path (readFile) which commits the writer before reading.
            return null;
        }

        // A commit (flushFile) is in flight for this file — its bytes aren't durable yet.
        // Force the async read path so the caller awaits the pending flush first.
        if (this.pendingFlushes.has(key)) return null;

        const handle = this.syncHandleCache.get(key);
        if (!handle) return null;

        // Touch LRU
        const idx = this.syncHandleLru.indexOf(key);
        if (idx >= 0) this.syncHandleLru.splice(idx, 1);
        this.syncHandleLru.push(key);

        const buffer = new Uint8Array(length);
        const bytesRead = readSyncAccessHandle(handle, buffer, offset);
        return buffer.subarray(0, bytesRead);
    }

    /**
     * Open or return a cached FileSystemSyncAccessHandle for the given path.
     * Returns null if a writer is active (exclusive lock conflict) or the file is absent
     * (when create=false). A sync access handle is exclusive, so callers must ensure no
     * WritableFileStream is open for the same file first (writerCache empty / writer closed).
     */
    private async ensureSyncHandle(path: string, create = false): Promise<any /* FileSystemSyncAccessHandle */ | null> {
        const key = toKey(path);

        const existing = this.syncHandleCache.get(key);
        if (existing) return existing;

        // Don't open if writer is active — a WritableFileStream and a sync access handle
        // can't coexist on the same OPFS file (createSyncAccessHandle would throw).
        if (this.writerCache.has(key)) return null;

        try {
            // Evict LRU if at capacity
            while (this.syncHandleCache.size >= this.MAX_SYNC_HANDLES && this.syncHandleLru.length > 0) {
                const evictKey = this.syncHandleLru.shift()!;
                const evictHandle = this.syncHandleCache.get(evictKey);
                if (evictHandle) {
                    evictHandle.close();
                    this.syncHandleCache.delete(evictKey);
                }
            }

            const fileHandle = await this.getFileHandle(path, create);
            const syncHandle = await (fileHandle as any).createSyncAccessHandle();
            this.syncHandleCache.set(key, syncHandle);
            this.syncHandleLru.push(key);
            return syncHandle;
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `OPFS: ensureSyncHandle("${path}") failed: ${e}`);
            return null;
        }
    }

    /** Close a cached sync handle (e.g. before opening a writer for the same file). */
    private closeSyncHandle(path: string): void {
        const key = toKey(path);
        const handle = this.syncHandleCache.get(key);
        if (handle) {
            handle.close();
            this.syncHandleCache.delete(key);
            const idx = this.syncHandleLru.indexOf(key);
            if (idx >= 0) this.syncHandleLru.splice(idx, 1);
        }
    }

    async readFile(path: string, offset: number, length: number): Promise<Uint8Array> {
        Logger.verbose(LogCategory.SYSTEM, `OPFS: readFile("${path}", offset=${offset}, length=${length}) starting`);

        const key = toKey(path);

        if (this.policy.isEphemeral(path)) return this.ephemeralRead(key, offset, length);

        // Authoritative in-memory content (files written/truncated this session).
        const cached = this.cacheRead(key, offset, length);
        if (cached !== null) return cached;

        // Wait out any in-flight commit (CloseHandle → flushFile runs fire-and-forget) so a
        // write→close→reopen→read sequence observes the committed bytes, not stale content.
        const inFlight = this.pendingFlushes.get(key);
        if (inFlight) { try { await inFlight; } catch { /* commit error already logged */ } }

        // If there's an active writer with uncommitted data, handle it before reading.
        // WritableFileStream changes aren't visible to readers until writer.close().
        const writerEntry = this.writerCache.get(key);
        if (writerEntry) {
            const buf = writerEntry.memoryBuffer;
            const bufStart = writerEntry.bufferOffset;
            // If memory buffer fully covers the requested range, serve directly
            if (buf.length > 0 && offset >= bufStart && offset + length <= bufStart + buf.length) {
                const relOffset = offset - bufStart;
                Logger.verbose(LogCategory.SYSTEM, `OPFS: readFile("${path}") served from writer memoryBuffer, ${length} bytes`);
                return buf.slice(relOffset, relOffset + length);
            }
            // Otherwise flush and close writer so OPFS has committed data
            this.writerCache.delete(key);
            if (writerEntry.flushTimer !== null) {
                clearTimeout(writerEntry.flushTimer);
                writerEntry.flushTimer = null;
            }
            await this.flushWriteBuffer(writerEntry);
            await writerEntry.queue;
            try { await writerEntry.writer?.close(); } catch {}
            Logger.verbose(LogCategory.SYSTEM, `OPFS: readFile("${path}") flushed and closed active writer before read`);
        }

        // Try sync handle first (already cached)
        const syncResult = this.readFileSyncVia(path, offset, length);
        if (syncResult !== null) {
            Logger.verbose(LogCategory.SYSTEM, `OPFS: readFile("${path}") served from sync handle, ${syncResult.length} bytes`);
            return syncResult;
        }

        // Try to open a sync handle for future reads
        const syncHandle = await this.ensureSyncHandle(path);
        if (syncHandle) {
            const buffer = new Uint8Array(length);
            const bytesRead = readSyncAccessHandle(syncHandle, buffer, offset);
            Logger.verbose(LogCategory.SYSTEM, `OPFS: readFile("${path}") opened sync handle, read ${bytesRead} bytes`);
            return buffer.subarray(0, bytesRead);
        }

        // Fall back to File API (sync handle unavailable)
        try {
            const handle = await this.getFileHandle(path, false);
            const file = await handle.getFile();
            const slice = file.slice(offset, offset + length);
            const buf = await slice.arrayBuffer();
            return new Uint8Array(buf);
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `OPFS: readFile("${path}", offset=${offset}, length=${length}) failed: ${e}`);
            throw e;
        }
    }

    async writeFile(path: string, offset: number, data: Uint8Array): Promise<number> {
        try {
            const key = toKey(path);
            if (this.policy.isEphemeral(path)) return this.ephemeralWrite(key, path, offset, data);
            this.cacheWrite(key, offset, data);  // authoritative in-memory copy for reads
            let cacheEntry = this.writerCache.get(key);
            if (!cacheEntry) {
                this.closeSyncHandle(path);
                cacheEntry = {
                    writer: null,
                    path,
                    lastUsed: performance.now(),
                    queue: Promise.resolve(),
                    replaceExisting: false,
                    memoryBuffer: new Uint8Array(0),
                    bufferOffset: offset,
                    flushTimer: null,
                    flushInFlight: null,
                };
                this.writerCache.set(key, cacheEntry);
            }

            const isSequential = offset === cacheEntry.bufferOffset + cacheEntry.memoryBuffer.length;

            if (isSequential && cacheEntry.memoryBuffer.length + data.length < this.WRITE_BUFFER_THRESHOLD) {
                const newBuffer = new Uint8Array(cacheEntry.memoryBuffer.length + data.length);
                newBuffer.set(cacheEntry.memoryBuffer, 0);
                newBuffer.set(data, cacheEntry.memoryBuffer.length);
                cacheEntry.memoryBuffer = newBuffer;
                cacheEntry.lastUsed = performance.now();
                this.scheduleBufferFlush(cacheEntry, key);

                const existing = this.entries.get(key);
                const size = Math.max(existing?.size ?? 0, offset + data.length);
                this.entries.set(key, { size, kind: "file", path: normalizePath(path) });
                return data.length;
            }

            // Take the buffered run and re-anchor BEFORE yielding. flushWriteBuffer has
            // already emptied memoryBuffer synchronously; anything appended during the
            // awaits below belongs to a later run and must survive them, so this is the
            // only point at which the anchor may be moved.
            const flush = this.flushWriteBuffer(cacheEntry);
            cacheEntry.bufferOffset = offset + data.length;
            await flush;

            await this.ensureWriter(cacheEntry);
            const buffer = new Uint8Array(data).buffer;
            const doWrite = async () => {
                await cacheEntry!.writer!.seek(offset);
                await cacheEntry!.writer!.write(buffer);
                cacheEntry!.lastUsed = performance.now();
            };

            cacheEntry.queue = cacheEntry.queue.then(doWrite, doWrite);
            await cacheEntry.queue;

            this.scheduleWriterCleanup();

            const existing = this.entries.get(key);
            const size = Math.max(existing?.size ?? 0, offset + data.length);
            this.entries.set(key, { size, kind: "file", path: normalizePath(path) });
            return data.length;
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `OPFS: writeFile("${path}", offset=${offset}, size=${data.length}) failed: ${e}`);
            throw e;
        }
    }

    /**
     * Open the entry's WritableFileStream.
     *
     * OPFS gives `createWritable` an EXCLUSIVE lock, so it throws
     * NoModificationAllowedError while any other writable or sync access handle on the
     * same file is still open — including one of ours whose close() has not settled
     * (prepareCreateSync/cleanupWriters retire entries without awaiting the close).
     * A commit that gives up there loses the guest's bytes, so wait the conflict out
     * once: settle whatever commit we already have in flight for this path and retry.
     */
    private async ensureWriter(entry: WriterCacheEntry): Promise<void> {
        if (entry.writer) return;
        this.closeSyncHandle(entry.path);
        const keepExistingData = !entry.replaceExisting;
        const open = async (): Promise<FileSystemWritableFileStream> => {
            const handle = await this.getFileHandle(entry.path, true);
            return handle.createWritable({ keepExistingData });
        };
        try {
            entry.writer = await open();
        } catch (e) {
            if ((e as { name?: string })?.name !== "NoModificationAllowedError") throw e;
            const pending = this.pendingFlushes.get(toKey(entry.path));
            if (pending) { try { await pending; } catch { /* its owner logs it */ } }
            this.closeSyncHandle(entry.path);
            Logger.warn(LogCategory.SYSTEM,
                `OPFS: ensureWriter("${entry.path}") lock conflict — retrying after in-flight commit`);
            entry.writer = await open();
        }
        entry.replaceExisting = false;
    }

    /**
     * Last-resort commit for a buffered run whose WritableFileStream cannot be opened:
     * a sync access handle takes the same lock through a different door. Only usable
     * once the entry is out of writerCache (ensureSyncHandle refuses otherwise), which
     * is exactly the drain/cleanup case. Returns false if it could not commit.
     */
    private async commitBufferViaSyncHandle(path: string, offset: number, buf: Uint8Array): Promise<boolean> {
        const sh = await this.ensureSyncHandle(path, true);
        if (!sh) return false;
        try {
            sh.write(buf, { at: offset });
            sh.flush();
            return true;
        } catch (e) {
            Logger.error(LogCategory.SYSTEM,
                `OPFS: sync-handle fallback for "${path}" (offset=${offset}, ${buf.length} bytes) failed: ${e}`);
            return false;
        }
    }

    /**
     * Commit the entry's buffered run.
     *
     * The take-and-swap happens in THIS JS turn, before any await, and a flush already
     * in flight is CHAINED onto rather than awaited-and-returned. Both matter: callers
     * (writeFileSync's pre-flush, writeFile, readFile, drainWriters) assume that once
     * this has been *called* the buffered bytes are spoken for, and then overwrite
     * memoryBuffer/bufferOffset. An early return that left the buffer in place — which
     * is exactly what the flushInFlight branch did — dropped that run silently.
     */
    private async flushWriteBuffer(entry: WriterCacheEntry): Promise<void> {
        const bufferToWrite = entry.memoryBuffer;
        const offsetToWrite = entry.bufferOffset;
        if (bufferToWrite.length > 0) {
            entry.bufferOffset = offsetToWrite + bufferToWrite.length;
            entry.memoryBuffer = new Uint8Array(0);
        }
        if (entry.flushTimer !== null) {
            clearTimeout(entry.flushTimer);
            entry.flushTimer = null;
        }

        const prior = entry.flushInFlight;
        const run = (async () => {
            if (prior) {
                try { await prior; } catch { /* the flush that owns it logs it */ }
            }
            if (bufferToWrite.length === 0) {
                if (entry.replaceExisting) {
                    await this.ensureWriter(entry);
                }
                return;
            }

            try {
                await this.ensureWriter(entry);
            } catch (e) {
                // The buffer has already been taken out of the entry, so giving up here
                // DROPS guest bytes. Try the other door before losing them, and if that
                // fails too, say so at error level — this is data loss, not a hiccup.
                Logger.warn(LogCategory.SYSTEM,
                    `OPFS: writer unavailable for "${entry.path}" (offset=${offsetToWrite}, ${bufferToWrite.length} bytes): ${e}`);
                if (await this.commitBufferViaSyncHandle(entry.path, offsetToWrite, bufferToWrite)) return;
                Logger.error(LogCategory.SYSTEM,
                    `OPFS: LOST ${bufferToWrite.length} buffered bytes at offset ${offsetToWrite} of "${entry.path}" — no writable and no sync handle`);
                throw e;
            }
            const doFlush = async () => {
                await entry.writer!.seek(offsetToWrite);
                await entry.writer!.write(asArrayBuffer(bufferToWrite.buffer));
                entry.lastUsed = performance.now();
            };
            entry.queue = entry.queue.then(doFlush, doFlush);
            await entry.queue;
        })();

        entry.flushInFlight = run;
        try {
            await run;
        } finally {
            if (entry.flushInFlight === run) {
                entry.flushInFlight = null;
            }
        }
    }

    private scheduleBufferFlush(entry: WriterCacheEntry, key: string): void {
        if (entry.flushTimer !== null) return; // Already scheduled

        entry.flushTimer = setTimeout(async () => {
            entry.flushTimer = null;
            const current = this.writerCache.get(key);
            if (current === entry) {
                await this.flushWriteBuffer(entry);
                this.scheduleWriterCleanup();
            }
        }, this.WRITE_BUFFER_FLUSH_MS) as unknown as number;
    }

    async flushFile(path: string): Promise<void> {
        const key = toKey(path);
        if (this.ephemeralFiles.has(key)) return;  // ephemeral — nothing to persist
        const cacheEntry = this.writerCache.get(key);
        if (!cacheEntry) {
            // Nothing buffered, but a previous flush may still be committing — let readers
            // that already awaited it proceed (no-op).
            return this.pendingFlushes.get(key);
        }

        // flushFile is driven by CloseHandle — the guest is done writing this handle.
        // The buffered bytes MUST be committed so the very next open()+read() observes
        // them (UE1 launcher rewrites then immediately re-reads HP.ini). OPFS forbids a
        // WritableFileStream and a FileSystemSyncAccessHandle on the same file at once, so
        // we commit through the sync-handle path (which also stays cached to serve the
        // imminent read) and only fall back to the writable when one is already open.
        const prev = this.pendingFlushes.get(key);
        const run = (async () => {
            if (prev) { try { await prev; } catch { /* ignore */ } }
            if (this.writerCache.get(key) !== cacheEntry) return; // superseded by a newer writer

            if (cacheEntry.flushTimer !== null) {
                clearTimeout(cacheEntry.flushTimer);
                cacheEntry.flushTimer = null;
            }
            if (cacheEntry.flushInFlight) {
                try {
                    await cacheEntry.flushInFlight;
                } catch (e) {
                    Logger.warn(LogCategory.SYSTEM, `OPFS: flushFile("${path}") in-flight buffer flush failed: ${e}`);
                }
            }

            const pending = cacheEntry.memoryBuffer;
            const pendingOffset = cacheEntry.bufferOffset;
            const replace = cacheEntry.replaceExisting;

            // Drop the entry up front: ensureSyncHandle() refuses while a writer entry
            // exists, and removing it lets the post-commit reader open a fresh sync handle.
            this.writerCache.delete(key);

            try {
                if (cacheEntry.writer) {
                    // A WritableFileStream was already opened for this file — finish through
                    // it (it holds the exclusive lock) and close so the file is committed.
                    if (pending.length > 0) {
                        await cacheEntry.writer.seek(pendingOffset);
                        // SAB-backed: cast at DOM boundary
                        await cacheEntry.writer.write((pending.length === pending.buffer.byteLength ? pending.buffer : new Uint8Array(pending)) as unknown as FileSystemWriteChunkType);
                    }
                    await cacheEntry.queue;
                    await cacheEntry.writer.close();
                } else if (pending.length > 0) {
                    // Lazy case (the common one): commit synchronously via a sync access
                    // handle. createSyncAccessHandle requires the file to exist, so create it.
                    // Reads are served from contentCache regardless, so a failure here only
                    // costs cross-session persistence, not in-session read-after-write.
                    const sh = await this.ensureSyncHandle(path, true);
                    if (sh) {
                        if (replace) sh.truncate(pendingOffset + pending.length);
                        sh.write(pending, { at: pendingOffset });
                        sh.flush();
                    }
                }
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `OPFS: flushFile("${path}") commit failed: ${e}`);
            }
        })();

        this.pendingFlushes.set(key, run);
        const cleanup = () => { if (this.pendingFlushes.get(key) === run) this.pendingFlushes.delete(key); };
        run.then(cleanup, cleanup);
        await run;
    }

    /**
     * Durably commit every overlay write to OPFS, then settle in-flight commits.
     * This is the teardown barrier: once it resolves, a fresh boot's loadIndex() /
     * scanDirectory() observes every file written this session.
     *
     * Crucially it CLOSES each writer — an OPFS WritableFileStream only persists its
     * changes on close(). The previous implementation merely flushed buffers into the
     * still-open streams, so nothing it "flushed" was actually durable; files created
     * late in a session were lost on relaunch and the guest had to re-create them on
     * the next run (the "create -> not found -> crash, relaunch, repeat" symptom).
     */
    async flushAll(): Promise<void> {
        // Settle in-flight CloseHandle commits FIRST: flushFile holds a sync access
        // handle, and OPFS refuses a WritableFileStream on a file one is open on — so
        // draining first makes the drain fail on exactly the files a commit just touched.
        await this.settlePendingFlushes();
        await this.drainWriters();
        // ...and again for anything the drain kicked off.
        await this.settlePendingFlushes();
        // Persist CoW tombstones so a relaunch re-opens the truncated state, not stale ROM.
        await this.saveShadowIndex();
    }

    private async settlePendingFlushes(): Promise<void> {
        for (const p of Array.from(this.pendingFlushes.values())) {
            try { await p; } catch { /* commit error already logged in flushFile */ }
        }
    }

    /** Flush each cached writer's buffer and CLOSE it so its bytes commit to OPFS. */
    private async drainWriters(): Promise<void> {
        if (this.writerCleanupTimer !== null) {
            clearTimeout(this.writerCleanupTimer);
            this.writerCleanupTimer = null;
        }
        const entries = Array.from(this.writerCache.entries());
        this.writerCache.clear();
        for (const [key, entry] of entries) {
            try {
                if (entry.flushTimer !== null) {
                    clearTimeout(entry.flushTimer);
                    entry.flushTimer = null;
                }
                await this.flushWriteBuffer(entry);   // opens a writer for lazy/replace entries
                await entry.queue;
                await entry.writer?.close();
            } catch (e) {
                // Loud: the teardown barrier failing means the guest's last writes to
                // this file did not reach OPFS (see flushWriteBuffer's fallback).
                Logger.error(LogCategory.SYSTEM, `OPFS: drainWriters FAILED for "${key}" — writes may be lost: ${e}`);
            }
        }
    }

    /** Wait out an in-flight commit for one path (the read path does the same at
     *  `pendingFlushes.get(key)`). A caller that is about to remove the file must not race the
     *  commit that is still writing it. */
    async settlePendingFlush(path: string): Promise<void> {
        const inFlight = this.pendingFlushes.get(toKey(path));
        if (inFlight) { try { await inFlight; } catch { /* commit error already logged */ } }
    }

    async deleteFile(path: string): Promise<boolean> {
        const ephKey = toKey(path);
        if (this.ephemeralFiles.has(ephKey)) {
            this.ephemeralFiles.delete(ephKey);
            this.entries.delete(ephKey);
            this.clearShadowed(ephKey);
            return true;
        }
        this.closeSyncHandle(path);
        const key = toKey(path);
        this.contentCache.delete(key);
        this.pendingFlushes.delete(key);
        this.clearShadowed(key);
        const existing = this.entries.get(key);
        if (!existing || existing.kind !== "file") {
            return false;
        }

        const cacheEntry = this.writerCache.get(key);
        if (cacheEntry) {
            this.writerCache.delete(key);
            if (cacheEntry.flushTimer !== null) {
                clearTimeout(cacheEntry.flushTimer);
                cacheEntry.flushTimer = null;
            }

            await this.flushWriteBuffer(cacheEntry);
            await cacheEntry.queue;
            try {
                await cacheEntry.writer?.close();
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `OPFS: Error closing writer before delete for key "${key}": ${e}`);
            }
        }

        try {
            const { dirHandle, name } = await this.getDirectoryHandle(path, false);
            await dirHandle.removeEntry(name);
            this.entries.delete(key);
            return true;
        } catch (e: any) {
            if (e?.name === "NotFoundError") {
                // The index HAD the entry (checked above) but OPFS never got it
                // persisted (created-then-deleted before any flush). Removing it
                // from the index makes it invisible — that IS a successful delete;
                // returning false here made DeleteFile/remove() fail on files the
                // guest just created (Max Payne re-saving over a fresh slot).
                this.entries.delete(key);
                return true;
            }
            throw e;
        }
    }

    /** Delete an empty overlay directory (index + OPFS). Caller is responsible
     *  for the emptiness/existence checks (VFS.removeDirectory). */
    async deleteDirectory(path: string): Promise<boolean> {
        const key = toKey(path);
        const existing = this.entries.get(key);
        if (!existing || existing.kind !== "dir") {
            return false;
        }
        try {
            const { dirHandle, name } = await this.getDirectoryHandle(path, false);
            await dirHandle.removeEntry(name);
        } catch (e: any) {
            if (e?.name !== "NotFoundError") throw e; // never persisted → index-only dir
        }
        this.entries.delete(key);
        return true;
    }

    private scheduleWriterCleanup(): void {
        if (this.writerCleanupTimer !== null) {
            clearTimeout(this.writerCleanupTimer);
        }
        this.writerCleanupTimer = setTimeout(() => {
            this.writerCleanupTimer = null;
            void this.cleanupWriters();
        }, this.writerIdleCloseMs) as unknown as number;
    }

    private async cleanupWriters(): Promise<void> {
        const now = performance.now();
        const entries = Array.from(this.writerCache.entries());
        for (const [key, entry] of entries) {
            if (now - entry.lastUsed < this.writerIdleCloseMs) continue;

            // Remove from cache before starting async close process
            this.writerCache.delete(key);

            // Flush memory buffer first
            await this.flushWriteBuffer(entry);

            await entry.queue;
            try {
                await entry.writer?.close();
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `OPFS: Error closing idle writer for key "${key}": ${e}`);
            }
        }
        if (this.writerCache.size > 0) {
            this.scheduleWriterCleanup();
        }
    }

    private async getFileHandle(path: string, create: boolean): Promise<FileSystemFileHandle> {
        Logger.verbose(LogCategory.SYSTEM, `OPFS: getFileHandle("${path}", create=${create}) starting`);
        try {
            const dirStart = performance.now();
            const { dirHandle, name } = await this.getDirectoryHandle(path, create);
            const dirTime = performance.now() - dirStart;
            Logger.verbose(LogCategory.SYSTEM, `OPFS: getFileHandle got directory handle in ${dirTime.toFixed(2)}ms, filename="${name}"`);

            const fileStart = performance.now();
            const fileHandle = await dirHandle.getFileHandle(name, { create });
            const fileTime = performance.now() - fileStart;
            Logger.verbose(LogCategory.SYSTEM, `OPFS: getFileHandle got file handle in ${fileTime.toFixed(2)}ms`);
            return fileHandle;
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `OPFS: getFileHandle("${path}", create=${create}) failed: ${e}`);
            throw e;
        }
    }

    private async getDirectoryHandle(path: string, create: boolean): Promise<{ dirHandle: FileSystemDirectoryHandle; name: string }> {
        Logger.verbose(LogCategory.SYSTEM, `OPFS: getDirectoryHandle("${path}", create=${create}) starting`);
        if (!this.root) {
            Logger.error(LogCategory.SYSTEM, `OPFS: getDirectoryHandle("${path}") failed: OPFS not initialized`);
            throw new Error("OPFS not initialized");
        }
        const segments = toOpfsSegments(path);
        if (segments.length === 0) {
            Logger.error(LogCategory.SYSTEM, `OPFS: getDirectoryHandle("${path}") failed: Invalid path (empty segments)`);
            throw new Error("Invalid path");
        }
        Logger.verbose(LogCategory.SYSTEM, `OPFS: getDirectoryHandle path segments: [${segments.join(", ")}]`);

        let dir = this.root;
        for (let i = 0; i < segments.length - 1; i++) {
            const segment = segments[i];
            const segmentStart = performance.now();
            try {
                dir = await dir.getDirectoryHandle(segment, { create });
                const segmentTime = performance.now() - segmentStart;
                Logger.verbose(LogCategory.SYSTEM, `OPFS: getDirectoryHandle got segment "${segment}" (${i + 1}/${segments.length - 1}) in ${segmentTime.toFixed(2)}ms`);
            } catch (e: any) {
                if (e.name === 'TypeMismatchError') {
                    // Path exists but is a file, replace it with a directory if creating
                    if (create) {
                        Logger.warn(LogCategory.SYSTEM, `OPFS: Replacing file with directory at segment "${segment}" for path "${path}"`);
                        await dir.removeEntry(segment);
                        dir = await dir.getDirectoryHandle(segment, { create: true });
                        const segmentTime = performance.now() - segmentStart;
                        Logger.verbose(LogCategory.SYSTEM, `OPFS: getDirectoryHandle replaced and got segment "${segment}" in ${segmentTime.toFixed(2)}ms`);
                    } else {
                        Logger.error(LogCategory.SYSTEM, `OPFS: getDirectoryHandle("${path}") failed at segment "${segment}": TypeMismatchError and create=false`);
                        throw e;
                    }
                } else {
                    Logger.error(LogCategory.SYSTEM, `OPFS: getDirectoryHandle("${path}") failed at segment "${segment}": ${e}`);
                    throw e;
                }
            }
        }
        const fileName = segments[segments.length - 1];
        Logger.verbose(LogCategory.SYSTEM, `OPFS: getDirectoryHandle("${path}") completed, returning directory with filename="${fileName}"`);
        return { dirHandle: dir, name: fileName };
    }

    private async scanDirectory(dir: FileSystemDirectoryHandle, prefix: string[]): Promise<void> {
        // FileSystemDirectoryHandle.entries() exists but TypeScript types may not include it
        // Use type assertion to access the async iterator
        const dirEntries = (dir as any as { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries();
        for await (const [name, handle] of dirEntries) {
            const nextPrefix = prefix.concat(name);
            const vfsPath = fromOpfsSegments(nextPrefix);
            if (handle.kind === "file") {
                const file = await (handle as FileSystemFileHandle).getFile();
                this.entries.set(toKey(vfsPath), { size: file.size, kind: "file", path: normalizePath(vfsPath) });
            } else {
                this.entries.set(toKey(vfsPath), { size: 0, kind: "dir", path: normalizePath(vfsPath) });
                await this.scanDirectory(handle as FileSystemDirectoryHandle, nextPrefix);
            }
        }
    }
}

/**
 * Sidecar (in the container dir, sibling of overlay/) that persists the CoW tombstone
 * set across sessions. Lives OUTSIDE overlay/ so it is never surfaced to the guest via C:\.
 */
const SHADOW_INDEX_FILE = "overlay-shadow.json";

/**
 * FileSystemSyncAccessHandle.read() is permitted to return fewer bytes than the buffer
 * holds without being at EOF. A single un-looped call therefore reports a short read as
 * an EOF, and every layer above turns that into a truncated file. Loop until filled or
 * the handle genuinely stops producing (mirrors SyncAccessHandleSource.readRangeSync).
 */
function readSyncAccessHandle(
    handle: { read(buffer: Uint8Array, opts: { at: number }): number },
    buffer: Uint8Array,
    at: number,
): number {
    let got = 0;
    while (got < buffer.length) {
        const n = handle.read(buffer.subarray(got), { at: at + got });
        if (n <= 0) break;
        got += n;
    }
    return got;
}

function normalizePath(path: string): string {
    const cleaned = path.replace(/\//g, "\\");
    const driveMatch = cleaned.match(/^([A-Za-z]):/);
    const drive = driveMatch ? driveMatch[1].toUpperCase() : "C";
    const rest = cleaned.replace(/^[A-Za-z]:\\?/, "");
    const parts = rest.split("\\").filter(Boolean);
    const stack: string[] = [];
    for (const part of parts) {
        if (part === ".") continue;
        if (part === "..") {
            stack.pop();
            continue;
        }
        stack.push(part);
    }
    return `${drive}:\\${stack.join("\\")}`;
}

function toKey(path: string): string {
    return normalizePath(path).toLowerCase();
}

function toOpfsSegments(path: string): string[] {
    const normalized = normalizePath(path);
    const drive = normalized[0].toUpperCase();
    const rest = normalized.slice(3);
    return [drive].concat(rest ? rest.split("\\") : []).filter(Boolean);
}

function fromOpfsSegments(segments: string[]): string {
    if (segments.length === 0) return "C:\\";
    const drive = segments[0].toUpperCase();
    const rest = segments.slice(1).join("\\");
    return normalizePath(`${drive}:\\${rest}`);
}
