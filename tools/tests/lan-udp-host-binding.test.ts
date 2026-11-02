import {test,expect} from "bun:test";
import {LanNetwork} from "../../src/worker/net/lan-network";
import type {UdpHostLease,UdpHostFailure} from "../../src/worker/net/udp-host-lease-rpc";
const allowedNodes=[[2,1,127,0,0,1]],endpoint={deliver(){}};
function setup(){
 const net=new LanNetwork(Uint8Array.of(2,0,0,1,2,3));let answer!:(lease:UdpHostLease)=>void;
 net.attach({send:()=>true,close(){},openUdpHost:()=>new Promise(resolve=>{answer=resolve})});
 net.configureUdpHosts({listeners:[{id:"game",allowedNodes}]});expect(net.bind(2302,endpoint,1)).toBe(true);
 let releases=0,live=true,end!:(error:UdpHostFailure)=>void;
 const closed=new Promise<UdpHostFailure>(resolve=>{end=resolve});
 const lease:UdpHostLease={address:{node:[2,1,127,0,0,1],port:45124},allowedNodes,isLive:()=>live,closed,
  release(){if(!live)return;live=false;releases++;end({code:995,message:"released"})}};
 return{net,lease,answer:(value=lease)=>answer(value),releases:()=>releases,end:(error:UdpHostFailure)=>{live=false;end(error)}};
}
test("physical Host bind waits for READY; abort after adoption retires once",async()=>{
 const s=setup(),cancel=new AbortController();let settled=false;
 const pending=s.net.openUdpHost(2302,"game",cancel.signal).then(lease=>{settled=true;return lease});
 await Promise.resolve();expect(settled).toBe(false);s.answer();const lease=await pending;
 expect(lease.address.port).toBe(45124);expect(lease.isLive()).toBe(true);
 cancel.abort();expect(s.releases()).toBe(1);expect(lease.isLive()).toBe(false);await lease.closed;
 lease.release();expect(s.releases()).toBe(1);s.net.reset();
});
test("old Host ACK closes after UDP binding reuse without attaching to replacement",async()=>{
 const s=setup();const pending=s.net.openUdpHost(2302,"game");
 s.net.unbind(2302,endpoint,1);await expect(pending).rejects.toMatchObject({code:"CANCELLED"});
 expect(s.net.bind(2302,endpoint,1)).toBe(true);s.answer();await new Promise(resolve=>setTimeout(resolve,0));
 expect(s.releases()).toBe(1);s.net.reset();
});
test("Host fatal close ends local liveness without taking down unrelated UDP",async()=>{
 const s=setup(),pending=s.net.openUdpHost(2302,"game");s.answer();const lease=await pending;
 s.end({code:10054,message:"physical listener failed"});await lease.closed;await Promise.resolve();
 expect(lease.isLive()).toBe(false);expect(s.net.connected).toBe(true);expect(s.net.isBound(2302,1)).toBe(true);
 s.net.reset();
});
test("Host READY cannot expand advertised ingress ACL",async()=>{
 const s=setup(),pending=s.net.openUdpHost(2302,"game");
 s.answer({...s.lease,allowedNodes:[[2,1,192,0,2,4]]});
 await expect(pending).rejects.toMatchObject({code:"NO_RECOVERY"});expect(s.releases()).toBe(1);s.net.reset();
});
