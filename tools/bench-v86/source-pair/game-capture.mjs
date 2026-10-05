import {call,freshGuest} from './browser.mjs';
const log=s=>{document.querySelector('#output').textContent+=s+'\n';document.querySelector('#status').textContent=s;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const guard=()=>{if(location.origin!=='http://127.0.0.1:5174')throw Error('Use http://127.0.0.1:5174 for a separate OPFS origin');};
let loaded=false;
document.querySelector('#game-shot').onclick=()=>action(async()=>{
    const cfg=await(await fetch('/apps/source-pair-lab/config.json')).json();
    const row={shot:await call('shot'),report:await call('report')};
    const saved=await fetch(cfg.collector,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({schema:1,mode:'game-shot',status:'ok',rows:[row]})});
    if(!saved.ok)throw Error('Screenshot collector HTTP '+saved.status);log('Game screenshot saved.');
});
for(const [id,key] of [['game-enter',13],['game-escape',27]])document.querySelector('#'+id).onclick=()=>action(async()=>{
    await call('resume');await call('keyHold',key,350);log(`Guest key ${key} sent.`);
});
async function action(fn){
    document.querySelectorAll('button').forEach(b=>b.disabled=true);
    try{guard();await fn();}catch(e){log(String(e.stack||e));}
    finally{document.querySelectorAll('button').forEach(b=>b.disabled=false);}
}
document.querySelector('#game').onclick=()=>action(async()=>{
    loaded=false;await freshGuest();await call('resetWorkerFlags');
    log('Loading NFSU from configured G: bundle root into this origin…');
    await call('openWgb','G:/WGB/running/nfs-underground.wgb',{reload:false});
    loaded=true;log('Game loaded. Navigate in the game iframe, then capture. No timing claim.');
});
document.querySelector('#capture-game').onclick=()=>action(async()=>{
    if(!loaded)throw Error('Load the isolated game first');
    const cfg=await(await fetch('/apps/source-pair-lab/config.json')).json();
    const result={schema:1,mode:'game-capture',status:'running',origin:location.origin,
        userAgent:navigator.userAgent,performanceAccepted:false,rows:[]};
    try{
        await call('jitPublications','clear');await call('jitPublications','arm');
        await call('resume');log('Capturing newly published JIT modules for 20 seconds…');
        await sleep(20000);await call('pause');await call('jitPublications','seal');
        result.rows.push({publications:await call('jitPublications','export'),report:await call('report')});
        if(result.rows[0].publications.dropped)throw Error('Publication capture dropped records');
        result.status='ok';
    }catch(e){result.status='error';result.error=String(e);}
    finally{await call('jitPublications','seal');}
    const saved=await fetch(cfg.collector,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
    if(!saved.ok)throw Error('Collector HTTP '+saved.status);
    log(`Capture ${result.status}: ${result.rows[0]?.publications.modules.length??0} modules saved. Guest paused.`);
});
