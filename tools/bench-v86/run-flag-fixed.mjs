import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../../', import.meta.url));
const snapshot = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (snapshot.mutation) throw Error('mutation cannot be benchmarked');
const mulpd=process.argv.includes('--mulpd');
const inlineMove=mulpd||process.argv.includes('--inline-move');
const arms = inlineMove ? {A:{...snapshot.arms.baseline,flag:0},C:{...snapshot.arms.candidate,flag:0,inlineMove:true}}
    : { A: { ...snapshot.arms.baseline, flag: 0 }, B: { ...snapshot.arms.baseline, flag: 1 }, C: { ...snapshot.arms.candidate, flag: 1 } };
if(mulpd)arms.A.inlineMove=true;
if(mulpd&&['simd','scalar-order'].includes(snapshot.mulpdMode))arms.C.inlineMulpd=true;
const pairs = inlineMove ? ['AA','AA','CC','CC','AC','CA','AC','CA'] : ['AA','AA','BB','BB','CC','CC','AC','CA','BC','CB','AC','CA','BC','CB'];
const out = fs.mkdtempSync(path.join(root, 'tools/bench-v86/results/flag-fixed-'));
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const median = xs => { const a = [...xs].sort((a,b) => a-b); return (a[(a.length-1)>>1]+a[a.length>>1])/2; };
const kinds = inlineMove || process.argv.includes('--sse') ? ['flags-integer','flags-sse-reg','flags-sse-mem'] : ['flags-integer','flags-mixed','flags-fp'];
const manifest = { arms, pairs, kinds, iterations: 5000000, rounds: 7,
    experiment:snapshot.experiment,mulpd,
    gate: { maxSelfPairPercent: 3, maxArmSpreadPercent: 10 },
    hashes: Object.fromEntries(['flag-fixed-work.mjs','x87-workload.mjs'].map(n => [n,sha(path.join(root,'tools/bench-v86',n))])) };
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));
console.log(`OUTPUT ${out}`);
const rows = [];
for (const [pair, label] of pairs.entries()) for (const [side, arm] of [...label].entries()) {
    const a = arms[arm]; if (sha(a.wasm) !== a.hash) throw Error('artifact changed');
    const file = path.join(out,`${pair}-${side}-${arm}.json`);
    const p = spawnSync(process.execPath,[path.join(root,'tools/bench-v86/flag-fixed-work.mjs'),
        '--wasm',a.wasm,'--flag',String(a.flag),'--kind',kinds.join(','),'--iterations',String(manifest.iterations),'--rounds',String(manifest.rounds),'--out',file,...(a.inlineMove?['--inline-move']:[]),...(a.inlineMulpd?['--inline-mulpd']:[])],
        {cwd:root,encoding:'utf8',maxBuffer:8<<20});
    fs.writeFileSync(file+'.log',p.stdout+p.stderr); if (p.status !== 0) throw Error(p.stderr);
    const data = JSON.parse(fs.readFileSync(file,'utf8'));
    const row = {pair,side,arm,medians:Object.fromEntries(data.results.map(r => [r.kind,median(r.samples.map(s => s.ms))]))};
    rows.push(row); console.log(JSON.stringify(row));
}
const summary = { rows, kernels: {} };
for (const kind of kinds) {
    const self = {}, comparisons = inlineMove ? {AC:[]} : { AC: [], BC: [] }, spreads = {};
    for (let i=0;i<pairs.length;i++) {
        const [a,b] = rows.filter(r => r.pair === i);
        if (a.arm === b.arm) (self[a.arm] ||= []).push(100*(b.medians[kind]/a.medians[kind]-1));
        else {
            const c = a.arm === 'C' ? a : b, ref = a.arm === 'C' ? b : a;
            comparisons[ref.arm+'C'].push(100*(c.medians[kind]/ref.medians[kind]-1));
        }
    }
    for (const arm of Object.keys(arms)) {
        const xs = rows.filter(r => r.arm === arm).map(r => r.medians[kind]);
        spreads[arm] = 100*(Math.max(...xs)-Math.min(...xs))/median(xs);
    }
    const noisePass = Object.values(self).flat().every(x => Math.abs(x)<=manifest.gate.maxSelfPairPercent)
        && Object.values(spreads).every(x => x<=manifest.gate.maxArmSpreadPercent);
    summary.kernels[kind] = { self, comparisons, medians:Object.fromEntries(Object.entries(comparisons).map(([k,v])=>[k,median(v)])),spreads,noisePass };
}
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary.kernels));
