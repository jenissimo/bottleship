import { ThunkImplementation, ThunkResult } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { MemoryGuard } from "../../core/memory/mem-guard";
import { System } from "../../core/system";
import { VfsFileHandle } from "../../runtime/filesystem/vfs";
import { MSSContext } from "./context";
import { detectAilFileTypeFromMemory, readFilenameArg, readStackArg, resolveVfsHandle } from "./helpers";
import {
    GuestCallChain, fileSizeViaApp, hasAppFileCallbacks, readWholeFileViaApp, runGuestCallChain,
} from "./app-file-io";

const FILE_READ_WITH_SIZE = 0xFFFFFFFF;

export function createFileIOExports(ctx: MSSContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};
    const system = System.getInstance();

    // _AIL_file_read@8
    const fileReadCompat: ThunkImplementation = (ctxThunk, mem, args): ThunkResult | Promise<ThunkResult> => {
        const arg0 = args[0];
        const arg1 = args[1];
        const vfsHandle = resolveVfsHandle(ctx, arg0);
        const filename = !vfsHandle ? getLikelyFilename(mem, arg0) : null;

        if (filename) {
            Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_file_read@8 called: filename="${filename}" (ptr=0x${arg0.toString(16)}), dest=0x${arg1.toString(16)}`);
            if (hasAppFileCallbacks(ctx)) {
                const chain = (function* (): GuestCallChain {
                    const data = yield* readWholeFileViaApp(ctx, arg0, filename);
                    return deliverFileData(ctx, data, arg1, filename);
                })();
                const r = runGuestCallChain(ctx, ctxThunk, 8, "mss32:AIL_file_read", chain);
                return typeof r === "number" ? { value: r, stackCleanup: 8 } : r;
            }
            return readFileByName(ctx, filename, arg1, mem).then(value => ({ value, stackCleanup: 8 }));
        }

        const fileHandle = arg0;
        const buffer = arg1;
        const bytes = readStackArg(mem, ctxThunk.esp, 2) ?? args[2] ?? 0;
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_file_read@8 called: fileHandle=0x${fileHandle.toString(16)}, buffer=0x${buffer.toString(16)}, bytes=${bytes}`);
        return fileReadLowLevel(ctx, mem, fileHandle, buffer, bytes).then(value => ({ value, stackCleanup: 8 }));
    };
    exports["_AIL_file_read@8"] = fileReadCompat;

    // _AIL_file_read@12
    const fileRead12: ThunkImplementation = (ctxThunk, mem, args) => {
        const arg0 = args[0];
        const arg1 = args[1];
        const arg2 = args[2];
        const vfsHandle = resolveVfsHandle(ctx, arg0);
        const filename = !vfsHandle ? getLikelyFilename(mem, arg0) : null;

        if (filename) {
            Logger.log(
                LogCategory.SYSTEM,
                `MSS32: _AIL_file_read@12 called: filename="${filename}" (ptr=0x${arg0.toString(16)}), dest=0x${arg1.toString(16)}, bytes=${arg2}`
            );
            const requestedBytes = (arg2 >>> 0);
            const useRequestedBytes = arg1 !== 0 && arg1 !== FILE_READ_WITH_SIZE && requestedBytes > 0;
            const maxBytes = useRequestedBytes ? requestedBytes : 0;
            if (hasAppFileCallbacks(ctx)) {
                const chain = (function* (): GuestCallChain {
                    const data = yield* readWholeFileViaApp(ctx, arg0, filename, maxBytes);
                    return deliverFileData(ctx, data, arg1, filename);
                })();
                return runGuestCallChain(ctx, ctxThunk, 12, "mss32:AIL_file_read", chain);
            }
            return readFileByName(ctx, filename, arg1, mem, maxBytes);
        }

        const fileHandle = arg0;
        const buffer = arg1;
        const bytes = arg2;
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_file_read@12 called: fileHandle=0x${fileHandle.toString(16)}, buffer=0x${buffer.toString(16)}, bytes=${bytes}`);
        return fileReadLowLevel(ctx, mem, fileHandle, buffer, bytes);
    };
    exports["_AIL_file_read@12"] = fileRead12;

    // _AIL_file_type@8 — S32 AIL_file_type(void const* data, U32 size)
    const ailFileType: ThunkImplementation = (ctxThunk, mem, args) => {
        const dataPtr = args[0];
        const size = args[1] | 0;
        const fileType = detectAilFileTypeFromMemory(mem, dataPtr, size);
        Logger.verbose(
            LogCategory.SYSTEM,
            `MSS32: _AIL_file_type@8: ptr=0x${dataPtr.toString(16)} size=${size} → ${fileType}`
        );
        return fileType;
    };
    exports["_AIL_file_type@8"] = ailFileType;
    exports["AIL_file_type"] = ailFileType;

    // _AIL_file_size@4
    exports["_AIL_file_size@4"] = (ctxThunk, mem, args) => {
        const arg0 = args[0];
        const vfsHandle = resolveVfsHandle(ctx, arg0);
        const filename = !vfsHandle ? getLikelyFilename(mem, arg0) : null;

        if (filename) {
            Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_file_size@4 called: filename="${filename}" (ptr=0x${arg0.toString(16)})`);
            if (hasAppFileCallbacks(ctx)) {
                return runGuestCallChain(
                    ctx, ctxThunk, 4, "mss32:AIL_file_size", fileSizeViaApp(ctx, arg0, filename));
            }
            try {
                const fileSize = system.fileSystem.getFileSize(filename);
                Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_file_size@4: "${filename}" size = ${fileSize} bytes`);
                return fileSize;
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_file_size@4: Error getting file size for "${filename}": ${e}`);
                return 0;
            }
        }

        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_file_size@4 called: fileHandle=0x${arg0.toString(16)}`);
        if (!vfsHandle) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_file_size@4: Invalid file handle 0x${arg0.toString(16)}`);
            return 0;
        }
        try {
            const fileSize = system.fileSystem.getFileSize(vfsHandle.path);
            Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_file_size@4: handle 0x${arg0.toString(16)} size = ${fileSize} bytes`);
            return fileSize;
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_file_size@4: Error getting file size for handle 0x${arg0.toString(16)}: ${e}`);
            return 0;
        }
    };

    // _AIL_set_file_callbacks@16(open, close, seek, read)
    //
    // The app takes over Miles' file I/O. A title that keeps its audio inside an
    // archive installs these because the names it will ask for are NOT files, so
    // from here on every AIL_file_* path must go through them and not the VFS.
    exports["_AIL_set_file_callbacks@16"] = (ctxThunk, mem, args) => {
        const [open, close, seek, read] = [args[0] >>> 0, args[1] >>> 0, args[2] >>> 0, args[3] >>> 0];
        ctx.fileCallbacks = (open || close || seek || read) ? { open, close, seek, read } : null;
        Logger.log(
            LogCategory.SYSTEM,
            `MSS32: _AIL_set_file_callbacks@16 open=0x${open.toString(16)} close=0x${close.toString(16)} ` +
            `seek=0x${seek.toString(16)} read=0x${read.toString(16)}`
        );
        return 0;
    };

    // _AIL_mem_use_malloc@4(fn) / _AIL_mem_use_free@4(fn)
    // The app's allocator for Miles' internal buffers. Ours are host-side, so there
    // is nothing to route through it; remember the pointers so a later read-back
    // (or a stream engine that must allocate in guest memory) has them.
    exports["_AIL_mem_use_malloc@4"] = (ctxThunk, mem, args) => {
        ctx.memCallbacks.malloc = args[0] >>> 0;
        return 0;
    };
    exports["_AIL_mem_use_free@4"] = (ctxThunk, mem, args) => {
        ctx.memCallbacks.free = args[0] >>> 0;
        return 0;
    };

    // _AIL_mem_alloc_lock@4
    exports["_AIL_mem_alloc_lock@4"] = (ctxThunk, mem, args) => {
        const size = args[0];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_mem_alloc_lock@4 called: size=${size}`);
        if (size <= 0 || size > 0x10000000) {
            return 0;
        }
        return ctx.process.memory.alloc(size);
    };

    // _AIL_mem_free_lock@4
    exports["_AIL_mem_free_lock@4"] = (ctxThunk, mem, args) => {
        const ptr = args[0];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_mem_free_lock@4 called: ptr=0x${ptr.toString(16)}`);
        if (ptr && ctx.memAllocatedByMss.has(ptr)) {
            ctx.process.memory.free(ptr);
            ctx.memAllocatedByMss.delete(ptr);
        }
        return 0;
    };

    return exports;
}

// ==================== Private helpers ====================

/**
 * AIL_file_read's destination contract, applied to bytes we already hold:
 * NULL = Miles allocates and returns the block, 0xFFFFFFFF = same but with the
 * size in the first DWORD, otherwise the caller's own buffer.
 */
function deliverFileData(ctx: MSSContext, data: Uint8Array | null, destBuffer: number, filename: string): number {
    if (!data || data.length === 0) return 0;

    const mem = ctx.process.getCurrentMemory();
    let targetBuffer = destBuffer;
    const writeOffset = destBuffer === FILE_READ_WITH_SIZE ? 4 : 0;

    if (destBuffer === 0 || destBuffer === FILE_READ_WITH_SIZE) {
        const allocated = ctx.process.memory.alloc(data.length + writeOffset);
        if (!allocated) {
            Logger.error(LogCategory.SYSTEM, `MSS32: AIL_file_read: no memory for ${data.length} bytes of "${filename}"`);
            return 0;
        }
        ctx.memAllocatedByMss.add(allocated);
        targetBuffer = allocated;
    }

    if (!MemoryGuard.isValidRange(mem, targetBuffer + writeOffset, data.length)) {
        Logger.error(LogCategory.SYSTEM,
            `MSS32: AIL_file_read: buffer 0x${targetBuffer.toString(16)} + ${data.length} exceeds memory bounds`);
        return 0;
    }
    if (destBuffer === FILE_READ_WITH_SIZE) {
        new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setUint32(targetBuffer, data.length, true);
    }
    MemoryGuard.writeBytes(mem, targetBuffer + writeOffset, data, "MSS32:AIL_file_read");
    return targetBuffer;
}

async function readFileByName(
    ctx: MSSContext,
    filename: string,
    destBuffer: number,
    mem: Uint8Array,
    maxBytes = 0
): Promise<number> {
    const system = System.getInstance();

    try {
        const handle = system.fileSystem.openSync(filename, 0x80000000, 3);
        if (!handle) {
            const asyncHandle = await system.fileSystem.open(filename, 0x80000000, 3);
            if (!asyncHandle) {
                Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_file_read@8: Failed to open file "${filename}"`);
                return 0;
            }
            return readFileToBuffer(ctx, asyncHandle, destBuffer, mem, filename, maxBytes);
        }
        return readFileToBuffer(ctx, handle, destBuffer, mem, filename, maxBytes);
    } catch (e) {
        Logger.error(LogCategory.SYSTEM, `MSS32: _AIL_file_read@8: Error reading file "${filename}": ${e}`);
        return 0;
    }
}

async function readFileToBuffer(
    ctx: MSSContext,
    vfsHandle: VfsFileHandle,
    destBuffer: number,
    mem: Uint8Array,
    filename: string,
    maxBytes = 0
): Promise<number> {
    const system = System.getInstance();

    try {
        const fullFileSize = system.fileSystem.getFileSize(vfsHandle.path);
        if (fullFileSize <= 0) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_file_read@8: File "${filename}" is empty or not found`);
            return 0;
        }

        const requestedBytes = (maxBytes >>> 0);
        const fileSize = requestedBytes > 0 ? Math.min(fullFileSize, requestedBytes) : fullFileSize;
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_file_read@8: File "${filename}" size=${fullFileSize}, read=${fileSize}`);

        let targetBuffer = destBuffer;
        if (destBuffer === 0 || destBuffer === FILE_READ_WITH_SIZE) {
            const allocSize = destBuffer === FILE_READ_WITH_SIZE ? fileSize + 4 : fileSize;
            const allocatedPtr = ctx.process.memory.alloc(allocSize);
            if (!allocatedPtr || allocatedPtr === 0) {
                Logger.error(LogCategory.SYSTEM, `MSS32: _AIL_file_read@8: Failed to allocate ${allocSize} bytes for file "${filename}"`);
                return 0;
            }
            ctx.memAllocatedByMss.add(allocatedPtr);
            targetBuffer = allocatedPtr;
            Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_file_read@8: Allocated ${allocSize} bytes at 0x${targetBuffer.toString(16)}`);
        }

        const writeOffset = destBuffer === FILE_READ_WITH_SIZE ? 4 : 0;
        if (!MemoryGuard.isValidRange(mem, targetBuffer + writeOffset, fileSize)) {
            Logger.error(LogCategory.SYSTEM,
                `MSS32: _AIL_file_read@8: Buffer 0x${targetBuffer.toString(16)} + ${fileSize} exceeds memory bounds`);
            return 0;
        }

        let fileData: Uint8Array | null = null;
        let usedAsync = false;

        system.fileSystem.setPosition(vfsHandle, 0, 0);

        fileData = system.fileSystem.readSync(vfsHandle, fileSize);
        if (!fileData) {
            fileData = await system.fileSystem.read(vfsHandle, fileSize);
            usedAsync = true;
        }

        if (!fileData || fileData.length === 0) {
            Logger.error(LogCategory.SYSTEM, `MSS32: _AIL_file_read@8: Failed to read file "${filename}"`);
            return 0;
        }

        let targetMem = mem;
        if (usedAsync) {
            const process = system.process;
            const v86 = process?.v86;
            const freshMem = v86?.mem8 || (v86?.v86 && v86.v86.cpu?.mem8);
            if (!freshMem) {
                Logger.error(LogCategory.SYSTEM, `MSS32: _AIL_file_read@8: Cannot get fresh memory!`);
                return 0;
            }
            targetMem = freshMem;
        }

        if (destBuffer === FILE_READ_WITH_SIZE) {
            const view = new DataView(targetMem.buffer, targetMem.byteOffset, targetMem.byteLength);
            view.setUint32(targetBuffer, fileSize, true);
        }
        const bytesWritten = MemoryGuard.writeBytes(targetMem, targetBuffer + writeOffset, fileData, "MSS32:_AIL_file_read@8");
        Logger.log(LogCategory.SYSTEM,
            `MSS32: _AIL_file_read@8: Read ${bytesWritten} bytes from "${filename}" to 0x${targetBuffer.toString(16)}`);
        return targetBuffer;
    } catch (e) {
        Logger.error(LogCategory.SYSTEM, `MSS32: _AIL_file_read@8: Error reading file "${filename}": ${e}`);
        return 0;
    }
}

async function fileReadLowLevel(ctx: MSSContext, mem: Uint8Array, fileHandle: number, buffer: number, bytes: number): Promise<number> {
    const system = System.getInstance();
    const MAX_READ_SIZE = 0x4000000;

    if (buffer === 0) {
        Logger.warn(LogCategory.SYSTEM,
            `MSS32: _AIL_file_read@12: NULL buffer pointer. fileHandle=0x${fileHandle.toString(16)}, bytes=${bytes}`);
        return 0;
    }

    if (bytes <= 0) {
        Logger.warn(LogCategory.SYSTEM,
            `MSS32: _AIL_file_read@12: Invalid bytes count (${bytes}). fileHandle=0x${fileHandle.toString(16)}, buffer=0x${buffer.toString(16)}`);
        return 0;
    }

    if (bytes > MAX_READ_SIZE) {
        Logger.warn(LogCategory.SYSTEM,
            `MSS32: _AIL_file_read@12: Bytes count exceeds maximum (${bytes} > ${MAX_READ_SIZE}). fileHandle=0x${fileHandle.toString(16)}, buffer=0x${buffer.toString(16)}`);
        return 0;
    }

    if (!MemoryGuard.isValidRange(mem, buffer, 1)) {
        Logger.warn(LogCategory.SYSTEM,
            `MSS32: _AIL_file_read@12: Buffer address out of bounds. buffer=0x${buffer.toString(16)}, bytes=${bytes}`);
        return 0;
    }

    let readSize = bytes;
    if (!MemoryGuard.isValidRange(mem, buffer, bytes)) {
        const maxAvailable = Math.max(0, mem.length - buffer);
        Logger.warn(LogCategory.SYSTEM,
            `MSS32: _AIL_file_read@12: Buffer+bytes exceeds memory bounds. buffer=0x${buffer.toString(16)}, bytes=${bytes}, maxAvailable=${maxAvailable}`);
        if (maxAvailable > 0) {
            readSize = maxAvailable;
        } else {
            return 0;
        }
    }

    const vfsHandle = resolveVfsHandle(ctx, fileHandle);
    if (!vfsHandle) {
        Logger.warn(LogCategory.SYSTEM,
            `MSS32: _AIL_file_read@12: Invalid file handle 0x${fileHandle.toString(16)}`);
        return 0;
    }

    try {
        const fileSize = system.fileSystem.getFileSize(vfsHandle.path);
        const currentPosition = system.fileSystem.tell(vfsHandle);
        const remainingBytes = fileSize - currentPosition;

        if (readSize > remainingBytes) {
            readSize = remainingBytes;
        }

        if (readSize <= 0) {
            return 0;
        }

        const syncData = system.fileSystem.readSync(vfsHandle, readSize);
        if (syncData) {
            const writeLen = MemoryGuard.writeBytes(mem, buffer, syncData, "MSS32:_AIL_file_read@12");
            Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_file_read@12: Read ${writeLen} bytes`);
            return writeLen;
        }

        const data = await system.fileSystem.read(vfsHandle, readSize);
        const process = system.process;
        const v86 = process?.v86;
        const freshMem = v86?.mem8 || (v86?.v86 && v86.v86.cpu?.mem8);
        if (!freshMem) {
            Logger.error(LogCategory.SYSTEM, `MSS32: _AIL_file_read@12: Cannot get fresh memory!`);
            return 0;
        }
        const writeLen = MemoryGuard.writeBytes(freshMem, buffer, data, "MSS32:_AIL_file_read@12");
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_file_read@12: Read ${writeLen} bytes`);
        return writeLen;
    } catch (e) {
        Logger.error(LogCategory.SYSTEM, `MSS32: _AIL_file_read@12: Error reading file: ${e}`);
        return 0;
    }
}

function getLikelyFilename(mem: Uint8Array, ptr: number): string | null {
    const candidate = readFilenameArg(mem, ptr);
    if (!candidate) return null;
    return isLikelyPath(candidate) ? candidate : null;
}

function isLikelyPath(value: string): boolean {
    if (!value || value.length < 2 || value.length > 260) return false;
    if (value.includes("\0")) return false;
    if (!/[\\\/\.:]/.test(value)) return false;
    return true;
}
