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
            expect(s.offset + 5).toBeLessThanOrEqual(s.body.length);
        }
    });

    test("both functions are found with relocated operands", () => {
        const { mem, module, at } = image();
        const hits = findNativeSplices(mem, module);
        expect(hits.map(h => h.name)).toEqual(["_Unwind_SjLj_Register", "_Unwind_SjLj_Unregister"]);
        expect(hits.map(h => h.address)).toEqual(at);
    });

    test("only a complete five-byte JMP is published; original tail and epilogue stay intact", () => {
        const { mem, module, at } = image();
        const before = mem.slice(); let code = BASE + 0x3000;
        expect(applyNativeSplices(mem, module, { alloc(n) { const a=code; code+=(n+15)&~15; return a; } }).length).toBe(2);
        NATIVE_SPLICES.forEach((s, n) => {
            const a=at[n]!, patch=a+s.offset;
            for(let i=0;i<s.body.length;i++) if(i<s.offset || i>=s.offset+5) expect(mem[a+i]).toBe(before[a+i]);
            expect(mem[patch]).toBe(0xe9);
            const target=patch+5+new DataView(mem.buffer).getInt32(patch+1,true);
            expect(target).toBeGreaterThanOrEqual(BASE+0x3000);
            expect(target).toBeLessThan(code);
            expect(mem[a+s.continuation]).toBe(n===0 ? 0x8d : 0x8b);
        });
    });
    test("no allocator or failed allocation leaves the original bytes untouched", () => {
        const {mem,module}=image(); const before=mem.slice();
        expect(applyNativeSplices(mem,module)).toEqual([]);
        expect(mem).toEqual(before);
        expect(applyNativeSplices(mem,module,{alloc(){throw new Error("allocation failed");}})).toEqual([]);
        expect(mem).toEqual(before);
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
