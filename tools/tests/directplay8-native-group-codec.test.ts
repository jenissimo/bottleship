import { expect, test } from "bun:test";
import { decodeNativeGroupRequest, encodeNativeGroupAdded, decodeNativeMemberRequest, encodeNativeMemberChanged } from "../../src/worker/modules/dpnet/native-wire/group-operations";
import { decodeNativeCoreOperation } from "../../src/worker/modules/dpnet/native-wire/core-operations";
import type { NativeNameTableEntry } from "../../src/worker/modules/dpnet/native-wire/core-connect-codec";

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex.replace(/\s/g, ""), "hex"));
// Independent literal NT5 request.cpp/message.h/ntentry.cpp layouts. SOURCE profile,
// not a packet captured from a modern provider and not produced by our encoder.
// Body-relative D2: data at24, UTF-16 "AЖ" at28. Command/token are outside that body.
const d2Hex = "d2000000 12345678 01000000 03000000 1c000000 06000000 18000000 04000000 31007fff 410016040000";
// D7 requester-relative offsets: data at56, name at60; entry starts at8.
// Stored owner7 differs from an ordinary group's CREATE_GROUP callback owner0.
const d7Hex = "d7000000 07000000 12345678 40302010 07000000 50000000 09000000 00000000 02000000 3c000000 06000000 38000000 04000000 00000000 00000000 31007fff 410016040000";
const entry = (): NativeNameTableEntry => ({
    id: 0x10203040, owner: 7, flags: 0x50, version: 9, unused: 0, coreVersion: 2,
    name: "AЖ", data: Uint8Array.of(0x31, 0, 0x7f, 0xff), url: null,
});

test("literal D2 uses a distinct request token and group-body offsets, with owned unaligned binary data", () => {
    const literal = bytes(d2Hex), storage = new Uint8Array(literal.length + 7);
    storage.set(literal, 3);
    const decoded = decodeNativeGroupRequest(storage.subarray(3, 3 + literal.length));
    storage.fill(0);
    expect(decoded).toEqual({ handle: 0x78563412, flags: 1, mask: 3, name: "AЖ", data: Uint8Array.of(0x31, 0, 0x7f, 0xff) });
});

test("literal empty D2 distinguishes NULL from a selected empty Unicode string", () => {
    const absent = bytes("d2000000 09000000 00000000 00000000 00000000 00000000 00000000 00000000");
    const empty = bytes("d2000000 0a000000 00000000 01000000 18000000 02000000 00000000 00000000 0000");
    expect(decodeNativeGroupRequest(absent)).toEqual({ handle: 9, flags: 0, mask: 0, name: null, data: new Uint8Array() });
    expect(decodeNativeGroupRequest(empty)).toEqual({ handle: 10, flags: 0, mask: 1, name: "", data: new Uint8Array() });
});

test("malformed D2 cannot turn a header, wrapped extent or unterminated string into a group", () => {
    const source = bytes(d2Hex);
    for (let n = 0; n < 32; n++) expect(decodeNativeGroupRequest(source.slice(0, n))).toBeNull();
    const changes = [
        [0, 0xd7], [8, 2], [12, 4], [12, 2], [16, 23], [16, 0xffffffff],
        [20, 0], [20, 5], [20, 0xfffffffe], [24, 0xfffffffc], [28, 0x10000],
    ] as const;
    for (const [offset, value] of changes) {
        const bad = source.slice(); new DataView(bad.buffer).setUint32(offset, value, true);
        expect(decodeNativeGroupRequest(bad)).toBeNull();
    }
    const noTerminator = source.slice(); noTerminator[noTerminator.length - 1] = 1;
    const embeddedNull = source.slice(); embeddedNull[36] = 0;
    expect(decodeNativeGroupRequest(noTerminator)).toBeNull();
    expect(decodeNativeGroupRequest(embeddedNull)).toBeNull();
});

test("D7 writer matches independent requester-relative literal including AUTO, owner, tail order and copied bytes", () => {
    const input = entry(), literal = bytes(d7Hex), encoded = encodeNativeGroupAdded(7, 0x78563412, input);
    expect(encoded).toEqual(literal);
    input.data.fill(0);
    expect(encoded).toEqual(literal);
    const decoded = decodeNativeCoreOperation(literal)!;
    literal.fill(0);
    expect(decoded).toMatchObject({
        command: 0xd7, requesting: 7, handle: 0x78563412, id: 0x10203040, version: 9,
        entry: { owner: 7, flags: 0x50, coreVersion: 2, name: "AЖ", data: Uint8Array.of(0x31, 0, 0x7f, 0xff), url: null },
    });
    const ordinary = entry(); ordinary.flags = 0x10;
    const expectedOrdinary = bytes(d7Hex); new DataView(expectedOrdinary.buffer).setUint32(20, 0x10, true);
    expect(encodeNativeGroupAdded(7, 0x78563412, ordinary)).toEqual(expectedOrdinary);
});

test("D7 encoder refuses invalid DWORD ownership, absent GROUP identity and a fabricated provider URL", () => {
    for (const bad of [{ ...entry(), owner: -1 }, { ...entry(), version: 1.5 },
        { ...entry(), flags: 0 }, { ...entry(), url: "x-directplay:/fabricated" }])
        expect(() => encodeNativeGroupAdded(7, 0x78563412, bad)).toThrow(RangeError);
});

// Independent message.h membership DWORD order: internal token is opaque and
// neither a guest callback context nor a public async-operation handle.
test("literal D3 and D4 requests use exact 16-byte framing with opaque zero or nonzero tokens",()=>{
 const d3=bytes("d3000000 12345678 40302010 88776655");
 const d4=bytes("d4000000 00000000 40302010 88776655");
 const storage=new Uint8Array(23);storage.set(d3,3);
 expect(decodeNativeMemberRequest(storage.subarray(3,19))).toEqual({handle:0x78563412,group:0x10203040,player:0x55667788,add:true});
 expect(decodeNativeMemberRequest(d4)).toEqual({handle:0,group:0x10203040,player:0x55667788,add:false});
 for(const literal of [d3,d4]){
  for(let n=0;n<16;n++)expect(decodeNativeMemberRequest(literal.slice(0,n))).toBeNull();
  const extra=new Uint8Array(20);extra.set(literal);expect(decodeNativeMemberRequest(extra)).toBeNull();
  const wrong=literal.slice();new DataView(wrong.buffer).setUint32(0,0xd5,true);expect(decodeNativeMemberRequest(wrong)).toBeNull();
 }
});
test("D9 and DA writers match independent 28-byte membership literals and reserved version",()=>{
 const d9=bytes("d9000000 40302010 88776655 0b000000 00000000 07000000 12345678");
 const da=bytes("da000000 40302010 88776655 0c000000 00000000 07000000 00000000");
 expect(encodeNativeMemberChanged(0x10203040,0x55667788,true,11,7,0x78563412)).toEqual(d9);
 expect(encodeNativeMemberChanged(0x10203040,0x55667788,false,12,7,0)).toEqual(da);
 for(const [literal,command,version,handle] of [[d9,0xd9,11,0x78563412],[da,0xda,12,0]] as const){
  const unaligned=new Uint8Array(31);unaligned.set(literal,1);
  expect(decodeNativeCoreOperation(unaligned.subarray(1,29))).toMatchObject({
   command,id:0x10203040,player:0x55667788,version,unused:0,requesting:7,handle
  });
 }
});
test("membership publication rejects non-DWORD identities, versions and completion tokens",()=>{
 for(const index of [0,1,3,4,5])for(const bad of [-1,0x100000000,1.5,NaN]){
  const args:[number,number,boolean,number,number,number]=[0x10203040,0x55667788,true,11,7,0];
  args[index]=bad;
  expect(()=>encodeNativeMemberChanged(...args)).toThrow(RangeError);
 }
});
