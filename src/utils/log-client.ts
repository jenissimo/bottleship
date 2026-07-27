/**
 * Log Client for BottleShip
 *
 * WebSocket client that connects to the log server and forwards logs.
 * Only active in dev mode, gracefully degrades if server is unavailable.
 *
 * Features:
 * - Buffering when WebSocket is not connected (prevents log loss)
 * - Batching to reduce message frequency
 * - Automatic flush on connect
 */

import { sessionFromLocation, sessionLogPath, sessionRelPath } from "../harness/session";

type LogEntry = {
  timestamp: number;
  category: string;
  level: number;
  message: string;
};

/** The dev sidecar this page talks to. VITE_SIDECAR_PORT points a second dev stack at its
 *  own sidecar (see BS_SIDECAR_PORT) instead of the first stack's logs/. */
export const SIDECAR_PORT = Number(import.meta.env?.VITE_SIDECAR_PORT ?? 3001);

/** This tab's harness session (`?bs=<name>`), or "" for the default single-tab one. */
function pageSession(): string {
  return typeof location === "undefined" ? "" : sessionFromLocation(location.search);
}

/** Where a logs-relative artifact this tab writes actually lands on disk. Use it for the
 *  message you print, so an agent is never pointed at another tab's evidence. */
export function logArtifactPath(rel: string): string {
  return sessionLogPath(rel, pageSession());
}

const CONFIG = {
  MAX_BUFFER_SIZE: 10000,      // Max entries to buffer when disconnected
  BATCH_SIZE: 50,              // Send logs in batches of this size
  BATCH_INTERVAL: 100,         // Flush batch every N ms
  BACKPRESSURE_THRESHOLD: 5000, // Threshold for backpressure warning
} as const;

class LogClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private reconnectDelay = 1000; // Start with 1 second
  private isEnabled = false;
  private url: string;
  /** Harness session of the tab this client runs in — the archive and every debug file
   *  it writes are scoped to it, so parallel guests don't interleave into one stream. */
  private session = pageSession();

  // Buffering and batching
  private buffer: LogEntry[] = [];
  private batchTimer: number | null = null;
  
  // Backpressure callback (optional)
  private backpressureCallback: ((isHeavy: boolean) => void) | null = null;
  private backpressureState = false;

  constructor(port: number = SIDECAR_PORT) {
    this.url = `ws://localhost:${port}`;
  }

  /**
   * Enable logging to server (only in dev mode)
   */
  enable(): void {
    if (!import.meta.env.DEV) {
      return; // Only in dev mode
    }

    if (this.isEnabled) {
      return; // Already enabled
    }

    this.isEnabled = true;
    this.connect();
  }

  /**
   * Disable logging to server (flushes remaining buffer first)
   */
  disable(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    // Flush all remaining logs before disabling
    this.flushAll();
    this.isEnabled = false;
    this.disconnect();
  }

  /**
   * Flush all buffered logs immediately (used on stop streaming)
   */
  flushAll(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.buffer.length === 0) {
      if (this.buffer.length > 0) {
        console.log(`[LogClient] Cannot flush ${this.buffer.length} entries - not connected`);
      }
      return;
    }

    // Send everything at once
    const entries = this.buffer.splice(0);
    console.log(`[LogClient] Flushing ${entries.length} remaining entries`);

    try {
      this.ws.send(
        JSON.stringify({
          type: "log_batch",
          entries: entries.map((e) => ({
            timestamp: e.timestamp,
            category: e.category,
            level: e.level,
            message: e.message,
          })),
        })
      );
    } catch (error) {
      this.buffer.unshift(...entries);
      console.error("[LogClient] Failed to flush:", error);
    }
  }

  /**
   * Set callback for backpressure notifications
   */
  setBackpressureCallback(callback: ((isHeavy: boolean) => void) | null): void {
    this.backpressureCallback = callback;
  }

  /**
   * Check if backpressure threshold is exceeded
   */
  private checkBackpressure(): boolean {
    const bufferSize = this.buffer.length;
    return bufferSize > CONFIG.BACKPRESSURE_THRESHOLD;
  }

  /**
   * Notify about backpressure state change
   */
  private notifyBackpressure(isHeavy: boolean): void {
    if (this.backpressureState === isHeavy) {
      return; // No state change
    }
    this.backpressureState = isHeavy;
    if (this.backpressureCallback) {
      try {
        this.backpressureCallback(isHeavy);
      } catch (err) {
        // Silently ignore callback errors
      }
    }
  }

  /**
   * Send a log entry to the server (buffers if not connected)
   */
  sendLog(entry: LogEntry): void {
    if (!this.isEnabled) {
      return;
    }

    // Add to buffer
    this.buffer.push(entry);

    // Trim buffer if too large (keep newest entries)
    if (this.buffer.length > CONFIG.MAX_BUFFER_SIZE) {
      this.buffer = this.buffer.slice(-CONFIG.MAX_BUFFER_SIZE);
    }

    // Check backpressure
    const isHeavy = this.checkBackpressure();
    this.notifyBackpressure(isHeavy);

    // Schedule batch flush
    if (this.batchTimer === null) {
      this.batchTimer = window.setTimeout(() => {
        this.batchTimer = null;
        this.flushBuffer();
      }, CONFIG.BATCH_INTERVAL);
    }
  }

  /**
   * Flush buffered logs to server
   */
  private flushBuffer(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.buffer.length === 0) {
      return;
    }

    // Take a batch from the buffer
    const batch = this.buffer.splice(0, CONFIG.BATCH_SIZE);

    try {
      // Send as batch message
      this.ws.send(
        JSON.stringify({
          type: "log_batch",
          entries: batch.map((e) => ({
            timestamp: e.timestamp,
            category: e.category,
            level: e.level,
            message: e.message,
          })),
        })
      );
    } catch (error) {
      // Put entries back on failure
      this.buffer.unshift(...batch);
      console.debug("[LogClient] Failed to send batch:", error);
      return;
    }

    // Check backpressure after flush
    const isHeavy = this.checkBackpressure();
    this.notifyBackpressure(isHeavy);

    // Continue flushing if more entries remain
    if (this.buffer.length > 0 && this.batchTimer === null) {
      this.batchTimer = window.setTimeout(() => {
        this.batchTimer = null;
        this.flushBuffer();
      }, CONFIG.BATCH_INTERVAL);
    }
  }

  private connect(): void {
    if (!this.isEnabled) {
      return;
    }

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        console.log("[LogClient] Connected to log server");
        // Claim our own archive file BEFORE the first batch — the sidecar keeps one
        // log stream per session, and an unclaimed connection lands in the shared one.
        if (this.session) {
          try { this.ws?.send(JSON.stringify({ type: "log_session", session: this.session })); } catch { /* best-effort */ }
        }
        // Flush any buffered logs
        this.flushBuffer();
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "connected") {
            // Server confirmed connection
          } else if (data.type === "pong") {
            // Heartbeat response
          }
        } catch {
          // Ignore parse errors
        }
      };

      this.ws.onerror = (error) => {
        // Silently handle errors, will try to reconnect
        console.debug("[LogClient] WebSocket error:", error);
      };

      this.ws.onclose = () => {
        this.ws = null;
        if (this.isEnabled) {
          this.scheduleReconnect();
        }
      };
    } catch (error) {
      // Connection failed, schedule reconnect
      console.debug("[LogClient] Failed to connect:", error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.isEnabled) {
      return;
    }

    // Exponential backoff with max 30s delay, never give up
    this.reconnectAttempts++;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
  }

  private disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Ask the server to start a fresh log file for a new game session.
   * Flushes any pending logs to the OLD file first, so each game load gets
   * its own clean file (no cross-run confusion when debugging).
   */
  rotate(gameName?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.flushAll();
    try {
      this.ws.send(JSON.stringify({ type: "log_rotate", game: gameName ?? "" }));
    } catch {
      // best-effort
    }
  }

  /**
   * Write a debug file to the logs/ directory via the log server.
   * path is a relative logs path (e.g. "seh-dumps/foo.json").
   * The server sanitizes and keeps writes inside logs/.
   */
  writeDebugFile(filename: string, content: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[LogClient] writeDebugFile: not connected to log server (run bun run dev:logs)");
      return false;
    }
    try {
      this.ws.send(JSON.stringify({ type: "write_file", path: sessionRelPath(filename, this.session), content }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write a binary debug file as base64 payload.
   * path is relative to logs/ (e.g. "seh-dumps/foo.bin").
   */
  writeDebugFileBase64(filename: string, base64: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[LogClient] writeDebugFileBase64: not connected to log server (run bun run dev:logs)");
      return false;
    }
    try {
      this.ws.send(JSON.stringify({ type: "write_file_b64", path: sessionRelPath(filename, this.session), base64 }));
      return true;
    } catch {
      return false;
    }
  }
}

// Singleton instance
let logClientInstance: LogClient | null = null;

/**
 * Get or create the log client instance
 */
export function getLogClient(): LogClient {
  if (!logClientInstance) {
    logClientInstance = new LogClient();
  }
  return logClientInstance;
}

/**
 * Send a log entry to the server (if enabled and connected)
 */
export function sendLogToServer(entry: LogEntry): void {
  if (logClientInstance) {
    logClientInstance.sendLog(entry);
  }
}

/**
 * Start a fresh server-side log file for a new game session.
 */
export function rotateLogFile(gameName?: string): void {
  if (logClientInstance) logClientInstance.rotate(gameName);
}

/**
 * Flush all buffered logs immediately
 */
export function flushLogClient(): void {
  if (logClientInstance) {
    logClientInstance.flushAll();
  }
}

/**
 * Set backpressure callback for log client
 */
export function setLogClientBackpressureCallback(callback: ((isHeavy: boolean) => void) | null): void {
  if (logClientInstance) {
    logClientInstance.setBackpressureCallback(callback);
  }
}

/**
 * Write a debug file to the logs/ directory via the log server WebSocket.
 * filename: bare name, e.g. "debug-flip-2026-02-25.jsonl"
 */
export function writeDebugFile(filename: string, content: string): boolean {
  if (!logClientInstance) return false;
  return logClientInstance.writeDebugFile(filename, content);
}

/**
 * Write a binary debug file to logs/ via base64 payload.
 */
export function writeDebugFileBase64(filename: string, base64: string): boolean {
  if (!logClientInstance) return false;
  return logClientInstance.writeDebugFileBase64(filename, base64);
}
