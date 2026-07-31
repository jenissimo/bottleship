/**
 * Unit tests for the user32 key-name and wsprintf families.
 *
 * The A/W pairs share one core each, so these pin the parts that differ between
 * the variants and are easy to regress: the cchSize<1 / truncation contract of
 * GetKeyNameText (nt5 xlate.c `_GetKeyNameText` + client/ntcftxt.h), and which
 * code-unit width each %s/%c argument is read at (WPRINTF_ParseFormat{A,W}).
 */
import { describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createSystemExports } from "../../src/worker/modules/user32/system";

const exports = createSystemExports();
// Guest writes go through the Mem accessor (region-permission validation), whose
// binding is process-global — rebind per call so a sibling test file cannot steal it.
const call = (name: string, args: number[]): number => {
    Mem.bind(() => mem);
    return exports[name]!({} as any, mem, args) as number;
};

const mem = new Uint8Array(0x10000);
const view = new DataView(mem.buffer);

const putA = (p: number, s: string) => {
    for (let i = 0; i < s.length; i++) mem[p + i] = s.charCodeAt(i);
    mem[p + s.length] = 0;
};
const putW = (p: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint16(p + i * 2, s.charCodeAt(i), true);
    view.setUint16(p + s.length * 2, 0, true);
};
const getA = (p: number) => {
    let s = "";
    for (let i = p; mem[i]; i++) s += String.fromCharCode(mem[i]);
    return s;
};
const getW = (p: number) => {
    let s = "";
    for (let i = p; view.getUint16(i, true); i += 2) s += String.fromCharCode(view.getUint16(i, true));
    return s;
};

const OUT = 0x1000;
const ARG = 0x2000;
const FMT = 0x3000;
const poison = () => mem.fill(0xcc, OUT, OUT + 0x200);

/** wsprintf is cdecl/variadic: the stub hands us 16 argument slots. */
const varargs = (...rest: number[]): number[] => {
    const slots = new Array<number>(16).fill(0);
    for (let i = 0; i < rest.length; i++) slots[i] = rest[i];
    return slots;
};

const LP_CTRL = 0x1d << 16;
const EXTENDED = 0x01000000;
const DONTCARE = 0x02000000;

describe("GetKeyNameText", () => {
    test("returns the character count excluding the terminator", () => {
        poison();
        expect(call("GetKeyNameTextA", [LP_CTRL, OUT, 40])).toBe(4);
        expect(getA(OUT)).toBe("Ctrl");

        poison();
        expect(call("GetKeyNameTextW", [LP_CTRL, OUT, 40])).toBe(4);
        expect(getW(OUT)).toBe("Ctrl");
    });

    test("truncates to cchSize-1", () => {
        poison();
        expect(call("GetKeyNameTextA", [LP_CTRL, OUT, 4])).toBe(3);
        expect(getA(OUT)).toBe("Ctr");

        poison();
        expect(call("GetKeyNameTextW", [LP_CTRL, OUT, 4])).toBe(3);
        expect(getW(OUT)).toBe("Ctr");

        poison();
        expect(call("GetKeyNameTextW", [LP_CTRL, OUT, 1])).toBe(0);
        expect(getW(OUT)).toBe("");
    });

    test("cchSize<1 returns 0; only the ANSI wrapper still terminates", () => {
        poison();
        expect(call("GetKeyNameTextA", [LP_CTRL, OUT, 0])).toBe(0);
        expect(mem[OUT]).toBe(0);

        poison();
        expect(call("GetKeyNameTextW", [LP_CTRL, OUT, 0])).toBe(0);
        expect(view.getUint16(OUT, true)).toBe(0xcccc);
    });

    test("the extended bit distinguishes left/right; the don't-care bit folds them", () => {
        call("GetKeyNameTextW", [LP_CTRL | EXTENDED, OUT, 40]);
        expect(getW(OUT)).toBe("Right Ctrl");

        call("GetKeyNameTextW", [LP_CTRL | EXTENDED | DONTCARE, OUT, 40]);
        expect(getW(OUT)).toBe("Ctrl");

        call("GetKeyNameTextA", [(0x36 << 16) | DONTCARE, OUT, 40]);
        expect(getA(OUT)).toBe("Shift");
    });
});

describe("wsprintf", () => {
    test("A and W format identically and return the character count", () => {
        putA(FMT, "%s=%d [%05x] %c|%8s|");
        putA(ARG, "abc");
        expect(call("wsprintfA", varargs(OUT, FMT, ARG, -7, 0xbeef, 0x5a, ARG))).toBe(26);
        expect(getA(OUT)).toBe("abc=-7 [0beef] Z|     abc|");

        putW(FMT, "%s=%d [%05x] %c|%8s|");
        putW(ARG, "abc");
        expect(call("wsprintfW", varargs(OUT, FMT, ARG, -7, 0xbeef, 0x5a, ARG))).toBe(26);
        expect(getW(OUT)).toBe("abc=-7 [0beef] Z|     abc|");
    });

    test("length modifiers pick the argument's code-unit width", () => {
        putW(FMT, "[%hs]");
        putA(ARG, "narrow");
        expect(call("wsprintfW", varargs(OUT, FMT, ARG))).toBe(8);
        expect(getW(OUT)).toBe("[narrow]");

        putA(FMT, "[%S]");
        putW(ARG, "wide");
        expect(call("wsprintfA", varargs(OUT, FMT, ARG))).toBe(6);
        expect(getA(OUT)).toBe("[wide]");
    });

    test("a NULL buffer or format returns -1", () => {
        putW(FMT, "x");
        expect(call("wsprintfW", varargs(0, FMT))).toBe(-1);
        expect(call("wsprintfW", varargs(OUT, 0))).toBe(-1);
    });

    // wine wsprintf.c:593-616 — the real entry points format through wvsnprintf with a 1024
    // code-unit budget and report 1024 on overflow. Callers size buffers to that documented
    // maximum, so exceeding it corrupts guest memory rather than merely mis-reporting.
    test("output is clamped to 1024 code units including the terminator", () => {
        putA(FMT, "%s");
        putA(ARG, "z".repeat(4000));
        mem.fill(0xcc, OUT + 1024, OUT + 1100);

        expect(call("wsprintfA", varargs(OUT, FMT, ARG))).toBe(1024);
        expect(getA(OUT).length).toBe(1023);
        expect(mem[OUT + 1023]).toBe(0);
        // nothing past the documented buffer size was touched
        expect(mem[OUT + 1024]).toBe(0xcc);
    });
});

describe("GetDpiForSystem", () => {
    test("agrees with the LOGPIXELS gdi32 reports for the unscaled desktop", () => {
        expect(call("GetDpiForSystem", [])).toBe(96);
    });
});
