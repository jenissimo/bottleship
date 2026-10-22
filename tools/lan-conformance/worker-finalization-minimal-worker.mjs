// Standalone runtime diagnostic: no BottleShip imports, sockets or native code.
async function boot({shared,control,network}){
    let client;
    control.onmessage=async({data})=>{
        if(data.type==="client"){
            client=data.port;
            client.onmessage=({data:request})=>{
                const header=new Int32Array(request.mailbox,0,4);
                new Uint8Array(request.mailbox,16,4).set([1,2,3,4]);
                Atomics.store(header,0,1);Atomics.notify(header,0);
                client.postMessage({type:"changed"});
            };client.start();
        }else if(data.type==="shutdown"){
            await new Promise(resolve=>{network.onmessage=()=>resolve();network.start();network.postMessage({type:"barrier"});});
            client.close();network.close();control.postMessage({type:"done"});
        }
    };control.start();
    void shared;
}
if(typeof self!=="undefined")self.onmessage=({data})=>void boot(data);
else (await import("node:worker_threads")).parentPort.on("message",data=>void boot(data));
