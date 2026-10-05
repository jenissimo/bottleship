/**
 * CRTDLL minimal thunk module.
 * Old Visual C++ runtime (pre-MSVC 6.0). Mostly compatible with msvcrt.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation, ThunkResult } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import { VfsFileHandle } from "../runtime/filesystem/vfs";
import { fpuGetST, fpuPop, fpuSetST0 } from "../core/fpu-helper";

import { VaListReader, ArrayVaListReader, encodeAnsi, formatCLazy as formatCLazyShared } from "./crt-format";
import { scanfCore } from "./crt-scanf";
import { getCodePageDecoder, getAnsiCodePage } from "./codepage-utils";
import { EmulatorConfig } from "../core/emulator-config-manager";
import { asBufferSource } from "../../dom-buffer";
import { hypercallDataManager } from "../core/cpu/hypercall-data";
import { LARGE_IO_TRACE_ENABLED, traceLargeRead } from "../core/diagnostics/large-io-trace";
import { ensureNativeQsort } from "./crt-qsort";
import { fillStatStruct, STAT32_OFFSETS } from "./crt-vc9-io";

const formatUnknownError = (err: unknown): string => {
    const forceString = (value: unknown): string => {
        if (typeof value === "string") return value;
        if (typeof value === "symbol") return value.toString();
        try {
            return String(value);
        } catch {
            return "[unprintable value]";
        }
    };

    if (err instanceof Error) {
        const msg = forceString((err as any).message);
        if (msg && msg !== "undefined") return msg;
        return forceString(err.name);
    }
    if (typeof err === "symbol") {
        return err.toString();
    }
    return forceString(err);
};

export class Crtdll implements IModule {
    name = "crtdll";
    exports: Record<string, ThunkImplementation> = {};

    private process!: Process;
    private randSeed = 1;
    private errnoAddr = 0;
    private pctypeAddr = 0;
    private mbCurMaxAddr = 0;
    private localeAddr = 0;
    private currentLocale = "C";
    private adjustFdivAddr = 0;
    private qsortCodeAddr = 0;
    private readonly crtAllocations = new Map<number, number>();
    private fdNext = 3;
    private fds: Map<number, VfsFileHandle> = new Map();

    initialize(process: Process): void {
        this.process = process;
        this.ensureRuntimeStorage();
        this.registerDataExports();

        const exports = this.exports;

        // Memory functions
        exports["malloc"] = (ctx, mem, args) => this.malloc(args[0] ?? 0);
        exports["free"] = (ctx, mem, args) => this.free(args[0] ?? 0);
        exports["calloc"] = (ctx, mem, args) => this.calloc(args[0] ?? 0, args[1] ?? 0);
        exports["realloc"] = (ctx, mem, args) => this.realloc(args[0] ?? 0, args[1] ?? 0);
        exports["memset"] = (ctx, mem, args) => this.memset(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["memcpy"] = (ctx, mem, args) => this.memcpy(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["memmove"] = (ctx, mem, args) => this.memmove(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);

        // String functions
        exports["strlen"] = (ctx, mem, args) => this.strlen(args[0] ?? 0);
        exports["strcpy"] = (ctx, mem, args) => this.strcpy(args[0] ?? 0, args[1] ?? 0);
        exports["strncpy"] = (ctx, mem, args) => this.strncpy(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["strcat"] = (ctx, mem, args) => this.strcat(args[0] ?? 0, args[1] ?? 0);
        exports["strncat"] = (ctx, mem, args) => this.strncat(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["strcmp"] = (ctx, mem, args) => this.strcmp(args[0] ?? 0, args[1] ?? 0);
        exports["strncmp"] = (ctx, mem, args) => this.strncmp(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["_strcmpi"] = (ctx, mem, args) => this.stricmp(args[0] ?? 0, args[1] ?? 0);
        exports["_stricmp"] = (ctx, mem, args) => this.stricmp(args[0] ?? 0, args[1] ?? 0);
        exports["_strnicmp"] = (ctx, mem, args) => this.strnicmp(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["strchr"] = (ctx, mem, args) => this.strchr(args[0] ?? 0, args[1] ?? 0);
        exports["strrchr"] = (ctx, mem, args) => this.strrchr(args[0] ?? 0, args[1] ?? 0);
        exports["strstr"] = (ctx, mem, args) => this.strstr(args[0] ?? 0, args[1] ?? 0);
        exports["strpbrk"] = (ctx, mem, args) => this.strpbrk(args[0] ?? 0, args[1] ?? 0);
        exports["_strlwr"] = (ctx, mem, args) => this.strlwr(args[0] ?? 0);
        exports["_strupr"] = (ctx, mem, args) => this.strupr(args[0] ?? 0);
        exports["_strdup"] = (ctx, mem, args) => this.strdup(args[0] ?? 0);

        // Wide string functions
        exports["wcslen"] = (ctx, mem, args) => this.wcslen(args[0] ?? 0);
        exports["wcstombs"] = (ctx, mem, args) => this.wcstombs(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);

        // Formatting
        exports["sprintf"] = (ctx, mem, args) => this.sprintf(args);
        exports["printf"] = (ctx, mem, args) => this.printf(args);
        exports["vsprintf"] = (ctx, mem, args) => this.vsprintf(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["_vsnprintf"] = (ctx, mem, args) => this.vsnprintf(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, args[3] ?? 0);
        exports["sscanf"] = (ctx, mem, args) => this.sscanf(args);

        // Conversion functions
        exports["atoi"] = (ctx, mem, args) => this.atoi(args[0] ?? 0);
        exports["atol"] = (ctx, mem, args) => this.atol(args[0] ?? 0);
        exports["strtol"] = (ctx, mem, args) => this.strtol(args[0] ?? 0, args[1] ?? 0, args[2] ?? 10);
        exports["strtoul"] = (ctx, mem, args) => this.strtoul(args[0] ?? 0, args[1] ?? 0, args[2] ?? 10);
        exports["_ltoa"] = (ctx, mem, args) => this.ltoa(args[0] ?? 0, args[1] ?? 0, args[2] ?? 10);
        exports["toupper"] = (ctx, mem, args) => this.toupper(args[0] ?? 0);
        exports["tolower"] = (ctx, mem, args) => this.tolower(args[0] ?? 0);

        // Random/time
        exports["srand"] = (ctx, mem, args) => this.srand(args[0] ?? 0);
        exports["rand"] = () => this.rand();
        exports["time"] = (ctx, mem, args) => this.time(args[0] ?? 0);
        exports["_ftime"] = (ctx, mem, args) => this.ftime(args[0] ?? 0);

        // Character type
        exports["_errno"] = () => this.errnoAddr;
        exports["__p__pctype"] = () => this.pctypeAddr;
        exports["__p___mb_cur_max"] = () => this.mbCurMaxAddr;
        exports["_isctype"] = (ctx, mem, args) => this.isctype(args[0] ?? 0, args[1] ?? 0);
        exports["setlocale"] = (ctx, mem, args) => this.setlocale(args[0] ?? 0, args[1] ?? 0);

        // Runtime
        exports["_adjust_fdiv"] = () => this.adjustFdivAddr;
        exports["_initterm"] = () => 0;
        exports["_purecall"] = () => this.purecall();

        // FPU intrinsics
        exports["_ftol"] = () => this.ftol();
        exports["_CItan"] = () => this.CItan();
        exports["_CIatan2"] = () => this.CIatan2();
        exports["_CIpow"] = () => this.CIpow();

        // File I/O
        exports["_open"] = (ctx, mem, args) => this.open(args[0] ?? 0, args[1] ?? 0);
        exports["_close"] = (ctx, mem, args) => this.close(args[0] ?? 0);
        exports["_read"] = (ctx, mem, args) => this.read(ctx, mem, args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["_write"] = (ctx, mem, args) => this.write(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["_lseek"] = (ctx, mem, args) => this.lseek(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["_tell"] = (ctx, mem, args) => this.tell(args[0] ?? 0);
        exports["_filelength"] = (ctx, mem, args) => this.filelength(args[0] ?? 0);
        exports["_eof"] = (ctx, mem, args) => this.eof(args[0] ?? 0);
        exports["_commit"] = () => 0;
        exports["_access"] = (ctx, mem, args) => this.access(args[0] ?? 0, args[1] ?? 0);
        exports["_chmod"] = (ctx, mem, args) => this.chmod(args[0] ?? 0);
        exports["_mkdir"] = (ctx, mem, args) => this.mkdir(args[0] ?? 0);
        exports["_rmdir"] = (ctx, mem, args) => this.rmdir(args[0] ?? 0);
        exports["_unlink"] = (ctx, mem, args) => this.unlink(args[0] ?? 0);
        exports["_splitpath"] = (ctx, mem, args) => this.splitpath(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, args[3] ?? 0, args[4] ?? 0);
        exports["_fullpath"] = (ctx, mem, args) => this.fullpath(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        exports["_stat"] = (ctx, mem, args) => this.stat(args[0] ?? 0, args[1] ?? 0);

        // Misc
        exports["qsort"] = () => 0;
        exports["bsearch"] = () => 0;
        exports["abs"] = (ctx, mem, args) => this.abs(args[0] ?? 0);
        exports["labs"] = (ctx, mem, args) => this.abs(args[0] ?? 0);
    }

    reset(): void {
        this.randSeed = 1;
        this.fds.clear();
        this.fdNext = 3;
        this.crtAllocations.clear();
        if (this.errnoAddr) {
            Mem.writeUint32(this.errnoAddr, 0);
        }
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
        if (this.pctypeAddr === 0) {
            this.pctypeAddr = this.process.memory.alloc(512, "THUNK_DATA", "rw");
            const table = new Uint8Array(512);
            for (let i = 0; i < 256; i++) {
                const flags = this.computeCtypeFlags(i);
                table[i * 2] = flags & 0xff;
                table[i * 2 + 1] = (flags >>> 8) & 0xff;
            }
            Mem.writeBytes(this.pctypeAddr, table);
        }
        if (this.localeAddr === 0) {
            this.localeAddr = this.process.memory.alloc(this.currentLocale.length + 1, "THUNK_DATA", "rw");
            this.writeCString(this.localeAddr, this.currentLocale);
        }
        if (this.adjustFdivAddr === 0) {
            this.adjustFdivAddr = this.process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.adjustFdivAddr, 0);
        }
    }

    private registerDataExports(): void {
        const tg = this.process.thunkGenerator;
        if (!tg?.registerDataExport) return;

        tg.registerDataExport("crtdll", "_adjust_fdiv", this.adjustFdivAddr);

        // Native x86 qsort (insertion sort) — IAT points to code, no JS thunk.
        if (this.qsortCodeAddr === 0) {
            this.qsortCodeAddr = ensureNativeQsort(this.process);
        }
        if (this.qsortCodeAddr) {
            tg.registerDataExport("crtdll", "qsort", this.qsortCodeAddr);
        }

        Logger.log(LogCategory.SYSTEM,
            `CRTDLL data exports: _adjust_fdiv=0x${this.adjustFdivAddr.toString(16)}, qsort=0x${this.qsortCodeAddr.toString(16)}`);
    }

    reregisterExports(_process: Process): void {
        this.errnoAddr = 0;
        this.pctypeAddr = 0;
        this.mbCurMaxAddr = 0;
        this.localeAddr = 0;
        this.adjustFdivAddr = 0;
        // NOT resetNativeQsort(): the shared code address is keyed on
        // process.resetGeneration, so clearing it from one module's re-registration
        // would hand a DIFFERENT address to whichever CRT flavour re-registers after
        // us — and each flavour publishes its own IAT binding.
        this.qsortCodeAddr = 0;

        this.ensureRuntimeStorage();
        this.registerDataExports();
    }

    private setErrno(value: number): boolean {
        if (!this.errnoAddr) return false;
        Mem.writeUint32(this.errnoAddr, value >>> 0);
        return true;
    }

    // ==================== Memory ====================

    private malloc(size: number): number {
        const bytes = size >>> 0;
        if (bytes === 0) return 0;
        try {
            const ptr = this.process.memory.alloc(bytes);
            this.crtAllocations.set(ptr >>> 0, bytes >>> 0);
            return ptr;
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `crtdll.malloc failed: ${formatUnknownError(e)}`);
            this.setErrno(12);
            return 0;
        }
    }

    private free(ptr: number): number {
        if (!ptr) return 0;
        const addr = ptr >>> 0;
        if (!this.crtAllocations.has(addr)) {
            Logger.warn(LogCategory.SYSTEM, `crtdll.free ignored non-CRT pointer 0x${addr.toString(16)}`);
            this.setErrno(22);
            return 0;
        }
        try {
            this.process.memory.free(addr);
            this.crtAllocations.delete(addr);
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `crtdll.free failed: ${formatUnknownError(e)}`);
            this.setErrno(22);
        }
        return 0;
    }

    private calloc(count: number, size: number): number {
        const total = (count >>> 0) * (size >>> 0);
        if (!total) return 0;
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
        if (!this.crtAllocations.has(addr)) {
            Logger.warn(LogCategory.SYSTEM, `crtdll.realloc ignored non-CRT pointer 0x${addr.toString(16)}`);
            this.setErrno(22);
            return 0;
        }
        const oldSize = this.process.memory.getSize(ptr) ?? 0;
        if (oldSize === 0) {
            this.crtAllocations.delete(addr);
            this.setErrno(22);
            return 0;
        }
        if (oldSize >= bytes) return ptr;
        const newPtr = this.malloc(bytes);
        if (!newPtr) return 0;
        this.memcpy(newPtr, ptr, oldSize);
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
        const srcBytes = Mem.readBytes(src, size);
        if (!srcBytes) return dest >>> 0;
        const copy = new Uint8Array(srcBytes);
        Mem.writeBytes(dest, copy);
        return dest >>> 0;
    }

    // ==================== String ====================

    private strlen(ptr: number): number {
        return this.readCString(ptr, 0x100000).length;
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

    private strncmp(aPtr: number, bPtr: number, count: number): number {
        return this.compareCString(aPtr, bPtr, false, count >>> 0);
    }

    private stricmp(aPtr: number, bPtr: number): number {
        return this.compareCString(aPtr, bPtr, true, 0);
    }

    private strnicmp(aPtr: number, bPtr: number, count: number): number {
        return this.compareCString(aPtr, bPtr, true, count >>> 0);
    }

    private strchr(ptr: number, ch: number): number {
        return this.findChar(ptr, ch, false);
    }

    private strrchr(ptr: number, ch: number): number {
        return this.findChar(ptr, ch, true);
    }

    private strstr(haystack: number, needle: number): number {
        if (!haystack || !needle) return 0;
        const str = this.readCString(haystack, 0x100000);
        const sub = this.readCString(needle, 0x100000);
        if (sub.length === 0) return haystack >>> 0;
        const idx = str.indexOf(sub);
        if (idx < 0) return 0;
        return (haystack + idx) >>> 0;
    }

    private strpbrk(str: number, charset: number): number {
        if (!str || !charset) return 0;
        const s = this.readCString(str, 0x100000);
        const chars = this.readCString(charset, 256);
        for (let i = 0; i < s.length; i++) {
            if (chars.includes(s[i])) {
                return (str + i) >>> 0;
            }
        }
        return 0;
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

    private strupr(ptr: number): number {
        if (!ptr) return 0;
        let offset = 0;
        for (;;) {
            const c = Mem.readUint8(ptr + offset);
            if (c === null || c === 0) break;
            let out = c;
            if (c >= 0x61 && c <= 0x7a) out = c - 0x20;
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

    // ==================== Wide String ====================

    private wcslen(ptr: number): number {
        if (!ptr) return 0;
        let len = 0;
        for (let i = 0; i < 0x100000; i += 2) {
            const lo = Mem.readUint8(ptr + i);
            const hi = Mem.readUint8(ptr + i + 1);
            if (lo === null || hi === null || (lo === 0 && hi === 0)) break;
            len++;
        }
        return len;
    }

    private wcstombs(dest: number, src: number, count: number): number {
        if (!src) return 0;
        const maxBytes = count >>> 0;
        const wideStr: number[] = [];

        // Read wide string
        for (let i = 0; i < 0x100000; i += 2) {
            const lo = Mem.readUint8(src + i);
            const hi = Mem.readUint8(src + i + 1);
            if (lo === null || hi === null) break;
            const wchar = lo | (hi << 8);
            if (wchar === 0) break;
            wideStr.push(wchar);
        }

        // Convert to UTF-8
        const str = String.fromCharCode(...wideStr);
        const bytes = encodeAnsi(str);

        if (!dest) {
            // Return required size
            return bytes.length;
        }

        // Copy to destination (truncate if needed)
        const copyLen = Math.min(bytes.length, maxBytes > 0 ? maxBytes - 1 : bytes.length);
        const slice = bytes.subarray(0, copyLen);
        Mem.writeBytes(dest, slice);
        if (maxBytes > copyLen) {
            Mem.writeBytes(dest + copyLen, new Uint8Array([0]));
        }

        return copyLen;
    }

    // ==================== Formatting ====================

    private sprintf(args: number[]): number {
        const dest = args[0] ?? 0;
        const fmtPtr = args[1] ?? 0;
        if (!dest || !fmtPtr) return -1;
        const format = this.readCString(fmtPtr, 0x100000);
        const reader = new ArrayVaListReader(args, 2);
        const text = this.formatCLazy(format, reader);
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
        const text = this.formatCLazy(format, reader);
        Logger.info(LogCategory.SYSTEM, `[CRT] ${text}`);
        return text.length;
    }

    private vsprintf(dest: number, fmtPtr: number, vaList: number): number {
        if (!dest || !fmtPtr) return -1;
        const format = this.readCString(fmtPtr, 0x100000);
        const reader = vaList ? new VaListReader(vaList) : new VaListReader(0);
        const text = this.formatCLazy(format, reader);
        const bytes = encodeAnsi(text);
        Mem.writeBytes(dest, bytes);
        Mem.writeBytes(dest + bytes.length, new Uint8Array([0]));
        return text.length;
    }

    private sscanf(args: number[]): number {
        const inputPtr = args[0] ?? 0;
        const fmtPtr = args[1] ?? 0;
        if (!inputPtr || !fmtPtr) return 0;
        // Delegate to the shared faithful scanf core (crt-scanf.ts) so crtdll and msvcrt behave
        // identically — width/'*'/length-modifiers/scansets/literal matching all handled there.
        const input = this.readCString(inputPtr, 0x100000);
        const format = this.readCString(fmtPtr, 0x100000);
        const { assigned, eof } = scanfCore(input, format, args, 2);
        return eof && assigned === 0 ? -1 : assigned;
    }

    private vsnprintf(dest: number, count: number, fmtPtr: number, vaList: number): number {
        if (!dest || !fmtPtr) return -1;
        const max = count >>> 0;
        if (max === 0) return -1;

        const format = this.readCString(fmtPtr, 0x100000);
        const reader = vaList ? new VaListReader(vaList) : new VaListReader(0);
        const text = this.formatCLazy(format, reader);
        const bytes = encodeAnsi(text);

        if (bytes.length < max) {
            Mem.writeBytes(dest, bytes);
            Mem.writeBytes(dest + bytes.length, new Uint8Array([0]));
            return bytes.length | 0;
        }

        // Legacy MSVCRT behavior: on truncation return -1 and buffer may be non-null-terminated.
        Mem.writeBytes(dest, bytes.subarray(0, max));
        return -1;
    }

    // ==================== Conversion ====================

    private atoi(ptr: number): number {
        const value = this.readCString(ptr, 256).trim();
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) ? (parsed | 0) : 0;
    }

    private atol(ptr: number): number {
        return this.atoi(ptr);
    }

    private strtol(strPtr: number, endPtr: number, base: number): number {
        const str = this.readCString(strPtr, 256);
        const radix = base === 0 ? 10 : (base | 0);

        // Skip whitespace
        let start = 0;
        while (start < str.length && /\s/.test(str[start])) start++;

        // Handle sign
        let negative = false;
        if (str[start] === '-') {
            negative = true;
            start++;
        } else if (str[start] === '+') {
            start++;
        }

        // Parse number
        let end = start;
        while (end < str.length) {
            const c = str[end].toLowerCase();
            const digit = c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 :
                          c >= 'a' && c <= 'z' ? c.charCodeAt(0) - 87 : -1;
            if (digit < 0 || digit >= radix) break;
            end++;
        }

        const numStr = str.slice(start, end);
        let value = parseInt(numStr, radix) | 0;
        if (negative) value = -value;

        // Set end pointer if provided
        if (endPtr) {
            Mem.writeUint32(endPtr, strPtr + end);
        }

        return value;
    }

    private strtoul(strPtr: number, endPtr: number, base: number): number {
        const str = this.readCString(strPtr, 256);
        const radix = base === 0 ? 10 : (base | 0);

        let start = 0;
        while (start < str.length && /\s/.test(str[start])) start++;

        if (str[start] === '+') start++;

        let end = start;
        while (end < str.length) {
            const c = str[end].toLowerCase();
            const digit = c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 :
                          c >= 'a' && c <= 'z' ? c.charCodeAt(0) - 87 : -1;
            if (digit < 0 || digit >= radix) break;
            end++;
        }

        const numStr = str.slice(start, end);
        const value = parseInt(numStr, radix) >>> 0;

        if (endPtr) {
            Mem.writeUint32(endPtr, strPtr + end);
        }

        return value;
    }

    private ltoa(value: number, buffer: number, radix: number): number {
        if (!buffer) return 0;
        const base = radix > 1 ? radix : 10;
        const signed = (base === 10);
        const val = signed ? (value | 0) : (value >>> 0);
        const text = (signed && val < 0) ? `-${Math.abs(val).toString(base)}` : val.toString(base);
        this.writeCString(buffer, text);
        return buffer >>> 0;
    }

    private toupper(ch: number): number {
        const c = ch & 0xff;
        if (c >= 0x61 && c <= 0x7a) return c - 0x20;
        return c;
    }

    private tolower(ch: number): number {
        const c = ch & 0xff;
        if (c >= 0x41 && c <= 0x5a) return c + 0x20;
        return c;
    }

    private abs(value: number): number {
        const v = value | 0;
        return v < 0 ? -v : v;
    }

    // ==================== Random/Time ====================

    private srand(seed: number): number {
        this.randSeed = seed >>> 0;
        hypercallDataManager.updateRandSeed(this.randSeed);
        return 0;
    }

    private rand(): number {
        this.randSeed = (this.randSeed * 214013 + 2531011) >>> 0;
        return (this.randSeed >>> 16) & 0x7fff;
    }

    private time(ptr: number): number {
        const seconds = Math.floor(Date.now() / 1000) >>> 0;
        if (ptr) Mem.writeUint32(ptr, seconds);
        return seconds;
    }

    private ftime(ptr: number): number {
        if (!ptr) return 0;
        const now = Date.now();
        const seconds = Math.floor(now / 1000) >>> 0;
        const millis = now % 1000;
        Mem.writeUint32(ptr, seconds);
        this.writeUint16(ptr + 4, millis);
        this.writeUint16(ptr + 6, 0);
        this.writeUint16(ptr + 8, 0);
        return 0;
    }

    // ==================== Character Type ====================

    private isctype(ch: number, mask: number): number {
        const flags = this.computeCtypeFlags(ch & 0xff);
        return (flags & mask) !== 0 ? 1 : 0;
    }

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

        return this.localeAddr >>> 0;
    }

    // ==================== Runtime ====================

    private purecall(): number {
        Logger.error(LogCategory.SYSTEM, "[CRT] _purecall: pure virtual function call!");
        return 0;
    }

    // ==================== FPU Intrinsics ====================

    // _ftol / __ftol: convert ST(0) to a signed __int64 (truncate toward zero), pop ST(0), return
    // the FULL 64-bit result in EDX:EAX. Clamping to int32 (old behaviour) broke 64-bit users such
    // as the UE1 launcher's RDTSC timebase `now = _ftol(seconds*2^32)` (frozen DeltaTime). JS
    // fallback — primary path is the WASM hypercall (handler 17), kept in sync.
    private ftol(): number {
        try {
            const value = fpuGetST(this.process.v86, 0);
            fpuPop(this.process.v86); // FISTP pops the stack
            const v = Math.trunc(value);
            const reg = (this.process as any)?.dispatcher?.cachedReg32;
            if (reg) reg[2] = Math.floor(v / 4294967296) | 0;  // EDX = high 32
            return (v >>> 0) | 0;                               // EAX = low 32
        } catch (e) {
            Logger.log(LogCategory.SYSTEM, `crtdll._ftol failed: ${formatUnknownError(e)}`);
            return 0;
        }
    }

    private CItan(): number {
        try {
            const x = fpuGetST(this.process.v86, 0);
            const result = Math.tan(x);
            fpuSetST0(this.process.v86, result);
            return 0;
        } catch (e) {
            Logger.log(LogCategory.SYSTEM, `crtdll._CItan failed: ${formatUnknownError(e)}`);
            fpuSetST0(this.process.v86, 0);
            return 0;
        }
    }

    private CIatan2(): number {
        try {
            const x = fpuGetST(this.process.v86, 0);
            const y = fpuGetST(this.process.v86, 1);
            const result = Math.atan2(y, x);
            fpuPop(this.process.v86);
            fpuSetST0(this.process.v86, result);
            return 0;
        } catch (e) {
            Logger.log(LogCategory.SYSTEM, `crtdll._CIatan2 failed: ${formatUnknownError(e)}`);
            try { fpuSetST0(this.process.v86, 0); } catch {}
            return 0;
        }
    }

    private CIpow(): number {
        try {
            const exponent = fpuGetST(this.process.v86, 0);  // ST(0)
            const base = fpuGetST(this.process.v86, 1);      // ST(1)
            const result = Math.pow(base, exponent);         // ST(1)^ST(0)
            fpuPop(this.process.v86);
            fpuSetST0(this.process.v86, result);
            return 0;
        } catch (e) {
            Logger.log(LogCategory.SYSTEM, `crtdll._CIpow failed: ${formatUnknownError(e)}`);
            try { fpuSetST0(this.process.v86, 1); } catch {}
            return 0;
        }
    }

    // ==================== File I/O ====================

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
        const startPos = handle.position;
        const synced = vfs.readIntoSync(handle, mem, buffer, want);
        if (synced !== null) {
            if (LARGE_IO_TRACE_ENABLED) traceLargeRead('_read', handle.path, fd, startPos, want, synced);
            return synced;
        }

        // Large ROM / HTTP-range reads: async path (sync _read would fail with EIO otherwise).
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
                if (LARGE_IO_TRACE_ENABLED) traceLargeRead('_read', handle.path, fd, startPos, want, bytesRead);
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

    private access(pathPtr: number, _mode: number): number {
        const path = this.readCString(pathPtr, 512);
        if (!path) {
            this.setErrno(2);
            return -1;
        }
        const vfs = System.getInstance().fileSystem;
        if (vfs.hasRomFile(path)) return 0;
        const handle = vfs.openSync(path, 0x80000000, 3);
        if (handle) return 0;
        this.setErrno(2);
        return -1;
    }

    // Same faithful semantics as msvcrt's crt-path implementations (remove →
    // DeleteFile, _rmdir → RemoveDirectory, _chmod → attr no-op on existing path).
    private async unlink(pathPtr: number): Promise<number> {
        const path = pathPtr ? this.readCString(pathPtr, 512) : "";
        if (!path) {
            this.setErrno(22); // EINVAL
            return -1;
        }
        const vfs = System.getInstance().fileSystem;
        const resolved = vfs.resolvePath(path);
        if (vfs.directoryExists(resolved)) {
            this.setErrno(13); // EACCES
            return -1;
        }
        if (!vfs.openSync(resolved, 0x80000000, 3)) {
            this.setErrno(2); // ENOENT
            return -1;
        }
        try {
            const deleted = await vfs.deleteFile(resolved);
            if (!deleted) {
                this.setErrno(13);
                return -1;
            }
            return 0;
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `CRTDLL _unlink("${path}") failed: ${e}`);
            this.setErrno(13);
            return -1;
        }
    }

    private mkdir(pathPtr: number): number {
        const path = pathPtr ? this.readCString(pathPtr, 512).trim() : "";
        if (!path) {
            this.setErrno(22);
            return -1;
        }
        if (/^[A-Za-z]:\\?$/.test(path)) return 0;
        const result = System.getInstance().fileSystem.createDirectorySync(path);
        if (result.ok) return 0;
        switch (result.error) {
            case 183: this.setErrno(17); break; // EEXIST
            case 3: this.setErrno(2); break;    // ENOENT
            case 5: this.setErrno(13); break;   // EACCES
            default: this.setErrno(22); break;  // EINVAL
        }
        return -1;
    }

    private async rmdir(pathPtr: number): Promise<number> {
        const path = pathPtr ? this.readCString(pathPtr, 512) : "";
        if (!path) {
            this.setErrno(22);
            return -1;
        }
        const result = await System.getInstance().fileSystem.removeDirectory(path);
        if (result.ok) return 0;
        switch (result.error) {
            case 2: this.setErrno(2); break;    // ENOENT
            case 145: this.setErrno(41); break; // ENOTEMPTY
            default: this.setErrno(13); break;  // EACCES
        }
        return -1;
    }

    private stat(pathPtr: number, structPtr: number): number {
        const path = pathPtr ? this.readCString(pathPtr, 512) : "";
        if (!path || !structPtr) {
            this.setErrno(22); // EINVAL
            return -1;
        }
        const vfs = System.getInstance().fileSystem;
        const resolved = vfs.resolvePath(path);
        const isDir = vfs.directoryExists(resolved);
        const isFile = !isDir && (vfs.hasRomFile(resolved) || vfs.openSync(resolved, 0x80000000, 3) !== null);
        if (!isDir && !isFile) {
            this.setErrno(2); // ENOENT
            return -1;
        }
        fillStatStruct(structPtr, STAT32_OFFSETS, 36, isFile ? vfs.getFileSize(resolved) : 0, isDir,
            (p, v, n) => { for (let off = 0; off < n; off += 4) Mem.writeUint32(p + off, v); });
        return 0;
    }

    private chmod(pathPtr: number): number {
        const path = pathPtr ? this.readCString(pathPtr, 512) : "";
        if (!path) {
            this.setErrno(22);
            return -1;
        }
        const vfs = System.getInstance().fileSystem;
        const resolved = vfs.resolvePath(path);
        if (vfs.directoryExists(resolved) || vfs.fileExists(resolved)) return 0;
        this.setErrno(2); // ENOENT
        return -1;
    }

    private splitpath(pathPtr: number, drivePtr: number, dirPtr: number, fnamePtr: number, extPtr: number): number {
        const path = this.readCString(pathPtr, 1024);
        const normalized = path.replace(/\//g, "\\");
        let drive = "";
        let dir = "";
        let fname = normalized;
        let ext = "";

        const driveMatch = normalized.match(/^[A-Za-z]:/);
        if (driveMatch) {
            drive = driveMatch[0];
            fname = normalized.slice(2);
        }

        const lastSlash = fname.lastIndexOf("\\");
        if (lastSlash >= 0) {
            dir = fname.slice(0, lastSlash + 1);
            fname = fname.slice(lastSlash + 1);
        }

        const lastDot = fname.lastIndexOf(".");
        if (lastDot > 0) {
            ext = fname.slice(lastDot);
            fname = fname.slice(0, lastDot);
        }

        if (drivePtr) this.writeCString(drivePtr, drive);
        if (dirPtr) this.writeCString(dirPtr, dir);
        if (fnamePtr) this.writeCString(fnamePtr, fname);
        if (extPtr) this.writeCString(extPtr, ext);

        return 0;
    }

    private fullpath(absPath: number, relPath: number, maxLen: number): number {
        if (!relPath) return 0;

        const rel = this.readCString(relPath, 512);
        let full = rel.replace(/\//g, "\\");

        // If not absolute, prepend current drive
        if (!full.match(/^[A-Za-z]:/)) {
            if (full.startsWith("\\")) {
                full = "C:" + full;
            } else {
                full = "C:\\" + full;
            }
        }

        // Normalize path: resolve . and ..
        const parts = full.split("\\");
        const result: string[] = [];
        for (const part of parts) {
            if (part === "." || part === "") continue;
            if (part === "..") {
                if (result.length > 1) result.pop();
            } else {
                result.push(part);
            }
        }

        full = result.join("\\");

        if (!absPath) {
            // Return required buffer size
            return full.length + 1;
        }

        const max = maxLen >>> 0;
        if (full.length >= max) {
            this.setErrno(34); // ERANGE
            return 0;
        }

        this.writeCString(absPath, full);
        return absPath >>> 0;
    }

    // ==================== Helpers ====================

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
        // bytes[encoded.length] is already 0 (null terminator)
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

    /** Delegate to shared formatCLazy from crt-format.ts */
    private formatCLazy(format: string, reader: VaListReader | ArrayVaListReader): string {
        return formatCLazyShared(format, reader, (addr, max) => this.readCString(addr, max));
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
}
