/**
 * footprint-measure — desktop ground truth for the emulator's memory footprint.
 *
 *   bun tools/harness/diagnostics/footprint-measure.ts [wgb] [label] [delays=5,15,30] [--fp]
 *
 * Crashes the dev tab's renderer first (a reload keeps the same process, and the previous
 * guest's wasm memory is only freed when GC gets to it), reloads, opens the bundle (`WGB`
 * env var or the first argument), and samples Chrome's renderer and GPU processes at the
 * given delays after the guest starts. `--fp` adds the worker's `footprint` verb.
 *
 * The number that approximates iOS footprint is the renderer's PRIVATE WORKING SET (pages
 * this process has touched and holds). Private bytes (commit) include the whole wasm
 * reservation and do not move when pages are touched. Windows only (perf counters).
 */
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const wgb = process.env.WGB ?? positional[0];
const label = positional[1] ?? "run";
const delays = (positional[2] ?? "5,15,30").split(",").map(Number);
const withFp = process.argv.includes("--fp");
const port = process.env.BS_CDP_PORT ?? "9333";
if (!wgb) throw new Error("footprint-measure: pass a .wgb path (or set WGB)");

type Row = { type: string; pid: number; wsPrivMB: number; wsMB: number; privMB: number };

async function cdp(url: string, method: string): Promise<any> {
    const ws = new WebSocket(url);
    return await new Promise((res, rej) => {
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method }));
        ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id === 1) { ws.close(); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
        ws.onerror = (e) => rej(e);
    });
}

async function sample(): Promise<{ renderer?: Row; gpu?: Row }> {
    const version = await (await fetch(`http://localhost:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
    const info = await cdp(version.webSocketDebuggerUrl, "SystemInfo.getProcessInfo");
    const procs = (info.processInfo as Array<{ type: string; id: number }>).filter((p) => p.type === "renderer" || /gpu/i.test(p.type));
    const r = Bun.spawnSync(["powershell", "-NoProfile", "-Command",
        `$ids=@(${procs.map((p) => p.id).join(",")}); Get-CimInstance Win32_PerfRawData_PerfProc_Process | ` +
        `Where-Object { $ids -contains $_.IDProcess } | ForEach-Object { "{0} {1} {2} {3}" -f $_.IDProcess,$_.WorkingSetPrivate,$_.WorkingSet,$_.PrivateBytes }`],
        { stdout: "pipe", stderr: "pipe" });
    const mb = (b: number) => Math.round(b / 1048576);
    const rows = r.stdout.toString().trim().split(/\r?\n/).filter(Boolean).map((l) => l.trim().split(/\s+/).map(Number));
    const out: Row[] = procs.map((p) => {
        const row = rows.find((x) => x[0] === p.id);
        return { type: p.type, pid: p.id, wsPrivMB: row ? mb(row[1]!) : -1, wsMB: row ? mb(row[2]!) : -1, privMB: row ? mb(row[3]!) : -1 };
    });
    // The guest tab's renderer is the big one; an extension or spare renderer is not.
    return { renderer: out.filter((x) => x.type === "renderer").sort((a, b) => b.wsMB - a.wsMB)[0], gpu: out.find((x) => x.type !== "renderer") };
}

const list = await (await fetch(`http://localhost:${port}/json/list`)).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
const tab = list.find((t) => t.type === "page" && t.url.includes("game=dev"));
if (tab) { try { await Promise.race([cdp(tab.webSocketDebuggerUrl, "Page.crash"), Bun.sleep(1500)]); } catch { /* the crash closes the socket */ } }
const reload = Bun.spawnSync(["bun", "tools/harness.ts", "reload"], { stdout: "pipe", stderr: "pipe" });
const idle = await sample();
console.log(`[${label}] fresh renderer (reload exit=${reload.exitCode}) idle wsPriv=${idle.renderer?.wsPrivMB}MB`);

const t = Date.now();
const open = Bun.spawnSync(["bun", "tools/harness.ts", "openWgb", wgb], { stdout: "pipe", stderr: "pipe" });
const openOut = open.stdout.toString() + open.stderr.toString();
const loaded = openOut.includes('"loaded": true');
console.log(`[${label}] openWgb ${loaded ? "loaded" : "FAILED"} in ${((Date.now() - t) / 1000).toFixed(1)}s${loaded ? "" : " " + openOut.slice(-400)}`);
if (!loaded) process.exit(1);

const t0 = Date.now();
for (const d of delays) {
    const wait = t0 + d * 1000 - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    const s = await sample();
    let fp = "";
    if (withFp) {
        const r = Bun.spawnSync(["bun", "tools/harness.ts", "footprint"], { stdout: "pipe", stderr: "pipe" });
        try {
            const j = JSON.parse(r.stdout.toString().slice(r.stdout.toString().indexOf("{")));
            fp = ` | footprint estimate=${j.estimateMB}MB guestDirty=${j.guestDirty?.dirtyMB}MB gpuBuffers=${j.gpu?.bufferMB}MB`;
        } catch { fp = " | footprint unavailable"; }
    }
    console.log(`[${label}] t+${d}s renderer wsPriv=${s.renderer?.wsPrivMB}MB ws=${s.renderer?.wsMB}MB private=${s.renderer?.privMB}MB` +
        ` | gpu wsPriv=${s.gpu?.wsPrivMB}MB${fp}`);
}
