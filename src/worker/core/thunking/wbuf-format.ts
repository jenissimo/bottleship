/**
 * WBUF entry format — shared by the dispatcher's drain and the split D3D9 render worker, which
 * walks the same entries without the dispatcher.
 *
 * An entry is [funcId][args…]; the handler for funcId sees `ptr` at the first argument. The
 * stride follows from the funcId's registered argCount, or from one of the sentinels below.
 */

/** Stride = (4 + vec4Count×4) × 4 bytes; vec4Count is the third argument. */
export const WBUF_ARG_SHADER_CONSTANT = 255;

/** Captured UP draw: [funcId][this][primType][primCount][stride][byteCount][payload…],
 *  stride = 24 + byteCount. */
export const WBUF_ARG_UP_DRAW = 254;

/** Deferred-queue payload entry (never written by a guest trampoline): funcId, four header
 *  dwords, a byte count at +20, then the bytes padded to a dword — a trapped call whose data
 *  had to be copied out of guest memory when it was made (an Unlock). */
export const WBUF_ARG_PAYLOAD = 253;
export const WBUF_PAYLOAD_MAX_BYTES = 64 * 1024 * 1024;

/** Byte stride of the entry at `offset`, or -1 when its header is malformed. */
export function wbufEntryStride(mem32: Uint32Array, dataBase: number, offset: number, argCount: number): number {
    if (argCount === WBUF_ARG_SHADER_CONSTANT) {
        const vec4Count = mem32[(dataBase + offset + 12) >> 2] >>> 0;
        if (!vec4Count || vec4Count > 256) return -1;
        return (4 + vec4Count * 4) * 4;
    }
    if (argCount === WBUF_ARG_UP_DRAW) {
        const byteCount = mem32[(dataBase + offset + 20) >> 2] >>> 0;
        if (!byteCount || byteCount > 65536 || (byteCount & 3) !== 0) return -1;
        return 24 + byteCount;
    }
    if (argCount === WBUF_ARG_PAYLOAD) {
        const byteCount = mem32[(dataBase + offset + 20) >> 2] >>> 0;
        if (byteCount > WBUF_PAYLOAD_MAX_BYTES) return -1;
        return 24 + ((byteCount + 3) & ~3);
    }
    return (argCount + 1) * 4;
}
