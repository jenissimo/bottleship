import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const dir=process.argv[2],manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
const names={DONUMSORT:'NUMERIC SORT',DOSTRINGSORT:'STRING SORT',DOBITFIELD:'BITFIELD',DOEMF:'FP EMULATION',DOFOUR:'FOURIER',DOASSIGN:'ASSIGNMENT',DOIDEA:'IDEA',DOHUFF:'HUFFMAN',DONNET:'NEURAL NET',DOLU:'LU DECOMPOSITION'};
const selected=manifest.tests.split(','),expected=selected.map(t=>names[t]);
if(expected.some(x=>!x)||manifest.order.length%2)throw Error('unsupported or incomplete protocol');
const flags=Object.fromEntries(manifest.flags.split(',').map(s=>s.split('=').map(Number)));
const rows=[];
for(const [i,arm] of manifest.order.entries()){
    const a=manifest.arms[arm],r=JSON.parse(fs.readFileSync(path.join(dir,`${i}-${arm}.json`),'utf8'));
    if(createHash('sha256').update(fs.readFileSync(a.wasm)).digest('hex')!==a.hash)throw Error('artifact changed');
    if(path.resolve(r.engine)!==path.dirname(path.dirname(path.resolve(a.wasm))))throw Error('wrong engine path');
    if(JSON.stringify(r.tests_selected)!==JSON.stringify(selected))throw Error('wrong selected workload');
    if(Object.keys(r.scores).length!==expected.length||expected.some(k=>!Number.isFinite(r.scores[k])||r.scores[k]<=0))throw Error('missing/extra/invalid scores');
    if(!r.jit_config_provenance?.verified||Object.entries(flags).some(([k,v])=>r.flags[k]!==v))throw Error('unverified/wrong flags');
    if(r.relaxed!==1||!r.finished_at||r.wall_ms<=0)throw Error('incomplete or wrong mode');
    if(!Number.isFinite(r.clock?.ratio)||Math.abs(r.clock.ratio-1)>0.03)throw Error('guest clock outside existing 3% tolerance');
    if(!r.judgements?.length||r.judgements.some(j=>!j.ok)||r.helper_census)throw Error('refused or instrumented run');
    rows.push({i,arm,scores:r.scores,clockRatio:r.clock.ratio});
}
const pairs=[];
for(let i=0;i<rows.length;i+=2){
    const pair=rows.slice(i,i+2),a=pair.find(r=>r.arm==='baseline'),c=pair.find(r=>r.arm==='candidate');
    if(!a||!c)throw Error('expected baseline/candidate pair');
    pairs.push(Object.fromEntries(expected.map(k=>[k,100*(c.scores[k]/a.scores[k]-1)])));
}
const report={runIntegrity:true,performanceAcceptance:'Not assessed: this protocol has no independent A/A noise floor. Ratios are observations, not universal speedup.',rows,pairThroughputPercent:pairs};
fs.writeFileSync(path.join(dir,'paired-summary.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
