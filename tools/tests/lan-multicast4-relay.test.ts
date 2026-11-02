import {expect,test} from "bun:test";
import {RootNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork,type LanDatagram} from "../../src/worker/net/lan-network";
import {createLanServer} from "../../packages/lan/src/server";
import {PROTO_UDP} from "../../src/worker/net/netplay-wire";
class ControlWorker extends EventTarget{
 private ports:MessagePort[]=[];
 postMessage(m:any){const p=m.control;this.ports.push(p,m.network.port);p.onmessage=e=>{const v=e.data;if(["barrier","finish","shutdown"].includes(v.type))p.postMessage({type:v.type==="shutdown"?"shutdownDone":v.type==="finish"?"finished":"barrierDone",id:v.id});};p.start();}
 unref(){}terminate(){this.ports.forEach(p=>p.close());this.dispatchEvent(new Event("close"));}
}
function root(id:number){const network=new LanNetwork(Uint8Array.of(2,0,0,29,1,id)),saved=globalThis.Worker;let host:RootNetworkNamespace;try{globalThis.Worker=ControlWorker as unknown as typeof Worker;host=new RootNetworkNamespace(network,8);}finally{globalThis.Worker=saved;}return {network,host:host!};}
function child(host:RootNetworkNamespace,config:any){
 const lease=host.createChild(),worker=new Worker(new URL("./fixtures/multicast4-namespace-worker.ts",import.meta.url).href,{type:"module"});
 let serial=0;const pending=new Map<number,{ok:(v:any)=>void;fail:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 worker.onmessage=e=>{const p=pending.get(e.data.id);if(!p)return;pending.delete(e.data.id);clearTimeout(p.timer);if(e.data.error)p.fail(Error(e.data.error));else p.ok(e.data.result);};
 function call(message:object,transfer:Transferable[]=[]){const id=++serial;return new Promise<any>((ok,fail)=>{pending.set(id,{ok,fail,timer:setTimeout(()=>{pending.delete(id);fail(Error("multicast child timeout"));},8000)});worker.postMessage({id,...message},transfer);});}
 const ready=call({boot:lease.boot,config},[lease.boot.port]);
 return {ready,call,async close(){const stopped=new Promise<void>(ok=>worker.addEventListener("close",()=>ok(),{once:true}));worker.terminate();lease.close();for(const p of pending.values()){clearTimeout(p.timer);p.fail(Error("closed"));}pending.clear();await stopped;}};
}
async function until(check:()=>boolean|Promise<boolean>){const end=Date.now()+5000;while(!await check()){if(Date.now()>end)throw Error("multicast delivery timeout");await new Promise(ok=>setTimeout(ok,5));}}
const G=[239,255,42,17],H=[239,255,42,18],port=6293;
for(const transport of ["websocket","polling"] as const)test(transport+" preserves multicast across actual child Worker, broker and room",async()=>{
 const server=createLanServer({port:0,transports:[transport]}),url="http://127.0.0.1:"+await server.listen(),config={serverUrl:url,room:"multicast-worker-"+transport};
 const a=root(1),b=root(2),isolated=root(3),atA:LanDatagram[]=[],atB:LanDatagram[]=[],outside:LanDatagram[]=[];
 let guest:ReturnType<typeof child>|undefined;let joins=0;server.io.on("connection",()=>joins++);
 try{
  await a.host.configure(config);await b.host.configure(config);await isolated.host.configure({...config,room:"other"});
  a.network.bind(port,{deliver:dg=>atA.push(dg)},PROTO_UDP,true);b.network.bind(port,{deliver:dg=>atB.push(dg)},PROTO_UDP);isolated.network.bind(port,{deliver:dg=>outside.push(dg)},PROTO_UDP);
  guest=child(a.host,config);await guest.ready;expect(await guest.call({command:"bind",port})).toBe(true);
  const payload=Array.from({length:65507},(_,i)=>(i*17)&255);
  expect(await guest.call({command:"send",srcPort:6294,dstPort:port,group:G,payload,interfaceIndex:2,ttl:1})).toBe(true);
  await until(()=>atB.length===1);await guest.call({command:"barrier"});
  const local=await guest.call({command:"packets"});
  expect(local).toHaveLength(1);expect(atA).toHaveLength(1);expect(atB).toHaveLength(1);
  expect(atB[0].data).toEqual(Uint8Array.from(payload));expect(atB[0].srcNode).toEqual(a.network.node);
  expect(atA[0].multicast4).toEqual({group:Uint8Array.from(G),interfaceIndex:2,ttl:1,localOrigin:true});
  expect(atB[0].multicast4).toEqual({group:Uint8Array.from(G),interfaceIndex:2,ttl:1,localOrigin:false});
  expect(local[0].multicast4).toEqual({group:G,interfaceIndex:2,ttl:1,localOrigin:true});
  expect(await guest.call({command:"send",srcPort:6294,dstPort:port,group:H,payload:[2],interfaceIndex:1,ttl:3})).toBe(true);
  expect(await guest.call({command:"send",srcPort:6294,dstPort:port,group:H,payload:[3],interfaceIndex:2,ttl:0})).toBe(true);
  expect(await guest.call({command:"send",srcPort:6294,dstPort:port,group:H,payload:[4],interfaceIndex:2,ttl:1})).toBe(true);
  await until(()=>atB.length===2);await guest.call({command:"barrier"});
  expect(atA).toHaveLength(4);expect(atB).toHaveLength(2);expect(outside).toHaveLength(0);
  expect(atB[1].multicast4?.group).toEqual(Uint8Array.from(H));expect(atB[1].data).toEqual(Uint8Array.of(4));
  expect(joins).toBe(3);
 }finally{await guest?.close();await a.host.close();await b.host.close();await isolated.host.close();await server.close();}
},20000);
