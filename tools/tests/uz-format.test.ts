// Unit tests for the Unreal `.uz` reader (packages/formats/src/uz): hand-derived vectors for
// every FCodecFull stage, then round trips through the test-side encoder.

import { describe, it, expect } from "bun:test";
import {
    bwtDecode, huffmanDecode, mtfDecode, rleDecode, decodeUz, encodeUz, isUz, UzError,
    bwtEncode, huffmanEncode, mtfEncode, rleEncode,
} from "@bottleship/formats/uz";

const bitsToBytes = (bits: number[]): Uint8Array => {
    const out = new Uint8Array((bits.length + 7) >> 3);
    bits.forEach((b, i) => { if (b) out[i >> 3]! |= 1 << (i & 7); });
    return out;
};
const bytesOf = (s: string) => new TextEncoder().encode(s);

describe("uz stages (hand-derived vectors)", () => {
    it("RLE: the byte after five equal bytes is the whole run length", () => {
        expect([...rleDecode(new Uint8Array([7, 7, 7, 7, 7, 9, 3]))]).toEqual([...new Array(9).fill(7), 3]);
        // Leading zeros count against the initial PrevChar=0.
        expect([...rleDecode(new Uint8Array([0, 0, 0, 0, 0, 5]))]).toEqual([0, 0, 0, 0, 0]);
    });

    it("MTF: indices into a list that moves each symbol to the front", () => {
        expect([...mtfDecode(new Uint8Array([1, 0, 1, 2]))]).toEqual([1, 1, 0, 2]);
    });

    it("BWT: the sentinel row sorts after every byte", () => {
        // "ab": rows [0,1,2] → first=1 (suffix 1), last=0 (suffix 0), column L = a a b.
        const block = new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x61, 0x61, 0x62]);
        expect(new TextDecoder().decode(bwtDecode(block))).toBe("ab");
    });

    it("Huffman: LSB-first tree then codes", () => {
        const bits = [1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1];
        const input = new Uint8Array([3, 0, 0, 0, ...bitsToBytes(bits)]);
        expect(new TextDecoder().decode(huffmanDecode(input))).toBe("xyy");
    });
});

describe("uz round trip", () => {
    const cases: Array<[string, Uint8Array]> = [
        ["empty", new Uint8Array(0)],
        ["text", bytesOf("Unreal Tournament package payload, Unreal Tournament package payload.")],
        ["runs", new Uint8Array([...new Array(600).fill(0), 1, 2, 2, 2, 2, 2, 3, ...new Array(255).fill(9), ...new Array(5).fill(4)])],
    ];
    // Spans more than one 256 KiB BWT block.
    const big = new Uint8Array(0x40000 + 12345);
    let s = 0x1234567;
    for (let i = 0; i < big.length; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; big[i] = (s >>> 24) & 0x3f; }
    cases.push(["multi-block", big]);

    for (const [name, data] of cases) {
        it(`stages invert: ${name}`, () => {
            expect(rleDecode(rleEncode(data))).toEqual(data);
            expect(mtfDecode(mtfEncode(data))).toEqual(data);
            expect(huffmanDecode(huffmanEncode(data))).toEqual(data);
            if (data.length <= 4096) expect(bwtDecode(bwtEncode(data))).toEqual(data);
        });
    }

    it("whole file: header + FCodecFull pipeline", () => {
        const data = cases[2]![1];
        const uz = encodeUz("DM-Test.unr", data);
        expect(isUz(uz)).toBe(true);
        const out = decodeUz(uz);
        expect(out.originalName).toBe("DM-Test.unr");
        expect(out.data).toEqual(data);
    });

    it("whole file: multi-block BWT", () => {
        const out = decodeUz(encodeUz("big.unr", big));
        expect(out.data).toEqual(big);
    }, 60_000);

    it("accepts both signatures, refuses garbage", () => {
        const data = bytesOf("payload");
        expect(decodeUz(encodeUz("a.unr", data, 1234)).data).toEqual(data);
        const ut = encodeUz("a.unr", data);
        expect([...ut.subarray(0, 4)]).toEqual([0x2e, 0x16, 0, 0]);
        expect(decodeUz(ut).data).toEqual(data);
        expect(() => decodeUz(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(UzError);
        expect(() => decodeUz(new Uint8Array([0x2e, 0x16, 0, 0, 1, 0]))).toThrow(UzError);
    });
});
