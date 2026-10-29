/**
 * Wide-string helpers the pre-UCRT runtime exports: wcsncat and _ultow.
 * https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/strncat-strncat-l-wcsncat-wcsncat-l-mbsncat-mbsncat-l
 * https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/itoa-itow
 */
import { Mem } from '../core/memory/mem-accessor';
import type { ThunkImplementation } from '../core/thunking/thunk-dispatcher';

function range(address: number, size: number, operation: string): void {
    const memory = Mem.getView();
    if (!address || !memory || address + size > memory.length || address + size > 0x100000000) {
        throw new Error(`CRT wide strings: invalid guest ${operation} at 0x${address.toString(16)}`);
    }
}
function unit(address: number): number {
    range(address, 2, 'read');
    const value = Mem.readUint16(address);
    if (value === null) throw new Error('CRT wide strings: invalid guest read');
    return value;
}
function putUnit(address: number, value: number): void {
    range(address, 2, 'write');
    if (!Mem.writeUint16(address, value)) throw new Error('CRT wide strings: invalid guest write');
}

export function crtWcsncat(destination: number, source: number, count: number): number {
    const original = destination >>> 0;
    let output = original, input = source >>> 0, remaining = count >>> 0;
    if (remaining === 0) return original;
    while (unit(output) !== 0) output += 2;
    while (remaining-- > 0) {
        const value = unit(input);
        putUnit(output, value);
        if (value === 0) return original;
        input += 2;
        output += 2;
    }
    putUnit(output, 0);
    return original;
}

export function crtUltow(value: number, destination: number, radix: number): number {
    radix |= 0;
    if (radix < 2 || radix > 36) throw new Error('_ultow: invalid radix (must be 2..36)');
    const pointer = destination >>> 0;
    const text = (value >>> 0).toString(radix);
    for (let i = 0; i < text.length; i++) putUnit(pointer + 2 * i, text.charCodeAt(i));
    putUnit(pointer + 2 * text.length, 0);
    return pointer;
}

export function registerLegacyCrtStringExports(exports: Record<string, ThunkImplementation>): void {
    exports["wcsncat"] = (_context, _memory, args) => crtWcsncat(args[0], args[1], args[2]);
    exports["_ultow"] = (_context, _memory, args) => crtUltow(args[0], args[1], args[2]);
}
