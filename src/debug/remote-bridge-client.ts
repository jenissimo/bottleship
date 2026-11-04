/**
 * Page side of tools/remote-bridge.ts — lets the harness CLI drive a browser that has no
 * Chrome DevTools Protocol (iPhone/iPad Safari, any WebKit) over a plain WebSocket.
 *
 * Opt-in and dev-only: it does nothing unless the dev server serves the page AND the URL
 * carries `?bridge=<token>`. The bridge checks the token; the page only forwards it.
 *
 * Imported for its side effect FIRST in main.tsx, so the console/error hooks are armed
 * before App evaluates — boot-time failures are exactly what this is for. Lines produced
 * while the socket is down are queued (bounded) and flushed on (re)connect.
 */

type Outgoing =
    | { t: "hello"; href: string; title: string; ua: string; isolated: boolean; at: number }
    | { t: "result"; id: number; ok: true; type: string; value: unknown }
    | { t: "result"; id: number; ok: false; text: string; description: string }
    | { t: "log"; level: string; ts: number; text: string }
    | { t: "wlog"; lines: string[]; dropped: number };

type Incoming =
    | { t: "eval"; id: number; expression: string; awaitPromise: boolean }
    | { t: "reload" };

const TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_QUEUE = 2000;
const MAX_LINE = 8000;
const LEVELS = ["log", "info", "warn", "error", "debug"] as const;

function fmt(v: unknown): string {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
    try {
        return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
    } catch {
        return String(v);
    }
}

/** What CDP's returnByValue would hand back: plain JSON, BigInt as a string. */
function byValue(v: unknown): unknown {
    if (v === undefined || typeof v === "function" || typeof v === "symbol") return undefined;
    try {
        const s = JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
        return s === undefined ? undefined : JSON.parse(s);
    } catch {
        return String(v);
    }
}

/**
 * Keep the device screen on for the whole remote session: an auto-locked iPhone suspends
 * the page, drops the socket and reads exactly like a hang. The OS releases the lock
 * whenever the page is hidden, and WebKit may refuse it without a user gesture — so it is
 * re-requested on every return to the foreground and on every touch.
 */
function keepAwake(line: (level: string, text: string) => void): void {
    const wl = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ released: boolean; addEventListener(t: "release", cb: () => void): void }> } }).wakeLock;
    if (!wl) { line("warn", "[wakelock] Screen Wake Lock API unavailable — set Auto-Lock to Never"); return; }
    let held: { released: boolean } | null = null;
    let pending = false;
    const acquire = async (why: string): Promise<void> => {
        if (pending || (held && !held.released) || document.visibilityState !== "visible") return;
        pending = true;
        try {
            const lock = await wl.request("screen");
            held = lock;
            line("info", `[wakelock] held (${why})`);
            lock.addEventListener("release", () => line("info", "[wakelock] released"));
        } catch (e) {
            line("warn", `[wakelock] refused (${why}): ${fmt(e)} — tap the page once`);
        } finally {
            pending = false;
        }
    };
    void acquire("load");
    document.addEventListener("visibilitychange", () => void acquire("visible"));
    for (const ev of ["touchend", "click"]) addEventListener(ev, () => void acquire(ev), { capture: true, passive: true });
}

/**
 * Mirror the worker's log stream to the bridge. On a device the dev sidecar (:3001) is
 * unreachable, so without this the last guest/HLE lines before a WebContent kill are lost
 * with the process. Bounded: at most WLOG_PER_SEC lines/s leave the page, the rest are
 * counted as dropped — a firehose must not become the thing that kills the tab.
 */
const WLOG_PER_SEC = 300;
const WLOG_FLUSH_MS = 200;
/** Logger levels above this (debug/trace firehose) are not mirrored. */
const WLOG_MAX_LEVEL = 3;
function tapWorkerLogs(send: (m: Outgoing) => void, line: (level: string, text: string) => void): void {
    let tapped: Worker | null = null;
    let pending: string[] = [];
    let budget = WLOG_PER_SEC;
    let dropped = 0;
    const take = (e: { timestamp?: number; category?: string; level?: number; message?: string }) => {
        if ((e.level ?? 2) > WLOG_MAX_LEVEL) return;
        if (budget <= 0) { dropped++; return; }
        budget--;
        const ts = new Date(e.timestamp ?? Date.now()).toISOString().slice(11, 23);
        const msg = String(e.message ?? "");
        pending.push(`${ts} L${e.level ?? "?"} ${e.category ?? "?"} ${msg.length > 2000 ? msg.slice(0, 2000) + "…" : msg}`);
    };
    // A WebContent kill gives no warning: flush often so the last lines before it are out.
    let ticks = 0;
    setInterval(() => {
        if (++ticks * WLOG_FLUSH_MS >= 1000) { ticks = 0; budget = WLOG_PER_SEC; }
        if (pending.length || dropped) {
            send({ t: "wlog", lines: pending, dropped });
            pending = [];
            dropped = 0;
        }
        const w = (window as unknown as { worker?: Worker }).worker;
        if (!w || w === tapped) return;
        tapped = w;
        w.addEventListener("message", (ev: MessageEvent) => {
            const d = ev.data;
            if (d?.type === "log_stream_batch" && Array.isArray(d.entries)) for (const e of d.entries) take(e);
            else if (d?.type === "log_stream_entry" && d.entry) take(d.entry);
        });
        w.postMessage({ type: "log_stream_enable", enabled: true });
        line("info", "[bridge] worker log stream mirrored");
    }, WLOG_FLUSH_MS);
}

function install(token: string): void {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/__bridge/page?token=${encodeURIComponent(token)}`;
    const queue: string[] = [];
    let ws: WebSocket | null = null;
    let backoffMs = 500;

    const send = (msg: Outgoing): void => {
        let s: string;
        try { s = JSON.stringify(msg); } catch { s = JSON.stringify({ ...msg, value: String((msg as { value?: unknown }).value) }); }
        if (ws && ws.readyState === WebSocket.OPEN) { ws.send(s); return; }
        queue.push(s);
        if (queue.length > MAX_QUEUE) queue.shift();
    };

    const line = (level: string, text: string): void => {
        send({ t: "log", level, ts: Date.now(), text: text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…[+${text.length - MAX_LINE}]` : text });
    };

    for (const level of LEVELS) {
        const orig = console[level].bind(console);
        console[level] = (...args: unknown[]) => {
            orig(...args);
            try { line(level, args.map(fmt).join(" ")); } catch { /* never let logging throw */ }
        };
    }
    addEventListener("error", (e) => {
        line("error", `[window.error] ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}${e.error?.stack ? `\n${e.error.stack}` : ""}`);
    });
    addEventListener("unhandledrejection", (e) => line("error", `[unhandledrejection] ${fmt(e.reason)}`));
    addEventListener("pagehide", (e) => line("warn", `[pagehide] persisted=${e.persisted}`));
    document.addEventListener("visibilitychange", () => line("info", `[visibility] ${document.visibilityState}`));

    const evaluate = async (id: number, expression: string, awaitPromise: boolean): Promise<void> => {
        try {
            // Indirect eval: global scope, exactly like Runtime.evaluate in the page.
            let v: unknown = (0, eval)(expression);
            if (awaitPromise && v && typeof (v as PromiseLike<unknown>).then === "function") v = await v;
            send({ t: "result", id, ok: true, type: typeof v, value: byValue(v) });
        } catch (e) {
            const description = e instanceof Error ? (e.stack || `${e.name}: ${e.message}`) : String(e);
            send({ t: "result", id, ok: false, text: "Uncaught", description });
        }
    };

    const connect = (): void => {
        const sock = new WebSocket(url);
        ws = sock;
        sock.onopen = () => {
            backoffMs = 500;
            sock.send(JSON.stringify({
                t: "hello", href: location.href, title: document.title, ua: navigator.userAgent,
                isolated: !!globalThis.crossOriginIsolated, at: Date.now(),
            } satisfies Outgoing));
            for (const s of queue.splice(0)) sock.send(s);
        };
        sock.onmessage = (ev) => {
            let m: Incoming;
            try { m = JSON.parse(String(ev.data)); } catch { return; }
            if (m.t === "eval") void evaluate(m.id, m.expression, m.awaitPromise);
            else if (m.t === "reload") location.reload();
        };
        sock.onclose = () => {
            if (ws === sock) ws = null;
            setTimeout(connect, backoffMs);
            backoffMs = Math.min(backoffMs * 2, 10_000);
        };
        sock.onerror = () => { /* onclose follows and schedules the retry */ };
    };

    keepAwake(line);
    if (new URLSearchParams(location.search).get("wlog") !== "0") tapWorkerLogs(send, line);
    connect();
    (window as unknown as { __BS_BRIDGE__?: unknown }).__BS_BRIDGE__ = { url, queued: () => queue.length };
}

if (import.meta.env.DEV) {
    const token = new URLSearchParams(location.search).get("bridge");
    if (token && TOKEN_RE.test(token)) install(token);
}
