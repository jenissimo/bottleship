import {Mem} from "../core/memory/mem-accessor";
import {raiseGuestAccessViolation} from "../core/thunking/guest-fault";
import type {ThunkImplementation} from "../core/thunking/thunk-dispatcher";
import {EmulatorConfig, getCodePageDecoder} from "../core/emulator-config-manager";

class CrtReadFault extends Error {
    constructor(readonly address: number) { super("CRT guest string read failed"); }
}

/** Only these checked readers' faults are converted; unrelated host errors still propagate. */
export function withCrtReadFault(implementation: ThunkImplementation): ThunkImplementation {
    return (ctx, mem, args) => {
        try { return implementation(ctx, mem, args); }
        catch (error) {
            if (!(error instanceof CrtReadFault)) throw error;
            return raiseGuestAccessViolation(ctx, mem, error.address, "r", 0);
        }
    };
}

export function readCrtWString(ptr: number, maxChars: number): string {
    if (!ptr) return "";
    const limit = Math.max(1, Math.min(maxChars >>> 0, 0x10000));
    let text = "";
    for (let i = 0; i < limit; i++) {
        const address = ptr + i * 2, unit = Mem.readUint16(address);
        if (unit === null) throw new CrtReadFault(Mem.firstInaccessibleByte(address, 2, "r"));
        if (unit === 0) break;
        text += String.fromCharCode(unit);
    }
    return text;
}

export function readCrtCString(ptr: number, maxBytes: number): string {
    if (!ptr) return "";
    const limit = Math.max(1, maxBytes >>> 0), bytes: number[] = [];
    for (let i = 0; i < limit; i++) {
        const address = ptr + i, byte = Mem.readUint8(address);
        if (byte === null) throw new CrtReadFault(address);
        if (byte === 0) break;
        bytes.push(byte);
    }
    return getCodePageDecoder(EmulatorConfig.getInstance().ansiCodePage).decode(new Uint8Array(bytes));
}

/** A precision-limited string need not have a readable terminator past its output. */
export function readCrtFormatString(ptr: number, wide: boolean, precision: number | null): string {
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
        const address = ptr + i, value = Mem.readUint8(address);
        if (value === null) throw new CrtReadFault(address);
        if (value === 0) return (text + (decoder?.decode() ?? "")).slice(0, precision);
        byte[0] = value;
        text += decoder ? decoder.decode(byte, {stream: true}) : codepage.decode(byte);
        if (text.length >= precision) return text.slice(0, precision);
    }
    return (text + (decoder?.decode() ?? "")).slice(0, precision);
}
