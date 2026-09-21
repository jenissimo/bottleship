/**
 * The CRT's _controlfp/_statusfp layout is NOT the x87 layout — pinned both ways.
 *
 * Two fields are re-encoded rather than shifted: the six exception bits sit in a different
 * ORDER (_EM_INVALID is x87 bit 0 but CRT bit 4, _EM_DENORMAL is x87 bit 1 but CRT bit 19), and
 * the precision field's values run the other way (_PC_24 is the x87 encoding 0, _PC_64 is 3).
 * Passing either word through unchanged therefore answers with a plausible number that means
 * something else — which is exactly how a title asking for single precision was left running at
 * extended.
 */
import { describe, expect, test } from "bun:test";
import {
    msvcControlWordFromX87, x87ControlWordFromMsvc, msvcStatusWordFromX87,
    MSVC_MCW_PC, MSVC_MCW_RC, MSVC_MCW_EM, MSVC_MCW_IC,
} from "../../src/worker/core/fpu-helper";

const PC_24 = 0x00020000, PC_53 = 0x00010000, PC_64 = 0x00000000;
const EM_ALL = 0x0008001f;
const X87_CW_DEFAULT = 0x037f;       // CRT default: 64-bit, round nearest, all masked
const X87_CW_D3D = 0x003f;           // what Direct3D's CreateDevice leaves: 24-bit, all masked

describe("CRT control word <-> x87 control word", () => {
    test("the CRT default reads back as 64-bit, all exceptions masked", () => {
        const m = msvcControlWordFromX87(X87_CW_DEFAULT);
        expect(m & MSVC_MCW_PC).toBe(PC_64);
        expect(m & MSVC_MCW_RC).toBe(0);
        expect(m & MSVC_MCW_EM).toBe(EM_ALL);
    });

    test("Direct3D's single-precision word reads back as _PC_24", () => {
        expect(msvcControlWordFromX87(X87_CW_D3D) & MSVC_MCW_PC).toBe(PC_24);
    });

    test("_PC_24 asks for x87 precision 0, not 2 — the encodings are reversed", () => {
        const cw = x87ControlWordFromMsvc(msvcControlWordFromX87(X87_CW_DEFAULT) & ~MSVC_MCW_PC | PC_24, X87_CW_DEFAULT);
        expect((cw >> 8) & 3).toBe(0);
        expect(cw).toBe(X87_CW_DEFAULT & ~0x0300);
        // ... and _PC_53 is x87 2, _PC_64 is x87 3.
        expect((x87ControlWordFromMsvc(PC_53 | EM_ALL, X87_CW_DEFAULT) >> 8) & 3).toBe(2);
        expect((x87ControlWordFromMsvc(PC_64 | EM_ALL, X87_CW_DEFAULT) >> 8) & 3).toBe(3);
    });

    test("each exception bit maps to its own x87 bit, not to the same position", () => {
        const pairs: Array<[number, number]> = [
            [0x00000010, 0x01], [0x00080000, 0x02], [0x00000008, 0x04],
            [0x00000004, 0x08], [0x00000002, 0x10], [0x00000001, 0x20],
        ];
        for (const [msvcBit, x87Bit] of pairs) {
            expect(x87ControlWordFromMsvc(msvcBit, 0) & 0x3f).toBe(x87Bit);
            expect(msvcControlWordFromX87(x87Bit) & MSVC_MCW_EM).toBe(msvcBit);
        }
        // The order really is different: invalid is CRT 0x10 / x87 0x01, inexact the other way.
        expect(x87ControlWordFromMsvc(0x00000010, 0) & 0x3f).not.toBe(0x00000010);
    });

    test("rounding control keeps its value order, but moves two bits up", () => {
        for (const rc of [0, 1, 2, 3]) {
            const cw = x87ControlWordFromMsvc(rc << 8, 0);
            expect((cw >> 10) & 3).toBe(rc);
            expect(msvcControlWordFromX87(cw) & MSVC_MCW_RC).toBe(rc << 8);
        }
    });

    test("infinity control is x87 bit 12", () => {
        expect(x87ControlWordFromMsvc(MSVC_MCW_IC, 0) & 0x1000).toBe(0x1000);
        expect(msvcControlWordFromX87(0x1000) & MSVC_MCW_IC).toBe(MSVC_MCW_IC);
    });

    test("a round trip through both directions is stable", () => {
        for (const cw of [0x037f, 0x003f, 0x027f, 0x0c3f, 0x137f, 0x1f3f]) {
            expect(x87ControlWordFromMsvc(msvcControlWordFromX87(cw), cw)).toBe(cw);
        }
    });

    test("the status word moves with the same permutation", () => {
        expect(msvcStatusWordFromX87(0x01)).toBe(0x00000010);   // invalid
        expect(msvcStatusWordFromX87(0x02)).toBe(0x00080000);   // denormal
        expect(msvcStatusWordFromX87(0x20)).toBe(0x00000001);   // inexact
        expect(msvcStatusWordFromX87(0x3f)).toBe(0x0008001f);
    });
});
