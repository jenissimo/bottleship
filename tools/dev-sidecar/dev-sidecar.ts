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

const server = Bun.serve({
  port: CONFIG.PORT,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response(req.url.endsWith("/health") ? "OK" : "BottleShip Log Server");
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
