/**
 * cdp-core.ts — the shared Chrome DevTools Protocol transport for BottleShip
 * tooling. Until now ~35 `cdp-*.ts` scripts each copy-pasted the same
 * ~30 lines: target discovery via http://localhost:9333/json/list (filter
 * url.includes("game=dev")), a WebSocket to webSocketDebuggerUrl, an id/pending
 * Map request loop, and the Target.setAutoAttach worker-session dance. This file
 * extracts all of it once.
 *
 * Exports: launchOrAttachChrome, findTab, findOrCreateTab, closeStaleTabs, listTargets,
 * listSessionTabs, connect (-> CdpSession), pageEval, workerEval, screenshot,
 * captureTrace, health.
 *
 * Target discovery is session-scoped (src/harness/session.ts): `BS_TAB=<name>` pins every
 * lookup to the `?game=dev&bs=<name>` tab, so several agents can drive several tabs of one
 * Chrome. Unset = the historical single-tab behaviour.
 *
 * Bun script (top-level await, Bun.spawnSync, global fetch/WebSocket).
 */
import { gzipSync } from "node:zlib";
import { closeSync, existsSync, openSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickSessionTab, sessionFromEnv, sessionOwnsUrl, sessionUrl } from "../src/harness/session";

export const DEFAULT_CDP_PORT = Number(process.env.BS_CDP_PORT ?? 9333);
/** BS_DEV_URL / BS_SIDECAR_PORT point the tools at a SECOND dev stack (an isolated
 *  worktree, a test rig) so it never drives or writes into the first one's. */
export const DEFAULT_DEV_URL = process.env.BS_DEV_URL ?? "http://localhost:5174/?game=dev";
export const SIDECAR_PORT = Number(process.env.BS_SIDECAR_PORT ?? 3001);
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

/** The session this process drives (`BS_TAB`); "" = the default single-tab session. */
export function cdpSession(): string {
    return sessionFromEnv(process.env);
}

/**
 * Cross-process guard so two concurrent `harness up` runs don't each launch Chrome on
 * the same port. Machine-global (os tmpdir, keyed by port) — parallel agents work from
 * separate git worktrees, so anything under cwd would not be shared. A lock older than
 * the launch timeout is stolen: a crashed launcher must not wedge the port forever.
 */
const LAUNCH_LOCK_TTL_MS = 45_000;

function acquireLaunchLock(port: number, kind = "cdp", ttlMs = LAUNCH_LOCK_TTL_MS): (() => void) | null {
    const path = join(tmpdir(), `bottleship-${kind}-launch-${port}.lock`);
    return acquireLockAt(path, ttlMs);
}

function acquireLockAt(path: string, ttlMs: number): (() => void) | null {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            closeSync(openSync(path, "wx"));
            return () => { try { rmSync(path); } catch { /* already gone */ } };
        } catch {
            try {
                if (Date.now() - statSync(path).mtimeMs > ttlMs) { rmSync(path); continue; }
            } catch { continue; }
            return null;
        }
    }
    return null;
}

async function waitForChrome(port: number, tries: number): Promise<any> {
    for (let i = 0; i < tries; i++) {
        try {
            return await fetchJson(port, "/json/version");
        } catch {
            await Bun.sleep(300);
        }
    }
    throw new Error(`Chrome did not come up on :${port} within ${Math.round(tries * 0.3)}s`);
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
    const release = acquireLaunchLock(port);
    // Someone else is already launching this port: wait for THEIR Chrome instead of
    // racing a second one onto the same profile directory.
    if (!release) return waitForChrome(port, 100);
    try {
        return await launchChrome(port, profile, autoplay);
    } finally {
        release();
    }
}

async function launchChrome(port: number, profile: string, autoplay: boolean): Promise<any> {
    // Re-probe under the lock — the winner may have finished between our probe and here.
    try {
        return await fetchJson(port, "/json/version");
    } catch {
        /* still down — launch */
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
    return waitForChrome(port, 50);
}

/** Every target Chrome reports (page, worker, iframe…). */
export async function listTargets(opts: { port?: number } = {}): Promise<CdpTarget[]> {
    return fetchJson(opts.port ?? DEFAULT_CDP_PORT, "/json/list");
}

/** The `?game=dev` page tabs, one per harness session that has one open. */
export async function listSessionTabs(opts: { port?: number } = {}): Promise<CdpTarget[]> {
    const list = await listTargets(opts);
    return list.filter((t) => t.type === "page" && t.url.includes(GAME_DEV_FILTER));
}

/** Find the target this session drives (default page/game=dev).
 *  Multi-agent isolation: with `BS_TAB=<name>` set, only a tab carrying the matching
 *  `?bs=<name>` token matches, so two agents never steal each other's. With BS_TAB unset
 *  an UNMARKED tab wins (a named sibling's tab is not hijacked), falling back to the first
 *  game=dev tab — which is the unchanged behaviour when no session is in play. */
export async function findTab(urlMatch = GAME_DEV_FILTER, opts: { type?: string; port?: number; strict?: boolean } = {}): Promise<CdpTarget> {
    const port = opts.port ?? DEFAULT_CDP_PORT;
    const type = opts.type ?? "page";
    const session = cdpSession();
    const list: CdpTarget[] = await fetchJson(port, "/json/list");
    const hit = pickSessionTab(list, session, { type, urlMatch, strict: opts.strict });
    if (!hit) {
        const avail = list.map((t) => `${t.type}:${t.url.slice(-60)}`).join("\n  ");
        throw new Error(`no ${type} tab matching '${urlMatch}'${session ? ` + BS_TAB '${session}'` : ""}. Open tabs:\n  ${avail}`);
    }
    return hit;
}

/** Close this session's game=dev tabs. Tabs belonging to another session are left
 *  alone — a sibling agent's guest must survive our teardown. */
export async function closeStaleTabs(urlMatch = GAME_DEV_FILTER, opts: { port?: number } = {}): Promise<number> {
    const port = opts.port ?? DEFAULT_CDP_PORT;
    const session = cdpSession();
    const list: CdpTarget[] = await fetchJson(port, "/json/list");
    let closed = 0;
    for (const t of list) {
        if (t.type === "page" && t.url.includes(urlMatch) && sessionOwnsUrl(t.url, session)) {
            try {
                await fetch(`http://localhost:${port}/json/close/${t.id}`);
                closed++;
            } catch { /* */ }
        }
    }
    return closed;
}

/** Find this session's game=dev tab, or open one at `url` (PUT then GET fallback).
 *  Creation is strict: rather open our own tab than adopt one another session owns. */
export async function findOrCreateTab(url = DEFAULT_DEV_URL, opts: { port?: number } = {}): Promise<CdpTarget> {
    const port = opts.port ?? DEFAULT_CDP_PORT;
    try {
        return await findTab(GAME_DEV_FILTER, { port, strict: true });
    } catch { /* create below */ }
    const target = sessionUrl(url, cdpSession());
    const newUrl = `http://localhost:${port}/json/new?${encodeURIComponent(target)}`;
    for (const method of ["PUT", "GET"]) {
        const r = await fetch(newUrl, { method });
        if (r.ok) return r.json();
    }
    throw new Error(`failed to open tab ${target} (PUT and GET both rejected)`);
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
    opts: { port?: number; categories?: string[]; during?: (elapsedMs: number) => Promise<void> } = {},
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
    // `during` runs INSIDE the recording window (a third of the way in, so its own sampling
    // interval finishes comfortably before Tracing.end). This is how the bottleship.hotblocks
    // mark gets into the trace — blink.user_timing is already recorded, so a mark emitted here
    // lands in the artifact and analyze-trace can resolve wasm frames to module:rva. Without
    // it a trace looks complete and analyses shallow.
    const totalMs = seconds * 1000;
    const t0 = Date.now();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    if (opts.during) {
        await sleep(Math.min(Math.max(500, totalMs / 3), Math.max(0, totalMs - 500)));
        try { await opts.during(Date.now() - t0); } catch (e) { console.warn(`[captureTrace] during-window hook failed: ${e}`); }
    }
    const remaining = totalMs - (Date.now() - t0);
    if (remaining > 0) await sleep(remaining);
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
export async function pageEval(session: CdpSession, expr: string, opts: { timeoutMs?: number; awaitPromise?: boolean; returnByValue?: boolean; userGesture?: boolean } = {}): Promise<any> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const r = await Promise.race([
        session.send("Runtime.evaluate", {
            expression: expr,
            awaitPromise: opts.awaitPromise ?? true,
            returnByValue: opts.returnByValue ?? true,
            // Gesture-gated APIs (requestPointerLock, requestFullscreen, AudioContext.resume)
            // reject without user activation, which no harness verb can otherwise grant.
            userGesture: opts.userGesture ?? false,
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

/**
 * Engage or release Pointer Lock — the transport a guest gets whenever it asks for a
 * relative mouse (ShowCursor(FALSE), ClipCursor, exclusive DirectInput, a warp burst).
 * Neither half is reachable from the page: the browser demands user activation AND a
 * focused document, and a background tab has neither. Everything downstream of the lock
 * (relative deltas, honored SetCursorPos warps, the host-drawn cursor) is untestable
 * without it.
 */
export async function setPointerLock(session: CdpSession, engage: boolean, opts: { timeoutMs?: number } = {}): Promise<{ locked: boolean; error: string | null }> {
    if (engage) await session.send("Page.bringToFront", {}).catch(() => { /* already front */ });
    const expr = `(async () => {
        const c = document.querySelector('canvas');
        if (!c) return { locked: false, error: 'no canvas' };
        let error = null;
        try {
            if (${engage}) await c.requestPointerLock(); else document.exitPointerLock();
        } catch (e) { error = String((e && e.message) || e); }
        const deadline = Date.now() + 2000;
        while (!!document.pointerLockElement !== ${engage} && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 32));
        }
        return { locked: !!document.pointerLockElement, error };
    })()`;
    return await pageEval(session, expr, { userGesture: true, timeoutMs: opts.timeoutMs ?? 15_000 });
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
    /** Vite still TRANSFORMS source, not just serves cached static replies. */
    viteTransform: boolean;
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

/** A module Vite must run through its transform pipeline to answer — the root and
 *  index.html come back from a static/cached path even when the transform pipeline
 *  is wedged, so `vite: true` alone cannot distinguish "serving" from "working". */
const VITE_TRANSFORM_PROBE = "/src/app/App.tsx";

/** Probe all three services (Vite has no /health — GET the dev URL instead).
 *  `viteTransform` is the load-bearing one: a wedged Vite still answers 200 on the
 *  root while every real module request hangs, which presents as "the page loads but
 *  nothing renders / the guest never boots" and sends you hunting inside the game. */
/**
 * Vite's cold start in this project is ~2 minutes (measured: 116 s cold, 89 s warm), which
 * is long enough that a live server is repeatedly mistaken for a hung one and killed.
 * Everything below exists so nobody has to make that judgement by eye.
 */
const VITE_COLD_START_MS = 300_000;
/** Long TTL for the same reason: stealing this lock mid-cold-start starts a second Vite. */
const VITE_LOCK_TTL_MS = 360_000;

async function viteTransformOk(timeoutMs = 20_000): Promise<boolean> {
    try {
        const origin = new URL(DEFAULT_DEV_URL).origin;
        return (await fetch(`${origin}${VITE_TRANSFORM_PROBE}`, { signal: AbortSignal.timeout(timeoutMs) })).ok;
    } catch { return false; }
}

/**
 * Vite pre-bundles deps into `node_modules/.vite-temp` and renames it to `.vite/deps`.
 * When that rename does not happen — which it does under concurrent starts — every dep
 * request 504s forever and no amount of waiting recovers it. The half-state is precisely
 * detectable, so detect and clear it rather than asking a human to notice.
 */
function repairViteDepCache(): boolean {
    const temp = join(process.cwd(), "node_modules", ".vite-temp");
    const deps = join(process.cwd(), "node_modules", ".vite", "deps");
    if (!existsSync(temp) || existsSync(deps)) return false;
    rmSync(temp, { recursive: true, force: true });
    rmSync(join(process.cwd(), "node_modules", ".vite"), { recursive: true, force: true });
    return true;
}

function killWedgedVite(): void {
    if (IS_MAC) { Bun.spawnSync(["pkill", "-f", "vite"]); return; }
    // By PID via the listening socket — matching 'vite' on the command line kills every
    // Vite on the machine, including other agents' and other checkouts'.
    const port = new URL(DEFAULT_DEV_URL).port || "5174";
    Bun.spawnSync(["powershell", "-NoProfile", "-Command",
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
        `ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`]);
}

/**
 * Make sure exactly one healthy Vite is serving, starting or repairing it if not.
 *
 * The lock is the point: several agents each running `harness up` used to start several
 * Vites, and they share one dep-optimizer cache directory — which is how the rename above
 * gets lost in the first place. A loser of the lock waits for the winner instead of
 * starting a competitor.
 */
export async function ensureVite(): Promise<{ ok: boolean; action: string }> {
    if (await viteTransformOk(8_000)) return { ok: true, action: "already-serving" };

    const port = Number(new URL(DEFAULT_DEV_URL).port || 5174);
    const release = acquireLaunchLock(port, "vite", VITE_LOCK_TTL_MS);
    if (!release) {
        // Someone else is starting it; a cold start is minutes, so wait rather than race.
        const deadline = Date.now() + VITE_COLD_START_MS;
        while (Date.now() < deadline) {
            if (await viteTransformOk(10_000)) return { ok: true, action: "waited-for-other-starter" };
            await Bun.sleep(3_000);
        }
        return { ok: false, action: "timed-out-waiting-for-other-starter" };
    }

    try {
        const listening = await (async () => { try { return (await fetch(new URL(DEFAULT_DEV_URL).origin, { signal: AbortSignal.timeout(5_000) })).ok; } catch { return false; } })();
        const repaired = repairViteDepCache();
        // Serving static but not transforming = wedged; it will never recover on its own.
        if (listening || repaired) {
            killWedgedVite();
            for (let i = 0; i < 30 && await portInUse(port); i++) await Bun.sleep(1_000);
        }
        Bun.spawnSync(["powershell", "-NoProfile", "-Command",
            `Start-Process -FilePath 'bun' -ArgumentList 'run','dev' -WorkingDirectory '${process.cwd()}' -WindowStyle Hidden`]);
        const deadline = Date.now() + VITE_COLD_START_MS;
        while (Date.now() < deadline) {
            if (await viteTransformOk(10_000)) {
                return { ok: true, action: repaired ? "repaired-and-restarted" : "started" };
            }
            await Bun.sleep(3_000);
        }
        return { ok: false, action: "started-but-not-ready" };
    } finally {
        release();
    }
}

async function portInUse(port: number): Promise<boolean> {
    try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(2_000) }); return true; } catch { return false; }
}

export async function health(opts: { port?: number } = {}): Promise<HealthReport> {
    const port = opts.port ?? DEFAULT_CDP_PORT;
    const probe = async (url: string, init?: RequestInit) => {
        try { return (await fetch(url, init)).ok; } catch { return false; }
    };
    const viteOrigin = new URL(DEFAULT_DEV_URL).origin;
    const vite = (await probe(`${viteOrigin}/health`)) || (await probe(DEFAULT_DEV_URL));
    // Needs its own deadline: the wedged mode HANGS rather than erroring.
    const viteTransform = await (async () => {
        try {
            const r = await fetch(`${viteOrigin}${VITE_TRANSFORM_PROBE}`, { signal: AbortSignal.timeout(15_000) });
            return r.ok;
        } catch { return false; }
    })();
    const logServer = await (async () => {
        try { return (await (await fetch(`http://localhost:${SIDECAR_PORT}/health`)).text()).trim() === "OK"; } catch { return false; }
    })();
    let chrome = false, devTab = false;
    try {
        await fetchJson(port, "/json/version");
        chrome = true;
        await findTab(GAME_DEV_FILTER, { port });
        devTab = true;
    } catch { /* */ }
    return { vite, viteTransform, logServer, chrome, devTab };
}
