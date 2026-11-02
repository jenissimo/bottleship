import{afterEach,expect,test}from"bun:test";
import{NativeReliableLink}from"../../src/worker/modules/dpnet/native-wire/reliable-link";
import{DPN}from"../../src/worker/modules/dpnet/constants";
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const c of cleanup.splice(0))c();});
async function pair(){
 let a!:NativeReliableLink,b!:NativeReliableLink;let bytes=0,jobs=0;const messages:Uint8Array[]=[];
 a=new NativeReliableLink({send:p=>{b.receive(p);return true;},sendBudget:{reserve:n=>{bytes+=n;jobs++;return true;},release:n=>{bytes-=n;jobs--;}}});
 b=new NativeReliableLink({send:p=>{a.receive(p);return true;},onMessage:m=>{messages.push(m.payload.slice());}});
 cleanup.push(()=>{a.close();b.close();});void b.listen();expect(await a.connect()).toBe(0);
 return{a,b,messages,get bytes(){return bytes;},get jobs(){return jobs;}};
}
test("held native reliable reservation admits bytes before publishing and preserves delivery ordering",async()=>{
 const s=await pair(),first=s.a.reserveReliable(Uint8Array.of(1));expect(typeof first).toBe("object");if(typeof first==="number")throw Error();
 const next=s.a.sendReliable(Uint8Array.of(2));expect(s.messages).toEqual([]);expect(s.jobs).toBe(2);
 first.start();expect(await first.result).toBe(0);expect(await next).toBe(0);expect(s.messages).toEqual([Uint8Array.of(1),Uint8Array.of(2)]);expect(s.bytes).toBe(0);
});
test("native reliable reservation refusal is finite and cannot leave unaccounted held jobs",async()=>{
 const s=await pair(),held=[];for(let i=0;i<256;i++){const r=s.a.reserveReliable(Uint8Array.of(1));if(typeof r==="number")throw Error();held.push(r);}
 expect(s.a.reserveReliable(Uint8Array.of(1))).toBe(DPN.TABLEFULL);expect(s.jobs).toBe(256);
 for(const r of held){r.cancel();r.cancel();r.start();}expect(await Promise.all(held.map(r=>r.result))).toEqual(Array(256).fill(DPN.USERCANCEL));expect(s.jobs).toBe(0);expect(s.bytes).toBe(0);expect(s.messages).toEqual([]);
});
test("Close discards a held native update before start and releases its budget once",async()=>{
 const s=await pair(),r=s.a.reserveReliable(Uint8Array.of(7));if(typeof r==="number")throw Error();
 s.a.close(DPN.CONNECTIONLOST);expect(await r.result).toBe(DPN.CONNECTIONLOST);r.start();r.cancel();expect(s.jobs).toBe(0);expect(s.bytes).toBe(0);expect(s.messages).toEqual([]);
});

test("native reliable copy failure unwinds an aggregate byte/job reservation",async()=>{
 const s=await pair(),data=Uint8Array.of(8);data.slice=()=>{throw Error("copy allocation");};
 expect(s.a.reserveReliable(data)).toBe(DPN.OUTOFMEMORY);expect(s.jobs).toBe(0);expect(s.bytes).toBe(0);
 const next=s.a.reserveReliable(Uint8Array.of(9));if(typeof next==="number")throw Error();next.start();expect(await next.result).toBe(0);
});
