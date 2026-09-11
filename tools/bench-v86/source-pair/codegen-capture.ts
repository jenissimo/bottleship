/**
 * Capture OUR generated Wasm for each codegen-pair kernel, so it can be read against the Wasm
 * Emscripten produces from the same C++.
 *
 * The attribution rests on one kernel per 4 KiB page (see codegen.h): the v86 JIT publishes a
 * module per physical page, so a module captured for page P is that kernel and nothing else.
 * The capture is armed BEFORE the bundle loads — by the time a load call returns the page can
 * already be hot, and an arm after that captures nothing while looking like it worked.
 *
 * Usage: bun tools/bench-v86/source-pair/codegen-capture.ts [k1 k2 ...] [--seconds N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchOrAttachChrome, listTargets, CdpSession, pageEval } from '../../cdp-core';

const repo = path.resolve(import.meta.dir, '../../..');
const demo = process.env.CODEGEN_DEMO_DIR || 'C:/Projects/bottleship-demos/demo_codegen_pair';
const build = JSON.parse(fs.readFileSync(path.join(demo, 'build.json'), 'utf8'));
const outDir = path.join(repo, 'logs/codegen-pair');
const secondsIndex = process.argv.indexOf('--seconds');
const seconds = secondsIndex > 0 ? Number(process.argv[secondsIndex + 1]) : 25;
const kernels = process.argv.slice(2).filter(a => /^k[1-6]$/.test(a));
const wanted = kernels.length ? kernels : ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sections: Record<string, { va: number; page: number; virtualSize: number }> = build.sectionMap;
const pageOf = (name: string) => (sections[name].page >>> 12);

await launchOrAttachChrome({});
const targets = await listTargets({});
const target = targets.find(t => t.type === 'page' && t.url.includes('bs=codegen'))
    ?? targets.find(t => t.type === 'page' && (t.url === 'about:blank' || t.url.startsWith('chrome://newtab')))
    ?? targets.find(t => t.type === 'page');
if (!target) throw new Error('No page target in the harness Chrome');
const session = await CdpSession.connect(target.webSocketDebuggerUrl);
await session.send('Page.enable', {});

const call = async (cmd: string, ...args: unknown[]) => {
    const expr = `(async () => {
        const r = await window.__BS__.harness.__runSteps([{cmd: ${JSON.stringify(cmd)}, args: ${JSON.stringify(args)}}]);
        if (!r.ok) throw new Error(${JSON.stringify(cmd)} + ': ' + JSON.stringify(r.error));
        return r.steps.at(-1).result;
    })()`;
    return pageEval(session, expr, { timeoutMs: 180_000 });
};

fs.mkdirSync(outDir, { recursive: true });
const summary: any[] = [];

for (const k of wanted) {
    // Every kernel page plus the shared helpers it reaches: a walk kernel's cost lives in
    // cg_visit and the leaves, not in the loop that calls them.
    const names = Object.keys(sections);
    const pages = names.map(pageOf);
    console.log(`[capture] ${k}: fresh page, arming ${pages.length} kernel pages`);
    await session.send('Page.navigate', { url: `http://127.0.0.1:5174/?game=dev&bs=codegen` });
    // Wait for the harness facade rather than a fixed delay: a page that is not ready yet
    // would take the arm silently into the previous document.
    for (let i = 0; i < 120; i++) {
        const ready = await pageEval(session, `!!(window.__BS__ && window.__BS__.harness)`).catch(() => false);
        if (ready) break;
        await sleep(500);
    }
    await call('resetWorkerFlags');
    await call('jitBytes', 'clear');
    const armed = await call('jitBytes', 'arm', pages);
    console.log(`[capture] armed`, JSON.stringify(armed));

    await call('openWgb', `/apps/codegen-pair/codegen-${k}.wgb`, { reload: false });
    console.log(`[capture] ${k}: running ${seconds}s`);
    await sleep(seconds * 1000);

    const snap = await call('jitBytes', 'snap', k) as any;
    const kernelDir = path.join(outDir, k);
    fs.mkdirSync(kernelDir, { recursive: true });
    const modules: any[] = [];
    for (const name of names) {
        const page = pageOf(name);
        let exported: any;
        try {
            exported = await call('jitBytes', 'export', k, page);
        } catch {
            modules.push({ section: name, page: `0x${page.toString(16)}`, captured: false });
            continue;
        }
        const bytes = Buffer.from(exported.base64, 'base64');
        // The slot is keyed by the page the module was recorded under, but a module can span
        // pages, and then that key is NOT the function it starts at. The emitted function name
        // (g<entry>@t<slot>) is the ground truth; a mismatch means the module covers more than
        // this section and nothing per-instruction may be attributed to it.
        const emitted = /g([0-9a-f]{8})@t(\d+)/.exec(bytes.toString('latin1'));
        const entry = emitted ? parseInt(emitted[1], 16) : null;
        const attributable = entry === sections[name].va;
        const file = path.join(kernelDir, `${attributable ? name.replace(/^\./, '') : 'span-' + (entry ?? 0).toString(16)}.wasm`);
        fs.writeFileSync(file, bytes);
        modules.push({
            section: name, page: exported.page, len: exported.len, sha: exported.sha,
            entry: entry === null ? null : `0x${entry.toString(16)}`,
            sectionVa: `0x${sections[name].va.toString(16)}`,
            attributable,
            x86Bytes: sections[name].virtualSize, file: path.relative(repo, file), captured: true,
        });
    }
    const captured = modules.filter(m => m.captured).length;
    const attributable = modules.filter(m => m.attributable).length;
    console.log(`[capture] ${k}: ${captured} modules (${attributable} attributable to one section), snap ${JSON.stringify(snap.entries ?? []).slice(0, 200)}`);
    summary.push({ kernel: k, captured, attributable, modules, snap: { modules: snap.modules, totalBytes: snap.totalBytes } });
}

fs.writeFileSync(path.join(outDir, 'capture.json'), JSON.stringify({
    builtAt: build.builtAt, demo, sectionMap: sections, seconds, summary,
}, null, 2));
console.log(`[capture] wrote ${path.relative(repo, path.join(outDir, 'capture.json'))}`);
session.close();
