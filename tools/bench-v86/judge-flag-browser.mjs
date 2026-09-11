import fs from 'node:fs';
const r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(r.status!=='ok')throw Error('incomplete run');
if(r.correctnessOnly)throw Error('correctness-only run: not performance evidence');
if(r.config.diagnostic)throw Error('diagnostic instrumentation: not performance evidence');
const median=xs=>{const a=[...xs].sort((a,b)=>a-b);return (a[(a.length-1)>>1]+a[a.length>>1])/2;};
const report={gate:r.config.gate,kernels:{},pass:false};
for(const kind of r.config.kinds){
    const self={},comparisons=r.config.arms.B?{AC:[],BC:[]}:{AC:[]},spreads={};
    for(let i=0;i<r.config.pairs.length;i++){
        const [a,b]=r.rows.filter(x=>x.pair===i);
        if(a.arm===b.arm)(self[a.arm]||=[]).push(100*(b.medians[kind]/a.medians[kind]-1));
        else {const c=a.arm==='C'?a:b,ref=a.arm==='C'?b:a;comparisons[ref.arm+'C'].push(100*(c.medians[kind]/ref.medians[kind]-1));}
    }
    for(const arm of Object.keys(r.config.arms)){
        const xs=r.rows.filter(x=>x.arm===arm).map(x=>x.medians[kind]);
        spreads[arm]=100*(Math.max(...xs)-Math.min(...xs))/median(xs);
    }
    const noisePass=Object.values(self).flat().every(x=>Math.abs(x)<=report.gate.maxSelfPairPercent)
        &&Object.values(spreads).every(x=>x<=report.gate.maxArmSpreadPercent);
    const identicalInput=new Set(r.rows.map(x=>x.kernels.find(k=>k.kind===kind).image)).size===1;
    report.kernels[kind]={self,comparisons,medians:Object.fromEntries(Object.entries(comparisons).map(([k,v])=>[k,median(v)])),spreads,noisePass,identicalInput};
}
report.pass=Object.values(report.kernels).every(k=>k.noisePass&&k.identicalInput);
fs.writeFileSync(process.argv[2].replace(/\.json$/,'.judgement.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
process.exit(report.pass?0:1);
