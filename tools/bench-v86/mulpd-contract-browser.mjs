// Run the same exact-bit contract suite as Node, inside a browser Worker.
if(typeof document!=='undefined'){
    const worker=new Worker(new URL(import.meta.url),{type:'module'});
    const finish=async result=>{worker.terminate();await fetch('/_x87/finish',{method:'POST',body:JSON.stringify(result)});};
    worker.onmessage=({data})=>finish(data);
    worker.onerror=e=>finish({status:'error',error:e.message});
}else{
    try{
        const config=await(await fetch('/_x87/config')).json();
        const {runSseFlagContract}=await import('../../vendor/v86/tests/sse-flag-contract-core.mjs');
        const {runSseFaultContract}=await import('../../vendor/v86/tests/sse-move-pagefault-core.mjs');
        for(const arm of ['baseline','candidate']){
            const bytes=await(await fetch(`/_x87/${arm}.wasm`)).arrayBuffer();
            const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
            if(hash!==config.arms[arm].hash)throw Error('artifact mismatch');
        }
        const baseline=await runSseFlagContract({wasm:'/_x87/baseline.wasm',log:()=>{}});
        await fetch('/_x87/progress',{method:'POST',body:JSON.stringify({baselineContracts:baseline.count})});
        const inlineMulpd=['simd','scalar-order'].includes(config.mulpdMode);
        const candidate=await runSseFlagContract({wasm:'/_x87/candidate.wasm',inlineMulpd,
            guardedMulpd:!inlineMulpd,reference:baseline.nanRecords,log:()=>{}});
        const baselineFaults=await runSseFaultContract({wasm:'/_x87/baseline.wasm',mulpd:true,inline:false,log:()=>{}});
        const candidateFaults=await runSseFaultContract({wasm:'/_x87/candidate.wasm',mulpd:true,inline:inlineMulpd,log:()=>{}});
        postMessage({status:'ok',userAgent:navigator.userAgent,config,baseline,candidate,baselineFaults,candidateFaults,correctnessOnly:true});
    }catch(e){postMessage({status:'error',error:String(e.stack||e)});}
}
