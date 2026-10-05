/**
 * Storage transparency + management (main thread).
 *
 * Surfaces what the per-game containers actually consume so the library UI can show real numbers and
 * let the user reclaim space — the "storage manager". Covers:
 *   - total OPFS usage/quota (navigator.storage.estimate) + persistence grant (persist/persisted),
 *   - per-game container size (overlay saves + registry + meta), keyed by container dir,
 *   - the shared wgb-cache (ROM bundle copies) size,
 *   - eviction of a container (saves) or a cached bundle (ROM).
 *
 * The container layout is owned by container-store.ts (worker), imported here for one source of truth.
 */
import { BOTTLESHIP_ROOT, GAMES_DIR } from "./worker/runtime/filesystem/container-store";
import { buildZip } from "@bottleship/formats/wgb/zip-build";
import { ZipArchive, BufferSource } from "@bottleship/formats/zip";
import { asWriteChunk } from "./dom-buffer";

const WGB_CACHE_DIR = "wgb-cache";
const TEMP_DIRS = ["_imports", "_wizard", "_ingest"];

export async function temporaryImportBytes(): Promise<number> {
    const root = await opfsBottleship();
    if (!root) return 0;
    let bytes = 0;
    for (const name of TEMP_DIRS) {
        try { bytes += await dirSize(await root.getDirectoryHandle(name)); }
        catch (err) { if ((err as DOMException).name !== "NotFoundError") throw err; }
    }
    return bytes;
}

/** Reclaim abandoned import/export workspaces; saves and library bundles are separate. */
export async function clearTemporaryImports(): Promise<void> {
    const root = await opfsBottleship();
    if (!root) return;
    for (const name of TEMP_DIRS) {
        try { await root.removeEntry(name, { recursive: true }); }
        catch (err) { if ((err as DOMException).name !== "NotFoundError") throw err; }
    }
}

/** Container-root files that belong to the persistent (exportable) layer, besides overlay/**. */
const ROOT_PERSIST_FILES = ["registry.json", "meta.json"];

export interface StorageEstimate {
    usageBytes: number;
    quotaBytes: number;
    persisted: boolean;
}

export interface GameStorageInfo {
    /** Container dir name (encoded gameId). */
    containerDir: string;
    overlayBytes: number;
    registryBytes: number;
    totalBytes: number;
}

export interface CachedBundleInfo {
    key: string;
    bytes: number;
}

async function opfsBottleship(create = false): Promise<FileSystemDirectoryHandle | null> {
    try {
        const root = await navigator.storage.getDirectory();
        return await root.getDirectoryHandle(BOTTLESHIP_ROOT, { create });
    } catch { return null; }
}

async function dirSize(dir: FileSystemDirectoryHandle): Promise<number> {
    let total = 0;
    for await (const [, handle] of (dir as any).entries()) {
        if (handle.kind === "file") {
            try { total += (await (handle as FileSystemFileHandle).getFile()).size; } catch { /* locked */ }
        } else {
            total += await dirSize(handle as FileSystemDirectoryHandle);
        }
    }
    return total;
}

/** Total OPFS usage/quota + whether storage is persisted (exempt from eviction). */
export async function getStorageEstimate(): Promise<StorageEstimate> {
    const est = (await navigator.storage?.estimate?.()) ?? {};
    let persisted = false;
    try { persisted = (await navigator.storage?.persisted?.()) ?? false; } catch { /* unsupported */ }
    return { usageBytes: est.usage ?? 0, quotaBytes: est.quota ?? 0, persisted };
}

/** Ask the browser to make storage persistent (exempt from automatic eviction). Needs a gesture. */
export async function requestPersistentStorage(): Promise<boolean> {
    try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
}

let persistAutoRequested = false;

/**
 * One-shot, fire-and-forget persistent-storage request, called from the game-load entry
 * points (click/drop → gesture context, which Firefox's permission prompt wants; Chrome
 * decides by engagement heuristics). Saves live in OPFS next to multi-GB bundle caches;
 * best-effort mode evicts the ORIGIN wholesale under disk pressure — saves included —
 * so the moment the user commits data to us is the moment to ask for the exemption.
 */
export function ensurePersistentStorageRequested(): void {
    if (persistAutoRequested) return;
    persistAutoRequested = true;
    void (async () => {
        try {
            if (await navigator.storage?.persisted?.()) return;
            const granted = await navigator.storage?.persist?.();
            console.log(`BottleShip: persistent storage ${granted ? "granted" : "not granted (best-effort eviction stays possible)"}`);
        } catch { /* unsupported */ }
    })();
}

/** Per-game container sizes (saves + registry), sorted largest first. */
export async function listGameStorage(): Promise<GameStorageInfo[]> {
    const bs = await opfsBottleship(false);
    if (!bs) return [];
    let games: FileSystemDirectoryHandle;
    try { games = await bs.getDirectoryHandle(GAMES_DIR); } catch { return []; }

    const out: GameStorageInfo[] = [];
    for await (const [name, handle] of (games as any).entries()) {
        if (handle.kind !== "directory") continue;
        const container = handle as FileSystemDirectoryHandle;
        let overlayBytes = 0;
        let registryBytes = 0;
        try { overlayBytes = await dirSize(await container.getDirectoryHandle("overlay")); } catch { /* none */ }
        for (const f of ["registry.json", "meta.json"]) {
            try { registryBytes += (await (await container.getFileHandle(f)).getFile()).size; } catch { /* none */ }
        }
        out.push({ containerDir: name, overlayBytes, registryBytes, totalBytes: overlayBytes + registryBytes });
    }
    return out.sort((a, b) => b.totalBytes - a.totalBytes);
}

/** Sizes of cached ROM bundles (the shared wgb-cache), sorted largest first. */
export async function listCachedBundles(): Promise<CachedBundleInfo[]> {
    const bs = await opfsBottleship(false);
    if (!bs) return [];
    let cache: FileSystemDirectoryHandle;
    try { cache = await bs.getDirectoryHandle(WGB_CACHE_DIR); } catch { return []; }
    const out: CachedBundleInfo[] = [];
    for await (const [name, handle] of (cache as any).entries()) {
        if (handle.kind !== "file" || name === "_cache-lru.json") continue;
        try { out.push({ key: name, bytes: (await (handle as FileSystemFileHandle).getFile()).size }); } catch { /* locked */ }
    }
    return out.sort((a, b) => b.bytes - a.bytes);
}

/** Delete a game's container (its saves + registry). The ROM bundle in wgb-cache is separate. */
export async function evictGameContainer(containerDir: string): Promise<void> {
    const bs = await opfsBottleship(false);
    if (!bs) return;
    try {
        const games = await bs.getDirectoryHandle(GAMES_DIR);
        await games.removeEntry(containerDir, { recursive: true });
    } catch (e: any) { if (e?.name !== "NotFoundError") throw e; }
}

/** Delete a cached ROM bundle copy from wgb-cache. */
export async function evictCachedBundle(key: string): Promise<void> {
    const bs = await opfsBottleship(false);
    if (!bs) return;
    try {
        const cache = await bs.getDirectoryHandle(WGB_CACHE_DIR);
        await cache.removeEntry(key);
    } catch (e: any) { if (e?.name !== "NotFoundError") throw e; }
}

/** Recursively collect every file under a dir into `out`, keyed by posix relpath (locked files skipped). */
async function collectDir(dir: FileSystemDirectoryHandle, prefix: string, out: Map<string, Uint8Array>): Promise<void> {
    for await (const [name, handle] of (dir as any).entries()) {
        const rel = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === "file") {
            try {
                const file = await (handle as FileSystemFileHandle).getFile();
                out.set(rel, new Uint8Array(await file.arrayBuffer()));
            } catch { /* locked by a running game — skip */ }
        } else {
            await collectDir(handle as FileSystemDirectoryHandle, rel, out);
        }
    }
}

/**
 * Export a game's persistent save layer (overlay/** + registry.json + meta.json) as a store-only ZIP.
 * Returns null if the container is empty / missing. The ROM (.wgb) is deliberately excluded — saves
 * travel, game files don't. Mirrors the worker-side save-export.ts but works against the OPFS handle
 * directly so the library page can export without a running worker.
 */
export async function exportGameContainer(containerDir: string): Promise<Uint8Array | null> {
    const bs = await opfsBottleship(false);
    if (!bs) return null;
    let container: FileSystemDirectoryHandle;
    try {
        const games = await bs.getDirectoryHandle(GAMES_DIR);
        container = await games.getDirectoryHandle(containerDir);
    } catch { return null; }

    const files = new Map<string, Uint8Array>();
    for (const name of ROOT_PERSIST_FILES) {
        try {
            const f = await (await container.getFileHandle(name)).getFile();
            files.set(name, new Uint8Array(await f.arrayBuffer()));
        } catch { /* absent — skip */ }
    }
    try { await collectDir(await container.getDirectoryHandle("overlay"), "overlay", files); } catch { /* none */ }

    if (files.size === 0) return null;
    return buildZip(files);
}

/** Write one file (posix relpath) into a container dir, creating parent dirs. */
async function writeContainerFile(container: FileSystemDirectoryHandle, rel: string, data: Uint8Array): Promise<void> {
    const parts = rel.split("/").filter(Boolean);
    let dir = container;
    for (let i = 0; i < parts.length - 1; i++) {
        dir = await dir.getDirectoryHandle(parts[i], { create: true });
    }
    const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    await w.write(asWriteChunk(data));
    await w.close();
}

/**
 * Import a previously-exported save ZIP into a container, overwriting its persistent layer.
 * Returns the number of files written.
 */
export async function importGameContainer(containerDir: string, zipBytes: Uint8Array): Promise<number> {
    const bs = await opfsBottleship(true);
    if (!bs) throw new Error("OPFS unavailable: cannot open container for import");
    const games = await bs.getDirectoryHandle(GAMES_DIR, { create: true });
    const container = await games.getDirectoryHandle(containerDir, { create: true });

    const archive = new ZipArchive(new BufferSource(zipBytes));
    await archive.init();
    let written = 0;
    for (const entry of archive.listEntries()) {
        if (entry.isDirectory) continue;
        const data = await archive.readEntry(entry);
        await writeContainerFile(container, entry.name.replace(/\\/g, "/"), data);
        written++;
    }
    return written;
}

/** Fetch a cached ROM bundle (the stored .wgb) as a File for download, or null if absent. */
export async function getCachedBundleFile(key: string): Promise<File | null> {
    const bs = await opfsBottleship(false);
    if (!bs) return null;
    try {
        const cache = await bs.getDirectoryHandle(WGB_CACHE_DIR);
        return await (await cache.getFileHandle(key)).getFile();
    } catch { return null; }
}

/** Human-readable byte size. */
export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
