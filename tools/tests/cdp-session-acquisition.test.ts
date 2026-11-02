import {expect,test} from "bun:test";
import {createServer,type Socket} from "node:net";
import {CdpSession} from "../cdp-core";

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
async function finite<T>(promise:Promise<T>,label:string,ms=1200){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(Error(label+" observation deadline")),ms);})]);}finally{clearTimeout(timer);}}
/** A real TCP listener accepts the client's actual HTTP upgrade request and never
 * responds. Assertions observe client-side cancellation through the server's TCP
 * close event BEFORE fallback cleanup destroys any remaining owned socket. */
async function blackhole(){
 const request=deferred<void>(),closed=deferred<void>(),sockets=new Set<Socket>();let accepts=0,received=0;
 const server=createServer(socket=>{accepts++;sockets.add(socket);let head="";
  socket.on("data",bytes=>{received+=bytes.length;head+=bytes.toString("ascii");if(head.length>16384){request.reject(Error("Unexpected handshake size"));return;}if(head.includes("\r\n\r\n")&&/^GET .* HTTP\/1\.1\r\n/i.test(head)&&/\r\nupgrade:\s*websocket\r\n/i.test(head))request.resolve();});
  socket.on("error",()=>{});socket.on("close",()=>{sockets.delete(socket);closed.resolve();});
 });
 await new Promise<void>((yes,no)=>{server.once("error",no);server.listen(0,"127.0.0.1",yes);});
 const address=server.address();if(!address||typeof address==="string")throw Error("Actual local TCP endpoint required");
 return{url:"ws://127.0.0.1:"+address.port+"/devtools/page/owned-test",request:request.promise,closed:closed.promise,
  get accepts(){return accepts;},get received(){return received;},get live(){return sockets.size;},
  async dispose(){for(const s of sockets)s.destroy();await finite(new Promise<void>(yes=>server.close(()=>yes())),"Owned TCP listener cleanup");}
 };
}

test("CDP acquisition timeout closes a real accepted blackhole handshake TCP connection",async()=>{
 const peer=await blackhole();let session:CdpSession|undefined;
 // Catch immediately so fallback disposal never creates an unhandled rejection.
 const pending=CdpSession.connect(peer.url,{timeoutMs:250}).then(s=>{session=s;return s;},e=>e);
 try{
  await finite(peer.request,"Actual HTTP upgrade request");expect(peer.accepts).toBe(1);expect(peer.received).toBeGreaterThan(0);
  const result=await finite(pending,"Acquisition timeout rejection");
  expect(result).toBeInstanceOf(Error);expect(result.name).toBe("TimeoutError");
  await finite(peer.closed,"Client timeout physically closed TCP");
  expect(peer.live).toBe(0);expect(session).toBeUndefined();
 }finally{session?.close();await peer.dispose();}
},5000);

test("aborting a pending CDP acquisition closes its real TCP connection and rejects with the owner reason",async()=>{
 const peer=await blackhole(),controller=new AbortController(),reason=Error("Owned target retired");let session:CdpSession|undefined;
 const pending=CdpSession.connect(peer.url,{timeoutMs:2000,signal:controller.signal}).then(s=>{session=s;return s;},e=>e);
 try{
  await finite(peer.request,"Actual HTTP upgrade request");controller.abort(reason);
  expect(await finite(pending,"Owner abort rejection")).toBe(reason);
  await finite(peer.closed,"Owner abort physically closed TCP");expect(peer.live).toBe(0);expect(session).toBeUndefined();
 }finally{controller.abort(reason);session?.close();await peer.dispose();}
},5000);

test("a pre-aborted CDP acquisition makes no TCP attempt",async()=>{
 const peer=await blackhole(),controller=new AbortController(),reason=Error("Already cancelled");controller.abort(reason);let session:CdpSession|undefined;
 const pending=CdpSession.connect(peer.url,{timeoutMs:100,signal:controller.signal}).then(s=>{session=s;return s;},e=>e);
 try{
  expect(await finite(pending,"Pre-abort rejection")).toBe(reason);
  // Negative observation window gives any mistakenly scheduled native connect a
  // chance to reach this owned listener; it is not a performance threshold.
  await Bun.sleep(30);expect(peer.accepts).toBe(0);expect(peer.live).toBe(0);expect(session).toBeUndefined();
 }finally{session?.close();await peer.dispose();}
},5000);

function echoServer(delay=0){
 const opened=deferred<void>(),closed=deferred<void>();let accepted=0,normalCloses=0;
 const server=Bun.serve({hostname:"127.0.0.1",port:0,
  fetch(request,server){if(server.upgrade(request))return;return new Response("Upgrade required",{status:426});},
  websocket:{open(){accepted++;opened.resolve();},
   async message(ws,message){const q=JSON.parse(String(message));if(delay)await Bun.sleep(delay);ws.send(JSON.stringify({id:q.id,result:{observed:q.params}}));},
   close(){normalCloses++;closed.resolve();}
  }
 });
 return{url:"ws://127.0.0.1:"+server.port+"/devtools/page/echo",opened:opened.promise,closed:closed.promise,
  get accepted(){return accepted;},get normalCloses(){return normalCloses;},dispose(){server.stop(true);}};
}

test("legacy CDP connect without acquisition options still exchanges commands and closes normally",async()=>{
 const peer=echoServer();let session:CdpSession|undefined;
 try{
  session=await finite(CdpSession.connect(peer.url),"Legacy successful handshake");await finite(peer.opened,"Real WebSocket accepted");
  const reply=await session.send("Test.echo",{marker:123},undefined,{timeoutMs:1000});
  expect(reply.result.observed).toEqual({marker:123});expect(peer.accepted).toBe(1);
  session.close();await finite(peer.closed,"Normal acquired session close");expect(peer.normalCloses).toBe(1);
 }finally{session?.close();peer.dispose();}
},5000);

test("acquisition timeout and signal stop governing a successfully acquired CDP session",async()=>{
 const peer=echoServer(600),controller=new AbortController();let session:CdpSession|undefined;
 try{
  session=await finite(CdpSession.connect(peer.url,{timeoutMs:400,signal:controller.signal}),"Successful bounded acquisition");
  controller.abort(Error("Owner later reused its acquisition controller"));
  // Real echo arrives after the old acquisition deadline. Neither that timer nor
  // a post-acquisition abort may dispose an already handed-off session.
  const reply=await session.send("Test.echo",{marker:"after-deadline"},undefined,{timeoutMs:1800});
  expect(reply.result.observed).toEqual({marker:"after-deadline"});expect(peer.normalCloses).toBe(0);
  session.close();await finite(peer.closed,"Explicit acquired session close");expect(peer.normalCloses).toBe(1);
 }finally{session?.close();peer.dispose();}
},5000);
