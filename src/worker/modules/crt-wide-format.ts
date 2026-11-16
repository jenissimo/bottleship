import { Mem } from "../core/memory/mem-accessor";
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";

interface WideFormatHost {
    format(format: number, args: number[], first: number): string;
    setErrno(code: number): void;
}

export function registerCrtWideFormatExports(exports: Record<string, ThunkImplementation>, host: WideFormatHost): void {
    const format = (counted: boolean): ThunkImplementation => (_c, _m, a) => {
        const dst = (a[0] ?? 0) >>> 0;
        const size = (a[1] ?? 0) >>> 0;
        const count = counted ? (a[2] ?? 0) >>> 0 : size;
        const fmt = (a[counted ? 3 : 2] ?? 0) >>> 0;
        if (counted && !dst && !size && !count) return 0;
        if (!dst || !size || !fmt) { host.setErrno(22); return -1; }
        const text = host.format(fmt, a, counted ? 4 : 3);
        const limit = counted && count < size ? count : size - 1;
        if (text.length > limit && (!counted || (count !== 0xffffffff && count >= size))) {
            Mem.writeUint16(dst, 0);
            host.setErrno(34);
            return -1;
        }
        const length = Math.min(text.length, limit);
        for (let i = 0; i < length; i++) Mem.writeUint16(dst + i * 2, text.charCodeAt(i));
        Mem.writeUint16(dst + length * 2, 0);
        return text.length > limit ? -1 : length;
    };
    exports["swprintf_s"] = format(false);
    exports["_snwprintf_s"] = format(true);
}
