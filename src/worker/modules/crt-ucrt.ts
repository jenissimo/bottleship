/**
 * The MSVC 2015+ (UCRT / vcruntime140) CRT ABI.
 *
 * VS2015 split the C runtime into `api-ms-win-crt-<area>-l1-1-0.dll` forwarders over
 * `ucrtbase.dll`, plus `vcruntime140.dll` for the compiler-support half. Most of that
 * surface kept its C names and shapes and is already served by this module; what
 * follows is only the entry points whose SHAPE changed, plus the few genuinely new
 * ones. Every import name in the family resolves here through dll-aliases.
 *
 * The two shape changes worth knowing:
 *  - the printf/scanf family collapsed into `__stdio_common_v*` taking a 64-bit
 *    options word (TWO stack slots in a cdecl frame) and an explicit locale;
 *  - atexit moved to a CALLER-owned `_onexit_table_t`, so the CRT no longer owns the
 *    list and each module carries its own.
 */

import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { VaListReader, ArrayVaListReader, encodeAnsi, formatCLazy } from "./crt-format";
import { scanfCore } from "./crt-scanf";
import { invokeGuestVoidChain } from "./crt-callback-chain";
import type { ThunkImplementation, ThunkResult } from "../core/thunking/thunk-dispatcher";
import type { Process } from "../core/process";

export interface UcrtHost {
    process: Process;
    free(ptr: number): number;
    realloc(ptr: number, size: number): number;
    calloc(num: number, size: number): number;
    msize(ptr: number): number;
    memset(dest: number, ch: number, count: number): number;
    strdup(ptr: number): number;
    readCString(ptr: number, maxLen: number): string;
    readWString(ptr: number, maxChars: number): string;
    formatWide(format: string, reader: VaListReader | ArrayVaListReader): string;
    setErrno(code: number): boolean;
    terminateProcess(code: number, reason: string): ThunkResult;
    /** End the process from inside a callback chain's completion: park, never resume. */
    endProcessAfterChain(code: number): null;
    setAppType(type: number): number;
    registerExitHandler(fn: number): boolean;
    /** FILE* for stdin(0)/stdout(1)/stderr(2) — the `_iob` array this module owns. */
    stdioFile(index: number): number;
    /** Which of the three standard streams `filePtr` is, or -1. */
    stdStreamIndex(filePtr: number): number;
    vfprintf(filePtr: number, fmtPtr: number, vaListPtr: number): number;
    /** Guest address of the CRT's `int _fmode`. */
    fmodeAddr(): number;
    /** Guest address of the CRT's copy of the command line (`_acmdln`). */
    commandLineAddr(): number;
    newHandler(): number;
    setNewMode(mode: number): number;
}

/** corecrt_stdio_config.h. The high half of the options word carries nothing. */
const PRINTF_LEGACY_VSPRINTF_NULL_TERMINATION = 0x0001;
const PRINTF_STANDARD_SNPRINTF_BEHAVIOR = 0x0002;
const PRINTF_LEGACY_WIDE_SPECIFIERS = 0x0004;
const PRINTF_LEGACY_MSVCRT_COMPATIBILITY = 0x0008;
const PRINTF_LEGACY_THREE_DIGIT_EXPONENTS = 0x0010;
const PRINTF_STANDARD_ROUNDING = 0x0020;
const PRINTF_KNOWN_OPTIONS =
    PRINTF_LEGACY_VSPRINTF_NULL_TERMINATION | PRINTF_STANDARD_SNPRINTF_BEHAVIOR
    | PRINTF_LEGACY_WIDE_SPECIFIERS | PRINTF_LEGACY_MSVCRT_COMPATIBILITY
    | PRINTF_LEGACY_THREE_DIGIT_EXPONENTS | PRINTF_STANDARD_ROUNDING;

const SCANF_SECURECRT = 0x0001;
const SCANF_LEGACY_WIDE_SPECIFIERS = 0x0002;
const SCANF_LEGACY_MSVCRT_COMPATIBILITY = 0x0004;
const SCANF_KNOWN_OPTIONS =
    SCANF_SECURECRT | SCANF_LEGACY_WIDE_SPECIFIERS | SCANF_LEGACY_MSVCRT_COMPATIBILITY;

const MAX_FORMAT_CHARS = 0x100000;
const MAX_WIDE_CHARS = 0x10000;

/** `_onexit_table_t { _PVFV *_first, *_last, *_end; }` — caller-allocated, 12 bytes. */
const ONEXIT_FIRST = 0;
const ONEXIT_LAST = 4;
const ONEXIT_END = 8;
/** The UCRT's own initial capacity, in function pointers. */
const ONEXIT_INITIAL_SLOTS = 32;

/** `struct __std_exception_data { char const *_What; bool _DoFree; }`. */
const EXCEPTION_DATA_WHAT = 0;
const EXCEPTION_DATA_DOFREE = 4;

/** errno values used below (errno.h). */
const EACCES = 13;
const EINVAL = 22;
const ENOMEM = 12;

const EXCEPTION_CONTINUE_SEARCH = 0;

/** Rebuild a 64-bit options word from its two cdecl stack slots. Only the low 32 bits
 *  carry flags; the high half is reported so an unknown one is not silently dropped. */
function optionsOf(args: number[], warnTag: string, known: number): number {
    const lo = (args[0] ?? 0) >>> 0;
    const hi = (args[1] ?? 0) >>> 0;
    if (hi !== 0 || (lo & ~known) !== 0) {
        Logger.warn(LogCategory.SYSTEM,
            `${warnTag}: unhandled options 0x${hi.toString(16)}${lo.toString(16).padStart(8, "0")}`);
    }
    return lo;
}

export function registerUcrtExports(exports: Record<string, ThunkImplementation>, host: UcrtHost): void {
    const readFormat = (ptr: number) => host.readCString(ptr, MAX_FORMAT_CHARS);
    const readCString = (addr: number, maxLen: number) => host.readCString(addr, maxLen);

    // ==================== stdio: the __stdio_common_v* family ====================

    /**
     * The shared tail of __stdio_common_vsprintf/vswprintf. `units` is the formatted
     * body in characters (bytes for narrow, UTF-16 units for wide) and `write` puts a
     * prefix of it plus its terminator into the buffer. Return semantics are the UCRT's:
     * the UNTRUNCATED length on success, -1 under legacy vsprintf termination when it
     * did not fit, and -2 for a truncated standard snprintf that was not asked for
     * C99 behaviour.
     */
    const finishBufferedPrintf = (
        buffer: number, len: number, options: number, produced: number,
        write: (count: number, terminate: boolean) => void,
        terminateAt: (index: number) => void,
    ): number => {
        if (!buffer) return produced;
        const room = Math.min(produced, len);
        write(room, room < len);
        if (options & PRINTF_LEGACY_VSPRINTF_NULL_TERMINATION) return produced > len ? -1 : produced;
        if (produced >= len) {
            if (len > 0) terminateAt(len - 1);
            if (options & PRINTF_STANDARD_SNPRINTF_BEHAVIOR) return produced;
            return len > 0 ? -2 : -1;
        }
        return produced;
    };

    exports["__stdio_common_vsprintf"] = (_ctx, _mem, args) => {
        const options = optionsOf(args, "__stdio_common_vsprintf", PRINTF_KNOWN_OPTIONS);
        const buffer = (args[2] ?? 0) >>> 0;
        const len = (args[3] ?? 0) >>> 0;
        const formatPtr = (args[4] ?? 0) >>> 0;
        const argList = (args[6] ?? 0) >>> 0;
        if (!formatPtr) { host.setErrno(EINVAL); return -1; }
        const bytes = encodeAnsi(formatCLazy(readFormat(formatPtr), new VaListReader(argList), readCString));
        return finishBufferedPrintf(
            buffer, len, options, bytes.length,
            (count, terminate) => {
                if (count > 0) Mem.writeBytes(buffer, bytes.subarray(0, count));
                if (terminate) Mem.writeUint8(buffer + count, 0);
            },
            (index) => Mem.writeUint8(buffer + index, 0),
        );
    };

    exports["__stdio_common_vswprintf"] = (_ctx, _mem, args) => {
        const options = optionsOf(args, "__stdio_common_vswprintf", PRINTF_KNOWN_OPTIONS);
        const buffer = (args[2] ?? 0) >>> 0;
        const len = (args[3] ?? 0) >>> 0;
        const formatPtr = (args[4] ?? 0) >>> 0;
        const argList = (args[6] ?? 0) >>> 0;
        if (!formatPtr) { host.setErrno(EINVAL); return -1; }
        const text = host.formatWide(host.readWString(formatPtr, MAX_WIDE_CHARS), new VaListReader(argList));
        return finishBufferedPrintf(
            buffer, len, options, text.length,
            (count, terminate) => {
                for (let i = 0; i < count; i++) Mem.writeUint16(buffer + i * 2, text.charCodeAt(i));
                if (terminate) Mem.writeUint16(buffer + count * 2, 0);
            },
            (index) => Mem.writeUint16(buffer + index * 2, 0),
        );
    };

    exports["__stdio_common_vfprintf"] = (_ctx, _mem, args) => {
        optionsOf(args, "__stdio_common_vfprintf", PRINTF_KNOWN_OPTIONS);
        const stream = (args[2] ?? 0) >>> 0;
        const formatPtr = (args[3] ?? 0) >>> 0;
        const argList = (args[5] ?? 0) >>> 0;
        if (!stream || !formatPtr) { host.setErrno(EINVAL); return -1; }
        const std = host.stdStreamIndex(stream);
        if (std >= 0) {
            const text = formatCLazy(readFormat(formatPtr), new VaListReader(argList), readCString);
            Logger.log(LogCategory.SYSTEM, `crt:${std === 2 ? "stderr" : "stdout"}: ${text.replace(/\r?\n$/, "")}`);
            return encodeAnsi(text).length;
        }
        return host.vfprintf(stream, formatPtr, argList);
    };

    /** The shared body of __stdio_common_vsscanf/vswscanf. */
    const commonScanf = (input: string, formatPtr: number, wide: boolean, argList: number): number => {
        const format = wide ? host.readWString(formatPtr, MAX_WIDE_CHARS) : readFormat(formatPtr);
        // scanfCore takes its assignment targets from an argument ARRAY; a va_list is a
        // pointer to the same slots, so walk it into one rather than fork the parser.
        const reader = new VaListReader(argList);
        const slots: number[] = [];
        const maxSlots = countScanfConversions(format);
        for (let i = 0; i < maxSlots; i++) slots.push(reader.nextUint32() >>> 0);
        const { assigned, eof } = scanfCore(input, format, slots, 0);
        return eof && assigned === 0 ? -1 : assigned;
    };

    exports["__stdio_common_vsscanf"] = (_ctx, _mem, args) => {
        optionsOf(args, "__stdio_common_vsscanf", SCANF_KNOWN_OPTIONS);
        const inputPtr = (args[2] ?? 0) >>> 0;
        const formatPtr = (args[4] ?? 0) >>> 0;
        const argList = (args[6] ?? 0) >>> 0;
        if (!inputPtr || !formatPtr) { host.setErrno(EINVAL); return -1; }
        return commonScanf(readFormat(inputPtr), formatPtr, false, argList);
    };

    exports["__stdio_common_vswscanf"] = (_ctx, _mem, args) => {
        optionsOf(args, "__stdio_common_vswscanf", SCANF_KNOWN_OPTIONS);
        const inputPtr = (args[2] ?? 0) >>> 0;
        const formatPtr = (args[4] ?? 0) >>> 0;
        const argList = (args[6] ?? 0) >>> 0;
        if (!inputPtr || !formatPtr) { host.setErrno(EINVAL); return -1; }
        return commonScanf(host.readWString(inputPtr, MAX_WIDE_CHARS), formatPtr, true, argList);
    };

    // The `_iob` array is opaque in the UCRT: a FILE* is only ever obtained through
    // this accessor, which is why the array's stride stopped being part of the ABI.
    exports["__acrt_iob_func"] = (_ctx, _mem, args) => host.stdioFile((args[0] ?? 0) >>> 0);

    exports["_set_fmode"] = (_ctx, _mem, args) => {
        const mode = (args[0] ?? 0) | 0;
        // _O_TEXT (0x4000) and _O_BINARY (0x8000) are the only legal values.
        if (mode !== 0x4000 && mode !== 0x8000) { host.setErrno(EINVAL); return EINVAL; }
        Mem.writeUint32(host.fmodeAddr(), mode >>> 0);
        return 0;
    };

    // ==================== runtime: startup and shutdown ====================

    // The narrow argv/environment are built eagerly by this module at process setup, so
    // both configure calls are already satisfied when the CRT startup code asks.
    exports["_configure_narrow_argv"] = () => 0;
    exports["_initialize_narrow_environment"] = () => 0;
    exports["_set_app_type"] = (_ctx, _mem, args) => host.setAppType((args[0] ?? 0) | 0);
    /** All cleanup happens on DLL detach; _c_exit returns to its caller. */
    exports["_c_exit"] = () => 0;

    /**
     * The command line with argv[0] removed — a pointer INTO the CRT's own copy, not a
     * new allocation, exactly as the UCRT returns. Scans guest bytes rather than a
     * decoded string so a multi-byte ANSI page cannot shift the offset.
     */
    exports["_get_narrow_winmain_command_line"] = () => {
        const base = host.commandLineAddr() >>> 0;
        if (!base) return 0;
        let i = 0;
        for (;;) {
            const ch = Mem.readUint8(base + i);
            if (!ch || ch === 0x20 || ch === 0x09) break;
            i++;
            if (ch === 0x22) { // opening quote: skip to the closing one
                for (;;) {
                    const q = Mem.readUint8(base + i);
                    if (!q) break;
                    i++;
                    if (q === 0x22) break;
                }
            }
        }
        for (;;) {
            const ch = Mem.readUint8(base + i);
            if (ch !== 0x20 && ch !== 0x09) break;
            i++;
        }
        return (base + i) >>> 0;
    };

    exports["_crt_atexit"] = (_ctx, _mem, args) => (host.registerExitHandler((args[0] ?? 0) >>> 0) ? 0 : -1);

    // quick_exit runs its OWN table and never the atexit chain; keeping it separate is
    // the whole point of the split.
    const quickExitHandlers: number[] = [];
    exports["_crt_at_quick_exit"] = (_ctx, _mem, args) => {
        const fn = (args[0] ?? 0) >>> 0;
        if (!fn) return -1;
        quickExitHandlers.push(fn);
        return 0;
    };
    // quick_exit is [[noreturn]]: the handlers run and THEN the process ends. Resuming the
    // caller once the chain drains would hand control back to code past a call the compiler
    // proved unreachable.
    exports["quick_exit"] = (_ctx, _mem, args) => {
        const code = (args[0] ?? 0) | 0;
        const pending = quickExitHandlers.splice(0).reverse();
        if (pending.length === 0) return host.terminateProcess(code, "ucrt: quick_exit");
        return invokeGuestVoidChain(host.process, pending, "quick_exit", 0,
            () => host.endProcessAfterChain(code));
    };

    // --- the caller-owned onexit table ---

    exports["_initialize_onexit_table"] = (_ctx, _mem, args) => {
        const table = (args[0] ?? 0) >>> 0;
        if (!table) return -1;
        // An already-initialized table is left alone: the UCRT only resets one whose
        // _first and _end agree, which is how a zeroed (or exhausted) table reads.
        const first = Mem.readUint32(table + ONEXIT_FIRST) ?? 0;
        const end = Mem.readUint32(table + ONEXIT_END) ?? 0;
        if (first === end) {
            Mem.writeUint32(table + ONEXIT_FIRST, 0);
            Mem.writeUint32(table + ONEXIT_LAST, 0);
            Mem.writeUint32(table + ONEXIT_END, 0);
        }
        return 0;
    };

    exports["_register_onexit_function"] = (_ctx, _mem, args) => {
        const table = (args[0] ?? 0) >>> 0;
        const func = (args[1] ?? 0) >>> 0;
        if (!table) return -1;

        let first = (Mem.readUint32(table + ONEXIT_FIRST) ?? 0) >>> 0;
        let last = (Mem.readUint32(table + ONEXIT_LAST) ?? 0) >>> 0;
        let end = (Mem.readUint32(table + ONEXIT_END) ?? 0) >>> 0;

        if (!first) {
            first = host.calloc(ONEXIT_INITIAL_SLOTS, 4) >>> 0;
            if (!first) { host.setErrno(ENOMEM); return -1; }
            last = first;
            end = first + ONEXIT_INITIAL_SLOTS * 4;
        } else if (last === end) {
            const slots = (end - first) >>> 2;
            const grown = host.realloc(first, slots * 2 * 4) >>> 0;
            if (!grown) { host.setErrno(ENOMEM); return -1; }
            first = grown;
            last = first + slots * 4;
            end = first + slots * 2 * 4;
        }

        Mem.writeUint32(last, func);
        Mem.writeUint32(table + ONEXIT_FIRST, first);
        Mem.writeUint32(table + ONEXIT_LAST, last + 4);
        Mem.writeUint32(table + ONEXIT_END, end);
        return 0;
    };

    exports["_execute_onexit_table"] = (_ctx, _mem, args) => {
        const table = (args[0] ?? 0) >>> 0;
        if (!table) return -1;
        const first = (Mem.readUint32(table + ONEXIT_FIRST) ?? 0) >>> 0;
        const last = (Mem.readUint32(table + ONEXIT_LAST) ?? 0) >>> 0;
        if (!first || first >= last) return 0;

        // Detach the list BEFORE running it: a handler may register more, and those
        // belong to the next execution, not this one.
        const pending: number[] = [];
        for (let addr = last - 4; addr >= first; addr -= 4) {
            const fn = (Mem.readUint32(addr) ?? 0) >>> 0;
            if (fn) pending.push(fn);
        }
        Mem.writeUint32(table + ONEXIT_FIRST, 0);
        Mem.writeUint32(table + ONEXIT_LAST, 0);
        Mem.writeUint32(table + ONEXIT_END, 0);
        host.free(first);

        return invokeGuestVoidChain(host.process, pending, "_execute_onexit_table");
    };

    /**
     * The EXE's per-thread atexit callback. We record it; nothing calls it, because a
     * guest thread exiting through our scheduler has no CRT-owned teardown point — the
     * real UCRT calls it from its own DllMain(THREAD_DETACH), which an HLE'd CRT has no
     * equivalent of.
     */
    exports["_register_thread_local_exe_atexit_callback"] = (_ctx, _mem, args) => {
        Logger.info(LogCategory.SYSTEM,
            `ucrt: thread-local atexit callback 0x${((args[0] ?? 0) >>> 0).toString(16)} recorded, never invoked`);
        return 0;
    };

    exports["_invalid_parameter_noinfo_noreturn"] = () =>
        host.terminateProcess(3, "ucrt: _invalid_parameter_noinfo_noreturn");
    exports["terminate"] = () => host.terminateProcess(3, "ucrt: terminate() called");
    exports["__std_terminate"] = () => host.terminateProcess(3, "ucrt: __std_terminate() called");

    /**
     * The filters guarding main()/DllMain() in the VS2015+ startup code. Reporting
     * EXCEPTION_CONTINUE_SEARCH is what a real UCRT does when a debugger is attached,
     * and it is the only answer that keeps the fault visible: EXCEPTION_EXECUTE_HANDLER
     * makes the startup code swallow the exception and exit with its code, which is
     * indistinguishable from a clean exit by the time anyone looks.
     */
    const sehFilter = (tag: string) => (_ctx: unknown, _mem: unknown, args: number[]): number => {
        Logger.error(LogCategory.SYSTEM,
            `ucrt: ${tag} — unhandled exception 0x${((args[0] ?? 0) >>> 0).toString(16)} escaped to the CRT`);
        return EXCEPTION_CONTINUE_SEARCH;
    };
    exports["_seh_filter_exe"] = sehFilter("_seh_filter_exe");
    exports["_seh_filter_dll"] = sehFilter("_seh_filter_dll");

    // ==================== heap ====================

    exports["_set_new_mode"] = (_ctx, _mem, args) => {
        const mode = (args[0] ?? 0) | 0;
        if (mode !== 0 && mode !== 1) { host.setErrno(EINVAL); return -1; }
        return host.setNewMode(mode);
    };

    /** Invoke the installed new-handler; 0 ("do not retry") when there is none. */
    exports["_callnewh"] = (_ctx, _mem, args) => {
        const handler = host.newHandler() >>> 0;
        if (!handler) return 0;
        Logger.warn(LogCategory.SYSTEM, `ucrt: _callnewh(${(args[0] ?? 0) >>> 0}) — new-handler installed at `
            + `0x${handler.toString(16)} is not re-entered; reporting "do not retry"`);
        return 0;
    };

    exports["_recalloc"] = (_ctx, _mem, args) => {
        const ptr = (args[0] ?? 0) >>> 0;
        const num = (args[1] ?? 0) >>> 0;
        const size = (args[2] ?? 0) >>> 0;
        if (!ptr) return host.calloc(num, size);
        const total = num * size;
        const oldSize = host.msize(ptr);
        const grown = host.realloc(ptr, total) >>> 0;
        if (!grown) { host.setErrno(ENOMEM); return 0; }
        if (total > oldSize) host.memset(grown + oldSize, 0, total - oldSize);
        return grown;
    };

    // ==================== vcruntime140 ====================

    /**
     * std::exception's owned message. `_DoFree` is the one-byte `bool` the header
     * declares — writing four would clobber the struct's padding.
     */
    exports["__std_exception_copy"] = (_ctx, _mem, args) => {
        const src = (args[0] ?? 0) >>> 0;
        const dst = (args[1] ?? 0) >>> 0;
        if (!src || !dst) return 0;
        const what = (Mem.readUint32(src + EXCEPTION_DATA_WHAT) ?? 0) >>> 0;
        const doFree = (Mem.readUint8(src + EXCEPTION_DATA_DOFREE) ?? 0) !== 0;
        if (doFree && what) {
            const copy = host.strdup(what) >>> 0;
            Mem.writeUint32(dst + EXCEPTION_DATA_WHAT, copy);
            Mem.writeUint8(dst + EXCEPTION_DATA_DOFREE, copy ? 1 : 0);
            return 0;
        }
        Mem.writeUint32(dst + EXCEPTION_DATA_WHAT, what);
        Mem.writeUint8(dst + EXCEPTION_DATA_DOFREE, 0);
        return 0;
    };

    exports["__std_exception_destroy"] = (_ctx, _mem, args) => {
        const data = (args[0] ?? 0) >>> 0;
        if (!data) return 0;
        if ((Mem.readUint8(data + EXCEPTION_DATA_DOFREE) ?? 0) !== 0) {
            host.free((Mem.readUint32(data + EXCEPTION_DATA_WHAT) ?? 0) >>> 0);
        }
        Mem.writeUint32(data + EXCEPTION_DATA_WHAT, 0);
        Mem.writeUint8(data + EXCEPTION_DATA_DOFREE, 0);
        return 0;
    };

    /**
     * Free the SList of demangled type_info names. SLIST_HEADER on x86 is
     * { SLIST_ENTRY *Next; WORD Depth; WORD Sequence; }; flushing it means taking Next
     * and zeroing the header, then walking each entry's own Next.
     */
    exports["__std_type_info_destroy_list"] = (_ctx, _mem, args) => {
        const header = (args[0] ?? 0) >>> 0;
        if (!header) return 0;
        let cur = (Mem.readUint32(header) ?? 0) >>> 0;
        Mem.writeUint32(header, 0);
        Mem.writeUint32(header + 4, 0);
        for (let guard = 0; cur && guard < 0x10000; guard++) {
            const next = (Mem.readUint32(cur) ?? 0) >>> 0;
            host.free(cur);
            cur = next;
        }
        return 0;
    };

    // ==================== time: the __time64_t forms ====================

    /**
     * Setting a file's timestamps. The OPFS-backed VFS records no mtime of its own, so
     * there is nothing to set and this reports failure rather than claiming success —
     * callers treat it as an advisory step and continue.
     */
    exports["_utime64"] = () => {
        host.setErrno(EACCES);
        return -1;
    };
}

/**
 * How many assignment targets a scanf format consumes — `%` conversions that are not
 * `%%` and not suppressed with `*`. Needed because a va_list gives no count and
 * scanfCore wants the targets as an array.
 */
export function countScanfConversions(format: string): number {
    const SPECIFIER = /[a-zA-Z\[]/;
    let count = 0;
    for (let i = 0; i < format.length; i++) {
        if (format[i] !== "%") continue;
        i++;
        if (format[i] === "%") continue;
        const suppressed = format[i] === "*";
        // Skip width, precision and length modifiers to the conversion character.
        while (i < format.length && !SPECIFIER.test(format[i]!)) i++;
        if (!suppressed) count++;
        // A scanset swallows everything to its closing bracket, `%` included.
        if (format[i] === "[") {
            i++;
            if (format[i] === "^") i++;
            if (format[i] === "]") i++;
            while (i < format.length && format[i] !== "]") i++;
        }
    }
    return count;
}
