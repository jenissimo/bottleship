/**
 * kernel32 serial/communications-port + DeviceIoControl handlers (GetComm/SetComm
 * family, PurgeComm, SetupComm, GetOverlappedResult, DeviceIoControl). Games
 * almost never use serial ports — faithful stubs.
 */
import { ThunkImplementation, ThunkResult, X86Context } from '../../core/thunking/thunk-dispatcher';
import { isValidAddress } from '../../core/memory/address-guard';
import {
    INFINITE, WAIT_BLOCKED_NO_SWITCH, WAIT_FAILED, WAIT_IO_COMPLETION, WAIT_OBJECT_0,
} from '../../core/scheduler/types';
import { deliverPendingApcs } from './sync';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';

const ERROR_INVALID_PARAMETER = 87;
const ERROR_IO_INCOMPLETE = 996;
const COMMCONFIG_SIZE = 48;
const OVERLAPPED_SIZE = 20;
const STATUS_PENDING = 0x103;

function writeStubDcb(lpDCB: number): void {
    Mem.writeUint32(lpDCB + 0, 28); // DCBlength
    Mem.writeUint32(lpDCB + 4, 9600); // BaudRate
    Mem.writeUint32(lpDCB + 8, 1); // fBinary
    Mem.writeUint16(lpDCB + 12, 0);
    Mem.writeUint16(lpDCB + 14, 0);
    Mem.writeUint16(lpDCB + 16, 0);
    Mem.writeUint8(lpDCB + 18, 8); // ByteSize
    Mem.writeUint8(lpDCB + 19, 0); // Parity
    Mem.writeUint8(lpDCB + 20, 0); // StopBits
    Mem.writeUint8(lpDCB + 21, 0);
    Mem.writeUint8(lpDCB + 22, 0);
    Mem.writeUint8(lpDCB + 23, 0);
    Mem.writeUint8(lpDCB + 24, 0);
    Mem.writeUint8(lpDCB + 25, 0);
    Mem.writeUint16(lpDCB + 26, 0);
}

/** The Win32 codes an I/O completion status maps to (RtlNtStatusToDosError). */
function ioStatusToWin32(status: number): number {
    switch (status >>> 0) {
        case STATUS_PENDING: return ERROR_IO_INCOMPLETE;
        case 0x80000005: return 234;  // STATUS_BUFFER_OVERFLOW -> ERROR_MORE_DATA
        case 0xC0000008: return 6;    // STATUS_INVALID_HANDLE
        case 0xC000000D: return ERROR_INVALID_PARAMETER;
        case 0xC0000011: return 38;   // STATUS_END_OF_FILE -> ERROR_HANDLE_EOF
        case 0xC0000022: return 5;    // STATUS_ACCESS_DENIED
        case 0xC000007F: return 112;  // STATUS_DISK_FULL
        case 0xC00000BB: return 50;   // STATUS_NOT_SUPPORTED
        case 0xC0000120: return 995;  // STATUS_CANCELLED -> ERROR_OPERATION_ABORTED
        case 0xC000014B: return 109;  // STATUS_PIPE_BROKEN
        default: return 317;          // ERROR_MR_MID_NOT_FOUND, RtlNtStatusToDosError's own default
    }
}

/**
 * GetOverlappedResult[Ex]: the OVERLAPPED's Internal/InternalHigh are the operation's
 * status and byte count. A pending operation with a non-zero timeout waits on hEvent
 * (the file handle when there is none); the low two bits of a handle are tag bits the
 * object manager ignores, which is where the "no completion packet" flag lives.
 */
function overlappedResult(
    ctx: X86Context, mem: Uint8Array, hFile: number, lpOverlapped: number, lpBytes: number,
    timeoutMs: number, alertable: boolean, cleanup: number,
): ThunkResult {
    const sched = System.getInstance().scheduler;
    if (!lpOverlapped || !isValidAddress(mem, lpOverlapped, OVERLAPPED_SIZE, 'r')) {
        sched.setLastError(ERROR_INVALID_PARAMETER);
        return { value: 0, stackCleanup: cleanup };
    }

    const complete = (): { value: number; lastError?: number } => {
        // Signalled yet still marked pending: the waited object said done, so it is.
        let status = Mem.readUint32(lpOverlapped) ?? 0;
        if (lpBytes) Mem.writeUint32(lpBytes, Mem.readUint32(lpOverlapped + 4) ?? 0);
        if (status === STATUS_PENDING) status = 0;
        return status === 0 ? { value: 1 } : { value: 0, lastError: ioStatusToWin32(status) };
    };
    const afterWait = (waitResult: number): { value: number; lastError?: number } => {
        if (waitResult === WAIT_OBJECT_0) return complete();
        if (waitResult === WAIT_FAILED) return { value: 0, lastError: 6 }; // ERROR_INVALID_HANDLE
        return { value: 0, lastError: waitResult };                      // WAIT_TIMEOUT / WAIT_IO_COMPLETION
    };
    const answer = (r: { value: number; lastError?: number }): ThunkResult => {
        if (r.lastError !== undefined) sched.setLastError(r.lastError);
        return { value: r.value, stackCleanup: cleanup };
    };

    if ((Mem.readUint32(lpOverlapped) ?? 0) !== STATUS_PENDING) return answer(complete());
    if (timeoutMs === 0) return answer({ value: 0, lastError: ERROR_IO_INCOMPLETE });

    if (alertable) {
        const alerted = deliverPendingApcs(ctx, 'GetOverlappedResultEx:APC', cleanup, () => {
            sched.setLastError(WAIT_IO_COMPLETION);
            return 0;
        });
        if (alerted) return alerted;
    }

    const hEvent = Mem.readUint32(lpOverlapped + 16) ?? 0;
    const waitOn = (hEvent ? hEvent : hFile) & ~3;
    const returnAddr = Mem.readUint32(ctx.esp) ?? 0;
    const result = sched.waitForObjectsWithContext(
        [waitOn >>> 0], false, timeoutMs, returnAddr, ctx.esp + 4 + cleanup,
        { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags },
        alertable, afterWait,
    );
    if (result === WAIT_BLOCKED_NO_SWITCH) return { value: 0, blockedNoSwitch: true, stackCleanup: cleanup };
    return answer(afterWait(result));
}

export function registerFileIoCommExports(exports: Record<string, ThunkImplementation>): void {
    exports['GetCommProperties'] = (ctx, mem, args) => {
        const lpCommProp = args[1];
        if (!lpCommProp) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        const size = 64;
        Mem.writeBytes(lpCommProp, new Uint8Array(size));
        Mem.writeUint32(lpCommProp, size);
        return 1;
    };

    exports['GetCommState'] = (ctx, mem, args) => {
        const lpDCB = args[1];
        if (!lpDCB) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        writeStubDcb(lpDCB);
        return 1;
    };

    exports['SetCommState'] = (ctx, mem, args) => {
        return 1;
    };

    exports['SetCommTimeouts'] = (ctx, mem, args) => {
        return 1;
    };

    exports['GetCommModemStatus'] = (ctx, mem, args) => {
        const lpModemStat = args[1];
        if (lpModemStat) {
            Mem.writeUint32(lpModemStat, 0);
        }
        return 1;
    };

    exports['EscapeCommFunction'] = (ctx, mem, args) => {
        return 1;
    };

    exports['PurgeComm'] = (ctx, mem, args) => {
        return 1;
    };

    exports['SetCommBreak'] = (ctx, mem, args) => {
        return 1;
    };

    exports['ClearCommBreak'] = (ctx, mem, args) => {
        return 1;
    };

    // BOOL ClearCommError(HANDLE hFile, LPDWORD lpErrors, LPCOMSTAT lpStat)
    exports['ClearCommError'] = (ctx, mem, args) => {
        const lpErrors = args[1];
        const lpStat = args[2];
        if (lpErrors) Mem.writeUint32(lpErrors, 0);
        if (lpStat) {
            // Zero out COMSTAT (28 bytes)
            for (let i = 0; i < 28; i += 4) {
                Mem.writeUint32(lpStat + i, 0);
            }
        }
        return 1;
    };

    // BOOL SetupComm(HANDLE hFile, DWORD dwInQueue, DWORD dwOutQueue)
    exports['SetupComm'] = (ctx, mem, args) => {
        return 1;
    };

    // BOOL GetCommMask(HANDLE hFile, LPDWORD lpEvtMask)
    exports['GetCommMask'] = (ctx, mem, args) => {
        const lpEvtMask = args[1];
        if (lpEvtMask) Mem.writeUint32(lpEvtMask, 0);
        return 1;
    };

    // BOOL GetCommConfig(HANDLE, LPCOMMCONFIG lpCC, LPDWORD lpdwSize)
    exports['GetCommConfig'] = (ctx, mem, args) => {
        const lpCC = args[1];
        const lpdwSize = args[2];
        if (!lpdwSize) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        Mem.writeUint32(lpdwSize, COMMCONFIG_SIZE);
        if (!lpCC) {
            return 1;
        }
        Mem.writeUint32(lpCC, COMMCONFIG_SIZE);
        Mem.writeUint16(lpCC + 4, 1); // wVersion
        Mem.writeUint16(lpCC + 6, 0); // wReserved
        writeStubDcb(lpCC + 8);
        Mem.writeUint32(lpCC + 36, 0); // dwProviderSubType
        Mem.writeUint32(lpCC + 40, 0); // dwProviderOffset
        Mem.writeUint32(lpCC + 44, 0); // dwProviderSize
        return 1;
    };

    // BOOL SetCommConfig(HANDLE, LPCOMMCONFIG lpCC, DWORD dwSize)
    exports['SetCommConfig'] = () => 1;

    // BOOL WaitCommEvent(HANDLE, LPDWORD lpEvtMask, LPOVERLAPPED lpOverlapped)
    exports['WaitCommEvent'] = (ctx, mem, args) => {
        const lpEvtMask = args[1];
        const lpOverlapped = args[2];
        if (lpEvtMask) Mem.writeUint32(lpEvtMask, 0);
        if (lpOverlapped && lpOverlapped + 20 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lpOverlapped, 0, true); // Internal = completed
            view.setUint32(lpOverlapped + 4, 0, true); // InternalHigh
        }
        return 1;
    };

    // BOOL GetOverlappedResult(HANDLE, LPOVERLAPPED, LPDWORD lpNumberOfBytesTransferred, BOOL bWait)
    exports['GetOverlappedResult'] = (ctx, mem, args) =>
        overlappedResult(ctx, mem, args[0] >>> 0, args[1] >>> 0, args[2] >>> 0, args[3] ? INFINITE : 0, false, 16);

    // BOOL GetOverlappedResultEx(HANDLE, LPOVERLAPPED, LPDWORD, DWORD dwMilliseconds, BOOL bAlertable)
    exports['GetOverlappedResultEx'] = (ctx, mem, args) =>
        overlappedResult(ctx, mem, args[0] >>> 0, args[1] >>> 0, args[2] >>> 0, args[3] >>> 0, args[4] !== 0, 20);

    // BOOL DeviceIoControl(HANDLE, DWORD dwIoControlCode, LPVOID lpInBuffer, DWORD nInBufferSize,
    //   LPVOID lpOutBuffer, DWORD nOutBufferSize, LPDWORD lpBytesReturned, LPOVERLAPPED)
    exports['DeviceIoControl'] = (ctx, mem, args) => {
        const dwIoControlCode = args[1];
        const lpBytesReturned = args[6];
        Logger.warn(LogCategory.KERNEL32,
            `DeviceIoControl: ioctl=0x${dwIoControlCode.toString(16)} — stub`);
        if (lpBytesReturned) Mem.writeUint32(lpBytesReturned, 0);
        // Return FALSE with ERROR_INVALID_FUNCTION — device not supported
        System.getInstance().scheduler.setLastError(1); // ERROR_INVALID_FUNCTION
        return 0;
    };
}
