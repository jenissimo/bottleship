/**
 * The CRT entry points VC8 (Visual Studio 2005, msvcr80) added and earlier runtimes do not
 * export: the `*_s` "secure" string family, the 64-bit integer conversions, aligned
 * allocation, and the FPU-state accessors. A 2005-era title links these by NAME, so a
 * missing one is not a missing feature — the import cannot be bound at all and the whole
 * image fails to load.
 *
 * `_aligned_malloc` stores its bookkeeping in the two dwords BELOW the pointer it hands
 * back: the block the allocator actually returned, and the requested size. The first is what
 * `_aligned_free` must free (the aligned pointer is in the middle of the block); the second
 * is what `_aligned_realloc` must copy, since nothing else knows how much of the old block
 * held data.
 */
import { Mem } from "../core/memory/mem-accessor";
import { getCPU } from "../core/thunking/thunk-utils";
import { cpuViews } from "../core/cpu/cpu-views";
import {
    setFpuControlWord, setFpuStatusWord, getFpuStatusWord, msvcStatusWordFromX87,
} from "../core/fpu-helper";
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import type { Process } from "../core/process";

export interface CrtVc8Host {
    process: Process;
    readCString(ptr: number, maxLen: number): string;
    writeCString(ptr: number, value: string): void;
    readWString(ptr: number, maxChars: number): string;
    writeWString(ptr: number, value: string, maxChars?: number): void;
    malloc(size: number): number;
    free(ptr: number): number;
    setErrno(code: number): void;
    /** vsnprintf into a caller buffer: at most `count` bytes, -1 when it did not fit. */
    vsnprintf(dest: number, count: number, format: number, vaList: number): number;
}

const EINVAL = 22;
const ERANGE = 34;
const MAX_STR = 0x100000;

/** The two dwords of bookkeeping that sit below an _aligned_malloc pointer. */
const ALIGN_HEADER = 8;

export function registerCrtVc8Exports(exports: Record<string, ThunkImplementation>, host: CrtVc8Host): void {
    const digits = "0123456789abcdefghijklmnopqrstuvwxyz";

    /** Return a 64-bit value the way the ABI does: low half in EAX, high half in EDX. */
    const return64 = (value: bigint): number => {
        const cpu = getCPU(host.process.v86);
        if (cpu) cpuViews(cpu).reg32[2] = Number((value >> 32n) & 0xffffffffn) | 0;
        return Number(value & 0xffffffffn) >>> 0;
    };

    const join64 = (lo: number, hi: number, signed: boolean): bigint => {
        const raw = (BigInt((hi ?? 0) >>> 0) << 32n) | BigInt((lo ?? 0) >>> 0);
        return signed && raw >= 0x8000000000000000n ? raw - 0x10000000000000000n : raw;
    };

    // ---- string / character ----

    exports["wcsrchr"] = (_c, _m, a) => {
        const ptr = (a[0] ?? 0) >>> 0;
        const ch = (a[1] ?? 0) & 0xffff;
        if (!ptr) return 0;
        const s = host.readWString(ptr, MAX_STR);
        // The terminator counts: wcsrchr(s, 0) points AT it, as strrchr does.
        const idx = ch === 0 ? s.length : s.lastIndexOf(String.fromCharCode(ch));
        return idx < 0 ? 0 : (ptr + idx * 2) >>> 0;
    };

    // No locale collation table beyond "C", where strcoll IS strcmp.
    exports["strcoll"] = (_c, _m, a) => {
        const x = host.readCString((a[0] ?? 0) >>> 0, MAX_STR);
        const y = host.readCString((a[1] ?? 0) >>> 0, MAX_STR);
        return x < y ? -1 : x > y ? 1 : 0;
    };

    exports["towlower"] = (_c, _m, a) => String.fromCharCode((a[0] ?? 0) & 0xffff).toLowerCase().charCodeAt(0) & 0xffff;
    exports["towupper"] = (_c, _m, a) => String.fromCharCode((a[0] ?? 0) & 0xffff).toUpperCase().charCodeAt(0) & 0xffff;

    exports["_itow"] = (_c, _m, a) => {
        const value = (a[0] ?? 0) | 0;
        const buf = (a[1] ?? 0) >>> 0;
        const radix = (a[2] ?? 10) >>> 0;
        if (!buf || radix < 2 || radix > 36) return 0;
        // Only base 10 is signed — every other radix prints the unsigned bit pattern.
        const text = radix === 10 ? String(value) : (value >>> 0).toString(radix);
        host.writeWString(buf, text);
        return buf;
    };

    const i64toa = (value: bigint, buf: number, radix: number): number => {
        if (!buf || radix < 2 || radix > 36) return 0;
        let v = value;
        let out = "";
        const negative = radix === 10 && v < 0n;
        if (negative) v = -v;
        if (v === 0n) out = "0";
        while (v > 0n) {
            out = digits[Number(v % BigInt(radix))] + out;
            v /= BigInt(radix);
        }
        host.writeCString(buf, negative ? `-${out}` : out);
        return buf;
    };

    exports["_i64toa"] = (_c, _m, a) => i64toa(join64(a[0] ?? 0, a[1] ?? 0, true), (a[2] ?? 0) >>> 0, (a[3] ?? 10) >>> 0);
    exports["_ui64toa"] = (_c, _m, a) => i64toa(join64(a[0] ?? 0, a[1] ?? 0, false), (a[2] ?? 0) >>> 0, (a[3] ?? 10) >>> 0);

    exports["_i64tow"] = (_c, _m, a) => {
        const buf = (a[2] ?? 0) >>> 0;
        const radix = (a[3] ?? 10) >>> 0;
        if (!buf || radix < 2 || radix > 36) return 0;
        const v = join64(a[0] ?? 0, a[1] ?? 0, true);
        host.writeWString(buf, radix === 10 ? v.toString() : (v < 0n ? -v : v).toString(radix));
        return buf;
    };

    /**
     * strtoui64 over the C rules: optional sign, optional 0x/0 prefix when base is 0 or 16,
     * and `endptr` left AT the first unconsumed character (the caller's loop depends on it
     * moving; parking it at the start is how a tokenizer spins forever).
     */
    const strtou64 = (text: string, base: number): { value: bigint; consumed: number } => {
        let i = 0;
        while (i < text.length && /\s/.test(text[i]!)) i++;
        let negative = false;
        if (text[i] === "+" || text[i] === "-") { negative = text[i] === "-"; i++; }
        let radix = base;
        if ((radix === 0 || radix === 16) && text[i] === "0" && (text[i + 1] === "x" || text[i + 1] === "X")) {
            radix = 16; i += 2;
        } else if (radix === 0) {
            radix = text[i] === "0" ? 8 : 10;
        }
        const start = i;
        let value = 0n;
        while (i < text.length) {
            const d = digits.indexOf(text[i]!.toLowerCase());
            if (d < 0 || d >= radix) break;
            value = value * BigInt(radix) + BigInt(d);
            i++;
        }
        if (i === start) return { value: 0n, consumed: 0 };   // no conversion
        if (negative) value = (0x10000000000000000n - value) & 0xffffffffffffffffn;
        return { value: value & 0xffffffffffffffffn, consumed: i };
    };

    const strto64Export = (signed: boolean): ThunkImplementation => (_c, _m, a) => {
        const strPtr = (a[0] ?? 0) >>> 0;
        const endPtr = (a[1] ?? 0) >>> 0;
        const base = (a[2] ?? 0) >>> 0;
        if (!strPtr) return return64(0n);
        const text = host.readCString(strPtr, MAX_STR);
        const { value, consumed } = strtou64(text, base);
        if (endPtr) Mem.writeUint32(endPtr, (strPtr + consumed) >>> 0);
        void signed;    // the bit pattern is identical; only the caller's reading differs
        return return64(value);
    };
    exports["_strtoui64"] = strto64Export(false);
    exports["_strtoi64"] = strto64Export(true);

    exports["strcpy_s"] = (_c, _m, a) => {
        const dst = (a[0] ?? 0) >>> 0;
        const size = (a[1] ?? 0) >>> 0;
        const src = (a[2] ?? 0) >>> 0;
        if (!dst || !src) return EINVAL;
        if (size === 0) return EINVAL;
        const s = host.readCString(src, MAX_STR);
        // On overflow the secure forms leave the destination EMPTY rather than truncated —
        // a truncated path or key read as valid is exactly what they exist to prevent.
        if (s.length + 1 > size) { Mem.writeUint8(dst, 0); host.setErrno(ERANGE); return ERANGE; }
        host.writeCString(dst, s);
        return 0;
    };

    exports["strcat_s"] = (_c, _m, a) => {
        const dst = (a[0] ?? 0) >>> 0;
        const size = (a[1] ?? 0) >>> 0;
        const src = (a[2] ?? 0) >>> 0;
        if (!dst || !src || size === 0) return EINVAL;
        const head = host.readCString(dst, size);
        const tail = host.readCString(src, MAX_STR);
        if (head.length + tail.length + 1 > size) { Mem.writeUint8(dst, 0); host.setErrno(ERANGE); return ERANGE; }
        host.writeCString(dst, head + tail);
        return 0;
    };

    /**
     * strtok_s keeps its cursor in the CALLER's context pointer rather than a static, which
     * is the only difference from strtok — and the reason a caller may interleave two
     * tokenizations that strtok would corrupt.
     */
    exports["strtok_s"] = (_c, _m, a) => {
        const strPtr = (a[0] ?? 0) >>> 0;
        const delimPtr = (a[1] ?? 0) >>> 0;
        const ctxPtr = (a[2] ?? 0) >>> 0;
        if (!delimPtr || !ctxPtr) return 0;
        let cursor = strPtr ? strPtr : ((Mem.readUint32(ctxPtr) ?? 0) >>> 0);
        if (!cursor) return 0;

        const delims = host.readCString(delimPtr, 256);
        const rest = host.readCString(cursor, MAX_STR);
        let i = 0;
        while (i < rest.length && delims.includes(rest[i]!)) i++;
        if (i >= rest.length) { Mem.writeUint32(ctxPtr, 0); return 0; }
        const tokenStart = cursor + i;
        let end = i;
        while (end < rest.length && !delims.includes(rest[end]!)) end++;
        if (end < rest.length) {
            Mem.writeUint8(cursor + end, 0);
            Mem.writeUint32(ctxPtr, (cursor + end + 1) >>> 0);
        } else {
            Mem.writeUint32(ctxPtr, 0);
        }
        return tokenStart >>> 0;
    };

    exports["vsprintf_s"] = (_c, _m, a) => {
        const dst = (a[0] ?? 0) >>> 0;
        const size = (a[1] ?? 0) >>> 0;
        const fmt = (a[2] ?? 0) >>> 0;
        const va = (a[3] ?? 0) >>> 0;
        if (!dst || !fmt || size === 0) return -1;
        // Bounded BEFORE the write, not checked after it: formatting into the buffer first
        // and then reporting ERANGE has already overrun whatever followed it.
        const written = host.vsnprintf(dst, size, fmt, va);
        if (written < 0) { Mem.writeUint8(dst, 0); host.setErrno(ERANGE); return -1; }
        return written;
    };

    // ---- aligned allocation ----

    exports["_aligned_malloc"] = (_c, _m, a) => alignedAlloc((a[0] ?? 0) >>> 0, (a[1] ?? 0) >>> 0);

    exports["_aligned_free"] = (_c, _m, a) => {
        const ptr = (a[0] ?? 0) >>> 0;
        if (!ptr) return 0;
        host.free((Mem.readUint32(ptr - 4) ?? 0) >>> 0);
        return 0;
    };

    exports["_aligned_realloc"] = (_c, _m, a) => {
        const ptr = (a[0] ?? 0) >>> 0;
        const size = (a[1] ?? 0) >>> 0;
        const alignment = (a[2] ?? 0) >>> 0;
        if (!ptr) return alignedAlloc(size, alignment);
        if (size === 0) { host.free((Mem.readUint32(ptr - 4) ?? 0) >>> 0); return 0; }
        const oldSize = (Mem.readUint32(ptr - 8) ?? 0) >>> 0;
        const fresh = alignedAlloc(size, alignment);
        if (!fresh) return 0;
        const copy = Math.min(oldSize, size);
        if (copy > 0) {
            const bytes = Mem.readBytes(ptr, copy);
            if (bytes) Mem.writeBytes(fresh, bytes);
        }
        host.free((Mem.readUint32(ptr - 4) ?? 0) >>> 0);
        return fresh;
    };

    function alignedAlloc(size: number, alignment: number): number {
        // The CRT rejects an alignment that is not a power of two rather than rounding it.
        if (alignment === 0 || (alignment & (alignment - 1)) !== 0) { host.setErrno(EINVAL); return 0; }
        const base = host.malloc(size + alignment + ALIGN_HEADER) >>> 0;
        if (!base) return 0;
        const aligned = ((base + ALIGN_HEADER + alignment - 1) & ~(alignment - 1)) >>> 0;
        Mem.writeUint32(aligned - 4, base);
        Mem.writeUint32(aligned - 8, size);
        return aligned;
    }

    // ---- FPU state ----

    // _fpreset restores the default control word (0x037F: 53-bit precision, round-to-nearest,
    // all exceptions masked) and clears the stack — the state a CRT hands a fresh thread.
    exports["_fpreset"] = () => {
        setFpuControlWord(host.process.v86, 0x037f);
        setFpuStatusWord(host.process.v86, 0);
        return 0;
    };

    // _SW_* do NOT share the x87 status word's bit positions — the six exception flags are in a
    // different order and _SW_DENORMAL sits at 0x80000 — so the raw word has to be translated.
    exports["_statusfp"] = () => msvcStatusWordFromX87(getFpuStatusWord(host.process.v86) ?? 0);

    // We advertise SSE2 (PF_XMMI64_AVAILABLE) and v86 implements it, so the CRT's SSE2 math
    // paths are legal here: report the flag as set whatever the caller asks for.
    exports["_set_SSE2_enable"] = () => 1;
}
