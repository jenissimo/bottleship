/**
 * The pre-UCRT time-locale helpers MSVCP60 calls: _Getdays/_Getmonths/_Gettnames return
 * caller-owned malloc'd copies (cdecl, no arguments) and _Strftime(dest, max, fmt, tm,
 * timeData) formats with an explicit locale block.
 *
 * The narrow time-data block is 43 string pointers, LCID, calendar flag and refcount (the
 * __lc_time_data layout; only that narrow prefix is produced). Formatting follows the
 * strftime contract with the C locale's MM/dd/yy and HH:mm:ss patterns, never the host's.
 * https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/strftime-wcsftime-strftime-l-wcsftime-l
 */
import { Mem } from "../core/memory/mem-accessor";
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";

export interface MsvcrtTimeLocaleHost {
    alloc(bytes: number): number;
    hasCLocale(): boolean;
    setErrno(value: number): void;
    timezoneName?(isDst: number): string;
}
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const C_NAMES = [
    ...DAYS.map(s => s.slice(0, 3)),
    ...DAYS,
    ...MONTHS.map(s => s.slice(0, 3)),
    ...MONTHS,
    "AM",
    "PM",
    "MM/dd/yy",
    "dddd, MMMM dd, yyyy",
    "HH:mm:ss",
];
const TIME_PREFIX_SIZE = 46 * 4;
class InvalidTime extends Error {}

function readBytesString(ptr: number): string {
    if (!ptr) throw new InvalidTime("NULL time string");
    let out = "";
    for (let i = 0; i < 0x100000; i++) {
        const value = Mem.readUint8(ptr + i);
        if (value == null) throw new Error("msvcrt: unreadable time string");
        if (value === 0) return out;
        out += String.fromCharCode(value);
    }
    throw new Error("msvcrt: unterminated time string");
}
function writeBytesString(ptr: number, text: string): void {
    const bytes = new Uint8Array(text.length + 1);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    if (Mem.writeBytes(ptr, bytes) !== bytes.length) throw new Error("msvcrt: time string write failed");
}

function writeTimeWord(ptr: number, value: number): void {
    if (!Mem.writeUint32(ptr, value)) throw new Error("msvcrt: time-data write failed");
}
function clearTimeString(ptr: number): void {
    if (!Mem.writeUint8(ptr, 0)) throw new Error("msvcrt: time terminator write failed");
}

/** One function call's tm fields are consumed without normalizing the date. */
function formatTime(
    format: string,
    tmPtr: number,
    names: readonly string[],
    timezoneName?: (isDst: number) => string
): string {
    const field = (index: number, low: number, high: number): number => {
        if (!tmPtr) throw new InvalidTime("NULL tm");
        const raw = Mem.readUint32(tmPtr + 4 * index);
        if (raw == null) throw new Error("msvcrt: unreadable tm");
        const value = raw | 0;
        if (value < low || value > high) throw new InvalidTime("tm field outside range");
        return value;
    };
    // The pre-UCRT runtime accepts seconds 0..59; the leap second is a UCRT extension.
    const sec = () => field(0, 0, 59),
        min = () => field(1, 0, 59),
        hour = () => field(2, 0, 23);
    const day = () => field(3, 1, 31),
        month = () => field(4, 0, 11),
        year = () => field(5, 0, 8099) + 1900;
    const wday = () => field(6, 0, 6),
        yday = () => field(7, 0, 365);
    const number = (n: number, width: number, alternate = false) =>
        String(n).padStart(alternate ? 0 : width, "0");
    const shortDate = () => `${number(month() + 1, 2)}/${number(day(), 2)}/${number(year() % 100, 2)}`;
    const longDate = () =>
        `${names[7 + wday()]}, ${names[26 + month()]} ${number(day(), 2)}, ${number(year(), 4)}`;
    const clock = () => `${number(hour(), 2)}:${number(min(), 2)}:${number(sec(), 2)}`;
    let output = "";
    for (let i = 0; i < format.length; i++) {
        if (format[i] !== "%") {
            output += format[i];
            continue;
        }
        i++;
        const alternate = format[i] === "#";
        if (alternate) i++;
        let part: string;
        switch (format[i]) {
            case "a":
                part = names[wday()]!;
                break;
            case "A":
                part = names[7 + wday()]!;
                break;
            case "b":
                part = names[14 + month()]!;
                break;
            case "B":
                part = names[26 + month()]!;
                break;
            case "c":
                part = (alternate ? longDate() : shortDate()) + " " + clock();
                break;
            case "d":
                part = number(day(), 2, alternate);
                break;
            case "H":
                part = number(hour(), 2, alternate);
                break;
            case "I":
                part = number(hour() % 12 || 12, 2, alternate);
                break;
            case "j":
                part = number(yday() + 1, 3, alternate);
                break;
            case "m":
                part = number(month() + 1, 2, alternate);
                break;
            case "M":
                part = number(min(), 2, alternate);
                break;
            case "p":
                part = names[hour() < 12 ? 38 : 39]!;
                break;
            case "S":
                part = number(sec(), 2, alternate);
                break;
            case "U":
                part = number(Math.floor((yday() + 7 - wday()) / 7), 2, alternate);
                break;
            case "W":
                part = number(Math.floor((yday() + 7 - ((wday() + 6) % 7)) / 7), 2, alternate);
                break;
            case "w":
                part = String(wday());
                break;
            case "x":
                part = alternate ? longDate() : shortDate();
                break;
            case "X":
                part = clock();
                break;
            case "y":
                part = number(year() % 100, 2, alternate);
                break;
            case "Y":
                part = number(year(), 4, alternate);
                break;
            // The pre-UCRT runtime prints _tzname for both, unlike UCRT's numeric %z.
            case "z":
            case "Z": {
                if (!timezoneName)
                    throw new Error("msvcrt: VC6 timezone formatting requires _tzset/_tzname state");
                part = timezoneName(field(8, -0x80000000, 0x7fffffff));
                break;
            }
            case "%":
                part = "%";
                break;
            default:
                throw new InvalidTime("invalid VC6 time conversion");
        }
        output += part;
    }
    return output;
}

export function registerMsvcrtTimeLocaleExports(
    exports: Record<string, ThunkImplementation>,
    host: MsvcrtTimeLocaleHost
): void {
    const allocate = (size: number): number => {
        const p = host.alloc(size) >>> 0;
        if (!p) host.setErrno(12); // ENOMEM
        return p;
    };
    const ownedString = (text: string): number => {
        const p = allocate(text.length + 1);
        if (p) writeBytesString(p, text);
        return p;
    };
    // Only the C locale's names exist here; another locale stops the process rather than
    // borrowing the host's rules (strftime itself fails with EINVAL instead).
    const requireCLocale = (): void => {
        if (!host.hasCLocale()) throw new Error("msvcrt: unsupported LC_TIME locale data");
    };
    exports["_Getdays"] = () => {
        requireCLocale();
        return ownedString(DAYS.map(s => `:${s.slice(0, 3)}:${s}`).join(""));
    };
    exports["_Getmonths"] = () => {
        requireCLocale();
        return ownedString(MONTHS.map(s => `:${s.slice(0, 3)}:${s}`).join(""));
    };
    exports["_Gettnames"] = () => {
        requireCLocale();
        const size = TIME_PREFIX_SIZE + C_NAMES.reduce((n, s) => n + s.length + 1, 0);
        const p = allocate(size);
        if (!p) return 0;
        let data = p + TIME_PREFIX_SIZE;
        C_NAMES.forEach((s, i) => {
            writeTimeWord(p + 4 * i, data);
            writeBytesString(data, s);
            data += s.length + 1;
        });
        writeTimeWord(p + 172, 9); // C time-data uses English LCID in the narrow ABI.
        writeTimeWord(p + 176, 1); // Gregorian calendar.
        writeTimeWord(p + 180, 0xffffffff); // C locale snapshot's refcount field.
        return p;
    };
    const strftime = (dest: number, size: number, fmt: number, tm: number, data: number): number => {
        size >>>= 0;
        if (!dest || !size || !fmt || !host.hasCLocale()) {
            host.setErrno(22);
            return 0;
        }
        const names = data
            ? C_NAMES.map((_, i) => {
                  const p = Mem.readUint32(data + 4 * i);
                  if (p == null) throw new Error("msvcrt: unreadable time-data prefix");
                  return readBytesString(p);
              })
            : C_NAMES;
        // Only the C locale's date patterns are understood; refuse others rather than guess.
        for (let i = 40; i < 43; i++)
            if (names[i] !== C_NAMES[i]) throw new Error("msvcrt: unsupported LC_TIME date pattern");
        try {
            const output = formatTime(readBytesString(fmt), tm, names, host.timezoneName);
            if (output.length >= size) {
                clearTimeString(dest);
                host.setErrno(34);
                return 0;
            }
            writeBytesString(dest, output);
            return output.length;
        } catch (error) {
            if (!(error instanceof InvalidTime)) throw error;
            clearTimeString(dest);
            host.setErrno(22);
            return 0;
        }
    };
    exports["_Strftime"] = (_c, _m, a) => strftime(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, a[4] ?? 0);
    exports["strftime"] = (_c, _m, a) => strftime(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, 0);
}
