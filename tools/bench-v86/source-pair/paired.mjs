import {call,waitFile,words,freshGuest} from './browser.mjs';
import {compare} from './oracle.mjs';
const log=s=>{document.querySelector('#output').textContent+=s+'\n';document.querySelector('#status').textContent=s;};
const cpuCode=`const p=System.getInstance().process,c=p?.v86?.cpu??p?.v86?.v86?.cpu;
    if(!c)throw Error('No CPU');const w=c.wm.exports,t=c.wm.wasm_table;`;
const median=a=>{const s=[...a].sort((a,b)=>a-b),n=s.length;return(s[(n-1)>>1]+s[n>>1])/2;};
document.querySelector('#paired').onclick=async()=>{
    document.querySelectorAll('button').forEach(b=>b.disabled=true);
    document.querySelector('#output').textContent='';
    const cfg=await(await fetch('/apps/source-pair-lab/config.json')).json();
    const control=new URLSearchParams(location.search).get('control')==='identity';
    const result={schema:1,status:'running',mode:'paired-rotate',build:cfg.build,userAgent:navigator.userAgent,
        performanceAccepted:false,control:control?'identity':null,rows:[]};
    const save=()=>fetch(cfg.collector,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
    try {
        for(const mode of control?[0]:[0,1,2,3]) {
            const c={seed:73,operations:8388608,burst:mode===0?8388608:mode===3?524288:2048,mode,variable:1};
            const row={config:c,samples:[]};result.rows.push(row);
            const token=crypto.getRandomValues(new Uint32Array(1))[0]>>>1;
            const file=(round,suffix)=>`c:\\pair-${token+round}-${suffix}.bin`;
            log(`Mode ${mode}: loading and warming production JIT…`);
            await freshGuest();await call('resetWorkerFlags');
            await call('openWgb','/apps/source-pair-lab/pair.wgb',{args:`${c.seed} ${c.operations} ${c.burst} ${c.mode} ${c.variable} 2 ${token}`,reload:false});
            await waitFile(file(0,'ready'));await call('stopLogs');await call('jitPublications','arm');
            await call('dbgCall','aot','arm',[0x401]);
            let round=0;
            const run=async(arm,warming)=>{
                await waitFile(file(round,'ready'));
                const compileBefore=await call('dbgCall','aot','compileStats');
                await call('logPhase','arm','SOURCE_PAIR_BEGIN','SOURCE_PAIR_END');
                await call('fsWrite',file(round,'go'),'go');
                const out=await waitFile(file(round,'result'));
                const timing=await call('logPhase','seal');
                const compileAfter=await call('dbgCall','aot','compileStats');
                if(!timing.valid)throw Error(`Bad marker interval ${JSON.stringify(timing)}`);
                const ledger=compare(words(out.content),c);
                if(timing.compileBegin===null||timing.compileEnd===null)throw Error('Missing phase compile counters');
                const sample={round:round++,arm,warming,timing,ledger,compiled:timing.compileEnd-timing.compileBegin,
                    outerCompiled:compileAfter.count-compileBefore.count};row.samples.push(sample);
                log(`Mode ${mode} ${arm}${warming?' warm':''}: ${timing.ms.toFixed(2)} ms`);
                return sample;
            };
            for(let i=0;i<3;i++)await run('A',true);
            await call('pause');await call('jitPublications','seal');
            row.publications=await call('jitPublications','export');
            row.aotSnapshot=await call('dbgCall','aot','snapshot');
            await call('dbgCall','aot','disarm');
            row.aot=await call('aotArtifacts','export');
            if(row.publications.dropped)throw Error('Dropped captures');
            const latest=new Map();
            for(const e of row.publications.events)if(e.status==='published')latest.set(e.tableIndex,e);
            const current=await call('evalWorker',cpuCode+`return ${JSON.stringify([...latest.values()])}.filter(e=>
                (w.jit_aot_page_table_index(e.start&~4095)>>>0)===e.tableIndex);`);
            row.transforms=[];
            for(const e of current) {
                if(e.start<0x400000||e.start>=0x402000)continue;
                const m=row.publications.modules.find(m=>m.sha256===e.sha256);
                const bytes=Uint8Array.from(atob(m.base64),c=>c.charCodeAt(0));
                const response=await fetch(new URL('/transform',cfg.collector),{method:'POST',body:bytes});
                const tr=await response.json();if(!response.ok)throw Error(tr.error);
                if(tr.inputSha256!==e.sha256)throw Error('Transform input mismatch');
                if(tr.sites)row.transforms.push({...tr,event:e,...(control?{
                    base64:m.base64,outputSha256:tr.inputSha256,selectedSites:tr.sites,sites:0,control:'identity'}:{})});
            }
            if(!row.transforms.length)throw Error('No rotate transform');
            row.install=await call('evalWorker',cpuCode+`
                state.variants=[];
                for(const tr of ${JSON.stringify(row.transforms)}) {
                    const idx=tr.event.tableIndex,slot=tr.event.tableSlot;
                    if((w.jit_aot_page_table_index(tr.event.start&~4095)>>>0)!==idx)throw Error('Publication no longer owns page');
                    const original=t.get(slot),bytes=Uint8Array.from(atob(tr.base64),c=>c.charCodeAt(0));
                    const candidate=new WebAssembly.Instance(new WebAssembly.Module(bytes),{e:c.jit_imports}).exports.f;
                    if(typeof candidate!=='function')throw Error('No candidate f');
                    state.variants.push({idx,slot,original,candidate,current:original,page:tr.event.start&~4095});
                }
                return state.variants.map(v=>({idx:v.idx,slot:v.slot,page:v.page}));`);
            row.replaced=await call('aotArtifacts','replace',{engine:row.transforms[0].engineSha256,
                units:row.transforms.map(tr=>({tableIndex:tr.event.tableIndex,inputSha256:tr.inputSha256,base64:tr.base64}))});
            await call('dbgCall','aot','drop');
            row.replay=await call('dbgCall','aot','replay');
            row.replayOwnership=await call('evalWorker',cpuCode+`return state.variants.map(v=>{
                if((w.jit_aot_page_table_index(v.page)>>>0)!==v.idx)throw Error('AOT replay did not publish variant');
                v.candidate=t.get(v.slot);v.current=v.candidate;
                if(typeof v.candidate!=='function')throw Error('Missing replay function');
                return {idx:v.idx,registered:w.jit_aot_registered_count()>>>0};
            });`);
            const select=async arm=>call('evalWorker',cpuCode+`
                return state.variants.map(v=>{
                    if(t.get(v.slot)!==v.current||(w.jit_aot_page_table_index(v.page)>>>0)!==v.idx)throw Error('Variant invalidated');
                    const next=v.${arm==='A'?'original':'candidate'};t.set(v.slot,next);v.current=next;
                    v.entries=w.jit_get_module_entry_total(v.idx)>>>0;
                    return {idx:v.idx,entries:v.entries};
                });`);
            await select('C');await call('resume');
            for(let i=0;i<5;i++)await run('C',true);
            // ABBA reverses pair order; both variants coexist in the same warmed engine.
            let accepted=0;
            for(let block=0;block<6&&accepted<2;block++) {
            const quartet=[];
            for(const arm of block%2?['C','A','A','C']:['A','C','C','A']) {
                await call('pause');await select(arm);await call('resume');
                const s=await run(arm,false);
                s.block=block;quartet.push(s);
                s.liveness=await call('evalWorker',cpuCode+`return state.variants.map(v=>({
                    sameFn:t.get(v.slot)===v.current,ownsPage:(w.jit_aot_page_table_index(v.page)>>>0)===v.idx,
                    entries:((w.jit_get_module_entry_total(v.idx)>>>0)-v.entries)>>>0}));`);
                if(s.liveness.some(v=>!v.sameFn||!v.ownsPage||!v.entries))throw Error('Candidate not executed or invalidated');
            }
            const clean=quartet.every(s=>s.compiled===0);
            for(const s of quartet)s.accepted=clean;
            if(clean)accepted++;else log(`Mode ${mode}: quartet ${block} excluded (JIT compilation); retaining all raw samples`);
            }
            if(accepted<2)throw Error('Could not collect two compilation-free quartets in six attempts');
            await call('pause');await select('A');
            row.medians=Object.fromEntries(['A','C'].map(arm=>[arm,median(row.samples.filter(s=>s.accepted&&s.arm===arm).map(s=>s.timing.ms))]));
            row.speedup=row.medians.A/row.medians.C;
            log(`Mode ${mode}: ${row.speedup.toFixed(3)}x; state and module ownership PASS`);await save();
        }
        result.status='ok';log('Paired experiment complete. See raw samples; no game-wide claim.');
    } catch(error) {result.status='error';result.error=String(error);log(`ERROR: ${error}`);}
    finally {try{await call('pause');}catch{} await save();window.pairResult=result;document.querySelectorAll('button').forEach(b=>b.disabled=false);}
};
