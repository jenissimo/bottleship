import fs from 'node:fs';
const file=process.argv[2],events=JSON.parse(fs.readFileSync(file,'utf8')).traceEvents;
const starts=new Map(),windows=[];
for(const e of [...events].sort((a,b)=>a.ts-b.ts)){
    const m=/^guest-sample-(\d+)-(start|end)$/.exec(e.name);
    if(!m||e.ph!=='I')continue;
    const key=`${e.pid}:${e.tid}:${m[1]}`;
    if(m[2]==='start')starts.set(key,e);
    else if(starts.has(key)){
        const s=starts.get(key);starts.delete(key);
        windows.push({pid:e.pid,tid:e.tid,sample:Number(m[1]),start:s.ts,end:e.ts,
            wallMs:(e.ts-s.ts)/1000,cpuMs:(e.tts-s.tts)/1000});
    }
}
if(!windows.length)throw Error('no marked windows');
function unionMs(intervals){
    intervals.sort((a,b)=>a[0]-b[0]);let total=0,end=-Infinity;
    for(const [a,b] of intervals){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}
    return total/1000;
}
for(const w of windows){
    const overlapping=events.filter(e=>e.pid===w.pid&&e.tid===w.tid&&e.ph==='X'&&e.ts<w.end&&e.ts+e.dur>w.start);
    const intervals=re=>overlapping.filter(e=>re.test(e.name)).map(e=>[Math.max(w.start,e.ts),Math.min(w.end,e.ts+e.dur)]);
    w.gcMs=unionMs(intervals(/GC|Scavenge|MajorGC|MinorGC/));
    w.compileMs=unionMs(intervals(/compile|Compile|Optimize|Deopt/));
    w.offCpuMs=w.wallMs-w.cpuMs;
}
const median=a=>{a.sort((x,y)=>x-y);return a[a.length>>1];};
const threads=[...new Set(windows.map(w=>`${w.pid}:${w.tid}`))].map(id=>{
    const ws=windows.filter(w=>`${w.pid}:${w.tid}`===id);
    return {id,samples:ws.length,...Object.fromEntries(['wallMs','cpuMs','offCpuMs','gcMs','compileMs'].map(k=>[k,median(ws.map(w=>w[k]))]))};
});
const result={diagnosticOnly:true,notes:'Marked intervals include measure validation. GC/compile are unions of matching complete events on the worker thread; absence does not exclude untraced/background work. Thread CPU is not a frequency or hardware-counter measurement.',threads,windows};
const profiles=new Map(),leafSamples={};
for(const e of [...events].sort((a,b)=>a.ts-b.ts)){
    if(e.name!=='Profile'&&e.name!=='ProfileChunk')continue;
    const key=`${e.pid}:${e.id}`,d=e.args?.data;
    if(e.name==='Profile'){profiles.set(key,{time:d.startTime,tid:e.tid,nodes:new Map()});continue;}
    const p=profiles.get(key);if(!p)continue;
    for(const n of d.cpuProfile?.nodes||[])p.nodes.set(n.id,n);
    const samples=d.cpuProfile?.samples||[];
    for(let i=0;i<samples.length;i++){
        p.time+=d.timeDeltas[i];
        if(!windows.some(w=>w.pid===e.pid&&w.tid===p.tid&&p.time>=w.start&&p.time<=w.end))continue;
        const f=p.nodes.get(samples[i])?.callFrame;
        const name=f?`${f.codeType||''}:${f.functionName} ${f.url||''}`:'unresolved';
        leafSamples[name]=(leafSamples[name]||0)+1;
    }
}
result.leafSamples=Object.entries(leafSamples).sort((a,b)=>b[1]-a[1]);
fs.writeFileSync(file.replace(/\.json$/,'.analysis.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({diagnosticOnly:true,threads,leafSamples:result.leafSamples.slice(0,12)},null,2));
