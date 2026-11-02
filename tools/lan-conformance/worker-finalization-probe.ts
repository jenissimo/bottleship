// Diagnostic only: two sequential Workers, then actor-only creation/teardown.
import {RootNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
async function simple(){
    const worker=new Worker(new URL("../tests/fixtures/network-worker-probe.ts",import.meta.url).href,{type:"module"});
    const stopped=new Promise<void>(resolve=>worker.addEventListener("close",()=>resolve(),{once:true}));
    const result=await new Promise(resolve=>{worker.onmessage=event=>resolve(event.data);worker.postMessage({id:1});});
    console.log(JSON.stringify(result));worker.terminate();await stopped;
}
const iterations=Number(process.argv[2]??2);
if(!Number.isInteger(iterations)||iterations<1||iterations>200)throw new Error("Invalid probe count");
for(let iteration=0;iteration<iterations;iteration++)await simple();
console.log("plain workers: PASS");
for(let iteration=0;iteration<iterations;iteration++){
    const worker=new Worker(new URL("../tests/fixtures/network-worker-probe.ts",import.meta.url).href,{type:"module"}),channel=new MessageChannel();
    const stopped=new Promise<void>(resolve=>worker.addEventListener("close",()=>resolve(),{once:true}));
    const shared=new SharedArrayBuffer(512*1024),header=new Int32Array(shared);
    worker.postMessage({port:channel.port2},[channel.port2]);
    const notification=new Promise<void>(resolve=>{channel.port1.onmessage=()=>resolve();channel.port1.start();});
    channel.port1.postMessage({shared});
    if(Atomics.wait(header,0,0,5000)==="timed-out")throw new Error("SAB worker timed out");
    await notification;channel.port1.close();worker.terminate();await stopped;
}
console.log("SAB RPC workers: PASS");
for(let iteration=0;iteration<iterations;iteration++){
    const network=new LanNetwork(),namespace=new RootNetworkNamespace(network,16,19001);
    try{
        const table=createWsaActorTable(network,()=>namespace.socketActorClient()),socket=table.socket(2);
        console.log("actor socket",socket);await namespace.finishProcessLifetime();
    }finally{await namespace.close();}
}
console.log("actor-only workers: PASS");
