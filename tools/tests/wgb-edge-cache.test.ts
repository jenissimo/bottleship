import { afterEach, describe, expect, test } from "bun:test";
import { onRequest } from "../../functions/apps/[[path]]";

const original = globalThis.caches;
afterEach(() => { Object.defineProperty(globalThis, "caches", { value: original, writable: true, configurable: true }); });

function fixture() {
    let etag = '"v1"';
    let gets = 0;
    const data = Uint8Array.from({ length: 64 }, (_, i) => i);
    const entries = new Map<string, Response>();
    const statuses: number[] = [];
    const pending: Promise<unknown>[] = [];
    Object.defineProperty(globalThis, "caches", { value: { default: {
        match: async (request: Request) => entries.get(request.url)?.clone(),
        put: async (request: Request, response: Response) => {
            statuses.push(response.status);
            if (response.status !== 200) throw new Error("Cache API rejects 206");
            entries.set(request.url, new Response(await response.arrayBuffer(), response));
        },
    } }, writable: true, configurable: true });
    const bucket = {
        head: async () => ({ size: data.length, httpEtag: etag, writeHttpMetadata() {} }),
        get: async (_key: string, options?: { range?: { offset: number; length: number } }) => {
            gets++;
            const offset = options?.range?.offset ?? 0, length = options?.range?.length ?? data.length;
            return { size: data.length, httpEtag: etag, body: new Response(data.slice(offset, offset + length)).body, writeHttpMetadata() {} };
        },
    };
    return {
        gets: () => gets, statuses, data, update: () => { etag = '"v2"'; },
        call: async (headers: HeadersInit = {}, method = "GET", key = "bundle.wgb") => {
            const response = await (onRequest as Function)({ params: { path: [key] }, env: { APPS: bucket },
                request: new Request(`https://example.test/apps/${key}`, { method, headers }), waitUntil: (p: Promise<unknown>) => pending.push(p) }) as Response;
            await Promise.all(pending.splice(0));
            return response;
        },
    };
}

describe("versioned edge chunks", () => {
    test("HEAD pins ETag; a repeated range is served from a 200 cache entry as 206", async () => {
        const f = fixture();
        const metadata = await f.call({}, "HEAD");
        expect(metadata.headers.get("etag")).toBe('"v1"');
        expect(metadata.headers.get("cache-control")).toContain("must-revalidate");
        for (let i = 0; i < 2; i++) {
            const response = await f.call({ Range: "bytes=0-15", "If-Range": '"v1"' });
            expect(response.status).toBe(206);
            expect(response.headers.get("content-range")).toBe("bytes 0-15/64");
            expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.data.slice(0, 16));
        }
        expect(f.gets()).toBe(1);
        expect(f.statuses).toEqual([200]);
    });
    test("same-size updates cannot hit old chunks and If-Range mismatch returns the full new version", async () => {
        const f = fixture();
        await f.call({ Range: "bytes=0-15" });
        f.update();
        const response = await f.call({ Range: "bytes=0-15", "If-Range": '"v1"' });
        expect(response.status).toBe(200);
        expect(response.headers.get("etag")).toBe('"v2"');
        expect((await response.arrayBuffer()).byteLength).toBe(64);
        const current = await f.call({ Range: "bytes=0-15", "If-Range": '"v2"' });
        expect(current.status).toBe(206);
        expect(f.gets()).toBe(3);
    });
    test("hash URLs are immutable and unsatisfiable ranges fail before R2 GET", async () => {
        const f = fixture();
        const response = await f.call({}, "HEAD", `bundle.${"a".repeat(64)}.wgb`);
        expect(response.headers.get("cache-control")).toContain("immutable");
        expect((await f.call({ Range: "bytes=100-110" })).status).toBe(416);
        expect((await f.call({ Range: "bytes=-0" })).status).toBe(416);
        expect(f.gets()).toBe(0);
    });
});
