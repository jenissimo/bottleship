/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { BROADCAST_NODE, decodeDatagram, encodeDatagram, ipv4ToNode, nodeToIpv4, PROTO_IPX, PROTO_UDP, PROTO_RAW4, PROTO_RAW6, RAW_FRAME_MAX_PAYLOAD, MAX_FRAME_SIZE, WIRE_DGRAM } from "../src/protocol";

describe("LAN wire", () => {
    test("raw envelope preserves full IP packets and validates protocol ports and flags", () => {
        for (const proto of [PROTO_RAW4, PROTO_RAW6]) {
            const payload = new Uint8Array(RAW_FRAME_MAX_PAYLOAD); payload[0] = 58; payload[1] = 3; payload[payload.length - 1] = 0xab;
            const frame = encodeDatagram(proto, BROADCAST_NODE, 59, 59, payload);
            expect(frame.length).toBe(MAX_FRAME_SIZE);
            expect(decodeDatagram(frame)!.payload.at(-1)).toBe(0xab);
            expect(decodeDatagram(encodeDatagram(proto, BROADCAST_NODE, 59, 256, payload))!.srcPort).toBe(256);
            expect(() => encodeDatagram(proto, BROADCAST_NODE, 257, 59, payload)).toThrow();
            frame[13] = 4; expect(decodeDatagram(frame)).toBeNull();
            expect(() => encodeDatagram(proto, BROADCAST_NODE, 59, 59, new Uint8Array(RAW_FRAME_MAX_PAYLOAD + 1))).toThrow();
        }
    });
    test("matches the network-order reference bytes and decodes sliced buffers", () => {
        const node = Uint8Array.of(2, 0, 0, 1, 2, 3);
        const frame = encodeDatagram(PROTO_UDP, node, 0x1234, 0xabcd, Uint8Array.of(7, 8));
        expect(Array.from(frame)).toEqual([WIRE_DGRAM, 1, 2, 0, 0, 1, 2, 3, 0x12, 0x34, 0xab, 0xcd, 7, 8]);
        const padded = new Uint8Array(frame.length + 10);
        padded.set(frame, 5);
        const decoded = decodeDatagram(padded.subarray(5, 5 + frame.length))!;
        expect(decoded.srcPort).toBe(0xabcd);
        expect(decoded.dstPort).toBe(0x1234);
        expect(Array.from(decoded.payload)).toEqual([7, 8]);
        expect(Array.from(nodeToIpv4(node))).toEqual([10, 1, 2, 3]);
        expect(ipv4ToNode(Uint8Array.of(10, 1, 2, 3))).toEqual(node);
        expect(ipv4ToNode(Uint8Array.of(255, 255, 255, 255))).toEqual(BROADCAST_NODE);
    });
    test("rejects invalid protocols, ports, and oversize IPX instead of truncating", () => {
        const valid = encodeDatagram(PROTO_IPX, BROADCAST_NODE, 1, 2, new Uint8Array(548));
        expect(decodeDatagram(valid)).not.toBeNull();
        const oversized = new Uint8Array(valid.length + 1);
        oversized.set(valid);
        expect(decodeDatagram(oversized)).toBeNull();
        expect(() => encodeDatagram(PROTO_IPX, BROADCAST_NODE, 1, 2, new Uint8Array(549))).toThrow();
        valid[1] = 255;
        expect(decodeDatagram(valid)).toBeNull();
        valid[1] = PROTO_IPX;
        valid[8] = valid[9] = 0;
        expect(decodeDatagram(valid)).toBeNull();
        expect(decodeDatagram(new Uint8Array(2))).toBeNull();
        expect(() => encodeDatagram(PROTO_IPX, BROADCAST_NODE, 1, 2, new Uint8Array())).toThrow();
        const emptyIpx = encodeDatagram(PROTO_UDP, BROADCAST_NODE, 1, 2, new Uint8Array());
        emptyIpx[1] = PROTO_IPX;
        expect(decodeDatagram(emptyIpx)).toBeNull();
    });
});
