/**
 * _ecvt/_fcvt digit generation and the _mktemp/_getdiskfree contracts.
 *
 * Ground truth: the VC6 CRT (cvt.c _ecvt/_fcvt/_fpcvt, cfout.c _fltout2 at 17 significant
 * digits, fpcvt.c _fptostr, mktemp.c). The 17-digit mantissa is why VC prints 0.1 with
 * "%.20f" as 0.10000000000000001000, and _fptostr rounding raw characters is why it prints
 * a one-decimal infinity as "1.$".
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { fltout, fptostr, registerCrtConvExports, resetCrtConvStatics } from "../../src/worker/modules/crt-conv";
import { registerCrtPathExports, type CrtPathHost } from "../../src/worker/modules/crt-path";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

function bitsOf(value: number): [number, number] {
    const u32 = new Uint32Array(new Float64Array([value]).buffer);
    return [u32[0]!, u32[1]!];
}

/** _ecvt(value, ndigit) as text/decpt/sign, through the same two stages the export uses. */
function ecvt(value: number, ndigit: number) {
    const flt = fltout(...bitsOf(value));
    const r = fptostr(flt, ndigit);
    return { text: ndigit > 0 ? r.text.slice(0, ndigit) : r.text, decpt: r.decpt, sign: flt.negative ? 1 : 0 };
}

function fcvt(value: number, ndec: number) {
    const flt = fltout(...bitsOf(value));
    const r = fptostr(flt, flt.decpt + ndec);
    return { text: r.text, decpt: r.decpt, sign: flt.negative ? 1 : 0 };
}

describe("_ecvt", () => {
    test("rounds to ndigit significant digits", () => {
        expect(ecvt(3.14159, 3)).toEqual({ text: "314", decpt: 1, sign: 0 });
        expect(ecvt(-0.00123, 2)).toEqual({ text: "12", decpt: -2, sign: 1 });
    });

    test("a carry out of the first digit keeps ndigit characters and moves decpt", () => {
        expect(ecvt(9.99, 2)).toEqual({ text: "10", decpt: 2, sign: 0 });
    });

    test("zero pads with '0' at decpt 0", () => {
        expect(ecvt(0, 3)).toEqual({ text: "000", decpt: 0, sign: 0 });
        expect(ecvt(-0, 1).sign).toBe(1);
    });

    test("digits beyond the 17-digit mantissa are zeros, not the exact binary expansion", () => {
        expect(ecvt(0.1, 20).text).toBe("10000000000000001000");
    });

    test("specials come from _fltout2's mantissa string", () => {
        expect(ecvt(Infinity, 5)).toEqual({ text: "1#INF", decpt: 1, sign: 0 });
        expect(ecvt(-Infinity, 1)).toEqual({ text: "1", decpt: 1, sign: 1 });
    });
});

describe("_fcvt", () => {
    test("ndec counts digits after the decimal point", () => {
        expect(fcvt(3.14159, 2)).toEqual({ text: "314", decpt: 1, sign: 0 });
        expect(fcvt(1234.5, 0)).toEqual({ text: "1235", decpt: 4, sign: 0 });
    });

    test("a value below the requested precision yields an empty string", () => {
        expect(fcvt(0.0001234, 2)).toEqual({ text: "", decpt: -3, sign: 0 });
    });

    test("rounding at the zeroth digit produces '1' and moves decpt", () => {
        expect(fcvt(0.009, 2)).toEqual({ text: "1", decpt: -1, sign: 0 });
    });

    test("a carry grows the string with decpt", () => {
        expect(fcvt(9.99, 1)).toEqual({ text: "100", decpt: 2, sign: 0 });
    });

    test("rounding runs over a special's raw characters: '#' + 1 is '$'", () => {
        expect(fcvt(Infinity, 1).text).toBe("1$");
    });
});

describe("_ecvt / _fcvt exports", () => {
    test("read the double from two stack dwords, write *dec and *sign, and share one per-thread buffer", () => {
        resetCrtConvStatics();
        const mem = new Uint8Array(0x10000);
        Mem.bind(() => mem);
        const exports: Record<string, ThunkImplementation> = {};
        let allocs = 0;
        registerCrtConvExports(exports, {
            process: { memory: { alloc: () => { allocs++; return 0x8000; } } } as any,
            readCString: () => "",
            readWString: () => "",
            writeCString: (ptr, value) => {
                for (let i = 0; i < value.length; i++) mem[ptr + i] = value.charCodeAt(i);
                mem[ptr + value.length] = 0;
            },
            writeUint16: () => {},
            caseLowerTableAddr: () => 0,
            caseUpperTableAddr: () => 0,
        });
        const view = new DataView(mem.buffer);
        const text = (ptr: number) => {
            let s = "";
            for (let i = ptr; mem[i] !== 0; i++) s += String.fromCharCode(mem[i]!);
            return s;
        };

        const e = (exports["_ecvt"] as any)(null, mem, [...bitsOf(-9.99), 2, 0x100, 0x104]);
        expect(e).toBe(0x8000);
        expect(text(e)).toBe("10");
        expect(view.getInt32(0x100, true)).toBe(2);
        expect(view.getInt32(0x104, true)).toBe(1);

        const f = (exports["_fcvt"] as any)(null, mem, [...bitsOf(0.0001234), 2, 0x100, 0x104]);
        expect(f).toBe(0x8000);
        expect(text(f)).toBe("");
        expect(view.getInt32(0x100, true)).toBe(-3);
        expect(allocs).toBe(1);
    });
});

describe("_mktemp / _getdiskfree", () => {
    let mem: Uint8Array;
    let exports: Record<string, ThunkImplementation>;
    let errno: number;

    const readC = (ptr: number) => {
        let s = "";
        for (let i = ptr; i < mem.length && mem[i] !== 0; i++) s += String.fromCharCode(mem[i]!);
        return s;
    };
    const writeC = (ptr: number, value: string) => {
        for (let i = 0; i < value.length; i++) mem[ptr + i] = value.charCodeAt(i) & 0xff;
        mem[ptr + value.length] = 0;
    };
    const call = (name: string, ...args: number[]) => (exports[name] as any)(null, mem, args) as number;

    beforeEach(() => {
        mem = new Uint8Array(0x10000);
        Mem.bind(() => mem);
        exports = {};
        errno = 0;
        const host: CrtPathHost = {
            readCString: (ptr) => readC(ptr),
            writeCString: writeC,
            malloc: () => 0,
            setErrno: (e) => { errno = e; return true; },
            nextTempnamSeq: () => 1,
        };
        registerCrtPathExports(exports, host);
    });

    test("_mktemp replaces six trailing X's in place with a letter and five thread-id digits", () => {
        writeC(0x100, "C:\\tmpXXXXXX");
        const tid = System.getInstance().scheduler.getCurrentThreadId() >>> 0;
        expect(call("_mktemp", 0x100)).toBe(0x100);
        const digits = String(tid % 100000).padStart(5, "0");
        expect(readC(0x100)).toBe(`C:\\tmpa${digits}`);
    });

    test("_mktemp refuses fewer than six trailing X's", () => {
        writeC(0x100, "tmpXXXXX");
        expect(call("_mktemp", 0x100)).toBe(0);
        writeC(0x100, "XXXXXXtmp");
        expect(call("_mktemp", 0x100)).toBe(0);
    });

    test("_getdiskfree fills struct _diskfree_t and returns 0", () => {
        expect(call("_getdiskfree", 3, 0x200)).toBe(0);
        const view = new DataView(mem.buffer);
        const total = view.getUint32(0x200, true);
        const avail = view.getUint32(0x204, true);
        expect(total).toBeGreaterThan(0);
        expect(avail).toBeLessThanOrEqual(total);
        expect(view.getUint32(0x208, true)).toBe(8);
        expect(view.getUint32(0x20c, true)).toBe(512);
    });

    test("_getdiskfree rejects a drive past Z: and a NULL struct", () => {
        expect(call("_getdiskfree", 27, 0x200)).toBe(87);
        expect(errno).toBe(22);
        expect(call("_getdiskfree", 0, 0)).toBe(87);
    });
});
