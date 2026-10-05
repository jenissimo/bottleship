import {runKernel} from './flag-browser-kernel.mjs';
self.onmessage=async({data})=>{
    try{self.postMessage({ok:true,kernel:await runKernel(data.config,data.arm,data.kind,data.engineModule)});}
    catch(e){self.postMessage({ok:false,error:String(e?.stack||e)});}
};
