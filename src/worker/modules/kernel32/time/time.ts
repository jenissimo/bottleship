// Time-related functions for kernel32
// GetTickCount, GetSystemTimeAsFileTime, QueryPerformanceCounter, QueryPerformanceFrequency

import { ThunkImplementation, FastPathImplementation } from '../../../core/thunking/thunk-dispatcher';
import { TimeService } from '../../../runtime/time';
import { Logger, LogCategory } from '../../../core/logger';
import { System } from '../../../core/system';
import { Mem } from '../../../core/memory/mem-accessor';
import { WAIT_BLOCKED_NO_SWITCH, WAIT_IO_COMPLETION } from '../../../core/scheduler/types';
import { encodeAnsi } from '../../codepage-utils';
import { deliverPendingApcs } from '../sync';


export const exports: Record<string, ThunkImplementation> = {};
let lastSleepLog = 0;
let sleepCallCount = 0;
let lastSleepMs = 0;
// Sleep is the top thunk in spin-yield titles, and "how many" is useless without
// "of what": a Sleep(0) yield and a Sleep(2) block are different bugs, and the
// last-value-seen the line used to print names neither.
const sleepArgHist = { zero: 0, one: 0, two: 0, more: 0 };
let lastSleepExApcDepth = -1;
let sleepExStormUnchangedTicks = 0;
let lastSleepExStormWarnMs = 0;

/**
 * Register fast path implementations for high-frequency time functions
 */
export function registerFastPathTimeFunctions(dispatcher: any): void {
    if (dispatcher && typeof dispatcher.registerFastPath === 'function') {
        dispatcher.registerFastPath('kernel32', 'GetTickCount', TimeService.fastPathGetTickCount);
        dispatcher.registerFastPath('winmm', 'timeGetTime', TimeService.fastPathGetTickCount);
        dispatcher.registerFastPath('kernel32', 'QueryPerformanceCounter', TimeService.fastPathQueryPerformanceCounter);
        dispatcher.registerFastPath('kernel32', 'QueryPerformanceFrequency', TimeService.fastPathQueryPerformanceFrequency);

        // Sleep(0) fast path: skip full thunk when no context switch is needed.
        // D2 calls Sleep(0) ~600K times in 20s. When no other thread is runnable,
        // this is a pure no-op — avoid UD2 trap → JS marshal → scheduler round-trip.
        const fastPathSleep: FastPathImplementation = (
            cpu: any, _mem8: Uint8Array, _mem32: Uint32Array, dataView: DataView
        ): number | null => {
            const esp = cpu.reg32[4]; // ESP
            const dwMilliseconds = dataView.getUint32(esp + 4, true);

            if (dwMilliseconds === 0) {
                const sched = System.getInstance().scheduler;
                if (!sched.hasOtherRunnableThreads(sched.getCurrentThreadId())) {
                    return 0; // No-op: no peer to yield to
                }
            }

            // Non-zero sleep or actual peers to yield to → full thunk
            return null;
        };
        dispatcher.registerFastPath('kernel32', 'Sleep', fastPathSleep);

        Logger.log(LogCategory.KERNEL32, 'Registered fast path for time functions');
    }
}

function initTimeFunctions(): void {
    exports['GetTickCount'] = (ctx, mem, args): number => {
        return TimeService.getInstance().nowMs() | 0;
    };

    const writeSystemTimeAsFileTime = (mem: Uint8Array, lpSystemTimeAsFileTime: number): void => {
        const now = BigInt(TimeService.getInstance().nowUnixMs());
        // Windows FILETIME is 100ns intervals since Jan 1 1601.
        // Unix epoch is 11644473600 seconds after Windows epoch.
        const windowsTicks = (now + 11644473600000n) * 10000n;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setBigUint64(lpSystemTimeAsFileTime, windowsTicks, true);
    };

    exports['GetSystemTimeAsFileTime'] = (ctx, mem, args) => {
        writeSystemTimeAsFileTime(mem, args[0]);
        return { value: 0, stackCleanup: 4 };
    };

    exports['GetSystemTimePreciseAsFileTime'] = (ctx, mem, args) => {
        writeSystemTimeAsFileTime(mem, args[0]);
        return { value: 0, stackCleanup: 4 };
    };

    exports['GetTimeZoneInformation'] = (ctx, mem, args) => {
        const lpTimeZoneInformation = args[0];
        const ERROR_INVALID_PARAMETER = 87;
        const TIME_ZONE_ID_UNKNOWN = 0;
        const TIME_ZONE_ID_INVALID = 0xFFFFFFFF;

        if (!lpTimeZoneInformation || lpTimeZoneInformation + 172 > mem.length) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return TIME_ZONE_ID_INVALID;
        }

        // TIME_ZONE_INFORMATION layout (Win32):
        // LONG Bias; WCHAR StandardName[32]; SYSTEMTIME StandardDate; LONG StandardBias;
        // WCHAR DaylightName[32]; SYSTEMTIME DaylightDate; LONG DaylightBias;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const bias = new Date().getTimezoneOffset(); // minutes: UTC - local

        // Zero entire struct
        mem.fill(0, lpTimeZoneInformation, lpTimeZoneInformation + 172);

        view.setInt32(lpTimeZoneInformation + 0, bias, true); // Bias
        view.setInt32(lpTimeZoneInformation + 88, 0, true);   // StandardBias
        view.setInt32(lpTimeZoneInformation + 168, 0, true);  // DaylightBias

        return TIME_ZONE_ID_UNKNOWN;
    };

    exports['GetSystemTime'] = (ctx, mem, args) => {
        const lpSystemTime = args[0];
        if (!lpSystemTime) {
            return { value: 0, stackCleanup: 4 };
        }

        const now = new Date();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        // GetSystemTime returns UTC
        view.setUint16(lpSystemTime + 0,  now.getUTCFullYear(), true);
        view.setUint16(lpSystemTime + 2,  now.getUTCMonth() + 1, true);
        view.setUint16(lpSystemTime + 4,  now.getUTCDay(), true);
        view.setUint16(lpSystemTime + 6,  now.getUTCDate(), true);
        view.setUint16(lpSystemTime + 8,  now.getUTCHours(), true);
        view.setUint16(lpSystemTime + 10, now.getUTCMinutes(), true);
        view.setUint16(lpSystemTime + 12, now.getUTCSeconds(), true);
        view.setUint16(lpSystemTime + 14, now.getUTCMilliseconds(), true);

        return { value: 0, stackCleanup: 4 };
    };

    exports['GetLocalTime'] = (ctx, mem, args) => {
        const lpSystemTime = args[0];
        if (!lpSystemTime) {
            return { value: 0, stackCleanup: 4 };
        }

        const now = new Date();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        view.setUint16(lpSystemTime + 0,  now.getFullYear(), true);
        view.setUint16(lpSystemTime + 2,  now.getMonth() + 1, true);  // JS 0-11 -> Win 1-12
        view.setUint16(lpSystemTime + 4,  now.getDay(), true);        // 0=Sun
        view.setUint16(lpSystemTime + 6,  now.getDate(), true);
        view.setUint16(lpSystemTime + 8,  now.getHours(), true);
        view.setUint16(lpSystemTime + 10, now.getMinutes(), true);
        view.setUint16(lpSystemTime + 12, now.getSeconds(), true);
        view.setUint16(lpSystemTime + 14, now.getMilliseconds(), true);

        return { value: 0, stackCleanup: 4 };
    };

    exports['SetLocalTime'] = (ctx, mem, args) => {
        Logger.warn(LogCategory.KERNEL32, 'SetLocalTime: ignored (sandboxed)');
        return { value: 1, stackCleanup: 4 };
    };

    exports['QueryPerformanceCounter'] = (ctx, mem, args) => {
        const lpPerformanceCount = args[0];
        if (lpPerformanceCount !== 0) {
            const now = BigInt(TimeService.getInstance().nowMicros());
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setBigUint64(lpPerformanceCount, now, true);
        }
        return { value: 1, stackCleanup: 4 };
    };

    exports['QueryPerformanceFrequency'] = (ctx, mem, args) => {
        const lpFrequency = args[0];
        if (lpFrequency !== 0) {
            const freq = BigInt(1000000);
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setBigUint64(lpFrequency, freq, true);
        }
        return { value: 1, stackCleanup: 4 };
    };

    exports['Sleep'] = (ctx, mem, args) => {
        const dwMilliseconds = args[0] >>> 0;
        const now = performance.now();
        sleepCallCount += 1;
        lastSleepMs = dwMilliseconds;
        if (dwMilliseconds === 0) sleepArgHist.zero++;
        else if (dwMilliseconds === 1) sleepArgHist.one++;
        else if (dwMilliseconds === 2) sleepArgHist.two++;
        else sleepArgHist.more++;
        if (now - lastSleepLog >= 1000) {
            Logger.log(
                LogCategory.KERNEL32,
                `Sleep: calls=${sleepCallCount} lastMs=${lastSleepMs} ` +
                `ms0=${sleepArgHist.zero} ms1=${sleepArgHist.one} ms2=${sleepArgHist.two} ms3+=${sleepArgHist.more}`
            );
            lastSleepLog = now;
            sleepCallCount = 0;
            sleepArgHist.zero = sleepArgHist.one = sleepArgHist.two = sleepArgHist.more = 0;
        }

        const sched = System.getInstance().scheduler;
        // Let sleepWithContext handle the runnable-thread check internally

        // Read return address from stack
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const returnAddr = view.getUint32(ctx.esp, true);
        const postReturnEsp = ctx.esp + 8;  // Sleep: 4 (ret addr) + 4 (1 arg)

        if (returnAddr < 0x100000 || returnAddr >= 0x80000000) {
            Logger.error(LogCategory.KERNEL32,
                `Sleep: BAD returnAddr=0x${returnAddr.toString(16)} ESP=0x${ctx.esp.toString(16)} — skipping block`);
            return 0;
        }

        // Cache the current thread id before sleepWithContext (which may switch threads).
        const sleepThreadId = sched.getCurrentThreadId();

        const sleepResult = sched.sleepWithContext(
            dwMilliseconds,
            returnAddr,
            postReturnEsp,
            { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags }
        );
        if (dwMilliseconds === 0 && sched.hasOtherRunnableThreads(sleepThreadId)) {
            sched.requestSwitch();
        }
        if (sleepResult === WAIT_BLOCKED_NO_SWITCH) {
            return { value: 0, blockedNoSwitch: true, stackCleanup: 4 };
        }
        return 0;
    };

    exports['SleepEx'] = (ctx, mem, args) => {
        const dwMilliseconds = args[0] >>> 0;
        const bAlertable = args[1] !== 0;
        const system = System.getInstance();
        const sched = system.scheduler;
        const now = performance.now();
        sleepCallCount += 1;
        lastSleepMs = dwMilliseconds;
        if (now - lastSleepLog >= 1000) {
            const apcDepth = sched.getApcTelemetry?.().pendingApcTotal ?? 0;
            if (bAlertable && sleepCallCount >= 20000) {
                if (apcDepth === lastSleepExApcDepth) {
                    sleepExStormUnchangedTicks++;
                } else {
                    sleepExStormUnchangedTicks = 0;
                }
                if (sleepExStormUnchangedTicks >= 2 && (now - lastSleepExStormWarnMs) >= 2000) {
                    lastSleepExStormWarnMs = now;
                    Logger.warn(
                        LogCategory.KERNEL32,
                        `SleepEx storm: calls=${sleepCallCount}/s alertable=1 apcDepth=${apcDepth} (no APC progress)`
                    );
                }
            }
            lastSleepExApcDepth = apcDepth;
            Logger.log(
                LogCategory.KERNEL32,
                `SleepEx: calls=${sleepCallCount} lastMs=${lastSleepMs} alertable=${bAlertable ? 1 : 0}`
            );
            lastSleepLog = now;
            sleepCallCount = 0;
        }

        if (bAlertable) {
            const apcResult = deliverPendingApcs(ctx, 'SleepEx:APC', 8);
            if (apcResult) return apcResult;
        }

        // Use post-return context path (same model as Sleep) because SleepEx is called from thunk code.
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const returnAddr = view.getUint32(ctx.esp, true);
        const postReturnEsp = ctx.esp + 12;  // SleepEx: 4 (ret addr) + 8 (2 args)

        const sleepExResult = sched.sleepWithContext(
            dwMilliseconds,
            returnAddr,
            postReturnEsp,
            { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags },
            bAlertable
        );
        if (dwMilliseconds === 0 && sched.hasOtherRunnableThreads(sched.getCurrentThreadId())) {
            sched.requestSwitch();
        }
        if (sleepExResult === WAIT_BLOCKED_NO_SWITCH) {
            return { value: 0, blockedNoSwitch: true, stackCleanup: 8 };
        }
        if (sleepExResult === WAIT_IO_COMPLETION) {
            return WAIT_IO_COMPLETION;
        }
        return 0;
    };

    exports['CompareFileTime'] = (ctx, mem, args) => {
        const lpFileTime1 = args[0];
        const lpFileTime2 = args[1];

        if (!lpFileTime1 || !lpFileTime2) {
            Logger.warn(LogCategory.KERNEL32, 'CompareFileTime: NULL pointer');
            return 0;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        // Read 64-bit FILETIME values (little-endian)
        const time1 = view.getBigUint64(lpFileTime1, true);
        const time2 = view.getBigUint64(lpFileTime2, true);

        Logger.verbose(LogCategory.KERNEL32,
            `CompareFileTime: time1=${time1} time2=${time2}`);

        // Compare and return: -1 if time1 < time2, 0 if equal, 1 if time1 > time2
        if (time1 < time2) {
            return -1;
        } else if (time1 > time2) {
            return 1;
        } else {
            return 0;
        }
    };

    // GetDateFormatA - format date as string
    exports['GetDateFormatA'] = (ctx, mem, args) => {
        const locale = args[0];
        const dwFlags = args[1];
        const lpDate = args[2];      // SYSTEMTIME* or NULL for current
        const lpFormat = args[3];    // format string or NULL for default
        const lpDateStr = args[4];   // output buffer
        const cchDate = args[5];     // buffer size

        const now = lpDate ? readSystemTime(mem, lpDate) : new Date();

        // Simple default format: MM/dd/yyyy
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const year = now.getFullYear();
        const dateStr = `${month}/${day}/${year}`;

        if (cchDate === 0) {
            // Return required buffer size
            return dateStr.length + 1;
        }

        if (lpDateStr && cchDate > 0) {
            const bytes = encodeAnsi(dateStr + '\0');
            const toWrite = bytes.subarray(0, Math.min(bytes.length, cchDate));
            Mem.writeBytes(lpDateStr, toWrite);
            return toWrite.length - 1; // exclude null terminator from count
        }

        return 0;
    };

    exports['GetDateFormatW'] = (ctx, mem, args) => {
        const locale = args[0];
        const dwFlags = args[1];
        const lpDate = args[2];
        const lpFormat = args[3];
        const lpDateStr = args[4];
        const cchDate = args[5];

        const now = lpDate ? readSystemTime(mem, lpDate) : new Date();

        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const year = now.getFullYear();
        const dateStr = `${month}/${day}/${year}`;

        if (cchDate === 0) {
            return dateStr.length + 1;
        }

        if (lpDateStr && cchDate > 0) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const len = Math.min(dateStr.length, cchDate - 1);
            for (let i = 0; i < len; i++) {
                view.setUint16(lpDateStr + i * 2, dateStr.charCodeAt(i), true);
            }
            view.setUint16(lpDateStr + len * 2, 0, true); // null terminator
            return len;
        }

        return 0;
    };

    // GetTimeFormatA - format time as string
    exports['GetTimeFormatA'] = (ctx, mem, args) => {
        const locale = args[0];
        const dwFlags = args[1];
        const lpTime = args[2];      // SYSTEMTIME* or NULL for current
        const lpFormat = args[3];    // format string or NULL for default
        const lpTimeStr = args[4];   // output buffer
        const cchTime = args[5];     // buffer size

        const now = lpTime ? readSystemTime(mem, lpTime) : new Date();

        // Simple default format: HH:mm:ss
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const timeStr = `${hours}:${minutes}:${seconds}`;

        if (cchTime === 0) {
            return timeStr.length + 1;
        }

        if (lpTimeStr && cchTime > 0) {
            const bytes = encodeAnsi(timeStr + '\0');
            const toWrite = bytes.subarray(0, Math.min(bytes.length, cchTime));
            Mem.writeBytes(lpTimeStr, toWrite);
            return toWrite.length - 1;
        }

        return 0;
    };

    exports['GetTimeFormatW'] = (ctx, mem, args) => {
        const locale = args[0];
        const dwFlags = args[1];
        const lpTime = args[2];
        const lpFormat = args[3];
        const lpTimeStr = args[4];
        const cchTime = args[5];

        const now = lpTime ? readSystemTime(mem, lpTime) : new Date();

        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const timeStr = `${hours}:${minutes}:${seconds}`;

        if (cchTime === 0) {
            return timeStr.length + 1;
        }

        if (lpTimeStr && cchTime > 0) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const len = Math.min(timeStr.length, cchTime - 1);
            for (let i = 0; i < len; i++) {
                view.setUint16(lpTimeStr + i * 2, timeStr.charCodeAt(i), true);
            }
            view.setUint16(lpTimeStr + len * 2, 0, true);
            return len;
        }

        return 0;
    };

    // BOOL GetFileTime(HANDLE hFile, LPFILETIME lpCreationTime, LPFILETIME lpLastAccessTime, LPFILETIME lpLastWriteTime)
    // Stub: reports a fixed epoch timestamp for all three fields so callers get valid output.
    exports['GetFileTime'] = (ctx, mem, args) => {
        const hFile = args[0];
        const lpCreationTime  = args[1] >>> 0;
        const lpLastAccessTime = args[2] >>> 0;
        const lpLastWriteTime  = args[3] >>> 0;

        Logger.verbose(LogCategory.KERNEL32,
            `GetFileTime(hFile=0x${hFile.toString(16)})`);

        // Use a fixed epoch: 2000-01-01 00:00:00 UTC
        const unixMs = BigInt(Date.UTC(2000, 0, 1));
        const windowsTicks = (unixMs + 11644473600000n) * 10000n;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (const ptr of [lpCreationTime, lpLastAccessTime, lpLastWriteTime]) {
            if (ptr && ptr + 8 <= mem.length) {
                view.setBigUint64(ptr, windowsTicks, true);
            }
        }

        return 1; // TRUE
    };

    // BOOL FileTimeToSystemTime(const FILETIME *lpFileTime, LPSYSTEMTIME lpSystemTime)
    exports['FileTimeToSystemTime'] = (ctx, mem, args) => {
        const lpFileTime   = args[0] >>> 0;
        const lpSystemTime = args[1] >>> 0;

        if (!lpFileTime || !lpSystemTime || lpFileTime + 8 > mem.length || lpSystemTime + 16 > mem.length) {
            return { value: 0, stackCleanup: 8 }; // FALSE
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const windowsTicks = view.getBigUint64(lpFileTime, true);
        // Convert 100ns Windows ticks → Unix ms
        const unixMs = Number((windowsTicks / 10000n) - 11644473600000n);
        const d = new Date(unixMs);

        view.setUint16(lpSystemTime +  0, d.getUTCFullYear(),        true); // wYear
        view.setUint16(lpSystemTime +  2, d.getUTCMonth() + 1,       true); // wMonth (1-based)
        view.setUint16(lpSystemTime +  4, d.getUTCDay(),             true); // wDayOfWeek
        view.setUint16(lpSystemTime +  6, d.getUTCDate(),            true); // wDay
        view.setUint16(lpSystemTime +  8, d.getUTCHours(),           true); // wHour
        view.setUint16(lpSystemTime + 10, d.getUTCMinutes(),         true); // wMinute
        view.setUint16(lpSystemTime + 12, d.getUTCSeconds(),         true); // wSecond
        view.setUint16(lpSystemTime + 14, d.getUTCMilliseconds(),    true); // wMilliseconds

        Logger.verbose(LogCategory.KERNEL32,
            `FileTimeToSystemTime -> ${d.toISOString()}`);
        return { value: 1, stackCleanup: 8 }; // TRUE
    };

    // BOOL FileTimeToLocalFileTime(const FILETIME *lpFileTime, LPFILETIME lpLocalFileTime)
    // Converts UTC FILETIME to local FILETIME by subtracting timezone offset.
    exports['FileTimeToLocalFileTime'] = (ctx, mem, args) => {
        const lpFileTime      = args[0] >>> 0;
        const lpLocalFileTime = args[1] >>> 0;

        if (!lpFileTime || !lpLocalFileTime || lpFileTime + 8 > mem.length || lpLocalFileTime + 8 > mem.length) {
            return { value: 0, stackCleanup: 8 }; // FALSE
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const windowsTicks = view.getBigUint64(lpFileTime, true);

        // JS timezone offset is in minutes (positive = west of UTC)
        const tzOffsetMs = BigInt(-new Date().getTimezoneOffset() * 60 * 1000);
        const tzOffsetTicks = tzOffsetMs * 10000n;
        const localTicks = windowsTicks + tzOffsetTicks;

        view.setBigUint64(lpLocalFileTime, localTicks, true);

        Logger.verbose(LogCategory.KERNEL32,
            `FileTimeToLocalFileTime: UTC ticks=${windowsTicks} local ticks=${localTicks}`);
        return { value: 1, stackCleanup: 8 }; // TRUE
    };

    // BOOL LocalFileTimeToFileTime(const FILETIME *lpLocalFileTime, LPFILETIME lpFileTime)
    // Inverse of FileTimeToLocalFileTime — converts local FILETIME to UTC.
    exports['LocalFileTimeToFileTime'] = (ctx, mem, args) => {
        const lpLocalFileTime = args[0] >>> 0;
        const lpFileTime      = args[1] >>> 0;

        if (!lpLocalFileTime || !lpFileTime || lpLocalFileTime + 8 > mem.length || lpFileTime + 8 > mem.length) {
            return { value: 0, stackCleanup: 8 }; // FALSE
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const localTicks = view.getBigUint64(lpLocalFileTime, true);

        const tzOffsetMs = BigInt(-new Date().getTimezoneOffset() * 60 * 1000);
        const tzOffsetTicks = tzOffsetMs * 10000n;
        const utcTicks = localTicks - tzOffsetTicks;

        view.setBigUint64(lpFileTime, utcTicks, true);

        Logger.verbose(LogCategory.KERNEL32,
            `LocalFileTimeToFileTime: local ticks=${localTicks} UTC ticks=${utcTicks}`);
        return { value: 1, stackCleanup: 8 }; // TRUE
    };

    // BOOL FileTimeToDosDateTime(const FILETIME *lpFileTime, LPWORD lpFatDate, LPWORD lpFatTime)
    // Converts a Windows FILETIME to MS-DOS date/time format (FAT timestamps).
    // DOS date: bits 15-9 = year-1980, bits 8-5 = month, bits 4-0 = day
    // DOS time: bits 15-11 = hours, bits 10-5 = minutes, bits 4-0 = seconds/2
    exports['FileTimeToDosDateTime'] = (ctx, mem, args) => {
        const lpFileTime = args[0] >>> 0;
        const lpFatDate  = args[1] >>> 0;
        const lpFatTime  = args[2] >>> 0;

        if (!lpFileTime || !lpFatDate || !lpFatTime ||
            lpFileTime + 8 > mem.length ||
            lpFatDate + 2 > mem.length ||
            lpFatTime + 2 > mem.length) {
            return { value: 0, stackCleanup: 12 }; // FALSE
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const windowsTicks = view.getBigUint64(lpFileTime, true);
        // Convert to local time for FAT timestamps (convention)
        const tzOffsetMs = BigInt(-new Date().getTimezoneOffset() * 60 * 1000);
        const localMs = Number((windowsTicks / 10000n) - 11644473600000n) + Number(tzOffsetMs);
        const d = new Date(localMs);

        const year    = d.getFullYear();
        const month   = d.getMonth() + 1;  // 1-12
        const day     = d.getDate();        // 1-31
        const hours   = d.getHours();
        const minutes = d.getMinutes();
        const seconds = d.getSeconds();

        // FAT year is relative to 1980; clamp to valid range
        const fatYear = Math.max(0, Math.min(127, year - 1980));
        const fatDate = (fatYear << 9) | (month << 5) | day;
        const fatTime = (hours << 11) | (minutes << 5) | (seconds >>> 1);

        view.setUint16(lpFatDate, fatDate, true);
        view.setUint16(lpFatTime, fatTime, true);

        Logger.verbose(LogCategory.KERNEL32,
            `FileTimeToDosDateTime -> date=0x${fatDate.toString(16)} time=0x${fatTime.toString(16)}`);
        return { value: 1, stackCleanup: 12 }; // TRUE
    };

    // BOOL DosDateTimeToFileTime(WORD wFatDate, WORD wFatTime, LPFILETIME lpFileTime)
    // Reverse of FileTimeToDosDateTime
    exports['DosDateTimeToFileTime'] = (ctx, mem, args) => {
        const wFatDate  = args[0] & 0xFFFF;
        const wFatTime  = args[1] & 0xFFFF;
        const lpFileTime = args[2] >>> 0;

        if (!lpFileTime || lpFileTime + 8 > mem.length) {
            return 0; // FALSE
        }

        const year    = ((wFatDate >> 9) & 0x7F) + 1980;
        const month   = (wFatDate >> 5) & 0x0F;
        const day     = wFatDate & 0x1F;
        const hours   = (wFatTime >> 11) & 0x1F;
        const minutes = (wFatTime >> 5) & 0x3F;
        const seconds = (wFatTime & 0x1F) * 2;

        const d = new Date(year, month - 1, day, hours, minutes, seconds);
        const msFromEpoch = BigInt(d.getTime());
        // Convert JS epoch ms → Windows FILETIME (100ns ticks from 1601-01-01)
        const windowsTicks = (msFromEpoch + 11644473600000n) * 10000n;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setBigUint64(lpFileTime, windowsTicks, true);

        Logger.verbose(LogCategory.KERNEL32,
            `DosDateTimeToFileTime(date=0x${wFatDate.toString(16)}, time=0x${wFatTime.toString(16)}) -> ${d.toISOString()}`);
        return 1; // TRUE
    };

    // SetFileTime - sets the date and time that a file was created/accessed/modified
    exports['SetFileTime'] = (ctx, mem, args) => {
        const hFile = args[0];
        const lpCreationTime = args[1];
        const lpLastAccessTime = args[2];
        const lpLastWriteTime = args[3];

        Logger.verbose(LogCategory.KERNEL32,
            `SetFileTime(hFile=0x${hFile.toString(16)}, create=${lpCreationTime ? '0x' + lpCreationTime.toString(16) : 'NULL'}, access=${lpLastAccessTime ? '0x' + lpLastAccessTime.toString(16) : 'NULL'}, write=${lpLastWriteTime ? '0x' + lpLastWriteTime.toString(16) : 'NULL'})`);

        // Stub: report success but don't actually change timestamps in VFS
        return 1; // TRUE
    };

    // BOOL SystemTimeToFileTime(const SYSTEMTIME *lpSystemTime, LPFILETIME lpFileTime)
    exports['SystemTimeToFileTime'] = (ctx, mem, args) => {
        const lpSystemTime = args[0] >>> 0;
        const lpFileTime = args[1] >>> 0;

        if (!lpSystemTime || !lpFileTime || lpSystemTime + 16 > mem.length || lpFileTime + 8 > mem.length) {
            return { value: 0, stackCleanup: 8 }; // FALSE
        }

        const st = readSystemTime(mem, lpSystemTime);
        // Convert to Windows FILETIME: 100ns intervals since Jan 1 1601 UTC
        const unixMs = BigInt(st.getTime());
        const windowsTicks = (unixMs + 11644473600000n) * 10000n;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setBigUint64(lpFileTime, windowsTicks, true);

        return { value: 1, stackCleanup: 8 }; // TRUE
    };

    // BOOL SystemTimeToTzSpecificLocalTime(
    //   const TIME_ZONE_INFORMATION *lpTimeZone, const SYSTEMTIME *lpUniversalTime, LPSYSTEMTIME lpLocalTime)
    exports['SystemTimeToTzSpecificLocalTime'] = (ctx, mem, args) => {
        const lpUniversalTime = args[1] >>> 0;
        const lpLocalTime = args[2] >>> 0;

        if (!lpUniversalTime || !lpLocalTime) {
            return { value: 0, stackCleanup: 12 }; // FALSE
        }

        // Read UTC SYSTEMTIME, convert to local using JS timezone
        const utcDate = readSystemTime(mem, lpUniversalTime);
        // readSystemTime treats values as local — reconstruct as UTC
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const year = view.getUint16(lpUniversalTime + 0, true);
        const month = view.getUint16(lpUniversalTime + 2, true) - 1;
        const day = view.getUint16(lpUniversalTime + 6, true);
        const hour = view.getUint16(lpUniversalTime + 8, true);
        const minute = view.getUint16(lpUniversalTime + 10, true);
        const second = view.getUint16(lpUniversalTime + 12, true);
        const ms = view.getUint16(lpUniversalTime + 14, true);
        const utc = new Date(Date.UTC(year, month, day, hour, minute, second, ms));

        // Write local time
        writeSystemTime(mem, lpLocalTime, utc);

        return { value: 1, stackCleanup: 12 }; // TRUE
    };
}

// Helper to write SYSTEMTIME struct to memory (from a Date in local time)
function writeSystemTime(mem: Uint8Array, ptr: number, d: Date): void {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setUint16(ptr + 0, d.getFullYear(), true);
    view.setUint16(ptr + 2, d.getMonth() + 1, true); // Win32 months 1-based
    view.setUint16(ptr + 4, d.getDay(), true);        // DayOfWeek
    view.setUint16(ptr + 6, d.getDate(), true);
    view.setUint16(ptr + 8, d.getHours(), true);
    view.setUint16(ptr + 10, d.getMinutes(), true);
    view.setUint16(ptr + 12, d.getSeconds(), true);
    view.setUint16(ptr + 14, d.getMilliseconds(), true);
}

// Helper to read SYSTEMTIME struct from memory
function readSystemTime(mem: Uint8Array, ptr: number): Date {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const year = view.getUint16(ptr + 0, true);
    const month = view.getUint16(ptr + 2, true) - 1; // JS months are 0-based
    const day = view.getUint16(ptr + 6, true);
    const hour = view.getUint16(ptr + 8, true);
    const minute = view.getUint16(ptr + 10, true);
    const second = view.getUint16(ptr + 12, true);
    const ms = view.getUint16(ptr + 14, true);
    return new Date(year, month, day, hour, minute, second, ms);
}

initTimeFunctions();
