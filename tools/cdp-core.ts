/**
 * cdp-core.ts — the shared Chrome DevTools Protocol transport for BottleShip
 * tooling. Until now ~35 `cdp-*.ts` scripts each copy-pasted the same
 * ~30 lines: target discovery via http://localhost:9333/json/list (filter
 * url.includes("game=dev")), a WebSocket to webSocketDebuggerUrl, an id/pending
 * Map request loop, and the Target.setAutoAttach worker-session dance. This file
 * extracts all of it once.
 *
 * Exports: launchOrAttachChrome, findTab, findOrCreateTab, closeStaleTabs,
 * connect (-> CdpSession), pageEval, workerEval, screenshot, captureTrace, health.
 *
 * Bun script (top-level await, Bun.spawnSync, global fetch/WebSocket).
 */
import { gzipSync } from "node:zlib";

export const DEFAULT_CDP_PORT = 9333;
export const DEFAULT_DEV_URL = "http://localhost:5174/?game=dev";
export const GAME_DEV_FILTER = "game=dev";
const IS_MAC = process.platform === "darwin";
const CHROME_PATH = IS_MAC
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEFAULT_PROFILE = IS_MAC
    ? `${process.env.HOME}/.bottleship-cdp-profile`
    : `${process.cwd()}/tmp/cdp-profile`;

export interface CdpTarget {
    id: string;
    type: string;
    url: string;
    title?: string;
    webSocketDebuggerUrl: string;
}

async function fetchJson(port: number, path: string): Promise<any> {
    const r = await fetch(`http://localhost:${port}${path}`);
    if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
    return r.json();
}

/** Probe Chrome's debug endpoint; launch a DETACHED instance if it's down. */
export async function launchOrAttachChrome(opts: { port?: number; profile?: string; autoplay?: boolean } = {}): Promise<any> {
    const port = opts.port ?? DEFAULT_CDP_PORT;
    const profile = opts.profile ?? DEFAULT_PROFILE;
    const autoplay = opts.autoplay ?? true;
    try {
        return await fetchJson(port, "/json/version");
    } catch {
        /* not running — launch below */
    }
    const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate",
        // Touch feature detection ('ontouchstart' in window, maxTouchPoints > 0) at
        // page load — before any Emulation override — so startup-time capability
        // checks see a touch device in automation.
        "--touch-events=enabled",
        ...(autoplay ? ["--autoplay-policy=no-user-gesture-required"] : []),
        "--window-size=1400,1050",
        // Escape hatch for measurement runs that need engine flags the default launch
        // must not carry, e.g. BS_CHROME_FLAGS="--js-flags=--allow-natives-syntax" to
        // classify JIT modules by V8 tier. Space-separated; only honored on a cold
        // launch, so kill a running instance first for it to take effect.
        ...(process.env.BS_CHROME_FLAGS ? process.env.BS_CHROME_FLAGS.split(" ").filter(Boolean) : []),
        "about:blank",
    ];
    if (IS_MAC) {
        // Detach so Chrome outlives this bun process. `open -na` launches a fresh
        // instance with our args even if Chrome is already running under another profile.
        Bun.spawn(["open", "-na", "Google Chrome", "--args", ...args], {
            stdout: "ignore",
            stderr: "ignore",
        }).unref();
    } else {
        // Detached via PowerShell Start-Process so Chrome outlives this bun process
        // (a plain Bun.spawn child dies with bun on Windows).
        const psArgs = args.map((a) => `'${a}'`).join(",");
        Bun.spawnSync(["powershell", "-NoProfile", "-Command", `Start-Process -FilePath '${CHROME_PATH}' -ArgumentList ${psArgs}`]);
    }
    for (let i = 0; i < 50; i++) {
        try {
            return await fetchJson(port, "/json/version");
        } catch {
            await Bun.sleep(300);
        }
    }
    throw new Error(`Chrome did not come up on :${port} within 15s`);
}

/** Find the first target matching a url substring + type (default page/game=dev).
 *  Multi-agent isolation: when env `BS_TAB` is set, the match additionally requires the url to
 *  contain that marker — so two agents can each pin their own `?game=dev&<marker>` tab without
 *  stealing each other's. With BS_TAB unset the behaviour is unchanged (first game=dev tab). */
export async function findTab(urlMatch = GAME_DEV_FILTER, opts: { type?: string; port?: number } = {}): Promise<CdpTarget> {
    const port = opts.port ?? DEFAULT_CDP_PORT;
    const type = opts.type ?? "page";
    const marker = (process.env.BS_TAB ?? "").trim();
    const list: CdpTarget[] = await fetchJson(port, "/json/list");
    const hit = list.find((t) => t.type === type && t.url.includes(urlMatch) && (!marker || t.url.includes(marker)));
    if (!hit) {
        const avail = list.map((t) => `${t.type}:${t.url.slice(-60)}`).join("\n  ");
        throw new Error(`no ${type} tab matching '${urlMatch}'${marker ? ` + BS_TAB '${marker}'` : ""}. Open tabs:\n  ${avail}`);
    }
    return hit;
}

export async function closeStaleTabs(urlMatch = GAME_DEV_FILTER, opts: { port?: number } = {}): Promise<number> {
    const port = opts.port ?? DEFAULT_CDP_PORT;
    const list: CdpTarget[] = await fetchJson(port, "/json/list");
    let closed = 0;
    for (const t of list) {
        if (t.type === "page" && t.url.includes(urlMatch)) {
            try {
                await fetch(`http://localhost:${port}/json/close/${t.id}`);
                closed++;
            } catch { /* */ }
        }
    }
    return closed;
}

/** Find an existing game=dev tab, or open one at `url` (PUT then GET fallback). */
export async function findOrCreateTab(url = DEFAULT_DEV_URL, opts: { port?: number } = {}): Promise<CdpTarget> {
    const port = opts.port ?? DEFAULT_CDP_PORT;
    try {
        return await findTab(GAME_DEV_FILTER, { port });
    } catch { /* create below */ }
    const newUrl = `http://localhost:${port}/json/new?${encodeURIComponent(url)}`;
    for (const method of ["PUT", "GET"]) {
        const r = await fetch(newUrl, { method });
        if (r.ok) return r.json();
    }
    throw new Error(`failed to open tab ${url} (PUT and GET both rejected)`);
}

/** A live CDP WebSocket session with id-correlated requests + event fan-out. */
export class CdpSession {
    private ws: WebSocket;
    private nextId = 1;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    private listeners = new Map<string, Array<(params: any, sessionId?: string) => void>>();

    private constructor(ws: WebSocket) {
        this.ws = ws;
        this.ws.onmessage = (ev: MessageEvent) => {
            const m = JSON.parse(String(ev.data));
            if (m.id && this.pending.has(m.id)) {
                const p = this.pending.get(m.id)!;
                this.pending.delete(m.id);
                if (m.error) p.reject(new Error(`${m.error.message ?? "CDP error"} (${m.error.code ?? "?"})`));
                else p.resolve(m);
                return;
            }
            if (m.method) {
                const ls = this.listeners.get(m.method);
                if (ls) for (const l of ls) l(m.params, m.sessionId);
            }
        };
    }

    static connect(wsUrl: string): Promise<CdpSession> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            ws.onopen = () => resolve(new CdpSession(ws));
            ws.onerror = (e) => reject(new Error(`CDP ws connect failed: ${String((e as any)?.message ?? e)}`));
        });
    }

    send(method: string, params: any = {}, sessionId?: string): Promise<any> {
        const id = this.nextId++;
        const payload: any = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        this.ws.send(JSON.stringify(payload));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }

    on(method: string, cb: (params: any, sessionId?: string) => void): void {
        const ls = this.listeners.get(method) ?? [];
        ls.push(cb);
        this.listeners.set(method, ls);
    }

    close(): void {
        try { this.ws.close(); } catch { /* */ }
    }
}

/**
 * Capture a Chrome performance trace and write it gzipped for tools/analyze-trace.ts.
 *
 * Tracing is a BROWSER-level domain (not per-page), so this opens its own session on the
 * browser endpoint rather than reusing a page session. The v8.cpu_profiler category is the
 * load-bearing one — without it the trace has no Profile/ProfileChunk events and the
 * analyzer reports nothing.
 */
export async function captureTrace(
    outFile: string,
    seconds: number,
    opts: { port?: number; categories?: string[] } = {},
): Promise<{ file: string; events: number; bytes: number }> {
    const port = opts.port ?? DEFAULT_CDP_PORT;
    const version = await fetchJson(port, "/json/version");
    const session = await CdpSession.connect(version.webSocketDebuggerUrl);
    const categories = opts.categories ?? [
        "disabled-by-default-v8.cpu_profiler",
        "v8", "v8.execute", "devtools.timeline", "blink.user_timing", "toplevel",
    ];
    const events: any[] = [];
    session.on("Tracing.dataCollected", (p) => { if (p?.value) events.push(...p.value); });
    const complete = new Promise<void>((resolve) => session.on("Tracing.tracingComplete", () => resolve()));

    await session.send("Tracing.start", {
        traceConfig: { includedCategories: categories, recordMode: "recordAsMuchAsPossible" },
        transferMode: "ReportEvents",
    });
    await new Promise((r) => setTimeout(r, seconds * 1000));
    await session.send("Tracing.end");
    await Promise.race([complete, new Promise((r) => setTimeout(r, 120_000))]);
    session.close();

    const json = JSON.stringify({ traceEvents: events });
    const gz = gzipSync(Buffer.from(json));
    await Bun.write(outFile, gz);
    return { file: outFile, events: events.length, bytes: gz.byteLength };
}

/** Connect to the game=dev page target. */
export async function connect(opts: { port?: number; urlMatch?: string } = {}): Promise<{ session: CdpSession; target: CdpTarget }> {
    const target = await findTab(opts.urlMatch ?? GAME_DEV_FILTER, { port: opts.port });
    const session = await CdpSession.connect(target.webSocketDebuggerUrl);
    return { session, target };
}

/** Evaluate an expression in the PAGE context; returns the deserialized value. */
export async function pageEval(session: CdpSession, expr: string, opts: { timeoutMs?: number; awaitPromise?: boolean; returnByValue?: boolean } = {}): Promise<any> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const r = await Promise.race([
        session.send("Runtime.evaluate", {
            expression: expr,
            awaitPromise: opts.awaitPromise ?? true,
            returnByValue: opts.returnByValue ?? true,
        }),
        Bun.sleep(timeoutMs).then(() => ({ __timeout: true } as any)),
    ]);
    if ((r as any).__timeout) throw new Error(`pageEval timed out after ${timeoutMs}ms`);
    const res = (r as any).result;
    if (res?.exceptionDetails) {
        throw new Error(`page eval exception: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ""}`);
    }
    return res?.result?.value ?? res?.result;
}

/** Evaluate an expression in the WORKER context via the flattened auto-attach dance. */
export async function workerEval(session: CdpSession, expr: string, opts: { timeoutMs?: number } = {}): Promise<any> {
    let workerSession: string | undefined;
    const got = new Promise<string>((resolve) => {
        session.on("Target.attachedToTarget", (params) => {
            if (params?.targetInfo?.type === "worker") {
                workerSession = params.sessionId;
                resolve(params.sessionId);
            }
        });
    });
    await session.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await session.send("Target.setDiscoverTargets", { discover: true }).catch(() => { /* optional */ });

    // AutoAttach only fires for workers created *after* enable — attach existing ones too.
    if (!workerSession) {
        try {
            const targets = await session.send("Target.getTargets");
            for (const t of targets.result?.targetInfos ?? []) {
                if (t.type !== "worker") continue;
                const attach = await session.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
                workerSession = attach.result?.sessionId ?? workerSession;
                if (workerSession) break;
            }
        } catch { /* fall through to race */ }
    }

    const sessionId = workerSession ?? (await Promise.race([
        got,
        new Promise<string>((_res, rej) => setTimeout(() => rej(new Error("no worker attached in 15s")), 15_000)),
    ]));
    await session.send("Runtime.enable", {}, sessionId).catch(() => { /* idempotent */ });
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const r = await Promise.race([
        session.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId),
        Bun.sleep(timeoutMs).then(() => ({ __timeout: true } as any)),
    ]);
    if ((r as any).__timeout) throw new Error(`workerEval timed out after ${timeoutMs}ms`);
    const res = (r as any).result;
    if (res?.exceptionDetails) throw new Error(`worker eval exception: ${res.exceptionDetails.text}`);
    return res?.result?.value ?? res?.result;
}

/** Attach to the worker target and return its sessionId (auto-attach + existing-target fallback). */
async function attachWorkerSession(session: CdpSession): Promise<string> {
    let workerSession: string | undefined;
    const got = new Promise<string>((resolve) => {
        session.on("Target.attachedToTarget", (params) => {
            if (params?.targetInfo?.type === "worker") {
                workerSession = params.sessionId;
                resolve(params.sessionId);
            }
        });
    });
    await session.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await session.send("Target.setDiscoverTargets", { discover: true }).catch(() => { /* optional */ });
    if (!workerSession) {
        try {
            const targets = await session.send("Target.getTargets");
            for (const t of targets.result?.targetInfos ?? []) {
                if (t.type !== "worker") continue;
                const attach = await session.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
                workerSession = attach.result?.sessionId ?? workerSession;
                if (workerSession) break;
            }
        } catch { /* fall through to race */ }
    }
    return workerSession ?? (await Promise.race([
        got,
        new Promise<string>((_res, rej) => setTimeout(() => rej(new Error("no worker attached in 15s")), 15_000)),
    ]));
}

export interface WorkerStackFrame {
    functionName: string;
    url: string;
    line: number;
    column: number;
}

/**
 * Interrupt the WORKER with Debugger.pause and capture its call stack — works even
 * when the worker's event loop is starved by a synchronous loop (V8 pauses via
 * interrupt at loop back-edges / wasm). Takes `samples` stacks `intervalMs` apart
 * so a hot loop shows up as the repeated frame. Resumes the worker after each sample.
 */
export async function workerStack(
    session: CdpSession,
    opts: { samples?: number; intervalMs?: number; timeoutMs?: number } = {},
): Promise<WorkerStackFrame[][]> {
    const samples = opts.samples ?? 3;
    const intervalMs = opts.intervalMs ?? 250;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const sessionId = await attachWorkerSession(session);
    await session.send("Debugger.enable", {}, sessionId);
    const out: WorkerStackFrame[][] = [];
    try {
        for (let i = 0; i < samples; i++) {
            const paused = new Promise<any>((resolve) => {
                session.on("Debugger.paused", (params, sid) => {
                    if (sid === sessionId) resolve(params);
                });
            });
            await session.send("Debugger.pause", {}, sessionId);
            const p = await Promise.race([
                paused,
                Bun.sleep(timeoutMs).then(() => null),
            ]);
            if (!p) {
                out.push([{ functionName: "<pause timed out — worker blocked outside interruptible code>", url: "", line: 0, column: 0 }]);
                break;
            }
            out.push((p.callFrames ?? []).map((f: any) => ({
                functionName: f.functionName || "<anonymous>",
                url: f.url || f.location?.scriptId || "",
                line: (f.location?.lineNumber ?? 0) + 1,
                column: f.location?.columnNumber ?? 0,
            })));
            await session.send("Debugger.resume", {}, sessionId);
            if (i < samples - 1) await Bun.sleep(intervalMs);
        }
    } finally {
        await session.send("Debugger.resume", {}, sessionId).catch(() => { /* already running */ });
        await session.send("Debugger.disable", {}, sessionId).catch(() => { /* */ });
    }
    return out;
}

/** Capture a page screenshot (PNG base64). */
export async function screenshot(session: CdpSession): Promise<string> {
    const r = await session.send("Page.captureScreenshot", { format: "png" });
    return r.result?.data ?? "";
}

export interface HealthReport {
    vite: boolean;
    logServer: boolean;
    chrome: boolean;
    devTab: boolean;
}

/** Hard-reload the ?game=dev tab (cache bypass) and poll until harness + loadApp are ready. */
export async function reloadDevPage(opts: { url?: string; port?: number; settleMs?: number } = {}): Promise<CdpTarget> {
    const url = opts.url ?? DEFAULT_DEV_URL;
    const port = opts.port ?? DEFAULT_CDP_PORT;
    const tab = await findOrCreateTab(url, { port });
    const session = await CdpSession.connect(tab.webSocketDebuggerUrl);
    try {
        await session.send("Page.reload", { ignoreCache: true });
    } finally {
        session.close();
    }
    await Bun.sleep(opts.settleMs ?? 3000);
    for (let i = 0; i < 60; i++) {
        const fresh = await findTab(GAME_DEV_FILTER, { port });
        const s2 = await CdpSession.connect(fresh.webSocketDebuggerUrl);
        try {
            const ready = await pageEval(
                s2,
                "!!(window.__BS__ && window.__BS__.harness && window.loadApp)",
                { timeoutMs: 5000 },
            ).catch(() => false);
            if (ready) return fresh;
        } finally {
            s2.close();
        }
        await Bun.sleep(500);
    }
    throw new Error("harness not ready after page reload");
}

/** Probe all three services (Vite has no /health — GET the dev URL instead). */
export async function health(opts: { port?: number } = {}): Promise<HealthReport> {
    const port = opts.port ?? DEFAULT_CDP_PORT;
    const probe = async (url: string, init?: RequestInit) => {
        try { return (await fetch(url, init)).ok; } catch { return false; }
    };
    const vite = (await probe("http://localhost:5174/health")) || (await probe(DEFAULT_DEV_URL));
    const logServer = await (async () => {
        try { return (await (await fetch("http://localhost:3001/health")).text()).trim() === "OK"; } catch { return false; }
    })();
    let chrome = false, devTab = false;
    try {
        await fetchJson(port, "/json/version");
        chrome = true;
        await findTab(GAME_DEV_FILTER, { port });
        devTab = true;
    } catch { /* */ }
    return { vite, logServer, chrome, devTab };
}
