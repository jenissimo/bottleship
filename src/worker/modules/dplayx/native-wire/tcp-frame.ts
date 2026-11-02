/**
 * Isolated normal TOKEN framing of legacy DirectPlay system messages.
 * NT5 wsock/dpsp.h:94-128,293-305, wsock/dpsp.c:484-493,
 * 1119-1169,1299-1336,3535-3557 and dplay/dpmess.h:162-190.
 * This is an inner codec, not a socket, routing, or native interop claim.
 */
export interface DirectPlay4SystemTcpFrame {
    consumed: number;
    /** Exact 16 wire bytes before provider receive-side address rewriting. */
    providerSockaddr: Uint8Array;
    /** Entire internal message, including signature and command/version. */
    message: Uint8Array;
    command: number;
    version: number;
}

function limit(value: number): void {
    if (!Number.isInteger(value) || value < 28 || value > 0xfffff)
        throw new RangeError("frame limit must be between 28 and 1048575");
}

/** Build the normal 20-byte provider header around an existing system message. */
export function encodeDirectPlay4SystemTcpFrame(
    providerSockaddr: Uint8Array, message: Uint8Array, maxBytes: number,
): Uint8Array {
    limit(maxBytes);
    if (!(providerSockaddr instanceof Uint8Array) || providerSockaddr.length !== 16)
        throw new RangeError("provider sockaddr must contain 16 raw bytes");
    if (!(message instanceof Uint8Array) || message.length < 8)
        throw new RangeError("system message is too short");
    const inner = new DataView(message.buffer, message.byteOffset, message.byteLength);
    if (inner.getUint32(0, true) !== 0x79616c70)
        throw new RangeError("invalid system message signature");
    const length = 20 + message.length;
    if (length > maxBytes) throw new RangeError("frame exceeds limit");
    const result = new Uint8Array(length), view = new DataView(result.buffer);
    view.setUint32(0, (0xfab00000 | length) >>> 0, true);
    result.set(providerSockaddr, 4);
    result.set(message, 20);
    return result;
}

/**
 * Decode one already-buffered normal system frame, or null if incomplete.
 * consumed permits a caller to process concatenated frames. All returned
 * bytes are independently owned, including when input is a Node Buffer.
 * Bounds, minimum size, and unsupported-token rejection are local safety
 * policy; zero-size controls, non-system messages, server/helper/reuse tokens,
 * packetization, receive-side address rewriting and native malformed-input
 * semantics are outside this slice.
 */
export function decodeDirectPlay4SystemTcpFrame(
    input: Uint8Array, maxBytes: number,
): DirectPlay4SystemTcpFrame | null {
    limit(maxBytes);
    if (!(input instanceof Uint8Array)) throw new TypeError("input must be bytes");
    if (input.length < 4) return null;
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const header = view.getUint32(0, true);
    if (((header & 0xfff00000) >>> 0) !== 0xfab00000)
        throw new RangeError("unsupported provider token");
    const length = header & 0xfffff;
    if (length < 28 || length > maxBytes) throw new RangeError("invalid frame size");
    if (input.length < length) return null;
    if (view.getUint32(20, true) !== 0x79616c70)
        throw new RangeError("not a DirectPlay system message");
    return {
        consumed: length,
        providerSockaddr: Uint8Array.from(input.subarray(4,20)),
        message: Uint8Array.from(input.subarray(20,length)),
        command: view.getUint16(24,true), version: view.getUint16(26,true),
    };
}
