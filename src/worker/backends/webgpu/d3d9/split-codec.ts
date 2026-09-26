/**
 * Argument codec for the split D3D9 call stream (front device -> render twin).
 *
 * Only plain data crosses: numbers, booleans, null/undefined, strings, typed arrays (COPIED at
 * encode time — the guest may overwrite the source the moment the call returns), plain objects
 * and arrays of those, and references to objects the stream itself created on both sides
 * (`refs`). Anything else throws: a GPU object, a device, or a view over all of guest memory
 * crossing the boundary is a bug to see at the call that did it, not a value to carry.
 */

const T_UNDEFINED = 0;
const T_NULL = 1;
const T_FALSE = 2;
const T_TRUE = 3;
const T_INT = 4;
const T_FLOAT = 5;
const T_STRING = 6;
const T_TYPED = 7;
const T_ARRAY = 8;
const T_OBJECT = 9;
const T_REF = 10;

/** Larger than any single D3D9 payload (a 4096^2 RGBA level is 64 MiB); a view over guest
 *  memory is gigabytes and must never be copied. */
export const SPLIT_MAX_TYPED_BYTES = 64 * 1024 * 1024;

const TYPED_CTORS = [
    Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array,
    Uint8ClampedArray,
] as const;
type TypedCtor = (typeof TYPED_CTORS)[number];

/** Objects created by a recorded call on both sides, keyed by the front's instance. */
export interface SplitRefTable {
    idOf(frontObject: object): number | undefined;
    twinOf(id: number): object | undefined;
}

export class SplitEncoder {
    private buf = new ArrayBuffer(4096);
    private u8 = new Uint8Array(this.buf);
    private dv = new DataView(this.buf);
    private pos = 0;
    private readonly text = new TextEncoder();

    constructor(private readonly refs: SplitRefTable) {}

    reset(): void { this.pos = 0; }
    get length(): number { return this.pos; }
    get bytes(): Uint8Array { return this.u8; }

    private reserve(n: number): void {
        if (this.pos + n <= this.u8.length) return;
        let size = this.u8.length * 2;
        while (size < this.pos + n) size *= 2;
        const next = new ArrayBuffer(size);
        new Uint8Array(next).set(this.u8.subarray(0, this.pos));
        this.buf = next;
        this.u8 = new Uint8Array(next);
        this.dv = new DataView(next);
    }

    private tag(t: number): void { this.reserve(1); this.u8[this.pos++] = t; }
    private u32(v: number): void { this.reserve(4); this.dv.setUint32(this.pos, v >>> 0, true); this.pos += 4; }

    value(v: unknown, path = "arg"): void {
        if (v === undefined) { this.tag(T_UNDEFINED); return; }
        if (v === null) { this.tag(T_NULL); return; }
        switch (typeof v) {
            case "boolean": this.tag(v ? T_TRUE : T_FALSE); return;
            case "number":
                if (Number.isInteger(v) && v >= -0x80000000 && v <= 0xffffffff) {
                    this.tag(T_INT);
                    this.reserve(5);
                    this.u8[this.pos++] = v < 0 ? 1 : 0;
                    this.dv.setUint32(this.pos, v >>> 0, true);
                    this.pos += 4;
                } else {
                    this.tag(T_FLOAT);
                    this.reserve(8);
                    this.dv.setFloat64(this.pos, v, true);
                    this.pos += 8;
                }
                return;
            case "string": {
                const bytes = this.text.encode(v);
                this.tag(T_STRING);
                this.u32(bytes.length);
                this.reserve(bytes.length);
                this.u8.set(bytes, this.pos);
                this.pos += bytes.length;
                return;
            }
            case "object": break;
            default: throw new Error(`split codec: ${path} is a ${typeof v}, which cannot cross the call stream`);
        }
        const obj = v as object;
        if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
            const kind = TYPED_CTORS.findIndex((C) => obj instanceof C);
            if (kind < 0) throw new Error(`split codec: ${path} is an unsupported typed array`);
            const view = obj as unknown as { byteLength: number; byteOffset: number; buffer: ArrayBufferLike };
            if (view.byteLength > SPLIT_MAX_TYPED_BYTES) {
                throw new Error(`split codec: ${path} is a ${view.byteLength}-byte view (guest memory?) — capture the range instead`);
            }
            this.tag(T_TYPED);
            this.reserve(1);
            this.u8[this.pos++] = kind;
            this.u32(view.byteLength);
            this.reserve(view.byteLength);
            this.u8.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), this.pos);
            this.pos += view.byteLength;
            return;
        }
        const ref = this.refs.idOf(obj);
        if (ref !== undefined) { this.tag(T_REF); this.u32(ref); return; }
        if (Array.isArray(obj)) {
            this.tag(T_ARRAY);
            this.u32(obj.length);
            for (let i = 0; i < obj.length; i++) this.value(obj[i], `${path}[${i}]`);
            return;
        }
        const proto = Object.getPrototypeOf(obj);
        if (proto !== Object.prototype && proto !== null) {
            throw new Error(`split codec: ${path} is a ${proto?.constructor?.name ?? "class"} instance that no recorded call created`);
        }
        const keys = Object.keys(obj);
        this.tag(T_OBJECT);
        this.u32(keys.length);
        for (const k of keys) {
            this.value(k, `${path}.<key>`);
            this.value((obj as Record<string, unknown>)[k], `${path}.${k}`);
        }
    }
}

export class SplitDecoder {
    private dv: DataView;
    private pos: number;
    private readonly text = new TextDecoder();

    constructor(private readonly u8: Uint8Array, start: number, private readonly end: number,
        private readonly refs: SplitRefTable) {
        this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        this.pos = start;
    }

    get done(): boolean { return this.pos >= this.end; }

    private u32(): number { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }

    value(): unknown {
        const t = this.u8[this.pos++];
        switch (t) {
            case T_UNDEFINED: return undefined;
            case T_NULL: return null;
            case T_FALSE: return false;
            case T_TRUE: return true;
            case T_INT: {
                const neg = this.u8[this.pos++] === 1;
                const raw = this.u32();
                return neg ? raw | 0 : raw;
            }
            case T_FLOAT: { const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return v; }
            case T_STRING: {
                const n = this.u32();
                const s = this.text.decode(this.u8.subarray(this.pos, this.pos + n));
                this.pos += n;
                return s;
            }
            case T_TYPED: {
                const Ctor: TypedCtor = TYPED_CTORS[this.u8[this.pos++]];
                const n = this.u32();
                const copy = this.u8.slice(this.pos, this.pos + n);
                this.pos += n;
                return new Ctor(copy.buffer, 0, n / Ctor.BYTES_PER_ELEMENT);
            }
            case T_ARRAY: {
                const n = this.u32();
                const out = new Array(n);
                for (let i = 0; i < n; i++) out[i] = this.value();
                return out;
            }
            case T_OBJECT: {
                const n = this.u32();
                const out: Record<string, unknown> = {};
                for (let i = 0; i < n; i++) {
                    const k = this.value() as string;
                    out[k] = this.value();
                }
                return out;
            }
            case T_REF: {
                const id = this.u32();
                const twin = this.refs.twinOf(id);
                if (twin === undefined) throw new Error(`split codec: reference #${id} has no twin object`);
                return twin;
            }
            default: throw new Error(`split codec: bad tag ${t} at ${this.pos - 1}`);
        }
    }
}
