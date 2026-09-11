/**
 * Fixed-work timing of one codegen-pair kernel, on a chosen v86 engine binary.
 *
 * Why fixed work: the game stand's FPS wanders far more than a codegen candidate is worth
 * (see docs/performance/v86-fps-handoff-2026-09-10.md). The demo runs a fixed iteration count
 * and the GUEST times it with GetTickCount around cg_run, so a run measures the kernel rather
 * than a scene, a load, or a teardown.
 *
 * The engine is bound when the worker boots, so the flag is written to localStorage BEFORE the
 * page is navigated, and the bytes actually instantiated are verified against the request.
 *
 * Usage: bun tools/bench-v86/source-pair/codegen-bench.ts <k1..k6> [--engine <sha256>] [--runs N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchOrAttachChrome, listTargets, CdpSession, pageEval } from '../../cdp-core';

const repo = path.resolve(import.meta.dir, '../../..');
const kernel = process.argv.find(a => /^k[1-6]$/.test(a)) ?? 'k3';
// Which work volume this run measures. The slope across the two is what removes cold start.
const volIndex = process.argv.indexOf('--volume');
const volume = volIndex > 0 ? process.argv[volIndex + 1] : 'lo';
if (!['lo', 'hi'].includes(volume)) throw new Error(`unknown --volume ${volume}`);
const engineIndex = process.argv.indexOf('--engine');
const engine = engineIndex > 0 ? process.argv[engineIndex + 1] : null;
const runsIndex = process.argv.indexOf('--runs');
const runs = runsIndex > 0 ? Number(process.argv[runsIndex + 1]) : 3;
if (engine && !/^[a-f0-9]{64}$/.test(engine)) throw new Error('--engine takes a sha256');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
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

const readTlbIndex = process.argv.indexOf('--read-tlb');
const readTlb = readTlbIndex > 0 ? Number(process.argv[readTlbIndex + 1]) : null;
// Kernel N lives in section .cgkN, and build.json says where. The gate compares a guest code
// page, so it has to be that section's page and not a guess.
const buildJson = JSON.parse(fs.readFileSync(path.join(process.env.CODEGEN_DEMO_DIR || 'C:/Projects/bottleship-demos/demo_codegen_pair', 'build.json'), 'utf8'));
const kernelSection = buildJson.sectionMap['.cg' + kernel];
if (!kernelSection) throw new Error(`No section .cg${kernel} in build.json`);
const kernelPage = kernelSection.va >>> 12;
const goAddress = buildJson.goAddress;
if (typeof goAddress !== 'number') throw new Error('build.json has no goAddress; rebuild the demo');
const expectIndex = process.argv.indexOf('--expect');
const expect = expectIndex > 0 ? Number(process.argv[expectIndex + 1]) : null;
// --ab interleaves the two modes inside ONE process, ABBA-balanced. Sequential blocks of arms
// let a host-load drift land entirely on one of them; the game stand already produced two
// opposite-signed results that way.
const ab = process.argv.includes('--ab');
const leverIndex = process.argv.indexOf('--lever');
const lever = leverIndex > 0 ? process.argv[leverIndex + 1] : 'rtlb';
if (!['rtlb', 'stackraw', 'relaxedfpu', 'flagtuple', 'flaglocals', 'x87locals'].includes(lever)) throw new Error(`unknown --lever ${lever}`);
const sequence = ab
    ? Array.from({ length: runs }, (_, i) => [0, 1, 1, 0][i % 4])
    : Array.from({ length: runs }, () => readTlb ?? 0);
const results: Array<{ run: number; arm: number; ms: number; checksum: number; engine: string; census?: unknown }> = [];
for (let run = 0; run < sequence.length; run++) {
    // Written before navigation: the worker reads its flags on init, and initV86 picks the
    // engine there. Setting it afterwards persists a flag for a reload that never happens.
    await pageEval(session, `(() => {
        const store = 'bs_debug_flags:codegen';
        localStorage.removeItem(store);
        ${engine ? `localStorage.setItem(store, JSON.stringify({__v86LabWasmPath: '/apps/source-pair-lab/engines/${engine}.wasm', __aotNoAutoLoad: true}));` : ''}
        return true;
    })()`).catch(() => null);
    await session.send('Page.navigate', { url: 'http://127.0.0.1:5174/?game=dev&bs=codegen' });
    for (let i = 0; i < 120; i++) {
        const ready = await pageEval(session, `!!(window.__BS__ && window.__BS__.harness)`).catch(() => false);
        if (ready) break;
        await sleep(500);
    }
    // The digest of the instantiated bytes resolves asynchronously; reading before it lands
    // would fail a correct run and, worse, could pass a wrong one that had not answered yet.
    let load: any = null;
    for (let i = 0; i < 60; i++) {
        load = await call('evalWorker', `const e=globalThis.__v86EngineLoad;return e?{...e}:null;`);
        if (load && (load.sha256 || load.error)) break;
        await sleep(500);
    }
    if (engine && load?.sha256 !== engine) throw new Error(`Engine not instantiated as requested: ${JSON.stringify(load)}`);

    await call('openWgb', `/apps/codegen-pair/codegen-${kernel}-${volume}.wgb`, { reload: false });

    // The guest is parked on the go-file gate here, so nothing of the kernel is compiled yet.
    // Runtime-switchable candidate: the block-local read micro-TLB (jit config idx 29/30) is
    // gated to ONE code page, and this demo puts exactly one kernel on each page — so the two
    // arms are the same engine binary, the same boot, one config value apart. The debug
    // accessor needs the live PreemptionManager, which only exists once a bundle is loaded.
    // BOTH arms take this call, including the off arm. setReadTlbCache clears the JIT cache,
    // so calling it in one arm only hands that arm a cold JIT during the timed phase — a
    // systematic difference that has nothing to do with the feature under test.
    const mode = sequence[run];
    if (lever === 'flaglocals') {
        // The SHIPPED flag-locals implementation (jit config 21). Rejected in-game on three
        // windows per arm — a sample the stand's five-minute ±30% drift can produce by itself.
        const back = await call('evalWorker',
            "const w = globalThis.preemption.getWasmExports();"
            + " w.set_jit_config(21, " + mode + ");"
            + " const back = w.get_jit_config(21) >>> 0;"
            + " if (back !== " + mode + ") throw new Error('idx21 readback ' + back);"
            + " if (w.jit_clear_cache_js) w.jit_clear_cache_js();"
            + " return back;");
        if (back !== mode) throw new Error(`idx21 not applied: ${JSON.stringify(back)}`);
    }
    else if (lever === 'x87locals') {
        // The x87 ST-register local cache (jit config 10). On the rotate-not-invalidate
        // candidate this is the arm under test, and k5 is the x87 kernel — so the per-arm
        // checksum gate below is the differential: an arm that renames the cache wrongly
        // computes different floats and cannot pass its own checksum.
        const back = await call('evalWorker',
            "const w = globalThis.preemption.getWasmExports();"
            + " w.set_jit_config(10, " + mode + ");"
            + " const back = w.get_jit_config(10) >>> 0;"
            + " if (back !== " + mode + ") throw new Error('idx10 readback ' + back);"
            + " if (w.jit_clear_cache_js) w.jit_clear_cache_js();"
            + " return back;");
        if (back !== mode) throw new Error(`idx10 not applied: ${JSON.stringify(back)}`);
    }
    else if (lever === 'flagtuple') {
        // ABLATION: arm 1 skips the lazy-EFLAGS tuple stores. Deliberately wrong, so its
        // checksum WILL diverge — recorded, never hidden, and never quoted as a candidate.
        const back = await call('evalWorker',
            "const w = globalThis.preemption.getWasmExports();"
            + " if (!w.jit_no_flag_tuple_set) throw new Error('engine has no jit_no_flag_tuple_set');"
            + " w.jit_no_flag_tuple_set(" + mode + ");"
            + " const back = w.jit_no_flag_tuple_get() >>> 0;"
            + " if (back !== " + mode + ") throw new Error('flag-tuple readback ' + back);"
            + " if (w.jit_clear_cache_js) w.jit_clear_cache_js();"
            + " return back;");
        if (back !== mode) throw new Error(`flag-tuple ablation not applied: ${JSON.stringify(back)}`);
    }
    else if (lever === 'relaxedfpu') {
        // Routed through PreemptionManager, which is the single source of truth: a bare
        // set_relaxed_fpu would be re-applied away at the next init and the A/B would compare
        // an arm against itself. It clears the JIT cache itself, in both arms.
        const back = await call('evalWorker',
            "const pm = globalThis.preemption;"
            + " if (!pm || !pm.setRelaxedFpu) throw new Error('no PreemptionManager.setRelaxedFpu');"
            + " pm.setRelaxedFpu(" + (mode === 1) + ");"
            + " const w = pm.getWasmExports();"
            + " const live = w.get_relaxed_fpu ? (w.get_relaxed_fpu() >>> 0) : (pm.isRelaxedFpuEnabled() ? 1 : 0);"
            + " return { desired: pm.isRelaxedFpuEnabled() ? 1 : 0, live };");
        const b = back as { desired: number; live: number };
        if (b.desired !== mode) throw new Error(`relaxed FPU not applied: ${JSON.stringify(b)}`);
    }
    else if (lever === 'stackraw') {
        // Direct wasm export, verified by readback, and the JIT cache is cleared in BOTH arms so
        // the shape difference is the only difference. Mode 1 = ESP/EBP-based constant
        // addressing only; it SKIPS the guard, so such an access can no longer fault.
        const back = await call('evalWorker',
            "const w = globalThis.preemption.getWasmExports();"
            + " if (!w.set_stack_raw_unsafe) throw new Error('engine exports no set_stack_raw_unsafe');"
            + " w.set_stack_raw_unsafe(" + mode + ");"
            + " const back = w.get_stack_raw_unsafe() >>> 0;"
            + " if (back !== " + mode + ") throw new Error('stack_raw readback ' + back);"
            + " if (w.jit_clear_cache_js) w.jit_clear_cache_js();"
            + " return back;");
        if (back !== mode) throw new Error(`stack_raw not applied: ${JSON.stringify(back)}`);
    }
    else {
        if (mode === 2) await call('dbgCall', 'dispatchStatsEnable', true).catch(() => null);
        const applied = await call('dbgCall', 'setReadTlbCache', mode, kernelPage) as any;
        if (!applied || applied.mode !== mode || applied.codePage !== kernelPage) {
            throw new Error(`read micro-TLB not applied: ${JSON.stringify(applied)}`);
        }
    }
    // Open the gate by writing the guest's own flag variable. Data, not code, so no JIT
    // invalidation is involved; the address comes from the linker map via build.json.
    const opened = await call('evalWorker',
        `const m = System.getInstance().process.getCurrentMemory();
         const v = new DataView(m.buffer, m.byteOffset, m.byteLength);
         if (v.getUint32(${goAddress}, true) !== 0) throw new Error('gate was already open');
         v.setUint32(${goAddress}, 1, true);
         return v.getUint32(${goAddress}, true);`);
    if (opened !== 1) throw new Error(`start gate not opened: ${JSON.stringify(opened)}`);
    let ms: number | null = null;
    let checksum: number | null = null;
    for (let i = 0; i < 240 && (ms === null || checksum === null); i++) {
        await sleep(1000);
        const entries = await call('logs', 600, 'CODEGEN_PAIR_') as Array<{ message: string }>;
        for (const e of entries) {
            const m = /CODEGEN_PAIR_MS=(\d+)/.exec(e.message);
            if (m) ms = Number(m[1]);
            const c = /CODEGEN_PAIR_SUM=(\d+)/.exec(e.message);
            if (c) checksum = Number(c[1]);
        }
    }
    if (ms === null || checksum === null) throw new Error(`No CODEGEN_PAIR_MS/SUM within 240s for ${kernel}`);
    // A timing arm that quietly did different work is not a faster arm.
    // The flag-tuple arm is an ablation: a divergence is expected and is reported, not fatal.
    if (expect !== null && checksum !== expect && !(lever === 'flagtuple' && mode === 1)) {
        throw new Error(`Checksum mismatch for ${kernel}: guest ${checksum} vs expected ${expect}`);
    }
    // Mode 2 emits hit/fill census traffic (and is therefore slower than mode 1): it answers
    // WHY an arm won or lost, which a time alone cannot.
    let census: unknown = null;
    if (mode === 2) {
        census = await call('dbgCall', 'readTlbCacheStats', false).catch(() => null);
    }
    results.push({ run, arm: mode, ms, checksum, engine: load?.sha256 ?? 'default', census });
    console.log(`[bench] ${kernel} run ${run + 1}/${sequence.length} arm=rtlb${mode}: ${ms} ms, checksum ${checksum}`);
}

const med = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2; };
const values = results.map(r => r.ms).sort((a, b) => a - b);
const median = med(values);
const armMs = (m) => results.filter(r => r.arm === m).map(r => r.ms);
const perArm = [0, 1, 2].filter(m => armMs(m).length).map(m => ({ mode: m, runs: armMs(m), median: med(armMs(m)) }));
const off = perArm.find(a => a.mode === 0), on = perArm.find(a => a.mode === 1);
const out = {
    kernel, engine: engine ?? 'default(/v86.wasm)',
    lever, volume, readTlbMode: readTlb, ab, perArm,
    ratioOnOverOff: off && on ? +(on.median / off.median).toFixed(4) : null,
    kernelPage: `0x${kernelPage.toString(16)}`, runs: results,
    median, min: values[0], max: values[values.length - 1],
    spreadPct: values[0] ? +(((values[values.length - 1] - values[0]) / values[0]) * 100).toFixed(1) : null,
    note: 'Guest-timed fixed work (GetTickCount around cg_run). Not an FPS claim.',
};
const file = path.join(repo, 'logs/codegen-pair', `bench-${kernel}-${volume}-${(engine ?? 'default').slice(0, 8)}-${lever}${ab ? 'ab' : (readTlb === null ? 'off' : readTlb)}.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ kernel, volume, median, spreadPct: out.spreadPct, perArm, ratioOnOverOff: out.ratioOnOverOff, file: path.relative(repo, file) }));
session.close();
