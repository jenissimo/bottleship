const sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
const median=xs=>[...xs].sort((a,b)=>a-b)[xs.length>>1];
function inWorker(config,arm,kind,engineModule){
    return new Promise((resolve,reject)=>{
        const w=new Worker(new URL('./flag-browser-worker.mjs',import.meta.url),{type:'module'});
        const finish=(error,kernel)=>{clearTimeout(timer);w.terminate();error?reject(Error(error)):resolve(kernel);};
        const timer=setTimeout(()=>finish('worker timed out'),30000);
        w.onerror=e=>finish(e.message);
        w.onmessage=({data})=>finish(data.ok?null:data.error,data.kernel);
        w.postMessage({config,arm,kind,engineModule});
    });
}
try{
    const config=await(await fetch('/_x87/config')).json(),modules={};
    for(const arm of Object.keys(config.arms)){
        const bytes=await(await fetch(`/_x87/${arm}.wasm`)).arrayBuffer();
        if(await sha(bytes)!==config.arms[arm].hash)throw Error('artifact mismatch');
        modules[arm]=await WebAssembly.compile(bytes);
    }
    const result={status:'ok',userAgent:navigator.userAgent,config,rows:[]};
    for(const kind of config.kinds)for(const [i,arm]of config.order.entries()){
        const kernel=await inWorker(config,arm,kind,modules[arm]);
        const row=result.rows[i]||={pair:i>>1,side:i%2,arm,medians:{},kernels:[]};
        row.medians[kind]=median(kernel.samples.map(s=>s.ms));row.kernels.push(kernel);
        await fetch('/_x87/progress',{method:'POST',body:JSON.stringify({kind,i,arm,ms:row.medians[kind]})});
    }
    await fetch('/_x87/finish',{method:'POST',body:JSON.stringify(result)});
}catch(e){await fetch('/_x87/finish',{method:'POST',body:JSON.stringify({status:'error',error:String(e?.stack||e)})});}
