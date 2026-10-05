import fs from 'node:fs';
import path from 'node:path';
const [dir,prefix]=process.argv.slice(2);if(!dir||!prefix)throw Error('Expected evidence directory and run sequence prefix');
const rows=fs.readdirSync(dir).filter(f=>f.startsWith(prefix)&&/^\d+\.json$/.test(f)).sort().map(f=>JSON.parse(fs.readFileSync(path.join(dir,f))));
const start=rows.find(r=>r.kind==='paired-start'),end=rows.find(r=>r.kind==='paired-complete'),restore=rows.find(r=>r.kind==='paired-restored');
const windows=rows.filter(r=>r.kind==='paired-window').map(r=>r.data);
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length,gm=a=>Math.exp(mean(a.map(Math.log)));
const quartetRatios=[];for(let i=0;i+3<windows.length;i+=4){const q=windows.slice(i,i+4);quartetRatios.push(gm(q.filter(r=>r.arm==='C').map(r=>r.fps))/gm(q.filter(r=>r.arm==='A').map(r=>r.fps)));}
const modules=(windows[0]?.before.variants??[]).map((v,i)=>{const perFrame=windows.map(r=>r.entries[i]/(r.after.serial-r.before.serial)),m=mean(perFrame);return {idx:v.idx,perFrame,mean:m,min:Math.min(...perFrame),max:Math.max(...perFrame),cv:Math.sqrt(mean(perFrame.map(x=>(x-m)**2)))/m};});
console.log(JSON.stringify({start:start?.seq,identity:start?.data.identity,complete:!!end,restored:!!restore,allValid:windows.length===8&&windows.every(r=>r.valid),fps:windows.map(r=>({arm:r.arm,fps:r.fps})),quartetRatios,geometricRatio:quartetRatios.length?gm(quartetRatios):null,modules,note:'Same-session descriptive ratios; no independent-boot confidence interval.'},null,2));
