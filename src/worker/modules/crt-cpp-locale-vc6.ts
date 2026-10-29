/**
 * MSVCP60's C locale helpers (`_Getcoll`, `_Getctype`, `_Mbrtowc`, ... declared in
 * <xlocinfo.h>). `_Collvec`/`_Cvtvec` are 8-byte PODs returned in EDX:EAX; the 16-byte
 * `_Ctypevec` comes back through a hidden, caller-cleaned result pointer.
 *
 * The C locale is byte-preserving and ignores the process ANSI code page. Other locales
 * throw: answering with the host's locale rules would silently change comparisons.
 */
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { vc6ReadBytes as bytes, vc6ReadU32 as u32, vc6WriteBytes, vc6WriteU32 } from "./crt-cpp-memory-vc6";

export interface Vc6LocaleSnapshot {
    collateHandle: number;
    collateCodePage: number;
    ctypeHandle: number;
    ctypeCodePage: number;
    ctypeTable: number;
}

export interface Vc6LocaleHost {
    snapshot(): Vc6LocaleSnapshot;
    alloc(bytes: number): number;
    free(address: number): void;
    setEdx(value: number): void;
    setErrno(value: number): void;
}

export function registerVc6LocaleExports(exports: Record<string, ThunkImplementation>, host: Vc6LocaleHost): void {
    const rangeLength = (first: number, last: number): number => {
        if ((last >>> 0) < (first >>> 0)) throw new Error("msvcp60: reversed locale byte range");
        return (last >>> 0) - (first >>> 0);
    };
    const requireC = (name: string, vector: number, collate = false): void => {
        let handle: number, page: number;
        if (vector) {
            handle = u32(vector);
            page = u32(vector + 4);
        } else {
            const current = host.snapshot();
            handle = collate ? current.collateHandle : current.ctypeHandle;
            page = collate ? current.collateCodePage : current.ctypeCodePage;
        }
        if (handle !== 0 || page !== 0) {
            throw new Error(`msvcp60:${name}: non-C locale is not implemented (LCID=${handle}, codepage=${page})`);
        }
    };
    exports["_Getcoll"] = () => {
        const current = host.snapshot();
        host.setEdx(current.collateCodePage);
        return current.collateHandle;
    };
    exports["_Getcvt"] = () => {
        const current = host.snapshot();
        host.setEdx(current.ctypeCodePage);
        return current.ctypeHandle;
    };
    exports["_Getctype"] = (_ctx, _mem, args) => {
        const destination = args[0]! >>> 0;
        const current = host.snapshot();
        // Copy before allocating: malloc may grow guest memory and invalidate a view.
        const copy = new Uint8Array(bytes(current.ctypeTable, 512));
        const table = host.alloc(512);
        if (!table) throw new Error("msvcp60:_Getctype: allocation failed (bad_alloc dispatch unavailable)");
        try {
            vc6WriteBytes(table, copy);
            // _Getctype pairs the LC_COLLATE handle with the LC_CTYPE code page
            // (Wine's msvcp60 behavior, cited as observed; not checked against a native DLL).
            const result = new Uint8Array(16), view = new DataView(result.buffer);
            view.setUint32(0, current.collateHandle, true);
            view.setUint32(4, current.ctypeCodePage, true);
            view.setUint32(8, table, true);
            view.setUint32(12, 1, true); // Caller owns table and must delete it.
            vc6WriteBytes(destination, result);
        } catch (error) {
            host.free(table);
            throw error;
        }
        return destination;
    };
    exports["_Tolower"] = (_ctx, _mem, args) => {
        requireC("_Tolower", args[1] ?? 0);
        const ch = args[0]! | 0;
        return ch >= 0x41 && ch <= 0x5a ? ch + 0x20 : ch;
    };
    exports["_Toupper"] = (_ctx, _mem, args) => {
        requireC("_Toupper", args[1] ?? 0);
        const ch = args[0]! | 0;
        return ch >= 0x61 && ch <= 0x7a ? ch - 0x20 : ch;
    };
    exports["_Mbrtowc"] = (_ctx, _mem, args) => {
        const [out, input, count, state, vector] = args;
        // VC6's helper returns zero for an empty range without accessing input/state.
        if (!count) return 0;
        requireC("_Mbrtowc", vector ?? 0);
        const ch = bytes(input! >>> 0, 1)[0]!;
        if (out) vc6WriteBytes(out, new Uint8Array([ch, 0]));
        if (state) vc6WriteU32(state, 0);
        return ch === 0 ? 0 : 1;
    };
    exports["_Wcrtomb"] = (_ctx, _mem, args) => {
        requireC("_Wcrtomb", args[3] ?? 0);
        const ch = args[1]! & 0xffff;
        if (ch > 0xff) {
            host.setErrno(42); // MSVC EILSEQ
            return -1;
        }
        vc6WriteBytes(args[0]! >>> 0, new Uint8Array([ch]));
        return 1;
    };
    exports["btowc"] = (_ctx, _mem, args) => {
        requireC("btowc", 0);
        const ch = args[0]! | 0;
        // VC6 implements this via _Mbrtowc and accepts only a return count of one.
        return ch === -1 || (ch & 0xff) === 0 ? 0xffff : ch & 0xff;
    };
    exports["wctob"] = (_ctx, _mem, args) => {
        requireC("wctob", 0);
        const ch = args[0]! & 0xffff;
        if (ch === 0xffff) return -1;
        if (ch > 0xff) { host.setErrno(42); return -1; }
        // VC6 promotes a signed char from its one-byte conversion buffer.
        return (ch << 24) >> 24;
    };
    exports["_Strcoll"] = (_ctx, _mem, args) => {
        requireC("_Strcoll", args[4] ?? 0, true);
        const leftLength = rangeLength(args[0]!, args[1]!);
        const rightLength = rangeLength(args[2]!, args[3]!);
        const left = bytes(args[0]!, leftLength);
        const right = bytes(args[2]!, rightLength);
        for (let i = 0, end = Math.min(leftLength, rightLength); i < end; i++) {
            if (left[i] !== right[i]) return left[i]! - right[i]!;
        }
        return leftLength < rightLength ? -1 : leftLength > rightLength ? 1 : 0;
    };
    exports["_Strxfrm"] = (_ctx, _mem, args) => {
        requireC("_Strxfrm", args[4] ?? 0, true);
        const capacity = rangeLength(args[0]!, args[1]!);
        const length = rangeLength(args[2]!, args[3]!);
        if (length <= capacity && length > 0) {
            vc6WriteBytes(args[0]!, new Uint8Array(bytes(args[2]!, length)));
        }
        return length;
    };
}
