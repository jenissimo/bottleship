/**
 * VC9 (msvcr90) CRT ABI helpers — Stage A thin/fail-soft handlers.
 */

import { ThunkImplementation, ThunkResult } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import { ensureSrwWaitEvent, releaseSrwExclusive, tryAcquireSrwExclusive } from "./kernel32/srw-lock";
import { VaListReader, formatCLazy } from "./crt-format";
import { fpuGetST, fpuPop, fpuSetST0 } from "../core/fpu-helper";
import { getCPU } from "../core/thunking/thunk-utils";
import type { Process } from "../core/process";

export interface Vc9CrtHost {
    process: Process;
    initterm(pfbegin: number, pfend: number): ThunkResult;
    malloc(size: number): number;
    free(ptr: number): number;
    controlfp(newVal: number, mask: number): number;
    readCString(ptr: number, maxLen?: number): string;
    writeCString(ptr: number, value: string): void;
    readWString(ptr: number, maxChars: number): string;
    setErrno(code: number): boolean;
    exitProcess(code: number): ThunkResult;
    terminateProcess(code: number, reason: string): ThunkResult;
    getcwd(buffer: number, maxLen: number): number;
    snprintf(args: number[]): number;
    vsnprintf(dest: number, max: number, fmt: number, va: number): number;
    strncpy(dest: number, src: number, count: number): number;
    strncat(dest: number, src: number, count: number): number;
    memmove(dest: number, src: number, count: number): number;
    sprintf(args: number[]): number;
    computeCtypeFlags(ch: number): number;
    ischartype(ch: number, mask: number): number;
}

/** Synthetic guest addresses for MSVC CRT _lock/_unlock file numbers. */
const CRT_LOCK_BASE = 0xE0000000;

export function registerVc9AbiExports(exports: Record<string, ThunkImplementation>, host: Vc9CrtHost): void {
    const invalidParam = () => {
        /* _invalid_parameter_noinfo */
    };

    exports["_initterm_e"] = (_ctx, _mem, args) => host.initterm(args[0] ?? 0, args[1] ?? 0);
    exports["_cexit"] = () => 0;
    exports["_crt_debugger_hook"] = () => 0;
    exports["_invalid_parameter_noinfo"] = () => {
        invalidParam();
        return 0;
    };
    exports["_amsg_exit"] = (_ctx, _mem, args) => host.exitProcess(args[0] ?? 0);
    exports["_invoke_watson"] = () => host.terminateProcess(0xc0000417, "msvcrt: _invoke_watson");
    exports["_configthreadlocale"] = () => 0;
    exports["_encode_pointer"] = (_ctx, _mem, args) => (args[0] ?? 0) >>> 0;
    exports["_decode_pointer"] = (_ctx, _mem, args) => (args[0] ?? 0) >>> 0;
    exports["_malloc_crt"] = (_ctx, _mem, args) => host.malloc(args[0] ?? 0);
    // EXCEPTION_CONTINUE_SEARCH — let outer handlers run.
    exports["__CppXcptFilter"] = () => 0;
    exports["__clean_type_info_names_internal"] = () => 0;
    exports["_lock"] = (ctx, mem, args): number | ThunkResult => {
        const lockPtr = (CRT_LOCK_BASE + (args[0] ?? 0)) >>> 0;
        const sched = System.getInstance().scheduler;
        const tid = sched.getCurrentThreadId();
        if (tryAcquireSrwExclusive(lockPtr, tid)) return 0;

        const waitEvent = ensureSrwWaitEvent(lockPtr, sched);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const returnAddr = view.getUint32(ctx.esp, true);
        sched.enterSrwLockWithContext(
            lockPtr,
            true,
            waitEvent,
            returnAddr,
            ctx.esp + 8,
            { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags },
        );
        return { value: 0, blockedNoSwitch: true, stackCleanup: 4 };
    };
    exports["_unlock"] = (_ctx, _mem, args) => {
        const lockPtr = (CRT_LOCK_BASE + (args[0] ?? 0)) >>> 0;
        const sched = System.getInstance().scheduler;
        const wakeEvent = releaseSrwExclusive(lockPtr, sched.getCurrentThreadId());
        if (wakeEvent && sched.hasWaitersForHandle(wakeEvent)) {
            sched.setEvent(wakeEvent);
        }
        return 0;
    };
    exports["??_V@YAXPAX@Z"] = (_ctx, _mem, args) => host.free(args[0] ?? 0);

    // _except_handler4_common — registered by crt-vc9-seh.ts (semantic)

    exports["_CIatan"] = () => {
        try {
            const x = fpuGetST(host.process.v86, 0);
            fpuSetST0(host.process.v86, Math.atan(x));
            fpuPop(host.process.v86);
            return 0;
        } catch {
            return 0;
        }
    };

    exports["_controlfp_s"] = (_ctx, mem, args) => {
        const currentOut = args[0] ?? 0;
        const newVal = args[1] ?? 0;
        const mask = args[2] ?? 0;
        const old = host.controlfp(newVal, mask);
        if (currentOut) Mem.writeUint32(currentOut, old >>> 0);
        return 0;
    };

    exports["memchr"] = (_ctx, mem, args) => {
        const ptr = args[0] ?? 0;
        const ch = (args[1] ?? 0) & 0xff;
        const count = args[2] ?? 0;
        if (!ptr || count === 0 || !mem) return 0;
        const end = Math.min(ptr + count, mem.length);
        for (let i = ptr; i < end; i++) {
            if (mem[i] === ch) return i >>> 0;
        }
        return 0;
    };

    exports["strcspn"] = (_ctx, _mem, args) => {
        const s = args[0] ?? 0;
        const reject = args[1] ?? 0;
        if (!s || !reject) return 0;
        const str = host.readCString(s, 0x10000);
        const rej = host.readCString(reject, 256);
        const rejSet = new Set(rej.split(""));
        let n = 0;
        for (; n < str.length && str.charCodeAt(n) !== 0; n++) {
            if (rejSet.has(str[n]!)) break;
        }
        return n;
    };

    exports["strspn"] = (_ctx, _mem, args) => {
        const s = args[0] ?? 0;
        const accept = args[1] ?? 0;
        if (!s || !accept) return 0;
        const str = host.readCString(s, 0x10000);
        const accSet = new Set(host.readCString(accept, 256).split(""));
        let n = 0;
        for (; n < str.length; n++) {
            if (!accSet.has(str[n]!)) break;
        }
        return n;
    };

    exports["_ismbblead"] = (_ctx, _mem, args) => {
        const c = args[0] ?? 0;
        return c >= 0x80 && c <= 0xff ? 1 : 0;
    };

    exports["iswspace"] = (_ctx, _mem, args) => host.ischartype(args[0] ?? 0, 0x0008);

    exports["iswctype"] = (_ctx, _mem, args) => {
        const ch = args[0] ?? 0;
        const mask = args[1] ?? 0;
        return (host.computeCtypeFlags(ch & 0xffff) & mask) !== 0 ? 1 : 0;
    };

    exports["strncpy_s"] = (_ctx, _mem, args) => {
        const dest = args[0] ?? 0;
        const destSize = args[1] ?? 0;
        const src = args[2] ?? 0;
        const count = args[3] ?? 0;
        if (!dest || destSize === 0) { invalidParam(); return 22; }
        if (count >= destSize) { invalidParam(); return 22; }
        return host.strncpy(dest, src, count);
    };

    exports["strncat_s"] = (_ctx, _mem, args) => {
        const dest = args[0] ?? 0;
        const destSize = args[1] ?? 0;
        const src = args[2] ?? 0;
        const count = args[3] ?? 0;
        if (!dest || destSize === 0) { invalidParam(); return 22; }
        const existing = host.readCString(dest, destSize).length;
        if (existing + count >= destSize) { invalidParam(); return 22; }
        return host.strncat(dest, src, count);
    };

    exports["memmove_s"] = (_ctx, _mem, args) => {
        const dest = args[0] ?? 0;
        const destSize = args[1] ?? 0;
        const src = args[2] ?? 0;
        const count = args[3] ?? 0;
        if (count > destSize) { invalidParam(); return 22; }
        host.memmove(dest, src, count);
        return 0;
    };

    exports["sprintf_s"] = (_ctx, _mem, args) => host.snprintf(args);
    exports["_snprintf_s"] = (_ctx, _mem, args) => host.snprintf(args);

    exports["vfprintf"] = (_ctx, _mem, args) => {
        const filePtr = args[0] ?? 0;
        const fmtPtr = args[1] ?? 0;
        const vaPtr = args[2] ?? 0;
        if (!filePtr || !fmtPtr) return -1;
        const format = host.readCString(fmtPtr, 0x100000);
        const reader = new VaListReader(vaPtr);
        const text = formatCLazy(format, reader, (addr, maxLen) => host.readCString(addr, maxLen));
        Logger.verbose(LogCategory.SYSTEM, `[CRT] vfprintf: ${text.slice(0, 200)}`);
        return text.length;
    };

    exports["setbuf"] = () => 0;

    exports["_getdrive"] = () => 3;

    let umaskVal = 0;
    exports["_umask"] = (_ctx, _mem, args) => {
        const prev = umaskVal;
        umaskVal = args[0] ?? 0;
        return prev;
    };

    exports["_getdcwd"] = (_ctx, _mem, args) => {
        const drive = args[0] ?? 0;
        const buffer = args[1] ?? 0;
        const maxLen = args[2] ?? 0;
        if (drive !== 0 && drive !== 3) {
            host.setErrno(2);
            return 0;
        }
        // Drive qualification and the buffer==NULL allocation size both live in getcwd, so
        // the two forms cannot diverge (they did while the fix-up lived here: it could only
        // reach the caller-supplied-buffer form).
        return host.getcwd(buffer, maxLen);
    };

    // C++ exception / type_info — minimal no-op stubs (Stage A)
    const exceptionCtorFromCStr = (_ctx: unknown, _mem: unknown, args: number[]) => {
        const cpu = getCPU(host.process.v86);
        const thisPtr = cpu?.reg32?.[1] ?? 0; // ECX = this
        const msgRef = args[0] ?? 0;
        const msgPtr = msgRef ? (Mem.readUint32(msgRef) ?? 0) : 0;
        if (thisPtr) Mem.writeUint32(thisPtr + 4, msgPtr >>> 0);
        return thisPtr >>> 0;
    };
    const exceptionCopyCtor = (_ctx: unknown, _mem: unknown, args: number[]) => {
        const cpu = getCPU(host.process.v86);
        const thisPtr = cpu?.reg32?.[1] ?? 0;
        const src = args[0] ?? 0;
        if (thisPtr && src) {
            Mem.writeUint32(thisPtr + 4, Mem.readUint32(src + 4) ?? 0);
        }
        return thisPtr >>> 0;
    };

    exports["??0exception@std@@QAE@XZ"] = () => 0;
    exports["??0exception@std@@QAE@ABQBD@Z"] = exceptionCtorFromCStr;
    exports["??0exception@std@@QAE@ABV01@@Z"] = exceptionCopyCtor;
    exports["??1exception@std@@UAE@XZ"] = () => 0;
    exports["??0exception@@QAE@ABQBD@Z"] = exceptionCtorFromCStr;
    exports["??0exception@@QAE@ABV0@@Z"] = exceptionCopyCtor;
    exports["??1exception@@UAE@XZ"] = () => 0;
    exports["?what@exception@std@@UBEPBDXZ"] = () => {
        const cpu = getCPU(host.process.v86);
        const thisPtr = cpu?.reg32?.[1] ?? 0;
        return thisPtr ? (Mem.readUint32(thisPtr + 4) ?? 0) : 0;
    };
    exports["?_type_info_dtor_internal_method@type_info@@QAEXXZ"] = () => 0;

}
