import fs from 'node:fs';
const r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(r.status!=='ok')throw Error(`incomplete browser run: ${r.status}`);
const median=xs=>{const a=[...xs].sort((a,b)=>a-b);return (a[(a.length-1)>>1]+a[a.length>>1])/2;};
const report={maxSpreadPercent:10,controlTolerancePercent:3,kernels:{},pass:false};
for(const kind of ['pair','spread','memory']){
    const med=i=>r.rows[i].medians[kind];
    const aa=[0,2].map(i=>100*(med(i+1)/med(i)-1));
    const ab=[4,6,8,10,12,14].map(i=>r.rows[i].arm==='baseline'?100*(med(i+1)/med(i)-1):100*(med(i)/med(i+1)-1));
    const spread={};
    for(const arm of ['baseline','candidate']){
        const a=r.rows.slice(4).filter(x=>x.arm===arm).map(x=>x.medians[kind]);
        spread[arm]=100*(Math.max(...a)-Math.min(...a))/median(a);
    }
    report.kernels[kind]={aa,ab,medianLatencyPercent:median(ab),spread,
        steady:Object.values(spread).every(x=>x<=report.maxSpreadPercent)};
}
const k=report.kernels;
const hashes=r.rows.map(row=>row.kernels.find(x=>x.kind==='memory').modules.join(','));
report.identicalControlCode=new Set(hashes).size===1;
report.pass=report.identicalControlCode && Object.values(k).every(x=>x.steady)
    && Math.abs(k.memory.medianLatencyPercent)<=report.controlTolerancePercent
    && k.spread.ab.every(x=>x < -report.controlTolerancePercent);
fs.writeFileSync(process.argv[2].replace(/\.json$/,'.judgement.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
process.exit(report.pass?0:1);
