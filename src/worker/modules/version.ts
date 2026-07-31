/**
 * VERSION.dll implementation.
 * Provides file version information APIs used by apps to check DLL/EXE versions.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { encodeAnsi } from "./codepage-utils";

const TRUE = 1;
const FALSE = 0;
const VERSION_STR_BUF_A_SIZE = 0x400;
const VERSION_STR_BUF_W_SIZE = 0x800;
const VERSION_TRANSLATION_BUF_SIZE = 4;
const DEFAULT_VERSION_STR = "1.0.0.1";

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

const writeAsciiZ = (addr: number, value: string): number => {
    const bytes = encodeAnsi(value + "\0");
    Mem.writeBytes(addr, bytes);
    return bytes.length;
};

const writeWideZ = (addr: number, value: string): number => {
    let off = addr;
    for (let i = 0; i < value.length; i++) {
        Mem.writeUint16(off, value.charCodeAt(i));
        off += 2;
    }
    Mem.writeUint16(off, 0);
    return (value.length + 1) * 2;
};

const resolveStringValue = (normalizedSubBlock: string): string => {
    if (normalizedSubBlock.endsWith("\\fileversion")) return DEFAULT_VERSION_STR;
    if (normalizedSubBlock.endsWith("\\productversion")) return DEFAULT_VERSION_STR;
    if (normalizedSubBlock.endsWith("\\productname")) return "Need For Speed III";
    if (normalizedSubBlock.endsWith("\\originalfilename")) return "nfs3.exe";
    if (normalizedSubBlock.endsWith("\\internalname")) return "nfs3";
    return DEFAULT_VERSION_STR;
};

/**
 * Fake VS_FIXEDFILEINFO structure for version queries.
 * Most games just check if GetFileVersionInfo succeeds, they don't care about actual version.
 */
const createFakeVersionInfo = (mem: Uint8Array, bufferPtr: number, bufferSize: number): void => {
    // VS_FIXEDFILEINFO structure (52 bytes)
    // We return a minimal valid structure
    if (bufferSize < 52) return;

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let offset = bufferPtr;

    // dwSignature (0xFEEF04BD)
    view.setUint32(offset, 0xFEEF04BD, true);
    offset += 4;

    // dwStrucVersion (0x00010000 = 1.0)
    view.setUint32(offset, 0x00010000, true);
    offset += 4;

    // dwFileVersionMS (high 32 bits of version: 4.0.0.0 -> 0x00040000)
    view.setUint32(offset, 0x00040000, true);
    offset += 4;

    // dwFileVersionLS (low 32 bits of version: 4.0.0.0 -> 0x00000000)
    view.setUint32(offset, 0x00000000, true);
    offset += 4;

    // dwProductVersionMS (high 32 bits of product version: 4.0.0.0)
    view.setUint32(offset, 0x00040000, true);
    offset += 4;

    // dwProductVersionLS (low 32 bits of product version: 4.0.0.0)
    view.setUint32(offset, 0x00000000, true);
    offset += 4;

    // dwFileFlagsMask (0x3F)
    view.setUint32(offset, 0x0000003F, true);
    offset += 4;

    // dwFileFlags (0x0 = final version)
    view.setUint32(offset, 0x00000000, true);
    offset += 4;

    // dwFileOS (VOS_NT_WINDOWS32 = 0x00040004)
    view.setUint32(offset, 0x00040004, true);
    offset += 4;

    // dwFileType (VFT_DLL = 0x2)
    view.setUint32(offset, 0x00000002, true);
    offset += 4;

    // dwFileSubtype (0x0)
    view.setUint32(offset, 0x00000000, true);
    offset += 4;

    // dwFileDateMS (0x0)
    view.setUint32(offset, 0x00000000, true);
    offset += 4;

    // dwFileDateLS (0x0)
    view.setUint32(offset, 0x00000000, true);
};

export class Version implements IModule {
    name = "version";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;
    private versionStrBufA = 0;
    private versionStrBufW = 0;
    private versionTranslationBuf = 0;

    initialize(process: Process): void {
        this.process = process;
        this.versionStrBufA = process.memory.alloc(VERSION_STR_BUF_A_SIZE, "THUNK_DATA", "rw");
        this.versionStrBufW = process.memory.alloc(VERSION_STR_BUF_W_SIZE, "THUNK_DATA", "rw");
        this.versionTranslationBuf = process.memory.alloc(VERSION_TRANSLATION_BUF_SIZE, "THUNK_DATA", "rw");

        // GetFileVersionInfoSizeA(lptstrFilename, lpdwHandle)
        // Returns: size of version info in bytes, or 0 on error
        // lpdwHandle is output param (usually ignored, set to 0)
        this.exports["GetFileVersionInfoSizeA"] = (ctx, mem, args) => {
            const lptstrFilename = args[0];
            const lpdwHandle = args[1];

            if (lptstrFilename === 0) {
                Logger.verbose(LogCategory.SYSTEM, `GetFileVersionInfoSizeA: NULL filename`);
                return 0;
            }

            // Read filename (for logging)
            let filename = "<invalid>";
            try {
                const bytes: number[] = [];
                let addr = lptstrFilename;
                while (addr < mem.length && mem[addr] !== 0) {
                    bytes.push(mem[addr]);
                    addr++;
                    if (bytes.length > 260) break; // MAX_PATH
                }
                filename = String.fromCharCode(...bytes);
            } catch {}

            // Set handle to 0 (ignored by most apps)
            if (lpdwHandle !== 0) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(lpdwHandle, 0, true);
            }

            // Return fixed size (VS_FIXEDFILEINFO = 52 bytes)
            const versionInfoSize = 52;
            Logger.verbose(LogCategory.SYSTEM,
                `GetFileVersionInfoSizeA: file="${filename}" -> size=${versionInfoSize}`
            );

            return versionInfoSize;
        };

        // GetFileVersionInfoSizeW(lptstrFilename, lpdwHandle)
        this.exports["GetFileVersionInfoSizeW"] = (ctx, mem, args) => {
            const lptstrFilename = args[0];
            const lpdwHandle = args[1];

            if (lptstrFilename === 0) {
                Logger.verbose(LogCategory.SYSTEM, `GetFileVersionInfoSizeW: NULL filename`);
                return 0;
            }

            if (lpdwHandle !== 0) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(lpdwHandle, 0, true);
            }

            return 52;
        };

        // GetFileVersionInfoSizeExW(dwFlags, lptstrFilename, lpdwHandle)
        this.exports["GetFileVersionInfoSizeExW"] = (ctx, mem, args) => {
            const lptstrFilename = args[1];
            const lpdwHandle = args[2];
            if (lptstrFilename === 0) return 0;
            if (lpdwHandle !== 0) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(lpdwHandle, 0, true);
            }
            return 52;
        };

        // GetFileVersionInfoA(lptstrFilename, dwHandle, dwLen, lpData)
        // Returns: TRUE on success, FALSE on failure
        // lpData receives VS_FIXEDFILEINFO structure
        this.exports["GetFileVersionInfoA"] = (ctx, mem, args) => {
            const lptstrFilename = args[0];
            const dwHandle = args[1]; // Ignored (from GetFileVersionInfoSizeA)
            const dwLen = args[2];
            const lpData = args[3];

            if (lptstrFilename === 0 || lpData === 0) {
                Logger.verbose(LogCategory.SYSTEM,
                    `GetFileVersionInfoA: NULL pointer (filename=0x${lptstrFilename.toString(16)} lpData=0x${lpData.toString(16)})`
                );
                return FALSE;
            }

            // Read filename (for logging)
            let filename = "<invalid>";
            try {
                const bytes: number[] = [];
                let addr = lptstrFilename;
                while (addr < mem.length && mem[addr] !== 0) {
                    bytes.push(mem[addr]);
                    addr++;
                    if (bytes.length > 260) break;
                }
                filename = String.fromCharCode(...bytes);
            } catch {}

            // Create fake version info
            createFakeVersionInfo(mem, lpData, dwLen);

            Logger.verbose(LogCategory.SYSTEM,
                `GetFileVersionInfoA: file="${filename}" handle=0x${dwHandle.toString(16)} ` +
                `len=${dwLen} lpData=0x${lpData.toString(16)} -> TRUE`
            );

            return TRUE;
        };

        // GetFileVersionInfoW(lptstrFilename, dwHandle, dwLen, lpData)
        this.exports["GetFileVersionInfoW"] = (ctx, mem, args) => {
            const lptstrFilename = args[0];
            const dwLen = args[2];
            const lpData = args[3];

            if (lptstrFilename === 0 || lpData === 0) {
                return FALSE;
            }

            createFakeVersionInfo(mem, lpData, dwLen);
            return TRUE;
        };

        // GetFileVersionInfoExW(dwFlags, lptstrFilename, dwHandle, dwLen, lpData)
        this.exports["GetFileVersionInfoExW"] = (ctx, mem, args) => {
            const lptstrFilename = args[1];
            const dwLen = args[3];
            const lpData = args[4];

            if (lptstrFilename === 0 || lpData === 0) {
                return FALSE;
            }

            createFakeVersionInfo(mem, lpData, dwLen);
            return TRUE;
        };

        // VerQueryValueA(pBlock, lpSubBlock, lplpBuffer, puLen)
        // Returns: TRUE on success, FALSE on failure
        // lplpBuffer receives pointer to requested value
        // puLen receives length of value
        this.exports["VerQueryValueA"] = (ctx, mem, args) => {
            const pBlock = args[0];
            const lpSubBlock = args[1];
            const lplpBuffer = args[2];
            const puLen = args[3];

            if (pBlock === 0 || lpSubBlock === 0 || lplpBuffer === 0 || puLen === 0) {
                Logger.verbose(LogCategory.SYSTEM,
                    `VerQueryValueA: NULL pointer (pBlock=0x${pBlock.toString(16)} ` +
                    `lpSubBlock=0x${lpSubBlock.toString(16)} lplpBuffer=0x${lplpBuffer.toString(16)} ` +
                    `puLen=0x${puLen.toString(16)})`
                );
                return FALSE;
            }

            const subBlock = readAsciiZ(mem, lpSubBlock, 512);
            const normalized = subBlock.toLowerCase();

            // Most common query is "\\" for VS_FIXEDFILEINFO root
            if (subBlock === "\\" || subBlock === "") {
                // Return pointer to VS_FIXEDFILEINFO at pBlock
                Mem.writeUint32(lplpBuffer, pBlock);
                Mem.writeUint32(puLen, 52); // sizeof(VS_FIXEDFILEINFO)

                Logger.verbose(LogCategory.SYSTEM,
                    `VerQueryValueA: subBlock="${subBlock}" -> pBlock=0x${pBlock.toString(16)} len=52`
                );
                return TRUE;
            }

            if (normalized.includes("\\varfileinfo\\translation")) {
                // LANGID=0x0409 (en-US), CodePage=0x04B0 (Unicode)
                const translation = new Uint8Array([0x09, 0x04, 0xB0, 0x04]);
                Mem.writeBytes(this.versionTranslationBuf, translation);
                Mem.writeUint32(lplpBuffer, this.versionTranslationBuf);
                Mem.writeUint32(puLen, 4);
                Logger.verbose(LogCategory.SYSTEM,
                    `VerQueryValueA: subBlock="${subBlock}" -> Translation 0x0409/0x04B0`);
                return TRUE;
            }

            if (normalized.includes("\\stringfileinfo\\")) {
                const value = resolveStringValue(normalized);
                const bytes = writeAsciiZ(this.versionStrBufA, value);
                Mem.writeUint32(lplpBuffer, this.versionStrBufA);
                Mem.writeUint32(puLen, bytes);
                Logger.verbose(LogCategory.SYSTEM,
                    `VerQueryValueA: subBlock="${subBlock}" -> "${value}"`);
                return TRUE;
            }

            Logger.verbose(LogCategory.SYSTEM,
                `VerQueryValueA: subBlock="${subBlock}" -> FALSE (not implemented for strings)`
            );
            return FALSE;
        };

        // VerQueryValueW(pBlock, lpSubBlock, lplpBuffer, puLen)
        this.exports["VerQueryValueW"] = (ctx, mem, args) => {
            const pBlock = args[0];
            const lpSubBlock = args[1];
            const lplpBuffer = args[2];
            const puLen = args[3];

            if (pBlock === 0 || lpSubBlock === 0 || lplpBuffer === 0 || puLen === 0) {
                return FALSE;
            }

            const subBlock = readWideZ(mem, lpSubBlock, 512);
            const normalized = subBlock.toLowerCase();

            if (subBlock === "\\" || subBlock === "") {
                Mem.writeUint32(lplpBuffer, pBlock);
                Mem.writeUint32(puLen, 52);
                return TRUE;
            }

            if (normalized.includes("\\varfileinfo\\translation")) {
                const translation = new Uint8Array([0x09, 0x04, 0xB0, 0x04]);
                Mem.writeBytes(this.versionTranslationBuf, translation);
                Mem.writeUint32(lplpBuffer, this.versionTranslationBuf);
                Mem.writeUint32(puLen, 4);
                return TRUE;
            }

            if (normalized.includes("\\stringfileinfo\\")) {
                const value = resolveStringValue(normalized);
                const bytes = writeWideZ(this.versionStrBufW, value);
                Mem.writeUint32(lplpBuffer, this.versionStrBufW);
                Mem.writeUint32(puLen, bytes / 2);
                return TRUE;
            }

            return FALSE;
        };

        // ExA variants are aliases for compatibility.
        this.exports["GetFileVersionInfoExA"] = (ctx, mem, args) =>
            this.exports["GetFileVersionInfoA"]!(ctx, mem, [args[1], args[2], args[3], args[4]]);
        this.exports["GetFileVersionInfoSizeExA"] = (ctx, mem, args) =>
            this.exports["GetFileVersionInfoSizeA"]!(ctx, mem, [args[1], args[2]]);
    }

    reset(): void {
        this.versionStrBufA = 0;
        this.versionStrBufW = 0;
        this.versionTranslationBuf = 0;
    }

    reregisterExports(process: Process): void {
        this.process = process;
        this.versionStrBufA = process.memory.alloc(VERSION_STR_BUF_A_SIZE, "THUNK_DATA", "rw");
        this.versionStrBufW = process.memory.alloc(VERSION_STR_BUF_W_SIZE, "THUNK_DATA", "rw");
        this.versionTranslationBuf = process.memory.alloc(VERSION_TRANSLATION_BUF_SIZE, "THUNK_DATA", "rw");
    }
}
