/**
 * Plain-data values for savestate sections, encoded as JSON plus binary blobs.
 *
 * - Object keys are written sorted, so a value encodes to the same bytes whatever order its
 *   keys were built in.
 * - Typed arrays become blobs in host byte order, which is little-endian on every target,
 *   like the container itself.
 * - A shared, non-cyclic reference is written once per place it appears; a cycle is refused.
 * - `undefined` is dropped from objects and refused in arrays; holes in a sparse array come
 *   back as `null`.
 * - Plain objects and null-prototype objects are accepted; both decode as plain objects.
 *   Arrays must be plain arrays.
 */
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

const MAX_DEPTH = 1000;

const SPECIAL_NUMBERS: Readonly<Record<string, number>> = { '-0': -0, NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity };

function typedTag(v: unknown): TypedTag | null {
    for (const tag of Object.keys(TYPED) as TypedTag[]) {
        if (Object.getPrototypeOf(v) === TYPED[tag].prototype) return tag;
    }
    return null;
}

function isTypedTag(tag: unknown): tag is TypedTag {
    return typeof tag === 'string' && Object.prototype.hasOwnProperty.call(TYPED, tag);
}

export class SaveValueError extends Error {
    constructor(readonly path: string, what: string) {
        super(`savestate value at ${path || '<root>'}: ${what}`);
    }
}

export interface EncodedValue { json: string; blobs: Uint8Array[] }

export function encodeValue(value: SaveValue): EncodedValue {
    const blobs: Uint8Array[] = [];
    const ancestors = new Set<object>();
    const walk = (v: unknown, path: string): unknown => {
        if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
        if (ancestors.size >= MAX_DEPTH) throw new SaveValueError(path, `nested deeper than ${MAX_DEPTH}`);
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
        if (ancestors.has(v)) throw new SaveValueError(path, 'cycle');
        ancestors.add(v);
        try {
            if (Array.isArray(v)) {
                if (Object.getPrototypeOf(v) !== Array.prototype) throw new SaveValueError(path, `${v.constructor?.name ?? 'array'} is not a plain array`);
                const arr: unknown[] = [];
                for (let i = 0; i < v.length; i++) {
                    if (i in v && v[i] === undefined) throw new SaveValueError(`${path}[${i}]`, 'undefined in an array');
                    arr.push(i in v ? walk(v[i], `${path}[${i}]`) : null);
                }
                return arr;
            }
            const proto = Object.getPrototypeOf(v);
            if (proto !== Object.prototype && proto !== null) {
                throw new SaveValueError(path, `${(v as object).constructor?.name ?? 'object'} is not a plain object`);
            }
            const out: Record<string, unknown> = Object.create(null);
            for (const k of Object.keys(v).sort()) {
                if (k.startsWith('$')) throw new SaveValueError(`${path}.${k}`, 'keys may not start with $');
                if (k === '__proto__') throw new SaveValueError(`${path}.${k}`, 'the key __proto__ is not allowed');
                const x = (v as Record<string, unknown>)[k];
                if (x === undefined) continue;
                out[k] = walk(x, `${path}.${k}`);
            }
            return out;
        } finally {
            ancestors.delete(v);
        }
    };
    return { json: JSON.stringify(walk(value, '')), blobs };
}

export function decodeValue(encoded: EncodedValue): SaveValue {
    const tagged = (o: Record<string, unknown>, path: string, keys: readonly string[]) => {
        for (const k of Object.keys(o)) if (!keys.includes(k)) throw new SaveValueError(`${path}.${k}`, 'unexpected key on a tagged value');
    };
    const walk = (v: unknown, path: string, depth: number): SaveValue => {
        if (v === null || typeof v !== 'object') return v as SaveValue;
        if (depth >= MAX_DEPTH) throw new SaveValueError(path, `nested deeper than ${MAX_DEPTH}`);
        if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`, depth + 1));
        const o = v as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(o, '$num')) {
            tagged(o, path, ['$num']);
            const n = o.$num;
            if (typeof n !== 'string' || !Object.prototype.hasOwnProperty.call(SPECIAL_NUMBERS, n)) {
                throw new SaveValueError(path, `bad number ${String(n)}`);
            }
            return SPECIAL_NUMBERS[n]!;
        }
        if (Object.prototype.hasOwnProperty.call(o, '$typed')) {
            tagged(o, path, ['$typed', 'blob']);
            const index = o.blob;
            if (!isTypedTag(o.$typed) || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= encoded.blobs.length) {
                throw new SaveValueError(path, `bad typed array ${String(o.$typed)}/${String(index)}`);
            }
            const Ctor = TYPED[o.$typed];
            const blob = encoded.blobs[index]!;
            if (blob.byteLength % Ctor.BYTES_PER_ELEMENT !== 0) {
                throw new SaveValueError(path, `${blob.byteLength} bytes is not a whole number of ${o.$typed} elements`);
            }
            const copy = blob.slice();
            return new Ctor(copy.buffer, 0, copy.byteLength / Ctor.BYTES_PER_ELEMENT) as SaveValue;
        }
        const out: Record<string, SaveValue> = {};
        for (const k of Object.keys(o)) {
            if (k === '__proto__' || k.startsWith('$')) throw new SaveValueError(`${path}.${k}`, 'reserved key');
            out[k] = walk(o[k], `${path}.${k}`, depth + 1);
        }
        return out;
    };
    return walk(JSON.parse(encoded.json), '', 0);
}
