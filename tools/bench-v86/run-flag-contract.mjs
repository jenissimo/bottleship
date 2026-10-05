import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
import {SHIPPING_JIT,flagsWith,formatFlags} from '../jit-config/shipping.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const manifest=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if (manifest.mutation) throw Error('refusing to benchmark an intentionally incorrect mutation');
const arg=n=>{const i=process.argv.indexOf(n);return i<0?undefined:process.argv[i+1];};
const previous=arg('--previous')?JSON.parse(fs.readFileSync(arg('--previous'),'utf8')):null;
if(previous?.mutation)throw Error('invalid reference');
const reference=previous?'previous':'locals';
const arms={shipping:{...manifest.arms.baseline,flag:0},[reference]:{...(previous?previous.arms.candidate:manifest.arms.baseline),flag:1},contracts:{...manifest.arms.candidate,flag:1}};
const order=['shipping',reference,'contracts','contracts',reference,'shipping'];
const tests=arg('--tests')||'DONUMSORT,DOBITFIELD,DOFOUR,DOLU';
const out=fs.mkdtempSync(path.join(root,'tools/bench-v86/results/flag-contract-'));
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({arms,order,tests,created:new Date().toISOString()},null,2));
console.log(`OUTPUT ${out}`);
for(const [i,arm] of order.entries()){
 const a=arms[arm];if(createHash('sha256').update(fs.readFileSync(a.wasm)).digest('hex')!==a.hash)throw Error('artifact changed');
 console.log(`START ${i} ${arm}`);
 const p=spawnSync(process.execPath,[path.join(root,'tools/bench-v86/run-bytemark.mjs'),
 '--engine',path.dirname(path.dirname(a.wasm)),'--bios',path.join(root,'vendor/v86/bios'),
 '--flags',formatFlags(flagsWith(SHIPPING_JIT,[[21,a.flag]])),'--relaxed','1',
 '--tests',tests,'--label',`${i}-${arm}`,'--out',path.join(out,`${i}-${arm}.json`),'--timeout','10'],
 {cwd:root,encoding:'utf8',maxBuffer:8<<20});
 fs.writeFileSync(path.join(out,`${i}-${arm}.log`),p.stdout+p.stderr);
 if(p.status!==0)throw Error(p.stderr);console.log(p.stderr);
}
console.log(`DONE ${out}`);
