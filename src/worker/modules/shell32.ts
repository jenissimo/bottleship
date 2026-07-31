/**
 * SHELL32.dll stub module.
 * ShellExecuteA вЂ” safe stub so PE imports don't corrupt stack.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation, ThunkResult } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import { Logger, LogCategory } from "../core/logger";
import { EmulatorConfig } from "../core/emulator-config-manager";
import { invalidateIniCache } from "./kernel32/profile";
import { readAnsiFromGuest, encodeAnsi } from "./codepage-utils";
import { Marshaler } from "../core/memory/marshaler";
import {
    countPeIcons,
    loadIconFromPeByIndex,
    loadIconFromPeBySize,
    resolveModuleBaseForIconPath,
} from "./kernel32/icon-extractor";

/**
 * Check `shellExecFake` rules against the given command line / parameter string.
 * If a rule matches, create the declared files in VFS and return true; otherwise
 * return false without side effects. Shared between ShellExecute* (shell32) and
 * CreateProcess* (kernel32), because some games (Unreal Engine setup) probe
 * render devices via either API.
 *
 * If no rule matches, callers choose their compatibility behavior. CreateProcess*
 * keeps a narrow UE1 `-b false` no-op child fallback because some builds do not
 * tolerate a hard failure on that probe.
 */
export function hasShellExecFakeMatch(commandLine: string): boolean {
    return EmulatorConfig.getInstance().shellExecFake.some(rule => commandLine.includes(rule.match));
}

export async function applyShellExecFake(commandLine: string, source: string): Promise<boolean> {
    const rules = EmulatorConfig.getInstance().shellExecFake;
    for (const rule of rules) {
        if (!commandLine.includes(rule.match)) continue;

        Logger.log(
            LogCategory.SYSTEM,
            `[${source}] shellExecFake matched "${rule.match}" - creating ${rule.createFiles.length} file(s)`
        );
        const vfs = System.getInstance().fileSystem;
        for (const f of rule.createFiles) {
            // ifAbsent: don't clobber an existing copy (e.g. a config the game rewrote with
            // the user's resolution) — only create on first run. Mirrors manifest writeFiles.
            if (f.ifAbsent && vfs.getFileSize(f.path) > 0) {
                Logger.log(LogCategory.SYSTEM, `[${source}] shellExecFake: "${f.path}" already exists, skipped (ifAbsent)`);
                continue;
            }
            // Emulator-side injection: mkdir -p the target's parent dirs so an author
            // can drop a file into a path the bundle doesn't ship (e.g. a freshly-
            // installed game's "My Documents\<Game>" config dir). CREATE_ALWAYS below
            // returns null on a missing parent (faithful Win32), which would silently
            // skip the write — this makes the declared path Just Work.
            vfs.ensureParentDirsSync(f.path);
            let data: Uint8Array | undefined;
            if (f.copyFrom) {
                const src = await vfs.open(f.copyFrom, 0x80000000, 3); // GENERIC_READ, OPEN_EXISTING
                if (src) {
                    const size = vfs.getFileSize(f.copyFrom);
                    if (size > 0) data = await vfs.read(src, size);
                } else {
                    Logger.warn(
                        LogCategory.SYSTEM,
                        `[${source}] shellExecFake: copyFrom source not found: "${f.copyFrom}"`
                    );
                }
            } else if (f.content) {
                data = encodeAnsi(f.content);
            }
            const h = await vfs.open(f.path, 0x40000000, 2); // GENERIC_WRITE, CREATE_ALWAYS
            if (h && data) {
                await vfs.write(h, data);
                await vfs.flushFile(h.path);
            }
            if (f.path.toLowerCase().endsWith('.ini')) {
                invalidateIniCache(f.path);
            }
            Logger.log(
                LogCategory.SYSTEM,
                `[${source}] shellExecFake created: "${f.path}"${data ? ` (${data.length} bytes)` : ''}`
            );
        }
        return true;
    }
    return false;
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

        /**
         * ShellExecute* return value. >32 is success; 0..31 are SE_ERR_* codes.
         *
         * Success is a claim about EFFECT, not mechanism: we are single-process, so the
         * only launch shape we can serve is one whose entire observable contract is a
         * side effect on the filesystem (UE1's `testrendev` child exists purely to leave
         * Detected.ini behind — the parent never waits on it and never reads an exit
         * code). Saying "launched" when we produced that artifact is honest; saying it
         * when we did nothing tells the guest a child ran and lets it proceed on a false
         * premise, failing arbitrarily far from here.
         *
         * The refusal code must not itself assert something false about the image:
         * SE_ERR_FNF/SE_ERR_BADFORMAT are falsifiable by the guest and route some callers
         * into a reinstall/repair branch. ACCESSDENIED says only "this environment would
         * not run it", which is true.
         */
        const executeShell = async (
            apiName: "ShellExecuteA" | "ShellExecuteW" | "ShellExecuteExA" | "ShellExecuteExW",
            operation: string,
            file: string,
            parameters: string,
            directory: string,
            nShowCmd: number
        ): Promise<number> => {
            const launched = await applyShellExecFake(parameters, "SHELL32");

            // Self re-exec: a launcher relaunching its OWN image with a new command line
            // (see System.isSelfImage). The child's whole observable contract is "this
            // program, restarted with these arguments", and that we can reproduce exactly.
            //
            // Strictly AFTER shellExecFake: a self-launch whose real purpose is a file side
            // effect is already served by that rule, and restarting for it would relaunch
            // the game mid-boot forever (UE1 probes its renderer by running its own image
            // to drop Detected.ini).
            const system = System.getInstance();
            if (!launched && system.isSelfImage(file, directory)
                && isDifferentCommandLine(parameters, system.executableArgs)
                && system.requestReExec(parameters)) {
                system.scheduler.setLastError(0);
                Logger.log(
                    LogCategory.SYSTEM,
                    `[SHELL32] ${apiName}("${operation}", "${file}", "${parameters}") -> re-exec ` +
                    `(launcher relaunching its own image; restarting with the new command line)`
                );
                return SHELL_EXEC_OK;
            }

            if (!launched) {
                System.getInstance().scheduler.setLastError(ERROR_ACCESS_DENIED);
                Logger.warn(
                    LogCategory.SYSTEM,
                    `[SHELL32] ${apiName}("${operation}", "${file}", "${parameters}", dir="${directory}", ` +
                    `show=${nShowCmd}) -> SE_ERR_ACCESSDENIED (no emulated child effect; ` +
                    `single-process HLE cannot spawn a real child)`
                );
                return SE_ERR_ACCESSDENIED;
            }

            System.getInstance().scheduler.setLastError(0);
            Logger.log(
                LogCategory.SYSTEM,
                `[SHELL32] ${apiName}("${operation}", "${file}", "${parameters}", dir="${directory}", ` +
                `show=${nShowCmd}) -> ${SHELL_EXEC_OK} (child effect emulated)`
            );
            return SHELL_EXEC_OK;
        };

        /** Shared tail for ShellExecuteEx{A,W}: hInstApp + handle policy + BOOL. */
        const finishShellExecuteEx = (pExecInfo: number, fMask: number, result: number): ThunkResult => {
            // A handle we cannot back must not exist: an unregistered value never signals
            // a wait, fails GetExitCodeProcess, and corrupts whatever real object later
            // lands on it via CloseHandle. So when the caller ASKED for the process handle,
            // hProcess stays NULL — and the call must then report FAILURE, because TRUE with
            // a NULL hProcess sends a guest straight into WaitForSingleObject(NULL) with no
            // branch for the error it gets back.
            const wantsProcess = (fMask & SEE_MASK_NOCLOSEPROCESS) !== 0;
            let outcome = result;
            if (wantsProcess) {
                Mem.writeUint32(pExecInfo + 56, 0); // hProcess
                if (outcome > SE_ERR_MAX) {
                    outcome = SE_ERR_ACCESSDENIED;
                    System.getInstance().scheduler.setLastError(ERROR_ACCESS_DENIED);
                    Logger.warn(
                        LogCategory.SYSTEM,
                        `[SHELL32] ShellExecuteEx: SEE_MASK_NOCLOSEPROCESS requested but no process handle ` +
                        `can be backed — reporting FALSE/SE_ERR_ACCESSDENIED rather than a NULL hProcess`
                    );
                }
            }

            Mem.writeUint32(pExecInfo + 32, outcome >>> 0); // hInstApp (SE_ERR_* on failure)
            return { value: outcome > SE_ERR_MAX ? 1 : 0, stackCleanup: 4 };
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
            return { value: result, stackCleanup: 24 };
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
            return { value: result, stackCleanup: 24 };
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

            const result = await executeShell("ShellExecuteExA", operation, file, parameters, directory, nShow);
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

            const result = await executeShell("ShellExecuteExW", operation, file, parameters, directory, nShow);
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

        // void DragAcceptFiles(HWND hWnd, BOOL fAccept)
        // Registers/unregisters window for drag-and-drop вЂ” no-op in emulator
        this.exports["DragAcceptFiles"] = () => ({ value: 0, stackCleanup: 8 });

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

        // HRESULT SHGetFolderPathA(HWND hwnd, int csidl, HANDLE hToken, DWORD dwFlags, LPSTR pszPath)
        // Same logic as SHGetSpecialFolderPathA but args are (hwnd, csidl, hToken, dwFlags, pszPath)
        // and returns HRESULT (S_OK=0, E_FAIL=0x80004005).
        this.exports["SHGetFolderPathA"] = (ctx, mem, args) => {
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

        this.exports["SHGetFolderPathW"] = (ctx, mem, args) => {
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

