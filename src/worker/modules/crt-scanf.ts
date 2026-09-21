/**
 * Faithful streaming scanf core, shared by msvcrt (sscanf/fscanf) and crtdll (sscanf).
 *
 * Parses `input` per `format`, writing results to the pointers in `args` starting at
 * `argStart`. Returns the number of fields assigned, the number of input chars consumed
 * (so fscanf can advance the file position precisely — only the bytes actually matched are
 * consumed, the rest stay in the stream for the next call), and an `eof` flag that lets the
 * caller emit the C `EOF` (-1) return when input runs out before the first conversion.
 *
 * Supported directives (matching the CRT documented behavior):
 *   - whitespace skipping and literal matching
 *   - field width, '*' assignment suppression
 *   - length modifiers: h/hh (short/char), l/ll/L/I64 (long/wide/64-bit)
 *   - conversions: d i u x X o p f e g E G a A s c %  and scansets %[...] (with ^ negation)
 *   - %n (store consumed count; not counted as an assignment)
 * Integer conversions honor the C base rules: %i auto-detects (0x→hex, 0→octal), and the
 * hex conversions consume an optional "0x"/"0X" prefix.
 */

import { Mem } from "../core/memory/mem-accessor";
import { encodeAnsi } from "./crt-format";
import { Logger, LogCategory } from "../core/logger";

export interface ScanfResult {
    /** Number of fields successfully assigned (the C scanf return value when >= 0). */
    assigned: number;
    /** Input chars consumed — fscanf rewinds the stream to startPos + consumed. */
    consumed: number;
    /** True when parsing hit end-of-input before completing any conversion (→ caller returns EOF). */
    eof: boolean;
}

const isSpace = (c: string): boolean =>
    c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f";

const warnedUnsupported = new Set<string>();

function digitValue(c: string): number {
    const cc = c.charCodeAt(0);
    if (cc >= 48 && cc <= 57) return cc - 48;        // 0-9
    if (cc >= 97 && cc <= 122) return cc - 87;       // a-z → 10-35
    if (cc >= 65 && cc <= 90) return cc - 55;        // A-Z → 10-35
    return -1;
}

function writeNarrowString(ptr: number, value: string): void {
    if (!ptr) return;
    const encoded = encodeAnsi(value);
    const bytes = new Uint8Array(encoded.length + 1);
    bytes.set(encoded);
    Mem.writeBytes(ptr, bytes);
}

function writeWideString(ptr: number, value: string): void {
    if (!ptr) return;
    for (let i = 0; i < value.length; i++) Mem.writeUint16(ptr + i * 2, value.charCodeAt(i) & 0xffff);
    Mem.writeUint16(ptr + value.length * 2, 0); // wide null terminator
}

function writeNarrowOrWide(ptr: number, value: string, wide: boolean): void {
    if (wide) writeWideString(ptr, value); else writeNarrowString(ptr, value);
}

function writeInteger(ptr: number, big: bigint, sizeBytes: number): void {
    if (!ptr) return;
    switch (sizeBytes) {
        case 1: Mem.writeUint8(ptr, Number(big & 0xffn)); break;
        case 2: Mem.writeUint16(ptr, Number(big & 0xffffn)); break;
        case 8:
            Mem.writeUint32(ptr, Number(big & 0xffffffffn));
            Mem.writeUint32(ptr + 4, Number((big >> 32n) & 0xffffffffn));
            break;
        default: Mem.writeUint32(ptr, Number(big & 0xffffffffn)); break;
    }
}

function writeDouble(ptr: number, val: number): void {
    if (!ptr) return;
    // Route through the bounds-checked accessor like the integer/float32 paths — a
    // wild/near-end guest pointer becomes a checked no-op instead of an uncaught
    // RangeError escaping the scanf thunk.
    Mem.writeFloat64(ptr, val);
}

/** Length-modifier → integer write size in bytes. */
const enum IntSize { Char = 1, Short = 2, Int = 4, Long8 = 8 }

/**
 * `secure` selects the `*_s` family's argument shape: every %s, %c and %[ is followed by a
 * buffer SIZE in characters. Consuming it is not optional — skip it and every argument after
 * the first string conversion is read one slot early, so the caller's ints land in whatever
 * the size happened to be. The size also bounds the write, which is the whole point of the
 * form: a field that does not fit empties the buffer and ends the scan, as the CRT does when
 * its invalid-parameter handler returns.
 */
export function scanfCore(
    input: string,
    format: string,
    args: number[],
    argStart: number,
    secure = false,
): ScanfResult {
    let ip = 0;
    let assigned = 0;
    let argIndex = argStart;
    let fi = 0;
    let eof = false;

    while (fi < format.length) {
        const fc = format[fi];

        // Whitespace in the format matches any run of input whitespace (including none).
        if (isSpace(fc)) {
            while (ip < input.length && isSpace(input[ip])) ip++;
            fi++;
            continue;
        }

        // Ordinary character: must match literally.
        if (fc !== "%") {
            if (ip < input.length && input[ip] === fc) { ip++; fi++; continue; }
            if (ip >= input.length) eof = assigned === 0;
            break;
        }

        // --- Conversion specification ---
        fi++;
        if (fi >= format.length) break;

        let suppress = false;
        if (format[fi] === "*") { suppress = true; fi++; }

        let width = 0; let hasWidth = false;
        while (fi < format.length && format[fi] >= "0" && format[fi] <= "9") {
            width = width * 10 + (format.charCodeAt(fi) - 48); hasWidth = true; fi++;
        }
        const max = hasWidth ? width : Infinity;

        // Length modifiers: h, hh, l, ll, L, I64, I32, w (wide). Parse as counts/flags, then
        // derive the actual write size per conversion class (a single 'l' means "long" for
        // integers = 4 bytes on Win32, but "double" for floats and "wide" for strings/chars).
        let hCount = 0, lCount = 0, i64 = false, bigL = false, wideMod = false;
        for (;;) {
            const m = format[fi];
            if (m === "h") { hCount++; fi++; }
            else if (m === "l") { lCount++; fi++; }
            else if (m === "L") { bigL = true; fi++; }
            else if (m === "w") { wideMod = true; fi++; }
            else if (m === "I" && format[fi + 1] === "6" && format[fi + 2] === "4") { i64 = true; fi += 3; }
            else if (m === "I" && format[fi + 1] === "3" && format[fi + 2] === "2") { fi += 3; }
            else break;
        }
        const intSize: IntSize = (i64 || lCount >= 2) ? IntSize.Long8
            : hCount >= 2 ? IntSize.Char
            : hCount === 1 ? IntSize.Short
            : IntSize.Int;                          // single 'l' → long → 4 bytes on Win32
        const doubleFloat = lCount >= 1 || bigL;    // %lf / %Lf → 8-byte double
        const wide = wideMod || lCount >= 1;        // %ls / %lc / %l[ → wchar_t

        const spec = format[fi]; fi++;
        if (spec === undefined) break;

        if (spec === "%") {
            // '%%' skips leading whitespace then matches a single '%'.
            while (ip < input.length && isSpace(input[ip])) ip++;
            if (ip < input.length && input[ip] === "%") { ip++; continue; }
            if (ip >= input.length) eof = assigned === 0;
            break;
        }

        if (spec === "n") {
            // Store count of chars consumed so far; not an assignment, doesn't consume input.
            if (!suppress) { const p = args[argIndex++] ?? 0; writeInteger(p, BigInt(ip), intSize); }
            continue;
        }

        // All conversions except c, [, n skip leading whitespace.
        if (spec !== "c" && spec !== "[") {
            while (ip < input.length && isSpace(input[ip])) ip++;
        }

        const outPtr = suppress ? 0 : (args[argIndex++] ?? 0);
        const takesSize = secure && !suppress && (spec === "s" || spec === "c" || spec === "[");
        const bufChars = takesSize ? ((args[argIndex++] ?? 0) >>> 0) : Infinity;

        // ---- Integer conversions ----
        if (spec === "d" || spec === "i" || spec === "u" || spec === "x" || spec === "X" || spec === "o" || spec === "p") {
            const start = ip;
            let count = 0;
            let sign = 1n;
            if (ip < input.length && count < max && (input[ip] === "+" || input[ip] === "-")) {
                if (input[ip] === "-") sign = -1n;
                ip++; count++;
            }

            let radix: number;
            if (spec === "o") radix = 8;
            else if (spec === "x" || spec === "X" || spec === "p") radix = 16;
            else if (spec === "i") radix = 10; // provisional; auto-detected below
            else radix = 10;

            // 0x / 0X prefix (hex specs and %i) — only consumed if a hex digit follows.
            const canHexPrefix = spec === "x" || spec === "X" || spec === "p" || spec === "i";
            if (canHexPrefix && ip + 1 < input.length && input[ip] === "0" &&
                (input[ip + 1] === "x" || input[ip + 1] === "X") &&
                count + 2 <= max && digitValue(input[ip + 2] ?? "") >= 0 && digitValue(input[ip + 2] ?? "") < 16) {
                radix = 16; ip += 2; count += 2;
            } else if (spec === "i" && ip < input.length && input[ip] === "0") {
                radix = 8; // leading 0 (no x) → octal; the 0 itself is read by the digit loop
            }

            let big = 0n;
            const R = BigInt(radix);
            let ndigits = 0;
            while (ip < input.length && count < max) {
                const d = digitValue(input[ip]);
                if (d < 0 || d >= radix) break;
                big = big * R + BigInt(d);
                ip++; count++; ndigits++;
            }
            if (ndigits === 0) {
                ip = start;
                eof = assigned === 0 && start >= input.length;
                break;
            }
            writeInteger(outPtr, sign * big, intSize);
            if (!suppress) assigned++;
            continue;
        }

        // ---- Floating-point conversions ----
        if (spec === "f" || spec === "e" || spec === "g" || spec === "E" || spec === "G" || spec === "a" || spec === "A") {
            const start = ip;
            let count = 0;
            const take = (): boolean => {
                if (ip >= input.length || count >= max) return false;
                ip++; count++; return true;
            };
            // optional sign
            if (ip < input.length && (input[ip] === "+" || input[ip] === "-")) take();
            let intDigits = 0, fracDigits = 0;
            while (ip < input.length && input[ip] >= "0" && input[ip] <= "9" && take()) intDigits++;
            if (ip < input.length && input[ip] === "." && take()) {
                while (ip < input.length && input[ip] >= "0" && input[ip] <= "9" && take()) fracDigits++;
            }
            if (intDigits === 0 && fracDigits === 0) {
                ip = start;
                eof = assigned === 0 && start >= input.length;
                break;
            }
            // optional exponent
            if (ip < input.length && (input[ip] === "e" || input[ip] === "E")) {
                const expStart = ip; const expCount = count;
                take(); // consume e/E
                if (ip < input.length && (input[ip] === "+" || input[ip] === "-")) take();
                let expDigits = 0;
                while (ip < input.length && input[ip] >= "0" && input[ip] <= "9" && take()) expDigits++;
                if (expDigits === 0) { ip = expStart; count = expCount; } // dangling 'e' — back it out
            }
            const val = parseFloat(input.slice(start, ip));
            if (Number.isNaN(val)) { ip = start; break; }
            if (doubleFloat) writeDouble(outPtr, val);
            else if (outPtr) Mem.writeFloat32(outPtr, val);
            if (!suppress) assigned++;
            continue;
        }

        // ---- String ----
        if (spec === "s") {
            let s = ""; let n = 0;
            while (ip < input.length && !isSpace(input[ip]) && n < max) { s += input[ip++]; n++; }
            if (s.length === 0) { eof = assigned === 0 && ip >= input.length; break; }
            if (s.length + 1 > bufChars) { if (outPtr) writeNarrowOrWide(outPtr, "", wide); break; }
            if (wide) writeWideString(outPtr, s); else writeNarrowString(outPtr, s);
            if (!suppress) assigned++;
            continue;
        }

        // ---- Character(s) ----
        if (spec === "c") {
            const want = hasWidth ? width : 1;
            if (ip + want > input.length) { eof = assigned === 0; ip = input.length; break; }
            if (want > bufChars) break;
            for (let n = 0; n < want; n++) {
                if (outPtr) {
                    if (wide) Mem.writeUint16(outPtr + n * 2, input.charCodeAt(ip) & 0xffff);
                    else Mem.writeUint8(outPtr + n, input.charCodeAt(ip) & 0xff);
                }
                ip++;
            }
            if (!suppress) assigned++;
            continue;
        }

        // ---- Scanset %[...] ----
        if (spec === "[") {
            let negate = false;
            if (format[fi] === "^") { negate = true; fi++; }
            const set = new Set<string>();
            // A ']' immediately after '[' (or '[^') is a literal member.
            if (format[fi] === "]") { set.add("]"); fi++; }
            while (fi < format.length && format[fi] !== "]") {
                // Range a-z (not at edges, '-' otherwise literal).
                if (format[fi] === "-" && set.size > 0 && fi + 1 < format.length && format[fi + 1] !== "]") {
                    const prev = format[fi - 1].charCodeAt(0);
                    const next = format[fi + 1].charCodeAt(0);
                    for (let cc = Math.min(prev, next); cc <= Math.max(prev, next); cc++) set.add(String.fromCharCode(cc));
                    fi += 2;
                } else {
                    set.add(format[fi]); fi++;
                }
            }
            if (fi < format.length) fi++; // consume closing ']'
            let s = ""; let n = 0;
            while (ip < input.length && n < max) {
                const inSet = set.has(input[ip]);
                if (negate ? inSet : !inSet) break;
                s += input[ip++]; n++;
            }
            if (s.length === 0) { eof = assigned === 0 && ip >= input.length; break; }
            if (s.length + 1 > bufChars) { if (outPtr) writeNarrowOrWide(outPtr, "", wide); break; }
            if (wide) writeWideString(outPtr, s); else writeNarrowString(outPtr, s);
            if (!suppress) assigned++;
            continue;
        }

        // Unsupported specifier — stop parsing (matches C: undefined directive aborts).
        if (!warnedUnsupported.has(spec)) {
            warnedUnsupported.add(spec);
            Logger.warn(LogCategory.SYSTEM, `[CRT] scanf: unsupported conversion '%${spec}' in format ${JSON.stringify(format)} — parse stopped`);
        }
        break;
    }

    return { assigned, consumed: ip, eof };
}
