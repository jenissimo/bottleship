/**
 * CRT string search/compare/case functions (strstr, strpbrk, strncmp, _strupr,
 * strtok, memcmp). Host supplies readCString / compareCString; strtok's saved
 * pointer lives here (single-stream static in C; one Msvcrt instance).
 */
import { ThunkImplementation } from '../core/thunking/thunk-dispatcher';
import { Mem } from '../core/memory/mem-accessor';

export interface CrtStringHost {
    readCString(ptr: number, maxLen: number): string;
    compareCString(aPtr: number, bPtr: number, ignoreCase: boolean, max: number): number;
}

export function registerCrtStringExports(exports: Record<string, ThunkImplementation>, host: CrtStringHost): void {
    let strtokPtr = 0; // static state for strtok

    exports["strstr"] = (_c, _m, a) => {
        const haystack = a[0] ?? 0, needle = a[1] ?? 0;
        if (!haystack || !needle) return 0;
        const str = host.readCString(haystack, 0x100000);
        const sub = host.readCString(needle, 0x100000);
        if (sub.length === 0) return haystack >>> 0;
        const idx = str.indexOf(sub);
        if (idx < 0) return 0;
        return (haystack + idx) >>> 0;
    };

    exports["strpbrk"] = (_c, _m, a) => {
        const str = a[0] ?? 0, charset = a[1] ?? 0;
        if (!str || !charset) return 0;
        const s = host.readCString(str, 0x100000);
        const chars = host.readCString(charset, 256);
        for (let i = 0; i < s.length; i++) {
            if (chars.includes(s[i])) {
                return (str + i) >>> 0;
            }
        }
        return 0;
    };

    exports["strncmp"] = (_c, _m, a) =>
        ((a[2] ?? 0) >>> 0) === 0 ? 0 // compare zero chars → equal (compareCString treats 0 as unbounded)
            : host.compareCString(a[0] ?? 0, a[1] ?? 0, false, (a[2] ?? 0) >>> 0);

    exports["_strupr"] = (_c, _m, a) => {
        const ptr = a[0] ?? 0;
        if (!ptr) return 0;
        let offset = 0;
        for (;;) {
            const c = Mem.readUint8(ptr + offset);
            if (c === null || c === 0) break;
            if (c >= 0x61 && c <= 0x7a) {
                Mem.writeBytes(ptr + offset, new Uint8Array([c - 0x20]));
            }
            offset++;
        }
        return ptr >>> 0;
    };

    exports["strtok"] = (_c, _m, a) => {
        const strPtr = a[0] ?? 0, delimPtr = a[1] ?? 0;
        if (!delimPtr) return 0;
        const delims = host.readCString(delimPtr, 256);
        // If strPtr is non-null, start a new tokenization
        if (strPtr) strtokPtr = strPtr;
        if (!strtokPtr) return 0;

        // Skip leading delimiters
        let pos = strtokPtr;
        while (true) {
            const c = Mem.readUint8(pos);
            if (c === null || c === 0) { strtokPtr = 0; return 0; }
            if (!delims.includes(String.fromCharCode(c))) break;
            pos++;
        }

        // Find end of token
        const tokenStart = pos;
        while (true) {
            const c = Mem.readUint8(pos);
            if (c === null || c === 0) { strtokPtr = 0; break; }
            if (delims.includes(String.fromCharCode(c))) {
                Mem.writeBytes(pos, new Uint8Array([0])); // null-terminate
                strtokPtr = pos + 1;
                break;
            }
            pos++;
        }
        return tokenStart >>> 0;
    };

    exports["memcmp"] = (_c, _m, a) => {
        const aPtr = a[0] ?? 0, bPtr = a[1] ?? 0, n = (a[2] ?? 0) >>> 0;
        if (!aPtr || !bPtr || n === 0) return 0;
        for (let i = 0; i < n; i++) {
            const av = Mem.readUint8(aPtr + i) ?? 0;
            const bv = Mem.readUint8(bPtr + i) ?? 0;
            if (av !== bv) return (av - bv) | 0;
        }
        return 0;
    };

    // int _memicmp(const void*, const void*, size_t) — memcmp over ASCII-folded bytes.
    // The fold is ASCII-only in the "C" locale, which is what the CRT does too.
    exports["_memicmp"] = (_c, _m, a) => {
        const aPtr = a[0] ?? 0, bPtr = a[1] ?? 0, n = (a[2] ?? 0) >>> 0;
        if (!aPtr || !bPtr || n === 0) return 0;
        const fold = (c: number) => (c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
        for (let i = 0; i < n; i++) {
            const av = fold(Mem.readUint8(aPtr + i) ?? 0);
            const bv = fold(Mem.readUint8(bPtr + i) ?? 0);
            if (av !== bv) return (av - bv) | 0;
        }
        return 0;
    };
    exports["_memicmp_l"] = exports["_memicmp"];
}
