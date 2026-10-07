import { afterEach, describe, expect, test } from "bun:test";
import { BundleVersionError, HttpRangeSource } from "@bottleship/formats/zip";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });
const content = Uint8Array.from({ length: 64 }, (_, i) => i);
function serve(handler: (request: Request) => Response | Promise<Response>): string {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
    servers.push(server);
    return `http://127.0.0.1:${server.port}/bundle.wgb`;
}
function head(): Response { return new Response(null, { headers: { "content-length": "64", etag: '"v1"' } }); }
function range(request: Request): Response {
    const [, s, e] = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range")!)!;
    return new Response(content.slice(Number(s), Number(e) + 1), { status: 206,
        headers: { "content-range": `bytes ${s}-${e}/64`, etag: '"v1"' } });
}

describe("HTTP range version and retry", () => {
    test("transient failures retry internally and every attempt carries the pinned validator", async () => {
        const seen: string[] = [];
        const url = serve(request => {
            if (request.method === "HEAD") return head();
            seen.push(request.headers.get("if-range")!);
            if (seen.length < 3) return new Response(null, { status: seen.length === 1 ? 502 : 429, headers: { "retry-after": "0" } });
            return range(request);
        });
        const source = await HttpRangeSource.create(url, { retryDelayMs: 0 });
        expect(await source.readRange(5, 32)).toEqual(content.slice(5, 32));
        expect(seen).toEqual(['"v1"', '"v1"', '"v1"']);
        source.close();
    });
    test("a same-size version change returning 200 is refused without consuming the body", async () => {
        let pulls = 0, reads = 0;
        const url = serve(request => {
            if (request.method === "HEAD") return head();
            reads++;
            return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); }, pull() { pulls++; } }), { headers: { etag: '"v2"' } });
        });
        const source = await HttpRangeSource.create(url, { timeoutMs: 100 });
        await expect(source.readRange(0, 16)).rejects.toBeInstanceOf(BundleVersionError);
        expect(reads).toBe(1);
        expect(pulls).toBeLessThan(4);
        source.close();
    });
    test("a 206 with a changed ETag or wrong offsets is a permanent error", async () => {
        let wrong = true;
        const url = serve(request => request.method === "HEAD" ? head() : new Response(content.slice(0, 16), { status: 206,
            headers: { etag: wrong ? '"v2"' : '"v1"', "content-range": "bytes 16-31/64" } }));
        const source = await HttpRangeSource.create(url);
        await expect(source.readRange(0, 16)).rejects.toBeInstanceOf(BundleVersionError);
        wrong = false;
        await expect(source.readRange(0, 16)).rejects.toBeInstanceOf(BundleVersionError);
        source.close();
    });
    test("short responses retry, and a permanent 404 does not", async () => {
        let requests = 0;
        const url = serve(request => {
            if (request.method === "HEAD") return head();
            requests++;
            if (requests === 1) return new Response(content.slice(0, 4), { status: 206, headers: { etag: '"v1"', "content-range": "bytes 0-15/64" } });
            if (requests === 2) return range(request);
            return new Response(null, { status: 404 });
        });
        const source = await HttpRangeSource.create(url, { retryDelayMs: 0 });
        expect(await source.readRange(0, 16)).toEqual(content.slice(0, 16));
        await expect(source.readRange(32, 48)).rejects.toThrow("404");
        expect(requests).toBe(3);
        source.close();
    });
    test("a stalled body is aborted, releasing the next retry", async () => {
        let requests = 0;
        const url = serve(request => {
            if (request.method === "HEAD") return head();
            requests++;
            if (requests === 1) return new Response(new ReadableStream({ start(controller) { controller.enqueue(content.slice(0, 4)); } }),
                { status: 206, headers: { etag: '"v1"', "content-range": "bytes 0-15/64" } });
            return range(request);
        });
        const source = await HttpRangeSource.create(url, { timeoutMs: 50, retryDelayMs: 0 });
        expect(await source.readRange(0, 16)).toEqual(content.slice(0, 16));
        expect(requests).toBe(2);
        source.close();
    });
});
