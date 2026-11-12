/**
 * Per-game container store — the OPFS layout that gives each game its own isolated namespace.
 *
 *   bottleship/
 *     games/<containerDir>/      ← one container per gameId (see container-id.ts)
 *       overlay/                 ← writable CoW save layer (OpfsOverlay roots here)
 *       registry.json            ← persisted registry (RegistryPersistence)
 *       meta.json                ← manifest snapshot, lastPlayed, sizes (Stage 6)
 *       ephemeral/               ← scratch, wiped on launch (Stage 2)
 *     wgb-cache/                 ← ROM bundles (shared/dedup-able; NOT per-container)
 *
 * The container dir is the single unit of isolation / persistence / eviction / teardown / export.
 * All consumers (overlay, registry, future storage UI) resolve a game's storage through here so the
 * layout stays in one place.
 */
import { gameIdToContainerDir } from "@bottleship/formats/wgb/container-id";

export const BOTTLESHIP_ROOT = "bottleship";
export const GAMES_DIR = "games";
/** CoW tombstones live beside overlay/ and travel with the persistent save layer. */
export const SHADOW_INDEX_FILE = "overlay-shadow.json";

/** Open (optionally create) the `bottleship/` OPFS root. Returns null if OPFS is unavailable. */
export async function getBottleshipRoot(create: boolean): Promise<FileSystemDirectoryHandle | null> {
    try {
        const root = await navigator.storage.getDirectory();
        return await root.getDirectoryHandle(BOTTLESHIP_ROOT, { create });
    } catch (e: any) {
        if (e?.name === "NotFoundError") return null;
        return null;
    }
}

/**
 * Open (optionally create) a game's container dir `bottleship/games/<containerDir(gameId)>`.
 * Returns null if OPFS is unavailable or (when create=false) the container doesn't exist yet.
 */
export async function getContainerDir(
    gameId: string,
    create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
    try {
        const bs = await getBottleshipRoot(create);
        if (!bs) return null;
        const games = await bs.getDirectoryHandle(GAMES_DIR, { create });
        return await games.getDirectoryHandle(gameIdToContainerDir(gameId), { create });
    } catch (e: any) {
        if (e?.name === "NotFoundError") return null;
        throw e;
    }
}

/** List the container dir names present under `bottleship/games/`. */
export async function listContainerDirs(): Promise<string[]> {
    const bs = await getBottleshipRoot(false);
    if (!bs) return [];
    try {
        const games = await bs.getDirectoryHandle(GAMES_DIR);
        const out: string[] = [];
        for await (const [name, handle] of (games as any).entries()) {
            if (handle.kind === "directory") out.push(name);
        }
        return out.sort();
    } catch (e: any) {
        if (e?.name === "NotFoundError") return [];
        throw e;
    }
}

/** Remove a game's entire container (overlay + registry + meta + ephemeral). */
export async function removeContainer(gameId: string): Promise<void> {
    const bs = await getBottleshipRoot(false);
    if (!bs) return;
    try {
        const games = await bs.getDirectoryHandle(GAMES_DIR);
        await games.removeEntry(gameIdToContainerDir(gameId), { recursive: true });
    } catch (e: any) {
        if (e?.name === "NotFoundError") return;
        throw e;
    }
}
