/**
 * Unpack codecs — thin WASM wrapper.
 *
 * Shared native-decoder backend for the installer/archive format parsers (Inno LZMA1/LZMA2,
 * FreeArc srep). One small Rust crate (`tools/build-unpack-streaming`) → `public/unpack-streaming.wasm`.
 * ABI must match `tools/build-unpack-streaming/src/lib.rs`.
 */

export const UNPACK_STORE = 0;
export const UNPACK_LZMA1 = 1;
export const UNPACK_LZMA2 = 2;
export const UNPACK_SREP = 3;

/** Legacy constant — JS no longer allocates transfer buffers; Rust uses global allocator. */
export const UNPACK_TRANSFER_BUF_SIZE = 256 * 1024;

export class UnpackError extends Error {
    constructor(
        message: string,
        readonly code: number,
    ) {
        super(message);
        this.name = "UnpackError";
    }
}

type UnpackExports = {
    memory: WebAssembly.Memory;
    unpack_alloc: (size: number) => number;
    unpack_free: (ptr: number, size: number) => void;
    unpack_decode: (kind: number, propsPtr: number, propsLen: number) => number;
    rar_ppm_new: (ptr: number, len: number) => number;
    rar_ppm_block: (handle: number, offset: number, output: number, base: number, capacity: number) => number;
    rar_ppm_position: (handle: number) => number;
    rar_ppm_written: (handle: number) => number;
    rar_ppm_free: (handle: number) => void;
};

import { BufferSource, type RandomAccessSource } from "./source";

interface DecodeSession {
    input: RandomAccessSource;
    cursor: number;
    output: Uint8Array[];
    outputLen: number;
}

let wasmMemory: WebAssembly.Memory | null = null;
let activeSession: DecodeSession | null = null;
let streamWriteCallback: ((bytes: Uint8Array) => boolean) | null = null;

const IMPORTS: WebAssembly.Imports = {
    env: {
        unpack_read(ptr: number, cap: number): number {
            const s = activeSession;
            const mem = wasmMemory;
            if (!s || !mem) return 0;
            const remaining = s.input.size - s.cursor;
            if (remaining <= 0) return 0;
            const n = Math.min(cap, remaining, UNPACK_TRANSFER_BUF_SIZE);
            const bytes = s.input.readRangeSync(s.cursor, s.cursor + n);
            if (bytes.length !== n) throw new UnpackError("truncated compressed input", -3);
            new Uint8Array(mem.buffer).set(bytes, ptr);
            s.cursor += n;
            return n;
        },
        unpack_write(ptr: number, len: number): number {
            const mem = wasmMemory;
            if (!mem) return 0;
            // Copy immediately — wasm memory may grow and detach views before the callee returns.
            const chunk = new Uint8Array(mem.buffer, ptr, len).slice();
            if (streamWriteCallback) {
                return streamWriteCallback(chunk) ? len : 0;
            }
            const s = activeSession;
            if (!s) return 0;
            s.output.push(chunk);
            s.outputLen += len;
            return len;
        },
    },
};

function concatOutput(chunks: Uint8Array[], total: number): Uint8Array {
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
    }
    return out;
}

function decodeError(code: number): never {
    const messages: Record<number, string> = {
        [-1]: "unknown decode kind",
        [-2]: "invalid LZMA props",
        [-3]: "decode failed",
        [-4]: "output write aborted",
        [-5]: "invalid srep stream",
        [-6]: "unsupported RAR29 PPM framing or model size",
        [-8]: "RAR29 PPM VM programs are unsupported",
    };
    throw new UnpackError(messages[code] ?? `unpack_decode failed (code=${code})`, code);
}

export class UnpackDecoder {
    private instance: WebAssembly.Instance | null = null;
    private exports: UnpackExports | null = null;
    private loadPromise: Promise<void> | null = null;

    /** Load WASM from bytes (worker: fetch; CLI: readFile). */
    async init(wasmBytes: ArrayBuffer): Promise<void> {
        if (this.instance) return;
        if (this.loadPromise) return this.loadPromise;
        this.loadPromise = this._load(wasmBytes);
        return this.loadPromise;
    }

    private async _load(wasmBytes: ArrayBuffer): Promise<void> {
        try {
            const result = await WebAssembly.instantiate(wasmBytes, IMPORTS);
            this.instance = result.instance;
            this.exports = this.instance.exports as unknown as UnpackExports;
            wasmMemory = this.exports.memory;
        } catch (e) {
            this.loadPromise = null;
            throw e;
        }
    }

    private exp(): UnpackExports {
        if (!this.exports) throw new Error("UnpackDecoder not initialized");
        return this.exports;
    }

    private memView(): Uint8Array {
        return new Uint8Array(this.exp().memory.buffer);
    }

    /** PPMd state survives coding-table switches; the caller owns the unfiltered LZ dictionary. */
    createRarPpmSession(input: Uint8Array): import('../rar/lz29').RarPpmSession {
        const exp = this.exp();
        if (!exp.rar_ppm_new) throw new Error('RAR PPMd requires a rebuilt unpack-streaming.wasm');
        const ptr = exp.unpack_alloc(input.length);
        if (!ptr) throw new UnpackError('RAR PPM input allocation failed', -99);
        let handle: number;
        try { this.memView().set(input, ptr); handle = exp.rar_ppm_new(ptr, input.length); }
        finally { exp.unpack_free(ptr, input.length); }
        return {
            decodeBlock: (offset, output, base) => {
                if (!handle) throw new Error('RAR PPM session is closed');
                const outPtr = exp.unpack_alloc(Math.max(1, output.length));
                if (!outPtr) throw new UnpackError('RAR PPM output allocation failed', -99);
                try {
                    this.memView().set(output.subarray(0, base), outPtr);
                    const status = exp.rar_ppm_block(handle, offset, outPtr, base, output.length);
                    if (status < 0) decodeError(status);
                    const written = exp.rar_ppm_written(handle), consumed = exp.rar_ppm_position(handle);
                    if (written < base || written > output.length || consumed <= offset || consumed > input.length) {
                        throw new Error('RAR PPM: invalid codec extent');
                    }
                    output.set(this.memView().subarray(outPtr + base, outPtr + written), base);
                    return { written, consumed, ended: status === 0 };
                } finally { exp.unpack_free(outPtr, Math.max(1, output.length)); }
            },
            close: () => { if (handle) { exp.rar_ppm_free(handle); handle = 0; } },
        };
    }

    /**
     * Decode a stream, routing decompressed output through `onWrite` (no whole-buffer accumulation).
     */
    decodeToCallback(
        kind: number,
        compressed: Uint8Array,
        onWrite: (bytes: Uint8Array) => boolean,
        props: Uint8Array = new Uint8Array(0),
    ): void {
        this.decodeSourceToCallback(kind, new BufferSource(compressed), onWrite, props);
    }

    /** Pull compressed input by bounded ranges, including multi-gigabyte solid streams. */
    decodeSourceToCallback(
        kind: number,
        source: RandomAccessSource,
        onWrite: (bytes: Uint8Array) => boolean,
        props: Uint8Array = new Uint8Array(0),
    ): void {
        const exp = this.exp();
        wasmMemory = exp.memory;

        let propsPtr = 0;
        if (props.byteLength > 0) {
            propsPtr = exp.unpack_alloc(props.byteLength);
            if (!propsPtr) throw new UnpackError("unpack_alloc props failed", -99);
            this.memView().set(props, propsPtr);
        }

        const sess: DecodeSession = {
            input: source,
            cursor: 0,
            output: [],
            outputLen: 0,
        };
        activeSession = sess;
        let writeAborted = false;
        streamWriteCallback = (bytes: Uint8Array): boolean => {
            if (!onWrite(bytes)) {
                writeAborted = true;
                return false;
            }
            return true;
        };

        let rc = 0;
        try {
            rc = exp.unpack_decode(kind, propsPtr, props.byteLength);
        } finally {
            streamWriteCallback = null;
            activeSession = null;
            if (propsPtr) exp.unpack_free(propsPtr, props.byteLength);
        }

        if (writeAborted) throw new UnpackError("output write aborted", -4);
        if (rc !== 0) decodeError(rc);
    }

    /**
     * Decode a single framed stream to EOF.
     * @param kind UNPACK_STORE | UNPACK_LZMA1 | UNPACK_LZMA2 | UNPACK_SREP
     * @param compressed Raw compressed bytes (props not included for LZMA1)
     * @param props LZMA1: 5 bytes (props + dict LE); LZMA2: 4-byte dict LE; store/srep: empty
     */
    decode(kind: number, compressed: Uint8Array, props: Uint8Array = new Uint8Array(0)): Uint8Array {
        const exp = this.exp();
        wasmMemory = exp.memory;

        let propsPtr = 0;
        if (props.byteLength > 0) {
            propsPtr = exp.unpack_alloc(props.byteLength);
            if (!propsPtr) throw new UnpackError("unpack_alloc props failed", -99);
            this.memView().set(props, propsPtr);
        }

        const sess: DecodeSession = {
            input: new BufferSource(compressed),
            cursor: 0,
            output: [],
            outputLen: 0,
        };
        activeSession = sess;

        let rc = 0;
        try {
            rc = exp.unpack_decode(kind, propsPtr, props.byteLength);
        } finally {
            activeSession = null;
            if (propsPtr) exp.unpack_free(propsPtr, props.byteLength);
        }

        if (rc !== 0) decodeError(rc);
        return concatOutput(sess.output, sess.outputLen);
    }
}
