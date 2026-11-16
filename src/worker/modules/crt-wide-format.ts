import { Mem } from "../core/memory/mem-accessor";
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";

function putUnit(address: number, value: number): void {
    if (!Mem.writeUint16(address, value)) throw new Error("CRT wide formatting: invalid guest write");
}

interface WideFormatHost {
    format(format: number, args: number[], first: number): string;
    setErrno(code: number): void;
}

/** Validate every conversion before the permissive legacy formatter can consume arguments. */
function validSecureFormat(ptr: number): boolean {
    let format = "";
    for (let i = 0; ; i++) {
        const unit = Mem.readUint16(ptr + i * 2);
        if (unit === null) throw new Error("CRT wide formatting: invalid guest read");
        if (unit === 0) break;
        format += String.fromCharCode(unit);
    }
    const conversion = /%[-+ #0]*(?:\*|\d*)(?:\.(?:\*|\d*))?(?:hh|h|ll|l|L|w|I32|I64|I|z|t|j)?[diuoxXfFeEgGaAcCsSp]/y;
    for (let i = 0; i < format.length; i++) {
        if (format[i] !== "%") continue;
        if (format[i + 1] === "%") { i++; continue; }
        conversion.lastIndex = i;
        if (!conversion.test(format)) return false;
        i = conversion.lastIndex - 1;
    }
    return true;
}

export function registerCrtWideFormatExports(exports: Record<string, ThunkImplementation>, host: WideFormatHost): void {
    const format = (counted: boolean): ThunkImplementation => (_c, _m, a) => {
        const dst = (a[0] ?? 0) >>> 0;
        const size = (a[1] ?? 0) >>> 0;
        const count = counted ? (a[2] ?? 0) >>> 0 : size;
        const fmt = (a[counted ? 3 : 2] ?? 0) >>> 0;
        if (counted && !dst && !size && !count) return 0;
        if (!dst || !size || !fmt) { host.setErrno(22); return -1; }
        if (!validSecureFormat(fmt)) {
            putUnit(dst, 0);
            host.setErrno(22);
            return -1;
        }
        const text = host.format(fmt, a, counted ? 4 : 3);
        const limit = counted && count < size ? count : size - 1;
        if (text.length > limit && (!counted || (count !== 0xffffffff && count >= size))) {
            putUnit(dst, 0);
            host.setErrno(34);
            return -1;
        }
        const length = Math.min(text.length, limit);
        for (let i = 0; i < length; i++) putUnit(dst + i * 2, text.charCodeAt(i));
        putUnit(dst + length * 2, 0);
        return text.length > limit ? -1 : length;
    };
    exports["swprintf_s"] = format(false);
    exports["_snwprintf_s"] = format(true);
}
