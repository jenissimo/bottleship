#!/usr/bin/env bun
/**
 * remote-bridge — drive the harness on a browser that has no Chrome DevTools Protocol
 * (iPhone/iPad Safari, any WebKit), from this machine, over a WebSocket.
 *
 *   bun tools/remote-bridge.ts [--tunnel]
 *
 * The bridge impersonates a CDP endpoint: `/json/list` lists the connected remote page as
 * a target and `Runtime.evaluate` is relayed to it. Everything the harness CLI does by
 * evaluating in the page therefore works unchanged:
 *
 *   BS_CDP_PORT=9444 BS_TAB=iphone bun tools/harness.ts eval "navigator.userAgent"
 *
 * What CDP gives Chrome and a page cannot (worker targets, Debugger.pause, trusted input,
 * compositor screenshots, tracing) is refused with a clear error, never faked.
 *
 * The page (src/debug/remote-bridge-client.ts, dev builds only) connects back through the
 * Vite dev server's `/__bridge` proxy, so one origin — the dev server — is all that has to
 * be reachable. `--tunnel` publishes it with a cloudflared quick tunnel (start Vite with
 * BS_TUNNEL=1 so it admits the tunnel's Host) and prints the URL to open on the device.
 *
 * Security: the tunnel URL is public. The page socket requires the random token, which only
 * travels in the URL you open on the device. The CDP side is loopback-only and refuses any
 * request that came in through the tunnel. The token grants eval in THAT page, not on this
 * machine — but the dev server itself (sources, /__wgb bundles within BS_WGB_ROOTS) is
 * reachable for as long as the tunnel runs. Stop it when you are done.
 *
 * Page console output, window errors and unhandled rejections are appended to
 * logs/remote/page-<time>.log — they survive the page dying, which on iOS is the point.
 */

import type { ServerWebSocket } from "bun";
import { appendFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { networkInterfaces } from "node:os";

const PORT = Number(process.env.BS_BRIDGE_PORT ?? 9444);
const DEV_PORT = Number(process.env.BS_DEV_PORT ?? 5174);
const TOKEN = process.env.BS_BRIDGE_TOKEN || randomBytes(16).toString("hex");
const SESSION = process.env.BS_TAB || "iphone";
const TUNNEL = process.argv.includes("--tunnel");
const LAN = process.argv.includes("--lan");

const LOG_DIR = `${process.cwd()}/logs/remote`;
mkdirSync(LOG_DIR, { recursive: true });
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = `${LOG_DIR}/page-${RUN_STAMP}.log`;
const WLOG_FILE = `${LOG_DIR}/worker-${RUN_STAMP}.log`;

interface WsData { kind: "page" | "cli" }
interface PageInfo { href: string; title: string; ua: string; isolated: boolean; at: number }

let page: ServerWebSocket<WsData> | null = null;
let pageInfo: PageInfo | null = null;
const inflight = new Map<number, { cli: ServerWebSocket<WsData>; cdpId: number }>();
let nextEvalId = 1;

function log(line: string, echo = true): void {
    const stamped = `${new Date().toISOString()} ${line}`;
    try { appendFileSync(LOG_FILE, stamped + "\n"); } catch { /* disk full: keep relaying */ }
    if (echo) console.log(stamped);
}

function cdpReply(cli: ServerWebSocket<WsData>, id: number, result: unknown): void {
    cli.send(JSON.stringify({ id, result }));
}

function cdpError(cli: ServerWebSocket<WsData>, id: number, message: string): void {
    cli.send(JSON.stringify({ id, error: { code: -32000, message } }));
}

function failInflight(reason: string): void {
    for (const [, { cli, cdpId }] of inflight) {
        try { cdpError(cli, cdpId, reason); } catch { /* cli gone */ }
    }
    inflight.clear();
}

function onCliMessage(cli: ServerWebSocket<WsData>, raw: string): void {
    let m: { id: number; method: string; params?: any; sessionId?: string };
    try { m = JSON.parse(raw); } catch { return; }
    if (m.sessionId) {
        cdpError(cli, m.id, `${m.method}: worker/child targets are not reachable over the remote bridge`);
        return;
    }
    switch (m.method) {
        case "Runtime.enable":
        case "Page.enable":
        case "Page.bringToFront":
            cdpReply(cli, m.id, {});
            return;
        case "Runtime.evaluate": {
            if (!page) { cdpError(cli, m.id, "no remote page connected (open the bridge URL on the device)"); return; }
            const id = nextEvalId++;
            inflight.set(id, { cli, cdpId: m.id });
            page.send(JSON.stringify({
                t: "eval", id, expression: String(m.params?.expression ?? ""),
                awaitPromise: m.params?.awaitPromise !== false,
            }));
            return;
        }
        case "Page.reload":
            if (!page) { cdpError(cli, m.id, "no remote page connected"); return; }
            page.send(JSON.stringify({ t: "reload" }));
            cdpReply(cli, m.id, {});
            return;
        default:
            cdpError(cli, m.id, `${m.method} is not available over the remote bridge (no CDP on the device)`);
    }
}

function onPageMessage(raw: string): void {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === "hello") {
        pageInfo = { href: m.href, title: m.title, ua: m.ua, isolated: !!m.isolated, at: m.at };
        log(`[bridge] page connected: ${m.href}\n    ua=${m.ua}\n    crossOriginIsolated=${m.isolated}`);
    } else if (m.t === "result") {
        const entry = inflight.get(m.id);
        if (!entry) return;
        inflight.delete(m.id);
        cdpReply(entry.cli, entry.cdpId, m.ok
            ? { result: { type: m.type, value: m.value } }
            : { exceptionDetails: { text: m.text, exception: { description: m.description } } });
    } else if (m.t === "wlog") {
        const body = (Array.isArray(m.lines) ? m.lines.join("\n") + "\n" : "")
            + (m.dropped ? `[bridge] ${m.dropped} worker lines dropped (rate cap)\n` : "");
        try { appendFileSync(WLOG_FILE, body); } catch { /* keep relaying */ }
    } else if (m.t === "log") {
        const lvl = String(m.level).toUpperCase().padEnd(5);
        const line = `[page ${new Date(m.ts).toISOString().slice(11, 23)}] ${lvl} ${m.text}`;
        log(line, m.level === "error" || m.level === "warn");
    }
}

/** A request that arrived through cloudflared carries its edge headers. The CDP side is for
 *  this machine only — the tunnel may reach nothing but the token-checked page socket. */
function viaTunnel(req: Request): boolean {
    return req.headers.has("cf-connecting-ip") || req.headers.has("cf-ray");
}

function targets(): unknown[] {
    if (!page || !pageInfo) return [];
    return [{
        id: "remote", type: "page", url: pageInfo.href, title: pageInfo.title || "remote page",
        webSocketDebuggerUrl: `ws://localhost:${PORT}/devtools/page/remote`,
    }];
}

const server = Bun.serve<WsData, undefined>({
    hostname: "localhost",
    port: PORT,
    fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/__bridge/page") {
            if (url.searchParams.get("token") !== TOKEN) return new Response("bad token", { status: 403 });
            return srv.upgrade(req, { data: { kind: "page" } }) ? undefined : new Response("upgrade required", { status: 426 });
        }
        if (viaTunnel(req)) return new Response("not found", { status: 404 });
        if (url.pathname === "/devtools/page/remote") {
            return srv.upgrade(req, { data: { kind: "cli" } }) ? undefined : new Response("upgrade required", { status: 426 });
        }
        if (url.pathname === "/json" || url.pathname === "/json/list") return Response.json(targets());
        if (url.pathname === "/json/version") return Response.json({ Browser: "BottleShip remote bridge", "Protocol-Version": "1.3" });
        if (url.pathname === "/status") return Response.json({ page: pageInfo, connected: !!page, inflight: inflight.size, log: LOG_FILE, workerLog: WLOG_FILE });
        return new Response("not found", { status: 404 });
    },
    websocket: {
        maxPayloadLength: 64 * 1024 * 1024,
        open(ws) {
            if (ws.data.kind !== "page") return;
            if (page && page !== ws) {
                log("[bridge] a new page replaced the previous connection");
                failInflight("remote page was replaced by a new connection");
                try { page.close(1000, "replaced"); } catch { /* */ }
            }
            page = ws;
        },
        message(ws, msg) {
            const raw = typeof msg === "string" ? msg : new TextDecoder().decode(msg);
            if (ws.data.kind === "page") onPageMessage(raw); else onCliMessage(ws, raw);
        },
        close(ws, code, reason) {
            if (ws.data.kind === "page" && page === ws) {
                page = null;
                log(`[bridge] page disconnected (code ${code}${reason ? `, ${reason}` : ""}) — reloaded, backgrounded or killed`);
                failInflight(`remote page disconnected (code ${code}) — it reloaded, was backgrounded or was killed`);
            }
            if (ws.data.kind === "cli") {
                for (const [id, e] of inflight) if (e.cli === ws) inflight.delete(id);
            }
        },
    },
});

const pagePath = `/?game=dev&bs=${SESSION}&bridge=${TOKEN}`;
console.log(`[bridge] listening on http://localhost:${server.port} — log ${LOG_FILE}`);
console.log(`[bridge] drive it: BS_CDP_PORT=${PORT} BS_TAB=${SESSION} bun tools/harness.ts eval "navigator.userAgent"`);

/** Print the device URL and show it as a QR code: in the terminal, and as a PNG opened on
 *  this machine's screen (the terminal may be an agent's, not one the user can see). */
async function announce(url: string, note: string): Promise<void> {
    console.log(`[bridge] Open on the device:\n\n    ${url}\n`);
    console.log(`[bridge] (${note})`);
    // Per-run name: an image viewer still showing the previous QR holds that file open on
    // Windows, and overwriting it fails with EUNKNOWN.
    const png = `${LOG_DIR}/open-on-device-${RUN_STAMP}.png`;
    try {
        console.log(await QRCode.toString(url, { type: "terminal", small: true }));
        await QRCode.toFile(png, url, { width: 512, margin: 2 });
        console.log(`[bridge] QR code -> ${png}`);
        if (!process.argv.includes("--no-open")) {
            const opener = process.platform === "win32" ? ["explorer.exe", png.replace(/\//g, "\\")]
                : process.platform === "darwin" ? ["open", png] : ["xdg-open", png];
            Bun.spawn(opener, { stdout: "ignore", stderr: "ignore" }).unref();
        }
    } catch (e) {
        console.warn(`[bridge] QR code failed: ${e instanceof Error ? e.message : e}`);
    }
}

/** This machine's address on the home LAN: a private IPv4 on an interface that is up,
 *  skipping VirtualBox/Hyper-V host-only nets and VPN ranges unless BS_LAN_HOST says so. */
function lanAddress(): string | null {
    if (process.env.BS_LAN_HOST) return process.env.BS_LAN_HOST;
    const cands: string[] = [];
    for (const list of Object.values(networkInterfaces())) {
        for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) cands.push(a.address);
    }
    return cands.find((ip) => /^192\.168\./.test(ip) && !/^192\.168\.56\./.test(ip))
        ?? cands.find((ip) => /^(10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) ?? null;
}

if (LAN) {
    // Same Wi-Fi, no tunnel: the device pulls bundles at LAN speed. WebKit grants
    // crossOriginIsolated (SharedArrayBuffer) only to a secure context, and a LAN IP is one
    // only over HTTPS — so Vite must run with VITE_SSL=1 (self-signed; accept it once).
    const ip = lanAddress();
    if (!ip) console.warn("[bridge] no LAN IPv4 found — set BS_LAN_HOST");
    else void announce(`https://${ip}:${DEV_PORT}${pagePath}`,
        "same Wi-Fi as this PC; Vite must run with VITE_SSL=1. Safari warns about the self-signed certificate once: Show Details → visit this website");
} else if (!TUNNEL) {
    console.log(`[bridge] local page URL: http://localhost:${DEV_PORT}${pagePath}`);
} else {
    // Quick tunnel: no account, random hostname, lives as long as this process. HTTP/2 over
    // TCP by default: cloudflared's QUIC needs UDP 7844, which VPNs and office networks drop
    // silently — the tunnel then flaps and serves 502s. BS_TUNNEL_PROTOCOL=quic opts back in.
    const protocol = process.env.BS_TUNNEL_PROTOCOL ?? "http2";
    const cf = Bun.spawn(["cloudflared", "tunnel", "--no-autoupdate", "--protocol", protocol, "--url", `http://localhost:${DEV_PORT}`], {
        stdout: "pipe", stderr: "pipe",
    });
    const scan = async (stream: ReadableStream<Uint8Array>) => {
        const dec = new TextDecoder();
        let announced = false;
        for await (const chunk of stream) {
            const text = dec.decode(chunk);
            appendFileSync(`${LOG_DIR}/cloudflared.log`, text);
            const hit = !announced && /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);
            if (hit) {
                announced = true;
                void announce(`${hit[0]}${pagePath}`, "tunnel up; Vite must run with BS_TUNNEL=1, or it answers the tunnel with 403 'Blocked request'");
            }
        }
    };
    void scan(cf.stdout);
    void scan(cf.stderr);
    const stop = () => { try { cf.kill(); } catch { /* */ } process.exit(0); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    void cf.exited.then((code) => log(`[bridge] cloudflared exited with code ${code}`));
}
