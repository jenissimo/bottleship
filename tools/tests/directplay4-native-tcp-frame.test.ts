import {expect,test} from "bun:test";
import {encodeDirectPlay4SystemTcpFrame,decodeDirectPlay4SystemTcpFrame} from "../../src/worker/modules/dplayx/native-wire/tcp-frame";

const bytes=(s:string)=>Uint8Array.from(Buffer.from(s.replace(/\s/g,""),"hex"));
// Source-derived little endian literal, not a captured native packet.
const request=bytes("2000b0fa 020008fc c0000201 0000000000000000 706c6179 05000d00 78563412");

test("normal TCP provider framing matches independent request literal",()=>{
    const address=bytes("020008fc c0000201 0000000000000000");
    const message=bytes("706c6179 05000d00 78563412");
    const result=encodeDirectPlay4SystemTcpFrame(address,message,1024);
    expect(result).toEqual(request);
    address.fill(0);message.fill(0);
    expect(result).toEqual(request);
});

test("partial reads wait and concatenated commands are consumed separately",()=>{
    for(let i=0;i<request.length;i++) expect(decodeDirectPlay4SystemTcpFrame(request.subarray(0,i),1024)).toBeNull();
    const reply=bytes("2000b0fa 020008fc c0000201 0000000000000000 706c6179 07000900 01000000");
    const both=Buffer.concat([Buffer.from(request),Buffer.from(reply)]), result=decodeDirectPlay4SystemTcpFrame(both,1024)!;
    expect(result.consumed).toBe(32); expect(result.command).toBe(5); expect(result.version).toBe(13);
    const second=decodeDirectPlay4SystemTcpFrame(both.subarray(result.consumed),1024)!;
    expect(second.command).toBe(7); expect(second.version).toBe(9); expect(second.consumed).toBe(32);
    both.fill(0);
    expect(result.providerSockaddr).toEqual(bytes("020008fc c0000201 0000000000000000"));
    expect(second.message).toEqual(bytes("706c6179 07000900 01000000"));
});

test("unaligned views retain raw fields and 16-bit command/version",()=>{
    const unaligned=Buffer.from("ff1c00b0fa02000000000000000000000000000000706c61792900feff00","hex");
    const result=decodeDirectPlay4SystemTcpFrame(unaligned.subarray(1,-1),28)!;
    expect(result.consumed).toBe(28); expect(result.command).toBe(41); expect(result.version).toBe(65534);
});

test("bounded codec rejects unsupported token, lengths and invalid signature",()=>{
    for(const max of [27,0x100000,NaN,28.5]) expect(()=>decodeDirectPlay4SystemTcpFrame(request,max)).toThrow(RangeError);
    expect(()=>decodeDirectPlay4SystemTcpFrame(request,31)).toThrow(RangeError);
    for(const token of ["0000b0fa","1b00b0fa","2000b0ba","2000b0aa","2000b0ca"]) {
        const changed=request.slice();changed.set(bytes(token));
        expect(()=>decodeDirectPlay4SystemTcpFrame(changed,1024)).toThrow(RangeError);
    }
    const invalid=request.slice();invalid[20]=0;
    expect(()=>decodeDirectPlay4SystemTcpFrame(invalid,1024)).toThrow(RangeError);
    expect(()=>encodeDirectPlay4SystemTcpFrame(new Uint8Array(15),request.subarray(20),1024)).toThrow(RangeError);
    expect(()=>encodeDirectPlay4SystemTcpFrame(request.subarray(4,20),new Uint8Array(7),1024)).toThrow(RangeError);
    expect(()=>encodeDirectPlay4SystemTcpFrame(request.subarray(4,20),invalid.subarray(20),1024)).toThrow(RangeError);
    expect(()=>encodeDirectPlay4SystemTcpFrame(request.subarray(4,20),request.subarray(20),31)).toThrow(RangeError);
});
