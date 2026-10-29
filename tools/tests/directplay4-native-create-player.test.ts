import {expect,test} from "bun:test";
import {DirectPlay4CreatePlayer} from "../../src/worker/modules/dplayx/native-wire/create-player";
import {decodeDirectPlay4SystemTcpFrame,encodeDirectPlay4SystemTcpFrame} from "../../src/worker/modules/dplayx/native-wire/tcp-frame";
const hex=(s:string)=>Uint8Array.from(Buffer.from(s.replace(/[^0-9a-f]/gi,""),"hex"));
const tcp=hex("0200f9d5c0a838010000000000000000"),udp=hex("0200d4d9c0a838010000000000000000");
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
function setup(timeoutMs=1000){
 const abort=new AbortController(),sent:Uint8Array[]=[],uncertain:string[]=[];let live=true;
 const owner={signal:abort.signal,current:()=>live,version:14,systemPlayerId:0x07756d23,tcpSockaddr:tcp,udpSockaddr:udp,
  send:async(frame:Uint8Array)=>{sent.push(Uint8Array.from(frame));},onUncertain:(e:Error)=>uncertain.push(e.message)};
 const op=new DirectPlay4CreatePlayer(owner,timeoutMs,1024);
 const reply=(id=0x07756d22)=>{const b=new Uint8Array(48),v=new DataView(b.buffer);v.setUint32(0,0x79616c70,true);v.setUint16(4,7,true);v.setUint16(6,14,true);v.setUint32(8,id,true);return decodeDirectPlay4SystemTcpFrame(encodeDirectPlay4SystemTcpFrame(tcp,b,1024),1024)!;};
 return {abort,sent,uncertain,owner,op,reply,retire:()=>{live=false;}};
}
test("cmd5 then cmd8 matches real native-host accepted source-derived fixture",async()=>{
 const f=setup();const run=f.op.create({shortName:"owned-client",longName:null,data:new Uint8Array()});
 await tick();expect(f.sent).toHaveLength(1);expect(f.sent[0]).toEqual(hex("2000b0fa0200f9d5c0a838010000000000000000706c617905000e0008000000"));
 expect(f.op.receive(f.reply())).toBe(true);expect(await run).toEqual({playerId:0x07756d22,submission:"submitted"});
 // Oracle d91b4cc4716f60fc: host GetPlayerName S_OK, not an application ACK.
 expect(f.sent[1]).toEqual(hex("a000b0fa0200f9d5c0a838010000000000000000706c617908000e0000000000226d7507000000001c000000000000006a00000008000000226d75071a00000000000000200000000000000000000000236d7507300000000e000000000000006f0077006e00650064002d0063006c00690065006e00740000000200f9d5c0a8380100000000000000000200d4d9c0a838010000000000000000000000000000"));
 expect(f.uncertain).toEqual([]);
});
test("reservation prevents reentrant create from current callback",async()=>{
 const f=setup();let op!:DirectPlay4CreatePlayer,inner:Promise<unknown>|undefined,once=true;
 f.owner.current=()=>{if(once){once=false;inner=op.create({shortName:null,longName:null,data:new Uint8Array()}).catch(e=>e);}return true;};
 op=new DirectPlay4CreatePlayer(f.owner,1000,1024);
 const run=op.create({shortName:null,longName:null,data:new Uint8Array()});
 expect(await inner).toBeInstanceOf(Error);await tick();op.receive(f.reply());await run;
 expect(f.sent).toHaveLength(2);expect(f.uncertain).toEqual([]);
});
test("reply delivery reentrant in current consumes the exact pending only once",async()=>{
 const f=setup();let op!:DirectPlay4CreatePlayer,armed=false,nested=false;
 f.owner.current=()=>{if(armed){armed=false;nested=op.receive(f.reply());}return true;};
 op=new DirectPlay4CreatePlayer(f.owner,1000,1024);const run=op.create({shortName:null,longName:null,data:new Uint8Array()});
 await tick();armed=true;expect(op.receive(f.reply())).toBe(true);expect(nested).toBe(true);
 expect((await run).submission).toBe("submitted");expect(f.sent).toHaveLength(2);
});
test("timeout retires ambiguous operation and never accepts a later reply",async()=>{
 const f=setup(15);await expect(f.op.create({shortName:null,longName:null,data:new Uint8Array()})).rejects.toThrow("timeout");
 expect(f.uncertain).toHaveLength(1);expect(f.op.receive(f.reply())).toBe(false);
 await expect(f.op.create({shortName:null,longName:null,data:new Uint8Array()})).rejects.toThrow("unavailable");
});
test("concurrent request rejected, abort before queued send cannot write",async()=>{
 const f=setup(),run=f.op.create({shortName:null,longName:null,data:new Uint8Array()});
 const second=f.op.create({shortName:null,longName:null,data:new Uint8Array()});
 f.abort.abort();await expect(second).rejects.toThrow();await expect(run).rejects.toThrow();expect(f.sent).toHaveLength(0);expect(f.uncertain).toHaveLength(1);
});
test("abort during held cmd8 send reports uncertain and never waits forever",async()=>{
 const f=setup();let calls=0;
 f.owner.send=async(frame)=>{calls++;f.sent.push(Uint8Array.from(frame));if(calls===2)await new Promise(()=>{});};
 const op=new DirectPlay4CreatePlayer(f.owner,1000,1024),run=op.create({shortName:null,longName:null,data:new Uint8Array()});
 await tick();op.receive(f.reply());await tick();f.abort.abort();await expect(run).rejects.toThrow("cancelled");expect(f.uncertain).toHaveLength(1);
});
