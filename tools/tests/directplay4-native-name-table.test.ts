import {expect,test} from "bun:test";
import {decodeDirectPlay4NameTable,encodeDirectPlay4AddForward} from "../../src/worker/modules/dplayx/native-wire/name-table";

const bytes=(hex:string)=>Uint8Array.from(Buffer.from(hex.replace(/\s/g,""),"hex"));
const desc="50000000"+"00".repeat(76);
// Literals derive from NT5 x86 layouts; they are not captured native packets.
const packedPlayer=bytes(
    "30000000 01000000 78563412 00000000 00000000 00000000 " +
    "00000000 00000000 78563412 30000000 0d000000 00000000",
);
test("ADDFORWARD uses inner offsets, empty password and unaligned tickcount",()=>{
    const actual=encodeDirectPlay4AddForward(0x12345678,packedPlayer,"",0xa1b2c3d4,1024);
    expect(actual).toEqual(bytes(
        "706c6179 13000d00 00000000 78563412 00000000 1c000000 4c000000 " +
        "30000000 01000000 78563412 00000000 00000000 00000000 " +
        "00000000 00000000 78563412 30000000 0d000000 00000000 " +
        "0000 d4c3b2a1",
    ));
    expect(()=>encodeDirectPlay4AddForward(2,packedPlayer,"",0,1024)).toThrow();
    expect(()=>encodeDirectPlay4AddForward(0x12345678,packedPlayer,"x\0",0,1024)).toThrow();
    expect(()=>encodeDirectPlay4AddForward(0x12345678,packedPlayer,"",0,81)).toThrow();
});
const ordinary=bytes(
    "706c6179 03000d00 01000000 01000000 74000000 ffffffff 24000000 00000000 00000000 "+
    desc+
    "30000000 01000000 01000000 00000000 00000000 00000000 00000000 00000000 01000000 30000000 0d000000 00000000 "+
    "34000000 00000000 02000000 00000000 00000000 00000000 00000000 01000000 01000000 30000000 0d000000 00000000 01000000",
);
test("ordinary name table decodes player, group and membership, ignores ordinary shortcut DWORD",()=>{
    const result=decodeDirectPlay4NameTable(ordinary,1024,10);
    expect(result.command).toBe(3); expect(result.players[0].id).toBe(1);
    expect(result.players[0].version).toBe(13);
    expect(result.groups[0].id).toBe(2); expect(result.groups[0].memberIds).toEqual([1]);
    expect(result.shortcuts).toEqual([]);
});
const superReply=bytes(
    "706c6179 29000d00 01000000 01000000 74000000 01000000 24000000 00000000 00000000 "+
    desc+
    "10000000 01000000 01000000 19000000 0d000000 41000000 01aa 0300 010203 "+
    "10000000 00000000 02000000 40010000 01000000 63000000 02 01000000 03000000 "+
    "10000000 00000000 02000000 00020000 01 04000000",
);
test("super name table handles unaligned names, mixed data widths, members, parent and shortcuts",()=>{
    const buffer=Buffer.alloc(superReply.length+1); Buffer.from(superReply).copy(buffer,1);
    const result=decodeDirectPlay4NameTable(buffer.subarray(1),1024,10);
    expect(result.command).toBe(41); expect(result.players[0].version).toBe(13);
    expect(result.players[0].shortName).toEqual(bytes("41000000"));
    expect(result.players[0].playerData).toEqual(bytes("aa"));
    expect(result.players[0].spData).toEqual(bytes("010203"));
    expect(result.groups[0].parentId).toBe(99);
    expect(result.groups[0].memberIds).toEqual([1,3]);
    expect(result.shortcuts[0]).toEqual({flags:0,id:2,groupIds:[4]});
    buffer.fill(0);
    expect(result.sessionDescription[0]).toBe(80);
    expect(result.players[0].shortName).toEqual(bytes("41000000"));
});
test("shortcut ignores unrelated mask bits but uses bits 9 and 10 as count width",()=>{
    for (const mask of ["01020000", "01020080"]) {
        const reply=bytes(
            "706c6179 29000d00 00000000 00000000 74000000 01000000 24000000 00000000 00000000 "+
            desc+
            "10000000 00000000 02000000 "+mask+" 01 04000000",
        );
        expect(decodeDirectPlay4NameTable(reply,1024,10).shortcuts[0]).toEqual({flags:0,id:2,groupIds:[4]});
    }
    // Width bits are not ignored: 0x601 specifies a DWORD count, which is truncated.
    const wrongWidth=bytes(
        "706c6179 29000d00 00000000 00000000 74000000 01000000 24000000 00000000 00000000 "+
        desc+"10000000 00000000 02000000 01060080 01",
    );
    expect(()=>decodeDirectPlay4NameTable(wrongWidth,1024,10)).toThrow(RangeError);
});
test("superpacked DWORD length uses little endian at an unaligned position",()=>{
    const reply=bytes(
        "706c6179 29000d00 01000000 00000000 74000000 00000000 24000000 00000000 00000000 "+
        desc+
        "10000000 01000000 01000000 30000000 0d000000 03000000 aabbcc",
    );
    const result=decodeDirectPlay4NameTable(reply,1024,10);
    expect(result.players[0].playerData).toEqual(bytes("aabbcc"));
});
test("truncated structures, oversized record counts and invalid offsets fail within bounds",()=>{
    for(const reply of [ordinary,superReply]) {
        for(let n=0;n<reply.length;n++)
            expect(()=>decodeDirectPlay4NameTable(reply.subarray(0,n),1024,10)).toThrow(RangeError);
    }
    expect(()=>decodeDirectPlay4NameTable(superReply,1024,2)).toThrow();
    expect(()=>decodeDirectPlay4NameTable(superReply,100,10)).toThrow();
    const corrupted=superReply.slice(); new DataView(corrupted.buffer).setUint32(16,0xffffffff,true);
    expect(()=>decodeDirectPlay4NameTable(corrupted,1024,10)).toThrow();
});
