/**
 * GetCharWidthA and GetCharABCWidthsA measure the character the caller named.
 *
 * Their character codes are in the code page of the font selected into the DC, and a code
 * above 0xFF on a multi-byte page is a packed two-byte character. Read as Unicode scalars,
 * every code outside ASCII measured a different glyph (0x80 is the euro sign on CP1252,
 * not U+0080). GetCharABCWidthsW takes UTF-16 code units and stays that way.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import { createPaintingExports } from "../../src/worker/modules/gdi32/painting";
import { ANSI_CHARSET, JOHAB_CHARSET, RUSSIAN_CHARSET, SHIFTJIS_CHARSET } from "../../src/worker/modules/gdi32/font-charset";
import { preserveMemBinding } from "./helpers/scoped-process-state";

preserveMemBinding();

const HDC = 0x200a0, OUT = 0x2000;
const system = System.getInstance();
const config = EmulatorConfig.getInstance();
const saved = { gdi: (system as any).gdiContext, acp: config.ansiCodePage };

let mem: Uint8Array, view: DataView;
let measured: string[];
let fontCharset: number | null;
let exports: ReturnType<typeof createPaintingExports>;

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
    exports = createPaintingExports();
    mem.fill(0xcc, OUT, OUT + 64);
});
afterEach(() => {
    (system as any).gdiContext = saved.gdi;
    config.ansiCodePage = saved.acp;
});

const call = (name: string, first: number, last: number): number =>
    (exports[name] as any)(null, mem, [HDC, first, last, OUT]) as number;
const untouched = (): boolean => mem.subarray(OUT, OUT + 64).every(b => b === 0xcc);

for (const name of ["GetCharWidthA", "GetCharABCWidthsA"]) {
    describe(`${name} decodes through the selected font's code page`, () => {
        test("0x80 under an ANSI_CHARSET font is the euro sign", () => {
            expect(call(name, 0x80, 0x80)).toBe(1);
            expect(measured).toEqual(["€"]);
        });

        test("0x82A0 under a SHIFTJIS_CHARSET font is あ while the system page is 1252", () => {
            fontCharset = SHIFTJIS_CHARSET;
            expect(config.ansiCodePage).toBe(1252);
            expect(call(name, 0x82a0, 0x82a0)).toBe(1);
            expect(measured).toEqual(["あ"]);
        });

        test("0xC0 under a RUSSIAN_CHARSET font is А", () => {
            fontCharset = RUSSIAN_CHARSET;
            expect(call(name, 0xc0, 0xc0)).toBe(1);
            expect(measured).toEqual(["А"]);
        });

        test("an ASCII range is unchanged", () => {
            expect(call(name, 0x41, 0x43)).toBe(1);
            expect(measured).toEqual(["A", "B", "C"]);
        });

        test("a code above 0xFF on a single-byte page fails and writes nothing", () => {
            expect(call(name, 0x82a0, 0x82a0)).toBe(0);
            expect(measured).toEqual([]);
            expect(untouched()).toBe(true);
        });

        test("a multi-byte range across lead bytes, or a page with no decoder, fails", () => {
            fontCharset = SHIFTJIS_CHARSET;
            expect(call(name, 0x82a0, 0x83a0)).toBe(0);
            fontCharset = JOHAB_CHARSET;
            expect(call(name, 0x8441, 0x8441)).toBe(0);
            expect(measured).toEqual([]);
            expect(untouched()).toBe(true);
        });
    });
}

test("GetCharWidthA writes one rounded advance per character", () => {
    expect(call("GetCharWidthA", 0x41, 0x42)).toBe(1);
    expect([view.getInt32(OUT, true), view.getInt32(OUT + 4, true)]).toEqual([10, 10]);
});

test("GetCharABCWidthsA writes A, B, C per character, summing to the advance", () => {
    expect(call("GetCharABCWidthsA", 0x80, 0x80)).toBe(1);
    const abc = [view.getInt32(OUT, true), view.getInt32(OUT + 4, true), view.getInt32(OUT + 8, true)];
    expect(abc).toEqual([1, 7, 2]);
});

test("GetCharABCWidthsW takes UTF-16 code units whatever the font's charset", () => {
    fontCharset = SHIFTJIS_CHARSET;
    expect(call("GetCharABCWidthsW", 0x82a0, 0x82a0)).toBe(1);
    expect(call("GetCharABCWidthsW", 0x80, 0x80)).toBe(1);
    expect(measured).toEqual(["芠", "\u0080"]);
});
