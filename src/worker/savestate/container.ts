import { decodeValue, encodeValue, type SaveValue } from './value-codec';
import { validateRamManifest, type RamManifest } from './ram';

export const CONTAINER_MAGIC = 0x56535342;
export const CONTAINER_VERSION = 1;

export interface ParticipantSchema {
    version: number;
    schemaHash: string;
}

export interface CompatibilityKey {
    buildSha: string;
    contentHash: string;
    configHash: string;
    bootLayout: string;
    participants: Record<string, ParticipantSchema>;
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

export class SavestateFormatError extends Error {}

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
        if (this.off + 4 > this.buf.byteLength) throw new SavestateFormatError('savestate: truncated');
        const n = this.view.getUint32(this.off, true);
        this.off += 4;
        return n;
    }
    blob(): Uint8Array {
        const len = this.u32();
        if (this.off + len > this.buf.byteLength) throw new SavestateFormatError('savestate: truncated');
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

const isRecord = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v);

function checkString(v: unknown, what: string): void {
    if (typeof v !== 'string') throw new SavestateFormatError(`savestate: ${what} is not a string`);
}

export function validateHeader(value: unknown): SavestateHeader {
    if (!isRecord(value)) throw new SavestateFormatError('savestate: header is not an object');
    const key = value.key;
    if (!isRecord(key)) throw new SavestateFormatError('savestate: compatibility key is not an object');
    for (const field of ['buildSha', 'contentHash', 'configHash', 'bootLayout'] as const) checkString(key[field], field);
    if (!isRecord(key.participants)) throw new SavestateFormatError('savestate: participants is not an object');
    for (const [name, p] of Object.entries(key.participants)) {
        if (!isRecord(p) || typeof p.version !== 'number' || !Number.isInteger(p.version) || typeof p.schemaHash !== 'string') {
            throw new SavestateFormatError(`savestate: participant ${name} has a bad schema entry`);
        }
    }
    checkString(value.overlay, 'overlay');
    checkString(value.gameId, 'gameId');
    if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) throw new SavestateFormatError('savestate: createdAt is not a number');
    try { validateRamManifest(value.ram); } catch (e) { throw new SavestateFormatError(`savestate: ${(e as Error).message}`); }
    return value as unknown as SavestateHeader;
}

export function decodeSavestate(bytes: Uint8Array): Savestate {
    try {
        const r = new Reader(bytes);
        if (r.u32() !== CONTAINER_MAGIC) throw new SavestateFormatError('savestate: not a savestate');
        const version = r.u32();
        if (version !== CONTAINER_VERSION) throw new SavestateFormatError(`savestate: container version ${version}`);
        const header = validateHeader(readValue(r));
        const sections = new Map<string, SaveValue>();
        const count = r.u32();
        for (let i = 0; i < count; i++) {
            const name = r.text();
            if (sections.has(name)) throw new SavestateFormatError(`savestate: section ${name} twice`);
            sections.set(name, readValue(r));
        }
        if (!r.done) throw new SavestateFormatError('savestate: trailing bytes');
        return { header, sections };
    } catch (e) {
        if (e instanceof SavestateFormatError) throw e;
        throw new SavestateFormatError(`savestate: unreadable (${(e as Error).message})`);
    }
}

export function incompatibilities(saved: CompatibilityKey, current: CompatibilityKey): string[] {
    const out: string[] = [];
    for (const field of ['buildSha', 'contentHash', 'configHash', 'bootLayout'] as const) {
        if (saved[field] !== current[field]) out.push(`${field} differs`);
    }
    for (const [name, then] of Object.entries(saved.participants)) {
        const now = Object.prototype.hasOwnProperty.call(current.participants, name) ? current.participants[name] : undefined;
        if (now === undefined) out.push(`participant ${name} is unknown to this build`);
        else if (now.version !== then.version) out.push(`participant ${name} is v${now.version}, snapshot has v${then.version}`);
        else if (now.schemaHash !== then.schemaHash) out.push(`participant ${name} has a different schema`);
    }
    for (const name of Object.keys(current.participants)) {
        if (!Object.prototype.hasOwnProperty.call(saved.participants, name)) out.push(`participant ${name} is missing from the snapshot`);
    }
    return out;
}
