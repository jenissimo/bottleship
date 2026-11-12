import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

/**
 * Two ETag policies for a `.wgb` served off disk with Range support.
 *
 * Both are strong validators: the I/O worker pins the first one it sees and refuses any later
 * 206 carrying a different value (packages/formats/src/zip/http-range-source.ts), so a bundle
 * rewritten mid-session fails loudly instead of mixing two archives.
 *
 * - `wgbEtag` (deploy/server.ts, the self-hosted stand): SHA-256 of the whole file. It survives
 *   a redeploy that copies the same bytes with fresh timestamps, which keeps every remote
 *   player's sparse OPFS copy valid. The price is one full read of the bundle on the first
 *   request after start — acceptable for a long-running stand.
 *
 * - `diskWgbEtag` (the dev sidecar's `/wgb?path=` and Vite's `/__wgb/?path=`): size + mtime +
 *   inode, nothing read. Those routes stream straight off the host's disk; nothing persists
 *   their bytes (wgb-cache-policy.ts shouldPersistBundleUrl), so content identity buys nothing,
 *   while hashing an 8.6 GB bundle cold took ~41 s — longer than the page's HEAD/Range probe
 *   budget (3 x 8 s each), so the first load of a big bundle failed with AbortError.
 *   Both dev routes compute the same value for the same file, so a fallback from one to the
 *   other does not look like a version change.
 */

const digests = new Map<string, { stamp: string; etag: Promise<string> }>();

async function stamp(path: string): Promise<string> {
    const s = await stat(path, { bigint: true });
    return `${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.ino}`;
}

/** Content ETag. Coalesce first probes; hash again only when the on-disk file changes. */
export async function wgbEtag(path: string): Promise<string> {
    const before = await stamp(path);
    const cached = digests.get(path);
    if (cached?.stamp === before) return cached.etag;
    const etag = (async () => {
        const hasher = createHash("sha256");
        for await (const bytes of createReadStream(path)) hasher.update(bytes);
        if (await stamp(path) !== before) throw new Error("WGB changed while hashing");
        return `"${hasher.digest("hex")}"`;
    })();
    digests.set(path, { stamp: before, etag });
    if (digests.size > 128) digests.delete(digests.keys().next().value!);
    try { return await etag; }
    catch (error) { if (digests.get(path)?.etag === etag) digests.delete(path); throw error; }
}

/**
 * Metadata ETag for the local dev disk routes: changes whenever the file is rewritten
 * (size, modification time or — for a replace-by-rename — inode), never reads the content.
 * ctime is left out on purpose: attribute-only changes do not alter the bytes.
 */
export async function diskWgbEtag(path: string): Promise<string> {
    const s = await stat(path, { bigint: true });
    return `"disk-${s.size.toString(16)}-${s.mtimeNs.toString(16)}-${s.ino.toString(16)}"`;
}
