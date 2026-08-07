// module-registry.ts
// Tracks loaded PE modules (EXE + DLLs) with their exports for GetProcAddress, GetModuleHandle, etc.

import { Logger, LogCategory } from './logger';
import { MEM_ROM_BASE, MEM_ROM_SIZE } from './cpu/emulator-config';

/**
 * Information about a loaded PE module (EXE or DLL)
 */
export interface LoadedPEModule {
    /** Module name without extension (e.g., "smackw32") */
    name: string;
    /** Full path to the module (e.g., "C:\\smackw32.dll") */
    path: string;
    /** Base address where the module is loaded */
    baseAddress: number;
    /** Size of the module in memory */
    size: number;
    /** On-disk PE file size (optional; used for Galaxy version profiles). */
    fileSize?: number;
    /** Entry point RVA (DllMain for DLLs, 0 if none) */
    entryPoint: number;
    /** Export table: function name -> absolute address */
    exports: Map<string, number>;
    /** Export table by ordinal: ordinal -> absolute address */
    ordinalExports: Map<number, number>;
    /** Whether this is a real DLL loaded from VFS (vs stub/thunked) */
    isRealDll: boolean;
    /** True for the main process executable (the .exe). A LoadLibrary("x.dll") request
     *  must never resolve to the EXE even when they share a basename (e.g. hl.exe vs
     *  the hl.dll game DLL) — see getByName. */
    isExecutable?: boolean;
    /** Whether DllMain has been called with DLL_PROCESS_ATTACH */
    /** Whether DllMain has been called with DLL_PROCESS_ATTACH */
    initialized: boolean;
    /** PE Sections (for debugging/diagnostics) */
    sections?: PESection[];
}

export interface PESection {
    name: string;
    virtualAddress: number;
    virtualSize: number;
    rawSize: number;
    characteristics: number;
}

/**
 * DLL images are rebased into the ROM bucket the layout reserves for PE images
 * (emulator-config.ts). They must NOT share VA with HEAP: the kernel32 slab arena
 * carves top-down from HEAP's limit and ZEROES what it takes, so an image mapped
 * inside HEAP is wiped the moment heap growth reaches it — its vtables read back as
 * 0 and the next virtual call jumps to NULL, hundreds of frames after the write.
 * ROM sits above the red zone and no allocator carves from it, so the two frontiers
 * can never meet.
 */
const DLL_BASE_START = MEM_ROM_BASE;
const DLL_BASE_LIMIT = MEM_ROM_BASE + MEM_ROM_SIZE;
const DLL_BASE_ALIGNMENT = 0x10000; // 64KB alignment (Windows standard)

/**
 * ModuleRegistry
 *
 * Tracks all loaded PE modules for the emulated process.
 * Used by:
 * - GetModuleHandle to find module base addresses
 * - GetProcAddress to lookup exports
 * - LoadLibrary to check if DLL is already loaded
 */
export class ModuleRegistry {
    private modules = new Map<string, LoadedPEModule>();
    private byBase = new Map<number, LoadedPEModule>();
    private nextDllBase = DLL_BASE_START;
    /** VA returned by unregister(), first-fit reusable. See allocateBase. */
    private freeDllRanges: Array<{ base: number; size: number }> = [];

    private normalizeModuleLookupKey(name: string): string {
        return name.toLowerCase().replace(/\.(dll|exe)$/i, '');
    }

    /**
     * Register a loaded module
     */
    register(mod: LoadedPEModule): void {
        const nameLower = this.normalizeModuleLookupKey(mod.name);

        // Check for duplicate registration
        if (this.modules.has(nameLower)) {
            Logger.warn(LogCategory.SYSTEM,
                `[ModuleRegistry] Module "${mod.name}" already registered, replacing`);
        }

        this.modules.set(nameLower, mod);
        this.byBase.set(mod.baseAddress, mod);

        Logger.log(LogCategory.SYSTEM,
            `[ModuleRegistry] Registered "${mod.name}" at 0x${mod.baseAddress.toString(16)}, ` +
            `size=0x${mod.size.toString(16)}, exports=${mod.exports.size}, isReal=${mod.isRealDll}`);
    }

    /**
     * Unregister a module (for FreeLibrary)
     */
    unregister(name: string): boolean {
        const nameLower = this.normalizeModuleLookupKey(name);
        const mod = this.modules.get(nameLower);
        if (!mod) return false;

        this.modules.delete(nameLower);
        this.byBase.delete(mod.baseAddress);
        this.releaseBase(mod.baseAddress, mod.size);
        return true;
    }

    /**
     * Get module by name (case-insensitive, handles .dll extension)
     */
    getByName(name: string): LoadedPEModule | undefined {
        const nameLower = name.toLowerCase();
        // A ".dll" request must not resolve to the main EXE. The EXE is keyed by its
        // bare basename (e.g. "hl" from hl.exe), which collides with a game DLL of the
        // same basename ("hl.dll" → "hl"). Without this guard, LoadLibrary("…\hl.dll")
        // returned the exe at 0x400000 and GetProcAddress("GiveFnptrsToDll") failed.
        const wantsDll = /\.dll$/i.test(nameLower);
        const acceptable = (m: LoadedPEModule | undefined): LoadedPEModule | undefined =>
            (m && !(wantsDll && m.isExecutable)) ? m : undefined;

        const existing = acceptable(this.modules.get(this.normalizeModuleLookupKey(nameLower)));
        if (existing) return existing;

        // Also try basename only — DLLs loaded via import table are registered
        // by short name ("engine"), but LoadLibraryA passes full path ("c:\system\engine")
        const lastSlash = Math.max(nameLower.lastIndexOf('/'), nameLower.lastIndexOf('\\'));
        if (lastSlash >= 0) {
            const basename = this.normalizeModuleLookupKey(nameLower.substring(lastSlash + 1));
            return acceptable(this.modules.get(basename));
        }
        return undefined;
    }

    /**
     * Get module by base address
     */
    getByBase(addr: number): LoadedPEModule | undefined {
        return this.byBase.get(addr);
    }

    /** Main process executable registered at PE load (isExecutable=true). */
    getExecutableModule(): LoadedPEModule | undefined {
        for (const mod of this.modules.values()) {
            if (mod.isExecutable) return mod;
        }
        return undefined;
    }

    /** Win32 HMODULE for the main EXE — actual ImageBase (UE1 games often use 0x10900000). */
    getMainExecutableBase(): number {
        return this.getExecutableModule()?.baseAddress ?? 0x00400000;
    }

    /**
     * Map NULL or legacy 0x400000 handles to the loaded EXE base for PE resource/export walks.
     * Real Windows HMODULE equals ImageBase; many of our paths still pass the 0x400000 placeholder.
     */
    resolvePeModuleBase(hModule: number): number {
        const h = hModule >>> 0;
        if (h === 0 || h === 0x00400000) {
            return this.getMainExecutableBase();
        }
        if (this.byBase.has(h)) return h;
        return h;
    }

    /**
     * Get module containing a given address (for GetModuleHandleEx with FROM_ADDRESS)
     */
    getModuleContainingAddress(addr: number): LoadedPEModule | undefined {
        for (const mod of this.modules.values()) {
            if (addr >= mod.baseAddress && addr < mod.baseAddress + mod.size) {
                return mod;
            }
        }
        return undefined;
    }

    /** True when addr lies in a PE section marked IMAGE_SCN_MEM_WRITE (e.g. .data), not .text. */
    isAddressInModuleWritableSection(addr: number): boolean {
        const mod = this.getModuleContainingAddress(addr);
        if (!mod?.sections?.length) return false;
        const rva = addr - mod.baseAddress;
        const IMAGE_SCN_MEM_WRITE = 0x80000000;
        for (const sec of mod.sections) {
            const end = sec.virtualAddress + Math.max(sec.virtualSize, sec.rawSize);
            if (rva >= sec.virtualAddress && rva < end) {
                return (sec.characteristics & IMAGE_SCN_MEM_WRITE) !== 0;
            }
        }
        return false;
    }

    /** Safe to store a COM pointer at addr via HLE QueryInterface output. */
    isSafeQueryInterfaceOutput(addr: number): boolean {
        const mod = this.getModuleContainingAddress(addr);
        if (!mod) return true;
        return this.isAddressInModuleWritableSection(addr);
    }

    /**
     * Resolve segment offset to linear address (for #GP recovery when EIP is offset in stack range).
     * Prefers a module where offset < mod.size; if none, falls back to preferBase or first module (EXE).
     */
    resolveOffsetToLinear(offset: number, preferBase?: number): { mod: LoadedPEModule; linear: number } | undefined {
        if (preferBase !== undefined) {
            const mod = this.byBase.get(preferBase);
            if (mod) {
                return { mod, linear: (mod.baseAddress + offset) >>> 0 };
            }
        }
        for (const mod of this.modules.values()) {
            if (offset < mod.size) {
                return { mod, linear: (mod.baseAddress + offset) >>> 0 };
            }
        }
        const fallback = this.modules.values().next().value as LoadedPEModule | undefined;
        if (fallback) {
            return { mod: fallback, linear: (fallback.baseAddress + offset) >>> 0 };
        }
        return undefined;
    }

    /**
     * Allocate base address for a new DLL
     * Returns aligned address and updates internal pointer
     */
    allocateBase(imageSize: number): number {
        // Align image size to 64KB boundary
        const alignedSize = (imageSize + DLL_BASE_ALIGNMENT - 1) & ~(DLL_BASE_ALIGNMENT - 1);

        // Reuse VA an unloaded module gave back before taking new ground: the bucket is
        // bounded now, and a title that cycles LoadLibrary/FreeLibrary on the same DLL —
        // a real pattern this runtime supports — would otherwise exhaust it in ~100 cycles
        // and then fail every later load.
        for (let i = 0; i < this.freeDllRanges.length; i++) {
            const r = this.freeDllRanges[i];
            if (r.size < alignedSize) continue;
            const reused = r.base;
            if (r.size === alignedSize) this.freeDllRanges.splice(i, 1);
            else { r.base += alignedSize; r.size -= alignedSize; }
            Logger.log(LogCategory.SYSTEM,
                `[ModuleRegistry] Reused base 0x${reused.toString(16)} for DLL (size=0x${imageSize.toString(16)})`);
            return reused;
        }

        const base = this.nextDllBase;
        // Running past the bucket would hand out SURFACE VA and corrupt texture pixels
        // instead of failing — a LoadLibrary failure is the honest outcome.
        if (base + alignedSize > DLL_BASE_LIMIT) {
            throw new Error(
                `ModuleRegistry: module VA exhausted (need 0x${alignedSize.toString(16)} at ` +
                `0x${base.toString(16)}, limit 0x${DLL_BASE_LIMIT.toString(16)})`);
        }
        this.nextDllBase += alignedSize;

        Logger.log(LogCategory.SYSTEM,
            `[ModuleRegistry] Allocated base 0x${base.toString(16)} for DLL (size=0x${imageSize.toString(16)})`);

        return base;
    }

    /**
     * Give a module's VA back to the pool, coalescing with neighbours so a load/unload cycle
     * cannot fragment the bucket into unusable slivers. Rewinding the bump pointer when the
     * range is the topmost allocation keeps the common case (one DLL loaded and unloaded
     * repeatedly) exactly as cheap as it was before the bucket had a limit.
     */
    private releaseBase(base: number, size: number): void {
        const aligned = (size + DLL_BASE_ALIGNMENT - 1) & ~(DLL_BASE_ALIGNMENT - 1);
        if (aligned <= 0 || base < DLL_BASE_START || base + aligned > DLL_BASE_LIMIT) return;
        if (base + aligned === this.nextDllBase) {
            this.nextDllBase = base;
            // Absorb any free range that now sits at the top.
            let merged = true;
            while (merged) {
                merged = false;
                for (let i = 0; i < this.freeDllRanges.length; i++) {
                    const r = this.freeDllRanges[i];
                    if (r.base + r.size === this.nextDllBase) {
                        this.nextDllBase = r.base;
                        this.freeDllRanges.splice(i, 1);
                        merged = true;
                        break;
                    }
                }
            }
            return;
        }
        this.freeDllRanges.push({ base, size: aligned });
        this.freeDllRanges.sort((a, b) => a.base - b.base);
        for (let i = this.freeDllRanges.length - 1; i > 0; i--) {
            const prev = this.freeDllRanges[i - 1];
            if (prev.base + prev.size === this.freeDllRanges[i].base) {
                prev.size += this.freeDllRanges[i].size;
                this.freeDllRanges.splice(i, 1);
            }
        }
    }

    /**
     * Get export address from a module
     * Searches by name first, then by ordinal if name is "ord_N"
     */
    getExportAddress(moduleName: string, exportName: string): number | undefined {
        const mod = this.getByName(moduleName);
        if (!mod) return undefined;

        // Try by name (case-insensitive)
        const nameLower = exportName.toLowerCase();
        const addr = mod.exports.get(nameLower);
        if (addr !== undefined) return addr;

        // Try ordinal format "ord_123"
        const ordMatch = nameLower.match(/^ord_(\d+)$/);
        if (ordMatch) {
            const ordinal = parseInt(ordMatch[1], 10);
            return mod.ordinalExports.get(ordinal);
        }

        return undefined;
    }

    /**
     * Get all registered modules (for debugging)
     */
    getAllModules(): LoadedPEModule[] {
        return Array.from(this.modules.values());
    }

    /**
     * Check if a module is loaded
     */
    isLoaded(name: string): boolean {
        return this.getByName(name) !== undefined;
    }

    /**
     * Reset the registry (for process reset)
     */
    reset(): void {
        this.modules.clear();
        this.byBase.clear();
        this.nextDllBase = DLL_BASE_START;
        this.freeDllRanges = [];
        Logger.log(LogCategory.SYSTEM, '[ModuleRegistry] Reset');
    }

    /**
     * Resolve an address to a human-readable string: "module.dll+0xRVA (nearest export)"
     * Returns null if address doesn't fall in any loaded module.
     */
    resolveAddress(addr: number): string | null {
        const mod = this.getModuleContainingAddress(addr);
        if (!mod) return null;

        const rva = addr - mod.baseAddress;
        let label = `${mod.name}.dll+0x${rva.toString(16)}`;

        // Find nearest export at or before this address
        let bestName: string | null = null;
        let bestDist = 0x7FFFFFFF;
        for (const [name, exportAddr] of mod.exports) {
            const dist = addr - exportAddr;
            if (dist >= 0 && dist < bestDist) {
                bestDist = dist;
                bestName = name;
            }
        }

        if (bestName) {
            label += bestDist === 0
                ? ` [${bestName}]`
                : ` [${bestName}+0x${bestDist.toString(16)}]`;
        }

        return label;
    }
}
