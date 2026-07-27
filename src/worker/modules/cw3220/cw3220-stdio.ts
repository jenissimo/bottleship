import { Process } from "../../core/process";
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { System } from "../../core/system";
import { writeGetcStub } from "../crt-slab-stubs";
import { writeGuestCode } from "../../core/memory/guest-code";

// ----------------------------------------------------------------------------
// CW3220.DLL stdio HLE (partial override of a real DLL)
// ----------------------------------------------------------------------------
// CW3220.DLL is the Borland C++ 1996 runtime. Games compiled with Borland (e.g.
// Discworld Noir / Tin3 engine) statically import their CRT from it and read ALL
// their data through CW3220's stdio (_fopen/_fread/...).
//
// We load CW3220 as a REAL DLL (its math / string / C++ / exception machinery must
// stay native — reimplementing it is impractical), but its stdio FILE subsystem
// performs no file I/O in our HLE environment: every _fopen returns NULL WITHOUT
// ever reaching kernel32 CreateFileA (confirmed for Discworld Noir — zero CRT opens
// reach the VFS across the entire boot, despite DllMain running and the target
// files existing). Consequence: the engine's resource scanner finds no language
// files and aborts at startup ("There are no text resource files").
//
// Fix: override JUST CW3220's stdio exports in the importing EXE's IAT with our
// VFS-backed handlers (reused from the msvcrt module, so the pseudo-FILE* space is
// shared and consistent), leaving the rest of CW3220 native. The Borland CRT is
// __cdecl, so all stubs are caller-cleans (RET, stackCleanupBytes 0).
//
// Generic + reusable: any Borland/Watcom-RTL game whose CRT DLL is in DLL_PARTIAL_HLE
// gets working stdio for free.

interface Cw3220StubInfo {
    name: string;
    argCount: number;
    callingConvention: "cdecl";
    stackCleanupBytes: 0;
}

/**
 * Install VFS-backed stdio thunks for CW3220.DLL and return the export table
 * (function-name -> stub address) so the PE loader can patch the importing EXE's
 * IAT entries. Returns null if the msvcrt module (which provides the FILE*
 * implementation we reuse) is unavailable.
 */
export function installCw3220Stdio(process: Process): Map<string, number> | null {
    const msvcrt: any = process.modules.get("msvcrt");
    if (!msvcrt?.exports) {
        Logger.warn(LogCategory.SYSTEM, `[cw3220] msvcrt module unavailable — cannot HLE stdio`);
        return null;
    }
    const m = msvcrt.exports as Record<string, ThunkImplementation>;

    // Borland's CRT inlines getc/putc — the hot loops read FILE->level (+0) and
    // FILE->curp (+20) straight out of the FILE struct (e.g. the engine's LZSS
    // resource decompressor in Discworld Noir). msvcrt's default FILE* is a bare
    // 0x70000000 token (outside guest RAM), so those reads return garbage and
    // decompression fails ("Decompression error"). Switch msvcrt to real, zeroed
    // FILE structs so the inlined macro always defers to our _fgetc.
    msvcrt.enableRealFileStructs?.();
    const noop0: ThunkImplementation = () => 0;     // success / NULL DIR* / dropped output
    const fail: ThunkImplementation = () => -1;     // _fstat: report failure, caller falls back

    // [name, handler, argCount]. FILE*-consuming funcs MUST all be overridden so our
    // pseudo-FILE* never reaches real CW3220 code. fprintf/vfprintf are dropped (output
    // only, not needed to boot) but still overridden so they don't deref our FILE*.
    const table: Array<[string, ThunkImplementation | undefined, number]> = [
        ["_fopen", m["_fopen"], 2],
        ["_fclose", m["_fclose"], 1],
        ["_fread", m["_fread"], 4],
        ["_fwrite", m["_fwrite"], 4],
        ["_fseek", m["_fseek"], 3],
        ["_ftell", m["_ftell"], 1],
        ["_fgets", m["_fgets"], 3],
        ["__fgetc", m["_fgetc"], 1],   // Borland's getc spelling
        ["_chdir", m["_chdir"], 1],
        ["_fprintf", noop0, 2],
        ["_vfprintf", noop0, 3],
        ["_fstat", fail, 2],
        ["_flushall", noop0, 0],
        ["_remove", noop0, 1],
        ["_mkdir", noop0, 1],
        ["_opendir", noop0, 1],        // stub: no directory enumeration (not on the boot path)
        ["_readdir", noop0, 1],
        ["_closedir", noop0, 1],
    ];

    const handlers: Record<string, ThunkImplementation> = {};
    const methods: Cw3220StubInfo[] = [];
    for (const [name, handler, argCount] of table) {
        if (!handler) {
            Logger.warn(LogCategory.SYSTEM, `[cw3220] no handler for ${name} — leaving native`);
            continue;
        }
        handlers[name] = handler;
        methods.push({ name, argCount, callingConvention: "cdecl", stackCleanupBytes: 0 });
    }

    process.dispatcher.registerModule("cw3220", handlers);
    const stubDll = process.thunkGenerator.generateStubDll("cw3220", methods);

    if (stubDll.stubCode.length > 0) {
        try {
            process.memory.allocAt(stubDll.baseAddress, stubDll.stubCode.length, "THUNK_CODE", "rx");
        } catch {
            // Already reserved — fine.
        }
        const mem = process.getCurrentMemory();
        if (stubDll.baseAddress + stubDll.stubCode.length > mem.length) {
            Logger.error(LogCategory.SYSTEM, `[cw3220] stub write OOB at 0x${stubDll.baseAddress.toString(16)}`);
            return null;
        }
        writeGuestCode(mem, stubDll.stubCode, stubDll.baseAddress);
    }

    // Inline x86 getc fast path. The Tin3 LZSS decompressor calls __fgetc(FILE*) as a
    // real function once per input byte (~13.3M traps over Discworld's boot, profiled at
    // 92% of the worker in JS thunk dispatch — it does NOT inline the getc macro, so the
    // JS buffered-getc path still trapped per byte). The inline stub serves bytes straight
    // from the guest FILE buffer in guest code and only OUT-traps to the original __fgetc
    // stub to refill a chunk — collapsing ~262144 per-byte traps into 1. Generic for any
    // Borland/Watcom-RTL game on this path. Global kill-switch: window.__noGetcStub.
    if (!(globalThis as any).__noGetcStub) {
        try {
            const fgetcTrap = stubDll.exportTable.get("__fgetc");
            const tmm = process.thunkMemoryManager;
            if (fgetcTrap && tmm) {
                const { levelOff, curpOff } = msvcrt.getBorlandFileLayout();
                const inline = writeGetcStub(tmm.stubAllocator,
                    () => process.getCurrentMemory(), fgetcTrap, levelOff, curpOff);
                // Redirect the IAT (patched from this exportTable in pe-loader) to the inline
                // stub; its slow path JMPs back to the original OUT-trap stub.
                stubDll.exportTable.set("__fgetc", inline.getcStub);
                // level--/curp++ is a short non-atomic RMW on the per-FILE struct — keep it
                // atomic vs the 1ms-quantum thread switch (mirrors the heap slab stubs).
                System.getInstance().scheduler?.registerNonPreemptibleRange(
                    inline.regionBase, inline.regionEnd);
            }
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `[cw3220] inline getc stub unavailable: ${e}`);
        }
    }

    process.dispatcher.applyPendingRegistrations();

    // relaxed-FPU stays ENABLED for Borland-RTL games too. Disabling it for
    // transcendentals (F2XM1/FYL2X/FSCALE) was a crutch — the fix belongs in the
    // relaxed-FPU path in vendor/v86. relaxed-FPU is the universal fast path and
    // must never be turned off per-game.

    Logger.warn(
        LogCategory.SYSTEM,
        `[cw3220] HLE stdio installed: ${methods.length} funcs, stubs @ 0x${stubDll.baseAddress.toString(16)}`
    );
    return stubDll.exportTable;
}
