/**
 * VERSION.dll implementation.
 *
 * The block a guest gets back describes the file it named. For a PE the bundle ships that
 * is its own RT_VERSION resource, byte for byte; for a DLL we HLE it is the version of the
 * API level we implement (hle-dll-versions.ts). Answering with one constant for every file
 * is not a shortcut but a wrong answer: DirectX-era titles discover the installed DirectX
 * generation exactly this way and refuse to start on a number below their minimum.
 *
 * VerQueryValue is a generic path walk over whatever block it is handed (version-block.ts),
 * so a sub-block we never anticipated still resolves — including one the app built itself.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { isValidAddress } from "../core/memory/address-guard";
import { System } from "../core/system";
import { isVirtualHleSystemFile, HLE_SYSTEM_DLL_NAMES } from "../core/hle-system-catalog";
import { normalizeDllBaseName, resolveThunkedDllAlias } from "../core/dll-aliases";
import { readPeVersionResourceBytes } from "../core/pe-version";
import { buildHleDllVersionBlock } from "../core/hle-dll-versions";
import { queryVersionBlock } from "../core/version-block";
import { encodeAnsi } from "./codepage-utils";

const TRUE = 1;
const FALSE = 0;
const ERROR_RESOURCE_DATA_NOT_FOUND = 1812;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_INVALID_PARAMETER = 87;

/** A PE whose version resource we would have to read wholesale; well past any real DLL. */
const MAX_VERSION_SOURCE_BYTES = 128 * 1024 * 1024;

const readAsciiZ = (mem: Uint8Array, ptr: number, maxChars = 260): string => {
    if (!ptr || ptr < 0 || ptr >= mem.length) return "";
    const out: number[] = [];
    let addr = ptr;
    while (addr < mem.length && mem[addr] !== 0 && out.length < maxChars) {
        out.push(mem[addr]);
        addr++;
    }
    return String.fromCharCode(...out);
};

const readWideZ = (mem: Uint8Array, ptr: number, maxChars = 260): string => {
    if (!ptr || ptr < 0 || ptr + 1 >= mem.length) return "";
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let out = "";
    let addr = ptr;
    for (let i = 0; i < maxChars && addr + 1 < mem.length; i++, addr += 2) {
        const ch = view.getUint16(addr, true);
        if (ch === 0) break;
        out += String.fromCharCode(ch);
    }
    return out;
};

const setLastError = (code: number): void => {
    try { System.getInstance().scheduler.setLastError(code); } catch { /* pre-boot */ }
};

/** Both widths of one file's block, plus the size both GetFileVersionInfoSize forms report. */
interface VersionBlockPair {
    wide: Uint8Array;
    /** The version resource is UTF-16 for both GetFileVersionInfoA and W. */
    reportedSize: number;
}

export class Version implements IModule {
    name = "version";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;
    /** Keyed by the filename as the guest spelled it, lowercased. */
    private blockCache = new Map<string, VersionBlockPair | null>();
    /** Stable ANSI copies keyed by the caller's block and value offset. */
    private ansiQueryBuffers = new Map<string, { ptr: number; size: number }>();

    /**
     * Search order for a bare filename, mirroring the loader's: the app directory before
     * the system one, so a game shipping its own wrapper DLL sees that DLL's version.
     */
    private candidatePaths(fileName: string): string[] {
        const normalized = fileName.trim().replace(/\//g, "\\");
        if (/^[A-Za-z]:\\/.test(normalized) || normalized.startsWith("\\")) return [normalized];

        const system = System.getInstance();
        const exePath = system.executablePath ?? "";
        const lastSlash = exePath.lastIndexOf("\\");
        const appDir = lastSlash > 2 ? exePath.slice(0, lastSlash + 1) : "C:\\";
        const currentDir = system.fileSystem?.currentDir ?? appDir;

        const paths = [`${appDir}${normalized}`];
        if (currentDir.toLowerCase() !== appDir.toLowerCase()) paths.push(`${currentDir}${normalized}`);
        paths.push(`C:\\WINDOWS\\SYSTEM\\${normalized}`, `C:\\WINDOWS\\SYSTEM32\\${normalized}`);
        return paths;
    }

    private readVfsFile(path: string): Uint8Array | null | Promise<Uint8Array | null> {
        try {
            const vfs = System.getInstance().fileSystem;
            const size = vfs.getFileSize(path);
            if (size <= 0 || size > MAX_VERSION_SOURCE_BYTES) return null;
            const handle = vfs.openSync(path, 0x80000000 /* GENERIC_READ */, 3 /* OPEN_EXISTING */);
            if (!handle) return null;
            const sync = vfs.readSync(handle, size);
            if (sync !== null) return sync;
            return vfs.read(handle, size).catch((e) => {
                Logger.warn(LogCategory.SYSTEM, `[version] read("${path}") failed: ${e}`);
                return null;
            });
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `[version] read("${path}") failed: ${e}`);
            return null;
        }
    }

    private finishFileBlock(fileName: string, path: string, image: Uint8Array | null): VersionBlockPair | null {
        if (!image) return null;
        const resource = readPeVersionResourceBytes(image);
        if (!resource) {
            Logger.verbose(LogCategory.SYSTEM, `[version] "${path}" has no RT_VERSION resource`);
            return null;
        }
        Logger.log(LogCategory.SYSTEM, `[version] "${fileName}" -> ${path} (${resource.length}B resource)`);
        // The A/W distinction is only the filename parameter. Both return the native
        // UTF-16 resource; VerQueryValueA handles ANSI conversion for string values.
        return { wide: resource, reportedSize: resource.length };
    }

    private buildBlockPair(fileName: string): VersionBlockPair | null | Promise<VersionBlockPair | null> {
        const paths = this.candidatePaths(fileName);
        const visit = (index: number): VersionBlockPair | null | Promise<VersionBlockPair | null> => {
            if (index >= paths.length) return null;
            const path = paths[index];
            // The HLE check comes first per candidate: the VFS advertises these paths so
            // existence probes agree with LoadLibrary, but there are no PE bytes behind them.
            if (isVirtualHleSystemFile(path)) {
                const canonical = resolveThunkedDllAlias(normalizeDllBaseName(path));
                if (canonical && HLE_SYSTEM_DLL_NAMES.has(canonical)) {
                    const base = path.slice(path.lastIndexOf("\\") + 1);
                    const wide = buildHleDllVersionBlock(canonical, base, true);
                    if (wide) {
                        Logger.log(LogCategory.SYSTEM,
                            `[version] "${fileName}" -> HLE ${canonical} (${wide.length}B block)`);
                        return { wide, reportedSize: wide.length };
                    }
                }
                return visit(index + 1);
            }

            const image = this.readVfsFile(path);
            if (image instanceof Promise) {
                return image.then((resolved) => {
                    if (!resolved) return visit(index + 1);
                    return this.finishFileBlock(fileName, path, resolved);
                });
            }
            if (!image) return visit(index + 1);
            return this.finishFileBlock(fileName, path, image);
        };
        return visit(0);
    }

    /**
     * Return a cached block synchronously. Apart from avoiding needless work, this matters
     * for callers such as Cossacks that make the Size → Info → VerQueryValue sequence on
     * one small stack frame: only the cache miss may park the guest thread for VFS I/O.
     */
    private resolveBlock(fileName: string): VersionBlockPair | null | Promise<VersionBlockPair | null> {
        const key = fileName.toLowerCase();
        const cached = this.blockCache.get(key);
        if (cached !== undefined) return cached;
        const pending = this.buildBlockPair(fileName);
        if (!(pending instanceof Promise)) {
            this.blockCache.set(key, pending);
            if (!pending) Logger.log(LogCategory.SYSTEM, `[version] "${fileName}": no version information`);
            return pending;
        }
        return pending.then((built) => {
            this.blockCache.set(key, built);
            if (!built) {
                Logger.log(LogCategory.SYSTEM, `[version] "${fileName}": no version information`);
            }
            return built;
        });
    }

    private finishInfoSize(fileName: string, block: VersionBlockPair | null): number {
        if (!block) {
            setLastError(fileName ? ERROR_RESOURCE_DATA_NOT_FOUND : ERROR_FILE_NOT_FOUND);
            return 0;
        }
        return block.reportedSize;
    }

    private infoSize(fileName: string, lpdwHandle: number): number | Promise<number> {
        // Reserved for historical use, but Windows still writes zero when the
        // caller supplies it (Wine's conformance tests assert this as well).
        if (lpdwHandle !== 0) Mem.writeUint32(lpdwHandle, 0);
        const block = this.resolveBlock(fileName);
        return block instanceof Promise
            ? block.then((resolved) => this.finishInfoSize(fileName, resolved))
            : this.finishInfoSize(fileName, block);
    }

    private finishWriteInfo(block: VersionBlockPair | null, dwLen: number, lpData: number): number {
        if (!block) {
            setLastError(ERROR_RESOURCE_DATA_NOT_FOUND);
            return FALSE;
        }
        const bytes = block.wide;
        if (dwLen < bytes.length) {
            setLastError(ERROR_INSUFFICIENT_BUFFER);
            return FALSE;
        }
        Mem.writeBytes(lpData, bytes);
        return TRUE;
    }

    private writeInfo(fileName: string, dwLen: number, lpData: number): number | Promise<number> {
        const block = this.resolveBlock(fileName);
        return block instanceof Promise
            ? block.then((resolved) => this.finishWriteInfo(resolved, dwLen, lpData))
            : this.finishWriteInfo(block, dwLen, lpData);
    }

    /**
     * Shared VerQueryValueA/W body. pBlock is a BORROWED guest pointer whose extent is the
     * block's own wLength, so it is validated over that whole extent before the walk and
     * the walk itself runs over a copy — lplpBuffer then names the address inside pBlock.
     */
    private queryValue(pBlock: number, subBlock: string, lplpBuffer: number, puLen: number, ansi: boolean): number {
        const length = Mem.readUint16(pBlock) ?? 0;
        if (length < 6 || !isValidAddress(pBlock, length, "r")) {
            setLastError(ERROR_INVALID_PARAMETER);
            return FALSE;
        }
        const bytes = Mem.readBytes(pBlock, length);
        const found = bytes ? queryVersionBlock(bytes, subBlock) : null;
        if (!found) {
            Logger.verbose(LogCategory.SYSTEM, `[version] VerQueryValue("${subBlock}") -> not present`);
            setLastError(ERROR_RESOURCE_DATA_NOT_FOUND);
            return FALSE;
        }
        let valuePtr = (pBlock + found.offset) >>> 0;
        // File-version resources are always UTF-16. The A query API alone supplies a
        // converted ANSI copy for text values; root info and Translation stay in-place.
        if (ansi && found.type === 1) {
            const wideBytes = Mem.readBytes(valuePtr, found.len * 2);
            if (!wideBytes) { setLastError(ERROR_INVALID_PARAMETER); return FALSE; }
            const wide = new DataView(wideBytes.buffer, wideBytes.byteOffset, wideBytes.byteLength);
            let text = "";
            for (let i = 0; i < found.len; i++) {
                const ch = wide.getUint16(i * 2, true);
                if (ch === 0) break;
                text += String.fromCharCode(ch);
            }
            const encoded = encodeAnsi(text);
            const required = encoded.length + 1;
            const key = `${pBlock >>> 0}:${found.offset}`;
            let buffer = this.ansiQueryBuffers.get(key);
            if (!buffer || buffer.size < required) {
                buffer = {
                    ptr: this.process.memory.alloc(required, "THUNK_DATA", "rw"),
                    size: required,
                };
                this.ansiQueryBuffers.set(key, buffer);
            }
            Mem.writeBytes(buffer.ptr, encoded);
            Mem.writeUint8(buffer.ptr + encoded.length, 0);
            valuePtr = buffer.ptr;
            found.len = required;
        }
        Mem.writeUint32(lplpBuffer, valuePtr);
        Mem.writeUint32(puLen, found.len);
        return TRUE;
    }

    initialize(process: Process): void {
        this.process = process;
        this.blockCache.clear();
        this.ansiQueryBuffers.clear();

        this.exports["GetFileVersionInfoSizeA"] = (_ctx, mem, args) => {
            const fileName = readAsciiZ(mem, args[0]);
            if (!fileName) { setLastError(ERROR_INVALID_PARAMETER); return 0; }
            return this.infoSize(fileName, args[1]);
        };
        this.exports["GetFileVersionInfoSizeW"] = (_ctx, mem, args) => {
            const fileName = readWideZ(mem, args[0]);
            if (!fileName) { setLastError(ERROR_INVALID_PARAMETER); return 0; }
            return this.infoSize(fileName, args[1]);
        };
        this.exports["GetFileVersionInfoSizeExA"] = (_ctx, mem, args) => {
            const fileName = readAsciiZ(mem, args[1]);
            if (!fileName) { setLastError(ERROR_INVALID_PARAMETER); return 0; }
            return this.infoSize(fileName, args[2]);
        };
        this.exports["GetFileVersionInfoSizeExW"] = (_ctx, mem, args) => {
            const fileName = readWideZ(mem, args[1]);
            if (!fileName) { setLastError(ERROR_INVALID_PARAMETER); return 0; }
            return this.infoSize(fileName, args[2]);
        };

        this.exports["GetFileVersionInfoA"] = (_ctx, mem, args) => {
            const fileName = readAsciiZ(mem, args[0]);
            if (!fileName || args[3] === 0) { setLastError(ERROR_INVALID_PARAMETER); return FALSE; }
            return this.writeInfo(fileName, args[2], args[3]);
        };
        this.exports["GetFileVersionInfoW"] = (_ctx, mem, args) => {
            const fileName = readWideZ(mem, args[0]);
            if (!fileName || args[3] === 0) { setLastError(ERROR_INVALID_PARAMETER); return FALSE; }
            return this.writeInfo(fileName, args[2], args[3]);
        };
        this.exports["GetFileVersionInfoExA"] = (_ctx, mem, args) => {
            const fileName = readAsciiZ(mem, args[1]);
            if (!fileName || args[4] === 0) { setLastError(ERROR_INVALID_PARAMETER); return FALSE; }
            return this.writeInfo(fileName, args[3], args[4]);
        };
        this.exports["GetFileVersionInfoExW"] = (_ctx, mem, args) => {
            const fileName = readWideZ(mem, args[1]);
            if (!fileName || args[4] === 0) { setLastError(ERROR_INVALID_PARAMETER); return FALSE; }
            return this.writeInfo(fileName, args[3], args[4]);
        };

        this.exports["VerQueryValueA"] = (_ctx, mem, args) => {
            const [pBlock, lpSubBlock, lplpBuffer, puLen] = args;
            if (!pBlock || !lpSubBlock || !lplpBuffer || !puLen) { setLastError(ERROR_INVALID_PARAMETER); return FALSE; }
            return this.queryValue(pBlock, readAsciiZ(mem, lpSubBlock, 512), lplpBuffer, puLen, true);
        };
        this.exports["VerQueryValueW"] = (_ctx, mem, args) => {
            const [pBlock, lpSubBlock, lplpBuffer, puLen] = args;
            if (!pBlock || !lpSubBlock || !lplpBuffer || !puLen) { setLastError(ERROR_INVALID_PARAMETER); return FALSE; }
            return this.queryValue(pBlock, readWideZ(mem, lpSubBlock, 512), lplpBuffer, puLen, false);
        };
    }

    reset(): void {
        this.blockCache.clear();
        this.ansiQueryBuffers.clear();
    }

    reregisterExports(process: Process): void {
        this.process = process;
        this.blockCache.clear();
        this.ansiQueryBuffers.clear();
    }
}
