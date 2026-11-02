import {expect,test} from "bun:test";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {WsaSocketTable} from "../../src/worker/modules/wsa-network";
import {WsaActorKernel} from "../../src/worker/modules/wsa-actor-kernel";

function fixture(){
 const net=new LanNetwork(Uint8Array.of(2,0,0,1,2,3));
 let resolve!:(lease:any)=>void,close!:(e:{code:number;message:string})=>void,releases=0,stopped=false;
 const node=[2,1,127,0,0,1],closed=new Promise<{code:number;message:string}>(ok=>{close=ok;});
 const lease={address:{node,port:32123},allowedNodes:[node],closed,isLive:()=>!stopped,
  release(){if(!stopped){stopped=true;releases++;close({code:10054,message:"closed"});}}};
 net.attach({connected:true,send:()=>true,close(){},openUdpHost:()=>new Promise(ok=>{resolve=ok;})});
 net.configureUdpHosts({listeners:[{id:"udp",allowedNodes:[node]}]});
 const table=new WsaSocketTable(net),kernel=new WsaActorKernel(table),identity={pid:7,slot:1,epoch:1};
 kernel.register(identity);
 const socket=kernel.execute(identity,"socket",[2,2,17]) as number;
 kernel.execute(identity,"bind",[socket]);
 return {net,table,kernel,identity,socket,answer:()=>resolve(lease),releases:()=>releases};
}
const tick=()=>new Promise<void>(r=>setTimeout(r,0));
test("actor UDP host READY owns the exact socket binding and advertised physical address",async()=>{
 const f=fixture();try{
  const token=f.kernel.execute(f.identity,"startUdpHost",[f.socket,"udp"]) as number;
  expect(f.kernel.execute(f.identity,"inspectUdpHost",[token])).toBeNull();
  await Promise.resolve();f.answer();await tick();
  const ready=f.kernel.execute(f.identity,"inspectUdpHost",[token]) as any;
  expect(ready.address.port).toBe(32123);expect(ready.binding).toBeGreaterThan(0);
  expect(ready.physical).toBe(f.kernel.execute(f.identity,"fileObjectId",[f.socket]));
  expect(f.net.bindingGeneration(ready.port,1)).toBe(ready.binding);
  f.kernel.execute(f.identity,"retireUdpHost",[token]);f.kernel.execute(f.identity,"retireUdpHost",[token]);
  expect(f.releases()).toBe(1);
 }finally{f.kernel.drop(f.identity);f.table.reset();}
});
test("closing the issuing alias before READY retires late lease; replacement is untouched",async()=>{
 const f=fixture();try{
  const token=f.kernel.execute(f.identity,"startUdpHost",[f.socket,"udp"]) as number;
  await Promise.resolve();f.kernel.execute(f.identity,"closesocket",[f.socket]);
  const replacement=f.kernel.execute(f.identity,"socket",[2,2,17]) as number;
  f.answer();await tick();await tick();
  expect(f.releases()).toBe(1);expect(f.kernel.execute(f.identity,"isValid",[replacement])).toBe(true);
  expect(()=>f.kernel.execute(f.identity,"inspectUdpHost",[token])).toThrow();
 }finally{f.kernel.drop(f.identity);f.table.reset();}
});
test("reentrant lease isLive retirement cannot publish or leak a late lease",async()=>{
 const f=fixture();let releases=0,token=0;
 try{
  const closed=new Promise<{code:number;message:string}>(()=>{});
  f.net.openUdpHost=()=>Promise.resolve({address:{node:[2,1,127,0,0,1],port:32123},allowedNodes:[[2,1,127,0,0,1]],closed,
   isLive(){f.kernel.execute(f.identity,"retireUdpHost",[token]);return true;},release(){releases++;}});
  token=f.kernel.execute(f.identity,"startUdpHost",[f.socket,"udp"]) as number;
  await tick();expect(releases).toBe(1);expect(()=>f.kernel.execute(f.identity,"inspectUdpHost",[token])).toThrow();
 }finally{f.kernel.drop(f.identity);f.table.reset();}
});
test("ACL mutation during final lease check cannot publish stale readiness",async()=>{
 const f=fixture();let checks=0;
 try{
  const closed=new Promise<{code:number;message:string}>(()=>{});
  f.net.openUdpHost=()=>Promise.resolve({address:{node:[2,1,127,0,0,1],port:32123},allowedNodes:[[2,1,127,0,0,1]],closed,
   isLive(){if(++checks===2)f.net.configureUdpHosts({listeners:[{id:"udp",allowedNodes:[[2,1,127,0,0,2]]}]});return true;},release(){}});
  const token=f.kernel.execute(f.identity,"startUdpHost",[f.socket,"udp"]) as number;
  await tick();expect(()=>f.kernel.execute(f.identity,"inspectUdpHost",[token])).toThrow();expect(checks).toBe(2);
 }finally{f.kernel.drop(f.identity);f.table.reset();}
});
test("synchronous host acquisition failure rolls back operation capacity",()=>{
 const f=fixture();try{
  f.net.openUdpHost=()=>{throw Error("injected open failure");};
  for(let i=0;i<130;i++)expect(()=>f.kernel.execute(f.identity,"startUdpHost",[f.socket,"udp"])).toThrow("injected open failure");
 }finally{f.kernel.drop(f.identity);f.table.reset();}
});
test("ACL change and process epoch revocation cannot preserve old lease",async()=>{
 const f=fixture();try{
  const token=f.kernel.execute(f.identity,"startUdpHost",[f.socket,"udp"]) as number;
  await Promise.resolve();f.answer();await tick();
  f.net.configureUdpHosts({listeners:[{id:"udp",allowedNodes:[[2,1,127,0,0,2]]}]});
  expect(()=>f.kernel.execute(f.identity,"inspectUdpHost",[token])).toThrow();
  f.kernel.drop(f.identity);expect(f.releases()).toBe(1);
  expect(()=>f.kernel.execute(f.identity,"inspectUdpHost",[token])).toThrow();
 }finally{f.kernel.drop(f.identity);f.table.reset();}
});
