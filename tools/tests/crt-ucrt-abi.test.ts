import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { msvcrtModule } from "../../src/worker/api/msvcrt.api";
import { msvcp140Module } from "../../src/worker/api/msvcp140.api";
import { resolveThunkedDllAlias } from "../../src/worker/core/dll-aliases";
import { registerUcrtExports, countScanfConversions, type UcrtHost } from "../../src/worker/modules/crt-ucrt";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

/** The 46 names whose absence made The Bard's Tale's image fail to map at all. */
const UCRT_UNBINDABLE = [
    "_c_exit", "_configure_narrow_argv", "_crt_at_quick_exit", "_crt_atexit",
    "_execute_onexit_table", "_get_narrow_winmain_command_line", "_initialize_narrow_environment",
    "_initialize_onexit_table", "_invalid_parameter_noinfo_noreturn", "_register_onexit_function",
    "_register_thread_local_exe_atexit_callback", "_seh_filter_dll", "_seh_filter_exe",
    "_set_app_type", "terminate",
    "_CIcosh", "_CIsinh", "_CItanh", "_except1", "_fpclass",
    "_libm_sse2_acos_precise", "_libm_sse2_atan_precise", "_libm_sse2_cos_precise",
    "_libm_sse2_exp_precise", "_libm_sse2_log_precise", "_libm_sse2_pow_precise",
    "_libm_sse2_sin_precise", "_libm_sse2_sqrt_precise", "_libm_sse2_tan_precise",
    "__acrt_iob_func", "__stdio_common_vfprintf", "__stdio_common_vsprintf",
    "__stdio_common_vsscanf", "__stdio_common_vswprintf", "__stdio_common_vswscanf", "_set_fmode",
    "__std_exception_copy", "__std_exception_destroy", "__std_terminate",
    "__std_type_info_destroy_list",
    "_gmtime64", "_mktime64", "_utime64",
    "_callnewh", "_recalloc", "_set_new_mode",
];

/** corecrt_stdio_config.h. */
const LEGACY_VSPRINTF_NULL_TERMINATION = 0x0001;
const STANDARD_SNPRINTF_BEHAVIOR = 0x0002;
const LEGACY_WIDE_SPECIFIERS = 0x0004;

const MSVC_FILE_SIZE = 32;
const IOB_BASE = 0x3000;

describe("UCRT ABI surface", () => {
    let mem: Uint8Array;
    let exports: Record<string, ThunkImplementation>;
    let freed: number[];
    let heapNext: number;
    let terminations: string[];

    const readCString = (ptr: number, maxLen: number): string => {
        let s = "";
        for (let i = ptr; i < mem.length && mem[i] !== 0 && s.length < maxLen; i++) s += String.fromCharCode(mem[i]!);
        return s;
    };
    const writeCString = (ptr: number, value: string): void => {
        for (let i = 0; i < value.length; i++) mem[ptr + i] = value.charCodeAt(i) & 0xff;
        mem[ptr + value.length] = 0;
    };
    const readWString = (ptr: number, maxChars: number): string => {
        let s = "";
        for (let i = 0; i < maxChars; i++) {
            const code = (mem[ptr + i * 2]! | (mem[ptr + i * 2 + 1]! << 8));
            if (!code) break;
            s += String.fromCharCode(code);
        }
        return s;
    };
    const writeWString = (ptr: number, value: string, maxChars?: number): void => {
        const limit = maxChars === undefined ? value.length + 1 : Math.max(1, maxChars);
        const n = Math.min(value.length, limit - 1);
        for (let i = 0; i < n; i++) {
            mem[ptr + i * 2] = value.charCodeAt(i) & 0xff;
            mem[ptr + i * 2 + 1] = (value.charCodeAt(i) >>> 8) & 0xff;
        }
        mem[ptr + n * 2] = 0;
        mem[ptr + n * 2 + 1] = 0;
    };

    beforeEach(() => {
        mem = new Uint8Array(0x8000);
        Mem.bind(() => mem);
        exports = {};
        freed = [];
        heapNext = 0x4000;
        terminations = [];

        const host: UcrtHost = {
            process: { v86: null } as never,
            malloc: (size) => { const p = heapNext; heapNext += Math.max(4, size); return p; },
            free: (ptr) => { freed.push(ptr); return 0; },
            realloc: (ptr, size) => { const p = heapNext; heapNext += Math.max(4, size); mem.copyWithin(p, ptr, ptr + size); return p; },
            calloc: (num, size) => { const p = heapNext; heapNext += Math.max(4, num * size); mem.fill(0, p, p + num * size); return p; },
            msize: () => 0,
            memset: (dest, ch, count) => { mem.fill(ch & 0xff, dest, dest + count); return dest; },
            strdup: (ptr) => { const s = readCString(ptr, 512); const p = heapNext; heapNext += s.length + 1; writeCString(p, s); return p; },
            readCString,
            writeCString,
            readWString,
            writeWString,
            formatWide: (format) => format,
            setErrno: () => true,
            terminateProcess: (code, reason) => { terminations.push(reason); return { value: 0, terminated: true }; },
            setAppType: (t) => t,
            registerExitHandler: () => true,
            stdioFile: (i) => (i > 2 ? 0 : IOB_BASE + i * MSVC_FILE_SIZE),
            stdStreamIndex: (p) => {
                const offset = p - IOB_BASE;
                return offset >= 0 && offset < 3 * MSVC_FILE_SIZE && offset % MSVC_FILE_SIZE === 0
                    ? offset / MSVC_FILE_SIZE : -1;
            },
            vfprintf: () => -1,
            fmodeAddr: () => 0x10,
            commandLineAddr: () => 0x200,
            newHandler: () => 0,
            setNewMode: () => 0,
        };
        registerUcrtExports(exports, host);
    });

    // ---- the 64-bit options word --------------------------------------------------

    /** __stdio_common_vsprintf(options:u64, buffer, len, format, locale, arglist). */
    const vsprintf = (optionsLo: number, buffer: number, len: number, format: number, va: number): number =>
        exports["__stdio_common_vsprintf"]!(null as never, mem, [optionsLo, 0, buffer, len, format, 0, va]) as number;

    test("the options word occupies two stack slots, so the buffer is args[2]", () => {
        writeCString(0x100, "ok");
        const ret = vsprintf(LEGACY_WIDE_SPECIFIERS, 0x800, 64, 0x100, 0);
        expect(ret).toBe(2);
        expect(readCString(0x800, 64)).toBe("ok");
    });

    test("a 64-bit options word split as two u32 params would read the buffer as the high half", () => {
        // The bug this pins: passing `options` as ONE slot shifts every later argument
        // down one, so `buffer` lands where `len` is read. Spelled out as the arg array
        // a wrong descriptor would produce.
        writeCString(0x100, "ok");
        const wrong = exports["__stdio_common_vsprintf"]!(null as never, mem, [0, 0x800, 64, 0x100, 0, 0]) as number;
        expect(wrong).not.toBe(2);
        expect(readCString(0x800, 64)).toBe("");
    });

    test("descriptor sizes the options word as two DWORD slots", () => {
        const registry = APIRegistry.getInstance();
        registry.registerModule(msvcrtModule);
        expect(registry.getArgCount("msvcrt", "__stdio_common_vsprintf")).toBe(7);
        expect(registry.getArgCount("msvcrt", "__stdio_common_vfprintf")).toBe(6);
        expect(registry.getCallingConvention("msvcrt", "__stdio_common_vsprintf")).toBe("cdecl");
        // The SSE2 math entries take nothing on the stack at all.
        expect(registry.getArgCount("msvcrt", "_libm_sse2_pow_precise")).toBe(0);
        expect(registry.getArgCount("msvcrt", "_fpclass")).toBe(2);
        expect(registry.getArgCount("msvcrt", "_except1")).toBe(8);
    });

    test("truncation answers per the options bits", () => {
        writeCString(0x100, "abcdef");
        // C99/standard-snprintf: the UNTRUNCATED length, buffer NUL-terminated at len-1.
        expect(vsprintf(STANDARD_SNPRINTF_BEHAVIOR, 0x800, 4, 0x100, 0)).toBe(6);
        expect(readCString(0x800, 64)).toBe("abc");
        // Legacy vsprintf termination: -1, and no terminator is forced.
        expect(vsprintf(LEGACY_VSPRINTF_NULL_TERMINATION, 0x900, 4, 0x100, 0)).toBe(-1);
        // Neither bit: -2 is the UCRT's "truncated" answer for a non-empty buffer.
        expect(vsprintf(0, 0xa00, 4, 0x100, 0)).toBe(-2);
        expect(readCString(0xa00, 64)).toBe("abc");
    });

    test("a NULL buffer asks only for the length", () => {
        writeCString(0x100, "abcdef");
        expect(vsprintf(STANDARD_SNPRINTF_BEHAVIOR, 0, 0, 0x100, 0)).toBe(6);
    });

    test("sprintf's (size_t)-1 length is unsigned, not a truncation", () => {
        writeCString(0x100, "hello");
        expect(vsprintf(STANDARD_SNPRINTF_BEHAVIOR, 0x800, 0xffffffff, 0x100, 0)).toBe(5);
        expect(readCString(0x800, 64)).toBe("hello");
    });

    test("vswprintf writes UTF-16 and terminates", () => {
        writeWString(0x100, "wide");
        const ret = exports["__stdio_common_vswprintf"]!(null as never, mem, [0, 0, 0x800, 16, 0x100, 0, 0]) as number;
        expect(ret).toBe(4);
        expect(readWString(0x800, 16)).toBe("wide");
    });

    test("vfprintf routes the standard streams instead of failing on them", () => {
        writeCString(0x100, "to stdout\n");
        const stdout = exports["__acrt_iob_func"]!(null as never, mem, [1]) as number;
        const ret = exports["__stdio_common_vfprintf"]!(null as never, mem, [0, 0, stdout, 0x100, 0, 0]) as number;
        expect(ret).toBe(10);
        // A real file (unknown FILE*) still goes to the host's stream writer.
        expect(exports["__stdio_common_vfprintf"]!(null as never, mem, [0, 0, 0x7000, 0x100, 0, 0])).toBe(-1);
    });

    // ---- __acrt_iob_func ----------------------------------------------------------

    test("__acrt_iob_func hands out three distinct FILE* and nothing else", () => {
        const iob = exports["__acrt_iob_func"]!;
        const handles = [0, 1, 2].map((i) => iob(null as never, mem, [i]) as number);
        expect(new Set(handles).size).toBe(3);
        expect(handles.every((h) => h !== 0)).toBe(true);
        expect(iob(null as never, mem, [3])).toBe(0);
        expect(iob(null as never, mem, [0xffffffff])).toBe(0);
    });

    // ---- the caller-owned onexit table --------------------------------------------

    const TABLE = 0x600;
    const first = () => Mem.readUint32(TABLE)! >>> 0;
    const last = () => Mem.readUint32(TABLE + 4)! >>> 0;
    const end = () => Mem.readUint32(TABLE + 8)! >>> 0;

    test("_initialize_onexit_table zeroes a fresh table and leaves a live one alone", () => {
        mem.fill(0, TABLE, TABLE + 12);
        expect(exports["_initialize_onexit_table"]!(null as never, mem, [TABLE])).toBe(0);
        expect([first(), last(), end()]).toEqual([0, 0, 0]);

        Mem.writeUint32(TABLE, 0x1111);
        Mem.writeUint32(TABLE + 4, 0x2222);
        Mem.writeUint32(TABLE + 8, 0x3333);
        exports["_initialize_onexit_table"]!(null as never, mem, [TABLE]);
        expect(first()).toBe(0x1111);

        expect(exports["_initialize_onexit_table"]!(null as never, mem, [0])).toBe(-1);
    });

    test("_register_onexit_function allocates, appends and grows the caller's table", () => {
        mem.fill(0, TABLE, TABLE + 12);
        exports["_initialize_onexit_table"]!(null as never, mem, [TABLE]);

        expect(exports["_register_onexit_function"]!(null as never, mem, [TABLE, 0xaaaa])).toBe(0);
        expect(first()).not.toBe(0);
        expect(last()).toBe(first() + 4);
        expect(end() - first()).toBe(32 * 4);
        expect(Mem.readUint32(first())).toBe(0xaaaa);

        exports["_register_onexit_function"]!(null as never, mem, [TABLE, 0xbbbb]);
        expect(last()).toBe(first() + 8);

        // Fill to capacity; the 33rd registration must double the block, not overrun it.
        for (let i = 2; i < 32; i++) exports["_register_onexit_function"]!(null as never, mem, [TABLE, 0xc000 + i]);
        expect(last()).toBe(end());
        exports["_register_onexit_function"]!(null as never, mem, [TABLE, 0xdddd]);
        expect(end() - first()).toBe(64 * 4);
        expect(last()).toBe(first() + 33 * 4);

        expect(exports["_register_onexit_function"]!(null as never, mem, [0, 0xaaaa])).toBe(-1);
    });

    test("_execute_onexit_table detaches and frees the list before running it", () => {
        mem.fill(0, TABLE, TABLE + 12);
        exports["_initialize_onexit_table"]!(null as never, mem, [TABLE]);
        // An empty (never-registered) table is a no-op success, not a failure.
        expect(exports["_execute_onexit_table"]!(null as never, mem, [TABLE])).toBe(0);

        exports["_register_onexit_function"]!(null as never, mem, [TABLE, 0xaaaa]);
        const block = first();
        // With a null v86 the chain cannot dispatch, but the bookkeeping still must
        // happen: the table is reset and its storage released exactly once.
        exports["_execute_onexit_table"]!(null as never, mem, [TABLE]);
        expect([first(), last(), end()]).toEqual([0, 0, 0]);
        expect(freed).toEqual([block]);

        expect(exports["_execute_onexit_table"]!(null as never, mem, [0])).toBe(-1);
    });

    // ---- vcruntime helpers ---------------------------------------------------------

    test("__std_exception_copy duplicates only an owned message, one byte of _DoFree", () => {
        writeCString(0x1000, "boom");
        Mem.writeUint32(0x700, 0x1000);
        Mem.writeUint8(0x704, 1);
        mem[0x705] = 0xcc; // padding must survive: _DoFree is a one-byte bool
        Mem.writeUint32(0x710, 0);
        Mem.writeUint8(0x714, 0);

        exports["__std_exception_copy"]!(null as never, mem, [0x700, 0x710]);
        const copy = Mem.readUint32(0x710)! >>> 0;
        expect(copy).not.toBe(0x1000);
        expect(readCString(copy, 64)).toBe("boom");
        expect(Mem.readUint8(0x714)).toBe(1);

        // A borrowed message is shared, never duplicated, and never freed.
        Mem.writeUint8(0x704, 0);
        exports["__std_exception_copy"]!(null as never, mem, [0x700, 0x720]);
        expect(Mem.readUint32(0x720)).toBe(0x1000);
        expect(Mem.readUint8(0x724)).toBe(0);

        freed.length = 0;
        exports["__std_exception_destroy"]!(null as never, mem, [0x720]);
        expect(freed).toEqual([]);
        expect(Mem.readUint32(0x720)).toBe(0);
    });

    test("__std_type_info_destroy_list flushes the SList and frees every entry", () => {
        Mem.writeUint32(0x300, 0x310); // header -> entry A
        Mem.writeUint32(0x304, 0x00010001);
        Mem.writeUint32(0x310, 0x320); // A -> B
        Mem.writeUint32(0x320, 0);     // B -> end
        exports["__std_type_info_destroy_list"]!(null as never, mem, [0x300]);
        expect(freed).toEqual([0x310, 0x320]);
        expect(Mem.readUint32(0x300)).toBe(0);
        expect(Mem.readUint32(0x304)).toBe(0);
    });

    test("terminate and __std_terminate end the process", () => {
        exports["terminate"]!(null as never, mem, []);
        exports["__std_terminate"]!(null as never, mem, []);
        expect(terminations.length).toBe(2);
    });

    test("the SEH filters report CONTINUE_SEARCH so the fault stays visible", () => {
        expect(exports["_seh_filter_exe"]!(null as never, mem, [0xc0000005, 0])).toBe(0);
        expect(exports["_seh_filter_dll"]!(null as never, mem, [0xc0000005, 0])).toBe(0);
    });

    // ---- the rest of the new shapes ------------------------------------------------

    test("_set_fmode accepts only _O_TEXT/_O_BINARY and publishes it", () => {
        expect(exports["_set_fmode"]!(null as never, mem, [0x8000])).toBe(0);
        expect(Mem.readUint32(0x10)).toBe(0x8000);
        expect(exports["_set_fmode"]!(null as never, mem, [3])).toBe(22); // EINVAL
        expect(Mem.readUint32(0x10)).toBe(0x8000);
    });

    test("_set_new_mode returns the previous mode and rejects anything but 0/1", () => {
        expect(exports["_set_new_mode"]!(null as never, mem, [1])).toBe(0);
        expect(exports["_set_new_mode"]!(null as never, mem, [7])).toBe(-1);
    });

    test("_recalloc zeroes the growth and calloc()s a NULL pointer", () => {
        const fresh = exports["_recalloc"]!(null as never, mem, [0, 4, 4]) as number;
        expect(fresh).not.toBe(0);
        const grown = exports["_recalloc"]!(null as never, mem, [fresh, 8, 4]) as number;
        for (let i = 0; i < 32; i++) expect(mem[grown + i]).toBe(0);
    });

    test("_callnewh reports 'do not retry' when no handler is installed", () => {
        expect(exports["_callnewh"]!(null as never, mem, [64])).toBe(0);
    });

    test("_get_narrow_winmain_command_line skips a quoted argv[0] and the spaces after it", () => {
        writeCString(0x200, '"C:\\Program Files\\game.exe"   -windowed foo');
        const p = exports["_get_narrow_winmain_command_line"]!(null as never, mem, []) as number;
        expect(readCString(p, 128)).toBe("-windowed foo");

        writeCString(0x200, "game.exe -a");
        expect(readCString(exports["_get_narrow_winmain_command_line"]!(null as never, mem, []) as number, 64)).toBe("-a");

        writeCString(0x200, "game.exe");
        expect(readCString(exports["_get_narrow_winmain_command_line"]!(null as never, mem, []) as number, 64)).toBe("");
    });

    test("_utime64 reports failure rather than claiming it stamped the file", () => {
        expect(exports["_utime64"]!(null as never, mem, [0x100, 0])).toBe(-1);
    });

    test("countScanfConversions ignores %% and suppressed conversions", () => {
        expect(countScanfConversions("%d %s")).toBe(2);
        expect(countScanfConversions("%d%% %*d %s")).toBe(2);
        expect(countScanfConversions("%[^%]x%d")).toBe(2);
        expect(countScanfConversions("%10ld %I64d")).toBe(2);
        expect(countScanfConversions("no conversions")).toBe(0);
    });
});

describe("UCRT import binding", () => {
    test("the whole VS2015+ CRT family aliases onto one HLE module", () => {
        for (const name of [
            "api-ms-win-crt-runtime-l1-1-0", "api-ms-win-crt-stdio-l1-1-0.dll",
            "api-ms-win-crt-math-l1-1-0", "api-ms-win-crt-heap-l1-1-0",
            "API-MS-WIN-CRT-STRING-L1-1-0.DLL", "api-ms-win-crt-private-l1-1-0",
            "ucrtbase", "ucrtbased", "vcruntime140", "vcruntime140d", "vcruntime140_1", "vcruntime",
        ]) {
            expect(resolveThunkedDllAlias(name), name).toBe("msvcrt");
        }
    });

    /**
     * A descriptor file added after the last Vite glob scan is INVISIBLE to
     * `import.meta.glob`, so APIRegistry never sees it, `hasModule` is false, the PE
     * loader declines to thunk the DLL and its imports get arity-less fallback stubs —
     * silently, with the descriptor sitting right there looking correct. Every check
     * that reads the `.api.ts` files directly (preflight, the coverage index, the
     * validators) stays green throughout, which is why this needs a test that goes
     * through the REGISTRY. `import.meta.glob` does not exist under bun, so a fresh
     * registry here holds exactly the statically-imported descriptors — making this
     * assertion an exact proxy for "was it added to the static list".
     */
    test("msvcp140's descriptor is registered without relying on the Vite glob", () => {
        const registry = APIRegistry.getInstance();
        expect(registry.hasModule("msvcp140")).toBe(true);
        expect(registry.getArgCount("msvcp140", "?_Xlength_error@std@@YAXPBD@Z")).toBe(1);
        expect(registry.getArgCount("msvcp140", "?_Xout_of_range@std@@YAXPBD@Z")).toBe(1);
        expect(registry.getCallingConvention("msvcp140", "?_Xbad_alloc@std@@YAXXZ")).toBe("cdecl");
    });

    test("msvcp140 is NOT folded into msvcp90 — the std::string ABI differs", () => {
        expect(resolveThunkedDllAlias("msvcp140")).toBe("msvcp140");
        expect(resolveThunkedDllAlias("msvcp140.dll")).toBe("msvcp140");
        expect(resolveThunkedDllAlias("msvcp90")).toBe("msvcp90");
    });

    test("every name that made the image unbindable now has a declared ABI", () => {
        const registry = APIRegistry.getInstance();
        registry.registerModule(msvcrtModule);
        for (const name of UCRT_UNBINDABLE) {
            expect(registry.getArgCount("msvcrt", name), `no ABI for ${name}`).toBeDefined();
            expect(registry.getCallingConvention("msvcrt", name), name).toBe("cdecl");
        }
    });

    test("the thunk generator emits stubs for the whole family without throwing", () => {
        const registry = APIRegistry.getInstance();
        registry.registerModule(msvcrtModule);
        registry.registerModule(msvcp140Module);
        const gen = new ThunkGenerator();
        const stubs = UCRT_UNBINDABLE.map((name) => ({
            name,
            argCount: registry.getArgCount("msvcrt", name),
            stackCleanupBytes: registry.getStackCleanupBytes("msvcrt", name),
            callingConvention: registry.getCallingConvention("msvcrt", name),
        }));
        expect(() => gen.generateStubDll("msvcrt", stubs)).not.toThrow();

        const cppStubs = msvcp140Module.functions.map((f) => ({
            name: f.name,
            argCount: registry.getArgCount("msvcp140", f.name),
            stackCleanupBytes: registry.getStackCleanupBytes("msvcp140", f.name),
            callingConvention: registry.getCallingConvention("msvcp140", f.name),
        }));
        expect(() => gen.generateStubDll("msvcp140", cppStubs)).not.toThrow();
    });
});
