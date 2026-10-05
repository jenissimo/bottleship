import {call,freshGuest} from './browser.mjs';
const log=s=>{document.querySelector('#output').textContent+=s+'\n';document.querySelector('#status').textContent=s;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const cpu=`const s=System.getInstance(),p=s.process,c=p?.v86?.cpu??p?.v86?.v86?.cpu;
if(!c)throw Error('No CPU');const w=c.wm.exports,t=c.wm.wasm_table,r=s.services.render;`;
const scene=cpu+`const mem=p.getCurrentMemory(),v=new DataView(mem.buffer,mem.byteOffset,mem.byteLength),ptr=v.getUint32(0x73619c,true);
const scene={raceState:ptr?v.getUint32(ptr,true):null,moverCounter:v.getUint32(0x78eb4c,true),
serial:r.getPresentSerial(),guestSerial:r.getGuestPresentSerial(),source:r.getLastPresenterKind(),time:performance.now(),
paused:s.isPaused,config:Array.from({length:32},(_,i)=>w.get_jit_config(i)),compile:globalThis.__jitCompileStats?.count??0};`;
async function action(fn){document.querySelectorAll('button').forEach(b=>b.disabled=true);
try{if(location.origin!=='http://127.0.0.1:5174')throw Error('Separate lab origin required');await fn();}
catch(e){log(String(e.stack||e));}finally{document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
for(const button of document.querySelectorAll('[data-vk]'))button.onclick=()=>action(async()=>{
    await call('resume');const response=await call('keyHold',Number(button.dataset.vk),1000);
    if(!response.ok)throw Error('Guest input refused');await sleep(1100);log('Guest key '+response.vk+' held for one second.');
});
document.querySelector('#load-game').onclick=()=>action(async()=>{
    await freshGuest();await call('resetWorkerFlags');
    log('Loading NFSU and its saved AOT cache…');
    await call('openWgb','G:/WGB/running/nfs-underground.wgb',{reload:false});
    log('Loaded. Wait for a race scene, then run the probe.');
});
document.querySelector('#run-game').onclick=()=>action(async()=>{
    const cfg=await(await fetch('/apps/source-pair-lab/config.json')).json();
    const patch=await(await fetch('/apps/source-pair-lab/nfsu-candidate.json')).json();
    const identity=new URLSearchParams(location.search).get('identity')==='1';
    const result={schema:1,mode:'game-paired',status:'running',identity,performanceAccepted:false,
        scope:'same-session changing-scene diagnostic; not independent game performance acceptance',rows:[{samples:[]}]};
    const row=result.rows[0];
    const save=async()=>{const response=await fetch(cfg.collector,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
        if(!response.ok)throw Error('Collector HTTP '+response.status);};
    try{
        await call('pause');row.version=await call('dbgCall','aot','version');
        if(JSON.stringify(row.version)!==JSON.stringify(patch.version))throw Error('Full AOT version mismatch');
        row.before=await call('evalWorker',scene+'return scene;');
        if(row.before.raceState!==4||row.before.config[21]!==0)throw Error('Race scene with shipping idx21=0 required');
        row.boot=await call('dbgCall','aot','bootStats');
        await call('dbgCall','aot','disarm');await call('jitPublications','clear');
        row.variants=await call('evalWorker',cpu+`state.gameVariants=[];
            for(const u of ${JSON.stringify(patch.units)}){
                const bytes=Uint8Array.from(atob(u.original),c=>c.charCodeAt(0));
                const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
                if(hash!==u.inputSha256)throw Error('Original hash mismatch');
                const original=new WebAssembly.Instance(new WebAssembly.Module(bytes),{e:c.jit_imports}).exports.f;
                state.gameVariants.push({idx:u.tableIndex,slot:u.tableIndex+1024,pages:u.pages,original,current:null,candidate:null});
            }return state.gameVariants.map(v=>({idx:v.idx,pages:v.pages}));`);
        row.replace=await call('aotArtifacts','replace',{engine:patch.version.engine,units:patch.units.map(u=>({tableIndex:u.tableIndex,inputSha256:u.inputSha256,base64:identity?u.original:u.candidate}))});
        await call('dbgCall','aot','drop');row.replay=await call('dbgCall','aot','replay');
        await call('evalWorker',cpu+`for(const v of state.gameVariants){
            if(!v.pages.every(p=>(w.jit_aot_page_table_index(p*4096)>>>0)===v.idx))throw Error('Target refused by replay');
            v.candidate=t.get(v.slot);v.current=v.candidate;if(typeof v.current!=='function')throw Error('Missing replay function');}return true;`);
        const select=arm=>call('evalWorker',cpu+`return state.gameVariants.map(v=>{
            if(t.get(v.slot)!==v.current||!v.pages.every(p=>(w.jit_aot_page_table_index(p*4096)>>>0)===v.idx))throw Error('Variant invalidated');
            v.current=v.${arm==='A'?'original':'candidate'};t.set(v.slot,v.current);return v.idx;});`);
        const inspect=reset=>call('evalWorker',scene+`${reset?'r.resetFlipCadence();':''}
            return {...scene,raw:Array.from(r.flipIntervals),variants:state.gameVariants.map(v=>({idx:v.idx,
                entries:w.jit_get_module_entry_total(v.idx)>>>0,sameFn:t.get(v.slot)===v.current,
                ownsPages:v.pages.every(p=>(w.jit_aot_page_table_index(p*4096)>>>0)===v.idx)}))};`);
        for(const arm of ['A','C']){await select(arm);await call('resume');log('Warming '+arm+' for 10 seconds…');await sleep(10000);await call('pause');}
        for(const arm of ['A','C','C','A','C','A','A','C']){
            await select(arm);await call('resume');const before=await inspect(true);
            log('Measuring '+arm+' for 10 seconds…');await sleep(10000);const after=await inspect(false);await call('pause');
            const entries=after.variants.map((v,i)=>({idx:v.idx,delta:(v.entries-before.variants[i].entries)>>>0}));
            const frames=after.serial-before.serial,raw=after.raw,sum=raw.reduce((a,b)=>a+b,0);
            const valid=before.raceState===4&&after.raceState===4&&after.moverCounter>before.moverCounter&&
                after.source===before.source&&after.compile===before.compile&&JSON.stringify(after.config)===JSON.stringify(before.config)&&
                raw.length===frames-1&&raw.length>20&&after.guestSerial-before.guestSerial===frames&&
                [...before.variants,...after.variants].every(v=>v.sameFn&&v.ownsPages);
            row.samples.push({arm,before,after,entries,valid,fps:sum?raw.length*1000/sum:null});
            await save();if(!valid)throw Error('Window failed integrity checks; raw sample retained');
        }
        await select('A');result.status='ok';
    }catch(e){result.status='error';result.error=String(e.stack||e);}
    finally{try{await call('pause');}catch{}await save();log(`${result.status}: saved live probe. No game-wide acceptance claim.`);}
});
