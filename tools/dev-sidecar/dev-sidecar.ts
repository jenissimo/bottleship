/**
 * BottleShip dev sidecar (:3001) — the local process that does the things the browser cannot,
 * for both the app and the agent harness. Five roles:
 *
 *  - **log archive** — the durable tier behind the in-worker ring (`log-hub.ts`): WS ingest,
 *    per-game rotation, size/age pruning. One archive per harness session (the page announces
 *    its `?bs=<name>` with `log_session`), so parallel agents' guests never interleave.
 *  - **file writer** — `write_file` / `write_file_b64`, how surface and GetDIBits dumps reach
 *    `logs/debug/` (a page cannot write to the repo). The client prefixes its session dir.
 *  - **bundle delivery** — `GET /wgb?path=…` with Range, deliberately NOT via the Vite dev
 *    server (see serveWgb below).
 *  - **host tools** — `POST /tool/run`, how a guest that compiles its shaders by spawning
 *    `fxc.exe` gets an answer on a dev box (see runHostTool). Opt-in via `BS_HOST_TOOLS`.
 *  - **liveness** — `/health`, one of the three services `harness up` probes, and `/stats`,
 *    which reports what the archive is actually doing (buffered, written, DROPPED).
 *
 * `bun run dev:sidecar` (`dev:logs` is kept as an alias so existing docs and scripts still work).
 * Load-test it with `tools/dev-sidecar/sidecar-loadtest.ts`.
 */

import { appendFile, readdir, unlink, stat, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { normalizeSession, sessionLogDir } from "../../src/harness/session";
import { isUnc, underAnyRoot, wgbRoots } from "../wgb-roots";

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
  /** Hard ceiling on log text held in memory per session, in UTF-16 code units.
   *  Reached only when the writer cannot keep up; past it the OLDEST lines are dropped
   *  and counted (see enforceCap). Unbounded is not an option: a stalled writer under
   *  the worker's firehose grows this by ~10x the ingest rate in committed bytes. */
  MAX_BUFFER_CHARS: 8 * 1024 * 1024,
  /** Drop down to this fraction of the cap, so a stalled writer does not shift() per line. */
  DRAIN_TO: 0.75,
  /** Retry backoff after a failed append, and how often a persistent failure is reported. */
  RETRY_BASE_MS: 250,
  RETRY_MAX_MS: 10_000,
  REPORT_INTERVAL_MS: 10_000,
  /** Largest single `write_file`/`write_file_b64` payload (a 4K RGBA surface dump fits). */
  MAX_WRITE_BYTES: 64 * 1024 * 1024,
  /** Per-connection write budget, refilled every WRITE_WINDOW_MS. */
  MAX_WRITES_PER_WINDOW: 120,
  WRITE_WINDOW_MS: 10_000,
  /** Distinct `?bs=<name>` archives one process will open. A client picks the name. */
  MAX_SESSIONS: 32,
} as const;

const LEVELS = ["SILENT", "ERROR", "WARN", "NORMAL", "VERBOSE"];

/** Per-flush/per-batch chatter is not a daemon's steady state: nothing reads this process's
 *  stdout, and one line per 100 archived lines is its own second firehose. BS_SIDECAR_VERBOSE=1
 *  brings it back for a hand-run sidecar. Anything ABNORMAL is reported regardless. */
const VERBOSE = process.env.BS_SIDECAR_VERBOSE === "1";
const vlog = VERBOSE ? console.log : () => {};

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

export interface ArchiveStats {
  session: string;
  path: string;
  bufferedChars: number;
  bufferedChunks: number;
  bytesWritten: number;
  droppedLines: number;
  droppedChars: number;
  writeErrors: number;
  lastError: string | null;
  /** Milliseconds since the last SUCCESSFUL append, or null if nothing has been written. */
  msSinceWrite: number | null;
}

/**
 * The durable log archive for one harness session.
 *
 * The in-memory buffer is BOUNDED (CONFIG.MAX_BUFFER_CHARS). A log archive whose writer
 * stalls — a full disk, a deleted logs/, an antivirus lock — must not convert the guest's
 * firehose into committed memory: measured, an unbounded buffer took this process from
 * 200 MB to 1.6 GB in 20 s at 8 MB/s and then killed it. Over the cap the OLDEST lines are
 * dropped, COUNTED, and announced — both on stdout and as an `[ARCHIVE GAP]` line written
 * into the archive itself, so a reader of the file can never mistake a gap for silence.
 */
class LogManager {
  /** Pending log text. Elements are single lines, or one re-joined chunk after a failed
   *  append; both are just strings to concatenate, and `bufferedChars` tracks the total. */
  private buffer: string[] = [];
  private bufferedChars = 0;
  private currentPath = "";
  private currentSize = 0;
  private bytesWritten = 0;
  private timer: Timer | null = null;
  private timer2: Timer | null = null;
  private dirReady = false;
  /** The write in flight. Callers of flush() share it, so `await flush()` is honest —
   *  shutdown used to return before the write it was waiting for had even started. */
  private inflight: Promise<void> | null = null;
  /** Pending gap, cleared once it has been stated in the archive file. */
  private droppedLines = 0;
  private droppedChars = 0;
  private droppedSince = 0;
  /** Lifetime totals — what /stats reports, so a gap stays visible after it was written out. */
  private droppedLinesTotal = 0;
  private droppedCharsTotal = 0;
  private writeErrors = 0;
  private lastError: string | null = null;
  private lastReportAt = 0;
  private lastWriteAt = 0;
  private readonly session: string;
  private readonly dir: string;

  /** `session` scopes the archive to its own directory: parallel guests would otherwise
   *  interleave into one file, and a firehose that mixes two games is worse than none. */
  constructor(session = "") {
    this.session = session;
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

  /** The scheduling invariant: while anything is buffered, either a write is in flight or a
   *  timer is armed to start one. The old code armed the timer only on the small-buffer
   *  branch, so a flush skipped because one was already running left the rest unscheduled. */
  private schedule(delayMs = CONFIG.FLUSH_INTERVAL) {
    if (this.timer || this.inflight || !this.buffer.length) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, delayMs);
  }

  add(entry: any) {
    const { timestamp = Date.now(), category = "ANY", level = 2, message = "" } = entry;
    const line = `[${(timestamp / 1000).toFixed(3)}s] [${LEVELS[level] || level}] [${category}] ${message}\n`;

    this.buffer.push(line);
    this.bufferedChars += line.length;
    this.enforceCap();

    if (this.buffer.length >= CONFIG.BUFFER_LIMIT) void this.flush();
    else this.schedule();
  }

  /**
   * Keep the buffer under the cap by dropping the OLDEST text — the newest window is the
   * one worth having when the writer comes back. Every dropped line is counted so the gap
   * can be stated exactly; nothing here loses data quietly.
   */
  private enforceCap() {
    if (this.bufferedChars <= CONFIG.MAX_BUFFER_CHARS) return;
    const target = CONFIG.MAX_BUFFER_CHARS * CONFIG.DRAIN_TO;
    if (!this.droppedSince) this.droppedSince = Date.now();
    while (this.bufferedChars > target && this.buffer.length) {
      const gone = this.buffer.shift()!;
      this.bufferedChars -= gone.length;
      this.droppedChars += gone.length;
      this.droppedCharsTotal += gone.length;
      // One chunk can hold many lines (a re-queued failed append); count them for real.
      for (let i = gone.indexOf("\n"); i >= 0; i = gone.indexOf("\n", i + 1)) {
        this.droppedLines++;
        this.droppedLinesTotal++;
      }
    }
    this.report(`buffer over ${(CONFIG.MAX_BUFFER_CHARS / 1e6).toFixed(0)}MB — dropping oldest lines`);
  }

  /** Loud, but not once per failed flush: a stalled writer under the firehose would itself
   *  become a firehose. One line per REPORT_INTERVAL_MS, carrying the running totals. */
  private report(what: string) {
    const now = Date.now();
    if (now - this.lastReportAt < CONFIG.REPORT_INTERVAL_MS) return;
    this.lastReportAt = now;
    console.error(
      `[FS] ARCHIVE DEGRADED (${this.session || "default"}): ${what}; ` +
      `buffered=${(this.bufferedChars / 1e6).toFixed(1)}MB dropped=${this.droppedLinesTotal} lines ` +
      `writeErrors=${this.writeErrors}${this.lastError ? ` last=${this.lastError}` : ""}`,
    );
  }

  /** The gap marker that goes INTO the archive, so the file states its own losses. Pending
   *  until an append actually succeeds — a gap that was never written down is not recorded. */
  private gapNotice(): string {
    if (!this.droppedLines && !this.droppedChars) return "";
    return `[ARCHIVE GAP] ${this.droppedLines} lines (${this.droppedChars} chars) dropped ` +
      `since ${new Date(this.droppedSince).toISOString()} — the archive writer could not keep up\n`;
  }

  private backoff(): number {
    return Math.min(CONFIG.RETRY_MAX_MS, CONFIG.RETRY_BASE_MS * 2 ** Math.min(this.writeErrors, 6));
  }

  /** Drain what is buffered. Concurrent callers share the write in flight. */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.inflight) return this.inflight;
    if (!this.buffer.length) return Promise.resolve();
    if (!this.dirReady) { this.schedule(); return Promise.resolve(); }
    const run = this.writeOnce();
    this.inflight = run;
    return run;
  }

  private async writeOnce(): Promise<void> {
    // Take the data out before any await: another turn's add() must not see it twice.
    const chunk = this.buffer.splice(0, this.buffer.length);
    const body = chunk.join("");
    const data = this.gapNotice() + body;
    this.bufferedChars -= body.length;
    let failed = false;

    try {
      await appendFile(this.currentPath, data);
      this.droppedLines = this.droppedChars = this.droppedSince = 0;  // the gap is now on record
      this.currentSize += data.length;
      this.bytesWritten += data.length;
      this.lastWriteAt = Date.now();
      if (this.writeErrors) {
        console.log(`[FS] archive writer recovered (${this.session || "default"}) after ${this.writeErrors} failed appends`);
        this.writeErrors = 0;
        this.lastError = null;
      }
      vlog(`[FS] Wrote ${chunk.length} chunks (${data.length} bytes), total ${this.currentSize} bytes`);
      // Prune on every rotation, not only on the hourly timer: at the worker's log rate a
      // single hour fills the archive with tens of GB before a timer-only sweep ever runs.
      // Rotating bounds the dir at MAX_FILES x MAX_SIZE.
      if (this.currentSize >= CONFIG.MAX_SIZE) { this.rotate(); void this.cleanup(); }
    } catch (e) {
      failed = true;
      this.writeErrors++;
      this.lastError = String((e as { message?: string })?.message ?? e).slice(0, 200);
      // ONE element, never a spread: `unshift(...toWrite)` is a RangeError once the backlog
      // passes the argument-count limit, and that exception killed the whole archive.
      // Re-queue the BODY only; the gap notice is regenerated when a write finally lands.
      this.buffer.unshift(body);
      this.bufferedChars += body.length;
      this.enforceCap();
      this.report(`append failed: ${this.lastError}`);
    } finally {
      // Re-arm here and only here for the post-write case: immediately if the writer is
      // healthy and more arrived meanwhile, on a backoff while it is failing.
      this.inflight = null;
      this.schedule(failed ? this.backoff() : 0);
    }
  }

  /** Best-effort drain for shutdown: retry until empty or out of time. */
  async drain(maxMs = 3000): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (this.buffer.length && Date.now() < deadline) {
      const before = this.bufferedChars;
      await this.flush();
      if (this.bufferedChars >= before) await Bun.sleep(100);  // writer is failing
    }
  }

  stats(): ArchiveStats {
    return {
      session: this.session,
      path: this.currentPath,
      bufferedChars: this.bufferedChars,
      bufferedChunks: this.buffer.length,
      bytesWritten: this.bytesWritten,
      droppedLines: this.droppedLinesTotal,
      droppedChars: this.droppedCharsTotal,
      writeErrors: this.writeErrors,
      lastError: this.lastError,
      msSinceWrite: this.lastWriteAt ? Date.now() - this.lastWriteAt : null,
    };
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
  await hit.mgr.drain(2000);
  hit.mgr.dispose();
}

/**
 * What the archive is actually doing — the instrument that makes a stalled writer visible
 * instead of merely slow. `harness up` folds it into its service report, and
 * tools/dev-sidecar/sidecar-loadtest.ts reads it to judge a run.
 */
function archiveStats() {
  return {
    rss: process.memoryUsage.rss(),
    sessions: [...loggers.values()].map((l) => l.mgr.stats()),
  };
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
 * UNC is refused outright. The root set is shared with Vite's `/__wgb/` fallback and the
 * dev browser's listing route (tools/wgb-roots.ts) — two deliverers disagreeing about
 * what is allowed is the same as no confinement.
 */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const WGB_ROOTS = wgbRoots(REPO_ROOT);

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
  if (!underAnyRoot(file, WGB_ROOTS)) {
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

/**
 * Host tools the guest may run (`POST /tool/run`) — the dev half of the shader oven.
 *
 * A 2004 engine that compiles its shaders by spawning `fxc.exe` mid-render gets an honest
 * refusal from our CreateProcess: we have no x86 console host. But the dev box IS Windows,
 * and the compiler is right there in the bundle. This route runs one of those tools on the
 * host so the guest can populate its own on-disk shader cache once; the cache then ships in
 * the bundle and no player ever needs this.
 *
 * Spawning a named executable on request is the most dangerous thing this process can do, so
 * the tool set is EMPTY unless the dev names it: `BS_HOST_TOOLS="fxc=C:/…/fxc.exe;cgc=…"`.
 * A key not in that map is refused; the request never supplies a path.
 */
const HOST_TOOLS: Map<string, string> = new Map(
  (process.env.BS_HOST_TOOLS ?? "").split(";").flatMap((pair) => {
    const eq = pair.indexOf("=");
    if (eq <= 0) return [];
    const key = pair.slice(0, eq).trim().toLowerCase();
    const exe = pair.slice(eq + 1).trim();
    return key && exe ? [[key, resolve(exe)] as [string, string]] : [];
  }),
);

const TOOL_LIMITS = {
  /** One shader source is a few KB; this bounds a runaway upload, not a real workload. */
  MAX_INPUT_BYTES: 8 * 1024 * 1024,
  MAX_OUTPUT_BYTES: 8 * 1024 * 1024,
  TIMEOUT_MS: 30_000,
} as const;

interface ToolRunRequest {
  tool: string;
  args: string[];
  /** Files the guest named on the command line, base64, keyed by the bare name the tool sees. */
  files: Array<{ name: string; base64: string }>;
}

/**
 * Run one allow-listed tool in a scratch directory seeded with the guest's input files, and
 * return everything it PRODUCED there. Returning the directory diff rather than a declared
 * output list keeps this tool-agnostic: the caller does not have to know that `/Fc` means
 * "listing" or that a compiler drops a second file next to it.
 */
async function runHostTool(req: Request): Promise<Response> {
  const cors = {
    ...wgbHeaders(req),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const origin = req.headers.get("origin");
  if (!origin || !DEV_ORIGINS.has(origin)) {
    return new Response("forbidden origin", { status: 403, headers: cors });
  }
  if (HOST_TOOLS.size === 0) {
    return Response.json({ ok: false, error: "no host tools configured (set BS_HOST_TOOLS)" },
      { status: 403, headers: cors });
  }

  let body: ToolRunRequest;
  try { body = await req.json() as ToolRunRequest; }
  catch { return Response.json({ ok: false, error: "bad json" }, { status: 400, headers: cors }); }

  const exe = HOST_TOOLS.get(String(body.tool ?? "").toLowerCase());
  if (!exe) {
    return Response.json({ ok: false, error: `tool '${body.tool}' is not allow-listed` },
      { status: 403, headers: cors });
  }
  const args = Array.isArray(body.args) ? body.args.map(String) : [];
  // Every file a tool touches must be a BARE name in the scratch dir. A leading `/` or `-`
  // is a SWITCH, not a path — `fxc /T ps_2_0 /Zpr /Fc out.cg in.cg` is the whole workload,
  // and rejecting it on the switch's own slash refuses every request this route exists for.
  // The remainder after that prefix is held to the same bare-name rule as a plain argument.
  const namesAPath = (arg: string) => {
    const bare = /^[/-]+/.test(arg) ? arg.replace(/^[/-]+/, "") : arg;
    return bare.includes("/") || bare.includes("\\") || bare.includes("..") || /[A-Za-z]:/.test(bare);
  };
  const unsafeArg = args.find(namesAPath);
  if (unsafeArg !== undefined) {
    return Response.json({ ok: false, error: `path-bearing tool argument is not allowed: '${unsafeArg}'` },
      { status: 400, headers: cors });
  }
  const files = Array.isArray(body.files) ? body.files : [];
  const total = files.reduce((n, f) => n + (f.base64?.length ?? 0), 0);
  if (total > TOOL_LIMITS.MAX_INPUT_BYTES) {
    return Response.json({ ok: false, error: "inputs too large" }, { status: 413, headers: cors });
  }

  const dir = join(resolve(CONFIG.LOG_DIR), "host-tool", `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  try {
    for (const f of files) {
      const name = String(f.name ?? "");
      // The tool runs with `dir` as its cwd, so a name with a separator would escape it.
      if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
        return Response.json({ ok: false, error: `bad input name '${name}'` }, { status: 400, headers: cors });
      }
      await writeFile(join(dir, name), Buffer.from(String(f.base64 ?? ""), "base64"));
    }
    const before = new Set(await readdir(dir));

    const proc = Bun.spawn([exe, ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), TOOL_LIMITS.TIMEOUT_MS);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    clearTimeout(timer);

    const outputs: Array<{ name: string; base64: string }> = [];
    for (const name of await readdir(dir)) {
      if (before.has(name)) continue;
      const data = await Bun.file(join(dir, name)).arrayBuffer();
      if (data.byteLength > TOOL_LIMITS.MAX_OUTPUT_BYTES) continue;
      outputs.push({ name, base64: Buffer.from(data).toString("base64") });
    }
    console.log(`[TOOL] ${body.tool} ${args.join(" ")} -> exit=${exitCode} produced=${outputs.map(o => o.name).join(",") || "-"}`);
    return Response.json({ ok: true, exitCode, stdout, stderr, outputs }, { headers: cors });
  } catch (e) {
    return Response.json({ ok: false, error: String((e as Error).message ?? e) }, { status: 500, headers: cors });
  } finally {
    // Tool inputs and outputs are transient; durable diagnostics belong in the response/log,
    // not in one scratch directory per request.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
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
    if (url.pathname === "/tool/run") return runHostTool(req);
    if (url.pathname.endsWith("/stats")) {
      return new Response(JSON.stringify(archiveStats()), {
        headers: { ...wgbHeaders(req), "Content-Type": "application/json" },
      });
    }
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
      vlog("[WS] Client connected");
    },
    close(ws) {
      vlog("[WS] Client disconnected");
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
          vlog(`[WS] Received batch: ${data.entries.length} entries`);
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
          vlog(`[FS] Wrote debug file: ${fullPath} (${data.content.length} bytes)`);
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
          vlog(`[FS] Wrote debug binary file: ${fullPath} (${raw.byteLength} bytes)`);
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
  await Promise.all([...loggers.values()].map((l) => l.mgr.drain(3000)));
  server.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// A daemon nobody watches must not die of a stray rejection: losing the archive mid-session
// costs an hour of re-running a game. Say it loudly and stay up.
process.on("unhandledRejection", (reason) => {
  console.error("[sidecar] unhandled rejection (staying up):", reason);
});

console.log(`Server started on ${server.hostname}:${CONFIG.PORT}`);
console.log(`  /wgb roots: ${WGB_ROOTS.join(" | ")}`);
