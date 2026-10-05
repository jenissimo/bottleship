/**
 * SHELL32.dll: shell folders, file operations and guest process launch.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation, ThunkResult } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import { Logger, LogCategory } from "../core/logger";
import { readAnsiFromGuest, readWideFromGuest, encodeAnsi } from "./codepage-utils";
import { startProcessRuntime } from "./kernel32/process/runtime-child";
import { getVirtualProcessManager } from "./kernel32/process/virtual-process-manager";
import { Marshaler } from "../core/memory/marshaler";
import { performShFileOperation, DE_INVALIDFILES } from "./shell32-fileop";
import { windows } from "./user32/shared-state";
import {
    countPeIcons,
    loadIconFromPeByIndex,
    loadIconFromPeBySize,
    resolveModuleBaseForIconPath,
} from "./kernel32/icon-extractor";

/**
 * SHFILEOPSTRUCTA/W field offsets. shellapi.h wraps the whole header in
 * `#include <pshpack1.h>`, so this struct is PACKED: fAnyOperationsAborted sits at 18,
 * UNALIGNED, and reading it at the naturally-aligned 20 would take the top half of
 * fFlags plus two bytes of the BOOL — the caller then sees "aborted" written into its
 * flags. Same table for A and W: only the strings the pointers name differ.
 */
export const SHFILEOPSTRUCT_OFFSETS = {
    hwnd: 0,
    wFunc: 4,
    pFrom: 8,
    pTo: 12,
    fFlags: 16,
    fAnyOperationsAborted: 18,
    hNameMappings: 22,
    lpszProgressTitle: 26,
};

/**
 * A double-NUL-terminated path LIST. A caller may also pass a plain NUL-terminated path
 * (the shell accepts both), which is the same thing read one element deep.
 */
function readPathList(mem: Uint8Array, ptr: number, wide: boolean): string[] {
    if (!ptr) return [];
    const out: string[] = [];
    let at = ptr >>> 0;
    const MAX_ENTRIES = 4096;
    for (let n = 0; n < MAX_ENTRIES; n++) {
        const text = wide ? readWideFromGuest(mem, at) : readAnsiFromGuest(mem, at);
        if (text.length === 0) break;
        out.push(text);
        // Advance past this element's own NUL, in the units the list is stored in.
        if (wide) {
            let i = 0;
            while (i < 32768 && (mem[at + i * 2] !== 0 || mem[at + i * 2 + 1] !== 0)) i++;
            at += (i + 1) * 2;
        } else {
            let i = 0;
            while (i < 32768 && mem[at + i] !== 0) i++;
            at += i + 1;
        }
    }
    return out;
}

/**
 * Whether a self-launch actually asks for a DIFFERENT command line.
 *
 * Re-execing with the arguments we are already running under is a loop with no exit: the
 * restarted image reaches the same launch and asks again. A launcher only re-execs to
 * CHANGE something, so an identical command line means we mis-read the call.
 */
export function isDifferentCommandLine(requested: string, current: string): boolean {
    const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();
    return norm(requested) !== norm(current);
}

const CSIDL_FLAG_CREATE = 0x8000;

/** ShellExecute* failure codes are 0..31; anything above is an "instance handle" = success. */
const SE_ERR_MAX = 31;
const SE_ERR_ACCESSDENIED = 5;
const SHELL_EXEC_OK = 42;
const ERROR_ACCESS_DENIED = 5;
/** SHCreateDirectoryEx's own return codes — it answers with a Win32 code, not an HRESULT. */
const ERROR_BAD_PATHNAME = 161;
const ERROR_ALREADY_EXISTS = 183;
const ERROR_FILENAME_EXCED_RANGE = 206;
const SEE_MASK_NOCLOSEPROCESS = 0x00000040;

function getSpecialFolderPath(csidl: number): string {
    switch (csidl & 0xff) {
        case 0x05: return "C:\\My Documents";                         // CSIDL_PERSONAL
        case 0x1a: return "C:\\Windows\\Application Data";            // CSIDL_APPDATA
        case 0x1c: return "C:\\Windows\\Local Settings\\Application Data"; // CSIDL_LOCAL_APPDATA
        case 0x24: return "C:\\Windows";                              // CSIDL_WINDOWS
        case 0x25: return "C:\\Windows\\System";                      // CSIDL_SYSTEM
        case 0x26: return "C:\\Program Files";                        // CSIDL_PROGRAM_FILES
        default: return "C:\\";
    }
}

/**
 * KNOWNFOLDERID (a GUID) → the CSIDL that names the same folder, so both shell-folder APIs
 * answer from one table. Only the folders a game or a mod loader actually asks for; anything
 * else must fail rather than be silently aliased to C:\.
 */
const KNOWN_FOLDER_CSIDL: Record<string, number> = {
    "fdd39ad0-238f-46af-adb4-6c85480369c7": 0x05, // Documents      → CSIDL_PERSONAL
    "3eb685db-65f9-4cf6-a03a-e3ef65729f3d": 0x1a, // RoamingAppData → CSIDL_APPDATA
    "f1b32785-6fba-4fcf-9d55-7b8e7f157091": 0x1c, // LocalAppData   → CSIDL_LOCAL_APPDATA
    "f38bf404-1d43-42f2-9305-67de0b28fc23": 0x24, // Windows        → CSIDL_WINDOWS
    "1ac14e77-02e7-4e5d-b744-2eb1ae5198b7": 0x25, // System         → CSIDL_SYSTEM
    "905e63b6-c1bf-494e-b29c-65b732d3d21a": 0x26, // ProgramFiles   → CSIDL_PROGRAM_FILES
};

/** GUID bytes (little-endian Data1/2/3 + big-endian Data4) → canonical lowercase string. */
function csidlForKnownFolderId(guid: Uint8Array | null): number | undefined {
    if (!guid || guid.length < 16) return undefined;
    const hex = (n: number): string => guid[n].toString(16).padStart(2, "0");
    const key =
        `${hex(3)}${hex(2)}${hex(1)}${hex(0)}-${hex(5)}${hex(4)}-${hex(7)}${hex(6)}-` +
        `${hex(8)}${hex(9)}-${hex(10)}${hex(11)}${hex(12)}${hex(13)}${hex(14)}${hex(15)}`;
    return KNOWN_FOLDER_CSIDL[key];
}

function ensureSpecialFolderPath(path: string): void {
    if (/^[A-Za-z]:\\?$/.test(path.trim())) return;

    const vfs = System.getInstance().fileSystem;
    const full = vfs.resolvePath(path);
    if (vfs.directoryExists(full)) return;

    const drivePath = full.match(/^([A-Za-z]:)\\(.+)$/);
    if (!drivePath) return;

    let current = drivePath[1];
    for (const part of drivePath[2].split("\\").filter(Boolean)) {
        current += "\\" + part;
        if (vfs.directoryExists(current)) continue;
        const result = vfs.createDirectorySync(current);
        if (!result.ok && result.error !== 183) {
            Logger.warn(LogCategory.SYSTEM, `shell32: could not create special folder "${current}" err=${result.error}`);
            return;
        }
    }
}

/**
 * SHGetFolderPathA/W, shared by shell32 and shfolder.
 *
 * shfolder.dll is a forwarder on real Windows, and the dispatcher can forward at run time —
 * but only once a shell32 stub for the same name has been materialized, so a title that loads
 * shfolder alone would get the no-handler answer instead of a path. One table, two modules,
 * no load-order dependency.
 */
export function createFolderPathExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // HRESULT SHGetFolderPathA(HWND hwnd, int csidl, HANDLE hToken, DWORD dwFlags, LPSTR pszPath)
    // Same logic as SHGetSpecialFolderPathA but args are (hwnd, csidl, hToken, dwFlags, pszPath)
    // and returns HRESULT (S_OK=0, E_FAIL=0x80004005).
    exports["SHGetFolderPathA"] = (ctx, mem, args) => {
        const csidl = args[1] >>> 0;
        const pszPath = args[4] >>> 0;

        if (pszPath) {
            const path = getSpecialFolderPath(csidl);
            ensureSpecialFolderPath(path); // always exists on real Windows — see SHGetSpecialFolderPathA
            const bytes = encodeAnsi(path + "\0");
            Mem.writeBytes(pszPath, bytes);
        }
        return 0; // S_OK
    };

    exports["SHGetFolderPathW"] = (ctx, mem, args) => {
        const csidl = args[1] >>> 0;
        const pszPath = args[4] >>> 0;

        if (pszPath) {
            const path = getSpecialFolderPath(csidl);
            ensureSpecialFolderPath(path); // always exists on real Windows — see SHGetSpecialFolderPathA
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            for (let i = 0; i < path.length; i++) {
                view.setUint16(pszPath + i * 2, path.charCodeAt(i), true);
            }
            view.setUint16(pszPath + path.length * 2, 0, true);
        }
        return 0; // S_OK
    };

    /**
     * SHCreateDirectoryEx(hwnd, pszPath, psa) — mkdir -p, as Win32 ships it.
     *
     * CreateDirectory fails when a parent is missing, so this is the call a game makes to
     * lay down its whole save/config tree in one go. Refusing it (the unimplemented
     * answer) leaves every later fopen("wb") under that tree failing, which surfaces far
     * away as "the game saves nothing" — and, for a title that builds a manager per
     * config directory, as a NULL it never checks.
     *
     * The path must be ABSOLUTE: Windows answers ERROR_BAD_PATHNAME for a relative one
     * rather than resolving it against the current directory.
     */
    const createDirectoryTree = (path: string): number => {
        if (!path) return ERROR_BAD_PATHNAME;
        const full = path.replace(/\//g, "\\").replace(/\\+$/, "");
        if (!/^[A-Za-z]:\\/.test(full) && !full.startsWith("\\\\")) return ERROR_BAD_PATHNAME;
        if (full.length > 248) return ERROR_FILENAME_EXCED_RANGE;

        const vfs = System.getInstance().fileSystem;
        const drive = full.slice(0, 2);
        const parts = full.slice(3).split("\\").filter(Boolean);
        let cur = drive;
        let createdAny = false;
        for (const part of parts) {
            cur += "\\" + part;
            const r = vfs.createDirectorySync(cur);
            if (r.ok) { createdAny = true; continue; }
            // An existing ancestor is the normal case on the way down; only the LEAF's
            // "already there" is what the caller is told about.
            if (r.error === ERROR_ALREADY_EXISTS) continue;
            return r.error;
        }
        return createdAny ? 0 : ERROR_ALREADY_EXISTS;
    };

    exports["SHCreateDirectoryExA"] = (_ctx, mem, args) => {
        const path = args[1] ? readAnsiFromGuest(mem, args[1] >>> 0) : "";
        const rc = createDirectoryTree(path);
        Logger.log(LogCategory.SYSTEM, `SHCreateDirectoryExA("${path}") -> ${rc}`);
        return rc;
    };

    exports["SHCreateDirectoryExW"] = (_ctx, mem, args) => {
        const path = args[1] ? readWideFromGuest(mem, args[1] >>> 0) : "";
        const rc = createDirectoryTree(path);
        Logger.log(LogCategory.SYSTEM, `SHCreateDirectoryExW("${path}") -> ${rc}`);
        return rc;
    };

    return exports;
}

export class Shell32 implements IModule {
    name = "shell32";
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        const readStrA = (mem: Uint8Array, addr: number): string => {
            if (!addr) return '';
            return readAnsiFromGuest(mem, addr, 260);
        };

        const readStrW = (mem: Uint8Array, addr: number): string => {
            if (!addr) return '';
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const chars: number[] = [];
            for (let i = 0; i < 260; i++) {
                const off = addr + i * 2;
                if (off + 1 >= mem.length) break;
                const ch = view.getUint16(off, true);
                if (ch === 0) break;
                chars.push(ch);
            }
            return String.fromCharCode(...chars);
        };

        type ShellLaunch = { value: number; processHandle?: number };
        const executeShell = async (
            apiName: string, operation: string, file: string, parameters: string,
            directory: string, nShowCmd: number, retainProcess = false,
        ): Promise<ShellLaunch> => {
            const system = System.getInstance();
            const imagePath = system.resolveImagePath(file, directory);
            if (!imagePath || !system.fileSystem.fileExists(imagePath)) {
                system.scheduler.setLastError(2);
                return { value: 2 };
            }
            if (operation.toLowerCase() !== "open" && operation.toLowerCase() !== "runas") {
                system.scheduler.setLastError(ERROR_ACCESS_DENIED);
                return { value: SE_ERR_ACCESSDENIED };
            }
            const manager = getVirtualProcessManager();
            const currentDirectory = directory || system.fileSystem.currentDir;
            const proc = manager.createProcess({ applicationName: imagePath,
                commandLine: parameters, currentDirectory, creationFlags: 0, runtimeBacked: true });
            startProcessRuntime(system.fileSystem, proc.processId, {
                imagePath, commandLine: parameters, currentDirectory,
                rawCommandLine: '\"' + imagePath + '\"' + (parameters ? " " + parameters : ""),
                environment: system.process ? [...system.process.environment] : undefined,
            });
            system.resourceProvider.unregisterKernelObject(proc.threadHandle);
            if (!retainProcess) system.resourceProvider.unregisterKernelObject(proc.processHandle);
            system.scheduler.setLastError(0);
            Logger.log(LogCategory.SYSTEM,
                "[SHELL32] " + apiName + " -> guest child pid=" + proc.processId + " image=" + imagePath);
            return { value: SHELL_EXEC_OK, processHandle: retainProcess ? proc.processHandle : undefined };
        };

        const finishShellExecuteEx = (pExecInfo: number, fMask: number, result: ShellLaunch): ThunkResult => {
            Mem.writeUint32(pExecInfo + 56, result.processHandle ?? 0);
            Mem.writeUint32(pExecInfo + 32, result.value >>> 0);
            return { value: result.value > SE_ERR_MAX ? 1 : 0, stackCleanup: 4 };
        };

        // ShellExecuteA(HWND hwnd, LPCSTR lpOperation, LPCSTR lpFile,
        //               LPCSTR lpParameters, LPCSTR lpDirectory, INT nShowCmd)
        this.exports["ShellExecuteA"] = async (ctx, mem, args) => {
            const lpOperation = args[1] >>> 0;
            const lpFile = args[2] >>> 0;
            const lpParameters = args[3] >>> 0;
            const lpDirectory = args[4] >>> 0;
            const nShowCmd = args[5] >>> 0;

            const operation = lpOperation ? readStrA(mem, lpOperation) : "open";
            const file = lpFile ? readStrA(mem, lpFile) : "";
            const parameters = lpParameters ? readStrA(mem, lpParameters) : "";
            const directory = lpDirectory ? readStrA(mem, lpDirectory) : "";

            const result = await executeShell("ShellExecuteA", operation, file, parameters, directory, nShowCmd);
            return { value: result.value, stackCleanup: 24 };
        };

        // ShellExecuteW(HWND hwnd, LPCWSTR lpOperation, LPCWSTR lpFile,
        //               LPCWSTR lpParameters, LPCWSTR lpDirectory, INT nShowCmd)
        this.exports["ShellExecuteW"] = async (ctx, mem, args) => {
            const lpOperation = args[1] >>> 0;
            const lpFile = args[2] >>> 0;
            const lpParameters = args[3] >>> 0;
            const lpDirectory = args[4] >>> 0;
            const nShowCmd = args[5] >>> 0;

            const operation = lpOperation ? readStrW(mem, lpOperation) : "open";
            const file = lpFile ? readStrW(mem, lpFile) : "";
            const parameters = lpParameters ? readStrW(mem, lpParameters) : "";
            const directory = lpDirectory ? readStrW(mem, lpDirectory) : "";

            const result = await executeShell("ShellExecuteW", operation, file, parameters, directory, nShowCmd);
            return { value: result.value, stackCleanup: 24 };
        };

        // BOOL ShellExecuteExA(SHELLEXECUTEINFOA *pExecInfo)
        this.exports["ShellExecuteExA"] = async (ctx, mem, args) => {
            const pExecInfo = args[0] >>> 0;
            if (!pExecInfo) return { value: 0, stackCleanup: 4 };

            const fMask = Mem.readUint32(pExecInfo + 4) ?? 0;
            const lpVerb = Mem.readUint32(pExecInfo + 12) ?? 0;
            const lpFile = Mem.readUint32(pExecInfo + 16) ?? 0;
            const lpParameters = Mem.readUint32(pExecInfo + 20) ?? 0;
            const lpDirectory = Mem.readUint32(pExecInfo + 24) ?? 0;
            const nShow = Mem.readInt32(pExecInfo + 28) ?? 0;

            const operation = lpVerb ? readStrA(mem, lpVerb) : "open";
            const file = lpFile ? readStrA(mem, lpFile) : "";
            const parameters = lpParameters ? readStrA(mem, lpParameters) : "";
            const directory = lpDirectory ? readStrA(mem, lpDirectory) : "";

            const result = await executeShell(
                "ShellExecuteExA", operation, file, parameters, directory, nShow,
                (fMask & SEE_MASK_NOCLOSEPROCESS) !== 0,
            );
            return finishShellExecuteEx(pExecInfo, fMask, result);
        };

        // BOOL ShellExecuteExW(SHELLEXECUTEINFOW *pExecInfo)
        this.exports["ShellExecuteExW"] = async (ctx, mem, args) => {
            const pExecInfo = args[0] >>> 0;
            if (!pExecInfo) return { value: 0, stackCleanup: 4 };

            const fMask = Mem.readUint32(pExecInfo + 4) ?? 0;
            const lpVerb = Mem.readUint32(pExecInfo + 12) ?? 0;
            const lpFile = Mem.readUint32(pExecInfo + 16) ?? 0;
            const lpParameters = Mem.readUint32(pExecInfo + 20) ?? 0;
            const lpDirectory = Mem.readUint32(pExecInfo + 24) ?? 0;
            const nShow = Mem.readInt32(pExecInfo + 28) ?? 0;

            const operation = lpVerb ? readStrW(mem, lpVerb) : "open";
            const file = lpFile ? readStrW(mem, lpFile) : "";
            const parameters = lpParameters ? readStrW(mem, lpParameters) : "";
            const directory = lpDirectory ? readStrW(mem, lpDirectory) : "";

            const result = await executeShell(
                "ShellExecuteExW", operation, file, parameters, directory, nShow,
                (fMask & SEE_MASK_NOCLOSEPROCESS) !== 0,
            );
            return finishShellExecuteEx(pExecInfo, fMask, result);
        };
        this.exports["Shell_NotifyIconA"] = () => 1; // BOOL TRUE (tray icon ops accepted)
        this.exports["Shell_NotifyIconW"] = () => 1;
        this.exports["DragQueryFileA"] = (ctx, mem, args) => {
            const iFile = args[1] >>> 0;
            const lpszFile = args[2] >>> 0;
            const cch = args[3] >>> 0;

            // No drag-drop support: report zero files.
            if (iFile !== 0xFFFFFFFF && lpszFile && cch > 0) {
                Mem.writeBytes(lpszFile, new Uint8Array([0]));
            }

            return { value: 0, stackCleanup: 16 };
        };
        this.exports["DragQueryFileW"] = (_ctx, _mem, args) => {
            const iFile = args[1] >>> 0;
            const lpszFile = args[2] >>> 0;
            const cch = args[3] >>> 0;

            // No drag-drop support: report zero files.
            if (iFile !== 0xFFFFFFFF && lpszFile && cch > 0) {
                Mem.writeUint16(lpszFile, 0);
            }

            return { value: 0, stackCleanup: 16 };
        };
        this.exports["DragFinish"] = () => ({ value: 0, stackCleanup: 4 });

        // void DragAcceptFiles(HWND hWnd, BOOL fAccept) — toggles WS_EX_ACCEPTFILES, which is
        // all "accepting dropped files" is; a non-window is ignored.
        this.exports["DragAcceptFiles"] = (_ctx, _mem, args) => {
            const WS_EX_ACCEPTFILES = 0x00000010;
            const win = windows.get(args[0] >>> 0);
            if (win) {
                const exStyle = win.exStyle ?? 0;
                win.exStyle = (args[1] ? exStyle | WS_EX_ACCEPTFILES : exStyle & ~WS_EX_ACCEPTFILES) >>> 0;
            }
            return { value: 0, stackCleanup: 8 };
        };

        // IsUserAnAdmin — always return FALSE (not admin)
        this.exports["IsUserAnAdmin"] = () => ({ value: 0, stackCleanup: 0 });

        // HICON ExtractAssociatedIconA(HINSTANCE hInst, LPSTR pszIconPath, LPWORD piIcon)
        this.exports["ExtractAssociatedIconA"] = () => 0x10001; // fake HICON

        const extractIconEx = (ctx: unknown, mem: Uint8Array, args: number[], wide: boolean) => {
            const lpszFile = args[0] >>> 0;
            const nIconIndex = args[1] | 0;
            const phiconLarge = args[2] >>> 0;
            const phiconSmall = args[3] >>> 0;
            const nIcons = args[4] >>> 0;

            const path = lpszFile
                ? (wide ? Marshaler.readWideString(mem, lpszFile) : Marshaler.readString(mem, lpszFile))
                : '';
            const moduleBase = resolveModuleBaseForIconPath(path);
            const iconCount = moduleBase ? countPeIcons(mem, moduleBase) : 0;

            // Count-only query: both output arrays NULL, or nIconIndex == -1 with nIcons == 0.
            if ((!phiconLarge && !phiconSmall) || (nIconIndex === -1 && nIcons === 0)) {
                Logger.verbose(LogCategory.SYSTEM, `ExtractIconEx${wide ? 'W' : 'A'}('${path}') -> count ${iconCount}`);
                return iconCount;
            }

            if (!moduleBase || nIconIndex < 0 || nIconIndex >= iconCount || nIcons === 0) {
                return 0;
            }

            const toExtract = Math.min(nIcons, iconCount - nIconIndex);
            let extracted = 0;
            for (let i = 0; i < toExtract; i++) {
                const idx = nIconIndex + i;
                const hLarge = loadIconFromPeByIndex(mem, moduleBase, idx)
                    || loadIconFromPeBySize(mem, moduleBase, true);
                const hSmall = loadIconFromPeByIndex(mem, moduleBase, idx)
                    || loadIconFromPeBySize(mem, moduleBase, false);
                if (phiconLarge) Mem.writeUint32(phiconLarge + i * 4, hLarge);
                if (phiconSmall) Mem.writeUint32(phiconSmall + i * 4, hSmall);
                if (hLarge || hSmall) extracted++;
            }

            Logger.verbose(LogCategory.SYSTEM,
                `ExtractIconEx${wide ? 'W' : 'A'}('${path}', idx=${nIconIndex}, n=${nIcons}) -> ${extracted}`);
            return extracted;
        };

        this.exports["ExtractIconExA"] = (ctx, mem, args) => extractIconEx(ctx, mem, args, false);
        this.exports["ExtractIconExW"] = (ctx, mem, args) => extractIconEx(ctx, mem, args, true);

        // FindExecutableA - find executable associated with a file
        this.exports["FindExecutableA"] = (ctx, mem, args) => {
            const lpFile = args[0] >>> 0;
            const lpDirectory = args[1] >>> 0;
            const lpResult = args[2] >>> 0;

            // Stub: return error (no association found)
            if (lpResult) {
                Mem.writeBytes(lpResult, new Uint8Array([0]));
            }
            return 31; // SE_ERR_NOASSOC
        };

        // SHGetSpecialFolderLocation - get PIDL for special folder
        this.exports["SHGetSpecialFolderLocation"] = (ctx, mem, args) => {
            const hwnd = args[0] >>> 0;
            const csidl = args[1] >>> 0;
            const ppidl = args[2] >>> 0;

            // Allocate a fake PIDL (minimal: just 2 bytes for size + 2 bytes terminator)
            if (ppidl) {
                const pidl = process.memory.alloc(4, "HEAP", "rw");
                // PIDL format: USHORT cb (size including cb), followed by data, terminated by USHORT 0
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint16(pidl, 0, true); // Empty PIDL (cb=0 means end)
                view.setUint32(ppidl, pidl, true);
            }
            return 0; // S_OK
        };

        // SHGetPathFromIDListA - convert PIDL to path
        this.exports["SHGetPathFromIDListA"] = (ctx, mem, args) => {
            const pidl = args[0] >>> 0;
            const pszPath = args[1] >>> 0;

            if (pszPath) {
                // Return a default path based on common CSIDLs
                const path = "C:\\";
                const bytes = encodeAnsi(path + "\0");
                Mem.writeBytes(pszPath, bytes);
            }
            return 1; // TRUE
        };

        // SHGetPathFromIDListW - wide char version
        this.exports["SHGetPathFromIDListW"] = (ctx, mem, args) => {
            const pidl = args[0] >>> 0;
            const pszPath = args[1] >>> 0;

            if (pszPath) {
                const path = "C:\\";
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                for (let i = 0; i < path.length; i++) {
                    view.setUint16(pszPath + i * 2, path.charCodeAt(i), true);
                }
                view.setUint16(pszPath + path.length * 2, 0, true); // null terminator
            }
            return 1; // TRUE
        };

        // HRESULT SHGetMalloc(LPMALLOC *ppMalloc) — documented as CoGetMalloc with
        // MEMCTX_TASK, so it must hand back the SAME allocator: the shell frees
        // with it what ole32 allocated (PIDLs), and two allocators would corrupt.
        this.exports["SHGetMalloc"] = (ctx, mem, args) => {
            const ppMalloc = args[0] >>> 0;
            if (!ppMalloc) return 0x80004003; // E_POINTER
            const ole32 = process.getModule("ole32");
            const coGetMalloc = ole32?.exports?.["CoGetMalloc"];
            if (!coGetMalloc) {
                Mem.writeUint32(ppMalloc, 0);
                return 0x80004005; // E_FAIL
            }
            return coGetMalloc(ctx, mem, [1 /* MEMCTX_TASK */, ppMalloc]) as ThunkResult;
        };

        // SHGetSpecialFolderPathA - get path for special folder
        this.exports["SHGetSpecialFolderPathA"] = (ctx, mem, args) => {
            const hwnd = args[0] >>> 0;
            const pszPath = args[1] >>> 0;
            const csidl = args[2] >>> 0;
            const fCreate = args[3] >>> 0;

            if (pszPath) {
                const path = getSpecialFolderPath(csidl);
                // Well-known shell folders always exist on real Windows (profile setup
                // creates them), so materialize unconditionally — fCreate/CSIDL_FLAG_CREATE
                // only ever ADD creation, never gate it. Without this a game that queries
                // the folder without the flag then CreateDirectory's a subfolder under it
                // fails with ERROR_PATH_NOT_FOUND (D2 GameLogs).
                ensureSpecialFolderPath(path);
                const bytes = encodeAnsi(path + "\0");
                Mem.writeBytes(pszPath, bytes);
            }
            return 1; // TRUE
        };

        // SHGetSpecialFolderPathW - wide char version
        this.exports["SHGetSpecialFolderPathW"] = (ctx, mem, args) => {
            const hwnd = args[0] >>> 0;
            const pszPath = args[1] >>> 0;
            const csidl = args[2] >>> 0;
            const fCreate = args[3] >>> 0;

            if (pszPath) {
                const path = getSpecialFolderPath(csidl);
                ensureSpecialFolderPath(path); // always exists on real Windows — see SHGetSpecialFolderPathA
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                for (let i = 0; i < path.length; i++) {
                    view.setUint16(pszPath + i * 2, path.charCodeAt(i), true);
                }
                view.setUint16(pszPath + path.length * 2, 0, true);
            }
            return 1; // TRUE
        };

        Object.assign(this.exports, createFolderPathExports());

        // HRESULT SHGetKnownFolderPath(REFKNOWNFOLDERID rfid, DWORD dwFlags, HANDLE hToken,
        //                              PWSTR *ppszPath)
        // The Vista+ replacement for SHGetFolderPath, and the one modern loaders reach for
        // (Ultimate ASI Loader). Unlike its predecessor it OUT-ALLOCATES: the caller passes a
        // PWSTR* and frees the result with CoTaskMemFree. A stub returning S_OK without
        // writing *ppszPath is worse than failing — the caller dereferences whatever was in
        // that variable. On any path we cannot map, fail and NULL the out-param.
        this.exports["SHGetKnownFolderPath"] = (ctx, mem, args) => {
            const rfid = args[0] >>> 0;
            const ppszPath = args[3] >>> 0;
            const E_FAIL = 0x80004005;
            const E_INVALIDARG = 0x80070057;

            if (!ppszPath) return E_INVALIDARG;
            Mem.writeUint32(ppszPath, 0);
            if (!rfid) return E_INVALIDARG;

            const csidl = csidlForKnownFolderId(Mem.readBytes(rfid, 16));
            if (csidl === undefined) return E_FAIL;

            const path = getSpecialFolderPath(csidl);
            ensureSpecialFolderPath(path);

            // CoTaskMemAlloc semantics: the caller owns the buffer (CoTaskMemFree is a no-op
            // for us, matching ole32's own allocator).
            const bytes = (path.length + 1) * 2;
            const buf = System.getInstance().process?.memory?.alloc(bytes);
            if (!buf) return E_FAIL;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            for (let i = 0; i < path.length; i++) view.setUint16(buf + i * 2, path.charCodeAt(i), true);
            view.setUint16(buf + path.length * 2, 0, true);
            Mem.writeUint32(ppszPath, buf >>> 0);
            return 0; // S_OK
        };

        /**
         * int SHFileOperationA/W(LPSHFILEOPSTRUCT lpFileOp)
         *
         * The real bulk copy/move/delete, not an acknowledgement. A title's first run
         * seeds its writable state through this call; answering 0 without moving bytes
         * leaves a game that boots, renders, and silently saves nothing — with no
         * failure anywhere near the cause.
         */
        const fileOperation = async (mem: Uint8Array, lpFileOp: number, wide: boolean): Promise<number> => {
            const name = wide ? "SHFileOperationW" : "SHFileOperationA";
            if (!lpFileOp) {
                Logger.warn(LogCategory.SYSTEM, `${name}: NULL SHFILEOPSTRUCT`);
                return DE_INVALIDFILES;
            }
            const o = SHFILEOPSTRUCT_OFFSETS;
            const wFunc = Mem.readUint32(lpFileOp + o.wFunc);
            const pFrom = Mem.readUint32(lpFileOp + o.pFrom);
            const pTo = Mem.readUint32(lpFileOp + o.pTo);
            const fFlags = Mem.readUint16(lpFileOp + o.fFlags);
            if (wFunc === null || pFrom === null || pTo === null || fFlags === null) {
                Logger.warn(LogCategory.SYSTEM, `${name}: unreadable SHFILEOPSTRUCT at 0x${lpFileOp.toString(16)}`);
                return DE_INVALIDFILES;
            }

            const from = readPathList(mem, pFrom, wide);
            const to = readPathList(mem, pTo, wide);
            Logger.log(LogCategory.SYSTEM,
                `${name}(wFunc=${wFunc}, flags=0x${fFlags.toString(16)}, from=[${from.join("; ")}], to=[${to.join("; ")}])`);

            const outcome = await performShFileOperation({ wFunc, from, to, flags: fFlags });
            // fAnyOperationsAborted is the caller's own "did everything happen" check, and
            // it lives at an UNALIGNED offset — see SHFILEOPSTRUCT_OFFSETS.
            Mem.writeUint32(lpFileOp + o.fAnyOperationsAborted, outcome.aborted ? 1 : 0);
            // FOF_WANTMAPPINGHANDLE is not honoured: we never rename on collision, so
            // there is no name map to hand back and the field stays as the caller left it.
            Logger.log(LogCategory.SYSTEM,
                `${name} -> 0x${outcome.result.toString(16)} (${outcome.filesTouched} file(s), aborted=${outcome.aborted})`);
            return outcome.result;
        };

        this.exports["SHFileOperationA"] = (ctx, mem, args) => fileOperation(mem, args[0] >>> 0, false);
        this.exports["SHFileOperationW"] = (ctx, mem, args) => fileOperation(mem, args[0] >>> 0, true);

        // SHAppBarMessage - taskbar/appbar notifications (not modeled in HLE).
        this.exports["SHAppBarMessage"] = () => 0;

        // LPWSTR* CommandLineToArgvW(LPCWSTR lpCmdLine, int *pNumArgs)
        // Parses command line into argv array. Return a single-element array with the exe name.
        this.exports["CommandLineToArgvW"] = (ctx, mem, args) => {
            const lpCmdLine = args[0] >>> 0;
            const pNumArgs = args[1] >>> 0;

            // Read the command line (or use a default)
            let cmdLine = "program.exe";
            if (lpCmdLine) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const chars: number[] = [];
                for (let i = 0; i < 1024; i++) {
                    const ch = view.getUint16(lpCmdLine + i * 2, true);
                    if (ch === 0) break;
                    chars.push(ch);
                }
                if (chars.length > 0) cmdLine = String.fromCharCode(...chars);
            }

            // Allocate: pointer array + string data from process heap
            const processObj = System.getInstance().process;
            if (!processObj) {
                if (pNumArgs) Mem.writeUint32(pNumArgs, 0);
                return 0; // NULL
            }

            // 4 bytes for pointer + (cmdLine.length+1)*2 bytes for wide string
            const strBytes = (cmdLine.length + 1) * 2;
            const totalSize = 4 + strBytes;
            let baseAddr: number;
            try {
                baseAddr = processObj.memory.alloc(totalSize);
            } catch {
                if (pNumArgs) Mem.writeUint32(pNumArgs, 0);
                return 0;
            }

            const ptrArrayAddr = baseAddr;
            const strAddr = baseAddr + 4;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            // Write pointer to string
            view.setUint32(ptrArrayAddr, strAddr, true);
            // Write the wide string
            for (let i = 0; i < cmdLine.length; i++) {
                view.setUint16(strAddr + i * 2, cmdLine.charCodeAt(i), true);
            }
            view.setUint16(strAddr + cmdLine.length * 2, 0, true);

            if (pNumArgs) Mem.writeUint32(pNumArgs, 1);
            return ptrArrayAddr;
        };
    }

    reset(): void {}
}

