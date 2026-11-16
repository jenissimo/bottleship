import { Mem } from "../core/memory/mem-accessor";
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";

function putUnit(address: number, value: number): void {
    if (!Mem.writeUint16(address, value)) throw new Error("CRT wide copies: invalid guest write");
}

const EINVAL = 22;
const ERANGE = 34;
const STRUNCATE = 80;
const TRUNCATE = 0xffffffff;

export function registerCrtWideCopyExports(
    exports: Record<string, ThunkImplementation>,
    host: { setErrno(code: number): void },
): void {
    const fail = (dst: number, size: number, code: number): number => {
        if (dst && size) putUnit(dst, 0);
        host.setErrno(code);
        return code;
    };
    const copy = (append: boolean, counted: boolean): ThunkImplementation => (_c, _m, a) => {
        const dst = (a[0] ?? 0) >>> 0;
        const size = (a[1] ?? 0) >>> 0;
        const src = (a[2] ?? 0) >>> 0;
        const count = counted ? (a[3] ?? 0) >>> 0 : TRUNCATE;
        if (counted && count === 0 && dst === 0 && size === 0) return 0;
        if (!dst || size === 0) { host.setErrno(EINVAL); return EINVAL; }
        let used = 0;
        if (append) {
            while (used < size) {
                const ch = Mem.readUint16(dst + used * 2);
                if (ch === null) return fail(dst, size, EINVAL);
                if (ch === 0) break;
                used++;
            }
            if (used === size) return fail(dst, size, EINVAL);
        }
        if (counted && count === 0) { putUnit(dst + used * 2, 0); return 0; }
        if (!src) return fail(dst, size, EINVAL);
        const room = size - used - 1;
        let n = 0;
        // Read only the source prefix needed to decide whether it fits; no arbitrary string cap.
        while (n < count) {
            const ch = Mem.readUint16(src + n * 2);
            if (ch === null) return fail(dst, size, EINVAL);
            if (ch === 0) break;
            if (n === room) {
                if (!counted || count !== TRUNCATE) return fail(dst, size, ERANGE);
                putUnit(dst + (used + n) * 2, 0);
                return STRUNCATE;
            }
            putUnit(dst + (used + n) * 2, ch);
            n++;
        }
        putUnit(dst + (used + n) * 2, 0);
        return 0;
    };
    exports["wcscpy_s"] = copy(false, false);
    exports["wcscat_s"] = copy(true, false);
    exports["wcsncpy_s"] = copy(false, true);
    exports["wcsncat_s"] = copy(true, true);
}
