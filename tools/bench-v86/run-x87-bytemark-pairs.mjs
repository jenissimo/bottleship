import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SHIPPING_JIT, formatFlags } from '../jit-config/shipping.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if(manifest.mutation)throw Error('cannot benchmark intentionally incorrect mutation');
const arg=n=>{const i=process.argv.indexOf(n);return i<0?undefined:process.argv[i+1];};
const tests=arg('--tests')||'DOFOUR,DOLU';
const label=arg('--label')||'x87-pair';
if(!/^[a-z0-9-]+$/.test(label))throw Error('invalid label');
const out = fs.mkdtempSync(path.join(root, `tools/bench-v86/results/${label}-bytemark-`));
const pairCount=Number(arg('--pairs')||3);
if(!Number.isInteger(pairCount)||pairCount<1||pairCount>8)throw Error('invalid pair count');
const order=Array.from({length:pairCount},(_,i)=>i%2?['candidate','baseline']:['baseline','candidate']).flat();
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ ...manifest, order, tests, flags: formatFlags(SHIPPING_JIT) }, null, 2));
console.log(`OUTPUT ${out}`);
for (const [i, arm] of order.entries()) {
    const a = manifest.arms[arm];
    if (createHash('sha256').update(fs.readFileSync(a.wasm)).digest('hex') !== a.hash) throw Error('artifact changed');
    console.log(`START ${i} ${arm}`);
    const p = spawnSync(process.execPath, [path.join(root, 'tools/bench-v86/run-bytemark.mjs'),
        '--engine', path.dirname(path.dirname(a.wasm)), '--bios', path.join(root, 'vendor/v86/bios'),
        '--flags', formatFlags(SHIPPING_JIT), '--relaxed', '1', '--tests', tests,
        '--label', `${label}-${i}-${arm}`, '--out', path.join(out, `${i}-${arm}.json`), '--timeout', '10'],
        { cwd: root, encoding: 'utf8', maxBuffer: 8 << 20 });
    fs.writeFileSync(path.join(out, `${i}-${arm}.log`), p.stdout + p.stderr);
    if (p.status !== 0) throw Error(p.stderr);
    console.log(p.stderr);
}
console.log(`DONE ${out}`);
