/**
 * Kernel32 File I/O functions
 *
 * Atomic implementation for file operations
 */

import { ThunkImplementation, ThunkResult, DeferredWrite } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { registerFileIoCommExports } from './file-io-comm';
import { registerFileIoConsoleExports, ConsoleDeviceHandle, isConsoleDeviceHandle, isWindowsDevice } from './file-io-console';
import { registerFileIoFindExports } from './file-io-find';
import { registerFileIoVolumeExports } from './file-io-volume';
import { registerFileIoPathExports } from './file-io-path';
import { readStringA, readStringW } from './file-io-strings';
import { MemoryGuard } from '../../core/memory/mem-guard';
import { Mem } from '../../core/memory/mem-accessor';
import { System } from '../../core/system';
import { Process } from '../../core/process';
import { VfsFileHandle, VirtualFileSystem } from '../../runtime/filesystem/vfs';
import { noteBootFileActivity } from '../../runtime/boot-status';
import { EmulatorConfig } from '../../core/emulator-config-manager';
import { encodeAnsi, getCodePageDecoder } from '../codepage-utils';
import {
    classifyUe1FirstRunFile,
    dirOfWindowsPath,
    baseOfWindowsPath,
    pinUeEngineIni,
    detectUe2PcPackages,
} from '../../runtime/filesystem/ue1-firstrun';
import { invalidateIniCache } from './profile';
import { namedObjects } from './named-objects';
import { LARGE_IO_TRACE_ENABLED, traceLargeRead } from '../../core/diagnostics/large-io-trace';
import { ioTraceRing } from '../../core/debug/io-trace-ring';
import { hypercallDataManager } from '../../core/cpu/hypercall-data';
import { postFileIoCompletion, abandonIoCompletionWaiters, dissociateIoCompletionHandle } from './sync';

const readFileFirstLogged = new Set<number>();
let shortReadLogCount = 0;
// A handle whose file position is driven from two threads is a race the guest can only
// win by serialising itself: SetFilePointer and ReadFile are separate calls, and our
// scheduler preempts between them. Reported once per handle — the pair reads the wrong
// offset and the caller sees plausible-looking garbage, not an error.
const readFileLastThread = new Map<number, number>();
let sharedHandleLogCount = 0;
function noteReadFileThread(hFile: number, path: string): void {
    const tid = System.getInstance().scheduler.getCurrentThread()?.id ?? 0;
    const prev = readFileLastThread.get(hFile);
    if (prev === undefined) { readFileLastThread.set(hFile, tid); return; }
    if (prev !== tid && sharedHandleLogCount < 20) {
        sharedHandleLogCount++;
        Logger.warn(LogCategory.KERNEL32,
            `[SHAREDHANDLE] h=0x${hFile.toString(16)} "${path}" read from T${prev} and T${tid}`);
    }
    readFileLastThread.set(hFile, tid);
}

const RW_RASTER_NAMES: Record<number, string> = {
    0x0100: "1555",
    0x0200: "565",
    0x0300: "4444",
    0x0400: "LUM8",
    0x0500: "8888",
    0x0600: "888",
};

function normalizeWinPath(path: string): string {
    return path.toLowerCase().replace(/\//g, "\\");
}

function isCapsDatPath(path: string): boolean {
    return normalizeWinPath(path).endsWith("caps.dat");
}

function isTxdImgPath(path: string): boolean {
    return normalizeWinPath(path).endsWith("txd.img");
}

function logCapsDatDwords(tag: string, mem: Uint8Array, bufOffset: number, byteLen: number): void {
    if (byteLen < 4 || bufOffset + 4 > mem.length) return;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const count = Math.min(4, Math.floor(byteLen / 4));
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
        const v = view.getUint32(bufOffset + i * 4, true);
        const rw = RW_RASTER_NAMES[v & 0x0f00] ?? "?";
        parts.push(`0x${v.toString(16)}(${rw})`);
    }
    Logger.log(LogCategory.KERNEL32, `CAPS.DAT ${tag}: [${parts.join(", ")}] (bake ref: 0x500, 0x600, 0x100, 0x500)`);
}

/**
 * Wrapper class for VfsFileHandle that provides methods expected by file I/O functions
 */
class FileHandleWrapper {
    private handle: VfsFileHandle;
    private vfs: VirtualFileSystem;

    constructor(handle: VfsFileHandle, vfs: VirtualFileSystem) {
        this.handle = handle;
        this.vfs = vfs;
        // Surface "loading <asset>" to the host overlay during the boot window
        // (no-op outside it). Single chokepoint for every guest file open.
        noteBootFileActivity(handle.path, handle.source);
    }

    get vfsHandle(): VfsFileHandle {
        return this.handle;
    }

    get position(): number {
        return this.handle.position;
    }

    get size(): number {
        return this.vfs.getFileSize(this.handle.path);
    }

    /**
     * Synchronous read for fast-path (cached ROM files)
     * Returns null if async read is needed
     */
    readSync(length: number): Uint8Array | null {
        return this.vfs.readSync(this.handle, length);
    }

    /**
     * Read directly into target buffer (no intermediate allocation). Returns bytes read or null if async needed.
     */
    readIntoSync(target: Uint8Array, targetOffset: number, length: number): number | null {
        return this.vfs.readIntoSync(this.handle, target, targetOffset, length);
    }

    async read(length: number): Promise<Uint8Array> {
        return await this.vfs.read(this.handle, length);
    }

    /**
     * Read directly into target buffer (avoids double buffer + large temp alloc on big reads e.g. LOD).
     */
    async readInto(target: Uint8Array, targetOffset: number, length: number): Promise<number> {
        return await this.vfs.readInto(this.handle, target, targetOffset, length);
    }

    async write(data: Uint8Array): Promise<number> {
        return await this.vfs.write(this.handle, data);
    }

    seek(position: number): void {
        this.vfs.setPosition(this.handle, position, 0);
    }

    close(): void {
        // Flush pending writes for this file, if any
        this.vfs.flushFile(this.handle.path).catch((error) => {
            Logger.warn(LogCategory.KERNEL32, `Flush on close failed for "${this.handle.path}": ${error}`);
        });
    }
}

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;
const CREATE_ALWAYS = 2;

/**
 * Generic Unreal Engine 1 first-run handler — reactive layer at the file-open
 * boundary. UE1 games READ their render-detection output (Detected.ini) and
 * their lazily-copied active config (e.g. HP.ini / User.ini) with OPEN_EXISTING;
 * if either is missing the game stalls. The active-config directory is baked
 * into the exe (some titles redirect to C:\My Documents\<GameFolder>) — unknown at build
 * time — so we learn it from the game's own Detected.* request, then materialize
 * the missing files into the CoW overlay.
 *
 * Conservative by construction: only fires when (a) the bundle is UE1, (b) the
 * disposition is OPEN_EXISTING, (c) the access requests read, (d) the file is
 * genuinely MISSING, and (e) the basename matches our patterns. Returns true if
 * it materialized a file (the caller should then re-attempt the normal open,
 * which will now succeed). Never overwrites an existing file; never acts on
 * write dispositions (the engine/game owns those).
 *
 * Mirrors shell32 applyShellExecFake's overlay file-creation: ensureParentDirsSync
 * (mkdir -p), then open(GENERIC_WRITE, CREATE_ALWAYS) → write → flushFile, plus
 * invalidateIniCache for *.ini.
 */
async function tryUe1FirstRunMaterialize(
    filename: string,
    dwDesiredAccess: number,
    dwCreationDisposition: number,
): Promise<boolean> {
    const config = EmulatorConfig.getInstance();
    if (!config.ue1) return false;
    if ((dwCreationDisposition >>> 0) !== OPEN_EXISTING) return false;
    if ((dwDesiredAccess & GENERIC_READ) === 0) return false;
    if (!filename) return false;

    const vfs = System.getInstance().fileSystem;

    // Only act on a genuine miss — never clobber an existing file.
    if (vfs.openSync(filename, GENERIC_READ, OPEN_EXISTING) !== null) return false;

    const full = vfs.resolvePath(filename);
    const dir = dirOfWindowsPath(full);
    const base = baseOfWindowsPath(full);
    const inUserDir = config.ue1UserDir !== null && dir.toLowerCase() === config.ue1UserDir.toLowerCase();
    const kind = classifyUe1FirstRunFile(base, inUserDir);
    if (kind === null) return false;

    const materialize = async (path: string, data: Uint8Array, sourceDesc: string): Promise<boolean> => {
        try {
            vfs.ensureParentDirsSync(path);
            const h = await vfs.open(path, GENERIC_WRITE, CREATE_ALWAYS);
            if (!h) {
                Logger.warn(LogCategory.SYSTEM, `UE1: could not create "${path}" (parent missing?)`);
                return false;
            }
            if (data.length > 0) await vfs.write(h, data);
            await vfs.flushFile(h.path);
            if (path.toLowerCase().endsWith('.ini')) invalidateIniCache(path);
            Logger.log(LogCategory.SYSTEM, `UE1 first-run: materialized "${path}" (${data.length} bytes, source=${sourceDesc})`);
            return true;
        } catch (err) {
            Logger.warn(LogCategory.SYSTEM, `UE1: materialize "${path}" failed: ${err}`);
            return false;
        }
    };

    const readSource = async (srcPath: string): Promise<Uint8Array | null> => {
        const src = await vfs.open(srcPath, GENERIC_READ, OPEN_EXISTING);
        if (!src) return null;
        const size = vfs.getFileSize(srcPath);
        return size > 0 ? await vfs.read(src, size) : new Uint8Array(0);
    };

    if (kind === 'detected') {
        // Render-detection output the game reads but never finds: an empty file is
        // enough to let the OPEN_EXISTING succeed and the game proceed. Learn the
        // containing directory as the UE1 user dir for subsequent config seeding.
        const ok = await materialize(full, new Uint8Array(0), 'empty');
        if (ok && dir) {
            config.ue1UserDir = dir;
            Logger.log(LogCategory.SYSTEM, `UE1 first-run: learned user dir "${dir}" from "${base}"`);
        }
        return ok;
    }

    if (kind === 'user-ini') {
        // Active key-bindings config — seed from the factory DefUser.ini template.
        const data = await readSource('C:\\System\\DefUser.ini');
        if (data === null) {
            Logger.warn(LogCategory.SYSTEM, `UE1: cannot seed "${full}" — System\\DefUser.ini missing`);
            return false;
        }
        return await materialize(full, data, 'System\\DefUser.ini');
    }

    // kind === 'ini': active settings config — seed from Default.ini, pinning our
    // D3D render device (reproduces what the curated HP.ini did by hand).
    const raw = await readSource('C:\\System\\Default.ini');
    if (raw === null) {
        Logger.warn(LogCategory.SYSTEM, `UE1: cannot seed "${full}" — System\\Default.ini missing`);
        return false;
    }
    const hasPcPackages = detectUe2PcPackages((guestPath) => System.getInstance().fileSystem.getFileSize(guestPath) > 0);
    const pinned = pinUeEngineIni(new TextDecoder('utf-8').decode(raw), { hasPcPackages });
    return await materialize(full, new TextEncoder().encode(pinned), 'System\\Default.ini (engine-pinned)');
}

const fileIoModule = (() => {
    const exports: Record<string, ThunkImplementation> = {};
    const SET_FILE_POINTER_LOG_FIRST_N = 8;
    const SET_FILE_POINTER_LOG_SAMPLE_EVERY = 512;
    const setFilePointerCallCounts: Map<number, number> = new Map();

    function shouldLogSetFilePointer(handle: number): boolean {
        const count = (setFilePointerCallCounts.get(handle) ?? 0) + 1;
        setFilePointerCallCounts.set(handle, count);
        return count <= SET_FILE_POINTER_LOG_FIRST_N || (count % SET_FILE_POINTER_LOG_SAMPLE_EVERY) === 0;
    }

    // Standard file handles
    const STD_INPUT_HANDLE = -10;
    const STD_OUTPUT_HANDLE = -11;
    const STD_ERROR_HANDLE = -12;

    const INVALID_HANDLE_VALUE = -1;
    const HFILE_ERROR = -1;

    // Win32 Error Codes
    const ERROR_FILE_NOT_FOUND = 2;
    const ERROR_PATH_NOT_FOUND = 3;
    const ERROR_ACCESS_DENIED = 5;
    const ERROR_INVALID_HANDLE = 6;
    const ERROR_INVALID_PARAMETER = 87;
    const ERROR_INSUFFICIENT_BUFFER = 122;
    const ERROR_INVALID_NAME = 123;
    const ERROR_MORE_DATA = 234;
    const ERROR_ALREADY_EXISTS = 183;
    const ERROR_NO_MORE_FILES = 18;
    const ERROR_SEEK = 25;
    const ERROR_NOACCESS = 998;
    const ERROR_IO_DEVICE = 1117;
    const INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF;

    const FILE_ATTRIBUTE_DIRECTORY = 0x10;
    const FILE_ATTRIBUTE_ARCHIVE = 0x20;
    const FILE_ATTRIBUTE_NORMAL = 0x80;

    interface FileMappingObject {
        kind: 'file_mapping';
        size: number;
        fileHandle: number | null;
        protect: number;
    }

    const namedFileMappings: Map<string, number> = new Map();
    // Tracks live mapped views so UnmapViewOfFile/FlushViewOfFile can write dirty
    // bytes back to the backing VFS file. offset/fileHandle/writable are required
    // for the write-back: without them a mapped view is effectively read-only and
    // any data the guest writes through the view is silently lost (some titles save
    // profiles via CreateFileMapping+MapViewOfFile, no WriteFile).
    const fileMappingViews: Map<number, { mappingHandle: number; size: number; offset: number; fileHandle: number | null; writable: boolean }> = new Map();

    // MapViewOfFile dwDesiredAccess flags
    const FILE_MAP_COPY = 0x0001;
    const FILE_MAP_WRITE = 0x0002;
    const FILE_MAP_ALL_ACCESS = 0xf001f;
    // PAGE protection flags that imply a writable mapping
    const PAGE_WRITE_MASK = 0x04 /*PAGE_READWRITE*/ | 0x08 /*PAGE_WRITECOPY*/ | 0x40 /*PAGE_EXECUTE_READWRITE*/ | 0x80 /*PAGE_EXECUTE_WRITECOPY*/;

    // Write a mapped view's current guest-memory contents back to its backing VFS
    // file at the mapped offset. No-op for anonymous (pagefile-backed), read-only,
    // or copy-on-write views.
    const flushMappedView = async (base: number, view: { size: number; offset: number; fileHandle: number | null; writable: boolean }): Promise<void> => {
        if (!view.writable || view.fileHandle === null) return;
        const resourceProvider = System.getInstance().resourceProvider;
        const fileObj = resourceProvider.getFileHandle(view.fileHandle);
        if (!fileObj || isConsoleDeviceHandle(fileObj)) return;
        const data = Mem.readBytes(base, view.size);
        if (!data) return;
        const vfs = System.getInstance().fileSystem;
        // Write-back runs on its OWN cursor. FlushViewOfFile does not move the file
        // pointer, and a save/restore around these awaits cannot emulate that: the guest
        // may legitimately seek during the yield, and the restore then reverts its seek.
        const viewHandle = vfs.duplicateHandle((fileObj as FileHandleWrapper).vfsHandle, view.offset);
        let off = 0;
        while (off < data.length) {
            const chunk = data.subarray(off, Math.min(off + 256 * 1024, data.length));
            const written = await vfs.write(viewHandle, chunk);
            if (written <= 0) break;
            off += written;
        }
    };

    const writeUint16 = (addr: number, value: number): void => {
        Mem.writeBytes(addr, new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
    };

    const writeUint8 = (addr: number, value: number): void => {
        Mem.writeBytes(addr, new Uint8Array([value & 0xff]));
    };

    exports['GetStdHandle'] = (ctx, mem, args) => {
        const nStdHandle = args[0] | 0;
        Logger.verbose(LogCategory.KERNEL32, `GetStdHandle(${nStdHandle})`);

        switch (nStdHandle) {
            case STD_INPUT_HANDLE:
                return 0; // stdin
            case STD_OUTPUT_HANDLE:
                return 1; // stdout
            case STD_ERROR_HANDLE:
                return 2; // stderr
            default:
                return INVALID_HANDLE_VALUE;
        }
    };

    // BOOL CancelIo(HANDLE hFile)
    // Cancels all pending async I/O operations issued by the calling thread for hFile.
    // BottleShip completes all file I/O synchronously, so there is never anything to
    // cancel. We validate the handle enough to catch bogus pointers and succeed quietly.
    exports['CancelIo'] = (ctx, mem, args) => {
        const hFile = args[0] >>> 0;

        // Pseudo-handles for standard streams — always OK.
        if (hFile === 0 || hFile === 1 || hFile === 2) {
            Logger.verbose(LogCategory.KERNEL32, `CancelIo(std=${hFile}) -> TRUE`);
            System.getInstance().scheduler.setLastError(0);
            return 1; // TRUE
        }

        const fileHandle = System.getInstance().resourceProvider.getFileHandle(hFile);
        if (!fileHandle) {
            Logger.warn(LogCategory.KERNEL32, `CancelIo(0x${hFile.toString(16)}) -> ERROR_INVALID_HANDLE`);
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0; // FALSE
        }

        Logger.verbose(LogCategory.KERNEL32, `CancelIo(0x${hFile.toString(16)}) -> TRUE (no pending I/O)`);
        System.getInstance().scheduler.setLastError(0);
        return 1; // TRUE
    };

    exports['GetFileType'] = (ctx, mem, args) => {
        const hFile = args[0];
        Logger.verbose(LogCategory.KERNEL32, `GetFileType(0x${hFile.toString(16)})`);

        // FILE_TYPE_CHAR = 0x02 for console handles
        if (hFile >= 0 && hFile <= 2) {
            return 0x02; // FILE_TYPE_CHAR
        }

        // Check if this is a console device handle
        const resourceProvider = System.getInstance().resourceProvider;
        const fileHandle = resourceProvider.getFileHandle(hFile);
        if (fileHandle && isConsoleDeviceHandle(fileHandle)) {
            return 0x02; // FILE_TYPE_CHAR
        }

        return 0x01; // FILE_TYPE_DISK
    };

    registerFileIoCommExports(exports);
    registerFileIoConsoleExports(exports);
    registerFileIoFindExports(exports);
    registerFileIoVolumeExports(exports);
    registerFileIoPathExports(exports);

    exports['CreateDirectoryA'] = (ctx, mem, args) => {
        const lpPathName = args[0];
        const path = lpPathName ? readStringA(mem, lpPathName) : '';
        Logger.log(LogCategory.KERNEL32, `CreateDirectoryA("${path}")`);

        if (/^[A-Za-z]:\\?$/.test(path.trim())) {
            System.getInstance().scheduler.setLastError(0);
            return 1;
        }

        const vfs = System.getInstance().fileSystem;
        const result = vfs.createDirectorySync(path);
        if (result.ok) {
            System.getInstance().scheduler.setLastError(0);
            return 1;
        }
        System.getInstance().scheduler.setLastError(result.error);
        return 0;
    };

    exports['CreateDirectoryW'] = (ctx, mem, args) => {
        const lpPathName = args[0];
        const path = lpPathName ? readStringW(mem, lpPathName) : '';
        Logger.log(LogCategory.KERNEL32, `CreateDirectoryW("${path}")`);

        if (/^[A-Za-z]:\\?$/.test(path.trim())) {
            System.getInstance().scheduler.setLastError(0);
            return 1;
        }

        const vfs = System.getInstance().fileSystem;
        const result = vfs.createDirectorySync(path);
        if (result.ok) {
            System.getInstance().scheduler.setLastError(0);
            return 1;
        }
        System.getInstance().scheduler.setLastError(result.error);
        return 0;
    };

    const removeDirectoryImpl = async (path: string): Promise<number> => {
        if (!path) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        const result = await System.getInstance().fileSystem.removeDirectory(path);
        if (result.ok) {
            System.getInstance().scheduler.setLastError(0);
            return 1;
        }
        System.getInstance().scheduler.setLastError(result.error);
        return 0;
    };

    exports['RemoveDirectoryA'] = async (ctx, mem, args) => {
        const lpPathName = args[0];
        const path = lpPathName ? readStringA(mem, lpPathName) : '';
        const result = await removeDirectoryImpl(path);
        Logger.log(LogCategory.KERNEL32, `RemoveDirectoryA("${path}") -> ${result ? 'OK' : `FAILED err=${System.getInstance().scheduler.getLastError()}`}`);
        return result;
    };

    exports['RemoveDirectoryW'] = async (ctx, mem, args) => {
        const lpPathName = args[0];
        const path = lpPathName ? readStringW(mem, lpPathName) : '';
        const result = await removeDirectoryImpl(path);
        Logger.log(LogCategory.KERNEL32, `RemoveDirectoryW("${path}") -> ${result ? 'OK' : `FAILED err=${System.getInstance().scheduler.getLastError()}`}`);
        return result;
    };

    exports['CreateFileA'] = (ctx, mem, args) => {
        const perfStart = performance.now();
        const lpFileName = args[0];
        const dwDesiredAccess = args[1];
        const dwShareMode = args[2];
        const lpSecurityAttributes = args[3]; // unused
        const dwCreationDisposition = args[4];
        const dwFlagsAndAttributes = args[5];
        const hTemplateFile = args[6]; // unused

        const filename = lpFileName ? readStringA(mem, lpFileName) : '';
        Logger.log(LogCategory.KERNEL32, `CreateFileA("${filename}", access=0x${dwDesiredAccess.toString(16)}, disposition=${dwCreationDisposition})`);

        // Check for Windows special devices before VFS
        const deviceType = isWindowsDevice(filename);
        if (deviceType !== null) {
            Logger.verbose(LogCategory.KERNEL32, `CreateFileA: opening Windows device "${filename}" as ${deviceType}`);
            const consoleHandle = new ConsoleDeviceHandle(deviceType);
            const resourceProvider = System.getInstance().resourceProvider;
            const handleId = resourceProvider.registerFileHandle(consoleHandle);
            Logger.verbose(LogCategory.KERNEL32, `CreateFileA: opened console device handle 0x${handleId.toString(16)}`);
            return handleId;
        }

        const vfs = System.getInstance().fileSystem;

        // Fast path: try synchronous open first (avoids Promise overhead)
        const syncHandle = vfs.openSync(filename, dwDesiredAccess, dwCreationDisposition);
        if (syncHandle !== null) {
            const handle = new FileHandleWrapper(syncHandle, vfs);
            const resourceProvider = System.getInstance().resourceProvider;
            const handleId = resourceProvider.registerFileHandle(handle);
            const totalTime = performance.now() - perfStart;
            if (totalTime > 1) {
                Logger.verbose(LogCategory.KERNEL32, `Slow CreateFileA sync: ${totalTime.toFixed(2)}ms, file="${filename}"`);
            }
            Logger.log(LogCategory.KERNEL32, `CreateFileA: OK "${filename}" handle=0x${handleId.toString(16)} (sync, source=${syncHandle.source}) size=${vfs.getFileSize(filename)}`);
            if (isCapsDatPath(filename)) {
                Logger.log(LogCategory.KERNEL32,
                    `CAPS.DAT: opened from ${syncHandle.source} (${vfs.getFileSize(filename)} bytes) — ` +
                    `GTA3 reconverts when live GPU probe DWORDs differ from this file`);
            }
            if (isTxdImgPath(filename)) {
                const disp = dwCreationDisposition >>> 0;
                const size = vfs.getFileSize(filename);
                if (disp === CREATE_ALWAYS) {
                    Logger.log(LogCategory.KERNEL32,
                        `txd.img: CREATE_ALWAYS — texture conversion started (overlay masks ROM). ` +
                        `Reset overlay before retest if you want the WGB bake instead.`);
                } else if (syncHandle.source === "overlay") {
                    Logger.log(LogCategory.KERNEL32,
                        `txd.img: opened from overlay (${size} bytes) — stale/partial overlay blocks rom cache`);
                } else {
                    Logger.log(LogCategory.KERNEL32, `txd.img: opened from rom (${size} bytes)`);
                }
            }
            System.getInstance().scheduler.setLastError(0);
            return handleId;
        }

        const openFailure = vfs.classifyOpenFailure(filename, dwCreationDisposition);
        const disp = dwCreationDisposition >>> 0;

        // Generic UE1 first-run: an OPEN_EXISTING read-miss on Detected.ini /
        // a config-ini → materialize/seed it into the overlay, then retry the open.
        // Gated on the ue1 flag (no-op for non-UE1 games). Async because it writes.
        if (disp === 3 && EmulatorConfig.getInstance().ue1 && (dwDesiredAccess & GENERIC_READ) !== 0) {
            return (async (): Promise<number> => {
                const materialized = await tryUe1FirstRunMaterialize(filename, dwDesiredAccess, dwCreationDisposition);
                if (materialized) {
                    const vfsHandle = await vfs.open(filename, dwDesiredAccess, dwCreationDisposition);
                    if (vfsHandle) {
                        const handle = new FileHandleWrapper(vfsHandle, vfs);
                        const handleId = System.getInstance().resourceProvider.registerFileHandle(handle);
                        System.getInstance().scheduler.setLastError(0);
                        Logger.log(LogCategory.KERNEL32, `CreateFileA: OK (UE1 first-run) "${filename}" handle=0x${handleId.toString(16)}`);
                        return handleId;
                    }
                }
                let resolved = '';
                try { resolved = vfs.resolvePath(filename); } catch { /* ignore */ }
                Logger.log(LogCategory.KERNEL32,
                    `CreateFileA: FAILED "${filename}" resolved="${resolved}" disposition=${dwCreationDisposition} err=${openFailure}`);
                System.getInstance().scheduler.setLastError(openFailure);
                return INVALID_HANDLE_VALUE;
            })();
        }

        if (
            disp === 3 ||
            openFailure === ERROR_PATH_NOT_FOUND ||
            (disp === 1 && openFailure === ERROR_ALREADY_EXISTS)
        ) {
            let resolved = '';
            try { resolved = vfs.resolvePath(filename); } catch { /* ignore */ }
            Logger.log(LogCategory.KERNEL32,
                `CreateFileA: FAILED "${filename}" resolved="${resolved}" disposition=${dwCreationDisposition} err=${openFailure}`);
            System.getInstance().scheduler.setLastError(openFailure);
            return INVALID_HANDLE_VALUE;
        }

        // Async path: overlay files or other dispositions
        Logger.verbose(LogCategory.KERNEL32, `CreateFileA: entering async path for "${filename}"`);
        return (async () => {
            try {
                Logger.verbose(LogCategory.KERNEL32, `CreateFileA async: calling vfs.open`);
                const vfsStart = performance.now();
                const vfsHandle = await vfs.open(filename, dwDesiredAccess, dwCreationDisposition);
                const vfsTime = performance.now() - vfsStart;
                Logger.verbose(LogCategory.KERNEL32, `CreateFileA async: vfs.open returned in ${vfsTime.toFixed(2)}ms`);

                if (!vfsHandle) {
                    let resolved = '';
                    try { resolved = vfs.resolvePath(filename); } catch { /* ignore */ }
                    const err = vfs.classifyOpenFailure(filename, dwCreationDisposition);
                    Logger.log(LogCategory.KERNEL32,
                        `CreateFileA: NOT FOUND "${filename}" resolved="${resolved}" currentDir="${vfs.currentDir}" err=${err}`);
                    System.getInstance().scheduler.setLastError(err);
                    return INVALID_HANDLE_VALUE;
                }

                const handle = new FileHandleWrapper(vfsHandle, vfs);
                const resourceProvider = System.getInstance().resourceProvider;
                const handleId = resourceProvider.registerFileHandle(handle);
                const totalTime = performance.now() - perfStart;
                if (totalTime > 10 || vfsTime > 10) {
                    Logger.verbose(LogCategory.KERNEL32, `Slow CreateFileA: total=${totalTime.toFixed(2)}ms, vfs.open=${vfsTime.toFixed(2)}ms, file="${filename}"`);
                }
                Logger.log(LogCategory.KERNEL32, `CreateFileA: OK "${filename}" handle=0x${handleId.toString(16)} source=${vfsHandle.source} size=${vfs.getFileSize(filename)}`);
                return handleId;
            } catch (error) {
                Logger.error(LogCategory.KERNEL32, `CreateFileA async failed: ${error}`);
                return INVALID_HANDLE_VALUE;
            }
        })();
    };

    // OpenFile - legacy Win16-compatible open API.
    // Maps to CreateFileA semantics for old installers/games.
    exports['OpenFile'] = (ctx, mem, args) => {
        const lpFileName = args[0];
        const lpReOpenBuff = args[1];
        const uStyle = args[2] >>> 0;

        const filename = lpFileName ? readStringA(mem, lpFileName) : '';

        // OFSTRUCT writeback (minimal but ABI-correct enough for callers that inspect it).
        if (lpReOpenBuff && lpReOpenBuff + 136 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint8(lpReOpenBuff + 0, 136); // cBytes
            view.setUint8(lpReOpenBuff + 1, 1);   // fFixedDisk
            view.setUint16(lpReOpenBuff + 2, 0, true); // nErrCode
            view.setUint16(lpReOpenBuff + 4, 0, true);
            view.setUint16(lpReOpenBuff + 6, 0, true);
            const pathBytes = encodeAnsi(filename + '\0');
            const max = Math.min(pathBytes.length, 128);
            mem.set(pathBytes.slice(0, max), lpReOpenBuff + 8);
        }

        // uStyle access mode (OF_READ/OF_WRITE/OF_READWRITE)
        const accessMode = uStyle & 0x3;
        const OF_WRITE = 0x00000001;
        const OF_READWRITE = 0x00000002;
        const OF_CREATE = 0x00001000;

        let desiredAccess = 0x80000000; // GENERIC_READ
        if (accessMode === OF_WRITE) desiredAccess = 0x40000000; // GENERIC_WRITE
        else if (accessMode === OF_READWRITE) desiredAccess = 0xC0000000; // GENERIC_READ|GENERIC_WRITE

        const creationDisposition = (uStyle & OF_CREATE) ? 2 : 3; // CREATE_ALWAYS : OPEN_EXISTING

        // Reuse existing CreateFileA path.
        return exports['CreateFileA']!(ctx, mem, [
            lpFileName,
            desiredAccess,
            1, // FILE_SHARE_READ
            0,
            creationDisposition,
            0,
            0,
        ]);
    };

    // _lopen - legacy wrapper around OpenFile.
    exports['_lopen'] = (ctx, mem, args) => {
        const lpPathName = args[0];
        const iReadWrite = args[1] >>> 0;
        return exports['OpenFile']!(ctx, mem, [lpPathName, 0, iReadWrite]);
    };

    exports['CreateFileW'] = (ctx, mem, args) => {
        const lpFileName = args[0];
        const dwDesiredAccess = args[1];
        const dwCreationDisposition = args[4];

        // For simplicity, convert wide string to ASCII
        const filename = lpFileName ? readStringW(mem, lpFileName) : '';
        if (filename.toLowerCase().endsWith('.bmp')) {
            Logger.log(LogCategory.KERNEL32, `CreateFileW BMP: "${filename}", 0x${dwDesiredAccess.toString(16)}, 0x${dwCreationDisposition.toString(16)}`);
        } else {
            Logger.log(LogCategory.KERNEL32, `CreateFileW("${filename}", 0x${dwDesiredAccess.toString(16)}, 0x${dwCreationDisposition.toString(16)})`);
        }

        // Check for Windows special devices before VFS
        const deviceType = isWindowsDevice(filename);
        if (deviceType !== null) {
            Logger.verbose(LogCategory.KERNEL32, `CreateFileW: opening Windows device "${filename}" as ${deviceType}`);
            const consoleHandle = new ConsoleDeviceHandle(deviceType);
            const resourceProvider = System.getInstance().resourceProvider;
            const handleId = resourceProvider.registerFileHandle(consoleHandle);
            Logger.verbose(LogCategory.KERNEL32, `CreateFileW: opened console device handle 0x${handleId.toString(16)}`);
            return handleId;
        }

        const vfs = System.getInstance().fileSystem;

        // Fast path: resolve synchronously (matches CreateFileA and the synchronous
        // Win32 CreateFile contract). Returning a Promise here would make the thunk
        // ASYNC and park the thread mid-open — which corrupts the CRT's in-flight fd
        // allocation (VC2005 __sopen allocates an fd BEFORE CreateFileW), leaving a
        // FILE* with _file=-1 that later _close(-1)s → _invalid_parameter throw.
        const syncHandle = vfs.openSync(filename, dwDesiredAccess, dwCreationDisposition);
        if (syncHandle !== null) {
            const handle = new FileHandleWrapper(syncHandle, vfs);
            const handleId = System.getInstance().resourceProvider.registerFileHandle(handle);
            Logger.log(LogCategory.KERNEL32, `CreateFileW: OK "${filename}" handle=0x${handleId.toString(16)} (sync, source=${syncHandle.source})`);
            System.getInstance().scheduler.setLastError(0);
            return handleId;
        }

        const openFailure = vfs.classifyOpenFailure(filename, dwCreationDisposition);
        const disp = dwCreationDisposition >>> 0;
        // OPEN_EXISTING miss / path-not-found: fail synchronously, exactly like CreateFileA.
        if (disp === 3 || openFailure === ERROR_PATH_NOT_FOUND || (disp === 1 && openFailure === 0xB7 /* ERROR_ALREADY_EXISTS */)) {
            Logger.verbose(LogCategory.KERNEL32, `CreateFileW: FAILED "${filename}" disposition=${disp} err=${openFailure}`);
            System.getInstance().scheduler.setLastError(openFailure);
            return INVALID_HANDLE_VALUE;
        }

        // Async path: overlay files / create dispositions that must write.
        return (async () => {
            try {
                let vfsHandle = await vfs.open(filename, dwDesiredAccess, dwCreationDisposition);
                if (!vfsHandle && await tryUe1FirstRunMaterialize(filename, dwDesiredAccess, dwCreationDisposition)) {
                    vfsHandle = await vfs.open(filename, dwDesiredAccess, dwCreationDisposition);
                }
                if (!vfsHandle) {
                    System.getInstance().scheduler.setLastError(openFailure || ERROR_FILE_NOT_FOUND);
                    return INVALID_HANDLE_VALUE;
                }
                const handle = new FileHandleWrapper(vfsHandle, vfs);
                const handleId = System.getInstance().resourceProvider.registerFileHandle(handle);
                Logger.verbose(LogCategory.KERNEL32, `CreateFileW: opened file handle 0x${handleId.toString(16)} source=${vfsHandle.source}`);
                return handleId;
            } catch (error) {
                Logger.error(LogCategory.KERNEL32, `CreateFileW failed: ${error}`);
                return INVALID_HANDLE_VALUE;
            }
        })();
    };

    const copyFileImpl = async (srcPath: string, dstPath: string, bFailIfExists: boolean): Promise<number> => {
        const vfs = System.getInstance().fileSystem;

        try {
            if (!srcPath || !dstPath) {
                System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }

            const srcHandle = await vfs.open(srcPath, 0x80000000, 3); // GENERIC_READ, OPEN_EXISTING
            if (!srcHandle) {
                System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
                return 0;
            }

            if (bFailIfExists) {
                const existing = vfs.openSync(dstPath, 0x80000000, 3);
                if (existing !== null) {
                    System.getInstance().scheduler.setLastError(ERROR_ALREADY_EXISTS);
                    return 0;
                }
            }

            const dstHandle = await vfs.open(dstPath, 0x40000000, bFailIfExists ? 1 : 2); // CREATE_NEW or CREATE_ALWAYS
            if (!dstHandle) {
                System.getInstance().scheduler.setLastError(ERROR_ACCESS_DENIED);
                return 0;
            }

            const totalSize = vfs.getFileSize(srcHandle.path);
            const chunkSize = 256 * 1024;
            let remaining = totalSize;

            srcHandle.position = 0;
            dstHandle.position = 0;

            while (remaining > 0) {
                const toRead = Math.min(chunkSize, remaining);
                const data = await vfs.read(srcHandle, toRead);
                if (data.length === 0) break;
                await vfs.write(dstHandle, data);
                remaining -= data.length;
            }

            System.getInstance().scheduler.setLastError(0);
            return 1;
        } catch (error) {
            Logger.error(LogCategory.KERNEL32, `CopyFile failed: ${error}`);
            System.getInstance().scheduler.setLastError(ERROR_ACCESS_DENIED);
            return 0;
        }
    };

    const isExactTildeTempForSource = (srcPath: string, dstPath: string): boolean => {
        const vfs = System.getInstance().fileSystem;
        const src = normalizeWinPath(vfs.resolvePath(srcPath));
        const dst = normalizeWinPath(vfs.resolvePath(dstPath));
        return dst === `${src}~`;
    };

    const discardStaleRomRenameTemp = async (srcPath: string, dstPath: string): Promise<void> => {
        const vfs = System.getInstance().fileSystem;
        const srcExisting = vfs.openSync(srcPath, 0x80000000, 3); // GENERIC_READ, OPEN_EXISTING
        if (srcExisting?.source !== "rom" || !isExactTildeTempForSource(srcPath, dstPath)) return;

        const dstExisting = vfs.openSync(dstPath, 0x80000000, 3);
        if (dstExisting?.source !== "overlay" || vfs.hasRomFile(dstPath)) return;

        const deleted = await deleteFileImpl(dstPath);
        if (deleted) {
            Logger.log(
                LogCategory.KERNEL32,
                `MoveFile: discarded stale overlay temp "${dstPath}" before ROM COW rename`
            );
        }
    };

    const deleteFileImpl = async (filename: string): Promise<number> => {
        if (!filename) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        const vfs = System.getInstance().fileSystem;
        const resolved = vfs.resolvePath(filename);

        // Win32: DeleteFile on directories fails with ERROR_ACCESS_DENIED.
        if (vfs.directoryExists(resolved)) {
            System.getInstance().scheduler.setLastError(ERROR_ACCESS_DENIED);
            return 0;
        }

        const existing = vfs.openSync(resolved, 0x80000000, 3); // GENERIC_READ, OPEN_EXISTING
        if (!existing) {
            System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
            return 0;
        }

        try {
            const deleted = await vfs.deleteFile(resolved);
            if (!deleted) {
                System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
                return 0;
            }

            System.getInstance().scheduler.setLastError(0);
            return 1;
        } catch (error) {
            Logger.error(LogCategory.KERNEL32, `DeleteFileA failed: ${error}`);
            System.getInstance().scheduler.setLastError(ERROR_ACCESS_DENIED);
            return 0;
        }
    };

    exports['CopyFileA'] = async (ctx, mem, args) => {
        const lpExistingFileName = args[0];
        const lpNewFileName = args[1];
        const bFailIfExists = args[2] !== 0;

        const srcPath = lpExistingFileName ? readStringA(mem, lpExistingFileName) : '';
        const dstPath = lpNewFileName ? readStringA(mem, lpNewFileName) : '';
        Logger.log(LogCategory.KERNEL32, `CopyFileA("${srcPath}" -> "${dstPath}", failIfExists=${bFailIfExists ? 1 : 0})`);
        const result = await copyFileImpl(srcPath, dstPath, bFailIfExists);
        if (!result) {
            Logger.log(LogCategory.KERNEL32, `CopyFileA: FAILED "${srcPath}" -> "${dstPath}" err=${System.getInstance().scheduler.getLastError()}`);
        }
        return result;
    };

    exports['CopyFileW'] = async (ctx, mem, args) => {
        const lpExistingFileName = args[0];
        const lpNewFileName = args[1];
        const bFailIfExists = args[2] !== 0;

        const srcPath = lpExistingFileName ? readStringW(mem, lpExistingFileName) : '';
        const dstPath = lpNewFileName ? readStringW(mem, lpNewFileName) : '';
        Logger.log(LogCategory.KERNEL32, `CopyFileW("${srcPath}" -> "${dstPath}", failIfExists=${bFailIfExists ? 1 : 0})`);
        const result = await copyFileImpl(srcPath, dstPath, bFailIfExists);
        if (!result) {
            Logger.log(LogCategory.KERNEL32, `CopyFileW: FAILED "${srcPath}" -> "${dstPath}" err=${System.getInstance().scheduler.getLastError()}`);
        }
        return result;
    };

    exports['DeleteFileA'] = async (ctx, mem, args) => {
        const lpFileName = args[0];
        const filename = lpFileName ? readStringA(mem, lpFileName) : '';
        Logger.log(LogCategory.KERNEL32, `DeleteFileA("${filename}")`);
        const result = await deleteFileImpl(filename);
        Logger.log(LogCategory.KERNEL32, result
            ? `DeleteFileA: OK "${filename}"`
            : `DeleteFileA: FAILED "${filename}" err=${System.getInstance().scheduler.getLastError()}`);
        return result;
    };

    exports['DeleteFileW'] = async (ctx, mem, args) => {
        const lpFileName = args[0];
        const filename = lpFileName ? readStringW(mem, lpFileName) : '';
        Logger.log(LogCategory.KERNEL32, `DeleteFileW("${filename}")`);
        const result = await deleteFileImpl(filename);
        Logger.log(LogCategory.KERNEL32, result
            ? `DeleteFileW: OK "${filename}"`
            : `DeleteFileW: FAILED "${filename}" err=${System.getInstance().scheduler.getLastError()}`);
        return result;
    };

    exports['MoveFileA'] = async (ctx, mem, args) => {
        const lpExistingFileName = args[0];
        const lpNewFileName = args[1];
        const srcPath = lpExistingFileName ? readStringA(mem, lpExistingFileName) : '';
        const dstPath = lpNewFileName ? readStringA(mem, lpNewFileName) : '';
        Logger.log(LogCategory.KERNEL32, `MoveFileA("${srcPath}" -> "${dstPath}")`);

        await discardStaleRomRenameTemp(srcPath, dstPath);
        const copyResult = await copyFileImpl(srcPath, dstPath, true);
        if (!copyResult) {
            Logger.log(LogCategory.KERNEL32, `MoveFileA: FAILED copy "${srcPath}" -> "${dstPath}" err=${System.getInstance().scheduler.getLastError()}`);
            return 0;
        }
        const deleteResult = await deleteFileImpl(srcPath);
        Logger.log(LogCategory.KERNEL32, deleteResult
            ? `MoveFileA: OK "${srcPath}" -> "${dstPath}"`
            : `MoveFileA: FAILED delete-source "${srcPath}" -> "${dstPath}" err=${System.getInstance().scheduler.getLastError()}`);
        return deleteResult;
    };

    exports['MoveFileW'] = async (ctx, mem, args) => {
        const lpExistingFileName = args[0];
        const lpNewFileName = args[1];
        const srcPath = lpExistingFileName ? readStringW(mem, lpExistingFileName) : '';
        const dstPath = lpNewFileName ? readStringW(mem, lpNewFileName) : '';
        Logger.log(LogCategory.KERNEL32, `MoveFileW("${srcPath}" -> "${dstPath}")`);

        await discardStaleRomRenameTemp(srcPath, dstPath);
        const copyResult = await copyFileImpl(srcPath, dstPath, true);
        if (!copyResult) {
            Logger.log(LogCategory.KERNEL32, `MoveFileW: FAILED copy "${srcPath}" -> "${dstPath}" err=${System.getInstance().scheduler.getLastError()}`);
            return 0;
        }
        const deleteResult = await deleteFileImpl(srcPath);
        Logger.log(LogCategory.KERNEL32, deleteResult
            ? `MoveFileW: OK "${srcPath}" -> "${dstPath}"`
            : `MoveFileW: FAILED delete-source "${srcPath}" -> "${dstPath}" err=${System.getInstance().scheduler.getLastError()}`);
        return deleteResult;
    };

    // MoveFileEx(lpExisting, lpNew, dwFlags). Unlike MoveFile it can overwrite an
    // existing destination when MOVEFILE_REPLACE_EXISTING is set — several installers
    // and self-test paths (Worms Armageddon's startup FS check) rely on the Ex form.
    const MOVEFILE_REPLACE_EXISTING = 0x1;
    const moveFileExImpl = async (srcPath: string, dstPath: string, dwFlags: number, tag: string): Promise<number> => {
        const failIfExists = (dwFlags & MOVEFILE_REPLACE_EXISTING) === 0;
        Logger.log(LogCategory.KERNEL32, `${tag}("${srcPath}" -> "${dstPath}", flags=0x${(dwFlags >>> 0).toString(16)})`);
        await discardStaleRomRenameTemp(srcPath, dstPath);
        const copyResult = await copyFileImpl(srcPath, dstPath, failIfExists);
        if (!copyResult) {
            Logger.log(LogCategory.KERNEL32, `${tag}: FAILED copy "${srcPath}" -> "${dstPath}" err=${System.getInstance().scheduler.getLastError()}`);
            return 0;
        }
        const deleteResult = await deleteFileImpl(srcPath);
        Logger.log(LogCategory.KERNEL32, deleteResult
            ? `${tag}: OK "${srcPath}" -> "${dstPath}"`
            : `${tag}: FAILED delete-source "${srcPath}" -> "${dstPath}" err=${System.getInstance().scheduler.getLastError()}`);
        return deleteResult;
    };

    exports['MoveFileExA'] = async (ctx, mem, args) => {
        const srcPath = args[0] ? readStringA(mem, args[0]) : '';
        const dstPath = args[1] ? readStringA(mem, args[1]) : '';
        return moveFileExImpl(srcPath, dstPath, args[2] >>> 0, 'MoveFileExA');
    };

    exports['MoveFileExW'] = async (ctx, mem, args) => {
        const srcPath = args[0] ? readStringW(mem, args[0]) : '';
        const dstPath = args[1] ? readStringW(mem, args[1]) : '';
        return moveFileExImpl(srcPath, dstPath, args[2] >>> 0, 'MoveFileExW');
    };

    exports['CreateFileMappingA'] = (ctx, mem, args) => {
        const hFile = args[0];
        const flProtect = args[2] >>> 0;
        const dwMaxSizeHigh = args[3] >>> 0;
        const dwMaxSizeLow = args[4] >>> 0;
        const lpName = args[5];

        const name = lpName ? readStringA(mem, lpName) : '';
        if (name) {
            const existing = namedFileMappings.get(name);
            if (existing !== undefined) {
                System.getInstance().scheduler.setLastError(ERROR_ALREADY_EXISTS);
                return existing;
            }
        }

        let size = dwMaxSizeHigh * 0x100000000 + dwMaxSizeLow;
        let fileHandle: number | null = null;

        if (hFile !== INVALID_HANDLE_VALUE && hFile !== 0) {
            const resourceProvider = System.getInstance().resourceProvider;
            const fileObj = resourceProvider.getFileHandle(hFile);
            if (!fileObj || isConsoleDeviceHandle(fileObj)) {
                System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
                return 0;
            }
            fileHandle = hFile;
            if (size === 0) {
                const vfsHandle = (fileObj as FileHandleWrapper).vfsHandle;
                const vfs = System.getInstance().fileSystem;
                size = vfs.getFileSize(vfsHandle.path);
            }
        }

        if (size === 0) {
            size = 0x1000;
        }

        const mapping: FileMappingObject = {
            kind: 'file_mapping',
            size,
            fileHandle,
            protect: flProtect,
        };

        const handle = System.getInstance().resourceProvider.registerKernelObject(mapping);
        if (name) {
            namedFileMappings.set(name, handle);
        }
        return handle;
    };

    exports['CreateFileMappingW'] = (ctx, mem, args) => {
        const hFile = args[0];
        const flProtect = args[2] >>> 0;
        const dwMaxSizeHigh = args[3] >>> 0;
        const dwMaxSizeLow = args[4] >>> 0;
        const lpName = args[5];

        const name = lpName ? readStringW(mem, lpName) : '';
        if (name) {
            const existing = namedFileMappings.get(name);
            if (existing !== undefined) {
                System.getInstance().scheduler.setLastError(ERROR_ALREADY_EXISTS);
                return existing;
            }
        }

        let size = dwMaxSizeHigh * 0x100000000 + dwMaxSizeLow;
        let fileHandle: number | null = null;

        if (hFile !== INVALID_HANDLE_VALUE && hFile !== 0) {
            const resourceProvider = System.getInstance().resourceProvider;
            const fileObj = resourceProvider.getFileHandle(hFile);
            if (!fileObj || isConsoleDeviceHandle(fileObj)) {
                System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
                return 0;
            }
            fileHandle = hFile;
            if (size === 0) {
                const vfsHandle = (fileObj as FileHandleWrapper).vfsHandle;
                const vfs = System.getInstance().fileSystem;
                size = vfs.getFileSize(vfsHandle.path);
            }
        }

        if (size === 0) {
            size = 0x1000;
        }

        const mapping: FileMappingObject = {
            kind: 'file_mapping',
            size,
            fileHandle,
            protect: flProtect,
        };

        const handle = System.getInstance().resourceProvider.registerKernelObject(mapping);
        if (name) {
            namedFileMappings.set(name, handle);
        }
        return handle;
    };

    exports['OpenFileMappingA'] = (ctx, mem, args) => {
        const lpName = args[2];
        const name = lpName ? readStringA(mem, lpName) : '';
        if (!name) {
            System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
            return 0;
        }
        const handle = namedFileMappings.get(name);
        if (handle === undefined) {
            System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
            return 0;
        }
        return handle;
    };

    exports['MapViewOfFile'] = async (ctx, mem, args) => {
        const hFileMappingObject = args[0];
        const dwDesiredAccess = args[1] >>> 0;
        const dwFileOffsetHigh = args[2] >>> 0;
        const dwFileOffsetLow = args[3] >>> 0;
        const dwNumberOfBytesToMap = args[4] >>> 0;

        const mapping = System.getInstance().resourceProvider.getKernelObject(hFileMappingObject) as FileMappingObject | null;
        if (!mapping || mapping.kind !== 'file_mapping') {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }

        const offset = dwFileOffsetHigh * 0x100000000 + dwFileOffsetLow;
        const size = dwNumberOfBytesToMap === 0 ? Math.max(0, mapping.size - offset) : dwNumberOfBytesToMap;
        if (size <= 0) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        const process = System.getInstance().process;
        if (!process) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }

        let base = 0;
        try {
            base = process.memory.alloc(size);
        } catch (e) {
            Logger.error(LogCategory.KERNEL32, `MapViewOfFile alloc failed: ${e}`);
            System.getInstance().scheduler.setLastError(ERROR_NOACCESS);
            return 0;
        }

        const zeroChunk = new Uint8Array(64 * 1024);
        for (let wrote = 0; wrote < size; wrote += zeroChunk.length) {
            const chunkSize = Math.min(zeroChunk.length, size - wrote);
            Mem.writeBytes(base + wrote, zeroChunk.subarray(0, chunkSize));
        }

        if (mapping.fileHandle !== null) {
            const resourceProvider = System.getInstance().resourceProvider;
            const fileObj = resourceProvider.getFileHandle(mapping.fileHandle);
            if (fileObj && !isConsoleDeviceHandle(fileObj)) {
                const vfs = System.getInstance().fileSystem;
                // Populating the view runs on its OWN cursor: MapViewOfFile does not touch
                // the file pointer at all, and save/restore around these awaits would clobber
                // any seek the guest performs during the yield.
                const viewHandle = vfs.duplicateHandle((fileObj as FileHandleWrapper).vfsHandle, offset);

                const chunkSize = 256 * 1024;
                let remaining = size;
                let dest = base;

                while (remaining > 0) {
                    const toRead = Math.min(chunkSize, remaining);
                    const data = await vfs.read(viewHandle, toRead);
                    if (data.length === 0) break;
                    Mem.writeBytes(dest, data);
                    dest += data.length;
                    remaining -= data.length;
                }
            }
        }

        // A file-backed view is dirty-tracked for write-back only when both the
        // mapping protection and the view access request write (and it is not a
        // copy-on-write view, whose writes must NOT reach the file).
        const mappingWritable = (mapping.protect & PAGE_WRITE_MASK) !== 0;
        const accessWrite = (dwDesiredAccess & (FILE_MAP_WRITE | FILE_MAP_ALL_ACCESS)) !== 0;
        const isCopy = (dwDesiredAccess & FILE_MAP_COPY) !== 0 && !accessWrite;
        const writable = mapping.fileHandle !== null && mappingWritable && accessWrite && !isCopy;

        fileMappingViews.set(base, { mappingHandle: hFileMappingObject, size, offset, fileHandle: mapping.fileHandle, writable });
        return base;
    };

    exports['UnmapViewOfFile'] = (ctx, mem, args) => {
        const lpBaseAddress = args[0];
        const view = fileMappingViews.get(lpBaseAddress);
        if (!view) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        return (async (): Promise<ThunkResult> => {
            // Persist dirty bytes back to the backing file BEFORE freeing the view
            // memory (flushMappedView reads the guest pages at lpBaseAddress).
            await flushMappedView(lpBaseAddress, view);
            const process = System.getInstance().process;
            if (process) {
                process.memory.free(lpBaseAddress);
            }
            fileMappingViews.delete(lpBaseAddress);
            return { value: 1, stackCleanup: 4 };
        })();
    };

    // BOOL FlushViewOfFile(LPCVOID lpBaseAddress, SIZE_T dwNumberOfBytesToFlush)
    exports['FlushViewOfFile'] = (ctx, mem, args) => {
        const lpBaseAddress = args[0] >>> 0;
        const dwNumberOfBytesToFlush = args[1] >>> 0;
        const view = fileMappingViews.get(lpBaseAddress);
        if (!view) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        // dwNumberOfBytesToFlush == 0 means "flush from base to end of view".
        const flushSize = dwNumberOfBytesToFlush === 0 ? view.size : Math.min(dwNumberOfBytesToFlush, view.size);
        return (async (): Promise<ThunkResult> => {
            await flushMappedView(lpBaseAddress, { ...view, size: flushSize });
            return { value: 1, stackCleanup: 8 };
        })();
    };

    // MapViewOfFileEx — same as MapViewOfFile but with lpBaseAddress hint (arg[5]), which we ignore
    exports['MapViewOfFileEx'] = (ctx, mem, args) => {
        // Forward to MapViewOfFile (ignoring the base address hint)
        return exports['MapViewOfFile']!(ctx, mem, args) as Promise<number>;
    };

    exports['ReadFile'] = (ctx, mem, args) => {
        const hFile = args[0];
        const lpBuffer = args[1];
        const nNumberOfBytesToRead = (args[2] >>> 0) as number;
        const lpNumberOfBytesRead = args[3];
        const lpOverlapped = args[4];

        const espEntry = ctx.esp;
        const eipEntry = ctx.eip;
        const retSlot = espEntry;

        const STACK_LO = 0x00080000;
        const STACK_HI = 0x00100000;
        const isStackPtr = (p: number) => p >= STACK_LO && p < STACK_HI;
        const rangesOverlap = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;
        const fmtPtr = (x: number) => "0x" + (x >>> 0).toString(16);

        const bufInStack = isStackPtr(lpBuffer);
        const retInBuf = rangesOverlap(lpBuffer, (lpBuffer + nNumberOfBytesToRead) >>> 0, retSlot, (retSlot + 4) >>> 0);

        // Watch return slot and args (24 bytes total: ret addr + 5 args)
        const watchHandle = Mem.pushWriteWatchRange(espEntry, (espEntry + 24) >>> 0, `ReadFile[h=0x${hFile.toString(16)},buf=0x${lpBuffer.toString(16)}]`);

        if (bufInStack) {
            Logger.verbose(LogCategory.KERNEL32, `[ReadFile] stack buffer! buf=${fmtPtr(lpBuffer)} size=${nNumberOfBytesToRead} retSlot=${fmtPtr(retSlot)} retInBuf=${retInBuf}`);
        }

        // Parse OVERLAPPED structure if provided
        let overlappedOffset = -1;  // file offset from OVERLAPPED, -1 = use current position
        let overlappedHEvent = 0;
        if (lpOverlapped && lpOverlapped + 20 <= mem.length) {
            const ovView = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            overlappedOffset = ovView.getUint32(lpOverlapped + 8, true);  // Offset (low 32 bits)
            // OffsetHigh at +12 ignored (files > 4GB not supported)
            overlappedHEvent = ovView.getUint32(lpOverlapped + 16, true);  // hEvent
            Logger.log(LogCategory.KERNEL32,
                `ReadFile OVERLAPPED: h=0x${hFile.toString(16)} offset=${overlappedOffset}, hEvent=0x${overlappedHEvent.toString(16)}`);
        }

        Logger.verbose(LogCategory.KERNEL32,
            `ReadFile(h=0x${hFile.toString(16)}, buf=${fmtPtr(lpBuffer)}, size=${nNumberOfBytesToRead}, bytesReadPtr=${fmtPtr(lpNumberOfBytesRead)})`);

        /** Signal overlapped completion: write Internal/InternalHigh fields and SetEvent. */
        const signalOverlapped = (bytesRead: number) => {
            if (!lpOverlapped || lpOverlapped + 20 > mem.length) return;
            const freshMem = Mem.getView() || mem;
            const ovView = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);
            ovView.setUint32(lpOverlapped, 0, true);            // Internal = STATUS_SUCCESS (0)
            ovView.setUint32(lpOverlapped + 4, bytesRead, true); // InternalHigh = bytes transferred
            if (overlappedHEvent) {
                System.getInstance().scheduler.setEvent(overlappedHEvent);
            }
            // A handle bound to a completion port also gets a packet: that, not the
            // event, is what an I/O worker pool is waiting on.
            postFileIoCompletion(hFile, bytesRead, lpOverlapped);
        };

        const cleanup = () => {
            Mem.popWriteWatchRange(watchHandle);
        };

        // Handle standard file handles (stdin/stdout/stderr)
        if (hFile === 0 || hFile === 1 || hFile === 2) {
            if (hFile === 0) {
                if (lpNumberOfBytesRead) {
                    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                    view.setUint32(lpNumberOfBytesRead, 0, true);
                }
                cleanup();
                return 1;
            }
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            cleanup();
            return 0;
        }

        const resourceProvider = System.getInstance().resourceProvider;
        const fileHandle = resourceProvider.getFileHandle(hFile);

        if (!fileHandle) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            cleanup();
            return 0;
        }

        // Seek to overlapped offset if specified
        if (overlappedOffset >= 0 && !isConsoleDeviceHandle(fileHandle)) {
            (fileHandle as FileHandleWrapper).seek(overlappedOffset);
        }

        // Fast path: try sync read first
        if (!isConsoleDeviceHandle(fileHandle) && lpBuffer + nNumberOfBytesToRead <= mem.length) {
            const bytesReadSync = (fileHandle as FileHandleWrapper).readIntoSync(mem, lpBuffer, nNumberOfBytesToRead);
            if (bytesReadSync !== null) {
                if (lpNumberOfBytesRead) {
                    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                    view.setUint32(lpNumberOfBytesRead, bytesReadSync, true);
                }
                const vfsHandle = (fileHandle as FileHandleWrapper).vfsHandle;
                noteReadFileThread(hFile, vfsHandle?.path ?? "?");
                if (vfsHandle?.path.toLowerCase().endsWith("casa.mmp")) {
                    Logger.log(LogCategory.KERNEL32, 
                        `ReadFile casa.mmp: h=0x${hFile.toString(16)} buf=0x${lpBuffer.toString(16)} ` +
                        `size=${nNumberOfBytesToRead} read=${bytesReadSync} pos=${vfsHandle.position - bytesReadSync}`);
                }
                if (!readFileFirstLogged.has(hFile)) {
                    readFileFirstLogged.add(hFile);
                    Logger.log(LogCategory.KERNEL32,
                        `ReadFile first: h=0x${hFile.toString(16)} file="${vfsHandle?.path ?? '?'}" read=${bytesReadSync}/${nNumberOfBytesToRead} pos=${vfsHandle.position - bytesReadSync}`);
                } else {
                    Logger.verbose(LogCategory.KERNEL32,
                        `ReadFile OK (fastSync): h=0x${hFile.toString(16)} read=${bytesReadSync}/${nNumberOfBytesToRead}`);
                }
                if (vfsHandle && isCapsDatPath(vfsHandle.path)) {
                    const readPos = vfsHandle.position - bytesReadSync;
                    if (readPos === 0 && bytesReadSync >= 4) {
                        logCapsDatDwords("read", mem, lpBuffer, Math.min(16, bytesReadSync));
                    }
                }
                if (vfsHandle && isTxdImgPath(vfsHandle.path) && bytesReadSync < nNumberOfBytesToRead) {
                    Logger.warn(LogCategory.KERNEL32,
                        `txd.img short read: wanted=${nNumberOfBytesToRead} got=${bytesReadSync} ` +
                        `pos=${vfsHandle.position - bytesReadSync} (corrupt cache / partial overlay?)`);
                }
                // BottleShip diag: any short sync read on a package/code file — a short read of a .u/.unr
                // truncates the linker's export load (→ a class resolves NULL → "Empty class"). XIII dies
                // on `engine.InteractionMaster`; this catches whether reading engine.u (etc.) short-reads.
                if (vfsHandle && bytesReadSync < nNumberOfBytesToRead && /\.(u|unr|uax|utx|usx|ukx)$/i.test(vfsHandle.path)) {
                    Logger.warn(LogCategory.KERNEL32,
                        `[SHORTREAD] ${vfsHandle.path}: wanted=${nNumberOfBytesToRead} got=${bytesReadSync} ` +
                        `pos=${vfsHandle.position - bytesReadSync}`);
                }
                // A short read that the guest does not check leaves its buffer holding whatever
                // was there before — the header it then parses is stale stack/heap bytes. The
                // per-extension probes above only cover the titles that already cost us a day,
                // so keep a generic one: any file, rate-limited.
                if (vfsHandle && bytesReadSync < nNumberOfBytesToRead && shortReadLogCount < 40) {
                    shortReadLogCount++;
                    Logger.warn(LogCategory.KERNEL32,
                        `[SHORTREAD] ${vfsHandle.path}: wanted=${nNumberOfBytesToRead} got=${bytesReadSync} ` +
                        `pos=${vfsHandle.position - bytesReadSync} size=${fileHandle.size}`);
                }
                if (vfsHandle) {
                    if (LARGE_IO_TRACE_ENABLED) traceLargeRead(
                        'ReadFile',
                        vfsHandle.path,
                        hFile,
                        vfsHandle.position - bytesReadSync,
                        nNumberOfBytesToRead,
                        bytesReadSync,
                    );
                }
                System.getInstance().scheduler.setLastError(0);
                signalOverlapped(bytesReadSync);
                cleanup();
                return 1;
            }
        }

        const syncData = fileHandle.readSync(nNumberOfBytesToRead);
        if (syncData !== null) {
            if (lpBuffer > mem.length || lpBuffer < 0) {
                const sched = System.getInstance().scheduler;
                const tid = sched.getCurrentThread()?.id ?? '?';
                Logger.error(LogCategory.KERNEL32,
                    `ReadFile CORRUPT lpBuffer=0x${(lpBuffer >>> 0).toString(16)} ` +
                    `memLen=0x${mem.length.toString(16)} size=${syncData.length} ` +
                    `hFile=0x${hFile.toString(16)} thread=${tid} ` +
                    `ESP=0x${ctx.esp.toString(16)} EBP=0x${ctx.ebp.toString(16)} ` +
                    `stack=[${Array.from({length: 8}, (_, i) => '0x' + (args[i] ?? 0).toString(16)).join(',')}]`);
            }
            const writeLen = MemoryGuard.writeBytes(mem, lpBuffer, syncData, "ReadFile");
            if (lpNumberOfBytesRead) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(lpNumberOfBytesRead, writeLen, true);
            }
            {
                const vfsHandle = (fileHandle as FileHandleWrapper).vfsHandle;
                if (LARGE_IO_TRACE_ENABLED) traceLargeRead(
                    'ReadFile',
                    vfsHandle.path,
                    hFile,
                    vfsHandle.position - writeLen,
                    nNumberOfBytesToRead,
                    writeLen,
                );
            }
            Logger.verbose(LogCategory.KERNEL32,
                `ReadFile OK (sync): h=0x${hFile.toString(16)} read=${writeLen}/${nNumberOfBytesToRead}`);
            System.getInstance().scheduler.setLastError(0);
            signalOverlapped(writeLen);
            cleanup();
            return 1;
        }

        const fh = fileHandle as FileHandleWrapper;
        const capturedLpNumberOfBytesRead = lpNumberOfBytesRead;

        return (async (): Promise<ThunkResult> => {
            try {
                // H1 Stack Watch: set a long-lived watch for the async period
                const asyncWatchHandle = Mem.pushWriteWatchRange(espEntry, (espEntry + 24) >>> 0, `ReadFileAsync[h=0x${hFile.toString(16)}]`);

                const freshMem = Mem.getView();
                if (!freshMem || freshMem.byteLength === 0) {
                    cleanup();
                    Mem.popWriteWatchRange(asyncWatchHandle);
                    return { value: 0, stackCleanup: 20 };
                }
                const bytesRead = await fh.readInto(freshMem, lpBuffer, nNumberOfBytesToRead);

                const vfsHandle = (fileHandle as FileHandleWrapper).vfsHandle;
                if (LARGE_IO_TRACE_ENABLED) traceLargeRead(
                    'ReadFile',
                    vfsHandle.path,
                    hFile,
                    vfsHandle.position - bytesRead,
                    nNumberOfBytesToRead,
                    bytesRead,
                );

                System.getInstance().scheduler.setLastError(0);
                signalOverlapped(bytesRead);

                cleanup();
                Mem.popWriteWatchRange(asyncWatchHandle);

                // Use deferred writes - they're applied in _restoreAsyncContext BEFORE simulating RET
                // This ensures writes happen when ESP is still at original position
                if (capturedLpNumberOfBytesRead) {
                    return { value: 1, deferredWrites: [{ address: capturedLpNumberOfBytesRead, value: bytesRead, size: 4 }], stackCleanup: 20 };
                }
                return { value: 1, stackCleanup: 20 };
            } catch (e) {
                cleanup();
                // A FALSE with a STALE last error is a wrong answer the caller cannot
                // detect: a leftover ERROR_IO_PENDING reads as "overlapped, wait for it"
                // and the guest waits for a completion this failure will never post.
                Logger.error(LogCategory.KERNEL32, `ReadFile async failed: h=0x${hFile.toString(16)} ${e}`);
                System.getInstance().scheduler.setLastError(ERROR_IO_DEVICE);
                return { value: 0, stackCleanup: 20 };
            }
        })();
    };

    exports['WriteFile'] = (ctx, mem, args) => {
        const perfStart = performance.now();
        const hFile = args[0];
        const lpBuffer = args[1];
        const nNumberOfBytesToWrite = args[2];
        const lpNumberOfBytesWritten = args[3];
        const lpOverlapped = args[4];

        /**
         * Complete an overlapped write the way the OS does: the OVERLAPPED's status
         * fields, then its event, then a packet on the completion port the handle is
         * bound to. Leaving this out is invisible while GetQueuedCompletionStatus
         * merely polls, and a deadlock once it properly blocks: a save hangs with the
         * whole thread pool parked on a packet that never comes.
         */
        const completeOverlappedWrite = (bytesWritten: number): void => {
            if (!lpOverlapped) return;
            const freshMem = Mem.getView();
            if (!freshMem || lpOverlapped + 20 > freshMem.length) return;
            const ovView = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);
            ovView.setUint32(lpOverlapped, 0, true);                 // Internal = STATUS_SUCCESS
            ovView.setUint32(lpOverlapped + 4, bytesWritten, true);  // InternalHigh = bytes transferred
            const hEvent = ovView.getUint32(lpOverlapped + 16, true) >>> 0;
            if (hEvent) System.getInstance().scheduler.setEvent(hEvent);
            postFileIoCompletion(hFile, bytesWritten, lpOverlapped);
        };

        // Handle standard file handles (stdin/stdout/stderr) - synchronous
        if (hFile === 1 || hFile === 2) {
            // stdout/stderr from guest process.
            // Use logger (not console.error) to avoid misleading JS stack traces.
            const data = mem.slice(lpBuffer, lpBuffer + nNumberOfBytesToWrite);
            const text = getCodePageDecoder(EmulatorConfig.getInstance().ansiCodePage).decode(data).replace(/\r?\n$/, '');
            const stream = hFile === 2 ? 'STDERR' : 'STDOUT';
            const message = `[GUEST ${stream}] ${text}`;
            if (hFile === 2) {
                Logger.warn(LogCategory.SYSTEM, message);
            } else {
                Logger.log(LogCategory.SYSTEM, message);
            }
            if (lpNumberOfBytesWritten) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(lpNumberOfBytesWritten, nNumberOfBytesToWrite, true);
            }
            return 1; // TRUE
        }
        if (hFile === 0) {
            // stdin - cannot write to
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0; // FALSE
        }

        const resourceProvider = System.getInstance().resourceProvider;
        const fileHandle = resourceProvider.getFileHandle(hFile);

        if (!fileHandle) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0; // FALSE
        }

        // Check if this is a console device handle - synchronous path
        if (isConsoleDeviceHandle(fileHandle)) {
            // Console devices buffer internally, use fire-and-forget async
            const data = mem.slice(lpBuffer, lpBuffer + nNumberOfBytesToWrite);
            fileHandle.write(data).catch(error => {
                Logger.error(LogCategory.KERNEL32, `WriteFile failed for console device: ${error}`);
            });
            // Return immediately - write is buffered
            if (lpNumberOfBytesWritten) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(lpNumberOfBytesWritten, nNumberOfBytesToWrite, true);
            }
            return 1; // TRUE
        }

        // Regular file handle - get filename for logging
        const vfsHandle = (fileHandle as FileHandleWrapper).vfsHandle;
        const filename = vfsHandle.path || "";

        if (filename.toLowerCase().endsWith('.bmp')) {
            Logger.log(LogCategory.KERNEL32, `WriteFile BMP: "${filename}" (0x${hFile.toString(16)}), ${nNumberOfBytesToWrite} bytes`);
        } else if (filename.toLowerCase().endsWith('.ini')) {
            Logger.log(LogCategory.KERNEL32, `WriteFile INI: "${filename}" (0x${hFile.toString(16)}), ${nNumberOfBytesToWrite} bytes, pos=${vfsHandle.position}`);
        } else if (isCapsDatPath(filename) && nNumberOfBytesToWrite >= 4) {
            logCapsDatDwords("write", mem, lpBuffer, Math.min(16, nNumberOfBytesToWrite));
        } else {
            Logger.verbose(LogCategory.KERNEL32, `WriteFile(0x${hFile.toString(16)}, ${nNumberOfBytesToWrite} bytes)`);
        }

        // Dump text content for log/error files to help diagnose game errors
        const fnLower = filename.toLowerCase();
        if ((fnLower.endsWith('.log') || fnLower.endsWith('.err') || fnLower.includes('blizzarderror') || fnLower.endsWith('.txt')) && nNumberOfBytesToWrite > 0 && nNumberOfBytesToWrite < 32768) {
            try {
                const logData = mem.slice(lpBuffer, lpBuffer + nNumberOfBytesToWrite);
                const logText = getCodePageDecoder(EmulatorConfig.getInstance().ansiCodePage).decode(logData);
                const label = fnLower.endsWith('.log') ? 'LOG' : fnLower.endsWith('.err') ? 'ERR' : 'TXT';
                Logger.log(LogCategory.KERNEL32, `WriteFile ${label} content: "${logText.trimEnd()}"`);
            } catch { /* ignore decode errors */ }
        }

        const capturedLpNumberOfBytesWritten = lpNumberOfBytesWritten;
        const data = mem.slice(lpBuffer, lpBuffer + nNumberOfBytesToWrite);

        // Synchronous fast path — the write-side mirror of ReadFile's readFileSyncVia.
        // On real Win32, WriteFile to a non-overlapped buffered handle returns immediately
        // (a copy into the cache manager); persistence is lazy. Routing every write through
        // an async thunk instead parks the guest main thread (~1ms/call). Games that rewrite
        // a file in a tight loop — e.g. HTMLayout UIs that rewrite C:\nbsoth.html in dozens
        // of tiny WriteFiles per frame — then monopolize the main thread, starving other
        // work that runs on it, including the DirectSound streaming-buffer refill pump →
        // audible stutter. vfs.writeSync buffers to the overlay (read-after-write stays
        // correct via the authoritative contentCache) and defers OPFS to the lazy flush.
        // It returns <0 only when it cannot complete synchronously (overlay not ready), in
        // which case we fall through to the async path below.
        const vfs = System.getInstance().fileSystem;
        const syncWritten = vfs.writeSync(vfsHandle, data);
        if (syncWritten >= 0) {
            if (capturedLpNumberOfBytesWritten) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(capturedLpNumberOfBytesWritten, syncWritten, true);
            }
            completeOverlappedWrite(syncWritten);
            return 1; // TRUE — stdcall cleanup applied from the registered WriteFile signature
        }

        // Async path for file writes (sync fast path unavailable)
        return (async (): Promise<ThunkResult> => {
            try {
                const writeStart = performance.now();
                const bytesWritten = await fileHandle.write(data);
                const writeTime = performance.now() - writeStart;
                const totalTime = performance.now() - perfStart;

                // Log slow operations (>1ms) to help diagnose v86 blocking
                if (writeTime > 1 || totalTime > 1) {
                    Logger.verbose(LogCategory.KERNEL32,
                        `WriteFile slow: "${filename}" write=${writeTime.toFixed(2)}ms total=${totalTime.toFixed(2)}ms size=${nNumberOfBytesToWrite} bytes`
                    );
                }

                // Use deferred writes - they're applied in _restoreAsyncContext BEFORE simulating RET
                // This ensures writes happen when ESP is still at original position
                completeOverlappedWrite(bytesWritten);
                if (capturedLpNumberOfBytesWritten) {
                    return {
                        value: 1,
                        deferredWrites: [{
                            address: capturedLpNumberOfBytesWritten,
                            value: bytesWritten,
                            size: 4
                        }],
                        stackCleanup: 20
                    };
                }

                return { value: 1, stackCleanup: 20 };
            } catch (error) {
                Logger.error(LogCategory.KERNEL32, `WriteFile failed: ${error}`);
                // Same reason as ReadFile's catch: never return FALSE on a stale error.
                System.getInstance().scheduler.setLastError(ERROR_IO_DEVICE);
                return { value: 0, stackCleanup: 20 }; // FALSE
            }
        })();
    };

    exports['SetFilePointer'] = (ctx, mem, args) => {
        // Entire body in try/catch to prevent EAX=0xdead000d on detached buffer or other exceptions
        try {
            const hFile = args[0];
            const lDistanceToMoveLow = args[1] | 0;  // Signed 32-bit
            const lpDistanceToMoveHigh = args[2] >>> 0;  // IN/OUT pointer to high 32 bits (unsigned)
            const dwMoveMethod = args[3];

            const resourceProvider = System.getInstance().resourceProvider;
            const fileHandle = resourceProvider.getFileHandle(hFile);

            if (!fileHandle) {
                System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
                return INVALID_HANDLE_VALUE;
            }

            // Safe memory access – DataView creation throws if buffer is detached
            if (!mem.buffer || mem.buffer.byteLength === 0) {
                throw new Error('Memory detached - cannot access buffer');
            }
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Read high 32 bits if pointer is provided (for 64-bit seeking)
            let distanceToMoveHigh = 0;
            if (lpDistanceToMoveHigh !== 0) {
                if (lpDistanceToMoveHigh + 4 > mem.length) {
                    System.getInstance().scheduler.setLastError(ERROR_NOACCESS);
                    return INVALID_HANDLE_VALUE;
                }
                distanceToMoveHigh = view.getInt32(lpDistanceToMoveHigh, true);
            }

            // WinAPI: when lpDistanceToMoveHigh == NULL, lDistanceToMoveLow is SIGNED 32-bit (e.g. seek back).
            // Otherwise 64-bit: high signed, low as uint32 bits.
            let distance: number;
            if (lpDistanceToMoveHigh === 0) {
                distance = lDistanceToMoveLow; // already int32 via |0 at args[1]
            } else {
                distance = (distanceToMoveHigh * 0x100000000) + (lDistanceToMoveLow >>> 0);
            }

            const vfsHandle = (fileHandle as FileHandleWrapper).vfsHandle;

            if (shouldLogSetFilePointer(hFile)) {
                // Resolve caller only for sampled logs to avoid hot-path overhead on seek-heavy titles (e.g. HoMM3).
                const retAddr = ctx.esp > 0 && ctx.esp + 4 <= mem.length
                    ? new DataView(mem.buffer, mem.byteOffset, mem.byteLength).getUint32(ctx.esp, true)
                    : 0;
                let callerInfo = "";
                const moduleRegistry = System.getInstance().process?.moduleRegistry;
                if (moduleRegistry && retAddr !== 0) {
                    const callerMod = moduleRegistry.getModuleContainingAddress(retAddr);
                    if (callerMod) {
                        callerInfo = ` (caller: ${callerMod.name} @ 0x${retAddr.toString(16)})`;
                    }
                }

                Logger.verbose(
                    LogCategory.KERNEL32,
                    `SetFilePointer(0x${hFile.toString(16)}, distLow=${lDistanceToMoveLow}, distHigh=${distanceToMoveHigh}, method=${dwMoveMethod}) ` +
                    `lpDistanceToMoveHigh=0x${lpDistanceToMoveHigh.toString(16)} ESP=0x${ctx.esp.toString(16)}${callerInfo}`
                );
            }

            const vfs = System.getInstance().fileSystem;
            const newPosition = vfs.setPosition(vfsHandle, distance, dwMoveMethod);

            // Write high 32 bits of new position if pointer provided.
            // Writing to caller's stack variables (addresses >= ESP) is perfectly legal.
            // This is standard C/C++ pattern: caller passes pointer to local variable.
            if (lpDistanceToMoveHigh !== 0 && lpDistanceToMoveHigh + 4 <= mem.length) {
                const newPosHigh = Math.floor(newPosition / 0x100000000) | 0;
                view.setInt32(lpDistanceToMoveHigh, newPosHigh, true);
                Logger.verbose(LogCategory.KERNEL32,
                    `SetFilePointer: wrote high=0x${newPosHigh.toString(16)} to 0x${lpDistanceToMoveHigh.toString(16)}`);
            }

            // Success: 0xFFFFFFFF is a valid position in WinAPI; error is determined by GetLastError().
            System.getInstance().scheduler.setLastError(0);
            const result = (newPosition >>> 0) & 0xFFFFFFFF;

            // NOTE: File position can be any 32-bit value - no need to check for "stack-like" or "code-like"
            // SetFilePointer returns a numeric file offset, not a pointer that guest code would dereference
            Logger.verbose(LogCategory.KERNEL32,
                `SetFilePointer → 0x${result.toString(16)} (position=${newPosition})`);
            return result;
        } catch (error) {
            Logger.error(LogCategory.KERNEL32, `🚨 SetFilePointer EXCEPTION: ${error} (stack: ${(error as Error).stack})`);
            System.getInstance().scheduler.setLastError(ERROR_SEEK);
            return INVALID_HANDLE_VALUE;
        }
    };

    // BOOL SetEndOfFile(HANDLE hFile)
    exports['SetEndOfFile'] = (ctx, mem, args) => {
        const hFile = args[0] >>> 0;
        const resourceProvider = System.getInstance().resourceProvider;
        const fileHandle = resourceProvider.getFileHandle(hFile);
        if (!fileHandle) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }
        const vfsHandle = (fileHandle as FileHandleWrapper).vfsHandle;
        if (!vfsHandle) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }
        const position = vfsHandle.position ?? 0;
        const vfs = System.getInstance().fileSystem;
        Logger.log(LogCategory.KERNEL32, `SetEndOfFile(0x${hFile.toString(16)}, "${vfsHandle.path}") at position ${position}`);
        return (async (): Promise<ThunkResult> => {
            try {
                await vfs.truncateAt(vfsHandle.path, position);
                return { value: 1, stackCleanup: 4 };
            } catch (error) {
                Logger.warn(LogCategory.KERNEL32, `SetEndOfFile(0x${hFile.toString(16)}) failed: ${error}`);
                System.getInstance().scheduler.setLastError(ERROR_ACCESS_DENIED);
                return { value: 0, stackCleanup: 4 };
            }
        })();
    };

    // _llseek - old 16-bit style file seek wrapper.
    exports['_llseek'] = (ctx, mem, args) => {
        const hFile = args[0];
        const lOffset = args[1] | 0;
        const iOrigin = args[2] >>> 0;

        const resourceProvider = System.getInstance().resourceProvider;
        const fileHandle = resourceProvider.getFileHandle(hFile);
        if (!fileHandle) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return HFILE_ERROR;
        }

        try {
            const vfs = System.getInstance().fileSystem;
            const newPos = vfs.setPosition((fileHandle as FileHandleWrapper).vfsHandle, lOffset, iOrigin);
            return newPos | 0;
        } catch {
            System.getInstance().scheduler.setLastError(ERROR_SEEK);
            return HFILE_ERROR;
        }
    };

    // _lread - old file read wrapper.
    exports['_lread'] = (ctx, mem, args) => {
        const hFile = args[0];
        const lpBuffer = args[1];
        const uBytes = args[2] >>> 0;

        if (!lpBuffer || lpBuffer + uBytes > mem.length) {
            System.getInstance().scheduler.setLastError(ERROR_NOACCESS);
            return HFILE_ERROR;
        }

        const fileHandle = System.getInstance().resourceProvider.getFileHandle(hFile);
        if (!fileHandle) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return HFILE_ERROR;
        }

        try {
            const wrapper = fileHandle as FileHandleWrapper;
            const bytesRead = wrapper.readIntoSync(mem, lpBuffer, uBytes);
            if (bytesRead === null) {
                // Fallback path when sync read is unavailable.
                return 0;
            }
            return bytesRead;
        } catch {
            System.getInstance().scheduler.setLastError(ERROR_SEEK);
            return HFILE_ERROR;
        }
    };

    exports['GetFileSize'] = (ctx, mem, args) => {
        const hFile = args[0];
        const lpFileSizeHigh = args[1];

        const resourceProvider = System.getInstance().resourceProvider;
        const fileHandle = resourceProvider.getFileHandle(hFile);
        let filename = "";
        if (fileHandle) {
            const vfsHandle = (fileHandle as FileHandleWrapper).vfsHandle;
            filename = vfsHandle.path || "";
        }

        Logger.verbose(LogCategory.KERNEL32, `GetFileSize(0x${hFile.toString(16)}, "${filename}")`);

        if (!fileHandle) {
            return INVALID_HANDLE_VALUE;
        }

        try {
            const size = fileHandle.size;
            Logger.verbose(LogCategory.KERNEL32, `GetFileSize: "${filename}" size=${size} bytes`);

            if (lpFileSizeHigh) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(lpFileSizeHigh, Math.floor(size / 0x100000000), true);
            }

            return size & 0xFFFFFFFF;
        } catch (error) {
            Logger.error(LogCategory.KERNEL32, `GetFileSize failed: ${error}`);
            return INVALID_HANDLE_VALUE;
        }
    };

    // All ANSI functions (ending with 'A') use UTF-8 encoding instead of system codepage (Windows-1251, Latin1, etc.)
    // This is a simplification for the emulator. Real Windows uses the current system ANSI codepage,
    // which may affect legacy applications with non-ASCII filenames.
    exports['GetFileAttributesA'] = (ctx, mem, args) => {
        const lpFileName = args[0];
        const filename = lpFileName ? readStringA(mem, lpFileName) : '';
        if (filename.toLowerCase().endsWith('.bmp')) {
            Logger.log(LogCategory.KERNEL32, `GetFileAttributesA BMP: "${filename}"`);
        } else {
            Logger.log(LogCategory.KERNEL32, `GetFileAttributesA("${filename}")`);
        }

        const vfs = System.getInstance().fileSystem;
        const resolved = vfs.resolvePath(filename);
        if (filename.toLowerCase().endsWith('.bmp')) {
            const relRom = (vfs as any).relRomPath ? (vfs as any).relRomPath(resolved) : "";
            const hasRom = vfs.hasRomFile(resolved);
            const romSize = (vfs as any).romIndex?.size ?? 0;
            Logger.log(
                LogCategory.KERNEL32,
                `GetFileAttributesA BMP diag: resolved="${resolved}" relRom="${relRom}" hasRom=${hasRom} romIndexSize=${romSize}`
            );
        }

        if (vfs.directoryExists(resolved)) {
            return FILE_ATTRIBUTE_DIRECTORY;
        }

        if (vfs.fileExists(resolved)) {
            return FILE_ATTRIBUTE_ARCHIVE;
        }

        Logger.verbose(LogCategory.KERNEL32, `GetFileAttributesA: file not found "${filename}"`);
        System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
        return INVALID_FILE_ATTRIBUTES;
    };

    exports['GetFileAttributesW'] = (ctx, mem, args) => {
        const lpFileName = args[0];
        const filename = lpFileName ? readStringW(mem, lpFileName) : '';
        if (filename.toLowerCase().endsWith('.bmp')) {
            Logger.log(LogCategory.KERNEL32, `GetFileAttributesW BMP: "${filename}"`);
        } else {
            Logger.log(LogCategory.KERNEL32, `GetFileAttributesW("${filename}")`);
        }

        const vfs = System.getInstance().fileSystem;
        const resolved = vfs.resolvePath(filename);
        if (filename.toLowerCase().endsWith('.bmp')) {
            const relRom = (vfs as any).relRomPath ? (vfs as any).relRomPath(resolved) : "";
            const hasRom = vfs.hasRomFile(resolved);
            const romSize = (vfs as any).romIndex?.size ?? 0;
            Logger.log(
                LogCategory.KERNEL32,
                `GetFileAttributesW BMP diag: resolved="${resolved}" relRom="${relRom}" hasRom=${hasRom} romIndexSize=${romSize}`
            );
        }

        if (vfs.directoryExists(resolved)) {
            return FILE_ATTRIBUTE_DIRECTORY;
        }

        if (vfs.fileExists(resolved)) {
            return FILE_ATTRIBUTE_ARCHIVE;
        }

        Logger.verbose(LogCategory.KERNEL32, `GetFileAttributesW: file not found "${filename}"`);
        System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
        return INVALID_FILE_ATTRIBUTES;
    };

    exports['SetFileAttributesA'] = (ctx, mem, args) => {
        const lpFileName = args[0];
        const dwFileAttributes = args[1];
        const filename = lpFileName ? readStringA(mem, lpFileName) : '';

        Logger.verbose(LogCategory.KERNEL32, `SetFileAttributesA("${filename}", 0x${dwFileAttributes.toString(16)})`);

        // In the emulator's VFS, we don't actually support file attributes modification
        // since the underlying storage (ROM/OPFS) doesn't have traditional Windows attributes.
        // We'll just pretend success if the file exists.
        const vfs = System.getInstance().fileSystem;
        const resolved = vfs.resolvePath(filename);

        if (vfs.directoryExists(resolved) || vfs.fileExists(resolved)) {
            // File exists - pretend we set attributes successfully
            return 1; // TRUE
        }

        // File not found
        System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
        return 0; // FALSE
    };

    exports['SetFileAttributesW'] = (ctx, mem, args) => {
        const lpFileName = args[0];
        const dwFileAttributes = args[1];
        const filename = lpFileName ? readStringW(mem, lpFileName) : '';

        Logger.verbose(LogCategory.KERNEL32, `SetFileAttributesW("${filename}", 0x${dwFileAttributes.toString(16)})`);

        const vfs = System.getInstance().fileSystem;
        const resolved = vfs.resolvePath(filename);

        if (vfs.directoryExists(resolved) || vfs.fileExists(resolved)) {
            return 1; // TRUE
        }

        System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
        return 0; // FALSE
    };

    // CloseHandle is now synchronous - overlay flush is fire-and-forget
    exports['CloseHandle'] = (ctx, mem, args) => {
        const hObject = args[0];

        Logger.verbose(LogCategory.KERNEL32, `CloseHandle(0x${hObject.toString(16)})`);
        readFileFirstLogged.delete(hObject);
        // Handle values are recycled: a completion-port binding must die with the handle
        // that owns it, or the next file to get this value posts into someone else's port.
        dissociateIoCompletionHandle(hObject);

        const resourceProvider = System.getInstance().resourceProvider;
        const resource = resourceProvider.getResource(hObject);

        if (!resource) {
            return 0; // FALSE
        }

        try {
            switch (resource.type) {
                case 'file_handle':
                    const fileHandle = resource.resource;

                    // Check if this is a console device handle
                    if (isConsoleDeviceHandle(fileHandle)) {
                        fileHandle.close(); // Flush buffer and cleanup
                        resourceProvider.unregisterFileHandle(hObject);
                        Logger.verbose(LogCategory.KERNEL32, `CloseHandle: closed console device handle 0x${hObject.toString(16)}`);
                        break;
                    }

                    // Regular file handle
                    const vfsHandle = (fileHandle as FileHandleWrapper).vfsHandle;
                    const filename = vfsHandle.path || "";
                    if (filename.toLowerCase().endsWith('.bmp')) {
                        Logger.log(LogCategory.KERNEL32, `CloseHandle BMP: "${filename}" (0x${hObject.toString(16)})`);
                    } else if (filename.toLowerCase().endsWith('.ini')) {
                        Logger.log(LogCategory.KERNEL32, `CloseHandle INI: "${filename}" (0x${hObject.toString(16)})`);
                    } else {
                        Logger.verbose(LogCategory.KERNEL32, `CloseHandle(0x${hObject.toString(16)})`);
                    }
                    // For overlay files, fire-and-forget flush (don't block on async)
                    // ROM files don't need flush
                    if (vfsHandle.source === 'overlay') {
                        const vfs = System.getInstance().fileSystem;
                        vfs.flushFile(vfsHandle.path).catch(error => {
                            Logger.warn(LogCategory.KERNEL32, `CloseHandle: fire-and-forget flush failed for "${filename}": ${error}`);
                        });
                    }
                    fileHandle.close();
                    resourceProvider.unregisterFileHandle(hObject);
                    break;
                case 'kernel_object': {
                    // Named sync objects (mutex/event/semaphore) persist while >=1 open
                    // handle references them. Decrement the named-object refcount; only
                    // destroy the underlying kernel object when the LAST reference closes,
                    // so a later Open* correctly fails and a later Create* makes a fresh
                    // object (faithful Windows named-object lifetime). 'not-named' handles
                    // (and the final 'destroyed' reference) fall through to normal teardown.
                    const namedResult = namedObjects.releaseByHandle(hObject);
                    if (namedResult === 'still-open') {
                        Logger.verbose(LogCategory.KERNEL32,
                            `CloseHandle(0x${hObject.toString(16)}): named object still referenced — kept alive`);
                        break;
                    }
                    const kernelObj = resourceProvider.getKernelObject(hObject);
                    if (kernelObj?.kind === 'iocp') {
                        // Threads parked in GetQueuedCompletionStatus on this port would
                        // otherwise wait for a packet the closed port can never deliver.
                        abandonIoCompletionWaiters(hObject);
                    }
                    if (kernelObj?.kind === 'event') {
                        hypercallDataManager.unregisterEventMirror(hObject);
                    } else if (kernelObj?.kind === 'mutex') {
                        hypercallDataManager.unregisterMutexMirror(hObject);
                    }
                    resourceProvider.unregisterKernelObject(hObject);
                    break;
                }
                default:
                    Logger.warn(LogCategory.KERNEL32, `CloseHandle: unhandled resource type ${resource.type}`);
                    return 0;
            }

            return 1; // TRUE
        } catch (error) {
            Logger.error(LogCategory.KERNEL32, `CloseHandle failed: ${error}`);
            return 0; // FALSE
        }
    };

    // _lclose - old file close wrapper.
    exports['_lclose'] = (ctx, mem, args) => {
        const result = exports['CloseHandle']!(ctx, mem, args);
        if (typeof result === 'number') {
            return result ? 0 : HFILE_ERROR;
        }
        if (result && typeof result === 'object' && 'value' in result) {
            const ok = (result as any).value ? 1 : 0;
            return ok ? 0 : HFILE_ERROR;
        }
        return 0;
    };

    exports['SetFilePointerEx'] = (ctx, mem, args) => {
        try {
            const hFile = args[0];
            const liDistanceToMoveLow = args[1] >>> 0;
            const liDistanceToMoveHigh = args[2] >>> 0;
            const lpNewFilePointer = args[3];
            const dwMoveMethod = args[4];

            const resourceProvider = System.getInstance().resourceProvider;
            const fileHandle = resourceProvider.getFileHandle(hFile);
            if (!fileHandle) {
                System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
                return 0; // FALSE
            }

            if (!mem.buffer || mem.buffer.byteLength === 0) {
                throw new Error('Memory detached - cannot access buffer');
            }

            if (shouldLogSetFilePointer(hFile)) {
                Logger.verbose(
                    LogCategory.KERNEL32,
                    `SetFilePointerEx(handle=0x${hFile.toString(16)}, distLow=0x${liDistanceToMoveLow.toString(16)}, distHigh=0x${liDistanceToMoveHigh.toString(16)}, method=${dwMoveMethod}) ` +
                    `lpNewFilePointer=0x${lpNewFilePointer.toString(16)} ESP=0x${ctx.esp.toString(16)}`
                );
            }

            let distance = (BigInt(liDistanceToMoveHigh) << 32n) | BigInt(liDistanceToMoveLow);
            if (distance & (1n << 63n)) {
                distance -= 1n << 64n;
            }

            const vfs = System.getInstance().fileSystem;
            const vfsHandle = (fileHandle as FileHandleWrapper).vfsHandle;
            const distNum = Number(distance);
            if (!Number.isFinite(distNum)) {
                System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            const newPos = vfs.setPosition(vfsHandle, distNum, dwMoveMethod);

            // Write new position to caller's output variable if provided.
            // Writing to caller's stack variables (addresses >= ESP) is perfectly legal.
            if (lpNewFilePointer && lpNewFilePointer + 8 <= mem.length) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setBigInt64(lpNewFilePointer, BigInt(newPos), true);
            }

            return 1; // TRUE
        } catch (error) {
            Logger.error(LogCategory.KERNEL32, `SetFilePointerEx exception: ${error}`);
            System.getInstance().scheduler.setLastError(ERROR_SEEK);
            return 0; // FALSE
        }
    };

    exports['FlushFileBuffers'] = async (ctx, mem, args) => {
        const hFile = args[0];
        const resourceProvider = System.getInstance().resourceProvider;
        const fileHandle = resourceProvider.getFileHandle(hFile);

        if (!fileHandle) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0; // FALSE
        }

        const vfsHandle = (fileHandle as FileHandleWrapper).vfsHandle;
        try {
            await System.getInstance().fileSystem.flushFile(vfsHandle.path);
            return 1; // TRUE
        } catch (error) {
            Logger.error(LogCategory.KERNEL32, `FlushFileBuffers failed: ${error}`);
            return 0; // FALSE
        }
    };

    // BOOL LockFile(HANDLE hFile, DWORD dwFileOffsetLow, DWORD dwFileOffsetHigh,
    //   DWORD nNumberOfBytesToLockLow, DWORD nNumberOfBytesToLockHigh)
    // No file locking in emulator — always succeed
    exports['LockFile'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.KERNEL32, `LockFile(0x${args[0].toString(16)}) -> stub`);
        return 1; // TRUE
    };

    // BOOL UnlockFile(HANDLE hFile, DWORD dwFileOffsetLow, DWORD dwFileOffsetHigh,
    //   DWORD nNumberOfBytesToUnlockLow, DWORD nNumberOfBytesToUnlockHigh)
    exports['UnlockFile'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.KERNEL32, `UnlockFile(0x${args[0].toString(16)}) -> stub`);
        return 1; // TRUE
    };

    // BOOL CreatePipe(PHANDLE hReadPipe, PHANDLE hWritePipe, LPSECURITY_ATTRIBUTES lpPipeAttributes, DWORD nSize)
    // Stub — return failure, pipes not supported
    exports['CreatePipe'] = (ctx, mem, args) => {
        Logger.warn(LogCategory.KERNEL32, `CreatePipe -> stub (not supported)`);
        System.getInstance().scheduler.setLastError(120); // ERROR_CALL_NOT_IMPLEMENTED
        return 0; // FALSE
    };

    exports['SetStdHandle'] = (ctx, mem, args) => {
        return 1; // TRUE
    };

    exports['SetHandleCount'] = (ctx, mem, args) => {
        const uNumber = args[0];
        Logger.log(LogCategory.KERNEL32, `SetHandleCount called: uNumber=${uNumber}`);
        // Legacy function, return default handle count
        return 512;
    };

    // PeekNamedPipe - peeks at data available in a named pipe
    exports['PeekNamedPipe'] = (ctx, mem, args) => {
        const hNamedPipe = args[0];
        const lpBuffer = args[1];
        const nBufferSize = args[2];
        const lpBytesRead = args[3];
        const lpTotalBytesAvail = args[4];
        const lpBytesLeftThisMessage = args[5];

        Logger.verbose(LogCategory.KERNEL32,
            `PeekNamedPipe(handle=0x${hNamedPipe.toString(16)}, bufSize=${nBufferSize})`);

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        // Stub: report no data available
        if (lpBytesRead) view.setUint32(lpBytesRead, 0, true);
        if (lpTotalBytesAvail) view.setUint32(lpTotalBytesAvail, 0, true);
        if (lpBytesLeftThisMessage) view.setUint32(lpBytesLeftThisMessage, 0, true);

        return 1; // TRUE - success, but no data
    };

    // GetFileInformationByHandle - retrieves file information for a handle
    exports['GetFileInformationByHandle'] = (ctx, mem, args) => {
        const hFile = args[0];
        const lpFileInformation = args[1]; // BY_HANDLE_FILE_INFORMATION (52 bytes)

        Logger.verbose(LogCategory.KERNEL32,
            `GetFileInformationByHandle(handle=0x${hFile.toString(16)}, lpInfo=0x${lpFileInformation.toString(16)})`);

        if (!lpFileInformation || lpFileInformation + 52 > mem.length) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0; // FALSE
        }

        const resourceProvider = System.getInstance().resourceProvider;
        const fileHandle = resourceProvider.getFileHandle(hFile);
        if (!fileHandle) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0; // FALSE
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const fileSize = fileHandle.size;

        // BY_HANDLE_FILE_INFORMATION layout:
        // +0:  dwFileAttributes (DWORD)
        // +4:  ftCreationTime (FILETIME, 8 bytes)
        // +12: ftLastAccessTime (FILETIME, 8 bytes)
        // +20: ftLastWriteTime (FILETIME, 8 bytes)
        // +28: dwVolumeSerialNumber (DWORD)
        // +32: nFileSizeHigh (DWORD)
        // +36: nFileSizeLow (DWORD)
        // +40: nNumberOfLinks (DWORD)
        // +44: nFileIndexHigh (DWORD)
        // +48: nFileIndexLow (DWORD)
        view.setUint32(lpFileInformation + 0, 0x80, true);   // FILE_ATTRIBUTE_NORMAL
        // Creation/access/write times: 2020-01-01 as FILETIME
        const fakeTime = 132224352000000000n; // 2020-01-01 as FILETIME
        view.setBigUint64(lpFileInformation + 4, fakeTime, true);
        view.setBigUint64(lpFileInformation + 12, fakeTime, true);
        view.setBigUint64(lpFileInformation + 20, fakeTime, true);
        view.setUint32(lpFileInformation + 28, 0x12345678, true); // Volume serial
        view.setUint32(lpFileInformation + 32, (fileSize >>> 0) > 0xFFFFFFFF ? 1 : 0, true); // SizeHigh
        view.setUint32(lpFileInformation + 36, fileSize >>> 0, true); // SizeLow
        view.setUint32(lpFileInformation + 40, 1, true);  // nNumberOfLinks
        view.setUint32(lpFileInformation + 44, 0, true);  // nFileIndexHigh
        view.setUint32(lpFileInformation + 48, hFile, true); // nFileIndexLow (use handle as unique ID)

        return 1; // TRUE
    };

    exports['CreateSymbolicLinkW'] = () => {
        System.getInstance().scheduler.setLastError(1314); // ERROR_PRIVILEGE_NOT_HELD
        return 0;
    };

    exports['GetFileInformationByHandleEx'] = (ctx, mem, args) => {
        const hFile = args[0] >>> 0;
        const infoClass = args[1] >>> 0;
        const lpBuffer = args[2] >>> 0;
        const dwBufferSize = args[3] >>> 0;

        const resourceProvider = System.getInstance().resourceProvider;
        const fileHandle = resourceProvider.getFileHandle(hFile);
        if (!fileHandle) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const fileSize = fileHandle.size >>> 0;
        const fakeTime = 132224352000000000n;

        // FileBasicInfo = 0 (40 bytes)
        if (infoClass === 0) {
            if (!lpBuffer || dwBufferSize < 40 || lpBuffer + 40 > mem.length) {
                System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            // FILE_BASIC_INFO: CreationTime(0) LastAccessTime(8) LastWriteTime(16)
            // ChangeTime(24) FileAttributes(32) — 4 bytes trailing pad to 40.
            view.setBigUint64(lpBuffer + 0, fakeTime, true);
            view.setBigUint64(lpBuffer + 8, fakeTime, true);
            view.setBigUint64(lpBuffer + 16, fakeTime, true);
            view.setBigUint64(lpBuffer + 24, fakeTime, true); // ChangeTime
            view.setUint32(lpBuffer + 32, 0x80, true);        // FileAttributes = FILE_ATTRIBUTE_NORMAL
            view.setUint32(lpBuffer + 36, 0, true);           // pad
            return 1;
        }

        // FileStandardInfo = 1 (24 bytes)
        if (infoClass === 1) {
            if (!lpBuffer || dwBufferSize < 24 || lpBuffer + 24 > mem.length) {
                System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            view.setBigUint64(lpBuffer + 0, BigInt(fileSize), true);
            view.setBigUint64(lpBuffer + 8, BigInt(fileSize), true);
            view.setUint32(lpBuffer + 16, 1, true);
            view.setUint8(lpBuffer + 20, 0);
            view.setUint8(lpBuffer + 21, 0);
            return 1;
        }

        System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
        return 0;
    };

    exports['SetFileInformationByHandle'] = () => {
        System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
        return 0;
    };

    const reset = (): void => {
        namedFileMappings.clear();
        fileMappingViews.clear();
        readFileFirstLogged.clear();
        readFileLastThread.clear();
        shortReadLogCount = 0;
        sharedHandleLogCount = 0;
        setFilePointerCallCounts.clear();
    };

    return { exports, reset };
})();

export const exports: Record<string, ThunkImplementation> = fileIoModule.exports;

export function resetFileIoState(): void {
    fileIoModule.reset();
}

/**
 * Register fast-path implementations for high-frequency file I/O.
 * SetFilePointer: ~44K calls (169ms), ReadFile: ~33K calls (286ms) in UT99 demo.
 * Bypasses full thunk context deserialization for sync operations.
 */
export function registerFastPathFileIOFunctions(dispatcher: any): void {
    if (!dispatcher || typeof dispatcher.registerFastPath !== 'function') return;

    // =========================================================================
    // SetFilePointer fast path — 44K calls, 169ms
    // =========================================================================
    dispatcher.registerFastPath('kernel32', 'SetFilePointer', (cpu: any, mem8: Uint8Array): number | null => {
        const esp = cpu.reg32[4];
        if (esp + 20 > mem8.length) return null;
        const view = new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);

        // Stack layout (stdcall @16):
        // esp + 0  = return address
        // esp + 4  = hFile
        // esp + 8  = lDistanceToMoveLow (signed)
        // esp + 12 = lpDistanceToMoveHigh (pointer, may be NULL)
        // esp + 16 = dwMoveMethod
        const hFile = view.getUint32(esp + 4, true);
        const lDistanceToMoveLow = view.getInt32(esp + 8, true);
        const lpDistanceToMoveHigh = view.getUint32(esp + 12, true);
        const dwMoveMethod = view.getUint32(esp + 16, true);

        // Skip std handles
        if (hFile <= 2 || hFile === 0xFFFFFFFF) return null;

        const resourceProvider = System.getInstance().resourceProvider;
        const fileHandle = resourceProvider.getFileHandle(hFile);
        if (!fileHandle || !fileHandle.vfsHandle) return null;

        // Read high 32 bits if pointer provided
        let distance: number;
        if (lpDistanceToMoveHigh === 0) {
            distance = lDistanceToMoveLow;
        } else {
            if (lpDistanceToMoveHigh + 4 > mem8.length) return null;
            const distHigh = view.getInt32(lpDistanceToMoveHigh, true);
            distance = (distHigh * 0x100000000) + (lDistanceToMoveLow >>> 0);
        }

        const vfs = System.getInstance().fileSystem;
        const newPosition = vfs.setPosition(fileHandle.vfsHandle, distance, dwMoveMethod);
        // Write high 32 bits back if pointer provided
        if (lpDistanceToMoveHigh !== 0 && lpDistanceToMoveHigh + 4 <= mem8.length) {
            const newPosHigh = Math.floor(newPosition / 0x100000000) | 0;
            view.setInt32(lpDistanceToMoveHigh, newPosHigh, true);
        }

        if (ioTraceRing.isEnabled()) ioTraceRing.record('seek', hFile, fileHandle.vfsHandle.path, newPosition, 0, 0);

        System.getInstance().scheduler.setLastError(0);
        return (newPosition >>> 0) & 0xFFFFFFFF;
    });

    // =========================================================================
    // ReadFile fast path — 33K calls, 286ms (sync ROM cache hits only)
    // =========================================================================
    dispatcher.registerFastPath('kernel32', 'ReadFile', (cpu: any, mem8: Uint8Array): number | null => {
        const esp = cpu.reg32[4];
        if (esp + 24 > mem8.length) return null;
        const view = new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);

        // Stack layout (stdcall @20):
        // esp + 0  = return address
        // esp + 4  = hFile
        // esp + 8  = lpBuffer
        // esp + 12 = nNumberOfBytesToRead
        // esp + 16 = lpNumberOfBytesRead
        // esp + 20 = lpOverlapped
        const hFile = view.getUint32(esp + 4, true);
        const lpBuffer = view.getUint32(esp + 8, true);
        const nBytesToRead = view.getUint32(esp + 12, true);
        const lpBytesRead = view.getUint32(esp + 16, true);
        const lpOverlapped = view.getUint32(esp + 20, true);

        // Overlapped I/O needs slow path for seek + event signaling
        if (lpOverlapped) return null;

        // Skip std handles and console devices
        if (hFile <= 2 || hFile === 0xFFFFFFFF) return null;

        const resourceProvider = System.getInstance().resourceProvider;
        const fileHandle = resourceProvider.getFileHandle(hFile);
        if (!fileHandle || !fileHandle.vfsHandle) return null;

        // Only fast-path for sync reads with valid buffer
        if (lpBuffer + nBytesToRead > mem8.length) return null;

        const bytesRead = fileHandle.readIntoSync(mem8, lpBuffer, nBytesToRead);
        if (bytesRead === null) return null; // needs async, fallthrough to slow path
        if (ioTraceRing.isEnabled()) ioTraceRing.record('read', hFile, fileHandle.vfsHandle.path, fileHandle.vfsHandle.position - bytesRead, nBytesToRead, bytesRead);
        if (LARGE_IO_TRACE_ENABLED) traceLargeRead(
            'ReadFile',
            fileHandle.vfsHandle.path,
            hFile,
            fileHandle.vfsHandle.position - bytesRead,
            nBytesToRead,
            bytesRead,
        );

        if (lpBytesRead && lpBytesRead + 4 <= mem8.length) {
            view.setUint32(lpBytesRead, bytesRead, true);
        }

        System.getInstance().scheduler.setLastError(0);
        return 1; // TRUE
    });
}
