// Process-related functions for kernel32
// GetCurrentProcessId, GetCurrentThreadId, ExitProcess, GetStartupInfo*, IsProcessorFeaturePresent

import { ThunkImplementation, ThunkResult } from '../../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../../core/logger';
import { System } from '../../../core/system';
import {
    EmulatorConfig,
    VER_PLATFORM_WIN32_NT,
    VER_PLATFORM_WIN32_WINDOWS,
} from '../../../core/emulator-config-manager';
import { isValidAddress } from '../../../core/memory/address-guard';
import { ThreadState } from '../../../core/scheduler/types';
import { Mem } from '../../../core/memory/mem-accessor';
import { invalidateGuestCode, invalidateAllGuestCode } from '../../../core/memory/guest-code';
import { Marshaler } from '../../../core/memory/marshaler';
import { SystemResourceProvider } from '../../../core/resources/system-resource-provider';
import { encodeAnsi } from '../../codepage-utils';
import { applyShellExecFake, hasShellExecFakeMatch } from '../../shell32';
import { getVirtualProcessManager, VIRTUAL_CURRENT_PROCESS_ID } from './virtual-process-manager';
import { createActCtxExports } from './actctx';
import { versionVerifyExports } from './version-verify';

const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_CALL_NOT_IMPLEMENTED = 120;
const ERROR_PARTIAL_COPY = 299;
const ERROR_NO_MORE_FILES = 18;
const CURRENT_PROCESS_PSEUDO_HANDLE = 0xFFFFFFFF;
const STILL_ACTIVE = 259;
const CURRENT_PROCESS_ID = VIRTUAL_CURRENT_PROCESS_ID;
const DEFAULT_MIN_WORKING_SET_BYTES = 0x00020000; // 128 KB
const DEFAULT_MAX_WORKING_SET_BYTES = 0x01000000; // 16 MB
const IDLE_PRIORITY_CLASS = 0x00000040;
const BELOW_NORMAL_PRIORITY_CLASS = 0x00004000;
const NORMAL_PRIORITY_CLASS = 0x00000020;
const ABOVE_NORMAL_PRIORITY_CLASS = 0x00008000;
const HIGH_PRIORITY_CLASS = 0x00000080;
const REALTIME_PRIORITY_CLASS = 0x00000100;
const INVALID_HANDLE_VALUE = 0xFFFFFFFF;

let currentPriorityClass = NORMAL_PRIORITY_CLASS;

// Tracks the last ES_CONTINUOUS SetThreadExecutionState value.
// Initial state: ES_CONTINUOUS only (no active power-management request).
let threadExecutionState = 0x80000000; // ES_CONTINUOUS

// ==================== Toolhelp32 Snapshot internals ====================

interface ToolhelpSnapshot {
    flags: number;
    pid: number;
    processes: Array<{ pid: number; parentPid: number; exeName: string }>;
    threads: Array<{ tid: number; ownerPid: number; basePri: number }>;
    modules: Array<{ name: string; path: string; baseAddr: number; size: number }>;
    procIdx: number;
    threadIdx: number;
    moduleIdx: number;
}

/** Active snapshots keyed by handle. Cleaned up on access if handle was closed. */
const toolhelpSnapshots = new Map<number, ToolhelpSnapshot>();

function getSnapshot(handle: number): ToolhelpSnapshot | null {
    const snap = toolhelpSnapshots.get(handle);
    if (snap) return snap;
    // Handle may have been closed via CloseHandle — clean up stale entry
    toolhelpSnapshots.delete(handle);
    return null;
}

/** Write PROCESSENTRY32 to guest memory. Returns TRUE/FALSE ThunkResult. */
function process32Impl(mem: Uint8Array, hSnapshot: number, lppe: number, isFirst: boolean, isWide: boolean): ThunkResult {
    const snap = getSnapshot(hSnapshot);
    if (!snap) {
        System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
        return { value: 0, stackCleanup: 8 };
    }

    if (isFirst) snap.procIdx = 0;

    if (snap.procIdx >= snap.processes.length) {
        System.getInstance().scheduler.setLastError(ERROR_NO_MORE_FILES);
        return { value: 0, stackCleanup: 8 };
    }

    const proc = snap.processes[snap.procIdx++];
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    // PROCESSENTRY32(W) layout:
    // +0   dwSize          (uint32)
    // +4   cntUsage        (uint32)
    // +8   th32ProcessID   (uint32)
    // +12  th32DefaultHeapID (ulong_ptr)
    // +16  th32ModuleID    (uint32)
    // +20  cntThreads      (uint32)
    // +24  th32ParentProcessID (uint32)
    // +28  pcPriClassBase  (long)
    // +32  dwFlags         (uint32)
    // +36  szExeFile       ANSI: char[260] / Wide: wchar[260]
    const structSize = isWide ? 556 : 296; // 36 + 260*2 or 36 + 260
    view.setUint32(lppe + 0, structSize, true);     // dwSize
    view.setUint32(lppe + 4, 0, true);              // cntUsage
    view.setUint32(lppe + 8, proc.pid >>> 0, true); // th32ProcessID
    view.setUint32(lppe + 12, 0, true);             // th32DefaultHeapID
    view.setUint32(lppe + 16, 0, true);             // th32ModuleID
    view.setUint32(lppe + 20, snap.threads.length, true); // cntThreads
    view.setUint32(lppe + 24, proc.parentPid >>> 0, true); // th32ParentProcessID
    view.setInt32(lppe + 28, 8, true);              // pcPriClassBase (NORMAL_PRIORITY_CLASS)
    view.setUint32(lppe + 32, 0, true);             // dwFlags

    // szExeFile at offset 36
    const nameOffset = lppe + 36;
    if (isWide) {
        const maxChars = Math.min(proc.exeName.length, 259);
        for (let i = 0; i < maxChars; i++) {
            view.setUint16(nameOffset + i * 2, proc.exeName.charCodeAt(i), true);
        }
        view.setUint16(nameOffset + maxChars * 2, 0, true);
    } else {
        const exeBytes = encodeAnsi(proc.exeName);
        const maxChars = Math.min(exeBytes.length, 259);
        mem.set(exeBytes.subarray(0, maxChars), nameOffset);
        mem[nameOffset + maxChars] = 0;
    }

    return { value: 1, stackCleanup: 8 }; // TRUE
}

/** Write THREADENTRY32 to guest memory. Returns TRUE/FALSE ThunkResult. */
function thread32Impl(mem: Uint8Array, hSnapshot: number, lpte: number, isFirst: boolean): ThunkResult {
    const snap = getSnapshot(hSnapshot);
    if (!snap) {
        System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
        return { value: 0, stackCleanup: 8 };
    }

    if (isFirst) snap.threadIdx = 0;

    if (snap.threadIdx >= snap.threads.length) {
        System.getInstance().scheduler.setLastError(ERROR_NO_MORE_FILES);
        return { value: 0, stackCleanup: 8 };
    }

    const t = snap.threads[snap.threadIdx++];
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    // THREADENTRY32 layout (28 bytes):
    // +0   dwSize          (uint32)
    // +4   cntUsage        (uint32)
    // +8   th32ThreadID    (uint32)
    // +12  th32OwnerProcessID (uint32)
    // +16  tpBasePri       (long)
    // +20  tpDeltaPri      (long)
    // +24  dwFlags         (uint32)
    view.setUint32(lpte + 0, 28, true);               // dwSize
    view.setUint32(lpte + 4, 0, true);                // cntUsage
    view.setUint32(lpte + 8, t.tid >>> 0, true);      // th32ThreadID
    view.setUint32(lpte + 12, t.ownerPid >>> 0, true);// th32OwnerProcessID
    view.setInt32(lpte + 16, t.basePri, true);         // tpBasePri
    view.setInt32(lpte + 20, 0, true);                 // tpDeltaPri
    view.setUint32(lpte + 24, 0, true);               // dwFlags

    return { value: 1, stackCleanup: 8 }; // TRUE
}

/** Write MODULEENTRY32(A/W) to guest memory. Returns TRUE/FALSE ThunkResult. */
function module32Impl(mem: Uint8Array, hSnapshot: number, lpme: number, isFirst: boolean, isWide: boolean): ThunkResult {
    const snap = getSnapshot(hSnapshot);
    if (!snap) {
        System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
        return { value: 0, stackCleanup: 8 };
    }

    if (isFirst) snap.moduleIdx = 0;

    if (snap.moduleIdx >= snap.modules.length) {
        System.getInstance().scheduler.setLastError(ERROR_NO_MORE_FILES);
        return { value: 0, stackCleanup: 8 };
    }

    const m = snap.modules[snap.moduleIdx++];
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const OUR_PID = CURRENT_PROCESS_ID;

    // MODULEENTRY32A layout (548 bytes):
    // +0    dwSize        (uint32)
    // +4    th32ModuleID  (uint32)
    // +8    th32ProcessID (uint32)
    // +12   GlblcntUsage  (uint32)
    // +16   ProccntUsage  (uint32)
    // +20   modBaseAddr   (ptr)
    // +24   modBaseSize   (uint32)
    // +28   hModule       (HMODULE)
    // +32   szModule      char[256]
    // +288  szExePath     char[260]
    //
    // MODULEENTRY32W layout (1080 bytes, legacy compatibility):
    // +0    dwSize        (uint32)
    // +4    th32ModuleID  (uint32)
    // +8    th32ProcessID (uint32)
    // +12   GlblcntUsage  (uint32)
    // +16   ProccntUsage  (uint32)
    // +20   modBaseAddr   (ptr)
    // +24   modBaseSize   (uint32)
    // +28   hModule       (HMODULE)
    // +32   szModule      wchar[256] (512 bytes)
    // +544  szExePath     wchar[260] (520 bytes)
    const structSize = isWide ? 1080 : 548;
    view.setUint32(lpme + 0, structSize, true);        // dwSize
    view.setUint32(lpme + 4, 1, true);                 // th32ModuleID
    view.setUint32(lpme + 8, OUR_PID, true);           // th32ProcessID
    view.setUint32(lpme + 12, 1, true);                // GlblcntUsage
    view.setUint32(lpme + 16, 1, true);                // ProccntUsage
    view.setUint32(lpme + 20, m.baseAddr >>> 0, true); // modBaseAddr
    view.setUint32(lpme + 24, m.size >>> 0, true);     // modBaseSize
    view.setUint32(lpme + 28, m.baseAddr >>> 0, true); // hModule (same as base)

    if (isWide) {
        // szModule at +32 (wchar[256])
        const moduleOffset = lpme + 32;
        const nameChars = Math.min(m.name.length, 255);
        for (let i = 0; i < nameChars; i++) {
            view.setUint16(moduleOffset + i * 2, m.name.charCodeAt(i), true);
        }
        view.setUint16(moduleOffset + nameChars * 2, 0, true);

        // szExePath at +544 (wchar[260])
        const pathOffset = lpme + 544;
        const pathChars = Math.min(m.path.length, 259);
        for (let i = 0; i < pathChars; i++) {
            view.setUint16(pathOffset + i * 2, m.path.charCodeAt(i), true);
        }
        view.setUint16(pathOffset + pathChars * 2, 0, true);
    } else {
        // szModule at +32 (char[256])
        const moduleOffset = lpme + 32;
        const nameBytes = encodeAnsi(m.name);
        const nameLen = Math.min(nameBytes.length, 255);
        mem.set(nameBytes.subarray(0, nameLen), moduleOffset);
        mem[moduleOffset + nameLen] = 0;

        // szExePath at +288 (char[260])
        const pathOffset = lpme + 288;
        const pathBytes = encodeAnsi(m.path);
        const pathLen = Math.min(pathBytes.length, 259);
        mem.set(pathBytes.subarray(0, pathLen), pathOffset);
        mem[pathOffset + pathLen] = 0;
    }

    return { value: 1, stackCleanup: 8 }; // TRUE
}

function module32AImpl(mem: Uint8Array, hSnapshot: number, lpme: number, isFirst: boolean): ThunkResult {
    return module32Impl(mem, hSnapshot, lpme, isFirst, false);
}

function module32WImpl(mem: Uint8Array, hSnapshot: number, lpme: number, isFirst: boolean): ThunkResult {
    return module32Impl(mem, hSnapshot, lpme, isFirst, true);
}

const shutdownProcess = (exitCode: number): ThunkResult => {
    const system = System.getInstance();
    Logger.log(LogCategory.KERNEL32, `ShutdownProcess code=${exitCode}`);

    // Forensic call stack for ANY app close. ExitProcess is a clean thunk (no
    // WASM trap), so the worker fault-snapshot never fires — but a game
    // "vanishing" (e.g. a CRT exit()/__amsg_exit graceful abort after an
    // under-implemented API) is exactly when we want to see who called exit.
    try {
        (system.process?.dispatcher as { dumpExitCallStack?: (r: string, e?: number) => void } | undefined)
            ?.dumpExitCallStack?.(`ExitProcess(code=${exitCode})`);
    } catch (e) {
        Logger.warn(LogCategory.KERNEL32, `ShutdownProcess: exit-trace failed: ${e}`);
    }

    try {
        const ddraw = system.process?.getModule("ddraw") as { flushDeferredSurfacePtrFrees?: () => void } | undefined;
        ddraw?.flushDeferredSurfacePtrFrees?.();
    } catch (e) {
        Logger.warn(LogCategory.KERNEL32, `ShutdownProcess: deferred surfacePtr flush failed: ${e}`);
    }

    // Flush all pending VFS writes to OPFS before stopping
    system.fileSystem.flushAll().catch(e => {
        Logger.warn(LogCategory.KERNEL32, `ShutdownProcess: flushAll failed: ${e}`);
    });

    system.isExiting = true;

    // Snapshot diagnostics while guest state is still live (backtrace, stubs,
    // getProcMisses, recent WinAPI) — the host shows this in the "Game exited" dialog.
    let exitFault: ReturnType<System["buildProcessExitReport"]> | undefined;
    try {
        exitFault = system.buildProcessExitReport(exitCode);
    } catch (e) {
        Logger.warn(LogCategory.KERNEL32, `ShutdownProcess: exit report failed: ${e}`);
    }

    // Faithful Win32 ExitProcess: tear down the WHOLE process, not just the
    // calling thread. Terminating every thread (worker pool, winmm-timer, audio)
    // leaves no runnable thread, so _handleSyncResult / the scheduler loop stop
    // v86 cleanly instead of spinning a frozen frame (the pseudo-hang that made
    // a guest crash look like a deadlock). The current thread is included here;
    // the `terminated: true` return below still unwinds the calling thunk.
    system.scheduler.terminateAllThreads(exitCode);

    // Notify the host so the UI can present a clean "game exited" state instead
    // of a stale, frozen canvas (the game's window is gone, nothing repaints it).
    try {
        (self as unknown as { postMessage: (m: unknown) => void }).postMessage({
            type: "process_exit",
            exitCode: exitCode >>> 0,
            fault: exitFault,
        });
    } catch { /* not in a worker context (tests) — ignore */ }

    return { value: 0, terminated: true };
};

const writeProcessInformationZeroed = (lpProcessInformation: number): void => {
    if (!lpProcessInformation) return;

    // PROCESS_INFORMATION = hProcess, hThread, dwProcessId, dwThreadId
    Mem.writeUint32(lpProcessInformation + 0, 0);
    Mem.writeUint32(lpProcessInformation + 4, 0);
    Mem.writeUint32(lpProcessInformation + 8, 0);
    Mem.writeUint32(lpProcessInformation + 12, 0);
};

const writeProcessInformation = (
    lpProcessInformation: number,
    processHandle: number,
    threadHandle: number,
    processId: number,
    threadId: number
): boolean => {
    if (!lpProcessInformation) return false;
    if (!Mem.writeUint32(lpProcessInformation + 0, processHandle >>> 0)) return false;
    if (!Mem.writeUint32(lpProcessInformation + 4, threadHandle >>> 0)) return false;
    if (!Mem.writeUint32(lpProcessInformation + 8, processId >>> 0)) return false;
    if (!Mem.writeUint32(lpProcessInformation + 12, threadId >>> 0)) return false;
    return true;
};

const readNullableProcessString = (memory: Uint8Array, ptr: number, isWide: boolean): string => {
    if (!ptr) return '';
    return isWide ? Marshaler.readWideString(memory, ptr) : Marshaler.readString(memory, ptr);
};

const isCurrentProcessHandle = (handle: number): boolean => {
    if ((handle >>> 0) === CURRENT_PROCESS_PSEUDO_HANDLE) {
        return true;
    }
    const pid = getVirtualProcessManager().getProcessIdByHandle(handle >>> 0);
    return pid === CURRENT_PROCESS_ID;
};

const isKnownProcessHandle = (handle: number): boolean => {
    if ((handle >>> 0) === CURRENT_PROCESS_PSEUDO_HANDLE) {
        return true;
    }
    return getVirtualProcessManager().hasProcessHandle(handle >>> 0);
};

const virtualProcessMemoryByPid = new Map<number, Map<number, number>>();

const getVirtualProcessPid = (handle: number): number | null => {
    if ((handle >>> 0) === CURRENT_PROCESS_PSEUDO_HANDLE) {
        return CURRENT_PROCESS_ID;
    }
    return getVirtualProcessManager().getProcessIdByHandle(handle >>> 0);
};

const isVirtualChildProcessHandle = (handle: number): boolean => {
    const pid = getVirtualProcessPid(handle);
    return pid !== null && pid !== CURRENT_PROCESS_ID;
};

const getVirtualMemoryMapForPid = (pid: number): Map<number, number> => {
    let map = virtualProcessMemoryByPid.get(pid >>> 0);
    if (!map) {
        map = new Map<number, number>();
        virtualProcessMemoryByPid.set(pid >>> 0, map);
    }
    return map;
};

const readVirtualProcessMemory = (pid: number, address: number, size: number): Uint8Array | null => {
    const base = address >>> 0;
    const store = virtualProcessMemoryByPid.get(pid >>> 0);
    const fallback = Mem.readBytes(base, size);
    const out = new Uint8Array(size);

    for (let i = 0; i < size; i++) {
        const key = (base + i) >>> 0;
        const written = store?.get(key);
        if (written !== undefined) {
            out[i] = written & 0xFF;
            continue;
        }

        if (fallback) {
            out[i] = fallback[i] ?? 0;
            continue;
        }

        // Compatibility mode: return zero-filled bytes for unmapped regions.
        out[i] = 0;
    }

    return out;
};

const writeVirtualProcessMemory = (pid: number, address: number, data: Uint8Array): number => {
    const base = address >>> 0;
    const store = getVirtualMemoryMapForPid(pid >>> 0);
    for (let i = 0; i < data.length; i++) {
        store.set((base + i) >>> 0, data[i]!);
    }
    return data.length;
};

const isUnrealBrowserProbe = (applicationName: string, commandLine: string): boolean => {
    const probe = `${applicationName} ${commandLine}`.trim();
    return /(?:^|\s)-b\s+false(?:\s|$)/i.test(probe);
};

const failVirtualProcess = (
    lpProcessInformation: number,
    applicationName: string,
    commandLine: string,
    currentDirectory: string,
    isWide: boolean
): ThunkResult => {
    writeProcessInformationZeroed(lpProcessInformation);
    System.getInstance().scheduler.setLastError(ERROR_CALL_NOT_IMPLEMENTED);
    Logger.warn(
        LogCategory.KERNEL32,
        `CreateProcess${isWide ? 'W' : 'A'}("${applicationName}", "${commandLine}", cwd="${currentDirectory}") ` +
        `-> FAILURE (no shellExecFake match; emulator cannot spawn real child processes)`
    );
    return { value: 0, stackCleanup: 40 };
};

const finishVirtualProcess = (
    lpProcessInformation: number,
    applicationName: string,
    commandLine: string,
    currentDirectory: string,
    dwCreationFlags: number,
    isWide: boolean,
    noOpProbe: boolean
): ThunkResult => {
    const manager = getVirtualProcessManager();
    const proc = manager.createProcess({
        applicationName,
        commandLine,
        currentDirectory,
        creationFlags: dwCreationFlags,
    });

    if (!writeProcessInformation(
        lpProcessInformation,
        proc.processHandle,
        proc.threadHandle,
        proc.processId,
        proc.threadId
    )) {
        manager.terminateProcess(proc.processHandle, 0);
        writeProcessInformationZeroed(lpProcessInformation);
        System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
        return { value: 0, stackCleanup: 40 };
    }

    Logger.log(
        LogCategory.KERNEL32,
        `CreateProcess${isWide ? 'W' : 'A'}("${applicationName}", "${commandLine}", cwd="${currentDirectory}", ` +
        `flags=0x${dwCreationFlags.toString(16)}) -> pid=${proc.processId} tid=${proc.threadId} ` +
        `hProcess=0x${proc.processHandle.toString(16)} hThread=0x${proc.threadHandle.toString(16)}` +
        `${noOpProbe ? ' no-op-probe=1 sync=1' : ''}`
    );

    System.getInstance().scheduler.setLastError(0);
    return { value: 1, stackCleanup: 40 };
};

const createVirtualProcess = (memory: Uint8Array, args: number[], isWide: boolean): ThunkResult | Promise<ThunkResult> => {
    const lpApplicationName = args[0] >>> 0;
    const lpCommandLine = args[1] >>> 0;
    const dwCreationFlags = args[5] >>> 0;
    const lpCurrentDirectory = args[7] >>> 0;
    const lpProcessInformation = args[9] >>> 0;

    const applicationName = readNullableProcessString(memory, lpApplicationName, isWide);
    const commandLine = readNullableProcessString(memory, lpCommandLine, isWide);
    const currentDirectory = readNullableProcessString(memory, lpCurrentDirectory, isWide);

    if (!lpProcessInformation) {
        System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
        return { value: 0, stackCleanup: 40 };
    }

    if (!applicationName && !commandLine) {
        writeProcessInformationZeroed(lpProcessInformation);
        System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
        return { value: 0, stackCleanup: 40 };
    }

    // Only fake a child process when an explicit shellExecFake rule matches, or
    // for UE1's renderer/browser `-b false` probe. Most no-match launches still fail.
    // For UT99, a hard failure on `-b false` can leave Core's native script
    // dispatch with an uninitialized object pointer, so keep this case as a
    // no-op virtual child that auto-exits.
    const probeCommand = commandLine || applicationName;
    const hasFakeRule = hasShellExecFakeMatch(probeCommand);
    const noOpProbe = !hasFakeRule && isUnrealBrowserProbe(applicationName, commandLine);
    if (!hasFakeRule && !noOpProbe) {
        return failVirtualProcess(lpProcessInformation, applicationName, commandLine, currentDirectory, isWide);
    }

    // Keep the common no-match/no-op probe path synchronous. The async thunk
    // machinery is only needed when a matched shellExecFake rule has to touch VFS.
    if (hasFakeRule) {
        return applyShellExecFake(probeCommand, "KERNEL32").then((faked) =>
            faked
                ? finishVirtualProcess(
                    lpProcessInformation,
                    applicationName,
                    commandLine,
                    currentDirectory,
                    dwCreationFlags,
                    isWide,
                    false
                )
                : failVirtualProcess(lpProcessInformation, applicationName, commandLine, currentDirectory, isWide)
        );
    }

    return finishVirtualProcess(
        lpProcessInformation,
        applicationName,
        commandLine,
        currentDirectory,
        dwCreationFlags,
        isWide,
        noOpProbe
    );
};

const OSVERSIONINFOA_SIZE = 148;
const OSVERSIONINFOEXA_SIZE = 156;
const OSVERSIONINFOW_SIZE = 276;   // 20 + 128 WCHAR
const OSVERSIONINFOEXW_SIZE = 284; // OSVERSIONINFOW + 8-byte EX tail

function fillVersionExA(mem: Uint8Array, lpVersionInfo: number, apiName: string): number {
    if (!lpVersionInfo || !isValidAddress(lpVersionInfo, OSVERSIONINFOA_SIZE, 'rw')) {
        Logger.warn(
            LogCategory.KERNEL32,
            `${apiName}: invalid lpVersionInfo=0x${lpVersionInfo.toString(16)}`
        );
        return 0;
    }

    const dwSize = Mem.readUint32(lpVersionInfo);
    if (dwSize === null || dwSize < OSVERSIONINFOA_SIZE) {
        Logger.warn(LogCategory.KERNEL32, `${apiName}: dwSize too small: ${dwSize}`);
        return 0;
    }

    const { major, minor, build, platformId } = EmulatorConfig.getInstance().osVersion;

    Mem.writeUint32(lpVersionInfo + 0, dwSize);
    Mem.writeUint32(lpVersionInfo + 4, major);
    Mem.writeUint32(lpVersionInfo + 8, minor);
    Mem.writeUint32(lpVersionInfo + 12, build);
    Mem.writeUint32(lpVersionInfo + 16, platformId);

    const csdOffset = lpVersionInfo + 20;
    const csdText = platformId === VER_PLATFORM_WIN32_WINDOWS ? ' ' : 'Service Pack 0';
    mem.fill(0, csdOffset, csdOffset + 128);
    const csdBytes = encodeAnsi(csdText);
    mem.set(csdBytes.subarray(0, Math.min(csdBytes.length, 127)), csdOffset);

    if (dwSize >= OSVERSIONINFOEXA_SIZE) {
        Mem.writeUint16(lpVersionInfo + 148, 0);
        Mem.writeUint16(lpVersionInfo + 150, 0);
        Mem.writeUint16(lpVersionInfo + 152, 0);
        mem[lpVersionInfo + 154] = platformId === VER_PLATFORM_WIN32_NT ? 1 : 0;
        mem[lpVersionInfo + 155] = 0;
    }

    Logger.log(
        LogCategory.KERNEL32,
        `${apiName}: ${major}.${minor} (build ${build}, platform ${platformId}) @ 0x${lpVersionInfo.toString(16)}`
    );
    return 1;
}

function fillVersionExW(mem: Uint8Array, lpVersionInfo: number, apiName: string): number {
    if (!lpVersionInfo || !isValidAddress(lpVersionInfo, OSVERSIONINFOW_SIZE, 'rw')) {
        Logger.warn(
            LogCategory.KERNEL32,
            `${apiName}: invalid lpVersionInfo=0x${lpVersionInfo.toString(16)}`
        );
        return 0;
    }

    const dwSize = Mem.readUint32(lpVersionInfo);
    if (dwSize === null || dwSize < OSVERSIONINFOW_SIZE) {
        Logger.warn(LogCategory.KERNEL32, `${apiName}: dwSize too small: ${dwSize}`);
        return 0;
    }

    const { major, minor, build, platformId } = EmulatorConfig.getInstance().osVersion;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    view.setUint32(lpVersionInfo + 0, dwSize, true);
    view.setUint32(lpVersionInfo + 4, major, true);
    view.setUint32(lpVersionInfo + 8, minor, true);
    view.setUint32(lpVersionInfo + 12, build, true);
    view.setUint32(lpVersionInfo + 16, platformId, true);

    const csdOffset = lpVersionInfo + 20;
    const csdText = platformId === VER_PLATFORM_WIN32_WINDOWS ? ' ' : 'Service Pack 0';
    mem.fill(0, csdOffset, csdOffset + 256);
    for (let i = 0; i < csdText.length && i < 127; i++) {
        view.setUint16(csdOffset + i * 2, csdText.charCodeAt(i), true);
    }
    view.setUint16(csdOffset + csdText.length * 2, 0, true);

    // EX tail lives after the 128-WCHAR CSD buffer — only when caller allocated EXW (284 B).
    // Writing at +276 when dwSize==276 (plain OSVERSIONINFOW) stomps the stack (HP CoS crash).
    if (dwSize >= OSVERSIONINFOEXW_SIZE) {
        view.setUint16(lpVersionInfo + 276, 0, true); // wServicePackMajor
        view.setUint16(lpVersionInfo + 278, 0, true); // wServicePackMinor
        view.setUint16(lpVersionInfo + 280, 0, true); // wSuiteMask
        view.setUint8(lpVersionInfo + 282, platformId === VER_PLATFORM_WIN32_NT ? 1 : 0);
        view.setUint8(lpVersionInfo + 283, 0); // wReserved
    }

    Logger.log(
        LogCategory.KERNEL32,
        `${apiName}: ${major}.${minor} (build ${build}, platform ${platformId}) @ 0x${lpVersionInfo.toString(16)} dwSize=${dwSize}`
    );
    return 1;
}

export const exports: Record<string, ThunkImplementation> = {
    ...createActCtxExports(),

    'IsProcessorFeaturePresent': (ctx, mem, args) => {
        const feature = args[0] >>> 0;
        // WinXP Pentium-III-class profile aligned with our CPUID/SSE advertisement.
        // PF_FLOATING_POINT_PRECISION (0) must be TRUE — EAX.DLL / MSVC CRT abort without it.
        // PF_FLOATING_POINT_EMULATED (1) is FALSE (real x87, not emulated).
        let supported = 0;
        switch (feature) {
            case 0:  // PF_FLOATING_POINT_PRECISION
            case 2:  // PF_COMPARE_EXCHANGE_DOUBLE
            case 3:  // PF_MMX_INSTRUCTIONS_AVAILABLE
            case 6:  // PF_XMMI_INSTRUCTIONS_AVAILABLE (SSE)
            case 8:  // PF_RDTSC_INSTRUCTION_AVAILABLE
            case 10: // PF_XMMI64_INSTRUCTIONS_AVAILABLE (SSE2)
                supported = 1;
                break;
            case 1:  // PF_FLOATING_POINT_EMULATED
                supported = 0;
                break;
            default:
                supported = 0;
                break;
        }

        Logger.log(LogCategory.KERNEL32, `IsProcessorFeaturePresent(feature=${feature}) -> ${supported}`);
        return { value: supported, stackCleanup: 4 };
    },

    'GetCurrentProcessId': (ctx, mem, args): number => {
        return CURRENT_PROCESS_ID;
    },

    'GetCurrentThreadId': (ctx, mem, args) => {
        return System.getInstance().scheduler.getCurrentThreadId();
    },

    'ResumeThread': (ctx, mem, args) => {
        const hThread = args[0];
        const system = System.getInstance();
        const manager = getVirtualProcessManager();
        const virtualPrev = manager.resumeThread(hThread);
        const prevSuspendCount = virtualPrev !== null
            ? virtualPrev
            : system.scheduler.resumeThread(hThread);

        if (prevSuspendCount === 0xFFFFFFFF) {
            system.scheduler.setLastError(ERROR_INVALID_HANDLE);
        }

        Logger.log(LogCategory.KERNEL32,
            `ResumeThread(hThread=0x${hThread.toString(16)}) -> ${prevSuspendCount === 0xFFFFFFFF ? 'INVALID_HANDLE' : prevSuspendCount}`);

        return { value: prevSuspendCount, stackCleanup: 4 };
    },

    'GetCurrentProcess': (ctx, mem, args) => {
        return 0xFFFFFFFF; // Pseudo-handle for current process (-1)
    },

    'GetCurrentThread': (ctx, mem, args) => {
        return System.getInstance().scheduler.getCurrentThreadHandle();
    },

    'GetStartupInfoW': (ctx, mem, args) => {
        const lpStartupInfo = args[0];
        // Clear the structure (size is 68 bytes for STARTUPINFOW)
        if (lpStartupInfo && lpStartupInfo + 68 <= mem.length) {
            mem.fill(0, lpStartupInfo, lpStartupInfo + 68);
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lpStartupInfo, 68, true); // cb
        }
        return { value: 0, stackCleanup: 4 };
    },

    'GetStartupInfoA': (ctx, mem, args) => {
        const lpStartupInfo = args[0];
        // Clear the structure (size is 68 bytes for STARTUPINFOA)
        if (lpStartupInfo && lpStartupInfo + 68 <= mem.length) {
            mem.fill(0, lpStartupInfo, lpStartupInfo + 68);
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lpStartupInfo, 68, true); // cb
        }
        return { value: 0, stackCleanup: 4 };
    },

    'ExitProcess': (ctx, mem, args): ThunkResult => {
        const exitCode = args[0];
        return shutdownProcess(exitCode);
    },

    'FatalAppExitA': (ctx, mem, args): ThunkResult => {
        const uAction = args[0] >>> 0;
        const lpMessageText = args[1] >>> 0;
        const message = lpMessageText ? Marshaler.readString(mem, lpMessageText) : '';

        Logger.error(
            LogCategory.KERNEL32,
            `FatalAppExitA(action=${uAction}, message="${message}")`
        );

        // Legacy behavior: terminates the process immediately.
        return shutdownProcess(1);
    },

    'CreateThread': (ctx, mem, args) => {
        const lpThreadAttributes = args[0];
        const dwStackSize = args[1];
        const lpStartAddress = args[2];
        const lpParameter = args[3];
        const dwCreationFlags = args[4];
        const lpThreadId = args[5];

        Logger.log(LogCategory.KERNEL32,
            `CreateThread(start=0x${lpStartAddress.toString(16)}, param=0x${lpParameter.toString(16)}, stack=${dwStackSize}, flags=0x${dwCreationFlags.toString(16)})`);

        const sched = System.getInstance().scheduler;
        const handle = sched.createThread(
            lpStartAddress,
            lpParameter,
            dwStackSize,
            dwCreationFlags,
            lpThreadId,
            mem
        );

        if (handle === 0) {
            sched.setLastError(8); // ERROR_NOT_ENOUGH_MEMORY
        }

        return handle;
    },

    'CreateProcessA': (ctx, mem, args) => {
        return createVirtualProcess(mem, args, false);
    },

    'CreateProcessW': (ctx, mem, args) => {
        return createVirtualProcess(mem, args, true);
    },

    'ExitThread': (ctx, mem, args) => {
        const exitCode = args[0] >>> 0;
        Logger.log(LogCategory.KERNEL32, `ExitThread(code=0x${exitCode.toString(16)})`);
        System.getInstance().scheduler.exitThread(exitCode);
        return { value: 0, terminated: true };
    },

    'TerminateProcess': (ctx, mem, args): ThunkResult => {
        const hProcess = args[0] >>> 0;
        const exitCode = args[1] >>> 0;

        if (hProcess === CURRENT_PROCESS_PSEUDO_HANDLE) {
            return shutdownProcess(exitCode);
        }

        const terminated = getVirtualProcessManager().terminateProcess(hProcess, exitCode);
        if (!terminated) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return { value: 0, stackCleanup: 8 };
        }

        return { value: 1, stackCleanup: 8 };
    },

    'TerminateThread': (ctx, mem, args) => {
        const hThread = args[0];
        const exitCode = args[1] >>> 0;
        Logger.log(LogCategory.KERNEL32, `TerminateThread(hThread=0x${hThread.toString(16)}, exitCode=0x${exitCode.toString(16)})`);
        const manager = getVirtualProcessManager();
        const ok = manager.terminateThread(hThread, exitCode) ||
            System.getInstance().scheduler.terminateThreadByHandle(hThread, exitCode);
        if (!ok) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
        }
        return { value: ok ? 1 : 0, stackCleanup: 8 };
    },

    'GetExitCodeThread': (ctx, mem, args) => {
        const hThread = args[0];
        const lpExitCode = args[1];
        const manager = getVirtualProcessManager();
        const virtualExitCode = manager.getExitCodeThread(hThread);

        if (virtualExitCode !== null) {
            if (lpExitCode && lpExitCode + 4 <= mem.length) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(lpExitCode, virtualExitCode >>> 0, true);
            }
            return { value: 1, stackCleanup: 8 };
        }

        const sched = System.getInstance().scheduler;
        const threadInfo = sched.getThreadInfoByHandle(hThread);

        if (!threadInfo) {
            Logger.log(LogCategory.KERNEL32,
                `GetExitCodeThread(hThread=0x${hThread.toString(16)}) -> INVALID_HANDLE`);
            sched.setLastError(6);  // ERROR_INVALID_HANDLE
            return { value: 0, stackCleanup: 8 };  // FALSE
        }

        let exitCode: number;
        if (threadInfo.state === ThreadState.TERMINATED) {
            exitCode = threadInfo.exitCode ?? 0;
        } else {
            exitCode = STILL_ACTIVE;
        }

        if (lpExitCode && lpExitCode + 4 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lpExitCode, exitCode, true);
        }

        Logger.log(LogCategory.KERNEL32,
            `GetExitCodeThread(hThread=0x${hThread.toString(16)}) -> exitCode=${exitCode === STILL_ACTIVE ? 'STILL_ACTIVE' : exitCode} state=${threadInfo.state}`);

        return { value: 1, stackCleanup: 8 };  // TRUE
    },

    'GetExitCodeProcess': (ctx, mem, args) => {
        const hProcess = args[0] >>> 0;
        const lpExitCode = args[1] >>> 0;
        let exitCode: number | null = null;

        if (hProcess === CURRENT_PROCESS_PSEUDO_HANDLE) {
            exitCode = STILL_ACTIVE;
        } else {
            exitCode = getVirtualProcessManager().getExitCodeProcess(hProcess);
        }

        if (exitCode === null) {
            Logger.log(LogCategory.KERNEL32,
                `GetExitCodeProcess(hProcess=0x${hProcess.toString(16)}) -> INVALID_HANDLE`);
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return { value: 0, stackCleanup: 8 };
        }

        if (!lpExitCode || !Mem.writeUint32(lpExitCode, exitCode >>> 0)) {
            Logger.warn(LogCategory.KERNEL32,
                `GetExitCodeProcess: invalid lpExitCode pointer 0x${lpExitCode.toString(16)}`);
            System.getInstance().scheduler.setLastError(87); // ERROR_INVALID_PARAMETER
            return { value: 0, stackCleanup: 8 }; // FALSE
        }

        Logger.verbose(
            LogCategory.KERNEL32,
            `GetExitCodeProcess(hProcess=0x${hProcess.toString(16)}) -> ${exitCode === STILL_ACTIVE ? 'STILL_ACTIVE' : exitCode}`
        );
        return { value: 1, stackCleanup: 8 }; // TRUE
    },

    'GetProcessWorkingSetSize': (ctx, mem, args) => {
        const hProcess = args[0] >>> 0;
        const lpMinimumWorkingSetSize = args[1] >>> 0;
        const lpMaximumWorkingSetSize = args[2] >>> 0;

        if (!isCurrentProcessHandle(hProcess)) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return { value: 0, stackCleanup: 12 }; // FALSE
        }

        if (!lpMinimumWorkingSetSize || !lpMaximumWorkingSetSize) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 12 }; // FALSE
        }

        const minOk = Mem.writeUint32(lpMinimumWorkingSetSize, DEFAULT_MIN_WORKING_SET_BYTES);
        const maxOk = Mem.writeUint32(lpMaximumWorkingSetSize, DEFAULT_MAX_WORKING_SET_BYTES);

        if (!minOk || !maxOk) {
            Logger.warn(
                LogCategory.KERNEL32,
                `GetProcessWorkingSetSize: invalid pointers min=0x${lpMinimumWorkingSetSize.toString(16)} max=0x${lpMaximumWorkingSetSize.toString(16)}`
            );
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 12 }; // FALSE
        }

        Logger.verbose(
            LogCategory.KERNEL32,
            `GetProcessWorkingSetSize(current process) -> min=${DEFAULT_MIN_WORKING_SET_BYTES}, max=${DEFAULT_MAX_WORKING_SET_BYTES}`
        );
        return { value: 1, stackCleanup: 12 }; // TRUE
    },

    'IsDebuggerPresent': (ctx, mem, args) => {
        return 0; // No debugger
    },

    'GetVersion': (ctx, mem, args) => {
        const emulatorConfig = EmulatorConfig.getInstance();
        const versionValue = emulatorConfig.getVersionValue();
        Logger.verbose(
            LogCategory.KERNEL32,
            `GetVersion() -> ${emulatorConfig.osVersion.major}.${emulatorConfig.osVersion.minor} (0x${versionValue.toString(16)})`
        );
        return versionValue;
    },

    // Some linkers import GetVersionEx (macro) without the A suffix.
    'GetVersionEx': (ctx, mem, args) => fillVersionExA(mem, args[0], 'GetVersionEx'),

    'GetVersionExA': (ctx, mem, args) => fillVersionExA(mem, args[0], 'GetVersionExA'),

    'GetVersionExW': (ctx, mem, args) => fillVersionExW(mem, args[0], 'GetVersionExW'),

    'SetThreadPriority': (ctx, mem, args) => {
        const hThread = args[0];
        const nPriority = args[1]; // Signed int

        Logger.verbose(LogCategory.KERNEL32, `SetThreadPriority(hThread=0x${hThread.toString(16)}, nPriority=${nPriority})`);

        const success = System.getInstance().scheduler.setThreadPriority(hThread, nPriority);
        return { value: success ? 1 : 0, stackCleanup: 8 }; // BOOL: TRUE (1) or FALSE (0)
    },

    // BOOL SetPriorityClass(HANDLE hProcess, DWORD dwPriorityClass)
    'SetPriorityClass': (ctx, mem, args) => {
        const hProcess = args[0] >>> 0;
        const priorityClass = args[1] >>> 0;

        if (!isCurrentProcessHandle(hProcess)) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return { value: 0, stackCleanup: 8 };
        }

        const valid = priorityClass === IDLE_PRIORITY_CLASS ||
            priorityClass === BELOW_NORMAL_PRIORITY_CLASS ||
            priorityClass === NORMAL_PRIORITY_CLASS ||
            priorityClass === ABOVE_NORMAL_PRIORITY_CLASS ||
            priorityClass === HIGH_PRIORITY_CLASS ||
            priorityClass === REALTIME_PRIORITY_CLASS;

        if (!valid) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 8 };
        }

        currentPriorityClass = priorityClass;
        Logger.verbose(LogCategory.KERNEL32, `SetPriorityClass(hProcess=CURRENT_PROCESS, class=0x${priorityClass.toString(16)})`);
        return { value: 1, stackCleanup: 8 };
    },

    // DWORD GetPriorityClass(HANDLE hProcess)
    'GetPriorityClass': (ctx, mem, args) => {
        const hProcess = args[0] >>> 0;

        if (!isCurrentProcessHandle(hProcess)) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return { value: 0, stackCleanup: 4 };
        }

        return { value: currentPriorityClass >>> 0, stackCleanup: 4 };
    },

    // BOOL GetThreadTimes(HANDLE hThread, LPFILETIME lpCreationTime, LPFILETIME lpExitTime,
    //                     LPFILETIME lpKernelTime, LPFILETIME lpUserTime)
    // Stub: fill all FILETIME structs with zeros (each is 8 bytes: dwLowDateTime + dwHighDateTime)
    'GetThreadTimes': (ctx, mem, args) => {
        const ptrs = [args[1], args[2], args[3], args[4]];
        for (const ptr of ptrs) {
            if (ptr) {
                Mem.writeUint32(ptr, 0);
                Mem.writeUint32(ptr + 4, 0);
            }
        }
        return { value: 1, stackCleanup: 20 };
    },

    // int GetThreadPriority(HANDLE hThread)
    // Returns thread priority or THREAD_PRIORITY_ERROR_RETURN (0x7FFFFFFF) on failure.
    'GetThreadPriority': (ctx, mem, args) => {
        const hThread = args[0];
        const priority = System.getInstance().scheduler.getThreadPriority(hThread);
        if (priority === null) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return { value: 0x7FFFFFFF, stackCleanup: 4 }; // THREAD_PRIORITY_ERROR_RETURN
        }
        return { value: priority, stackCleanup: 4 };
    },

    // DWORD SuspendThread(HANDLE hThread)
    // Returns previous suspend count, or 0xFFFFFFFF on failure.
    'SuspendThread': (ctx, mem, args) => {
        const hThread = args[0];
        const system = System.getInstance();
        const manager = getVirtualProcessManager();
        const virtualPrev = manager.suspendThread(hThread);
        const prevCount = virtualPrev !== null
            ? virtualPrev
            : system.scheduler.suspendThread(hThread);
        if (prevCount === 0xFFFFFFFF) {
            system.scheduler.setLastError(ERROR_INVALID_HANDLE);
        }
        Logger.log(LogCategory.KERNEL32,
            `SuspendThread(hThread=0x${hThread.toString(16)}) -> ${prevCount === 0xFFFFFFFF ? 'INVALID_HANDLE' : prevCount}`);
        return { value: prevCount, stackCleanup: 4 };
    },

    // BOOL GetThreadContext(HANDLE hThread, LPCONTEXT lpContext)
    // x86 CONTEXT offsets: ContextFlags +0, Dr0-Dr3 +4-16, Dr6 +20, Dr7 +24,
    // FloatSave +28 (112 bytes), SegGs +140, SegFs +144, SegEs +148, SegDs +152,
    // Edi +156, Esi +160, Ebx +164, Edx +168, Ecx +172, Eax +176,
    // Ebp +180, Eip +184, SegCs +188, EFlags +192, Esp +196, SegSs +200
    'GetThreadContext': (ctx, mem, args) => {
        const hThread = args[0];
        const lpContext = args[1] >>> 0;

        if (!lpContext || lpContext + 204 > mem.length) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 8 };
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const contextFlags = view.getUint32(lpContext, true);

        const schedulerCtx = System.getInstance().scheduler.getThreadContext(hThread);
        const threadCtx = schedulerCtx ?? getVirtualProcessManager().getThreadContext(hThread >>> 0);
        if (!threadCtx) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return { value: 0, stackCleanup: 8 };
        }

        const CONTEXT_INTEGER = 0x00010002;
        const CONTEXT_CONTROL = 0x00010001;
        const CONTEXT_SEGMENTS = 0x00010004;

        if (contextFlags & CONTEXT_INTEGER) {
            view.setUint32(lpContext + 156, threadCtx.edi, true);
            view.setUint32(lpContext + 160, threadCtx.esi, true);
            view.setUint32(lpContext + 164, threadCtx.ebx, true);
            view.setUint32(lpContext + 168, threadCtx.edx, true);
            view.setUint32(lpContext + 172, threadCtx.ecx, true);
            view.setUint32(lpContext + 176, threadCtx.eax, true);
        }
        if (contextFlags & CONTEXT_CONTROL) {
            view.setUint32(lpContext + 180, threadCtx.ebp, true);
            view.setUint32(lpContext + 184, threadCtx.eip, true);
            view.setUint32(lpContext + 188, 0x08, true);  // SegCs = code selector
            view.setUint32(lpContext + 192, threadCtx.eflags, true);
            view.setUint32(lpContext + 196, threadCtx.esp, true);
            view.setUint32(lpContext + 200, 0x10, true);  // SegSs = data selector
        }
        if (contextFlags & CONTEXT_SEGMENTS) {
            view.setUint32(lpContext + 140, 0x10, true);  // SegGs
            view.setUint32(lpContext + 144, 0x18, true);  // SegFs = TEB selector
            view.setUint32(lpContext + 148, 0x10, true);  // SegEs
            view.setUint32(lpContext + 152, 0x10, true);  // SegDs
        }

        return { value: 1, stackCleanup: 8 }; // TRUE
    },

    // BOOL SetThreadContext(HANDLE hThread, const CONTEXT *lpContext)
    'SetThreadContext': (ctx, mem, args) => {
        const hThread = args[0];
        const lpContext = args[1] >>> 0;

        if (!lpContext || lpContext + 204 > mem.length) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 8 };
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const contextFlags = view.getUint32(lpContext, true);

        const partial: Record<string, number> = {};
        const CONTEXT_INTEGER = 0x00010002;
        const CONTEXT_CONTROL = 0x00010001;

        if (contextFlags & CONTEXT_INTEGER) {
            partial.edi = view.getUint32(lpContext + 156, true);
            partial.esi = view.getUint32(lpContext + 160, true);
            partial.ebx = view.getUint32(lpContext + 164, true);
            partial.edx = view.getUint32(lpContext + 168, true);
            partial.ecx = view.getUint32(lpContext + 172, true);
            partial.eax = view.getUint32(lpContext + 176, true);
        }
        if (contextFlags & CONTEXT_CONTROL) {
            partial.ebp = view.getUint32(lpContext + 180, true);
            partial.eip = view.getUint32(lpContext + 184, true);
            partial.eflags = view.getUint32(lpContext + 192, true);
            partial.esp = view.getUint32(lpContext + 196, true);
        }

        const success =
            System.getInstance().scheduler.setThreadContext(hThread, partial, contextFlags) ||
            getVirtualProcessManager().setThreadContext(hThread >>> 0, partial);
        if (!success) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
        }
        return { value: success ? 1 : 0, stackCleanup: 8 };
    },

    'DuplicateHandle': (ctx, mem, args) => {
        const hSourceProcessHandle = args[0];
        const hSourceHandle = args[1];
        const hTargetProcessHandle = args[2];
        const lpTargetHandle = args[3];
        const _dwDesiredAccess = args[4] >>> 0;
        const _bInheritHandle = args[5] !== 0;
        const dwOptions = args[6] >>> 0;

        const DUPLICATE_CLOSE_SOURCE = 0x00000001;
        const _DUPLICATE_SAME_ACCESS = 0x00000002;

        Logger.verbose(LogCategory.KERNEL32,
            `DuplicateHandle(srcProc=0x${hSourceProcessHandle.toString(16)}, srcHandle=0x${hSourceHandle.toString(16)}, ` +
            `tgtProc=0x${hTargetProcessHandle.toString(16)}, options=0x${dwOptions.toString(16)})`);

        // Pseudo-handle for current process is 0xFFFFFFFF (-1)
        const CURRENT_PROCESS = 0xFFFFFFFF;
        const CURRENT_THREAD = 0xFFFFFFFE;

        let targetHandle = hSourceHandle;
        let duplicatedVirtual = false;

        // Handle pseudo-handles (current process/thread)
        if (hSourceHandle === CURRENT_PROCESS) {
            const currentProcAlias = getVirtualProcessManager().openProcessById(CURRENT_PROCESS_ID);
            targetHandle = currentProcAlias !== 0 ? (currentProcAlias >>> 0) : CURRENT_PROCESS;
        } else if (hSourceHandle === CURRENT_THREAD) {
            const sched = System.getInstance().scheduler;
            const currentThread = sched.getCurrentThread();
            if (currentThread) {
                const resourceProvider = System.getInstance().resourceProvider;
                const threadResource = resourceProvider.getResource(currentThread.handle >>> 0);
                if (threadResource?.type === 'kernel_object') {
                    targetHandle = resourceProvider.registerKernelObject(threadResource.resource) >>> 0;
                } else {
                    targetHandle = currentThread.handle >>> 0;
                }
            } else {
                targetHandle = CURRENT_THREAD;
            }
        } else {
            const manager = getVirtualProcessManager();
            const duplicated = manager.duplicateHandle(hSourceHandle >>> 0);
            if (duplicated !== null) {
                targetHandle = duplicated >>> 0;
                duplicatedVirtual = true;
            } else {
                const resourceProvider = System.getInstance().resourceProvider;
                const resource = resourceProvider.getResource(hSourceHandle >>> 0);
                if (resource?.type === 'kernel_object') {
                    // Create an alias handle to the same kernel object payload.
                    targetHandle = resourceProvider.registerKernelObject(resource.resource) >>> 0;
                } else {
                    // Fallback for non-virtual handles: preserve legacy behavior.
                    targetHandle = hSourceHandle;
                }
            }
        }

        // Write the target handle to the output parameter
        if (lpTargetHandle !== 0 && lpTargetHandle + 4 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lpTargetHandle, targetHandle >>> 0, true);
        } else if (lpTargetHandle !== 0) {
            Logger.warn(LogCategory.KERNEL32, `DuplicateHandle: Invalid lpTargetHandle pointer 0x${lpTargetHandle.toString(16)}`);
            System.getInstance().scheduler.setLastError(6); // ERROR_INVALID_HANDLE
            return { value: 0, stackCleanup: 28 }; // FALSE
        }

        // Handle DUPLICATE_CLOSE_SOURCE option
        if (dwOptions & DUPLICATE_CLOSE_SOURCE) {
            Logger.verbose(LogCategory.KERNEL32, `DuplicateHandle: DUPLICATE_CLOSE_SOURCE requested for handle 0x${hSourceHandle.toString(16)}`);
            if (duplicatedVirtual) {
                // Best-effort close for virtual process/thread handles.
                System.getInstance().resourceProvider.unregisterKernelObject(hSourceHandle >>> 0);
            }
        }

        Logger.log(
            LogCategory.KERNEL32,
            `DuplicateHandle(src=0x${hSourceHandle.toString(16)}) -> 0x${(targetHandle >>> 0).toString(16)}`
        );
        System.getInstance().scheduler.setLastError(0);
        return { value: 1, stackCleanup: 28 }; // TRUE = success
    },

    'GetProcessVersion': (ctx, mem, args) => {
        const processId = args[0];

        Logger.verbose(LogCategory.KERNEL32, `GetProcessVersion(processId=${processId})`);

        // Return Windows version in the format expected by GetProcessVersion
        // High word = minor version, low word = major version
        // For Windows 95/98/ME: major=4, minor=0-90
        // For Windows NT/2000/XP: return value from GetVersion

        const emulatorConfig = EmulatorConfig.getInstance();

        // Construct version DWORD: low word = major, high word = minor
        const versionDword = (emulatorConfig.osVersion.minor << 16) | emulatorConfig.osVersion.major;

        Logger.verbose(LogCategory.KERNEL32,
            `GetProcessVersion: Returning version ${emulatorConfig.osVersion.major}.${emulatorConfig.osVersion.minor} (0x${versionDword.toString(16)})`);

        return versionDword >>> 0; // Unsigned 32-bit
    },

    'AreFileApisANSI': () => {
        return 1; // TRUE
    },

    'SetProcessAffinityMask': (ctx, mem, args) => {
        return 1; // TRUE
    },

    'GetProcessAffinityMask': (ctx, mem, args) => {
        const lpProcessAffinityMask = args[1] >>> 0;
        const lpSystemAffinityMask = args[2] >>> 0;
        if (lpProcessAffinityMask) Mem.writeUint32(lpProcessAffinityMask, 1);
        if (lpSystemAffinityMask) Mem.writeUint32(lpSystemAffinityMask, 1);
        return 1; // TRUE
    },

    'GetLogicalProcessorInformation': (ctx, mem, args) => {
        const bufferPtr = args[0] >>> 0;
        const returnLengthPtr = args[1] >>> 0;
        const required = 24; // sizeof(SYSTEM_LOGICAL_PROCESSOR_INFORMATION) on x86

        if (returnLengthPtr) {
            Mem.writeUint32(returnLengthPtr, required);
        }

        if (!bufferPtr) {
            System.getInstance().process!.lastError = 122; // ERROR_INSUFFICIENT_BUFFER
            return 0;
        }

        const length = Mem.readUint32(returnLengthPtr) ?? 0;
        if (length < required) {
            System.getInstance().process!.lastError = 122;
            return 0;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(bufferPtr + 0, 1, true); // ProcessorMask
        view.setUint32(bufferPtr + 4, 0, true); // Relationship = RelationProcessorCore
        for (let i = 8; i < required; i += 4) {
            view.setUint32(bufferPtr + i, 0, true);
        }
        return 1;
    },

    'SetProcessPriorityBoost': (ctx, mem, args) => {
        return 1; // TRUE
    },

    'SetThreadPriorityBoost': (ctx, mem, args) => {
        return 1; // TRUE
    },

    // EXECUTION_STATE SetThreadExecutionState(EXECUTION_STATE esFlags)
    // Notifies the OS that the thread needs display/system resources and should not
    // be subject to power management (sleep / display-off). There is no real host
    // sleep policy to control from inside the emulator, so we track the state and
    // return the previous value — exactly what Windows does on success.
    // ES_CONTINUOUS (0x80000000) persists a request; without it the call is a one-shot
    // hint whose value we do NOT persist (matching Windows behaviour).
    // Returns NULL only for unrecognised flag bits (to be safe with paranoid callers).
    'SetThreadExecutionState': (ctx, mem, args) => {
        const ES_SYSTEM_REQUIRED   = 0x00000001;
        const ES_DISPLAY_REQUIRED  = 0x00000002;
        const ES_USER_PRESENT      = 0x00000004; // legacy/obsolete, still accepted
        const ES_AWAYMODE_REQUIRED = 0x00000040;
        const ES_CONTINUOUS        = 0x80000000;
        const ES_KNOWN_MASK        =
            ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED | ES_USER_PRESENT |
            ES_AWAYMODE_REQUIRED | ES_CONTINUOUS;

        const esFlags   = args[0] >>> 0;
        const previous  = threadExecutionState >>> 0;

        const unknownBits = esFlags & ~ES_KNOWN_MASK;
        if (unknownBits !== 0) {
            Logger.warn(
                LogCategory.KERNEL32,
                `SetThreadExecutionState(flags=0x${esFlags.toString(16)}) -> NULL (unknown bits 0x${unknownBits.toString(16)})`
            );
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 4 }; // NULL
        }

        // ES_CONTINUOUS makes the new state persistent; without it this is a one-shot hint.
        if (esFlags & ES_CONTINUOUS) {
            threadExecutionState = esFlags;
        }
        // Non-continuous: don't persist; return previous as Windows does.

        Logger.verbose(
            LogCategory.KERNEL32,
            `SetThreadExecutionState(flags=0x${esFlags.toString(16)}) -> previous=0x${previous.toString(16)}`
        );
        System.getInstance().scheduler.setLastError(0);
        return { value: previous, stackCleanup: 4 };
    },

    ...versionVerifyExports,

    // BOOL FlushInstructionCache(HANDLE hProcess, LPCVOID lpBaseAddress, SIZE_T dwSize)
    // A no-op on real x86 (the pipeline is coherent), but here it is the guest telling us
    // exactly which bytes it just rewrote — and v86's block cache is not coherent with a
    // write it did not see (a JS-side patch, or a store through an alias). Honour it.
    // dwSize 0 / NULL base means "the whole process" per the SDK.
    'FlushInstructionCache': (ctx, mem, args) => {
        const lpBaseAddress = args[1] >>> 0;
        const dwSize = args[2] >>> 0;
        if (lpBaseAddress && dwSize) invalidateGuestCode(lpBaseAddress, dwSize);
        else invalidateAllGuestCode();
        return 1; // TRUE
    },

    'GetSystemDirectoryA': (ctx, mem, args) => {
        const lpBuffer = args[0];
        const uSize = args[1];

        const sysDir = 'C:\\WINDOWS\\SYSTEM';

        if (!lpBuffer || uSize === 0) {
            // Return required buffer size (including null terminator)
            return sysDir.length + 1;
        }

        if (uSize < sysDir.length + 1) {
            // Buffer too small — return required size
            return sysDir.length + 1;
        }

        const sysDirBytes = encodeAnsi(sysDir);
        mem.set(sysDirBytes, lpBuffer);
        mem[lpBuffer + sysDirBytes.length] = 0;

        return sysDirBytes.length;
    },

    'GetSystemDirectoryW': (ctx, mem, args) => {
        const lpBuffer = args[0];
        const uSize = args[1];

        const sysDir = 'C:\\WINDOWS\\SYSTEM';

        if (!lpBuffer || uSize === 0) {
            return sysDir.length + 1;
        }

        if (uSize < sysDir.length + 1) {
            return sysDir.length + 1;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < sysDir.length; i++) {
            view.setUint16(lpBuffer + i * 2, sysDir.charCodeAt(i), true);
        }
        view.setUint16(lpBuffer + sysDir.length * 2, 0, true);

        return sysDir.length;
    },

    'GetWindowsDirectoryA': (ctx, mem, args) => {
        const lpBuffer = args[0];
        const uSize = args[1];

        const winDir = 'C:\\WINDOWS';

        if (!lpBuffer || uSize === 0) {
            return winDir.length + 1;
        }

        if (uSize < winDir.length + 1) {
            return winDir.length + 1;
        }

        const winDirBytes = encodeAnsi(winDir);
        mem.set(winDirBytes, lpBuffer);
        mem[lpBuffer + winDirBytes.length] = 0;

        return winDirBytes.length;
    },

    'GetWindowsDirectoryW': (ctx, mem, args) => {
        const lpBuffer = args[0];
        const uSize = args[1];

        const winDir = 'C:\\WINDOWS';

        if (!lpBuffer || uSize === 0) {
            return winDir.length + 1;
        }

        if (uSize < winDir.length + 1) {
            return winDir.length + 1;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < winDir.length; i++) {
            view.setUint16(lpBuffer + i * 2, winDir.charCodeAt(i), true);
        }
        view.setUint16(lpBuffer + winDir.length * 2, 0, true);

        return winDir.length;
    },

    'GetComputerNameA': (ctx, mem, args) => {
        const lpBuffer = args[0];
        const lpnSize = args[1];

        const name = 'BOTTLESHIP';

        if (!lpBuffer || !lpnSize) {
            return 0; // FALSE
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const bufSize = view.getUint32(lpnSize, true);

        if (bufSize < name.length + 1) {
            // Set required size and fail
            view.setUint32(lpnSize, name.length + 1, true);
            System.getInstance().scheduler.setLastError(111); // ERROR_BUFFER_OVERFLOW
            return 0; // FALSE
        }

        const nameBytes = encodeAnsi(name);
        mem.set(nameBytes, lpBuffer);
        mem[lpBuffer + nameBytes.length] = 0;
        view.setUint32(lpnSize, nameBytes.length, true);

        return 1; // TRUE
    },

    'GetComputerNameW': (ctx, mem, args) => {
        const lpBuffer = args[0];
        const lpnSize = args[1];

        const name = 'BOTTLESHIP';

        if (!lpBuffer || !lpnSize) {
            return 0; // FALSE
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const bufSize = view.getUint32(lpnSize, true);

        if (bufSize < name.length + 1) {
            view.setUint32(lpnSize, name.length + 1, true);
            System.getInstance().scheduler.setLastError(111); // ERROR_BUFFER_OVERFLOW
            return 0; // FALSE
        }

        for (let i = 0; i < name.length; i++) {
            view.setUint16(lpBuffer + i * 2, name.charCodeAt(i), true);
        }
        view.setUint16(lpBuffer + name.length * 2, 0, true);
        view.setUint32(lpnSize, name.length, true);

        return 1; // TRUE
    },

    // ==================== Toolhelp32 Snapshot API ====================

    'CreateToolhelp32Snapshot': (ctx, mem, args) => {
        const dwFlags = args[0] >>> 0;
        const th32ProcessID = args[1] >>> 0;

        const system = System.getInstance();
        const sched = system.scheduler;
        const manager = getVirtualProcessManager();
        const TH32CS_SNAPPROCESS = 0x2;
        const TH32CS_SNAPTHREAD = 0x4;
        const TH32CS_SNAPMODULE = 0x8;
        const OUR_PID = CURRENT_PROCESS_ID;

        // Build process list
        const processes: ToolhelpSnapshot['processes'] = [];
        if (dwFlags & TH32CS_SNAPPROCESS) {
            for (const p of manager.listProcessSnapshotEntries()) {
                processes.push({ pid: p.pid, parentPid: p.parentPid, exeName: p.exeName });
            }
            if (!processes.some(p => p.pid === OUR_PID)) {
                processes.unshift({ pid: OUR_PID, parentPid: 0, exeName: system.executableName });
            }
        }

        // Build thread list
        const threads: ToolhelpSnapshot['threads'] = [];
        if (dwFlags & TH32CS_SNAPTHREAD) {
            for (const t of sched.getAllThreadInfo()) {
                threads.push({ tid: t.id, ownerPid: OUR_PID, basePri: t.priority });
            }
            for (const t of manager.listThreadSnapshotEntries()) {
                threads.push({ tid: t.tid, ownerPid: t.ownerPid, basePri: t.basePri });
            }
        }

        // Build module list
        const modules: ToolhelpSnapshot['modules'] = [];
        if (dwFlags & TH32CS_SNAPMODULE) {
            const modRegistry = system.process?.moduleRegistry;
            if (modRegistry) {
                for (const m of modRegistry.getAllModules()) {
                    if (m.isRealDll || m.name.toLowerCase() === system.executableName.replace(/\.\w+$/, '').toLowerCase()) {
                        const fileName = m.path ? m.path.split('\\').pop() ?? m.name : m.name;
                        modules.push({
                            name: fileName,
                            path: m.path || `C:\\${fileName}`,
                            baseAddr: m.baseAddress,
                            size: m.size,
                        });
                    }
                }
            }
            // Always ensure the exe itself appears
            if (modules.length === 0 || !modules.some(m => m.name.toLowerCase() === system.executableName.toLowerCase())) {
                modules.unshift({
                    name: system.executableName,
                    path: system.executablePath || `C:\\${system.executableName}`,
                    baseAddr: 0x00400000,
                    size: 0x00100000,
                });
            }
        }

        const snap: ToolhelpSnapshot = {
            flags: dwFlags, pid: th32ProcessID,
            processes, threads, modules,
            procIdx: 0, threadIdx: 0, moduleIdx: 0,
        };

        const resourceProvider = SystemResourceProvider.getInstance();
        const handle = resourceProvider.registerKernelObject({ kind: 'toolhelp_snapshot' });
        toolhelpSnapshots.set(handle, snap);

        Logger.log(LogCategory.KERNEL32,
            `CreateToolhelp32Snapshot(flags=0x${dwFlags.toString(16)}, pid=${th32ProcessID}) -> 0x${handle.toString(16)} ` +
            `(${processes.length} procs, ${threads.length} threads, ${modules.length} modules)`);
        return handle;
    },

    'Process32First': (ctx, mem, args) => {
        return process32Impl(mem, args[0] >>> 0, args[1] >>> 0, true, false);
    },

    'Process32Next': (ctx, mem, args) => {
        return process32Impl(mem, args[0] >>> 0, args[1] >>> 0, false, false);
    },

    'Process32FirstW': (ctx, mem, args) => {
        return process32Impl(mem, args[0] >>> 0, args[1] >>> 0, true, true);
    },

    'Process32NextW': (ctx, mem, args) => {
        return process32Impl(mem, args[0] >>> 0, args[1] >>> 0, false, true);
    },

    'Thread32First': (ctx, mem, args) => {
        return thread32Impl(mem, args[0] >>> 0, args[1] >>> 0, true);
    },

    'Thread32Next': (ctx, mem, args) => {
        return thread32Impl(mem, args[0] >>> 0, args[1] >>> 0, false);
    },

    'Module32First': (ctx, mem, args) => {
        return module32AImpl(mem, args[0] >>> 0, args[1] >>> 0, true);
    },

    'Module32Next': (ctx, mem, args) => {
        return module32AImpl(mem, args[0] >>> 0, args[1] >>> 0, false);
    },

    'Module32FirstW': (ctx, mem, args) => {
        return module32WImpl(mem, args[0] >>> 0, args[1] >>> 0, true);
    },

    'Module32NextW': (ctx, mem, args) => {
        return module32WImpl(mem, args[0] >>> 0, args[1] >>> 0, false);
    },

    // Heap enumeration stubs — return FALSE (ERROR_NO_MORE_FILES).
    // Real Windows enumerates process heaps; we fake "no heaps" which satisfies
    // most callers that just iterate until FALSE.
    'Heap32ListFirst': (ctx, mem, args) => {
        System.getInstance().scheduler.setLastError(18); // ERROR_NO_MORE_FILES
        return 0;
    },
    'Heap32ListNext': (ctx, mem, args) => {
        System.getInstance().scheduler.setLastError(18);
        return 0;
    },
    'Heap32First': (ctx, mem, args) => {
        System.getInstance().scheduler.setLastError(18);
        return 0;
    },
    'Heap32Next': (ctx, mem, args) => {
        System.getInstance().scheduler.setLastError(18);
        return 0;
    },

    // ==================== Process/Thread Handle API ====================

    'OpenProcess': (ctx, mem, args) => {
        const dwDesiredAccess = args[0];
        const bInheritHandle = args[1];
        const dwProcessId = args[2];
        const manager = getVirtualProcessManager();
        Logger.verbose(LogCategory.KERNEL32,
            `OpenProcess(access=0x${dwDesiredAccess.toString(16)}, inherit=${bInheritHandle}, pid=${dwProcessId})`);
        const handle = manager.openProcessById(dwProcessId >>> 0);
        if (handle !== 0) {
            Logger.log(
                LogCategory.KERNEL32,
                `OpenProcess(pid=${dwProcessId}) -> 0x${(handle >>> 0).toString(16)}`
            );
            return handle >>> 0;
        }
        System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
        return 0; // NULL
    },

    'OpenThread': (ctx, mem, args) => {
        const dwDesiredAccess = args[0];
        const bInheritHandle = args[1];
        const dwThreadId = args[2];
        const manager = getVirtualProcessManager();
        Logger.verbose(LogCategory.KERNEL32,
            `OpenThread(access=0x${dwDesiredAccess.toString(16)}, inherit=${bInheritHandle}, tid=${dwThreadId})`);
        const handle = manager.openThreadById(dwThreadId >>> 0);
        if (handle !== 0) {
            Logger.log(
                LogCategory.KERNEL32,
                `OpenThread(tid=${dwThreadId}) -> 0x${(handle >>> 0).toString(16)}`
            );
            return handle >>> 0;
        }
        System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
        return 0; // NULL
    },

    'GetProcessId': (ctx, mem, args) => {
        const hProcess = args[0] >>> 0;
        if (hProcess === CURRENT_PROCESS_PSEUDO_HANDLE) {
            return CURRENT_PROCESS_ID;
        }
        const pid = getVirtualProcessManager().getProcessIdByHandle(hProcess);
        if (pid !== null) {
            return pid >>> 0;
        }
        System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
        return 0;
    },

    'ReadProcessMemory': (ctx, mem, args) => {
        const hProcess = args[0] >>> 0;
        const lpBaseAddress = args[1] >>> 0;
        const lpBuffer = args[2] >>> 0;
        const nSize = args[3] >>> 0;
        const lpNumberOfBytesRead = args[4] >>> 0;
        Logger.verbose(
            LogCategory.KERNEL32,
            `ReadProcessMemory(hProcess=0x${hProcess.toString(16)}, base=0x${lpBaseAddress.toString(16)}, size=${nSize})`
        );

        if (!isKnownProcessHandle(hProcess)) {
            Logger.warn(
                LogCategory.KERNEL32,
                `ReadProcessMemory invalid handle hProcess=0x${hProcess.toString(16)}`
            );
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }

        if (nSize === 0) {
            if (lpNumberOfBytesRead) {
                Mem.writeUint32(lpNumberOfBytesRead, 0);
            }
            return 1;
        }

        if (!lpBaseAddress || !lpBuffer) {
            Logger.warn(
                LogCategory.KERNEL32,
                `ReadProcessMemory invalid params base=0x${lpBaseAddress.toString(16)} buffer=0x${lpBuffer.toString(16)} size=${nSize}`
            );
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        const pid = getVirtualProcessPid(hProcess);
        const isVirtualChild = isVirtualChildProcessHandle(hProcess) && pid !== null;
        const source = isVirtualChild
            ? readVirtualProcessMemory(pid, lpBaseAddress, nSize)
            : Mem.readBytes(lpBaseAddress, nSize);
        if (isVirtualChild) {
            Logger.verbose(
                LogCategory.KERNEL32,
                `ReadProcessMemory virtual child pid=${pid} base=0x${lpBaseAddress.toString(16)} size=${nSize}`
            );
        }
        if (!source) {
            Logger.warn(
                LogCategory.KERNEL32,
                `ReadProcessMemory partial copy (unreadable source) base=0x${lpBaseAddress.toString(16)} size=${nSize}`
            );
            if (lpNumberOfBytesRead) {
                Mem.writeUint32(lpNumberOfBytesRead, 0);
            }
            System.getInstance().scheduler.setLastError(ERROR_PARTIAL_COPY);
            return 0;
        }

        const snapshot = new Uint8Array(source);
        const copied = Mem.writeBytes(lpBuffer, snapshot);
        if (copied !== nSize) {
            Logger.warn(
                LogCategory.KERNEL32,
                `ReadProcessMemory partial copy copied=${copied} expected=${nSize} dst=0x${lpBuffer.toString(16)}`
            );
            if (lpNumberOfBytesRead) {
                Mem.writeUint32(lpNumberOfBytesRead, copied >>> 0);
            }
            System.getInstance().scheduler.setLastError(ERROR_PARTIAL_COPY);
            return 0;
        }

        if (lpNumberOfBytesRead) {
            Mem.writeUint32(lpNumberOfBytesRead, copied >>> 0);
        }

        System.getInstance().scheduler.setLastError(0);
        return 1;
    },

    // DWORD_PTR SetThreadAffinityMask(HANDLE hThread, DWORD_PTR dwThreadAffinityMask)
    // Returns previous mask (1 = single CPU); 0 on failure
    'SetThreadAffinityMask': () => 1,

    // BOOL SetProcessDEPPolicy(DWORD dwFlags)
    // DEP is irrelevant in emulation — always succeed
    'SetProcessDEPPolicy': () => 1,

    // BOOL SetAppCompatData(DWORD dwType, DWORD_PTR dwData)
    // Undocumented appcompat hook. Legacy games probe it via GetProcAddress;
    // accepting the call keeps the shim path non-fatal without changing state.
    'SetAppCompatData': (ctx, mem, args) => {
        Logger.verbose(
            LogCategory.KERNEL32,
            `SetAppCompatData(type=0x${(args[0] >>> 0).toString(16)}, data=0x${(args[1] >>> 0).toString(16)}) -> TRUE`
        );
        System.getInstance().scheduler.setLastError(0);
        return 1;
    },

    // BOOL SwitchToThread()
    // Yields to another ready thread; returns TRUE if one was scheduled, FALSE otherwise
    'SwitchToThread': () => {
        const sched = System.getInstance().scheduler;
        const currentTid = sched.getCurrentThreadId();
        if (sched.hasOtherRunnableThreads(currentTid)) {
            sched.requestSwitch();
            return 1; // TRUE — another thread was available
        }
        return 0; // FALSE — no other runnable threads
    },

    // BOOL K32GetProcessMemoryInfo(HANDLE Process, PPROCESS_MEMORY_COUNTERS ppsmemCounters, DWORD cb)
    // Fills PROCESS_MEMORY_COUNTERS (40 bytes on x86)
    'K32GetProcessMemoryInfo': (ctx, mem, args) => {
        const ppsmemCounters = args[1] >>> 0;
        const cb = args[2] >>> 0;

        if (!ppsmemCounters || cb < 40) {
            System.getInstance().scheduler.setLastError(87); // ERROR_INVALID_PARAMETER
            return 0;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(ppsmemCounters + 0, 40, true);       // cb
        view.setUint32(ppsmemCounters + 4, 0, true);        // PageFaultCount
        view.setUint32(ppsmemCounters + 8, 16 * 1024 * 1024, true);  // PeakWorkingSetSize (16 MB)
        view.setUint32(ppsmemCounters + 12, 16 * 1024 * 1024, true); // WorkingSetSize
        view.setUint32(ppsmemCounters + 16, 16 * 1024 * 1024, true); // QuotaPeakPagedPoolUsage
        view.setUint32(ppsmemCounters + 20, 8 * 1024 * 1024, true);  // QuotaPagedPoolUsage
        view.setUint32(ppsmemCounters + 24, 4 * 1024 * 1024, true);  // QuotaPeakNonPagedPoolUsage
        view.setUint32(ppsmemCounters + 28, 2 * 1024 * 1024, true);  // QuotaNonPagedPoolUsage
        view.setUint32(ppsmemCounters + 32, 32 * 1024 * 1024, true); // PagefileUsage
        view.setUint32(ppsmemCounters + 36, 32 * 1024 * 1024, true); // PeakPagefileUsage
        return 1; // TRUE
    },

    // CreateRemoteThread — stub, we only have one process
    // HANDLE CreateRemoteThread(HANDLE hProcess, LPSECURITY_ATTRIBUTES, SIZE_T dwStackSize,
    //   LPTHREAD_START_ROUTINE lpStartAddress, LPVOID lpParameter, DWORD dwCreationFlags, LPDWORD lpThreadId)
    'CreateRemoteThread': (ctx, mem, args) => {
        // hProcess (args[0]) is ignored — treat as CreateThread
        const lpThreadAttributes = args[1];
        const dwStackSize = args[2];
        const lpStartAddress = args[3];
        const lpParameter = args[4];
        const dwCreationFlags = args[5];
        const lpThreadId = args[6];

        Logger.log(LogCategory.KERNEL32,
            `CreateRemoteThread(start=0x${lpStartAddress.toString(16)}, param=0x${lpParameter.toString(16)}) -> forwarding to CreateThread`);

        const sched = System.getInstance().scheduler;
        const handle = sched.createThread(
            lpStartAddress,
            lpParameter,
            dwStackSize,
            dwCreationFlags,
            lpThreadId,
            mem
        );

        if (handle === 0) {
            sched.setLastError(8); // ERROR_NOT_ENOUGH_MEMORY
        }

        return handle;
    },

    // BOOL GetProcessTimes(HANDLE hProcess, LPFILETIME lpCreationTime, LPFILETIME lpExitTime,
    //   LPFILETIME lpKernelTime, LPFILETIME lpUserTime)
    'GetProcessTimes': (ctx, mem, args) => {
        const lpCreationTime = args[1];
        const lpExitTime = args[2];
        const lpKernelTime = args[3];
        const lpUserTime = args[4];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        // Creation time: process start (use a fixed recent time)
        const now = BigInt(Date.now());
        const creationTicks = (now + 11644473600000n) * 10000n;
        if (lpCreationTime) view.setBigUint64(lpCreationTime, creationTicks, true);
        // Exit time: 0 (process still running)
        if (lpExitTime) view.setBigUint64(lpExitTime, 0n, true);

        // kernel/user CPU time MUST ADVANCE between calls. Games (and the
        // CRT clock(), which is backed by GetProcessTimes) measure elapsed time via
        // GetProcessTimes deltas to drive splash-screen / intro timers and frame
        // pacing. Returning a constant made every delta 0, so a
        // `while(clock()-start < duration)` loop never exits when virtual time stalls —
        // monotonic FILETIME deltas are required for clock()-based guest waits.
        // Base on the monotonic wall clock (100ns FILETIME units), ~83% user / 17% kernel.
        const cpuTicks = BigInt(Math.max(0, Math.floor(performance.now()))) * 10000n;
        if (lpKernelTime) view.setBigUint64(lpKernelTime, cpuTicks / 6n, true);
        if (lpUserTime) view.setBigUint64(lpUserTime, (cpuTicks * 5n) / 6n, true);

        return 1; // TRUE
    },

    // BOOL Beep(DWORD dwFreq, DWORD dwDuration)
    // No speaker in emulator — silently succeed
    'Beep': (ctx, mem, args) => {
        Logger.verbose(LogCategory.KERNEL32, `Beep(freq=${args[0]}, duration=${args[1]}) -> stub`);
        return 1; // TRUE
    },

    // BOOL WriteProcessMemory(HANDLE hProcess, LPVOID lpBaseAddress, LPCVOID lpBuffer,
    //   SIZE_T nSize, SIZE_T* lpNumberOfBytesWritten)
    'WriteProcessMemory': (ctx, mem, args) => {
        const hProcess = args[0] >>> 0;
        const lpBaseAddress = args[1] >>> 0;
        const lpBuffer = args[2] >>> 0;
        const nSize = args[3] >>> 0;
        const lpNumberOfBytesWritten = args[4] >>> 0;

        Logger.verbose(
            LogCategory.KERNEL32,
            `WriteProcessMemory(hProcess=0x${hProcess.toString(16)}, dst=0x${lpBaseAddress.toString(16)}, src=0x${lpBuffer.toString(16)}, size=${nSize})`
        );

        if (!isKnownProcessHandle(hProcess)) {
            Logger.warn(
                LogCategory.KERNEL32,
                `WriteProcessMemory invalid handle hProcess=0x${hProcess.toString(16)}`
            );
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }

        if (nSize === 0) {
            if (lpNumberOfBytesWritten) {
                Mem.writeUint32(lpNumberOfBytesWritten, 0);
            }
            return 1;
        }

        if (!lpBaseAddress || !lpBuffer) {
            Logger.warn(
                LogCategory.KERNEL32,
                `WriteProcessMemory invalid params dst=0x${lpBaseAddress.toString(16)} src=0x${lpBuffer.toString(16)} size=${nSize}`
            );
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        const pid = getVirtualProcessPid(hProcess);
        const source = Mem.readBytes(lpBuffer, nSize);
        if (!source) {
            Logger.warn(
                LogCategory.KERNEL32,
                `WriteProcessMemory partial copy (unreadable source) src=0x${lpBuffer.toString(16)} size=${nSize}`
            );
            if (lpNumberOfBytesWritten) {
                Mem.writeUint32(lpNumberOfBytesWritten, 0);
            }
            System.getInstance().scheduler.setLastError(ERROR_PARTIAL_COPY);
            return 0;
        }

        const isVirtualChild = isVirtualChildProcessHandle(hProcess) && pid !== null;
        let copied: number;
        if (isVirtualChild) {
            copied = writeVirtualProcessMemory(pid, lpBaseAddress, source);
        } else {
            // Self-write: the canonical use of WriteProcessMemory is patching live code
            // (import hooks, entry-point detours, allocator interposition). This is a JS
            // write, which v86 cannot observe, so the range must be invalidated in the same
            // turn or the CPU keeps running the blocks it compiled from the pre-patch bytes
            // (§3.1 guest-code coherence).
            copied = Mem.writeBytes(lpBaseAddress, new Uint8Array(source));
            if (copied > 0) invalidateGuestCode(lpBaseAddress, copied);
            // Low volume and always interesting: a self-patch names the detour being installed.
            Logger.log(
                LogCategory.KERNEL32,
                `WriteProcessMemory self-patch dst=0x${lpBaseAddress.toString(16)} size=${copied} ` +
                `bytes=${Array.from(new Uint8Array(source).subarray(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`
            );
        }
        if (isVirtualChild) {
            Logger.verbose(
                LogCategory.KERNEL32,
                `WriteProcessMemory virtual child pid=${pid} dst=0x${lpBaseAddress.toString(16)} size=${nSize}`
            );
        }
        if (copied !== nSize) {
            Logger.warn(
                LogCategory.KERNEL32,
                `WriteProcessMemory partial copy copied=${copied} expected=${nSize} dst=0x${lpBaseAddress.toString(16)}`
            );
            if (lpNumberOfBytesWritten) {
                Mem.writeUint32(lpNumberOfBytesWritten, copied >>> 0);
            }
            System.getInstance().scheduler.setLastError(ERROR_PARTIAL_COPY);
            return 0;
        }

        if (lpNumberOfBytesWritten) {
            Mem.writeUint32(lpNumberOfBytesWritten, copied >>> 0);
        }

        System.getInstance().scheduler.setLastError(0);
        return 1;
    },
};

/**
 * Register FastPath dispatch for SuspendThread/ResumeThread. Some engines (Tin3 /
 * Discworld Noir) use SuspendThread/ResumeThread of a worker thread as a spin-sync
 * primitive (~1.4M calls/s). Profiling shows ALL the cost is the generic slow-dispatch
 * swarm (_handlePortWriteSlow + validateReturnAddr + recordShadowStackGuard +
 * recordWinApiCall + profiler), NOT the suspend/resume logic (a cheap scheduler state
 * flip). This routes the common case (suspend/resume another live scheduler thread)
 * through the lightweight FastPath, bypassing that swarm; self-suspend / manager-owned /
 * terminated handles return null → the slow path handles the context switch + errors.
 * Faithful: the suspend count still flips and the scheduler still skips a suspended
 * thread — only the dispatch overhead is removed.
 */
export function registerFastPathProcessFunctions(dispatcher: any): void {
    if (!dispatcher || typeof dispatcher.registerFastPath !== 'function') return;

    // DWORD SuspendThread(HANDLE hThread) — stdcall, RET 4. Returns prev suspend count.
    dispatcher.registerFastPath('kernel32', 'SuspendThread', (cpu: any, mem8: Uint8Array): number | null => {
        const esp = cpu.reg32[4] >>> 0;
        if (esp + 8 > mem8.length) return null;
        const sched = System.getInstance().scheduler;
        if (!sched) return null;
        const hThread = new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength).getUint32(esp + 4, true) >>> 0;
        const prev = sched.suspendThreadFast(hThread);
        return prev === null ? null : (prev >>> 0);
        // NOT trivial: SuspendThread(self) needs the thunk boundary to fire immediately so
        // performSwitch switches away from the now-SUSPENDED current thread (see suspendThreadFast).
    });

    // DWORD ResumeThread(HANDLE hThread) — stdcall, RET 4. Returns prev suspend count.
    dispatcher.registerFastPath('kernel32', 'ResumeThread', (cpu: any, mem8: Uint8Array): number | null => {
        const esp = cpu.reg32[4] >>> 0;
        if (esp + 8 > mem8.length) return null;
        const sched = System.getInstance().scheduler;
        if (!sched) return null;
        const hThread = new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength).getUint32(esp + 4, true) >>> 0;
        const prev = sched.resumeThreadFast(hThread);
        return prev === null ? null : (prev >>> 0);
    }, { trivial: true });
}

