import {compare,schedule} from './oracle.mjs';

const ui = document.querySelector('#output'), status = document.querySelector('#status');
const log = text => { ui.textContent += `${text}\n`; status.textContent=text; };
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let iframe;
export async function call(cmd,...args) {
    const h = iframe?.contentWindow?.__BS__?.harness;
    if(!h) throw Error('Guest harness is unavailable');
    const r = await h.__runSteps([{cmd,args}]);
    if(!r.ok) throw Error(`${cmd}: ${JSON.stringify(r.error)}`);
    return r.steps.at(-1).result;
}
export async function waitFile(name, timeout=90000) {
    const t=performance.now();
    while(performance.now()-t<timeout) {
        const s=await call('fsStat',name);
        if(s?.exists && s.size) return await call('fsRead',name,{encoding:'base64'});
        await sleep(150);
    }
    throw Error(`Timed out waiting for ${name}`);
}
export function words(base64) {
    const b=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
    if(b.length%4) throw Error('Misaligned result');
    const v=new DataView(b.buffer);
    return Array.from({length:b.length/4},(_,i)=>v.getUint32(i*4,true));
}
export async function freshGuest() {
    iframe?.remove();
    iframe=document.createElement('iframe');
    iframe.src='/?game=dev&bs=source-pair-browser';
    document.querySelector('#guest').append(iframe);
    const t=performance.now();
    while(performance.now()-t<90000) {
        if(iframe.contentWindow?.__BS__?.harness) return;
        await sleep(250);
    }
    throw Error('BottleShip iframe did not expose the harness');
}
async function direct(config) {
    const worker=new Worker('/apps/source-pair-lab/direct-worker.mjs',{type:'module'});
    try {
        return await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>{worker.terminate();reject(Error('Direct worker timeout'));},90000);
            worker.onmessage=({data})=>{clearTimeout(timer);data.status==='ok'?resolve(data):reject(Error(data.error));};
            worker.onerror=e=>{clearTimeout(timer);reject(Error(e.message));};
            worker.postMessage(config);
        });
    } finally {worker.terminate();}
}
const cases=[
    {name:'long-compute',seed:73,operations:65537,burst:65537,mode:0,variable:0},
    {name:'short-compute',seed:73,operations:65537,burst:257,mode:0,variable:1},
    {name:'wasm-hypercall',seed:73,operations:65537,burst:257,mode:1,variable:1},
    {name:'sync-js',seed:73,operations:65537,burst:257,mode:2,variable:1},
    {name:'async-resume',seed:4294967295,operations:65537,burst:8192,mode:3,variable:1},
];
async function run(full) {
    document.querySelectorAll('button').forEach(b=>b.disabled=true);
    ui.textContent='';
    const cfg=await (await fetch('/apps/source-pair-lab/config.json')).json();
    const result={schema:1,status:'running',startedAt:new Date().toISOString(),userAgent:navigator.userAgent,
        build:cfg.build,mode:full?'full-runtime-correctness':'direct-correctness',
        performanceAccepted:false,traceCalibrated:false,rows:[]};
    const save=async()=>{
        const r=await fetch(cfg.collector,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
        if(!r.ok) throw Error(`Artifact collector HTTP ${r.status}`);
    };
    try {
        for(const c of cases) {
            log(`${c.name}: direct Wasm…`);
            const row={config:c,schedule:schedule(c),direct:await direct(c)};
            result.rows.push(row);
            if(full) {
                const token=crypto.getRandomValues(new Uint32Array(1))[0];
                const file=suffix=>`c:\\pair-${token}-${suffix}.bin`;
                log(`${c.name}: loading PE in BottleShip…`);
                await freshGuest();
                await call('resetWorkerFlags');
                await call('openWgb','/apps/source-pair-lab/pair.wgb',{
                    args:`${c.seed} ${c.operations} ${c.burst} ${c.mode} ${c.variable} 1 ${token}`,reload:false});
                await waitFile(file('ready'));
                // A fresh iframe owns its own guest. Capture is diagnostics, never a timing arm.
                await call('stopLogs');
                await call('jitPublications','arm');
                row.runtimeBefore=await call('evalWorker',`const w=globalThis.preemption.getWasmExports();
                    return {config:Array.from({length:32},(_,i)=>w.get_jit_config(i)),
                        hypercalls:globalThis.hypercall?.getHandlerReport?.()??null,
                        compile:globalThis.__jitCompileStats??null};`);
                await call('fsWrite',file('go'),'go');
                const output=await waitFile(file('result'));
                await call('pause');
                await call('jitPublications','seal');
                row.guest={state:words(output.content)};
                row.guest.ledger=compare(row.guest.state,c);
                if(row.guest.state.some((v,i)=>v!==row.direct.state[i])) throw Error('PE/Wasm differential mismatch');
                row.publications=await call('jitPublications','export');
                row.runtimeAfter=await call('evalWorker',`return {compile:globalThis.__jitCompileStats??null,
                    hypercalls:globalThis.hypercall?.getHandlerReport?.()??null};`);
                row.hypercallDelta=(row.runtimeAfter.hypercalls??[]).map(h=>{
                    const b=row.runtimeBefore.hypercalls?.find(x=>x.handlerId===h.handlerId);
                    return {...h,served:h.served-(b?.served??0),fellBack:h.fellBack-(b?.fellBack??0)};
                }).filter(h=>h.served||h.fellBack);
                if(c.mode===1 && !row.hypercallDelta.some(h=>h.names.includes('kernel32.gettickcount') && h.served===row.guest.ledger.services && !h.fellBack && !h.saturated)) {
                    throw Error('Requested GetTickCount calls were not all served by Wasm');
                }
                row.report=await call('report');
                if(row.publications.dropped) throw Error('JIT publication capture dropped records');
                if(!row.publications.events.some(e=>e.status==='published' && e.start>=0x400000 && e.start<0x402000)) {
                    throw Error('No published JIT module for the PE text pages');
                }
            }
            log(`${c.name}: PASS, ${row.direct.ledger.operations} updates, ${row.direct.ledger.phases} phases, ${row.direct.ledger.wordsCompared} state words`);
            await save();
            iframe?.remove();iframe=undefined;
        }
        result.status='ok';
        log(`PASS: ${cases.length} scenarios. Artifacts saved; no speedup claim.`);
    } catch(error) {
        result.status='error';result.error=String(error);
        if(iframe?.contentWindow?.__BS__?.harness) {
            try {result.failureReport=await call('report');} catch(e) {result.reportError=String(e);}
        }
        log(`ERROR: ${error}`);
    } finally {
        try {if(iframe) await call('pause');} catch {}
        result.completedAt=new Date().toISOString();
        window.pairResult=result;
        try {await save();} catch(e) {log(`SAVE FAILED: ${e}`);}
        document.querySelectorAll('button').forEach(b=>b.disabled=false);
    }
}
document.querySelector('#start').onclick=()=>run(true);
document.querySelector('#direct').onclick=()=>run(false);
