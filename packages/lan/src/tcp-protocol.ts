export const TCP_MAGIC = 0x31545342;
export const TCP_HEADER = 20;
export const SYN = 1, SYNACK = 2, DATA = 3, FIN = 4, RST = 5, CREDIT = 6, OOB = 7, TCP_OPTION = 8;
export const SYN_INLINE_FLAG = 0x80000000;
export const SYN_KEEPALIVE_FLAG = 0x40000000, SYN_NODELAY_FLAG = 0x20000000;
export const SYN_WINDOW_MASK = 0x1fffffff;
export const TCP_OPTION_KEEPALIVE = 0x100, TCP_OPTION_NODELAY = 0x200;
export const TCP_WINDOW = 256 * 1024;
export const TCP_SEGMENT = 16 * 1024;
export interface TcpFrame { kind: number; srcId: number; dstId: number; value: number; data: Uint8Array }
export function encodeTcpFrame(kind: number, srcId: number, dstId: number, value = 0, data: Uint8Array = new Uint8Array()): Uint8Array<ArrayBuffer> {
    const frame = new Uint8Array(TCP_HEADER + data.length);
    const view = new DataView(frame.buffer);
    view.setUint32(0, TCP_MAGIC, true); view.setUint32(4, kind, true);
    view.setUint32(8, srcId, true); view.setUint32(12, dstId, true); view.setUint32(16, value, true);
    frame.set(data, TCP_HEADER);
    return frame;
}
export function decodeTcpFrame(bytes: Uint8Array): TcpFrame | null {
    if (bytes.length < TCP_HEADER) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== TCP_MAGIC) return null;
    const kind = view.getUint32(4, true);
    if (kind < SYN || kind > TCP_OPTION) return null;
    return { kind, srcId: view.getUint32(8, true), dstId: view.getUint32(12, true), value: view.getUint32(16, true), data: bytes.subarray(TCP_HEADER) };
}
