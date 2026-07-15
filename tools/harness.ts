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
 * list to `window.__BS__.harness.__runSteps` in the page over a single CDP eval.
 */

import {
    launchOrAttachChrome,
    findOrCreateTab,
    connect,
    pageEval,
    workerEval,
    workerStack,
    screenshot,
    health,
    CdpSession,
    DEFAULT_DEV_URL,
} from "./cdp-core";
import { HarnessChain } from "../src/harness/dsl";
import type { HarnessStep, HarnessRunResult } from "../src/harness/types";
import { runResultToJournal } from "../src/harness/journal";

let _session: CdpSession | null = null;

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

/** CLI-side step executor: ship the step list to the page and return its POJO,
 *  then write a re-runnable journal artifact. */
async function execViaCdp(steps: HarnessStep[]): Promise<HarnessRunResult> {
    const session = await ensureSession();
    const pageSteps = steps.filter((s) => s.cmd !== "reload");
    const preflight: HarnessRunResult = { ok: true, steps: [], named: {} };

    if (steps.some((s) => s.cmd === "reload")) {
        const t0 = Date.now();
        try {
            await reloadPageAndWait(session);
            const sr = { cmd: "reload", ok: true as const, result: { reloaded: true }, ms: Date.now() - t0 };
            preflight.steps.push(sr);
            preflight.named.reload = sr.result;
        } catch (err) {
            const e = err as Error;
            preflight.ok = false;
            preflight.steps.push({
                cmd: "reload",
                ok: false,
                error: { message: e.message },
                ms: Date.now() - t0,
            });
            preflight.error = { message: e.message, atStep: 0, cmd: "reload" };
            return preflight;
        }
    }

    if (pageSteps.length === 0) return preflight;

    // Double-stringify so the steps reach the page as a string the page JSON.parses
    // (avoids brittle expression escaping).
    const payload = JSON.stringify(JSON.stringify(pageSteps));
    const expr = `window.__BS__ && window.__BS__.harness ? window.__BS__.harness.__runSteps(JSON.parse(${payload})) : Promise.reject(new Error('harness facade not installed (open ?game=dev)'))`;
    // Generous timeout: chains can include long waits (tickFrames, waitForEvent).
    const result = (await pageEval(session, expr, { timeoutMs: 300_000 })) as HarnessRunResult;
    if (preflight.steps.length > 0) {
        result.steps = [...preflight.steps, ...result.steps];
        result.named = { ...preflight.named, ...result.named };
        if (preflight.error) {
            result.ok = false;
            result.error = preflight.error;
        }
    }
    try {
        const file = `logs/harness/run-${++_journalSeq}.harness.ts`;
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
    await launchOrAttachChrome({ autoplay: true });
    const tab = await findOrCreateTab(DEFAULT_DEV_URL);
    const session = await CdpSession.connect(tab.webSocketDebuggerUrl);
    _session = session;
    await waitForHarnessReady(session);
    const h = await health();
    console.log("[harness up] services:", JSON.stringify(h));
    const ping = await pageEval(session, "window.__BS__.harness.ping()", { timeoutMs: 8000 }).catch((e) => ({ error: String(e) }));
    console.log("[harness up] worker ping:", JSON.stringify(ping));
    console.log(`[harness up] ready — tab ${tab.id} (${tab.url})`);
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
    console.log(JSON.stringify(await pageEval(session, expr, { timeoutMs: 60_000 }), null, 2));
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

/** shot [out.png] — page screenshot to a file (replaces cdp-shot). */
async function cmdShot(out: string): Promise<void> {
    const session = await ensureSession();
    const b64 = await screenshot(session);
    const file = out || "logs/harness-shot.png";
    await Bun.write(file, Buffer.from(b64, "base64"));
    console.log(`screenshot -> ${file} (${b64.length} b64 chars)`);
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
    const inject = `(() => {
        const cv = document.querySelector('.app__canvas');
        if (!cv) return { error: 'no .app__canvas element' };
        const r = cv.getBoundingClientRect();
        // Guest surface dims (the space clickAt injects into). Prefer the explicit
        // global; fall back to the inline style.width/height App sets to guest px
        // (a transferred OffscreenCanvas reports width=0 on the main thread).
        const styW = parseFloat(cv.style.width) || 0, styH = parseFloat(cv.style.height) || 0;
        const gr = (window.__BS__ && window.__BS__.guestResolution) || (styW && styH ? { width: styW, height: styH } : { width: cv.width || 1024, height: cv.height || 768 });
        const gw = Math.max(1, gr.width), gh = Math.max(1, gr.height);
        const old = document.getElementById('__bs_grid_overlay'); if (old) old.remove();
        const niceStep = (n) => { const t = n / 12; for (const s of [10,20,25,50,100,200,250,500]) if (s >= t) return s; return 1000; };
        const stp = ${step} > 0 ? ${step} : niceStep(Math.max(gw, gh));
        const ov = document.createElement('canvas'); ov.id = '__bs_grid_overlay';
        Object.assign(ov.style, { position:'fixed', left:r.left+'px', top:r.top+'px', width:r.width+'px', height:r.height+'px', pointerEvents:'none', zIndex:2147483647 });
        const dpr = window.devicePixelRatio || 1;
        ov.width = Math.round(r.width*dpr); ov.height = Math.round(r.height*dpr);
        const c = ov.getContext('2d'); c.scale(dpr, dpr);
        const sx = r.width/gw, sy = r.height/gh;
        c.font = '11px monospace'; c.textBaseline = 'top'; c.lineWidth = 1;
        for (let gx=0; gx<=gw; gx+=stp) { const px=gx*sx; c.strokeStyle='rgba(0,234,255,0.30)'; c.beginPath(); c.moveTo(px,0); c.lineTo(px,r.height); c.stroke();
            c.fillStyle='rgba(0,0,0,0.6)'; c.fillRect(px+1,0,String(gx).length*7+2,12); c.fillStyle='#0ef'; c.fillText(String(gx), px+2, 1); }
        for (let gy=0; gy<=gh; gy+=stp) { const py=gy*sy; c.strokeStyle='rgba(0,234,255,0.30)'; c.beginPath(); c.moveTo(0,py); c.lineTo(r.width,py); c.stroke();
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
        return { ok:true, rect:{ x:r.left, y:r.top, w:r.width, h:r.height }, guest:{ w:gw, h:gh }, step:stp, controls:controls.length };
    })()`;
    const meta = (await pageEval(session, inject, { timeoutMs: 10_000 })) as any;
    if (!meta || meta.error) { console.error("gridShot:", meta?.error || "failed"); return; }
    // Clip to the canvas (+a little headroom for top-edge labels). Capture at a
    // scale that brings the output up to ~guest resolution so the px labels stay
    // crisp even when the on-screen canvas is shrunk to fit the viewport.
    const pad = 14;
    const scale = Math.max(1, Math.min(3, Math.round((meta.guest.w / Math.max(1, meta.rect.w)) * 10) / 10));
    const clip = { x: Math.max(0, meta.rect.x), y: Math.max(0, meta.rect.y - pad), width: meta.rect.w, height: meta.rect.h + pad, scale };
    const shot = await session.send("Page.captureScreenshot", { format: "png", clip });
    const file = out || "logs/harness-gridshot.png";
    await Bun.write(file, Buffer.from(shot.result?.data ?? "", "base64"));
    await pageEval(session, "(()=>{const o=document.getElementById('__bs_grid_overlay');if(o)o.remove();return 1})()", { timeoutMs: 5000 }).catch(() => {});
    console.log(`gridShot -> ${file}  guest=${meta.guest.w}x${meta.guest.h} step=${meta.step}px controls=${meta.controls}`);
    console.log(`  read a feature's (x,y) off the grid (GUEST pixels), then: bun tools/harness.ts clickAt <x> <y>`);
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
        case "shot": await cmdShot(rest[0]); break;
        case "gridShot": case "gridshot": await cmdGridShot(rest[0], rest[1]); break;
        case "reload": await cmdReload(); break;
        case undefined:
            console.log("usage: bun tools/harness.ts <up|run <script>|repl|health|eval <expr>|worker-eval <expr>|shot [out.png]|gridShot [out.png] [step]|reload|<any-harness-command> [args...]>");
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
