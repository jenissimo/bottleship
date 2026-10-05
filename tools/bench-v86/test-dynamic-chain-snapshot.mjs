import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
const manifest=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
for(const arm of ['baseline','candidate']){
 const a=manifest.arms[arm],dst=path.dirname(path.dirname(a.wasm));
 if(createHash('sha256').update(fs.readFileSync(a.wasm)).digest('hex')!==a.hash)throw Error('Artifact changed');
 fs.mkdirSync(path.join(dst,'tests'),{recursive:true});
 for(const stats of [true,false]){
  let s=fs.readFileSync('vendor/v86/tests/jit-alive-repro.mjs','utf8');
  if(!stats){s=s.replace('exports["set_dispatch_stats"]?.(1)','exports["set_dispatch_stats"]?.(0)');s=s.replace(/^if\(r\.retChaining && r\.retChainHit <= 0\).*$/m,'// Disabled dispatch counters cannot prove execution; chainEntries and retired still must move.');}
  const name=`dynamic-${stats?'instrumented':'clean'}-alive.mjs`;
  fs.writeFileSync(path.join(dst,'tests',name),s);
  const r=spawnSync('node',[path.join(dst,'tests',name)],{cwd:dst,encoding:'utf8',timeout:30000});
  fs.writeFileSync(path.join(dst,`${name}.log`),r.stdout+r.stderr);
  console.log(`${arm} stats=${stats}: ${r.stdout.trim()}`);
  if(r.status!==0)throw Error(r.stderr||r.error?.message||'Test failed');
 }
}
