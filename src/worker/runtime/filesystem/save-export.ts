/**
 * Per-container save export / import + cloud-sync seam (Stage 5).
 *
 * A game container's PERSISTENT layer (its `overlay/` save tree + `registry.json` + `meta.json`) is
 * small and lives under one OPFS root, so backing it up is just zipping that subtree. This gives:
 *   - local Download/Restore of saves (no OAuth),
 *   - a `SyncProvider` seam so a cloud adapter (Dropbox/Drive/WebDAV — DEFERRED) only has to move the
 *     same store-only zip blob; the emulator core never learns which backend.
 *
 * The ROM (the .wgb) is deliberately NOT included — saves travel, game files don't.
 */
import { buildZip, crc32 } from "@bottleship/formats/wgb/zip-build";
import { ZipArchive, BufferSource } from "@bottleship/formats/zip";
import { getContainerDir, PERSISTENT_ROOT_FILES, SHADOW_INDEX_FILE } from "./container-store";
import { Logger, LogCategory } from "../../core/logger";
import { asWriteChunk } from "../../../dom-buffer";

/** Recursively collect every file under a directory handle into `out` keyed by posix relpath. */
async function collectDir(dir: FileSystemDirectoryHandle, prefix: string, out: Map<string, Uint8Array>): Promise<void> {
    for await (const [name, handle] of (dir as any).entries()) {
        const rel = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === "file") {
            const file = await (handle as FileSystemFileHandle).getFile();
            out.set(rel, new Uint8Array(await file.arrayBuffer()));
        } else {
            await collectDir(handle as FileSystemDirectoryHandle, rel, out);
        }
    }
}

/**
 * Export a game's persistent layer as a store-only ZIP (overlay/** + registry.json + meta.json + CoW tombstones).
 * Returns null if the container doesn't exist (nothing saved yet).
 */
export async function exportContainer(gameId: string): Promise<Uint8Array | null> {
    const container = await getContainerDir(gameId, false);
    if (!container) return null;

    const files = new Map<string, Uint8Array>();
    for (const name of PERSISTENT_ROOT_FILES) {
        try {
            const fh = await container.getFileHandle(name);
            const f = await fh.getFile();
            files.set(name, new Uint8Array(await f.arrayBuffer()));
        } catch { /* absent — skip */ }
    }
    try {
        const overlay = await container.getDirectoryHandle("overlay");
        await collectDir(overlay, "overlay", files);
    } catch { /* no overlay yet */ }

    if (files.size === 0) return null;
    Logger.log(LogCategory.SYSTEM, `save-export: "${gameId}" → ${files.size} files`);
    return buildZip(files);
}

/** Write one file (posix relpath) into the container, creating parent dirs. */
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
 * Import a previously-exported ZIP into a game's container, overwriting the persistent layer.
 * Returns the number of files written.
 */
export async function importContainer(gameId: string, zipBytes: Uint8Array): Promise<number> {
    const container = await getContainerDir(gameId, true);
    if (!container) throw new Error("OPFS unavailable: cannot open container for import");

    const archive = new ZipArchive(new BufferSource(zipBytes));
    await archive.init();
    let written = 0;
    let hasShadowIndex = false;
    for (const entry of archive.listEntries()) {
        if (entry.isDirectory) continue;
        const data = await archive.readEntry(entry);
        const rel = entry.name.replace(/\\/g, "/").split("/").filter(Boolean).join("/");
        await writeContainerFile(container, rel, data);
        if (rel === SHADOW_INDEX_FILE) hasShadowIndex = true;
        written++;
    }
    // Older exports carry no shadow index: do not retain tombstones from the previous save.
    // Remove it only after all archive entries have been restored successfully.
    if (!hasShadowIndex) {
        try { await container.removeEntry(SHADOW_INDEX_FILE); }
        catch (err) { if ((err as DOMException).name !== "NotFoundError") throw err; }
    }
    Logger.log(LogCategory.SYSTEM, `save-import: "${gameId}" ← ${written} files`);
    return written;
}

/** Quick integrity check used by sync adapters before pushing a blob. */
export function checksum(bytes: Uint8Array): number {
    return crc32(bytes);
}

/**
 * Cloud-sync seam. A concrete adapter (Dropbox/Drive/WebDAV — deferred)
 * implements pull/push over the per-container export blob from
 * exportContainer/importContainer. Conflict resolution uses the container
 * meta.json `lastModified` (left to the adapter).
 */
export interface SyncProvider {
    readonly name: string;
    /** Fetch the remote save blob for a game, or null if none exists remotely. */
    pull(gameId: string): Promise<Uint8Array | null>;
    /** Upload the local save blob for a game. */
    push(gameId: string, blob: Uint8Array): Promise<void>;
}

let activeSyncProvider: SyncProvider | null = null;
export function setSyncProvider(p: SyncProvider | null): void { activeSyncProvider = p; }
export function getSyncProvider(): SyncProvider | null { return activeSyncProvider; }

/** Push the current local save state to the active provider (no-op if none configured). */
export async function syncPush(gameId: string): Promise<boolean> {
    if (!activeSyncProvider) return false;
    const blob = await exportContainer(gameId);
    if (!blob) return false;
    await activeSyncProvider.push(gameId, blob);
    return true;
}

/** Pull remote save state into the local container (no-op if none configured / nothing remote). */
export async function syncPull(gameId: string): Promise<boolean> {
    if (!activeSyncProvider) return false;
    const blob = await activeSyncProvider.pull(gameId);
    if (!blob) return false;
    await importContainer(gameId, blob);
    return true;
}
