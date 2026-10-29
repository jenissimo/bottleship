import {expect, test} from "bun:test";
import {DirectPlay4SystemTcpStream} from "../../src/worker/modules/dplayx/native-wire/tcp-stream";

const request=Buffer.from("2000b0fa020012c95e13de350000700063000000706c617905000e0009000000","hex");
const reply=Buffer.from("2000b0fa020008fcc00002010000000000000000706c617907000e0001000000","hex");

test("reads captured native request at every split and owns returned bytes",()=>{
    for(let split=0;split<=request.length;split++){
        const stream=new DirectPlay4SystemTcpStream(128,4,128), input=Buffer.from(request);
        const frames=[...stream.push(input.subarray(0,split)),...stream.push(input.subarray(split))];
        expect(frames).toHaveLength(1);
        expect(frames[0].command).toBe(5);
        expect(frames[0].version).toBe(14);
        input.fill(0);
        expect(Buffer.from(frames[0].message).toString("hex")).toBe("706c617905000e0009000000");
        stream.finish();
    }
});

test("handles many byte-wise fragments and concatenated frames in order",()=>{
    const stream=new DirectPlay4SystemTcpStream(128,4,128);
    const input=Buffer.concat([request,reply,request]);
    const frames=[];
    for(const byte of input) frames.push(...stream.push(Uint8Array.of(byte)));
    expect(frames.map(f=>f.command)).toEqual([5,7,5]);
    stream.finish();
    const batch=new DirectPlay4SystemTcpStream(128,3,128);
    expect(batch.push(input).map(f=>f.command)).toEqual([5,7,5]);
    batch.finish();
});

test("rejects truncation, malformed frames and overfull batches terminally",()=>{
    for(const length of [1,3,4,20,31]){
        const stream=new DirectPlay4SystemTcpStream(128,2,128);
        stream.push(request.subarray(0,length));
        expect(()=>stream.finish()).toThrow(RangeError);
        expect(()=>stream.push(request)).toThrow();
    }
    for(const hex of ["1b00b0fa","8100b0fa","2000b0ba"]){
        const stream=new DirectPlay4SystemTcpStream(128,2,128);
        expect(()=>stream.push(Buffer.from(hex,"hex"))).toThrow(RangeError);
        expect(()=>stream.push(request)).toThrow();
    }
    const invalid=Buffer.from(request);invalid[20]=0;
    const stream=new DirectPlay4SystemTcpStream(128,1,128);
    expect(()=>stream.push(invalid)).toThrow(RangeError);
    expect(()=>stream.finish()).toThrow();
    const batch=new DirectPlay4SystemTcpStream(128,1,128);
    expect(()=>batch.push(Buffer.concat([request,reply]))).toThrow(RangeError);
    expect(()=>batch.push(request)).toThrow();
    const bytes=new DirectPlay4SystemTcpStream(32,4,32);
    expect(()=>bytes.push(Buffer.concat([request,reply]))).toThrow(RangeError);
    expect(()=>bytes.push(request)).toThrow();
    const badType=new DirectPlay4SystemTcpStream(128,2,128);
    badType.push(request.subarray(0,3));
    expect(()=>badType.push(null as unknown as Uint8Array)).toThrow(TypeError);
    expect(()=>badType.push(request)).toThrow();
    const mixed=new DirectPlay4SystemTcpStream(128,2,128);
    expect(()=>mixed.push(Buffer.concat([request,invalid]))).toThrow(RangeError);
    expect(()=>mixed.push(request)).toThrow();
    const partial=new DirectPlay4SystemTcpStream(128,2,128);
    expect(partial.push(Buffer.concat([request,reply.subarray(0,3)]))).toHaveLength(1);
    expect(()=>partial.finish()).toThrow(RangeError);
});

test("validates limits and EOF at a frame boundary",()=>{
    for(const size of [27,0x100000,NaN]) expect(()=>new DirectPlay4SystemTcpStream(size,1,128)).toThrow();
    for(const count of [0,4097,1.5]) expect(()=>new DirectPlay4SystemTcpStream(128,count,128)).toThrow();
    expect(()=>new DirectPlay4SystemTcpStream(128,1,127)).toThrow();
    expect(()=>new DirectPlay4SystemTcpStream(128,1,0x1000001)).toThrow();
    const stream=new DirectPlay4SystemTcpStream(32,1,32);
    expect(stream.push(request)).toHaveLength(1);
    stream.finish();
    expect(()=>stream.finish()).toThrow();
    const maxFrame=Buffer.alloc(128);request.copy(maxFrame);maxFrame.writeUInt32LE(0xfab00080,0);
    const large=new DirectPlay4SystemTcpStream(128,1,128);
    expect(large.push(maxFrame.subarray(0,127))).toHaveLength(0);
    const decoded=large.push(maxFrame.subarray(127));
    expect(decoded).toHaveLength(1);expect(decoded[0].message.length).toBe(108);
    large.finish();
});
