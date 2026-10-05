// Fixed-work warm-JIT microbenchmark and actual-JIT empty/TOP differential matrix.
import { createX87Workload } from './x87-workload.mjs';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { V86 } from '../../vendor/v86/build/libv86.mjs';
import { SHIPPING_JIT } from '../jit-config/shipping.mjs';
const arg = n => { const i = process.argv.indexOf(n); return i < 0 ? undefined : process.argv[i + 1]; };
const wasm = arg('--wasm') || fileURLToPath(new URL('../../vendor/v86/build/v86.wasm', import.meta.url));
const digest = x => createHash('sha256').update(x).digest('hex');
const {image, boot, state, checkResult, measure} = createX87Workload(V86, {wasm, shipping: SHIPPING_JIT});
const output = { wasm, hash: digest(fs.readFileSync(wasm)), node: process.version, results: [] };
if (process.argv.includes('--matrix')) {
    const quick = process.argv.includes('--quick');
    for (const top of quick ? [0, 7] : [0, 1, 2, 3, 4, 5, 6, 7]) {
        for (const operand of quick ? [0, 1, 7] : [0, 1, 2, 3, 4, 5, 6, 7]) for (let empty = 0; empty < 4; empty++) {
            const im = image('matrix', top, operand, empty);
            const a = await boot(im, { jit: false, stats: true });
            const oracle = state(a.c, a.w); a.em.destroy();
            for (const locals of [0, 1]) {
                const b = await boot(im, { locals, stats: true });
                const got = state(b.c, b.w); b.em.destroy();
                for (const k of ['lo', 'hi', 'sw', 'remaining', 'iterations'])
                    if (got[k] !== oracle[k]) throw Error(`matrix ${top}/${operand}/${empty}/${locals}: ${k} ${JSON.stringify({ oracle, got })}`);
                if (empty === 0 && got.hits === 0) throw Error('no live inline arithmetic');
                if (empty !== 0 && got.fallbacks === 0) throw Error('empty never exercised helper');
            }
            output.results.push({ top, operand, empty });
        }
        console.error(`matrix TOP ${top} PASS`);
    }
} else {
    for (const kind of (arg('--kind') || 'pair,spread,memory').split(',')) {
        const im = image(kind);
        // Instrumented companion proves that this workload exercises the fast path.
        const live = await boot(im, { stats: true });
        const liveness = state(live.c, live.w, kind); checkResult(liveness, 120000, kind);
        if (liveness.hits === 0 || liveness.fallbacks !== 0) throw Error('fast path not live ' + JSON.stringify(liveness));
        live.em.destroy();
        const b = await boot(im);
        for (let i = 0; i < 3; i++) measure(b, im, 2000000);
        const samples = [];
        for (let i = 0; i < Number(arg('--rounds') || 7); i++) samples.push(measure(b, im, Number(arg('--iterations') || 2000000)));
        if (arg('--dump-dir')) {
            fs.mkdirSync(arg('--dump-dir'), { recursive: true });
            globalThis.__wasmDump.out.forEach((r, i) => fs.writeFileSync(path.join(arg('--dump-dir'), `${kind}-${i}.wasm`), r.bytes));
        }
        output.results.push({ kind, image: digest(im.bytes), liveness, modules: globalThis.__wasmDump.out.map(r => digest(r.bytes)), samples });
        b.em.destroy();
    }
}
if (arg('--out')) fs.writeFileSync(arg('--out'), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output));
