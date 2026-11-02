import { expect, test } from "bun:test";
import { decodeNativePlayerConnect, encodeNativePlayerConnect, decodeNativeCoreConnectInfo, NATIVE_CORE_MAX_MESSAGE } from "../../src/worker/modules/dpnet/native-wire/core-connect-codec";
const b = (hex: string) => Uint8Array.from(hex.match(/../g)!, n => parseInt(n, 16));
// Native Windows nonce 1626410397 fixed structures. Unstable native URLs/NAT
// addresses are replaced by a documentation address, retaining the wire layouts.
const player = b("c100000004000000070000000000000000000000000000000000000000000000000000000000000000000000580000005f000000000000000000000000000000000000009d0df160184aa14e90518243b9c138620000000000000000782d646972656374706c61793a2f70726f76696465723d25374245424645374241302d363238442d313144322d414530462d3030363039374230313431312537443b686f73746e616d653d3139322e302e322e313b706f72743d3233303200");
const connect = b("c2000000000000000000000050000000000000000700000002000000cf0000000c00000000000000000000000000000000000000cc0000000300000006a96550ee03474c848718d8b50ea3f19d0df160184aa14e90518243b9c1386205a955500300000000000000020000000000000004a94550000000000201000002000000000000000700000000000000000000000000000000000000000000000000000005a955500000000000010000030000000000000007000000000000000000000000000000000000000000000000000000030507570069007200650016040000");
test("native C1 fixed layout decodes and encodes with modern alternate-address fields and ANSI URL", () => {
    const parsed = decodeNativePlayerConnect(player)!;
    expect(parsed).toMatchObject({ flags: 4, version: 7, instance: "0".repeat(32), application: "9d0df160184aa14e90518243b9c13862", name: null, password: null });
    expect(parsed.url).toContain("hostname=192.0.2.1;port=2302"); expect(parsed.alternate.length).toBe(0); expect(encodeNativePlayerConnect(parsed)).toEqual(player);
});
test("native C2 application metadata and name-table identities use offsets relative to the core body", () => {
    const parsed = decodeNativeCoreConnectInfo(connect)!; expect(parsed).not.toBeNull();
    expect(parsed.application).toMatchObject({ name: "WireЖ", flags: 0, maxPlayers: 7, players: 2, application: "9d0df160184aa14e90518243b9c13862" });
    expect([...parsed.application.applicationData]).toEqual([3, 5, 7]); expect(parsed.entries.length).toBe(2);
    expect(parsed.localId).toBe(1347791109); expect(parsed.entries.map(e => e.id)).toEqual([1346742532, 1347791109]);
    expect(parsed.entries[0].flags & 2).toBeTruthy(); expect(parsed.entries[1].id).toBe(parsed.localId); expect(parsed.members).toEqual([]);
});
test("NT5 version 2 C1 omits modern fields while preserving Unicode, binary connection data and absent address", () => {
    const parsed = decodeNativePlayerConnect(player)!;
    const value = { ...parsed, version: 2, name: "Клиент", url: null, data: Uint8Array.of(1, 0), connectData: Uint8Array.of(3, 5, 7) };
    const encoded = encodeNativePlayerConnect(value); expect(decodeNativePlayerConnect(encoded)).toEqual(value);
    expect(new DataView(encoded.buffer).getUint32(44, true)).toBe(0); expect(encoded.length).toBe(84 + 14 + 2 + 3);
});
test("core connect parsers reject truncation, integer extents, duplicate players and malformed strings", () => {
    for (let size = 0; size < player.length; size++) expect(decodeNativePlayerConnect(player.subarray(0, size))).toBeNull();
    for (let size = 0; size < connect.length; size++) expect(decodeNativeCoreConnectInfo(connect.subarray(0, size))).toBeNull();
    for (const [offset, value] of [[104, 0xffffffff], [108, 65537], [28, 2], [32, 11], [52, 0xfffffff0]]) {
        const bad = connect.slice(); new DataView(bad.buffer).setUint32(offset, value, true); expect(decodeNativeCoreConnectInfo(bad)).toBeNull();
    }
    const duplicate = connect.slice(); new DataView(duplicate.buffer).setUint32(160, new DataView(duplicate.buffer).getUint32(112, true), true); expect(decodeNativeCoreConnectInfo(duplicate)).toBeNull();
    const unterminated = player.slice(); unterminated[unterminated.length - 1] = 1; expect(decodeNativePlayerConnect(unterminated)).toBeNull();
    expect(decodeNativeCoreConnectInfo(new Uint8Array(NATIVE_CORE_MAX_MESSAGE + 1))).toBeNull();
});
test("native core metadata owns its buffers and handles unaligned outer views", () => {
    const storage = new Uint8Array(connect.length + 7); storage.set(connect, 3);
    const parsed = decodeNativeCoreConnectInfo(storage.subarray(3, 3 + connect.length))!; storage.fill(0);
    expect(parsed.application.name).toBe("WireЖ"); expect([...parsed.application.applicationData]).toEqual([3, 5, 7]);
    const value = decodeNativePlayerConnect(player)!;
    for (const patch of [{ instance: "bad" }, { version: -1 }, { name: "a" + String.fromCharCode(0) + "b" }, { url: "a" + String.fromCharCode(0) + "b" }, { data: new Uint8Array(NATIVE_CORE_MAX_MESSAGE) }])
        expect(() => encodeNativePlayerConnect({ ...value, ...patch })).toThrow(RangeError);
});
