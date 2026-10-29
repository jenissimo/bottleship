import { NATIVE_CORE_MAX_MESSAGE, type NativeNameTableEntry } from "./core-connect-codec";
import { nativeCoreWide, nativeCoreWords } from "./core-operations";

export interface NativeGroupRequest {
    handle: number; flags: number; mask: number; name: string | null; data: Uint8Array;
}
/** D2: command, request token, then a 24-byte group body with body-relative extents. */
export function decodeNativeGroupRequest(bytes: Uint8Array): NativeGroupRequest | null {
    if (bytes.length < 32 || bytes.length > NATIVE_CORE_MAX_MESSAGE) return null;
    try {
        const outer = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (outer.getUint32(0, true) !== 0xd2) return null;
        const body = bytes.subarray(8), view = new DataView(body.buffer, body.byteOffset, body.byteLength);
        const flags = view.getUint32(0, true), mask = view.getUint32(4, true);
        if (flags & ~1 || mask & ~3) return null;
        const blob = (field: number): Uint8Array => {
            const offset = view.getUint32(field, true), size = view.getUint32(field + 4, true);
            if (!size) { if (offset) throw Error("Nonempty zero-sized group extent"); return new Uint8Array(); }
            if (offset < 24 || size > body.length || offset > body.length - size) throw Error("Invalid group extent");
            return body.slice(offset, offset + size);
        };
        const nameBytes = blob(8), data = blob(16);
        if (!(mask & 1) && nameBytes.length || !(mask & 2) && data.length) return null;
        let name: string | null = null;
        if (nameBytes.length) {
            if (nameBytes.length < 2 || nameBytes.length & 1 || nameBytes.at(-1) || nameBytes.at(-2)) return null;
            name = ""; const text = new DataView(nameBytes.buffer);
            for (let p = 0; p < nameBytes.length - 2; p += 2) {
                const ch = text.getUint16(p, true); if (!ch) return null; name += String.fromCharCode(ch);
            }
        }
        return { handle: outer.getUint32(4, true), flags, mask, name, data };
    } catch { return null; }
}
/** D7 extents are relative to the requester/token/entry body, not the entry alone. */
export function encodeNativeGroupAdded(requesting: number, handle: number, entry: NativeNameTableEntry): Uint8Array {
    const fields = [requesting, handle, entry.id, entry.owner, entry.flags, entry.version, entry.unused, entry.coreVersion];
    if (fields.some(n => !Number.isInteger(n) || n < 0 || n > 0xffffffff) || !(entry.flags & 0x10) || entry.url !== null)
        throw RangeError("Invalid native group entry");
    const name = nativeCoreWide(entry.name), data = entry.data, size = 56 + name.length + data.length;
    if (size + 4 > NATIVE_CORE_MAX_MESSAGE) throw RangeError("Group entry exceeds core bound");
    const out = new Uint8Array(size + 4), view = new DataView(out.buffer);
    out.set(nativeCoreWords(0xd7, ...fields, 0, 0, 0, 0, 0, 0));
    // CPackedBuffer adds the name before data, so data precedes the name in the tail.
    let tail = size;
    for (const [field, bytes] of [[32, name], [40, data]] as const) if (bytes.length) {
        tail -= bytes.length; out.set(bytes, 4 + tail);
        view.setUint32(4 + field, tail, true); view.setUint32(8 + field, bytes.length, true);
    }
    return out;
}

export interface NativeGroupDestroyRequest { handle: number; id: number; }
/** D5 carries only the opaque internal completion token and group ID. */
export function decodeNativeGroupDestroyRequest(bytes: Uint8Array): NativeGroupDestroyRequest | null {
    if (bytes.length !== 12) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0xd5) return null;
    return { handle: view.getUint32(4, true), id: view.getUint32(8, true) };
}
/** D8 contains no context, owner, flags or callback reason. */
export function encodeNativeGroupDestroyed(id: number, version: number, requesting: number, handle: number): Uint8Array {
    if ([id, version, requesting, handle].some(n => !Number.isInteger(n) || n < 0 || n > 0xffffffff))
        throw RangeError("Invalid native group destruction");
    return nativeCoreWords(0xd8, id, version, 0, requesting, handle);
}

export interface NativeMemberRequest { handle: number; group: number; player: number; add: boolean; }
/** D3/D4 carry only opaque request token, group and player DWORDs. */
export function decodeNativeMemberRequest(bytes: Uint8Array): NativeMemberRequest | null {
    if (bytes.length !== 16) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), command = view.getUint32(0, true);
    if (command !== 0xd3 && command !== 0xd4) return null;
    return { handle: view.getUint32(4, true), group: view.getUint32(8, true), player: view.getUint32(12, true), add: command === 0xd3 };
}
export function encodeNativeMemberChanged(group: number, player: number, add: boolean, version: number, requesting: number, handle: number): Uint8Array {
    if ([group, player, version, requesting, handle].some(n => !Number.isInteger(n) || n < 0 || n > 0xffffffff))
        throw RangeError("Invalid native group membership");
    return nativeCoreWords(add ? 0xd9 : 0xda, group, player, version, 0, requesting, handle);
}
