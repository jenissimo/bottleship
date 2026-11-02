import { NATIVE_CORE_MAX_MESSAGE, type NativeCoreApplication, type NativeNameTableEntry } from "./core-connect-codec";
export interface NativeCoreOperation {
    command: number; id: number; version: number; unused: number;
    player?: number; requesting?: number; handle?: number; reason?: number; mask?: number;
    name?: string | null; data?: Uint8Array; entry?: NativeNameTableEntry; application?: NativeCoreApplication;
}
class Reader {
    readonly view: DataView;
    constructor(readonly bytes: Uint8Array, readonly minimum: number) { if (bytes.length < minimum) throw Error("Short core operation"); this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
    u32(offset: number): number { return this.view.getUint32(offset, true); }
    guid(offset: number): string { if (offset > this.bytes.length - 16) throw Error("Short GUID"); return Array.from(this.bytes.subarray(offset, offset + 16), n => n.toString(16).padStart(2, "0")).join(""); }
    blob(field: number): Uint8Array {
        const offset = this.u32(field), size = this.u32(field + 4);
        if (!size) return new Uint8Array();
        if (offset < this.minimum || size > this.bytes.length || offset > this.bytes.length - size) throw Error("Invalid core extent");
        return this.bytes.slice(offset, offset + size);
    }
    text(field: number, wide: boolean): string | null {
        const bytes = this.blob(field); if (!bytes.length) return null;
        if (wide && (bytes.length < 2 || bytes.length & 1 || bytes.at(-2)) || bytes.at(-1)) throw Error("Invalid core string");
        const view = new DataView(bytes.buffer); let value = "";
        for (let i = 0; i < bytes.length - (wide ? 2 : 1); i += wide ? 2 : 1) {
            const ch = wide ? view.getUint16(i, true) : bytes[i]; if (!ch) break; value += String.fromCharCode(ch);
        }
        return value;
    }
    entry(p = 0): NativeNameTableEntry { return { id: this.u32(p), owner: this.u32(p + 4), flags: this.u32(p + 8), version: this.u32(p + 12), unused: this.u32(p + 16), coreVersion: this.u32(p + 20),
        name: this.text(p + 24, true), data: this.blob(p + 32), url: this.text(p + 40, false) }; }
    application(): NativeCoreApplication { return { flags: this.u32(4), maxPlayers: this.u32(8), players: this.u32(12), name: this.text(16, true), password: this.text(24, true),
        reserved: this.blob(32), applicationData: this.blob(40), instance: this.guid(48), application: this.guid(64) }; }
}
/** Only verified, bounded operations enter the name table. All offsets exclude the command DWORD. */
export function decodeNativeCoreOperation(bytes: Uint8Array): NativeCoreOperation | null {
    if (bytes.length < 4 || bytes.length > NATIVE_CORE_MAX_MESSAGE) return null;
    try {
        const command = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true), body = bytes.subarray(4);
        const sizes: Record<number, number> = { 0xc3: 0, 0xc4: 4, 0xc5: 12, 0xc6: 12, 0xc7: 4, 0xc8: 4, 0xc9: 8, 0xca: 8,
            0xcf: 80, 0xd0: 48, 0xd1: 16, 0xd7: 56, 0xd8: 20, 0xd9: 24, 0xda: 24, 0xdb: 40, 0xde: 8, 0xdf: 8, 0xe0: 4, 0xe1: 4 };
        const size = sizes[command]; if (size === undefined) return null;
        const r = new Reader(body, size), op: NativeCoreOperation = { command, id: 0, version: 0, unused: 0 };
        switch (command) {
            case 0xc3: return op;
            case 0xc4: case 0xc7: case 0xc8: op.id = r.u32(0); return op;
            case 0xc5: op.reason = r.u32(0); op.data = r.blob(4); return op;
            case 0xc6: case 0xd1: op.id = r.u32(0); op.version = r.u32(4); op.unused = r.u32(8); if (command === 0xd1) op.reason = r.u32(12); return op;
            case 0xc9: case 0xca: op.version = r.u32(0); op.unused = r.u32(4); return op;
            case 0xcf: op.application = r.application(); return op;
            case 0xd0: op.entry = r.entry(); op.id = op.entry.id; op.version = op.entry.version; op.unused = op.entry.unused; return op;
            case 0xd7: op.requesting = r.u32(0); op.handle = r.u32(4); op.entry = r.entry(8); op.id = op.entry.id; op.version = op.entry.version; op.unused = op.entry.unused; return op;
            case 0xd8: case 0xd9: case 0xda: {
                op.id = r.u32(0); const p = command === 0xd8 ? 4 : 8; if (p === 8) op.player = r.u32(4);
                op.version = r.u32(p); op.unused = r.u32(p + 4); op.requesting = r.u32(p + 8); op.handle = r.u32(p + 12); return op;
            }
            case 0xdb: op.id = r.u32(0); op.version = r.u32(4); op.unused = r.u32(8); op.mask = r.u32(12);
                op.name = r.text(16, true); op.data = r.blob(24); op.requesting = r.u32(32); op.handle = r.u32(36); return op;
            case 0xde: op.handle = r.u32(0); op.reason = r.u32(4); return op;
            case 0xdf: op.data = r.blob(0); return op;
            case 0xe0: op.handle = r.u32(0); op.data = body.slice(4); return op;
            case 0xe1: op.handle = r.u32(0); return op;
        }
    } catch { /* malformed native peer input is ignored, never an unchecked read */ }
    return null;
}
export function nativeCoreWords(command: number, ...words: number[]): Uint8Array {
    if ([command, ...words].some(n => !Number.isInteger(n) || n < 0 || n > 0xffffffff)) throw new RangeError("Invalid core DWORD");
    const out = new Uint8Array(4 + words.length * 4), view = new DataView(out.buffer);
    [command, ...words].forEach((n, i) => view.setUint32(i * 4, n, true)); return out;
}
export function nativeCoreWide(value: string | null): Uint8Array {
    if (value === null) return new Uint8Array();
    if (value.includes("\0") || value.length > (NATIVE_CORE_MAX_MESSAGE - 2) / 2) throw new RangeError("Invalid core WCHAR string");
    const out = new Uint8Array((value.length + 1) * 2), view = new DataView(out.buffer);
    for (let i = 0; i < value.length; i++) view.setUint16(i * 2, value.charCodeAt(i), true); return out;
}
/** Request completion handle precedes a body whose offsets are relative to that body. */
export function encodeNativeCoreRequest(command: number, handle: number, words: number[], blobs: { field: number; data: Uint8Array }[] = []): Uint8Array {
    const header = words.length * 4, size = header + blobs.reduce((n, b) => n + b.data.length, 0);
    if (size + 8 > NATIVE_CORE_MAX_MESSAGE || blobs.some(b => b.field < 0 || b.field + 8 > header || b.field % 4)) throw new RangeError("Invalid request extent");
    const out = new Uint8Array(size + 8), view = new DataView(out.buffer);
    out.set(nativeCoreWords(command, handle, ...words)); let tail = size;
    for (const blob of blobs) if (blob.data.length) { tail -= blob.data.length; out.set(blob.data, 8 + tail); view.setUint32(8 + blob.field, tail, true); view.setUint32(12 + blob.field, blob.data.length, true); }
    return out;
}

/** NT5 PackEntryInfo for ADD_PLAYER; offsets are relative to the 48-byte body. */
export function encodeNativePlayerAdded(entry: NativeNameTableEntry): Uint8Array {
    const fields = [entry.id, entry.owner, entry.flags, entry.version, entry.unused, entry.coreVersion];
    if (fields.some(n => !Number.isInteger(n) || n < 0 || n > 0xffffffff) ||
        (entry.url !== null && (entry.url.includes("\0") || [...entry.url].some(ch => ch.charCodeAt(0) > 255))))
        throw new RangeError("Invalid player entry");
    const blobs = [nativeCoreWide(entry.name), entry.data,
        entry.url === null ? new Uint8Array() : Uint8Array.from([...entry.url].map(ch => ch.charCodeAt(0)).concat(0))];
    const size = 48 + blobs.reduce((n, b) => n + b.length, 0);
    if (size + 4 > NATIVE_CORE_MAX_MESSAGE) throw new RangeError("Player entry exceeds core bound");
    const out = new Uint8Array(size + 4), view = new DataView(out.buffer);
    out.set(nativeCoreWords(0xd0, ...fields, 0, 0, 0, 0, 0, 0));
    let tail = size;
    for (let i = 0; i < blobs.length; i++) if (blobs[i].length) {
        tail -= blobs[i].length; out.set(blobs[i], 4 + tail);
        view.setUint32(28 + i * 8, tail, true); view.setUint32(32 + i * 8, blobs[i].length, true);
    }
    return out;
}
