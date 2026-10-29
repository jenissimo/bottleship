import { expect, test } from "bun:test";
import { decodeDirectPlay4TcpEnumReply } from "../../src/worker/modules/dplayx/native-wire/discovery";

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex.replace(/\s/g, ""), "hex"));
// Source-derived literal, not a native capture.
const tcpReply = bytes(
    "7600b0fa 020008fc c0000201 0000000000000000 " +
    "706c6179 01000b00 50000000 00200000 000102030405060708090a0b0c0d0e0f " +
    "101112131415161718191a1b1c1d1e1f 08000000 03000000 " +
    "00000000 00000000 04030201 88776655 01000000 02000000 03000000 04000000 " +
    "5c000000 410016040000",
);

test("bounded TCP reply decoder reads the independent literal and copies raw fields", () => {
    const storage = new Uint8Array(tcpReply.length + 3);
    storage.set(tcpReply, 1);
    const packet = storage.subarray(1, tcpReply.length + 1);
    const reply = decodeDirectPlay4TcpEnumReply(packet, 1024);
    expect(reply).toEqual({
        consumed: 118, providerSockaddr: bytes("020008fcc00002010000000000000000"),
        version: 11, size: 80, flags: 0x2000,
        instanceGuid: bytes("000102030405060708090a0b0c0d0e0f"),
        applicationGuid: bytes("101112131415161718191a1b1c1d1e1f"),
        maxPlayers: 8, currentPlayers: 3, sessionNamePointer: 0, passwordPointer: 0,
        reserved: [0x01020304, 0x55667788], user: [1, 2, 3, 4], name: "AЖ",
    });
    packet.fill(0);
    expect(reply?.instanceGuid[1]).toBe(1);
    expect(reply?.providerSockaddr[0]).toBe(2);
});

test("Buffer input cannot alias the returned address or GUIDs", () => {
    const packet = Buffer.from(tcpReply);
    const reply = decodeDirectPlay4TcpEnumReply(packet, 1024)!;
    packet.fill(0);
    expect(reply.providerSockaddr).toEqual(bytes("020008fcc00002010000000000000000"));
    expect(reply.instanceGuid).toEqual(bytes("000102030405060708090a0b0c0d0e0f"));
    expect(reply.applicationGuid).toEqual(bytes("101112131415161718191a1b1c1d1e1f"));
    reply.instanceGuid.fill(255);
    expect(packet[37]).toBe(0);
});

test("partial input waits, and concatenated input consumes only one frame", () => {
    for (let length = 0; length < tcpReply.length; length++)
        expect(decodeDirectPlay4TcpEnumReply(tcpReply.subarray(0, length), 1024)).toBeNull();
    const both = new Uint8Array(tcpReply.length * 2);
    both.set(tcpReply); both.set(tcpReply, tcpReply.length);
    expect(decodeDirectPlay4TcpEnumReply(both, 1024)?.consumed).toBe(tcpReply.length);
    expect(decodeDirectPlay4TcpEnumReply(both.subarray(tcpReply.length), 1024)?.name).toBe("AЖ");
});

test("decoder bounds reject malformed headers, lengths and names without native policy claims", () => {
    const changed = (offset: number, value: number) => {
        const packet = tcpReply.slice();
        new DataView(packet.buffer).setUint32(offset, value, true);
        return packet;
    };
    expect(() => decodeDirectPlay4TcpEnumReply(tcpReply, 117)).toThrow(RangeError);
    expect(() => decodeDirectPlay4TcpEnumReply(tcpReply, 0x100000)).toThrow(RangeError);
    for (const packet of [
        changed(0, 0xbab00076), changed(0, 0xfab0006f),
        changed(20, 0), changed(24, 0x000b0002),
        changed(108, 90), changed(108, 93), changed(108, 98),
    ]) expect(() => decodeDirectPlay4TcpEnumReply(packet, 1024)).toThrow(RangeError);
    const unterminated = tcpReply.slice(); unterminated[116] = 1;
    expect(() => decodeDirectPlay4TcpEnumReply(unterminated, 1024)).toThrow(RangeError);
    const absent = changed(108, 0);
    expect(decodeDirectPlay4TcpEnumReply(absent, 1024)?.name).toBeNull();
});
