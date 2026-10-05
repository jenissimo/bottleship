import {compare} from './oracle.mjs';

self.onmessage = async ({data:config}) => {
    try {
        const start = performance.now();
        const moduleUrl = '/apps/source-pair-lab/pair.mjs';
        const {default:createPair} = await import(/* @vite-ignore */ moduleUrl);
        const module = await createPair();
        const loadMs = performance.now()-start;
        module._pair_init(config.seed);
        const t = performance.now();
        await module.ccall('pair_run',null,['number','number','number','number'],
            [config.operations,config.burst,config.mode,config.variable],{async:true});
        const elapsedMs = performance.now()-t;
        const p = module._pair_state() >>> 2;
        const state = Array.from(module.HEAPU32.subarray(p,p+module._pair_size()/4));
        postMessage({status:'ok',state,ledger:compare(state,config),loadMs,elapsedMs,
            timingClass:'cold correctness smoke; no warmup, no performance acceptance',userAgent:navigator.userAgent});
    } catch(error) { postMessage({status:'error',error:String(error)}); }
};
