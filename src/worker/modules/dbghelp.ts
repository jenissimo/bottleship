import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Marshaler } from "../core/memory/marshaler";
import { Mem } from "../core/memory/mem-accessor";
import { encodeAnsi } from "./codepage-utils";

export class DbgHelp implements IModule {
    name = "dbghelp";
    exports: Record<string, ThunkImplementation> = {};

    initialize(_process: Process): void {}

    constructor(_process: Process) {
        const exports = this.exports;

        // BOOL SymInitialize(HANDLE hProcess, PCSTR UserSearchPath, BOOL fInvadeProcess)
        exports['SymInitialize'] = () => 1; // TRUE

        // BOOL SymCleanup(HANDLE hProcess)
        exports['SymCleanup'] = () => 1;

        // DWORD SymSetOptions(DWORD SymOptions)
        exports['SymSetOptions'] = (_ctx, _mem, args) => args[0] >>> 0;

        // DWORD SymGetOptions(void)
        exports['SymGetOptions'] = () => 0;

        // DWORD SymGetModuleBase(HANDLE hProcess, DWORD dwAddr)
        exports['SymGetModuleBase'] = () => 0;

        // DWORD64 SymGetModuleBase64(HANDLE hProcess, DWORD64 dwAddr)
        exports['SymGetModuleBase64'] = () => 0;

        // DWORD SymLoadModule(HANDLE, HANDLE, PCSTR, PCSTR, DWORD, DWORD)
        exports['SymLoadModule'] = () => 0;

        // PVOID SymFunctionTableAccess(HANDLE hProcess, DWORD AddrBase)
        exports['SymFunctionTableAccess'] = () => 0;

        // PVOID SymFunctionTableAccess64(HANDLE hProcess, DWORD64 AddrBase)
        exports['SymFunctionTableAccess64'] = () => 0;

        // BOOL SymGetLineFromAddr(HANDLE, DWORD, PDWORD, PIMAGEHLP_LINE)
        exports['SymGetLineFromAddr'] = () => 0; // FALSE

        // BOOL SymGetSymFromAddr(HANDLE, DWORD, PDWORD, PIMAGEHLP_SYMBOL)
        exports['SymGetSymFromAddr'] = () => 0; // FALSE

        // BOOL StackWalk(DWORD, HANDLE, HANDLE, LPSTACKFRAME, PVOID, PREAD_PROCESS_MEMORY_ROUTINE, PFUNCTION_TABLE_ACCESS_ROUTINE, PGET_MODULE_BASE_ROUTINE, PTRANSLATE_ADDRESS_ROUTINE)
        exports['StackWalk'] = () => 0; // FALSE — no frames

        // BOOL StackWalk64(DWORD, HANDLE, HANDLE, LPSTACKFRAME64, PVOID, PREAD_PROCESS_MEMORY_ROUTINE64, PFUNCTION_TABLE_ACCESS_ROUTINE64, PGET_MODULE_BASE_ROUTINE64, PTRANSLATE_ADDRESS_ROUTINE64)
        exports['StackWalk64'] = () => 0; // FALSE — no frames

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
    }
}
