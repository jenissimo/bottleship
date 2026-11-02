/** Public socket metadata: measured Windows A queries and independent ABI/catalog relationships. */
import {expect,test} from "bun:test";
import {RootNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import type {ThunkResult} from "../../src/worker/core/thunking/thunk-dispatcher";
import {createWsaApiFixture} from "./fixtures/wsa-api-context";

const SOL_SOCKET=0xffff,SO_PROTOCOL_INFOA=0x2004,SO_PROTOCOL_INFOW=0x2005;
const SIZE_A=372,SIZE_W=628,NAME=116,NAME_CHARS=256;
const OUTPUT=0x20000,LENGTH=0x10000,DUPLICATE=0x30000,ENUMERATED=0x40000,ENUM_LENGTH=0x11000;
const SENTINEL=0xa5,GUARD=16;
let sequence=0;
type Triple={family:number;type:number;protocol:number};
type Info={header:number[];providerGuid:number[];catalogId:number;chainLength:number;chainEntries:number[];
 version:number;family:number;maxAddress:number;minAddress:number;type:number;protocol:number;
 protocolMaxOffset:number;messageSize:number;providerReserved:number;name:string};

async function actorFixture(){
 const pid=49000+(++sequence),network=new LanNetwork(),namespace=new RootNetworkNamespace(network,16,pid);
 let memory:ReturnType<typeof createWsaApiFixture>|undefined;
 try{
  await namespace.barrier();
  const table=createWsaActorTable(network,()=>namespace.socketActorClient());
  memory=createWsaApiFixture(table,0x5a490001);const m=memory;
  let disposed=false;
  const call=(name:string,args:number[])=>{
   const fn=m.api[name];if(!fn)throw Error("Public Winsock export absent: "+name);
   const answer=fn({} as never,m.ram,args);
   if(answer instanceof Promise)throw Error("Unexpected asynchronous metadata ABI: "+name);
   if(typeof answer==="number")return answer;
   if(!answer||typeof answer.value!=="number")throw Error("Malformed public ABI result: "+name);
   m.apply(answer as ThunkResult);return answer.value;
  };
  const socket=(triple:Triple)=>{
   const value=call("WSASocketA",[triple.family,triple.type,triple.protocol,0,0,1]);
   if(value===-1||value===0xffffffff)throw Error("Actual actor socket prerequisite: "+JSON.stringify({triple,value,error:m.error()}));
   return value;
  };
  const query=(handle:number,wide:boolean,capacity=wide?SIZE_W:SIZE_A,output=OUTPUT,lengthPointer=LENGTH)=>{
   const size=wide?SIZE_W:SIZE_A;
   m.ram.fill(SENTINEL,OUTPUT-GUARD,OUTPUT+Math.max(size,capacity>0?capacity:0)+GUARD);
   m.put(LENGTH,capacity);m.seed(0x5a490002);
   const rc=call("getsockopt",[handle,SOL_SOCKET,wide?SO_PROTOCOL_INFOW:SO_PROTOCOL_INFOA,output,lengthPointer]);
   return{rc,error:m.error(),length:m.get(LENGTH),bytes:m.ram.slice(OUTPUT,OUTPUT+size),
    before:Array.from(m.ram.slice(OUTPUT-GUARD,OUTPUT)),
    after:Array.from(m.ram.slice(OUTPUT+size,OUTPUT+Math.max(size,capacity>0?capacity:0)+GUARD))};
  };
  return{pid,m,call,socket,query,
   async dispose(){
    if(disposed)return;disposed=true;
    // The fixture restores global System/Mem in its finally, even if table.reset throws.
    try{m.dispose();}finally{await namespace.close();}
   }};
 }catch(error){try{memory?.dispose();}finally{await namespace.close();}throw error;}
}
type Fixture=Awaited<ReturnType<typeof actorFixture>>;
async function withActor(run:(f:Fixture)=>void|Promise<void>){
 const f=await actorFixture();try{await run(f);}finally{await f.dispose();}
}
function decode(bytes:Uint8Array,wide:boolean):Info{
 const size=wide?SIZE_W:SIZE_A;expect(bytes.length).toBe(size);
 const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 // Win32 WSAPROTOCOL_INFO: GUID@20, catalog@36, WSAPROTOCOLCHAIN@40,
 // iVersion@72, AF@76, address extents@80/84, type/protocol@88/92, reserved@112.
 let name="";let terminated=false;
 for(let i=0;i<NAME_CHARS;i++){
  const code=wide?v.getUint16(NAME+i*2,true):v.getUint8(NAME+i);
  if(code===0){terminated=true;break;}name+=String.fromCharCode(code);
 }
 expect(terminated).toBe(true);expect(name.length).toBeGreaterThan(0);
 return{header:Array.from(bytes.slice(0,116)),providerGuid:Array.from(bytes.slice(20,36)),
  catalogId:v.getUint32(36,true),chainLength:v.getInt32(40,true),
  chainEntries:Array.from({length:7},(_,i)=>v.getUint32(44+i*4,true)),
  version:v.getInt32(72,true),family:v.getInt32(76,true),maxAddress:v.getInt32(80,true),minAddress:v.getInt32(84,true),
  type:v.getInt32(88,true),protocol:v.getInt32(92,true),protocolMaxOffset:v.getInt32(96,true),
  messageSize:v.getUint32(108,true),providerReserved:v.getUint32(112,true),name};
}
function untouched(bytes:number[]|Uint8Array){expect(Array.from(bytes).every(b=>b===SENTINEL)).toBe(true);}
function ansiNameTail(bytes:Uint8Array){
 const terminator=bytes.indexOf(0,NAME);expect(terminator).toBeGreaterThanOrEqual(NAME);
 untouched(bytes.slice(terminator+1));
}
function ordinaryIdentity(info:Info,triple:Triple){
 expect({family:info.family,type:info.type,protocol:info.protocol}).toEqual(triple);
 expect(info.catalogId).toBeGreaterThan(0);expect(info.providerGuid.some(b=>b!==0)).toBe(true);
 expect(info.chainLength).toBeGreaterThanOrEqual(1);expect(info.chainLength).toBeLessThanOrEqual(7);
 expect(info.providerReserved).toBe(0); // Ordinary metadata, not WSADuplicateSocket capability creation.
 expect(info.maxAddress).toBe(triple.family===23?28:16);expect(info.minAddress).toBe(triple.family===23?28:16);
}
function enumeration(f:Fixture,wide:boolean){
 const size=wide?SIZE_W:SIZE_A,fn=wide?"WSAEnumProtocolsW":"WSAEnumProtocolsA";
 f.m.put(ENUM_LENGTH,0);
 expect(f.call(fn,[0,0,ENUM_LENGTH])).toBe(-1);expect(f.m.error()).toBe(10055);
 const required=f.m.get(ENUM_LENGTH);
 if(required<=0||required%size!==0||required>16*size)throw Error("Bounded actual public catalog extent prerequisite");
 f.m.ram.fill(SENTINEL,ENUMERATED-GUARD,ENUMERATED+required+GUARD);f.m.put(ENUM_LENGTH,required);
 const count=f.call(fn,[0,ENUMERATED,ENUM_LENGTH]);
 expect(count).toBe(required/size);
 untouched(f.m.ram.slice(ENUMERATED-GUARD,ENUMERATED));untouched(f.m.ram.slice(ENUMERATED+required,ENUMERATED+required+GUARD));
 return Array.from({length:count},(_,i)=>decode(f.m.ram.slice(ENUMERATED+i*size,ENUMERATED+(i+1)*size),wide));
}
function catalogRelation(info:Info,rows:Info[],triple:Triple){
 // Enumeration supplies opaque catalog identity only, never the expected whole serializer image.
 const candidates=rows.filter(r=>r.family===triple.family&&r.type===triple.type&&
  triple.protocol>=r.protocol&&triple.protocol<=r.protocol+r.protocolMaxOffset);
 expect(candidates.length).toBe(1);const base=candidates[0];
 expect(info.catalogId).toBe(base.catalogId);expect(info.providerGuid).toEqual(base.providerGuid);
 expect(info.chainLength).toBe(base.chainLength);expect(info.chainEntries).toEqual(base.chainEntries);
 expect(info.name).toBe(base.name);
}

for(const family of [2,23])test("primary Stage47 SO_PROTOCOL_INFOA real actor AF"+family,async()=>{
 await withActor(f=>{
  const triple={family,type:2,protocol:17},s=f.socket(triple),r=f.query(s,false);
  // Measured modern Stage47 public A372 profile query: rc0/LE0 after its seeded call.
  // This assertion is profile-scoped; it does not impose universal successful getsockopt LE behavior.
  expect({rc:r.rc,error:r.error,length:r.length}).toEqual({rc:0,error:0,length:372});
  ordinaryIdentity(decode(r.bytes,false),triple);ansiNameTail(r.bytes);untouched(r.before);untouched(r.after);
 });
},10000);

for(const family of [2,23])test("NT5 ANSI short/null and invalid-socket precedence AF"+family,async()=>{
 await withActor(f=>{
  const s=f.socket({family,type:2,protocol:17});
  for(const capacity of [0,1,371]){
   const r=f.query(s,false,capacity);
   expect({rc:r.rc,error:r.error,length:r.length}).toEqual({rc:-1,error:10014,length:372});
   untouched(r.bytes);untouched(r.before);untouched(r.after);
  }
  const nullOutput=f.query(s,false,404,0,LENGTH);
  expect({rc:nullOutput.rc,error:nullOutput.error,length:nullOutput.length}).toEqual({rc:-1,error:10014,length:372});
  untouched(nullOutput.bytes);untouched(nullOutput.before);untouched(nullOutput.after);
  const nullLength=f.query(s,false,404,OUTPUT,0);
  expect({rc:nullLength.rc,error:nullLength.error,length:nullLength.length}).toEqual({rc:-1,error:10014,length:404});
  untouched(nullLength.bytes);untouched(nullLength.before);untouched(nullLength.after);
  for(const bad of [0xffffffff,s]){
   if(bad===s)expect(f.call("closesocket",[s])).toBe(0);
   const r=f.query(bad,false,17,0,0);
   expect({rc:r.rc,error:r.error,length:r.length}).toEqual({rc:-1,error:10038,length:17});
   untouched(r.bytes);untouched(r.before);untouched(r.after);
  }
 });
},10000);

for(const family of [2,23])test("NT5 ANSI success retains supplied optlen and writes only A372 AF"+family,async()=>{
 await withActor(f=>{
  const triple={family,type:2,protocol:17},s=f.socket(triple);
  for(const capacity of [372,404,628]){
   const r=f.query(s,false,capacity);
   expect({rc:r.rc,length:r.length}).toEqual({rc:0,length:capacity});
   ordinaryIdentity(decode(r.bytes,false),triple);untouched(r.before);untouched(r.after);
  }
 });
},10000);

test("virtual product A/W identity relationships including RAW (not a native RAW oracle)",async()=>{
 await withActor(f=>{
  const catalogA=enumeration(f,false),catalogW=enumeration(f,true);
  const triples:Triple[]=[
   {family:2,type:1,protocol:6},{family:2,type:2,protocol:17},{family:2,type:3,protocol:1},{family:2,type:3,protocol:253},
   {family:23,type:1,protocol:6},{family:23,type:2,protocol:17},{family:23,type:3,protocol:58},
  ];
  for(const triple of triples){
   const s=f.socket(triple),a=f.query(s,false),w=f.query(s,true);
   expect(a.rc).toBe(0);expect(w.rc).toBe(0);
   // The catalog relation checks opaque identity; the independent native matrix below checks W buffer rules.
   const ai=decode(a.bytes,false),wi=decode(w.bytes,true);
   ordinaryIdentity(ai,triple);ordinaryIdentity(wi,triple);
   expect(ai.header).toEqual(wi.header);expect(ai.name).toBe(wi.name);
   catalogRelation(ai,catalogA,triple);catalogRelation(wi,catalogW,triple);
   untouched(a.before);untouched(a.after);untouched(w.before);untouched(w.after);
  }
 });
},10000);

// RAW actual-protocol preservation below is an explicit virtual catalog/product relation.
// The accessible NT5 provider implementation and modern native RAW query are still unmeasured.
for(const wide of [false,true])test("virtual protocol-info preserves public duplicate reservation and live alias "+(wide?"W":"A"),async()=>{
 await withActor(f=>{
  const triple={family:23,type:3,protocol:58},source=f.socket(triple),size=wide?628:372;
  f.m.ram.fill(SENTINEL,DUPLICATE-GUARD,DUPLICATE+size+GUARD);
  expect(f.call(wide?"WSADuplicateSocketW":"WSADuplicateSocketA",[source,f.pid,DUPLICATE])).toBe(0);
  const duplicate=f.m.ram.slice(DUPLICATE,DUPLICATE+size),record=decode(duplicate,wide);
  expect(record.providerReserved).toBeGreaterThan(0);
  const beforeImport=f.query(source,wide);expect(beforeImport.rc).toBe(0);
  const ordinary=decode(beforeImport.bytes,wide);ordinaryIdentity(ordinary,triple);
  expect(ordinary.providerGuid).toEqual(record.providerGuid);expect(ordinary.catalogId).toBe(record.catalogId);
  // Query is not duplication/import and may not overwrite or consume the separately saved reservation.
  expect(f.m.ram.slice(DUPLICATE,DUPLICATE+size)).toEqual(duplicate);
  const alias=f.call(wide?"WSASocketW":"WSASocketA",[-1,-1,-1,DUPLICATE,0,1]);
  expect(alias).not.toBe(-1);expect(alias).not.toBe(0xffffffff);
  expect(f.call("closesocket",[source])).toBe(0);
  const aliased=f.query(alias,wide);expect(aliased.rc).toBe(0);
  const aliasInfo=decode(aliased.bytes,wide);ordinaryIdentity(aliasInfo,triple);
  expect(aliasInfo.header).toEqual(ordinary.header);expect(aliasInfo.name).toBe(ordinary.name);
  untouched(f.m.ram.slice(DUPLICATE-GUARD,DUPLICATE));untouched(f.m.ram.slice(DUPLICATE+size,DUPLICATE+size+GUARD));
  untouched(aliased.before);untouched(aliased.after);
 });
},10000);

const nativeOptionLengths = [
 // New x86 Windows observations: supplied, ANSI rc/optlen, Unicode rc/optlen.
 [-2147483648,0,0x80000000,-1,0x80000000],
 [-1,0,0xffffffff,-1,0xffffffff],
 [0,-1,372,-1,0], [371,-1,372,-1,371], [372,0,372,-1,372],
 [404,0,404,-1,404], [627,0,627,-1,627], [628,0,628,0,628], [660,0,660,0,628],
] as const;
for(const family of [2,23])test("modern Windows protocol-info lengths and pointer contracts AF"+family,async()=>{
 await withActor(f=>{
  const triple={family,type:2,protocol:17},s=f.socket(triple);
  for(const wide of [false,true]){
   for(const [capacity,aRc,aLength,wRc,wLength] of nativeOptionLengths){
    const rc=wide?wRc:aRc,length=wide?wLength:aLength,r=f.query(s,wide,capacity);
    expect({rc:r.rc,error:r.error,length:r.length}).toEqual({rc,error:rc===0?0:10014,length});
    if(rc===0){ordinaryIdentity(decode(r.bytes,wide),triple);if(!wide)ansiNameTail(r.bytes);}
    else untouched(r.bytes);
    untouched(r.before);untouched(r.after);
    const nil=f.query(s,wide,capacity,0,LENGTH);
    expect({rc:nil.rc,error:nil.error,length:nil.length}).toEqual({rc:-1,error:10014,length:wide?(capacity>>>0):372});
    untouched(nil.bytes);untouched(nil.before);untouched(nil.after);
    const bad=f.query(0xffffffff,wide,capacity,0,0);
    expect({rc:bad.rc,error:bad.error,length:bad.length}).toEqual({rc:-1,error:10038,length:capacity>>>0});
    untouched(bad.bytes);untouched(bad.before);untouched(bad.after);
   }
   const capacity=wide?660:404;
   for(const output of [OUTPUT,0]){
    const nil=f.query(s,wide,capacity,output,0);
    expect({rc:nil.rc,error:nil.error,length:nil.length}).toEqual({rc:-1,error:10014,length:capacity});
    untouched(nil.bytes);untouched(nil.before);untouched(nil.after);
   }
  }
 });
},10000);
