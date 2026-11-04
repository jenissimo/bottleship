import {DPSP_MSG, DPSP_SIGNATURE, DPSP_TOKEN_REMOTE, DPSP_VERSION} from "./spec";

/**
 * [MC-DPL4CS] 2.2.29 DPSP_MSG_ENUMSESSIONS, no-password form only (PasswordOffset 0),
 * framed by 2.2.6 DPSP_MSG_HEADER; see the 4.1 example. Version is DX8VERSION (13,
 * 2.2.3), which native Windows hosts answer in the DP4 interop fixtures
 * (tools/lan-conformance/directplay4-native-*-e2e.ts).
 * The inputs are Win32 in-memory GUID and SOCKADDR_IN bytes, not strings.
 */
export function encodeDirectPlay4EnumSessionsRequest(
    applicationGuid: Uint8Array,
    returnSockaddr: Uint8Array,
    flags: number,
): Uint8Array {
    // These are encoder input bounds, not claims about native receiver policy.
    if (!(applicationGuid instanceof Uint8Array) || applicationGuid.length !== 16)
        throw new RangeError("application GUID must contain 16 raw bytes");
    if (!(returnSockaddr instanceof Uint8Array) || returnSockaddr.length !== 16 ||
        returnSockaddr[0] !== 2 || returnSockaddr[1] !== 0)
        throw new RangeError("return address must be a 16-byte Win32 AF_INET sockaddr");
    if (!Number.isInteger(flags) || flags < 0 || flags > 0xffffffff)
        throw new RangeError("flags must be an unsigned DWORD");

    const result = new Uint8Array(52), view = new DataView(result.buffer);
    // Provider size includes its own 20 bytes; sockaddr contains network-order port/address.
    view.setUint32(0, ((DPSP_TOKEN_REMOTE << 20) | result.length) >>> 0, true);
    result.set(returnSockaddr, 4);
    // Inner offsets are relative to the first 'p', not to the provider header.
    view.setUint32(20, DPSP_SIGNATURE, true);
    view.setUint16(24, DPSP_MSG.ENUMSESSIONS, true);
    view.setUint16(26, DPSP_VERSION.DX8, true);
    result.set(applicationGuid, 28);
    view.setUint32(44, 0, true); // no password
    view.setUint32(48, flags, true);
    return result;
}

/** 2.2.5 DPSESSIONDESC2 fields as carried in 2.2.30 DPSP_MSG_ENUMSESSIONSREPLY (nonsecure). */
export interface DirectPlay4EnumReply {
    version: number;
    size: number;
    flags: number;
    instanceGuid: Uint8Array;
    applicationGuid: Uint8Array;
    maxPlayers: number;
    currentPlayers: number;
    reserved: readonly [number, number];
    user: readonly [number, number, number, number];
    name: string;
}

/**
 * [MC-DPL4CS] 2.2.30 DPSP_MSG_ENUMSESSIONSREPLY without the provider prefix:
 * header, 2.2.5 DPSESSIONDESC2 (80 bytes; SessionName/Password pointer
 * placeholders zero), NameOffset, then the NUL-terminated UTF-16 SessionName.
 * The version is an explicit input. Empty names and secure sessions are not
 * produced. Bounds are this encoder's contract, not native decoder rules.
 */
export function encodeDirectPlay4EnumSessionsReply(reply: DirectPlay4EnumReply): Uint8Array {
    const uint = (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
    if (!Number.isInteger(reply.version) || reply.version < 0 || reply.version > 0xffff)
        throw new RangeError("version must be an unsigned WORD");
    if (!(reply.instanceGuid instanceof Uint8Array) || reply.instanceGuid.length !== 16 ||
        !(reply.applicationGuid instanceof Uint8Array) || reply.applicationGuid.length !== 16)
        throw new RangeError("GUIDs must contain 16 raw bytes");
    if (!uint(reply.size) || !uint(reply.flags) || !uint(reply.maxPlayers) || !uint(reply.currentPlayers) ||
        !Array.isArray(reply.reserved) || reply.reserved.length !== 2 || !reply.reserved.every(uint) ||
        !Array.isArray(reply.user) || reply.user.length !== 4 || !reply.user.every(uint))
        throw new RangeError("description values must be unsigned DWORDs");
    if (typeof reply.name !== "string" || !reply.name.length || reply.name.includes("\0"))
        throw new RangeError("name must be a nonempty UTF-16 string without embedded NUL");

    const result = new Uint8Array(92 + (reply.name.length + 1) * 2), view = new DataView(result.buffer);
    view.setUint32(0, DPSP_SIGNATURE, true);
    view.setUint16(4, DPSP_MSG.ENUMSESSIONSREPLY, true);
    view.setUint16(6, reply.version, true);
    view.setUint32(8, reply.size, true);
    view.setUint32(12, reply.flags, true);
    result.set(reply.instanceGuid, 16);
    result.set(reply.applicationGuid, 32);
    view.setUint32(48, reply.maxPlayers, true);
    view.setUint32(52, reply.currentPlayers, true);
    // Both guest pointers in the transmitted description are zero.
    view.setUint32(64, reply.reserved[0], true);
    view.setUint32(68, reply.reserved[1], true);
    reply.user.forEach((value, index) => view.setUint32(72 + index * 4, value, true));
    view.setUint32(88, 92, true);
    for (let i = 0; i < reply.name.length; i++) view.setUint16(92 + i * 2, reply.name.charCodeAt(i), true);
    return result;
}

/** A decoded 2.2.30 reply; pointer placeholder DWORDs and provider sockaddr are raw wire bytes. */
export interface DirectPlay4DecodedEnumReply {
    consumed: number;
    providerSockaddr: Uint8Array;
    version: number;
    size: number;
    flags: number;
    instanceGuid: Uint8Array;
    applicationGuid: Uint8Array;
    maxPlayers: number;
    currentPlayers: number;
    sessionNamePointer: number;
    passwordPointer: number;
    reserved: readonly [number, number];
    user: readonly [number, number, number, number];
    name: string | null;
}

/**
 * Decode one TCP frame containing a 2.2.30 DPSP_MSG_ENUMSESSIONSREPLY. The
 * size/token DWORD (2.2.6) is read first; it gives the length of the whole
 * frame including the 20-byte size/token + SockAddr prefix.
 *
 * Returns null for an incomplete frame; consumed permits concatenated frames.
 * The explicit bound and strict offset/terminator checks are local safety
 * policy, not a claim about native malformed-input behavior. No secure-session
 * interpretation, address rewriting, socket handling or interop is implied.
 */
export function decodeDirectPlay4TcpEnumReply(
    input: Uint8Array,
    maxFrameBytes: number,
): DirectPlay4DecodedEnumReply | null {
    if (!(input instanceof Uint8Array)) throw new TypeError("input must be bytes");
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 112 || maxFrameBytes > 0xfffff)
        throw new RangeError("frame limit must be between 112 and 1048575");
    if (input.length < 4) return null;
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const header = view.getUint32(0, true);
    if (header >>> 20 !== DPSP_TOKEN_REMOTE)
        throw new RangeError("unsupported provider token");
    const length = header & 0xfffff;
    if (length < 112 || length > maxFrameBytes) throw new RangeError("invalid frame size");
    if (input.length < length) return null;
    const base = 20;
    if (view.getUint32(base, true) !== DPSP_SIGNATURE || view.getUint16(base + 4, true) !== DPSP_MSG.ENUMSESSIONSREPLY)
        throw new RangeError("not an enum sessions reply");
    const offset = view.getUint32(base + 88, true);
    let name: string | null = null;
    if (offset !== 0) {
        if (offset < 92 || (offset & 1) !== 0 || offset > length - base - 2)
            throw new RangeError("invalid name offset");
        const units: number[] = [];
        let ended = false;
        for (let pos = base + offset; pos + 1 < length; pos += 2) {
            const unit = view.getUint16(pos, true);
            if (unit === 0) { ended = true; break; }
            units.push(unit);
        }
        if (!ended) throw new RangeError("unterminated name");
        // Preserve UTF-16 code units, including unpaired surrogates.
        name = "";
        for (let i = 0; i < units.length; i += 4096)
            name += String.fromCharCode(...units.slice(i, i + 4096));
    }
    const u32 = (offset: number) => view.getUint32(base + offset, true);
    return {
        consumed: length, providerSockaddr: Uint8Array.from(input.subarray(4, 20)),
        version: view.getUint16(base + 6, true),
        size: u32(8), flags: u32(12),
        instanceGuid: Uint8Array.from(input.subarray(base + 16, base + 32)),
        applicationGuid: Uint8Array.from(input.subarray(base + 32, base + 48)),
        maxPlayers: u32(48), currentPlayers: u32(52),
        sessionNamePointer: u32(56), passwordPointer: u32(60),
        reserved: [u32(64), u32(68)], user: [u32(72), u32(76), u32(80), u32(84)],
        name,
    };
}

