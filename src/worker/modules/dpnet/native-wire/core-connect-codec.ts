export const NATIVE_CORE_MAX_MESSAGE = 1024 * 1024;
export interface NativePlayerConnectInfo {
    flags: number; version: number; instance: string; application: string;
    name: string | null; data: Uint8Array; password: string | null; connectData: Uint8Array; url: string | null; alternate: Uint8Array;
}
export interface NativeCoreApplication {
    flags: number; maxPlayers: number; players: number; instance: string; application: string;
    name: string | null; password: string | null; reserved: Uint8Array; applicationData: Uint8Array;
}
export interface NativeNameTableEntry { id: number; owner: number; flags: number; version: number; unused: number; coreVersion: number; name: string | null; data: Uint8Array; url: string | null; }
export interface NativeCoreConnectInfo {
    reply: Uint8Array; application: NativeCoreApplication; localId: number; version: number; unused: number;
    entries: NativeNameTableEntry[]; members: { player: number; group: number; version: number; unused: number }[];
}
const guid = /^[0-9a-f]{32}$/i;
const hex = (bytes: Uint8Array) => Array.from(bytes, n => n.toString(16).padStart(2, "0")).join("");
class Reader {
    readonly view: DataView;
    constructor(readonly bytes: Uint8Array, public minimum: number) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
    u32(offset: number): number { return this.view.getUint32(offset, true); }
    guid(offset: number): string { if (offset > this.bytes.length - 16) throw Error("Short GUID"); return hex(this.bytes.subarray(offset, offset + 16)); }
    blob(field: number): Uint8Array {
        const offset = this.u32(field), size = this.u32(field + 4);
        if (!size) return new Uint8Array();
        if (offset < this.minimum || size > this.bytes.length || offset > this.bytes.length - size) throw Error("Invalid core blob");
        return this.bytes.slice(offset, offset + size);
    }
    wide(field: number): string | null {
        const bytes = this.blob(field); if (!bytes.length) return null;
        if (bytes.length < 2 || bytes.length & 1 || bytes[bytes.length - 2] || bytes[bytes.length - 1]) throw Error("Invalid WCHAR extent");
        const view = new DataView(bytes.buffer); let value = "";
        for (let i = 0; i < bytes.length - 2; i += 2) { const ch = view.getUint16(i, true); if (!ch) break; value += String.fromCharCode(ch); } return value;
    }
    ansi(field: number): string | null {
        const bytes = this.blob(field); if (!bytes.length) return null;
        if (bytes.at(-1)) throw Error("Missing ANSI terminator");
        let value = ""; for (const ch of bytes.subarray(0, bytes.indexOf(0))) value += String.fromCharCode(ch); return value;
    }
}
const body = (bytes: Uint8Array, command: number, minimum: number): Reader => {
    if (bytes.length < minimum + 4 || bytes.length > NATIVE_CORE_MAX_MESSAGE || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) !== command) throw Error("Invalid core envelope");
    return new Reader(bytes.subarray(4), minimum);
};
/** Packed offsets exclude the DWORD internal-message command. */
export function decodeNativePlayerConnect(bytes: Uint8Array): NativePlayerConnectInfo | null {
    try {
        const r = body(bytes, 0xc1, 80), version = r.u32(4);
        if (version >= 7) { if (r.bytes.length < 88) return null; r.minimum = 88; }
        return { flags: r.u32(0), version, name: r.wide(8), data: r.blob(16), password: r.wide(24), connectData: r.blob(32), url: r.ansi(40),
            instance: r.guid(48), application: r.guid(64), alternate: version >= 7 ? r.blob(80) : new Uint8Array() };
    } catch { return null; }
}
function wide(value: string | null): Uint8Array {
    if (value === null) return new Uint8Array();
    if (value.includes("\0")) throw new RangeError("Embedded string terminator");
    const bytes = new Uint8Array((value.length + 1) * 2), view = new DataView(bytes.buffer);
    for (let i = 0; i < value.length; i++) view.setUint16(i * 2, value.charCodeAt(i), true); return bytes;
}
/** NT5 core version 2 is negotiated separately from DNET protocol version 1.2. */
export function encodeNativePlayerConnect(info: NativePlayerConnectInfo): Uint8Array {
    if (!guid.test(info.instance) || !guid.test(info.application) || !Number.isInteger(info.flags) || info.flags < 0 || info.flags > 0xffffffff ||
        !Number.isInteger(info.version) || info.version < 0 || info.version > 0xffffffff) throw new RangeError("Invalid core connect fields");
    if (info.url !== null && (info.url.includes("\0") || [...info.url].some(ch => ch.charCodeAt(0) > 255))) throw new RangeError("Invalid ANSI URL");
    if (info.version < 7 && info.alternate.length) throw new RangeError("This core version has no alternate-address field");
    const url = info.url === null ? new Uint8Array() : Uint8Array.from([...info.url].map(c => c.charCodeAt(0)).concat(0));
    const blobs = [wide(info.name), info.data, wide(info.password), info.connectData, url, ...(info.version >= 7 ? [info.alternate] : [])];
    const header = info.version >= 7 ? 88 : 80, size = header + blobs.reduce((n, p) => n + p.length, 0);
    if (size + 4 > NATIVE_CORE_MAX_MESSAGE) throw new RangeError("Core connect exceeds message bound");
    const out = new Uint8Array(size + 4), r = new DataView(out.buffer); r.setUint32(0, 0xc1, true); r.setUint32(4, info.flags, true); r.setUint32(8, info.version, true);
    let tail = size;
    for (let i = 0; i < blobs.length; i++) {
        const blob = blobs[i], field = i === 5 ? 80 : 8 + i * 8;
        if (blob.length) { tail -= blob.length; out.set(blob, 4 + tail); r.setUint32(4 + field, tail, true); r.setUint32(8 + field, blob.length, true); }
    }
    out.set(Uint8Array.from(info.instance.match(/../g)!, b => parseInt(b, 16)), 52);
    out.set(Uint8Array.from(info.application.match(/../g)!, b => parseInt(b, 16)), 68); return out;
}
/** Shared binary host snapshot writer; offsets remain relative to the complete C2 body. */
export function encodeNativeCoreConnectInfo(info: NativeCoreConnectInfo): Uint8Array {
    const a = info.application, count = info.entries.length, members = info.members.length, fixed = 108 + count * 48 + members * 16;
    const uint = (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
    if (count > 4096 || members > 65536 || !guid.test(a.instance) || !guid.test(a.application) ||
        [info.localId, info.version, info.unused, a.flags, a.maxPlayers, a.players].some(n => !uint(n)) ||
        new Set(info.entries.map(e => e.id)).size !== count) throw new RangeError("Invalid core snapshot fields");
    const fields: { at: number; bytes: Uint8Array }[] = [
        { at: 0, bytes: info.reply }, { at: 24, bytes: wide(a.name) }, { at: 32, bytes: wide(a.password) },
        { at: 40, bytes: a.reserved }, { at: 48, bytes: a.applicationData },
    ];
    for (let i = 0; i < count; i++) {
        const e = info.entries[i], p = 108 + i * 48;
        if ([e.id, e.owner, e.flags, e.version, e.unused, e.coreVersion].some(n => !uint(n)) ||
            (e.url !== null && (e.url.includes("\0") || [...e.url].some(ch => ch.charCodeAt(0) > 255)))) throw new RangeError("Invalid entry fields");
        fields.push({ at: p + 24, bytes: wide(e.name) }, { at: p + 32, bytes: e.data },
            { at: p + 40, bytes: e.url === null ? new Uint8Array() : Uint8Array.from([...e.url].map(ch => ch.charCodeAt(0)).concat(0)) });
    }
    if (info.members.some(m => [m.player, m.group, m.version, m.unused].some(n => !uint(n)))) throw new RangeError("Invalid membership fields");
    const size = fixed + fields.reduce((n, f) => n + f.bytes.length, 0);
    if (size + 4 > NATIVE_CORE_MAX_MESSAGE) throw new RangeError("Core snapshot exceeds message bound");
    const out = new Uint8Array(size + 4), view = new DataView(out.buffer), set = (offset: number, value: number) => view.setUint32(4 + offset, value, true);
    view.setUint32(0, 0xc2, true); [80, a.flags, a.maxPlayers, a.players].forEach((n, i) => set(8 + i * 4, n));
    out.set(Uint8Array.from(a.instance.match(/../g)!, b => parseInt(b, 16)), 60);
    out.set(Uint8Array.from(a.application.match(/../g)!, b => parseInt(b, 16)), 76);
    [info.localId, info.version, info.unused, count, members].forEach((n, i) => set(88 + i * 4, n));
    info.entries.forEach((e, i) => [e.id, e.owner, e.flags, e.version, e.unused, e.coreVersion].forEach((n, j) => set(108 + i * 48 + j * 4, n)));
    info.members.forEach((m, i) => [m.player, m.group, m.version, m.unused].forEach((n, j) => set(108 + count * 48 + i * 16 + j * 4, n)));
    let tail = size;
    for (const field of fields) if (field.bytes.length) { tail -= field.bytes.length; out.set(field.bytes, 4 + tail); set(field.at, tail); set(field.at + 4, field.bytes.length); }
    return out;
}
export function decodeNativeCoreConnectInfo(bytes: Uint8Array): NativeCoreConnectInfo | null {
    try {
        const r = body(bytes, 0xc2, 108), count = r.u32(100), members = r.u32(104);
        if (count > 4096 || members > 65536) return null;
        const minimum = 108 + count * 48 + members * 16; if (minimum > r.bytes.length) return null; r.minimum = minimum;
        const application: NativeCoreApplication = { flags: r.u32(12), maxPlayers: r.u32(16), players: r.u32(20),
            name: r.wide(24), password: r.wide(32), reserved: r.blob(40), applicationData: r.blob(48), instance: r.guid(56), application: r.guid(72) };
        const entries: NativeNameTableEntry[] = [], memberships: NativeCoreConnectInfo["members"] = [], ids = new Set<number>();
        for (let i = 0; i < count; i++) {
            const p = 108 + i * 48, id = r.u32(p); if (ids.has(id)) return null; ids.add(id);
            entries.push({ id, owner: r.u32(p + 4), flags: r.u32(p + 8), version: r.u32(p + 12), unused: r.u32(p + 16), coreVersion: r.u32(p + 20),
                name: r.wide(p + 24), data: r.blob(p + 32), url: r.ansi(p + 40) });
        }
        for (let i = 0; i < members; i++) { const p = 108 + count * 48 + i * 16; memberships.push({ player: r.u32(p), group: r.u32(p + 4), version: r.u32(p + 8), unused: r.u32(p + 12) }); }
        return { reply: r.blob(0), application, localId: r.u32(88), version: r.u32(92), unused: r.u32(96), entries, members: memberships };
    } catch { return null; }
}
