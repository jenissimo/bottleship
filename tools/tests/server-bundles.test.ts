import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SERVER = process.env.SERVER_UNDER_TEST ?? path.resolve(import.meta.dir, "../../deploy/server.ts");
const root = mkdtempSync(path.join(tmpdir(), "bs-server-"));
const dist = path.join(root, "dist");
const apps = path.join(root, "apps");
const outside = path.join(root, "outside.txt");

beforeAll(() => {
    mkdirSync(path.join(dist, "assets"), { recursive: true });
    mkdirSync(apps, { recursive: true });
    writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>x</title>");
    writeFileSync(path.join(dist, "assets", "app.js"), "export {}");
    writeFileSync(path.join(dist, "core.wasm"), new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    writeFileSync(path.join(dist, "manifest.webmanifest"), "{}");
    writeFileSync(path.join(apps, "ok.wgb"), new Uint8Array(4096).fill(7));
    writeFileSync(path.join(apps, "page.html"), "<script>alert(1)</script>");
    writeFileSync(path.join(apps, "notes.txt"), "not a bundle");
    writeFileSync(outside, "secret");
    symlinkSync(outside, path.join(apps, "escape.wgb"));
    symlinkSync(path.join(apps, "ok.wgb"), path.join(apps, "alias.wgb"));
    symlinkSync(path.join(apps, "page.html"), path.join(apps, "htmllink.wgb"));
    mkdirSync(path.join(apps, "dir.wgb"));
});

/** Raw request line, so the client cannot normalise the path before it is sent. */
async function rawStatus(base: string, rawPath: string): Promise<number> {
    const url = new URL(base);
    return await new Promise<number>((resolve, reject) => {
        let buf = "";
        void Bun.connect({
            hostname: url.hostname, port: Number(url.port),
            socket: {
                open(sock) { sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`); },
                data(_s, d) { buf += d.toString(); },
                close() { resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(buf)?.[1] ?? 0)); },
                error(_s, e) { reject(e); },
            },
        });
    });
}

interface Running { base: string; stop(): Promise<void> }
const running: Running[] = [];
let nextPort = 20000 + Math.floor(Math.random() * 20000);

async function start(env: Record<string, string> = {}): Promise<Running> {
    const port = nextPort++;
    const proc = Bun.spawn(["bun", SERVER], {
        env: { ...process.env, PORT: String(port), BS_DIST_DIR: dist, BS_APPS_DIR: apps, ...env },
        stdout: "ignore", stderr: "ignore",
    });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
        try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ }
        await Bun.sleep(50);
    }
    const r = { base, stop: async () => { proc.kill(); await proc.exited; } };
    running.push(r);
    return r;
}
afterAll(async () => { for (const r of running) await r.stop(); });

describe("/apps", () => {
    test("serves a bundle, inert if opened as a page, with Range", async () => {
        const { base } = await start();
        const r = await fetch(base + "/apps/ok.wgb");
        expect(r.status).toBe(200);
        expect((await r.arrayBuffer()).byteLength).toBe(4096);
        expect(r.headers.get("content-disposition")).toBe("attachment");
        expect(r.headers.get("content-security-policy")).toBe("sandbox");
        const part = await fetch(base + "/apps/ok.wgb", { headers: { Range: "bytes=10-19" } });
        expect(part.status).toBe(206);
        expect((await part.arrayBuffer()).byteLength).toBe(10);
        expect(part.headers.get("x-content-type-options")).toBe("nosniff");
    });
    test("only .wgb files: planted HTML and other types are not served", async () => {
        const { base } = await start();
        expect((await fetch(base + "/apps/page.html")).status).toBe(404);
        expect((await fetch(base + "/apps/notes.txt")).status).toBe(404);
    });
    test("a symlink out of the folder is not followed; one inside is", async () => {
        const { base } = await start();
        const esc = await fetch(base + "/apps/escape.wgb");
        expect(esc.status).toBe(404);
        expect(await esc.text()).not.toContain("secret");
        expect((await fetch(base + "/apps/alias.wgb")).status).toBe(200);
    });
    test("a directory named *.wgb is not a bundle, and traversal is refused", async () => {
        const { base } = await start();
        expect((await fetch(base + "/apps/dir.wgb")).status).toBe(404);
        for (const p of ["/apps/../outside.txt", "/apps/%2e%2e/outside.txt", "/apps/..%2foutside.txt", "/apps/%2e%2e%2foutside.txt"]) {
            const status = await rawStatus(base, p);
            expect(status).toBeGreaterThanOrEqual(400);
        }
    });
    test("an encoded /apps prefix gets the same treatment as the plain one", async () => {
        const { base } = await start();
        const r = await fetch(base + "/%61pps/ok.wgb");
        expect(r.status).toBe(200);
        expect(r.headers.get("content-security-policy")).toBe("sandbox");
        expect(r.headers.get("content-disposition")).toBe("attachment");
    });
    test("a link named .wgb that points at another file type is not served, however it is requested", async () => {
        const { base } = await start();
        for (const p of ["/apps/htmllink.wgb", "/%61pps/htmllink.wgb"]) {
            const r = await fetch(base + p);
            expect(r.status).toBe(404);
            expect(await r.text()).not.toContain("<script>");
        }
    });
    test("bundles are always application/octet-stream", async () => {
        const { base } = await start();
        expect((await fetch(base + "/apps/ok.wgb")).headers.get("content-type")).toBe("application/octet-stream");
    });
    test("a missing apps folder stops the server with a clear message instead of a stack trace", async () => {
        const proc = Bun.spawn(["bun", SERVER], { env: { ...process.env, PORT: String(nextPort++), BS_DIST_DIR: dist, BS_APPS_DIR: path.join(root, "nope") }, stdout: "ignore", stderr: "pipe" });
        expect(await proc.exited).toBe(1);
        expect(await new Response(proc.stderr).text()).toContain("does not exist or cannot be read");
    });
});
