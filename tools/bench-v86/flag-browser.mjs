import { V86 } from '../../vendor/v86/build/libv86.mjs';
import { SHIPPING_JIT } from '../jit-config/shipping.mjs';
import { createX87Workload } from './x87-workload.mjs';
const sha = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
const median = xs => [...xs].sort((a,b)=>a-b)[xs.length>>1];
try {
    const config=await (await fetch('/_x87/config')).json(), modules={};
    for(const arm of Object.keys(config.arms)) {
        const bytes=await (await fetch(`/_x87/${arm}.wasm`)).arrayBuffer();
        if(await sha(bytes)!==config.arms[arm].hash)throw Error('artifact mismatch');
        modules[arm]=await WebAssembly.compile(bytes);
    }
    const result={status:'ok',userAgent:navigator.userAgent,config,rows:[]};
    for(const kind of config.kinds) for(const [i,arm] of config.order.entries()) {
        const {image,boot,state,checkResult,measure}=createX87Workload(V86,{wasm:`/_x87/${arm}.wasm`,shipping:SHIPPING_JIT,engineModule:modules[arm]});
        const im=image(kind),b=await boot(im,{flagLocals:config.arms[arm].flag});
        checkResult(state(b.c,b.w,kind),120000,kind);
        const warmup=[];
        for(let j=0;j<3;j++){warmup.push(measure(b,im,1000000,{warming:true}));await new Promise(r=>setTimeout(r,0));}
        const samples=[];
        const iterations=config.iterationsByKind?.[kind]||config.iterations;
        for(let j=0;j<config.rounds;j++)samples.push(measure(b,im,iterations));
        const generated=[];
        for(const r of globalThis.__wasmDump.out)generated.push({hash:await sha(r.bytes),imports:WebAssembly.Module.imports(new WebAssembly.Module(r.bytes)).map(x=>x.name)});
        const inlineMove=config.arms[arm].inlineMove;
        const required=kind.startsWith('flags-sse-')?(inlineMove?['instr_660F59']:['instr_0F16','instr_660F59']):kind==='flags-integer'?[]:['instr16_D9_7_reg'];
        if(!required.every(name=>generated.some(m=>m.imports.includes(name))))throw Error('required helper absent');
        if(inlineMove&&generated.some(m=>m.imports.includes('instr_0F16')))throw Error('move helper remains');
        const row=result.rows[i]||={pair:i>>1,side:i%2,arm,medians:{},kernels:[]};
        row.medians[kind]=median(samples.map(s=>s.ms));
        row.kernels.push({kind,iterations,image:await sha(im.bytes),setup:im.setup,body:im.body,end:im.end,warmup,samples,modules:generated});
        b.em.destroy();
        await fetch('/_x87/progress',{method:'POST',body:JSON.stringify({kind,i,arm,ms:row.medians[kind]})});
    }
    await fetch('/_x87/finish',{method:'POST',body:JSON.stringify(result)});
}catch(e){await fetch('/_x87/finish',{method:'POST',body:JSON.stringify({status:'error',error:String(e?.stack||e)})});}
