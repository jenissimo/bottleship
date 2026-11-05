import { decodeValue, encodeValue, type SaveValue } from './value-codec';
import type { RamManifest } from './ram';

export const CONTAINER_MAGIC = 0x56535342;
export const CONTAINER_VERSION = 1;

export interface CompatibilityKey {
    buildSha: string;
    bundleHash: string;
    configHash: string;
    bootLayout: string;
    participants: Record<string, number>;
}

export interface SavestateHeader {
    key: CompatibilityKey;
    overlay: string;
    createdAt: number;
    gameId: string;
    ram: RamManifest;
}

export interface Savestate {
    header: SavestateHeader;
    sections: Map<string, SaveValue>;
}

class Writer {
    private parts: Uint8Array[] = [];
    private size = 0;
    u32(n: number): void { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); this.bytes(b); }
    bytes(b: Uint8Array): void { this.parts.push(b); this.size += b.byteLength; }
    blob(b: Uint8Array): void { this.u32(b.byteLength); this.bytes(b); }
    text(s: string): void { this.blob(new TextEncoder().encode(s)); }
    finish(): Uint8Array {
        const out = new Uint8Array(this.size);
        let off = 0;
        for (const p of this.parts) { out.set(p, off); off += p.byteLength; }
        return out;
    }
}

class Reader {
    private off = 0;
    private readonly view: DataView;
    constructor(private readonly buf: Uint8Array) { this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
    u32(): number {
        if (this.off + 4 > this.buf.byteLength) throw new Error('savestate: truncated');
        const n = this.view.getUint32(this.off, true);
        this.off += 4;
        return n;
    }
    blob(): Uint8Array {
        const len = this.u32();
        if (this.off + len > this.buf.byteLength) throw new Error('savestate: truncated');
        const b = this.buf.subarray(this.off, this.off + len);
        this.off += len;
        return b;
    }
    text(): string { return new TextDecoder('utf-8', { fatal: true }).decode(this.blob()); }
    get done(): boolean { return this.off === this.buf.byteLength; }
}

function writeValue(w: Writer, value: SaveValue): void {
    const { json, blobs } = encodeValue(value);
    w.text(json);
    w.u32(blobs.length);
    for (const b of blobs) w.blob(b);
}

function readValue(r: Reader): SaveValue {
    const json = r.text();
    const count = r.u32();
    const blobs: Uint8Array[] = [];
    for (let i = 0; i < count; i++) blobs.push(r.blob());
    return decodeValue({ json, blobs });
}

export function encodeSavestate(state: Savestate): Uint8Array {
    const w = new Writer();
    w.u32(CONTAINER_MAGIC);
    w.u32(CONTAINER_VERSION);
    writeValue(w, state.header as unknown as SaveValue);
    w.u32(state.sections.size);
    for (const [name, value] of state.sections) {
        w.text(name);
        writeValue(w, value);
    }
    return w.finish();
}

export function decodeSavestate(bytes: Uint8Array): Savestate {
    const r = new Reader(bytes);
    if (r.u32() !== CONTAINER_MAGIC) throw new Error('savestate: not a savestate');
    const version = r.u32();
    if (version !== CONTAINER_VERSION) throw new Error(`savestate: container version ${version}`);
    const header = readValue(r) as unknown as SavestateHeader;
    const sections = new Map<string, SaveValue>();
    const count = r.u32();
    for (let i = 0; i < count; i++) {
        const name = r.text();
        if (sections.has(name)) throw new Error(`savestate: section ${name} twice`);
        sections.set(name, readValue(r));
    }
    if (!r.done) throw new Error('savestate: trailing bytes');
    return { header, sections };
}

export function incompatibilities(saved: CompatibilityKey, current: CompatibilityKey): string[] {
    const out: string[] = [];
    for (const field of ['buildSha', 'bundleHash', 'configHash', 'bootLayout'] as const) {
        if (saved[field] !== current[field]) out.push(`${field} differs`);
    }
    for (const [name, version] of Object.entries(saved.participants)) {
        const now = current.participants[name];
        if (now === undefined) out.push(`participant ${name} is unknown to this build`);
        else if (now !== version) out.push(`participant ${name} is v${now}, snapshot has v${version}`);
    }
    for (const name of Object.keys(current.participants)) {
        if (!(name in saved.participants)) out.push(`participant ${name} is missing from the snapshot`);
    }
    return out;
}
