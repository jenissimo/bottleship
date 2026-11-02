import {expect,test} from "bun:test";
import {EventEmitter} from "node:events";
import {PassThrough,Writable} from "node:stream";
import type {spawn} from "node:child_process";
import {NativeBoundUdpDriver} from "../src/native-bound-udp";
import {UDP_BOUND as P,encodeUdpAddress} from "../src/udp-bound-protocol";
function fixture(){
 const output=new PassThrough(),error=new PassThrough(),frames:Buffer[]=[],acks:(()=>void)[]=[],child=new EventEmitter() as any;
 let generation=0;
 const input=new Writable({write(bytes:Buffer,_encoding,ack){frames.push(Buffer.from(bytes));generation=bytes.readUInt32LE(12);acks.push(ack);}});
 child.stdin=input;child.stdout=output;child.stderr=error;child.kill=()=>{queueMicrotask(()=>child.emit("close",1));return true;};
 const driver=new NativeBoundUdpDriver("mock",4,{spawnHelper:(()=>child) as typeof spawn,automaticReceiveCredit:false});
 const reply=(opcode:number,id:number,body:Buffer)=>{
  const b=Buffer.alloc(P.header+body.length);b.writeUInt32LE(b.length);b[4]=P.version;b[5]=opcode;b.writeUInt32LE(id,8);b.writeUInt32LE(generation,12);body.copy(b,P.header);output.write(b);
 };
 const flush=()=>{while(acks.length)acks.shift()!();};
 const ready=async()=>{
  const b=Buffer.alloc(48);encodeUdpAddress({family:4,address:"0.0.0.0",port:45000},true).copy(b);
  [P.capabilities,P.txRecords,P.bytes,P.rxRecords,P.controls,P.peers].forEach((x,i)=>b.writeUInt32LE(x,24+i*4));
  reply(P.ready,1,b);flush();await driver.ready;
  const registered=driver.registerPeer(1,1,"127.0.0.1",12345);await Promise.resolve();flush();
  const frame=frames.find(b=>b[5]===P.peer)!;const peer=Buffer.alloc(12);peer.writeUInt32LE(1);peer.writeUInt32LE(1,4);reply(P.peerReady,frame.readUInt32LE(8),peer);await registered;
 };
 const finish=async()=>{const closing=driver.close("abort").catch(()=>{});flush();child.emit("close",0);await closing;};
 return {driver,reply,frames,flush,ready,finish,child};
}
test("whole UDP packets reserve all bytes and record credit until native result",async()=>{
 const f=fixture(),outcomes:number[]=[];try{
  await f.ready();const bytes=new Uint8Array(65507);
  for(let i=0;i<4;i++)expect(f.driver.send(1,1,bytes,e=>outcomes.push(e?(e as any).code:0))).toBe(true);
  expect(f.driver.pendingWriteBytes).toBe(262028);
  expect(f.driver.send(1,1,new Uint8Array(117),e=>outcomes.push((e as any).code))).toBe(false);
  expect(f.driver.pendingWriteBytes).toBe(262028);await Promise.resolve();expect(outcomes).toEqual([10055]);
  f.flush();expect(f.driver.pendingWrites).toBe(4); // pipe consumption is not native SEND acknowledgement
 }finally{await f.finish();}
});
test("256 empty datagrams consume 256 records and callback-once survives reentrant abort",async()=>{
 const f=fixture(),outcomes:number[]=[];try{
  await f.ready();for(let i=0;i<256;i++)expect(f.driver.send(1,1,new Uint8Array(),e=>outcomes.push(e?(e as any).code:0))).toBe(true);
  expect(f.driver.pendingWrites).toBe(256);expect(f.driver.pendingWriteBytes).toBe(0);
  expect(f.driver.send(1,1,new Uint8Array(),e=>outcomes.push((e as any).code))).toBe(false);await Promise.resolve();expect(outcomes).toEqual([10055]);
  f.flush();f.child.emit("error",Error("gone"));expect(outcomes.length).toBe(257);f.child.emit("error",Error("again"));expect(outcomes.length).toBe(257);
 }finally{await f.finish();}
});
test("returned credit coalesces behind one in-flight CREDIT command",async()=>{
 const f=fixture();try{
  await f.ready();f.driver.grantReceiveCredit(0,1);f.flush();
  for(let i=0;i<255;i++)f.driver.grantReceiveCredit(0,1);
  expect(f.frames.filter(b=>b[5]===P.credit).length).toBe(1);
  const first=f.frames.find(b=>b[5]===P.credit)!,ack=Buffer.alloc(8);ack.writeUInt32LE(1,4);
  f.reply(P.creditApplied,first.readUInt32LE(8),ack);await Promise.resolve();await Promise.resolve();await Promise.resolve();f.flush();
  const commands=f.frames.filter(b=>b[5]===P.credit);expect(commands.length).toBe(2);expect(commands[1].readUInt32LE(P.header+4)).toBe(255);
 }finally{await f.finish();}
});
test("ABORT has a reserved command even when ordinary controls exhaust admission",async()=>{
 const f=fixture();try{
  await f.ready();const pending=Array.from({length:70},(_,i)=>f.driver.registerPeer(i+2,1,"127.0.0.1",13000+i).catch(e=>e));
  await Promise.resolve();await Promise.resolve();f.flush();
  const closing=f.driver.close("abort").catch(()=>{});f.flush();expect(f.frames.some(b=>b[5]===P.abort)).toBe(true);
  f.child.emit("error",Error("done"));f.child.emit("close",0);await closing.catch(()=>{});await Promise.all(pending);
 }finally{await f.finish();}
});

test("malformed accepted SEND acknowledgement still settles its callback once",async()=>{
 const f=fixture(),results:number[]=[];try{
  await f.ready();f.driver.send(1,1,Uint8Array.of(7),e=>results.push(e?(e as Error&{code:number}).code:0));f.flush();
  const frame=f.frames.find(b=>b[5]===P.send)!,body=Buffer.alloc(24);body.writeUInt32LE(1);body.writeUInt32LE(1,4);body.writeUInt32LE(10054,12);
  f.reply(P.sendResult,frame.readUInt32LE(8),body);
  expect(results).toEqual([10022]);expect(f.driver.pendingWrites).toBe(0);
 }finally{await f.finish();}
});
test("malformed cancellation acknowledgement rejects rather than orphaning its control promise",async()=>{
 const f=fixture();try{
  await f.ready();let outcome:unknown;
  const pending=f.driver.registerPeer(2,1,"127.0.0.1",12346).then(()=>{outcome="resolved";},e=>{outcome=e;});
  await Promise.resolve();f.flush();const frame=f.frames.filter(b=>b[5]===P.peer).at(-1)!;
  f.reply(P.controlCancelled,frame.readUInt32LE(8),Buffer.alloc(4));
  await Promise.resolve();await Promise.resolve();expect(outcome).toMatchObject({code:10022});
  await pending;
 }finally{await f.finish();}
});
