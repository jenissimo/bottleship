self.onmessage=({data})=>{
    if(data.port instanceof MessagePort){
        const port:MessagePort=data.port;
        port.onmessage=({data:request})=>{const header=new Int32Array(request.shared);Atomics.store(header,0,1);Atomics.notify(header,0);port.postMessage({done:true});};
        port.start();
    }else self.postMessage({id:data.id,closeType:typeof self.close,globalCloseType:typeof (globalThis as any).close});
};
