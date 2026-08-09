/**
 * MSVCRT minimal thunk module.
 * Provides basic memory/string/stdlib helpers needed by legacy apps.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation, ThunkResult } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import { VfsFileHandle } from "../runtime/filesystem/vfs";
import { fpuGetST, fpuPop, fpuPush, fpuSetST0 } from "../core/fpu-helper";
import { getCPU, getMemory } from "../core/thunking/thunk-utils";
import { Marshaler } from "../core/memory/marshaler";
import { VaListReader, ArrayVaListReader, encodeAnsi, formatCLazy } from "./crt-format";
import { scanfCore } from "./crt-scanf";
import { getCodePageDecoder } from "./codepage-utils";
import { EmulatorConfig } from "../core/emulator-config-manager";
import { hypercallDataManager } from "../core/cpu/hypercall-data";
import { asBufferSource } from "../../dom-buffer";
import { getSlabSizeForPtr, freeHeapBlock, maybeGrowHeapSlab, HEAP_SMALL_ALLOC_MAX } from "./kernel32/memory";
import { ensureNativeQsort } from "./crt-qsort";
import { ensureNativeCBsearch } from "./crt-cbsearch";
import { LARGE_IO_TRACE_ENABLED, traceLargeRead } from "../core/diagnostics/large-io-trace";
import { registerVc9AbiExports } from "./crt-vc9-abi";
import { registerVc9IoExports, fillStatStruct, STAT32_OFFSETS } from "./crt-vc9-io";
import { registerVc9SehExports } from "./crt-vc9-seh";
import { registerVc9SetjmpExports } from "./crt-vc9-setjmp";
import { registerCrtMathExports } from "./crt-math";
import { registerCrtTimeExports } from "./crt-time";
import { registerCrtStringExports } from "./crt-string";
import { registerCrtMbExports } from "./crt-mb";
import { registerCrtConvExports } from "./crt-conv";
import { registerCrtPathExports } from "./crt-path";
import { registerCrtSeh3Exports } from "./crt-seh3";
import { ensureNativeEHProlog } from "./crt-eh-prolog";
import { registerRttiExports, demangleTypeInfoName } from "./crt-rtti";

/** Priming value for fgetsLoop — a generator's first next() discards its argument. */
const EMPTY_BYTES = new Uint8Array(0);

/** State behind one FILE* token (see fileStreams). */
interface MsvcrtFileStream {
    fd: number;
    handle: VfsFileHandle;
    ungetChar: number;
    text: boolean;
    eof: boolean;
    err: boolean;
    structPtr?: number;
    bufPtr?: number;
}

export class Msvcrt implements IModule {
    name = "msvcrt";
    exports: Record<string, ThunkImplementation> = {};

    private process!: Process;
    private randSeed = 1;
    private errnoAddr = 0;
    private pctypeVarAddr = 0;   // pointer-to-pointer: *pctypeVarAddr → pctypeTableAddr
    private pctypeTableAddr = 0; // actual ctype table (512 bytes, 256 x uint16)
    // 256-byte single-byte case-fold LUTs in guest RAM (THUNK_DATA). Single source of
    // truth for tolower/toupper — the JS impls below index them AND pe-loader points the
    // guest IAT at trap-free inline x86 stubs that index the same tables (writeCaseFoldStubs).
    // ASCII-only by default (matches the CRT "C" locale); repopulated over 0x80-0xFF from the
    // active ANSI codepage when the game setlocale()s / _setmbcp()s (so a CP1251 game that
    // switches locale gets faithful Cyrillic case-folding — the default JS path never did).
    private caseLowerTableAddr = 0;
    private caseUpperTableAddr = 0;
    private mbCurMaxAddr = 0;
    private fmodeAddr = 0;
    private commodeAddr = 0;
    private acmdlnAddr = 0;
    private arg0Addr = 0;
    private argvVectorAddr = 0;
    private argcAddr = 0;
    private argvPtrVarAddr = 0;
    private dosErrnoAddr = 0;
    private mbctypeAddr = 0;
    private ehPrologAddr = 0;
    private envpVectorAddr = 0;
    private environVarAddr = 0;  // char** _environ / __environ / _environ_dll
    private iobAddr = 0;
    private pioinfoAddr = 0;
    private badioinfoAddr = 0;
    private lcCodepageAddr = 0;  // int __lc_codepage — the CRT's active ANSI codepage
    // int _osver/_winmajor/_winminor/_winver — the CRT's cached GetVersion() fields.
    private osVerVarsAddr = 0;   // 4 consecutive ints in the order above
    private appType = 0;
    private userMathErrHandler = 0;
    private newHandlerPtr = 0;
    private newMode = 0;
    private strerrorBuf = 0;
    private crtDbgFlag = 0;
    private controlFpWord = 0x0009001f;
    private tempnamCounter = 0;
    /** atexit/_onexit table, registration order (exit runs it reversed). */
    private exitHandlers: number[] = [];
    private exitChainRunning = false;
    private static readonly MAX_EXIT_HANDLERS = 4096;
    private fdNext = 3;
    private fds: Map<number, VfsFileHandle> = new Map();
    /** CRT fd → Win32 HANDLE (for _get_osfhandle / _open_osfhandle). */
    private fdHandles: Map<number, number> = new Map();
    /** Win32 HANDLE → CRT fd */
    private handleFds: Map<number, number> = new Map();
    /** When non-null, tally wide-string pairs passed to wcscmp/_wcsicmp/wcsstr (dbg.strcap()). */
    public dbgStrCap: Map<string, number> | null = null;
    private _dbgCapPair(fn: string, aPtr: number, bPtr: number): void {
        const cap = this.dbgStrCap;
        if (!cap) return;
        try {
            const a = this.readWString(aPtr >>> 0, 64);
            const b = this.readWString(bPtr >>> 0, 64);
            const key = `${fn}(${a} , ${b})`;
            cap.set(key, (cap.get(key) ?? 0) + 1);
            if (cap.size > 4000) cap.set('__overflow__', (cap.get('__overflow__') ?? 0) + 1);
        } catch { /* ignore */ }
    }
    /** Narrow (ANSI) sibling of _dbgCapPair — for strcmp/_stricmp/_strnicmp/strstr (dbg.strcap()).
     *  Lets strcap catch ANSI-build (e.g. XIII/msvcr70) class-name comparisons the wide path misses. */
    private _dbgCapPairN(fn: string, aPtr: number, bPtr: number): void {
        const cap = this.dbgStrCap;
        if (!cap) return;
        try {
            const a = this.readCString(aPtr >>> 0, 64);
            const b = this.readCString(bPtr >>> 0, 64);
            const key = `${fn}(${a} , ${b})`;
            cap.set(key, (cap.get(key) ?? 0) + 1);
            if (cap.size > 4000) cap.set('__overflow__', (cap.get('__overflow__') ?? 0) + 1);
        } catch { /* ignore */ }
    }
    private _dbgCapCaller(fn: string, ctx: any, mem: Uint8Array, keyPtr: number): void {
        const cap = this.dbgStrCap;
        if (!cap) return;
        try {
            const esp = (ctx?.esp ?? 0) >>> 0;
            if (!esp || esp + 4 > mem.length) return;
            const rd = (a: number) => (mem[a] | (mem[a + 1] << 8) | (mem[a + 2] << 16) | (mem[a + 3] << 24)) >>> 0;
            const caller = rd(esp);
            cap.set(`CALLER:${fn}=0x${caller.toString(16)}`, (cap.get(`CALLER:${fn}=0x${caller.toString(16)}`) ?? 0) + 1);
            // Walk up the stack for the first return addr in a non-core game module
            // (engine..galaxy 0x131f0000-0x136c0000, or hp 0x10900000-0x10972000, or
            // window 0x13000000-0x13086000) — the native code that drives this per frame.
            const key = this.readWString(keyPtr >>> 0, 40);
            let gc = 0;
            for (let off = esp + 4; off <= esp + 0x80 && off + 4 <= mem.length; off += 4) {
                const v = rd(off);
                const inGame = (v >= 0x131f0000 && v < 0x136c0000) || (v >= 0x10900000 && v < 0x10972000) || (v >= 0x13000000 && v < 0x13086000);
                if (inGame) { gc = v; break; }
            }
            if (gc) {
                const gk = `GC:${fn}[${key}]=0x${gc.toString(16)}`;
                cap.set(gk, (cap.get(gk) ?? 0) + 1);
            }
        } catch { /* ignore */ }
    }
    dbgStrCapStart(): void { this.dbgStrCap = new Map(); }
    dbgStrCapDump(top = 40): any {
        const cap = this.dbgStrCap;
        if (!cap) return null;
        const rows = Array.from(cap.entries()).sort((a, b) => b[1] - a[1]).slice(0, top)
            .map(([k, n]) => ({ cmp: k, count: n }));
        return { unique: cap.size, top: rows };
    }
    dbgStrCapStop(): void { this.dbgStrCap = null; }
    private static readonly MAX_WIDE_SCAN_CHARS = 0x10000;
    private static readonly MAX_WIDE_COPY_CHARS = 0x4000;
    private static readonly STACK_GUARD_BYTES = 32;
    private static readonly STACK_WCSCPY_HARD_CAP_CHARS = 260;
    private acmdlnVarAddr = 0;   // 4-byte pointer-to-string: *acmdlnVarAddr → acmdlnAddr (string data)
    private adjustFdivAddr = 0;  // 4-byte int variable (value 0 = no FDIV bug)
    private encodedNullAddr = 0; // VC9 _encoded_null DATA export (encoded NULL pointer cookie)
    private qsortCodeAddr = 0;
    private bsearchCodeAddr = 0;
    private readonly crtAllocations = new Map<number, number>();

    initialize(process: Process): void {
        this.process = process;
        this.ensureRuntimeStorage();
        this.registerDataExports();

        const exports = this.exports;

        exports["malloc"] = (ctx, mem, args) => this.malloc(args[0] ?? 0);
        exports["_malloc_dbg"] = (ctx, mem, args) => this.malloc(args[0] ?? 0);
        exports["_malloc"] = (ctx, mem, args) => this.malloc(args[0] ?? 0);
        exports["??2@YAPAXI@Z"] = (ctx, mem, args) => this.malloc(args[0] ?? 0);
        exports["@$bnew$qui"] = (ctx, mem, args) => this.malloc(args[0] ?? 0);
        exports["free"] = (ctx, mem, args) => this.free(args[0] ?? 0);
        exports["_free_dbg"] = (ctx, mem, args) => this.free(args[0] ?? 0);
        exports["_free"] = (ctx, mem, args) => this.free(args[0] ?? 0);
        exports["calloc"] = (ctx, mem, args) => this.calloc(args[0] ?? 0, args[1] ?? 0);
        exports["_calloc_dbg"] = (ctx, mem, args) => this.calloc(args[0] ?? 0, args[1] ?? 0);
        exports["_calloc"] = (ctx, mem, args) => this.calloc(args[0] ?? 0, args[1] ?? 0);
        exports["realloc"] = (ctx, mem, args) => this.realloc(args[0] ?? 0, args[1] ?? 0);
        exports["_realloc_dbg"] = (ctx, mem, args) => this.realloc(args[0] ?? 0, args[1] ?? 0);
        exports["_realloc"] = (ctx, mem, args) => this.realloc(args[0] ?? 0, args[1] ?? 0);

        exports["memset"] = (ctx, mem, args) => this.memset(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["memcpy"] = (ctx, mem, args) => this.memcpy(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["memmove"] = (ctx, mem, args) => this.memmove(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);

        exports["strlen"] = (ctx, mem, args) => this.strlen(args[0] ?? 0);
        exports["strcpy"] = (ctx, mem, args) => this.strcpy(args[0] ?? 0, args[1] ?? 0);
        exports["strncpy"] = (ctx, mem, args) => this.strncpy(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["strcat"] = (ctx, mem, args) => this.strcat(args[0] ?? 0, args[1] ?? 0);
        exports["strncat"] = (ctx, mem, args) => this.strncat(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["strcmp"] = (ctx, mem, args) => { if (this.dbgStrCap) this._dbgCapPairN('strcmp', args[0] ?? 0, args[1] ?? 0); return this.strcmp(args[0] ?? 0, args[1] ?? 0); };
        exports["_strcmpi"] = (ctx, mem, args) => { if (this.dbgStrCap) this._dbgCapPairN('_strcmpi', args[0] ?? 0, args[1] ?? 0); return this.stricmp(args[0] ?? 0, args[1] ?? 0); };
        exports["_stricmp"] = (ctx, mem, args) => { if (this.dbgStrCap) this._dbgCapPairN('_stricmp', args[0] ?? 0, args[1] ?? 0); return this.stricmp(args[0] ?? 0, args[1] ?? 0); };
        exports["_strnicmp"] = (ctx, mem, args) => { if (this.dbgStrCap) this._dbgCapPairN('_strnicmp', args[0] ?? 0, args[1] ?? 0); return this.strnicmp(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0); };
        exports["strchr"] = (ctx, mem, args) => this.strchr(args[0] ?? 0, args[1] ?? 0);
        exports["strrchr"] = (ctx, mem, args) => this.strrchr(args[0] ?? 0, args[1] ?? 0);
        exports["wcslen"] = (ctx, mem, args) => this.wcslen(args[0] ?? 0);
        exports["wcscpy"] = (ctx, mem, args) => this.wcscpy(args[0] ?? 0, args[1] ?? 0);
        exports["wcschr"] = (ctx, mem, args) => this.wcschr(args[0] ?? 0, args[1] ?? 0);
        exports["wcscat"] = (ctx, mem, args) => this.wcscat(args[0] ?? 0, args[1] ?? 0);
        exports["wcscmp"] = (ctx, mem, args) => this.wcscmp(args[0] ?? 0, args[1] ?? 0);
        exports["wcsncmp"] = (ctx, mem, args) => this.wcsncmp(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["wcsncpy"] = (ctx, mem, args) => this.wcsncpy(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["wcsstr"] = (ctx, mem, args) => { if (this.dbgStrCap) this._dbgCapCaller('wcsstr', ctx, mem, args[1] ?? 0); return this.wcsstr(args[0] ?? 0, args[1] ?? 0); };
        exports["_wcsicmp"] = (ctx, mem, args) => { if (this.dbgStrCap) this._dbgCapCaller('_wcsicmp', ctx, mem, args[0] ?? 0); return this.wcsicmp(args[0] ?? 0, args[1] ?? 0); };
        exports["_wcsnicmp"] = (ctx, mem, args) => this.wcsnicmp(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["_wcsupr"] = (ctx, mem, args) => this.wcsupr(args[0] ?? 0);
        exports["_strlwr"] = (ctx, mem, args) => this.strlwr(args[0] ?? 0);
        exports["_strdup"] = (ctx, mem, args) => this.strdup(args[0] ?? 0);
        exports["_strdup_dbg"] = (ctx, mem, args) => this.strdup(args[0] ?? 0);

        exports["sprintf"] = (ctx, mem, args) => this.sprintf(args);
        exports["printf"] = (ctx, mem, args) => this.printf(args);
        exports["sscanf"] = (ctx, mem, args) => this.sscanf(args);
        exports["fscanf"] = (ctx, mem, args) => this.fscanf(args);
        exports["_fscanf"] = exports["fscanf"];
        // setbuf/setvbuf — buffering is internal to our VFS; accept and no-op.
        exports["setbuf"] = () => 0;
        exports["setvbuf"] = () => 0;

        exports["srand"] = (ctx, mem, args) => this.srand(args[0] ?? 0);
        exports["rand"] = () => this.rand();

        // --- Time/date — see crt-time.ts ---
        registerCrtTimeExports(exports, {
            process: this.process,
            writeUint16: (addr, value) => this.writeUint16(addr, value),
            writeCString: (ptr, value) => this.writeCString(ptr, value),
            writeWString: (ptr, value, maxChars) => this.writeWString(ptr, value, maxChars),
        });

        // /GZ stack-check stub — no-op in HLE (release builds omit calls).
        exports["_chkesp"] = () => 0;

        exports["_rotr"] = (_ctx, _mem, args) => {
            const value = args[0] >>> 0;
            const shift = (args[1] ?? 0) & 31;
            if (shift === 0) return value;
            return ((value >>> shift) | (value << (32 - shift))) >>> 0;
        };

        exports["_errno"] = () => this.errnoAddr;
        exports["__doserrno"] = () => this.dosErrnoAddr;
        exports["__p__pctype"] = () => this.pctypeVarAddr;
        exports["__p___mb_cur_max"] = () => this.mbCurMaxAddr;
        exports["__p___argc"] = () => this.argcAddr;
        exports["__p___argv"] = () => this.argvPtrVarAddr;
        exports["_mbctype"] = () => this.mbctypeAddr;
        exports["__p__fmode"] = () => this.fmodeAddr;
        exports["__p__commode"] = () => this.commodeAddr;
        exports["_acmdln"] = () => this.acmdlnAddr;
        exports["_environ"] = () => this.environVarAddr;
        exports["__environ"] = () => this.environVarAddr;
        exports["_environ_dll"] = () => this.environVarAddr;
        exports["?_query_new_handler@@YAP6AHI@ZXZ"] = () => this.newHandlerPtr >>> 0;
        exports["?_query_new_mode@@YAHXZ"] = () => this.newMode;
        exports["?_set_new_mode@@YAHH@Z"] = (ctx, mem, args) => {
            const prev = this.newMode;
            this.newMode = args[0] ?? 0;
            return prev;
        };
        exports["?_set_new_handler@@YAP6AHI@ZP6AHI@Z@Z"] = (ctx, mem, args) => {
            const prev = this.newHandlerPtr >>> 0;
            this.newHandlerPtr = args[0] ?? 0;
            return prev;
        };
        exports["?set_new_handler@@YAP6AXXZP6AXXZ@Z"] = (ctx, mem, args) => {
            const prev = this.newHandlerPtr >>> 0;
            this.newHandlerPtr = args[0] ?? 0;
            return prev;
        };
        exports["@set_new_handler$qpqv$v"] = exports["?set_new_handler@@YAP6AXXZP6AXXZ@Z"];
        exports["__set_app_type"] = (ctx, mem, args) => this.setAppType(args[0] ?? 0);
        exports["__setusermatherr"] = (ctx, mem, args) => this.setUserMathErr(args[0] ?? 0);
        exports["__getmainargs"] = (ctx, mem, args) =>
            this.getMainArgs(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, args[3] ?? 0, args[4] ?? 0);
        exports["_XcptFilter"] = (ctx, mem, args) => this.xcptFilter(args[0] ?? 0, args[1] ?? 0);
        exports["_CrtDbgReport"] = (ctx, mem, args) => this.crtDbgReport(mem, args, false);
        exports["_CrtDbgReportW"] = (ctx, mem, args) => this.crtDbgReport(mem, args, true);
        exports["_CrtSetDbgFlag"] = (ctx, mem, args) => this.crtSetDbgFlag(args[0] ?? 0);
        exports["_CrtCheckMemory"] = () => 1;
        exports["_CrtIsValidHeapPointer"] = (ctx, mem, args) => {
            const ptr = args[0] >>> 0;
            return ptr === 0 ? 0 : (this.process.memory.getSize(ptr) !== undefined ? 1 : 0);
        };
        exports["_CrtDumpMemoryLeaks"] = () => 0;
        exports["_assert"] = (ctx, mem, args) => this.crtAssert(mem, args, false);
        exports["_wassert"] = (ctx, mem, args) => this.crtAssert(mem, args, true);
        exports["_isctype"] = (ctx, mem, args) => this.isctype(args[0] ?? 0, args[1] ?? 0);
        exports["exit"] = (ctx, mem, args) => this.exitWithHandlers(args[0] ?? 0);
        // _exit() is the "skip the atexit table" flavour by contract, not an alias.
        exports["_exit"] = (ctx, mem, args) => this.exitProcess(args[0] ?? 0);
        exports["_execl"] = (ctx, mem, args) => this.execl(args);
        exports["_execv"] = (ctx, mem, args) => this.execv(args[0] ?? 0, args[1] ?? 0);

        exports["_adjust_fdiv"] = () => 0;
        exports["_initterm"] = (ctx, mem, args) => this.initterm(args[0] ?? 0, args[1] ?? 0);
        exports["_ftol"] = () => this.ftol();
        exports["_atoi64"] = (ctx, mem, args) => this.atoi64(args[0] ?? 0);
        exports["_CItan"] = () => this.CItan();
        exports["_CIatan2"] = () => this.CIatan2();
        exports["_CIfmod"] = () => this.CIfmod();
        exports["ceil"] = (ctx, mem, args) => this.ceil(args[0] ?? 0, args[1] ?? 0);
        exports["floor"] = (ctx, mem, args) => this.floor(args[0] ?? 0, args[1] ?? 0);
        exports["_isnan"] = (ctx, mem, args) => this.isnan(args[0] ?? 0, args[1] ?? 0);
        exports["_finite"] = (ctx, mem, args) => this.finite(args[0] ?? 0, args[1] ?? 0);
        exports["_controlfp"] = (ctx, mem, args) => this.controlfp(args[0] ?? 0, args[1] ?? 0);
        exports["_control87"] = (ctx, mem, args) => this.controlfp(args[0] ?? 0, args[1] ?? 0);
        exports["_clearfp"] = () => 0;
        exports["_vsnwprintf"] = (ctx, mem, args) =>
            this.vsnwprintf(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, args[3] ?? 0);

        exports["_open"] = (ctx, mem, args) => this.open(args[0] ?? 0, args[1] ?? 0);
        exports["_sopen"] = (ctx, mem, args) => this.sopen(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, args[3] ?? 0);
        exports["_close"] = (ctx, mem, args) => this.close(args[0] ?? 0);
        exports["_chsize"] = (ctx, mem, args) => this.chsize(args[0] ?? 0, args[1] ?? 0);
        exports["_chsize_s"] = (ctx, mem, args) => this.chsizeS(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["_read"] = (ctx, mem, args) => this.read(ctx, mem, args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["_write"] = (ctx, mem, args) => this.write(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["_lseek"] = (ctx, mem, args) => this.lseek(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["_lseeki64"] = (ctx, mem, args) => this.lseeki64(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, args[3] ?? 0);
        exports["_tell"] = (ctx, mem, args) => this.tell(args[0] ?? 0);
        exports["_filelength"] = (ctx, mem, args) => this.filelength(args[0] ?? 0);
        exports["_eof"] = (ctx, mem, args) => this.eof(args[0] ?? 0);
        exports["_commit"] = () => 0;
        exports["_stat"] = (ctx: any, mem: any, args: number[]) => this.statImpl(args[0] ?? 0, args[1] ?? 0, false);
        exports["_wstat"] = (ctx: any, mem: any, args: number[]) => this.statImpl(args[0] ?? 0, args[1] ?? 0, true);
        exports["qsort"] = () => 0;
        exports["bsearch"] = () => 0;   // overridden by the native data export (see ensureNativeCBsearch)
        exports["getenv"] = (ctx, mem, args) => {
            const name = Marshaler.readString(mem, args[0] ?? 0);
            Logger.verbose(LogCategory.SYSTEM, `getenv("${name}") -> NULL`);
            return 0; // NULL - environment variable not found
        };
        exports["_putenv"] = (ctx, mem, args) => {
            const envstr = Marshaler.readString(mem, args[0] ?? 0);
            Logger.verbose(LogCategory.SYSTEM, `_putenv("${envstr}") -> 0`);
            return 0; // success
        };
        exports["_wputenv"] = (ctx, mem, args) => {
            const envstr = Marshaler.readWideString(mem, args[0] ?? 0);
            Logger.verbose(LogCategory.SYSTEM, `_wputenv("${envstr}") -> 0`);
            return 0;
        };
        exports["_wgetenv"] = () => 0; // NULL

        // --- String functions (see crt-string.ts) ---
        registerCrtStringExports(exports, {
            readCString: (p, max) => this.readCString(p, max),
            compareCString: (a, b, ci, n) => this.compareCString(a, b, ci, n),
        });

        registerCrtMbExports(exports, {
            readCString: (p, max) => this.readCString(p, max),
            compareCString: (a, b, ci, n) => this.compareCString(a, b, ci, n),
            ischartype: (ch, mask) => this.ischartype(ch, mask),
            setMbcp: (cp) => this.setMbcp(cp),
            getMbcp: () => this.getMbcp(),
        });

        // --- Conversion functions — see crt-conv.ts ---
        registerCrtConvExports(exports, {
            process: this.process,
            readCString: (p, max) => this.readCString(p, max),
            readWString: (p, max) => this.readWString(p, max),
            writeCString: (p, v) => this.writeCString(p, v),
            writeUint16: (addr, value) => this.writeUint16(addr, value),
            caseLowerTableAddr: () => this.caseLowerTableAddr,
            caseUpperTableAddr: () => this.caseUpperTableAddr,
        });
        exports["setlocale"] = (ctx, mem, args) => this.setlocale(args[0] ?? 0, args[1] ?? 0);
        exports["localeconv"] = () => this.localeconv();

        // --- Formatted output ---
        exports["_vsnprintf"] = (ctx, mem, args) => this.vsnprintf(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, args[3] ?? 0);
        exports["vsprintf"] = (ctx, mem, args) => this.vsprintf(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["_snprintf"] = (ctx, mem, args) => this.snprintf(args);

        // --- Path/directory — see crt-path.ts ---
        // (also registers _access/_mkdir/_splitpath/_tempnam and the EACCES stubs)
        const pathFns = registerCrtPathExports(exports, {
            readCString: (p, max) => this.readCString(p, max),
            writeCString: (p, v) => this.writeCString(p, v),
            malloc: (n) => this.malloc(n),
            setErrno: (e) => this.setErrno(e),
            nextTempnamSeq: () => (this.tempnamCounter++ & 0xffff),
        });
        exports["_setmode"] = () => 0;
        exports["_fileno"] = (ctx, mem, args) => this.fileno(args[0] ?? 0);
        exports["_open_osfhandle"] = (ctx, mem, args) => this.openOsfhandle(args[0] ?? 0, args[1] ?? 0);
        exports["_get_osfhandle"] = (ctx, mem, args) => this.getOsfhandle(args[0] ?? 0);
        exports["_fdopen"] = (ctx, mem, args) => this.fdopen(args[0] ?? 0, args[1] ?? 0);
        exports["_isatty"] = (ctx, mem, args) => (args[0] ?? 0) >= 0 && (args[0] ?? 0) <= 2 ? 1 : 0;

        // --- Math (FPU intrinsics) — see crt-math.ts ---
        registerCrtMathExports(exports, {
            process: this.process,
            u32PairToDouble: (lo, hi) => this.u32PairToDouble(lo, hi),
        });

        // --- Threading ---
        exports["_beginthread"] = (ctx, mem, args) => {
            const startAddress = args[0];
            const stackSize = args[1];
            const arglist = args[2];

            Logger.log(LogCategory.KERNEL32,
                `_beginthread(start=0x${(startAddress >>> 0).toString(16)}, ` +
                `arg=0x${(arglist >>> 0).toString(16)}, stack=${stackSize})`);

            const sched = System.getInstance().scheduler;
            const handle = sched.createThread(
                startAddress,
                arglist,
                stackSize,
                0,
                0,
                mem,
            );
            if (handle === 0) {
                sched.setLastError(8);
                return 0xffffffff;
            }
            return handle >>> 0;
        };
        exports["_beginthreadex"] = (ctx, mem, args) => {
            const stackSize = args[1];
            const startAddress = args[2];
            const arglist = args[3];
            const initFlag = args[4];
            const thrdAddr = args[5];
            const creationFlags = (initFlag & 0x4) ? 0x00000004 : 0; // CREATE_SUSPENDED

            Logger.log(LogCategory.KERNEL32,
                `_beginthreadex(start=0x${(startAddress >>> 0).toString(16)}, ` +
                `arg=0x${(arglist >>> 0).toString(16)}, stack=${stackSize}, init=0x${(initFlag >>> 0).toString(16)})`);

            const sched = System.getInstance().scheduler;
            const handle = sched.createThread(
                startAddress,
                arglist,
                stackSize,
                creationFlags,
                thrdAddr,
                mem,
            );
            if (handle === 0) {
                sched.setLastError(8);
                return 0;
            }
            return handle >>> 0;
        };
        exports["_endthread"] = (ctx, mem, args) => {
            Logger.log(LogCategory.KERNEL32, "_endthread()");
            System.getInstance().scheduler.exitThread(0);
            return { value: 0, terminated: true, stackCleanup: 0 };
        };
        exports["_endthreadex"] = (ctx, mem, args) => {
            const retCode = args[0] >>> 0;
            Logger.log(LogCategory.KERNEL32, `_endthreadex(code=0x${retCode.toString(16)})`);
            System.getInstance().scheduler.exitThread(retCode);
            return { value: 0, terminated: true, stackCleanup: 4 };
        };
        exports["signal"] = () => 0;
        exports["perror"] = (ctx, mem, args) => {
            this.perror(args[0] ?? 0);
            return 0;
        };
        exports["abort"] = () => this.terminateProcess(3, "msvcrt: abort() called");
        exports["_kbhit"] = () => 0; // no keyboard input pending
        exports["_getch"] = () => 0;

        // --- High-level file I/O (FILE* based) ---
        exports["fopen"] = (ctx, mem, args) => this.fopen(args[0] ?? 0, args[1] ?? 0);
        // FILE* _fsopen(path, mode, shflag) — fopen plus a share mode. Our VFS has no
        // mandatory locking, so every share mode resolves to the same open.
        exports["_fsopen"] = (ctx, mem, args) => this.fopen(args[0] ?? 0, args[1] ?? 0);
        exports["_wfsopen"] = (ctx, mem, args) => this.wfopen(args[0] ?? 0, args[1] ?? 0);
        exports["_wfopen"] = (ctx, mem, args) => this.wfopen(args[0] ?? 0, args[1] ?? 0);
        exports["wfopen"] = exports["_wfopen"];
        exports["fclose"] = (ctx, mem, args) => this.fclose(args[0] ?? 0);
        exports["fread"] = (ctx, mem, args) => this.fread(ctx, mem, args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, args[3] ?? 0);
        exports["fwrite"] = (ctx, mem, args) => this.fwrite(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, args[3] ?? 0);
        exports["fgets"] = (ctx, mem, args) => this.fgets(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["fputs"] = (ctx, mem, args) => this.fputs(args[0] ?? 0, args[1] ?? 0);
        exports["fseek"] = (ctx, mem, args) => this.fseek(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["ftell"] = (ctx, mem, args) => this.ftell(args[0] ?? 0);
        exports["fflush"] = () => 0;
        exports["fprintf"] = (ctx, mem, args) => this.fprintf(args);
        exports["feof"] = (ctx, mem, args) => this.feof_fn(args[0] ?? 0);
        exports["ferror"] = (ctx, mem, args) => this.ferror_fn(args[0] ?? 0);
        exports["clearerr"] = (ctx, mem, args) => this.clearerr_fn(args[0] ?? 0);
        exports["rewind"] = (ctx, mem, args) => this.rewind_fn(args[0] ?? 0);
        exports["fgetpos"] = (ctx, mem, args) => this.fgetpos(args[0] ?? 0, args[1] ?? 0);
        exports["fsetpos"] = (ctx, mem, args) => this.fsetpos(args[0] ?? 0, args[1] ?? 0);
        exports["fgetc"] = (ctx, mem, args) => this.fgetc(args[0] ?? 0);
        exports["getc"] = exports["fgetc"];
        exports["fputc"] = (ctx, mem, args) => this.fputc(args[0] ?? 0, args[1] ?? 0);
        exports["ungetc"] = (ctx, mem, args) => this.ungetc(args[0] ?? 0, args[1] ?? 0);
        exports["strerror"] = (ctx, mem, args) => this.strerror(args[0] ?? 0);

        // MSVC decorated aliases (_fopen = fopen, etc.)
        exports["_fopen"] = exports["fopen"];
        exports["_fclose"] = exports["fclose"];
        exports["_fread"] = exports["fread"];
        exports["_fwrite"] = exports["fwrite"];
        exports["_fgets"] = exports["fgets"];
        exports["_fputs"] = exports["fputs"];
        exports["_fseek"] = exports["fseek"];
        exports["_ftell"] = exports["ftell"];
        exports["_fflush"] = exports["fflush"];
        exports["_fprintf"] = exports["fprintf"];
        exports["_feof"] = exports["feof"];
        exports["_ferror"] = exports["ferror"];
        exports["_clearerr"] = exports["clearerr"];
        exports["_rewind"] = exports["rewind"];
        exports["_fgetc"] = exports["fgetc"];
        exports["_fputc"] = exports["fputc"];
        exports["_ungetc"] = exports["ungetc"];
        exports["_fgetpos"] = exports["fgetpos"];
        exports["_fsetpos"] = exports["fsetpos"];

        // --- Character classification ---
        exports["isalpha"] = (ctx, mem, args) => this.ischartype(args[0] ?? 0, 0x0100 | 0x0001 | 0x0002);
        exports["isdigit"] = (ctx, mem, args) => this.ischartype(args[0] ?? 0, 0x0004);
        exports["isspace"] = (ctx, mem, args) => this.ischartype(args[0] ?? 0, 0x0008);
        exports["isupper"] = (ctx, mem, args) => this.ischartype(args[0] ?? 0, 0x0001);
        exports["islower"] = (ctx, mem, args) => this.ischartype(args[0] ?? 0, 0x0002);
        exports["isalnum"] = (ctx, mem, args) => this.ischartype(args[0] ?? 0, 0x0100 | 0x0001 | 0x0002 | 0x0004);
        exports["isprint"] = (ctx, mem, args) => this.isprint(args[0] ?? 0);
        exports["ispunct"] = (ctx, mem, args) => this.ischartype(args[0] ?? 0, 0x0010);
        exports["iscntrl"] = (ctx, mem, args) => this.ischartype(args[0] ?? 0, 0x0020);
        exports["isxdigit"] = (ctx, mem, args) => this.ischartype(args[0] ?? 0, 0x0080);
        exports["isleadbyte"] = () => 0;
        exports["iswalpha"] = (ctx, mem, args) => this.iswctype(args[0] ?? 0, 0x0100 | 0x0001 | 0x0002);
        exports["iswdigit"] = (ctx, mem, args) => this.iswctype(args[0] ?? 0, 0x0004);
        exports["iswpunct"] = (ctx, mem, args) => this.iswctype(args[0] ?? 0, 0x0010);

        // --- Memory ---
        exports["_msize"] = (ctx, mem, args) => this.msize(args[0] ?? 0);
        exports["_msize_dbg"] = (ctx, mem, args) => this.msize(args[0] ?? 0);
        exports["__msize"] = (ctx, mem, args) => this.msize(args[0] ?? 0);
        exports["_expand"] = (ctx, mem, args) => this.realloc(args[0] ?? 0, args[1] ?? 0);
        exports["__expand"] = (ctx, mem, args) => this.realloc(args[0] ?? 0, args[1] ?? 0);
        exports["_heapmin"] = () => 0;
        exports["__heapmin"] = () => 0;
        exports["_heapadd"] = () => -1;
        exports["__heapadd"] = () => -1;
        exports["_heapchk"] = () => -2;   // _HEAPOK
        exports["__heapchk"] = () => -2;  // _HEAPOK
        exports["_heapset"] = () => -2;   // _HEAPOK
        exports["__heapset"] = () => -2;  // _HEAPOK
        exports["_heapwalk"] = () => -1;  // _HEAPEND
        exports["__heapwalk"] = () => -1; // _HEAPEND
        exports["__rtl_heapwalk"] = () => -1; // _HEAPEND (legacy alias)
        exports["_heapused"] = () => 0;
        exports["__heapused"] = () => 0;
        exports["_iob"] = () => this.iobAddr >>> 0;
        exports["__pioinfo"] = () => this.pioinfoAddr >>> 0;
        exports["__badioinfo"] = () => this.badioinfoAddr >>> 0;
        exports["??3@YAXPAX@Z"] = (ctx, mem, args) => this.free(args[0] ?? 0);
        exports["??2CObject@@SAPAXI@Z"] = (ctx, mem, args) => this.malloc(args[0] ?? 0);
        exports["??3CObject@@SAXPAX@Z"] = (ctx, mem, args) => this.free(args[0] ?? 0);
        exports["??2CObject@@SGPAXI@Z"] = (ctx, mem, args) => this.malloc(args[0] ?? 0);
        exports["??3CObject@@SGXPAX@Z"] = (ctx, mem, args) => this.free(args[0] ?? 0);
        exports["@$bnwa$qui"] = (ctx, mem, args) => this.malloc(args[0] ?? 0);
        exports["@$bdele$qpv"] = (ctx, mem, args) => this.free(args[0] ?? 0);
        exports["@$bdla$qpv"] = (ctx, mem, args) => this.free(args[0] ?? 0);

        // --- String formatting ---
        exports["strftime"] = () => 0;
        exports["_snwprintf"] = (ctx, mem, args) =>
            this.vsnwprintf(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, args[3] ?? 0);
        exports["swprintf"] = (ctx, mem, args) => this.swprintf(args);

        exports["_onexit"]             = (ctx, mem, args) => this.registerExitHandler(args[0] ?? 0);
        // atexit is _onexit with the C return convention (0 = registered).
        exports["atexit"]              = (ctx, mem, args) => (this.registerExitHandler(args[0] ?? 0) ? 0 : -1);
        // __dllonexit owns a DLL-scoped table (*pbegin..*pend) drained at DLL detach —
        // folding it into the process table would run those handlers at the wrong time.
        exports["__dllonexit"]         = (ctx, mem, args) => args[0] ?? 0;
        // VC5/6 SEH surface (_except_handler3/__CxxFrameHandler/_CxxThrowException) — see crt-seh3.ts
        registerCrtSeh3Exports(exports, {
            process: this.process,
            terminateProcess: (c, r) => this.terminateProcess(c, r),
        });
        exports["_purecall"]           = () => { Logger.error(LogCategory.SYSTEM, "msvcrt: pure virtual function call"); return 0; };
        registerRttiExports(exports, {
            throwBadCast: () => this.terminateProcess(3, "msvcrt: bad_cast from __RTDynamicCast"),
            throwBadTypeid: () => this.terminateProcess(3, "msvcrt: bad_typeid from __RTtypeid"),
        });
        exports["??1bad_cast@@UAE@XZ"] = () => 0;
        exports["??1type_info@@UAE@XZ"] = () => 0;
        exports["?name@type_info@@QBEPBDXZ"] = (ctx, mem, args) => {
            const self = ctx.ecx >>> 0;
            if (!self || self + 12 > mem.length) return 0;
            const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const cached = dv.getUint32(self + 4, true) >>> 0;
            if (cached) return cached; // real type_info::name() caches into _M_data too
            const decorated = this.readCString(self + 8, 512);
            const undecorated = demangleTypeInfoName(decorated);
            const ptr = this.process.memory.alloc(undecorated.length + 1, "THUNK_DATA", "rw");
            this.writeCString(ptr, undecorated);
            dv.setUint32(self + 4, ptr, true);
            return ptr;
        };
        exports["??8type_info@@QBEHABV0@@Z"] = (ctx, _mem, args) => {
            const lhs = ctx.ecx >>> 0;
            const rhs = args[0] ?? 0;
            if (!lhs || !rhs) return 0;
            if (lhs === rhs) return 1; // identical type_info → equal (fast path)
            // MSVC type_info layout: +0 vfptr, +4 _M_data (undecorated-name cache,
            // 0 until name() runs), +8 decorated name (".?AV<class>@@"). Equality is
            // by NAME — comparing +4 returned "equal" for ALL distinct types (both
            // 0), so the guest's RTTI dispatch (typeid(x)==typeid(T)) matched the
            // wrong type → a wrong-layout object → null-vtable crash.
            const nameA = this.readCString(lhs + 8, 512);
            const nameB = this.readCString(rhs + 8, 512);
            return nameA.length > 0 && nameA === nameB ? 1 : 0;
        };
        exports["?terminate@@YAXXZ"]   = () => this.terminateProcess(3, "msvcrt: terminate() called");

        registerVc9AbiExports(exports, {
            process: this.process,
            initterm: (a, b) => this.initterm(a, b),
            malloc: (n) => this.malloc(n),
            free: (p) => this.free(p),
            controlfp: (n, m) => this.controlfp(n, m),
            readCString: (p, max) => this.readCString(p, max ?? 512),
            writeCString: (p, v) => this.writeCString(p, v),
            readWString: (p, max) => this.readWString(p, max),
            setErrno: (e) => this.setErrno(e),
            exitProcess: (c) => this.exitProcess(c),
            terminateProcess: (c, r) => this.terminateProcess(c, r),
            getcwd: (b, m) => pathFns.getcwd(b, m),
            snprintf: (a) => this.snprintf(a),
            vsnprintf: (d, m, f, v) => this.vsnprintf(d, m, f, v),
            strncpy: (d, s, c) => this.strncpy(d, s, c),
            strncat: (d, s, c) => this.strncat(d, s, c),
            memmove: (d, s, c) => this.memmove(d, s, c),
            sprintf: (a) => this.sprintf(a),
            computeCtypeFlags: (ch) => this.computeCtypeFlags(ch),
            ischartype: (ch, mask) => this.ischartype(ch, mask),
        });

        const ioHost = {
            process: this.process,
            readCString: (p: number, max?: number) => this.readCString(p, max ?? 512),
            setErrno: (e: number) => this.setErrno(e),
            statImpl: (a: number, b: number, w: boolean) => this.statImpl(a, b, w),
            fseek: (a: number, b: number, c: number) => this.fseek(a, b, c),
            ftell: (a: number) => this.ftell(a),
            filelength: (a: number) => this.filelength(a),
            fileStreams: this.fileStreams,
            malloc: (n: number) => this.malloc(n),
            writeCString: (p: number, v: string) => this.writeCString(p, v),
            memset: (p: number, v: number, n: number) => this.memset(p, v, n),
        };
        registerVc9IoExports(exports, ioHost);
        registerVc9SetjmpExports(exports, { process: this.process });
        registerVc9SehExports(exports, {
            process: this.process,
            notifySehAborted: (reason) => this.process.dispatcher.notifySehDispatchAborted(reason),
        });
    }

    reset(): void {
        this.randSeed = 1;
        this.newHandlerPtr = 0;
        this.newMode = 0;
        this.strerrorBuf = 0;
        this.crtDbgFlag = 0;
        this.tempnamCounter = 0;
        this.exitHandlers.length = 0;
        this.exitChainRunning = false;
        this.fds.clear();
        this.fdHandles.clear();
        this.handleFds.clear();
        this.fdNext = 3;
        this.crtAllocations.clear();
        this.appType = 0;
        this.userMathErrHandler = 0;
        this.controlFpWord = 0x0009001f;
        this.currentLocale = "C";
        this.localeAddr = 0;
        this.lconvAddr = 0;
        if (this.errnoAddr) {
            Mem.writeUint32(this.errnoAddr, 0);
        }
        if (this.fmodeAddr) {
            Mem.writeUint32(this.fmodeAddr, 0);
        }
        if (this.commodeAddr) {
            Mem.writeUint32(this.commodeAddr, 0);
        }
    }

    reregisterExports(_process: Process): void {
        // Zero addresses so ensureRuntimeStorage re-allocates after reset freed the memory
        this.errnoAddr = 0;
        this.pctypeVarAddr = 0;
        this.pctypeTableAddr = 0;
        this.caseLowerTableAddr = 0;
        this.caseUpperTableAddr = 0;
        this.mbCurMaxAddr = 0;
        this.fmodeAddr = 0;
        this.commodeAddr = 0;
        this.acmdlnAddr = 0;
        this.arg0Addr = 0;
        this.argvVectorAddr = 0;
        this.argcAddr = 0;
        this.argvPtrVarAddr = 0;
        this.dosErrnoAddr = 0;
        this.mbctypeAddr = 0;
        this.ehPrologAddr = 0;
        this.envpVectorAddr = 0;
        this.environVarAddr = 0;
        this.iobAddr = 0;
        this.pioinfoAddr = 0;
        this.badioinfoAddr = 0;
        this.lcCodepageAddr = 0;
        this.osVerVarsAddr = 0;
        this.acmdlnVarAddr = 0;
        this.adjustFdivAddr = 0;
        this.qsortCodeAddr = 0;
        this.bsearchCodeAddr = 0;
        this.localeAddr = 0;
        this.lconvAddr = 0;

        this.ensureRuntimeStorage();
        this.registerDataExports();
    }

    private ensureRuntimeStorage(): void {
        if (this.errnoAddr === 0) {
            this.errnoAddr = this.process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.errnoAddr, 0);
        }
        if (this.mbCurMaxAddr === 0) {
            this.mbCurMaxAddr = this.process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.mbCurMaxAddr, 1);
        }
        if (this.lcCodepageAddr === 0) {
            this.lcCodepageAddr = this.process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.lcCodepageAddr, EmulatorConfig.getInstance().ansiCodePage);
        }
        if (this.osVerVarsAddr === 0) {
            this.osVerVarsAddr = this.process.memory.alloc(16, "THUNK_DATA", "rw");
            const { major, minor, build } = EmulatorConfig.getInstance().osVersion;
            Mem.writeUint32(this.osVerVarsAddr, build & 0xffff);          // _osver
            Mem.writeUint32(this.osVerVarsAddr + 4, major);               // _winmajor
            Mem.writeUint32(this.osVerVarsAddr + 8, minor);               // _winminor
            Mem.writeUint32(this.osVerVarsAddr + 12, (major << 8) | minor); // _winver
        }
        if (this.fmodeAddr === 0) {
            this.fmodeAddr = this.process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.fmodeAddr, 0);
        }
        if (this.commodeAddr === 0) {
            this.commodeAddr = this.process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.commodeAddr, 0);
        }
        if (this.acmdlnAddr === 0) {
            this.acmdlnAddr = this.process.memory.alloc(2048, "THUNK_DATA", "rw");
            // Populate with actual command line if available (e.g. after system.reset())
            const system = System.getInstance();
            const exeName = system.executableName || "";
            const args = system.executableArgs || "";
            const cmdLine = exeName ? (args ? `${exeName} ${args}` : exeName) : "";
            this.writeCString(this.acmdlnAddr, cmdLine);
        }
        if (this.arg0Addr === 0) {
            this.arg0Addr = this.process.memory.alloc(512, "THUNK_DATA", "rw");
            this.writeCString(this.arg0Addr, "");
        }
        if (this.argvVectorAddr === 0) {
            this.argvVectorAddr = this.process.memory.alloc(8, "THUNK_DATA", "rw");
            Mem.writeUint32(this.argvVectorAddr, 0);
            Mem.writeUint32(this.argvVectorAddr + 4, 0);
        }
        if (this.argcAddr === 0) {
            this.argcAddr = this.process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.argcAddr, 1);
        }
        if (this.argvPtrVarAddr === 0) {
            this.argvPtrVarAddr = this.process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.argvPtrVarAddr, this.argvVectorAddr);
        }
        if (this.dosErrnoAddr === 0) {
            this.dosErrnoAddr = this.process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.dosErrnoAddr, 0);
        }
        if (this.mbctypeAddr === 0) {
            // _mbctype[257]: lead-byte table for DBCS; SBCS → all zeros.
            this.mbctypeAddr = this.process.memory.alloc(257, "THUNK_DATA", "rw");
            Mem.writeBytes(this.mbctypeAddr, new Uint8Array(257));
        }
        if (this.envpVectorAddr === 0) {
            this.envpVectorAddr = this.process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.envpVectorAddr, 0);
        }
        if (this.environVarAddr === 0) {
            this.environVarAddr = this.process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.environVarAddr, this.envpVectorAddr);
        }
        if (this.iobAddr === 0) {
            this.iobAddr = this.process.memory.alloc(0x60, "THUNK_DATA", "rw");
            Mem.writeBytes(this.iobAddr, new Uint8Array(0x60));
        }
        if (this.pioinfoAddr === 0) {
            this.pioinfoAddr = this.process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.pioinfoAddr, 0);
        }
        if (this.badioinfoAddr === 0) {
            this.badioinfoAddr = this.process.memory.alloc(0x20, "THUNK_DATA", "rw");
            Mem.writeBytes(this.badioinfoAddr, new Uint8Array(0x20));
        }
        if (this.pctypeTableAddr === 0) {
            // Allocate the actual ctype table (256 entries × 2 bytes = 512 bytes)
            this.pctypeTableAddr = this.process.memory.alloc(512, "THUNK_DATA", "rw");
            const table = new Uint8Array(512);
            for (let i = 0; i < 256; i++) {
                const flags = this.computeCtypeFlags(i);
                table[i * 2] = flags & 0xff;
                table[i * 2 + 1] = (flags >>> 8) & 0xff;
            }
            Mem.writeBytes(this.pctypeTableAddr, table);

            // Allocate the pointer variable that points to the table
            // __p__pctype() returns unsigned short** — a pointer TO _pctype,
            // which is itself a pointer to the table
            this.pctypeVarAddr = this.process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.pctypeVarAddr, this.pctypeTableAddr);
        }
        if (this.caseLowerTableAddr === 0) {
            this.caseLowerTableAddr = this.process.memory.alloc(256, "THUNK_DATA", "rw");
            this.caseUpperTableAddr = this.process.memory.alloc(256, "THUNK_DATA", "rw");
            this.buildCaseTables();
        }
    }

    /**
     * (Re)populate the tolower/toupper LUTs for the currently active locale. 0-0x7F is always
     * ASCII; 0x80-0xFF is identity in the "C" locale and the ANSI codepage's single-byte
     * case-folding once a non-"C" locale is active (e.g. CP1251 Cyrillic А-Я↔а-я, Ё↔ё).
     * Trap-free: the inline stubs and the JS fallbacks both read the result of this build.
     */
    private buildCaseTables(): void {
        if (!this.caseLowerTableAddr || !this.caseUpperTableAddr) return;
        const lower = new Uint8Array(256);
        const upper = new Uint8Array(256);
        for (let i = 0; i < 256; i++) { lower[i] = i; upper[i] = i; }
        for (let i = 0x41; i <= 0x5a; i++) lower[i] = i + 0x20; // 'A'..'Z' -> 'a'..'z'
        for (let i = 0x61; i <= 0x7a; i++) upper[i] = i - 0x20; // 'a'..'z' -> 'A'..'Z'

        const localeActive = this.currentLocale !== "" && this.currentLocale.toUpperCase() !== "C";
        if (localeActive) {
            try {
                const dec = getCodePageDecoder(EmulatorConfig.getInstance().ansiCodePage);
                // Decode every byte once; build a reverse (unicode char -> lowest codepage byte) map.
                const uni: string[] = new Array(256);
                const rev = new Map<string, number>();
                for (let b = 0; b < 256; b++) {
                    const s = dec.decode(new Uint8Array([b]));
                    uni[b] = s;
                    // Skip U+FFFD: undefined/lead bytes (all of CP932 0x81-0xFE, CP1252
                    // 0x81/0x8D/0x8F/0x90/0x9D) decode to the replacement char. Mapping
                    // it into `rev` would fold every such byte to the first one instead
                    // of leaving it as identity → mangled high/DBCS bytes.
                    if (s.length === 1 && s !== "�" && !rev.has(s)) rev.set(s, b);
                }
                for (let i = 0x80; i < 256; i++) {
                    const ch = uni[i];
                    if (!ch || ch.length !== 1 || ch === "�") continue;
                    const lc = ch.toLowerCase();
                    const uc = ch.toUpperCase();
                    if (lc.length === 1 && rev.has(lc)) lower[i] = rev.get(lc)!;
                    if (uc.length === 1 && rev.has(uc)) upper[i] = rev.get(uc)!;
                }
            } catch { /* keep ASCII-only high range */ }
        }
        Mem.writeBytes(this.caseLowerTableAddr, lower);
        Mem.writeBytes(this.caseUpperTableAddr, upper);
    }

    /**
     * Guest addresses of the 256-byte lower/upper case LUTs (ensures they're allocated+built).
     * pe-loader reads these to emit the trap-free inline tolower/toupper stubs.
     */
    getCaseTableAddrs(): { lower: number; upper: number } {
        if (this.caseLowerTableAddr === 0) this.ensureRuntimeStorage();
        return { lower: this.caseLowerTableAddr, upper: this.caseUpperTableAddr };
    }

    /**
     * Register data exports (global variables) with the ThunkGenerator.
     * These are PE imports accessed as data (mov eax, [__imp_X]; mov eax, [eax])
     * rather than called as functions. The IAT must point to the variable address.
     */
    private registerDataExports(): void {
        const tg = this.process.thunkGenerator;
        if (!tg?.registerDataExport) return;

        // _acmdln: char* variable pointing to command line string
        if (this.acmdlnVarAddr === 0) {
            this.acmdlnVarAddr = this.process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.acmdlnVarAddr, this.acmdlnAddr);
        }
        tg.registerDataExport("msvcrt", "_acmdln", this.acmdlnVarAddr);

        // _adjust_fdiv: int variable (0 = no Pentium FDIV bug)
        if (this.adjustFdivAddr === 0) {
            this.adjustFdivAddr = this.process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.adjustFdivAddr, 0);
        }
        tg.registerDataExport("msvcrt", "_adjust_fdiv", this.adjustFdivAddr);

        // _environ aliases: exported CRT environment pointer.
        tg.registerDataExport("msvcrt", "_environ", this.environVarAddr);
        tg.registerDataExport("msvcrt", "__environ", this.environVarAddr);
        tg.registerDataExport("msvcrt", "_environ_dll", this.environVarAddr);
        tg.registerDataExport("msvcrt", "_iob", this.iobAddr);
        tg.registerDataExport("msvcrt", "__pioinfo", this.pioinfoAddr);
        tg.registerDataExport("msvcrt", "__badioinfo", this.badioinfoAddr);
        tg.registerDataExport("msvcrt", "_mbctype", this.mbctypeAddr);

        // Locale/ctype/OS variables the CRT exports as data. A DLL linked against
        // msvcrt reads them directly (MB_CUR_MAX, isX() via _pctype[c]); resolving one
        // to a call stub hands back executable bytes as the value, and the import of a
        // name with no argCount aborts the whole LoadLibrary.
        tg.registerDataExport("msvcrt", "__mb_cur_max", this.mbCurMaxAddr);
        tg.registerDataExport("msvcrt", "_pctype", this.pctypeVarAddr);
        tg.registerDataExport("msvcrt", "__lc_codepage", this.lcCodepageAddr);
        tg.registerDataExport("msvcrt", "_osver", this.osVerVarsAddr);
        tg.registerDataExport("msvcrt", "_winmajor", this.osVerVarsAddr + 4);
        tg.registerDataExport("msvcrt", "_winminor", this.osVerVarsAddr + 8);
        tg.registerDataExport("msvcrt", "_winver", this.osVerVarsAddr + 12);

        if (this.ehPrologAddr === 0) {
            this.ehPrologAddr = ensureNativeEHProlog(this.process);
        }
        if (this.ehPrologAddr) {
            tg.registerDataExport("msvcrt", "_EH_prolog", this.ehPrologAddr);
        }

        // VC9 _encoded_null — DATA import used by msvcr90-linked DLLs (e.g. lgvid.dll).
        if (this.encodedNullAddr === 0) {
            this.encodedNullAddr = this.process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.encodedNullAddr, 0);
        }
        tg.registerDataExport("msvcrt", "_encoded_null", this.encodedNullAddr);
        tg.registerDataExport("msvcr90", "_encoded_null", this.encodedNullAddr);

        // Native x86 qsort (insertion sort) — shared with crtdll
        if (this.qsortCodeAddr === 0) {
            this.qsortCodeAddr = ensureNativeQsort(this.process);
        }
        if (this.qsortCodeAddr) {
            tg.registerDataExport("msvcrt", "qsort", this.qsortCodeAddr);
            // SS2 imports qsort/bsearch via msvcr90.dll — IAT must point at native code, not the JS ()=>0 stub.
            tg.registerDataExport("msvcr90", "qsort", this.qsortCodeAddr);
        }

        // Native x86 bsearch (binary search calling the guest comparator in guest space)
        if (this.bsearchCodeAddr === 0) {
            this.bsearchCodeAddr = ensureNativeCBsearch(this.process);
        }
        if (this.bsearchCodeAddr) {
            tg.registerDataExport("msvcrt", "bsearch", this.bsearchCodeAddr);
            tg.registerDataExport("msvcr90", "bsearch", this.bsearchCodeAddr);
        }

        Logger.log(LogCategory.SYSTEM,
            `MSVCRT data exports: _acmdln var=0x${this.acmdlnVarAddr.toString(16)} -> str=0x${this.acmdlnAddr.toString(16)}, ` +
            `_adjust_fdiv=0x${this.adjustFdivAddr.toString(16)}, _environ=0x${this.environVarAddr.toString(16)}`);
    }

    private setErrno(value: number): boolean {
        if (!this.errnoAddr) return false;
        Mem.writeUint32(this.errnoAddr, value >>> 0);
        return true;
    }

    private static readonly MB_CP_LOCALE = -1;
    private static readonly MB_CP_OEM = -2;
    private static readonly MB_CP_ANSI = -3;
    private static readonly DBCS_CODE_PAGES = new Set([
        932, 936, 949, 950, 1361, 50225, 50227, 50229, 51932, 51936, 51949, 52936, 54936,
    ]);
    private static readonly VALID_MB_CODE_PAGES = new Set([
        437, 850, 874, 932, 936, 949, 950, 1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258,
        28591, 65001, 1361,
    ]);

    /** int _setmbcp(int codepage) — set CRT multibyte code page; updates __mb_cur_max. */
    private setMbcp(codepage: number): number {
        this.ensureRuntimeStorage();
        const config = EmulatorConfig.getInstance();
        let resolved = codepage | 0;

        if (resolved === Msvcrt.MB_CP_ANSI) {
            resolved = config.ansiCodePage;
        } else if (resolved === Msvcrt.MB_CP_OEM) {
            resolved = config.oemCodePage;
        } else if (resolved === Msvcrt.MB_CP_LOCALE) {
            resolved = config.ansiCodePage;
        }

        if (resolved <= 0 || !Msvcrt.VALID_MB_CODE_PAGES.has(resolved)) {
            this.setErrno(22); // EINVAL
            return -1;
        }

        config.ansiCodePage = resolved;
        const mbCurMax = Msvcrt.DBCS_CODE_PAGES.has(resolved) ? 2 : 1;
        Mem.writeUint32(this.mbCurMaxAddr, mbCurMax);
        Mem.writeUint32(this.lcCodepageAddr, resolved);

        if (this.mbctypeAddr) {
            Mem.writeBytes(this.mbctypeAddr, new Uint8Array(257));
        }
        // Keep the case LUTs consistent with the now-active codepage (effective only while a
        // non-"C" locale is set — buildCaseTables gates the 0x80-0xFF range on that).
        this.buildCaseTables();

        Logger.verbose(LogCategory.SYSTEM, `_setmbcp(${codepage}) -> cp=${resolved}, mb_cur_max=${mbCurMax}`);
        return 0;
    }

    /** int _getmbcp(void) — the active multibyte code page, or 0 when the locale is SBCS. */
    private getMbcp(): number {
        const cp = EmulatorConfig.getInstance().ansiCodePage;
        return Msvcrt.DBCS_CODE_PAGES.has(cp) ? cp : 0;
    }

    private strerrorMessage(errnoVal: number): string {
        switch (errnoVal) {
            case 1: return "Operation not permitted";
            case 2: return "No such file or directory";
            case 5: return "Input/output error";
            case 9: return "Bad file descriptor";
            case 12: return "Cannot allocate memory";
            case 13: return "Permission denied";
            case 17: return "File exists";
            case 18: return "No more files";
            case 22: return "Invalid argument";
            case 28: return "No space left on device";
            case 34: return "Result too large";
            default: return `Unknown error (${errnoVal})`;
        }
    }

    private strerror(errnum: number): number {
        const msg = this.strerrorMessage(errnum);
        if (!this.strerrorBuf) {
            this.strerrorBuf = this.process.memory.alloc(128, "THUNK_DATA", "rw");
        }
        this.writeCString(this.strerrorBuf, msg);
        return this.strerrorBuf >>> 0;
    }

    private perror(prefixPtr: number): void {
        const prefix = prefixPtr ? this.readCString(prefixPtr, 512) : "";
        const errnoVal = this.errnoAddr ? (Mem.readUint32(this.errnoAddr) ?? 0) : 0;
        const msg = this.strerrorMessage(errnoVal);
        const line = prefix ? `${prefix}: ${msg}` : msg;
        Logger.warn(LogCategory.SYSTEM, `perror: ${line}`);
    }

    private setAppType(appType: number): number {
        this.appType = appType | 0;
        return 0;
    }

    private setUserMathErr(handlerPtr: number): number {
        this.userMathErrHandler = handlerPtr >>> 0;
        return 0;
    }

    private getMainArgs(argcPtr: number, argvPtr: number, envPtr: number, _doWildCard: number, _startupInfo: number): number {
        const system = System.getInstance();
        const exeName = system.executableName || "app.exe";
        const args = system.executableArgs || "";
        const cmdLine = args ? `${exeName} ${args}` : exeName;

        this.writeCString(this.acmdlnAddr, cmdLine);
        // Update the pointer variable so data import reads see the correct address
        if (this.acmdlnVarAddr) {
            Mem.writeUint32(this.acmdlnVarAddr, this.acmdlnAddr);
        }
        this.writeCString(this.arg0Addr, exeName);

        Mem.writeUint32(this.argvVectorAddr, this.arg0Addr >>> 0);
        Mem.writeUint32(this.argvVectorAddr + 4, 0);
        Mem.writeUint32(this.envpVectorAddr, 0);
        if (this.argcAddr) Mem.writeUint32(this.argcAddr, 1);
        if (this.argvPtrVarAddr) Mem.writeUint32(this.argvPtrVarAddr, this.argvVectorAddr >>> 0);
        if (this.environVarAddr) {
            Mem.writeUint32(this.environVarAddr, this.envpVectorAddr >>> 0);
        }

        if (argcPtr) Mem.writeUint32(argcPtr, 1);
        if (argvPtr) Mem.writeUint32(argvPtr, this.argvVectorAddr >>> 0);
        if (envPtr) Mem.writeUint32(envPtr, this.envpVectorAddr >>> 0);
        if (_startupInfo) Mem.writeUint32(_startupInfo, 0); // newmode = 0
        return 0;
    }

    private xcptFilter(xcptNum: number, xcptInfo: number): number {
        const inputCode = xcptNum >>> 0;
        let effectiveCode = inputCode;
        let exceptionFlags = 0;

        if (xcptInfo) {
            const recPtr = Mem.readUint32(xcptInfo >>> 0) ?? 0;
            if (recPtr) {
                const recCode = Mem.readUint32(recPtr) ?? 0;
                exceptionFlags = Mem.readUint32((recPtr + 4) >>> 0) ?? 0;
                if (recCode !== 0) {
                    effectiveCode = recCode >>> 0;
                }
            }
        }

        const EXCEPTION_NONCONTINUABLE = 0x1;
        const nonContinuable = (exceptionFlags & EXCEPTION_NONCONTINUABLE) !== 0;
        const isNtError = (effectiveCode & 0xC0000000) === 0xC0000000;

        // VC6-compatible behavior for hardware faults used by CRT startup wrappers:
        // fatal hardware exceptions => EXECUTE_HANDLER.
        switch (effectiveCode) {
            case 0x80000003: // STATUS_BREAKPOINT
            case 0x80000004: // STATUS_SINGLE_STEP
                return nonContinuable ? 0 : -1; // ContinueExecution if allowed

            case 0xC0000005: // STATUS_ACCESS_VIOLATION
            case 0xC0000006: // STATUS_IN_PAGE_ERROR
            case 0xC000001D: // STATUS_ILLEGAL_INSTRUCTION
            case 0xC0000025: // STATUS_NONCONTINUABLE_EXCEPTION
            case 0xC000008C: // STATUS_ARRAY_BOUNDS_EXCEEDED
            case 0xC000008D: // STATUS_FLOAT_DENORMAL_OPERAND
            case 0xC000008E: // STATUS_FLOAT_DIVIDE_BY_ZERO
            case 0xC000008F: // STATUS_FLOAT_INEXACT_RESULT
            case 0xC0000090: // STATUS_FLOAT_INVALID_OPERATION
            case 0xC0000091: // STATUS_FLOAT_OVERFLOW
            case 0xC0000092: // STATUS_FLOAT_STACK_CHECK
            case 0xC0000093: // STATUS_FLOAT_UNDERFLOW
            case 0xC0000094: // STATUS_INTEGER_DIVIDE_BY_ZERO
            case 0xC0000095: // STATUS_INTEGER_OVERFLOW
            case 0xC0000096: // STATUS_PRIVILEGED_INSTRUCTION
            case 0xC00000FD: // STATUS_STACK_OVERFLOW
            case 0xC000013A: // STATUS_CONTROL_C_EXIT
                return 1; // EXCEPTION_EXECUTE_HANDLER
        }

        if (isNtError) {
            return 1;
        }
        return 0; // EXCEPTION_CONTINUE_SEARCH
    }

    private crtSetDbgFlag(newFlag: number): number {
        const prev = this.crtDbgFlag | 0;
        this.crtDbgFlag = newFlag | 0;
        return prev;
    }

    private crtDbgReport(mem: Uint8Array, args: number[], wide: boolean): number {
        const reportType = args[0] >>> 0;
        const filePtr = args[1] >>> 0;
        const line = args[2] | 0;
        const modulePtr = args[3] >>> 0;
        const formatPtr = args[4] >>> 0;
        const file = filePtr ? (wide ? Marshaler.readWideString(mem, filePtr) : Marshaler.readString(mem, filePtr)) : "";
        const moduleName = modulePtr ? (wide ? Marshaler.readWideString(mem, modulePtr) : Marshaler.readString(mem, modulePtr)) : "";
        const format = formatPtr ? (wide ? Marshaler.readWideString(mem, formatPtr) : Marshaler.readString(mem, formatPtr)) : "";
        Logger.warn(
            LogCategory.SYSTEM,
            `_CrtDbgReport${wide ? "W" : ""}(type=${reportType}, file="${file}", line=${line}, module="${moduleName}", fmt="${format}")`
        );
        // 0 = do not break into debugger, continue execution.
        return 0;
    }

    private crtAssert(mem: Uint8Array, args: number[], wide: boolean): number {
        const exprPtr = args[0] >>> 0;
        const filePtr = args[1] >>> 0;
        const line = args[2] | 0;
        const expr = exprPtr ? (wide ? Marshaler.readWideString(mem, exprPtr) : Marshaler.readString(mem, exprPtr)) : "";
        const file = filePtr ? (wide ? Marshaler.readWideString(mem, filePtr) : Marshaler.readString(mem, filePtr)) : "";
        Logger.error(LogCategory.SYSTEM, `_assert${wide ? "W" : ""}: "${expr}" at ${file}:${line}`);
        // Compatibility mode: do not abort process.
        return 0;
    }

    /**
     * atexit/_onexit registration. The CRT keeps ONE process-wide table and runs it
     * LIFO from exit(); returning the pointer without recording it is the shape that
     * loses every "flush my state on the way out" handler — games persist settings
     * from here far more often than from their own quit path.
     */
    private registerExitHandler(fn: number): number {
        const target = fn >>> 0;
        if (!target) return 0;
        if (this.exitHandlers.length >= Msvcrt.MAX_EXIT_HANDLERS) {
            Logger.warn(LogCategory.SYSTEM, `_onexit: table full (${Msvcrt.MAX_EXIT_HANDLERS}), dropping 0x${target.toString(16)}`);
            return 0;
        }
        this.exitHandlers.push(target);
        return target;
    }

    /** Terminating half of exit(), shared with the atexit chain's terminal step. */
    private beginProcessExit(exitCode: number): void {
        const system = System.getInstance();
        system.isExiting = true;
        system.scheduler.exitThread(exitCode);
        // C exit() ends the PROCESS, so the host gets the same notification ExitProcess
        // sends — behind the same durability barrier. This is the path the atexit chain
        // ends on, i.e. exactly where a game's settings write has just happened and is
        // still sitting in the overlay's buffers.
        let exitFault: unknown;
        try {
            exitFault = system.buildProcessExitReport(exitCode);
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `msvcrt.exit: exit report failed: ${e}`);
        }
        system.postProcessExitWhenDurable({ exitCode: exitCode >>> 0, fault: exitFault });
    }

    private exitProcess(code: number): ThunkResult {
        const exitCode = code >>> 0;
        Logger.log(LogCategory.SYSTEM, `msvcrt.exit(code=0x${exitCode.toString(16)})`);
        this.beginProcessExit(exitCode);
        return { value: 0, terminated: true };
    }

    /**
     * exit(): run the atexit/_onexit table (LIFO, cdecl, no args) as a guest-callback
     * chain, then terminate — the CRT's own order. _exit()/ExitProcess deliberately
     * skip the table, so they still go straight to exitProcess.
     *
     * The chain is the same mechanism as _initterm's static-ctor chain, but its
     * terminal step cannot return a value: `exit` is noreturn, so completing the
     * suspended frame would resume the guest on the byte after `call exit`. It
     * terminates and parks at the spin loop instead, returning null so the callback
     * manager leaves the CPU exactly as we left it.
     */
    private exitWithHandlers(code: number): ThunkResult {
        const exitCode = code >>> 0;
        const skip = (globalThis as { __noExitChain?: unknown }).__noExitChain === true;
        if (skip || this.exitChainRunning || this.exitHandlers.length === 0) {
            return this.exitProcess(exitCode);
        }
        const cpu = getCPU(this.process.v86);
        const callbackManager = this.process.dispatcher.callbackManager;
        if (!cpu || !callbackManager) return this.exitProcess(exitCode);

        const pending = this.exitHandlers.length;
        this.exitChainRunning = true;
        Logger.log(LogCategory.SYSTEM, `msvcrt.exit(0x${exitCode.toString(16)}): running ${pending} atexit handler(s)`);

        // cdecl, no args: the thunk stub RETs with 0 cleanup, the caller pops `code`.
        if (!callbackManager.saveSuspendedThunkContext({ esp: cpu.reg32[4] >>> 0 }, 0, "CrtExitChain")) {
            this.exitChainRunning = false;
            return this.exitProcess(exitCode);
        }

        let ran = 0;
        const finish = (): null => {
            Logger.log(LogCategory.SYSTEM, `msvcrt.exit: atexit chain done (${ran} handler(s) ran)`);
            this.beginProcessExit(exitCode);
            this.process.dispatcher.parkTerminatedThreadAtSpinLoop();
            return null;
        };
        // Pop rather than iterate a snapshot: a handler may register another one, and
        // the CRT runs those too. The cap bounds a handler that re-registers itself.
        const runNext = (): null => {
            const fn = ran < Msvcrt.MAX_EXIT_HANDLERS ? this.exitHandlers.pop() : undefined;
            if (!fn) return finish();
            ran++;
            try {
                callbackManager.invokeCallback(fn, [], 0, completeThunk, true, "CrtExitChain");
                return null;
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `msvcrt.exit: atexit handler 0x${fn.toString(16)} could not be invoked: ${e}`);
                return finish();
            }
        };
        const completeThunk = (_ret: number): number | null => runNext();

        // Either a callback now owns EIP/ESP, or finish() already parked the dead
        // thread; both cases mean "do not RET from this thunk".
        runNext();
        return { value: 0, skipStackCheck: true };
    }

    private terminateProcess(code: number, reason: string): ThunkResult {
        const exitCode = code >>> 0;
        Logger.error(LogCategory.SYSTEM, `${reason} -> terminating process with exitCode=0x${exitCode.toString(16)}`);
        return this.exitProcess(exitCode);
    }

    /** _exec* family: replace current process. We cannot spawn — fail like ENOENT. */
    private execFail(cmdname: string, argv: string[]): number {
        Logger.verbose(LogCategory.SYSTEM,
            `msvcrt: exec(${cmdname}${argv.length ? ` [${argv.join(", ")}]` : ""}) — not supported`);
        this.setErrno(2); // ENOENT — CRT sets this when the target image is unavailable
        return -1;
    }

    private execv(cmdnamePtr: number, argvPtr: number): number {
        const cmdname = cmdnamePtr ? this.readCString(cmdnamePtr, 512) : "";
        const argv: string[] = [];
        if (argvPtr) {
            for (let i = 0; i < 64; i++) {
                const ptr = Mem.readUint32(argvPtr + i * 4) ?? 0;
                if (!ptr) break;
                argv.push(this.readCString(ptr, 512));
            }
        }
        return this.execFail(cmdname, argv);
    }

    private execl(args: number[]): number {
        const cmdnamePtr = args[0] ?? 0;
        const cmdname = cmdnamePtr ? this.readCString(cmdnamePtr, 512) : "";
        const argv: string[] = [];
        for (let i = 1; i < args.length; i++) {
            const ptr = args[i] ?? 0;
            if (!ptr) break;
            argv.push(this.readCString(ptr, 512));
        }
        return this.execFail(cmdname, argv);
    }

    private malloc(size: number): number {
        const bytes = size >>> 0;
        // MSVCRT malloc(0) returns a VALID, unique, freeable non-NULL pointer to a
        // minimum-size block — it does NOT return NULL. Callers routinely do
        // `p = malloc(n); if (!p) <fail>;` (MFC operator new → AfxThrowMemoryException),
        // so handing back NULL for n==0 is misread as OOM. Max Payne's startup script
        // hit exactly this: malloc(0) → NULL → CMemoryException → the engine's top-level
        // catch(...) aborts startup (saves video settings, hides window, exits) even
        // though the heap has ~500 MB free. Allocate a 1-byte block so the pointer is
        // unique and free() still recognizes it; the tracked user size stays 0 (so
        // _msize(malloc(0)) == 0, matching the CRT).
        const allocBytes = bytes === 0 ? 1 : bytes;
        // Reaching JS for a slab-class size means the inline CRT stub's bump pointer
        // overran SLAB_END — same exhaustion signal kernel32 HeapAlloc reacts to.
        // Without this, a CRT-heavy game (Max Payne: ~39k live CRT blocks) pins the
        // slab at its initial size forever and EVERY small malloc/free pays a full
        // JS thunk round-trip.
        if (allocBytes <= HEAP_SMALL_ALLOC_MAX) {
            maybeGrowHeapSlab();
        }
        try {
            const ptr = this.process.memory.alloc(allocBytes);
            this.crtAllocations.set(ptr >>> 0, bytes >>> 0);
            return ptr;
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `msvcrt.malloc failed: ${e}`);
            this.setErrno(12);
            return 0;
        }
    }

    private free(ptr: number): number {
        if (!ptr) return 0;
        const addr = ptr >>> 0;
        // Slab-resident block (malloc/operator new served by the WASM slab inline
        // stub, or its JS fallback into the shared arena). The active generation is
        // freed in guest code by the inline free stub; blocks reaching JS here belong
        // to a retired generation — treat as a no-op (the bytes stay reserved inside
        // the retired slab until process reset). MUST run before process.memory.free:
        // an interior slab pointer is not a root allocation and would mistarget the
        // enclosing arena. Mirrors kernel32 HeapFree's isInAnySlab guard.
        if (getSlabSizeForPtr(addr) !== undefined) {
            this.crtAllocations.delete(addr);
            return 0;
        }
        if (this.crtAllocations.has(addr)) {
            try {
                // Respect lookaside park-state: a malloc'd block that was HeapFree-parked
                // must not be double-handed-out by a second free here (see kernel32).
                freeHeapBlock(this.process, addr);
                this.crtAllocations.delete(addr);
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `msvcrt.free failed: ${e}`);
                this.setErrno(22);
            }
            return 0;
        }
        // HeapAlloc / direct MemoryManager blocks are not tracked in crtAllocations.
        const guestSize = this.process.memory.getSize(addr);
        if (guestSize !== undefined) {
            try {
                freeHeapBlock(this.process, addr);
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `msvcrt.free failed: ${e}`);
                this.setErrno(22);
            }
            return 0;
        }
        if (addr >= 0x10000) {
            Logger.warn(LogCategory.SYSTEM, `msvcrt.free ignored non-CRT pointer 0x${addr.toString(16)}`);
        }
        this.setErrno(22);
        return 0;
    }

    private calloc(count: number, size: number): number {
        const total = (count >>> 0) * (size >>> 0);
        // Overflow: count*size that doesn't fit in 32 bits can't be satisfied. Real
        // MSVCRT calloc returns NULL here; without this guard malloc() below wraps the
        // request via `total >>> 0` (e.g. 0x1_0000_0000 → 0 → a 1-byte block since
        // malloc(0) now returns non-NULL) while memset() zeroes the full untruncated
        // `total` bytes → heap corruption. (See malloc(0) semantics below.)
        if (total > 0xffffffff) { this.setErrno(12 /* ENOMEM */); return 0; }
        // calloc(0,x)/calloc(x,0): like malloc(0), the CRT returns a valid non-NULL
        // (freeable) block, not NULL. Route through malloc(0) so callers that check
        // the result don't misread it as failure (see malloc()).
        if (!total) return this.malloc(0);
        const ptr = this.malloc(total);
        if (ptr) this.memset(ptr, 0, total);
        return ptr;
    }

    private realloc(ptr: number, size: number): number {
        const bytes = size >>> 0;
        if (!ptr) return this.malloc(bytes);
        if (bytes === 0) {
            this.free(ptr);
            return 0;
        }
        const addr = ptr >>> 0;
        // Size resolution mirrors kernel32 HeapReAlloc/HeapSize: slab block first
        // (sub-allocations inside the WASM arena are NOT tracked in crtAllocations),
        // then the JS-tracked process.memory allocation.
        const slabSize = getSlabSizeForPtr(addr);
        const oldSize = slabSize !== undefined ? slabSize : this.process.memory.getSize(ptr);
        if (oldSize === undefined) {
            if (!this.crtAllocations.has(addr)) {
                Logger.error(LogCategory.SYSTEM,
                    `msvcrt.realloc: invalid non-CRT pointer 0x${addr.toString(16)}`);
                this.setErrno(22);
                return 0;
            }
            Logger.error(LogCategory.SYSTEM,
                `msvcrt.realloc: invalid pointer 0x${ptr.toString(16)}, getSize returned undefined`);
            this.crtAllocations.delete(addr);
            return 0;
        }
        // In-place when the existing capacity already holds the new size (the slab
        // rounds up to its bin size, process.memory rounds up to >=8).
        if (oldSize >= bytes) return ptr;
        const newPtr = this.malloc(bytes);
        if (!newPtr) return 0;
        this.memcpy(newPtr, ptr, oldSize);
        // NOTE: freeing an active-gen slab block from JS is a no-op (see free()), so
        // the old block stays reserved inside the slab until process reset — the same
        // bounded leak kernel32 HeapReAlloc-move accepts. Non-slab blocks free fully.
        this.free(ptr);
        return newPtr;
    }

    private memset(dest: number, value: number, length: number): number {
        const size = length >>> 0;
        if (!dest || size === 0) return dest >>> 0;
        const byteVal = value & 0xff;
        const chunk = new Uint8Array(Math.min(4096, size));
        chunk.fill(byteVal);
        let offset = 0;
        while (offset < size) {
            const slice = chunk.subarray(0, Math.min(chunk.length, size - offset));
            Mem.writeBytes(dest + offset, slice);
            offset += slice.length;
        }
        return dest >>> 0;
    }

    private memcpy(dest: number, src: number, length: number): number {
        const size = length >>> 0;
        if (!dest || !src || size === 0) return dest >>> 0;
        Mem.memcpy(dest, src, size);
        return dest >>> 0;
    }

    private memmove(dest: number, src: number, length: number): number {
        const size = length >>> 0;
        if (!dest || !src || size === 0) return dest >>> 0;
        // One native memmove — Mem.memmove is overlap-correct, so no staging copy.
        Mem.memmove(dest, src, size);
        return dest >>> 0;
    }

    private strlen(ptr: number): number {
        if (!ptr) return 0;
        let len = 0;
        while (len < 0x100000) {
            const b = Mem.readUint8(ptr + len);
            if (b === 0 || b === null) break;
            len++;
        }
        return len;
    }

    private strcpy(dest: number, src: number): number {
        const value = this.readCString(src, 0x100000);
        this.writeCString(dest, value);
        return dest >>> 0;
    }

    private strncpy(dest: number, src: number, count: number): number {
        const max = count >>> 0;
        if (!dest || max === 0) return dest >>> 0;
        const value = this.readCString(src, max);
        const bytes = encodeAnsi(value);
        const padded = new Uint8Array(max);
        padded.set(bytes.subarray(0, Math.min(bytes.length, max)));
        Mem.writeBytes(dest, padded);
        return dest >>> 0;
    }

    private strcat(dest: number, src: number): number {
        const destLen = this.strlen(dest);
        const value = this.readCString(src, 0x100000);
        this.writeCString(dest + destLen, value);
        return dest >>> 0;
    }

    private strncat(dest: number, src: number, count: number): number {
        const destLen = this.strlen(dest);
        const max = count >>> 0;
        const value = this.readCString(src, max);
        const bytes = encodeAnsi(value);
        Mem.writeBytes(dest + destLen, bytes);
        Mem.writeBytes(dest + destLen + bytes.length, new Uint8Array([0]));
        return dest >>> 0;
    }

    private strcmp(aPtr: number, bPtr: number): number {
        return this.compareCString(aPtr, bPtr, false, 0);
    }

    private stricmp(aPtr: number, bPtr: number): number {
        return this.compareCString(aPtr, bPtr, true, 0);
    }

    private strnicmp(aPtr: number, bPtr: number, count: number): number {
        if ((count >>> 0) === 0) return 0; // compare zero chars → equal (compareCString treats 0 as unbounded)
        return this.compareCString(aPtr, bPtr, true, count >>> 0);
    }

    private strchr(ptr: number, ch: number): number {
        return this.findChar(ptr, ch, false);
    }

    private strrchr(ptr: number, ch: number): number {
        return this.findChar(ptr, ch, true);
    }

    private strlwr(ptr: number): number {
        if (!ptr) return 0;
        let offset = 0;
        for (;;) {
            const c = Mem.readUint8(ptr + offset);
            if (c === null || c === 0) break;
            let out = c;
            if (c >= 0x41 && c <= 0x5a) out = c + 0x20;
            Mem.writeBytes(ptr + offset, new Uint8Array([out]));
            offset++;
        }
        return ptr >>> 0;
    }

    private strdup(ptr: number): number {
        const value = this.readCString(ptr, 0x100000);
        const bytes = encodeAnsi(value + "\0");
        const outPtr = this.malloc(bytes.length);
        if (!outPtr) return 0;
        Mem.writeBytes(outPtr, bytes);
        return outPtr >>> 0;
    }

    private sprintf(args: number[]): number {
        const dest = args[0] ?? 0;
        const fmtPtr = args[1] ?? 0;
        if (!dest || !fmtPtr) return -1;
        const format = this.readCString(fmtPtr, 0x100000);
        const reader = new ArrayVaListReader(args, 2);
        const text = formatCLazy(format, reader, (addr, maxLen) => this.readCString(addr, maxLen));
        const bytes = encodeAnsi(text);
        Mem.writeBytes(dest, bytes);
        Mem.writeBytes(dest + bytes.length, new Uint8Array([0]));
        return text.length;
    }

    private printf(args: number[]): number {
        const fmtPtr = args[0] ?? 0;
        if (!fmtPtr) return -1;
        const format = this.readCString(fmtPtr, 0x100000);
        const reader = new ArrayVaListReader(args, 1);
        const text = formatCLazy(format, reader, (addr, maxLen) => this.readCString(addr, maxLen));
        Logger.info(LogCategory.SYSTEM, `[CRT] ${text}`);
        return text.length;
    }

    private sscanf(args: number[]): number {
        const inputPtr = args[0] ?? 0;
        const fmtPtr = args[1] ?? 0;
        if (!inputPtr || !fmtPtr) return 0;
        // Route through the faithful streaming scanf core (crt-scanf.ts): %d/%i/%u/%x/%o/%p/%f/%lf/
        // %s/%c/%[scanset]/%n, width, '*' suppression, length modifiers, literal/whitespace matching.
        const input = this.readCString(inputPtr, 0x100000);
        const format = this.readCString(fmtPtr, 0x100000);
        const { assigned, eof } = scanfCore(input, format, args, 2);
        // C: EOF (-1) when input runs out before the first conversion; otherwise the assigned count.
        return eof && assigned === 0 ? -1 : assigned;
    }

    private fscanf(args: number[]): number | Promise<ThunkResult> {
        const filePtr = args[0] ?? 0;
        const fmtPtr = args[1] ?? 0;
        const stream = this.fileStreams.get(filePtr);
        if (!stream || !fmtPtr) return -1; // EOF
        const format = this.readCString(fmtPtr, 0x10000);
        this.flushGetcBuffer(filePtr, stream.handle);
        const vfs = System.getInstance().fileSystem;
        const startPos = stream.handle.position;
        // Peek a chunk from the current position, parse, then rewind to exactly what was consumed.
        const CHUNK = 8192;
        const apply = (bytes: Uint8Array | null): number => {
            if (!bytes || bytes.length === 0) return -1; // EOF / nothing to read
            let input = "";
            for (let i = 0; i < bytes.length; i++) input += String.fromCharCode(bytes[i]);
            const { assigned, consumed, eof } = scanfCore(input, format, args, 2);
            stream.handle.position = startPos + consumed; // leave unconsumed bytes for next read
            if (LARGE_IO_TRACE_ENABLED) Logger.verbose(LogCategory.KERNEL32, `fscanf("${stream.handle.path}") fmt=${JSON.stringify(format)} assigned=${assigned} consumed=${consumed}`);
            return eof && assigned === 0 ? -1 : assigned;
        };
        const sync = vfs.readSync(stream.handle, CHUNK);
        if (sync !== null) return apply(sync);
        return (async (): Promise<ThunkResult> => {
            try { const b = await vfs.read(stream.handle, CHUNK); return { value: apply(b) >>> 0 }; }
            catch { return { value: 0xffffffff }; }
        })();
    }

    private srand(seed: number): number {
        this.randSeed = seed >>> 0;
        // Sync seed to WASM hypercall page so WASM rand() stays in sync
        hypercallDataManager.updateRandSeed(this.randSeed);
        return 0;
    }

    private rand(): number {
        this.randSeed = (this.randSeed * 214013 + 2531011) >>> 0;
        return (this.randSeed >>> 16) & 0x7fff;
    }

    private isctype(ch: number, mask: number): number {
        const flags = this.computeCtypeFlags(ch & 0xff);
        return (flags & mask) !== 0 ? 1 : 0;
    }

    private open(pathPtr: number, oflag: number): number {
        const path = this.readCString(pathPtr, 512);
        if (!path) {
            this.setErrno(2);
            return -1;
        }

        const O_WRONLY = 0x0001;
        const O_RDWR = 0x0002;
        const O_APPEND = 0x0008;
        const O_CREAT = 0x0100;
        const O_TRUNC = 0x0200;
        const O_EXCL = 0x0400;

        const GENERIC_READ = 0x80000000;
        const GENERIC_WRITE = 0x40000000;
        const OPEN_EXISTING = 3;
        const CREATE_NEW = 1;
        const CREATE_ALWAYS = 2;
        const OPEN_ALWAYS = 4;
        const TRUNCATE_EXISTING = 5;

        let access = GENERIC_READ;
        if (oflag & O_RDWR) access = GENERIC_READ | GENERIC_WRITE;
        else if (oflag & O_WRONLY) access = GENERIC_WRITE;

        let disposition = OPEN_EXISTING;
        if (oflag & O_CREAT) {
            if (oflag & O_EXCL) disposition = CREATE_NEW;
            else if (oflag & O_TRUNC) disposition = CREATE_ALWAYS;
            else disposition = OPEN_ALWAYS;
        } else if (oflag & O_TRUNC) {
            disposition = TRUNCATE_EXISTING;
        }

        const vfs = System.getInstance().fileSystem;
        const handle = vfs.openSync(path, access, disposition);
        if (!handle) {
            this.setErrno(2);
            return -1;
        }
        if ((oflag & O_APPEND) !== 0) {
            handle.position = vfs.getFileSize(handle.path);
        }

        const fd = this.nextFd();
        this.fds.set(fd, handle);
        return fd;
    }

    /** int _sopen(path, oflag, shflag [, pmode]) — shared open; shflag/pmode ignored in HLE. */
    private sopen(pathPtr: number, oflag: number, _shflag: number, _pmode: number): number {
        return this.open(pathPtr, oflag);
    }

    private close(fd: number): number {
        if (fd <= 2) return 0;
        if (!this.fds.has(fd)) {
            this.setErrno(9);
            return -1;
        }
        this.fds.delete(fd);
        return 0;
    }

    private read(ctx: any, mem: Uint8Array, fd: number, buffer: number, count: number): number | Promise<ThunkResult> {
        if (fd === 0) return 0;
        const handle = this.fds.get(fd);
        if (!handle) {
            this.setErrno(9);
            return -1;
        }
        const vfs = System.getInstance().fileSystem;
        const want = count >>> 0;
        const synced = vfs.readIntoSync(handle, mem, buffer, want);
        if (synced !== null) {
            return synced;
        }

        return (async (): Promise<ThunkResult> => {
            const freshMem = Mem.getView();
            if (!freshMem) {
                this.setErrno(5);
                return { value: -1 };
            }
            try {
                const bytesRead = await vfs.readInto(handle, freshMem, buffer, want);
                if (bytesRead < 0) {
                    this.setErrno(5);
                    return { value: -1 };
                }
                return { value: bytesRead };
            } catch {
                this.setErrno(5);
                return { value: -1 };
            }
        })();
    }

    private write(fd: number, buffer: number, count: number): number {
        const size = count >>> 0;
        if (fd === 1 || fd === 2) {
            const bytes = Mem.readBytes(buffer, size) ?? new Uint8Array();
            const text = getCodePageDecoder(EmulatorConfig.getInstance().ansiCodePage).decode(asBufferSource(bytes));
            Logger.info(LogCategory.SYSTEM, `[CRT] ${text.trimEnd()}`);
            return size;
        }
        const handle = this.fds.get(fd);
        if (!handle) {
            this.setErrno(9);
            return -1;
        }
        const data = Mem.readBytes(buffer, size);
        if (!data) {
            this.setErrno(14);
            return -1;
        }
        const vfs = System.getInstance().fileSystem;
        const written = vfs.writeSync(handle, data);
        if (written < 0) {
            this.setErrno(5);
            return -1;
        }
        return written;
    }

    /** int _chsize(int fd, long size) — set the file's length, growing with zeros. */
    private chsize(fd: number, size: number): number | Promise<ThunkResult> {
        return this.chsizeImpl(fd, size | 0, false);
    }

    /**
     * errno_t _chsize_s(int fd, __int64 size) — the secure variant differs twice: the size is
     * 64-bit (two stack dwords) and the errno IS the return value, 0 on success.
     */
    private chsizeS(fd: number, lo: number, hi: number): number | Promise<ThunkResult> {
        return this.chsizeImpl(fd, (hi | 0) * 0x1_0000_0000 + (lo >>> 0), true);
    }

    private chsizeImpl(fd: number, length: number, errnoIsResult: boolean): number | Promise<ThunkResult> {
        const fail = (errno: number): number => {
            this.setErrno(errno);
            return errnoIsResult ? errno : -1;
        };
        const handle = this.fds.get(fd);
        if (!handle) return fail(9); // EBADF
        if (length < 0) return fail(22); // EINVAL
        const vfs = System.getInstance().fileSystem;
        return (async (): Promise<ThunkResult> => {
            try {
                await vfs.truncateAt(handle.path, length);
                return { value: 0 };
            } catch {
                return { value: fail(13) }; // EACCES
            }
        })();
    }

    private lseek(fd: number, offset: number, origin: number): number {
        const handle = this.fds.get(fd);
        if (!handle) {
            this.setErrno(9);
            return -1;
        }
        const vfs = System.getInstance().fileSystem;
        const newPos = vfs.setPosition(handle, offset | 0, origin | 0);
        return newPos | 0;
    }

    private lseeki64(fd: number, offsetLo: number, offsetHi: number, origin: number): number {
        const handle = this.fds.get(fd);
        if (!handle) {
            this.setErrno(9);
            const cpu = getCPU(this.process.v86);
            if (cpu?.reg32) cpu.reg32[2] = 0xffffffff;
            return -1;
        }

        const signedOffset = (offsetHi | 0) * 0x100000000 + (offsetLo >>> 0);
        const vfs = System.getInstance().fileSystem;
        const newPos = vfs.setPosition(handle, signedOffset, origin | 0);
        const cpu = getCPU(this.process.v86);
        if (cpu?.reg32) cpu.reg32[2] = Math.floor(newPos / 0x100000000) >>> 0;
        return newPos >>> 0;
    }

    private tell(fd: number): number {
        const handle = this.fds.get(fd);
        if (!handle) {
            this.setErrno(9);
            return -1;
        }
        return handle.position | 0;
    }

    private filelength(fd: number): number {
        const handle = this.fds.get(fd);
        if (!handle) {
            this.setErrno(9);
            return -1;
        }
        const size = System.getInstance().fileSystem.getFileSize(handle.path);
        return size | 0;
    }

    private eof(fd: number): number {
        const handle = this.fds.get(fd);
        if (!handle) {
            this.setErrno(9);
            return -1;
        }
        const size = System.getInstance().fileSystem.getFileSize(handle.path);
        return handle.position >= size ? 1 : 0;
    }

    private statImpl(pathPtr: number, structPtr: number, wide: boolean): number {
        const path = wide
            ? this.readWString(pathPtr, Msvcrt.MAX_WIDE_SCAN_CHARS)
            : this.readCString(pathPtr, 512);
        if (!path || !structPtr) {
            this.setErrno(22); // EINVAL
            return -1;
        }
        const vfs = System.getInstance().fileSystem;
        // A directory is a legal stat target (st_mode carries _S_IFDIR), and callers
        // use exactly that to probe for one — see crt-vc9-io STAT32_OFFSETS.
        if (vfs.directoryExists(path)) {
            fillStatStruct(structPtr, STAT32_OFFSETS, 36, 0, true, (p, v, n) => this.memset(p, v, n));
            return 0;
        }
        const exists = vfs.hasRomFile(path) || vfs.openSync(path, 0x80000000, 3) !== null;
        if (!exists) {
            this.setErrno(2); // ENOENT
            return -1;
        }
        fillStatStruct(structPtr, STAT32_OFFSETS, 36, vfs.getFileSize(path), false,
            (p, v, n) => this.memset(p, v, n));
        return 0;
    }

    private initterm(pfbegin: number, pfend: number): ThunkResult {
        pfbegin = pfbegin >>> 0;
        pfend = pfend >>> 0;

        if (!pfbegin || !pfend || pfbegin >= pfend) {
            Logger.info(LogCategory.SYSTEM, `_initterm(0x${pfbegin.toString(16)}, 0x${pfend.toString(16)}): empty table, skipping`);
            return { value: 0, skipStackCheck: true };
        }

        const cpu = getCPU(this.process.v86);
        const mem = getMemory(this.process.v86);
        if (!cpu || !mem) {
            Logger.error(LogCategory.SYSTEM, `_initterm: cannot get CPU/memory`);
            return { value: 0, skipStackCheck: true };
        }

        // Collect all non-null function pointers from the initializer table
        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const numEntries = (pfend - pfbegin) >>> 2;
        const constructors: number[] = [];
        for (let i = 0; i < numEntries; i++) {
            const ptr = dv.getUint32(pfbegin + i * 4, true);
            if (ptr !== 0) constructors.push(ptr);
        }

        Logger.log(LogCategory.SYSTEM,
            `_initterm(0x${pfbegin.toString(16)}, 0x${pfend.toString(16)}): ` +
            `${numEntries} entries, ${constructors.length} non-null`);

        if (constructors.length === 0) {
            return { value: 0, skipStackCheck: true };
        }

        // Use the callback chaining mechanism (same pattern as DllMain invocation).
        // saveSuspendedThunkContext saves the current ESP and return address so that
        // after all constructors complete, the callback system restores state and
        // returns to the CRT caller naturally via stack-based POP EAX + RET.
        const callbackManager = this.process.dispatcher.callbackManager;
        const esp = cpu.reg32[4] >>> 0;

        // cdecl _initterm: thunk stub uses RET (0 cleanup). Caller cleans args.
        callbackManager.saveSuspendedThunkContext({ esp }, 0);

        let ctorIndex = 0;
        const completeThunk = (_retVal: number): number | null => {
            ctorIndex++;
            if (ctorIndex < constructors.length) {
                // Chain to next constructor
                callbackManager.invokeCallback(
                    constructors[ctorIndex],
                    [],   // void(*)(void) — no arguments
                    0,    // no caller cleanup
                    completeThunk,
                    true  // isCdecl
                );
                return null; // Continue chain
            }
            // All constructors completed
            Logger.info(LogCategory.SYSTEM,
                `_initterm: all ${constructors.length} static constructors completed`);
            return 0; // Final value (return 0 to CRT)
        };

        // Start first constructor
        callbackManager.invokeCallback(
            constructors[0],
            [],   // no arguments
            0,    // no caller cleanup
            completeThunk,
            true  // isCdecl
        );

        // Return skipStackCheck: invokeCallback has set EIP/ESP to the first constructor.
        // The thunk dispatcher will not perform manual RET — the callback system handles
        // all state restoration when the chain completes.
        return { value: 0, skipStackCheck: true };
    }

    private readCString(ptr: number, maxLen: number): string {
        if (!ptr) return "";
        const limit = Math.max(1, maxLen >>> 0);
        const bytes: number[] = [];
        for (let i = 0; i < limit; i++) {
            const b = Mem.readUint8(ptr + i);
            if (b === null || b === 0) break;
            bytes.push(b);
        }
        return getCodePageDecoder(EmulatorConfig.getInstance().ansiCodePage)
            .decode(new Uint8Array(bytes));
    }

    private writeCString(ptr: number, value: string): void {
        if (!ptr) return;
        const encoded = encodeAnsi(value);
        const bytes = new Uint8Array(encoded.length + 1);
        bytes.set(encoded);
        Mem.writeBytes(ptr, bytes);
    }

    private readWString(ptr: number, maxChars: number): string {
        if (!ptr) return "";
        const mem = getMemory(this.process.v86);
        if (!mem) return "";
        const limit = Math.max(1, Math.min(maxChars >>> 0, Msvcrt.MAX_WIDE_SCAN_CHARS));
        // Read uint16 code units directly from raw memory
        const codes: number[] = [];
        const end = Math.min(ptr + limit * 2, mem.length - 1);
        for (let addr = ptr; addr < end; addr += 2) {
            const codeUnit = mem[addr] | (mem[addr + 1] << 8);
            if (codeUnit === 0) break;
            codes.push(codeUnit);
        }
        return String.fromCharCode(...codes);
    }

    private writeWString(ptr: number, value: string, maxChars?: number): void {
        if (!ptr) return;
        const limit = maxChars !== undefined ? Math.max(1, maxChars >>> 0) : (value.length + 1);
        const writeChars = Math.min(value.length, Math.max(0, limit - 1));
        const bytes = new Uint8Array((writeChars + 1) * 2);
        for (let i = 0; i < writeChars; i++) {
            const code = value.charCodeAt(i);
            bytes[i * 2] = code & 0xff;
            bytes[i * 2 + 1] = (code >>> 8) & 0xff;
        }
        Mem.writeBytes(ptr, bytes);
    }

    private compareCString(aPtr: number, bPtr: number, ignoreCase: boolean, max: number): number {
        let i = 0;
        while (max === 0 || i < max) {
            const aByte = Mem.readUint8(aPtr + i) ?? 0;
            const bByte = Mem.readUint8(bPtr + i) ?? 0;
            let ac = aByte;
            let bc = bByte;
            if (ignoreCase) {
                if (ac >= 0x41 && ac <= 0x5a) ac += 0x20;
                if (bc >= 0x41 && bc <= 0x5a) bc += 0x20;
            }
            if (ac !== bc) return (ac - bc) | 0;
            if (aByte === 0 || bByte === 0) return 0;
            i++;
        }
        return 0;
    }

    private findChar(ptr: number, ch: number, last: boolean): number {
        if (!ptr) return 0;
        const target = ch & 0xff;
        let found = 0;
        for (let i = 0; i < 0x100000; i++) {
            const b = Mem.readUint8(ptr + i);
            if (b === null) break;
            if (b === target) {
                const addr = (ptr + i) >>> 0;
                if (!last) return addr;
                found = addr;
            }
            if (b === 0) break;
        }
        return found >>> 0;
    }

    private wcslen(ptr: number): number {
        if (!ptr) return 0;
        const region = this.process.addressSpace.getRegion(ptr);
        const maxByRegion = region ? ((region.base + region.size - ptr) >>> 1) : Msvcrt.MAX_WIDE_SCAN_CHARS;
        const maxChars = Math.max(1, Math.min(Msvcrt.MAX_WIDE_SCAN_CHARS, maxByRegion));
        let chars = 0;
        for (let i = 0; i < maxChars * 2; i += 2) {
            const codeUnit = Mem.readUint16(ptr + i);
            if (codeUnit === null || codeUnit === 0) break;
            chars++;
        }
        return chars;
    }

    private wcscpy(dest: number, src: number): number {
        if (!dest || !src) return dest >>> 0;
        const maxCharsToCopy = this.computeSafeWideCopyChars(dest);
        if (maxCharsToCopy <= 0) {
            this.setErrno(34);
            Logger.log(
                LogCategory.SYSTEM,
                `msvcrt.wcscpy blocked: no safe space (dest=0x${dest.toString(16)}, src=0x${src.toString(16)}, esp=0x${this.getCurrentEsp().toString(16)})`
            );
            return dest >>> 0;
        }

        // Safety cap: avoid runaway copies that can corrupt guest stack when source isn't terminated.
        for (let i = 0; i < maxCharsToCopy; i++) {
            const codeUnit = Mem.readUint16(src + i * 2);
            if (codeUnit === null) {
                break;
            }
            this.writeUint16(dest + i * 2, codeUnit);
            if (codeUnit === 0) {
                return dest >>> 0;
            }
        }
        this.writeUint16(dest + (maxCharsToCopy - 1) * 2, 0);
        this.setErrno(34);
        Logger.log(
            LogCategory.SYSTEM,
            `msvcrt.wcscpy truncated (dest=0x${dest.toString(16)}, src=0x${src.toString(16)}, maxChars=${maxCharsToCopy}, esp=0x${this.getCurrentEsp().toString(16)})`
        );
        return dest >>> 0;
    }

    private wcsicmp(aPtr: number, bPtr: number): number {
        if (this.dbgStrCap) this._dbgCapPair('_wcsicmp', aPtr, bPtr);
        return this.compareWString(aPtr, bPtr, true, 0);
    }

    private wcschr(ptr: number, ch: number): number {
        if (!ptr) return 0;
        const target = ch & 0xffff;
        for (let i = 0; i < 0x100000; i += 2) {
            const codeUnit = Mem.readUint16(ptr + i);
            if (codeUnit === null) break;
            if (codeUnit === target) return (ptr + i) >>> 0;
            if (codeUnit === 0) break;
        }
        return 0;
    }

    private wcscat(dest: number, src: number): number {
        if (!dest || !src) return dest >>> 0;
        const mem = getMemory(this.process.v86);
        if (!mem) return dest >>> 0;
        // Find end of dest string
        let dstOff = dest;
        const memLen = mem.length - 1;
        while (dstOff < memLen && (mem[dstOff] | (mem[dstOff + 1] << 8)) !== 0) {
            dstOff += 2;
        }
        // Copy src to dest end (including null terminator)
        let srcOff = src;
        while (srcOff < memLen && dstOff < memLen) {
            const lo = mem[srcOff];
            const hi = mem[srcOff + 1];
            mem[dstOff] = lo;
            mem[dstOff + 1] = hi;
            if ((lo | (hi << 8)) === 0) break;
            srcOff += 2;
            dstOff += 2;
        }
        return dest >>> 0;
    }

    private wcscmp(aPtr: number, bPtr: number): number {
        if (this.dbgStrCap) this._dbgCapPair('wcscmp', aPtr, bPtr);
        return this.compareWString(aPtr, bPtr, false, 0);
    }

    private wcsncmp(aPtr: number, bPtr: number, count: number): number {
        return this.compareWString(aPtr, bPtr, false, count >>> 0);
    }

    private wcsncpy(dest: number, src: number, count: number): number {
        const max = count >>> 0;
        if (!dest || max === 0) return dest >>> 0;
        let i = 0;
        for (; i < max; i++) {
            const ch = Mem.readUint16(src + i * 2) ?? 0;
            this.writeUint16(dest + i * 2, ch);
            if (ch === 0) { i++; break; }
        }
        for (; i < max; i++) {
            this.writeUint16(dest + i * 2, 0);
        }
        return dest >>> 0;
    }

    private wcsstr(hayPtr: number, needlePtr: number): number {
        if (this.dbgStrCap) this._dbgCapPair('wcsstr', hayPtr, needlePtr);
        if (!hayPtr || !needlePtr) return 0;
        const needle = this.readWString(needlePtr, Msvcrt.MAX_WIDE_SCAN_CHARS);
        if (needle.length === 0) return hayPtr >>> 0;
        const haystack = this.readWString(hayPtr, Msvcrt.MAX_WIDE_SCAN_CHARS);
        const idx = haystack.indexOf(needle);
        if (idx < 0) return 0;
        return (hayPtr + idx * 2) >>> 0;
    }

    private wcsnicmp(aPtr: number, bPtr: number, count: number): number {
        // Diagnostic: log when comparing a near-null pointer (NULL FNameEntry)
        if (aPtr < 0x100 || bPtr < 0x100) {
            const aStr = aPtr < 0x100 ? `(near-null@0x${aPtr.toString(16)})` : `"${this.readWString(aPtr, 30)}"`;
            const bStr = bPtr < 0x100 ? `(near-null@0x${bPtr.toString(16)})` : `"${this.readWString(bPtr, 30)}"`;
            Logger.verbose(LogCategory.THUNK,
                `[WCSNICMP] NEAR-NULL: ${aStr} vs ${bStr} count=${count}`);
        }
        return this.compareWString(aPtr, bPtr, true, count >>> 0);
    }

    private wcsupr(ptr: number): number {
        if (!ptr) return 0;
        for (let i = 0; i < Msvcrt.MAX_WIDE_SCAN_CHARS; i++) {
            const ch = Mem.readUint16(ptr + i * 2) ?? 0;
            if (ch === 0) break;
            if (ch >= 0x61 && ch <= 0x7a) {
                this.writeUint16(ptr + i * 2, ch - 0x20);
            }
        }
        return ptr >>> 0;
    }

    private compareWString(aPtr: number, bPtr: number, ignoreCase: boolean, max: number): number {
        const mem = getMemory(this.process.v86);
        if (!mem) return 0;
        let i = 0;
        const limit = max > 0 ? max : Msvcrt.MAX_WIDE_SCAN_CHARS;
        const memLen = mem.length - 1;
        while (i < limit) {
            const aOff = aPtr + i * 2;
            const bOff = bPtr + i * 2;
            if (aOff >= memLen || bOff >= memLen) return 0;
            let ac = mem[aOff] | (mem[aOff + 1] << 8);
            let bc = mem[bOff] | (mem[bOff + 1] << 8);
            if (ignoreCase) {
                if (ac >= 0x41 && ac <= 0x5a) ac += 0x20;
                if (bc >= 0x41 && bc <= 0x5a) bc += 0x20;
            }
            if (ac !== bc) return (ac - bc) | 0;
            if (ac === 0) return 0;
            i++;
        }
        return 0;
    }

    /**
     * Run the shared printf engine in WIDE mode: %s defaults to a wide guest
     * string, %hs/%S select narrow; floats consume a promoted double (2 dwords).
     */
    private formatWide(format: string, reader: VaListReader | ArrayVaListReader): string {
        return formatCLazy(
            format,
            reader,
            (addr, maxLen) => this.readCString(addr, maxLen),
            { wide: true, readWString: (addr, maxChars) => this.readWString(addr, maxChars) }
        );
    }

    private vsnwprintf(buffer: number, count: number, formatPtr: number, argListPtr: number): number {
        if (!buffer || !count || !formatPtr) return -1;
        const maxChars = count >>> 0;
        const format = this.readWString(formatPtr, Msvcrt.MAX_WIDE_SCAN_CHARS);

        // Fast path: no format specifiers at all — just copy the string directly
        if (format.indexOf('%') === -1) {
            if (format.length >= maxChars) {
                this.writeWString(buffer, format.slice(0, maxChars - 1), maxChars);
                return -1;
            }
            this.writeWString(buffer, format, maxChars);
            return format.length;
        }

        const out = this.formatWide(format, new VaListReader(argListPtr >>> 0));

        // Always log _vsnwprintf output for runtime text diagnostics.
        // Escape CR/LF to keep logs single-line and cap very long lines.
        const escapedOut = out.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
        const preview = escapedOut.length > 512 ? `${escapedOut.slice(0, 512)}...` : escapedOut;
        const willTruncate = out.length >= maxChars;
        Logger.log(
            LogCategory.THUNK,
            `_vsnwprintf: len=${out.length} cap=${maxChars} truncated=${willTruncate ? 1 : 0} text="${preview}"`
        );


        if (out.length >= maxChars) {
            this.writeWString(buffer, out.slice(0, maxChars - 1), maxChars);
            return -1;
        }
        this.writeWString(buffer, out, maxChars);
        return out.length;
    }

    /**
     * Dump CPU registers and FPU stack for diagnostics.
     * Called on key game messages to diagnose native code issues.
     */
    private dumpCpuFpuState(trigger: string): void {
        try {
            const v86: any = this.process?.v86;
            const cpu: any = v86?.cpu ?? v86?.v86?.cpu;
            if (!cpu) return;

            const h = (v: number) => '0x' + (v >>> 0).toString(16).padStart(8, '0');
            const reg32 = cpu.reg32;
            if (!reg32) return;

            // CPU registers
            const regs = `EAX=${h(reg32[0])} ECX=${h(reg32[1])} EDX=${h(reg32[2])} EBX=${h(reg32[3])} ` +
                `ESP=${h(reg32[4])} EBP=${h(reg32[5])} ESI=${h(reg32[6])} EDI=${h(reg32[7])}`;

            // FPU stack — dump all 8 entries
            const fpuEntries: string[] = [];
            for (let i = 0; i < 8; i++) {
                try {
                    const val = fpuGetST(v86, i);
                    fpuEntries.push(`ST(${i})=${val}`);
                } catch {
                    fpuEntries.push(`ST(${i})=<empty>`);
                }
            }

            // FPU stack pointer and empty mask
            const fpuStackPtr = cpu.fpu_stack_ptr;
            const fpuStackEmpty = cpu.fpu_stack_empty;
            const stkPtrVal = typeof fpuStackPtr === 'number' ? fpuStackPtr : (fpuStackPtr?.[0] ?? '?');
            const emptyVal = typeof fpuStackEmpty === 'number' ? fpuStackEmpty : (fpuStackEmpty?.[0] ?? '?');

            // Stack top (raw ESP dump)
            const esp = reg32[4] >>> 0;
            const ebp = reg32[5] >>> 0;
            const eip = cpu.instruction_pointer?.[0] ?? cpu.eip ?? 0;
            const mem = getMemory(this.process.v86);
            const stackLines: string[] = [];
            if (mem && esp > 0x1000 && esp + 64 <= mem.length) {
                const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                for (let off = 0; off < 64; off += 4) {
                    const val = dv.getUint32(esp + off, true) >>> 0;
                    const resolved = this.process?.moduleRegistry?.resolveAddress(val);
                    stackLines.push(`  [ESP+0x${off.toString(16)}] = ${h(val)}${resolved ? '  ' + resolved : ''}`);
                }
            } else {
                stackLines.push(`  (getMemory=${!!mem} esp=${h(esp)} len=${mem?.length ?? 0})`);
            }

            // EBP chain walk for call stack
            const callStack: string[] = [];
            if (mem && ebp > 0x1000 && ebp + 8 <= mem.length) {
                const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                let frame = ebp;
                for (let depth = 0; depth < 20; depth++) {
                    if (frame < 0x1000 || frame + 8 > mem.length) break;
                    // [EBP] = saved EBP, [EBP+4] = return address
                    const retAddr = dv.getUint32(frame + 4, true) >>> 0;
                    const nextFrame = dv.getUint32(frame, true) >>> 0;
                    const resolved = this.process?.moduleRegistry?.resolveAddress(retAddr);
                    callStack.push(`  #${depth} ${h(retAddr)}${resolved ? '  ' + resolved : ''}  (frame=${h(frame)})`);
                    if (nextFrame <= frame || nextFrame < 0x1000) break; // stack grows down
                    frame = nextFrame;
                }
            }

            Logger.warn(LogCategory.THUNK,
                `[CPU/FPU DUMP] ${trigger}\n` +
                `  Registers: ${regs}  EIP=${h(eip >>> 0)}\n` +
                `  FPU stack (ptr=${stkPtrVal} empty=0x${(typeof emptyVal === 'number' ? emptyVal : 0).toString(16)}):\n` +
                `    ${fpuEntries.join('  ')}\n` +
                `  Raw stack (ESP=${h(esp)}):\n${stackLines.join('\n')}\n` +
                `  Call stack (EBP chain from ${h(ebp)}):\n${callStack.length ? callStack.join('\n') : '  (no frames)'}`);
        } catch (e) {
            Logger.warn(LogCategory.THUNK, `[CPU/FPU DUMP] Failed: ${e}`);
        }
    }

    private controlfp(newControl: number, mask: number): number {
        const m = mask >>> 0;
        if (m !== 0) {
            const n = newControl >>> 0;
            this.controlFpWord = ((this.controlFpWord & ~m) | (n & m)) >>> 0;
        }
        return this.controlFpWord >>> 0;
    }

    private getCurrentEsp(): number {
        const v86: any = this.process?.v86;
        const cpu: any = v86?.cpu ?? v86?.v86?.cpu;
        return (cpu?.reg32?.[4] >>> 0) || 0;
    }

    private getCurrentEbp(): number {
        const v86: any = this.process?.v86;
        const cpu: any = v86?.cpu ?? v86?.v86?.cpu;
        return (cpu?.reg32?.[5] >>> 0) || 0;
    }

    private getCurrentStackBounds(): { base: number; top: number } | null {
        const sched: any = System.getInstance().scheduler;
        if (!sched || typeof sched.getCurrentThread_compat !== "function") {
            return null;
        }
        const th = sched.getCurrentThread_compat();
        if (!th) return null;
        const base = th.stackBase >>> 0;
        const top = th.stackTop >>> 0;
        if (base === 0 || top === 0 || top <= base) return null;
        return { base, top };
    }

    private computeSafeWideCopyChars(dest: number): number {
        let safeChars = Msvcrt.MAX_WIDE_COPY_CHARS;

        const region = this.process.addressSpace.getRegion(dest);
        if (region) {
            const bytesInRegion = Math.max(0, (region.base + region.size) - dest);
            safeChars = Math.min(safeChars, bytesInRegion >>> 1);
        }

        const esp = this.getCurrentEsp();
        const ebp = this.getCurrentEbp();
        const stack = this.getCurrentStackBounds();
        if (stack && dest >= stack.base && dest < stack.top) {
            safeChars = Math.min(safeChars, Msvcrt.STACK_WCSCPY_HARD_CAP_CHARS);
        }
        if (esp !== 0 && ebp !== 0 && ebp > esp) {
            // Typical x86 frame:
            // [esp ... ebp)   -> local variables (potentially writable)
            // [ebp]           -> saved EBP
            // [ebp+4]         -> return address (must never be clobbered)
            if (dest >= esp && dest < ebp) {
                const bytesUntilFrameTop = ebp - dest;
                if (bytesUntilFrameTop <= Msvcrt.STACK_GUARD_BYTES) {
                    return 0;
                }
                const frameSafeChars = (bytesUntilFrameTop - Msvcrt.STACK_GUARD_BYTES) >>> 1;
                safeChars = Math.min(safeChars, frameSafeChars);
            } else if (dest >= ebp && dest < (ebp + 8)) {
                // Destination points into saved EBP/RET area.
                return 0;
            }
        } else if (esp !== 0 && dest < esp) {
            // Fallback for non-standard frames.
            const bytesUntilEsp = esp - dest;
            if (bytesUntilEsp <= Msvcrt.STACK_GUARD_BYTES) {
                return 0;
            }
            const stackSafeChars = (bytesUntilEsp - Msvcrt.STACK_GUARD_BYTES) >>> 1;
            safeChars = Math.min(safeChars, stackSafeChars);
        }

        return safeChars | 0;
    }

    private computeCtypeFlags(ch: number): number {
        const C_UPPER = 0x0001;
        const C_LOWER = 0x0002;
        const C_DIGIT = 0x0004;
        const C_SPACE = 0x0008;
        const C_PUNCT = 0x0010;
        const C_CONTROL = 0x0020;
        const C_BLANK = 0x0040;
        const C_HEX = 0x0080;
        const C_ALPHA = 0x0100;

        let flags = 0;
        if (ch >= 0x41 && ch <= 0x5a) {
            flags |= C_UPPER | C_ALPHA;
        } else if (ch >= 0x61 && ch <= 0x7a) {
            flags |= C_LOWER | C_ALPHA;
        }
        if (ch >= 0x30 && ch <= 0x39) {
            flags |= C_DIGIT | C_HEX;
        }
        if (ch === 0x20 || ch === 0x09) flags |= C_SPACE | C_BLANK;
        if (ch === 0x0a || ch === 0x0d || ch === 0x0b || ch === 0x0c) flags |= C_SPACE;
        if (ch < 0x20 || ch === 0x7f) flags |= C_CONTROL;
        if (ch >= 0x21 && ch <= 0x7e && (flags & (C_ALPHA | C_DIGIT)) === 0) flags |= C_PUNCT;
        if (ch >= 0x41 && ch <= 0x46) flags |= C_HEX;
        if (ch >= 0x61 && ch <= 0x66) flags |= C_HEX;
        return flags;
    }

    private writeUint16(addr: number, value: number): void {
        const data = new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
        Mem.writeBytes(addr, data);
    }

    private nextFd(): number {
        while (this.fds.has(this.fdNext)) this.fdNext++;
        return this.fdNext++;
    }

    /**
     * _ftol / __ftol: convert ST(0) to a signed __int64 (truncate toward zero), pop ST(0), and
     * return the FULL 64-bit result in EDX:EAX. Returning only a clamped int32 (old behaviour)
     * broke 64-bit users — notably the UE1 launcher's RDTSC timebase `now = _ftol(seconds*2^32)`,
     * which exceeds INT32_MAX within ~0.5s and pinned per-frame DeltaTime to 0 (frozen splash).
     * JS fallback — primary path is WASM hypercall handler 17 (kept in sync).
     */
    private ftol(): number {
        try {
            const value = fpuGetST(this.process.v86, 0);
            fpuPop(this.process.v86);
            const v = Math.trunc(value);
            const reg = (this.process as any)?.dispatcher?.cachedReg32;
            if (reg) reg[2] = Math.floor(v / 4294967296) | 0;  // EDX = high 32
            return (v >>> 0) | 0;                               // EAX = low 32
        } catch (e) {
            Logger.log(LogCategory.SYSTEM, `msvcrt._ftol failed: ${e}`);
            return 0;
        }
    }

    /**
     * _atoi64: parse a decimal string to a signed __int64, returned in EDX:EAX (like _ftol).
     * BigInt keeps full 64-bit precision; two's-complement masking gives correct sign-extended halves.
     */
    private atoi64(strPtr: number): number {
        try {
            const s = this.readCString(strPtr >>> 0, 256).trim();
            const m = s.match(/^[+-]?\d+/);
            let v = 0n;
            if (m) { try { v = BigInt(m[0]); } catch { v = 0n; } }
            const reg = (this.process as any)?.dispatcher?.cachedReg32;
            if (reg) reg[2] = Number((v >> 32n) & 0xffffffffn) | 0;  // EDX = high 32
            return Number(v & 0xffffffffn) | 0;                      // EAX = low 32
        } catch (e) {
            Logger.log(LogCategory.SYSTEM, `msvcrt._atoi64 failed: ${e}`);
            return 0;
        }
    }

    /**
     * _CItan: Compute tangent of ST(0), result replaces ST(0)
     * Compiler intrinsic for tan() that operates directly on FPU stack
     */
    private CItan(): number {
        try {
            const x = fpuGetST(this.process.v86, 0);
            const result = Math.tan(x);
            fpuSetST0(this.process.v86, result);
            return 0;
        } catch (e) {
            Logger.log(LogCategory.SYSTEM, `msvcrt._CItan failed: ${e}`);
            fpuSetST0(this.process.v86, 0);
            return 0;
        }
    }

    /**
     * _CIatan2: Compute atan2(y, x) where y=ST(1), x=ST(0)
     * Result replaces ST(1), and ST(0) is popped (net effect: pops one value, leaves result)
     *
     * Stack before: ST(0)=x, ST(1)=y
     * Stack after:  ST(0)=atan2(y,x)
     */
    private CIatan2(): number {
        try {
            const x = fpuGetST(this.process.v86, 0);  // ST(0) = x
            const y = fpuGetST(this.process.v86, 1);  // ST(1) = y
            const result = Math.atan2(y, x);

            // Pop ST(0), so ST(1) becomes new ST(0).
            fpuPop(this.process.v86);
            // Now write result to new ST(0) (which was ST(1))
            fpuSetST0(this.process.v86, result);
            return 0;
        } catch (e) {
            Logger.log(LogCategory.SYSTEM, `msvcrt._CIatan2 failed: ${e}`);
            fpuSetST0(this.process.v86, 0);
            return 0;
        }
    }

    /**
     * _CIfmod: fmod(y, x) where y=ST(1), x=ST(0)
     * Result replaces ST(1), ST(0) is popped
     */
    private CIfmod(): number {
        try {
            const x = fpuGetST(this.process.v86, 0);
            const y = fpuGetST(this.process.v86, 1);
            const result = x !== 0 ? y % x : 0;
            fpuPop(this.process.v86);
            fpuSetST0(this.process.v86, result);
            return 0;
        } catch (e) {
            Logger.log(LogCategory.SYSTEM, `msvcrt._CIfmod failed: ${e}`);
            fpuSetST0(this.process.v86, 0);
            return 0;
        }
    }

    /**
     * ceil(x): args are a double passed as two u32 (lo, hi)
     * Returns double via FPU ST(0) — but MSVC cdecl ceil returns in ST(0),
     * and the thunk system puts EAX as return. We return the integer part in EAX
     * and set ST(0) for the FPU-aware caller.
     */
    private ceil(lo: number, hi: number): number {
        const value = this.u32PairToDouble(lo, hi);
        const result = Math.ceil(value);
        fpuPush(this.process.v86, result);
        return (result | 0) >>> 0;
    }

    private floor(lo: number, hi: number): number {
        const value = this.u32PairToDouble(lo, hi);
        const result = Math.floor(value);
        fpuPush(this.process.v86, result);
        return (result | 0) >>> 0;
    }

    private isnan(lo: number, hi: number): number {
        const value = this.u32PairToDouble(lo, hi);
        return Number.isNaN(value) ? 1 : 0;
    }

    private finite(lo: number, hi: number): number {
        const value = this.u32PairToDouble(lo, hi);
        return Number.isFinite(value) ? 1 : 0;
    }

    private localeAddr = 0;
    private currentLocale = "C";
    private setlocale(_category: number, localePtr: number): number {
        if (localePtr) {
            const requested = this.readCString(localePtr, 128);
            if (requested.length > 0) {
                this.currentLocale = requested;
                const newAddr = this.process.memory.alloc(this.currentLocale.length + 1, "THUNK_DATA", "rw");
                if (newAddr) {
                    this.localeAddr = newAddr;
                    this.writeCString(this.localeAddr, this.currentLocale);
                }
            }
        }
        if (!this.localeAddr) {
            this.localeAddr = this.process.memory.alloc(this.currentLocale.length + 1, "THUNK_DATA", "rw");
            this.writeCString(this.localeAddr, this.currentLocale);
        }
        // A locale change flips tolower/toupper's 0x80-0xFF range between ASCII-only ("C")
        // and the ANSI codepage's case-folding — rebuild the shared LUTs (stub + JS read them).
        this.buildCaseTables();
        return this.localeAddr >>> 0;
    }

    /**
     * struct lconv* localeconv(void) — 10 char* fields then 8 chars (48 bytes).
     * Only LC_NUMERIC is ever set by setlocale() here, so the struct stays the "C"
     * locale's: "." for decimal_point, empty strings elsewhere, CHAR_MAX for the
     * formatting chars ("not available", which is what the C locale specifies).
     * Callers that parse floats locale-independently read decimal_point and compare.
     */
    private lconvAddr = 0;
    private localeconv(): number {
        if (this.lconvAddr) return this.lconvAddr >>> 0;
        const LCONV_SIZE = 48;
        const empty = this.process.memory.alloc(2, "THUNK_DATA", "rw");
        this.writeCString(empty, "");
        const dot = this.process.memory.alloc(2, "THUNK_DATA", "rw");
        this.writeCString(dot, ".");
        const addr = this.process.memory.alloc(LCONV_SIZE, "THUNK_DATA", "rw");
        Mem.writeUint32(addr, dot);
        for (let off = 4; off < 40; off += 4) Mem.writeUint32(addr + off, empty);
        for (let off = 40; off < LCONV_SIZE; off++) Mem.writeUint8(addr + off, 0x7f); // CHAR_MAX
        this.lconvAddr = addr;
        return addr >>> 0;
    }

    // ==================== Formatted output (new) ====================

    private vsnprintf(dest: number, count: number, fmtPtr: number, vaList: number): number {
        if (!dest || !fmtPtr) return -1;
        const max = count >>> 0;
        if (max === 0) return -1;
        const format = this.readCString(fmtPtr, 0x100000);
        const reader = vaList ? new VaListReader(vaList) : new VaListReader(0);
        const text = formatCLazy(format, reader, (addr, maxLen) => this.readCString(addr, maxLen));
        const bytes = encodeAnsi(text);
        if (bytes.length < max) {
            Mem.writeBytes(dest, bytes);
            Mem.writeBytes(dest + bytes.length, new Uint8Array([0]));
            return bytes.length | 0;
        }
        Mem.writeBytes(dest, bytes.subarray(0, max));
        return -1;
    }

    private vsprintf(dest: number, fmtPtr: number, vaList: number): number {
        if (!dest || !fmtPtr) return -1;
        const format = this.readCString(fmtPtr, 0x100000);
        const reader = vaList ? new VaListReader(vaList) : new VaListReader(0);
        const text = formatCLazy(format, reader, (addr, maxLen) => this.readCString(addr, maxLen));
        const bytes = encodeAnsi(text);
        Mem.writeBytes(dest, bytes);
        Mem.writeBytes(dest + bytes.length, new Uint8Array([0]));
        return text.length;
    }

    private snprintf(args: number[]): number {
        const dest = args[0] ?? 0;
        const count = args[1] ?? 0;
        const fmtPtr = args[2] ?? 0;
        if (!dest || !fmtPtr) return -1;
        const max = count >>> 0;
        if (max === 0) return -1;
        const format = this.readCString(fmtPtr, 0x100000);
        const reader = new ArrayVaListReader(args, 3);
        const text = formatCLazy(format, reader, (addr, maxLen) => this.readCString(addr, maxLen));
        const bytes = encodeAnsi(text);
        if (bytes.length < max) {
            Mem.writeBytes(dest, bytes);
            Mem.writeBytes(dest + bytes.length, new Uint8Array([0]));
            return bytes.length | 0;
        }
        Mem.writeBytes(dest, bytes.subarray(0, max));
        return -1;
    }

    private swprintf(args: number[]): number {
        const dest = args[0] ?? 0;
        const fmtPtr = args[1] ?? 0;
        if (!dest || !fmtPtr) return -1;
        const format = this.readWString(fmtPtr, Msvcrt.MAX_WIDE_SCAN_CHARS);
        const out = this.formatWide(format, new ArrayVaListReader(args, 2));
        this.writeWString(dest, out);
        return out.length;
    }

    // ==================== High-level file I/O (FILE*) ====================

    // Simple FILE* simulation: we use the fd number as the FILE* pointer value
    // and store a mapping. Real FILE structs aren't needed since apps only pass
    // the pointer back to us.
    private fileStreams: Map<number, MsvcrtFileStream> = new Map();
    private nextFilePtr = 0x70000000; // pseudo-pointer space for FILE*
    /**
     * When true, fopen hands out a REAL zeroed guest FILE struct instead of the
     * 0x70000000 token. Borland/Watcom CRTs inline getc/putc, dereferencing FILE
     * internals directly (Borland layout: level@+0, curp@+20); a bare token
     * (which is outside guest RAM) makes those reads garbage and corrupts e.g.
     * the LZSS decompressor's input stream. A zeroed struct keeps level<=0, so the
     * inlined macro always falls through to _fgetc/_fputc, which our VFS handlers
     * implement. Enabled via enableRealFileStructs() (see modules/cw3220).
     */
    private useRealFileStructs = false;
    /** Borland CW3220/Turbo-C FILE layout (32-bit): int level, …, char *curp @ +20. */
    private static readonly BORLAND_FILE_SIZE = 32;
    private static readonly BORLAND_FILE_LEVEL_OFF = 0;
    private static readonly BORLAND_FILE_CURP_OFF = 20;
    /** getc refill chunk for buffered (inlined-getc) mode. One trap per chunk instead
     *  of per byte — turns a per-byte OUT-trap storm (minutes for a big LZSS stream)
     *  into a few chunk reads. */
    private static readonly GETC_CHUNK = 256 * 1024;
    /** Buffered getc: on refill, read a 256KB CHUNK into a guest buffer and point the
     *  guest's FILE->curp/level at it, so the inlined getc macro drains it straight from
     *  guest RAM with ZERO traps (faithful to how Borland's getc drains FILE's internal
     *  buffer) — one trap per chunk instead of one per byte. Only engages for real-FILE-
     *  struct streams (Borland/Watcom CRTs). The old "T2 has no context" SuspendThread(self)
     *  scheduler bug that blocked verifying this is fixed (see dwnoir-bringup memory). */
    private static readonly BUFFERED_GETC = true;

    /** Route fopen through real guest FILE structs (for CRTs that inline getc/putc). */
    enableRealFileStructs(): void { this.useRealFileStructs = true; }

    /**
     * Borland FILE field offsets, exposed so the inline x86 getc stub
     * (crt-slab-stubs writeGetcStub) reads/writes the SAME fields this module's
     * buffered-getc path fills. Single source of truth — keep them in lockstep.
     */
    getBorlandFileLayout(): { levelOff: number; curpOff: number; size: number } {
        return {
            levelOff: Msvcrt.BORLAND_FILE_LEVEL_OFF,
            curpOff: Msvcrt.BORLAND_FILE_CURP_OFF,
            size: Msvcrt.BORLAND_FILE_SIZE,
        };
    }

    /**
     * Re-sync handle.position with the guest getc buffer's unconsumed bytes
     * (FILE->level) and mark the buffer empty. Buffered getc advances handle.position
     * by a whole chunk up front, so any non-getc op (fseek/ftell/fread) must first
     * "give back" the bytes the guest hasn't consumed yet, else positions drift.
     */
    private flushGetcBuffer(filePtr: number, handle: VfsFileHandle): void {
        if (!this.useRealFileStructs) return;
        const levelOff = Msvcrt.BORLAND_FILE_LEVEL_OFF;
        const curpOff = Msvcrt.BORLAND_FILE_CURP_OFF;
        const level = Mem.readInt32(filePtr + levelOff) ?? 0;
        if (level > 0) {
            // Through the seek API, not the field: the rewind has to go past the read
            // window the same way any other seek does.
            System.getInstance().fileSystem.setPosition(handle, -level, 1 /* FILE_CURRENT */);
            Mem.writeUint32(filePtr + levelOff, 0); // level = 0 → next getc refills
            Mem.writeUint32(filePtr + curpOff, 0);
        }
    }

    private fopen(pathPtr: number, modePtr: number): number {
        const path = this.readCString(pathPtr, 512);
        const mode = this.readCString(modePtr, 16);
        return this.fopenPath(path, mode);
    }

    private wfopen(pathPtr: number, modePtr: number): number {
        const path = this.readWString(pathPtr, Msvcrt.MAX_WIDE_SCAN_CHARS);
        const mode = this.readWString(modePtr, 16);
        return this.fopenPath(path, mode);
    }

    private fopenPath(path: string, mode: string): number {
        if (!path || !mode) return 0;

        const GENERIC_READ = 0x80000000;
        const GENERIC_WRITE = 0x40000000;
        const OPEN_EXISTING = 3;
        const CREATE_ALWAYS = 2;
        const OPEN_ALWAYS = 4;

        let access = GENERIC_READ;
        let disposition = OPEN_EXISTING;

        if (mode.includes("w")) {
            access = GENERIC_WRITE;
            disposition = CREATE_ALWAYS;
        } else if (mode.includes("a")) {
            access = GENERIC_READ | GENERIC_WRITE;
            disposition = OPEN_ALWAYS;
        }
        if (mode.includes("+")) {
            access = GENERIC_READ | GENERIC_WRITE;
        }

        const vfs = System.getInstance().fileSystem;
        const handle = vfs.openSync(path, access, disposition);
        if (!handle) return 0;

        if (mode.includes("a")) {
            handle.position = vfs.getFileSize(handle.path);
        }

        const fd = this.nextFd();
        this.fds.set(fd, handle);

        let filePtr: number;
        let structPtr: number | undefined;
        if (this.useRealFileStructs) {
            // Real, zeroed FILE struct so inlined getc/putc (Borland/Watcom) read
            // valid memory: level(+8)=0 keeps the macro on the _fgetc/_fputc path.
            structPtr = this.malloc(Msvcrt.BORLAND_FILE_SIZE) >>> 0;
            if (structPtr) {
                this.memset(structPtr, 0, Msvcrt.BORLAND_FILE_SIZE);
                filePtr = structPtr;
            } else {
                filePtr = this.nextFilePtr;   // OOM — fall back to a token
                this.nextFilePtr += 4;
                structPtr = undefined;
            }
        } else {
            filePtr = this.nextFilePtr;
            this.nextFilePtr += 4;
        }
        // Text mode (no "b") strips CRLF→LF on read, matching the MSVC CRT. SS2's config
        // files are CRLF; without this, fgets returns "...install.cfg\r\n" and the parsed
        // directive value keeps a trailing \r → fopen("install.cfg\r") fails → resources
        // never load. Binary mode ("b") reads bytes verbatim.
        const text = !mode.includes("b");
        this.fileStreams.set(filePtr, { fd, handle, ungetChar: -1, text, eof: false, err: false, structPtr });
        return filePtr >>> 0;
    }

    private fclose(filePtr: number): number {
        const stream = this.fileStreams.get(filePtr);
        if (!stream) return -1;
        this.fds.delete(stream.fd);
        this.fileStreams.delete(filePtr);
        if (stream.bufPtr) { try { this.free(stream.bufPtr); } catch { /* best-effort */ } }
        if (stream.structPtr) { try { this.free(stream.structPtr); } catch { /* best-effort */ } }
        return 0;
    }

    private fread(ctx: unknown, mem: Uint8Array, bufPtr: number, size: number, count: number, filePtr: number): number | Promise<ThunkResult> {
        const stream = this.fileStreams.get(filePtr);
        if (!stream) return 0;
        this.flushGetcBuffer(filePtr, stream.handle);
        const elemSize = size >>> 0;
        const numElems = count >>> 0;
        const totalBytes = elemSize * numElems;
        if (totalBytes === 0) return 0;
        const vfs = System.getInstance().fileSystem;
        const startPos = stream.handle.position;
        const synced = vfs.readIntoSync(stream.handle, mem, bufPtr, totalBytes);
        if (synced !== null) {
            if (LARGE_IO_TRACE_ENABLED) traceLargeRead('fread', stream.handle.path, stream.fd, startPos, totalBytes, synced);
            return Math.floor(synced / elemSize);
        }

        return (async (): Promise<ThunkResult> => {
            const freshMem = Mem.getView();
            if (!freshMem) return { value: 0 };
            try {
                const bytesRead = await vfs.readInto(stream.handle, freshMem, bufPtr, totalBytes);
                if (LARGE_IO_TRACE_ENABLED) traceLargeRead('fread', stream.handle.path, stream.fd, startPos, totalBytes, bytesRead);
                return { value: Math.floor(bytesRead / elemSize) };
            } catch {
                return { value: 0 };
            }
        })();
    }

    private fwrite(bufPtr: number, size: number, count: number, filePtr: number): number | Promise<ThunkResult> {
        const stream = this.fileStreams.get(filePtr);
        if (!stream) return 0;
        this.flushGetcBuffer(filePtr, stream.handle);
        const elemSize = size >>> 0;
        const numElems = count >>> 0;
        const totalBytes = elemSize * numElems;
        if (totalBytes === 0 || elemSize === 0) return 0;
        const data = Mem.readBytes(bufPtr, totalBytes);
        if (!data) { stream.err = true; return 0; }
        // Note: bytes go out verbatim even in text mode (no LF→CRLF expansion),
        // mirroring the read side which only strips CRLF, never synthesizes it.
        const vfs = System.getInstance().fileSystem;
        const syncWritten = vfs.writeSync(stream.handle, data);
        if (syncWritten >= 0) {
            if (syncWritten < totalBytes) stream.err = true;
            return Math.floor(syncWritten / elemSize);
        }
        // Overlay not ready for a sync write — async thunk fallback (same split as fread).
        return (async (): Promise<ThunkResult> => {
            try {
                const written = await vfs.write(stream.handle, data);
                if (written < totalBytes) stream.err = true;
                return { value: Math.floor(written / elemSize) };
            } catch {
                stream.err = true;
                return { value: 0 };
            }
        })();
    }

    /**
     * fgets' byte loop as a resumable coroutine: it YIELDS to ask for the next byte and
     * is resumed with what was read (empty = genuine EOF). Two drivers pump the one loop —
     * a synchronous one, and an async continuation taken over the moment a byte is not
     * resident — so "not available synchronously" never has to masquerade as EOF, and
     * neither does the loop have to exist twice.
     */
    private *fgetsLoop(
        stream: MsvcrtFileStream,
        bufPtr: number,
        max: number,
        start: number,
    ): Generator<void, number, Uint8Array> {
        let i = start;
        while (i < max) {
            const data = yield;
            if (data.length === 0) { stream.eof = true; break; }
            let b = data[0];
            // Text mode: Ctrl-Z (0x1A) is the end-of-file marker.
            if (stream.text && b === 0x1a) { stream.eof = true; break; }
            // Text mode: collapse CRLF→LF (and drop a lone trailing \r before EOF).
            if (stream.text && b === 0x0d) {
                const peek = yield;
                if (peek.length === 1) {
                    if (peek[0] === 0x0a) { b = 0x0a; } // CRLF → emit LF only
                    else { stream.ungetChar = peek[0]; } // lone \r: keep \r, push back peeked byte
                } else { stream.eof = true; } // \r at EOF: emit the lone \r verbatim
            }
            Mem.writeUint8(bufPtr + i, b);
            i++;
            if (b === 0x0a) break; // include newline, stop
        }
        if (i === 0) return 0; // EOF/nothing read → NULL
        Mem.writeUint8(bufPtr + i, 0); // NUL terminate
        return bufPtr >>> 0;
    }

    private fgets(bufPtr: number, maxChars: number, filePtr: number): number | Promise<ThunkResult> {
        const stream = this.fileStreams.get(filePtr);
        if (!stream || !bufPtr) return 0;
        const n = maxChars | 0;
        if (n <= 0) return 0;
        if (n === 1) { Mem.writeUint8(bufPtr, 0); return bufPtr >>> 0; } // empty string, success
        const max = n - 1;
        const vfs = System.getInstance().fileSystem;
        let i = 0;
        // honor a pushed-back char (ungetc) first
        if (stream.ungetChar >= 0) {
            const c = stream.ungetChar & 0xff;
            stream.ungetChar = -1;
            Mem.writeUint8(bufPtr + i, c);
            i++;
            if (c === 0x0a) { Mem.writeUint8(bufPtr + i, 0); return bufPtr >>> 0; }
        }

        const loop = this.fgetsLoop(stream, bufPtr, max, i);
        // Explicit type: the `while (!step.done)` narrowing must not leak into the
        // closure below, which resumes the loop to completion.
        let step: IteratorResult<void, number> = loop.next(EMPTY_BYTES);
        while (!step.done) {
            const data = vfs.readSync(stream.handle, 1);
            if (data === null) {
                // Not resident — finish the SAME loop on the async thunk path.
                return (async (): Promise<ThunkResult> => {
                    let s: IteratorResult<void, number> = step;
                    try {
                        while (!s.done) s = loop.next(await vfs.read(stream.handle, 1));
                    } catch {
                        stream.err = true;
                        return { value: 0 };
                    }
                    return { value: s.value >>> 0 };
                })();
            }
            step = loop.next(data);
        }
        return step.value;
    }

    private ungetc(ch: number, filePtr: number): number {
        const stream = this.fileStreams.get(filePtr);
        if (!stream) return -1;            // EOF
        if ((ch | 0) === -1) return -1;    // EOF arg → no push-back (ISO C)
        // Buffered-getc push-back (faithful Borland): when the inline x86 getc stub is
        // draining the guest FILE buffer, the JS-side ungetChar field would be invisible
        // to it. So push the byte BACK INTO the guest buffer (curp--, level++, write it) —
        // exactly how the real CRT ungetc backs up curp — so the next getc serves it
        // whether it goes through the inline stub OR JS. Requires room before curp (always
        // true after a chunk fill, since curp = bufPtr+1; and at full drain curp = bufPtr+n).
        if (this.useRealFileStructs && stream.bufPtr !== undefined) {
            const curpOff = Msvcrt.BORLAND_FILE_CURP_OFF;
            const levelOff = Msvcrt.BORLAND_FILE_LEVEL_OFF;
            const curp = (Mem.readUint32(filePtr + curpOff) ?? 0) >>> 0;
            if (curp > stream.bufPtr) {
                const level = Mem.readInt32(filePtr + levelOff) ?? 0;
                Mem.writeUint8(curp - 1, ch & 0xff);
                Mem.writeUint32(filePtr + curpOff, curp - 1);
                Mem.writeUint32(filePtr + levelOff, (level + 1) | 0);
                stream.eof = false;
                return ch & 0xff;
            }
        }
        if (stream.ungetChar >= 0) return -1; // only one char of push-back guaranteed
        stream.ungetChar = ch & 0xff;
        stream.eof = false;                // ungetc clears EOF indicator
        return ch & 0xff;
    }

    private fputs(strPtr: number, filePtr: number): number {
        const stream = this.fileStreams.get(filePtr);
        if (!stream || !strPtr) return -1; // EOF
        this.flushGetcBuffer(filePtr, stream.handle);
        const bytes: number[] = [];
        for (let i = 0; i < 0x100000; i++) {
            const b = Mem.readUint8(strPtr + i);
            if (b === null || b === 0) break;
            bytes.push(b);
        }
        if (bytes.length === 0) return 0;
        const written = System.getInstance().fileSystem.writeSync(stream.handle, new Uint8Array(bytes));
        if (written < 0) { stream.err = true; return -1; }
        return written; // any non-negative value is success
    }

    private fseek(filePtr: number, offset: number, origin: number): number {
        const stream = this.fileStreams.get(filePtr);
        if (!stream) return -1;
        this.flushGetcBuffer(filePtr, stream.handle);
        const vfs = System.getInstance().fileSystem;
        vfs.setPosition(stream.handle, offset | 0, origin | 0);
        return 0;
    }

    private ftell(filePtr: number): number {
        const stream = this.fileStreams.get(filePtr);
        if (!stream) return -1;
        this.flushGetcBuffer(filePtr, stream.handle);
        return stream.handle.position | 0;
    }

    private feof_fn(filePtr: number): number {
        const stream = this.fileStreams.get(filePtr);
        if (!stream) return 1;
        this.flushGetcBuffer(filePtr, stream.handle);
        // Match MSVC: EOF flag is sticky once a read hits end-of-file (including text-mode
        // Ctrl-Z in fgets). Position alone is not sufficient — a file can be fully consumed
        // while eof is still clear until the next read attempt fails.
        if (stream.eof) return 1;
        const size = System.getInstance().fileSystem.getFileSize(stream.handle.path);
        return stream.handle.position >= size ? 1 : 0;
    }

    private ferror_fn(filePtr: number): number {
        const stream = this.fileStreams.get(filePtr);
        return stream?.err ? 1 : 0;
    }

    private clearerr_fn(filePtr: number): number {
        const stream = this.fileStreams.get(filePtr);
        if (stream) {
            stream.eof = false;
            stream.err = false;
        }
        return 0;
    }

    private fileno(filePtr: number): number {
        const stream = this.fileStreams.get(filePtr);
        return stream ? stream.fd : -1;
    }

    /** VFS backing for a kernel32 file handle, or null for console/non-VFS handles. */
    private vfsHandleFromWin32Handle(h: number): VfsFileHandle | null {
        const fileObj = System.getInstance().resourceProvider.getFileHandle(h);
        if (!fileObj) return null;
        // ConsoleDeviceHandle.vfsHandle throws — probe deviceType before the getter.
        if ("deviceType" in fileObj) return null;
        try {
            const vfs = (fileObj as { vfsHandle?: VfsFileHandle }).vfsHandle;
            return vfs ?? null;
        } catch {
            return null;
        }
    }

    private openOsfhandle(osfhandle: number, _flags: number): number {
        const h = osfhandle >>> 0;
        if (h === 0xffffffff) {
            this.setErrno(22);
            return -1;
        }
        const existing = this.handleFds.get(h);
        if (existing !== undefined) return existing;

        const vfsHandle = this.vfsHandleFromWin32Handle(h);
        if (vfsHandle) {
            const fd = this.nextFd();
            this.fds.set(fd, vfsHandle);
            this.fdHandles.set(fd, h);
            this.handleFds.set(h, fd);
            return fd;
        }

        const fd = this.nextFd();
        this.fdHandles.set(fd, h);
        this.handleFds.set(h, fd);
        return fd;
    }

    private getOsfhandle(fd: number): number {
        const mapped = this.fdHandles.get(fd);
        if (mapped !== undefined) return mapped >>> 0;
        if (!this.fds.has(fd)) {
            this.setErrno(9);
            return -1;
        }
        return 0xffffffff;
    }

    private fdopen(fd: number, modePtr: number): number {
        const handle = this.fds.get(fd);
        if (!handle) return 0;
        const mode = this.readCString(modePtr, 16);
        if (!mode) return 0;

        let filePtr: number;
        let structPtr: number | undefined;
        if (this.useRealFileStructs) {
            structPtr = this.malloc(Msvcrt.BORLAND_FILE_SIZE) >>> 0;
            if (structPtr) {
                this.memset(structPtr, 0, Msvcrt.BORLAND_FILE_SIZE);
                filePtr = structPtr;
            } else {
                filePtr = this.nextFilePtr;
                this.nextFilePtr += 4;
                structPtr = undefined;
            }
        } else {
            filePtr = this.nextFilePtr;
            this.nextFilePtr += 4;
        }
        const text = !mode.includes("b");
        this.fileStreams.set(filePtr, { fd, handle, ungetChar: -1, text, eof: false, err: false, structPtr });
        return filePtr >>> 0;
    }

    private rewind_fn(filePtr: number): number {
        const stream = this.fileStreams.get(filePtr);
        if (!stream) return 0;
        this.flushGetcBuffer(filePtr, stream.handle);
        stream.handle.position = 0;
        return 0;
    }

    // fgetpos(FILE*, fpos_t*) — fpos_t is a 32-bit value on MSVC (long long on newer, but 32-bit games use 32-bit)
    private fgetpos(filePtr: number, posPtr: number): number {
        const stream = this.fileStreams.get(filePtr);
        if (!stream || !posPtr) return -1;
        const pos = stream.handle.position | 0;
        Mem.writeUint32(posPtr, pos);
        return 0;
    }

    // fsetpos(FILE*, const fpos_t*)
    private fsetpos(filePtr: number, posPtr: number): number {
        const stream = this.fileStreams.get(filePtr);
        if (!stream || !posPtr) return -1;
        const pos = Mem.readUint32(posPtr) ?? 0;
        stream.handle.position = pos;
        return 0;
    }

    private fgetc(filePtr: number): number | Promise<ThunkResult> {
        const stream = this.fileStreams.get(filePtr);
        if (!stream) return -1; // EOF
        if (stream.ungetChar >= 0) {
            const ch = stream.ungetChar;
            stream.ungetChar = -1;
            return ch;
        }
        const vfs = System.getInstance().fileSystem;

        // Buffered fast path for CRTs that inline getc (Borland/Watcom). The guest's
        // getc macro reads FILE->level(+0)/curp(+20) directly; we refill a CHUNK into a
        // guest buffer and point curp/level at it, so the guest then reads bytes
        // straight from memory with no trap until the chunk drains. One trap per chunk
        // instead of per byte — the difference between a multi-minute and a sub-second
        // decompression. Works over a sync (BufferSource) or async (BlobSource) VFS.
        if (Msvcrt.BUFFERED_GETC && this.useRealFileStructs && stream.structPtr !== undefined) {
            const levelOff = Msvcrt.BORLAND_FILE_LEVEL_OFF;
            const curpOff = Msvcrt.BORLAND_FILE_CURP_OFF;
            // Guest called us with bytes still buffered (rare) — serve one inline.
            const lvl = Mem.readInt32(filePtr + levelOff) ?? 0;
            if (lvl > 0) {
                const curp = (Mem.readUint32(filePtr + curpOff) ?? 0) >>> 0;
                const b = Mem.readUint8(curp) ?? -1;
                Mem.writeUint32(filePtr + curpOff, curp + 1);
                Mem.writeUint32(filePtr + levelOff, (lvl - 1) | 0);
                return b;
            }
            if (stream.bufPtr === undefined) {
                stream.bufPtr = this.malloc(Msvcrt.GETC_CHUNK) >>> 0;
            }
            const bufPtr = stream.bufPtr;
            if (bufPtr) {
                const fillFromChunk = (n: number): number => {
                    if (n <= 0) return -1; // EOF
                    Mem.writeUint32(filePtr + curpOff, bufPtr + 1); // curp → second byte
                    Mem.writeUint32(filePtr + levelOff, (n - 1) | 0);      // level → remaining
                    return Mem.readUint8(bufPtr) ?? -1;             // return first byte
                };
                const view = Mem.getView();
                const sync = view ? vfs.readIntoSync(stream.handle, view, bufPtr, Msvcrt.GETC_CHUNK) : null;
                if (sync !== null) return fillFromChunk(sync);
                return (async (): Promise<ThunkResult> => {
                    const m = Mem.getView();
                    if (!m) return { value: 0xffffffff };
                    try {
                        const n = await vfs.readInto(stream.handle, m, bufPtr, Msvcrt.GETC_CHUNK);
                        return { value: fillFromChunk(n) >>> 0 };
                    } catch { return { value: 0xffffffff }; }
                })();
            }
            // malloc failed — fall through to single-byte read below.
        }

        const data = vfs.readSync(stream.handle, 1);
        // null is "not resident — await it", NOT end of file. Collapsing the two reports
        // EOF on the first cold block of a streamed bundle.
        if (data === null) {
            return (async (): Promise<ThunkResult> => {
                try {
                    const d = await vfs.read(stream.handle, 1);
                    if (d.length === 0) { stream.eof = true; return { value: 0xffffffff }; }
                    return { value: d[0] };
                } catch {
                    stream.eof = true;
                    return { value: 0xffffffff };
                }
            })();
        }
        if (data.length === 0) { stream.eof = true; return -1; } // EOF
        return data[0];
    }

    private fputc(ch: number, filePtr: number): number {
        const stream = this.fileStreams.get(filePtr);
        if (!stream) return -1;
        this.flushGetcBuffer(filePtr, stream.handle);
        const written = System.getInstance().fileSystem.writeSync(
            stream.handle, new Uint8Array([ch & 0xff]));
        if (written < 1) { stream.err = true; return -1; } // EOF
        return ch & 0xff;
    }

    private fprintf(args: number[]): number {
        const filePtr = args[0] ?? 0;
        const fmtPtr = args[1] ?? 0;
        const stream = this.fileStreams.get(filePtr);
        if (!stream || !fmtPtr) return -1;
        const format = this.readCString(fmtPtr, 0x100000);
        const reader = new ArrayVaListReader(args, 2);
        const text = formatCLazy(format, reader, (addr, maxLen) => this.readCString(addr, maxLen));
        this.flushGetcBuffer(filePtr, stream.handle);
        const written = System.getInstance().fileSystem.writeSync(stream.handle, encodeAnsi(text));
        if (written < 0) { stream.err = true; return -1; }
        return text.length;
    }

    // ==================== Character classification ====================

    private ischartype(ch: number, mask: number): number {
        const flags = this.computeCtypeFlags(ch & 0xff);
        return (flags & mask) !== 0 ? 1 : 0;
    }

    private iswctype(ch: number, mask: number): number {
        const code = ch & 0xffff;
        if (code > 0xff) return 0;
        const flags = this.computeCtypeFlags(code);
        return (flags & mask) !== 0 ? 1 : 0;
    }

    private isprint(ch: number): number {
        const c = ch & 0xff;
        return (c >= 0x20 && c <= 0x7e) ? 1 : 0;
    }

    // ==================== Memory (new) ====================

    private msize(ptr: number): number {
        if (!ptr) return 0;
        // Slab block first (malloc/operator new served by the shared WASM arena),
        // then the JS-tracked allocation size. Mirrors kernel32 HeapSize.
        const slabSize = getSlabSizeForPtr(ptr >>> 0);
        if (slabSize !== undefined) return slabSize;
        const tracked = this.crtAllocations.get(ptr >>> 0);
        if (tracked !== undefined) return tracked >>> 0;
        return 0;
    }

    private u32PairToDouble(lo: number, hi: number): number {
        const buf = new ArrayBuffer(8);
        const u32 = new Uint32Array(buf);
        const f64 = new Float64Array(buf);
        u32[0] = lo >>> 0;
        u32[1] = hi >>> 0;
        return f64[0];
    }

}

/**
 * Register fast-path implementations for high-frequency CRT string functions.
 * _wcsnicmp: ~49K calls (188ms) in UT99 demo — inline wide string compare.
 */
export function registerFastPathMsvcrtFunctions(dispatcher: any): void {
    if (!dispatcher || typeof dispatcher.registerFastPath !== 'function') return;

    // =========================================================================
    // _wcsnicmp fast path — 49K calls, 188ms
    // cdecl: args on stack, caller cleans up
    // =========================================================================
    const fastPathWcsnicmp = (cpu: any, mem8: Uint8Array): number | null => {
        const esp = cpu.reg32[4];
        if (esp + 16 > mem8.length) return null;
        const view = new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);

        // Stack layout (cdecl):
        // esp + 0  = return address
        // esp + 4  = str1 (const wchar_t*)
        // esp + 8  = str2 (const wchar_t*)
        // esp + 12 = count (size_t)
        const aPtr = view.getUint32(esp + 4, true);
        const bPtr = view.getUint32(esp + 8, true);
        const count = view.getUint32(esp + 12, true);

        if (!aPtr || !bPtr) return null; // near-null pointers, fallthrough for diagnostics

        const memLen = mem8.length - 1;
        const limit = count > 0 ? count : 0x10000;

        for (let i = 0; i < limit; i++) {
            const aOff = aPtr + i * 2;
            const bOff = bPtr + i * 2;
            if (aOff >= memLen || bOff >= memLen) return 0;
            let ac = mem8[aOff] | (mem8[aOff + 1] << 8);
            let bc = mem8[bOff] | (mem8[bOff + 1] << 8);
            // Case-insensitive: ASCII uppercase to lowercase
            if (ac >= 0x41 && ac <= 0x5a) ac += 0x20;
            if (bc >= 0x41 && bc <= 0x5a) bc += 0x20;
            if (ac !== bc) return (ac - bc) | 0;
            if (ac === 0) return 0;
        }
        return 0;
    };

    dispatcher.registerFastPath('msvcrt', '_wcsnicmp', fastPathWcsnicmp);
    dispatcher.registerFastPath('crtdll', '_wcsnicmp', fastPathWcsnicmp);
    dispatcher.registerFastPath('msvcr90', '_wcsnicmp', fastPathWcsnicmp);

    // =========================================================================
    // type_info::name() fast path — ?name@type_info@@QBEPBDXZ (thiscall, this=ECX)
    // RTTI-heavy titles hammer this: Max Payne in-game issues ~24K calls/s (~10% of
    // all slow-path OUT traps). Real type_info::name() lazily demangles the decorated
    // name (at this+8) on the FIRST call per type and caches the resulting undecorated
    // string pointer in _M_data (this+4); every later call is just `return [this+4]`.
    // We fast-path ONLY that cache hit. A zero cache (cold, once per type) returns null
    // → falls through to the slow JS thunk (see exports['?name@type_info@@QBEPBDXZ'])
    // which demangles + allocs + populates the cache, so the demangle logic lives in
    // exactly one place and only cold calls pay for it.
    // =========================================================================
    const fastPathTypeInfoName = (cpu: any, mem8: Uint8Array, _m32: Uint32Array, view: DataView): number | null => {
        const self = cpu.reg32[1] >>> 0; // ECX = thiscall `this`
        if (!self || self + 8 > mem8.length) return null;
        const cached = view.getUint32(self + 4, true) >>> 0;
        return cached !== 0 ? cached : null; // hit → return cached ptr; miss → slow thunk
    };
    dispatcher.registerFastPath('msvcrt', '?name@type_info@@QBEPBDXZ', fastPathTypeInfoName, { trivial: true });
    dispatcher.registerFastPath('crtdll', '?name@type_info@@QBEPBDXZ', fastPathTypeInfoName, { trivial: true });
    dispatcher.registerFastPath('msvcr90', '?name@type_info@@QBEPBDXZ', fastPathTypeInfoName, { trivial: true });

    // =========================================================================
    // _ftol fast path — JS fallback for when WASM hypercall falls through.
    // cdecl: no stack args, reads ST(0) from FPU, pops, returns int32.
    // =========================================================================
    let cachedWasmBuf: ArrayBuffer | null = null;
    let cachedWasmDv: DataView | null = null;

    const fastPathFtol = (cpu: any): number | null => {
        if (typeof cpu.fpu_get_sti_f64 !== 'function') return null;
        const value = cpu.fpu_get_sti_f64(0);

        // Pop FPU stack directly in WASM memory
        const buf = cpu.wasm_memory?.buffer;
        if (!buf || buf.byteLength === 0) return null;
        if (buf !== cachedWasmBuf) {
            cachedWasmBuf = buf;
            cachedWasmDv = new DataView(buf);
        }
        const dv = cachedWasmDv!;
        const oldTop = dv.getUint8(1032) & 7;  // FPU_STACK_PTR_OFFSET
        dv.setUint8(816, dv.getUint8(816) | (1 << oldTop));  // mark old top as empty
        dv.setUint8(1032, (oldTop + 1) & 7);  // advance stack pointer

        // _ftol returns a full __int64 in EDX:EAX (truncate toward zero). Returning only a clamped
        // int32 broke 64-bit users (e.g. UE1's `now = _ftol(seconds*2^32)` → frozen DeltaTime). Set
        // the high dword in EDX (reg32[2]) directly; return the low dword as EAX.
        const v = Math.trunc(value);
        const hi = Math.floor(v / 4294967296);
        const reg = cpu.reg32;
        if (reg) reg[2] = hi | 0;            // EDX = high 32
        return (v >>> 0) | 0;                // EAX = low 32
    };

    dispatcher.registerFastPath('msvcrt', '_ftol', fastPathFtol);
    dispatcher.registerFastPath('crtdll', '_ftol', fastPathFtol);
    dispatcher.registerFastPath('msvcr90', '_ftol', fastPathFtol);
}
