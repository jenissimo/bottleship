import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

const digests = new Map<string, { stamp: string; etag: Promise<string> }>();

async function stamp(path: string): Promise<string> {
    const s = await stat(path, { bigint: true });
    return `${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.ino}`;
}

/** Coalesce first probes; hash again only when the on-disk file changes. */
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
