import { expect, test } from "bun:test";
import { encodeDirectPlay4EnumSessionsRequest, encodeDirectPlay4EnumSessionsReply } from "../../src/worker/modules/dplayx/native-wire/discovery";

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex.replace(/\s/g, ""), "hex"));

// Independent NT5 dpmess.h/enum.c and wsock dpsp.h/dpsp.c/winsock.c layout.
// Source-derived literal profile; it is not a captured packet or interop proof.
// AF_INET, return address 192.0.2.1:2300, raw GUID 00..0f, no password, flags 0.
const literal = bytes(
    "3400b0fa 020008fc c0000201 0000000000000000 " +
    "706c6179 02000d00 000102030405060708090a0b0c0d0e0f 00000000 00000000",
);

test("legacy DirectPlay TCP/IP enum request matches an independent literal", () => {
    const guid = bytes("000102030405060708090a0b0c0d0e0f");
    const address = bytes("020008fcc00002010000000000000000");
    const result = encodeDirectPlay4EnumSessionsRequest(guid, address, 0);
    expect(result).toEqual(literal);
    guid.fill(255); address.fill(255);
    expect(result).toEqual(literal);
});

test("raw unaligned inputs retain sockaddr bytes and unsigned flags in little endian", () => {
    const guidStorage = new Uint8Array(19), addressStorage = new Uint8Array(20);
    guidStorage.set(bytes("000102030405060708090a0b0c0d0e0f"), 1);
    addressStorage.set(bytes("020008fcc00002010102030405060708"), 2);
    const actual = encodeDirectPlay4EnumSessionsRequest(guidStorage.subarray(1, 17), addressStorage.subarray(2, 18), 0xfedcba98);
    expect(actual).toEqual(bytes(
        "3400b0fa 020008fc c0000201 0102030405060708 " +
        "706c6179 02000d00 000102030405060708090a0b0c0d0e0f 00000000 98badcfe",
    ));
});

test("encoder rejects invalid input extents, address family and DWORD flags", () => {
    const guid = new Uint8Array(16), address = bytes("02000000000000000000000000000000");
    for (const length of [0, 15, 17]) expect(() => encodeDirectPlay4EnumSessionsRequest(new Uint8Array(length), address, 0)).toThrow(RangeError);
    for (const length of [0, 15, 17]) expect(() => encodeDirectPlay4EnumSessionsRequest(guid, new Uint8Array(length), 0)).toThrow(RangeError);
    const wrongFamily = address.slice(); wrongFamily[0] = 23;
    expect(() => encodeDirectPlay4EnumSessionsRequest(guid, wrongFamily, 0)).toThrow(RangeError);
    for (const flags of [-1, 0x100000000, 1.5, NaN, Infinity])
        expect(() => encodeDirectPlay4EnumSessionsRequest(guid, address, flags)).toThrow(RangeError);
});

test("normal nonsecure internal enum reply matches independent x86 literal", () => {
    // Source-derived layout; version 11 is an explicit input, not a DoReply claim.
    const instance = bytes("000102030405060708090a0b0c0d0e0f");
    const application = bytes("101112131415161718191a1b1c1d1e1f");
    const result = encodeDirectPlay4EnumSessionsReply({
        version: 11, size: 80, flags: 0x2000, instanceGuid: instance, applicationGuid: application,
        maxPlayers: 8, currentPlayers: 3, reserved: [0x01020304, 0x55667788], user: [1, 2, 3, 4],
        name: "AЖ",
    });
    const expected = bytes(
        "706c6179 01000b00 " +
        "50000000 00200000 000102030405060708090a0b0c0d0e0f " +
        "101112131415161718191a1b1c1d1e1f 08000000 03000000 " +
        "00000000 00000000 04030201 88776655 01000000 02000000 03000000 04000000 " +
        "5c000000 410016040000",
    );
    expect(result).toEqual(expected);
    instance.fill(255); application.fill(255);
    expect(result).toEqual(expected);
});

test("reply encoder input bounds do not define native receiver policy", () => {
    const valid = {
        version: 13, size: 80, flags: 0, instanceGuid: new Uint8Array(16), applicationGuid: new Uint8Array(16),
        maxPlayers: 0, currentPlayers: 0, reserved: [0, 0] as const, user: [0, 0, 0, 0] as const, name: "x",
    };
    expect(() => encodeDirectPlay4EnumSessionsReply({ ...valid, version: 0x10000 })).toThrow(RangeError);
    expect(() => encodeDirectPlay4EnumSessionsReply({ ...valid, version: -1 })).toThrow(RangeError);
    expect(() => encodeDirectPlay4EnumSessionsReply({ ...valid, size: 0x100000000 })).toThrow(RangeError);
    expect(() => encodeDirectPlay4EnumSessionsReply({ ...valid, applicationGuid: new Uint8Array(15) })).toThrow(RangeError);
    expect(() => encodeDirectPlay4EnumSessionsReply({ ...valid, name: "" })).toThrow(RangeError);
    expect(() => encodeDirectPlay4EnumSessionsReply({ ...valid, name: "a\0b" })).toThrow(RangeError);
});

