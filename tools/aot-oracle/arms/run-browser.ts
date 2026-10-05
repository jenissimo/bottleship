#!/usr/bin/env bun
/**
 * aot-oracle ARM — stock browser.
 *
 * The plan accepts a performance result only from an uninstrumented fixed-work run in a browser.
 * This drives one: it serves the repo over loopback, opens the arm page in Chrome, and prints the
 * same JSON the Node arm prints.
 *
 * It brings its OWN server and its own Chrome profile rather than reusing the harness's. A shared
 * dev server is a shared queue, and a shared browser is a shared CPU — both are exactly what a
 * timing run must not have.
 *
 *   bun tools/aot-oracle/arms/run-browser.ts --case k3 [--outer N] [--warmup W] [--unit u.json]
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const REPO = path.resolve(import.meta.dir, "../../..");
const argv = process.argv.slice(2);
const argOf = (name: string, dflt: string | null = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
};

const CASE = argOf("case", "k3")!;
const OUTER = argOf("outer", "1000000")!;
const WARMUP = argOf("warmup", "1000000")!;
const UNIT = argOf("unit", null);
const KEEP = argv.includes("--keep-open");
const TIMEOUT_MS = Number(argOf("timeout", "600000"));
/**
 * Rounds, each one reference run and one unit run, alternating, in ONE page.
 *
 * A round builds a fresh emulator for each arm — a reused one is a warmed one — but shares the
 * browser process, its Wasm tiering and its power state. Measuring the arms in separate browsers
 * put the difference between two Chrome processes inside the ratio: the reference spread was 21%
 * and the number was rightly withheld.
 */
const ROUNDS = Number(argOf("rounds", "1"));

const WASM = path.join(REPO, "vendor/v86/build/v86.wasm");
const LIB = path.join(REPO, "vendor/v86/build/libv86.mjs");
for (const p of [WASM, LIB]) {
    if (!fs.existsSync(p)) {
        console.error(`missing ${p} — build the fork first`);
        process.exit(2);
    }
}
const engineSha = crypto.createHash("sha256").update(fs.readFileSync(WASM)).digest("hex");

/**
 * A unit's manifest and its wasm live wherever the caller built them, which is usually outside the
 * repo. They are copied into a served directory rather than the server being taught to escape its
 * root: a timing harness that can serve arbitrary paths over loopback is a worse thing to own.
 */
const served = fs.mkdtempSync(path.join(REPO, "tmp", "oracle-browser-"));
let unitUrl: string | null = null;
if (UNIT) {
    const manifest = JSON.parse(fs.readFileSync(UNIT, "utf8"));
    const from = path.dirname(path.resolve(UNIT));
    fs.writeFileSync(path.join(served, "unit.json"), JSON.stringify(manifest));
    for (const u of manifest.units ?? []) {
        fs.copyFileSync(path.join(from, u.file), path.join(served, u.file));
    }
    unitUrl = `/${path.relative(REPO, served).replaceAll("\\", "/")}/unit.json`;
}

const MIME: Record<string, string> = {
    ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript",
    ".json": "application/json", ".wasm": "application/wasm",
};

const server = Bun.serve({
    port: 0,
    fetch(req) {
        const url = new URL(req.url);
        const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
        const file = path.resolve(REPO, rel);
        // Confined to the repo: a loopback server is still a server.
        if (!file.startsWith(REPO + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            return new Response("not found", { status: 404 });
        }
        return new Response(Bun.file(file), {
            headers: { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" },
        });
    },
});

const page = `http://127.0.0.1:${server.port}/tools/aot-oracle/browser/arm.html`
    + `?case=${CASE}&outer=${OUTER}&warmup=${WARMUP}&rounds=${ROUNDS}&engineSha=${engineSha}`
    + (unitUrl ? `&unit=${encodeURIComponent(unitUrl)}` : "");

const profile = fs.mkdtempSync(path.join(REPO, "tmp", "oracle-chrome-"));
const CHROME = process.env.BS_CHROME
    ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const port = 9400 + Math.floor(Math.random() * 200);
/**
 * V8 flags for DIAGNOSIS only.
 *
 * A run with these is not a stock browser and cannot produce an accepted performance number; it
 * exists to answer why a module that is fast in Node is not fast here. The flag used is printed
 * in the result so a number can never be quoted without it.
 */
const JS_FLAGS = argOf("js-flags", null);
const chrome = spawn(CHROME, [
    ...(JS_FLAGS ? [`--js-flags=${JS_FLAGS}`] : []),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    // The guest never yields to the event loop between markers; a throttled renderer would
    // measure the browser's power policy instead of the engine.
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    page,
], { stdio: "ignore", detached: false });

const cleanup = () => {
    try { chrome.kill(); } catch { /* already gone */ }
    try { server.stop(true); } catch { /* already stopped */ }
    if (!KEEP) {
        for (const dir of [served, profile]) {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    }
};

/** Chrome takes a moment to open its debugging port; a refused connection is not a failure yet. */
async function targets(): Promise<any[]> {
    for (let i = 0; i < 100; i++) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/json/list`);
            const list = await r.json();
            const pages = list.filter((t: any) => t.type === "page" && t.url.includes("arm.html"));
            if (pages.length) return pages;
        } catch { /* not listening yet */ }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("chrome never exposed the arm page");
}

const [target] = await targets();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
    ws.onopen = () => resolve(null);
    ws.onerror = (e) => reject(new Error(`cdp connect: ${String(e)}`));
});

let nextId = 1;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
    }
};
const send = (method: string, params: any = {}) => new Promise<any>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
});

// A page that never sets a result has usually thrown, and a driver that only reports "no result"
// hides the one line that says why. So exceptions and console errors are collected from the start.
const pageErrors: string[] = [];
ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
        return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails;
        pageErrors.push(d?.exception?.description ?? d?.text ?? JSON.stringify(d).slice(0, 300));
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
        pageErrors.push((msg.params.args ?? []).map((a: any) => a.value ?? a.description).join(" "));
    }
};
await send("Runtime.enable");

/** Wait for the page to publish a result, or say what it threw instead. */
async function collect(): Promise<any> {
    const started = Date.now();
    while (Date.now() - started < TIMEOUT_MS) {
        const r = await send("Runtime.evaluate", {
            expression: "window.__ORACLE_RESULT__ ? JSON.stringify(window.__ORACLE_RESULT__) : null",
            returnByValue: true,
        });
        const value = r?.result?.result?.value;
        if (typeof value === "string") return JSON.parse(value);
        await new Promise((r) => setTimeout(r, 500));
    }
    const r = await send("Runtime.evaluate", {
        expression: "document.body.innerText.slice(0, 2000)", returnByValue: true,
    });
    return {
        arm: UNIT ? "unit" : "reference", impl: "v86-browser", case: CASE,
        status: "DRIVER_TIMEOUT", errors: pageErrors, page: r?.result?.result?.value ?? null,
    };
}

const result = await collect();
cleanup();
console.log(JSON.stringify({ ...result, js_flags: JS_FLAGS }));
process.exit(result.status === "ok" ? 0 : 3);
