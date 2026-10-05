/**
 * CRT math intrinsics (FPU fallbacks).
 *
 * Two flavours, both JS fallbacks for when the WASM math hypercalls (Tier 2)
 * don't fire:
 *   - `_CI*` (Microsoft __cdecl FPU-calling-convention helpers): operands arrive
 *     on the x87 stack (ST(0)/ST(1)); the result replaces ST(0).
 *   - the libc-style entries (`sqrt`, `pow`, `sin`, …): the double argument(s)
 *     arrive as (lo, hi) u32 pairs on the integer stack and the result is
 *     returned via ST(0) (`fpuPush`), matching how the guest's `_ftol`/`fld`
 *     prologue expects a returned double.
 *
 * Pure compute over the host's v86 FPU; no other msvcrt state.
 */

import { Mem } from "../core/memory/mem-accessor";
import { Logger, LogCategory } from "../core/logger";
import { fpuGetST, fpuPop, fpuPush, fpuSetST0, xmmGetLowDouble, xmmSetLowDouble } from "../core/fpu-helper";
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import type { Process } from "../core/process";

export interface CrtMathHost {
    process: Process;
    /** Reinterpret two u32 halves (lo, hi) as an IEEE-754 double. */
    u32PairToDouble(lo: number, hi: number): number;
}

export function registerCrtMathExports(exports: Record<string, ThunkImplementation>, host: CrtMathHost): void {
    // --- _CI* : operands/result on the x87 stack -----------------------------
    /** Unary _CI helper: replace ST(0) with fn(ST(0)); on error leave `fallback`. */
    const ci1 = (name: string, fn: (x: number) => number, fallback: number): number => {
        try {
            const x = fpuGetST(host.process.v86, 0);
            fpuSetST0(host.process.v86, fn(x));
            return 0;
        } catch (e) {
            Logger.log(LogCategory.SYSTEM, `msvcrt.${name} failed: ${e}`);
            try { fpuSetST0(host.process.v86, fallback); } catch { /* FPU gone */ }
            return 0;
        }
    };

    exports["_CIpow"] = () => {
        try {
            const exponent = fpuGetST(host.process.v86, 0);
            const base = fpuGetST(host.process.v86, 1);
            const result = Math.pow(base, exponent);
            fpuPop(host.process.v86);
            fpuSetST0(host.process.v86, result);
            return 0;
        } catch (e) {
            Logger.log(LogCategory.SYSTEM, `msvcrt._CIpow failed: ${e}`);
            try { fpuSetST0(host.process.v86, 1); } catch { /* FPU gone */ }
            return 0;
        }
    };
    exports["_CIsqrt"] = () => ci1("_CIsqrt", Math.sqrt, 0);
    exports["_CIlog"] = () => ci1("_CIlog", Math.log, 0);
    exports["_CIcos"] = () => ci1("_CIcos", Math.cos, 0);
    exports["_CIsin"] = () => ci1("_CIsin", Math.sin, 0);
    exports["_CIexp"] = () => ci1("_CIexp", Math.exp, 0);
    exports["_CIacos"] = () => ci1("_CIacos", Math.acos, 0);
    exports["_CIasin"] = () => ci1("_CIasin", Math.asin, 0);
    exports["_CIlog10"] = () => ci1("_CIlog10", Math.log10, 0);
    exports["_CIsinh"] = () => ci1("_CIsinh", Math.sinh, 0);
    exports["_CIcosh"] = () => ci1("_CIcosh", Math.cosh, 1);
    exports["_CItanh"] = () => ci1("_CItanh", Math.tanh, 0);

    // --- MSVC 2015+ /arch:SSE2 entries: operands and result in XMM, NOTHING on ---
    // --- the stack. Same computation as the libc-style block below; only how the -
    // --- operand travels differs, so the stub must pop 0 bytes.                  -
    const sse2Unary = (fn: (x: number) => number): ThunkImplementation => () => {
        const x = xmmGetLowDouble(host.process.v86, 0);
        if (x === null) {
            Logger.warn(LogCategory.SYSTEM, "msvcrt._libm_sse2_*: no SSE state available");
            return 0;
        }
        xmmSetLowDouble(host.process.v86, 0, fn(x));
        return 0;
    };
    exports["_libm_sse2_acos_precise"] = sse2Unary(Math.acos);
    exports["_libm_sse2_atan_precise"] = sse2Unary(Math.atan);
    exports["_libm_sse2_cos_precise"] = sse2Unary(Math.cos);
    exports["_libm_sse2_exp_precise"] = sse2Unary(Math.exp);
    exports["_libm_sse2_log_precise"] = sse2Unary(Math.log);
    exports["_libm_sse2_sin_precise"] = sse2Unary(Math.sin);
    exports["_libm_sse2_sqrt_precise"] = sse2Unary(Math.sqrt);
    exports["_libm_sse2_tan_precise"] = sse2Unary(Math.tan);
    exports["_libm_sse2_pow_precise"] = () => {
        const base = xmmGetLowDouble(host.process.v86, 0);
        const exponent = xmmGetLowDouble(host.process.v86, 1);
        if (base === null || exponent === null) {
            Logger.warn(LogCategory.SYSTEM, "msvcrt._libm_sse2_pow_precise: no SSE state available");
            return 0;
        }
        xmmSetLowDouble(host.process.v86, 0, Math.pow(base, exponent));
        return 0;
    };

    /**
     * The FP-error reporting hook the _libm_sse2_* routines call when a computation
     * raised an exception, returning the (possibly substituted) result in ST(0). We
     * compute exactly and never unmask an FP exception, so the caller's own `res`
     * stands — the branch the real _except1 takes when nothing is unmasked.
     *
     * double _except1(DWORD fpe, int op, double arg, double res, DWORD cw, void *unk)
     */
    exports["_except1"] = (_c, _m, a) => {
        fpuPush(host.process.v86, host.u32PairToDouble(a[4] ?? 0, a[5] ?? 0));
        return 0;
    };

    /** _FPCLASS_* (float.h). */
    exports["_fpclass"] = (_c, _m, a) => {
        const x = host.u32PairToDouble(a[0] ?? 0, a[1] ?? 0);
        if (Number.isNaN(x)) return 0x0002;                       // _FPCLASS_QNAN
        if (x === Infinity) return 0x0200;                        // _FPCLASS_PINF
        if (x === -Infinity) return 0x0004;                       // _FPCLASS_NINF
        const negative = x < 0 || Object.is(x, -0);
        if (x === 0) return negative ? 0x0020 : 0x0040;           // _FPCLASS_NZ / _PZ
        const subnormal = Math.abs(x) < 2.2250738585072014e-308;  // < DBL_MIN
        if (negative) return subnormal ? 0x0010 : 0x0008;         // _FPCLASS_ND / _NN
        return subnormal ? 0x0080 : 0x0100;                       // _FPCLASS_PD / _PN
    };

    // --- libc-style: double args as (lo,hi) u32, result via ST(0) ------------
    /** Generic unary math function: takes double as (lo,hi) u32, returns via FPU ST(0). */
    const mathUnary = (fn: (x: number) => number, lo: number, hi: number): number => {
        const value = host.u32PairToDouble(lo, hi);
        const result = fn(value);
        fpuPush(host.process.v86, result);
        return (result | 0) >>> 0;
    };

    exports["sqrt"] = (_c, _m, a) => mathUnary(Math.sqrt, a[0] ?? 0, a[1] ?? 0);
    exports["sin"] = (_c, _m, a) => mathUnary(Math.sin, a[0] ?? 0, a[1] ?? 0);
    exports["cos"] = (_c, _m, a) => mathUnary(Math.cos, a[0] ?? 0, a[1] ?? 0);
    exports["acos"] = (_c, _m, a) => mathUnary(Math.acos, a[0] ?? 0, a[1] ?? 0);
    exports["asin"] = (_c, _m, a) => mathUnary(Math.asin, a[0] ?? 0, a[1] ?? 0);
    exports["atan"] = (_c, _m, a) => mathUnary(Math.atan, a[0] ?? 0, a[1] ?? 0);
    exports["tan"] = (_c, _m, a) => mathUnary(Math.tan, a[0] ?? 0, a[1] ?? 0);
    exports["sinh"] = (_c, _m, a) => mathUnary(Math.sinh, a[0] ?? 0, a[1] ?? 0);
    exports["cosh"] = (_c, _m, a) => mathUnary(Math.cosh, a[0] ?? 0, a[1] ?? 0);
    exports["tanh"] = (_c, _m, a) => mathUnary(Math.tanh, a[0] ?? 0, a[1] ?? 0);
    exports["fabs"] = (_c, _m, a) => mathUnary(Math.abs, a[0] ?? 0, a[1] ?? 0);
    exports["log"] = (_c, _m, a) => mathUnary(Math.log, a[0] ?? 0, a[1] ?? 0);
    exports["log10"] = (_c, _m, a) => mathUnary(Math.log10, a[0] ?? 0, a[1] ?? 0);
    exports["exp"] = (_c, _m, a) => mathUnary(Math.exp, a[0] ?? 0, a[1] ?? 0);

    exports["pow"] = (_c, _m, a) => {
        const x = host.u32PairToDouble(a[0] ?? 0, a[1] ?? 0);
        const y = host.u32PairToDouble(a[2] ?? 0, a[3] ?? 0);
        fpuPush(host.process.v86, Math.pow(x, y));
        return 0;
    };

    exports["atan2"] = (_c, _m, a) => {
        const y = host.u32PairToDouble(a[0] ?? 0, a[1] ?? 0);
        const x = host.u32PairToDouble(a[2] ?? 0, a[3] ?? 0);
        fpuPush(host.process.v86, Math.atan2(y, x));
        return 0;
    };

    exports["fmod"] = (_c, _m, a) => {
        const x = host.u32PairToDouble(a[0] ?? 0, a[1] ?? 0);
        const y = host.u32PairToDouble(a[2] ?? 0, a[3] ?? 0);
        fpuPush(host.process.v86, y !== 0 ? x % y : 0);
        return 0;
    };

    exports["ldexp"] = (_c, _m, a) => {
        const x = host.u32PairToDouble(a[0] ?? 0, a[1] ?? 0);
        fpuPush(host.process.v86, x * Math.pow(2, (a[2] ?? 0) | 0));
        return 0;
    };

    exports["frexp"] = (_c, _m, a) => {
        const x = host.u32PairToDouble(a[0] ?? 0, a[1] ?? 0);
        const expPtr = a[2] ?? 0;
        if (x === 0) {
            if (expPtr) Mem.writeUint32(expPtr, 0);
            fpuPush(host.process.v86, 0);
            return 0;
        }
        const exp = Math.floor(Math.log2(Math.abs(x))) + 1;
        const mantissa = x / Math.pow(2, exp);
        if (expPtr) Mem.writeUint32(expPtr, exp | 0);
        fpuPush(host.process.v86, mantissa);
        return 0;
    };

    exports["modf"] = (_c, _m, a) => {
        const x = host.u32PairToDouble(a[0] ?? 0, a[1] ?? 0);
        const intPtr = a[2] ?? 0;
        const intPart = Math.trunc(x);
        const fracPart = x - intPart;
        if (intPtr) {
            const buf = new ArrayBuffer(8);
            const f64 = new Float64Array(buf);
            const u32 = new Uint32Array(buf);
            f64[0] = intPart;
            Mem.writeUint32(intPtr, u32[0]);
            Mem.writeUint32(intPtr + 4, u32[1]);
        }
        fpuPush(host.process.v86, fracPart);
        return 0;
    };
}
