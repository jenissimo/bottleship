import { CdpSession, pageEval } from '../../cdp-core';
const mode=process.argv[2]??'reply';
let acknowledgeClose!:()=>void;
const closed=new Promise<void>(resolve=>{acknowledgeClose=resolve});
const server=Bun.serve({
    hostname:'127.0.0.1',port:0,
    fetch(request,server){if(server.upgrade(request))return;return new Response('Upgrade required',{status:426});},
    websocket:{
        message(socket,message){
            const request=JSON.parse(String(message));
            if(mode==='reply')socket.send(JSON.stringify({id:request.id,result:{result:{value:42}}}));
        },
        close(){acknowledgeClose()},
    },
});
const session=await CdpSession.connect('ws://127.0.0.1:'+server.port);
try{
    if(mode==='reply'){
        const value=await pageEval(session,'42',{timeoutMs:5000});
        if(value!==42)throw Error('Incorrect result');
    }else{
        let failure=false;
        try{await pageEval(session,'42',{timeoutMs:20})}catch(error){failure=/timed out|did not answer/.test(String(error))}
        if(!failure)throw Error('Missing renderer deadline');
    }
    console.log('evaluation verified',mode);
}finally{
    session.close();await closed;server.stop(true);
}
