/**
 * Shared C runtime formatting utilities for crtdll and msvcrt.
 * Provides VaListReader (lazy arg reading from va_list) and ANSI encoding.
 */

import { Mem } from "../core/memory/mem-accessor";
import { encodeAnsiString } from "../core/emulator-config-manager";
import { EmulatorConfig } from "../core/emulator-config-manager";

/** Lazy reader for va_list — reads uint32 values on demand from guest memory */
export class VaListReader {
    private offset = 0;
    constructor(private baseAddr: number) {}
    /** Read next uint32 from va_list and advance pointer */
    nextUint32(): number {
        if (!this.baseAddr) return 0;
        const val = Mem.readUint32(this.baseAddr + this.offset) ?? 0;
        this.offset += 4;
        return val;
    }
    /** Read next double (two consecutive uint32 in little-endian, 8 bytes on x86 stack) */
    nextDouble(): number {
        const lo = this.nextUint32();
        const hi = this.nextUint32();
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        view.setUint32(0, lo, true);
        view.setUint32(4, hi, true);
        return view.getFloat64(0, true);
    }
}

/**
 * VaListReader that reads from a pre-extracted args array (for sprintf/printf/snprintf).
 * Consumes uint32 values sequentially; doubles consume two consecutive slots.
 */
export class ArrayVaListReader {
    private offset: number;
    constructor(private args: number[], startIndex: number) {
        this.offset = startIndex;
    }
    nextUint32(): number {
        return this.args[this.offset++] ?? 0;
    }
    nextDouble(): number {
        const lo = this.nextUint32();
        const hi = this.nextUint32();
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        view.setUint32(0, lo, true);
        view.setUint32(4, hi, true);
        return view.getFloat64(0, true);
    }
}

/** Encode string as ANSI using the active code page — 1 byte per char, no multi-byte */
export function encodeAnsi(text: string): Uint8Array {
    return encodeAnsiString(text, EmulatorConfig.getInstance().ansiCodePage);
}

/** Options for {@link formatCLazy}. */
export interface FormatCLazyOptions {
    /**
     * Wide-context formatting (wide printf family: swprintf/_vsnwprintf/...).
     * Flips the default string width: %s/%c default to wide instead of narrow.
     * When set, `readWString` SHOULD be provided so wide %s can be resolved.
     */
    wide?: boolean;
    /** Secure callers can bound checked string reads by the output precision. */
    readString?: (addr: number, wide: boolean, precision: number | null) => string;
    /** Reader for wide (UTF-16) guest strings; required for wide %s/%S resolution. */
    readWString?: (addr: number, maxChars: number) => string;
}

/**
 * Format a C printf-style string with lazy arg reading from VaListReader.
 *
 * Supports: %d/%i/%u/%x/%X/%o/%s/%S/%c/%p/%f/%F/%e/%E/%g/%G/%n,
 * flags -/0/+/space/#, * for width/precision, and length modifiers
 * h/hh/l/ll/L/w/I/I32/I64/z/t/j.
 *
 * The SAME engine serves both the narrow and the wide CRT printf families.
 * Pass `opts.wide = true` (plus `opts.readWString`) for the wide family; in
 * that mode %s defaults to a wide guest string and %hs/%S select narrow. In
 * narrow mode (default) %s is narrow and %ls/%ws/%S select wide. (The length
 * modifier selects the OPPOSITE width of the function family's default — the
 * standard wide/narrow printf string-conversion rule.)
 *
 * Float specifiers consume a C-promoted double (TWO 32-bit va_list slots) via
 * `reader.nextDouble()`.
 */
export function formatCLazy(
    format: string,
    reader: VaListReader | ArrayVaListReader,
    readCString: (addr: number, maxLen: number) => string,
    opts?: FormatCLazyOptions
): string {
    const wideCtx = opts?.wide === true;
    const readWString = opts?.readWString;
    let result = "";
    const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";

    const pad = (str: string, width: number, leftAlign: boolean): string => {
        if (width <= str.length) return str;
        const fill = " ".repeat(width - str.length);
        return leftAlign ? str + fill : fill + str;
    };

    const formatInt = (
        raw: number, base: number, uppercase: boolean, signed: boolean,
        width: number, precision: number | null, zeroPad: boolean, leftAlign: boolean,
        plus: boolean, space: boolean, alt: boolean
    ): string => {
        let sign = "";
        let value: number;
        if (signed) {
            const sv = raw | 0;
            if (sv < 0) { sign = "-"; value = Math.abs(sv); } else { value = sv; if (plus) sign = "+"; else if (space) sign = " "; }
        } else {
            value = raw >>> 0;
        }
        let str = value.toString(base);
        if (uppercase) str = str.toUpperCase();
        // '#' adds 0/0x/0X prefix for o/x/X (not on a zero value for x/X).
        let prefix = "";
        if (alt && value !== 0) {
            if (base === 16) prefix = uppercase ? "0X" : "0x";
        }
        if (alt && base === 8 && str[0] !== "0") str = "0" + str;
        // C: precision 0 with value 0 produces empty digits.
        if (precision !== null && value === 0 && precision === 0) str = "";
        if (precision !== null) { str = str.padStart(precision, "0"); zeroPad = false; }
        if (zeroPad && !leftAlign && width > 0) {
            str = str.padStart(Math.max(width - sign.length - prefix.length, 0), "0");
        }
        return pad(sign + prefix + str, width, leftAlign);
    };

    const formatFloat = (
        val: number, spec: string, width: number, precision: number | null,
        zeroPad: boolean, leftAlign: boolean, plus: boolean, space: boolean
    ): string => {
        const prec = precision ?? 6;
        const neg = val < 0 || Object.is(val, -0);
        const abs = Math.abs(val);
        let body: string;
        switch (spec) {
            case "f": case "F": body = abs.toFixed(prec); break;
            case "e": body = abs.toExponential(prec); break;
            case "E": body = abs.toExponential(prec).toUpperCase(); break;
            case "g": body = prec > 0 ? abs.toPrecision(prec) : abs.toString(); break;
            case "G": body = (prec > 0 ? abs.toPrecision(prec) : abs.toString()).toUpperCase(); break;
            default: body = abs.toFixed(prec); break;
        }
        let sign = neg ? "-" : (plus ? "+" : (space ? " " : ""));
        if (zeroPad && !leftAlign && width > sign.length + body.length) {
            body = body.padStart(width - sign.length, "0");
        }
        return pad(sign + body, width, leftAlign);
    };

    let i = 0;
    while (i < format.length) {
        if (format[i] !== "%" || i + 1 >= format.length) { result += format[i++]; continue; }
        i++;
        if (format[i] === "%") { result += "%"; i++; continue; }

        let leftAlign = false;
        let zeroPad = false;
        let plus = false;
        let space = false;
        let alt = false;
        let width = 0;
        let precision: number | null = null;

        // Flags
        while (i < format.length && (format[i] === "-" || format[i] === "0" || format[i] === "+" || format[i] === " " || format[i] === "#")) {
            if (format[i] === "-") leftAlign = true;
            else if (format[i] === "0") zeroPad = true;
            else if (format[i] === "+") plus = true;
            else if (format[i] === " ") space = true;
            else if (format[i] === "#") alt = true;
            i++;
        }
        if (leftAlign) zeroPad = false;

        // Width
        if (i < format.length && format[i] === "*") {
            width = reader.nextUint32() | 0;
            if (width < 0) { leftAlign = true; zeroPad = false; width = -width; }
            i++;
        } else {
            while (i < format.length && isDigit(format[i])) {
                width = width * 10 + (format.charCodeAt(i) - 48); i++;
            }
        }

        // Precision
        if (i < format.length && format[i] === ".") {
            i++;
            if (i < format.length && format[i] === "*") {
                precision = reader.nextUint32() | 0;
                if (precision < 0) precision = null; // negative precision is ignored per C
                i++;
            } else {
                precision = 0;
                while (i < format.length && isDigit(format[i])) {
                    precision = precision * 10 + (format.charCodeAt(i) - 48); i++;
                }
            }
        }

        // Length modifiers — track which width the string/char specifiers want.
        // narrowMod = saw 'h'/'hh'; wideMod = saw 'l'/'ll'/'L'/'w'.
        let narrowMod = false;
        let wideMod = false;
        if (i < format.length && format[i] === "h") {
            narrowMod = true; i++;
            if (i < format.length && format[i] === "h") i++;
        } else if (i < format.length && format[i] === "l") {
            wideMod = true; i++;
            if (i < format.length && format[i] === "l") i++;
        } else if (i < format.length && (format[i] === "L" || format[i] === "w")) {
            wideMod = true; i++;
        } else if (i < format.length && (format[i] === "z" || format[i] === "t" || format[i] === "j")) {
            i++;
        } else if (i < format.length && format[i] === "I") {
            i++;
            if (i + 1 < format.length && format[i] === "6" && format[i + 1] === "4") i += 2;
            else if (i + 1 < format.length && format[i] === "3" && format[i + 1] === "2") i += 2;
        }

        if (i >= format.length) break;
        const spec = format[i++];

        // Decide whether a string/char arg is wide for THIS conversion.
        // Rule: the function family sets the default width, the length modifier
        // selects the OPPOSITE, and %S is always the opposite of the default.
        const sIsWide = (defaultWide: boolean): boolean => {
            if (narrowMod) return false;   // %hs/%hS → narrow
            if (wideMod) return true;       // %ls/%ws/%lS → wide
            return defaultWide;
        };

        switch (spec) {
            case "s": {
                const strAddr = reader.nextUint32();
                const useWide = sIsWide(wideCtx);
                let str: string;
                if (!strAddr) {
                    str = "(null)";
                } else if (opts?.readString) {
                    str = opts.readString(strAddr, useWide, precision);
                } else if (useWide && readWString) {
                    str = readWString(strAddr, 0x100000);
                } else {
                    str = readCString(strAddr, 0x100000);
                }
                if (precision !== null) str = str.slice(0, precision);
                result += pad(str, width, leftAlign);
                break;
            }
            case "S": {
                // %S is the opposite width of the family default (unless overridden).
                const strAddr = reader.nextUint32();
                const useWide = sIsWide(!wideCtx);
                let str: string;
                if (!strAddr) {
                    str = "(null)";
                } else if (opts?.readString) {
                    str = opts.readString(strAddr, useWide, precision);
                } else if (useWide && readWString) {
                    str = readWString(strAddr, 0x100000);
                } else {
                    str = readCString(strAddr, 0x100000);
                }
                if (precision !== null) str = str.slice(0, precision);
                result += pad(str, width, leftAlign);
                break;
            }
            case "d": case "i":
                result += formatInt(reader.nextUint32(), 10, false, true, width, precision, zeroPad, leftAlign, plus, space, alt);
                break;
            case "u":
                result += formatInt(reader.nextUint32(), 10, false, false, width, precision, zeroPad, leftAlign, false, false, false);
                break;
            case "x":
                result += formatInt(reader.nextUint32(), 16, false, false, width, precision, zeroPad, leftAlign, false, false, alt);
                break;
            case "X":
                result += formatInt(reader.nextUint32(), 16, true, false, width, precision, zeroPad, leftAlign, false, false, alt);
                break;
            case "o":
                result += formatInt(reader.nextUint32(), 8, false, false, width, precision, zeroPad, leftAlign, false, false, alt);
                break;
            case "c": {
                // Wide context (or %lc/%wc) → 16-bit char; narrow → 8-bit.
                const useWide = sIsWide(wideCtx);
                const ch = String.fromCharCode(reader.nextUint32() & (useWide ? 0xFFFF : 0xFF));
                result += pad(ch, width, leftAlign);
                break;
            }
            case "C": {
                // %C is the opposite char width of the family default.
                const useWide = sIsWide(!wideCtx);
                const ch = String.fromCharCode(reader.nextUint32() & (useWide ? 0xFFFF : 0xFF));
                result += pad(ch, width, leftAlign);
                break;
            }
            case "p": {
                const ptr = reader.nextUint32() >>> 0;
                let hex = ptr.toString(16).toUpperCase().padStart(8, "0");
                result += pad(hex, width, leftAlign);
                break;
            }
            case "f": case "F": case "e": case "E": case "g": case "G":
                result += formatFloat(reader.nextDouble(), spec, width, precision, zeroPad, leftAlign, plus, space);
                break;
            case "n": {
                const nPtr = reader.nextUint32();
                if (nPtr) Mem.writeUint32(nPtr, result.length);
                break;
            }
            default:
                result += "%" + spec;
                break;
        }
    }
    return result;
}

/**
 * Minimal scanf-style parser for log-driven VC9 bring-up (%d %u %x %s %c %f).
 * Returns number of assignments made.
 */
export function scanCLazy(
    input: string,
    format: string,
    writeInt: (addr: number, value: number) => void,
    writeFloat: (addr: number, value: number) => void,
    readAddr: () => number,
): number {
    let pos = 0;
    let assigned = 0;
    let i = 0;
    const skipWs = () => {
        while (pos < input.length && /\s/.test(input[pos]!)) pos++;
    };

    while (i < format.length) {
        if (format[i] !== "%" || i + 1 >= format.length) {
            if (pos < input.length && format[i] === input[pos]) { pos++; i++; continue; }
            break;
        }
        i++;
        if (format[i] === "%") { i++; continue; }
        while (i < format.length && format[i] === "*") i++;
        if (i < format.length && format[i] === "l") i++;
        if (i >= format.length) break;
        const spec = format[i++];
        skipWs();
        const outPtr = readAddr();
        if (!outPtr) continue;

        switch (spec) {
            case "d": case "i": {
                const m = input.slice(pos).match(/^-?\d+/);
                if (!m) return assigned;
                writeInt(outPtr, parseInt(m[0], 10));
                pos += m[0].length;
                assigned++;
                break;
            }
            case "u": case "x": case "X": case "o": {
                const base = spec === "o" ? 8 : spec === "x" || spec === "X" ? 16 : 10;
                const m = input.slice(pos).match(base === 16 ? /^(0x)?[0-9a-fA-F]+/ : /^-?\d+/);
                if (!m) return assigned;
                const raw = m[0].replace(/^0x/i, "");
                writeInt(outPtr, parseInt(raw, base) >>> 0);
                pos += m[0].length;
                assigned++;
                break;
            }
            case "s": {
                const start = pos;
                while (pos < input.length && !/\s/.test(input[pos]!)) pos++;
                const str = input.slice(start, pos);
                const bytes = new Uint8Array(str.length + 1);
                for (let j = 0; j < str.length; j++) bytes[j] = str.charCodeAt(j) & 0xff;
                Mem.writeBytes(outPtr, bytes);
                assigned++;
                break;
            }
            case "c": {
                if (pos >= input.length) return assigned;
                writeInt(outPtr, input.charCodeAt(pos++) & 0xff);
                assigned++;
                break;
            }
            case "f": case "g": case "e": {
                const m = input.slice(pos).match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/);
                if (!m) return assigned;
                writeFloat(outPtr, parseFloat(m[0]));
                pos += m[0].length;
                assigned++;
                break;
            }
            default:
                break;
        }
    }
    return assigned;
}
