import {expect,test} from "bun:test";
import {spawn} from "node:child_process";
import {createSocket} from "node:dgram";
import {buildBoundUdpHelper} from "../lan-conformance/build-bound-udp-helper";
import {UDP_BOUND as P,encodeUdpFrame,encodeUdpAddress,decodeUdpAddress} from "../../packages/lan/src/udp-bound-protocol";
const until=async(check:()=>boolean|Promise<boolean>,label:string)=>{const end=Date.now()+5000;while(!await check()){if(Date.now()>end)throw Error("Timeout: "+label);await new Promise(r=>setTimeout(r,2));}};
async function free(port:number):Promise<boolean>{
 const s=createSocket("udp4");return new Promise(ok=>{s.once("error",()=>{s.close();ok(false);});s.bind(port,"0.0.0.0",()=>s.close(()=>ok(true)));});
}
test.skipIf(process.platform!=="win32")("UDP helper bounds a failed reader cancellation without destroying live-thread synchronization",async()=>{
 // Compile-only fault injection leaves the helper's own stdin reader blocked.
 // No other process or OS thread is inspected, suspended or changed.
 const executable=await buildBoundUdpHelper(["-DUDP_TEST_SKIP_READER_CANCEL"]),child=spawn(executable,[],{stdio:["pipe","pipe","pipe"],windowsHide:true});
 let input:Buffer=Buffer.alloc(0),stderr="",exit:{code:number|null;signal:string|null}|undefined;
 const events=new Map<number,Buffer>(),failure:Error[]=[];
 child.stderr.on("data",b=>{stderr=(stderr+b.toString()).slice(-4096);});child.once("error",e=>failure.push(e));
 child.stdout.on("data",(bytes:Buffer)=>{
  input=Buffer.concat([input,bytes]);
  while(input.length>=P.header){
   const length=input.readUInt32LE();if(length<P.header||length>P.maxFrame){failure.push(Error("bad frame"));return;}
   if(input.length<length)return;
   const frame=input.subarray(0,length);input=input.subarray(length);
   if(frame[4]!==1||frame.readUInt32LE(12)!==17){failure.push(Error("bad generation"));return;}
   events.set(frame[5],Buffer.from(frame.subarray(P.header)));
  }
 });
 child.once("close",(code,signal)=>{exit={code,signal};});
 const awaitEvent=async(op:number)=>{await until(()=>{if(failure.length)throw failure[0];if(exit&&!events.has(op))throw Error("helper exited before event "+op);return events.has(op);},"helper event "+op);return events.get(op)!;};
 try{
  child.stdin.write(encodeUdpFrame(P.bind,1,17,encodeUdpAddress({family:4,address:"0.0.0.0",port:0},true)));
  const ready=await awaitEvent(P.ready),address=decodeUdpAddress(ready.subarray(0,24));expect(await free(address.port)).toBe(false);
  child.stdin.write(encodeUdpFrame(P.close,2,17)); // Keep stdin open throughout exit.
  const closed=await awaitEvent(P.closed);expect(closed.length).toBe(88);expect(closed.readUInt32LE(84)).toBe(0);
  await until(()=>free(address.port),"native socket released before parent closes stdin");
  await until(()=>exit!==undefined,"bounded process exit with blocked reader");
  expect(exit).toEqual({code:0,signal:null});expect(stderr).toContain("reader did not quiesce");
 }finally{
  child.stdin.destroy();if(exit===undefined)child.kill();
  await until(()=>exit!==undefined,"owned helper cleanup");
 }
},15000);
