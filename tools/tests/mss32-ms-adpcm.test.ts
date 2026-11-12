/**
 * Miles' AIL_decompress_ADPCM path decodes MS ADPCM with the standard coefficient table:
 * each block's header names the predictor, then nibbles correct it high half first.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeAdpcmToS16 } from "../../src/worker/modules/mss32/audio-decode";

describe("MS ADPCM (mss32)", () => {
    test("one mono block: header samples oldest first, then predicted samples", () => {
        // Predictor 1 (512, -256: a straight line), delta 16, sample1 30, sample2 20;
        // nibbles 0, 1, 0, 0, 0, 0.
        const block = new Uint8Array([1, 16, 0, 30, 0, 20, 0, 0x01, 0x00, 0x00]);
        expect([...decodeAdpcmToS16(block, 2, 1, block.length)]).toEqual([20, 30, 40, 66, 92, 118, 144, 170]);
    });

    test("stereo blocks interleave left and right, the high nibble left", () => {
        // Both channels predictor 0 (256, 0: hold), delta 16; L 100/50, R -100/-50; nibble L+1, R-1.
        const block = new Uint8Array([0, 0, 16, 0, 16, 0, 100, 0, 0x9c, 0xff, 50, 0, 0xce, 0xff, 0x1f]);
        expect([...decodeAdpcmToS16(block, 2, 2, block.length)]).toEqual([50, -50, 100, -100, 116, -116]);
    });
});

for (const name of ["ms_mono", "ms_st"]) {
    test(`${name} matches the existing independent PCM reference`, () => {
        const bytes = new Uint8Array(readFileSync(join(import.meta.dir, "fixtures/adpcm", `${name}.wav`)));
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let fmt = 0, data = new Uint8Array(0);
        for (let at = 12; at + 8 <= bytes.length;) {
            const size = view.getUint32(at + 4, true);
            const id = String.fromCharCode(...bytes.subarray(at, at + 4));
            if (id === "fmt ") fmt = at + 8;
            if (id === "data") data = bytes.subarray(at + 8, at + 8 + size);
            at += 8 + size + (size & 1);
        }
        expect(fmt).toBeGreaterThan(0);
        expect(data.length).toBeGreaterThan(0);
        const pcm = decodeAdpcmToS16(data, 2, view.getUint16(fmt + 2, true), view.getUint16(fmt + 12, true));
        const expected = readFileSync(join(import.meta.dir, "fixtures/adpcm", `${name}.ref`));
        expect(new Uint8Array(pcm.buffer)).toEqual(new Uint8Array(expected));
    });
}

test("incomplete headers and invalid predictors produce no PCM", () => {
    expect(decodeAdpcmToS16(new Uint8Array(6), 2, 1, 10).length).toBe(0);
    expect(decodeAdpcmToS16(new Uint8Array([7, 16, 0, 30, 0, 20, 0]), 2, 1, 7).length).toBe(0);
});
test("a short final block decodes only samples actually present", () => {
    const bytes = new Uint8Array([1, 16, 0, 30, 0, 20, 0, 0x01]);
    expect([...decodeAdpcmToS16(bytes, 2, 1, 10)]).toEqual([20, 30, 40, 66]);
});
test("invalid channel counts and block sizes are rejected before allocating PCM", () => {
    for (const channels of [0, 3, -1]) expect(decodeAdpcmToS16(new Uint8Array(16), 2, channels, 16).length).toBe(0);
    for (const size of [0, 6, -1, NaN, Infinity, 7.5]) expect(decodeAdpcmToS16(new Uint8Array(16), 2, 1, size).length).toBe(0);
});
