/** Real JS clients against both implementations; only synthetic invitation keys are used. */
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createSocket} from "node:dgram";
import {io,type Socket} from "socket.io-client";
import {createLanServer} from "../../packages/lan/src/server";
import {RoomAccess} from "../../packages/lan/src/access";
import {encodeDatagram} from "../../packages/lan/src/protocol";
import vector from "../../packages/lan/test/invite-vector.json";

const binary=process.argv[2];assert(binary,"Usage: bun tools/lan-conformance/security-access.ts <Rust conformance-server executable>");
const testKey="BOTTLESHIP_LAN_CONFORMANCE_INVITE_KEY";
const key=Buffer.from(vector.keyBase64,"base64"),signer=new RoomAccess({},key);
const directory=await mkdtemp(join(tmpdir(),"bottleship-access-"));
const udp=createSocket("udp4");await new Promise<void>(r=>udp.bind(0,"127.0.0.1",r));
const nativePort=udp.address().port;
const config={host:"127.0.0.1",port:0,roomAccess:{inviteKeyEnv:testKey,rooms:{lobby:{visibility:"public" as const}}},
    gateway:{routes:[{id:"echo",host:"127.0.0.1",address:"203.0.113.10",names:["echo.test"],ports:[nativePort],protocols:["udp" as const]}]}};
const configPath=join(directory,"server.json");await writeFile(configPath,JSON.stringify(config));
const child=spawn(resolve(binary),["--config",configPath],{stdio:["pipe","pipe","pipe"],env:{...process.env,[testKey]:vector.keyBase64}});
const exit=new Promise<number|null>((r,j)=>{child.once("error",j);child.once("close",r)});
const clients:Socket[]=[];let diagnostics="";child.stderr.on("data",d=>diagnostics=(diagnostics+String(d)).slice(-4096));
function finite<T>(p:Promise<T>,label:string,ms=3000):Promise<T>{
    let timer:ReturnType<typeof setTimeout>;return Promise.race([p,new Promise<never>((_,j)=>timer=setTimeout(()=>j(Error(label)),ms))]).finally(()=>clearTimeout(timer));
}
const readyRust=finite(new Promise<number>((r,j)=>{
    let buffered="";child.stdout.on("data",data=>{buffered+=String(data);for(;;){const end=buffered.indexOf("\n");if(end<0)break;const line=buffered.slice(0,end);buffered=buffered.slice(end+1);
        try{const value=JSON.parse(line);if(value.port)r(value.port)}catch{}}});
    exit.then(()=>j(Error("Rust exited before readiness")),j);
}),"Rust readiness");
let ts:ReturnType<typeof createLanServer>|undefined;
function event(c:Socket,name:string):Promise<any[]>{
    return finite(new Promise(r=>c.once(name,(...args)=>r(args))),"Event "+name);
}
function client(port:number,room:string,invite?:string,node=1){
    const c=io("http://127.0.0.1:"+port,{autoConnect:false,transports:currentTransport?[currentTransport]:["websocket"],reconnection:false,
        auth:{version:1,room,clientId:"synthetic-client-000"+node,node:[2,0,0,0,0,node],...(invite?{invite}:{})}});
    clients.push(c);return c;
}
let currentTransport:"polling"|"websocket"="websocket";
try{
    const rustPort=await readyRust;
    process.env[testKey]=vector.keyBase64;
    ts=createLanServer(config);
    const tsPort=await ts.listen();
    for(const [implementation,port] of [["ts",tsPort],["rust",rustPort]] as const){
        for(const transport of ["websocket","polling"] as const){
            currentTransport=transport;
            const unsigned=client(port,"locked");const denied=event(unsigned,"connect_error");unsigned.connect();assert.equal((await denied)[0].message,"LAN access denied");
            const attacker=client(port,"lobby");const r=event(attacker,"ready");attacker.connect();assert.deepEqual((await r)[0].gatewayIpv4,[]);
            const frame=encodeDatagram(1,Uint8Array.of(2,1,203,0,113,10),nativePort,25000,Uint8Array.of(7,8,9));
            const rejected=event(attacker,"socketError");attacker.emit("frame",frame,1);assert.equal((await rejected)[0].code,10013);
            const dns=event(attacker,"resolved");attacker.emit("resolve",1,{host:"echo.test",family:4});assert.equal((await dns)[1].error.code,"ACCESS_DENIED");
            const token=signer.sign("locked",Math.floor(Date.now()/1000)+60,{routes:["echo"]});
            const member=client(port,"locked",token,2);const ready=event(member,"ready");member.connect();assert.deepEqual((await ready)[0].gatewayIpv4,[[203,0,113,10]]);
            const received=new Promise<Buffer>(r=>udp.once("message",r));member.emit("frame",frame,1);
            assert.deepEqual(Array.from(await finite(received,"Native UDP")),[7,8,9]);
            for(const c of clients.splice(0))c.disconnect();
            console.log(implementation+" "+transport+": private admission, scoped UDP and denied anonymous DNS passed");
        }
    }
}finally{
    for(const c of clients)c.disconnect();
    if(ts)await ts.close();udp.close();delete process.env[testKey];
    child.stdin.end("shutdown\n");
    let ended=false;try{const code=await finite(exit,"Rust shutdown",5000);ended=true;assert.equal(code,0,diagnostics)}finally{if(!ended)child.kill();}
    await rm(directory,{recursive:true,force:true});
}
