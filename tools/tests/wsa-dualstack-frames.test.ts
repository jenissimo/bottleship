/**
 * Engine connection-identity regressions at the public encoded ingress boundary.
 * Exact peer IDs/ports come from live setup; they are not native oracle vectors.
 */
import {expect,test} from "bun:test";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {WsaSocketTable,WsaFailure,WSA,ipv4Address,ipv6Address} from "../../src/worker/modules/wsa-network";
import {encodeDatagram,encodeTcpFrame,PROTO_TCP,PROTO_TCP6,RST,SYN} from "../../src/worker/net/netplay-wire";

const ip4=Uint8Array.of(127,0,0,1);
const ip6=new Uint8Array(16);ip6[15]=1;
const mapped=new Uint8Array(16);mapped[10]=mapped[11]=255;mapped[12]=127;mapped[15]=1;
function connectLocal(table:WsaSocketTable,id:number,peer:ReturnType<typeof ipv6Address>){
 try{table.connect(id,peer);}catch(error){
  if(!(error instanceof WsaFailure)||error.code!==WSA.EWOULDBLOCK)throw error;
 }
 expect(table.get(id).state).toBe("connected");
}
function ingress(net:LanNetwork,proto:number,srcPort:number,dstPort:number,kind:number,srcId:number,value=0){
 const packet=encodeTcpFrame(kind,srcId,0,value);
 // receiveFrame treats this encoded node as the source. allowLoopback=true is the
 // existing trusted local ingress entry, not a forged remote provenance object.
 net.receiveFrame(encodeDatagram(proto,net.node,dstPort,srcPort,packet),true);
}

test("wrong-lane RST without destination identity cannot retire a live mapped TCP session",()=>{
 const net=new LanNetwork(),table=new WsaSocketTable(net);
 try{
  const listener=table.socket(1,2,6);table.bind(listener,ipv4Address(ip4,0));table.listen(listener);
  const client=table.socket(1,23,6);table.setV6Only(client,false);table.bind(client,ipv6Address(new Uint8Array(16),0));
  connectLocal(table,client,ipv6Address(mapped,table.get(listener).local!.port));
  const accepted=table.accept(listener),live=table.get(client);
  expect(live.peerId).toBe(table.get(accepted).wireId);
  expect(net.isBound(live.local!.port,PROTO_TCP)).toBe(true);
  expect(net.isBound(live.local!.port,PROTO_TCP6)).toBe(true);
  expect(table.send(client,Uint8Array.of(0x51))).toBe(1);
  expect(table.receive(accepted,1).data).toEqual(Uint8Array.of(0x51));
  const srcId=live.peerId,srcPort=live.peer!.port,dstPort=live.local!.port;
  ingress(net,PROTO_TCP6,srcPort,dstPort,RST,srcId,WSA.ECONNRESET);
  const afterWrong={state:table.get(client).state,error:table.get(client).error};
  // Positive control is collected before assertions on the meaningful RED.
  ingress(net,PROTO_TCP,srcPort,dstPort,RST,srcId,WSA.ECONNRESET);
  const afterCorrect={state:table.get(client).state,error:table.get(client).error};
  expect(afterCorrect).toEqual({state:"failed",error:WSA.ECONNRESET});
  expect(afterWrong).toEqual({state:"connected",error:0});
 }finally{table.reset();}
});

test("wrong-lane SYN cannot reuse an existing session from the other retained protocol",()=>{
 const net=new LanNetwork(),table=new WsaSocketTable(net);
 try{
  const listener6=table.socket(1,23,6);table.bind(listener6,ipv6Address(ip6,0));table.listen(listener6);
  const client=table.socket(1,23,6);table.setV6Only(client,false);table.bind(client,ipv6Address(new Uint8Array(16),0));
  connectLocal(table,client,ipv6Address(ip6,table.get(listener6).local!.port));
  const accepted6=table.accept(listener6),clientState=table.get(client),serverState=table.get(accepted6);
  expect(clientState.peerId).toBe(serverState.wireId);
  // Correct-lane duplicate SYN must reuse the existing child, without a second pending accept.
  ingress(net,PROTO_TCP6,clientState.local!.port,serverState.local!.port,SYN,clientState.wireId,65536);
  const correctPending=table.get(listener6).pending.length;
  const listener4=table.socket(1,2,6);
  table.bind(listener4,ipv4Address(net.ipv4,clientState.local!.port));table.listen(listener4);
  expect(net.isBound(clientState.local!.port,PROTO_TCP)).toBe(true);
  expect(net.isBound(clientState.local!.port,PROTO_TCP6)).toBe(true);
  // Only the actual setup peer ID/tuple is used; current client is retained TCP6,
  // while this SYN legitimately targets the coexisting TCP4 listener.
  ingress(net,PROTO_TCP,clientState.peer!.port,clientState.local!.port,SYN,clientState.peerId,65536);
  const afterWrong={
   pending:table.get(listener4).pending.length,
   clientState:table.get(client).state,
   serverState:table.get(accepted6).state,
  };
  expect(correctPending).toBe(0);
  expect(afterWrong).toEqual({pending:1,clientState:"connected",serverState:"connected"});
 }finally{table.reset();}
});
