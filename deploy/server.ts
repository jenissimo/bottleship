/**
 * Production static file server.
 * - Adds COOP/COEP headers (required for SharedArrayBuffer / cross-origin isolation)
 * - Handles HTTP Range requests (required for WGB streaming / ZIP random access)
 * - SPA fallback: unknown paths → index.html
 *
 * Env (all optional — unset behaves exactly like the plain `bun run deploy/server.ts`):
 *   PORT           listen port (default 5173)
 *   BS_DIST_DIR    built frontend (default ../dist relative to this file)
 *   BS_APPS_DIR    directory of .wgb bundles served at /apps/* — the self-hosted
 *                  equivalent of the R2 binding behind functions/apps/[[path]].ts.
 *                  Kept OUT of dist so the bundles are a separate mount/upload.
 *   BS_AUTH_USER   enable HTTP Basic auth for the whole site when both are set
 *   BS_AUTH_PASS   (private stands). /healthz stays open for container probes.
 *   BS_AUTH_REALM  realm shown in the browser prompt (default "BottleShip")
 */
import path from "path";
import { createHash, timingSafeEqual } from "node:crypto";

const DIST = path.resolve(process.env.BS_DIST_DIR ?? path.join(import.meta.dir, "..", "dist"));
const APPS = process.env.BS_APPS_DIR ? path.resolve(process.env.BS_APPS_DIR) : null;
const PORT = parseInt(process.env.PORT ?? "5173");

const AUTH_USER = process.env.BS_AUTH_USER ?? "";
const AUTH_PASS = process.env.BS_AUTH_PASS ?? "";
const AUTH_REALM = process.env.BS_AUTH_REALM ?? "BottleShip";
const AUTH_ENABLED = AUTH_USER !== "" && AUTH_PASS !== "";

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".css": "text/css",
    ".wasm": "application/wasm",
    ".json": "application/json",
    ".wgb": "application/octet-stream",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
};

const COOP_COEP = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
};

/** Compare over fixed-width digests so the check leaks neither length nor prefix. */
function secretEquals(a: string, b: string): boolean {
    const digest = (s: string) => createHash("sha256").update(s).digest();
    return timingSafeEqual(digest(a), digest(b));
}

function authorized(req: Request): boolean {
    const header = req.headers.get("Authorization");
    if (!header?.startsWith("Basic ")) return false;
    let decoded: string;
    try {
        decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf-8");
    } catch {
        return false;
    }
    const sep = decoded.indexOf(":");
    if (sep < 0) return false;
    // Both halves are always compared — no early return on a wrong user.
    const userOk = secretEquals(decoded.slice(0, sep), AUTH_USER);
    const passOk = secretEquals(decoded.slice(sep + 1), AUTH_PASS);
    return userOk && passOk;
}

/**
 * Serve one on-disk file with Range support. HEAD is answered without a body:
 * the WGB range source probes the bundle size with HEAD + Content-Length before
 * its first read (packages/formats/src/zip HttpRangeSource.create).
 */
async function serveFile(filePath: string, req: Request, extraHeaders: Record<string, string> = {}): Promise<Response | null> {
    const file = Bun.file(filePath);
    const fileSize = file.size;
    if (fileSize === 0 && !(await file.exists())) return null;

    const contentType = MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    const rangeHeader = req.headers.get("Range");
    const isHead = req.method === "HEAD";

    if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
        if (!match) {
            return new Response("Invalid Range", { status: 416, headers: COOP_COEP });
        }

        const rawStart = match[1];
        const rawEnd = match[2];
        const start = rawStart ? parseInt(rawStart) : fileSize - parseInt(rawEnd);
        const end = rawEnd && rawStart ? Math.min(parseInt(rawEnd), fileSize - 1) : fileSize - 1;

        if (isNaN(start) || isNaN(end) || start > end || start >= fileSize) {
            return new Response("Range Not Satisfiable", {
                status: 416,
                headers: { "Content-Range": `bytes */${fileSize}`, ...COOP_COEP },
            });
        }

        const headers = {
            "Content-Type": contentType,
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Content-Length": String(end - start + 1),
            "Accept-Ranges": "bytes",
            ...COOP_COEP,
            ...extraHeaders,
        };
        return new Response(isHead ? null : file.slice(start, end + 1), { status: 206, headers });
    }

    const headers = {
        "Content-Type": contentType,
        "Content-Length": String(fileSize),
        "Accept-Ranges": "bytes",
        ...COOP_COEP,
        ...extraHeaders,
    };
    return new Response(isHead ? null : file, { headers });
}

Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",
    async fetch(req) {
        const url = new URL(req.url);
        let pathname = decodeURIComponent(url.pathname);

        // Container/proxy liveness probe — never behind auth.
        if (pathname === "/healthz") return new Response("OK", { headers: { "Content-Type": "text/plain" } });

        if (AUTH_ENABLED && !authorized(req)) {
            return new Response("Unauthorized", {
                status: 401,
                headers: { "WWW-Authenticate": `Basic realm="${AUTH_REALM}", charset="UTF-8"`, ...COOP_COEP },
            });
        }

        // Bundles live on their own mount, not in dist (multi-GB, uploaded separately).
        if (APPS && pathname.startsWith("/apps/")) {
            const bundlePath = path.join(APPS, pathname.slice("/apps/".length));
            if (!bundlePath.startsWith(APPS + path.sep)) {
                return new Response("Forbidden", { status: 403 });
            }
            const resp = await serveFile(bundlePath, req, { "Cross-Origin-Resource-Policy": "same-origin" });
            return resp ?? new Response("Not Found", { status: 404, headers: COOP_COEP });
        }

        // SPA fallback for extensionless paths
        if (!path.extname(pathname)) pathname = "/index.html";

        const filePath = path.join(DIST, pathname);

        // Prevent path traversal
        if (!filePath.startsWith(DIST + path.sep) && filePath !== DIST) {
            return new Response("Forbidden", { status: 403 });
        }

        const resp = await serveFile(filePath, req);
        if (resp) return resp;

        // SPA fallback only for extensionless paths — never for binary assets
        if (!path.extname(filePath)) {
            const index = await serveFile(path.join(DIST, "index.html"), req);
            if (index) return index;
        }
        return new Response("Not Found", { status: 404, headers: COOP_COEP });
    },
});

console.log(`Serving ${DIST} on http://0.0.0.0:${PORT}`);
if (APPS) console.log(`  /apps/* → ${APPS}`);
console.log(`  auth: ${AUTH_ENABLED ? `Basic (user "${AUTH_USER}")` : "disabled"}`);
