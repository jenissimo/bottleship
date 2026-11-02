import {expect,test} from "bun:test";
import {encodeDirectPlay4PackedPlayer,encodeDirectPlay4TcpIpPlayerData} from "../../src/worker/modules/dplayx/native-wire/packed-player";
import {encodeDirectPlay4AddForward} from "../../src/worker/modules/dplayx/native-wire/name-table";
import {encodeDirectPlay4SystemTcpFrame} from "../../src/worker/modules/dplayx/native-wire/tcp-frame";

const bytes=(s:string)=>Uint8Array.from(Buffer.from(s.replace(/\s/g,""),"hex"));
// Source-derived x86 literals, not captured packets; provider sockaddr padding is raw.
test("SPPLAYERDATA stores stream followed by datagram and owns Buffer views",()=>{
    const stream=Buffer.from("ff020008fc000000001122334455667788ff","hex").subarray(1,17);
    const datagram=Buffer.from("ff020008fd0000000099aabbccddeeff00ff","hex").subarray(1,17);
    const data=encodeDirectPlay4TcpIpPlayerData(stream,datagram);
    expect(data).toEqual(bytes("020008fc000000001122334455667788 020008fd0000000099aabbccddeeff00"));
    stream.fill(0); datagram.fill(0);
    expect(data[0]).toBe(2);expect(data[18]).toBe(8);
    expect(()=>encodeDirectPlay4TcpIpPlayerData(new Uint8Array(15),new Uint8Array(16))).toThrow(RangeError);
});

test("PackPlayer filters nonprop flags and encodes null versus empty UTF-16",()=>{
    const sp=bytes("020008fc000000001122334455667788 020008fd0000000099aabbccddeeff00");
    const data=bytes("aabbcc");
    const packed=encodeDirectPlay4PackedPlayer({
        flags:0x17009,id:0x12345678,systemPlayerId:0x12345678,version:14,parentId:0,
        shortName:"AЖ",longName:"",spData:sp,playerData:data,
    },1024);
    expect(packed).toEqual(bytes(
        "5b000000 09000000 78563412 06000000 02000000 20000000 03000000 00000000 "+
        "78563412 30000000 0e000000 00000000 410016040000 0000 "+
        "020008fc000000001122334455667788 020008fd0000000099aabbccddeeff00 aabbcc",
    ));
    sp.fill(0);data.fill(0);
    expect(packed[56]).toBe(2); expect(packed[88]).toBe(0xaa);
    const request=encodeDirectPlay4AddForward(0x12345678,packed,"",0x11223344,1024);
    expect(request.length).toBe(125);
    const view=new DataView(request.buffer);
    expect(view.getUint32(24,true)).toBe(119);
    expect(view.getUint32(121,true)).toBe(0x11223344);
    const empty=encodeDirectPlay4PackedPlayer({flags:1,id:1,systemPlayerId:1,version:14,parentId:0,
        shortName:null,longName:null,spData:new Uint8Array(),playerData:new Uint8Array()},48);
    expect(empty.length).toBe(48);
});

test("packed player and forwarded frame reproduce native cmd19 capture",()=>{
    // logs/lan-conformance/dp4-join-wire-20261028-seventh/result.json:
    // raw addresses include captured padding; no assumption about their contents.
    const provider=bytes("020012c95e13de351200000063000000 0200c0c85e13de3510000000faaddbba");
    const player=encodeDirectPlay4PackedPlayer({
        flags:9,id:0x12345678,systemPlayerId:0x12345678,version:14,parentId:0,
        shortName:null,longName:null,spData:provider,playerData:new Uint8Array(),
    },1024);
    const forward=encodeDirectPlay4AddForward(0x12345678,player,"",0,1024,14);
    const frame=encodeDirectPlay4SystemTcpFrame(bytes("020012c95e13de351200000063000000"),forward,1024);
    expect(frame).toEqual(bytes(
        "8600b0fa020012c95e13de351200000063000000706c617913000e000000000078563412"+
        "000000001c0000006c000000500000000900000078563412000000000000000020000000"+
        "000000000000000078563412300000000e00000000000000020012c95e13de351200000063000000"+
        "0200c0c85e13de3510000000faaddbba000000000000",
    ));
});
test("PackPlayer validates lengths, DWORDs, byte inputs, and bounded allocation",()=>{
    const p={flags:1,id:1,systemPlayerId:1,version:14,parentId:0,shortName:null,longName:null,
        spData:new Uint8Array(),playerData:new Uint8Array()};
    for(const max of [47,0x100000,NaN,48.5]) expect(()=>encodeDirectPlay4PackedPlayer(p,max)).toThrow(RangeError);
    expect(()=>encodeDirectPlay4PackedPlayer({...p,id:-1},48)).toThrow(RangeError);
    expect(()=>encodeDirectPlay4PackedPlayer({...p,shortName:"x\0"},1024)).toThrow(RangeError);
    expect(()=>encodeDirectPlay4PackedPlayer({...p,shortName:"x"},48)).toThrow(RangeError);
});
