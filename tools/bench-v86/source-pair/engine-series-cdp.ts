/**
 * Run the engine comparison series in the DEDICATED harness Chrome instead of the user's
 * browser.
 *
 * Why this exists: measuring in a shared browser puts the arms on a CPU (and a compositor)
 * that other tabs and the desktop move around underneath them. The isolated launch also
 * carries `CalculateNativeWinOcclusion`/occluded-window flags — without those, Windows
 * throttles frame production whenever another window covers the page, which reads as a
 * monotonic FPS decay that no amount of arm balancing can remove.
 *
 * Usage: bun tools/bench-v86/source-pair/engine-series-cdp.ts [BAAB] [--timeout-min 20]
 */
import { launchOrAttachChrome, listTargets, CdpSession, pageEval, captureTrace, DEFAULT_CDP_PORT } from "../../cdp-core";

const order = (process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "BAAB").toUpperCase();
const timeoutIndex = process.argv.indexOf("--timeout-min");
const timeoutMin = timeoutIndex > 0 ? Number(process.argv[timeoutIndex + 1]) : 30;
const flagsIndex = process.argv.indexOf("--flags");
const flags = flagsIndex > 0 ? process.argv[flagsIndex + 1] : null;
const engineIndex = process.argv.indexOf("--engine");
const engine = engineIndex > 0 ? process.argv[engineIndex + 1] : null;
const PAGE = `http://127.0.0.1:5174/tools/bench-v86/source-pair/nfsu-entry.html?series=${order}`
    + (flags ? `&flags=${encodeURIComponent(flags)}` : "")
    + (engine ? `&engine=${engine}` : "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await launchOrAttachChrome({});
const targets = await listTargets({});
// Reuse a lab tab if this Chrome already has one; never adopt another agent's ?game=dev tab.
let target = targets.find((t) => t.type === "page" && t.url.includes("nfsu-entry.html"))
    ?? targets.find((t) => t.type === "page" && (t.url === "about:blank" || t.url.startsWith("chrome://newtab")));
if (!target) {
    // Never adopt a tab that belongs to another stand — a codegen bench tab holds its own guest,
    // and navigating it away would kill a measurement in flight. Open our own instead.
    const browser = await (await fetch(`http://127.0.0.1:${DEFAULT_CDP_PORT}/json/version`)).json();
    const browserSession = await CdpSession.connect(browser.webSocketDebuggerUrl);
    const created = await browserSession.send("Target.createTarget", { url: "about:blank" });
    browserSession.close();
    const id = created?.result?.targetId;
    for (let i = 0; i < 40 && !target; i++) {
        await sleep(250);
        target = (await listTargets({})).find((t) => t.targetId === id || t.id === id);
    }
    if (!target) throw new Error("Could not open a page target in the harness Chrome");
    console.log("[series] opened a dedicated tab (all existing tabs belong to other stands)");
}
const session = await CdpSession.connect(target.webSocketDebuggerUrl);
await session.send("Page.enable", {});
await session.send("Page.navigate", { url: PAGE });
await session.send("Page.bringToFront", {}).catch(() => { /* not fatal */ });
await sleep(3000);

// --enter: ONE entry on ONE engine instead of the comparison series. A census reads counters
// out of a single build; running a four-arm series for it would spend three boots proving
// nothing, and the arms are not comparable anyway when only one engine carries the counters.
const single = process.argv.includes("--enter");
const button = single ? "Войти в эталонную гонку" : "Серия сравнения";
console.log(`[series] ${single ? "single entry" : order} on ${PAGE}`);
await pageEval(session, `[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(button)})).click(),'started'`);

const deadline = Date.now() + timeoutMin * 60_000;
let last = "";
// The single-entry path leaves "Готово: ..."; the series leaves "Серия готова".
const isReady = (s: string) => s.startsWith("Серия готова") || s.startsWith("Готово:");
const isDone = (s: string) => isReady(s) || s.startsWith("Серия остановлена") || s.startsWith("Остановлено:");
while (Date.now() < deadline) {
    await sleep(10_000);
    const status: string = await pageEval(session, `document.querySelector('#status').textContent`);
    if (status !== last) { last = status; console.log(`[series] ${status}`); }
    if (isDone(last)) break;
}
if (!isDone(last)) console.log(`[series] TIMEOUT after ${timeoutMin} min - last status: ${last}`);

// --profile: the series leaves its last arm paused on a validated scene, which is exactly
// what the frame profile needs. Attribution, not timing — safe to run right after.
// --trace <sec>: record a Chrome trace ACROSS the running race and arm the guest-attribution
// mark inside the window, so `analyze-trace` can split the frame into guest JIT blocks, our JS
// and glue. That split is the one number the codegen track's whole ceiling depends on, and the
// two accountings currently on record disagree about it by a factor of three.
if (process.argv.includes("--trace") && isReady(last)) {
    const seconds = Number(process.argv[process.argv.indexOf("--trace") + 1]) || 12;
    const tagIndex = process.argv.indexOf("--tag");
    const tag = tagIndex > 0 ? process.argv[tagIndex + 1] : `${seconds}s`;
    const file = `logs/nfsu-race-${tag}.json.gz`;
    // The scene is left paused by the entry; resume it, or the trace records a stopped emulator.
    await pageEval(session, `(async () => {
        const frame = document.querySelector('#guest iframe');
        const r = await frame.contentWindow.__BS__.harness.__runSteps([{cmd: 'resume', args: []}]);
        if (!r.ok) throw new Error(JSON.stringify(r.error));
        return 'resumed';
    })()`);
    // Levers must be set BEFORE the recording window, not after it: a trace taken first and
    // configured second describes the configuration it did NOT record.
    const leversIndex = process.argv.indexOf("--levers");
    if (leversIndex > 0) {
        const on = process.argv[leversIndex + 1] === "on";
        const applied = await pageEval(session, `(async () => {
            const frame = document.querySelector('#guest iframe');
            const r = await frame.contentWindow.__BS__.harness.__runSteps([{cmd:'evalWorker',args:[
                "globalThis.__d3d9NoBankHashCache=" + ${!on} + ";" +
                "return {bankHashCache:!globalThis.__d3d9NoBankHashCache};"]}]);
            if (!r.ok) throw new Error(JSON.stringify(r.error));
            return r.steps.at(-1).result;
        })()`);
        console.log(`[trace] levers ${on ? "on" : "off"}: ${JSON.stringify(applied)}`);
    }
    await sleep(8000);
    console.log(`[trace] recording ${seconds}s -> ${file}`);
    const sampleMs = Math.min(3000, Math.max(800, (seconds * 1000) / 4));
    const r = await captureTrace(file, seconds, {
        during: async () => {
            const res = await pageEval(session, `(async () => {
                const frame = document.querySelector('#guest iframe');
                const r = await frame.contentWindow.__BS__.harness.__runSteps([
                    {cmd: 'hotBlocksMark', args: [{ms: ${sampleMs}}]}]);
                return r.ok ? r.steps.at(-1).result : {marked: false, note: JSON.stringify(r.error)};
            })()`, { timeoutMs: sampleMs + 30_000 }).catch(e => ({ marked: false, note: String(e) }));
            console.log(`[trace] hotblocks: ${JSON.stringify(res)}`);
        },
    });
    console.log(`[trace] ${r.events} events, ${(r.bytes / 1024 / 1024).toFixed(1)} MB`);
    await pageEval(session, `(async () => {
        const frame = document.querySelector('#guest iframe');
        await frame.contentWindow.__BS__.harness.__runSteps([{cmd: 'pause', args: []}]);
        return 'paused';
    })()`).catch(() => null);
}

// --experiment <name>: run an exported function from nfsu-experiment.mjs on the scene the
// series just left paused. This is where an in-boot paired A/B of a runtime JIT lever runs.
if (process.argv.includes("--experiment") && isReady(last)) {
    const name = process.argv[process.argv.indexOf("--experiment") + 1];
    console.log(`[experiment] ${name}`);
    await pageEval(session, `(async () => {
        const frame = document.querySelector('#guest iframe');
        const call = async (cmd, ...args) => {
            const r = await frame.contentWindow.__BS__.harness.__runSteps([{cmd, args}]);
            if (!r.ok) throw new Error(cmd + ': ' + JSON.stringify(r.error));
            return r.steps.at(-1).result;
        };
        const cfg = await (await fetch('./navigation-record-config.json', {cache: 'no-store'})).json();
        let seq = Number(new Date());
        const save = async (kind, data) => {
            const r = await fetch(cfg.endpoint, {method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({seq: seq++, kind, t: performance.now(), data})});
            if (!r.ok) throw new Error('Collector ' + r.status);
        };
        const note = s => { document.querySelector('#status').textContent = s;
            document.querySelector('#log').textContent += s + String.fromCharCode(10); };
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const mod = await import('./nfsu-experiment.mjs?exp=' + seq);
        window.__expDone = false;
        mod[${JSON.stringify('NAME')}]({call, save, note, sleep, scene: window.__nfsuScene})
            .then(() => { window.__expDone = 'ok'; })
            .catch(e => { window.__expDone = 'failed: ' + e; });
        return 'started';
    })()`.replace('"NAME"', JSON.stringify(name)));
    const expDeadline = Date.now() + 30 * 60_000;
    let elast = "";
    while (Date.now() < expDeadline) {
        await sleep(10_000);
        const status = await pageEval(session, `document.querySelector('#status').textContent`);
        if (status !== elast) { elast = status; console.log(`[experiment] ${elast}`); }
        const done = await pageEval(session, `window.__expDone`);
        if (done) { console.log(`[experiment] done: ${done}`); break; }
    }
}
if (process.argv.includes("--profile") && isReady(last)) {
    console.log("[profile] снимаю профиль готовой сцены");
    await pageEval(session, `[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Снять профиль')).click(),'started'`);
    const profileDeadline = Date.now() + 10 * 60_000;
    let plast = "";
    while (Date.now() < profileDeadline) {
        await sleep(10_000);
        const status: string = await pageEval(session, `document.querySelector('#status').textContent`);
        if (status !== plast) { plast = status; console.log(`[profile] ${status}`); }
        if (plast.startsWith("Профиль сохранён") || plast.startsWith("Профиль остановлен")) break;
    }
}
session.close();
