import{expect,test}from"bun:test";
import fixture from"./fixtures/directplay8-native-info.json";
import{decodeNativeInfoRequest,encodeNativeInfoUpdate}from"../../src/worker/modules/dpnet/native-wire/info-operations";
import{decodeNativeCoreOperation}from"../../src/worker/modules/dpnet/native-wire/core-operations";
const bytes=(s:string)=>Uint8Array.from(Buffer.from(s,"hex"));
test("captured authoritative DB fields re-encode byte for byte, including NULL name/data and both-mask tail order",()=>{
 const updates=fixture.messages.filter(m=>m.command===0xdb);expect(updates).toHaveLength(5);
 for(const entry of updates){const source=bytes(entry.payload),op=decodeNativeCoreOperation(source)!;
  expect(encodeNativeInfoUpdate({id:op.id,version:op.version,handle:op.handle!,requesting:op.requesting!,mask:op.mask!,name:op.name!,data:op.data!})).toEqual(source);
 }
});
test("captured D6 requests use independent correlation handles and body-relative extents",()=>{
 const requests=fixture.messages.filter(m=>m.command===0xd6).map(m=>decodeNativeInfoRequest(bytes(m.payload))!);
 expect(requests).toMatchObject([{handle:2,mask:2,name:null,data:Uint8Array.of(0x31,0,0x50,1)},{handle:3,mask:2,name:null,data:new Uint8Array()}]);
 expect(requests[0].id).toBe(requests[1].id);
});
test("short, cross-command and malformed native info extents cannot mutate authority",()=>{
 const packet=bytes(fixture.messages.find(m=>m.command===0xd6)!.payload);
 for(let n=0;n<32;n++)expect(decodeNativeInfoRequest(packet.slice(0,n))).toBeNull();
 for(const [offset,value]of[[0,0xdb],[8,0],[12,4],[24,0xffffffff],[28,0x10000]]as const){const bad=packet.slice();new DataView(bad.buffer).setUint32(offset,value,true);expect(decodeNativeInfoRequest(bad)).toBeNull();}
});
