import {WSA_ACTOR_PENDING,WSA_ACTOR_EXECUTING} from "../../../src/worker/modules/wsa-actor-protocol";
self.onmessage=({data})=>{
    const port:MessagePort=data.port;
    port.onmessage=({data:request})=>{
        const header=new Int32Array(request.mailbox,0,2);
        Atomics.compareExchange(header,0,WSA_ACTOR_PENDING,WSA_ACTOR_EXECUTING);
        // An executing mutation with lost completion: the caller must retire us.
    };
    port.start();self.postMessage("ready");
};
