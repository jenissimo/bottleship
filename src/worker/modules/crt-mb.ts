/**
 * CRT multibyte string helpers (_mbs*). SBCS locale (mb_cur_max = 1): each
 * character is one byte, so these mirror the narrow-string counterparts.
 */
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";

export interface CrtMbHost {
    readCString(ptr: number, maxLen: number): string;
    compareCString(aPtr: number, bPtr: number, ignoreCase: boolean, max: number): number;
    ischartype(ch: number, mask: number): number;
    setMbcp(codepage: number): number;
    getMbcp(): number;
}

export function registerCrtMbExports(exports: Record<string, ThunkImplementation>, host: CrtMbHost): void {
    const chr = (ptr: number, i: number) => Mem.readUint8(ptr + i) ?? 0;

    exports["_mbschr"] = (_c, _m, a) => {
        const str = a[0] ?? 0;
        const ch = (a[1] ?? 0) & 0xff;
        if (!str) return 0;
        for (let i = 0; i < 0x100000; i++) {
            const b = chr(str, i);
            if (b === ch) return (str + i) >>> 0;
            if (b === 0) break;
        }
        return 0;
    };

    exports["_mbsrchr"] = (_c, _m, a) => {
        const str = a[0] ?? 0;
        const ch = (a[1] ?? 0) & 0xff;
        if (!str) return 0;
        let found = 0;
        for (let i = 0; i < 0x100000; i++) {
            const b = chr(str, i);
            if (b === ch) found = (str + i) >>> 0;
            if (b === 0) break;
        }
        return found;
    };

    exports["_mbscmp"] = (_c, _m, a) => host.compareCString(a[0] ?? 0, a[1] ?? 0, false, 0);
    exports["_mbsnbcmp"] = (_c, _m, a) => {
        const n = (a[2] ?? 0) >>> 0;
        return n === 0 ? 0 : host.compareCString(a[0] ?? 0, a[1] ?? 0, false, n);
    };
    exports["_mbsnbicmp"] = (_c, _m, a) => {
        const n = (a[2] ?? 0) >>> 0;
        return n === 0 ? 0 : host.compareCString(a[0] ?? 0, a[1] ?? 0, true, n);
    };

    exports["_mbsstr"] = (_c, _m, a) => {
        const hay = a[0] ?? 0;
        const needle = a[1] ?? 0;
        if (!hay || !needle) return 0;
        const str = host.readCString(hay, 0x100000);
        const sub = host.readCString(needle, 0x100000);
        if (sub.length === 0) return hay >>> 0;
        const idx = str.indexOf(sub);
        return idx < 0 ? 0 : (hay + idx) >>> 0;
    };

    exports["_mbspbrk"] = (_c, _m, a) => {
        const str = a[0] ?? 0;
        const charset = a[1] ?? 0;
        if (!str || !charset) return 0;
        const s = host.readCString(str, 0x100000);
        const chars = host.readCString(charset, 256);
        for (let i = 0; i < s.length; i++) {
            if (chars.includes(s[i]!)) return (str + i) >>> 0;
        }
        return 0;
    };

    exports["_mbscspn"] = (_c, _m, a) => {
        const str = a[0] ?? 0;
        const reject = a[1] ?? 0;
        if (!str || !reject) return 0;
        const s = host.readCString(str, 0x100000);
        const rej = host.readCString(reject, 256);
        const rejSet = new Set(rej.split(""));
        let n = 0;
        for (; n < s.length && s.charCodeAt(n) !== 0; n++) {
            if (rejSet.has(s[n]!)) break;
        }
        return n;
    };

    exports["_mbsspn"] = (_c, _m, a) => {
        const str = a[0] ?? 0;
        const accept = a[1] ?? 0;
        if (!str || !accept) return 0;
        const s = host.readCString(str, 0x100000);
        const acc = host.readCString(accept, 256);
        const accSet = new Set(acc.split(""));
        let n = 0;
        for (; n < s.length && s.charCodeAt(n) !== 0; n++) {
            if (!accSet.has(s[n]!)) break;
        }
        return n;
    };

    exports["_mbsinc"] = (_c, _m, a) => {
        const ptr = a[0] ?? 0;
        if (!ptr) return 0;
        return chr(ptr, 0) === 0 ? ptr >>> 0 : (ptr + 1) >>> 0;
    };

    exports["_mbsdec"] = (_c, _m, a) => {
        const start = a[0] ?? 0;
        const current = a[1] ?? 0;
        if (!start || !current || current <= start) return 0;
        return (current - 1) >>> 0;
    };

    exports["_mbclen"] = (_c, _m, a) => {
        const ptr = a[0] ?? 0;
        if (!ptr) return 0;
        return chr(ptr, 0) === 0 ? 0 : 1;
    };

    exports["_mbsrev"] = (_c, _m, a) => {
        const ptr = a[0] ?? 0;
        if (!ptr) return 0;
        let len = 0;
        while (len < 0x100000 && chr(ptr, len) !== 0) len++;
        for (let i = 0, j = len - 1; i < j; i++, j--) {
            const tmp = chr(ptr, i);
            Mem.writeUint8(ptr + i, chr(ptr, j));
            Mem.writeUint8(ptr + j, tmp);
        }
        return ptr >>> 0;
    };

    exports["_mbslwr"] = (_c, _m, a) => {
        const ptr = a[0] ?? 0;
        if (!ptr) return 0;
        for (let i = 0; i < 0x100000; i++) {
            const c = chr(ptr, i);
            if (c === 0) break;
            if (c >= 0x41 && c <= 0x5a) Mem.writeUint8(ptr + i, c + 0x20);
        }
        return ptr >>> 0;
    };

    exports["_mbsupr"] = (_c, _m, a) => {
        const ptr = a[0] ?? 0;
        if (!ptr) return 0;
        for (let i = 0; i < 0x100000; i++) {
            const c = chr(ptr, i);
            if (c === 0) break;
            if (c >= 0x61 && c <= 0x7a) Mem.writeUint8(ptr + i, c - 0x20);
        }
        return ptr >>> 0;
    };

    exports["_ismbcspace"] = (_c, _m, a) => host.ischartype(a[0] ?? 0, 0x0008);
    exports["_ismbcdigit"] = (_c, _m, a) => host.ischartype(a[0] ?? 0, 0x0004);

    exports["_setmbcp"] = (_c, _m, a) => host.setMbcp(a[0] ?? 0);
    exports["_getmbcp"] = () => host.getMbcp();

    exports["_mbsicmp"] = (_c, _m, a) => host.compareCString(a[0] ?? 0, a[1] ?? 0, true, 0);

    // unsigned char* _mbsnbcpy(dst, src, count) — strncpy over bytes: copies at most
    // count bytes and zero-pads the remainder, so it does NOT guarantee termination.
    exports["_mbsnbcpy"] = (_c, _m, a) => {
        const dst = a[0] ?? 0, src = a[1] ?? 0, count = (a[2] ?? 0) >>> 0;
        if (!dst || count === 0) return dst >>> 0;
        const out = new Uint8Array(count);
        for (let i = 0; i < count; i++) {
            const b = chr(src, i);
            if (b === 0) break;
            out[i] = b;
        }
        Mem.writeBytes(dst, out);
        return dst >>> 0;
    };

    exports["_mbctolower"] = (_c, _m, a) => {
        const c = (a[0] ?? 0) & 0xffff;
        return c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
    };
    exports["_mbctoupper"] = (_c, _m, a) => {
        const c = (a[0] ?? 0) & 0xffff;
        return c >= 0x61 && c <= 0x7a ? c - 0x20 : c;
    };
}
