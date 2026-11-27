/** Boot the migration smoke set from one Vite dev server in an isolated Chrome context. */
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CdpSession, DEFAULT_CDP_PORT, launchOrAttachChrome, pageEval, screenshot } from "../../cdp-core";
import { readBlackwellTitle } from "./blackwell-title";

const titles = [
    { id: "nfs-underground", file: "nfs-underground.wgb", presenter: "d3d9" },
    { id: "blackwell-legacy", file: "blackwell-legacy.wgb", presenter: "d3d9" },
    { id: "quake2", file: "quake2.wgb", presenter: "opengl" },
    { id: "alice", file: "Alice Greenfingers.wgb", presenter: "ddraw" },
    { id: "montezuma", file: "montezuma.wgb", presenter: "d3d8" },
];
const [engine, originArg, outputRoot, ...ids] = process.argv.slice(2);
if (!["wwt", "protected", "v86"].includes(engine) || !originArg || !outputRoot || ids.some(id => !titles.some(t => t.id === id))) {
    throw Error("Usage: bun tools/harness/regression/wwt-smoke.ts wwt|protected|v86 DEV_URL OUTPUT_DIR [nfs-underground blackwell-legacy quake2 alice montezuma]");
}
const origin = new URL(originArg).origin;
const listingResponse = await fetch(origin + "/__wgb/list", {signal: AbortSignal.timeout(15000)});
if (!listingResponse.ok) throw Error(`WGB listing returned HTTP ${listingResponse.status}`);
const listing = await listingResponse.json();
const port = DEFAULT_CDP_PORT;
mkdirSync(outputRoot, { recursive: true });
const out = mkdtempSync(join(outputRoot, engine + "-"));
const version = await launchOrAttachChrome({ port });
const report = { engine, origin, browser: version.Browser, results: [] as Record<string, unknown>[] };
const titleReference = (await Bun.file(join(import.meta.dir, "../../bench-v86/source-pair/nfsu-entry-templates.json")).json()).title;
const browser = await CdpSession.connect(version.webSocketDebuggerUrl, { timeoutMs: 8000 });
console.log(out);

// Score the same title crop used by the original NFSU navigation harness.
const readTitle = `(async () => {
    const shot = await window.__BS__.harness.rpc("shot", [], { timeoutMs: 4000 });
    const image = await createImageBitmap(new Blob([Uint8Array.from(atob(shot.base64), c => c.charCodeAt(0))], { type: "image/png" }));
    try {
        const t = ${JSON.stringify(titleReference)}, [x, y, w, h] = t.crop;
        const ctx = new OffscreenCanvas(48, 24).getContext("2d");
        const left = Math.floor(x * image.width), top = Math.floor(y * image.height);
        ctx.drawImage(image, left, top, Math.floor((x + w) * image.width) - left,
            Math.floor((y + h) * image.height) - top, 0, 0, 48, 24);
        const pixels = ctx.getImageData(0, 0, 48, 24).data;
        return t.rgb.reduce((sum, v, i) => sum + Math.abs(v - pixels[Math.floor(i/3)*4 + i%3]), 0) / t.rgb.length;
    } finally { image.close(); }
})()`;

const readState = `(async () => {
    const text = document.body.innerText;
    if (text.includes("Play over the network?"))
        Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "Not now")?.click();
    const h = window.__BS__?.harness;
    if (!h) return { ui: text.slice(-500) };
    const exit = h.lastEvent("process_exit") || h.lastEvent("error");
    const cpu = h.lastEvent("cpu_backend_ready");
    if (exit) return { cpu, exit };
    const state = await h.rpc("state", [["screen", "threads"]], { timeoutMs: 1800 }).catch(() => null);
    return { cpu, screen: state?.screen, threads: state?.threads?.threads?.map(t => t.stateName), ui: text.slice(-500) };
})()`;

async function check(title: typeof titles[number], context: string) {
    const matches = listing.entries.filter((row: { name: string }) => row.name === title.file);
    if (matches.length !== 1) throw Error(`Expected one ${title.file} in /__wgb/list, found ${matches.length}`);
    const entry = matches[0];
    const params = new URLSearchParams({ game: "dev", load: "/__wgb/?path=" + encodeURIComponent(entry.path) });
    if (engine === "protected") params.set("wwtMode", "protected");
    const url = origin + "/?" + params;
    const { targetId } = (await browser.send("Target.createTarget", { url: "about:blank", browserContextId: context }, undefined, {timeoutMs: 8000})).result;
    let page: CdpSession | undefined;
    try {
        const tabs = await (await fetch(`http://localhost:${port}/json/list`, {signal: AbortSignal.timeout(8000)})).json();
        page = await CdpSession.connect(tabs.find((t: {id: string}) => t.id === targetId).webSocketDebuggerUrl, {timeoutMs: 8000});
        await page.send("Page.navigate", { url }, undefined, {timeoutMs: 10000});
        const start = Date.now();
        let previous = 0, titleStreak = 0;
        const limit = title.id === "nfs-underground" ? 300000 : 180000;
        while (Date.now() - start < limit) {
            await Bun.sleep(2000);
            const sample = await pageEval(page, readState, {timeoutMs: 8000});
            const { cpu, screen, exit, threads } = sample;
            const serial = screen?.presentSerial ?? 0;
            const drawing = screen?.presenter === title.presenter && serial > previous && previous > 0 && serial >= 240;
            previous = serial;
            if (drawing && title.id === "nfs-underground") {
                sample.titleDistance = await pageEval(page, readTitle, {timeoutMs: 6000});
                titleStreak = sample.titleDistance < 17 ? titleStreak + 1 : 0;
            } else if (drawing && title.id === "blackwell-legacy") {
                sample.titleMenu = await pageEval(page, readBlackwellTitle, {timeoutMs: 6000});
                titleStreak = sample.titleMenu.matches ? titleStreak + 1 : 0;
            }
            appendFileSync(join(out, title.id + ".jsonl"), JSON.stringify({ms: Date.now() - start, ...sample}) + "\n");
            if (exit) throw Error(JSON.stringify(exit));
            if (!cpu) continue;
            if (cpu.backend !== (engine === "v86" ? "v86" : "wwt") || (engine === "protected" && cpu.wwtMode !== "protected")) {
                throw Error("Unexpected CPU " + JSON.stringify(cpu));
            }
            const needsTitle = title.id === "nfs-underground" || title.id === "blackwell-legacy";
            if (!drawing || (needsTitle && titleStreak < 2)) continue;
            if (title.id === "blackwell-legacy" && (!threads?.length || threads.includes("TERMINATED"))) continue;
            return { checkpoint: needsTitle ? "title image" : "advancing game frames", cpu,
                presenter: screen.presenter, serial, threads, titleDistance: sample.titleDistance, titleMenu: sample.titleMenu, path: entry.path, bytes: entry.size };
        }
        throw Error("Checkpoint timeout; see samples and screenshot");
    } finally {
        try {
            if (page) writeFileSync(join(out, title.id + ".png"), Buffer.from(await screenshot(page, {timeoutMs: 6000}), "base64"));
        } catch (error) {
            appendFileSync(join(out, title.id + ".jsonl"), JSON.stringify({ screenshotError: String(error) }) + "\n");
        } finally {
            page?.close();
            await browser.send("Target.closeTarget", {targetId}, undefined, {timeoutMs: 6000}).catch(error => {
                appendFileSync(join(out, title.id + ".jsonl"), JSON.stringify({ closeError: String(error) }) + "\n");
            });
        }
    }
}

try {
    const { browserContextId } = (await browser.send("Target.createBrowserContext", {disposeOnDetach: true}, undefined, {timeoutMs: 8000})).result;
    try {
        for (const title of titles.filter(t => !ids.length || ids.includes(t.id))) {
            let result: Record<string, unknown>;
            try { result = { id: title.id, ok: true, ...await check(title, browserContextId) }; }
            catch (error) { result = { id: title.id, ok: false, error: String(error) }; process.exitCode = 1; }
            report.results.push(result);
            writeFileSync(join(out, "results.json"), JSON.stringify(report, null, 2));
            console.log(JSON.stringify(result));
        }
    } finally { await browser.send("Target.disposeBrowserContext", {browserContextId}, undefined, {timeoutMs: 8000}); }
} finally { browser.close(); }
