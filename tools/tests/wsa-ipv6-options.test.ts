import {expect,test} from "bun:test";
import {RootNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {createWsaApiFixture} from "./fixtures/wsa-api-context";

// Independent x86 Windows option observations52711f6a: UDP byte vs TCP DWORD.
const output=0x20000,length=0x21000,input=0x22000,address=0x23000;
let sequence=0;
type Fixture=ReturnType<typeof createWsaApiFixture>;
async function actor(run:(f:Fixture,call:(name:string,args:number[])=>number)=>void){
 const network=new LanNetwork(),host=new RootNetworkNamespace(network,8,52000+(++sequence));
 let f:Fixture|undefined;
 try{
  await host.barrier();
  f=createWsaApiFixture(createWsaActorTable(network,()=>host.socketActorClient()),0x5a500001);
  const current=f;
  const call=(name:string,args:number[])=>{
   const result=current.api[name]({} as never,current.ram,args);
   if(result instanceof Promise)throw Error("Unexpected async option ABI");
   if(typeof result==="number")return result;
   current.apply(result);return result.value;
  };
  run(f,call);
 }finally{try{f?.dispose();}finally{await host.close();}}
}
function query(f:Fixture,call:(n:string,a:number[])=>number,s:number,capacity:number){
 f.ram.fill(0xb6,output-8,output+16);f.put(length,capacity);f.seed(0x5a500002);
 const rc=call("getsockopt",[s,41,27,output,length]);
 return{rc,error:f.error(),length:f.get(length),bytes:Array.from(f.ram.slice(output,output+8)),
  before:Array.from(f.ram.slice(output-8,output)),after:Array.from(f.ram.slice(output+8,output+16))};
}
function checkedQuery(f:Fixture,call:(n:string,a:number[])=>number,s:number,type:number,capacity:number,value:number){
 const r=query(f,call,s,capacity),short=type===1&&capacity<4,size=type===1?4:1;
 expect({rc:r.rc,error:r.error,length:r.length}).toEqual(short?{rc:-1,error:10014,length:0}:{rc:0,error:0,length:size});
 const expected=new Array<number>(8).fill(0xb6);
 if(!short){expected[0]=value;if(size===4)expected.fill(0,1,4);}
 expect(r.bytes).toEqual(expected);expect(r.before).toEqual(new Array(8).fill(0xb6));expect(r.after).toEqual(new Array(8).fill(0xb6));
}
function set(f:Fixture,call:(n:string,a:number[])=>number,s:number,value:number,n:number){
 f.ram.fill(0xb6,input-8,input+16);f.put(input,value);const before=f.ram.slice(input-8,input+16);
 f.seed(0x5a500003);const rc=call("setsockopt",[s,41,27,input,n]),error=f.error();
 expect(f.ram.slice(input-8,input+16)).toEqual(before);return{rc,error};
}
for(const family of [2,23])for(const type of [2,1]){
 test("native V6ONLY default/get widths AF"+family+" type"+type,async()=>actor((f,call)=>{
  const s=call("WSASocketA",[family,type,type===1?6:17,0,0,1]);expect(s).not.toBe(-1);
  for(const n of family===23?[1,2,3,4,8]:[4])checkedQuery(f,call,s,type,n,1);
 }),10000);
 test("native V6ONLY unbound setter byte/DWORD AF"+family+" type"+type,async()=>actor((f,call)=>{
  const values=family===23?[[0,0,0],[1,1,1],[2,1,1],[256,0,1],[-1,1,1]]:[[0,0,0],[1,1,1]];
  for(const [value,udp,tcp] of values)for(const n of family===23?[1,2,3,4,8]:[4]){
   const s=call("WSASocketA",[family,type,type===1?6:17,0,0,1]);expect(s).not.toBe(-1);
   const result=set(f,call,s,value,n),short=type===1&&n<4;
   expect(result).toEqual(short?{rc:-1,error:10014}:{rc:0,error:0});
   checkedQuery(f,call,s,type,4,short?1:type===1?tcp:udp);
   expect(call("closesocket",[s])).toBe(0);
  }
 }),10000);
 if(family===23)test("native V6ONLY bound setter validation precedence type"+type,async()=>actor((f,call)=>{
  for(const value of [0,1,2,256,-1])for(const n of [1,2,3,4,8]){
   const s=call("WSASocketA",[23,type,type===1?6:17,0,0,1]);expect(s).not.toBe(-1);
   f.ram.fill(0,address,address+28);f.ram[address]=23;f.ram[address+23]=1;
   expect(call("bind",[s,address,28])).toBe(0);
   expect(set(f,call,s,value,n)).toEqual({rc:-1,error:type===1&&n<4?10014:10022});
   checkedQuery(f,call,s,type,4,1);expect(call("closesocket",[s])).toBe(0);
  }
 }),10000);
}
for(const family of [2,23])test("native V6ONLY RAW default and four-byte setter AF"+family,async()=>actor((f,call)=>{
 const s=call("WSASocketA",[family,3,family===2?1:58,0,0,1]);expect(s).not.toBe(-1);
 checkedQuery(f,call,s,3,4,0);
 for(const value of [0,1]){expect(set(f,call,s,value,4)).toEqual({rc:0,error:0});checkedQuery(f,call,s,3,4,value);}
}),10000);
