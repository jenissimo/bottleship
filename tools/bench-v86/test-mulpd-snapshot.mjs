// Reproduce exact cross-artifact NaN checks and hot fault/restart checks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url));
const manifest=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const out=fs.mkdtempSync(path.join(os.tmpdir(),'mulpd-contract-'));
console.log(`OUTPUT ${out}`);
for(const arm of ['baseline','candidate']){
    const a=manifest.arms[arm];
    if(createHash('sha256').update(fs.readFileSync(a.wasm)).digest('hex')!==a.hash)throw Error('artifact changed');
    const env={...process.env,V86_WASM_PATH:a.wasm,V86_INLINE_SSE_MOVE:'1',V86_INLINE_MULPD:arm==='baseline'?'0':['simd','scalar-order'].includes(manifest.mulpdMode)?'1':'guarded'};
    delete env.V86_SSE_REFERENCE;
    if(arm==='candidate')env.V86_SSE_REFERENCE=path.join(out,'baseline-contract.log');
    for(const [kind,args] of [['contract',['vendor/v86/tests/sse-flag-contract-diff.mjs']],['fault',['vendor/v86/tests/sse-move-pagefault.mjs','--mulpd']]]){
        const p=spawnSync(process.execPath,args,{cwd:root,env,encoding:'utf8',maxBuffer:8<<20});
        fs.writeFileSync(path.join(out,`${arm}-${kind}.log`),p.stdout+p.stderr);
        if(p.status!==0)throw Error(`${arm}/${kind}: ${p.stderr}`);
        console.log(`${arm}/${kind}: ${p.stdout.trim().split(/\r?\n/).at(-1)}`);
    }
}
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));
