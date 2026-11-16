import { Mem } from "../core/memory/mem-accessor";
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";

export function registerCrtWideIntegerExports(
    exports: Record<string, ThunkImplementation>,
    host: { setErrno(code: number): void },
): void {
    const convert = (secure: boolean): ThunkImplementation => (_ctx, _mem, args) => {
        const value = (args[0] ?? 0) | 0;
        const dst = (args[1] ?? 0) >>> 0;
        const size = secure ? (args[2] ?? 0) >>> 0 : 0;
        const radix = (args[secure ? 3 : 2] ?? 0) | 0;
        if (!dst || (secure && size === 0)) {
            host.setErrno(22);
            return secure ? 22 : 0;
        }
        if (radix < 2 || radix > 36) {
            Mem.writeUint16(dst, 0);
            host.setErrno(22);
            return secure ? 22 : 0;
        }
        // Windows long is 32-bit; only decimal formats a negative value with a sign.
        const text = (radix === 10 ? value : value >>> 0).toString(radix);
        if (secure && text.length >= size) {
            Mem.writeUint16(dst, 0);
            host.setErrno(34);
            return 34;
        }
        for (let i = 0; i < text.length; i++) Mem.writeUint16(dst + i * 2, text.charCodeAt(i));
        Mem.writeUint16(dst + text.length * 2, 0);
        return secure ? 0 : dst;
    };
    exports["_ltow"] = convert(false);
    exports["_ltow_s"] = convert(true);
}
