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

import { describe, expect, test } from "bun:test";
import { exports as kernelExports } from "../../src/worker/modules/kernel32/locale";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";

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

/** Drive the fast path through a fake CPU whose stack holds the stdcall arguments. */
function callFastPath(
    name: "WideCharToMultiByte" | "MultiByteToWideChar" | "LCMapStringW",
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
    name: "WideCharToMultiByte" | "MultiByteToWideChar" | "LCMapStringW",
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

    test("declines a call carrying a default char rather than guessing", () => {
        EmulatorConfig.getInstance().ansiCodePage = 1252;
        const r = compare("WideCharToMultiByte",
            (m) => putWide(m, SRC, "x"),
            [1252, 0, SRC, 1, DST, 8, 0x700, 0x704]);
        expect(r.fast).toBeNull();
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

    test("declines a character whose case mapping changes length", () => {
        // U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE lowercases to two code units.
        const r = compare("LCMapStringW",
            (m) => putWide(m, SRC, "AİB"),
            [0x409, LOWER, SRC, 3, DST, 64]);
        expect(r.fast).toBeNull();
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
