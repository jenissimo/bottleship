// Standalone runtime diagnostic: no BottleShip imports, sockets or native code.
const NativeWorker=globalThis.Worker??(await import("node:worker_threads")).Worker;
const iterations=Number(process.argv[2]??100);
for(let iteration=0;iteration<iterations;iteration++){
    const worker=new NativeWorker(new URL("./worker-finalization-minimal-worker.mjs",import.meta.url),{type:"module"});
    const stopped=new Promise(resolve=>{
        if(worker.addEventListener)worker.addEventListener("close",()=>resolve(),{once:true});
        else worker.once("exit",()=>resolve());
    });
    worker.unref?.();
    const control=new MessageChannel(),network=new MessageChannel(),client=new MessageChannel();
    const shared=new SharedArrayBuffer(5243456),mailbox=new SharedArrayBuffer(512*1024),header=new Int32Array(mailbox,0,4);
    network.port1.onmessage=()=>network.port1.postMessage({type:"reply"});network.port1.start();
    worker.postMessage({shared,control:control.port2,network:network.port2},[control.port2,network.port2]);
    control.port1.postMessage({type:"client",port:client.port2},[client.port2]);
    client.port1.postMessage({mailbox});
    if(Atomics.wait(header,0,0,5000)==="timed-out")throw Error("RPC timed out");
    const done=new Promise(resolve=>{control.port1.onmessage=()=>resolve();control.port1.start();});
    control.port1.postMessage({type:"shutdown"});await done;
    client.port1.close();network.port1.close();control.port1.close();
    worker.terminate();await stopped;
    if((iteration+1)%10===0)console.log("completed",iteration+1);
}
console.log("standalone worker finalization: PASS",iterations);
