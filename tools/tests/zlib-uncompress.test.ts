/**
 * zlib `uncompress` kernel — the guest-facing contract (return codes, the
 * *destLen out-param, the declared write surface) over both shadow views.
 *
 * The RE-verified semantics it must reproduce are in
 * src/worker/core/hle-lib/libs/zlib/descriptor.ts; the return codes are zlib's
 * own Z_OK / Z_BUF_ERROR / Z_DATA_ERROR / Z_NEED_DICT.
 */

import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { __test } from '../../src/worker/core/hle-lib/libs/zlib/descriptor';
import { LiveShadowView, ScratchShadowView } from '../../src/worker/core/hle-lib/shadow-validator';
import {
    DEST_CHUNK,
    Z_BUF_ERROR,
    Z_DATA_ERROR,
    Z_MEM_ERROR,
    Z_NEED_DICT,
    Z_OK,
    uncompressGuard,
    uncompressKernel,
    uncompressRanges,
} from '../../src/worker/core/hle-lib/libs/zlib/kernel';

const MEM = 0x100000;
const DEST = 0x10000;
const DEST_LEN_PTR = 0x8000;
const SRC = 0x60000;

function payload(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (i * 31 + (i >> 5)) & 0xff;
    return out;
}

interface Fixture {
    mem: Uint8Array;
    args: number[];
    data: Uint8Array;
    comp: Uint8Array;
}

function fixture(data: Uint8Array, cap = data.length, comp?: Uint8Array): Fixture {
    const mem = new Uint8Array(MEM);
    const c = comp ?? new Uint8Array(deflateSync(data));
    mem.set(c, SRC);
    new DataView(mem.buffer).setUint32(DEST_LEN_PTR, cap, true);
    return { mem, args: [DEST, DEST_LEN_PTR, SRC, c.length], data, comp: c };
}

describe('live view (production path)', () => {
    test('complete stream → Z_OK, bytes written, *destLen = total_out', () => {
        const data = payload(20_000);
        const f = fixture(data);
        const ret = uncompressKernel(new LiveShadowView(f.mem), f.args);
        expect(ret).toBe(Z_OK);
        expect(f.mem.subarray(DEST, DEST + data.length)).toEqual(data);
        expect(new DataView(f.mem.buffer).getUint32(DEST_LEN_PTR, true)).toBe(data.length);
    });

    test('destination too small → Z_BUF_ERROR, *destLen untouched', () => {
        const data = payload(20_000);
        const f = fixture(data, 500);
        const ret = uncompressKernel(new LiveShadowView(f.mem), f.args);
        expect(ret).toBe(Z_BUF_ERROR);
        expect(new DataView(f.mem.buffer).getUint32(DEST_LEN_PTR, true)).toBe(500);
    });

    test('truncated source → Z_BUF_ERROR', () => {
        const data = payload(20_000);
        const f = fixture(data);
        f.args[3] = f.comp.length >> 1;
        expect(uncompressKernel(new LiveShadowView(f.mem), f.args)).toBe(Z_BUF_ERROR);
    });

    test('corrupt stream → Z_DATA_ERROR', () => {
        const data = payload(20_000);
        const f = fixture(data);
        f.mem[SRC + f.comp.length - 1] ^= 0xff; // adler
        expect(uncompressKernel(new LiveShadowView(f.mem), f.args)).toBe(Z_DATA_ERROR);
    });

    test('preset dictionary → Z_NEED_DICT', () => {
        const data = payload(4000);
        const comp = new Uint8Array(deflateSync(data, { dictionary: new TextEncoder().encode('dict') }));
        const f = fixture(data, data.length, comp);
        expect(uncompressKernel(new LiveShadowView(f.mem), f.args)).toBe(Z_NEED_DICT);
    });

    test('zero-length payload round-trips', () => {
        const f = fixture(new Uint8Array(0), 0);
        expect(uncompressKernel(new LiveShadowView(f.mem), f.args)).toBe(Z_OK);
        expect(new DataView(f.mem.buffer).getUint32(DEST_LEN_PTR, true)).toBe(0);
    });

    test('trace callback reports the outcome for the log line', () => {
        const data = payload(1024);
        const f = fixture(data);
        let seen: { status: string; ret: number } | null = null;
        uncompressKernel(new LiveShadowView(f.mem), f.args,
            t => { seen = { status: t.outcome.status, ret: t.ret }; });
        expect(seen).toEqual({ status: 'ok', ret: Z_OK });
    });
});

describe('scratch view (shadow path)', () => {
    test('writes stay inside the declared ranges and leave guest memory alone', () => {
        const data = payload(30_000);
        const f = fixture(data);
        const live = new LiveShadowView(f.mem);
        const ranges = uncompressRanges(live, f.args);
        const before = f.mem.slice();

        const scratch = new ScratchShadowView(f.mem, ranges);
        const ret = uncompressKernel(scratch, f.args);

        expect(ret).toBe(Z_OK);
        expect(scratch.outOfContractWrite).toBeNull();
        expect(f.mem).toEqual(before);
        // ranges[0] is *destLen, the rest are the chunked destination.
        expect(new DataView(scratch.scratch[0].buffer, scratch.scratch[0].byteOffset).getUint32(0, true))
            .toBe(data.length);
        expect(scratch.scratch[1].subarray(0, data.length)).toEqual(data);
    });

    test('bytes past the produced output keep their pre-call value', () => {
        const data = payload(1000);
        const f = fixture(data, 4000);
        f.mem.fill(0x5a, DEST, DEST + 4000);
        const ranges = uncompressRanges(new LiveShadowView(f.mem), f.args);
        const scratch = new ScratchShadowView(f.mem, ranges);
        expect(uncompressKernel(scratch, f.args)).toBe(Z_OK);
        // Untouched tail compares equal to live memory for free — the property
        // that lets the hook declare one conservative destination span.
        expect(scratch.scratch[1].subarray(1000)).toEqual(f.mem.subarray(DEST + 1000, DEST + 4000));
    });
});

describe('ranges and guard', () => {
    const view = (cap: number) => {
        const mem = new Uint8Array(MEM);
        new DataView(mem.buffer).setUint32(DEST_LEN_PTR, cap, true);
        return new LiveShadowView(mem);
    };

    test('destination is chunked below the validator per-range ceiling', () => {
        const cap = DEST_CHUNK * 2 + 5;
        const r = uncompressRanges(view(cap), [DEST, DEST_LEN_PTR, SRC, 16]);
        expect(r[0]).toEqual({ addr: DEST_LEN_PTR, len: 4 });
        expect(r.slice(1)).toEqual([
            { addr: DEST, len: DEST_CHUNK },
            { addr: DEST + DEST_CHUNK, len: DEST_CHUNK },
            { addr: DEST + DEST_CHUNK * 2, len: 5 },
        ]);
        expect(r.every(x => x.len <= 0x1000000)).toBe(true);
    });

    test('guard rejects null pointers, empty spans and absurd sizes', () => {
        const v = view(4096);
        expect(uncompressGuard(v, [DEST, DEST_LEN_PTR, SRC, 100])).toBe(true);
        expect(uncompressGuard(v, [0, DEST_LEN_PTR, SRC, 100])).toBe(false);
        expect(uncompressGuard(v, [DEST, 0, SRC, 100])).toBe(false);
        expect(uncompressGuard(v, [DEST, DEST_LEN_PTR, 0, 100])).toBe(false);
        expect(uncompressGuard(v, [DEST, DEST_LEN_PTR, SRC, 0])).toBe(false);
        expect(uncompressGuard(v, [DEST, DEST_LEN_PTR, SRC, 0x8000000])).toBe(false);
        expect(uncompressGuard(view(0), [DEST, DEST_LEN_PTR, SRC, 100])).toBe(false);
        expect(uncompressGuard(view(0x8000000), [DEST, DEST_LEN_PTR, SRC, 100])).toBe(false);
    });
});

/**
 * Address resolution. `uncompress` and `compress2` are near-identical bodies
 * that both push ZLIB_VERSION; the only stable discriminator is the cdecl
 * cleanup of their init call (inflateInit_ takes 3 args, deflateInit_ 4).
 */
describe('uncompress shape classifier', () => {
    const BASE = 0x401000;
    const VER = 0x520ebc;
    const INIT = 0x408550;
    const CODEC = 0x408570;
    const END = 0x408400;

    /** Emit a zlib one-shot wrapper; `initCleanup` selects inflate vs deflate. */
    function emit(text: Uint8Array, off: number, initCleanup: number): number {
        const w = (...bytes: number[]) => { for (const b of bytes) text[off++] = b; };
        const call = (target: number) => {
            const rel = target - (BASE + off + 5);
            w(0xe8, rel & 0xff, (rel >> 8) & 0xff, (rel >> 16) & 0xff, (rel >> 24) & 0xff);
        };
        w(0xcc);                                    // padding: the prologue anchor
        const entry = off;
        w(0x83, 0xec, 0x38);                        // sub esp,0x38
        w(0x6a, 0x38);                              // push sizeof(z_stream)
        w(0x68, VER & 0xff, (VER >> 8) & 0xff, (VER >> 16) & 0xff, (VER >> 24) & 0xff);
        call(INIT);
        w(0x83, 0xc4, initCleanup);
        w(0x6a, 0x04);                              // push Z_FINISH
        call(CODEC);
        w(0x8b, 0xf0);                              // mov esi,eax
        w(0x83, 0xc4, 0x08);
        call(END);
        w(0x83, 0xc4, 0x04);
        w(0xc3);
        return entry;
    }

    test('accepts the inflate wrapper and names its three callees', () => {
        const text = new Uint8Array(0x200);
        const entry = emit(text, 0x40, 0x0c);
        const c = __test.classify(text, BASE, entry);
        expect(c).not.toBeNull();
        expect(c!.entry).toBe(BASE + entry);
        expect(c!.inflateInit).toBe(INIT);
        expect(c!.inflate).toBe(CODEC);
        expect(c!.inflateEnd).toBe(END);
    });

    test('rejects the deflate twin (4-arg init cleans 0x10)', () => {
        const text = new Uint8Array(0x200);
        const entry = emit(text, 0x40, 0x10);
        expect(__test.classify(text, BASE, entry)).toBeNull();
    });

    test('rejects a body with no z_stream-sized push', () => {
        const text = new Uint8Array(0x200);
        const entry = emit(text, 0x40, 0x0c);
        text[entry + 4] = 0x18; // push 0x18 instead of 0x38
        expect(__test.classify(text, BASE, entry)).toBeNull();
    });

    test('version strings must be standalone NUL-terminated "1.n.n"', () => {
        const enc = (s: string) => Array.from(s, ch => ch.charCodeAt(0));
        const rdata = new Uint8Array([
            0, ...enc('1.1.4'), 0,               // ZLIB_VERSION — accepted
            ...enc(' inflate 1.1.3 Copyright'), 0, // embedded, not standalone
            0, ...enc('1.2.11'), 0,              // accepted
            0, ...enc('1.x'), 0,                 // malformed
        ]);
        expect(__test.versionStrings(rdata, 0x519000)).toEqual([0x519001, 0x519021]);
    });
});

test('a span beyond the hook ceiling is declined, not allocated', () => {
    const mem = new Uint8Array(MEM);
    new DataView(mem.buffer).setUint32(DEST_LEN_PTR, 0x40000000, true);
    const ret = uncompressKernel(new LiveShadowView(mem), [DEST, DEST_LEN_PTR, SRC, 16]);
    expect(ret).toBe(Z_MEM_ERROR);
});
