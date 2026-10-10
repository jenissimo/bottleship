/** Public deployment contract check; WGB_URL must name an existing bundle. */
import { createHash } from "node:crypto";
const url = process.env.WGB_URL;
if (!url) throw new Error("WGB_URL is required");
const records: unknown[] = [];
const request = async (init: RequestInit) => fetch(url, { ...init, cache: "no-cache", signal: AbortSignal.timeout(15_000) });
const head = await request({ method: "HEAD" });
const size = Number(head.headers.get("content-length")), etag = head.headers.get("etag");
if (head.status !== 200 || !etag || etag.startsWith("W/") || !(size > 0)) throw new Error(`Invalid HEAD: ${head.status}, size=${size}, etag=${etag}`);
records.push({ method: "HEAD", status: head.status, size, etag, cacheControl: head.headers.get("cache-control") });
const length = Math.min(size, 1024 * 1024);
let sha256 = "", cacheHit = false;
for (let i = 0; i < 8; i++) {
    const response = await request({ headers: { Range: `bytes=0-${length - 1}`, "If-Range": etag } });
    if (response.status !== 206 || response.headers.get("etag") !== etag || response.headers.get("content-range") !== `bytes 0-${length - 1}/${size}`) {
        await response.body?.cancel();
        throw new Error(`Invalid range response: ${response.status}`);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length !== length || data[0] !== 0x50 || data[1] !== 0x4b) throw new Error("Short/non-ZIP range response");
    const hash = createHash("sha256").update(data).digest("hex");
    if (sha256 && hash !== sha256) throw new Error("Repeated range bytes changed");
    sha256 = hash;
    const cache = response.headers.get("x-wgb-cache");
    records.push({ method: "GET", status: response.status, bytes: data.length, sha256, cache });
    cacheHit ||= cache === "HIT";
    if (i >= 1 && (cacheHit || process.env.EXPECT_EDGE_CACHE !== "1")) break;
    await Bun.sleep(250);
}
if (process.env.EXPECT_EDGE_CACHE === "1" && !cacheHit) throw new Error("Repeated range never hit the deployed edge cache");
const changed = await request({ headers: { Range: "bytes=0-0", "If-Range": '"deliberately-different-version"' } });
await changed.body?.cancel();
if (changed.status !== 200 || changed.headers.get("etag") !== etag || Number(changed.headers.get("content-length")) !== size) throw new Error("If-Range mismatch did not return the full current representation");
records.push({ method: "GET", ifRange: "mismatch", status: changed.status, bodyCancelled: true });
const invalid = await request({ headers: { Range: `bytes=${size}-${size + 1}` } });
await invalid.body?.cancel();
if (invalid.status !== 416 || invalid.headers.get("content-range") !== `bytes */${size}`) throw new Error("Unsatisfiable range contract failed");
records.push({ method: "GET", range: "unsatisfiable", status: invalid.status });
const evidence = { url, records, cacheHit };
if (process.env.WGB_HTTP_EVIDENCE) await Bun.write(process.env.WGB_HTTP_EVIDENCE, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
