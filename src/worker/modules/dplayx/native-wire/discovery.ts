/**
 * NT5 legacy TCP/IP provider, no-password ENUMSESSIONS request only.
 * dplay/dplay/dpmess.h:162-178,237-248; dplay/dplay/enum.c:1507-1536;
 * dplay/wsock/dpsp.h:97-127,300-305; dplay/wsock/dpsp.c:484-493,2073-2076.
 * The inputs are Win32 in-memory GUID and SOCKADDR_IN bytes, not strings.
 * This is source-derived encoding, not evidence of native interoperability.
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
    view.setUint32(0, 0xfab00000 | result.length, true);
    result.set(returnSockaddr, 4);
    // Inner offsets are relative to the first 'p', not to the provider header.
    view.setUint32(20, 0x79616c70, true);
    view.setUint32(24, (13 << 16) | 2, true);
    result.set(applicationGuid, 28);
    view.setUint32(44, 0, true); // no password
    view.setUint32(48, flags, true);
    return result;
}

/** 32-bit normal, nonsecure session description as stored in MSG_ENUMSESSIONSREPLY. */
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
 * Internal reply only. NT5 dplay/dpmess.h:237-258, dplay/handler.c:1496-1544,
 * dplay/dplay.h:417-442. Version is explicit because DoReply may change it.
 * This excludes the provider header, empty names, and secure-server replies.
 * Bounds are this encoder's contract, not native decoder acceptance rules.
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
    view.setUint32(0, 0x79616c70, true);
    view.setUint32(4, (reply.version << 16) | 1, true);
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

/** A source-layout reply; pointer DWORDs and provider sockaddr are raw wire bytes. */
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
 * Decode one TCP provider frame containing an ENUMSESSIONSREPLY.
 * dplay/wsock/dpsp.h:94-130,300-305; dpsp.c:1119-1169,1242-1402;
 * dplay/handler.c:1496-1544,3519-3562. The first receive stage is the
 * four-byte token/size, although the full provider header is 20 bytes.
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
    if ((header & 0xfff00000) >>> 0 !== 0xfab00000)
        throw new RangeError("unsupported provider token");
    const length = header & 0xfffff;
    if (length < 112 || length > maxFrameBytes) throw new RangeError("invalid frame size");
    if (input.length < length) return null;
    const base = 20;
    if (view.getUint32(base, true) !== 0x79616c70 || view.getUint16(base + 4, true) !== 1)
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

