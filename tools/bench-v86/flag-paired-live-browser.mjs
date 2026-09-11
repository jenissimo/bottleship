// Steady-state paired samples: both warmed engines coexist in one Worker.
if(typeof document!=='undefined'){
    const worker=new Worker(new URL(import.meta.url),{type:'module'});
    const finish=async data=>{worker.terminate();await fetch('/_x87/finish',{method:'POST',body:JSON.stringify(data)});};
    worker.onmessage=({data})=>finish(data);
    worker.onerror=e=>finish({status:'error',error:e.message});
}else{
    const {V86}=await import('../../vendor/v86/build/libv86.mjs');
    const {SHIPPING_JIT}=await import('../jit-config/shipping.mjs');
    const {createX87Workload}=await import('./x87-workload.mjs');
    const sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
    const median=xs=>[...xs].sort((a,b)=>a-b)[xs.length>>1];
    const activate=e=>{globalThis.__wasmDump=e.dump;globalThis.__jitCompileStats=e.stats;};
    try{
        const config=await(await fetch('/_x87/config')).json(),modules={};
        for(const arm of Object.keys(config.arms)){
            const bytes=await(await fetch(`/_x87/${arm}.wasm`)).arrayBuffer();
            if(await sha(bytes)!==config.arms[arm].hash)throw Error('artifact mismatch');
            modules[arm]=await WebAssembly.compile(bytes);
        }
        const result={status:'ok',userAgent:navigator.userAgent,config,rows:[]};
        for(const kind of config.kinds){
            const engines={};
            try{
                for(const arm of Object.keys(config.arms)){
                    const api=createX87Workload(V86,{wasm:`/_x87/${arm}.wasm`,shipping:SHIPPING_JIT,engineModule:modules[arm]});
                    const im=api.image(kind),b=await api.boot(im,{flagLocals:config.arms[arm].flag});
                    const e=engines[arm]={api,im,b,warmup:[],dump:globalThis.__wasmDump,stats:globalThis.__jitCompileStats};
                    api.checkResult(api.state(b.c,b.w,kind),120000,kind);
                    for(let j=0;j<3;j++){e.warmup.push(api.measure(b,im,1000000,{warming:true}));await new Promise(r=>setTimeout(r,0));}
                    e.generated=[];
                    for(const r of e.dump.out)e.generated.push({hash:await sha(r.bytes),imports:WebAssembly.Module.imports(new WebAssembly.Module(r.bytes)).map(x=>x.name)});
                    if(kind.startsWith('flags-sse-'))for(const [helper,inline] of [['instr_0F16',config.arms[arm].inlineMove],['instr_660F59',config.arms[arm].inlineMulpd]]){
                        const present=e.generated.some(m=>m.imports.includes(helper));
                        if(present===!!inline)throw Error(`unexpected helper ${helper} in ${arm}`);
                    }
                }
                const iterations=config.iterationsByKind?.[kind]||config.iterations;
                for(const [pair,label] of config.pairs.entries()){
                    const samples=[[],[]];
                    for(let round=0;round<config.rounds;round++)for(const side of [0,1]){
                        const e=engines[label[side]];activate(e);
                        samples[side].push(e.api.measure(e.b,e.im,iterations));
                    }
                    for(const side of [0,1]){
                        const i=pair*2+side,arm=label[side],e=engines[arm];
                        const row=result.rows[i]||={pair,side,arm,medians:{},kernels:[]};
                        row.medians[kind]=median(samples[side].map(s=>s.ms));
                        row.kernels.push({kind,iterations,image:await sha(e.im.bytes),setup:e.im.setup,body:e.im.body,end:e.im.end,warmup:e.warmup,samples:samples[side],modules:e.generated});
                    }
                    await fetch('/_x87/progress',{method:'POST',body:JSON.stringify({kind,pair,label,medians:result.rows.slice(pair*2,pair*2+2).map(r=>r.medians[kind])})});
                }
            }finally{for(const e of Object.values(engines))e.b.em.destroy();}
        }
        postMessage(result);
    }catch(e){postMessage({status:'error',error:String(e.stack||e)});}
}
