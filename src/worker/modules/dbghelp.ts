import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Marshaler } from "../core/memory/marshaler";
import { Mem } from "../core/memory/mem-accessor";
import { encodeAnsi } from "./codepage-utils";
import { isValidAddress } from "../core/memory/address-guard";
import { System } from "../core/system";
import {
    stackWalk32, stackWalk64, symGetModuleBase32, symGetModuleBase64,
} from "./dbghelp-stackwalk";

const MAX_PATH = 260;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_INVALID_ADDRESS = 487;

/**
 * The dbghelp export surface, as a table rather than a class member: imagehlp.dll offers
 * the very same functions (on NT the two are built from one source and imagehlp re-exports
 * them), so both modules serve THIS table instead of two implementations free to drift.
 */
export function createDbgHelpExports(): Record<string, ThunkImplementation> {
        const exports: Record<string, ThunkImplementation> = {};

        // BOOL SymInitialize(HANDLE hProcess, PCSTR UserSearchPath, BOOL fInvadeProcess)
        exports['SymInitialize'] = () => 1; // TRUE

        // BOOL SymCleanup(HANDLE hProcess)
        exports['SymCleanup'] = () => 1;

        // DWORD SymSetOptions(DWORD SymOptions)
        exports['SymSetOptions'] = (_ctx, _mem, args) => args[0] >>> 0;

        // DWORD SymGetOptions(void)
        exports['SymGetOptions'] = () => 0;

        // DWORD SymGetModuleBase(HANDLE hProcess, DWORD dwAddr)
        exports['SymGetModuleBase'] = symGetModuleBase32;

        // DWORD64 SymGetModuleBase64(HANDLE hProcess, DWORD64 dwAddr)
        exports['SymGetModuleBase64'] = symGetModuleBase64;

        // DWORD SymLoadModule(HANDLE, HANDLE, PCSTR, PCSTR, DWORD BaseOfDll, DWORD)
        // The documented return is the module's base, and the caller already told us which
        // one — the *64 form takes BaseOfDll as a DWORD64, whose low half sits at the same
        // argument index. Zero means "work it out from the file", which we cannot.
        const symLoadModule: ThunkImplementation = (_ctx, _mem, args) => args[4] >>> 0;
        exports['SymLoadModule'] = symLoadModule;
        exports['SymLoadModule64'] = symLoadModule;

        // PVOID SymFunctionTableAccess(HANDLE hProcess, DWORD AddrBase)
        exports['SymFunctionTableAccess'] = () => 0;

        // PVOID SymFunctionTableAccess64(HANDLE hProcess, DWORD64 AddrBase)
        exports['SymFunctionTableAccess64'] = () => 0;

        // BOOL SymGetLineFromAddr(HANDLE, DWORD, PDWORD, PIMAGEHLP_LINE)
        exports['SymGetLineFromAddr'] = () => 0; // FALSE

        // BOOL SymGetLineFromAddr64(HANDLE, DWORD64, PDWORD, PIMAGEHLP_LINE64)
        // We carry no line-number data, and the documented "no line info" answer is
        // FALSE + ERROR_INVALID_ADDRESS — callers branch on the code, not just the BOOL.
        exports['SymGetLineFromAddr64'] = () => {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_ADDRESS);
            return 0;
        };

        // BOOL SymGetSymFromAddr(HANDLE, DWORD, PDWORD, PIMAGEHLP_SYMBOL)
        // We carry no symbol table; FALSE + ERROR_INVALID_ADDRESS is the "no symbol here"
        // answer, and callers fall back to printing module+offset.
        const symGetSymFromAddr: ThunkImplementation = () => {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_ADDRESS);
            return 0;
        };
        exports['SymGetSymFromAddr'] = symGetSymFromAddr;
        exports['SymGetSymFromAddr64'] = symGetSymFromAddr;
        exports['SymFromAddr'] = symGetSymFromAddr;

        // BOOL StackWalk(DWORD, HANDLE, HANDLE, LPSTACKFRAME, PVOID, PREAD_PROCESS_MEMORY_ROUTINE, PFUNCTION_TABLE_ACCESS_ROUTINE, PGET_MODULE_BASE_ROUTINE, PTRANSLATE_ADDRESS_ROUTINE)
        exports['StackWalk'] = stackWalk32;

        // BOOL StackWalk64(DWORD, HANDLE, HANDLE, LPSTACKFRAME64, PVOID, PREAD_PROCESS_MEMORY_ROUTINE64, PFUNCTION_TABLE_ACCESS_ROUTINE64, PGET_MODULE_BASE_ROUTINE64, PTRANSLATE_ADDRESS_ROUTINE64)
        exports['StackWalk64'] = stackWalk64;

        // DWORD UnDecorateSymbolName(PCSTR name, PSTR out, DWORD maxLen, DWORD flags)
        // We carry no MSVC demangler; the real function also passes an undecorated name
        // through unchanged, which is the branch every caller already handles.
        exports['UnDecorateSymbolName'] = (_ctx, mem, args) => {
            const namePtr = args[0] >>> 0;
            const out = args[1] >>> 0;
            const maxLen = args[2] >>> 0;
            if (!namePtr || !out || maxLen === 0) return 0;
            const name = Marshaler.readString(mem, namePtr);
            const bytes = encodeAnsi(name);
            const copied = Math.min(bytes.length, maxLen - 1);
            if (Mem.writeBytes(out, bytes.subarray(0, copied)) !== copied) return 0;
            if (!Mem.writeUint8(out + copied, 0)) return 0;
            return copied;
        };

        // PIMAGE_NT_HEADERS ImageNtHeader(PVOID Base)
        // Base is a mapped image; the NT headers sit at Base + e_lfanew. Validating both
        // signatures matters — callers pass whatever GetModuleHandle returned, including
        // handles that are not images at all.
        exports['ImageNtHeader'] = (_ctx, _mem, args) => {
            const base = args[0] >>> 0;
            if (!base) return 0;
            if (Mem.readUint16(base) !== 0x5a4d) return 0; // 'MZ'
            const lfanew = Mem.readUint32(base + 0x3c);
            if (lfanew === null || lfanew <= 0 || lfanew > 0x10000000) return 0;
            const nt = (base + lfanew) >>> 0;
            if (Mem.readUint32(nt) !== 0x00004550) return 0; // 'PE\0\0'
            return nt;
        };

        // BOOL MakeSureDirectoryPathExists(PCSTR DirPath)
        // The trailing backslash is load-bearing: without one the last component is a
        // FILE name and is not created, which is what callers passing a full file path rely on.
        exports['MakeSureDirectoryPathExists'] = (_ctx, mem, args) => {
            const pathPtr = args[0] >>> 0;
            if (!pathPtr) {
                System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            const raw = Marshaler.readString(mem, pathPtr).replace(/\//g, "\\");
            const lastSlash = raw.lastIndexOf("\\");
            const dir = lastSlash >= 0 ? raw.slice(0, lastSlash) : "";
            if (!dir) return 1;
            const vfs = System.getInstance().fileSystem;
            vfs.ensureDirTreeSync(dir);
            if (vfs.directoryExists(vfs.resolvePath(dir))) return 1;
            System.getInstance().scheduler.setLastError(ERROR_PATH_NOT_FOUND);
            return 0;
        };

        // BOOL SearchTreeForFile(PCSTR RootPath, PCSTR InputPathName, PSTR OutputPathBuffer)
        // Depth-first walk under RootPath for a file whose trailing components match
        // InputPathName; the first hit's full path lands in OutputPathBuffer (MAX_PATH).
        exports['SearchTreeForFile'] = (_ctx, mem, args) => {
            const rootPtr = args[0] >>> 0;
            const inputPtr = args[1] >>> 0;
            const outPtr = args[2] >>> 0;
            if (!rootPtr || !inputPtr || !outPtr) {
                System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            const vfs = System.getInstance().fileSystem;
            const root = vfs.resolvePath(Marshaler.readString(mem, rootPtr).replace(/\//g, "\\"));
            const wanted = Marshaler.readString(mem, inputPtr).replace(/\//g, "\\").replace(/^\\+/, "").toLowerCase();
            if (!wanted || !vfs.directoryExists(root)) {
                System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
                return 0;
            }

            const matches = (fullPath: string): boolean => {
                const lower = fullPath.toLowerCase();
                if (!lower.endsWith(wanted)) return false;
                // Only whole components count: "\a\bfoo.pdb" must not match "foo.pdb".
                const prefixLen = lower.length - wanted.length;
                return prefixLen === 0 || lower[prefixLen - 1] === "\\";
            };

            const stack = [root];
            let found: string | null = null;
            while (stack.length > 0 && found === null) {
                const dir = stack.pop()!;
                const subdirs: string[] = [];
                for (const entry of vfs.listDirectory(dir)) {
                    if (entry.kind === "dir") { subdirs.push(entry.path); continue; }
                    if (matches(entry.path)) { found = entry.path; break; }
                }
                // Reversed so the pop order stays the enumeration order.
                for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
            }

            if (found === null) {
                System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
                return 0;
            }

            const bytes = encodeAnsi(found);
            if (bytes.length + 1 > MAX_PATH) {
                System.getInstance().scheduler.setLastError(ERROR_INSUFFICIENT_BUFFER);
                return 0;
            }
            if (!isValidAddress(mem, outPtr, bytes.length + 1, "rw")) {
                System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            Mem.writeBytes(outPtr, bytes);
            Mem.writeUint8(outPtr + bytes.length, 0);
            return 1;
        };

        return exports;
}

export class DbgHelp implements IModule {
    name = "dbghelp";
    exports: Record<string, ThunkImplementation> = createDbgHelpExports();

    initialize(_process: Process): void {}

    constructor(_process?: Process) {}
}
