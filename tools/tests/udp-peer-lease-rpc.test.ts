import {describe,it,expect} from "bun:test";
import {UdpPeerLeaseRpc} from "../../src/worker/net/udp-peer-lease-rpc";
const request={proto:1 as const,localPort:47123,bindingGeneration:1,node:[2,1,203,0,113,1],remotePort:9000};
function fixture(){
 const sent:any[]=[],cancelled:number[]=[],released:number[]=[];let connected=true;
 const rpc=new UdpPeerLeaseRpc({connected:()=>connected,request:(id,value)=>{sent.push({id,value});},cancel:id=>cancelled.push(id),release:id=>released.push(id)});
 return {rpc,sent,cancelled,released,disconnect(){connected=false;rpc.disconnect();}};
}
describe("UDP peer lease control RPC",()=>{
 it("waits for the exact ready ACK, snapshots its request and releases once",async()=>{
  const f=fixture(),original={...request,node:[...request.node]},pending=f.rpc.open(original);
  original.node[2]=99;expect(f.sent[0].value.node).toEqual(request.node);
  let ready=false;void pending.then(()=>ready=true);await Promise.resolve();expect(ready).toBe(false);
  f.rpc.accept(1,{leaseId:17});const lease=await pending;
  lease.release();lease.release();expect(f.released).toEqual([17]);expect(f.cancelled).toEqual([]);f.disconnect();
 });
 it("cancels both pending and active permission and ignores a late ready ACK",async()=>{
  const f=fixture(),controller=new AbortController(),pending=f.rpc.open(request,controller.signal);
  controller.abort();await expect(pending).rejects.toHaveProperty("code",995);expect(f.cancelled).toEqual([1]);
  f.rpc.accept(1,{leaseId:18});expect(f.released).toEqual([]);
  const active=new AbortController(),second=f.rpc.open(request,active.signal);f.rpc.accept(2,{leaseId:19});await second;
  active.abort();expect(f.released).toEqual([19]);f.disconnect();
 });
 it("keeps a rebound generation while retiring the old binding",async()=>{
  const f=fixture(),old=f.rpc.open(request),fresh=f.rpc.open({...request,bindingGeneration:2});
  f.rpc.accept(1,{leaseId:20});f.rpc.accept(2,{leaseId:21});await Promise.all([old,fresh]);
  f.rpc.retire(request.localPort,request.proto,1);expect(f.released).toEqual([20]);
  f.rpc.retire();expect(f.released).toEqual([20,21]);f.disconnect();
 });
 it("bounds pending requests and never sends controls from a disconnected lifetime",async()=>{
  const f=fixture(),pending=Array.from({length:16},()=>f.rpc.open(request));
  const results=Promise.allSettled(pending);await expect(f.rpc.open(request)).rejects.toHaveProperty("code",10055);
  expect(f.sent).toHaveLength(16);f.disconnect();
  expect((await results).every(item=>item.status==="rejected"&&(item.reason as any).code===10050)).toBe(true);
  f.rpc.accept(1,{leaseId:22});expect(f.released).toEqual([]);expect(f.cancelled).toEqual([]);
 });
 it("does not let an unknown or duplicate ACK release another live lease",async()=>{
  const f=fixture(),pending=f.rpc.open(request);f.rpc.accept(1,{leaseId:23});const lease=await pending;
  f.rpc.accept(99,{leaseId:23});f.rpc.accept(1,{leaseId:23});expect(f.released).toEqual([]);
  lease.release();expect(f.released).toEqual([23]);f.disconnect();
 });
});
