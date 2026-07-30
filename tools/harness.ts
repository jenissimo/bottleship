#!/usr/bin/env bun
/**
 * harness — the single CLI for the AI-agent harness.
 *
 *   bun tools/harness.ts up                 cold-to-ready: launch/attach Chrome
 *                                           (+ --autoplay-policy), open ?game=dev,
 *                                           arm log streaming, probe all 3 services
 *   bun tools/harness.ts run <script.ts>    run a *.harness.ts fluent script
 *   bun tools/harness.ts repl               interactive: eval lines in the page
 *   bun tools/harness.ts health             probe Vite/log-server/Chrome
 *   bun tools/harness.ts eval <expr>        one-off page eval (debug)
 *
 * Scripts import the fluent builder from here:
 *     import { harness } from "../tools/harness";
 *     await harness().openWgb("blade-of-darkness").waitForEvent("dialogShow")
 *                    .click("Play Game").tickFrames(120)
 *                    .expectSurfaceNonBlack("primary").state(["surfaces"]).run();
 *
 * The builder is pure sugar over harness_rpc: `.run()` ships the serialized step
 * list to `window.__BS__.harness.__runSteps` in the page over a single CDP eval —
 * except the CDP_STEPS verbs (reload + the touch/device verbs), which the CLI runs
 * itself against the browser and splices back into the same ordered result.
 *
 * Parallel agents: `BS_TAB=<name>` binds every command to the `?game=dev&bs=<name>` tab
 * and re-roots this run's artifacts under `logs/<name>/`. Several agents can then bring up
 * several games in one Chrome without reading each other's evidence. Unset = unchanged.
 * Bring-up only — `trace` refuses to measure while a second guest is running.
 */

import {
    launchOrAttachChrome,
    ensureVite,
    reloadDevPage,
    findOrCreateTab,
    listSessionTabs,
    cdpSession,
    connect,
    pageEval,
    workerEval,
    workerStack,
    screenshot,
    captureTrace,
    health,
    CdpSession,
    DEFAULT_DEV_URL,
    setPointerLock,
} from "./cdp-core";
import { readCanvasGeometry } from "./cdp-geometry";
import { applyDevice, tap, touchDrag, longPress, twoFingerTap, pinch } from "./cdp-touch";
import { HarnessChain } from "../src/harness/dsl";
import type { HarnessStep, HarnessRunResult, HarnessStepResult } from "../src/harness/types";
import { runResultToJournal } from "../src/harness/journal";
import { sessionArtifactPath } from "../src/harness/session";

let _session: CdpSession | null = null;

/** The tab this process drives (`BS_TAB`); "" = the default single-tab session. */
const SESSION = cdpSession();

/** Re-root a default artifact path under `logs/<session>/` so two tabs never overwrite
 *  each other's evidence. An explicitly passed output path is left alone. */
function artifact(path: string): string {
    return sessionArtifactPath(path, SESSION);
}

async function ensureSession(): Promise<CdpSession> {
    if (_session) return _session;
    const { session } = await connect();
    _session = session;
    return session;
}

/** Wait until App mounted, harness facade + loadApp exist, and log streaming is armed. */
async function waitForHarnessReady(session: CdpSession): Promise<void> {
    for (let i = 0; i < 60; i++) {
        const ready = await pageEval(
            session,
            "!!(window.__BS__ && window.__BS__.harness && window.loadApp)",
            { timeoutMs: 5000 },
        ).catch(() => false);
        if (ready) break;
        await Bun.sleep(500);
    }
    // Worker log-server WS races server startup — arm twice.
    await pageEval(
        session,
        "window.worker && window.worker.postMessage({type:'log_stream_enable', enabled:true}), 'ok'",
        { timeoutMs: 5000 },
    ).catch(() => {});
    await Bun.sleep(500);
    await pageEval(
        session,
        "window.worker && window.worker.postMessage({type:'log_stream_enable', enabled:true}), 'ok'",
        { timeoutMs: 5000 },
    ).catch(() => {});
}

/** Hard-reload ?game=dev and wait for a fresh worker + harness facade.
 *  A marker on the pre-reload document distinguishes it from the fresh one —
 *  polling readiness alone races navigation commit and can match the OLD page. */
async function reloadPageAndWait(session: CdpSession): Promise<void> {
    await pageEval(session, "window.__bs_pre_reload__ = 1, 'ok'", { timeoutMs: 5000 }).catch(() => {});
    await session.send("Page.reload", { ignoreCache: true });
    for (let i = 0; i < 120; i++) {
        const fresh = await pageEval(
            session,
            "!window.__bs_pre_reload__ && !!(window.__BS__ && window.__BS__.harness && window.loadApp)",
            { timeoutMs: 5000 },
        ).catch(() => false);
        if (fresh) break;
        await Bun.sleep(500);
    }
    await waitForHarnessReady(session);
}

let _journalSeq = 0;

/** Verbs the CLI executes over CDP itself instead of shipping to the page: the
 *  page can neither reload itself mid-chain nor synthesize trusted touch input. */
const CDP_STEPS = new Set(["reload", "device", "tap", "touchDrag", "longPress", "twoFingerTap", "pinch", "pointerLock"]);

async function runCdpStep(session: CdpSession, step: HarnessStep): Promise<unknown> {
    const a = step.args as (number | string | undefined)[];
    const n = (i: number) => Number(a[i]);
    const opt = (i: number) => (a[i] === undefined || a[i] === null ? undefined : Number(a[i]));
    switch (step.cmd) {
        case "reload": await reloadPageAndWait(session); return { reloaded: true };
        case "device": return applyDevice(session, String(a[0]));
        case "tap": return tap(session, n(0), n(1));
        case "touchDrag": return touchDrag(session, n(0), n(1), n(2), n(3), opt(4));
        case "longPress": return longPress(session, n(0), n(1), opt(2));
        case "twoFingerTap": return twoFingerTap(session, n(0), n(1), opt(2));
        case "pinch": return pinch(session, n(0), n(1), n(2), { ms: opt(3) });
        case "pointerLock": return setPointerLock(session, a[0] !== false && a[0] !== 0);
    }
    throw new Error(`no CDP handler for step '${step.cmd}'`);
}

/** Ship a contiguous run of page steps to `__runSteps` in one eval. */
async function runPageSteps(session: CdpSession, steps: HarnessStep[]): Promise<HarnessRunResult> {
    // Double-stringify so the steps reach the page as a string the page JSON.parses
    // (avoids brittle expression escaping).
    const payload = JSON.stringify(JSON.stringify(steps));
    const expr = `window.__BS__ && window.__BS__.harness ? window.__BS__.harness.__runSteps(JSON.parse(${payload})) : Promise.reject(new Error('harness facade not installed (open ?game=dev)'))`;
    // The batch outlives its slowest step, so the CLI budget is the SUM of the per-step
    // budgets the chain asked for (tickFrames/waitUntil set theirs explicitly) plus slack.
    // A flat cap would abandon the eval while the chain is still legitimately running — and
    // the page keeps going, so the run reads as a timeout while the guest is mid-load.
    const budget = steps.reduce((sum, s) => sum + (s.opts?.timeoutMs ?? 30_000), 0);
    return (await pageEval(session, expr, { timeoutMs: Math.max(300_000, budget + 60_000) })) as HarnessRunResult;
}

/** CLI-side step executor: run CDP verbs here, batch everything else into the page,
 *  splice both back into ONE ordered result, then write a re-runnable journal.
 *  Order is preserved step-by-step — a chain may interleave the two freely
 *  (`.device(..).openWgb(..).tap(..).state(..)`). */
async function execViaCdp(steps: HarnessStep[]): Promise<HarnessRunResult> {
    const session = await ensureSession();
    const result: HarnessRunResult = { ok: true, steps: [], named: {} };

    for (let i = 0; i < steps.length;) {
        const step = steps[i];
        if (CDP_STEPS.has(step.cmd)) {
            const t0 = Date.now();
            try {
                const r = await runCdpStep(session, step);
                const sr: HarnessStepResult = { cmd: step.cmd, label: step.label, ok: true, result: r, ms: Date.now() - t0 };
                result.steps.push(sr);
                result.named[step.cmd] = r;
            } catch (err) {
                const e = err as Error;
                result.steps.push({ cmd: step.cmd, label: step.label, ok: false, error: { message: e.message }, ms: Date.now() - t0 });
                result.ok = false;
                result.error = { message: e.message, atStep: i, cmd: step.cmd };
                break;
            }
            i++;
            continue;
        }
        const start = i;
        while (i < steps.length && !CDP_STEPS.has(steps[i].cmd)) i++;
        const sub = await runPageSteps(session, steps.slice(start, i));
        result.steps.push(...(sub.steps ?? []));
        Object.assign(result.named, sub.named ?? {});
        if (!sub.ok) {
            result.ok = false;
            // The page numbers steps within its batch; re-base onto the whole chain.
            result.error = sub.error ? { ...sub.error, atStep: start + sub.error.atStep } : { message: "page batch failed", atStep: start, cmd: steps[start].cmd };
            if (sub.faultSnapshot !== undefined) result.faultSnapshot = sub.faultSnapshot;
            break;
        }
    }

    try {
        const file = artifact(`logs/harness/run-${++_journalSeq}.harness.ts`);
        await Bun.write(file, runResultToJournal(steps, result));
        console.log(`[harness] journal -> ${file} (${result.ok ? "ok" : "FAILED at step " + result.error?.atStep})`);
    } catch { /* logs/ may not exist; non-fatal */ }
    return result;
}

/** The fluent entry point scripts import. */
export function harness(): HarnessChain {
    return new HarnessChain(execViaCdp);
}

/* ─────────────────────────────── CLI commands ─────────────────────────────── */

async function cmdUp(): Promise<void> {
    console.log("[harness up] probing services…");
    // Before Chrome: a wedged Vite makes every guest look broken, and several agents each
    // starting their own Vite is what wedges it. ensureVite locks, repairs and waits.
    const v = await ensureVite();
    console.log(`[harness up] vite: ${v.action}${v.ok ? "" : " — NOT SERVING"}`);
    await launchOrAttachChrome({ autoplay: true });
    const tab = await findOrCreateTab(DEFAULT_DEV_URL);
    const session = await CdpSession.connect(tab.webSocketDebuggerUrl);
    _session = session;
    await waitForHarnessReady(session);
    const h = await health();
    console.log("[harness up] services:", JSON.stringify(h));
    if (h.vite && !h.viteTransform) {
        console.warn("[harness up] WARNING: Vite answers the root but will not transform modules — the page will load and render nothing. Restart the dev server (wait for :5174 to be released first); do not debug the guest until this is green.");
    }
    let ping = await pageEval(session, "window.__BS__.harness.ping()", { timeoutMs: 8000 }).catch((e) => ({ error: String(e) }));
    // A tab opened while Vite was wedged holds a dead page forever: the module graph never
    // loaded, so there is no harness facade and no worker — while `health()` still reports
    // devTab true, because the tab EXISTS. Reload once rather than hand back a green report
    // over a tab nothing can drive.
    if ((ping as { error?: string }).error) {
        console.log("[harness up] no harness in the tab — reloading it once");
        await reloadDevPage();
        const tab2 = await findOrCreateTab(DEFAULT_DEV_URL);
        _session = await CdpSession.connect(tab2.webSocketDebuggerUrl);
        await waitForHarnessReady(_session);
        ping = await pageEval(_session, "window.__BS__.harness.ping()", { timeoutMs: 8000 }).catch((e) => ({ error: String(e) }));
    }
    console.log("[harness up] worker ping:", JSON.stringify(ping));
    console.log(`[harness up] ready — tab ${tab.id} (${tab.url})`);
    if (SESSION) console.log(`[harness up] session '${SESSION}' — artifacts under logs/${SESSION}/`);
}

async function cmdRun(scriptPath: string): Promise<void> {
    if (!scriptPath) throw new Error("usage: harness run <script.harness.ts>");
    const abs = scriptPath.startsWith("/") || /^[A-Za-z]:/.test(scriptPath) ? scriptPath : `${process.cwd()}/${scriptPath}`;
    console.log(`[harness run] ${abs}`);
    // The script imports { harness } from this module and runs its chain(s) at
    // import time; we just await the module evaluation.
    await import(abs);
}

async function cmdRepl(): Promise<void> {
    const session = await ensureSession();
    console.log("[harness repl] page context. `window.__BS__.harness` (alias `harness`) is available. Ctrl-D to exit.");
    process.stdout.write("» ");
    const decoder = new TextDecoder();
    for await (const chunk of Bun.stdin.stream()) {
        const text = decoder.decode(chunk).trim();
        if (!text) { process.stdout.write("» "); continue; }
        try {
            const expr = `(async()=>{ const r = await (${text.startsWith("window") || text.startsWith("harness") ? text : "window.__BS__.harness." + text}); return r; })()`;
            const r = await pageEval(session, expr, { timeoutMs: 120_000 });
            console.log(JSON.stringify(r, null, 2));
        } catch (e) {
            console.error("error:", (e as Error).message);
        }
        process.stdout.write("» ");
    }
}

async function cmdHealth(): Promise<void> {
    console.log(JSON.stringify(await health(), null, 2));
}

async function cmdEval(expr: string): Promise<void> {
    const session = await ensureSession();
    // Hand-typed evals stand in for a human at the keyboard: carry user activation so
    // gesture-gated APIs (pointer lock, fullscreen) are reachable from the CLI.
    console.log(JSON.stringify(await pageEval(session, expr, { timeoutMs: 60_000, userGesture: true }), null, 2));
}

/** worker-eval <expr> — eval in the WORKER context (replaces cdp-worker-eval). */
async function cmdWorkerEval(expr: string): Promise<void> {
    const session = await ensureSession();
    console.log(JSON.stringify(await workerEval(session, expr, { timeoutMs: 60_000 }), null, 2));
}

/** stack [samples] — interrupt the worker and dump its call stack. The go-to probe
 *  when the worker is WEDGED (RPC dead, frozen frame): Debugger.pause interrupts even
 *  a synchronous infinite loop; repeated frames across samples = the hot loop. */
async function cmdStack(samplesArg?: string): Promise<void> {
    const session = await ensureSession();
    const stacks = await workerStack(session, { samples: samplesArg ? Number(samplesArg) : 3 });
    stacks.forEach((frames, i) => {
        console.log(`--- sample ${i + 1}/${stacks.length}`);
        for (const f of frames.slice(0, 30)) {
            const loc = f.url ? ` (${f.url.replace(/^.*\//, "")}:${f.line})` : "";
            console.log(`  ${f.functionName}${loc}`);
        }
        if (frames.length > 30) console.log(`  … ${frames.length - 30} more frames`);
    });
}

/**
 * fixture save|restore <name> [--container C] — a game's persisted profile (its
 * OPFS CoW overlay) as a checked-in artifact.
 *
 * Why the disk half lives here and not in a harness verb: the worker can reach
 * OPFS but not the filesystem, and the dev sidecar's writer is jailed to the log
 * dir (resolveSafeLogPath), so it can neither address fixtures/ nor keep a path
 * component containing a space.
 *
 * RESTORE BEFORE LOADING THE BUNDLE — a running game holds these files open.
 */
async function cmdFixture(mode: string, name: string, args: string[]): Promise<void> {
    if (!name) throw new Error("usage: fixture <save|restore> <name> [--container <id>]");
    const dir = `fixtures/${name}`;
    const flagAt = args.indexOf("--container");
    const flagContainer = flagAt >= 0 ? args[flagAt + 1] : "";
    const manifestPath = `${dir}/manifest.json`;

    if (mode === "save") {
        const container = flagContainer
            || (await Bun.file(manifestPath).exists() ? JSON.parse(await Bun.file(manifestPath).text()).container : "");
        if (!container) throw new Error("fixture save needs --container <id> (no manifest to inherit it from)");
        const listed = await harness().containerList(container).run();
        if (!listed.ok) throw new Error(`containerList failed: ${listed.error?.message}`);
        const files = (listed.named.containerList as { files: Array<{ path: string; size: number }> }).files;
        const saved: Array<{ path: string; bytes: number }> = [];
        for (const f of files) {
            const r = await harness().containerRead(container, f.path).run();
            if (!r.ok) throw new Error(`containerRead ${f.path} failed: ${r.error?.message}`);
            const { content } = r.named.containerRead as { content: string };
            await Bun.write(`${dir}${f.path}`, Buffer.from(content, "base64"));
            saved.push({ path: f.path, bytes: f.size });
        }
        const prior = await Bun.file(manifestPath).exists() ? JSON.parse(await Bun.file(manifestPath).text()) : {};
        await Bun.write(manifestPath, JSON.stringify(
            { container, files: files.map((f) => f.path), ...(prior.note ? { note: prior.note } : {}) }, null, 2,
        ) + "\n");
        console.log(JSON.stringify({ mode, container, dir, saved }, null, 2));
        return;
    }

    if (mode === "restore") {
        if (!(await Bun.file(manifestPath).exists())) throw new Error(`no fixture at ${manifestPath}`);
        const man = JSON.parse(await Bun.file(manifestPath).text()) as { container: string; files: string[] };
        const container = flagContainer || man.container;
        const done: Array<{ path: string; written: number }> = [];
        for (const p of man.files) {
            const bytes = new Uint8Array(await Bun.file(`${dir}${p}`).arrayBuffer());
            const r = await harness().containerWrite(container, p, Buffer.from(bytes).toString("base64")).run();
            if (!r.ok) throw new Error(`containerWrite ${p} failed: ${r.error?.message}`);
            done.push({ path: p, written: (r.named.containerWrite as { written: number }).written });
        }
        console.log(JSON.stringify({ mode, container, dir, done }, null, 2));
        return;
    }

    throw new Error(`unknown fixture mode '${mode}' (save|restore)`);
}

/** shot [out.png] [--verify] — page screenshot to a file (browser-side ground truth).
 *  With --verify it also pulls the worker's own `shot` (the canvas read from inside the
 *  worker) and compares the two, so the screenshot verb can report its own failure
 *  instead of handing back a plausible image. */
async function cmdShot(out: string, ...flags: string[]): Promise<void> {
    const session = await ensureSession();
    const b64 = await screenshot(session);
    const file = out && !out.startsWith("--") ? out : artifact("logs/harness-shot.png");
    await Bun.write(file, Buffer.from(b64, "base64"));
    console.log(`screenshot -> ${file} (${b64.length} b64 chars)`);
    if (out?.startsWith("--") || flags.includes("--verify")) await verifyShot(session);
}

/** Mean/max |Δluma| between two PNGs, both downscaled to a 32x32 grid in the page
 *  (the browser is the only decoder on hand, and it decodes both the same way). */
async function comparePngs(session: CdpSession, aB64: string, bB64: string): Promise<{ mean: number; max: number } | null> {
    const r = (await pageEval(session, `(async () => {
        const grid = async (b64) => {
            const bin = atob(b64); const u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            const bmp = await createImageBitmap(new Blob([u8], { type: 'image/png' }));
            const c = new OffscreenCanvas(32, 32); const x = c.getContext('2d');
            x.drawImage(bmp, 0, 0, 32, 32);
            const d = x.getImageData(0, 0, 32, 32).data; const g = new Float64Array(1024);
            for (let i = 0; i < 1024; i++) g[i] = 0.299*d[i*4] + 0.587*d[i*4+1] + 0.114*d[i*4+2];
            return g;
        };
        const [a, b] = await Promise.all([grid(${JSON.stringify(aB64)}), grid(${JSON.stringify(bB64)})]);
        let sum = 0, max = 0;
        for (let i = 0; i < 1024; i++) { const d = Math.abs(a[i] - b[i]); sum += d; if (d > max) max = d; }
        return { mean: sum / 1024, max };
    })()`, { timeoutMs: 20_000, awaitPromise: true })) as { mean: number; max: number; error?: string } | null;
    return r && !r.error ? r : null;
}

/**
 * Cross-check every route to "the screen" against the browser's own capture of the
 * canvas: the worker `shot` (source 'screen') and, when the presenter has one, its
 * pre-composite layer (source 'layer').
 *
 * Why it exists: the worker capture and the CDP capture are INDEPENDENT routes to the
 * same pixels, so a disagreement means the worker route is not looking at the screen —
 * the failure that let `shot()` show a game frame while the canvas held a grey dialog.
 * The 'layer' line is the standing proof that the check can go red: a composited frame
 * MUST show the layer disagreeing while the screen agrees.
 */
async function verifyShot(session: CdpSession): Promise<void> {
    const geo = await readCanvasGeometry(session);
    // Freeze the guest so every capture describes the SAME frame; a moving picture
    // would produce a difference that says nothing about the capture route.
    const paused = await execViaCdp([{ cmd: "pause", args: [] } as unknown as HarnessStep])
        .then((r) => r.ok).catch(() => false);
    try {
        type Shot = { base64?: string; source?: string; width?: number; height?: number };
        const runShot = async (args: Record<string, unknown>): Promise<Shot | string> => {
            const r = await execViaCdp([{ cmd: "shot", args: [args] } as unknown as HarnessStep]);
            return r.steps?.[0]?.ok ? (r.steps[0].result as Shot) : (r.steps?.[0]?.error?.message ?? "failed");
        };
        const screen = await runShot({});
        const clip = { x: Math.max(0, geo.rect.x), y: Math.max(0, geo.rect.y), width: geo.rect.w, height: geo.rect.h, scale: 1 };
        const shotPage = async () => (await session.send("Page.captureScreenshot", { format: "png", clip })).result?.data ?? "";
        // Two CDP captures back to back measure how much the screen moves on its own
        // (a paused guest can still re-present, and an animated overlay never stops). That
        // churn is the noise floor: below it no comparison can decide anything, and an
        // instrument that ignores it reports "DISAGREE" for a screen that merely moved.
        const pageA = await shotPage();
        const pageB64 = await shotPage();
        if (!pageB64 || !pageA) { console.log("verify: CDP capture returned nothing"); return; }
        const churn = (await comparePngs(session, pageA, pageB64)) ?? { mean: 0, max: 0 };
        const moving = churn.mean >= 8 || churn.max >= 48;
        console.log(`verify: screen churn between two CDP captures — mean|d|=${churn.mean.toFixed(1)} max|d|=${churn.max.toFixed(1)}` +
            (moving ? " (screen is MOVING — comparisons below can only be inconclusive; pause presents for a decisive check)" : ""));

        // mean 8/255 tolerates PNG/CSS rescaling of the whole frame; the max threshold is
        // what catches a LOCALIZED difference — a composited dialog or panel covering a
        // few cells barely moves the mean, and that is exactly the failure class here.
        // Identical images measure 0.0 on both, so the headroom is large.
        const line = async (label: string, shot: Shot | string) => {
            if (typeof shot === "string" || !shot.base64) { console.log(`verify: ${label} — unavailable (${shot})`); return; }
            const cmp = await comparePngs(session, shot.base64, pageB64);
            if (!cmp) { console.log(`verify: ${label} — compare failed`); return; }
            const agree = cmp.mean < 8 && cmp.max < 48;
            const verdict = agree ? "AGREE"
                : moving || cmp.mean <= churn.mean * 1.5 ? "INCONCLUSIVE (difference is within the screen's own churn)"
                    : "DISAGREE (this is NOT what is on screen)";
            console.log(`verify: ${label} (${shot.width}x${shot.height}) vs CDP canvas capture — ` +
                `mean|d|=${cmp.mean.toFixed(1)} max|d|=${cmp.max.toFixed(1)} → ${verdict}`);
        };
        await line("shot() source=screen", screen);
        await line("shot({source:'layer'}) pre-composite", await runShot({ source: "layer" }));
    } finally {
        if (paused) await execViaCdp([{ cmd: "resume", args: [] } as unknown as HarnessStep]).catch(() => {});
    }
}

/**
 * gridShot [out.png] [step] — screenshot the guest canvas with a semi-transparent
 * coordinate grid overlaid, labelled in GUEST PIXELS (the exact space clickAt(x,y)
 * injects into). For DDraw/D3D games the UI is painted into the surface with no
 * Win32 controls to target by name — read a feature's coords off the grid, then
 * `clickAt <x> <y>`. Any live Win32 dialog controls are also outlined with their
 * clickable center labelled. The image is clipped to the canvas so labels stay legible.
 */
async function cmdGridShot(out: string, stepArg?: string): Promise<void> {
    const session = await ensureSession();
    const step = stepArg ? Number(stepArg) : 0;
    // Same guest↔CSS mapping the touch verbs aim with (cdp-geometry) — the grid
    // labels would otherwise be a second, drifting copy of it.
    const geo = await readCanvasGeometry(session);
    const inject = `(() => {
        const r = ${JSON.stringify(geo.rect)}, sx = ${geo.scale.x}, sy = ${geo.scale.y};
        const gw = ${geo.guest.w}, gh = ${geo.guest.h}, dpr = ${geo.dpr};
        const old = document.getElementById('__bs_grid_overlay'); if (old) old.remove();
        const niceStep = (n) => { const t = n / 12; for (const s of [10,20,25,50,100,200,250,500]) if (s >= t) return s; return 1000; };
        const stp = ${step} > 0 ? ${step} : niceStep(Math.max(gw, gh));
        const ov = document.createElement('canvas'); ov.id = '__bs_grid_overlay';
        Object.assign(ov.style, { position:'fixed', left:r.x+'px', top:r.y+'px', width:r.w+'px', height:r.h+'px', pointerEvents:'none', zIndex:2147483647 });
        ov.width = Math.round(r.w*dpr); ov.height = Math.round(r.h*dpr);
        const c = ov.getContext('2d'); c.scale(dpr, dpr);
        c.font = '11px monospace'; c.textBaseline = 'top'; c.lineWidth = 1;
        for (let gx=0; gx<=gw; gx+=stp) { const px=gx*sx; c.strokeStyle='rgba(0,234,255,0.30)'; c.beginPath(); c.moveTo(px,0); c.lineTo(px,r.h); c.stroke();
            c.fillStyle='rgba(0,0,0,0.6)'; c.fillRect(px+1,0,String(gx).length*7+2,12); c.fillStyle='#0ef'; c.fillText(String(gx), px+2, 1); }
        for (let gy=0; gy<=gh; gy+=stp) { const py=gy*sy; c.strokeStyle='rgba(0,234,255,0.30)'; c.beginPath(); c.moveTo(0,py); c.lineTo(r.w,py); c.stroke();
            c.fillStyle='rgba(0,0,0,0.6)'; c.fillRect(0,py+1,String(gy).length*7+2,12); c.fillStyle='#0ef'; c.fillText(String(gy), 1, py+2); }
        let controls = [];
        // dialogs() may be async (RPC) → only use a synchronously-available array.
        try { const d = window.__BS__.harness.dialogs && window.__BS__.harness.dialogs(); if (Array.isArray(d)) controls = d; } catch (e) {}
        for (const ctl of controls) {
            if (!ctl || typeof ctl.x !== 'number') continue;
            const x=ctl.x*sx, y=ctl.y*sy, w=(ctl.w||0)*sx, h=(ctl.h||0)*sy;
            c.strokeStyle='rgba(255,210,0,0.9)'; c.strokeRect(x,y,w,h);
            const cx=(ctl.cx!=null?ctl.cx:ctl.x+(ctl.w||0)/2), cy=(ctl.cy!=null?ctl.cy:ctl.y+(ctl.h||0)/2);
            const lbl=(ctl.text||ctl.cls||'')+' ('+Math.round(cx)+','+Math.round(cy)+')';
            c.fillStyle='rgba(0,0,0,0.7)'; c.fillRect(x, y-12, c.measureText(lbl).width+4, 12); c.fillStyle='#fd0'; c.fillText(lbl, x+2, y-12);
            c.fillStyle='#fd0'; c.beginPath(); c.arc(cx*sx, cy*sy, 3, 0, 7); c.fill();
        }
        document.body.appendChild(ov);
        return { ok:true, step:stp, controls:controls.length };
    })()`;
    const meta = (await pageEval(session, inject, { timeoutMs: 10_000 })) as any;
    if (!meta || meta.error) { console.error("gridShot:", meta?.error || "failed"); return; }
    // Clip to the canvas (+a little headroom for top-edge labels). Capture at a
    // scale that brings the output up to ~guest resolution so the px labels stay
    // crisp even when the on-screen canvas is shrunk to fit the viewport.
    const pad = 14;
    const scale = Math.max(1, Math.min(3, Math.round((geo.guest.w / Math.max(1, geo.rect.w)) * 10) / 10));
    const clip = { x: Math.max(0, geo.rect.x), y: Math.max(0, geo.rect.y - pad), width: geo.rect.w, height: geo.rect.h + pad, scale };
    const shot = await session.send("Page.captureScreenshot", { format: "png", clip });
    const file = out || artifact("logs/harness-gridshot.png");
    await Bun.write(file, Buffer.from(shot.result?.data ?? "", "base64"));
    await pageEval(session, "(()=>{const o=document.getElementById('__bs_grid_overlay');if(o)o.remove();return 1})()", { timeoutMs: 5000 }).catch(() => {});
    console.log(`gridShot -> ${file}  guest=${geo.guest.w}x${geo.guest.h} step=${meta.step}px controls=${meta.controls}`);
    console.log(`  read a feature's (x,y) off the grid (GUEST pixels), then: bun tools/harness.ts clickAt <x> <y>`);
}

/** trace <seconds> [out.json.gz] — capture a Chrome perf trace for tools/analyze-trace.ts.
 *  Drive the game into the state you want FIRST; this only records.
 *
 *  Refuses to run while a second guest is open: tracing is a BROWSER-level domain (it
 *  records every renderer), and two guests share the CPU, so both the trace contents and
 *  any timing read off it describe a machine nobody was measuring. Parallel sessions are
 *  a bring-up tool; measurement is single-tab. `BS_ALLOW_PARALLEL_TRACE=1` to override. */
async function cmdTrace(secondsArg?: string, out?: string): Promise<void> {
    const seconds = Number(secondsArg ?? 10);
    const tabs = await listSessionTabs().catch(() => []);
    if (tabs.length > 1 && process.env.BS_ALLOW_PARALLEL_TRACE !== "1") {
        throw new Error(
            `refusing to trace: ${tabs.length} guest tabs are open (${tabs.map((t) => t.url.slice(-40)).join(", ")}).\n` +
            "  A Chrome trace is browser-wide and parallel guests share the CPU — the numbers would be noise.\n" +
            "  Close the other sessions' tabs, or set BS_ALLOW_PARALLEL_TRACE=1 if you really only want the trace shape.",
        );
    }
    const file = out ?? artifact(`logs/trace-${seconds}s.json.gz`);
    console.log(`tracing ${seconds}s -> ${file} …`);
    // Arm the guest-attribution mark INSIDE the window: without bottleship.hotblocks every
    // wasm frame in the artifact stays an opaque wasm-function[N] (v86's table indices do not
    // match Chrome's numbering, so the join is sampled, never computed) and the trace analyses
    // shallow while looking complete.
    let hotBlocks: { blocks?: number; marked?: boolean; note?: string } | null = null;
    const sampleMs = Math.min(3000, Math.max(800, (seconds * 1000) / 4));
    const r = await captureTrace(file, seconds, {
        during: async () => {
            try {
                const res = await execViaCdp([{ cmd: "hotBlocksMark", args: [{ ms: sampleMs }], opts: { timeoutMs: sampleMs + 30_000 } } as unknown as HarnessStep]);
                hotBlocks = (res.steps?.[0]?.result ?? null) as typeof hotBlocks;
            } catch (e) {
                console.warn(`  hotBlocksMark failed (guest attribution will be unavailable): ${e}`);
            }
        },
    });
    console.log(`  ${r.events} events, ${(r.bytes / 1024 / 1024).toFixed(1)} MB`);
    if (hotBlocks?.marked) console.log(`  bottleship.hotblocks: ${hotBlocks.blocks} blocks — wasm frames resolve to module:rva`);
    else console.log(`  bottleship.hotblocks: NOT emitted${hotBlocks?.note ? ` (${hotBlocks.note})` : ""} — guest attribution will read UNAVAILABLE`);
    console.log(`  analyze: bun tools/analyze-trace.ts ${file} --thread worker --top 40`);
}

/** reload — hard-reload the page (replaces cdp-reload; HMR is off, so reload to pick up worker edits). */
async function cmdReload(): Promise<void> {
    const session = await ensureSession();
    await reloadPageAndWait(session);
    console.log("page reloaded (harness ready)");
}

/** Run a single harness cmd and pretty-print its result (report/stubs/backtrace).
 *  Numeric args (e.g. an esp) are parsed; everything else passes through. */
async function cmdSingle(cmd: string, rest: string[]): Promise<void> {
    const args = rest.map((a) => {
        if (/^0x[0-9a-f]+$/i.test(a)) return parseInt(a, 16);
        if (/^\d+$/.test(a)) return Number(a);
        if (/^[[{]/.test(a)) { try { return JSON.parse(a); } catch { return a; } } // {"continuous":true} etc.
        return a;
    });
    const result = await execViaCdp([{ cmd, args } as unknown as HarnessStep]);
    console.log(JSON.stringify(result.steps?.[0]?.result ?? result, null, 2));
}

async function main(): Promise<void> {
    const [, , cmd, ...rest] = process.argv;
    switch (cmd) {
        case "up": await cmdUp(); break;
        case "run": await cmdRun(rest[0]); break;
        case "repl": await cmdRepl(); break;
        case "health": await cmdHealth(); break;
        case "eval": await cmdEval(rest.join(" ")); break;
        case "worker-eval": await cmdWorkerEval(rest.join(" ")); break;
        case "stack": await cmdStack(rest[0]); break;
        case "fixture": await cmdFixture(rest[0], rest[1], rest.slice(2)); break;
        case "shot": await cmdShot(rest[0], ...rest.slice(1)); break;
        case "gridShot": case "gridshot": await cmdGridShot(rest[0], rest[1]); break;
        case "trace": await cmdTrace(rest[0], rest[1]); break;
        case "reload": await cmdReload(); break;
        case undefined:
            console.log("usage: bun tools/harness.ts <up|run <script>|repl|health|eval <expr>|worker-eval <expr>|fixture <save|restore> <name> [--container <id>]|shot [out.png] [--verify]|gridShot [out.png] [step]|trace <sec> [out.json.gz]|reload|device <profile>|tap <x> <y>|<any-harness-command> [args...]>");
            process.exit(0);
            break;
        // Any other token is dispatched as a harness RPC command (report, stubs, backtrace,
        // readBytes, faults, state, regGet, …) with hex/decimal arg coercion.
        default: await cmdSingle(cmd, rest); break;
    }
    _session?.close();
}

// Only run the CLI when invoked directly (not when imported by a .harness.ts script).
if (import.meta.main) {
    main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
