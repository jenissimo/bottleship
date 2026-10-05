import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { V86 } from '../../vendor/v86/build/libv86.mjs';
import { SHIPPING_JIT } from '../jit-config/shipping.mjs';
import { createX87Workload } from './x87-workload.mjs';
const arg = n => { const i = process.argv.indexOf(n); return i < 0 ? undefined : process.argv[i + 1]; };
const wasm = arg('--wasm');
const flagLocals = Number(arg('--flag') || 0);
const inlineMove=process.argv.includes('--inline-move');
const inlineMulpd=process.argv.includes('--inline-mulpd');
const sha = b => createHash('sha256').update(b).digest('hex');
const { image, boot, state, checkResult, measure } = createX87Workload(V86, { wasm, shipping: SHIPPING_JIT });
const result = { wasm, hash: sha(fs.readFileSync(wasm)), flagLocals, inlineMove, node: process.version, results: [] };
for (const kind of (arg('--kind') || 'flags-integer,flags-mixed,flags-fp').split(',')) {
    const im = image(kind);
    if (process.argv.includes('--check')) {
        const ref = await boot(im, { jit: false, flagLocals });
        checkResult(state(ref.c, ref.w, kind), 120000, kind);
        ref.em.destroy();
    }
    const b = await boot(im, { flagLocals });
    checkResult(state(b.c, b.w, kind), 120000, kind);
    const warmup=[];
    for (let i = 0; i < 3; i++) {
        warmup.push(measure(b, im, 1000000, {warming:true}));
        await new Promise(r=>setTimeout(r,0));
    }
    const samples = [];
    for (let i = 0; i < Number(arg('--rounds') || 7); i++) samples.push(measure(b, im, Number(arg('--iterations') || 1000000)));
    const modules = globalThis.__wasmDump.out.map(r => ({ hash: sha(r.bytes), imports: WebAssembly.Module.imports(new WebAssembly.Module(r.bytes)).map(x => x.name) }));
    const required=kind.startsWith('flags-sse-')?(inlineMove?['instr_660F59']:['instr_0F16','instr_660F59']):kind==='flags-integer'?[]:['instr16_D9_7_reg'];
    if(inlineMulpd){const i=required.indexOf('instr_660F59');if(i>=0)required.splice(i,1);}
    if (!required.every(name=>modules.some(m=>m.imports.includes(name)))) throw Error('required helper absent from JIT');
    if (inlineMove && modules.some(m=>m.imports.includes('instr_0F16'))) throw Error('move helper was not eliminated');
    if (inlineMulpd && modules.some(m=>m.imports.includes('instr_660F59'))) throw Error('MULPD helper was not eliminated');
    result.results.push({ kind, image: sha(im.bytes), setup: im.setup, body: im.body, end: im.end, modules, warmup, samples });
    b.em.destroy();
}
if (arg('--out')) fs.writeFileSync(arg('--out'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
