import {expect,test} from "bun:test";
import {DirectPlay4MixedTcpStream} from "../../src/worker/modules/dplayx/native-wire/mixed-tcp-stream";
const hex=(s:string)=>Uint8Array.from(Buffer.from(s.replace(/\s/g,""),"hex"));
const sys=hex("2000b0fa 020008fcc00002010000000000000000 706c617907000e0001000000");
const raw=hex("2b00b0fa 020012c95e13de3510000000faaddbba 07d97907 05d97907 686f73742d33323434353636373335");
test("system and native player frames retain order across every split",()=>{
 const all=Uint8Array.from([...sys,...raw,...sys]);
 for(let i=0;i<=all.length;i++){
  const s=new DirectPlay4MixedTcpStream(128,4,512),frames=[...s.push(all.subarray(0,i)),...s.push(all.subarray(i))];
  expect(frames.map(x=>x.kind)).toEqual(["system","player","system"]);
  expect(frames[1].kind==="player"&&frames[1].frame.from).toBe(125425927);s.finish();
 }
});
test("PLAYERWRAPPER is delivered as player data amid system frames",()=>{
 const wrapper=hex("2600b0fa 020008fcc00002010000000000000000 706c617919000e00 706c6179 78563412 0102");
 const all=Uint8Array.from([...sys,...wrapper,...raw]);
 for(let i=0;i<=all.length;i++){
  const s=new DirectPlay4MixedTcpStream(128,4,512), frames=[...s.push(all.subarray(0,i)),...s.push(all.subarray(i))];
  expect(frames.map(x=>x.kind)).toEqual(["system","player","player"]);
  if(frames[1].kind!=="player")throw new Error("not a player frame");
  expect(frames[1].frame.from).toBe(0x79616c70);expect(frames[1].frame.to).toBe(0x12345678);
  expect(frames[1].frame.data).toEqual(Uint8Array.of(1,2));s.finish();
 }
 const short=hex("1c00b0fa 020008fcc00002010000000000000000 706c617919000e00");
 expect(()=>new DirectPlay4MixedTcpStream(128,4,512).push(short)).toThrow(RangeError);
});
test("mixed batch limits and malformed trailing frame are terminal",()=>{
 const s=new DirectPlay4MixedTcpStream(128,1,128);
 expect(()=>s.push(Uint8Array.from([...sys,...raw]))).toThrow();
 expect(()=>s.push(raw)).toThrow("closed");
 const other=new DirectPlay4MixedTcpStream(128,4,512),invalid=sys.slice();invalid[3]=0;
 expect(()=>other.push(Uint8Array.from([...raw,...invalid]))).toThrow();expect(()=>other.finish()).toThrow();
 const truncated=new DirectPlay4MixedTcpStream(128,4,512);truncated.push(raw.subarray(0,15));expect(()=>truncated.finish()).toThrow();
});
