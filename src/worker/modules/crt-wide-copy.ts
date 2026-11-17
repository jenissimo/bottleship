import {readCrtUint16, writeCrtUint16, crtFaultAddress} from "./crt-guest-access";
import { raiseGuestAccessViolation } from "../core/thunking/guest-fault";
import type { ThunkResult, ThunkImplementation } from "../core/thunking/thunk-dispatcher";

const EINVAL = 22;
const ERANGE = 34;
const STRUNCATE = 80;
const TRUNCATE = 0xffffffff;

export function registerCrtWideCopyExports(
    exports: Record<string, ThunkImplementation>,
    host: { setErrno(code: number): void },
): void {
    const fail = (ctx: {esp: number}, mem: Uint8Array, dst: number, size: number, code: number): number | ThunkResult => {
        if (dst && size && !writeCrtUint16(dst, 0)) return raiseGuestAccessViolation(ctx, mem, crtFaultAddress(dst, 2, "w"), "w", 0);
        host.setErrno(code);
        return code;
    };
    const copy = (append: boolean, counted: boolean): ThunkImplementation => (ctx, mem, a) => {
        const dst = (a[0] ?? 0) >>> 0;
        const size = (a[1] ?? 0) >>> 0;
        const src = (a[2] ?? 0) >>> 0;
        const count = counted ? (a[3] ?? 0) >>> 0 : TRUNCATE;
        if (counted && count === 0 && dst === 0 && size === 0) return 0;
        if (!dst || size === 0) { host.setErrno(EINVAL); return EINVAL; }
        let used = 0;
        if (append) {
            while (used < size) {
                const ch = readCrtUint16(dst + used * 2);
                if (ch === null) return raiseGuestAccessViolation(ctx, mem, crtFaultAddress(dst + used * 2, 2, "r"), "r", 0);
                if (ch === 0) break;
                used++;
            }
            if (used === size) return fail(ctx, mem, dst, size, EINVAL);
        }
        if (counted && count === 0) {
            if (!writeCrtUint16(dst + used * 2, 0)) return raiseGuestAccessViolation(ctx, mem, crtFaultAddress(dst + used * 2, 2, "w"), "w", 0);
            return 0;
        }
        if (!src) return fail(ctx, mem, dst, size, EINVAL);
        const room = size - used - 1;
        let n = 0;
        // Read only the source prefix needed to decide whether it fits; no arbitrary string cap.
        while (n < count) {
            const ch = readCrtUint16(src + n * 2);
            if (ch === null) return raiseGuestAccessViolation(ctx, mem, crtFaultAddress(src + n * 2, 2, "r"), "r", 0);
            if (ch === 0) break;
            if (n === room) {
                if (!counted || count !== TRUNCATE) return fail(ctx, mem, dst, size, ERANGE);
                if (!writeCrtUint16(dst + (used + n) * 2, 0)) return raiseGuestAccessViolation(ctx, mem, crtFaultAddress(dst + (used + n) * 2, 2, "w"), "w", 0);
                return STRUNCATE;
            }
            if (!writeCrtUint16(dst + (used + n) * 2, ch)) return raiseGuestAccessViolation(ctx, mem, crtFaultAddress(dst + (used + n) * 2, 2, "w"), "w", 0);
            n++;
        }
        if (!writeCrtUint16(dst + (used + n) * 2, 0)) return raiseGuestAccessViolation(ctx, mem, crtFaultAddress(dst + (used + n) * 2, 2, "w"), "w", 0);
        return 0;
    };
    exports["wcscpy_s"] = copy(false, false);
    exports["wcscat_s"] = copy(true, false);
    exports["wcsncpy_s"] = copy(false, true);
    exports["wcsncat_s"] = copy(true, true);
}
