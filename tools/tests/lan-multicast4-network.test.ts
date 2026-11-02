import {expect,test} from "bun:test";
import {LanNetwork,type LanDatagram} from "../../src/worker/net/lan-network";
import {encodeDatagram,ipv4ToNode,PROTO_UDP,PROTO_TCP} from "../../src/worker/net/netplay-wire";

const group=Uint8Array.of(239,255,42,17), remote=Uint8Array.of(2,0,0,8,0,2);
function fixture(){const net=new LanNetwork(Uint8Array.of(2,0,0,8,0,1)),received:LanDatagram[]=[];net.bind(6000,{deliver:dg=>received.push(dg)},PROTO_UDP);return {net,received};}
test("offline group routing retains destination and delivers exactly once",()=>{
 const {net,received}=fixture();
 expect(net.send(6001,ipv4ToNode(group),6000,Uint8Array.of(7),PROTO_UDP)).toBe(true);
 expect(received).toHaveLength(1);expect(received[0].multicast4).toEqual({group,interfaceIndex:2,ttl:1,localOrigin:true});
 expect(received[0].srcNode).toEqual(net.node);
 expect(net.send(6001,ipv4ToNode(group),6000,new Uint8Array(),PROTO_TCP)).toBe(false);
});
test("failed remote admission cannot leave a duplicate local copy",()=>{
 const {net,received}=fixture();let attempts=0;
 net.attach({send:()=>{attempts++;return false;},close(){}});
 expect(net.sendMulticast4(6001,group,6000,Uint8Array.of(1),2,1)).toBe(false);
 expect(attempts).toBe(0);expect(received).toHaveLength(0);
 net.configureMulticast4(true);
 expect(net.sendMulticast4(6001,group,6000,Uint8Array.of(1),2,1)).toBe(false);
 expect(attempts).toBe(1);expect(received).toHaveLength(0);
 expect(net.sendMulticast4(6001,group,6000,Uint8Array.of(2),1,1)).toBe(true);
 expect(net.sendMulticast4(6001,group,6000,Uint8Array.of(3),2,0)).toBe(true);
 expect(attempts).toBe(1);expect(received).toHaveLength(2);net.attach(null);
});
test("authenticated incoming multicast retains group and derives local origin",()=>{
 const {net,received}=fixture(),meta={group,interfaceIndex:2 as const,ttl:3};
 net.receiveFrame(encodeDatagram(PROTO_UDP,remote,6000,7000,Uint8Array.of(4),meta));
 expect(received[0]?.multicast4).toEqual({...meta,localOrigin:false});
 net.receiveFrame(encodeDatagram(PROTO_UDP,ipv4ToNode(group),6000,7000,Uint8Array.of(5),meta),true);
 expect(received).toHaveLength(1);
 net.receiveFrame(encodeDatagram(PROTO_UDP,net.node,6000,7000,Uint8Array.of(6),{...meta,interfaceIndex:1}),true);
 expect(received[1]?.multicast4?.localOrigin).toBe(true);
 received[0].multicast4!.group[0]=0;expect(received[1].multicast4?.group).toEqual(group);
});
test("disconnect retires multicast capability and recipient generation fences stale IPC",()=>{
 const {net,received}=fixture();net.configureMulticast4(true);net.setConnected(true);expect(net.udpMulticast4V1).toBe(true);
 const generation=net.deliveryGeneration(6000,PROTO_UDP),frame=encodeDatagram(PROTO_UDP,remote,6000,7000,Uint8Array.of(9),{group,interfaceIndex:2,ttl:1});
 net.receiveFrame(frame,true,undefined,generation+1);expect(received).toHaveLength(0);
 net.receiveFrame(frame,true,undefined,generation);expect(received).toHaveLength(1);
 net.setConnected(false);expect(net.udpMulticast4V1).toBeUndefined();
});
