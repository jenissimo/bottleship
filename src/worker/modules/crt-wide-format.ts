import {readCrtUint8, readCrtUint16, writeCrtUint16, crtFaultAddress} from "./crt-guest-access";
import { raiseGuestAccessViolation } from "../core/thunking/guest-fault";
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";

import {EmulatorConfig, getCodePageDecoder} from "../core/emulator-config-manager";
import {ArrayVaListReader, formatCLazy} from "./crt-format";
import {CrtReadFault, readCrtWString, withCrtReadFault} from "./crt-checked-strings";

interface WideFormatHost {
    setErrno(code: number): void;
}

/** Validate every conversion before the permissive legacy formatter can consume arguments. */
function validSecureFormat(ptr: number): boolean | number {
    let format = "";
    for (let i = 0; ; i++) {
        const unit = readCrtUint16(ptr + i * 2);
        if (unit === null) return crtFaultAddress(ptr + i * 2, 2, "r");
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
    const format = (counted: boolean): ThunkImplementation => (ctx, mem, a) => {
        const dst = (a[0] ?? 0) >>> 0;
        const size = (a[1] ?? 0) >>> 0;
        const count = counted ? (a[2] ?? 0) >>> 0 : size;
        const fmt = (a[counted ? 3 : 2] ?? 0) >>> 0;
        if (counted && !dst && !size && !count) return 0;
        if (!dst || !size || !fmt) { host.setErrno(22); return -1; }
        const validation = validSecureFormat(fmt);
        if (typeof validation === "number") return raiseGuestAccessViolation(ctx, mem, validation, "r", 0);
        if (!validation) {
            if (!writeCrtUint16(dst, 0)) return raiseGuestAccessViolation(ctx, mem, crtFaultAddress(dst, 2, "w"), "w", 0);
            host.setErrno(22);
            return -1;
        }
        const text = formatCLazy(readCrtWString(fmt, 0x10000), new ArrayVaListReader(a, counted ? 4 : 3),
            readCrtCString, {wide: true, readWString: readCrtWString, readString: readCrtFormatString});
        const limit = counted && count < size ? count : size - 1;
        if (text.length > limit && (!counted || (count !== 0xffffffff && count >= size))) {
            if (!writeCrtUint16(dst, 0)) return raiseGuestAccessViolation(ctx, mem, crtFaultAddress(dst, 2, "w"), "w", 0);
            host.setErrno(34);
            return -1;
        }
        const length = Math.min(text.length, limit);
        for (let i = 0; i < length; i++) {
            const address = dst + i * 2;
            if (!writeCrtUint16(address, text.charCodeAt(i))) return raiseGuestAccessViolation(ctx, mem, crtFaultAddress(address, 2, "w"), "w", 0);
        }
        if (!writeCrtUint16(dst + length * 2, 0)) return raiseGuestAccessViolation(ctx, mem, crtFaultAddress(dst + length * 2, 2, "w"), "w", 0);
        return text.length > limit ? -1 : length;
    };
    exports["swprintf_s"] = withCrtReadFault(format(false));
    exports["_snwprintf_s"] = withCrtReadFault(format(true));
}

function readCrtCString(ptr: number, maxBytes: number): string {
    if (!ptr) return "";
    const limit = Math.max(1, maxBytes >>> 0), bytes: number[] = [];
    for (let i = 0; i < limit; i++) {
        const address = ptr + i, byte = readCrtUint8(address);
        if (byte === null) throw new CrtReadFault(address);
        if (byte === 0) break;
        bytes.push(byte);
    }
    return getCodePageDecoder(EmulatorConfig.getInstance().ansiCodePage).decode(new Uint8Array(bytes));
}

/** A precision-limited string need not have a readable terminator past its output. */
function readCrtFormatString(ptr: number, wide: boolean, precision: number | null): string {
    if (precision === 0) return "";
    if (wide) return readCrtWString(ptr, precision === null ? 0x10000 : precision);
    if (precision === null) return readCrtCString(ptr, 0x100000);
    // Decode complete multibyte characters, stopping at the wide-output limit.
    // A private streaming decoder keeps an access fault from retaining decoder state.
    const codepage = getCodePageDecoder(EmulatorConfig.getInstance().ansiCodePage);
    const decoder = codepage instanceof TextDecoder ? new TextDecoder(codepage.encoding) : null;
    const byte = new Uint8Array(1);
    let text = "";
    for (let i = 0; i < 0x100000; i++) {
        const address = ptr + i, value = readCrtUint8(address);
        if (value === null) throw new CrtReadFault(address);
        if (value === 0) return (text + (decoder?.decode() ?? "")).slice(0, precision);
        byte[0] = value;
        text += decoder ? decoder.decode(byte, {stream: true}) : codepage.decode(byte);
        if (text.length >= precision) return text.slice(0, precision);
    }
    return (text + (decoder?.decode() ?? "")).slice(0, precision);
}
