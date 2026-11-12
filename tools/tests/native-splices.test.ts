import { afterEach, describe, expect, test } from "bun:test";
import { NATIVE_SPLICES, applyNativeSplices, findNativeSplices } from "../../src/worker/core/hle-lib/native-leaves";
import type { LoadedPEModule } from "../../src/worker/core/module-registry";

const BASE = 0x400000;
const TEXT = 0x1000;
const STATE = 0xe06c90;

function image(fill: (splice: (typeof NATIVE_SPLICES)[number], bytes: Uint8Array) => void = () => undefined) {
    const mem = new Uint8Array(BASE + 0x4000);
    const at: number[] = [];
    let cursor = BASE + TEXT + 0x40;
    for (const splice of NATIVE_SPLICES) {
        const bytes = Uint8Array.from(splice.body);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < bytes.length; i++) {
            if (splice.mask[i] === 0 && splice.mask[i + 3] === 0 && (i === 0 || splice.mask[i - 1] !== 0)) {
                view.setUint32(i, splice.same.includes(i) ? STATE : 0x1234 + i, true);
            }
        }
        fill(splice, bytes);
        mem.set(bytes, cursor);
        at.push(cursor);
        cursor += bytes.length + 0x23;
    }
    const module = {
        name: "game.exe", baseAddress: BASE, size: 0x4000,
        sections: [{ name: ".text", virtualAddress: TEXT, virtualSize: 0x2000, characteristics: 0x60000020 }],
    } as unknown as LoadedPEModule;
    return { mem, module, at };
}

afterEach(() => { delete (globalThis as { __noNativeSplices?: boolean }).__noNativeSplices; });

describe("native splices: libgcc SjLj frame registration", () => {
    test("masks and bodies are consistent", () => {
        for (const s of NATIVE_SPLICES) {
            expect(s.mask.length).toBe(s.body.length);
            for (let i = 0; i < s.body.length; i++) expect(s.body[i]! & ~s.mask[i]!).toBe(0);
            for (const o of s.same) expect(Array.from(s.mask.subarray(o, o + 4))).toEqual([0, 0, 0, 0]);
            for (let i = 0; i < s.code.length; i++) expect(s.mask[s.offset + i] === 0xff || s.mask[s.offset + i] === 0).toBe(true);
            expect(s.offset + s.code.length).toBeLessThanOrEqual(s.body.length);
        }
    });

    test("both functions are found with relocated operands", () => {
        const { mem, module, at } = image();
        const hits = findNativeSplices(mem, module);
        expect(hits.map(h => h.name)).toEqual(["_Unwind_SjLj_Register", "_Unwind_SjLj_Unregister"]);
        expect(hits.map(h => h.address)).toEqual(at);
    });

    test("only the TLS block is rewritten and the jump lands on the original epilogue", () => {
        const { mem, module, at } = image();
        const before = mem.slice();
        expect(applyNativeSplices(mem, module).length).toBe(2);
        NATIVE_SPLICES.forEach((s, n) => {
            const a = at[n]!;
            for (let i = 0; i < s.body.length; i++) {
                const inside = i >= s.offset && i < s.offset + s.code.length;
                expect(mem[a + i]).toBe(inside ? s.code[i - s.offset]! : before[a + i]!);
            }
            const end = s.offset + s.code.length;
            expect(s.code[s.code.length - 2]).toBe(0xeb);
            const target = end + ((s.code[s.code.length - 1]! << 24) >> 24);
            expect(target).toBe(n === 0 ? 0x2c : 0x24);
        });
        expect(Array.from(mem.subarray(at[0]! + 0x2c, at[0]! + 0x34))).toEqual([0x8d, 0x65, 0xf4, 0x5b, 0x5e, 0x5f, 0x5d, 0xc3]);
        expect(Array.from(mem.subarray(at[1]! + 0x24, at[1]! + 0x29))).toEqual([0x8b, 0x5d, 0xfc, 0xc9, 0xc3]);
    });

    test("the splice reads the slot array through fs:[0x2C] and never touches LastError", () => {
        const [reg, unreg] = NATIVE_SPLICES;
        expect(Array.from(reg!.code)).toEqual([
            0x8b, 0x4a, 0x30, 0x64, 0xa1, 0x2c, 0, 0, 0, 0x8b, 0x14, 0x88, 0x89, 0x17, 0x89, 0x3c, 0x88, 0xeb, 0xc1,
        ]);
        expect(Array.from(unreg!.code)).toEqual([
            0x8b, 0x48, 0x30, 0x64, 0xa1, 0x2c, 0, 0, 0, 0x89, 0x1c, 0x88, 0xeb, 0xc4,
        ]);
    });

    test("a body whose state operands disagree is left alone", () => {
        const { mem, module } = image((s, bytes) => new DataView(bytes.buffer).setUint32(s.same[1]!, STATE + 4, true));
        expect(findNativeSplices(mem, module)).toEqual([]);
        const before = mem.slice();
        expect(applyNativeSplices(mem, module)).toEqual([]);
        expect(mem).toEqual(before);
    });

    test("one changed fixed byte prevents the match", () => {
        const { mem, module } = image((_s, bytes) => { bytes[5] ^= 1; });
        expect(findNativeSplices(mem, module)).toEqual([]);
    });

    test("the kill switch keeps the original code", () => {
        (globalThis as { __noNativeSplices?: boolean }).__noNativeSplices = true;
        const { mem, module } = image();
        const before = mem.slice();
        expect(applyNativeSplices(mem, module)).toEqual([]);
        expect(mem).toEqual(before);
    });
});
