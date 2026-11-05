export type SaveValue =
    | null | boolean | number | string
    | Uint8Array | Uint16Array | Uint32Array | Int8Array | Int16Array | Int32Array | Float32Array | Float64Array
    | SaveValue[]
    | { [key: string]: SaveValue };

const TYPED = {
    u8: Uint8Array, u16: Uint16Array, u32: Uint32Array, i8: Int8Array,
    i16: Int16Array, i32: Int32Array, f32: Float32Array, f64: Float64Array,
} as const;
type TypedTag = keyof typeof TYPED;

function typedTag(v: unknown): TypedTag | null {
    for (const tag of Object.keys(TYPED) as TypedTag[]) {
        if (Object.getPrototypeOf(v) === TYPED[tag].prototype) return tag;
    }
    return null;
}

export class SaveValueError extends Error {
    constructor(readonly path: string, what: string) {
        super(`savestate value at ${path || '<root>'}: ${what}`);
    }
}

export interface EncodedValue { json: string; blobs: Uint8Array[] }

export function encodeValue(value: SaveValue): EncodedValue {
    const blobs: Uint8Array[] = [];
    const walk = (v: unknown, path: string): unknown => {
        if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
        if (typeof v === 'number') {
            if (Number.isFinite(v) && !Object.is(v, -0)) return v;
            return { $num: Object.is(v, -0) ? '-0' : String(v) };
        }
        if (typeof v !== 'object') throw new SaveValueError(path, `${typeof v} is not a save value`);
        const tag = typedTag(v);
        if (tag) {
            const t = v as ArrayBufferView;
            blobs.push(new Uint8Array(t.buffer, t.byteOffset, t.byteLength).slice());
            return { $typed: tag, blob: blobs.length - 1 };
        }
        if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`));
        if (Object.getPrototypeOf(v) !== Object.prototype) {
            throw new SaveValueError(path, `${(v as object).constructor?.name ?? 'object'} is not a plain object`);
        }
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) {
            if (k.startsWith('$')) throw new SaveValueError(`${path}.${k}`, 'keys may not start with $');
            if (x === undefined) continue;
            out[k] = walk(x, `${path}.${k}`);
        }
        return out;
    };
    return { json: JSON.stringify(walk(value, '')), blobs };
}

export function decodeValue(encoded: EncodedValue): SaveValue {
    const walk = (v: unknown): SaveValue => {
        if (v === null || typeof v !== 'object') return v as SaveValue;
        if (Array.isArray(v)) return v.map(walk);
        const o = v as Record<string, unknown>;
        if (typeof o.$num === 'string') return o.$num === '-0' ? -0 : Number(o.$num);
        if (typeof o.$typed === 'string') {
            const Ctor = TYPED[o.$typed as TypedTag];
            const blob = encoded.blobs[o.blob as number];
            if (!Ctor || !blob) throw new Error(`savestate value: bad typed array ${o.$typed}/${o.blob}`);
            const copy = blob.slice();
            return new Ctor(copy.buffer, 0, copy.byteLength / Ctor.BYTES_PER_ELEMENT) as SaveValue;
        }
        const out: Record<string, SaveValue> = {};
        for (const [k, x] of Object.entries(o)) out[k] = walk(x);
        return out;
    };
    return walk(JSON.parse(encoded.json));
}
