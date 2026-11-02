/**
 * CRT conversion functions (atoi/atol/atof, strtol/strtoul/strtod, _ltoa/_ultoa/
 * _itoa, toupper/tolower, abs/labs, mbstowcs/wcstombs/wctomb, _wtoi/wcstoul, _ecvt/_fcvt).
 *
 * Host supplies codepage-aware string readers/writers, FPU push for
 * double-returning functions (atof/strtod), and locale-aware case-fold LUT
 * addresses (toupper/tolower index the same guest tables the trap-free inline
 * stubs use — see Msvcrt.buildCaseTables). The only state is _ecvt/_fcvt's
 * per-thread _cvtbuf, forgotten with the process via resetCrtConvStatics.
 */

import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import { fpuPush } from "../core/fpu-helper";
import { Logger, LogCategory } from "../core/logger";
import { encodeAnsi } from "./crt-format";
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import type { Process } from "../core/process";

export interface CrtConvHost {
    process: Process;
    readCString(ptr: number, maxLen: number): string;
    readWString(ptr: number, maxChars: number): string;
    writeCString(ptr: number, value: string): void;
    writeUint16(addr: number, value: number): void;
    /** Live guest address of the tolower LUT (0 until allocated) — see Msvcrt.buildCaseTables. */
    caseLowerTableAddr(): number;
    /** Live guest address of the toupper LUT (0 until allocated). */
    caseUpperTableAddr(): number;
}

export function registerCrtConvExports(exports: Record<string, ThunkImplementation>, host: CrtConvHost): void {

    function atoi(ptr: number): number {
        const value = host.readCString(ptr, 256).trim();
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) ? (parsed | 0) : 0;
    }

    function atol(ptr: number): number {
        return atoi(ptr);
    }

    function ltoa(value: number, buffer: number, radix: number): number {
        if (!buffer) return 0;
        const base = radix > 1 ? radix : 10;
        const signed = (base === 10);
        const val = signed ? (value | 0) : (value >>> 0);
        const text = (signed && val < 0) ? `-${Math.abs(val).toString(base)}` : val.toString(base);
        host.writeCString(buffer, text);
        return buffer >>> 0;
    }

    function ultoa(value: number, buffer: number, radix: number): number {
        if (!buffer) return 0;
        const base = radix > 1 ? radix : 10;
        host.writeCString(buffer, (value >>> 0).toString(base));
        return buffer >>> 0;
    }

    function atof(ptr: number): number {
        const str = host.readCString(ptr, 256).trim();
        const value = parseFloat(str);
        const result = Number.isFinite(value) ? value : 0;
        fpuPush(host.process.v86, result);
        return 0;
    }

    function strtol(strPtr: number, endPtr: number, base: number): number {
        const str = host.readCString(strPtr, 256);
        let radix = base | 0;

        let start = 0;
        while (start < str.length && /\s/.test(str[start])) start++;

        let negative = false;
        if (str[start] === '-') { negative = true; start++; }
        else if (str[start] === '+') { start++; }

        // Auto-detect base
        if (radix === 0) {
            if (str[start] === '0' && (str[start + 1] === 'x' || str[start + 1] === 'X')) { radix = 16; start += 2; }
            else if (str[start] === '0') { radix = 8; start++; }
            else { radix = 10; }
        } else if (radix === 16 && str[start] === '0' && (str[start + 1] === 'x' || str[start + 1] === 'X')) {
            start += 2;
        }

        let end = start;
        while (end < str.length) {
            const c = str[end].toLowerCase();
            const digit = c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 :
                          c >= 'a' && c <= 'z' ? c.charCodeAt(0) - 87 : -1;
            if (digit < 0 || digit >= radix) break;
            end++;
        }

        const numStr = str.slice(start, end);
        let value = numStr.length > 0 ? parseInt(numStr, radix) | 0 : 0;
        if (negative) value = -value;

        if (endPtr) Mem.writeUint32(endPtr, strPtr + end);
        return value;
    }

    function strtoul(strPtr: number, endPtr: number, base: number): number {
        const str = host.readCString(strPtr, 256);
        let radix = base | 0;

        let start = 0;
        while (start < str.length && /\s/.test(str[start])) start++;
        if (str[start] === '+') start++;

        if (radix === 0) {
            if (str[start] === '0' && (str[start + 1] === 'x' || str[start + 1] === 'X')) { radix = 16; start += 2; }
            else if (str[start] === '0') { radix = 8; start++; }
            else { radix = 10; }
        } else if (radix === 16 && str[start] === '0' && (str[start + 1] === 'x' || str[start + 1] === 'X')) {
            start += 2;
        }

        let end = start;
        while (end < str.length) {
            const c = str[end].toLowerCase();
            const digit = c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 :
                          c >= 'a' && c <= 'z' ? c.charCodeAt(0) - 87 : -1;
            if (digit < 0 || digit >= radix) break;
            end++;
        }

        const numStr = str.slice(start, end);
        const value = numStr.length > 0 ? parseInt(numStr, radix) >>> 0 : 0;

        if (endPtr) Mem.writeUint32(endPtr, strPtr + end);
        return value;
    }

    function strtod(strPtr: number, endPtr: number): number {
        const str = host.readCString(strPtr, 256);
        let start = 0;
        while (start < str.length && /\s/.test(str[start])) start++;
        const value = parseFloat(str.slice(start));
        const result = Number.isFinite(value) ? value : 0;
        fpuPush(host.process.v86, result);
        if (endPtr) {
            // Find where parsing ended
            const match = str.slice(start).match(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
            const consumed = match ? start + match[0].length : start;
            Mem.writeUint32(endPtr, strPtr + consumed);
        }
        return 0;
    }

    function toupper(ch: number): number {
        const c = ch & 0xff;
        const caseUpperTableAddr = host.caseUpperTableAddr();
        if (caseUpperTableAddr) {
            const v = Mem.readUint8(caseUpperTableAddr + c);
            if (v !== null) return v;
        }
        return (c >= 0x61 && c <= 0x7a) ? c - 0x20 : c;
    }

    function tolower(ch: number): number {
        const c = ch & 0xff;
        const caseLowerTableAddr = host.caseLowerTableAddr();
        if (caseLowerTableAddr) {
            const v = Mem.readUint8(caseLowerTableAddr + c);
            if (v !== null) return v;
        }
        return (c >= 0x41 && c <= 0x5a) ? c + 0x20 : c;
    }

    function abs(value: number): number {
        const v = value | 0;
        return v < 0 ? -v : v;
    }

    function mbstowcs(dest: number, src: number, count: number): number {
        if (!src) return 0;
        const maxChars = count >>> 0;
        const str = host.readCString(src, maxChars > 0 ? maxChars : 0x100000);
        if (!dest) return str.length;
        const writeChars = Math.min(str.length, maxChars > 0 ? maxChars : str.length);
        for (let i = 0; i < writeChars; i++) {
            host.writeUint16(dest + i * 2, str.charCodeAt(i));
        }
        if (writeChars < maxChars) {
            host.writeUint16(dest + writeChars * 2, 0);
        }
        return writeChars;
    }

    function wcstombs(dest: number, src: number, count: number): number {
        if (!src) return 0;
        const maxBytes = count >>> 0;
        const wideStr: number[] = [];
        for (let i = 0; i < 0x100000; i += 2) {
            const ch = Mem.readUint16(src + i);
            if (ch === null || ch === 0) break;
            wideStr.push(ch);
        }
        const str = String.fromCharCode(...wideStr);
        const bytes = encodeAnsi(str);
        if (!dest) return bytes.length;
        const copyLen = Math.min(bytes.length, maxBytes > 0 ? maxBytes - 1 : bytes.length);
        Mem.writeBytes(dest, bytes.subarray(0, copyLen));
        if (maxBytes > copyLen) {
            Mem.writeBytes(dest + copyLen, new Uint8Array([0]));
        }
        return copyLen;
    }

    function wctomb(dest: number, wchar: number): number {
        if (!dest) return 0;
        Mem.writeBytes(dest, new Uint8Array([wchar & 0xff]));
        return 1;
    }

    function wtoi(ptr: number): number {
        const str = host.readWString(ptr, 256).trim();
        const parsed = parseInt(str, 10);
        const result = Number.isFinite(parsed) ? (parsed | 0) : 0;
        const preview = str.replace(/\r/g, "\\r").replace(/\n/g, "\\n").slice(0, 120);
        Logger.log(LogCategory.THUNK, `_wtoi: ptr=0x${(ptr >>> 0).toString(16)} text="${preview}" -> ${result}`);
        return result;
    }

    function wcstoul(ptr: number, endPtr: number, base: number): number {
        const str = host.readWString(ptr, 256).trim();
        const radix = (base >>> 0) || 10;
        const parsed = parseInt(str, radix);
        if (endPtr) Mem.writeUint32(endPtr, 0);
        return Number.isFinite(parsed) ? (parsed >>> 0) : 0;
    }

    exports["_wtoi"] = (ctx, mem, args) => wtoi(args[0] ?? 0);
    exports["wcstoul"] = (ctx, mem, args) => wcstoul(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);

    exports["atoi"] = (ctx, mem, args) => atoi(args[0] ?? 0);
    exports["atol"] = (ctx, mem, args) => atol(args[0] ?? 0);
    exports["_ltoa"] = (ctx, mem, args) => ltoa(args[0] ?? 0, args[1] ?? 0, args[2] ?? 10);
    exports["_ultoa"] = (ctx, mem, args) => ultoa(args[0] ?? 0, args[1] ?? 0, args[2] ?? 10);

    exports["atof"] = (ctx, mem, args) => atof(args[0] ?? 0);

    exports["strtol"] = (ctx, mem, args) => strtol(args[0] ?? 0, args[1] ?? 0, args[2] ?? 10);
    exports["strtoul"] = (ctx, mem, args) => strtoul(args[0] ?? 0, args[1] ?? 0, args[2] ?? 10);
    exports["strtod"] = (ctx, mem, args) => strtod(args[0] ?? 0, args[1] ?? 0);
    exports["toupper"] = (ctx, mem, args) => toupper(args[0] ?? 0);
    exports["tolower"] = (ctx, mem, args) => tolower(args[0] ?? 0);
    exports["abs"] = (ctx, mem, args) => abs(args[0] ?? 0);
    exports["labs"] = (ctx, mem, args) => abs(args[0] ?? 0);
    exports["_itoa"] = (ctx, mem, args) => ltoa(args[0] ?? 0, args[1] ?? 0, args[2] ?? 10);
    exports["mbstowcs"] = (ctx, mem, args) => mbstowcs(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
    exports["wcstombs"] = (ctx, mem, args) => wcstombs(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
    exports["wctomb"] = (ctx, mem, args) => wctomb(args[0] ?? 0, args[1] ?? 0);

    /** _ecvt/_fcvt: write the digits into the calling thread's _cvtbuf; *dec and *sign as the CRT reports them. */
    function cvt(lo: number, hi: number, ndigit: number, fixed: boolean, decPtr: number, signPtr: number): number {
        const flt = fltout(lo >>> 0, hi >>> 0);
        const digits = fixed ? flt.decpt + ndigit : ndigit;
        const rounded = fptostr(flt, Math.min(digits, CVTBUFSIZE - 2));
        const { decpt } = rounded;
        // _ecvt drops the extra character a carry adds ("99" -> "100" -> "10"); _fcvt's count already grew with decpt.
        const text = !fixed && digits > 0 ? rounded.text.slice(0, digits) : rounded.text;
        if (decPtr) Mem.writeUint32(decPtr, decpt);
        if (signPtr) Mem.writeUint32(signPtr, flt.negative ? 1 : 0);
        const tid = System.getInstance().scheduler.getCurrentThreadId();
        let buf = cvtBuffers.get(tid);
        if (!buf) {
            buf = host.process.memory.alloc(CVTBUFSIZE, "THUNK_DATA", "rw");
            cvtBuffers.set(tid, buf);
        }
        host.writeCString(buf, text);
        return buf >>> 0;
    }

    // The double occupies args[0..1]; then ndigit, int *dec, int *sign.
    exports["_ecvt"] = (ctx, mem, args) => cvt(args[0] ?? 0, args[1] ?? 0, (args[2] ?? 0) | 0, false, args[3] ?? 0, args[4] ?? 0);
    exports["_fcvt"] = (ctx, mem, args) => cvt(args[0] ?? 0, args[1] ?? 0, (args[2] ?? 0) | 0, true, args[3] ?? 0, args[4] ?? 0);
}

/** _CVTBUFSIZE (309 + 40): the per-thread buffer _ecvt and _fcvt share. */
const CVTBUFSIZE = 349;

/** Per-thread _cvtbuf addresses. Guest memory that Process.reset() rewinds — see resetCrtConvStatics. */
const cvtBuffers = new Map<number, number>();

export function resetCrtConvStatics(): void {
    cvtBuffers.clear();
}

export interface Fltout {
    /** Significant digits, trailing zeros stripped ("" for zero), or the "1#INF"-style special. */
    mantissa: string;
    /** value = 0.mantissa × 10^decpt. */
    decpt: number;
    negative: boolean;
}

/** The CRT's _fltout2: at most 17 significant digits, the precision every msvcrt float conversion starts from. */
export function fltout(lo: number, hi: number): Fltout {
    const negative = (hi >>> 31) === 1;
    const exponent = (hi >>> 20) & 0x7ff;
    const fractionHi = hi & 0xfffff;
    if (exponent === 0x7ff) {
        let mantissa: string;
        if (fractionHi === 0 && lo === 0) mantissa = "1#INF";
        else if (negative && fractionHi === 0x80000 && lo === 0) mantissa = "1#IND";
        else mantissa = (fractionHi & 0x80000) ? "1#QNAN" : "1#SNAN";
        return { mantissa, decpt: 1, negative };
    }
    const bits = new Uint32Array([lo, hi]);
    const abs = Math.abs(new Float64Array(bits.buffer)[0] ?? 0);
    if (abs === 0) return { mantissa: "", decpt: 0, negative };
    const es = abs.toExponential(16);
    const eIdx = es.indexOf("e");
    const mantissa = (es.slice(0, 1) + es.slice(2, eIdx)).replace(/0+$/, "");
    return { mantissa, decpt: parseInt(es.slice(eIdx + 1), 10) + 1, negative };
}

/**
 * The CRT's _fptostr: take `digits` mantissa characters (zero-padded), rounding half-up on
 * the next one. A negative count yields "" with no rounding; a carry out of the first digit
 * keeps a leading '1' and moves the decimal point. It rounds raw characters, specials
 * included, which is where VC's "1.$" for a one-digit infinity comes from.
 */
export function fptostr(flt: Fltout, digits: number): { text: string; decpt: number } {
    const n = Math.max(0, digits);
    const out: number[] = [48];
    for (let i = 0; i < n; i++) out.push(i < flt.mantissa.length ? flt.mantissa.charCodeAt(i) : 48);
    if (digits >= 0 && (flt.mantissa.charCodeAt(n) || 0) >= 53) {
        let i = out.length - 1;
        while (out[i] === 57) out[i--] = 48;
        out[i] = (out[i] ?? 48) + 1;
    }
    if (out[0] === 49) return { text: String.fromCharCode(...out), decpt: flt.decpt + 1 };
    return { text: String.fromCharCode(...out.slice(1)), decpt: flt.decpt };
}
