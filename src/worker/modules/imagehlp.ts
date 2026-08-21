import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Marshaler } from "../core/memory/marshaler";
import { Mem } from "../core/memory/mem-accessor";
import { isValidAddress } from "../core/memory/address-guard";
import { System } from "../core/system";
import { Logger, LogCategory } from "../core/logger";
import { createDbgHelpExports } from "./dbghelp";

const TRUE = 1;
const FALSE = 0;
const ERROR_INVALID_HANDLE = 6;
const ERROR_MOD_NOT_FOUND = 126;
const ERROR_BAD_EXE_FORMAT = 193;
const ERROR_INVALID_PARAMETER = 87;

const LOADED_IMAGE_OFFSETS = {
    moduleName: 0,
    hFile: 4,
    mappedAddress: 8,
    fileHeader: 12,
    lastRvaSection: 16,
    numberOfSections: 20,
    sections: 24,
    characteristics: 28,
    fSystemImage: 32,
    fDosImage: 33,
    fReadOnly: 34,
    version: 35,
    linksFlink: 36,
    linksBlink: 40,
    sizeOfImage: 44,
} as const;

const LOADED_IMAGE_SIZE = 48;

const basename = (path: string): string => {
    if (!path) return "";
    const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return slash >= 0 ? path.slice(slash + 1) : path;
};

const stripImageExtension = (name: string): string => name.replace(/\.(dll|exe)$/i, "");

export class ImageHlp implements IModule {
    name = "imagehlp";
    exports: Record<string, ThunkImplementation> = {};

    /** Flat file mappings handed out by MapAndLoad, so UnMapAndLoad can give them back. */
    private readonly fileMappings = new Map<number, number>();

    initialize(process: Process): void {
        const system = System.getInstance();

        // imagehlp.dll exports the whole Sym*/StackWalk* surface in its own right (NT builds
        // both DLLs from one source and re-exports them here), and GetProcAddress is scoped
        // by HMODULE — so a crash handler that loads imagehlp rather than dbghelp must find
        // them under THIS handle or it silently loses its stack walk. Assigned first so
        // imagehlp's own MapAndLoad/UnMapAndLoad/ImageRvaToVa below always win.
        Object.assign(this.exports, createDbgHelpExports());

        /**
         * Resolve an image name the way MapAndLoad does — as given, then against DllPath,
         * then the app directory — and map the file's bytes flat into guest memory.
         */
        const mapImageFile = (imageName: string, dllPath: string): { address: number; size: number; path: string } | null => {
            if (!imageName) return null;
            const vfs = system.fileSystem;
            const leaf = basename(imageName);
            const candidates = [imageName];
            for (const dir of dllPath.split(";")) {
                const trimmed = dir.trim();
                if (trimmed && leaf) candidates.push(`${trimmed.replace(/[\\/]+$/, "")}\\${leaf}`);
            }

            for (const candidate of candidates) {
                const handle = vfs.openSync(candidate, 0x80000000, 3);
                if (!handle) continue;
                const size = vfs.getFileSize(handle.path);
                if (size <= 0) continue;
                const bytes = vfs.readSync(handle, size);
                if (!bytes || bytes.byteLength === 0) continue;

                const address = process.memory.alloc(bytes.byteLength);
                if (!address) return null;
                if (!Mem.writeBytes(address, bytes)) {
                    process.memory.free(address);
                    return null;
                }
                this.fileMappings.set(address, bytes.byteLength);
                return { address, size: bytes.byteLength, path: candidate };
            }
            return null;
        };

        const unmapImageFile = (address: number): boolean => {
            if (!this.fileMappings.delete(address >>> 0)) return false;
            process.memory.free(address >>> 0);
            return true;
        };

        const writeLoadedImage = (
            loadedImagePtr: number,
            moduleNamePtr: number,
            mappedAddress: number,
            fileHeader: number,
            numberOfSections: number,
            sectionsPtr: number,
            characteristics: number,
            sizeOfImage: number,
            fSystemImage: number,
            fDosImage: number,
            fReadOnly: number
        ): boolean => {
            if (!Mem.writeUint32(loadedImagePtr + LOADED_IMAGE_OFFSETS.moduleName, moduleNamePtr >>> 0)) return false;
            if (!Mem.writeUint32(loadedImagePtr + LOADED_IMAGE_OFFSETS.hFile, 0)) return false;
            if (!Mem.writeUint32(loadedImagePtr + LOADED_IMAGE_OFFSETS.mappedAddress, mappedAddress >>> 0)) return false;
            if (!Mem.writeUint32(loadedImagePtr + LOADED_IMAGE_OFFSETS.fileHeader, fileHeader >>> 0)) return false;
            if (!Mem.writeUint32(loadedImagePtr + LOADED_IMAGE_OFFSETS.lastRvaSection, 0)) return false;
            if (!Mem.writeUint32(loadedImagePtr + LOADED_IMAGE_OFFSETS.numberOfSections, numberOfSections >>> 0)) return false;
            if (!Mem.writeUint32(loadedImagePtr + LOADED_IMAGE_OFFSETS.sections, sectionsPtr >>> 0)) return false;
            if (!Mem.writeUint32(loadedImagePtr + LOADED_IMAGE_OFFSETS.characteristics, characteristics >>> 0)) return false;
            if (!Mem.writeBytes(
                loadedImagePtr + LOADED_IMAGE_OFFSETS.fSystemImage,
                new Uint8Array([fSystemImage & 0xff, fDosImage & 0xff, fReadOnly & 0xff, 1])
            )) return false;
            if (!Mem.writeUint32(loadedImagePtr + LOADED_IMAGE_OFFSETS.linksFlink, 0)) return false;
            if (!Mem.writeUint32(loadedImagePtr + LOADED_IMAGE_OFFSETS.linksBlink, 0)) return false;
            if (!Mem.writeUint32(loadedImagePtr + LOADED_IMAGE_OFFSETS.sizeOfImage, sizeOfImage >>> 0)) return false;
            return true;
        };

        // BOOL MapAndLoad(PSTR ImageName, PSTR DllPath, PLOADED_IMAGE LoadedImage, BOOL DotDll, BOOL ReadOnly)
        this.exports["MapAndLoad"] = (_ctx, mem, args) => {
            const imageNamePtr = args[0] >>> 0;
            const dllPathPtr = args[1] >>> 0;
            const loadedImagePtr = args[2] >>> 0;
            const dotDll = args[3] >>> 0;
            const readOnly = args[4] >>> 0;

            if (!loadedImagePtr ||
                loadedImagePtr + LOADED_IMAGE_SIZE > mem.length ||
                !isValidAddress(mem, loadedImagePtr, LOADED_IMAGE_SIZE, "rw")) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: FALSE, stackCleanup: 20 };
            }

            const imageName = imageNamePtr ? Marshaler.readString(mem, imageNamePtr) : "";
            const dllPath = dllPathPtr ? Marshaler.readString(mem, dllPathPtr) : "";

            // MapAndLoad maps the FILE, flat, exactly as it sits on disk — MappedAddress is
            // file offset 0, so a caller converts an offset to a VA itself with the section
            // table (PointerToRawData / VirtualAddress). It is NOT the loaded image, and it
            // has nothing to do with which modules this process happens to have loaded: the
            // whole point is inspecting an executable the process did NOT load.
            const mapped = mapImageFile(imageName, dllPath);
            if (!mapped) {
                Logger.warn(
                    LogCategory.SYSTEM,
                    `MapAndLoad(image="${imageName}", dllPath="${dllPath}", dotDll=${dotDll}, readOnly=${readOnly}) -> file not found`
                );
                system.scheduler.setLastError(ERROR_MOD_NOT_FOUND);
                return { value: FALSE, stackCleanup: 20 };
            }

            const mappedAddress = mapped.address;
            const eLfanew = Mem.readUint32(mappedAddress + 0x3c);
            const mz = Mem.readUint16(mappedAddress);
            let fileHeader = 0;
            let numberOfSections = 0;
            let sectionsPtr = 0;
            let characteristics = 0;
            let sizeOfImage = mapped.size;
            if (mz === 0x5a4d && eLfanew !== null) {
                const ntHeaders = (mappedAddress + eLfanew) >>> 0;
                if (Mem.readUint32(ntHeaders) === 0x00004550) {
                    fileHeader = ntHeaders;
                    numberOfSections = Mem.readUint16(ntHeaders + 6) ?? 0;
                    const optionalHeaderSize = Mem.readUint16(ntHeaders + 20) ?? 0;
                    characteristics = Mem.readUint16(ntHeaders + 22) ?? 0;
                    sectionsPtr = (ntHeaders + 24 + optionalHeaderSize) >>> 0;
                    const parsedSizeOfImage = Mem.readUint32(ntHeaders + 24 + 56);
                    if (parsedSizeOfImage !== null && parsedSizeOfImage > 0) {
                        sizeOfImage = parsedSizeOfImage >>> 0;
                    }
                }
            }
            const fDosImage = fileHeader ? 1 : 0;

            if (!fileHeader) {
                unmapImageFile(mappedAddress);
                Logger.warn(
                    LogCategory.SYSTEM,
                    `MapAndLoad(image="${imageName}", resolved="${mapped.path}") -> not a PE file`
                );
                system.scheduler.setLastError(ERROR_BAD_EXE_FORMAT);
                return { value: FALSE, stackCleanup: 20 };
            }

            const ok = writeLoadedImage(
                loadedImagePtr,
                imageNamePtr,
                mappedAddress,
                fileHeader,
                numberOfSections,
                sectionsPtr,
                characteristics,
                sizeOfImage,
                0,
                fDosImage,
                readOnly ? 1 : 0
            );

            if (!ok) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: FALSE, stackCleanup: 20 };
            }

            Logger.verbose(
                LogCategory.SYSTEM,
                `MapAndLoad(image="${imageName}", dllPath="${dllPath}", dotDll=${dotDll}, readOnly=${readOnly}) -> ` +
                `mapped=0x${mappedAddress.toString(16)} size=0x${sizeOfImage.toString(16)}`
            );

            system.scheduler.setLastError(0);
            return { value: TRUE, stackCleanup: 20 };
        };

        // BOOL UnMapAndLoad(PLOADED_IMAGE LoadedImage)
        this.exports["UnMapAndLoad"] = (_ctx, mem, args) => {
            const loadedImagePtr = args[0] >>> 0;
            if (!loadedImagePtr ||
                loadedImagePtr + LOADED_IMAGE_SIZE > mem.length ||
                !isValidAddress(mem, loadedImagePtr, LOADED_IMAGE_SIZE, "rw")) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: FALSE, stackCleanup: 4 };
            }

            const mappedAddress = Mem.readUint32(loadedImagePtr + LOADED_IMAGE_OFFSETS.mappedAddress) ?? 0;
            if (mappedAddress) unmapImageFile(mappedAddress);

            if (!Mem.writeUint32(loadedImagePtr + LOADED_IMAGE_OFFSETS.hFile, 0)) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: FALSE, stackCleanup: 4 };
            }
            if (!Mem.writeUint32(loadedImagePtr + LOADED_IMAGE_OFFSETS.mappedAddress, 0)) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: FALSE, stackCleanup: 4 };
            }
            if (!Mem.writeUint32(loadedImagePtr + LOADED_IMAGE_OFFSETS.fileHeader, 0)) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: FALSE, stackCleanup: 4 };
            }

            system.scheduler.setLastError(0);
            return { value: TRUE, stackCleanup: 4 };
        };

        // PVOID ImageRvaToVa(PIMAGE_NT_HEADERS NtHeaders, PVOID Base, ULONG Rva, PIMAGE_SECTION_HEADER* LastRvaSection)
        this.exports["ImageRvaToVa"] = (_ctx, mem, args) => {
            const ntHeaders = args[0] >>> 0;
            const base = args[1] >>> 0;
            const rva = args[2] >>> 0;
            const lastRvaSectionOut = args[3] >>> 0;

            if (lastRvaSectionOut !== 0 &&
                lastRvaSectionOut + 4 <= mem.length &&
                isValidAddress(mem, lastRvaSectionOut, 4, "rw")) {
                Mem.writeUint32(lastRvaSectionOut, 0);
            }

            if (!base) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 16 };
            }

            const va = (base + rva) >>> 0;
            if (va >= mem.length) {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return { value: 0, stackCleanup: 16 };
            }

            Logger.verbose(
                LogCategory.SYSTEM,
                `ImageRvaToVa(nt=0x${ntHeaders.toString(16)}, base=0x${base.toString(16)}, rva=0x${rva.toString(16)}) -> 0x${va.toString(16)}`
            );
            system.scheduler.setLastError(0);
            return { value: va >>> 0, stackCleanup: 16 };
        };
    }
}
