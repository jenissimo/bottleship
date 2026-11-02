import { expect, test } from "bun:test";
import { decodeDirectPlay4PlayerIdReply, encodeDirectPlay4RequestPlayerId } from "../../src/worker/modules/dplayx/native-wire/player-id";
import { encodeDirectPlay4SystemTcpFrame } from "../../src/worker/modules/dplayx/native-wire/tcp-frame";

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex.replace(/\s/g, ""), "hex"));

// Independent literal derived from NT5's x86 MSG_REQUESTPLAYERID, not a packet capture.
test("REQUESTPLAYERID has command 5, current version and raw little-endian flags", () => {
    expect(encodeDirectPlay4RequestPlayerId(0xfedcba98)).toEqual(bytes("706c6179 05000d00 98badcfe"));
    for (const value of [-1, 0x100000000, 1.5, NaN, Infinity])
        expect(() => encodeDirectPlay4RequestPlayerId(value)).toThrow(RangeError);
});

test("captured native REQUESTPLAYERID supplies version 14 explicitly", () => {
    // Oracle logs/lan-conformance/dp4-join-wire-20261028-sixth/result.json.
    // Sockaddr is copied verbatim; its padding is not asserted to have a policy.
    const sockaddr = bytes("020012c95e13de350000700063000000");
    const result = encodeDirectPlay4SystemTcpFrame(sockaddr, encodeDirectPlay4RequestPlayerId(9, 14), 1024);
    expect(result).toEqual(bytes("2000b0fa020012c95e13de350000700063000000706c617905000e0009000000"));
    for (const version of [-1, 65536, NaN, 1.5])
        expect(() => encodeDirectPlay4RequestPlayerId(9, version)).toThrow(RangeError);
});

// Independent full x86 structure: security descriptor has six 32-bit fields.
test("PLAYERIDREPLY preserves offsets, pointers, version, HRESULT and trailing bytes", () => {
    const literal = bytes(
        "706c6179 07000d00 78563412 " +
        "18000000 04030201 11111111 22222222 33333333 44444444 " +
        "30000000 34000000 05004080 41000000 42000000",
    );
    const unaligned = new Uint8Array(literal.length + 2);
    unaligned.set(literal, 1);
    const result = decodeDirectPlay4PlayerIdReply(unaligned.subarray(1, -1), 128);
    expect(result.version).toBe(13);
    expect(result.playerId).toBe(0x12345678);
    expect(result.securityDescription).toEqual(bytes("18000000 04030201 11111111 22222222 33333333 44444444"));
    expect(result.sspiProviderOffset).toBe(48);
    expect(result.capiProviderOffset).toBe(52);
    expect(result.result).toBe(0x80400005);
    expect(result.trailingBytes).toEqual(bytes("41000000 42000000"));
    unaligned.fill(0);
    expect(result.securityDescription[0]).toBe(24);
    expect(result.trailingBytes[0]).toBe(65);
});

test("Buffer input cannot alias returned security or trailing data", () => {
    const input = Buffer.from(
        "706c617907000d0078563412180000000403020111111111222222223333333344444444" +
        "30000000340000000500408041000000", "hex",
    );
    const reply = decodeDirectPlay4PlayerIdReply(input, 128);
    input.fill(0);
    expect(reply.securityDescription[0]).toBe(24);
    expect(reply.trailingBytes).toEqual(bytes("41000000"));
    reply.securityDescription.fill(1);
    expect(input[12]).toBe(0);
});

test("version is raw and older-version fields remain uninterpreted", () => {
    const raw = bytes(
        "706c6179 07000800 01000000 " +
        "00000000 00000000 00000000 00000000 00000000 00000000 " +
        "00000000 00000000 ffffffff",
    );
    const decoded = decodeDirectPlay4PlayerIdReply(raw, 48);
    expect(decoded.version).toBe(8);
    expect(decoded.result).toBe(0xffffffff);
});

test("bounded parser rejects short, oversized and unrelated messages", () => {
    const reply = bytes(
        "706c6179 07000d00 01000000 " +
        "00000000 00000000 00000000 00000000 00000000 00000000 " +
        "00000000 00000000 00000000",
    );
    for (let size = 0; size < 48; size++)
        expect(() => decodeDirectPlay4PlayerIdReply(reply.subarray(0, size), 48)).toThrow(RangeError);
    for (const limit of [47, 0x100000, 48.5, NaN])
        expect(() => decodeDirectPlay4PlayerIdReply(reply, limit)).toThrow(RangeError);
    expect(() => decodeDirectPlay4PlayerIdReply(new Uint8Array(49), 48)).toThrow(RangeError);
    const wrongSignature = reply.slice(); wrongSignature[0] = 0;
    const wrongCommand = reply.slice(); wrongCommand[4] = 5;
    expect(() => decodeDirectPlay4PlayerIdReply(wrongSignature, 48)).toThrow(RangeError);
    expect(() => decodeDirectPlay4PlayerIdReply(wrongCommand, 48)).toThrow(RangeError);
});
