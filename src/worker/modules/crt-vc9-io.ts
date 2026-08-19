/**
 * VC9 CRT file/time I/O — find64, stat64, file64, time64.
 */

import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import type { VfsEntry, VfsFileHandle } from "../runtime/filesystem/vfs";
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { getCPU } from "../core/thunking/thunk-utils";
import { ArrayVaListReader, scanCLazy } from "./crt-format";
import { formatAsctime } from "./crt-time";

export interface Vc9IoHost {
    process: { v86: unknown };
    readCString(ptr: number, maxLen?: number): string;
    setErrno(code: number): boolean;
    statImpl(pathPtr: number, structPtr: number, wide: boolean): number;
    fseek(filePtr: number, offset: number, origin: number): number;
    ftell(filePtr: number): number;
    filelength(fd: number): number;
    fileStreams: Map<number, { fd: number; handle: VfsFileHandle; ungetChar: number }>;
    malloc(size: number): number;
    writeCString(ptr: number, value: string): void;
    memset(ptr: number, val: number, size: number): number;
}

interface FindState {
    entries: VfsEntry[];
    index: number;
}

let nextFindHandle = 0x4000;
const findHandles = new Map<number, FindState>();

/** Drop trailing fraction zeros but KEEP the decimal point (CRT _cropzeros stops on it). */
function cropZeros(s: string): string {
    const dot = s.indexOf(".");
    if (dot < 0) return s;
    let end = s.length;
    while (end > dot + 1 && s[end - 1] === "0") end--;
    return s.slice(0, end);
}

/** Fortran-G formatting used by _gcvt (see the export below for the contract). */
export function gcvtFormat(val: number, ndec: number): string {
    if (Number.isNaN(val)) return "1.#QNAN";
    if (!Number.isFinite(val)) return (val < 0 ? "-" : "") + "1.#INF";
    const nd = Math.min(100, Math.max(1, ndec | 0));
    const neg = val < 0 || Object.is(val, -0);
    const abs = Math.abs(val);
    const es = abs.toExponential(nd - 1);
    const eIdx = es.indexOf("e");
    const exp10 = abs === 0 ? 0 : parseInt(es.slice(eIdx + 1), 10);
    const decpt = abs === 0 ? 1 : exp10 + 1;
    const magnitude = decpt - 1;
    let body: string;
    if (abs !== 0 && (magnitude < -1 || magnitude > nd - 1)) {
        body = cropZeros(es.slice(0, eIdx))
            + "e" + (exp10 < 0 ? "-" : "+")
            + String(Math.abs(exp10)).padStart(3, "0");
    } else {
        body = cropZeros(abs.toFixed(Math.min(100, Math.max(0, nd - decpt))));
    }
    return (neg ? "-" : "") + body;
}

function parseFilespec(filespec: string): { dir: string; pattern: string } {
    const normalized = filespec.replace(/\//g, "\\");
    const slash = normalized.lastIndexOf("\\");
    if (slash < 0) return { dir: ".", pattern: normalized };
    return { dir: normalized.slice(0, slash) || ".", pattern: normalized.slice(slash + 1) };
}

function matchWildcard(name: string, pattern: string): boolean {
    if (pattern === "*" || pattern === "*.*") return true;
    const re = new RegExp(
        "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
        "i",
    );
    return re.test(name);
}

/**
 * _A_* file-attribute bits used by _finddata_t.attrib — these are the Win32
 * FILE_ATTRIBUTE_* values, NOT the st_mode bits of struct _stat. Code that
 * separates files from subdirectories in a directory walk tests _A_SUBDIR, so a
 * mode-style value here reads as "no subdirectories exist".
 */
const A_NORMAL = 0x00;
const A_SUBDIR = 0x10;
const A_ARCH = 0x20;

/** __finddata64i32_t — attrib @0, 3×__time64_t, size @32, char name[260] @36. */
export const FINDDATA64I32_OFFSETS = {
    attrib: 0, time_create: 8, time_access: 16, time_write: 24, size: 32, name: 36,
} as const;
const FINDDATA64I32_SIZE = 296;
const FINDDATA64I32_NAME_CHARS = 260;

/** struct _finddata_t — attrib @0, 3×__time32_t, size @16, char name[260] @20. */
export const FINDDATA32_OFFSETS = {
    attrib: 0, time_create: 4, time_access: 8, time_write: 12, size: 16, name: 20,
} as const;
const FINDDATA32_SIZE = 280;
const FINDDATA32_NAME_CHARS = 260;

function findAttrib(entry: VfsEntry): number {
    return entry.kind === "dir" ? A_SUBDIR : (A_NORMAL | A_ARCH);
}

/**
 * The one timestamp every file carries: 2020-01-01 UTC, as time_t.
 *
 * The VFS keeps no per-file mtime, and leaving the fields at zero dates every file to the
 * epoch — a guest that compares a cache/save against its source then sees "1970" for both
 * operands, which is not a comparison anyone wrote code for. A single plausible instant makes
 * same-age the answer, and it is the SAME instant kernel32's BY_HANDLE_FILE_INFORMATION and
 * WIN32_FIND_DATA report, so the CRT and Win32 views of a file cannot disagree.
 */
const FIXED_TIME_T = 1577836800; // 2020-01-01T00:00:00Z

/** Write a time_t at `offset`; `wide` selects the 64-bit __time64_t layout. */
function writeTimeT(structPtr: number, offset: number, wide: boolean): void {
    Mem.writeUint32(structPtr + offset, FIXED_TIME_T);
    if (wide) Mem.writeUint32(structPtr + offset + 4, 0);
}

function writeFindName(structPtr: number, offset: number, chars: number, name: string): void {
    const nameBytes = new Uint8Array(chars);
    const nameLen = Math.min(name.length, chars - 1);
    for (let i = 0; i < nameLen; i++) nameBytes[i] = name.charCodeAt(i) & 0xff;
    Mem.writeBytes(structPtr + offset, nameBytes);
}

/** _finddata64i32_t: 64-bit timestamps, 32-bit size, char name[260]. */
function fillFindData64i32(structPtr: number, entry: VfsEntry, host: Vc9IoHost): void {
    host.memset(structPtr, 0, FINDDATA64I32_SIZE);
    writeFindName(structPtr, FINDDATA64I32_OFFSETS.name, FINDDATA64I32_NAME_CHARS, entry.name);
    Mem.writeUint32(structPtr + FINDDATA64I32_OFFSETS.size, entry.size >>> 0);
    Mem.writeUint32(structPtr + FINDDATA64I32_OFFSETS.attrib, findAttrib(entry));
    writeTimeT(structPtr, FINDDATA64I32_OFFSETS.time_create, true);
    writeTimeT(structPtr, FINDDATA64I32_OFFSETS.time_access, true);
    writeTimeT(structPtr, FINDDATA64I32_OFFSETS.time_write, true);
}

function fillFindData32(structPtr: number, entry: VfsEntry, host: Vc9IoHost): void {
    host.memset(structPtr, 0, FINDDATA32_SIZE);
    writeFindName(structPtr, FINDDATA32_OFFSETS.name, FINDDATA32_NAME_CHARS, entry.name);
    Mem.writeUint32(structPtr + FINDDATA32_OFFSETS.size, entry.size >>> 0);
    Mem.writeUint32(structPtr + FINDDATA32_OFFSETS.attrib, findAttrib(entry));
    writeTimeT(structPtr, FINDDATA32_OFFSETS.time_create, false);
    writeTimeT(structPtr, FINDDATA32_OFFSETS.time_access, false);
    writeTimeT(structPtr, FINDDATA32_OFFSETS.time_write, false);
}

/*
 * struct _stat family. st_mode is an `unsigned short` at +6 — it follows
 * `_dev_t st_dev` (4) + `_ino_t st_ino` (2) — and every variant keeps that
 * prefix; only st_size's width/offset and the time_t width differ. A mode
 * written as a dword at +4 lands in st_ino and leaves st_mode zero, so
 * `st_mode & _S_IFDIR` / `& _S_IFREG` are false for everything and a directory
 * probe can never succeed.
 */
export const STAT32_OFFSETS = {
    st_dev: 0, st_ino: 4, st_mode: 6, st_nlink: 8, st_uid: 10, st_gid: 12,
    st_rdev: 16, st_size: 20, st_atime: 24, st_mtime: 28, st_ctime: 32,
} as const;
/** _stat64i32: 64-bit time_t, 32-bit st_size. */
export const STAT64I32_OFFSETS = {
    st_dev: 0, st_ino: 4, st_mode: 6, st_nlink: 8, st_uid: 10, st_gid: 12,
    st_rdev: 16, st_size: 20, st_atime: 24, st_mtime: 32, st_ctime: 40,
} as const;
/** __stat64: 64-bit time_t AND 64-bit st_size (8-aligned, hence the gap at +20). */
export const STAT64_OFFSETS = {
    st_dev: 0, st_ino: 4, st_mode: 6, st_nlink: 8, st_uid: 10, st_gid: 12,
    st_rdev: 16, st_size: 24, st_atime: 32, st_mtime: 40, st_ctime: 48,
} as const;
/** _stati64: 32-bit time_t, 64-bit st_size — the classic msvcrt large-file variant. */
export const STATI64_OFFSETS = {
    st_dev: 0, st_ino: 4, st_mode: 6, st_nlink: 8, st_uid: 10, st_gid: 12,
    st_rdev: 16, st_size: 24, st_atime: 32, st_mtime: 36, st_ctime: 40,
} as const;

const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;
/** rwx for owner + the group/other copies the CRT makes; _S_IEXEC only for dirs. */
const MODE_FILE = S_IFREG | 0x1b6;      // 0x81b6 — rw-rw-rw-
const MODE_DIR = S_IFDIR | 0x1ff;       // 0x41ff — rwxrwxrwx

/** st_mode/st_nlink/st_size, written at the offsets of the requested variant. */
export function fillStatStruct(
    structPtr: number,
    offsets: typeof STAT32_OFFSETS | typeof STAT64I32_OFFSETS | typeof STAT64_OFFSETS | typeof STATI64_OFFSETS,
    totalSize: number,
    size: number,
    isDir: boolean,
    memset: (ptr: number, val: number, size: number) => unknown,
): void {
    memset(structPtr, 0, totalSize);
    Mem.writeUint16(structPtr + offsets.st_mode, isDir ? MODE_DIR : MODE_FILE);
    Mem.writeUint16(structPtr + offsets.st_nlink, 1);
    Mem.writeUint32(structPtr + offsets.st_size, isDir ? 0 : size >>> 0);
    // A 64-bit st_size is what pushes st_atime 8 bytes past it; a 32-bit one leaves 4.
    if (offsets.st_atime - offsets.st_size === 8) Mem.writeUint32(structPtr + offsets.st_size + 4, 0);
    // 64-bit time_t is what puts st_mtime 8 bytes after st_atime; _stat's is 4.
    const wideTime = offsets.st_mtime - offsets.st_atime === 8;
    writeTimeT(structPtr, offsets.st_atime, wideTime);
    writeTimeT(structPtr, offsets.st_mtime, wideTime);
    writeTimeT(structPtr, offsets.st_ctime, wideTime);
}

/** __stat64 (56 bytes) — 64-bit st_size. */
function fillStat64(structPtr: number, size: number, isDir: boolean, host: Vc9IoHost): void {
    fillStatStruct(structPtr, STAT64_OFFSETS, 56, size, isDir, host.memset.bind(host));
}

/** _stat64i32 (48 bytes) — the layout `_stat64i32`/`_fstat64i32` actually take. */
function fillStat64i32(structPtr: number, size: number, isDir: boolean, host: Vc9IoHost): void {
    fillStatStruct(structPtr, STAT64I32_OFFSETS, 48, size, isDir, host.memset.bind(host));
}

/** struct _stati64 (48 bytes) — 64-bit st_size, 32-bit time_t. */
function fillStati64(structPtr: number, size: number, isDir: boolean, host: Vc9IoHost): void {
    fillStatStruct(structPtr, STATI64_OFFSETS, 48, size, isDir, host.memset.bind(host));
}

/** struct _stat (36 bytes) — 32-bit time_t and st_size. */
function fillStat32(structPtr: number, size: number, isDir: boolean, host: Vc9IoHost): void {
    fillStatStruct(structPtr, STAT32_OFFSETS, 36, size, isDir, host.memset.bind(host));
}

/**
 * asctime's string scratch and _localtime64's struct tm are SEPARATE statics, as
 * in the real CRT: asctime(localtime(t)) is a legal call, and one shared buffer
 * has the formatted text land on top of the tm being read.
 */
let asctimeBuf = 0;
let localtime64Buf = 0;

/** Both live in memory Process.reset() rewinds — forget them with it (see crt-time). */
export function resetVc9TimeStatics(): void {
    asctimeBuf = 0;
    localtime64Buf = 0;
}

export function registerVc9IoExports(exports: Record<string, ThunkImplementation>, host: Vc9IoHost): void {
    /** Path stat shared by every by-name variant: a directory is a legal stat target. */
    const statByPath = (
        pathPtr: number,
        structPtr: number,
        fill: (ptr: number, size: number, isDir: boolean, h: Vc9IoHost) => void,
    ): number => {
        if (!pathPtr || !structPtr) {
            host.setErrno(22);
            return -1;
        }
        const path = host.readCString(pathPtr, 512);
        const vfs = System.getInstance().fileSystem;
        if (vfs.directoryExists(path)) {
            fill(structPtr, 0, true, host);
            return 0;
        }
        if (!(vfs.hasRomFile(path) || vfs.openSync(path, 0x80000000, 3) !== null)) {
            host.setErrno(2);
            return -1;
        }
        fill(structPtr, vfs.getFileSize(path), false, host);
        return 0;
    };
    const statByFd = (
        fd: number,
        structPtr: number,
        fill: (ptr: number, size: number, isDir: boolean, h: Vc9IoHost) => void,
    ): number => {
        if (!structPtr) {
            host.setErrno(22);
            return -1;
        }
        const len = host.filelength(fd);
        if (len < 0) {
            host.setErrno(9);
            return -1;
        }
        fill(structPtr, len, false, host);
        return 0;
    };

    exports["_stat64i32"] = (_ctx, _mem, args) => statByPath(args[0] ?? 0, args[1] ?? 0, fillStat64i32);
    exports["_stat64"] = (_ctx, _mem, args) => statByPath(args[0] ?? 0, args[1] ?? 0, fillStat64);
    exports["_fstat64i32"] = (_ctx, _mem, args) => statByFd(args[0] ?? 0, args[1] ?? 0, fillStat64i32);
    exports["_fstat64"] = (_ctx, _mem, args) => statByFd(args[0] ?? 0, args[1] ?? 0, fillStat64);
    exports["_fstat"] = (_ctx, _mem, args) => statByFd(args[0] ?? 0, args[1] ?? 0, fillStat32);
    exports["_stati64"] = (_ctx, _mem, args) => statByPath(args[0] ?? 0, args[1] ?? 0, fillStati64);
    exports["_fstati64"] = (_ctx, _mem, args) => statByFd(args[0] ?? 0, args[1] ?? 0, fillStati64);

    /**
     * Shared body of the _findfirst variants: they differ only in the _finddata_t
     * layout they fill.
     */
    const findFirstImpl = (
        filespecPtr: number,
        dataPtr: number,
        fill: (structPtr: number, entry: VfsEntry, h: Vc9IoHost) => void,
    ): number => {
        if (!filespecPtr || !dataPtr) {
            host.setErrno(22);
            return -1;
        }
        const { dir, pattern } = parseFilespec(host.readCString(filespecPtr, 512));
        const vfs = System.getInstance().fileSystem;
        const cwd = (System.getInstance() as { currentDirectory?: string }).currentDirectory || "C:\\";
        let searchDir = dir;
        if (!searchDir.match(/^[A-Za-z]:/)) {
            searchDir = cwd.endsWith("\\") ? cwd + searchDir : `${cwd}\\${searchDir}`;
        }

        let matched: VfsEntry[];
        // A filespec with no wildcard is an existence check, not an enumeration —
        // stat the one name instead of listing (and pattern-matching) the directory.
        // Same fast path as FindFirstFileA/W.
        if (pattern && !/[*?]/.test(pattern)) {
            const entry = vfs.statEntry(searchDir.endsWith("\\") ? searchDir + pattern : `${searchDir}\\${pattern}`);
            matched = entry ? [entry] : [];
        } else {
            matched = vfs.listDirectory(searchDir).filter((e) => matchWildcard(e.name, pattern));
        }
        if (matched.length === 0) {
            host.setErrno(2);
            return -1;
        }
        const handle = nextFindHandle++;
        findHandles.set(handle, { entries: matched, index: 0 });
        fill(dataPtr, matched[0]!, host);
        return handle;
    };

    exports["_findfirst64i32"] = (_ctx, _mem, args) =>
        findFirstImpl(args[0] ?? 0, args[1] ?? 0, fillFindData64i32);

    exports["_findfirst"] = (_ctx, _mem, args) =>
        findFirstImpl(args[0] ?? 0, args[1] ?? 0, fillFindData32);

    exports["_findnext64i32"] = (_ctx, _mem, args) => {
        const handle = args[0] ?? 0;
        const dataPtr = args[1] ?? 0;
        const state = findHandles.get(handle);
        if (!state || !dataPtr) {
            host.setErrno(18);
            return -1;
        }
        state.index++;
        if (state.index >= state.entries.length) {
            host.setErrno(18);
            return -1;
        }
        fillFindData64i32(dataPtr, state.entries[state.index]!, host);
        return 0;
    };

    exports["_findnext"] = (_ctx, _mem, args) => {
        const handle = args[0] ?? 0;
        const dataPtr = args[1] ?? 0;
        const state = findHandles.get(handle);
        if (!state || !dataPtr) {
            host.setErrno(18);
            return -1;
        }
        state.index++;
        if (state.index >= state.entries.length) {
            host.setErrno(18);
            return -1;
        }
        fillFindData32(dataPtr, state.entries[state.index]!, host);
        return 0;
    };

    exports["_findclose"] = (_ctx, _mem, args) => {
        const handle = args[0] ?? 0;
        if (!findHandles.delete(handle)) {
            host.setErrno(9);
            return -1;
        }
        return 0;
    };

    exports["_filelengthi64"] = (_ctx, _mem, args) => {
        const fd = args[0] ?? 0;
        const len = host.filelength(fd);
        if (len < 0) return -1;
        const cpu = getCPU(host.process.v86);
        if (cpu?.reg32) cpu.reg32[2] = 0;
        return len >>> 0;
    };

    exports["_ftelli64"] = (_ctx, _mem, args) => {
        const pos = host.ftell(args[0] ?? 0);
        if (pos < 0) return -1;
        const cpu = getCPU(host.process.v86);
        if (cpu?.reg32) cpu.reg32[2] = 0;
        return pos >>> 0;
    };

    exports["_fseeki64"] = (_ctx, _mem, args) => {
        const filePtr = args[0] ?? 0;
        const offsetLo = args[1] ?? 0;
        const origin = args[2] ?? 0;
        return host.fseek(filePtr, offsetLo | 0, origin);
    };

    exports["_time64"] = (_ctx, _mem, args) => {
        const timerPtr = args[0] ?? 0;
        const secs = Math.floor(Date.now() / 1000);
        const lo = secs >>> 0;
        const hi = Math.floor(secs / 0x100000000) | 0;
        if (timerPtr) {
            Mem.writeUint32(timerPtr, lo);
            Mem.writeUint32(timerPtr + 4, hi);
        }
        const cpu = getCPU(host.process.v86);
        if (cpu?.reg32) cpu.reg32[2] = hi;
        return lo;
    };

    exports["_localtime64"] = (_ctx, _mem, args) => {
        const timePtr = args[0] ?? 0;
        if (!timePtr) return 0;
        const lo = Mem.readUint32(timePtr) ?? 0;
        const hi = Mem.readUint32(timePtr + 4) ?? 0;
        const secs = lo + hi * 0x100000000;
        const date = new Date(secs * 1000);
        if (!localtime64Buf) {
            localtime64Buf = host.malloc(36);
        }
        const buf = localtime64Buf;
        Mem.writeUint32(buf + 0, date.getSeconds());
        Mem.writeUint32(buf + 4, date.getMinutes());
        Mem.writeUint32(buf + 8, date.getHours());
        Mem.writeUint32(buf + 12, date.getDate());
        Mem.writeUint32(buf + 16, date.getMonth());
        Mem.writeUint32(buf + 20, date.getFullYear() - 1900);
        Mem.writeUint32(buf + 24, date.getDay());
        const start = new Date(date.getFullYear(), 0, 1);
        const yday = Math.floor((date.getTime() - start.getTime()) / 86400000);
        Mem.writeUint32(buf + 28, yday);
        Mem.writeUint32(buf + 32, date.getTimezoneOffset() > 0 ? 1 : 0);
        return buf >>> 0;
    };

    exports["asctime"] = (_ctx, _mem, args) => {
        const tmPtr = args[0] ?? 0;
        if (!tmPtr) return 0;
        const mon = Mem.readUint32(tmPtr + 16) ?? 0;
        const mday = Mem.readUint32(tmPtr + 12) ?? 0;
        const hour = Mem.readUint32(tmPtr + 8) ?? 0;
        const min = Mem.readUint32(tmPtr + 4) ?? 0;
        const sec = Mem.readUint32(tmPtr + 0) ?? 0;
        const year = (Mem.readUint32(tmPtr + 20) ?? 0) + 1900;
        const wday = Mem.readUint32(tmPtr + 24) ?? 0;
        const text = formatAsctime(wday, mon, mday, hour, min, sec, year);
        if (!asctimeBuf) asctimeBuf = host.malloc(32);
        host.writeCString(asctimeBuf, text);
        return asctimeBuf >>> 0;
    };

    exports["fscanf"] = (_ctx, _mem, args) => {
        const filePtr = args[0] ?? 0;
        const fmtPtr = args[1] ?? 0;
        if (!filePtr || !fmtPtr) return -1;
        const stream = host.fileStreams.get(filePtr);
        if (!stream) return -1;
        const format = host.readCString(fmtPtr, 4096);
        // Minimal: no stream read — use empty input unless fgets buffer exists
        const input = "";
        let argIdx = 2;
        const reader = new ArrayVaListReader(args, argIdx);
        return scanCLazy(
            input,
            format,
            (addr, v) => Mem.writeUint32(addr, v >>> 0),
            (addr, v) => {
                const buf = new ArrayBuffer(8);
                const f = new Float64Array(buf);
                f[0] = v;
                const u = new Uint32Array(buf);
                Mem.writeUint32(addr, u[0] ?? 0);
                Mem.writeUint32(addr + 4, u[1] ?? 0);
            },
            () => reader.nextUint32(),
        );
    };

    /**
     * char *_gcvt(double value, int ndec, char *buf) — cdecl, so the double occupies
     * TWO stack dwords: args = [valueLo, valueHi, ndec, buf].
     *
     * Faithful to CRT gcvt.c: Fortran-G selection on the decimal magnitude of the
     * value ROUNDED to ndec significant digits (magnitude = decpt-1; E format when
     * magnitude < -1 || magnitude > ndec-1, else F format with ndec-decpt fraction
     * digits), then trailing fraction zeros are cropped while the decimal point is
     * KEPT ("3.000" -> "3."), and the exponent uses the VC three-digit "e+000" form.
     * The real one does no range checking, but a JS RangeError out of
     * toExponential/toFixed would abandon the thunk mid-stack, so ndec is clamped to
     * the 1..100 those accept.
     */
    exports["_gcvt"] = (_ctx, _mem, args) => {
        const bufPtr = (args[3] ?? 0) >>> 0;
        if (!bufPtr) return 0;
        const conv = new ArrayBuffer(8);
        const u32 = new Uint32Array(conv);
        u32[0] = (args[0] ?? 0) >>> 0;
        u32[1] = (args[1] ?? 0) >>> 0;
        host.writeCString(bufPtr, gcvtFormat(new Float64Array(conv)[0] ?? 0, (args[2] ?? 0) | 0));
        return bufPtr;
    };
}
