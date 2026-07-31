/**
 * BottleShip dev sidecar (:3001) — the local process that does the things the browser cannot,
 * for both the app and the agent harness. Four roles:
 *
 *  - **log archive** — the durable tier behind the in-worker ring (`log-hub.ts`): WS ingest,
 *    per-game rotation, size/age pruning. One archive per harness session (the page announces
 *    its `?bs=<name>` with `log_session`), so parallel agents' guests never interleave.
 *  - **file writer** — `write_file` / `write_file_b64`, how surface and GetDIBits dumps reach
 *    `logs/debug/` (a page cannot write to the repo). The client prefixes its session dir.
 *  - **bundle delivery** — `GET /wgb?path=…` with Range, deliberately NOT via the Vite dev
 *    server (see serveWgb below).
 *  - **liveness** — `/health`, one of the three services `harness up` probes.
 *
 * `bun run dev:sidecar` (`dev:logs` is kept as an alias so existing docs and scripts still work).
 */

import { appendFile, readdir, unlink, stat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { normalizeSession, sessionLogDir } from "../../src/harness/session";

const CONFIG = {
  // BS_SIDECAR_PORT lets a SECOND dev stack (an isolated worktree, a test) run without
  // writing into the first one's logs/. Pair it with VITE_SIDECAR_PORT on the page.
  PORT: Number(process.env.BS_SIDECAR_PORT ?? 3001),
  LOG_DIR: "logs",
  MAX_SIZE: 50 * 1024 * 1024,  // 50MB per file
  MAX_FILES: 5,
  MAX_AGE_MS: 24 * 60 * 60 * 1000,
  FLUSH_INTERVAL: 1000,
  BUFFER_LIMIT: 100,
  /** Largest single `write_file`/`write_file_b64` payload (a 4K RGBA surface dump fits). */
  MAX_WRITE_BYTES: 64 * 1024 * 1024,
  /** Per-connection write budget, refilled every WRITE_WINDOW_MS. */
  MAX_WRITES_PER_WINDOW: 120,
  WRITE_WINDOW_MS: 10_000,
  /** Distinct `?bs=<name>` archives one process will open. A client picks the name. */
  MAX_SESSIONS: 32,
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
  private timer2: Timer | null = null;
  private dirReady = false;
  private flushing = false; // Prevent concurrent flushes
  private readonly dir: string;

  /** `session` scopes the archive to its own directory: parallel guests would otherwise
   *  interleave into one file, and a firehose that mixes two games is worse than none. */
  constructor(session = "") {
    this.dir = sessionLogDir(CONFIG.LOG_DIR, session);
    this.ensureDir().then(() => {
      this.dirReady = true;
      // A client can rotate (naming the file after its game) before mkdir resolves —
      // don't stomp that name with the default one.
      if (!this.currentPath) this.rotate();
      // Leading sweep: whatever the previous run left is already over budget.
      void this.cleanup();
    });
    this.timer2 = setInterval(() => this.cleanup(), 3600000);
  }

  dispose() {
    if (this.timer2) { clearInterval(this.timer2); this.timer2 = null; }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  get currentPathPublic(): string {
    return this.currentPath;
  }

  async ensureDir(): Promise<void> {
    if (!existsSync(this.dir)) {
      await mkdir(this.dir, { recursive: true });
    }
  }

  private rotate(game?: string) {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19).replace(/-(\d\d)-(\d\d)$/, "-$1$2");
    const suffix = game ? "-" + game.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40) : "";
    this.currentPath = join(this.dir, `bottleship-${stamp}${suffix}.log`);
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
      // Prune on every rotation, not only on the hourly timer: at the worker's log rate a
      // single hour fills the archive with tens of GB before a timer-only sweep ever runs.
      // Rotating bounds the dir at MAX_FILES x MAX_SIZE.
      if (this.currentSize >= CONFIG.MAX_SIZE) { this.rotate(); void this.cleanup(); }
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
      const files = (await readdir(this.dir))
        .filter(f => f.startsWith("bottleship-"))
        .map(f => join(this.dir, f));

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

/** One archive per harness session (`?bs=<name>` on the page). "" is the default
 *  single-tab session and keeps writing straight to `logs/`. Refcounted by connected
 *  sockets: the session name is client-supplied, so an unbounded map of timer-owning
 *  managers is a client-driven leak. The default session is pinned. */
const loggers = new Map<string, { mgr: LogManager; refs: number }>([
  ["", { mgr: new LogManager(), refs: 1 }],
]);

function loggerFor(session: string): LogManager {
  const hit = loggers.get(session);
  if (hit) return hit.mgr;
  if (loggers.size >= CONFIG.MAX_SESSIONS) {
    console.warn(`[WS] session cap reached (${CONFIG.MAX_SESSIONS}) — '${session}' shares the default archive`);
    return loggers.get("")!.mgr;
  }
  const mgr = new LogManager(session);
  loggers.set(session, { mgr, refs: 0 });
  return mgr;
}

function retainSession(session: string) {
  const hit = loggers.get(session);
  if (hit) hit.refs++;
}

async function releaseSession(session: string) {
  const hit = loggers.get(session);
  if (!hit || session === "") return;
  if (--hit.refs > 0) return;
  loggers.delete(session);
  await hit.mgr.flush();
  hit.mgr.dispose();
}

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
 * Who may READ a response body cross-origin, and who may open the WebSocket at all. `*` would
 * hand the first away; see wsOriginAllowed for why the second matters more.
 */
const DEV_PORTS = [5174, ...(process.env.BS_VITE_PORT ? [Number(process.env.BS_VITE_PORT)] : [])];
const DEV_ORIGINS = new Set(DEV_PORTS.flatMap((p) =>
  ["http", "https"].flatMap((s) => [`${s}://localhost:${p}`, `${s}://127.0.0.1:${p}`]),
));

/**
 * CORS only decides who may READ the body; the read off disk happens regardless, and a UNC
 * `path` would make Windows authenticate to a remote share (an NTLM handshake a `no-cors`
 * fetch from any visited page can force). So `path` is confined to an explicit root set and
 * UNC is refused outright. Roots: the repo, plus `BS_WGB_ROOTS` (`;`/`,`-separated) for a
 * drop folder living outside it.
 */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** `public/apps/external-wgb` is the repo's own pointer at the local drop folder — the tree
 *  this checkout is already configured to load bundles from, so it is a root by definition. */
function dropFolderRoot(): string[] {
  const link = join(REPO_ROOT, "public", "apps", "external-wgb");
  try { return [dirname(realpathSync(link))]; } catch { return []; }
}

const WGB_ROOTS = [
  REPO_ROOT,
  ...dropFolderRoot(),
  ...(process.env.BS_WGB_ROOTS ?? "").split(/[;,]/).map((s) => s.trim()).filter(Boolean).map((s) => resolve(s)),
];

const isUnc = (p: string) => /^(\\\\|\/\/)/.test(p.trim());

function underAnyRoot(file: string): boolean {
  return WGB_ROOTS.some((root) => file === root || file.startsWith(root.endsWith(sep) ? root : root + sep));
}

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
  if (isUnc(abs)) return new Response("UNC paths are refused", { status: 403, headers: cors });
  const file = resolve(abs);
  if (isUnc(file)) return new Response("UNC paths are refused", { status: 403, headers: cors });
  if (!file.toLowerCase().endsWith(".wgb")) {
    return new Response("only .wgb files", { status: 403, headers: cors });
  }
  if (!underAnyRoot(file)) {
    return new Response("path is outside the configured roots (set BS_WGB_ROOTS)", { status: 403, headers: cors });
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

/** Per-connection state: which session's archive this client's lines belong to
 *  (set by the `log_session` message the page sends on connect), plus the write budget. */
interface SocketData { session: string; writes: number; windowStart: number }

/**
 * A WebSocket handshake is exempt from the same-origin policy: without this check ANY page
 * the dev has open can open this socket and drive `write_file`. That writer is jailed to
 * `logs/` — which is where `tools/harness.ts` writes the `.harness.ts` journals it later
 * `await import()`s, so an unauthenticated write there is code execution on the dev box.
 * Browsers always send `Origin` on a WS handshake, so requiring it costs nothing.
 */
function wsOriginAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  return !!origin && DEV_ORIGINS.has(origin);
}

/** Refill the per-connection budget; false = over the limit for this window. */
function takeWriteToken(ws: { data: SocketData }): boolean {
  const now = Date.now();
  if (now - ws.data.windowStart >= CONFIG.WRITE_WINDOW_MS) {
    ws.data.windowStart = now;
    ws.data.writes = 0;
  }
  return ++ws.data.writes <= CONFIG.MAX_WRITES_PER_WINDOW;
}

const server = Bun.serve<SocketData>({
  port: CONFIG.PORT,
  // Loopback only. The route hands out whole files by absolute path; bound to 0.0.0.0 that
  // is a read primitive for everything on the LAN, which no CORS header can withhold.
  hostname: process.env.BS_SIDECAR_HOST ?? "127.0.0.1",
  fetch(req, server) {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (!wsOriginAllowed(req)) return new Response("forbidden origin", { status: 403 });
      if (server.upgrade(req, { data: { session: "", writes: 0, windowStart: Date.now() } })) return;
    }
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
      void releaseSession(ws.data.session);
    },
    async message(ws, msg) {
      try {
        const data = JSON.parse(String(msg));
        if (data.type === "log_session") {
          // A tab claiming its own archive file (multi-agent parallel bring-up).
          const next = normalizeSession(data.session);
          if (next !== ws.data.session) {
            await releaseSession(ws.data.session);
            ws.data.session = next;
            loggerFor(next);
            retainSession(next);
          }
          console.log(`[WS] Client session -> '${ws.data.session || "(default)"}'`);
          return;
        }
        const log = loggerFor(ws.data.session);
        if (data.type === "log_entry") {
          log.add(data.entry);
        } else if (data.type === "log_batch" && Array.isArray(data.entries)) {
          console.log(`[WS] Received batch: ${data.entries.length} entries`);
          for (const entry of data.entries) {
            log.add(entry);
          }
        } else if (data.type === "write_file" && typeof data.path === "string" && typeof data.content === "string") {
          const fullPath = resolveSafeLogPath(data.path);
          if (!fullPath) {
            ws.send(JSON.stringify({ type: "write_file_error", error: "invalid_path" }));
            return;
          }
          if (Buffer.byteLength(data.content, "utf8") > CONFIG.MAX_WRITE_BYTES) {
            ws.send(JSON.stringify({ type: "write_file_error", error: "too_large" }));
            return;
          }
          if (!takeWriteToken(ws)) {
            ws.send(JSON.stringify({ type: "write_file_error", error: "rate_limited" }));
            return;
          }
          await log.ensureDir();
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
          if (data.base64.length > CONFIG.MAX_WRITE_BYTES) {
            ws.send(JSON.stringify({ type: "write_file_error", error: "too_large" }));
            return;
          }
          if (!takeWriteToken(ws)) {
            ws.send(JSON.stringify({ type: "write_file_error", error: "rate_limited" }));
            return;
          }
          const raw = Buffer.from(data.base64, "base64");
          await log.ensureDir();
          await mkdir(dirname(fullPath), { recursive: true });
          await writeFile(fullPath, raw);
          console.log(`[FS] Wrote debug binary file: ${fullPath} (${raw.byteLength} bytes)`);
          ws.send(JSON.stringify({ type: "write_file_ok", path: fullPath }));
        } else if (data.type === "log_rotate") {
          await log.rotateForGame(typeof data.game === "string" && data.game ? data.game : undefined);
          ws.send(JSON.stringify({ type: "log_rotate_ok", path: log.currentPathPublic }));
        } else if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch {}
    }
  }
});

const shutdown = async () => {
  console.log("Shutting down...");
  await Promise.all([...loggers.values()].map((l) => l.mgr.flush()));
  server.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`Server started on ${server.hostname}:${CONFIG.PORT}`);
console.log(`  /wgb roots: ${WGB_ROOTS.join(" | ")}`);
