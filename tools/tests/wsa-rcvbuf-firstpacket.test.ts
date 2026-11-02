/**
 * Eight positive first-empty-packet controls from
 * actual native438c96b3... (154 calls), independent review80b69bf0....
 * Only one512B datagram at requested SO_RCVBUF0/1/2/256 is claimed.
 * No second-packet threshold, full quota, tag overhead or new RED claim.
 */
import {expect,test} from "bun:test";
import {RootNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {publicContext,type Family} from "./fixtures/wsa-rcvbuf-context";

type F=ReturnType<typeof publicContext>;
type Endpoint=ReturnType<F["local"]>;
const D=0x24000,N=0x25000,L=0x25100,T=0x25200,I=0x26000;
const a5=(n:number)=>Array(n).fill(0xa5);
function receive528(f:F,socket:number,peek:boolean){
 f.m.ram.fill(0xa5,D,D+544); //8+528+8, never the helper's32B receive region
 f.m.ram.fill(0xa5,N,N+48);f.m.ram.fill(0xa5,L,L+12);f.m.put(L+4,32);f.m.seed(0x5a5100a1);
 const rc=f.call("recvfrom",[socket,D+8,528,peek?2:0,N+8,L+4]);
 const row={rc,error:f.m.error(),nameLength:f.m.get(L+4),data:Array.from(f.m.ram.slice(D,D+544)),
  name:Array.from(f.m.ram.slice(N,N+48)),length:Array.from(f.m.ram.slice(L,L+12))};
 f.note({receive528:row});return row;
}
function endpoint(q:Endpoint,family:Family){
 const ip=family===2?[127,0,0,1]:[...Array(15).fill(0),1];
 expect(q.family).toBe(family);expect(q.length).toBe(family===2?16:28);
 expect(q.port).toBeGreaterThan(0);expect(q.port).toBeLessThanOrEqual(65535);
 expect(q.raw.slice(family===2?4:8,family===2?8:24)).toEqual(ip);
 expect(q.raw.slice(q.length)).toEqual(a5(32-q.length));
 if(family===23){expect(q.raw.slice(4,8)).toEqual([0,0,0,0]);expect(q.raw.slice(24,28)).toEqual([0,0,0,0]);}
}
function empty(r:ReturnType<typeof receive528>){
 expect(r.rc).toBe(-1);expect(r.error).toBe(10035);expect(r.nameLength).toBe(32);
 expect(r.data).toEqual(a5(544));expect(r.name).toEqual(a5(48));
 expect(r.length).toEqual([...a5(4),32,0,0,0,...a5(4)]);
}
function received(r:ReturnType<typeof receive528>,source:Endpoint,payload:number[]){
 expect(r.rc).toBe(512);expect(r.error).toBe(0);expect(r.nameLength).toBe(source.length);
 expect(r.data).toEqual([...a5(8),...payload,...a5(24)]); //16 spare payload bytes+8 guard
 expect(r.name).toEqual([...a5(8),...source.raw.slice(0,source.length),...a5(40-source.length)]);
 expect(r.length).toEqual([...a5(4),source.length,0,0,0,...a5(4)]);
}
for(const family of[2,23] as const)for(const requested of[0,1,2,256]){
 const arm=(family===2?0:4)+[0,1,2,256].indexOf(requested);
 test("measured first whole512B UDP AF"+family+" SO_RCVBUF="+requested,async()=>{
  const pid=52500+arm,network=new LanNetwork(),ns=new RootNetworkNamespace(network,16,pid);
  let f:F|undefined,first:unknown;const observed:unknown[]=[];
  try{
   await ns.barrier();f=publicContext(createWsaActorTable(network,()=>ns.socketActorClient()));
   const receiver=f.socket(family),target=f.bind(receiver,family);
   const sender=f.socket(family),source=f.bind(sender,family),set=f.set(receiver,requested),query=f.query(receiver);
   const initial=receive528(f,receiver,true);
   // Independent offered input, tagged with this arm/family/request; no production encoder/expected output.
   const payload=Array.from({length:512},(_,i)=>(i*37+arm*11+17)&255);
   payload.splice(0,8,0x52,0x43,0x56,0x35,0x31,arm,family,0x02);
   payload[8]=requested&255;payload[9]=requested>>>8&255;
   f.m.ram.fill(0xa5,I,I+528);f.m.ram.set(payload,I+8);
   f.m.ram.fill(0xa5,T,T+48);f.m.ram.set(target.raw.slice(0,target.length),T+8);
   const inputBefore=Array.from(f.m.ram.slice(I,I+528)),targetBefore=Array.from(f.m.ram.slice(T,T+48));
   f.m.seed(0x5a5100a2);
   const sent=f.call("sendto",[sender,I+8,512,0,T+8,target.length]),sendError=f.m.error();
   const inputAfter=Array.from(f.m.ram.slice(I,I+528)),targetAfter=Array.from(f.m.ram.slice(T,T+48));
   await ns.barrier(); //existing real actor service barrier; no sleeps-as-ACK
   const peek=receive528(f,receiver,true),drain=receive528(f,receiver,false),after=receive528(f,receiver,true);
   observed.push({family,requested,target,source,set,query,initial,payload,sent,sendError,inputBefore,inputAfter,targetBefore,targetAfter,peek,drain,after});
   f.close(sender);f.close(receiver);
   // Complete actual transcript and cleanup requests precede semantic assertions.
   endpoint(target,family);endpoint(source,family);
   expect(set.rc).toBe(0);expect(set.error).toBe(0);expect(set.after).toEqual(set.before);
   expect(query.rc).toBe(0);expect(query.error).toBe(0);expect(query.length).toBe(4);expect(query.word).toBe(requested);
   expect(query.value).toEqual([...Array(8).fill(0xb6),requested&255,requested>>>8&255,0,0,...Array(20).fill(0xb6)]);
   expect(query.lengthBytes).toEqual([...Array(4).fill(0xb6),4,0,0,0,...Array(4).fill(0xb6)]);
   empty(initial);expect(sent).toBe(512);expect(sendError).toBe(0);
   expect(inputBefore).toEqual([...a5(8),...payload,...a5(8)]);expect(inputAfter).toEqual(inputBefore);expect(targetAfter).toEqual(targetBefore);
   received(peek,source,payload);received(drain,source,payload);empty(after);
  }catch(error){first=error;console.error(JSON.stringify({kind:"MEASURED_FIRST_EMPTY_PACKET_ONLY",arm,observed,trace:f?.trace,error:String(error)}));}
  finally{
   try{f?.dispose();}catch(error){if(first===undefined)first=error;}
   try{await ns.close();}catch(error){if(first===undefined)first=error;}
  }
  if(first!==undefined)throw first;
 },15000);
}
