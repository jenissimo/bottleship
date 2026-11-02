import { expect, test } from "bun:test";
import { decodeNativeProtocolFrame, encodeNativeProtocolFrame, DN, type NativeDataFrame, type NativeAckFrame } from "../../src/worker/modules/dpnet/native-wire/frame-codec";
const b = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], n => parseInt(n, 16));
// Native Windows peers connected through the packet proxy, nonce 1626410397.
// Full peer handshake and core transcript are retained in that protocol.json.
const connect = b("880100000600010013513f048c2b2802"), connected = b("880200000600010013513f04932b2802"), final = b("800201000600010013513f048c2b2802");
const correlate = b("3f02000013513f04"), coreAck = b("7f000202c3000000"), sack = b("80060100040400008d2b2802"), end = b("3f080404");
test("captured native CONNECT/CONNECTED, data, SACK and end-stream frames round trip exactly", () => {
    for (const packet of [connect, connected, final, correlate, coreAck, sack, end]) {
        const frame = decodeNativeProtocolFrame(packet)!; expect(frame).not.toBeNull(); expect(encodeNativeProtocolFrame(frame)).toEqual(packet);
    }
    expect(decodeNativeProtocolFrame(connect)).toMatchObject({ kind: "control", opcode: DN.CONNECT, version: 0x10006, sessionId: 0x043f5113, messageId: 0, responseId: 0 });
    expect(decodeNativeProtocolFrame(final)).toMatchObject({ kind: "control", opcode: DN.CONNECTED, messageId: 1, responseId: 0, command: 0x80 });
    expect(decodeNativeProtocolFrame(coreAck)).toMatchObject({ kind: "data", command: 0x7f, sequence: 2, nextReceive: 2, payload: b("c3000000") });
    expect(decodeNativeProtocolFrame(sack)).toMatchObject({ kind: "ack", flags: 1, retry: 0, nextSend: 4, nextReceive: 4, reserved: [0, 0] });
});
test("every optional data and SACK mask combination is bounded, ordered and little endian", () => {
    for (let flags = 0; flags < 16; flags++) {
        const masks = [1, 2, 4, 8].filter(bit => flags & bit).map(bit => (0xdeadbeef ^ bit) >>> 0);
        const data: NativeDataFrame = { kind: "data", command: 0xff, control: flags << 4, sequence: 255, nextReceive: 0, masks, payload: Uint8Array.of(0, 0xff) };
        const ack: NativeAckFrame = { kind: "ack", command: 0x88, flags: flags << 1 | 1, retry: 1, nextSend: 0, nextReceive: 255, masks, timestamp: 0xffffffff, reserved: [5, 9], extra: Uint8Array.of(3) };
        for (const frame of [data, ack]) {
            const packet = encodeNativeProtocolFrame(frame); expect(decodeNativeProtocolFrame(packet)).toEqual(frame);
            const header = frame.kind === "data" ? 4 : 12;
            for (let size = 0; size < header + masks.length * 4; size++) expect(decodeNativeProtocolFrame(packet.subarray(0, size))).toBeNull();
        }
    }
});
test("native protocol decoder rejects short/invalid opcodes and owns buffers with arbitrary byte offsets", () => {
    for (const packet of [connect, sack]) for (let n = 0; n < packet.length; n++) expect(decodeNativeProtocolFrame(packet.subarray(0, n))).toBeNull();
    for (const [offset, value] of [[0, 0], [0, 0x82], [1, 3]]) { const bad = connect.slice(); bad[offset] = value; expect(decodeNativeProtocolFrame(bad)).toBeNull(); }
    expect(decodeNativeProtocolFrame(new Uint8Array(65508))).toBeNull();
    const container = new Uint8Array(coreAck.length + 5); container.set(coreAck, 3);
    const decoded = decodeNativeProtocolFrame(container.subarray(3, 3 + coreAck.length)) as NativeDataFrame;
    container.fill(0); expect(decoded.payload).toEqual(b("c3000000")); expect(decoded.sequence).toBe(2);
});
test("encoder rejects mismatched optional masks and out-of-range numbers before allocation", () => {
    const data = decodeNativeProtocolFrame(coreAck) as NativeDataFrame;
    for (const patch of [{ sequence: -1 }, { nextReceive: 256 }, { masks: [1] }, { command: 0x80 }, { payload: new Uint8Array(65504) }])
        expect(() => encodeNativeProtocolFrame({ ...data, ...patch })).toThrow(RangeError);
    expect(() => encodeNativeProtocolFrame({ ...data, control: 0x10, masks: [0x100000000] })).toThrow(RangeError);
});
