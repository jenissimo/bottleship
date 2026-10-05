document.querySelector('#shufps').onclick=async()=>{
    const status=document.querySelector('#status'),output=document.querySelector('#output');
    const log=s=>{status.textContent=s;output.textContent+=s+'\n';};
    document.querySelectorAll('button').forEach(b=>b.disabled=true);output.textContent='';
    const cfg=await(await fetch('/apps/source-pair-lab/config.json')).json();
    const result={schema:1,mode:'shufps-browser',status:'running',rows:[],userAgent:navigator.userAgent};
    const save=async()=>{const r=await fetch(cfg.collector,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});if(!r.ok)throw Error('Collector '+r.status);};
    try{
        for(const broadcast of [false,true])for(const identity of [true,false,false,true]){
            log(`${broadcast?'Broadcast/add':'Reverse lanes'}: ${identity?'identical-byte control':'SHUFPS specialization'}…`);
            const url=new URL('../shufps-aot-paired.mjs',import.meta.url);url.searchParams.set('identity',identity?'1':'0');
            url.searchParams.set('broadcast',broadcast?'1':'0');
            const worker=new Worker(url,{type:'module'});
            let row;
            try{row=await new Promise((resolve,reject)=>{
                const timer=setTimeout(()=>reject(Error('Worker timeout')),90000);
                worker.onmessage=({data})=>{clearTimeout(timer);resolve(data);};
                worker.onerror=e=>{clearTimeout(timer);reject(Error(e.message));};
            });}finally{worker.terminate();}
            result.rows.push(row);if(row.status!=='ok')throw Error(row.error);
            log(`${identity?'Control':'Candidate'}: ${row.medians.A.toFixed(2)} → ${row.medians.C.toFixed(2)} ms; ${row.speedup.toFixed(3)}x`);
            await save();
        }
        result.acceptance=Object.fromEntries(['flags-sse-shufps','flags-sse-broadcast'].map(kind=>{
            const rows=result.rows.filter(r=>r.kind===kind),controls=rows.filter(r=>r.identity),candidates=rows.filter(r=>!r.identity);
            const stable=controls.length===2&&controls.every(r=>Math.abs(r.speedup-1)<=0.03);
            return [kind,{scope:'synthetic warm browser AOT',controlTolerance:0.03,minimumSpeedup:1.1,
                controlStable:stable,accepted:stable&&candidates.length===2&&candidates.every(r=>r.speedup>=1.1)}];
        }));
        result.status='ok';log('Browser AOT probe complete; state/work/ownership passed. Performance acceptance is recorded separately.');
    }catch(error){result.status='error';result.error=String(error);log('ERROR: '+error);}
    finally{window.shufpsResult=result;await save();document.querySelectorAll('button').forEach(b=>b.disabled=false);}
};
