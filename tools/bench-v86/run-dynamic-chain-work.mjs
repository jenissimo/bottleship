// Fixed-work cross-page CALL/RET direction test. Includes initial JIT warm-up.
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
const man=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
let src=fs.readFileSync('vendor/v86/tests/jit-alive-repro.mjs','utf8');
const replace=(a,b)=>{if(src.split(a).length!==2)throw Error('Source shape changed: '+a);src=src.replace(a,b);};
replace('const ITER = 400000;','const ITER = 50000000;');
replace('const TIMEOUT_MS = 20000;','const TIMEOUT_MS = 60000;');
replace('let halted = false, timer, finalized = 0;','let halted = false, timer, finalized = 0, started = 0;');
replace('                status,','                status, elapsedMs: performance.now()-started, instructionCounter: cpu.instruction_counter[0] >>> 0,');
replace('cpu.set_jit_config(15, 1_000_000_000);','cpu.set_jit_config(15, 0);');
replace('exports["set_dispatch_stats"]?.(1)','exports["set_dispatch_stats"]?.(0)');
replace('            emulator.run();','            started=performance.now(); emulator.run();');
src=src.replace(/^if\(r\.retChaining && r\.retChainHit <= 0\).*$/m,'// Stats disabled.');
src=src.replace(/^if\(r\.retired <= 0\).*$/m,'// Tier2 accounting disabled, as in shipping.');
const rows=[];
for(const arm of ['baseline','candidate','candidate','baseline']){
 const dst=path.dirname(path.dirname(man.arms[arm].wasm));
 const file=path.join(dst,'tests/dynamic-fixed-work.mjs');fs.writeFileSync(file,src);
 const p=spawnSync('node',[file],{cwd:dst,encoding:'utf8',timeout:70000});
 fs.writeFileSync(path.join(man.dir,`fixed-${rows.length}-${arm}.log`),p.stdout+p.stderr);
 if(p.status!==0)throw Error(p.stderr||p.error?.message||p.stdout);
 const line=p.stdout.split('\n').find(l=>l.startsWith('jit-alive '));if(!line)throw Error('No result');
 const r={arm,...JSON.parse(line.slice(10))};rows.push(r);console.log(JSON.stringify(r));
 fs.writeFileSync(path.join(man.dir,'fixed-work.json'),JSON.stringify({manifest:process.argv[2],iterations:50000000,includesJitWarmup:true,rows},null,2));
}
if(rows.some(r=>r.instructionCounter!==rows[0].instructionCounter))throw Error('Instruction counts differ');
