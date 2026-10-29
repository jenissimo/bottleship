/**
 * Inner legacy DirectPlay messages only: no service-provider header or I/O.
 * NT5 dplay/dpmess.h:283-307, namesrv.c:304-323,376-396,
 * handler.c:1556-1583,1652-1713 and public/sdk/inc/dplay.h:438-454.
 * This describes x86 wire layout; it is not native interoperability evidence.
 */

/** NT5 default version is 13; native providers may send another version. */
export function encodeDirectPlay4RequestPlayerId(flags: number, version = 13): Uint8Array {
    if (!Number.isInteger(version) || version < 0 || version > 0xffff)
        throw new RangeError("version must be an unsigned WORD");
    if (!Number.isInteger(flags) || flags < 0 || flags > 0xffffffff)
        throw new RangeError("flags must be an unsigned DWORD");
    const result = new Uint8Array(12), view = new DataView(result.buffer);
    view.setUint32(0, 0x79616c70, true);
    view.setUint16(4, 5, true);
    view.setUint16(6, version, true);
    view.setUint32(8, flags, true);
    return result;
}

export interface DirectPlay4PlayerIdReply {
    version: number;
    playerId: number;
    /** Exact x86 DPSECURITYDESC bytes; includes raw pointer fields. */
    securityDescription: Uint8Array;
    sspiProviderOffset: number;
    capiProviderOffset: number;
    /** Raw HRESULT DWORD; callers may interpret it only for version >= 9. */
    result: number;
    /** Bytes following the fixed structure, copied without interpretation. */
    trailingBytes: Uint8Array;
}

/**
 * Decodes exactly one already-framed inner message. The fixed 48-byte minimum
 * and caller-provided maximum are local safety bounds, not native acceptance
 * rules for truncated historical messages. Provider offsets/pointers are raw:
 * this does not parse strings, validate secure replies, or perform a Join.
 */
export function decodeDirectPlay4PlayerIdReply(
    input: Uint8Array,
    maxBytes: number,
): DirectPlay4PlayerIdReply {
    if (!(input instanceof Uint8Array)) throw new TypeError("input must be bytes");
    if (!Number.isInteger(maxBytes) || maxBytes < 48 || maxBytes > 0xfffff)
        throw new RangeError("message limit must be between 48 and 1048575");
    if (input.length < 48 || input.length > maxBytes)
        throw new RangeError("invalid player ID reply size");
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    if (view.getUint32(0, true) !== 0x79616c70 || view.getUint16(4, true) !== 7)
        throw new RangeError("not a player ID reply");
    return {
        version: view.getUint16(6, true),
        playerId: view.getUint32(8, true),
        securityDescription: Uint8Array.from(input.subarray(12, 36)),
        sspiProviderOffset: view.getUint32(36, true),
        capiProviderOffset: view.getUint32(40, true),
        result: view.getUint32(44, true),
        trailingBytes: Uint8Array.from(input.subarray(48)),
    };
}
