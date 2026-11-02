import { NATIVE_DP8_MAX_DATAGRAM } from "./discovery-codec";
export const DN = {
    DATA: 1, RELIABLE: 2, SEQUENTIAL: 4, POLL: 8, NEW_MESSAGE: 0x10, END_MESSAGE: 0x20, USER1: 0x40, USER2: 0x80,
    RETRY: 1, CORRELATE: 2, RESPONSE: 4, END_STREAM: 8, SACK_LOW: 0x10, SACK_HIGH: 0x20, SEND_LOW: 0x40, SEND_HIGH: 0x80,
    CONNECT: 1, CONNECTED: 2, DISCONNECTED: 4, SACK: 6,
} as const;
export interface NativeDataFrame {
    kind: "data"; command: number; control: number; sequence: number; nextReceive: number;
    /** Ordered low/high SACK and low/high SEND masks, only where the control bit is set. */
    masks: number[]; payload: Uint8Array;
}
export interface NativeControlFrame {
    kind: "control"; command: number; opcode: 1 | 2 | 4; messageId: number; responseId: number;
    version: number; sessionId: number; timestamp: number; extra: Uint8Array;
}
export interface NativeAckFrame {
    kind: "ack"; command: number; flags: number; retry: number; nextSend: number; nextReceive: number;
    reserved: [number, number]; timestamp: number; masks: number[]; extra: Uint8Array;
}
export type NativeProtocolFrame = NativeDataFrame | NativeControlFrame | NativeAckFrame;
const count = (value: number): number => { let n = 0; for (; value; value >>>= 1) n += value & 1; return n; };
const uint = (value: number, max: number): boolean => Number.isInteger(value) && value >= 0 && value <= max;
const validCommand = (command: number): boolean => command === 0x80 || command === 0x88;
/** The DP8 DNET header has no native alignment or platform-sized fields. */
export function decodeNativeProtocolFrame(bytes: Uint8Array): NativeProtocolFrame | null {
    if (bytes.length < 4 || bytes.length > NATIVE_DP8_MAX_DATAGRAM) return null;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), command = bytes[0];
    if (command & DN.DATA) {
        const n = count(bytes[1] >>> 4), size = 4 + n * 4; if (bytes.length < size) return null;
        return { kind: "data", command, control: bytes[1], sequence: bytes[2], nextReceive: bytes[3],
            masks: Array.from({ length: n }, (_, i) => v.getUint32(4 + i * 4, true)), payload: bytes.slice(size) };
    }
    if (!validCommand(command)) return null;
    if (bytes[1] === DN.SACK) {
        if (bytes.length < 12) return null;
        const n = count((bytes[2] >>> 1) & 15), size = 12 + n * 4; if (bytes.length < size) return null;
        return { kind: "ack", command, flags: bytes[2], retry: bytes[3], nextSend: bytes[4], nextReceive: bytes[5],
            reserved: [bytes[6], bytes[7]], timestamp: v.getUint32(8, true),
            masks: Array.from({ length: n }, (_, i) => v.getUint32(12 + i * 4, true)), extra: bytes.slice(size) };
    }
    if (![DN.CONNECT, DN.CONNECTED, DN.DISCONNECTED].includes(bytes[1] as 1 | 2 | 4) || bytes.length < 16) return null;
    return { kind: "control", command, opcode: bytes[1] as 1 | 2 | 4, messageId: bytes[2], responseId: bytes[3],
        version: v.getUint32(4, true), sessionId: v.getUint32(8, true), timestamp: v.getUint32(12, true), extra: bytes.slice(16) };
}
export function encodeNativeProtocolFrame(frame: NativeProtocolFrame): Uint8Array {
    let size: number, payload: Uint8Array, masks: number[] = [];
    if (!uint(frame.command, 255)) throw new RangeError("Invalid DNET command");
    if (frame.kind === "data") {
        if (!(frame.command & DN.DATA) || !uint(frame.control, 255) || !uint(frame.sequence, 255) || !uint(frame.nextReceive, 255) ||
            frame.masks.length !== count(frame.control >>> 4)) throw new RangeError("Invalid DNET data header");
        masks = frame.masks; size = 4 + masks.length * 4; payload = frame.payload;
    } else if (frame.kind === "ack") {
        if (!validCommand(frame.command) || !uint(frame.flags, 255) || !uint(frame.retry, 255) || !uint(frame.nextSend, 255) || !uint(frame.nextReceive, 255) ||
            frame.reserved.length !== 2 || frame.reserved.some(n => !uint(n, 255)) || !uint(frame.timestamp, 0xffffffff) ||
            frame.masks.length !== count((frame.flags >>> 1) & 15)) throw new RangeError("Invalid DNET SACK header");
        masks = frame.masks; size = 12 + masks.length * 4; payload = frame.extra;
    } else {
        if (!validCommand(frame.command) || ![DN.CONNECT, DN.CONNECTED, DN.DISCONNECTED].includes(frame.opcode) ||
            !uint(frame.messageId, 255) || !uint(frame.responseId, 255) || [frame.version, frame.sessionId, frame.timestamp].some(n => !uint(n, 0xffffffff)))
            throw new RangeError("Invalid DNET connection header");
        size = 16; payload = frame.extra;
    }
    if (masks.some(n => !uint(n, 0xffffffff)) || size + payload.length > NATIVE_DP8_MAX_DATAGRAM) throw new RangeError("DNET frame exceeds UDP or mask bounds");
    const out = new Uint8Array(size + payload.length), v = new DataView(out.buffer); out[0] = frame.command;
    if (frame.kind === "data") {
        out.set([frame.control, frame.sequence, frame.nextReceive], 1);
        masks.forEach((value, i) => v.setUint32(4 + i * 4, value, true));
    } else if (frame.kind === "ack") {
        out.set([DN.SACK, frame.flags, frame.retry, frame.nextSend, frame.nextReceive, ...frame.reserved], 1); v.setUint32(8, frame.timestamp, true);
        masks.forEach((value, i) => v.setUint32(12 + i * 4, value, true));
    } else {
        out.set([frame.opcode, frame.messageId, frame.responseId], 1);
        v.setUint32(4, frame.version, true); v.setUint32(8, frame.sessionId, true); v.setUint32(12, frame.timestamp, true);
    }
    out.set(payload, size); return out;
}
