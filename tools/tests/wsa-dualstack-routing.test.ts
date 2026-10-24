import {expect,test} from "bun:test";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {PROTO_TCP,PROTO_TCP6,PROTO_UDP,PROTO_UDP6} from "../../src/worker/net/netplay-wire";
import {WsaSocketTable,WsaFailure,WSA,ipv4Address,ipv6Address} from "../../src/worker/modules/wsa-network";

// Engine ownership regression: a dual socket covers two canonical lanes but
// one established connection belongs to exactly one lane. This injects errors
// at the public network boundary; it is not a new native socket-error oracle.
for(const mapped of [true,false]) test("dual TCP rejects a socket error from the other canonical lane: "+(mapped?"mapped4":"native6"),()=>{
 const network=new LanNetwork(),table=new WsaSocketTable(network);
 const loopback4=Uint8Array.of(127,0,0,1),loopback6=new Uint8Array(16);loopback6[15]=1;
 const mapped4=new Uint8Array(16);mapped4[10]=mapped4[11]=255;mapped4.set(loopback4,12);
 try{
  const listener=table.socket(1,mapped?2:23,6);
  table.bind(listener,mapped?ipv4Address(loopback4,0):ipv6Address(loopback6,0));table.listen(listener);
  const client=table.socket(1,23,6);table.setV6Only(client,false);table.bind(client,ipv6Address(new Uint8Array(16),0));
  const port=table.get(listener).local!.port;
  expect(table.connect(client,ipv6Address(mapped?mapped4:loopback6,port))).toBe(0);
  const accepted=table.accept(listener),local=table.get(client).local!.port,wire=mapped?PROTO_TCP:PROTO_TCP6,other=mapped?PROTO_TCP6:PROTO_TCP;
  const error=(proto:number)=>({node:network.node,localPort:local,remotePort:port,proto,code:WSA.ECONNRESET,bindingGeneration:network.bindingGeneration(local,proto)});
  expect(error(other).bindingGeneration).toBeGreaterThan(0);
  network.notifySocketError(error(other));
  expect(table.isConnected(client)).toBe(true);expect(table.get(client).error).toBe(0);
  expect(table.send(client,Uint8Array.of(4,6,1))).toBe(3);expect([...table.receive(accepted,3).data]).toEqual([4,6,1]);
  network.notifySocketError(error(wire));
  expect(table.isConnected(client)).toBe(false);expect(table.get(client).error).toBe(WSA.ECONNRESET);
 }finally{table.reset();}
});

for(const mapped of [true,false]) test("connected dual UDP rejects a socket error from the other canonical lane: "+(mapped?"mapped4":"native6"),()=>{
 const network=new LanNetwork(),table=new WsaSocketTable(network);
 const loopback4=Uint8Array.of(127,0,0,1),loopback6=new Uint8Array(16);loopback6[15]=1;
 const mapped4=new Uint8Array(16);mapped4[10]=mapped4[11]=255;mapped4.set(loopback4,12);
 try{
  const receiver=table.socket(2,mapped?2:23,17);
  table.bind(receiver,mapped?ipv4Address(loopback4,0):ipv6Address(loopback6,0));
  const client=table.socket(2,23,17);table.setV6Only(client,false);table.bind(client,ipv6Address(new Uint8Array(16),0));
  const port=table.get(receiver).local!.port;
  expect(table.connect(client,ipv6Address(mapped?mapped4:loopback6,port))).toBe(0);
  const local=table.get(client).local!.port,wire=mapped?PROTO_UDP:PROTO_UDP6,other=mapped?PROTO_UDP6:PROTO_UDP;
  const error=(proto:number)=>({node:network.node,localPort:local,remotePort:port,proto,code:WSA.ECONNRESET,bindingGeneration:network.bindingGeneration(local,proto)});
  expect(error(other).bindingGeneration).toBeGreaterThan(0);network.notifySocketError(error(other));
  expect(table.readable(client)).toBe(false);expect(table.get(client).error).toBe(0);
  expect(table.send(client,Uint8Array.of(4,6,2))).toBe(3);expect([...table.receive(receiver,3).data]).toEqual([4,6,2]);
  network.notifySocketError(error(wire));expect(table.readable(client)).toBe(true);
  try{table.receive(client,1);throw Error("Expected retained matching-lane reset");}catch(error){expect(error).toBeInstanceOf(WsaFailure);expect((error as WsaFailure).code).toBe(WSA.ECONNRESET);}
 }finally{table.reset();}
});
