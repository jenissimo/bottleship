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
import { queryVersionBlock, transcodeVersionBlock } from "../core/version-block";

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
    ansi: Uint8Array;
    wide: Uint8Array;
    /** The wide length, so a buffer sized by either Size call fits either block. */
    reportedSize: number;
}

export class Version implements IModule {
    name = "version";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;
    /** Keyed by the filename as the guest spelled it, lowercased. */
    private blockCache = new Map<string, VersionBlockPair | null>();

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

    private async readVfsFile(path: string): Promise<Uint8Array | null> {
        try {
            const vfs = System.getInstance().fileSystem;
            const size = vfs.getFileSize(path);
            if (size <= 0 || size > MAX_VERSION_SOURCE_BYTES) return null;
            const handle = await vfs.open(path, 0x80000000 /* GENERIC_READ */, 3 /* OPEN_EXISTING */);
            if (!handle) return null;
            return await vfs.read(handle, size);
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `[version] read("${path}") failed: ${e}`);
            return null;
        }
    }

    private async buildBlockPair(fileName: string): Promise<VersionBlockPair | null> {
        for (const path of this.candidatePaths(fileName)) {
            // The HLE check comes first per candidate: the VFS advertises these paths so
            // existence probes agree with LoadLibrary, but there are no PE bytes behind them.
            if (isVirtualHleSystemFile(path)) {
                const canonical = resolveThunkedDllAlias(normalizeDllBaseName(path));
                if (canonical && HLE_SYSTEM_DLL_NAMES.has(canonical)) {
                    const base = path.slice(path.lastIndexOf("\\") + 1);
                    const wide = buildHleDllVersionBlock(canonical, base, true);
                    const ansi = buildHleDllVersionBlock(canonical, base, false);
                    if (wide && ansi) {
                        Logger.log(LogCategory.SYSTEM,
                            `[version] "${fileName}" -> HLE ${canonical} (${wide.length}B block)`);
                        return { ansi, wide, reportedSize: wide.length };
                    }
                }
                continue;
            }

            const image = await this.readVfsFile(path);
            if (!image) continue;
            const resource = readPeVersionResourceBytes(image);
            if (!resource) {
                Logger.verbose(LogCategory.SYSTEM, `[version] "${path}" has no RT_VERSION resource`);
                return null;
            }
            Logger.log(LogCategory.SYSTEM, `[version] "${fileName}" -> ${path} (${resource.length}B resource)`);
            // The resource IS the wide block; the narrow one costs a re-emit at half the
            // character width, so the wide length covers a buffer sized by either Size call.
            const ansi = transcodeVersionBlock(resource, false) ?? resource;
            return { ansi, wide: resource, reportedSize: resource.length };
        }
        return null;
    }

    private async resolveBlock(fileName: string): Promise<VersionBlockPair | null> {
        const key = fileName.toLowerCase();
        const cached = this.blockCache.get(key);
        if (cached !== undefined) return cached;
        const built = await this.buildBlockPair(fileName);
        this.blockCache.set(key, built);
        if (!built) {
            Logger.log(LogCategory.SYSTEM, `[version] "${fileName}": no version information`);
        }
        return built;
    }

    private async infoSize(fileName: string, lpdwHandle: number): Promise<number> {
        if (lpdwHandle !== 0) Mem.writeUint32(lpdwHandle, 0);
        const block = await this.resolveBlock(fileName);
        if (!block) {
            setLastError(fileName ? ERROR_RESOURCE_DATA_NOT_FOUND : ERROR_FILE_NOT_FOUND);
            return 0;
        }
        return block.reportedSize;
    }

    private async writeInfo(fileName: string, dwLen: number, lpData: number, wide: boolean): Promise<number> {
        const block = await this.resolveBlock(fileName);
        if (!block) {
            setLastError(ERROR_RESOURCE_DATA_NOT_FOUND);
            return FALSE;
        }
        const bytes = wide ? block.wide : block.ansi;
        if (dwLen < bytes.length) {
            setLastError(ERROR_INSUFFICIENT_BUFFER);
            return FALSE;
        }
        Mem.writeBytes(lpData, bytes);
        return TRUE;
    }

    /**
     * Shared VerQueryValueA/W body. pBlock is a BORROWED guest pointer whose extent is the
     * block's own wLength, so it is validated over that whole extent before the walk and
     * the walk itself runs over a copy — lplpBuffer then names the address inside pBlock.
     */
    private queryValue(pBlock: number, subBlock: string, lplpBuffer: number, puLen: number): number {
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
        Mem.writeUint32(lplpBuffer, (pBlock + found.offset) >>> 0);
        Mem.writeUint32(puLen, found.len);
        return TRUE;
    }

    initialize(process: Process): void {
        this.process = process;
        this.blockCache.clear();

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
            return this.writeInfo(fileName, args[2], args[3], false);
        };
        this.exports["GetFileVersionInfoW"] = (_ctx, mem, args) => {
            const fileName = readWideZ(mem, args[0]);
            if (!fileName || args[3] === 0) { setLastError(ERROR_INVALID_PARAMETER); return FALSE; }
            return this.writeInfo(fileName, args[2], args[3], true);
        };
        this.exports["GetFileVersionInfoExA"] = (_ctx, mem, args) => {
            const fileName = readAsciiZ(mem, args[1]);
            if (!fileName || args[4] === 0) { setLastError(ERROR_INVALID_PARAMETER); return FALSE; }
            return this.writeInfo(fileName, args[3], args[4], false);
        };
        this.exports["GetFileVersionInfoExW"] = (_ctx, mem, args) => {
            const fileName = readWideZ(mem, args[1]);
            if (!fileName || args[4] === 0) { setLastError(ERROR_INVALID_PARAMETER); return FALSE; }
            return this.writeInfo(fileName, args[3], args[4], true);
        };

        this.exports["VerQueryValueA"] = (_ctx, mem, args) => {
            const [pBlock, lpSubBlock, lplpBuffer, puLen] = args;
            if (!pBlock || !lpSubBlock || !lplpBuffer || !puLen) { setLastError(ERROR_INVALID_PARAMETER); return FALSE; }
            return this.queryValue(pBlock, readAsciiZ(mem, lpSubBlock, 512), lplpBuffer, puLen);
        };
        this.exports["VerQueryValueW"] = (_ctx, mem, args) => {
            const [pBlock, lpSubBlock, lplpBuffer, puLen] = args;
            if (!pBlock || !lpSubBlock || !lplpBuffer || !puLen) { setLastError(ERROR_INVALID_PARAMETER); return FALSE; }
            return this.queryValue(pBlock, readWideZ(mem, lpSubBlock, 512), lplpBuffer, puLen);
        };
    }

    reset(): void {
        this.blockCache.clear();
    }

    reregisterExports(process: Process): void {
        this.process = process;
        this.blockCache.clear();
    }
}
