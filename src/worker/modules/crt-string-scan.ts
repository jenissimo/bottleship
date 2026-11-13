/**
 * Scans for the CRT string leaves' JS fallbacks, with the semantics of the string
 * hypercalls: no length cap, so a string of any length inside guest memory is measured,
 * copied and searched whole. Every scan stops at the first unreadable byte, which bounds it
 * by readable guest memory; `terminated` says whether it ended at the terminator.
 */
import { Mem } from '../core/memory/mem-accessor';

export interface StringScan {
    /** Units before the terminator, or before the first unreadable unit. */
    length: number;
    terminated: boolean;
}

export function scanCString(ptr: number): StringScan {
    let length = 0;
    for (;;) {
        const b = Mem.readUint8(ptr + length);
        if (b == null || ptr + length > 0xffffffff) return { length, terminated: false };
        if (b === 0) return { length, terminated: true };
        length++;
    }
}

export function scanWString(ptr: number): StringScan {
    let length = 0;
    for (;;) {
        const u = Mem.readUint16(ptr + length * 2);
        if (u == null || ptr + length * 2 > 0xfffffffe) return { length, terminated: false };
        if (u === 0) return { length, terminated: true };
        length++;
    }
}

/**
 * First occurrence of `needle` in `haystack`, naive O(n*m) like MSVCRT and the hypercalls;
 * the empty needle matches at `haystack`. Returns 0 when absent, also when the haystack is
 * not terminated before unreadable memory.
 */
export function findString(haystack: number, needle: number, wide: boolean): number {
    const stride = wide ? 2 : 1;
    const read = (p: number) => (wide ? Mem.readUint16(p) : Mem.readUint8(p));
    const first = read(needle);
    if (first == null) return 0;
    if (first === 0) return haystack >>> 0;
    for (let i = 0; ; i++) {
        const h = read(haystack + i * stride);
        if (h == null || h === 0) return 0;
        if (h !== first) continue;
        for (let j = 1; ; j++) {
            const n = read(needle + j * stride);
            if (n == null) return 0;
            if (n === 0) return (haystack + i * stride) >>> 0;
            if (read(haystack + (i + j) * stride) !== n) break;
        }
    }
}
