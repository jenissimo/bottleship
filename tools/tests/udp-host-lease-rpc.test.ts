import {test,expect} from "bun:test";
import {UdpHostLeaseRpc} from "../../src/worker/net/udp-host-lease-rpc";
import {copyUdpHostCapability,copyUdpHostReady} from "../../packages/lan/src/udp-host-protocol";
const request={proto:1 as const,localPort:2302,bindingGeneration:9,listenerId:"game"};
const ready={leaseId:3,address:{node:[2,1,127,0,0,1],port:45123},allowedNodes:[[2,1,127,0,0,1]]};
function setup(){
 const sent:unknown[]=[];let connected=true;
 const rpc=new UdpHostLeaseRpc({connected:()=>connected,request:(id,r)=>{sent.push(["open",id,r]);return true},
  cancel:id=>sent.push(["cancel",id]),release:id=>sent.push(["release",id])});
 return{rpc,sent,offline:()=>{connected=false;rpc.disconnect()}};
}
test("Host READY owns copied actual endpoint and closes only its exact request/lease pair",async()=>{
 const{rpc,sent}=setup();const pending=rpc.open(request);rpc.accept(1,ready);const lease=await pending;
 expect(lease.address.port).toBe(45123);expect(lease.isLive()).toBe(true);
 rpc.acceptClosed(2,3,{code:10054,message:"other request"});rpc.acceptClosed(1,4,{code:10054,message:"other lease"});
 expect(lease.isLive()).toBe(true);
 rpc.acceptClosed(1,3,{code:10054,message:"listener stopped"});
 expect(lease.isLive()).toBe(false);expect(await lease.closed).toEqual({code:10054,message:"listener stopped"});
 lease.release();expect(sent.map(x=>(x as unknown[])[0])).toEqual(["open"]);expect(rpc.controlReservations).toBe(0);
});
test("cancelled open cannot adopt a late physical listener ACK",async()=>{
 const{rpc,sent}=setup(),cancel=new AbortController();const pending=rpc.open(request,cancel.signal);
 cancel.abort();await expect(pending).rejects.toMatchObject({code:995});
 rpc.accept(1,ready);expect(sent.map(x=>(x as unknown[])[0])).toEqual(["open","cancel"]);expect(rpc.controlReservations).toBe(0);
});
test("disconnect and reused server lease identity cannot close a new connection request",async()=>{
 const{rpc,sent}=setup();const first=rpc.open(request);rpc.accept(1,ready);const old=await first;
 rpc.disconnect();expect(old.isLive()).toBe(false);expect((await old.closed).code).toBe(10050);
 const pending=rpc.open(request);rpc.accept(2,ready);const current=await pending;
 rpc.acceptClosed(1,3,{code:10054,message:"old connection"});expect(current.isLive()).toBe(true);
 current.release();expect(current.isLive()).toBe(false);expect((await current.closed).code).toBe(995);
 expect(sent.filter(x=>(x as unknown[])[0]==="release")).toEqual([["release",3]]);
});
test("Host acknowledgement validates endpoint and bounded source ACL before becoming live",async()=>{
 for(const bad of [
  {...ready,address:{node:[2,1,0,0,0,0],port:12}},
  {...ready,address:{node:[2,1,224,0,0,1],port:12}},
  {...ready,address:{node:[2,1,127,0,0,1],port:0}},
  {...ready,allowedNodes:[]},
  {...ready,allowedNodes:[ready.allowedNodes[0],ready.allowedNodes[0]]},
  {...ready,allowedNodes:Array.from({length:33},(_,i)=>[2,1,192,0,2,i+1])},
 ]){
  const{rpc,sent}=setup();const pending=rpc.open(request);rpc.accept(1,bad);
  await expect(pending).rejects.toMatchObject({code:10022});expect(sent[1]).toEqual(["cancel",1]);
 }
 const copy=copyUdpHostReady(ready);copy.address.node[2]=1;copy.allowedNodes[0][2]=1;
 expect(ready.address.node[2]).toBe(127);expect(ready.allowedNodes[0][2]).toBe(127);
 expect(()=>copyUdpHostCapability({listeners:[{id:"same",allowedNodes:ready.allowedNodes},{id:"same",allowedNodes:ready.allowedNodes}]})).toThrow();
});
test("Host pending admission is bounded and every admitted request retains cancellation",async()=>{
 const{rpc,sent}=setup();const cancel=new AbortController();
 const pending=Array.from({length:16},()=>rpc.open(request,cancel.signal).catch(error=>error.code));
 await expect(rpc.open(request)).rejects.toMatchObject({code:10055});expect(rpc.controlReservations).toBe(16);
 cancel.abort();expect(await Promise.all(pending)).toEqual(new Array(16).fill(995));
 expect(sent.filter(x=>(x as unknown[])[0]==="cancel")).toHaveLength(16);expect(rpc.controlReservations).toBe(0);
});
