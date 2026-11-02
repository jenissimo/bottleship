import {expect,test} from "bun:test";
import {decodeDirectPlay4PlayerWrapper,encodeDirectPlay4PlayerWrapper} from "../../src/worker/modules/dplayx/native-wire/player-wrapper";

const literal=Buffer.from("2600b0fa020008fcc00002010000000000000000706c617919000e00706c6179785634120102","hex");

test("source-derived wrapper preserves an ID colliding with the system signature",()=>{
    const address=Buffer.from("020008fcc00002010000000000000000","hex"),data=Buffer.from([1,2]);
    const wire=encodeDirectPlay4PlayerWrapper(address,0x79616c70,0x12345678,data,14,38);
    expect(wire).toEqual(Uint8Array.from(literal));
    const decoded=decodeDirectPlay4PlayerWrapper(Buffer.from(wire),38)!;
    expect(decoded.from).toBe(0x79616c70);expect(decoded.to).toBe(0x12345678);
    expect(decoded.version).toBe(14);expect(decoded.data).toEqual(Uint8Array.of(1,2));
    address.fill(0);data.fill(0);wire.fill(0);
    expect(decoded.providerSockaddr).toEqual(Uint8Array.from(Buffer.from("020008fcc00002010000000000000000","hex")));
    expect(decoded.data).toEqual(Uint8Array.of(1,2));
});

test("supports fragmentation and rejects truncated or non-wrapper messages",()=>{
    for(let i=0;i<literal.length;i++)expect(decodeDirectPlay4PlayerWrapper(literal.subarray(0,i),38)).toBeNull();
    const other=Buffer.from(literal);other.writeUInt16LE(5,24);
    expect(()=>decodeDirectPlay4PlayerWrapper(other,38)).toThrow(RangeError);
    const short=Buffer.from(literal.subarray(0,32));short.writeUInt32LE(0xfab00020,0);
    expect(()=>decodeDirectPlay4PlayerWrapper(short,38)).toThrow(RangeError);
    expect(()=>encodeDirectPlay4PlayerWrapper(literal.subarray(4,20),1,2,Uint8Array.of(1,2),14,37)).toThrow(RangeError);
    expect(()=>encodeDirectPlay4PlayerWrapper(literal.subarray(4,20),1,2,Uint8Array.of(),65536,38)).toThrow(RangeError);
});
