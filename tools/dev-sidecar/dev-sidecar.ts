/**
 * BottleShip dev sidecar (:3001) — the local process that does the things the browser cannot,
 * for both the app and the agent harness. Four roles:
 *
 *  - **log archive** — the durable tier behind the in-worker ring (`log-hub.ts`): WS ingest,
 *    per-game rotation, size/age pruning.
 *  - **file writer** — `write_file` / `write_file_b64`, how surface and GetDIBits dumps reach
 *    `logs/debug/` (a page cannot write to the repo).
 *  - **bundle delivery** — `GET /wgb?path=…` with Range, deliberately NOT via the Vite dev
 *    server (see serveWgb below).
 *  - **liveness** — `/health`, one of the three services `harness up` probes.
 *
 * `bun run dev:sidecar` (`dev:logs` is kept as an alias so existing docs and scripts still work).
 */

import { appendFile, readdir, unlink, stat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { existsSync } from "node:fs";

const CONFIG = {
  PORT: 3001,
  LOG_DIR: "logs",
  MAX_SIZE: 50 * 1024 * 1024,  // 50MB per file (increased from 20MB)
  MAX_FILES: 5,                 // Keep only 5 files (reduced from 20)
  MAX_AGE_MS: 24 * 60 * 60 * 1000, // 24 hours (reduced from 7 days)
  FLUSH_INTERVAL: 1000,
  BUFFER_LIMIT: 100,
} as const;

const LEVELS = ["SILENT", "ERROR", "WARN", "NORMAL", "VERBOSE"];

function resolveSafeLogPath(requestedPath: string): string | null {
  const parts = requestedPath
    .split(/[\\/]+/)
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "_"))
    .filter((part) => part.length > 0 && part !== "." && part !== "..");
  if (parts.length === 0) return null;

  const root = resolve(CONFIG.LOG_DIR);
  const fullPath = resolve(root, ...parts);
  if (fullPath !== root && !fullPath.startsWith(root + sep)) {
    return null;
  }
  return fullPath;
}

class LogManager {
  private buffer: string[] = [];
  private currentPath = "";
  private currentSize = 0;
  private timer: Timer | null = null;
  private dirReady = false;
  private flushing = false; // Prevent concurrent flushes

  constructor() {
    this.ensureDir().then(() => {
      this.dirReady = true;
      this.rotate();
    });
    setInterval(() => this.cleanup(), 3600000);
  }

  get currentPathPublic(): string {
    return this.currentPath;
  }

  async ensureDir(): Promise<void> {
    if (!existsSync(CONFIG.LOG_DIR)) {
      await mkdir(CONFIG.LOG_DIR, { recursive: true });
    }
  }

  private rotate(game?: string) {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19).replace(/-(\d\d)-(\d\d)$/, "-$1$2");
    const suffix = game ? "-" + game.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40) : "";
    this.currentPath = join(CONFIG.LOG_DIR, `bottleship-${stamp}${suffix}.log`);
    this.currentSize = 0;
  }

  /** Start a fresh file for a new game session (flushes pending lines to the old file first). */
  async rotateForGame(game?: string) {
    await this.flush();
    this.rotate(game);
    console.log(`[FS] New game session -> ${this.currentPath}`);
  }

  add(entry: any) {
    const { timestamp = Date.now(), category = "ANY", level = 2, message = "" } = entry;
    const line = `[${(timestamp / 1000).toFixed(3)}s] [${LEVELS[level] || level}] [${category}] ${message}\n`;

    this.buffer.push(line);

    if (this.buffer.length >= CONFIG.BUFFER_LIMIT) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), CONFIG.FLUSH_INTERVAL);
    }
  }

  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.buffer.length || !this.dirReady) return;

    // Prevent concurrent flushes - this was causing duplicate writes!
    if (this.flushing) return;
    this.flushing = true;

    // Take data from buffer atomically BEFORE any async operation
    const toWrite = this.buffer.splice(0, this.buffer.length);
    const data = toWrite.join("");

    try {
      await appendFile(this.currentPath, data);
      this.currentSize += data.length;
      console.log(`[FS] Wrote ${toWrite.length} lines (${data.length} bytes), total ${this.currentSize} bytes`);
      if (this.currentSize >= CONFIG.MAX_SIZE) this.rotate();
    } catch (e) {
      console.error("[FS] Flush failed, restoring buffer:", e);
      // Restore data to beginning of buffer for retry
      this.buffer.unshift(...toWrite);
    } finally {
      this.flushing = false;
    }
  }

  async cleanup() {
    try {
      const files = (await readdir(CONFIG.LOG_DIR))
        .filter(f => f.startsWith("bottleship-"))
        .map(f => join(CONFIG.LOG_DIR, f));

      const stats = await Promise.all(files.map(async path => ({ path, s: await stat(path) })));
      const now = Date.now();

      const toDelete = stats
        .sort((a, b) => b.s.mtimeMs - a.s.mtimeMs)
        .filter((f, i) => i >= CONFIG.MAX_FILES || (now - f.s.mtimeMs) > CONFIG.MAX_AGE_MS);

      for (const f of toDelete) await unlink(f.path).catch(() => {});
    } catch (e) {
      console.error("Cleanup error", e);
    }
  }
}

const logger = new LogManager();

/**
 * `GET /wgb?path=<absolute .wgb>` — Range-capable delivery of a bundle straight off disk.
 *
 * A bundle read is the hot path of every boot: the io-worker pulls it in 8 MB ranges while the
 * guest thread is parked on `Atomics.wait` with a 30 s deadline
 * (`src/worker/runtime/filesystem/sab-io-source.ts`). Vite's middleware stack degrades that
 * route's throughput by orders of magnitude over a long-lived dev server, blowing the deadline
 * (`SabIoSource: read timed out`), so the bundle must not go through it. It lives here because
 * the sidecar is already started and probed by `harness up` — no new process, no new port.
 *
 * The page is cross-origin isolated (it needs SharedArrayBuffer), so a cross-origin fetch needs
 * `Cross-Origin-Resource-Policy` as well as CORS — and because `Range` is not a CORS-safelisted
 * request header, the browser preflights, so OPTIONS must be answered too.
 */
/**
 * The route hands out whole files by ABSOLUTE path (bundles legitimately live outside the repo,
 * e.g. a WGB drop folder), so the only thing standing between it and "any page you visit can read
 * files off this machine" is the origin. `*` would hand that away — CORS is the access control
 * here, not a formality.
 */
const DEV_ORIGINS = new Set([
  "http://localhost:5174", "https://localhost:5174",
  "http://127.0.0.1:5174", "https://127.0.0.1:5174",
]);

function wgbHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
    "Cross-Origin-Resource-Policy": "cross-origin",
    Vary: "Origin",
  };
  // No Origin at all = a same-origin or non-browser fetch (curl, the harness): nothing to grant.
  if (origin && DEV_ORIGINS.has(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

async function serveWgb(req: Request, url: URL): Promise<Response> {
  const cors = wgbHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const abs = url.searchParams.get("path");
  if (!abs) return new Response("missing ?path=<absolute .wgb path>", { status: 400, headers: cors });
  const file = resolve(abs);
  if (!file.toLowerCase().endsWith(".wgb")) {
    return new Response("only .wgb files", { status: 403, headers: cors });
  }

  const f = Bun.file(file);
  // Deliberately does not echo the resolved path — that would turn 404s into a
  // file-existence oracle for anything the caller cares to probe.
  if (!(await f.exists())) return new Response("not found", { status: 404, headers: cors });
  const size = f.size;

  const headers: Record<string, string> = {
    ...cors,
    "Accept-Ranges": "bytes",
    "Content-Type": "application/octet-stream",
  };

  const range = req.headers.get("range");
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m) {
    let start: number, end: number;
    if (m[1] === "" && m[2] !== "") { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
    else { start = parseInt(m[1], 10); end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1); }
    if (Number.isNaN(start) || start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    }
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    headers["Content-Length"] = String(end - start + 1);
    if (req.method === "HEAD") return new Response(null, { status: 206, headers });
    return new Response(f.slice(start, end + 1), { status: 206, headers });
  }

  headers["Content-Length"] = String(size);
  if (req.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(f, { status: 200, headers });
}

const server = Bun.serve({
  port: CONFIG.PORT,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    const url = new URL(req.url);
    if (url.pathname === "/wgb") return serveWgb(req, url);
    // CORS/CORP on EVERY response, not just /wgb: the page is cross-origin isolated
    // (COOP/COEP, for SharedArrayBuffer), and under COEP a cross-origin response without
    // Cross-Origin-Resource-Policy is blocked outright. Without this the /health probe the
    // loader uses to decide "is the sidecar up?" fails with "Failed to fetch" and the loader
    // silently falls back to the Vite route it is supposed to be avoiding.
    return new Response(url.pathname.endsWith("/health") ? "OK" : "BottleShip dev sidecar", {
        headers: wgbHeaders(req),
    });
  },
  websocket: {
    open(ws) {
      console.log("[WS] Client connected");
    },
    close(ws) {
      console.log("[WS] Client disconnected");
    },
    async message(ws, msg) {
      try {
        const data = JSON.parse(String(msg));
        if (data.type === "log_entry") {
          logger.add(data.entry);
        } else if (data.type === "log_batch" && Array.isArray(data.entries)) {
          console.log(`[WS] Received batch: ${data.entries.length} entries`);
          for (const entry of data.entries) {
            logger.add(entry);
          }
        } else if (data.type === "write_file" && typeof data.path === "string" && typeof data.content === "string") {
          const fullPath = resolveSafeLogPath(data.path);
          if (!fullPath) {
            ws.send(JSON.stringify({ type: "write_file_error", error: "invalid_path" }));
            return;
          }
          await logger.ensureDir();
          await mkdir(dirname(fullPath), { recursive: true });
          await writeFile(fullPath, data.content, "utf8");
          console.log(`[FS] Wrote debug file: ${fullPath} (${data.content.length} bytes)`);
          ws.send(JSON.stringify({ type: "write_file_ok", path: fullPath }));
        } else if (data.type === "write_file_b64" && typeof data.path === "string" && typeof data.base64 === "string") {
          const fullPath = resolveSafeLogPath(data.path);
          if (!fullPath) {
            ws.send(JSON.stringify({ type: "write_file_error", error: "invalid_path" }));
            return;
          }
          const raw = Buffer.from(data.base64, "base64");
          await logger.ensureDir();
          await mkdir(dirname(fullPath), { recursive: true });
          await writeFile(fullPath, raw);
          console.log(`[FS] Wrote debug binary file: ${fullPath} (${raw.byteLength} bytes)`);
          ws.send(JSON.stringify({ type: "write_file_ok", path: fullPath }));
        } else if (data.type === "log_rotate") {
          await logger.rotateForGame(typeof data.game === "string" && data.game ? data.game : undefined);
          ws.send(JSON.stringify({ type: "log_rotate_ok", path: logger.currentPathPublic }));
        } else if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch {}
    }
  }
});

const shutdown = async () => {
  console.log("Shutting down...");
  await logger.flush();
  server.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`Server started on :${CONFIG.PORT}`);
