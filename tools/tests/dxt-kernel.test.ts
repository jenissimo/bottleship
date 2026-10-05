/**
 * Differential: the WASM S3TC decoder against the TypeScript decoder that is
 * also its runtime fallback. One implementation is the oracle for the other —
 * there is no third copy to rot.
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TextureKernel } from "../../src/worker/backends/webgpu/shared/dxt-kernel";
import { decodeDxtToRgba, decodeDxtToRgbaCpu, dxtRowPitch, blocksHigh } from "../../src/worker/backends/webgpu/shared/dxt";

const asset = (name: string) => readFileSync(resolve(import.meta.dir, "../../public", name));
const variants = { scalar: asset("dxt-kernel.wasm"), simd: asset("dxt-kernel-simd.wasm") };
const format = (kind: number) => 0x00545844 | ((kind + 0x30) << 24);

/** xorshift, so a failure names a seed that reproduces the exact block soup. */
function fill(size: number, seed: number): Uint8Array {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        out[i] = seed;
    }
    return out;
}

test("the kernels import nothing from the host", () => {
    for (const bytes of Object.values(variants)) {
        assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(bytes)), []);
    }
});

test("both WASM variants agree byte-for-byte with the TS decoder", () => {
    for (const [name, bytes] of Object.entries(variants)) {
        const kernel = new TextureKernel(new WebAssembly.Instance(new WebAssembly.Module(bytes)));
        for (let kind = 1; kind <= 5; kind++) {
            for (const [width, height] of [[16, 16], [32, 24], [31, 17], [64, 33], [129, 65]]) {
                for (const pad of [0, 7, 19]) {
                    const rowBytes = dxtRowPitch(format(kind), width);
                    const pitch = rowBytes + pad;
                    const size = (blocksHigh(height) - 1) * pitch + rowBytes;
                    for (let seed = 1; seed <= 4; seed++) {
                        const src = fill(size, seed * 65537 + kind);
                        const expected = new Uint8Array(width * height * 4);
                        decodeDxtToRgbaCpu(format(kind), src, pitch, width, height, expected);
                        const actual = new Uint8Array(expected.length);
                        assert.equal(kernel.tryDecodeDxt(kind, src, pitch, width, height, actual, size), true);
                        assert.deepEqual(actual, expected,
                            `${name} kind=${kind} ${width}x${height} pitch=${pitch} seed=${seed}`);
                    }
                }
            }
        }
    }
});

test("BC1 punch-through decodes index 3 as transparent black on both paths", () => {
    // colour0 <= colour1 selects the 3-colour mode; every index here is 3.
    // BC2/BC3 colour blocks never take that mode, whatever the endpoint order.
    const width = 32, height = 32, pitch = dxtRowPitch(format(1), width);
    const src = new Uint8Array(pitch * blocksHigh(height));
    for (let b = 0; b < src.length; b += 8) {
        src[b] = 0x00; src[b + 1] = 0x00; // colour0 = 0x0000
        src[b + 2] = 0xff; src[b + 3] = 0xff; // colour1 = 0xffff
        src.fill(0xff, b + 4, b + 8); // every index = 3
    }
    const expected = new Uint8Array(width * height * 4);
    decodeDxtToRgbaCpu(format(1), src, pitch, width, height, expected);
    assert.ok(expected.every(x => x === 0), "BC1 index 3 in 3-colour mode is RGBA(0,0,0,0)");
    for (const bytes of Object.values(variants)) {
        const kernel = new TextureKernel(new WebAssembly.Instance(new WebAssembly.Module(bytes)));
        const actual = new Uint8Array(expected.length).fill(173);
        assert.equal(kernel.tryDecodeDxt(1, src, pitch, width, height, actual, src.length), true);
        assert.deepEqual(actual, expected);
    }
});

test("the public decoder rejects malformed requests without writing output", () => {
    const src = new Uint8Array(32);
    const dst = new Uint8Array(256).fill(173);
    for (const [pitch, width, height] of [[7, 4, 4], [8, -1, 4], [8, 1.5, 4], [8, NaN, 4], [8, Infinity, 4], [8, 4, 9999]]) {
        assert.throws(() => decodeDxtToRgba(format(1), src, pitch, width, height, dst), RangeError);
    }
    assert.throws(() => decodeDxtToRgba(0, src, 8, 4, 4, dst), RangeError);
    assert.throws(() => decodeDxtToRgba(format(1), src.subarray(0, 7), 8, 4, 4, dst), RangeError);
    assert.throws(() => decodeDxtToRgba(format(1), src, 8, 4, 4, dst.subarray(0, 63)), RangeError);
    assert.throws(() => decodeDxtToRgba(format(1), dst.subarray(0, 8), 8, 4, 4, dst), RangeError);
    decodeDxtToRgba(format(1), src, 0, 0, 0, dst);
    assert.ok(dst.every(x => x === 173));
});

test("an unaligned destination still decodes correctly", () => {
    const src = fill(dxtRowPitch(format(5), 8) * 2, 12345);
    const expected = new Uint8Array(8 * 8 * 4);
    decodeDxtToRgbaCpu(format(5), src, dxtRowPitch(format(5), 8), 8, 8, expected);
    const buffer = new Uint8Array(expected.length + 5).fill(173);
    const actual = buffer.subarray(1, 1 + expected.length);
    decodeDxtToRgba(format(5), src, dxtRowPitch(format(5), 8), 8, 8, actual);
    assert.deepEqual(actual, expected);
    assert.equal(buffer[0], 173);
    assert.ok(buffer.subarray(1 + expected.length).every(x => x === 173));
});

test("the raw Rust ABI independently rejects bad spans, overflow and overlap", () => {
    const wasm = new WebAssembly.Instance(new WebAssembly.Module(variants.scalar));
    const memory = wasm.exports.memory as WebAssembly.Memory;
    const base = Number((wasm.exports.__heap_base as WebAssembly.Global).value);
    memory.grow(1);
    const bytes = new Uint8Array(memory.buffer);
    const decode = wasm.exports.decode_dxt as (...args: number[]) => number;
    const dst = base + 1024;
    bytes.fill(173, dst, dst + 64);
    const rejected = [
        [0, base, 8, 8, 4, 4, dst, 64],                       // format out of range
        [1, base, 7, 8, 4, 4, dst, 64],                       // declared source too short
        [1, base, 8, 7, 4, 4, dst, 64],                       // pitch under one block row
        [1, base, 8, 8, 4, 4, dst, 63],                       // declared output too short
        [1, 0, 8, 8, 4, 4, dst, 64],                          // source below __heap_base
        [1, base, 8, 8, 4, 4, 0, 64],                         // destination below __heap_base
        [1, base, 8, 8, 4, 4, base + 4, 64],                  // overlap
        [1, bytes.length - 4, 8, 8, 4, 4, dst, 64],           // source past linear memory
        [1, base, 8, 8, 4, 4, bytes.length - 4, 64],          // destination past linear memory
        [5, base, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, dst, 0xffffffff], // u32 overflow
    ];
    for (const args of rejected) {
        assert.notEqual(decode(...args), 0, JSON.stringify(args));
        assert.ok(bytes.subarray(dst, dst + 64).every(x => x === 173), JSON.stringify(args));
    }
    assert.equal(decode(1, base + 1, 8, 8, 4, 4, dst + 1, 64), 0, "unaligned byte spans are legal");
});

test("the arena is reused across calls and survives its own growth", () => {
    const wasm = new WebAssembly.Instance(new WebAssembly.Module(variants.simd));
    const kernel = new TextureKernel(wasm);
    const memory = wasm.exports.memory as WebAssembly.Memory;
    const before = memory.buffer;
    const width = 1024, height = 512, pitch = dxtRowPitch(format(5), width);
    const src = fill(pitch * blocksHigh(height), 793);
    const dst = new Uint8Array(width * height * 4);
    assert.equal(kernel.tryDecodeDxt(5, src, pitch, width, height, dst, src.length), true);
    assert.notStrictEqual(memory.buffer, before, "this workload must force a grow");
    const after = memory.buffer;
    const expected = new Uint8Array(dst.length);
    decodeDxtToRgbaCpu(format(5), src, pitch, width, height, expected);
    assert.deepEqual(dst, expected);
    assert.equal(kernel.tryDecodeDxt(5, src, pitch, width, height, dst, src.length), true);
    assert.strictEqual(memory.buffer, after, "steady state must not grow again");
    assert.deepEqual(dst, expected);
    // Past the 64 MiB cap the kernel declines instead of throwing.
    assert.equal(kernel.tryDecodeDxt(5, src, 16384, 16384, 16384, dst, src.length), false);
});
