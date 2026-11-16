import { registerCrtWidePathExports } from "../../src/worker/modules/crt-wide-path";
import { registerCrtWideFormatExports } from "../../src/worker/modules/crt-wide-format";
import { registerCrtWideCopyExports } from "../../src/worker/modules/crt-wide-copy";
/**
 * The wide-character and secure CRT entry points d3dcompiler_46.dll imports: the *_s string
 * copies and formatters, wcstol, and the wide path helpers.
 *
 * Contract (MSVC CRT docs, Wine dlls/msvcrt): sizes count wchar_t; a *_s call whose result
 * does not fit leaves the destination EMPTY and returns ERANGE, except when given _TRUNCATE,
 * which copies what fits and returns STRUNCATE.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { registerCrtVc8Exports } from "../../src/worker/modules/crt-vc8";
import { registerCrtPathExports } from "../../src/worker/modules/crt-path";
import { registerCrtConvExports } from "../../src/worker/modules/crt-conv";
import { ArrayVaListReader, formatCLazy } from "../../src/worker/modules/crt-format";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

const EINVAL = 22;
const ERANGE = 34;
const STRUNCATE = 80;
const TRUNCATE = 0xffffffff;

describe("wide and secure CRT functions", () => {
    let mem: Uint8Array;
    let exports: Record<string, ThunkImplementation>;
    let errno: number;
    let next: number;
    let originalCwd: string;

    const readC = (ptr: number): string => {
        let s = "";
        for (let i = ptr; i < mem.length && mem[i] !== 0; i++) s += String.fromCharCode(mem[i]!);
        return s;
    };
    const readW = (ptr: number, max = 0x10000): string => {
        let s = "";
        for (let i = 0; i < max; i++) {
            const c = mem[ptr + i * 2]! | (mem[ptr + i * 2 + 1]! << 8);
            if (c === 0) break;
            s += String.fromCharCode(c);
        }
        return s;
    };
    const writeW = (ptr: number, value: string, maxChars?: number): void => {
        const n = maxChars === undefined ? value.length : Math.min(value.length, Math.max(0, maxChars - 1));
        for (let i = 0; i < n; i++) {
            mem[ptr + i * 2] = value.charCodeAt(i) & 0xff;
            mem[ptr + i * 2 + 1] = value.charCodeAt(i) >> 8;
        }
        mem[ptr + n * 2] = 0;
        mem[ptr + n * 2 + 1] = 0;
    };
    const alloc = (size: number): number => { const p = next; next += (size + 15) & ~15; return p; };
    const wstr = (value: string): number => { const p = alloc(value.length * 2 + 2); writeW(p, value); return p; };
    /** A destination pre-filled with a marker, so "left empty" is distinguishable from "untouched". */
    const dest = (chars: number): number => { const p = alloc(chars * 2); writeW(p, "#".repeat(chars - 1)); return p; };

    beforeEach(() => {
        mem = new Uint8Array(0x40000);
        Mem.bind(() => mem);
        exports = {};
        errno = 0;
        next = 0x1000;
        originalCwd = System.getInstance().fileSystem.currentDir;
        System.getInstance().fileSystem.currentDir = "C:\\Game";
        registerCrtVc8Exports(exports, {
            process: {} as any,
            readCString: readC,
            writeCString: () => { throw new Error("narrow write in a wide test"); },
            readWString: readW,
            writeWString: writeW,
            malloc: alloc,
            free: () => 0,
            setErrno: (e) => { errno = e; },
            vsnprintf: () => -1,
        });
        registerCrtPathExports(exports, {
            readCString: readC,
            writeCString: () => { throw new Error("narrow write in a wide test"); },
            malloc: alloc,
            setErrno: (e) => { errno = e; return true; },
            nextTempnamSeq: () => 1,
        });
        registerCrtWideCopyExports(exports, { setErrno: e => { errno = e; } });
        registerCrtWideFormatExports(exports, {
            setErrno: e => { errno = e; },
            format: (fmt, args, first) => formatCLazy(readW(fmt), new ArrayVaListReader(args, first), readC, { wide: true, readWString: readW }),
        });
        registerCrtWidePathExports(exports, { readWString: readW, writeWString: writeW,
            malloc: alloc, setErrno: e => { errno = e; } });
        registerCrtConvExports(exports, {
            process: {} as any,
            readCString: readC,
            readWString: readW,
            writeCString: () => {},
            writeWString: writeW,
            setErrno: (e) => { errno = e; },
            writeUint16: () => {},
            caseLowerTableAddr: () => 0,
            caseUpperTableAddr: () => 0,
        });
    });
    afterEach(() => { System.getInstance().fileSystem.currentDir = originalCwd; });

    const call = (name: string, ...args: number[]): number => {
        const r = (exports[name] as any)(null, mem, args);
        return (typeof r === "object" ? r.value : r) >>> 0;
    };
    const signed = (v: number): number => v | 0;

    test("wcscpy_s copies when it fits and empties the destination when it does not", () => {
        const d = dest(8);
        expect(call("wcscpy_s", d, 8, wstr("shader"))).toBe(0);
        expect(readW(d)).toBe("shader");
        expect(call("wcscpy_s", d, 6, wstr("shader"))).toBe(ERANGE);
        expect(readW(d)).toBe("");
        expect(errno).toBe(ERANGE);
        expect(call("wcscpy_s", 0, 8, wstr("x"))).toBe(EINVAL);
    });

    test("wcscat_s appends within the buffer and refuses an overflow", () => {
        const d = dest(16);
        writeW(d, "C:\\");
        expect(call("wcscat_s", d, 16, wstr("shaders"))).toBe(0);
        expect(readW(d)).toBe("C:\\shaders");
        expect(call("wcscat_s", d, 12, wstr("\\vs.hlsl"))).toBe(ERANGE);
        expect(readW(d)).toBe("");
    });

    test("wcsncpy_s honors count, and _TRUNCATE keeps what fits", () => {
        const d = dest(6);
        expect(call("wcsncpy_s", d, 6, wstr("abcdefgh"), 3)).toBe(0);
        expect(readW(d)).toBe("abc");
        expect(call("wcsncpy_s", d, 6, wstr("abcdefgh"), 8)).toBe(ERANGE);
        expect(readW(d)).toBe("");
        expect(call("wcsncpy_s", d, 6, wstr("abcdefgh"), TRUNCATE)).toBe(STRUNCATE);
        expect(readW(d)).toBe("abcde");
    });

    test("wcsncat_s appends at most count characters", () => {
        const d = dest(10);
        writeW(d, "ab");
        expect(call("wcsncat_s", d, 10, wstr("cdefgh"), 2)).toBe(0);
        expect(readW(d)).toBe("abcd");
        expect(call("wcsncat_s", d, 10, wstr("efghijklmn"), TRUNCATE)).toBe(STRUNCATE);
        expect(readW(d)).toBe("abcdefghi");
    });

    test("swprintf_s formats its variadic arguments and refuses an overflow", () => {
        const d = dest(32);
        expect(call("swprintf_s", d, 32, wstr("%s(%d)"), wstr("main"), 16)).toBe(8);
        expect(readW(d)).toBe("main(16)");
        expect(signed(call("swprintf_s", d, 4, wstr("%s"), wstr("toolong")))).toBe(-1);
        expect(readW(d)).toBe("");
        expect(errno).toBe(ERANGE);
    });

    test("_snwprintf_s cuts to count, and _TRUNCATE fills the buffer", () => {
        const d = dest(16);
        // The fourth argument is the format; varargs start after it.
        expect(call("_snwprintf_s", d, 16, 15, wstr("%s\\%s"), wstr("C:"), wstr("x.h"))).toBe(6);
        expect(readW(d)).toBe("C:\\x.h");
        expect(signed(call("_snwprintf_s", d, 16, 3, wstr("%d"), 123456))).toBe(-1);
        expect(readW(d)).toBe("123");
        expect(signed(call("_snwprintf_s", d, 4, TRUNCATE, wstr("%d"), 123456))).toBe(-1);
        expect(readW(d)).toBe("123");
        expect(signed(call("_snwprintf_s", d, 4, 10, wstr("%d"), 123456))).toBe(-1);
        expect(readW(d)).toBe("");
        expect(errno).toBe(ERANGE);
    });

    test("wcstol parses like strtol and advances endptr by whole wide characters", () => {
        const s = wstr("  -0x1Fz");
        const end = alloc(4);
        expect(signed(call("wcstol", s, end, 0))).toBe(-31);
        expect(Mem.readUint32(end)).toBe(s + 7 * 2);
        expect(call("wcstol", wstr("42"), 0, 10)).toBe(42);
    });

    test("_ltow_s writes the digits, and empties a buffer too small for them", () => {
        const d = dest(8);
        expect(call("_ltow_s", -1234, d, 8, 10)).toBe(0);
        expect(readW(d)).toBe("-1234");
        expect(call("_ltow_s", 0x10de, d, 8, 16)).toBe(0);
        expect(readW(d)).toBe("10de");
        expect(call("_ltow_s", 123456, d, 4, 10)).toBe(ERANGE);
        expect(readW(d)).toBe("");
        expect(call("_ltow_s", 1, d, 8, 1)).toBe(EINVAL);
    });

    test("_wfullpath resolves against the current directory, malloc'ing for NULL", () => {
        const d = dest(64);
        expect(call("_wfullpath", d, wstr("shaders\\..\\shaders\\vs.hlsl"), 64)).toBe(d);
        expect(readW(d)).toBe("C:\\Game\\shaders\\vs.hlsl");
        const owned = call("_wfullpath", 0, wstr("x.h"), 0);
        expect(owned).toBeGreaterThan(0);
        expect(readW(owned)).toBe("C:\\Game\\x.h");
        expect(call("_wfullpath", d, wstr("a-long-relative-name"), 8)).toBe(0);
        expect(errno).toBe(ERANGE);
    });

    test("_wsplitpath_s splits into sized buffers and fails whole on a short one", () => {
        const [drive, dir, fname, ext] = [dest(3), dest(64), dest(32), dest(8)];
        const path = wstr("C:\\Game\\shaders\\vs_global.hlsl");
        expect(call("_wsplitpath_s", path, drive, 3, dir, 64, fname, 32, ext, 8)).toBe(0);
        expect([readW(drive), readW(dir), readW(fname), readW(ext)])
            .toEqual(["C:", "\\Game\\shaders\\", "vs_global", ".hlsl"]);
        expect(call("_wsplitpath_s", path, 0, 0, dir, 64, fname, 4, 0, 0)).toBe(ERANGE);
        expect([readW(dir), readW(fname)]).toEqual(["", ""]);
        expect(call("_wsplitpath_s", path, drive, 0, 0, 0, 0, 0, 0, 0)).toBe(EINVAL);
    });

    test("_wmakepath_s joins components and empties the buffer on overflow", () => {
        const d = dest(32);
        expect(call("_wmakepath_s", d, 32, wstr("C"), wstr("\\shaders"), wstr("vs"), wstr("hlsl"))).toBe(0);
        expect(readW(d)).toBe("C:\\shaders\\vs.hlsl");
        expect(call("_wmakepath_s", d, 8, wstr("C"), wstr("\\shaders"), wstr("vs"), wstr("hlsl"))).toBe(ERANGE);
        expect(readW(d)).toBe("");
    });
});
