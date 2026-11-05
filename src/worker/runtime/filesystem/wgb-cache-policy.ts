import { WGB_CACHE_DIR } from "./wgb-cache-identity";

/**
 * Which bundle URLs are worth a copy in OPFS, and how to drop the copies that were not.
 *
 * The dev routes that deliver a `.wgb` straight off the host's disk — the sidecar's
 * `GET /wgb?path=…` and Vite's `/__wgb/?path=…` (src/utils/bundle-url.ts) — already serve
 * from a local file, so caching them buys nothing and costs a full second copy of every
 * bundle ever opened: the I/O worker persists each streamed chunk into a sparse file, the
 * post-first-frame fill pulls the rest of the archive in the background, and a complete
 * sparse file is then promoted into a whole `.wgb`. With ~60 local bundles of 0.3–6 GB and
 * a quota of ~60% of the disk, LRU eviction never triggers before the profile is huge.
 * Remote bundles (R2 / prod `/apps/…`) keep the cache: there a local copy is the point.
 */

/** Vite's disk route (vite.config.ts serveWgbFromDisk) and the dev sidecar's (tools/dev-sidecar). */
// @transient(constant route table)
const LOCAL_DISK_ROUTES = new Set(["/__wgb/", "/__wgb", "/wgb"]);

/** True for a dev URL that streams a bundle from the host's own disk (`…/wgb?path=` / `/__wgb/?path=`). */
export function isLocalDiskBundleUrl(url: string): boolean {
    let parsed: URL;
    try { parsed = new URL(url, "http://relative.invalid/"); }
    catch { return false; }
    return LOCAL_DISK_ROUTES.has(parsed.pathname) && !!parsed.searchParams.get("path");
}

/** Whether streamed chunks / full downloads of this URL may be written to the OPFS wgb-cache. */
export function shouldPersistBundleUrl(url: string): boolean {
    return !isLocalDiskBundleUrl(url);
}

const STREAM_SIDECARS = [".sparse", ".bitmap", ".part"];
const VERSION_SUFFIX = ".version.json";

/**
 * The wgb-cache entries that are copies of URL bundles: every streaming sidecar (sparse
 * chunk file, its slot bitmap, an unfinished `.part`), every `<key>.version.json`, and the
 * archive each version file describes. Everything else in the directory is left alone —
 * a bring-your-own bundle (imported installer, wizard "library" output) has no version
 * file and is NOT re-derivable, and neither saves nor overlays live in this directory.
 */
export function bundleCacheClearPlan(names: Iterable<string>): string[] {
    const all = new Set(names);
    const out = new Set<string>();
    for (const name of all) {
        if (STREAM_SIDECARS.some(suffix => name.endsWith(suffix))) out.add(name);
        else if (name.endsWith(VERSION_SUFFIX)) {
            out.add(name);
            const archive = name.slice(0, -VERSION_SUFFIX.length);
            if (all.has(archive)) out.add(archive);
        }
    }
    return [...out].sort();
}

export interface BundleCacheClearResult {
    removed: string[];
    freedBytes: number;
    /** Entries that could not be removed — usually the running game's open handle. */
    failed: string[];
}

/**
 * Delete the URL-bundle copies from `bottleship/wgb-cache/` (see bundleCacheClearPlan).
 * Main-thread or worker; files held open by a running game fail individually and are
 * reported, they do not abort the sweep.
 */
export async function clearBundleCache(directory?: FileSystemDirectoryHandle): Promise<BundleCacheClearResult> {
    const result: BundleCacheClearResult = { removed: [], freedBytes: 0, failed: [] };
    let dir = directory;
    if (!dir) {
        try {
            const root = await navigator.storage.getDirectory();
            dir = await (await root.getDirectoryHandle("bottleship")).getDirectoryHandle(WGB_CACHE_DIR);
        } catch { return result; } // nothing cached yet
    }
    const sizes = new Map<string, number>();
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        if (handle.kind !== "file") continue;
        let size = 0;
        try { size = (await (handle as FileSystemFileHandle).getFile()).size; } catch { /* locked */ }
        sizes.set(name, size);
    }
    for (const name of bundleCacheClearPlan(sizes.keys())) {
        try {
            await dir.removeEntry(name);
            result.removed.push(name);
            result.freedBytes += sizes.get(name) ?? 0;
        } catch { result.failed.push(name); }
    }
    return result;
}
