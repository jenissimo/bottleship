/**
 * CRT time/date functions (time, _ftime, difftime, gmtime, mktime, _strdate,
 * _strtime and the wide variants).
 *
 * Coupling to Msvcrt is only via CrtTimeHost: v86 handle (difftime returns via
 * the FPU), process allocator (gmtime's static struct-tm scratch), and the
 * string/word writers. The scratch buffers are module statics, reset with the
 * process (resetCrtTimeStatics). These CRT entry points are wall-clock
 * (Date.now()/new Date()).
 */

import { Mem } from "../core/memory/mem-accessor";
import { fpuPush } from "../core/fpu-helper";
import { TimeService } from "../runtime/time";
import { System } from "../core/system";
import { WAIT_BLOCKED_NO_SWITCH } from "../core/scheduler/types";
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import type { Process } from "../core/process";

export interface CrtTimeHost {
    process: Process;
    writeUint16(addr: number, value: number): void;
    writeCString(ptr: number, value: string): void;
    writeWString(ptr: number, value: string, maxChars?: number): void;
}

const WDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * asctime's fixed 26-character form: "Www Mmm dd hh:mm:ss yyyy\n\0". The
 * weekday is part of it — callers that parse the result by COLUMN read garbage
 * without it, and ctime is specified as asctime(localtime(t)).
 */
export function formatAsctime(
    wday: number,
    mon: number,
    mday: number,
    hour: number,
    min: number,
    sec: number,
    year: number,
): string {
    const hh = String(hour).padStart(2, "0");
    const mm = String(min).padStart(2, "0");
    const ss = String(sec).padStart(2, "0");
    return `${WDAY_NAMES[wday] ?? "???"} ${MONTH_NAMES[mon] ?? "???"} ${String(mday).padStart(2, " ")} ${hh}:${mm}:${ss} ${year}\n`;
}

/**
 * The CRT's static scratch buffers (the struct tm gmtime/localtime return, the string
 * ctime returns). They live in guest memory that Process.reset() rewinds, so they must
 * be forgotten with it — a kept address would have the next process's ctime write into
 * whatever now owns those bytes. Cleared via resetCrtTimeStatics from msvcrt's
 * reregisterExports, since registration itself does not run again.
 */
let gmtimeBuf = 0;
let localtimeBuf = 0;
let ctimeBuf = 0;

export function resetCrtTimeStatics(): void {
    gmtimeBuf = 0;
    localtimeBuf = 0;
    ctimeBuf = 0;
}

export function registerCrtTimeExports(exports: Record<string, ThunkImplementation>, host: CrtTimeHost): void {
    exports["time"] = (_c, _m, a) => {
        const ptr = a[0] ?? 0;
        const seconds = Math.floor(Date.now() / 1000) >>> 0;
        if (ptr) Mem.writeUint32(ptr, seconds);
        return seconds;
    };

    // clock() — processor-time ticks (Windows: ms, CLOCKS_PER_SEC=1000).
    // Must advance with guest virtual time (same source as GetTickCount).
    exports["clock"] = () => TimeService.getInstance().nowMs() | 0;

    // _sleep(duration) — the CRT's alias for Sleep, and its argument is MILLISECONDS
    // (msvcrt.spec: `cdecl _sleep(long)`; the CRT maps 0 to 1 so it always yields).
    // cdecl, so the caller pops the argument: the resume ESP pops the return address only.
    exports["_sleep"] = (ctx, mem, a) => {
        const ms = ((a[0] ?? 0) >>> 0) || 1;
        const sched = System.getInstance().scheduler;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const returnAddr = view.getUint32(ctx.esp, true);
        const blocked = sched.sleepWithContext(
            ms,
            returnAddr,
            ctx.esp + 4,
            { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags },
        );
        if (blocked === WAIT_BLOCKED_NO_SWITCH) {
            return { value: 0, blockedNoSwitch: true };
        }
        return 0;
    };

    exports["_ftime"] = (_c, _m, a) => {
        const ptr = a[0] ?? 0;
        if (!ptr) return 0;
        const now = Date.now();
        const seconds = Math.floor(now / 1000) >>> 0;
        const millis = now % 1000;
        Mem.writeUint32(ptr, seconds);
        host.writeUint16(ptr + 4, millis);
        host.writeUint16(ptr + 6, 0);
        host.writeUint16(ptr + 8, 0);
        return 0;
    };

    exports["difftime"] = (_c, _m, a) => {
        // Win32 time_t is 32-bit; difftime(time_t t1, time_t t0) — the first two
        // u32 args are the two time_t values (not halves of one double).
        const t1 = (a[0] ?? 0) >>> 0;
        const t0 = (a[1] ?? 0) >>> 0;
        fpuPush(host.process.v86, t1 - t0);
        return 0;
    };

    exports["localtime"] = (_c, _m, a) => {
        const timePtr = a[0] ?? 0;
        if (!timePtr) return 0;
        const seconds = Mem.readUint32(timePtr) ?? 0;
        const date = new Date(seconds * 1000);
        if (!localtimeBuf) {
            localtimeBuf = host.process.memory.alloc(36, "THUNK_DATA", "rw");
        }
        const buf = localtimeBuf;
        Mem.writeUint32(buf + 0, date.getSeconds());
        Mem.writeUint32(buf + 4, date.getMinutes());
        Mem.writeUint32(buf + 8, date.getHours());
        Mem.writeUint32(buf + 12, date.getDate());
        Mem.writeUint32(buf + 16, date.getMonth());
        Mem.writeUint32(buf + 20, date.getFullYear() - 1900);
        Mem.writeUint32(buf + 24, date.getDay());
        const start = new Date(date.getFullYear(), 0, 1);
        const yday = Math.floor((date.getTime() - start.getTime()) / 86400000);
        Mem.writeUint32(buf + 28, yday);
        Mem.writeUint32(buf + 32, 0);
        return buf >>> 0;
    };

    // ctime's scratch is NOT the localtime struct-tm buffer: ctime is
    // asctime(localtime(t)), so one shared buffer would have the text overwrite the
    // tm it was formatted from.
    exports["ctime"] = (_c, _m, a) => {
        const timePtr = a[0] ?? 0;
        if (!timePtr) return 0;
        const seconds = Mem.readUint32(timePtr) ?? 0;
        const date = new Date(seconds * 1000);
        if (Number.isNaN(date.getTime())) return 0;
        if (!ctimeBuf) ctimeBuf = host.process.memory.alloc(32, "THUNK_DATA", "rw");
        host.writeCString(
            ctimeBuf,
            formatAsctime(date.getDay(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getFullYear()),
        );
        return ctimeBuf >>> 0;
    };

    exports["gmtime"] = (_c, _m, a) => {
        const timePtr = a[0] ?? 0;
        if (!timePtr) return 0;
        const seconds = Mem.readUint32(timePtr) ?? 0;
        const date = new Date(seconds * 1000);
        if (!gmtimeBuf) {
            gmtimeBuf = host.process.memory.alloc(36, "THUNK_DATA", "rw");
        }
        const buf = gmtimeBuf;
        // struct tm: sec, min, hour, mday, mon, year, wday, yday, isdst
        Mem.writeUint32(buf + 0, date.getUTCSeconds());
        Mem.writeUint32(buf + 4, date.getUTCMinutes());
        Mem.writeUint32(buf + 8, date.getUTCHours());
        Mem.writeUint32(buf + 12, date.getUTCDate());
        Mem.writeUint32(buf + 16, date.getUTCMonth());
        Mem.writeUint32(buf + 20, date.getUTCFullYear() - 1900);
        Mem.writeUint32(buf + 24, date.getUTCDay());
        const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
        const yday = Math.floor((date.getTime() - start.getTime()) / 86400000);
        Mem.writeUint32(buf + 28, yday);
        Mem.writeUint32(buf + 32, 0); // isdst
        return buf >>> 0;
    };

    exports["mktime"] = (_c, _m, a) => {
        const tmPtr = a[0] ?? 0;
        if (!tmPtr) return -1;
        const sec = Mem.readUint32(tmPtr + 0) ?? 0;
        const min = Mem.readUint32(tmPtr + 4) ?? 0;
        const hour = Mem.readUint32(tmPtr + 8) ?? 0;
        const mday = Mem.readUint32(tmPtr + 12) ?? 0;
        const mon = Mem.readUint32(tmPtr + 16) ?? 0;
        const year = (Mem.readUint32(tmPtr + 20) ?? 0) + 1900;
        const date = new Date(year, mon, mday, hour, min, sec);
        return (Math.floor(date.getTime() / 1000)) >>> 0;
    };

    exports["_strdate"] = (_c, _m, a) => {
        const buffer = a[0] ?? 0;
        if (!buffer) return 0;
        const now = new Date();
        const mm = String(now.getMonth() + 1).padStart(2, "0");
        const dd = String(now.getDate()).padStart(2, "0");
        const yy = String(now.getFullYear() % 100).padStart(2, "0");
        host.writeCString(buffer, `${mm}/${dd}/${yy}`);
        return buffer >>> 0;
    };

    exports["_strtime"] = (_c, _m, a) => {
        const buffer = a[0] ?? 0;
        if (!buffer) return 0;
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, "0");
        const mm = String(now.getMinutes()).padStart(2, "0");
        const ss = String(now.getSeconds()).padStart(2, "0");
        host.writeCString(buffer, `${hh}:${mm}:${ss}`);
        return buffer >>> 0;
    };

    exports["_wstrdate"] = (_c, _m, a) => {
        const buffer = a[0] ?? 0;
        if (!buffer) return 0;
        const now = new Date();
        const mm = String(now.getMonth() + 1).padStart(2, "0");
        const dd = String(now.getDate()).padStart(2, "0");
        const yy = String(now.getFullYear() % 100).padStart(2, "0");
        host.writeWString(buffer, `${mm}/${dd}/${yy}`);
        return buffer >>> 0;
    };

    exports["_wstrtime"] = (_c, _m, a) => {
        const buffer = a[0] ?? 0;
        if (!buffer) return 0;
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, "0");
        const mm = String(now.getMinutes()).padStart(2, "0");
        const ss = String(now.getSeconds()).padStart(2, "0");
        host.writeWString(buffer, `${hh}:${mm}:${ss}`);
        return buffer >>> 0;
    };
}
