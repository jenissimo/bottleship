/**
 * SOURCE mechanism only: real child Worker/public WSADuplicateSocketW→WSASocketW.
 * Native8dc9 measured SAME-process immediate imports, not delayed cross-process
 * cache timing. No physical mutation occurs between this export and its import.
 */
import {expect,test} from "bun:test";
import {RootNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {publicContext} from "./fixtures/wsa-rcvbuf-context";

function childProcess(host:RootNetworkNamespace,pid:number){
 const lease=host.createChild(pid);
 let worker:Worker;
 try{worker=new Worker(new URL("./fixtures/wsa-rcvbuf-child.ts",import.meta.url).href,{type:"module"});}
 catch(error){lease.close();throw error;}
 let sequence=0,closed=false;
 const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();
 const stopped=new Promise<void>(resolve=>worker.addEventListener("close",()=>resolve(),{once:true}));
 function rejectPending(error:unknown){for(const task of pending.values()){clearTimeout(task.timer);task.reject(error);}pending.clear();}
 worker.onmessage=({data})=>{const task=pending.get(data.id);if(!task)return;pending.delete(data.id);clearTimeout(task.timer);
  if(data.error!==undefined)task.reject(Error(data.error));else task.resolve(data.result);};
 worker.onerror=event=>rejectPending(Error(String(event.message)));
 function request(value:object,ports:MessagePort[]=[]):Promise<any>{
  if(closed||pending.size)throw Error("Serial owned child request required");
  return new Promise((resolve,reject)=>{
   const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error("Child RPC deadline"));},3000);
   pending.set(id,{resolve,reject,timer});
   try{worker.postMessage({id,...value},ports);}catch(error){clearTimeout(timer);pending.delete(id);reject(error);}
  });
 }
 const ready=request({boot:lease.boot},[lease.boot.port]);
 return{ready,request,async close(){
  if(!closed){closed=true;try{worker.terminate();}finally{lease.close();rejectPending(Error("Own child retired"));}}
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([stopped,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("Own Worker retirement deadline")),2000);})]);}
  finally{if(timer)clearTimeout(timer);}
 }};
}
function checkData(r:any,source:ReturnType<ReturnType<typeof publicContext>["local"]>,payload:number[]){
 expect(r.rc).toBe(payload.length);expect(r.error).toBe(0);
 expect(r.data).toEqual([...payload,...Array(32-payload.length).fill(0xa5)]);
 expect(r.length).toBe(source.length);expect(r.name.slice(0,r.length)).toEqual(source.raw.slice(0,source.length));
 expect(r.name.slice(r.length)).toEqual(Array(32-r.length).fill(0xa5));
}
for(const family of[2,23] as const)test("SOURCE child reservation survives creator finish, cache seed and shared FIFO AF"+family,async()=>{
 const pid=51400+family,network=new LanNetwork(),ns=new RootNetworkNamespace(network,16,pid);
 let f:ReturnType<typeof publicContext>|undefined,child:ReturnType<typeof childProcess>|undefined,first:unknown;
 const observed:unknown[]=[];
 try{
  await ns.barrier();f=publicContext(createWsaActorTable(network,()=>ns.socketActorClient()));
  child=childProcess(ns,pid+100);const boot=await child.ready;
  if(boot.ready!==true||boot.pid!==pid+100)throw Error("Actual child bootstrap identity");
  const creator=f.socket(family),endpoint=f.bind(creator,family);
  const old=f.importInfo(f.duplicate(creator,pid));
  const setCreator=f.set(creator,4096),setOld=f.set(old,0);f.close(old);
  // Export actual opaque provider image while physical requested window is0.
  // Import is delayed only by real creator lifetime release, with no intervening option set.
  const info=f.duplicate(creator,boot.pid);
  await ns.finishProcessLifetime();ns.beginProcessLifetime();
  const oldValid=f.table.isValid(creator);
  const alias=await child.request({command:"import",info});
  const initial=await child.request({command:"query",socket:alias});
  const setChild=await child.request({command:"set",socket:alias,value:65536});
  const changed=await child.request({command:"query",socket:alias});
  const sender=f.socket(family),source=f.bind(sender,family),payload=[0x51,0xc1,family,0x00,0x05];
  const offeredEmpty=f.send(sender,endpoint,[]);await ns.barrier();
  const offeredData=f.send(sender,endpoint,payload);await ns.barrier();
  const deadline=Date.now()+3000;
  while(!await child.request({command:"readable",socket:alias})){
   if(Date.now()>=deadline)throw Error("Child FIFO readiness deadline");await ns.barrier();
  }
  const peek=await child.request({command:"receive",socket:alias,peek:true});
  const empty=await child.request({command:"receive",socket:alias});
  const data=await child.request({command:"receive",socket:alias});
  observed.push({boot,setCreator,setOld,oldValid,initial,setChild,changed,offeredEmpty,offeredData,source,peek,empty,data});
  await child.close();await ns.barrier();
  const replacement=f.socket(family),rebound=f.bind(replacement,family,endpoint.port);observed.push({rebound});
  // Assertions follow the actual lifecycle, queue reads and replacement bind.
  expect(oldValid).toBe(false);
  for(const set of[setCreator,setOld,setChild]){expect(set.rc).toBe(0);expect(set.error).toBe(0);expect(set.after).toEqual(set.before);}
  expect(initial.rc).toBe(0);expect(initial.word).toBe(0);expect(initial.length).toBe(4);
  expect(changed.rc).toBe(0);expect(changed.word).toBe(65536);expect(changed.length).toBe(4);
  expect([offeredEmpty,offeredData]).toEqual([0,payload.length]);
  checkData(peek,source,[]);checkData(empty,source,[]);checkData(data,source,payload);
  expect(rebound.port).toBe(endpoint.port);
 }catch(error){first=error;console.error(JSON.stringify({kind:"SOURCE_CROSS_PROCESS_NOT_NATIVE_CERTIFICATE",family,observed,trace:f?.trace,error:String(error)}));}
 finally{
  try{await child?.close();}catch(error){if(first===undefined)first=error;}
  try{f?.dispose();}catch(error){if(first===undefined)first=error;}
  try{await ns.close();}catch(error){if(first===undefined)first=error;}
 }
 if(first!==undefined)throw first;
},20000);
