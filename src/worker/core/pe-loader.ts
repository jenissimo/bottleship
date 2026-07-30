// pe-loader.ts
// Portably parses Win32 PE files and loads them into emulator memory

import { ThunkGenerator } from './thunking/thunk-generator';
import { deriveStackCleanupFromMangledName } from './thunking/msvc-mangling';
import { APIRegistry } from './api-registry';
import { System } from './system';
import { Logger, LogCategory } from './logger';
import { ModuleRegistry, LoadedPEModule } from './module-registry';
import { VirtualFileSystem } from '../runtime/filesystem/vfs';
import { EMU_NATIVE_VIDEO_DLLS, VIDEO_DLL_NAMES } from './cpu/emulator-config';
import { hypercallDataManager } from './cpu/hypercall-data';
import { libHleManager } from './hle-lib/lib-hle-manager';
import { hookRegistry } from './hooks';
import { Galaxy } from '../modules/galaxy';
import { normalizeDllBaseName, resolveThunkedDllAlias } from './dll-aliases';
import { installCw3220Stdio } from '../modules/cw3220/cw3220-stdio';
import { writeHeapSlabStubs } from '../modules/kernel32/heap-slab-stubs';
import { writeCrtSlabStubs, writeCaseFoldStubs } from '../modules/crt-slab-stubs';
import { loadDiagnostics } from './diagnostics/load-diagnostics';
import { writeGuestCode, invalidateGuestCode } from './memory/guest-code';

function isD3dx9VersionedDll(dllNameLower: string): boolean {
    return resolveThunkedDllAlias(normalizeDllBaseName(dllNameLower)) === 'd3dx9';
}

export interface LoadedModule {
    baseAddress: number;
    entryPoint: number;
    size: number;
    sizeOfStackReserve: number;
}

/**
 * Entry for a DLL whose DllMain needs to be called at boot time.
 * Collected during PE loading, emitted as x86 PUSH/CALL in the bootloader trampoline.
 */
export interface DllInitEntry {
    /** Module base address (passed as hModule to DllMain) */
    baseAddress: number;
    /** Absolute address of DllMain (baseAddress + entryPointRVA) */
    entryPoint: number;
    /** Module name for logging */
    name: string;
}

/**
 * DllMain reason codes
 */
const DLL_PROCESS_ATTACH = 1;
const DLL_PROCESS_DETACH = 0;
const DLL_THREAD_ATTACH = 2;
const DLL_THREAD_DETACH = 3;

/**
 * DLLs whose implementation IS the emulator. The "registry cannot cover these imports, but
 * a real file exists in the VFS — load it natively" fallback must never reach them: a real
 * kernel32/ntdll/user32 expects an NT kernel underneath (syscalls, PEB/TEB internals, a
 * real GDI driver) and there is none, so satisfying the import from a shipped copy trades
 * a handful of missing exports for a certain, unexplainable death. A bundle that happens
 * to ship one of these (installers routinely do) must stay thunked; unknown imports keep
 * their trap stubs, which fail one call loudly instead of the whole process silently.
 */
const HLE_ONLY_DLLS = new Set<string>([
    'kernel32', 'kernelbase', 'ntdll', 'user32', 'gdi32', 'advapi32',
    'ddraw', 'd3d8', 'd3d9', 'dsound', 'dinput', 'dinput8', 'opengl32', 'glide2x', 'glide3x',
]);

export class PELoader {
    private getMemory: () => Uint8Array;
    private thunkGenerator: ThunkGenerator;
    private apiRegistry: APIRegistry;
    private moduleRegistry: ModuleRegistry | null = null;
    private vfs: VirtualFileSystem | null = null;

    /**
     * DLLs that must NOT be loaded as real x86 code. Their native code uses OS features
     * (SEH, TEB, FS segment) that our minimal protected mode doesn't support.
     * These get safe stubs (return 0) instead.
     */
    private static readonly DLL_FORCE_STUB: Set<string> = new Set([
        'ifc20',   // Immersion TouchSense force-feedback — no hardware in emulator.
        'ifc21',   // IFC20's native code throws C++ exceptions on init failure instead
        'ifc22',   // of returning error codes; heroes3 catch blocks don't set "no FF"
                   // flag properly, breaking mouse input on the adventure map.
        'mscoree', // .NET runtime host — games link it for _CorDllMain managed-DLL detection.
                   // Native code needs full CLR; safe to stub (returns 0).
    ]);

    /**
     * Real DLLs that load natively but whose stdio/CRT is non-functional in HLE and
     * must have specific exports overridden with VFS-backed thunks. See
     * modules/cw3220/cw3220-stdio.ts — the Borland C++ runtime's _fopen does no file
     * I/O, so games reading data through it abort at startup.
     */
    private static readonly DLL_PARTIAL_HLE: Set<string> = new Set([
        'cw3220',  // Borland C++ 1996 RTL (Discworld Noir / Tin3 engine).
    ]);

    /**
     * Parse MSVC C++ mangled name to extract stack cleanup bytes.
     * Handles thiscall/stdcall methods — returns param count × 4.
     * Returns 0 for cdecl (caller cleans), null if unparseable.
     */
    private static parseMsvcStackCleanup(mangledName: string): number | null {
        if (!mangledName.startsWith('?')) return null;

        // Find @@ separator (end of qualified name)
        const qqIdx = mangledName.indexOf('@@');
        if (qqIdx < 0 || qqIdx + 5 >= mangledName.length) return null;

        // 3-char qualifier after @@: [access][cv-qual][calling-conv]
        // E.g. QAE = public, no-cv, thiscall; UAE = public virtual, no-cv, thiscall
        let pos = qqIdx + 5; // skip @@ + 3-char qualifier
        const ccChar = mangledName[qqIdx + 4]; // calling convention: E=thiscall, A=cdecl, G=stdcall

        if (ccChar === 'A') return 0; // cdecl — caller cleans stack, RET 0 is correct
        if (ccChar !== 'E' && ccChar !== 'G') return null; // unknown calling convention

        // Skip return type
        const isCtorDtor = mangledName.startsWith('??0') || mangledName.startsWith('??1');
        if (isCtorDtor) {
            // Constructors/destructors: '@' marker instead of return type
            if (pos < mangledName.length && mangledName[pos] === '@') pos++;
        } else {
            pos = PELoader.skipMsvcType(mangledName, pos);
            if (pos < 0) return null;
        }

        // Check for void params (XZ = no parameters)
        if (pos + 1 < mangledName.length && mangledName[pos] === 'X' && mangledName[pos + 1] === 'Z') {
            return 0;
        }

        // Count parameters until @Z
        let paramCount = 0;
        while (pos < mangledName.length) {
            if (mangledName[pos] === '@' || mangledName[pos] === 'Z') break;
            const nextPos = PELoader.skipMsvcType(mangledName, pos);
            if (nextPos <= pos) return null;
            paramCount++;
            pos = nextPos;
        }

        return paramCount * 4;
    }

    /**
     * Skip one MSVC C++ mangled type at the given position.
     * Returns position after the type, or -1 on error.
     */
    private static skipMsvcType(name: string, pos: number): number {
        if (pos >= name.length) return -1;
        const ch = name[pos];

        // Back-reference (0-9)
        if (ch >= '0' && ch <= '9') return pos + 1;

        // Simple types: C(signed char) D(char) E(unsigned char) F(short) G(unsigned short)
        // H(int) I(unsigned int) J(long) K(unsigned long) M(float) N(double) O(long double) X(void)
        if ('CDEFGHIJKMNOX'.includes(ch)) return pos + 1;

        // Underscore-prefixed: _J(__int64) _K(unsigned __int64) _N(bool) _W(wchar_t)
        if (ch === '_' && pos + 1 < name.length) return pos + 2;

        // Pointer/reference: PA/PB/QA/AA/AB + pointed-to type
        if ((ch === 'P' || ch === 'Q' || ch === 'A') && pos + 1 < name.length && 'ABCDEQ'.includes(name[pos + 1])) {
            return PELoader.skipMsvcType(name, pos + 2);
        }

        // Named types: V(class) U(struct) T(union) + qualified_name + @@
        if (ch === 'V' || ch === 'U' || ch === 'T') {
            const endIdx = name.indexOf('@@', pos + 1);
            return endIdx >= 0 ? endIdx + 2 : -1;
        }

        // Enum: W4 + name + @@
        if (ch === 'W' && pos + 1 < name.length && name[pos + 1] === '4') {
            const endIdx = name.indexOf('@@', pos + 2);
            return endIdx >= 0 ? endIdx + 2 : -1;
        }

        return -1; // Unknown encoding
    }

    // Track DLLs currently being loaded to detect circular dependencies
    private loadingDlls: Set<string> = new Set();

    /**
     * Cached addresses of inline x86 stubs for kernel32!HeapAlloc/HeapFree.
     * Generated on first kernel32 import; reused to rewrite IAT entries in every
     * subsequent PE that imports these functions. See kernel32/heap-slab-stubs writeHeapSlabStubs.
     */
    private heapInlineStubs: { heapAllocStub: number; heapFreeStub: number; regionBase: number; regionEnd: number } | null = null;

    /**
     * Cached addresses of inline x86 stubs for the msvcrt cdecl CRT allocator pair
     * (malloc/operator new + free/operator delete). Generated on first msvcrt import;
     * reused to rewrite IAT entries in every subsequent PE that imports these. Rides
     * the same WASM slab arena as the kernel32 heap stubs. See crt-slab-stubs writeCrtSlabStubs.
     */
    private crtInlineStubs: { mallocStub: number; freeStub: number; regionBase: number; regionEnd: number } | null = null;
    private caseFoldInlineStubs: { tolowerStub: number; toupperStub: number; regionBase: number; regionEnd: number } | null = null;

    /** Dynamically-linked C runtime modules that export the cdecl malloc/free pair
     *  and the MSVC operator new/delete aliases — all share one slab fast path. */
    private static readonly CRT_SLAB_MODULES = new Set<string>([
        'msvcrt', 'msvcr70', 'msvcr71', 'msvcr80', 'msvcr90', 'msvcr100', 'msvcr110', 'msvcr120',
    ]);
    /** cdecl void* malloc(size_t) and its aliases incl. MSVC `operator new(unsigned int)`.
     *  Plain `malloc` first so the inline stub's slow-path JMP prefers it. */
    private static readonly CRT_MALLOC_KEYS = ['malloc', '_malloc', '??2@yapaxi@z', '_malloc_dbg'];
    /** cdecl void free(void*) and its aliases incl. MSVC `operator delete(void*)`. */
    private static readonly CRT_FREE_KEYS = ['free', '_free', '??3@yaxpax@z', '_free_dbg'];

    /**
     * DLLs whose DllMain(DLL_PROCESS_ATTACH) must be called before the EXE entry point.
     * Collected during loadExecutable → loadDll, consumed by bootloader trampoline.
     */
    private pendingDllInits: DllInitEntry[] = [];

    constructor(getMemory: () => Uint8Array, thunkGenerator: ThunkGenerator, apiRegistry: APIRegistry) {
        this.getMemory = getMemory;
        this.thunkGenerator = thunkGenerator;
        this.apiRegistry = apiRegistry;
    }

    /**
     * Return DLLs that need DllMain(DLL_PROCESS_ATTACH) called at boot time.
     * Consumed by bootloader trampoline; clears the list after retrieval.
     */
    getPendingDllInits(): DllInitEntry[] {
        const inits = this.pendingDllInits;
        this.pendingDllInits = [];
        return inits;
    }

    /** Clear per-process caches (heap inline stubs, etc.) tied to specific guest
     *  memory addresses. Called from Process.reset() before thunk memory is regenerated. */
    resetCaches(): void {
        this.heapInlineStubs = null;
        this.crtInlineStubs = null;
        this.caseFoldInlineStubs = null;
    }

    /**
     * Set module registry for tracking loaded modules
     */
    setModuleRegistry(registry: ModuleRegistry): void {
        this.moduleRegistry = registry;
    }

    /**
     * Set VFS for loading DLLs from the file system
     */
    setVfs(vfs: VirtualFileSystem): void {
        this.vfs = vfs;
    }

    private get memory(): Uint8Array {
        return this.getMemory();
    }

    private get view(): DataView {
        const mem = this.memory;
        return new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    }

    async loadExecutable(peData: Uint8Array): Promise<LoadedModule> {
        const peView = new DataView(peData.buffer, peData.byteOffset, peData.byteLength);

        // Verify DOS Header
        if (peView.getUint16(0, true) !== 0x5A4D) throw new Error('Not a DOS executable');
        const e_lfanew = peView.getUint32(0x3C, true);

        // Verify PE Header
        if (peView.getUint32(e_lfanew, true) !== 0x00004550) throw new Error('Not a PE executable');

        const numberOfSections = peView.getUint16(e_lfanew + 6, true);
        const sizeOfOptionalHeader = peView.getUint16(e_lfanew + 20, true);
        const optHeaderPtr = e_lfanew + 24;

        const magic = peView.getUint16(optHeaderPtr, true);
        if (magic !== 0x10B) throw new Error('Only 32-bit PE is supported');

        const imageBase = peView.getUint32(optHeaderPtr + 28, true);
        const sizeOfImage = peView.getUint32(optHeaderPtr + 56, true);
        const entryPointRVA = peView.getUint32(optHeaderPtr + 16, true);

        // Use the PE's ImageBase as the load address. On real Windows, EXEs always
        // load at their preferred base (they're the first module, no conflicts).
        // Many EXEs (especially older ones like UE1 games) have no .reloc section
        // and CANNOT be relocated — loading at the wrong base breaks all absolute addresses.
        const baseAddress = imageBase;

        // Register the image range so AddressGuard accepts app reads/writes.
        const system = System.getInstance();
        const addressSpace = system.process?.addressSpace;
        if (addressSpace) {
            addressSpace.releaseRegion(baseAddress);
            addressSpace.mapRegion(baseAddress, sizeOfImage, "rwx", "ROM", "PELoader", "image");
        }

        // --- Clear image region before loading ---
        // Zero out the image region to prevent stale data from previous loads.
        const clearedBytes = sizeOfImage + 0x10000; // +64KB buffer
        this.memory.fill(0, baseAddress, baseAddress + clearedBytes);

        // --- Copy PE headers to memory ---
        // The headers (DOS header, PE header, optional header, section headers) must be
        // present in memory for FindResource, GetModuleHandle, and other APIs to work.
        // SizeOfHeaders is at offset 60 from optional header start.
        const sizeOfHeaders = peView.getUint32(optHeaderPtr + 60, true);
        writeGuestCode(this.memory, peData.subarray(0, sizeOfHeaders), baseAddress);
        Logger.log(LogCategory.SYSTEM, `[PE] Copied ${sizeOfHeaders} bytes of headers to 0x${baseAddress.toString(16)}`);

        // Load Sections
        const sections = this.loadSections(peData, peView, optHeaderPtr, sizeOfOptionalHeader, numberOfSections, baseAddress);

        // Apply base relocations if loaded at different address than PE ImageBase
        if (baseAddress !== imageBase) {
            this.applyRelocations(peData, baseAddress);
        }

        // Relocation fixups rewrite bytes inside already-written code; one invalidation
        // covers them and any address reused by a previous tenant. It must span everything
        // the load TOUCHED, not just the image — the clear runs 64KB past SizeOfImage, and
        // a previous tenant's compiled blocks in that tail would otherwise survive the zeroing.
        invalidateGuestCode(baseAddress, clearedBytes);

        // Process Imports (now async to support real DLL loading)
        const importDirRVA = peView.getUint32(optHeaderPtr + 104, true);
        if (importDirRVA !== 0) {
            await this.processImports(baseAddress, importDirRVA);
        }

        // Process TLS directory (implicit __declspec(thread) variables)
        // Must be after sections+relocations so guest memory has correct VAs.
        {
            const exeName = system.executableName.toLowerCase().replace(/\.exe$/, '');
            this.processTlsDirectory(peView, optHeaderPtr, baseAddress, exeName);
        }

        // Register main executable in module registry.
        // Parse the EXE's export table too: engine-style games (e.g. Blade of Darkness)
        // export an API from the main EXE that their own DLLs import back
        // (Bladex.dll/netgame.dll import Blade.exe!GetStringValue etc.). Without these,
        // processImports patches those IAT slots with the missing-import trap.
        let exeModuleForHle: LoadedPEModule | null = null;
        if (this.moduleRegistry) {
            const exeName = system.executableName.toLowerCase().replace(/\.exe$/, '');
            const { exports: exeExports, ordinals: exeOrdinals } = this.parseExportTable(peData, baseAddress);
            if (exeExports.size > 0 || exeOrdinals.size > 0) {
                Logger.log(LogCategory.SYSTEM,
                    `[PE] Main EXE exports parsed: ${exeExports.size} named, ${exeOrdinals.size} ordinals`);
            }
            const exeModule: LoadedPEModule = {
                name: exeName,
                path: system.executablePath || `C:\\${system.executableName}`,
                baseAddress,
                size: sizeOfImage,
                entryPoint: entryPointRVA,
                exports: exeExports,
                ordinalExports: exeOrdinals,
                isRealDll: false,
                isExecutable: true,
                initialized: true,
                sections
            };
            this.moduleRegistry.register(exeModule);
            exeModuleForHle = exeModule;
        }

        // Static Library HLE detection: scan the freshly-loaded image for
        // signatures of zlib/libpng/etc and hook any matches. Must run AFTER
        // applyRelocations + processImports so signatures see their final
        // post-relocation bytes. No-op when hleLibs.enable=false.
        if (exeModuleForHle) {
            try {
                libHleManager.onModuleLoaded(exeModuleForHle);
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `[HLE-lib] onModuleLoaded threw on EXE: ${e}`);
            }
            try {
                hookRegistry.onModuleLoaded(exeModuleForHle);
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `[hooks] onModuleLoaded threw on EXE: ${e}`);
            }
        }

        // PE32 optional header offset 72 = SizeOfStackReserve
        const sizeOfStackReserve = peView.getUint32(optHeaderPtr + 72, true);

        return {
            baseAddress,
            entryPoint: baseAddress + entryPointRVA,
            size: sizeOfImage,
            sizeOfStackReserve,
        };
    }

    /**
     * Load sections from PE data into memory at given base address
     */
    private loadSections(
        peData: Uint8Array,
        peView: DataView,
        optHeaderPtr: number,
        sizeOfOptionalHeader: number,
        numberOfSections: number,
        baseAddress: number
    ): import('./module-registry').PESection[] {
        const sectionHeaderPtr = optHeaderPtr + sizeOfOptionalHeader;
        const sections: import('./module-registry').PESection[] = [];

        for (let i = 0; i < numberOfSections; i++) {
            const ptr = sectionHeaderPtr + (i * 40);

            // Read section name for logging
            let sectionName = '';
            for (let j = 0; j < 8 && peData[ptr + j] !== 0; j++) {
                sectionName += String.fromCharCode(peData[ptr + j]);
            }

            const virtualSize = peView.getUint32(ptr + 8, true);      // +8: VirtualSize
            const virtualAddress = peView.getUint32(ptr + 12, true);  // +12: VirtualAddress
            const rawDataSize = peView.getUint32(ptr + 16, true);     // +16: SizeOfRawData
            const rawDataPtr = peView.getUint32(ptr + 20, true);      // +20: PointerToRawData
            const characteristics = peView.getUint32(ptr + 36, true); // +36: Characteristics

            const targetAddr = baseAddress + virtualAddress;

            sections.push({
                name: sectionName,
                virtualAddress,
                virtualSize,
                rawSize: rawDataSize,
                characteristics
            });

            Logger.log(LogCategory.SYSTEM,
                `[PE] Section ${sectionName}: VA=0x${virtualAddress.toString(16)}, ` +
                `VS=0x${virtualSize.toString(16)}, Raw=0x${rawDataSize.toString(16)}, ` +
                `RawPtr=0x${rawDataPtr.toString(16)}, Target=0x${targetAddr.toString(16)}`);

            // A NULL PointerToRawData means the section has NO file content, however
            // large SizeOfRawData claims to be — Watcom describes .bss that way
            // (VirtualSize 0, SizeOfRawData 0x6b600, RawPtr 0). Copying that many
            // bytes "from offset 0" silently fills the guest's uninitialized data
            // with a copy of the image header + code, so every global it expects to
            // be zero reads back garbage.
            const hasFileData = rawDataPtr !== 0 && rawDataSize > 0;
            // Old linkers leave VirtualSize 0; the mapped extent is then SizeOfRawData.
            const mappedSize = virtualSize || rawDataSize;

            // 1. Copy raw data from file
            const copySize = hasFileData ? Math.min(rawDataSize, Math.max(0, peData.length - rawDataPtr)) : 0;
            if (copySize > 0) {
                writeGuestCode(this.memory, peData.subarray(rawDataPtr, rawDataPtr + copySize), targetAddr);
            }

            // 2. Zero-fill the rest of the mapped extent (BSS-like behavior)
            // This is REQUIRED by PE spec - uninitialized global variables depend on this
            const fillStart = targetAddr + copySize;
            const fillEnd = targetAddr + Math.max(mappedSize, copySize);
            if (fillEnd > fillStart) {
                this.memory.fill(0, fillStart, fillEnd);
                Logger.log(LogCategory.SYSTEM,
                    `[PE] Section ${sectionName}: zero-filled ${fillEnd - fillStart} bytes at 0x${fillStart.toString(16)}`);
            }
        }
        return sections;
    }

    /**
     * Load a real DLL from VFS
     * Returns the module or null if DLL not found in VFS
     */
    async loadDll(dllName: string, invokeDllMain: boolean = true): Promise<LoadedPEModule | null> {
        if (!this.vfs || !this.moduleRegistry) {
            return null;
        }

        const dllNameLower = dllName.toLowerCase().replace(/\.dll$/, '');

        // Skip native load of video DLLs when HLE stubs are active
        if (!EMU_NATIVE_VIDEO_DLLS && VIDEO_DLL_NAMES.has(dllNameLower)) {
            Logger.log(LogCategory.SYSTEM, `[PE] Skipping native load of "${dllName}" — HLE stubs active`);
            return null; // IAT will be resolved to HLE thunk stubs
        }

        // D3DX9 versioned redist DLLs (d3dx9_24 … d3dx9_43) — always HLE via canonical d3dx9 module.
        if (isD3dx9VersionedDll(dllNameLower)) {
            Logger.log(LogCategory.SYSTEM, `[PE] Skipping native load of "${dllName}" — d3dx9 HLE active`);
            return null;
        }

        // Check if already loaded. Pass the ORIGINAL name (with .dll) so getByName's
        // executable-vs-dll guard works — "…\hl.dll" must not resolve to the hl.exe module.
        const existing = this.moduleRegistry.getByName(dllName);
        if (existing) {
            Logger.log(LogCategory.SYSTEM, `[PE] DLL "${dllName}" already loaded at 0x${existing.baseAddress.toString(16)}`);
            return existing;
        }

        // Check for circular dependency
        if (this.loadingDlls.has(dllNameLower)) {
            Logger.warn(LogCategory.SYSTEM, `[PE] Circular dependency detected for "${dllName}", skipping`);
            return null;
        }

        // Find DLL in VFS
        const dllPath = this.findDllPath(dllNameLower);
        if (!dllPath) {
            return null;
        }

        Logger.log(LogCategory.SYSTEM, `[PE] Loading real DLL: ${dllName} from VFS path: ${dllPath}`);

        // Mark as loading to detect circular dependencies
        this.loadingDlls.add(dllNameLower);

        let registered = false;
        try {
            // Open and read DLL from VFS
            const handle = await this.vfs.open(dllPath, 0x80000000, 3); // GENERIC_READ, OPEN_EXISTING
            if (!handle) {
                Logger.warn(LogCategory.SYSTEM, `[PE] Failed to open DLL: ${dllPath}`);
                return null;
            }

            const fileSize = this.vfs.getFileSize(dllPath);
            const peData = await this.vfs.read(handle, fileSize);

            if (peData.length === 0) {
                Logger.warn(LogCategory.SYSTEM, `[PE] Empty DLL file: ${dllPath}`);
                return null;
            }

            // Parse PE headers
            const peView = new DataView(peData.buffer, peData.byteOffset, peData.byteLength);

            // Verify DOS Header
            if (peView.getUint16(0, true) !== 0x5A4D) {
                Logger.warn(LogCategory.SYSTEM, `[PE] Invalid DOS header in DLL: ${dllPath}`);
                return null;
            }
            const e_lfanew = peView.getUint32(0x3C, true);

            // Verify PE Header
            if (peView.getUint32(e_lfanew, true) !== 0x00004550) {
                Logger.warn(LogCategory.SYSTEM, `[PE] Invalid PE header in DLL: ${dllPath}`);
                return null;
            }

            const numberOfSections = peView.getUint16(e_lfanew + 6, true);
            const sizeOfOptionalHeader = peView.getUint16(e_lfanew + 20, true);
            const optHeaderPtr = e_lfanew + 24;

            const magic = peView.getUint16(optHeaderPtr, true);
            if (magic !== 0x10B) {
                Logger.warn(LogCategory.SYSTEM, `[PE] Only 32-bit PE DLLs are supported: ${dllPath}`);
                return null;
            }

            const sizeOfImage = peView.getUint32(optHeaderPtr + 56, true);
            const entryPointRVA = peView.getUint32(optHeaderPtr + 16, true);

            // Allocate base address for DLL
            const baseAddress = this.moduleRegistry.allocateBase(sizeOfImage);

            // Register address space region
            const system = System.getInstance();
            const addressSpace = system.process?.addressSpace;
            if (addressSpace) {
                addressSpace.mapRegion(baseAddress, sizeOfImage, "rwx", "ROM", "PELoader", "dll");
            }

            // Clear region before loading
            this.memory.fill(0, baseAddress, baseAddress + sizeOfImage);

            // Copy PE headers to memory (needed for resource access, etc.)
            const sizeOfHeaders = peView.getUint32(optHeaderPtr + 60, true);
            writeGuestCode(this.memory, peData.subarray(0, sizeOfHeaders), baseAddress);

            // Load sections
            const sections = this.loadSections(peData, peView, optHeaderPtr, sizeOfOptionalHeader, numberOfSections, baseAddress);

            // Apply base relocations (MUST be done after sections are loaded, before imports)
            this.applyRelocations(peData, baseAddress);
            invalidateGuestCode(baseAddress, sizeOfImage);

            // Process TLS directory (implicit __declspec(thread) variables)
            // Must be after sections+relocations so guest memory has correct VAs.
            this.processTlsDirectory(peView, optHeaderPtr, baseAddress, dllNameLower);

            // Parse export table (from guest memory — relocations already applied)
            const { exports, ordinals } = this.parseExportTable(peData, baseAddress);

            // Create module entry (register before processing imports to handle circular deps)
            const module: LoadedPEModule = {
                name: dllNameLower,
                path: dllPath,
                baseAddress,
                size: sizeOfImage,
                fileSize: peData.byteLength,
                entryPoint: entryPointRVA,
                exports,
                ordinalExports: ordinals,
                isRealDll: true,
                initialized: false,
                sections
            };
            this.moduleRegistry.register(module);
            registered = true;

            // Static Library HLE detection for this DLL's image (same reason as EXE path).
            try {
                libHleManager.onModuleLoaded(module);
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `[HLE-lib] onModuleLoaded threw on DLL ${dllName}: ${e}`);
            }
            try {
                hookRegistry.onModuleLoaded(module);
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `[hooks] onModuleLoaded threw on DLL ${dllName}: ${e}`);
            }

            // Process DLL's own imports (recursive)
            // Native DLLs importing thunked modules (kernel32, user32, dinput, etc.)
            // get HLE thunk stubs patched into their IAT.
            const importDirRVA = peView.getUint32(optHeaderPtr + 104, true);
            if (importDirRVA !== 0) {
                Logger.warn(LogCategory.SYSTEM,
                    `[PE] === Processing imports for NATIVE DLL "${dllNameLower}" (base=0x${baseAddress.toString(16)}) ===`);
                await this.processImports(baseAddress, importDirRVA);
            }

            // Galaxy HLE after imports: patch function bodies, not packed 5-byte export thunks.
            try {
                const system = System.getInstance();
                if (system.process) {
                    Galaxy.onNativeModuleLoaded(system.process, module);
                }
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `[Galaxy] onNativeModuleLoaded threw on DLL ${dllName}: ${e}`);
            }

            Logger.warn(LogCategory.SYSTEM,
                `[PE] Loaded real DLL "${dllName}" at 0x${baseAddress.toString(16)}, ` +
                `exports: ${exports.size} by name, ${ordinals.size} by ordinal, entryPointRVA=0x${entryPointRVA.toString(16)}`);

            // Queue DllMain for bootloader trampoline (runs as x86 code before EXE entry).
            // Runtime LoadLibrary* path can defer this to thunk-dispatcher callback flow.
            if (invokeDllMain && entryPointRVA !== 0) {
                this.pendingDllInits.push({
                    baseAddress,
                    entryPoint: baseAddress + entryPointRVA,
                    name: dllNameLower,
                });
                Logger.warn(LogCategory.SYSTEM,
                    `[PE] Queued DllMain for "${dllNameLower}" at 0x${(baseAddress + entryPointRVA).toString(16)}`);
            } else if (entryPointRVA === 0) {
                Logger.warn(LogCategory.SYSTEM,
                    `[PE] DLL "${dllNameLower}" has NO entry point (entryPointRVA=0), skipping DllMain`);
            }

            return module;
        } catch (e) {
            // LoadLibrary is all-or-nothing: a half-linked module must not stay
            // resolvable, or a later LoadLibrary returns its base with an unpatched
            // IAT and the guest jumps wild. Memory stays allocated (harmless leak);
            // the registry entry must go so subsequent loads report NOT FOUND.
            if (registered) {
                this.moduleRegistry.unregister(dllNameLower);
                this.pendingDllInits = this.pendingDllInits.filter(p => p.name !== dllNameLower);
                Logger.warn(LogCategory.SYSTEM,
                    `[PE] Load of "${dllName}" failed after registration — unregistered half-linked module: ${e}`);
            }
            throw e;
        } finally {
            this.loadingDlls.delete(dllNameLower);
        }
    }

    /**
     * Apply base relocations to a PE loaded at a different address than its preferred ImageBase.
     * Without this, all absolute addresses in the DLL's code/data are wrong when loaded
     * at a non-preferred base, causing crashes (bad jumps, wrong global accesses, etc.).
     */
    private applyRelocations(
        peData: Uint8Array,
        baseAddress: number
    ): void {
        const peView = new DataView(peData.buffer, peData.byteOffset, peData.byteLength);
        const e_lfanew = peView.getUint32(0x3C, true);
        const optHeaderPtr = e_lfanew + 24;

        // Read preferred ImageBase
        const preferredBase = peView.getUint32(optHeaderPtr + 28, true);
        const delta = (baseAddress - preferredBase) | 0; // signed 32-bit delta

        if (delta === 0) {
            Logger.verbose(LogCategory.SYSTEM,
                `[PE] No relocation needed (loaded at preferred base 0x${preferredBase.toString(16)})`);
            return;
        }

        // Base Relocation Table is DataDirectory[5] (offset 136 from optional header)
        const relocDirRVA = peView.getUint32(optHeaderPtr + 136, true);
        const relocDirSize = peView.getUint32(optHeaderPtr + 140, true);

        if (relocDirRVA === 0 || relocDirSize === 0) {
            Logger.warn(LogCategory.SYSTEM,
                `[PE] DLL has no relocation table but loaded at non-preferred base! ` +
                `Preferred=0x${preferredBase.toString(16)}, Actual=0x${baseAddress.toString(16)}, Delta=0x${(delta >>> 0).toString(16)}`);
            return;
        }

        // Work on guest memory (sections already copied there)
        const mem = this.memory;
        const memView = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        let fixupCount = 0;
        let blockOffset = relocDirRVA;
        const relocEnd = relocDirRVA + relocDirSize;

        while (blockOffset < relocEnd) {
            const blockAddr = baseAddress + blockOffset;
            if (blockAddr + 8 > mem.length) break;

            const pageRVA = memView.getUint32(blockAddr, true);
            const blockSize = memView.getUint32(blockAddr + 4, true);

            if (blockSize < 8) break; // Invalid block

            const entryCount = (blockSize - 8) / 2;
            for (let i = 0; i < entryCount; i++) {
                const entryOffset = blockAddr + 8 + i * 2;
                if (entryOffset + 2 > mem.length) break;

                const entry = memView.getUint16(entryOffset, true);
                const type = (entry >> 12) & 0xF;
                const offset = entry & 0xFFF;

                if (type === 3) { // IMAGE_REL_BASED_HIGHLOW
                    const targetAddr = baseAddress + pageRVA + offset;
                    if (targetAddr + 4 <= mem.length) {
                        const oldValue = memView.getUint32(targetAddr, true);
                        memView.setUint32(targetAddr, (oldValue + delta) >>> 0, true);
                        fixupCount++;
                    }
                }
                // type 0 = IMAGE_REL_BASED_ABSOLUTE (padding, skip)
            }

            blockOffset += blockSize;
        }

        Logger.log(LogCategory.SYSTEM,
            `[PE] Applied ${fixupCount} relocations (delta=0x${(delta >>> 0).toString(16)}, ` +
            `preferred=0x${preferredBase.toString(16)} -> actual=0x${baseAddress.toString(16)})`);
    }

    /**
     * Process the PE TLS directory (IMAGE_DATA_DIRECTORY[9]).
     * Sets up implicit TLS (__declspec(thread)) for the module:
     * - Allocates a TLS index
     * - Writes the index to AddressOfIndex in guest memory
     * - Copies TLS template data into a per-thread allocation
     * - Stores the data pointer in the current thread's TLS array (FS:[0x2C])
     * - Registers the entry so new threads get TLS data too
     */
    private processTlsDirectory(
        peView: DataView,
        optHeaderPtr: number,
        baseAddress: number,
        moduleName: string
    ): void {
        // TLS directory is DataDirectory[9] at optional header offset 96 + 9*8 = 168
        const tlsDirRVA = peView.getUint32(optHeaderPtr + 168, true);
        const tlsDirSize = peView.getUint32(optHeaderPtr + 172, true);

        if (tlsDirRVA === 0 || tlsDirSize === 0) return;

        // Read IMAGE_TLS_DIRECTORY from GUEST MEMORY (after relocations applied)
        const mem = this.memory;
        const memView = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const tlsDirAddr = baseAddress + tlsDirRVA;

        const startOfRawData = memView.getUint32(tlsDirAddr, true);
        const endOfRawData = memView.getUint32(tlsDirAddr + 4, true);
        const addressOfIndex = memView.getUint32(tlsDirAddr + 8, true);
        const addressOfCallbacks = memView.getUint32(tlsDirAddr + 12, true);
        const sizeOfZeroFill = memView.getUint32(tlsDirAddr + 16, true);

        const templateSize = endOfRawData > startOfRawData ? endOfRawData - startOfRawData : 0;
        const totalTlsSize = templateSize + sizeOfZeroFill;

        if (totalTlsSize === 0) {
            Logger.log(LogCategory.SYSTEM,
                `[PE] TLS directory in "${moduleName}": empty (0 bytes), skipping`);
            return;
        }

        Logger.log(LogCategory.SYSTEM,
            `[PE] TLS directory in "${moduleName}": template=0x${startOfRawData.toString(16)}-0x${endOfRawData.toString(16)} ` +
            `(${templateSize}+${sizeOfZeroFill} bytes), index@0x${addressOfIndex.toString(16)}, callbacks@0x${addressOfCallbacks.toString(16)}`);

        // Allocate TLS index via scheduler (uses same slot space as TlsAlloc)
        const system = System.getInstance();
        const scheduler = system.scheduler;
        const tlsIndex = scheduler.tlsAlloc();

        if (tlsIndex === 0xFFFFFFFF) {
            Logger.error(LogCategory.SYSTEM, `[PE] TLS: Failed to allocate index for "${moduleName}" (all slots full)`);
            return;
        }

        // Write TLS index to AddressOfIndex in guest memory
        memView.setUint32(addressOfIndex, tlsIndex, true);

        // Register entry for thread initialization (ensureMainThread / createThread will use it)
        system.implicitTlsEntries.push({
            tlsIndex,
            templateStart: startOfRawData,
            templateSize,
            zeroFillSize: sizeOfZeroFill,
            moduleName,
        });

        Logger.log(LogCategory.SYSTEM,
            `[PE] TLS: "${moduleName}" index=${tlsIndex} template=0x${startOfRawData.toString(16)} (${totalTlsSize} bytes) ` +
            `index@0x${addressOfIndex.toString(16)}=${tlsIndex}`);
    }

    /**
     * Parse PE Export Directory to get exports
     */
    private parseExportTable(peData: Uint8Array, baseAddress: number): {
        exports: Map<string, number>;
        ordinals: Map<number, number>;
    } {
        const exports = new Map<string, number>();
        const ordinals = new Map<number, number>();

        const peView = new DataView(peData.buffer, peData.byteOffset, peData.byteLength);
        const e_lfanew = peView.getUint32(0x3C, true);
        const optHeaderPtr = e_lfanew + 24;

        // Export Directory is at DataDirectory[0] (offset 96 from optional header start)
        const exportDirRVA = peView.getUint32(optHeaderPtr + 96, true);
        const exportDirSize = peView.getUint32(optHeaderPtr + 100, true);

        if (exportDirRVA === 0) {
            return { exports, ordinals };
        }

        // Read from PE data, not memory (since we're parsing before loading is complete)
        // Need to convert RVA to file offset
        const exportDirOffset = this.rvaToFileOffset(peData, exportDirRVA);
        if (exportDirOffset === null) {
            Logger.warn(LogCategory.SYSTEM, `[PE] Could not convert export dir RVA 0x${exportDirRVA.toString(16)} to file offset`);
            return { exports, ordinals };
        }

        // Export Directory structure
        const numberOfFunctions = peView.getUint32(exportDirOffset + 20, true);
        const numberOfNames = peView.getUint32(exportDirOffset + 24, true);
        const addressOfFunctionsRVA = peView.getUint32(exportDirOffset + 28, true);
        const addressOfNamesRVA = peView.getUint32(exportDirOffset + 32, true);
        const addressOfNameOrdinalsRVA = peView.getUint32(exportDirOffset + 36, true);
        const ordinalBase = peView.getUint32(exportDirOffset + 16, true);

        const functionsOffset = this.rvaToFileOffset(peData, addressOfFunctionsRVA);
        const namesOffset = this.rvaToFileOffset(peData, addressOfNamesRVA);
        const nameOrdinalsOffset = this.rvaToFileOffset(peData, addressOfNameOrdinalsRVA);

        if (functionsOffset === null) {
            return { exports, ordinals };
        }

        // Parse function addresses (by ordinal)
        for (let i = 0; i < numberOfFunctions; i++) {
            const funcRVA = peView.getUint32(functionsOffset + i * 4, true);
            if (funcRVA !== 0) {
                // Check if this is a forwarder (RVA points within export directory)
                if (funcRVA >= exportDirRVA && funcRVA < exportDirRVA + exportDirSize) {
                    // Forwarder - skip for now (would need to resolve the forwarded function)
                    continue;
                }
                const absoluteAddr = baseAddress + funcRVA;
                const ordinal = ordinalBase + i;
                ordinals.set(ordinal, absoluteAddr);
            }
        }

        // Parse named exports
        if (namesOffset !== null && nameOrdinalsOffset !== null) {
            for (let i = 0; i < numberOfNames; i++) {
                const nameRVA = peView.getUint32(namesOffset + i * 4, true);
                const ordinalIndex = peView.getUint16(nameOrdinalsOffset + i * 2, true);

                const nameOffset = this.rvaToFileOffset(peData, nameRVA);
                if (nameOffset === null) continue;

                // Read name string
                let name = '';
                let j = nameOffset;
                while (j < peData.length && peData[j] !== 0) {
                    name += String.fromCharCode(peData[j++]);
                }

                // Get function address
                const funcRVA = peView.getUint32(functionsOffset + ordinalIndex * 4, true);
                if (funcRVA !== 0) {
                    // Skip forwarders
                    if (funcRVA >= exportDirRVA && funcRVA < exportDirRVA + exportDirSize) {
                        continue;
                    }
                    const absoluteAddr = baseAddress + funcRVA;
                    exports.set(name.toLowerCase(), absoluteAddr);
                }
            }
        }

        return { exports, ordinals };
    }

    /**
     * Convert RVA to file offset using section headers
     */
    private rvaToFileOffset(peData: Uint8Array, rva: number): number | null {
        const peView = new DataView(peData.buffer, peData.byteOffset, peData.byteLength);
        const e_lfanew = peView.getUint32(0x3C, true);
        const numberOfSections = peView.getUint16(e_lfanew + 6, true);
        const sizeOfOptionalHeader = peView.getUint16(e_lfanew + 20, true);
        const sectionHeaderPtr = e_lfanew + 24 + sizeOfOptionalHeader;

        for (let i = 0; i < numberOfSections; i++) {
            const ptr = sectionHeaderPtr + (i * 40);
            const virtualAddress = peView.getUint32(ptr + 12, true);
            const virtualSize = peView.getUint32(ptr + 8, true);
            const rawDataPtr = peView.getUint32(ptr + 20, true);
            const rawDataSize = peView.getUint32(ptr + 16, true);

            // Use the larger of virtualSize and rawDataSize for section bounds
            const sectionSize = Math.max(virtualSize, rawDataSize);

            if (rva >= virtualAddress && rva < virtualAddress + sectionSize) {
                return rawDataPtr + (rva - virtualAddress);
            }
        }

        // RVA might be in headers (before first section)
        const sizeOfHeaders = peView.getUint32(e_lfanew + 24 + 60, true);
        if (rva < sizeOfHeaders) {
            return rva;
        }

        return null;
    }

    /**
     * Find DLL path in VFS (case-insensitive search)
     * Search order: 1. Application directory (same as EXE), 2. C:\ root, 3. Windows system directories
     */
    /** VFS path of a DLL by the Windows search order, or null. Public because HLE
     *  modules that shadow a shipped DLL still need the file (e.g. to read its
     *  version resource and match that build's ABI). */
    findDllPath(dllName: string): string | null {
        if (!this.vfs) return null;

        const dllNameLower = dllName.toLowerCase();
        // Only append .dll if the name has no extension at all (e.g. "kernel32" → "kernel32.dll").
        // Preserve non-.dll extensions like .lng, .drv, etc. — Windows LoadLibrary handles any extension.
        const hasExtension = /\.\w+$/.test(dllNameLower);
        const dllFileName = hasExtension ? dllNameLower : `${dllNameLower}.dll`;

        // Handle explicitly absolute inputs only (e.g. "C:\foo.dll" or "\foo.dll").
        // Do not call resolvePath() before this check: it would turn relative names
        // like "window.dll" into absolute paths and skip EXE-directory search.
        const normalizedInput = dllName.trim().replace(/\//g, "\\");
        const isAbsoluteInput = /^[A-Za-z]:\\/.test(normalizedInput) || normalizedInput.startsWith("\\");
        if (isAbsoluteInput) {
            const candidateInput = /\.\w+$/i.test(normalizedInput)
                ? normalizedInput
                : `${normalizedInput}.dll`;
            const candidatePath = this.vfs.resolvePath(candidateInput);

            const existsInRom = this.vfs.hasRomFile(candidatePath);
            if (existsInRom) {
                Logger.log(LogCategory.SYSTEM,
                    `[PE] findDllPath("${dllName}"): found at absolute path ${candidatePath}`);
                return candidatePath;
            }

            try {
                const dir = candidatePath.substring(0, candidatePath.lastIndexOf('\\') + 1);
                const fileName = candidatePath.substring(dir.length);
                const entries = this.vfs.listDirectory(dir);
                for (const entry of entries) {
                    if (entry.kind === 'file' && entry.name.toLowerCase() === fileName.toLowerCase()) {
                        const foundPath = `${dir}${entry.name}`;
                        Logger.log(LogCategory.SYSTEM,
                            `[PE] findDllPath("${dllName}"): found via absolute directory listing at ${foundPath}`);
                        return foundPath;
                    }
                }
            } catch {
                // ignore listing failures
            }

            Logger.verbose(LogCategory.SYSTEM,
                `[PE] findDllPath("${dllName}"): absolute path ${candidatePath} not found`);
            return null;
        }

        // Get application directory from executable path
        const system = System.getInstance();
        const exePath = system.executablePath;
        const lastSlash = exePath.lastIndexOf('\\');
        const appDir = lastSlash > 2 ? exePath.slice(0, lastSlash + 1) : 'C:\\';

        // Search order (real Windows default DLL search order, without SafeDllSearchMode):
        // 1. Application directory (same directory as the EXE) - highest priority
        // 2. Current directory (SetCurrentDirectoryA scope — games commonly cd into a
        //    driver/plugin subfolder, then LoadLibraryA a bare filename expecting it to
        //    resolve there, e.g. Max Payne's e2driver\*_driver_mfc.dll)
        // 3. Root directory (C:\)
        // 4. Windows system directories
        const currentDir = this.vfs.currentDir;

        const searchPaths = [
            `${appDir}${dllFileName}`,
        ];

        // Only add current directory if it's different from appDir
        if (currentDir.toLowerCase() !== appDir.toLowerCase()) {
            searchPaths.push(`${currentDir}${dllFileName}`);
        }

        // Only add C:\ root if it's different from appDir and currentDir
        if (appDir.toLowerCase() !== 'c:\\' && currentDir.toLowerCase() !== 'c:\\') {
            searchPaths.push(`C:\\${dllFileName}`);
        }

        searchPaths.push(
            `C:\\WINDOWS\\SYSTEM32\\${dllFileName}`,
            `C:\\WINDOWS\\SYSTEM\\${dllFileName}`,
            `C:\\WINDOWS\\${dllFileName}`,
        );

        Logger.verbose(LogCategory.SYSTEM, `[PE] findDllPath("${dllName}"): searching in ${searchPaths.join(', ')}`);

        for (const path of searchPaths) {
            if (this.vfs.hasRomFile(path)) {
                Logger.log(LogCategory.SYSTEM, `[PE] findDllPath("${dllName}"): found at ${path}`);
                return path;
            }
        }

        // Try case-insensitive search in application directory listing
        if (appDir !== 'C:\\') {
            try {
                const appDirEntries = this.vfs.listDirectory(appDir);
                for (const entry of appDirEntries) {
                    if (entry.kind === 'file' && entry.name.toLowerCase() === dllFileName) {
                        const foundPath = `${appDir}${entry.name}`;
                        Logger.log(LogCategory.SYSTEM, `[PE] findDllPath("${dllName}"): found via listing at ${foundPath}`);
                        return foundPath;
                    }
                }
            } catch {
                // Directory listing may fail for non-existent directories
            }
        }

        // Try case-insensitive search in current directory listing
        if (currentDir.toLowerCase() !== appDir.toLowerCase() && currentDir !== 'C:\\') {
            try {
                const currentDirEntries = this.vfs.listDirectory(currentDir);
                for (const entry of currentDirEntries) {
                    if (entry.kind === 'file' && entry.name.toLowerCase() === dllFileName) {
                        const foundPath = `${currentDir}${entry.name}`;
                        Logger.log(LogCategory.SYSTEM, `[PE] findDllPath("${dllName}"): found via current-directory listing at ${foundPath}`);
                        return foundPath;
                    }
                }
            } catch {
                // Directory listing may fail for non-existent directories
            }
        }

        // Try case-insensitive search in root directory listing
        const rootEntries = this.vfs.listDirectory('C:\\');
        for (const entry of rootEntries) {
            if (entry.kind === 'file' && entry.name.toLowerCase() === dllFileName) {
                const foundPath = `C:\\${entry.name}`;
                Logger.log(LogCategory.SYSTEM, `[PE] findDllPath("${dllName}"): found via root listing at ${foundPath}`);
                return foundPath;
            }
        }

        Logger.verbose(LogCategory.SYSTEM, `[PE] findDllPath("${dllName}"): NOT FOUND`);
        return null;
    }

    private async processImports(baseAddress: number, importDirRVA: number): Promise<void> {
        let descriptorAddr = baseAddress + importDirRVA;
        const allDependencies: Array<{
            dllName: string;
            dllNameRaw: string;
            functions: Array<{ name?: string; ordinal?: number }>;
            isThunked: boolean;
            isRealDll: boolean;
        }> = [];

        Logger.log(LogCategory.SYSTEM, `[PE] Starting import table processing...`);

        while (true) {
            const nameRVA = this.view.getUint32(descriptorAddr + 12, true);
            if (nameRVA === 0) break;

            const dllNameRaw = this.readString(baseAddress + nameRVA);
            const dllNameBeforeAlias = dllNameRaw.toLowerCase().replace(/\.dll$/i, '');
            const dllName = resolveThunkedDllAlias(dllNameBeforeAlias);
            const aliasTarget = dllName !== dllNameBeforeAlias ? dllName : null;
            if (aliasTarget) {
                Logger.log(LogCategory.SYSTEM, `[PE] DLL alias: ${dllNameRaw} → ${aliasTarget} (using thunked implementation)`);
            }

            const iltRVA = this.view.getUint32(descriptorAddr, true); // Import Lookup Table
            const iatRVA = this.view.getUint32(descriptorAddr + 16, true); // Import Address Table

            const functions = this.parseImportTable(baseAddress, iltRVA || iatRVA);

            // Check if this DLL is thunked (has API registry entries).
            // Video DLLs are excluded when native loading is enabled — they fall through to VFS.
            let isThunked = this.apiRegistry.hasModule(dllName) &&
                !(EMU_NATIVE_VIDEO_DLLS && VIDEO_DLL_NAMES.has(dllName));

            // A thunked module must cover every requested import — stdcall stubs need
            // argCount or stackCleanupBytes, and generateStubDll throws otherwise.
            // A registry module name can collide with an unrelated real DLL a game ships
            // (same filename, different library): if the registry cannot satisfy some
            // imports but the real file exists in the VFS, load it natively instead.
            // Aliased DLLs keep their trap-stub handling for unknown imports; DLLs the
            // native loader refuses (HLE-only video/d3dx9) stay thunked.
            if (isThunked && !aliasTarget &&
                !HLE_ONLY_DLLS.has(dllName) &&
                !(!EMU_NATIVE_VIDEO_DLLS && VIDEO_DLL_NAMES.has(dllName)) &&
                !isD3dx9VersionedDll(dllName)) {
                const uncovered = functions.filter(f => {
                    if (f.name) {
                        const cc = this.apiRegistry.getCallingConvention(dllName, f.name);
                        return (!cc || cc === 'stdcall') &&
                            this.apiRegistry.getArgCount(dllName, f.name) === undefined &&
                            this.apiRegistry.getStackCleanupBytes(dllName, f.name) === undefined &&
                            deriveStackCleanupFromMangledName(f.name) === undefined;
                    }
                    return f.ordinal !== undefined &&
                        this.apiRegistry.getArgCountByOrdinal(dllName, f.ordinal) === undefined;
                });
                if (uncovered.length > 0 && this.findDllPath(dllName) !== null) {
                    const names = uncovered.slice(0, 5).map(f => f.name || `ord_${f.ordinal}`).join(', ');
                    Logger.warn(LogCategory.SYSTEM,
                        `[PE] Thunked module "${dllName}" cannot cover ${uncovered.length}/${functions.length} ` +
                        `imports of ${dllNameRaw} (${names}${uncovered.length > 5 ? ', …' : ''}); ` +
                        `real DLL exists in VFS — loading natively instead of thunking`);
                    isThunked = false;
                }
            }

            // Log ALL DLLs and their functions
            const importedNames = functions.map(f => f.name || `ord_${f.ordinal}`);
            const thunkedStatus = isThunked ? "THUNKED" : "NOT THUNKED";
            Logger.log(LogCategory.SYSTEM, `[PE] DLL: ${dllNameRaw} (${thunkedStatus}) - ${functions.length} functions`);

            // Log ALL imported function names (no truncation)
            Logger.log(LogCategory.SYSTEM, `[PE]   Functions: ${importedNames.join(", ")}`);

            let isRealDll = false;
            let iatAddr = baseAddress + iatRVA;

            // PRIORITY 1: Thunked APIs (kernel32, user32, ddraw, dsound, etc.)
            // These ALWAYS use our HLE implementations, even if a real DLL exists in VFS
            if (isThunked) {
                // Generate stubs with arg counts and calling conventions
                // For aliased DLLs, some imports may not exist in our registry — use trap stubs for those
                const knownFunctions: typeof functions = [];
                const unknownFunctions = new Set<string>();

                const stubInfos: { name: string, argCount?: number, stackCleanupBytes?: number, callingConvention?: string }[] = [];
                for (const f of functions) {
                    const name = f.name || `ord_${f.ordinal}`;
                    let argCount: number | undefined;
                    let stackCleanupBytes: number | undefined;
                    let callingConvention: string | undefined;

                    if (f.name) {
                        argCount = this.apiRegistry.getArgCount(dllName, f.name);
                        stackCleanupBytes = this.apiRegistry.getStackCleanupBytes(dllName, f.name);
                        callingConvention = this.apiRegistry.getCallingConvention(dllName, f.name);
                    } else if (f.ordinal !== undefined) {
                        argCount = this.apiRegistry.getArgCountByOrdinal(dllName, f.ordinal);
                        stackCleanupBytes = argCount !== undefined ? argCount * 4 : undefined;
                    }

                    if (argCount === undefined) {
                        Logger.warn(LogCategory.SYSTEM, `[PE] Unknown arg count for ${dllName}:${name}${aliasTarget ? ` (aliased from ${dllNameRaw})` : ''}`);
                        loadDiagnostics.noteUnknownArgCount(dllName, name, aliasTarget ? dllNameRaw : null);
                        if (aliasTarget) {
                            // For aliased DLLs, unknown functions get trap stubs instead of throwing
                            unknownFunctions.add(name.toLowerCase());
                            continue;
                        }
                    }

                    knownFunctions.push(f);
                    stubInfos.push({ name, argCount, stackCleanupBytes, callingConvention });
                }

                const stubDll = this.thunkGenerator.generateStubDll(dllName, stubInfos);

                // One-time inline x86 stub generation for kernel32!HeapAlloc/HeapFree.
                // Happens on first kernel32 import; cached for later DLLs' IAT patching.
                if (dllName === 'kernel32' && !this.heapInlineStubs) {
                    const heapAllocTrap = stubDll.exportTable.get('heapalloc');
                    const heapFreeTrap = stubDll.exportTable.get('heapfree');
                    const hpBase = hypercallDataManager.getHpBase();
                    if (heapAllocTrap && heapFreeTrap && hpBase !== 0) {
                        try {
                            // The inline HeapAlloc stub routes HEAP_ZERO_MEMORY to the
                            // original OUT-trap so Rust handle_heap_alloc can use
                            // zero_block on the shared slab. Register those trap IDs
                            // immediately; dynamic DLL loads can execute import stubs
                            // before the next broad applyPendingRegistrations() pass.
                            const heapAllocTrapStub = this.thunkGenerator.getStubByAddress(heapAllocTrap);
                            const heapFreeTrapStub = this.thunkGenerator.getStubByAddress(heapFreeTrap);
                            if (heapAllocTrapStub) {
                                hypercallDataManager.registerFunction('kernel32', 'HeapAlloc', heapAllocTrapStub.functionId);
                            }
                            if (heapFreeTrapStub) {
                                hypercallDataManager.registerFunction('kernel32', 'HeapFree', heapFreeTrapStub.functionId);
                            }

                            const sys = System.getInstance();
                            const tmm = sys.process?.thunkMemoryManager;
                            const lutAddr = tmm?.getRegions().heapBinLutAddr;
                            const slabCtlAddr = tmm?.getRegions().slabControlAddr;
                            if (tmm && lutAddr && slabCtlAddr) {
                                // Tell the JS slab manager to read/write the SAME guest-RAM
                                // control block the inline stubs use (else stub & JS diverge).
                                hypercallDataManager.setSlabControlAddr(slabCtlAddr);
                                this.heapInlineStubs = writeHeapSlabStubs(tmm.stubAllocator,
                                    this.getMemory, slabCtlAddr, lutAddr, heapAllocTrap, heapFreeTrap);
                                // The free-list pop/push/bump in these stubs are non-atomic RMWs
                                // on shared slab state — mark the stub block non-preemptible so a
                                // 1ms-quantum thread switch can't interleave two threads mid-RMW.
                                sys.scheduler?.registerNonPreemptibleRange(
                                    this.heapInlineStubs.regionBase, this.heapInlineStubs.regionEnd);
                            }
                        } catch (e) {
                            Logger.warn(LogCategory.SYSTEM, `[PE] Inline heap stubs unavailable: ${e}`);
                        }
                    }
                }

                // One-time inline x86 stub generation for the msvcrt cdecl CRT
                // allocator pair (malloc/operator new + free/operator delete). Rides
                // the same WASM slab arena as the kernel32 heap stubs. Generated on the
                // first CRT module import; reused for later CRT modules' IAT patching.
                if (PELoader.CRT_SLAB_MODULES.has(dllName) && !this.crtInlineStubs) {
                    const mallocTrap = PELoader.CRT_MALLOC_KEYS
                        .map(k => stubDll.exportTable.get(k)).find(a => a !== undefined);
                    const freeTrap = PELoader.CRT_FREE_KEYS
                        .map(k => stubDll.exportTable.get(k)).find(a => a !== undefined);
                    const hpBase = hypercallDataManager.getHpBase();
                    if (mallocTrap && freeTrap && hpBase !== 0) {
                        try {
                            const sys = System.getInstance();
                            const tmm = sys.process?.thunkMemoryManager;
                            const lutAddr = tmm?.getRegions().heapBinLutAddr;
                            const slabCtlAddr = tmm?.getRegions().slabControlAddr;
                            if (tmm && lutAddr && slabCtlAddr) {
                                hypercallDataManager.setSlabControlAddr(slabCtlAddr);
                                this.crtInlineStubs = writeCrtSlabStubs(tmm.stubAllocator,
                                    this.getMemory, slabCtlAddr, lutAddr, mallocTrap, freeTrap);
                                sys.scheduler?.registerNonPreemptibleRange(
                                    this.crtInlineStubs.regionBase, this.crtInlineStubs.regionEnd);
                            }
                        } catch (e) {
                            Logger.warn(LogCategory.SYSTEM, `[PE] Inline CRT slab stubs unavailable: ${e}`);
                        }
                    }
                }

                // One-time inline x86 stubs for msvcrt tolower/toupper (trap-free single LUT
                // lookup — kills the per-char OUT-trap in path-normalization loops). Generated
                // on the first CRT-module import; the LUTs live in msvcrt and track the codepage.
                if (PELoader.CRT_SLAB_MODULES.has(dllName) && !this.caseFoldInlineStubs
                    && !(globalThis as any).__noCaseFoldStub) {
                    try {
                        const sys = System.getInstance();
                        const tmm = sys.process?.thunkMemoryManager;
                        const msvcrt = sys.process?.getModule?.('msvcrt') as
                            { getCaseTableAddrs?: () => { lower: number; upper: number } } | undefined;
                        const tbl = msvcrt?.getCaseTableAddrs?.();
                        if (tmm && tbl && tbl.lower && tbl.upper) {
                            this.caseFoldInlineStubs = writeCaseFoldStubs(tmm.stubAllocator, this.getMemory, tbl.lower, tbl.upper);
                        } else {
                            Logger.warn(LogCategory.SYSTEM,
                                `[PE] case-fold stubs skipped for ${dllName}: tmm=${!!tmm} msvcrt=${!!msvcrt} ` +
                                `getCaseTableAddrs=${typeof msvcrt?.getCaseTableAddrs} tbl=${JSON.stringify(tbl)}`);
                        }
                    } catch (e) {
                        Logger.warn(LogCategory.SYSTEM, `[PE] Inline case-fold stubs unavailable: ${e}`);
                    }
                }

                // Patch IAT with stub addresses
                for (const func of functions) {
                    const funcKey = (func.name || `ord_${func.ordinal}`).toLowerCase();
                    if (unknownFunctions.has(funcKey)) {
                        // Unknown function from aliased DLL — use trap stub
                        this.thunkGenerator.writeTrapStub(this.memory);
                        this.view.setUint32(iatAddr, this.thunkGenerator.getTrapStubAddress(), true);
                        Logger.warn(LogCategory.SYSTEM, `[PE] Trap stub for unknown ${dllName}:${func.name || `ord_${func.ordinal}`} (from alias ${dllNameRaw})`);
                    } else {
                        // Heap slab fast path: override IAT with inline x86 stub when available.
                        // Inline stub's fallback JMPs to the original OUT-trap stub. HEAP_ZERO
                        // is deliberately routed there for Rust zero_block; uninitialized slab /
                        // dwBytes=0 / >4KB / exhausted cases can still fall through to JS.
                        let stubAddress = stubDll.exportTable.get(funcKey);
                        // The kernel32/CRT heap-slab fast path is DEFAULT-ON. The slab control block
                        // lives in guest RAM so it is reachable from guest code; RMW atomicity vs
                        // thread switch is covered by the non-preemptible stub region.
                        // Set window.__noHeapSlab=true BEFORE loading a game to force it OFF (the JS
                        // process.memory + lookaside path). Global toggle, NOT a per-game branch.
                        const slabOn = !(globalThis as any).__noHeapSlab;
                        if (slabOn && dllName === 'kernel32' && this.heapInlineStubs) {
                            if (funcKey === 'heapalloc') stubAddress = this.heapInlineStubs.heapAllocStub;
                            else if (funcKey === 'heapfree') stubAddress = this.heapInlineStubs.heapFreeStub;
                        } else if (slabOn && this.crtInlineStubs && PELoader.CRT_SLAB_MODULES.has(dllName)) {
                            if (PELoader.CRT_MALLOC_KEYS.includes(funcKey)) stubAddress = this.crtInlineStubs.mallocStub;
                            else if (PELoader.CRT_FREE_KEYS.includes(funcKey)) stubAddress = this.crtInlineStubs.freeStub;
                        }
                        // Trap-free tolower/toupper (any CRT module exporting them).
                        if (this.caseFoldInlineStubs && PELoader.CRT_SLAB_MODULES.has(dllName)) {
                            if (funcKey === 'tolower') stubAddress = this.caseFoldInlineStubs.tolowerStub;
                            else if (funcKey === 'toupper') stubAddress = this.caseFoldInlineStubs.toupperStub;
                        }
                        if (stubAddress) {
                            this.view.setUint32(iatAddr, stubAddress, true);
                        } else {
                            Logger.warn(LogCategory.SYSTEM, `[PE] Failed to generate stub for ${dllName}:${func.name || `ord_${func.ordinal}`}`);
                        }
                    }
                    iatAddr += 4;
                }

                // Load stub code into memory (skip if all stubs were reused)
                if (stubDll.stubCode.length > 0) {
                    try {
                        const system = System.getInstance();
                        if (system.process?.memory) {
                            system.process.memory.allocAt(stubDll.baseAddress, stubDll.stubCode.length);
                        }
                    } catch (e) {
                        // If already reserved, that's fine
                    }
                    writeGuestCode(this.memory, stubDll.stubCode, stubDll.baseAddress);
                    Logger.log(LogCategory.SYSTEM, `[PE] Stub DLL for ${dllName} written at 0x${stubDll.baseAddress.toString(16)}, size: ${stubDll.stubCode.length}`);
                } else {
                    Logger.verbose(LogCategory.SYSTEM, `[PE] All stubs for ${dllName} reused from existing (no new code written)`);
                }
            }
            // PRIORITY 2: Real DLLs from VFS (game-specific DLLs)
            else if (this.vfs && this.moduleRegistry) {
                const isForceStub = PELoader.DLL_FORCE_STUB.has(dllName);

                if (isForceStub) {
                    Logger.warn(LogCategory.SYSTEM,
                        `🔌 [PE] FORCE STUB ${dllNameRaw} - NOT loading natively, creating safe stubs instead`);

                    // Note: Parse @N or MSVC mangled names to get correct stack cleanup!
                    const stubInfos = functions.map(f => {
                        const name = f.name || `ord_${f.ordinal}`;
                        // 1) Try @N suffix (stdcall decoration, e.g. "_BinkSetSoundSystem@8")
                        const atMatch = name.match(/@(\d+)$/);
                        if (atMatch) {
                            const stackCleanupBytes = parseInt(atMatch[1], 10);
                            return { name, argCount: stackCleanupBytes / 4, stackCleanupBytes, callingConvention: 'stdcall' };
                        }
                        // 2) Try MSVC C++ mangled name (thiscall methods like IFC20 exports)
                        const msvcCleanup = PELoader.parseMsvcStackCleanup(name);
                        if (msvcCleanup !== null) {
                            return { name, argCount: msvcCleanup / 4, stackCleanupBytes: msvcCleanup, callingConvention: 'stdcall' };
                        }
                        // 3) Unknown — default to 0 cleanup
                        return { name, argCount: 0, stackCleanupBytes: 0, callingConvention: 'stdcall' };
                    });

                    const stubDll = this.thunkGenerator.generateStubDll(dllName, stubInfos);

                    // Patch IAT with stub addresses
                    for (const func of functions) {
                        const stubAddress = stubDll.exportTable.get((func.name || `ord_${func.ordinal}`).toLowerCase());
                        if (stubAddress) {
                            this.view.setUint32(iatAddr, stubAddress, true);
                        }
                        iatAddr += 4;
                    }

                    // Write stub code
                    if (stubDll.stubCode.length > 0) {
                        writeGuestCode(this.memory, stubDll.stubCode, stubDll.baseAddress);
                    }

                    Logger.log(LogCategory.SYSTEM,
                        `🔌 [PE] Created ${functions.length} safe stubs for ${dllNameRaw} (native code blocked)`);

                    allDependencies.push({ dllName, dllNameRaw, functions, isThunked: false, isRealDll: false });
                    descriptorAddr += 20;
                    continue; // Skip normal DLL loading
                }

                Logger.warn(LogCategory.SYSTEM, `[PE] Loading real DLL from VFS: "${dllName}" (${functions.length} imports)`);
                const dllModule = await this.loadDll(dllName);

                if (dllModule) {
                    isRealDll = true;

                    // Partial HLE: this real DLL ships a broken CRT (Borland cw3220's stdio
                    // does no file I/O in HLE). Route those exports to VFS-backed thunks while
                    // keeping the rest of the DLL native. Stub addresses override the real
                    // export in the IAT below.
                    let overrideStubs: Map<string, number> | null = null;
                    if (PELoader.DLL_PARTIAL_HLE.has(dllName)) {
                        try {
                            const proc = System.getInstance().process;
                            if (proc) overrideStubs = installCw3220Stdio(proc);
                        } catch (e) {
                            Logger.warn(LogCategory.SYSTEM, `[PE] partial-HLE install failed for ${dllName}: ${e}`);
                        }
                    }

                    // Patch IAT with real export addresses
                    for (const func of functions) {
                        const funcName = func.name?.toLowerCase() || `ord_${func.ordinal}`;
                        if (overrideStubs) {
                            const stubAddr = overrideStubs.get(funcName);
                            if (stubAddr !== undefined) {
                                this.view.setUint32(iatAddr, stubAddr, true);
                                Logger.verbose(LogCategory.SYSTEM,
                                    `[PE] partial-HLE: ${dllName}:${funcName} -> stub 0x${stubAddr.toString(16)}`);
                                iatAddr += 4;
                                continue;
                            }
                        }
                        let exportAddr: number | undefined;

                        if (func.name) {
                            exportAddr = dllModule.exports.get(func.name.toLowerCase());
                        }
                        if (exportAddr === undefined && func.ordinal !== undefined) {
                            exportAddr = dllModule.ordinalExports.get(func.ordinal);
                        }

                        if (exportAddr !== undefined) {
                            this.view.setUint32(iatAddr, exportAddr, true);
                            Logger.verbose(LogCategory.SYSTEM,
                                `[PE] IAT patched: ${dllName}:${funcName} -> 0x${exportAddr.toString(16)}`);
                        } else {
                            Logger.warn(LogCategory.SYSTEM,
                                `[PE] Export not found in real DLL: ${dllName}:${funcName}`);
                            // Use trap stub for missing exports
                            this.thunkGenerator.writeTrapStub(this.memory);
                            this.view.setUint32(iatAddr, this.thunkGenerator.getTrapStubAddress(), true);
                        }
                        iatAddr += 4;
                    }

                    Logger.log(LogCategory.SYSTEM,
                        `[PE] Patched IAT for real DLL "${dllName}" with ${functions.length} imports`);
                } else {
                    // DLL not found in VFS - fall through to stub generation
                    Logger.warn(LogCategory.SYSTEM, `[PE] DLL "${dllName}" not found in VFS, generating stubs`);
                    this.generateStubsForUnknownDll(dllName, functions, iatAddr);
                }
            }
            // PRIORITY 3: Unknown DLL - generate stubs with warnings
            else {
                this.generateStubsForUnknownDll(dllName, functions, iatAddr);
            }

            allDependencies.push({ dllName, dllNameRaw, functions, isThunked, isRealDll });
            descriptorAddr += 20;
        }

        // Summary: List all dependencies and highlight non-thunked ones
        Logger.log(LogCategory.SYSTEM, `[PE] ===== DEPENDENCY SUMMARY =====`);
        Logger.log(LogCategory.SYSTEM, `[PE] Total DLLs: ${allDependencies.length}`);

        const thunkedDlls = allDependencies.filter(d => d.isThunked);
        const realDlls = allDependencies.filter(d => d.isRealDll);
        const nonThunkedDlls = allDependencies.filter(d => !d.isThunked && !d.isRealDll);

        Logger.log(LogCategory.SYSTEM, `[PE] Thunked DLLs: ${thunkedDlls.length} (${thunkedDlls.map(d => d.dllNameRaw).join(", ")})`);

        if (realDlls.length > 0) {
            Logger.log(LogCategory.SYSTEM, `[PE] Real DLLs from VFS: ${realDlls.length} (${realDlls.map(d => d.dllNameRaw).join(", ")})`);
        }

        if (nonThunkedDlls.length > 0) {
            Logger.warn(LogCategory.SYSTEM, `[PE] NON-THUNKED DLLs (${nonThunkedDlls.length}): ${nonThunkedDlls.map(d => d.dllNameRaw).join(", ")}`);
            Logger.warn(LogCategory.SYSTEM, `[PE] These DLLs are NOT intercepted - calls go directly to stubs!`);

            for (const dep of nonThunkedDlls) {
                const criticalFunctions = dep.functions.filter(f => {
                    const name = f.name?.toLowerCase() || '';
                    return name.includes('mem') || name.includes('copy') || name.includes('move') ||
                        name.includes('str') || name.includes('alloc') || name.includes('free');
                });
                if (criticalFunctions.length > 0) {
                    const funcNames = criticalFunctions.map(f => f.name || `ord_${f.ordinal}`).join(", ");
                    Logger.warn(LogCategory.SYSTEM, `[PE]   ${dep.dllNameRaw} critical functions: ${funcNames}`);
                }
            }
        }

        Logger.log(LogCategory.SYSTEM, `[PE] =================================`);

        // Apply any pending registrations now that stubs are created
        const system = System.getInstance();
        if (system.process?.dispatcher) {
            system.process.dispatcher.applyPendingRegistrations();
        }
    }

    /**
     * Generate stub entries for an unknown DLL that couldn't be loaded
     */
    private generateStubsForUnknownDll(
        dllName: string,
        functions: Array<{ name?: string; ordinal?: number }>,
        iatAddr: number
    ): void {
        // Generate stubs with arg counts and calling conventions (if known)
        const stubInfos = functions.map(f => {
            const name = f.name || `ord_${f.ordinal}`;
            let argCount: number | undefined;
            let callingConvention: string | undefined;

            let stackCleanupBytes: number | undefined;

            if (f.name) {
                argCount = this.apiRegistry.getArgCount(dllName, f.name);
                stackCleanupBytes = this.apiRegistry.getStackCleanupBytes(dllName, f.name);
                callingConvention = this.apiRegistry.getCallingConvention(dllName, f.name);
                if (argCount === undefined) {
                    const msvcCleanup = PELoader.parseMsvcStackCleanup(name);
                    if (msvcCleanup !== null) {
                        stackCleanupBytes = msvcCleanup;
                        argCount = msvcCleanup / 4;
                        callingConvention = callingConvention ?? 'stdcall';
                    }
                }
            } else if (f.ordinal !== undefined) {
                argCount = this.apiRegistry.getArgCountByOrdinal(dllName, f.ordinal);
            }

            if (argCount === undefined) {
                Logger.warn(LogCategory.SYSTEM, `[PE] Unknown arg count for ${dllName}:${name}`);
                loadDiagnostics.noteUnknownArgCount(dllName, name);
            }

            return { name, argCount, stackCleanupBytes, callingConvention };
        });

        const stubDll = this.thunkGenerator.generateStubDll(dllName, stubInfos);

        // Patch IAT
        let addr = iatAddr;
        for (const func of functions) {
            const stubAddress = stubDll.exportTable.get((func.name || `ord_${func.ordinal}`).toLowerCase());
            if (stubAddress) {
                this.view.setUint32(addr, stubAddress, true);
            } else {
                Logger.warn(LogCategory.SYSTEM, `[PE] Failed to generate stub for ${dllName}:${func.name || `ord_${func.ordinal}`}`);
            }
            addr += 4;
        }

        // Load stub code into memory
        try {
            const system = System.getInstance();
            if (system.process?.memory) {
                system.process.memory.allocAt(stubDll.baseAddress, stubDll.stubCode.length);
            }
        } catch (e) {
            // If already reserved, that's fine
        }
        writeGuestCode(this.memory, stubDll.stubCode, stubDll.baseAddress);

        Logger.log(LogCategory.SYSTEM, `[PE] Stub DLL for ${dllName} written at 0x${stubDll.baseAddress.toString(16)}, size: ${stubDll.stubCode.length}`);
    }

    /**
     * Walk an ILT/IAT. Bounded, and each entry is validated as an RVA before it is
     * dereferenced: a PREBOUND table holds resolved ADDRESSES, not name RVAs, so
     * `base + entry + 2` would point outside the image entirely. An entry that cannot be
     * a name RVA is recorded as unnamed rather than used to index memory.
     */
    private parseImportTable(baseAddress: number, tableRVA: number): Array<{ name?: string, ordinal?: number }> {
        const functions: Array<{ name?: string, ordinal?: number }> = [];
        let addr = baseAddress + tableRVA;
        // No real module imports more than this from one DLL; a runaway loop here means the
        // table is not a table.
        const MAX_IMPORTS = 65536;

        for (let i = 0; i < MAX_IMPORTS; i++) {
            if (addr < 0 || addr + 4 > this.memory.length) break;
            const entry = this.view.getUint32(addr, true);
            if (entry === 0) break;

            if (entry & 0x80000000) {
                functions.push({ ordinal: entry & 0xFFFF });
            } else {
                const nameAddr = baseAddress + entry + 2; // skip the 2-byte hint
                if (nameAddr >= 0 && nameAddr < this.memory.length) {
                    functions.push({ name: this.readString(nameAddr, 0x200) });
                } else {
                    // Prebound / corrupt entry — no usable name. Recorded so the import
                    // count still matches the IAT slot count the caller patches.
                    functions.push({});
                }
            }
            addr += 4;
        }
        return functions;
    }

    /**
     * Read a NUL-terminated ASCII name out of the mapped image.
     *
     * Bounded on purpose. PE import/export names are <= 0xFF bytes by spec, but the
     * addresses we feed here are derived from IAT/ILT entries, and those are not always
     * name RVAs: a PREBOUND or packed import table stores resolved addresses instead, so
     * `base + entry + 2` lands at an arbitrary offset. Unbounded, the walk then scans
     * until it happens to find a zero byte — megabytes of garbage concatenated into a
     * string, or an out-of-range index on a Uint8Array (undefined !== 0, so the loop never
     * terminates). Stop at the cap or at the end of the image view instead.
     */
    private readString(addr: number, maxLen = 512): string {
        let str = '';
        const limit = Math.min(addr + maxLen, this.memory.length);
        for (let i = addr; i < limit; i++) {
            const b = this.memory[i];
            if (b === 0 || b === undefined) return str;
            str += String.fromCharCode(b);
        }
        return str;
    }

    /**
     * Get module registry (for kernel32 module functions)
     */
    getModuleRegistry(): ModuleRegistry | null {
        return this.moduleRegistry;
    }

    /**
     * Map an absolute address to a PE section and offset info.
     * Used for diagnostics to understand what "0x1302d4b8" actually is.
     */
    public describeAddr(
        moduleBase: number,
        addr: number,
        sections?: import('./module-registry').PESection[]
    ): { section: string, rva: number, inRaw: boolean, inBss: boolean, offset: number } | null {
        if (!sections) return null;

        const rva = (addr - moduleBase) >>> 0;

        for (const sec of sections) {
            // Check if RVA is within section virtual bounds
            if (rva >= sec.virtualAddress && rva < sec.virtualAddress + sec.virtualSize) {
                const offset = rva - sec.virtualAddress;
                const inRaw = offset < sec.rawSize;
                const inBss = !inRaw; // If in virtual range but past raw size, it's BSS (zero-init)
                return { section: sec.name, rva, inRaw, inBss, offset };
            }
        }

        // Check if in headers
        if (rva < 0x1000) { // Assuming first section usually starts at 0x1000
            return { section: 'HEADERS', rva, inRaw: true, inBss: false, offset: rva };
        }

        return null;
    }

}
