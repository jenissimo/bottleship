import {expect,test} from "bun:test";
import {decodeDirectPlay4SystemTcpFrame} from "../../src/worker/modules/dplayx/native-wire/tcp-frame";
import {decodeDirectPlay4NameTable} from "../../src/worker/modules/dplayx/native-wire/name-table";

const bytes=(s:string)=>Uint8Array.from(Buffer.from(s.replace(/\s/g,""),"hex"));

// Synthetic cmd41 accepted by native Open JOIN in oracle result
// logs/lan-conformance/dp4-join-wire-20261028-eighth/result.json (e818720c2d7454ae).
// This is a generated reply to a native client, not a native host capture.
const frame=bytes(
    "bd00b0fa0200dcd47f0000010000000000000000706c617929000e000100000000000000"+
    "7400000000000000240000000000000000000000500000000000000020575bd8d9a008b8"+
    "36efc38cc20c31af1469062f1973e14aa3928047312f9ad1080000000100000000000000"+
    "000000000000000000000000000000000000000000000000000000001000000003000000"+
    "89674523040000000e000000200200dcd47f00000100000000000000000200ba087f0000"+
    "010000000000000000",
);
test("source decoder accepts synthetic name table verified by native Open JOIN",()=>{
    const outer=decodeDirectPlay4SystemTcpFrame(frame,1024)!;
    expect(outer.consumed).toBe(189);
    expect(outer.command).toBe(41);expect(outer.version).toBe(14);
    const table=decodeDirectPlay4NameTable(outer.message,1024,8);
    expect(table.command).toBe(41);expect(table.version).toBe(14);
    expect(table.sessionDescription.length).toBe(80);
    expect(table.players).toHaveLength(1);expect(table.groups).toHaveLength(0);
    expect(table.shortcuts).toHaveLength(0);
    expect(table.players[0].id).toBe(0x23456789);
    expect(table.players[0].flags).toBe(3);
    expect(table.players[0].version).toBe(14);
    expect(table.players[0].spData).toEqual(bytes(
        "0200dcd47f0000010000000000000000 0200ba087f0000010000000000000000"));
});
