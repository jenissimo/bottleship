/**
 * ABI/alias literals come from modern native8dc9e864... and getter0b05c800...;
 * NT5 current-occupancy admission cases are separately labelled SOURCE, not
 * a modern exact-capacity claim. Existing abbb default RED source stays immutable.
 */
import {expect,test} from "bun:test";
import {RootNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {publicContext,type Family} from "./fixtures/wsa-rcvbuf-context";
let nextPid=51200;
async function run(label:string,body:(f:ReturnType<typeof publicContext>,ns:RootNetworkNamespace,pid:number)=>Promise<void>){
 const network=new LanNetwork(),pid=++nextPid,ns=new RootNetworkNamespace(network,16,pid);
 let f:ReturnType<typeof publicContext>|undefined,first:unknown;
 try{await ns.barrier();f=publicContext(createWsaActorTable(network,()=>ns.socketActorClient()));await body(f,ns,pid);}
 catch(error){first=error;console.error(JSON.stringify({label,trace:f?.trace,error:String(error)}));}
 finally{try{f?.dispose();}catch(error){if(first===undefined)first=error;}
  try{await ns.close();}catch(error){if(first===undefined)first=error;}}
 if(first!==undefined)throw first;
}
function checkQuery(q:ReturnType<ReturnType<typeof publicContext>["query"]>,expected:number){
 const short=q.capacity<4,word=[expected&255,expected>>>8&255,expected>>>16&255,expected>>>24&255];
 // Native extent probe: zero the exact declared capacity, then write DWORD only if cap>=4.
 // Short cap3 writes THREE ZEROS even after4096, never a prefix of the requested value.
 const body=short?[...Array(q.capacity).fill(0),...Array(16-q.capacity).fill(0xb6)]:
  [...word,...Array(q.capacity-4).fill(0),...Array(16-q.capacity).fill(0xb6)];
 expect(q.rc).toBe(short?-1:0);expect(q.error).toBe(short?10014:0);
 expect(q.length).toBe(short?q.capacity:4);
 expect(q.value).toEqual([...Array(8).fill(0xb6),...body,...Array(8).fill(0xb6)]);
 expect(q.lengthBytes).toEqual([...Array(4).fill(0xb6),short?q.capacity:4,0,0,0,...Array(4).fill(0xb6)]);
 if(!short)expect(q.word).toBe(expected);
}
function checkData(r:ReturnType<ReturnType<typeof publicContext>["receive"]>,source:ReturnType<ReturnType<typeof publicContext>["local"]>,payload:number[]){
 expect(r.rc).toBe(payload.length);expect(r.error).toBe(0);
 expect(r.data).toEqual([...payload,...Array(32-payload.length).fill(0xa5)]);
 expect(r.length).toBe(source.length);expect(r.name.slice(0,r.length)).toEqual(source.raw.slice(0,source.length));
 expect(r.name.slice(r.length)).toEqual(Array(32-r.length).fill(0xa5));
}
for(const family of[2,23] as const)for(const bound of[false,true]){
 test("measured SO_RCVBUF ABI AF"+family+" bound="+bound,async()=>run("MEASURED_ABI",async f=>{
  const fresh=()=>{const s=f.socket(family);if(bound)f.bind(s,family);return s;};
  const initial=fresh(),queries=[0,1,2,3,4,8].map(cap=>f.query(initial,cap));f.close(initial);
  const setters:{value:number;length:number;set:ReturnType<typeof f.set>;q4:ReturnType<typeof f.query>;q8:ReturnType<typeof f.query>}[]=[];
  for(const length of[0,1,2,3,4,8]){
   const values=length<4?[4096]:[0,1,2,256,4096,65536,1048576];
   for(const value of values){const s=fresh(),set=f.set(s,value,length),q4=f.query(s),q8=f.query(s,8);f.close(s);setters.push({value,length,set,q4,q8});}
  }
  f.note({queries,setters}); // complete actual matrix precedes assertions
  for(const q of queries)checkQuery(q,65536);
  for(const row of setters){
   expect(row.set.rc).toBe(row.length<4?-1:0);expect(row.set.error).toBe(row.length<4?10014:0);
   expect(row.set.after).toEqual(row.set.before);
   checkQuery(row.q4,row.length<4?65536:row.value);checkQuery(row.q8,row.length<4?65536:row.value);
  }
 }),20000);
 test("measured stale provider aliases AF"+family+" bound="+bound,async()=>run("MEASURED_SAME_PROCESS_ALIAS",async(f,_ns,pid)=>{
  const creator=f.socket(family);if(bound)f.bind(creator,family);
  const old=f.importInfo(f.duplicate(creator,pid)),seen:ReturnType<typeof f.query>[]=[],sets:ReturnType<typeof f.set>[]=[];
  const pair=(a:number,b:number)=>{seen.push(f.query(a),f.query(b));};
  pair(creator,old);sets.push(f.set(creator,4096));pair(creator,old);
  sets.push(f.set(old,0));pair(creator,old);f.close(old);
  const fresh=f.importInfo(f.duplicate(creator,pid));pair(creator,fresh);
  sets.push(f.set(fresh,65536));pair(creator,fresh);f.close(creator);
  seen.push(f.query(fresh));sets.push(f.set(fresh,2));seen.push(f.query(fresh));f.close(fresh);
  f.note({seen,sets});
  const native=[65536,65536,4096,65536,4096,0,4096,0,4096,65536,65536,2];
  expect(seen.length).toBe(native.length);seen.forEach((q,i)=>checkQuery(q,native[i]));
  for(const row of sets){expect(row.rc).toBe(0);expect(row.error).toBe(0);expect(row.after).toEqual(row.before);}
 }),20000);
}
for(const family of[2,23] as const){
 test("measured unbound getter declared extent0..16 in two states AF"+family,async()=>run("MEASURED_UNBOUND_EXTENT",async f=>{
  const s=f.socket(family),capacities=[0,1,2,3,4,5,6,7,8,12,16];
  const defaults=capacities.map(cap=>f.query(s,cap)),set=f.set(s,4096);
  const changed=capacities.map(cap=>f.query(s,cap));f.close(s);
  f.note({defaults,set,changed}); // no bind was performed in native getter0b05c800...
  expect(set.rc).toBe(0);expect(set.error).toBe(0);expect(set.after).toEqual(set.before);
  defaults.forEach(q=>checkQuery(q,65536));changed.forEach(q=>checkQuery(q,4096));
 }),15000);
}
for(const family of[2,23] as const){
 test("SOURCE NT5 zero window admits whole first datagram; alias FIFO AF"+family,async()=>run("NT5_SOURCE_NOT_MODERN_CAPACITY",async(f,ns,pid)=>{
  const original=f.socket(family),target=f.bind(original,family);
  const alias=f.importInfo(f.duplicate(original,pid)),sender=f.socket(family),source=f.bind(sender,family);
  const zero=f.set(original,0); // NT5 physical effective window=max(1,requested), public query may remain0.
  const a=[0x51,0x01,0x03],b=[0x51,0x02,0x05,0x25,0x35],c=[0x51,0x03,0x07,0x37,0x47,0x57,0x67];
  const offerA=f.send(sender,target,a);await ns.barrier();
  const offerB=f.send(sender,target,b);await ns.barrier();
  const before=f.available(alias),peek=f.receive(alias,true),afterPeek=f.available(original),first=f.receive(original),empty=f.available(alias);
  const offerC=f.send(sender,target,c);await ns.barrier();
  const next=f.receive(alias),after=f.available(original);
  f.note({zero,offerA,offerB,offerC,before,afterPeek,empty,after,peek,first,next});
  // Independent NT5 recvdg1168 CURRENT occupancy check, not available+incoming.
  expect(zero.rc).toBe(0);expect([offerA,offerB,offerC]).toEqual([a.length,b.length,c.length]);
  expect(before).toBe(a.length);expect(afterPeek).toBe(a.length);
  checkData(peek,source,a);checkData(first,source,a);expect(empty).toBe(0);
  checkData(next,source,c);expect(after).toBe(0);
  // b was offered while physically full and never replaces the admitted head.
 }),15000);
}
