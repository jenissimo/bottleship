import {test,expect,afterEach} from "bun:test";
import {io,type Socket} from "socket.io-client";
import {createPublicLanServer as createLanServer,type LanServer,type LanServerOptions} from "./public-server";
import {encodeDatagram,PROTO_TCP} from "../src/protocol";
const servers:LanServer[]=[],clients:Socket[]=[],raw:WebSocket[]=[];
afterEach(async()=>{for(const c of clients.splice(0))c.disconnect();for(const c of raw.splice(0))c.close();for(const s of servers.splice(0))await s.close();});
function finite<T>(p:Promise<T>,label:string):Promise<T>{
 let timer:ReturnType<typeof setTimeout>;return Promise.race([p,new Promise<never>((_,reject)=>timer=setTimeout(()=>reject(Error(label)),2500))]).finally(()=>clearTimeout(timer));
}
function event(c:Socket,name:string){return finite(new Promise<any[]>(r=>c.once(name,(...args)=>r(args))),name);}
async function start(options:LanServerOptions={}){const server=createLanServer({port:0,...options});servers.push(server);return {server,port:await server.listen()};}
const auth=(id:number)=>({version:1,room:"room",clientId:"synthetic-client-"+id.toString().padStart(8,"0"),node:[2,0,0,0,0,id]});
async function client(port:number,id:number,transport:"polling"|"websocket"="websocket"){
 const c=io("http://127.0.0.1:"+port,{autoConnect:false,transports:[transport],reconnection:false,auth:auth(id)});
 clients.push(c);const ready=event(c,"ready");c.connect();await ready;return c;
}
for(const transport of ["websocket","polling"] as const)for(const name of ["unknown","resolve","cancelResolve","badDns"]){
 test("SR-06 "+transport+" accounts "+name+" before dispatch",async()=>{
  const {port}=await start({maxFramesPerSecond:3});
  const healthy=await client(port,1,transport),attacker=await client(port,2,transport);
  const closed=event(attacker,"disconnect");
  for(let i=1;i<=4;i++){
   if(name==="resolve")attacker.emit("resolve",i,{host:"unknown.test",family:4});
   else if(name==="badDns")attacker.emit("resolve",i,{host:null});
   else attacker.emit(name,i);
  }
  await closed;expect(healthy.connected).toBe(true);
 });
}
test("SR-06 unknown binary and Unicode JSON consume the byte budget",async()=>{
 const {port}=await start({maxBytesPerSecond:256});
 const attacker=await client(port,1);const closed=event(attacker,"disconnect");
 attacker.emit("unknown","é".repeat(80),new Uint8Array(128));await closed;
});
async function engine(port:number):Promise<WebSocket>{
 const ws=new WebSocket("ws://127.0.0.1:"+port+"/socket.io/?EIO=4&transport=websocket");raw.push(ws);
 await finite(new Promise<void>((r,j)=>{ws.onmessage=e=>String(e.data).startsWith("0{")?r():j(Error("EngineIO handshake"));ws.onerror=()=>j(Error("EngineIO refused"));}),"EngineIO open");return ws;
}
test("SR-05 unauthenticated EngineIO sessions share the connection cap and expire",async()=>{
 const {port}=await start({maxConnections:2,authorizationTimeoutMs:200});
 const a=await engine(port),b=await engine(port);
 await expect(engine(port)).rejects.toThrow();
 const gone=finite(new Promise<void>(r=>a.addEventListener("close",()=>r(),{once:true})),"authorization expiry");
 await gone;
 if(b.readyState!==WebSocket.CLOSED)await finite(new Promise<void>(r=>b.addEventListener("close",()=>r(),{once:true})),"second expiry");
 const healthy=await client(port,1);expect(healthy.connected).toBe(true);
});
test("SR-07 Unicode SocketIO packet closes only its connection and listener remains usable",async()=>{
 const {port}=await start();const attacker=await engine(port);
 const closed=finite(new Promise<void>(r=>attacker.addEventListener("close",()=>r(),{once:true})),"Unicode retirement");
 attacker.send("4é");await closed;
 const healthy=await client(port,1);expect(healthy.connected).toBe(true);
});
test("SR-08 slow polling recipient survives reliable flood, departure and later traffic",async()=>{
 const {server,port}=await start({maxBufferedFrames:2,maxBufferedBytes:4096,maxConnections:3});
 const base="http://127.0.0.1:"+port+"/socket.io/?EIO=4&transport=polling";
 const opening=await (await fetch(base)).text(),sid=JSON.parse(opening.slice(1)).sid;
 const url=base+"&sid="+encodeURIComponent(sid);
 expect((await fetch(url,{method:"POST",body:"40"+JSON.stringify(auth(1))})).status).toBe(200);
 const connected=await(await fetch(url)).text();expect(connected).toContain("ready");
 const victim=[...server.io.sockets.sockets.values()].find(s=>s.handshake.auth.clientId===auth(1).clientId)!;
 const attacker=await client(port,2),closed=event(attacker,"disconnect");
 const frame=encodeDatagram(PROTO_TCP,Uint8Array.from(auth(1).node),4000,5000,new Uint8Array(512));
 for(let i=0;i<6;i++)attacker.emit("frame",frame);
 await closed;expect(victim.connected).toBe(true);
 // The offender's EngineIO admission credit remains held behind its departure.
 expect(server.io.engine.clientsCount).toBe(1);
 await expect(engine(port)).resolves.toBeDefined(); // only one spare credit
 await expect(engine(port)).rejects.toThrow();
 const payload=await(await fetch(url)).text();expect(payload).toContain("peerLeft");
 expect(victim.connected).toBe(true);
 raw.pop()?.close();
 const next=await client(port,3);next.emit("frame",frame);
 expect((await(await fetch(url)).text())).toContain("frame");expect(victim.connected).toBe(true);
},10000);

test("SR-05 repeated handshakes on one HTTP connection release all close listeners",async()=>{
 const {Agent,request}=await import("node:http");
 const {port,server}=await start();
 const agent=new Agent({keepAlive:true,maxSockets:1});
 let count=0,tcp:import("node:net").Socket|undefined;
 server.http.on("connection",socket=>{count++;tcp=socket;});
 const send=(path:string,body?:string)=>new Promise<string>((resolve,reject)=>{
  const req=request({hostname:"127.0.0.1",port,path,agent,method:body?"POST":"GET",
   headers:body?{"Content-Type":"text/plain","Content-Length":Buffer.byteLength(body)}:{}},res=>{
    let text="";res.on("data",chunk=>text+=chunk);res.on("end",()=>resolve(text));
   });req.on("error",reject);req.end(body);
 });
 try{
  let baseline=0;
  for(let i=0;i<20;i++){
   const open=await send("/socket.io/?EIO=4&transport=polling");
   const sid=JSON.parse(open.slice(1)).sid;
   await send("/socket.io/?EIO=4&transport=polling&sid="+sid,"1");
   if(i===0)baseline=tcp!.listenerCount("close");
   expect(tcp!.listenerCount("close")).toBe(baseline);
  }
  expect(count).toBe(1);
 }finally{agent.destroy();}
});
