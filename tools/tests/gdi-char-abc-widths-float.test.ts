/**
 * GetCharABCWidthsFloat measures the character the caller named.
 *
 * W takes UTF-16 code units. A takes character codes in the code page of the font selected
 * into the DC (its realised charset), and a code above 0xFF on a multi-byte page is a packed
 * two-byte character. Reading an A code as a Unicode scalar measures a different glyph for
 * everything outside ASCII: 0x80 is the euro sign on CP1252, and 0x82A0 is 'あ' under a
 * SHIFTJIS_CHARSET font whatever the system ANSI page is.
 *
 * The measurement context is a spy, so each test states exactly which string was measured.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import { registerOutlineMetricsExports } from "../../src/worker/modules/gdi32/outline-metrics";
import {
    ANSI_CHARSET, JOHAB_CHARSET, RUSSIAN_CHARSET, SHIFTJIS_CHARSET, SYMBOL_CHARSET,
} from "../../src/worker/modules/gdi32/font-charset";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";
import { preserveMemBinding } from "./helpers/scoped-process-state";

preserveMemBinding();

const HDC = 0x200a0, ABC = 0x2000;
const system = System.getInstance();
const config = EmulatorConfig.getInstance();
const saved = { gdi: (system as any).gdiContext, acp: config.ansiCodePage };

let mem: Uint8Array, view: DataView;
let measured: string[];
let fontCharset: number | null;
let exports: Record<string, ThunkImplementation>;

beforeEach(() => {
    mem = new Uint8Array(0x8000);
    view = new DataView(mem.buffer);
    Mem.bind(() => mem);
    measured = [];
    fontCharset = ANSI_CHARSET;
    config.ansiCodePage = 1252;
    (system as any).gdiContext = {
        getMeasureContext: (hdc: number) => hdc !== HDC ? null : {
            measureText(text: string) {
                measured.push(text);
                return { width: 10, actualBoundingBoxLeft: -1, actualBoundingBoxRight: 8 };
            },
        },
        getSelectedFontCharset: (hdc: number) => hdc === HDC ? fontCharset : null,
    };
    exports = {};
    registerOutlineMetricsExports(exports);
    mem.fill(0xcc, ABC, ABC + 64);
});
afterEach(() => {
    (system as any).gdiContext = saved.gdi;
    config.ansiCodePage = saved.acp;
});

const call = (name: "GetCharABCWidthsFloatA" | "GetCharABCWidthsFloatW", first: number, last: number, hdc = HDC): number =>
    (exports[name] as any)(null, mem, [hdc, first, last, ABC]) as number;
const untouched = (): boolean => mem.subarray(ABC, ABC + 64).every(b => b === 0xcc);

describe("GetCharABCWidthsFloatA decodes through the selected font's code page", () => {
    test("0x80 under an ANSI_CHARSET font is the euro sign, not U+0080", () => {
        expect(call("GetCharABCWidthsFloatA", 0x80, 0x80)).toBe(1);
        expect(measured).toEqual(["€"]);
    });

    test("0x82A0 under a SHIFTJIS_CHARSET font is あ while the system page is 1252", () => {
        fontCharset = SHIFTJIS_CHARSET;
        expect(config.ansiCodePage).toBe(1252);
        expect(call("GetCharABCWidthsFloatA", 0x82a0, 0x82a0)).toBe(1);
        expect(measured).toEqual(["あ"]);
    });

    test("the font's charset decides, not the system page: 0xC0 is А under RUSSIAN_CHARSET", () => {
        fontCharset = RUSSIAN_CHARSET;
        expect(call("GetCharABCWidthsFloatA", 0xc0, 0xc0)).toBe(1);
        expect(measured).toEqual(["А"]);
    });

    test("a charset without a page of its own is read through the system ANSI page", () => {
        fontCharset = SYMBOL_CHARSET;
        config.ansiCodePage = 1251;
        expect(call("GetCharABCWidthsFloatA", 0xc0, 0xc0)).toBe(1);
        expect(measured).toEqual(["А"]);
    });

    test("an ASCII range is measured character by character and written as A, B, C", () => {
        expect(call("GetCharABCWidthsFloatA", 0x41, 0x43)).toBe(1);
        expect(measured).toEqual(["A", "B", "C"]);
        for (let i = 0; i < 3; i++) {
            expect(view.getFloat32(ABC + i * 12, true)).toBe(1);        // A = -actualBoundingBoxLeft
            expect(view.getFloat32(ABC + i * 12 + 4, true)).toBe(7);    // B = ink width
            expect(view.getFloat32(ABC + i * 12 + 8, true)).toBe(2);    // C = advance - A - B
        }
    });

    test("a two-byte range inside one lead byte is measured as packed characters", () => {
        fontCharset = SHIFTJIS_CHARSET;
        expect(call("GetCharABCWidthsFloatA", 0x82a0, 0x82a2)).toBe(1);
        expect(measured).toEqual(["あ", "ぃ", "い"]);
    });
});

describe("GetCharABCWidthsFloatA refuses what is not a character of the font's page", () => {
    test("a code above 0xFF on a single-byte page", () => {
        expect(call("GetCharABCWidthsFloatA", 0x82a0, 0x82a0)).toBe(0);
        expect(measured).toEqual([]);
        expect(untouched()).toBe(true);
    });

    test("a multi-byte range whose ends differ in the lead byte", () => {
        fontCharset = SHIFTJIS_CHARSET;
        expect(call("GetCharABCWidthsFloatA", 0x82a0, 0x83a0)).toBe(0);
        expect(measured).toEqual([]);
    });

    test("a multi-byte page with no decoder fails instead of reading the bytes as CP1252", () => {
        fontCharset = JOHAB_CHARSET;
        expect(call("GetCharABCWidthsFloatA", 0x8441, 0x8441)).toBe(0);
        expect(measured).toEqual([]);
        expect(untouched()).toBe(true);
    });

    test("an unknown DC", () => {
        expect(call("GetCharABCWidthsFloatA", 0x41, 0x41, 0x1234)).toBe(0);
        expect(measured).toEqual([]);
    });
});

describe("GetCharABCWidthsFloatW takes UTF-16 code units", () => {
    test("0x82A0 is U+82A0 and 0x80 is U+0080, whatever the font's charset", () => {
        fontCharset = SHIFTJIS_CHARSET;
        expect(call("GetCharABCWidthsFloatW", 0x82a0, 0x82a0)).toBe(1);
        expect(call("GetCharABCWidthsFloatW", 0x80, 0x80)).toBe(1);
        expect(call("GetCharABCWidthsFloatW", 0x20ac, 0x20ac)).toBe(1);
        expect(measured).toEqual(["芠", "\u0080", "€"]);
    });
});

test("GetOutlineTextMetricsA has no handler: it answers through the unimplemented-export path", () => {
    expect(exports["GetOutlineTextMetricsA"]).toBeUndefined();
});
