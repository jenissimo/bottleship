/** The CRT's _timezone/_daylight/_dstbias/_tzname data and _tzset.
 * TZ follows the documented std[+|-]hh[:mm[:ss]][dst] syntax with a one-hour DST
 * adjustment; without TZ the OS snapshot GetTimeZoneInformation reports is used.
 * https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/tzset
 */
import { Mem } from "../core/memory/mem-accessor";
import type { WindowsTimezoneSnapshot } from "../runtime/windows-timezone";
export interface CrtTimezoneValues {
    secondsWest: number;
    daylight: number;
    dstBias: number;
    standardName: string;
    daylightName: string;
}
export function parseCrtTimezone(tz: string): CrtTimezoneValues {
    // Reject unsupported syntax explicitly; accepting arbitrary POSIX/IANA TZ
    // values here would give different semantics from the VC6 environment ABI.
    const m = /^([A-Za-z]{3})([+-]?)(\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?([A-Za-z]{3})?$/.exec(tz);
    if (!m || Number(m[3]) > 23 || Number(m[4] ?? 0) > 59 || Number(m[5] ?? 0) > 59)
        throw new Error(`msvcrt: unsupported TZ value ${JSON.stringify(tz)}`);
    const magnitude = Number(m[3]) * 3600 + Number(m[4] ?? 0) * 60 + Number(m[5] ?? 0);
    return {
        secondsWest: m[2] === "-" ? -magnitude : magnitude,
        daylight: m[6] ? 1 : 0,
        dstBias: -3600,
        standardName: m[1]!,
        daylightName: m[6] ?? "",
    };
}
export interface CrtTimezoneHost {
    alloc(bytes: number): number;
    environmentTZ(): string | undefined;
    windowsTimezone(): WindowsTimezoneSnapshot;
}
export class MsvcrtTimezoneState {
    readonly timezone: number;
    readonly daylight: number;
    readonly dstbias: number;
    readonly tzname: number;
    private readonly names: number;
    constructor(private readonly host: CrtTimezoneHost) {
        // Four data cells plus two bounded name strings; rebuilt after a process reset.
        const base = host.alloc(20 + 128);
        if (!base) throw new Error("msvcrt: timezone storage allocation failed");
        this.timezone = base;
        this.daylight = base + 4;
        this.dstbias = base + 8;
        this.tzname = base + 12;
        this.names = base + 20;
        this.writeWord(this.tzname, this.names);
        this.writeWord(this.tzname + 4, this.names + 64);
        this.writeWord(this.dstbias, -3600); // CRT startup default; explicit TZ does not replace it.
        this.tzset();
    }
    private writeWord(p: number, value: number): void {
        if (!Mem.writeUint32(p, value)) throw new Error("msvcrt: timezone data write failed");
    }
    private writeName(p: number, text: string): void {
        if (text.length >= 64 || [...text].some(c => c.charCodeAt(0) > 0x7f))
            throw new Error("msvcrt: unsupported timezone name encoding");
        const bytes = new Uint8Array(64);
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
        if (Mem.writeBytes(p, bytes) !== bytes.length) throw new Error("msvcrt: timezone name write failed");
    }
    tzset(): void {
        const tz = this.host.environmentTZ();
        let value: CrtTimezoneValues;
        if (tz) {
            value = parseCrtTimezone(tz);
            const bias = Mem.readUint32(this.dstbias);
            if (bias == null) throw new Error("msvcrt: unreadable DST bias");
            value.dstBias = bias | 0; // _tzset(TZ) retains the mutable CRT DST adjustment.
        } else {
            const os = this.host.windowsTimezone();
            value = {
                secondsWest: (os.biasMinutes + (os.hasDaylightTransitions ? os.standardBiasMinutes : 0)) * 60,
                daylight: os.hasDaylightTransitions ? 1 : 0,
                dstBias: os.hasDaylightTransitions
                    ? (os.daylightBiasMinutes - os.standardBiasMinutes) * 60
                    : 0,
                standardName: os.standardName,
                daylightName: os.daylightName,
            };
        }
        this.writeWord(this.timezone, value.secondsWest);
        this.writeWord(this.daylight, value.daylight);
        this.writeWord(this.dstbias, value.dstBias);
        this.writeName(this.names, value.standardName);
        this.writeName(this.names + 64, value.daylightName);
    }
    name(isDst: number): string {
        // Guest code can modify the exported _tzname pointers, as on native CRT.
        const ptr = Mem.readUint32(this.tzname + (isDst ? 4 : 0));
        if (ptr == null || !ptr) throw new Error("msvcrt: invalid timezone name pointer");
        let text = "";
        for (let i = 0; i < 64; i++) {
            const ch = Mem.readUint8(ptr + i);
            if (ch == null) throw new Error("msvcrt: unreadable timezone name");
            if (!ch) return text;
            text += String.fromCharCode(ch);
        }
        throw new Error("msvcrt: unterminated timezone name");
    }
}
