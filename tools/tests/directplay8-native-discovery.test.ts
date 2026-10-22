import { expect, test } from "bun:test";
import { decodeNativeEnumQuery, decodeNativeEnumResponse, encodeNativeEnumQuery, encodeNativeEnumResponse, NATIVE_DP8_MAX_DATAGRAM } from "../../src/worker/modules/dpnet/native-wire/discovery-codec";
// Captured from native Windows, capture-directplay8.ts nonce 1625355007.
// The native client accepted the host's binary response and verified all metadata.
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, value => parseInt(value, 16));
const query = bytes("000291b101fff2e060184aa14e90518243b9c13862");
const wildcard = bytes("0002a19602");
const queryData = bytes("000231bf01fff2e060184aa14e90518243b9c13862030507");
const response = bytes("000391b16700000003000000500000000000000007000000010000005b0000000c000000000000000000000000000000000000005800000003000000f37a1277fe32fa459c97c2e968cb5bb7fff2e060184aa14e90518243b9c13862030507570069007200650016040000aa00bb");
test("native filtered, wildcard and user-data enum queries round trip byte for byte", () => {
    for (const packet of [query, wildcard, queryData]) {
        const parsed = decodeNativeEnumQuery(packet)!; expect(parsed).not.toBeNull(); expect(encodeNativeEnumQuery(parsed)).toEqual(packet);
    }
    expect(decodeNativeEnumQuery(query)!.application).toBe("fff2e060184aa14e90518243b9c13862");
    expect(decodeNativeEnumQuery(wildcard)!.application).toBeNull();
    expect([...decodeNativeEnumQuery(queryData)!.data]).toEqual([3, 5, 7]);
});
test("native host response preserves unaligned UTF16, GUIDs, counts and binary payloads exactly", () => {
    const parsed = decodeNativeEnumResponse(response)!;
    expect(parsed).toMatchObject({ token: 0xb191, flags: 0, maxPlayers: 7, players: 1, name: "WireЖ", password: null,
        instance: "f37a1277fe32fa459c97c2e968cb5bb7", application: "fff2e060184aa14e90518243b9c13862" });
    expect([...parsed.applicationData]).toEqual([3, 5, 7]); expect([...parsed.data]).toEqual([0xaa, 0, 0xbb]); expect(parsed.reserved.length).toBe(0);
    expect(new DataView(response.buffer).getUint32(28, true)).toBe(91);
    expect(encodeNativeEnumResponse(parsed)).toEqual(response);
});
test("decoded binary data owns its storage and accepts a nonzero input byte offset", () => {
    const framed = new Uint8Array(response.length + 9); framed.set(response, 3);
    const parsed = decodeNativeEnumResponse(framed.subarray(3, 3 + response.length))!;
    framed.fill(0); expect(parsed.name).toBe("WireЖ"); expect([...parsed.data]).toEqual([0xaa, 0, 0xbb]); expect([...parsed.applicationData]).toEqual([3, 5, 7]);
    const input = queryData.slice(), decoded = decodeNativeEnumQuery(input)!; input.fill(0); expect([...decoded.data]).toEqual([3, 5, 7]);
});
test("truncated datagrams, unknown provider kinds and invalid offset extents fail without throwing", () => {
    for (let length = 0; length < response.length; length++) expect(decodeNativeEnumResponse(response.subarray(0, length))).toBeNull();
    for (let length = 0; length < query.length; length++) expect(decodeNativeEnumQuery(query.subarray(0, length))).toBeNull();
    for (const index of [0, 1, 4]) { const bad = query.slice(); bad[index] = 0xff; expect(decodeNativeEnumQuery(bad)).toBeNull(); }
    for (const [offset, value] of [[4, 0xfffffff0], [8, 0x80000000], [28, 8], [32, 13], [52, 0xfffffff0], [56, 0x80000000]]) {
        const bad = response.slice(); new DataView(bad.buffer).setUint32(offset, value, true); expect(decodeNativeEnumResponse(bad)).toBeNull();
    }
});
test("UTF16 parsing permits odd field alignment and rejects odd lengths or missing terminators", () => {
    const oddLength = response.slice(); new DataView(oddLength.buffer).setUint32(32, 11, true); expect(decodeNativeEnumResponse(oddLength)).toBeNull();
    const missingNul = response.slice(); missingNul[106] = 1; expect(decodeNativeEnumResponse(missingNul)).toBeNull();
    const sizeIsNotAnExtent = response.slice(); new DataView(sizeIsNotAnExtent.buffer).setUint32(12, 0xffffffff, true);
    expect(decodeNativeEnumResponse(sizeIsNotAnExtent)!.name).toBe("WireЖ");
});
test("absent and allocated-empty strings differ; zero bytes and maximum UDP query payload survive", () => {
    const parsed = decodeNativeEnumResponse(response)!; parsed.name = ""; parsed.applicationData = new Uint8Array(); parsed.data = new Uint8Array();
    const roundtrip = decodeNativeEnumResponse(encodeNativeEnumResponse(parsed))!; expect(roundtrip.name).toBe(""); expect(roundtrip.data.length).toBe(0);
    parsed.name = null; expect(decodeNativeEnumResponse(encodeNativeEnumResponse(parsed))!.name).toBeNull();
    const data = new Uint8Array(NATIVE_DP8_MAX_DATAGRAM - 5); data[data.length - 1] = 17;
    const max = encodeNativeEnumQuery({ token: 0xffff, application: null, data }); expect(max.length).toBe(NATIVE_DP8_MAX_DATAGRAM);
    expect(decodeNativeEnumQuery(max)!.data.at(-1)).toBe(17);
    expect(() => encodeNativeEnumQuery({ token: 1, application: null, data: new Uint8Array(data.length + 1) })).toThrow(RangeError);
    expect(() => encodeNativeEnumQuery({ token: -1, application: null, data: new Uint8Array() })).toThrow(RangeError);
    expect(() => encodeNativeEnumResponse({ ...parsed, name: "x".repeat(65507) })).toThrow(RangeError);
});
