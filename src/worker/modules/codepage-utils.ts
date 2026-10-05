/**
 * Codepage-aware ANSI string utilities for guest memory I/O.
 *
 * All functions use the active ANSI code page from EmulatorConfig
 * (default 1252, configurable per-game via manifest "codepage" field).
 */

export { getCodePageDecoder, decodeAnsiString, encodeAnsiString } from "../core/emulator-config-manager";
import { EmulatorConfig, encodeAnsiString, getCodePageDecoder } from "../core/emulator-config-manager";
import { asBufferSource } from "../../dom-buffer";

/** Get the active ANSI code page from EmulatorConfig. */
export function getAnsiCodePage(): number {
    return EmulatorConfig.getInstance().ansiCodePage;
}

/**
 * Read a null-terminated ANSI string from guest memory using the active code page.
 * Replaces: `new TextDecoder().decode(...)` and `String.fromCharCode(byte)` loop patterns.
 */
export function readAnsiFromGuest(mem: Uint8Array, ptr: number, maxLen?: number): string {
    if (!ptr || ptr < 0 || ptr >= mem.length) return "";
    const limit = maxLen ?? (mem.length - ptr);
    let end = ptr;
    const stop = Math.min(ptr + limit, mem.length);
    while (end < stop && mem[end] !== 0) end++;
    if (end === ptr) return "";
    return getCodePageDecoder(EmulatorConfig.getInstance().ansiCodePage)
        .decode(asBufferSource(mem.subarray(ptr, end)));
}

/**
 * Write a JS string to guest memory as null-terminated ANSI bytes.
 * Returns bytes written (excluding null terminator).
 * Replaces: `charCodeAt(i) & 0xFF` loops and `new TextEncoder().encode(...)`.
 */
export function writeAnsiToGuest(mem: Uint8Array, addr: number, str: string, maxBytes?: number): number {
    if (!addr || addr < 0 || addr >= mem.length) return 0;
    const encoded = encodeAnsiString(str, EmulatorConfig.getInstance().ansiCodePage);
    const limit = maxBytes !== undefined ? Math.min(encoded.length, maxBytes - 1) : encoded.length;
    mem.set(encoded.subarray(0, limit), addr);
    mem[addr + limit] = 0;
    return limit;
}

/**
 * Encode a JS string to ANSI bytes using the active code page (no null terminator).
 * Drop-in replacement for `new TextEncoder().encode(str)` when writing to guest memory.
 */
/**
 * Read a guest string whose width is unknown (WM_SETTEXT & friends arrive via both A and W
 * entry points): mostly-zero high bytes means UTF-16.
 *
 * PASS `hint` WHEN YOU KNOW. `"5\0"` and `L"5"` are the same bytes, and `"5\0A\0\0\0"` is
 * the same bytes as `L"5A"` — no inspection can separate them, so a caller that reached here
 * from an A or W entry point must say which it was rather than let the heuristic guess.
 *
 * Without a hint: the probe never draws a conclusion from bytes PAST the ANSI terminator —
 * those belong to the heap, not to the string. Two or more non-zero bytes in a row settle it
 * as ANSI outright (a UTF-16 string of ASCII-range characters puts a zero at ptr+1). That
 * leaves exactly one ambiguous shape, an ANSI string of length 1, whose first character
 * decodes the same either way — so wide has to be earned from further characters, and that
 * evidence is only admissible when the pairs terminate on a real 16-bit NUL inside the window
 * and every low byte is a plausible text unit. A one-character ANSI string followed by
 * ordinary heap fails both tests and stays ANSI; heap that happens to spell
 * `<char> 00 00 00` is the irreducible residual above.
 */
export function readAnsiOrWideFromGuest(mem: Uint8Array, ptr: number, hint?: 'ansi' | 'wide'): string {
    if (!ptr || ptr < 0 || ptr >= mem.length) return '';
    if (hint === 'ansi') return readAnsiFromGuest(mem, ptr);
    if (hint === 'wide') return readWideFromGuest(mem, ptr);

    const maxProbeChars = 16;
    const scanStop = Math.min(ptr + maxProbeChars * 2, mem.length);
    let ansiEnd = ptr;
    while (ansiEnd < scanStop && mem[ansiEnd] !== 0) ansiEnd++;
    if (ansiEnd - ptr !== 1) return readAnsiFromGuest(mem, ptr);

    let probed = 0;
    let zeroHighBytes = 0;
    let terminated = false;
    for (let i = 0; i < maxProbeChars; i++) {
        const loIdx = ptr + i * 2;
        const hiIdx = loIdx + 1;
        if (hiIdx >= mem.length) break;
        const lo = mem[loIdx];
        const hi = mem[hiIdx];
        if (lo === 0 && hi === 0) { terminated = true; break; }
        if (lo < 0x09) break; // not a plausible text unit — stop believing the wide reading
        probed++;
        if (hi === 0) zeroHighBytes++;
    }
    const looksWide = terminated && probed >= 2 && (zeroHighBytes / probed) >= 0.75;
    return looksWide ? readWideFromGuest(mem, ptr) : readAnsiFromGuest(mem, ptr);
}

/** Null-terminated UTF-16LE from guest memory. */
export function readWideFromGuest(mem: Uint8Array, ptr: number): string {
    if (!ptr || ptr < 0 || ptr >= mem.length) return '';
    let out = '';
    for (let p = ptr; p + 1 < mem.length; p += 2) {
        const code = mem[p] | (mem[p + 1] << 8);
        if (code === 0) break;
        out += String.fromCharCode(code);
    }
    return out;
}

export function encodeAnsi(str: string): Uint8Array {
    return encodeAnsiString(str, EmulatorConfig.getInstance().ansiCodePage);
}
