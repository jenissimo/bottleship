#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { harness, closeHarnessConnection } from "../../harness";
import { cdpSession, DEFAULT_CDP_PORT, listTargets, findTab } from "../../cdp-core";
import { judgeStackReport, hostGuestQuiescent, noLoadedModules } from "./browser-stack.mjs";

const REPO = path.resolve(import.meta.dir, "../../..");
const argv = process.argv.slice(2);
const arg = (name: string, fallback: string | null = null) => {
    const at = argv.indexOf(`--${name}`);
    return at < 0 ? fallback : argv[at + 1];
};
const sha = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function evaluate(expression: string) {
    const result = await harness().evalPage(expression, 15_000).run();
    if (!result.ok) throw new Error(result.error?.message ?? "harness page evaluation failed");
    return result.named.evalPage as any;
}

const guestProbe = `Promise.all([
    window.__BS__.harness.rpc('ping',[],{timeoutMs:5000,target:'root'}),
    window.__BS__.harness.rpc('state',[['cpu','threads','modules']],{timeoutMs:5000,target:'root'})
]).then(([ping,state])=>({ping,state}))`;

function stageUnit(source: string, name: string, directory: string): string {
    const sourcePath = path.resolve(source);
    const from = path.dirname(sourcePath);
    const manifest = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    const to = path.join(directory, name);
    fs.mkdirSync(to, { recursive: true });
    for (const unit of manifest.units ?? []) {
        const relative = String(unit.file);
        const sourceFile = path.resolve(from, relative);
        const destination = path.resolve(to, relative);
        if (!sourceFile.startsWith(from + path.sep) || !destination.startsWith(to + path.sep)) {
            throw new Error(`unit file escapes manifest directory: ${relative}`);
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(sourceFile, destination);
    }
    fs.writeFileSync(path.join(to, "unit.json"), JSON.stringify(manifest));
    return `/${path.relative(REPO, to).replaceAll("\\", "/")}/unit.json`;
}

function chromeCommandLine(): string | null {
    if (process.platform !== "win32") return null;
    const script = `Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -match '--remote-debugging-port=${DEFAULT_CDP_PORT}(?:\\s|$)' } | Select-Object -ExpandProperty CommandLine`;
    const result = Bun.spawnSync(["powershell", "-NoProfile", "-Command", script], { stdout: "pipe", stderr: "pipe" });
    return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() || null : null;
}

async function main() {
    if (argv.includes("--help")) {
        console.log("BS_TAB=<own-id> bun tools/aot/opt/stack-browser.ts --base base.json --candidate stack.json [--identity base-copy.json] [--direct-module /tmp/.../reference.mjs] [--fresh-sample-workers] [--outer 100000] [--warmup 100000] [--rounds 6] [--out report.json]");
        return;
    }
    const base = arg("base"), candidate = arg("candidate");
    if (!base || !candidate) throw new Error("--base and --candidate manifests are required");
    const beforeTargets = await listTargets();
    const own = await findTab();
    const otherPages = beforeTargets.filter((t) => t.type === "page" && t.id !== own.id && t.url !== "about:blank");
    if (otherPages.length && !argv.includes("--diagnostic")) {
        throw new Error(`measurement needs one browser page; other pages: ${otherPages.map((p) => p.url).join(", ")}`);
    }
    const preflight = await evaluate(`({harness:!!window.__BS__?.harness, visibility:document.visibilityState,
        url:location.href, running:!!window.__STACK_EXPERIMENT_WORKER__})`);
    if (!preflight.harness || preflight.running) throw new Error("own harness page unavailable or experiment already running");
    if (new URL(preflight.url).searchParams.get("game") !== "dev") throw new Error("measurement requires own game=dev page");
    const guestInitial = await evaluate(guestProbe);
    if (!noLoadedModules(guestInitial)) throw new Error("own harness page has loaded modules; measurement requires an empty game=dev page");
    const hostPause = guestInitial.ping?.hasProcess === true
        ? await evaluate("window.__BS__.harness.rpc('pause',[],{timeoutMs:5000,target:'root'})") : null;
    const guestBefore = hostPause ? await evaluate(guestProbe) : guestInitial;
    if (!hostGuestQuiescent(guestBefore) || !noLoadedModules(guestBefore)) {
        throw new Error("host guest did not reach canonical paused state with no loaded modules");
    }
    const directory = path.join(REPO, "tmp", `stack-browser-${crypto.randomUUID()}`);
    fs.mkdirSync(directory, { recursive: true });
    const engineDirectory = path.resolve(arg("engine-dir", "vendor/v86/build")!);
    if (!engineDirectory.startsWith(REPO + path.sep)) throw new Error("engine directory must be served inside the repository");
    const commandLine = chromeCommandLine();
    const directModuleUrl = arg("direct-module");
    const directWasmUrl = arg("direct-wasm", directModuleUrl?.replace(/\.mjs$/, ".wasm") ?? null);
    const publicDirectory = path.join(REPO, "public");
    const localUrl = (url: string) => {
        const file = path.resolve(REPO, "." + url);
        if (!url.startsWith("/") || !file.startsWith(REPO + path.sep)) throw new Error("reference URL must be served inside repository");
        if (fs.existsSync(file)) return file;
        const publicFile = path.resolve(publicDirectory, "." + url);
        if (!publicFile.startsWith(publicDirectory + path.sep)) throw new Error("reference URL escapes public directory");
        return publicFile;
    };
    let provenance: any = null;
    let directReference: any = null;
    if (directModuleUrl) {
        const modulePath = localUrl(directModuleUrl), wasmPath = localUrl(directWasmUrl!);
        const originalModuleSha = sha(modulePath), originalWasmSha = sha(wasmPath);
        const buildPath = path.join(path.dirname(modulePath), "build.json");
        if (fs.existsSync(buildPath)) {
            provenance = { path: buildPath, sha256: sha(buildPath), build: JSON.parse(fs.readFileSync(buildPath, "utf8")) };
            for (const url of [directModuleUrl, directWasmUrl!]) {
                const expected = provenance.build.artifacts?.[path.basename(url)]?.sha256;
                if (expected && expected !== sha(localUrl(url))) throw new Error(`build.json artifact hash differs: ${url}`);
            }
        }
        // Public assets bypass Vite's module transform, preserving the compiler artifact bytes.
        const staged = ![modulePath, wasmPath].every((file) => file.startsWith(publicDirectory + path.sep));
        const servedDirectory = staged ? path.join(publicDirectory, "apps", ".stack-lab", crypto.randomUUID()) : path.dirname(modulePath);
        fs.mkdirSync(servedDirectory, { recursive: true });
        const servedModulePath = staged ? path.join(servedDirectory, path.basename(modulePath)) : modulePath;
        const servedWasmPath = staged ? path.join(servedDirectory, path.basename(wasmPath)) : wasmPath;
        if (staged) {
            fs.copyFileSync(modulePath, servedModulePath);
            fs.copyFileSync(wasmPath, servedWasmPath);
        }
        const moduleSha = sha(servedModulePath), wasmSha = sha(servedWasmPath);
        if (moduleSha !== originalModuleSha || wasmSha !== originalWasmSha) throw new Error("staged reference artifact hashes differ from originals");
        const servedUrl = (file: string) => "/" + path.relative(publicDirectory, file).replaceAll("\\", "/");
        if (provenance) {
            const servedBuildPath = staged ? path.join(servedDirectory, "build.json") : buildPath;
            if (staged) fs.copyFileSync(buildPath, servedBuildPath);
            const stagedSha = sha(servedBuildPath);
            if (stagedSha !== provenance.sha256) throw new Error("staged build.json hash differs from original");
            provenance.served_url = servedUrl(servedBuildPath);
            provenance.served_sha256 = stagedSha;
        }
        directReference = {
            adapterUrl: "/tools/aot/opt/stack-reference-browser.mjs",
            moduleUrl: servedUrl(servedModulePath), wasmUrl: servedUrl(servedWasmPath), moduleSha, wasmSha,
            originalModuleUrl: directModuleUrl, originalWasmUrl: directWasmUrl,
            originalModuleSha, originalWasmSha, staged, servedDirectory, provenance,
        };
    }
    const config = {
        outer: Number(arg("outer", "100000")), warmup: Number(arg("warmup", "100000")),
        rounds: Number(arg("rounds", "6")), sampleTimeoutMs: Number(arg("sample-timeout", "300000")),
        freshSampleWorkers: argv.includes("--fresh-sample-workers"),
        engineDir: `/${path.relative(REPO, engineDirectory).replaceAll("\\", "/")}`,
        engineSha: sha(path.join(engineDirectory, "v86.wasm")),
        units: {
            semantic: stageUnit(base, "semantic", directory),
            identity: stageUnit(arg("identity", base)!, "identity", directory),
            stack: stageUnit(candidate, "stack", directory),
        },
        ...(directReference ? { directReference } : {}),
        gates: { minRounds: Number(arg("min-rounds", "6")), maxSpreadPct: Number(arg("max-spread", "10")) },
        environment: {
            session: cdpSession(), occupancy_ok: otherPages.length === 0, before_targets: beforeTargets,
            host_guest_quiescent: hostGuestQuiescent(guestBefore), no_loaded_modules: noLoadedModules(guestBefore),
            guest_initial: guestInitial, host_pause: hostPause, guest_before: guestBefore,
            own_page: preflight, chrome_command_line: commandLine,
            stock_browser: commandLine !== null && !/--(?:js-flags|wasm|enable-future-v8)|--(?:enable|disable)-features=[^\s]*Wasm/i.test(commandLine),
            chrome_flags_env: process.env.BS_CHROME_FLAGS ?? null,
            runtime_sha256: {
                libv86: sha(path.join(engineDirectory, "libv86.mjs")),
                fixed_work: sha(path.join(REPO, "tools/aot-oracle/browser/fixed-work.mjs")),
                worker: sha(path.join(REPO, "tools/aot/opt/browser-stack.mjs")),
                sample_worker: sha(path.join(REPO, "tools/aot/opt/stack-sample.mjs")),
                corpus: sha(path.join(REPO, "tools/aot-oracle/corpus/kernels.mjs")),
                image: sha(path.join(REPO, "tools/aot-oracle/corpus/image.mjs")),
                shipping: sha(path.join(REPO, "tools/jit-config/shipping.mjs")),
                oracle: sha(path.join(REPO, "tools/aot/opt/stack-oracle.mjs")),
                reference_adapter: sha(path.join(REPO, "tools/aot/opt/stack-reference-browser.mjs")),
                engine_unit: sha(path.join(REPO, "tools/aot-oracle/lib/engine-unit.mjs")),
                layout: sha(path.join(REPO, "tools/aot-oracle/corpus/layout.mjs")),
                state: sha(path.join(REPO, "tools/aot-oracle/lib/state.mjs")),
                gates: sha(path.join(REPO, "tools/aot-oracle/lib/gates.mjs")),
                cli: sha(path.join(REPO, "tools/aot/opt/stack-browser.ts")),
                publish: sha(path.join(REPO, "tools/aot/opt/publish.mjs")),
            },
        },
    };
    const configText = JSON.stringify(config);
    fs.writeFileSync(path.join(directory, "config.json"), configText);
    const out = path.resolve(arg("out", path.join(directory, "result.json"))!);
    const timeout = Number(arg("timeout", "1800000"));
    try {
        await evaluate(`(() => {
            window.__STACK_EXPERIMENT_RESULT__=null; window.__STACK_EXPERIMENT_PROGRESS__=null;
            const worker=new Worker('/tools/aot/opt/browser-stack.mjs',{type:'module'});
            window.__STACK_EXPERIMENT_WORKER__=worker;
            worker.onmessage=({data})=>{
                if(data.type==='progress') window.__STACK_EXPERIMENT_PROGRESS__=data.progress;
                else if(data.type==='result') window.__STACK_EXPERIMENT_RESULT__=data.result;
                else window.__STACK_EXPERIMENT_RESULT__={status:'WORKER_ERROR',why:data.error};
            };
            worker.onerror=(e)=>{window.__STACK_EXPERIMENT_RESULT__={status:'WORKER_ERROR',why:e.message};};
            worker.postMessage(${configText}); return 'started';
        })()`);
        let report: any = null, previousProgress = "";
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const poll = await evaluate("({result:window.__STACK_EXPERIMENT_RESULT__,progress:window.__STACK_EXPERIMENT_PROGRESS__})");
            if (poll.result) { report = poll.result; break; }
            const progress = JSON.stringify(poll.progress);
            if (progress !== previousProgress) { console.log(`[stack browser] ${progress}`); previousProgress = progress; }
            await Bun.sleep(2000);
        }
        if (!report) report = { status: "DRIVER_TIMEOUT" };
        const afterTargets = await listTargets();
        const guestAfter = await evaluate(guestProbe).catch((e) => ({ error: String(e) }));
        if (report.environment) {
            report.environment.after_targets = afterTargets;
            report.environment.occupancy_ok &&= !afterTargets.some((t) => t.type === "page" && t.id !== own.id && t.url !== "about:blank");
            report.environment.guest_after = guestAfter;
            report.environment.host_guest_quiescent &&= hostGuestQuiescent(guestAfter);
            report.environment.no_loaded_modules &&= noLoadedModules(guestAfter);
        }
        if (report.status === "ok") report.verdict = judgeStackReport(report, config.gates);
        report.config_sha256 = crypto.createHash("sha256").update(configText).digest("hex");
        report.started_at = new Date(deadline - timeout).toISOString();
        report.finished_at = new Date().toISOString();
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ status: report.status, result_file: out, verdict: report.verdict ?? null }));
        if (report.status !== "ok" || !report.verdict.correctness_ok) process.exitCode = 3;
    } finally {
        await evaluate("window.__STACK_EXPERIMENT_WORKER__?.terminate(),window.__STACK_EXPERIMENT_WORKER__=null,'stopped'").catch(() => {});
    }
}

try { await main(); }
catch (e) { console.error(String(e instanceof Error ? e.stack : e)); process.exitCode = 2; }
finally { closeHarnessConnection(); }
process.exit(process.exitCode ?? 0);
