/**
 * The kernel32 locale fast paths must be indistinguishable from the full thunks.
 *
 * The WideCharToMultiByte fast path was once disabled outright ("temporarily, while
 * bisecting") and stayed dead, so every conversion took the allocating slow path with
 * nothing to say so. Re-enabling it is only safe if the two paths are checked against each
 * other rather than argued about: the fast path's contract is that it either produces
 * exactly what the slow path would, or declines the call.
 *
 * Guest memory here is a plain byte array — both paths take the same view of it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { exports as kernelExports } from "../../src/worker/modules/kernel32/locale";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import { System } from "../../src/worker/core/system";

const SRC = 0x200;
const DST = 0x400;
const MEM_SIZE = 0x1000;

/** Minimal ctx the locale handlers touch. */
const ctx = { esp: 0x800 } as never;

function fresh(): Uint8Array {
    return new Uint8Array(MEM_SIZE).fill(0xcc);
}

function putWide(mem: Uint8Array, addr: number, s: string, terminate = true): number {
    for (let i = 0; i < s.length; i++) {
        mem[addr + i * 2] = s.charCodeAt(i) & 0xff;
        mem[addr + i * 2 + 1] = s.charCodeAt(i) >> 8;
    }
    if (terminate) { mem[addr + s.length * 2] = 0; mem[addr + s.length * 2 + 1] = 0; }
    return s.length;
}

type FastPathName =
    "WideCharToMultiByte" | "MultiByteToWideChar" | "LCMapStringW" | "GetLocaleInfoW" | "GetLocaleInfoA";

/** Drive the fast path through a fake CPU whose stack holds the stdcall arguments. */
function callFastPath(
    name: FastPathName,
    mem: Uint8Array,
    args: number[],
): number | null {
    let impl: ((cpu: unknown, mem8: Uint8Array) => number | null) | null = null;
    const dispatcher = {
        registerFastPath(_dll: string, fn: string, f: (cpu: unknown, mem8: Uint8Array) => number | null) {
            if (fn === name) impl = f;
        },
        registerWriteBufferFunction() { /* not exercised here */ },
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFastPathLocaleFunctions } = require("../../src/worker/modules/kernel32/locale");
    registerFastPathLocaleFunctions(dispatcher);
    if (!impl) throw new Error(`no fast path registered for ${name}`);

    const esp = 0x800;
    const view = new DataView(mem.buffer);
    for (let i = 0; i < args.length; i++) view.setUint32(esp + 4 + i * 4, args[i]! >>> 0, true);
    return (impl as (cpu: unknown, mem8: Uint8Array) => number | null)({ reg32: { 4: esp } }, mem);
}

/** Both paths on identical input; returns their return values and resulting buffers. */
function compare(
    name: FastPathName,
    seed: (mem: Uint8Array) => void,
    args: number[],
) {
    const fastMem = fresh(); seed(fastMem);
    const fast = callFastPath(name, fastMem, args);

    const slowMem = fresh(); seed(slowMem);
    const handler = (kernelExports as Record<string, (c: unknown, m: Uint8Array, a: number[]) => number>)[name]!;
    const slow = handler(ctx, slowMem, args);

    return { fast, slow, fastMem, slowMem };
}

describe("WideCharToMultiByte fast path agrees with the thunk", () => {
    for (const codePage of [1252, 866, 437, 850]) {
        test(`cp${codePage}: sized conversion writes the same bytes`, () => {
            EmulatorConfig.getInstance().ansiCodePage = codePage;
            const text = "Menu Item 42";
            const n = text.length;
            const r = compare("WideCharToMultiByte",
                (m) => putWide(m, SRC, text),
                [codePage, 0, SRC, n, DST, 64, 0, 0]);
            expect(r.fast).not.toBeNull();
            expect(r.fast).toBe(r.slow);
            expect([...r.fastMem.subarray(DST, DST + n)]).toEqual([...r.slowMem.subarray(DST, DST + n)]);
        });

        test(`cp${codePage}: -1 length carries the terminator exactly as the thunk does`, () => {
            EmulatorConfig.getInstance().ansiCodePage = codePage;
            const text = "save.dat";
            const r = compare("WideCharToMultiByte",
                (m) => putWide(m, SRC, text),
                [codePage, 0, SRC, -1, DST, 64, 0, 0]);
            expect(r.fast).toBe(r.slow);
            expect([...r.fastMem.subarray(DST, DST + 16)]).toEqual([...r.slowMem.subarray(DST, DST + 16)]);
        });

        test(`cp${codePage}: size query (cbMultiByte=0) matches`, () => {
            EmulatorConfig.getInstance().ansiCodePage = codePage;
            const r = compare("WideCharToMultiByte",
                (m) => putWide(m, SRC, "abc"),
                [codePage, 0, SRC, -1, 0, 0, 0, 0]);
            expect(r.fast).toBe(r.slow);
        });
    }

    test("serves a call carrying lpUsedDefaultChar, reporting no substitution", () => {
        // Servable BECAUSE representability is proven first: no substitution can occur, so
        // the default char is unused and the flag is FALSE.
        EmulatorConfig.getInstance().ansiCodePage = 1252;
        const r = compare("WideCharToMultiByte",
            (m) => putWide(m, SRC, "x"),
            [1252, 0, SRC, 1, DST, 8, 0x700, 0x704]);
        expect(r.fast).toBe(r.slow);
        expect(new DataView(r.fastMem.buffer).getUint32(0x704, true)).toBe(0);
        expect(new DataView(r.slowMem.buffer).getUint32(0x704, true)).toBe(0);
    });

    test("a substitution sets lpUsedDefaultChar and the fast path declines it", () => {
        EmulatorConfig.getInstance().ansiCodePage = 1252;
        const r = compare("WideCharToMultiByte",
            (m) => putWide(m, SRC, "中"),   // CJK — not in CP1252
            [1252, 0, SRC, 1, DST, 8, 0, 0x704]);
        expect(r.fast).toBeNull();
        expect(new DataView(r.slowMem.buffer).getUint32(0x704, true)).toBe(1);
    });

    test("lpDefaultChar replaces the substituted byte", () => {
        EmulatorConfig.getInstance().ansiCodePage = 1252;
        const mem = fresh();
        putWide(mem, SRC, "中");
        mem[0x700] = 0x5F;   // '_'
        const handler = (kernelExports as Record<string, (c: unknown, m: Uint8Array, a: number[]) => number>)
            .WideCharToMultiByte!;
        handler(ctx, mem, [1252, 0, SRC, 1, DST, 8, 0x700, 0]);
        expect(mem[DST]).toBe(0x5F);
    });

    test("declines a code point the page cannot encode, leaving the buffer untouched", () => {
        EmulatorConfig.getInstance().ansiCodePage = 1252;
        const r = compare("WideCharToMultiByte",
            (m) => putWide(m, SRC, "中"),   // CJK — not in CP1252
            [1252, 0, SRC, 1, DST, 8, 0, 0]);
        expect(r.fast).toBeNull();
        expect(r.fastMem[DST]).toBe(0xcc);      // nothing written before declining
    });

    test("declines when flags are set", () => {
        EmulatorConfig.getInstance().ansiCodePage = 1252;
        const r = compare("WideCharToMultiByte",
            (m) => putWide(m, SRC, "x"),
            [1252, 0x400 /* WC_NO_BEST_FIT_CHARS */, SRC, 1, DST, 8, 0, 0]);
        expect(r.fast).toBeNull();
    });
});

describe("LCMapStringW fast path agrees with the thunk", () => {
    const LOWER = 0x100, UPPER = 0x200;

    for (const [flagName, flag] of [["lowercase", LOWER], ["uppercase", UPPER]] as const) {
        test(`${flagName}: sized mapping matches the thunk`, () => {
            const text = "Data/Textures/HALL_01.TGA";
            const r = compare("LCMapStringW",
                (m) => putWide(m, SRC, text),
                [0x409, flag, SRC, text.length, DST, 64]);
            expect(r.fast).not.toBeNull();
            expect(r.fast).toBe(r.slow);
            expect([...r.fastMem.subarray(DST, DST + (text.length + 1) * 2)])
                .toEqual([...r.slowMem.subarray(DST, DST + (text.length + 1) * 2)]);
        });

        test(`${flagName}: -1 length matches the thunk`, () => {
            const text = "Sound/Music/Theme.ogg";
            const r = compare("LCMapStringW",
                (m) => putWide(m, SRC, text),
                [0x409, flag, SRC, -1, DST, 64]);
            expect(r.fast).toBe(r.slow);
            expect([...r.fastMem.subarray(DST, DST + (text.length + 1) * 2)])
                .toEqual([...r.slowMem.subarray(DST, DST + (text.length + 1) * 2)]);
        });

        test(`${flagName}: size query matches`, () => {
            const r = compare("LCMapStringW",
                (m) => putWide(m, SRC, "abcDEF"),
                [0x409, flag, SRC, -1, 0, 0]);
            expect(r.fast).toBe(r.slow);
        });

        test(`${flagName}: a destination smaller than the source truncates like the thunk`, () => {
            const text = "LongResourceName";
            const r = compare("LCMapStringW",
                (m) => putWide(m, SRC, text),
                [0x409, flag, SRC, text.length, DST, 5]);
            expect(r.fast).toBe(r.slow);
            expect([...r.fastMem.subarray(DST, DST + 12)]).toEqual([...r.slowMem.subarray(DST, DST + 12)]);
        });
    }

    test("declines sort keys", () => {
        const r = compare("LCMapStringW",
            (m) => putWide(m, SRC, "abc"),
            [0x409, 0x400 /* LCMAP_SORTKEY */, SRC, -1, DST, 64]);
        expect(r.fast).toBeNull();
    });

    test("a character JS would expand keeps Win32's one-for-one length", () => {
        // U+0130 lowercases to two code units under full case mapping; Win32's simple
        // mapping gives one, so the result is the same length as the source.
        const r = compare("LCMapStringW",
            (m) => putWide(m, SRC, "AİB"),
            [0x409, LOWER, SRC, 3, DST, 64]);
        expect(r.fast).toBe(r.slow);
        // 3 source chars + the terminator this implementation always writes. Full case
        // mapping would have made it 5.
        expect(r.slow).toBe(4);
        expect([...r.fastMem.subarray(DST, DST + 8)]).toEqual([...r.slowMem.subarray(DST, DST + 8)]);
    });
});

describe("MultiByteToWideChar fast path agrees with the thunk", () => {
    for (const codePage of [1252, 866, 437, 850]) {
        test(`cp${codePage}: high bytes decode through that page's own table`, () => {
            EmulatorConfig.getInstance().ansiCodePage = codePage;
            const bytes = [0x41, 0xc0, 0xe0, 0xff, 0x7a];
            const r = compare("MultiByteToWideChar",
                (m) => m.set(bytes, SRC),
                [codePage, 0, SRC, bytes.length, DST, 64]);
            expect(r.fast).not.toBeNull();
            expect(r.fast).toBe(r.slow);
            expect([...r.fastMem.subarray(DST, DST + bytes.length * 2)])
                .toEqual([...r.slowMem.subarray(DST, DST + bytes.length * 2)]);
        });
    }
});

describe("LCMapStringW uses Win32 simple case mapping", () => {
    // Win32 preserves length: ß has no one-character uppercase, so it maps to itself.
    // JS toUpperCase() gives "SS", which is a longer string than the caller sized for.
    for (const [name, ch, flags] of [
        ["sharp s", "ß", 0x200],
        ["fi ligature", "ﬁ", 0x200],
        ["n preceded by apostrophe", "ŉ", 0x200],
    ] as const) {
        test(`${name} keeps its length under LCMAP_UPPERCASE`, () => {
            const r = compare("LCMapStringW",
                (m) => putWide(m, SRC, ch),
                [0x409, flags, SRC, -1, DST, 8]);
            expect(r.slow).toBe(2);                          // one char + terminator
            expect(r.fast).toBe(r.slow);
            expect(new DataView(r.slowMem.buffer).getUint16(DST, true)).toBe(ch.charCodeAt(0));
            expect([...r.fastMem.subarray(DST, DST + 4)]).toEqual([...r.slowMem.subarray(DST, DST + 4)]);
        });
    }

    test("dotted capital I takes its simple lowercase, not the two-char full mapping", () => {
        const r = compare("LCMapStringW",
            (m) => putWide(m, SRC, "İ"),
            [0x409, 0x100, SRC, -1, DST, 8]);
        expect(r.slow).toBe(2);
        expect(new DataView(r.slowMem.buffer).getUint16(DST, true)).toBe(0x0069);
        expect(r.fast).toBe(r.slow);
    });

    test("ordinary letters still map", () => {
        const r = compare("LCMapStringW",
            (m) => putWide(m, SRC, "aBc"),
            [0x409, 0x200, SRC, -1, DST, 8]);
        expect(r.fast).toBe(r.slow);
        expect([...r.fastMem.subarray(DST, DST + 6)]).toEqual([...r.slowMem.subarray(DST, DST + 6)]);
        expect(new DataView(r.slowMem.buffer).getUint16(DST, true)).toBe("A".charCodeAt(0));
    });
});

// ---------------------------------------------------------------------------
// The FAILURE contract, which all three tiers have to share.
//
// The inline x86 stubs decline a negative count, an unknown LCTYPE and a too-small
// destination BY NAME, citing rules that only JS can implement (last-error is JS-side
// state). A JS tier that then truncates and reports success turns each of those declines
// into a silent divergence between what the guest gets from the stub and what it gets
// from JS — which is worse than either answer alone.
//
// Ground truth: Wine dlls/kernelbase/locale.c — GetLocaleInfoW (:6094), locale_return_data
// (:766), locale_return_number (:857), mbstowcs_sbcs (:2668), wcstombs_sbcs (:2949).
// ---------------------------------------------------------------------------

const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_INVALID_FLAGS = 1004;

const LOCALE_SDECIMAL = 0x000E;
const LOCALE_ILANGUAGE = 0x0001;
const LOCALE_SDAYNAME7 = 0x0030;          // "Sunday"
const LOCALE_RETURN_NUMBER = 0x20000000;
/** Inside the claimed 0x00..0x1014 span but absent from the table (LOCALE_FONTSIGNATURE). */
const LOCALE_UNKNOWN_HOLE = 0x0058;
const UNTOUCHED = 0xcc;

/** The scheduler stores last-error on the CURRENT THREAD, and there is none here, so
 *  reading it back would report 0 for every call — an instrument that cannot fail. Record
 *  the call instead. */
function withLastError<T>(body: () => T): { value: T; err: number } {
    const scheduler = System.getInstance().scheduler as unknown as { setLastError(c: number): void };
    const original = scheduler.setLastError;
    let err = 0;
    scheduler.setLastError = (code: number) => { err = code; };
    try {
        const value = body();
        return { value, err };
    } finally {
        scheduler.setLastError = original;
    }
}

/** Both tiers of one call, each on its own memory, with last-error captured per tier. */
function bothTiers(name: FastPathName, seed: (m: Uint8Array) => void, args: number[]) {
    const fastMem = fresh(); seed(fastMem);
    const f = withLastError(() => callFastPath(name, fastMem, args));

    const slowMem = fresh(); seed(slowMem);
    const handler = (kernelExports as Record<string, (c: unknown, m: Uint8Array, a: number[]) => number>)[name]!;
    const sl = withLastError(() => handler(ctx, slowMem, args));

    return { fast: f.value, fastMem, fastErr: f.err, slow: sl.value, slowMem, slowErr: sl.err };
}

describe("GetLocaleInfoW/A refuse what they cannot answer", () => {
    test("a negative cchData is ERROR_INVALID_PARAMETER, not a write of byteLen-2", () => {
        const r = bothTiers("GetLocaleInfoW", () => { }, [0x409, LOCALE_SDECIMAL, DST, -1]);
        expect(r.slow).toBe(0);
        expect(r.slowErr).toBe(ERROR_INVALID_PARAMETER);
        expect(r.fast).toBe(0);
        expect(r.fastErr).toBe(ERROR_INVALID_PARAMETER);
        // Nothing may be written: the destination is unsized.
        expect([...r.fastMem.subarray(DST, DST + 8)]).toEqual(new Array(8).fill(UNTOUCHED));
        expect([...r.slowMem.subarray(DST, DST + 8)]).toEqual(new Array(8).fill(UNTOUCHED));
    });

    test("an undersized cchData is 0 + ERROR_INSUFFICIENT_BUFFER, not a truncated string", () => {
        // SDECIMAL is "." — 2 WCHARs including the terminator, so 1 cannot hold it.
        const r = bothTiers("GetLocaleInfoW", () => { }, [0x409, LOCALE_SDECIMAL, DST, 1]);
        expect(r.slow).toBe(0);
        expect(r.slowErr).toBe(ERROR_INSUFFICIENT_BUFFER);
        expect(r.fast).toBe(0);
        expect(r.fastErr).toBe(ERROR_INSUFFICIENT_BUFFER);
        expect([...r.slowMem.subarray(DST, DST + 2)]).toEqual([UNTOUCHED, UNTOUCHED]);
        expect([...r.fastMem.subarray(DST, DST + 2)]).toEqual([UNTOUCHED, UNTOUCHED]);
    });

    test("a size query still returns the required WCHAR count", () => {
        const r = bothTiers("GetLocaleInfoW", () => { }, [0x409, LOCALE_SDECIMAL, 0, 0]);
        expect(r.slow).toBe(2);
        expect(r.fast).toBe(2);
    });

    test("an LCTYPE the table does not hold is 0 + ERROR_INVALID_FLAGS, not an empty string", () => {
        const r = bothTiers("GetLocaleInfoW", () => { }, [0x409, LOCALE_UNKNOWN_HOLE, DST, 64]);
        expect(r.slow).toBe(0);
        expect(r.slowErr).toBe(ERROR_INVALID_FLAGS);
        expect(r.fast).toBe(0);
        expect(r.fastErr).toBe(ERROR_INVALID_FLAGS);
        expect([...r.slowMem.subarray(DST, DST + 2)]).toEqual([UNTOUCHED, UNTOUCHED]);
        expect([...r.fastMem.subarray(DST, DST + 2)]).toEqual([UNTOUCHED, UNTOUCHED]);
    });

    test("LOCALE_ILANGUAGE|RETURN_NUMBER is the LANGID, read from a hex string", () => {
        const r = bothTiers("GetLocaleInfoW", () => { },
            [0x409, LOCALE_ILANGUAGE | LOCALE_RETURN_NUMBER, DST, 2]);
        expect(r.slow).toBe(2);
        expect(new DataView(r.slowMem.buffer).getUint32(DST, true)).toBe(0x0409);
        expect(r.fast).toBe(2);
        expect(new DataView(r.fastMem.buffer).getUint32(DST, true)).toBe(0x0409);
    });

    test("the A form refuses the same shapes", () => {
        const neg = bothTiers("GetLocaleInfoA", () => { }, [0x409, LOCALE_SDECIMAL, DST, -1]);
        expect(neg.slow).toBe(0);
        expect(neg.slowErr).toBe(ERROR_INVALID_PARAMETER);
        expect(neg.fast).toBe(0);
        expect(neg.fastErr).toBe(ERROR_INVALID_PARAMETER);

        const hole = bothTiers("GetLocaleInfoA", () => { }, [0x409, LOCALE_UNKNOWN_HOLE, DST, 64]);
        expect(hole.slow).toBe(0);
        expect(hole.slowErr).toBe(ERROR_INVALID_FLAGS);
        expect(hole.fast).toBe(0);
        expect(hole.fastErr).toBe(ERROR_INVALID_FLAGS);

        // "Sunday" needs 7 bytes; 4 cannot hold it. Windows fills what fits and fails.
        const small = bothTiers("GetLocaleInfoA", () => { }, [0x409, LOCALE_SDAYNAME7, DST, 4]);
        expect(small.slow).toBe(0);
        expect(small.slowErr).toBe(ERROR_INSUFFICIENT_BUFFER);
        expect(small.fast).toBe(0);
        expect(small.fastErr).toBe(ERROR_INSUFFICIENT_BUFFER);
        expect([...small.fastMem.subarray(DST, DST + 4)]).toEqual([...small.slowMem.subarray(DST, DST + 4)]);
    });
});

describe("the conversions fail an undersized destination instead of truncating", () => {
    test("MultiByteToWideChar: 0 + ERROR_INSUFFICIENT_BUFFER, destination filled to cchWideChar", () => {
        EmulatorConfig.getInstance().ansiCodePage = 1252;
        const bytes = [0x41, 0x42, 0x43, 0x44];
        const r = bothTiers("MultiByteToWideChar",
            (m) => m.set(bytes, SRC),
            [1252, 0, SRC, bytes.length, DST, 2]);
        expect(r.slow).toBe(0);
        expect(r.slowErr).toBe(ERROR_INSUFFICIENT_BUFFER);
        expect(r.fast).toBe(0);
        expect(r.fastErr).toBe(ERROR_INSUFFICIENT_BUFFER);
        expect([...r.fastMem.subarray(DST, DST + 4)]).toEqual([...r.slowMem.subarray(DST, DST + 4)]);
    });

    test("WideCharToMultiByte: 0 + ERROR_INSUFFICIENT_BUFFER, destination filled to cbMultiByte", () => {
        EmulatorConfig.getInstance().ansiCodePage = 1252;
        const r = bothTiers("WideCharToMultiByte",
            (m) => { putWide(m, SRC, "ABCD"); },
            [1252, 0, SRC, 4, DST, 2, 0, 0]);
        expect(r.slow).toBe(0);
        expect(r.slowErr).toBe(ERROR_INSUFFICIENT_BUFFER);
        expect(r.fast).toBe(0);
        expect(r.fastErr).toBe(ERROR_INSUFFICIENT_BUFFER);
        expect([...r.fastMem.subarray(DST, DST + 2)]).toEqual([...r.slowMem.subarray(DST, DST + 2)]);
    });

    test("a destination that fits is unaffected", () => {
        EmulatorConfig.getInstance().ansiCodePage = 1252;
        const r = bothTiers("WideCharToMultiByte",
            (m) => { putWide(m, SRC, "ABCD"); },
            [1252, 0, SRC, 4, DST, 64, 0, 0]);
        expect(r.slow).toBe(4);
        expect(r.fast).toBe(4);
    });
});

describe("WideCharToMultiByte reports substitution honestly on a multi-byte page", () => {
    const USED = 0x600;
    // A multi-byte ANSI page left behind here disables the inline mbwc stubs for every
    // test file that runs after this one in the same process.
    afterEach(() => { EmulatorConfig.getInstance().ansiCodePage = 1252; });
    const callThunk = (mem: Uint8Array, args: number[]) =>
        (kernelExports as Record<string, (c: unknown, m: Uint8Array, a: number[]) => number>)
        ["WideCharToMultiByte"]!(ctx, mem, args);

    test("a code point the page cannot encode sets lpUsedDefaultChar", () => {
        // CP932 (Shift-JIS) is multi-byte, so codePageToByteLut has no reverse table for it —
        // the branch that used to write FALSE without ever testing anything. Hiragana A has
        // no single-byte encoding, so encodeAnsiString substitutes and the round trip differs.
        EmulatorConfig.getInstance().ansiCodePage = 932;
        const mem = fresh();
        putWide(mem, SRC, "AあB");
        new DataView(mem.buffer).setUint32(USED, 0xdeadbeef, true);
        callThunk(mem, [932, 0, SRC, 3, DST, 64, 0, USED]);
        expect(new DataView(mem.buffer).getUint32(USED, true)).toBe(1);
    });

    test("a representable string on the same page reports FALSE", () => {
        EmulatorConfig.getInstance().ansiCodePage = 932;
        const mem = fresh();
        putWide(mem, SRC, "ABC");
        new DataView(mem.buffer).setUint32(USED, 0xdeadbeef, true);
        callThunk(mem, [932, 0, SRC, 3, DST, 64, 0, USED]);
        expect(new DataView(mem.buffer).getUint32(USED, true)).toBe(0);
    });
});
