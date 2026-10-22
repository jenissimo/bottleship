/**
 * DirectPlay 8 TCP/IP enumeration datagrams. Binary layout is documented by
 * NT5 dnet/sp/wsock/messagestructures.h and core/{enumhosts,message}.h.
 * Native Windows captures live under logs/lan-conformance/directplay8-wire.
 * No guest pointers or RAM views cross this boundary.
 */
export const NATIVE_DP8_MAX_DATAGRAM = 65507;
const RESPONSE_HEADER = 88;
export interface NativeEnumQuery { token: number; application: string | null; data: Uint8Array; }
export interface NativeEnumResponse {
    token: number; flags: number; maxPlayers: number; players: number;
    instance: string; application: string; name: string | null; password: string | null;
    reserved: Uint8Array; applicationData: Uint8Array; data: Uint8Array;
}
const hex = (bytes: Uint8Array) => Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
const unhex = (value: string): Uint8Array => {
    if (!/^[a-fA-F0-9]{32}$/.test(value)) throw new RangeError("A native GUID is exactly 16 wire-order bytes");
    return Uint8Array.from(value.match(/../g)!, byte => parseInt(byte, 16));
};
const uint = (value: number, max: number): number => {
    if (!Number.isInteger(value) || value < 0 || value > max) throw new RangeError("Native unsigned field out of range");
    return value;
};
const textBytes = (value: string | null): Uint8Array => {
    if (value === null) return new Uint8Array();
    if (value.length > (NATIVE_DP8_MAX_DATAGRAM >>> 1) - 1 || value.includes("\0")) throw new RangeError("Native enumeration string exceeds one datagram or contains NUL");
    const bytes = new Uint8Array((value.length + 1) * 2), view = new DataView(bytes.buffer);
    for (let i = 0; i < value.length; i++) view.setUint16(i * 2, value.charCodeAt(i), true);
    return bytes;
};
function text(bytes: Uint8Array): string | null {
    if (bytes.length < 2 || bytes.length & 1 || bytes[bytes.length - 2] || bytes[bytes.length - 1]) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let value = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
        const character = view.getUint16(i, true); if (!character) break;
        value += String.fromCharCode(character);
    }
    return value;
}
function envelope(bytes: Uint8Array, kind: number, minimum: number): DataView | null {
    return bytes.length >= minimum && bytes.length <= NATIVE_DP8_MAX_DATAGRAM && bytes[0] === 0 && bytes[1] === kind ?
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
}
export function decodeNativeEnumQuery(bytes: Uint8Array): NativeEnumQuery | null {
    const view = envelope(bytes, 2, 5); if (!view) return null;
    const type = bytes[4], offset = type === 1 ? 21 : type === 2 ? 5 : 0;
    if (!offset || bytes.length < offset) return null;
    return { token: view.getUint16(2, true), application: type === 1 ? hex(bytes.subarray(5, 21)) : null, data: bytes.slice(offset) };
}
export function encodeNativeEnumQuery(query: NativeEnumQuery): Uint8Array {
    const token = uint(query.token, 65535), guid = query.application === null ? null : unhex(query.application);
    const size = (guid ? 21 : 5) + query.data.length;
    if (size > NATIVE_DP8_MAX_DATAGRAM) throw new RangeError("Native enumeration query exceeds UDP capacity");
    const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
    bytes[1] = 2; view.setUint16(2, token, true); bytes[4] = guid ? 1 : 2;
    if (guid) bytes.set(guid, 5); bytes.set(query.data, guid ? 21 : 5);
    return bytes;
}
export function decodeNativeEnumResponse(bytes: Uint8Array): NativeEnumResponse | null {
    const view = envelope(bytes, 3, 4 + RESPONSE_HEADER); if (!view) return null;
    const body = bytes.subarray(4), bodyView = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const field = (offsetField: number, sizeField: number): Uint8Array | null => {
        const offset = bodyView.getUint32(offsetField, true), size = bodyView.getUint32(sizeField, true);
        if (!offset) return size ? null : new Uint8Array();
        // Offsets refer to the start of the core payload, after the four SP bytes.
        // A valid WCHAR field can have an odd offset; native packing adds no padding.
        if (offset < RESPONSE_HEADER || offset > body.length || size > body.length - offset) return null;
        return body.slice(offset, offset + size);
    };
    const data = field(0, 4), nameBytes = field(24, 28), passwordBytes = field(32, 36),
        reserved = field(40, 44), applicationData = field(48, 52);
    if (!data || !nameBytes || !passwordBytes || !reserved || !applicationData) return null;
    const name = nameBytes.length ? text(nameBytes) : null, password = passwordBytes.length ? text(passwordBytes) : null;
    if ((nameBytes.length && name === null) || (passwordBytes.length && password === null)) return null;
    // dwSize at core offset 8 is informational. NT5 receivers decode this fixed
    // wire structure without trusting it as a buffer size.
    return { token: view.getUint16(2, true), flags: bodyView.getUint32(12, true),
        maxPlayers: bodyView.getUint32(16, true), players: bodyView.getUint32(20, true),
        instance: hex(body.subarray(56, 72)), application: hex(body.subarray(72, 88)),
        name, password, reserved, applicationData, data };
}
export function encodeNativeEnumResponse(response: NativeEnumResponse): Uint8Array {
    const token = uint(response.token, 65535), flags = uint(response.flags, 0xffffffff),
        maxPlayers = uint(response.maxPlayers, 0xffffffff), players = uint(response.players, 0xffffffff);
    const instance = unhex(response.instance), application = unhex(response.application),
        name = textBytes(response.name), password = textBytes(response.password);
    const packedSize = RESPONSE_HEADER + name.length + password.length + response.reserved.length + response.applicationData.length;
    if (4 + packedSize + response.data.length > NATIVE_DP8_MAX_DATAGRAM) throw new RangeError("Native enumeration response exceeds UDP capacity");
    const bytes = new Uint8Array(4 + packedSize + response.data.length), view = new DataView(bytes.buffer),
        body = bytes.subarray(4), core = new DataView(body.buffer, body.byteOffset, body.byteLength);
    bytes[1] = 3; view.setUint16(2, token, true);
    core.setUint32(0, response.data.length ? packedSize : 0, true); core.setUint32(4, response.data.length, true);
    core.setUint32(8, 80, true); core.setUint32(12, flags, true); core.setUint32(16, maxPlayers, true); core.setUint32(20, players, true);
    body.set(instance, 56); body.set(application, 72); body.set(response.data, packedSize);
    let tail = packedSize;
    const field = (offsetField: number, sizeField: number, data: Uint8Array) => {
        if (!data.length) return;
        tail -= data.length; body.set(data, tail);
        core.setUint32(offsetField, tail, true); core.setUint32(sizeField, data.length, true);
    };
    field(24, 28, name); field(32, 36, password); field(40, 44, response.reserved); field(48, 52, response.applicationData);
    return bytes;
}
