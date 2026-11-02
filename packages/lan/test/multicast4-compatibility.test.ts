import {expect,test} from "bun:test";
import {createServer} from "node:http";
import {Server} from "socket.io";
import {LanNetwork,type LanDatagram} from "../../../src/worker/net/lan-network";
import {RelayLink} from "../../../src/worker/net/relay-link";
import {RootNetworkNamespace,ChildProcessNetworkNamespace} from "../../../src/worker/core/network-namespace";
import {PROTO_UDP,encodeDatagram,decodeDatagram} from "../../../src/worker/net/netplay-wire";
class ControlWorker extends EventTarget{
 private ports:MessagePort[]=[];
 postMessage(m:any){const p=m.control;this.ports.push(p,m.network.port);p.onmessage=e=>{const v=e.data;if(["barrier","finish","shutdown"].includes(v.type))p.postMessage({type:v.type==="shutdown"?"shutdownDone":v.type==="finish"?"finished":"barrierDone",id:v.id});};p.start();}
 unref(){}terminate(){this.ports.forEach(p=>p.close());this.dispatchEvent(new Event("close"));}
}
test("a legacy ready without multicast capability preserves ordinary UDP and local-only multicast",async()=>{
 const http=createServer(),io=new Server(http,{transports:["websocket"]}),frames:Uint8Array[]=[];
 io.on("connection",socket=>{socket.on("frame",frame=>frames.push(new Uint8Array(frame)));const node=socket.handshake.auth.node as number[];socket.emit("ready",{version:1,node,ipv4:[10,...node.slice(3)]});});
 await new Promise<void>(ok=>http.listen(0,"127.0.0.1",ok));
 const network=new LanNetwork(Uint8Array.of(2,0,0,29,2,1)),received:LanDatagram[]=[],link=new RelayLink("http://127.0.0.1:"+(http.address() as {port:number}).port,"legacy",network,{transports:["websocket"]});
 network.attach(link);network.bind(6295,{deliver:dg=>received.push(dg)},PROTO_UDP);
 try{
  await link.ready;expect(network.udpMulticast4V1).toBeUndefined();
  const group=Uint8Array.of(239,255,42,17);
  expect(network.sendMulticast4(6296,group,6295,Uint8Array.of(1),2,1)).toBe(false);expect(received).toHaveLength(0);
  expect(network.sendMulticast4(6296,group,6295,Uint8Array.of(2),1,1)).toBe(true);
  expect(network.sendMulticast4(6296,group,6295,Uint8Array.of(3),2,0)).toBe(true);expect(received).toHaveLength(2);
  expect(network.send(6296,Uint8Array.of(2,0,0,29,2,2),6295,Uint8Array.of(4),PROTO_UDP)).toBe(true);
  const end=Date.now()+2000;while(!frames.length){if(Date.now()>end)throw Error("legacy UDP not received");await new Promise(ok=>setTimeout(ok,5));}
  expect(frames).toHaveLength(1);expect(frames[0][0]).toBe(2);expect(decodeDatagram(frames[0])?.payload).toEqual(Uint8Array.of(4));
 }finally{network.attach(null);await new Promise<void>(ok=>io.close(()=>ok()));}
},8000);
test("relay multicast ingress validation precedes trusted root and child broker delivery",async()=>{
 const http=createServer(),io=new Server(http,{transports:["websocket"]});let peer:import("socket.io").Socket;
 io.on("connection",socket=>{peer=socket;const node=socket.handshake.auth.node as number[];socket.emit("ready",{version:1,node,ipv4:[10,...node.slice(3)],udpMulticast4V1:true});});
 await new Promise<void>(ok=>http.listen(0,"127.0.0.1",ok));
 const network=new LanNetwork(Uint8Array.of(2,0,0,29,3,1)),saved=globalThis.Worker;let host:RootNetworkNamespace;
 try{globalThis.Worker=ControlWorker as unknown as typeof Worker;host=new RootNetworkNamespace(network,8);}finally{globalThis.Worker=saved;}
 const lease=host!.createChild(),child=new LanNetwork(),namespace=new ChildProcessNetworkNamespace(child,lease.boot),atRoot:LanDatagram[]=[],atChild:LanDatagram[]=[];
 try{
  await host!.configure({serverUrl:"http://127.0.0.1:"+(http.address() as {port:number}).port,room:"ingress"});
  network.bind(6297,{deliver:dg=>atRoot.push(dg)},PROTO_UDP,true);child.bind(6297,{deliver:dg=>atChild.push(dg)},PROTO_UDP,true);await namespace.barrier();
  const foreign=Uint8Array.of(2,0,0,29,3,2),meta={group:Uint8Array.of(239,255,42,17),interfaceIndex:2 as const,ttl:1};
  peer!.emit("frame",encodeDatagram(PROTO_UDP,foreign,6297,6298,Uint8Array.of(90),{...meta,interfaceIndex:1}));
  peer!.emit("frame",encodeDatagram(PROTO_UDP,foreign,6297,6298,Uint8Array.of(91),{...meta,ttl:0}));
  peer!.emit("frame",encodeDatagram(PROTO_UDP,network.node,6297,6298,Uint8Array.of(92),meta));
  peer!.emit("frame",encodeDatagram(PROTO_UDP,Uint8Array.of(2,3,...meta.group),6297,6298,Uint8Array.of(93),meta));
  peer!.emit("frame",encodeDatagram(PROTO_UDP,foreign,6297,6298,Uint8Array.of(1),meta));
  const end=Date.now()+2000;while(!atRoot.some(dg=>dg.data[0]===1)){if(Date.now()>end)throw Error("valid ingress missing "+JSON.stringify({connected:network.connected,cap:network.udpMulticast4V1,backplaneCap:(host as any).backplane.udpMulticast4V1,root:atRoot.map(dg=>dg.data[0]),child:atChild.map(dg=>dg.data[0]),relay:(host as any).active?.link.connected,received:(host as any).backplane.stats}));await new Promise(ok=>setTimeout(ok,5));}
  await namespace.barrier();expect(atRoot.map(dg=>dg.data[0])).toEqual([1]);expect(atChild.map(dg=>dg.data[0])).toEqual([1]);
  expect(atChild[0].multicast4).toEqual({...meta,localOrigin:false});
 }finally{namespace.close();lease.close();await host!.close();await new Promise<void>(ok=>io.close(()=>ok()));}
},8000);
