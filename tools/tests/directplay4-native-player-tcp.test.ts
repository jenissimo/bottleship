import {expect,test} from "bun:test";
import {encodeDirectPlay4PlayerTcpFrame,decodeDirectPlay4PlayerTcpFrame,DirectPlay4PlayerTcpStream} from "../../src/worker/modules/dplayx/native-wire/player-tcp";
const hex=(s:string)=>Uint8Array.from(Buffer.from(s.replace(/\s/g,""),"hex"));
// Real exchange: logs/lan-conformance/dp4-data-native-websocket-20261028-second/result.json.
// Host Receive and Send succeeded. Provider padding is preserved as raw bytes.
const outbound=hex("2d00b0fa 0200e1cbc0a838010000000000000000 05d97907 07d97907 636c69656e742d33323434353636373335");
const inbound=hex("2b00b0fa 020012c95e13de3510000000faaddbba 07d97907 05d97907 686f73742d33323434353636373335");
test("native player data vectors roundtrip IDs, payload and provider bytes",()=>{
 const a=decodeDirectPlay4PlayerTcpFrame(outbound,1024)!,b=decodeDirectPlay4PlayerTcpFrame(inbound,1024)!;
 expect(a.from).toBe(125425925);expect(a.to).toBe(125425927);
 expect(b.from).toBe(a.to);expect(b.to).toBe(a.from);
 expect(encodeDirectPlay4PlayerTcpFrame(a.providerSockaddr,a.from,a.to,a.data,1024)).toEqual(outbound);
 expect(encodeDirectPlay4PlayerTcpFrame(b.providerSockaddr,b.from,b.to,b.data,1024)).toEqual(inbound);
 const storage=Buffer.alloc(inbound.length+3);Buffer.from(inbound).copy(storage,1);
 const copy=decodeDirectPlay4PlayerTcpFrame(storage.subarray(1),1024)!;storage.fill(0);
 expect(copy.data).toEqual(b.data);expect(copy.providerSockaddr).toEqual(b.providerSockaddr);
});
test("fragmentation and concatenation preserve order",()=>{
 for(let i=0;i<=inbound.length;i++){
  const stream=new DirectPlay4PlayerTcpStream(1024,3,2048);
  expect([...stream.push(inbound.subarray(0,i)),...stream.push(inbound.subarray(i))][0].data).toEqual(inbound.subarray(28));
  stream.finish();
 }
 const stream=new DirectPlay4PlayerTcpStream(1024,3,2048);
 expect(stream.push(Uint8Array.from([...outbound,...inbound])).map(x=>x.from)).toEqual([125425925,125425927]);stream.finish();
});
test("invalid limits, system token, truncated frame and failed batch fail closed",()=>{
 expect(()=>encodeDirectPlay4PlayerTcpFrame(new Uint8Array(16),0x79616c70,1,new Uint8Array(),1024)).toThrow();
 const system=outbound.slice();system.set(hex("706c6179"),20);
 expect(()=>decodeDirectPlay4PlayerTcpFrame(system,1024)).toThrow();
 expect(decodeDirectPlay4PlayerTcpFrame(inbound.subarray(0,10),1024)).toBeNull();
 const truncated=new DirectPlay4PlayerTcpStream(1024,2,1024);truncated.push(inbound.subarray(0,10));expect(()=>truncated.finish()).toThrow();
 const batch=new DirectPlay4PlayerTcpStream(1024,1,1024);
 expect(()=>batch.push(Uint8Array.from([...outbound,...inbound]))).toThrow();
 expect(()=>batch.push(inbound)).toThrow("closed");
 expect(()=>new DirectPlay4PlayerTcpStream(28,1,0x1000001)).toThrow();
 const invalid=outbound.slice();invalid[3]=0;
 const stream=new DirectPlay4PlayerTcpStream(1024,2,1024);expect(()=>stream.push(invalid)).toThrow();expect(()=>stream.finish()).toThrow();
});
