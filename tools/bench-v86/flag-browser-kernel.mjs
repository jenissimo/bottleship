import {V86} from '../../vendor/v86/build/libv86.mjs';
import {SHIPPING_JIT} from '../jit-config/shipping.mjs';
import {createX87Workload} from './x87-workload.mjs';
const sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
export async function runKernel(config,arm,kind,engineModule){
    const {image,boot,state,checkResult,measure}=createX87Workload(V86,{wasm:`/_x87/${arm}.wasm`,shipping:SHIPPING_JIT,engineModule});
    const im=image(kind),b=await boot(im,{flagLocals:config.arms[arm].flag});
    try{
        checkResult(state(b.c,b.w,kind),120000,kind);
        const warmup=[];
        for(let j=0;j<3;j++){warmup.push(measure(b,im,1000000,{warming:true}));await new Promise(r=>setTimeout(r,0));}
        if(config.settleMs)await new Promise(r=>setTimeout(r,config.settleMs));
        const samples=[],iterations=config.iterationsByKind?.[kind]||config.iterations;
        for(let j=0;j<config.rounds;j++){
            if(config.diagnostic)performance.mark(`guest-sample-${j}-start`);
            samples.push(measure(b,im,iterations));
            if(config.diagnostic){
                performance.mark(`guest-sample-${j}-end`);
                performance.measure(`guest-sample-${j}`,`guest-sample-${j}-start`,`guest-sample-${j}-end`);
            }
        }
        const generated=[];
        for(const r of globalThis.__wasmDump.out)generated.push({hash:await sha(r.bytes),imports:WebAssembly.Module.imports(new WebAssembly.Module(r.bytes)).map(x=>x.name)});
        const inlineMove=config.arms[arm].inlineMove;
        const required=kind.startsWith('flags-sse-')?(inlineMove?['instr_660F59']:['instr_0F16','instr_660F59']):kind==='flags-integer'?[]:['instr16_D9_7_reg'];
        if(config.arms[arm].inlineMulpd){const i=required.indexOf('instr_660F59');if(i>=0)required.splice(i,1);}
        if(!required.every(name=>generated.some(m=>m.imports.includes(name))))throw Error('required helper absent');
        if(inlineMove&&generated.some(m=>m.imports.includes('instr_0F16')))throw Error('move helper remains');
        if(config.arms[arm].inlineMulpd&&generated.some(m=>m.imports.includes('instr_660F59')))throw Error('MULPD helper remains');
        return {kind,iterations,image:await sha(im.bytes),setup:im.setup,body:im.body,end:im.end,warmup,samples,modules:generated};
    }finally{b.em.destroy();}
}
