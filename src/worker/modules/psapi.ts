import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import { LoadedPEModule } from "../core/module-registry";
import { Logger, LogCategory } from "../core/logger";
import { encodeAnsi } from "./codepage-utils";
import { getVirtualProcessManager, VIRTUAL_CURRENT_PROCESS_ID } from "./kernel32/process/virtual-process-manager";

/**
 * PSAPI — process/module enumeration over the real ModuleRegistry.
 *
 * Every answer here has to agree with what kernel32's toolhelp snapshot and
 * GetModuleFileName report: crash reporters (Gothic's SHW32) walk BOTH and treat a
 * disagreement as a corrupted process image.
 */

const ERROR_INSUFFICIENT_BUFFER = 122;
const PROCESS_MEMORY_COUNTERS_SIZE = 40;
const PROCESS_MEMORY_COUNTERS_EX_SIZE = 44;

/** Modules a psapi walk may see: the EXE plus every real DLL mapped from the VFS. */
function enumerableModules(): LoadedPEModule[] {
    const registry = System.getInstance().process?.moduleRegistry;
    if (!registry) return [];
    const mods = registry.getAllModules().filter(m => m.isExecutable || m.isRealDll);
    // EnumProcessModules documents the EXE as the first entry; callers use [0] as
    // "the process image" without re-checking.
    mods.sort((a, b) => (b.isExecutable ? 1 : 0) - (a.isExecutable ? 1 : 0));
    return mods;
}

/**
 * A handle that names no registered image has no MODULEINFO, and every caller here
 * fails rather than substitute one: reporting the EXE for an unknown HMODULE hands
 * back a base/size pair for a different module, which a pattern scanner then walks.
 * resolvePeModuleBase already maps NULL and the 0x400000 placeholder to the EXE.
 */
function moduleFor(hModule: number): LoadedPEModule | undefined {
    const registry = System.getInstance().process?.moduleRegistry;
    if (!registry) return undefined;
    return registry.getByBase(registry.resolvePeModuleBase(hModule >>> 0));
}

function baseNameOf(mod: LoadedPEModule): string {
    return mod.path ? (mod.path.split("\\").pop() ?? mod.name) : mod.name;
}

/** Shared A/W tail of GetModuleBaseName / GetModuleFileNameEx: copy, truncate, count. */
function writeAnsi(text: string, ptr: number, nSize: number): number {
    if (!ptr || nSize === 0) return 0;
    const bytes = encodeAnsi(text);
    const copied = Math.min(bytes.length, nSize - 1);
    if (Mem.writeBytes(ptr, bytes.subarray(0, copied)) !== copied) return 0;
    if (!Mem.writeUint8(ptr + copied, 0)) return 0;
    return copied;
}

function writeWide(text: string, ptr: number, nSize: number): number {
    if (!ptr || nSize === 0) return 0;
    const copied = Math.min(text.length, nSize - 1);
    for (let i = 0; i < copied; i++) {
        if (!Mem.writeUint16(ptr + i * 2, text.charCodeAt(i))) return 0;
    }
    if (!Mem.writeUint16(ptr + copied * 2, 0)) return 0;
    return copied;
}

export class Psapi implements IModule {
    name = "psapi";
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        // BOOL EnumProcesses(DWORD* lpidProcess, DWORD cb, DWORD* lpcbNeeded)
        this.exports["EnumProcesses"] = (ctx, mem, args) => {
            const lpidProcess = args[0] >>> 0;
            const cb = args[1] >>> 0;
            const lpcbNeeded = args[2] >>> 0;

            const pids = [VIRTUAL_CURRENT_PROCESS_ID >>> 0];
            for (const entry of getVirtualProcessManager().listProcessSnapshotEntries()) {
                if (!pids.includes(entry.pid)) pids.push(entry.pid);
            }

            // cb is a BYTE count; a caller that sized the buffer too small gets the
            // truncated list and a "needed" of what FIT (documented psapi quirk — the
            // caller detects truncation by needed === cb, not by a larger value).
            const fits = Math.min(pids.length, Math.floor(cb / 4));
            for (let i = 0; i < fits; i++) {
                if (!Mem.writeUint32(lpidProcess + i * 4, pids[i])) return 0;
            }
            if (lpcbNeeded && !Mem.writeUint32(lpcbNeeded, fits * 4)) return 0;
            return 1;
        };

        // BOOL EnumProcessModules(HANDLE hProcess, HMODULE* lphModule, DWORD cb, LPDWORD lpcbNeeded)
        const enumModules = (lphModule: number, cb: number, lpcbNeeded: number): number => {
            const mods = enumerableModules();
            const fits = Math.min(mods.length, Math.floor(cb / 4));
            for (let i = 0; i < fits; i++) {
                if (!Mem.writeUint32(lphModule + i * 4, mods[i].baseAddress >>> 0)) return 0;
            }
            // Unlike EnumProcesses, lpcbNeeded here IS the full requirement, so a caller
            // can grow the buffer and retry.
            if (lpcbNeeded && !Mem.writeUint32(lpcbNeeded, mods.length * 4)) return 0;
            return 1;
        };

        this.exports["EnumProcessModules"] = (ctx, mem, args) =>
            enumModules(args[1] >>> 0, args[2] >>> 0, args[3] >>> 0);

        // BOOL EnumProcessModulesEx(HANDLE, HMODULE*, DWORD, LPDWORD, DWORD dwFilterFlag)
        // We are 32-bit only, so LIST_MODULES_32BIT/64BIT/ALL all select the same set.
        this.exports["EnumProcessModulesEx"] = (ctx, mem, args) =>
            enumModules(args[1] >>> 0, args[2] >>> 0, args[3] >>> 0);

        // DWORD GetModuleBaseNameA(HANDLE hProcess, HMODULE hModule, LPSTR lpBaseName, DWORD nSize)
        this.exports["GetModuleBaseNameA"] = (ctx, mem, args) => {
            const mod = moduleFor(args[1] >>> 0);
            if (!mod) return 0;
            return writeAnsi(baseNameOf(mod), args[2] >>> 0, args[3] >>> 0);
        };

        this.exports["GetModuleBaseNameW"] = (ctx, mem, args) => {
            const mod = moduleFor(args[1] >>> 0);
            if (!mod) return 0;
            return writeWide(baseNameOf(mod), args[2] >>> 0, args[3] >>> 0);
        };

        // DWORD GetModuleFileNameExA(HANDLE hProcess, HMODULE hModule, LPSTR lpFilename, DWORD nSize)
        this.exports["GetModuleFileNameExA"] = (ctx, mem, args) => {
            const mod = moduleFor(args[1] >>> 0);
            if (!mod) return 0;
            return writeAnsi(mod.path || `C:\\${baseNameOf(mod)}`, args[2] >>> 0, args[3] >>> 0);
        };

        this.exports["GetModuleFileNameExW"] = (ctx, mem, args) => {
            const mod = moduleFor(args[1] >>> 0);
            if (!mod) return 0;
            return writeWide(mod.path || `C:\\${baseNameOf(mod)}`, args[2] >>> 0, args[3] >>> 0);
        };

        // BOOL GetModuleInformation(HANDLE hProcess, HMODULE hModule, LPMODULEINFO lpmodinfo, DWORD cb)
        // MODULEINFO = { LPVOID lpBaseOfDll; DWORD SizeOfImage; LPVOID EntryPoint; }
        this.exports["GetModuleInformation"] = (ctx, mem, args) => {
            const lpmodinfo = args[2] >>> 0;
            const cb = args[3] >>> 0;
            if (!lpmodinfo || cb < 12) return 0;

            const mod = moduleFor(args[1] >>> 0);
            if (!mod) return 0;
            // SizeOfImage bounds the range a symbol resolver accepts as "inside this
            // module"; a placeholder here silently drops every address past it.
            const ok = Mem.writeUint32(lpmodinfo, mod.baseAddress >>> 0)
                && Mem.writeUint32(lpmodinfo + 4, mod.size >>> 0)
                && Mem.writeUint32(lpmodinfo + 8, (mod.baseAddress + mod.entryPoint) >>> 0);
            if (!ok) return 0;
            Logger.verbose(LogCategory.KERNEL32,
                `GetModuleInformation(0x${(args[1] >>> 0).toString(16)}) -> "${mod.name}" ` +
                `base=0x${mod.baseAddress.toString(16)} size=0x${mod.size.toString(16)}`);
            return 1;
        };

        // BOOL GetProcessMemoryInfo(HANDLE hProcess, PPROCESS_MEMORY_COUNTERS ppsmemCounters, DWORD cb)
        //
        // PROCESS_MEMORY_COUNTERS: +0 cb +4 PageFaultCount +8 PeakWorkingSetSize
        //   +12 WorkingSetSize +16/20 QuotaPeak/PagedPoolUsage +24/28 QuotaPeak/NonPagedPoolUsage
        //   +32 PagefileUsage +36 PeakPagefileUsage  (40 bytes); the _EX form adds +40 PrivateUsage.
        //
        // Reported from the allocator's own accounting rather than a fixed number: a caller
        // polls this to decide when to drop caches, and a constant makes it either never free
        // anything or free constantly.
        this.exports["GetProcessMemoryInfo"] = (ctx, mem, args) => {
            const counters = args[1] >>> 0;
            const cb = args[2] >>> 0;
            if (!counters || cb < PROCESS_MEMORY_COUNTERS_SIZE) {
                System.getInstance().scheduler.setLastError(ERROR_INSUFFICIENT_BUFFER);
                return 0;
            }

            const metrics = System.getInstance().process?.memory.getMetrics();
            const current = metrics?.currentBytes ?? 0;
            const peak = metrics?.peakBytes ?? current;

            const ok = Mem.writeUint32(counters, cb)
                // No process-wide soft-fault counter exists (the recorder keeps a ring of
                // FAULTS WE TRAPPED, not the demand-zero faults Windows counts here), so 0
                // rather than a plausible-looking invention.
                && Mem.writeUint32(counters + 4, 0)
                && Mem.writeUint32(counters + 8, peak >>> 0)
                && Mem.writeUint32(counters + 12, current >>> 0)
                // No paged/non-paged pool quota accounting exists here; zero is what a
                // process with no kernel-object churn legitimately reports.
                && Mem.writeUint32(counters + 16, 0)
                && Mem.writeUint32(counters + 20, 0)
                && Mem.writeUint32(counters + 24, 0)
                && Mem.writeUint32(counters + 28, 0)
                // Nothing is ever paged out, so committed private bytes == working set.
                && Mem.writeUint32(counters + 32, current >>> 0)
                && Mem.writeUint32(counters + 36, peak >>> 0);
            if (!ok) return 0;
            if (cb >= PROCESS_MEMORY_COUNTERS_EX_SIZE && !Mem.writeUint32(counters + 40, current >>> 0)) return 0;
            return 1;
        };
    }
}
