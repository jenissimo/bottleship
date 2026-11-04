/**
 * [MC-DPL4CS] 2.2.49 DPSP_MSG_REQUESTPLAYERID and 2.2.50 DPSP_MSG_REQUESTPLAYERREPLY
 * (with 2.2.4 DPSECURITYDESC), inner message only: no size/token/SockAddr prefix or I/O.
 */
import {DPSP_MSG, DPSP_SIGNATURE, DPSP_VERSION} from "./spec";

/** Default version DX8VERSION (2.2.3); callers may pass the version they negotiated. */
export function encodeDirectPlay4RequestPlayerId(flags: number, version: number = DPSP_VERSION.DX8): Uint8Array {
    if (!Number.isInteger(version) || version < 0 || version > 0xffff)
        throw new RangeError("version must be an unsigned WORD");
    if (!Number.isInteger(flags) || flags < 0 || flags > 0xffffffff)
        throw new RangeError("flags must be an unsigned DWORD");
    const result = new Uint8Array(12), view = new DataView(result.buffer);
    view.setUint32(0, DPSP_SIGNATURE, true);
    view.setUint16(4, DPSP_MSG.REQUESTPLAYERID, true);
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
    /** 2.2.50 Result: raw HRESULT DWORD (0 = success). */
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
    if (view.getUint32(0, true) !== DPSP_SIGNATURE || view.getUint16(4, true) !== DPSP_MSG.REQUESTPLAYERREPLY)
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
