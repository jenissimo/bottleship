import { ModuleDescriptor, UnimplementedReturn, calculateStackCleanup } from "../api/types";
import { setupapiModule } from "../api/setupapi.api";
import { hidModule } from "../api/hid.api";
import { lgvidModule } from "../api/lgvid.api";
import { oledlgModule } from "../api/oledlg.api";
import { msiModule } from "../api/msi.api";
import { kernel32VistaSupplement } from "../api/kernel32-vista-supplement";
import { REFERENCE_ARG_COUNTS } from "../reference-argcounts.generated";
import { Logger, LogCategory } from "./logger";

/**
 * APIRegistry
 * 
 * Central registry for all WinAPI descriptors.
 * Provides argument counts and metadata for thunk generation and PE loading.
 */
/** Base name (no @N) -> list of full cache keys. Used to avoid collapsing _AIL_pause_stream@4 and @8. */
function baseNameKey(dll: string, fullName: string): string {
    const base = fullName.toLowerCase().replace(/@\d+$/, "");
    return `${dll}:${base}`;
}

export class APIRegistry {
    private static instance: APIRegistry;
    private modules: Map<string, ModuleDescriptor> = new Map();
    private argCountCache: Map<string, number> = new Map();
    private stackCleanupCache: Map<string, number> = new Map();
    private callingConventionCache: Map<string, string> = new Map();
    /** baseName (dll:name without @N) -> full cache keys. For single-variant fallback and duplicate diagnostic. */
    private baseNameToKeys: Map<string, string[]> = new Map();
    /** dll:func -> declared failure class, for exports that have no handler. */
    private unimplementedReturnCache: Map<string, UnimplementedReturn> = new Map();

    private constructor() {
        this.loadFromApiFiles();
        this.seedReferenceArgCounts();
        this.logDuplicateBaseNames();
    }

    /**
     * Seed argCount/stackCleanup from the curated win32 reference (reference-argcounts.generated.ts,
     * built from tools/reference/win32/<mod>/*.sig.json). These are the fallback for stdcall PE imports
     * from DLLs we don't thunk (e.g. rpcrt4:UuidCreate) so the ThunkGenerator can emit a correct RET N
     * instead of failing PE load. Real API descriptors registered above win — only fill gaps here.
     */
    private seedReferenceArgCounts(): void {
        let added = 0;
        for (const dll in REFERENCE_ARG_COUNTS) {
            const funcs = REFERENCE_ARG_COUNTS[dll];
            for (const func in funcs) {
                const key = `${dll}:${func}`;
                if (this.argCountCache.has(key)) continue; // don't override real descriptors
                const argCount = funcs[func];
                this.argCountCache.set(key, argCount);
                this.stackCleanupCache.set(key, argCount * 4);
                this.callingConventionCache.set(key, "stdcall");
                const bkey = `${dll}:${func}`; // reference names are already undecorated (no @N)
                const list = this.baseNameToKeys.get(bkey);
                if (list) { if (!list.includes(key)) list.push(key); }
                else this.baseNameToKeys.set(bkey, [key]);
                added++;
            }
        }
        Logger.log(LogCategory.SYSTEM, `APIRegistry: seeded ${added} reference argCounts (${Object.keys(REFERENCE_ARG_COUNTS).length} modules)`);
    }

    public static getInstance(): APIRegistry {
        if (!APIRegistry.instance) {
            APIRegistry.instance = new APIRegistry();
        }
        return APIRegistry.instance;
    }

    /**
     * Synchronously loads all *.api.ts files from the ../api directory
     * uses Vite's eager glob import.
     */
    private loadFromApiFiles(): void {
        // Static imports for modules added after the last Vite glob scan (import.meta.glob
        // is fixed at compile time — new *.api.ts files are invisible until rebuild).
        this.registerModule(setupapiModule);
        this.registerModule(hidModule);
        this.registerModule(lgvidModule);
        this.registerModule(oledlgModule);
        this.registerModule(msiModule);

        try {
            const apiModules = import.meta.glob('../api/*.api.ts', { eager: true });
            
            for (const path in apiModules) {
                const moduleContent = apiModules[path] as any;
                // Find any export that looks like a ModuleDescriptor (has name and functions)
                for (const key in moduleContent) {
                    const obj = moduleContent[key];
                    if (obj && typeof obj === 'object' && 'name' in obj && 'functions' in obj) {
                        const descriptor = obj as ModuleDescriptor;
                        this.registerModule(descriptor);
                    }
                }
            }
            
            Logger.log(LogCategory.SYSTEM, `APIRegistry: Loaded ${this.modules.size} API modules`);
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `APIRegistry: Failed to load API modules: ${e}`);
        }

        // After glob: merge GetProcAddress-only exports (static import survives stale Vite glob).
        this.mergeModuleFunctions(kernel32VistaSupplement);
    }

    /** Add exports to an existing module descriptor (deduped by function name). */
    public mergeModuleFunctions(descriptor: ModuleDescriptor): void {
        const moduleName = descriptor.name.toLowerCase();
        let target = this.modules.get(moduleName);
        if (!target) {
            this.registerModule(descriptor);
            return;
        }
        const existing = new Set(target.functions.map((f) => f.name.toLowerCase()));
        for (const func of descriptor.functions) {
            if (existing.has(func.name.toLowerCase())) continue;
            target.functions.push(func);
            existing.add(func.name.toLowerCase());
            this.cacheFunction(moduleName, func);
        }
    }

    private cacheFunction(moduleName: string, func: ModuleDescriptor["functions"][number]): void {
        const key = `${moduleName}:${func.name.toLowerCase()}`;
        if (func.onUnimplemented) this.unimplementedReturnCache.set(key, func.onUnimplemented);
        const stackBytes = func.stackCleanupBytes ?? calculateStackCleanup(func.params);
        const dwordSlots = stackBytes >> 2;
        this.argCountCache.set(key, dwordSlots);
        this.stackCleanupCache.set(key, stackBytes);
        this.callingConventionCache.set(key, func.callingConvention);
        const bkey = baseNameKey(moduleName, func.name);
        const list = this.baseNameToKeys.get(bkey) ?? [];
        list.push(key);
        this.baseNameToKeys.set(bkey, list);
    }

    public registerModule(descriptor: ModuleDescriptor): void {
        const moduleName = descriptor.name.toLowerCase();
        this.modules.set(moduleName, descriptor);
        
        // Pre-cache argument counts, stack cleanup bytes, and calling conventions for fast lookup
        for (const func of descriptor.functions) {
            this.cacheFunction(moduleName, func);
        }

        // Also cache interface methods
        if (descriptor.interfaces) {
            for (const iface of descriptor.interfaces) {
                for (const method of iface.methods) {
                    const key = `${moduleName}:${iface.name.toLowerCase()}_${method.name.toLowerCase()}`;
                    const methStackBytes = calculateStackCleanup(method.params);
                    this.argCountCache.set(key, methStackBytes >> 2);
                    this.callingConventionCache.set(key, method.callingConvention);
                    // A vtable slot returns an HRESULT unless the descriptor says otherwise.
                    this.unimplementedReturnCache.set(key, method.onUnimplemented ?? "hresult");
                }
            }
        }
    }

    /**
     * Returns argument count for a function in a specific DLL
     */
    public getArgCount(dllName: string, functionName: string): number | undefined {
        const dll = dllName.toLowerCase().replace(/\.dll$/, "");
        const func = functionName.toLowerCase();
        
        // 1. Exact match
        let count = this.argCountCache.get(`${dll}:${func}`);
        if (count !== undefined) return count;

        // 2. Try without A/W suffix if it fails
        const baseName = functionName.replace(/[WA]$/, "").toLowerCase();
        count = this.argCountCache.get(`${dll}:${baseName}`);
        if (count !== undefined) return count;

        // 2.5. If name has NO @N, try single-variant fallback: only resolve when exactly one export has this base name (avoids collapsing _AIL_pause_stream@4 and @8)
        if (!/@\d+$/i.test(functionName)) {
            const bkey = `${dll}:${func}`;
            const variants = this.baseNameToKeys.get(bkey);
            if (variants?.length === 1) {
                count = this.argCountCache.get(variants[0]);
                if (count !== undefined) return count;
            }
            if (variants && variants.length > 1) {
                Logger.warn(LogCategory.SYSTEM,
                    `APIRegistry: ambiguous base name "${functionName}" in ${dll} (${variants.length} variants: ${variants.map(k => k.split(":")[1]).join(", ")}). Use full decorated name in IAT.`);
            }
        }

        // 2.6. Try with _ prefix (MSS v5+ exports undecorated names, our descriptors use _AIL_ decoration)
        if (!/@\d+$/i.test(functionName)) {
            const bkeyPrefixed = `${dll}:_${func}`;
            const variants = this.baseNameToKeys.get(bkeyPrefixed);
            if (variants?.length === 1) {
                count = this.argCountCache.get(variants[0]);
                if (count !== undefined) return count;
            }
        }

        // 3. Fallback: Check if function exists in any module (sometimes DLL name is not precise)
        // This is less efficient but helpful for some cases
        for (const [modName, mod] of this.modules) {
            const modKey = `${modName}:${func}`;
            const c = this.argCountCache.get(modKey);
            if (c !== undefined) return c;
        }

        // 4. Parse @NN from decorated name (stdcall: Name@N, N = bytes to pop = args*4)
        const match = functionName.match(/@(\d+)$/i);
        if (match) {
            const bytes = parseInt(match[1], 10);
            if (bytes >= 0 && bytes % 4 === 0) return bytes / 4;
        }

        return undefined;
    }

    /**
     * Re-point one export's RET N at what the DLL the BUNDLE SHIPS actually pops.
     *
     * A static descriptor cannot decide an ABI that differs per shipped build — Bink's
     * `_BinkSetVolume@8` pops 8 up to SDK 1.0 and 12 from 1.5, under the one name — so
     * the owning module reads the real DLL and reports it here. Must land BEFORE any
     * stub for that export is generated: the RET N is emitted into guest code, so a
     * later correction cannot reach a stub the guest already holds.
     *
     * Argument count moves with it. `cacheFunction` derives BOTH from one number
     * (`dwordSlots = stackBytes >> 2`), so they are one fact in two spellings — and the
     * readers that consume them together would otherwise disagree with themselves:
     * `exception-context-dumper` computes `stackCleanupBytes ?? argCount * 4` to decide
     * whether a stub's RET N is wrong, and would call the corrected stub the broken one.
     */
    public overrideStackCleanupBytes(dllName: string, functionName: string, stackBytes: number): void {
        const dll = dllName.toLowerCase().replace(/\.dll$/, "");
        const key = `${dll}:${functionName.toLowerCase()}`;
        this.stackCleanupCache.set(key, stackBytes);
        this.argCountCache.set(key, stackBytes >> 2);
    }

    /**
     * Returns stack cleanup bytes (for RET N) for a function. Use this for stub generation and ESP checks.
     * Default: argCount * 4. Override with stackCleanupBytes when decoration is wrong (e.g. _AIL_file_read@8).
     */
    public getStackCleanupBytes(dllName: string, functionName: string): number | undefined {
        const dll = dllName.toLowerCase().replace(/\.dll$/, "");
        const func = functionName.toLowerCase();
        let bytes = this.stackCleanupCache.get(`${dll}:${func}`);
        if (bytes !== undefined) return bytes;
        const baseName = functionName.replace(/[WA]$/, "").toLowerCase();
        bytes = this.stackCleanupCache.get(`${dll}:${baseName}`);
        if (bytes !== undefined) return bytes;
        if (!/@\d+$/i.test(functionName)) {
            const bkey = `${dll}:${func}`;
            const variants = this.baseNameToKeys.get(bkey);
            if (variants?.length === 1) return this.stackCleanupCache.get(variants[0]);
            // 2.6. Try with _ prefix (MSS v5+ undecorated names)
            const bkeyPrefixed = `${dll}:_${func}`;
            const variantsPrefixed = this.baseNameToKeys.get(bkeyPrefixed);
            if (variantsPrefixed?.length === 1) {
                const result = this.stackCleanupCache.get(variantsPrefixed[0]);
                if (result !== undefined) return result;
            }
        }
        for (const [modName] of this.modules) {
            const c = this.stackCleanupCache.get(`${modName}:${func}`);
            if (c !== undefined) return c;
        }
        const match = functionName.match(/@(\d+)$/i);
        if (match) {
            const b = parseInt(match[1], 10);
            if (b >= 0 && b % 4 === 0) return b;
        }
        return undefined;
    }

    /** Log any base name (no @N) that has more than one export – use full decorated name in IAT. */
    private logDuplicateBaseNames(): void {
        for (const [bkey, keys] of this.baseNameToKeys) {
            if (keys.length > 1) {
                const names = keys.map(k => k.split(":")[1]);
                Logger.log(LogCategory.SYSTEM,
                    `[APIRegistry] Duplicate base name (use full @N in IAT): ${bkey} -> [${names.join(", ")}]`);
            }
        }
    }

    /**
     * Returns calling convention for a function in a specific DLL
     */
    public getCallingConvention(dllName: string, functionName: string): string | undefined {
        const dll = dllName.toLowerCase().replace(/\.dll$/, "");
        const func = functionName.toLowerCase();
        
        // 1. Exact match
        let cc = this.callingConventionCache.get(`${dll}:${func}`);
        if (cc !== undefined) return cc;

        // 2. Try without A/W suffix if it fails
        const baseName = functionName.replace(/[WA]$/, "").toLowerCase();
        cc = this.callingConventionCache.get(`${dll}:${baseName}`);
        if (cc !== undefined) return cc;

        // 2.6. Try with _ prefix (MSS v5+ undecorated names)
        if (!/@\d+$/i.test(functionName)) {
            const bkeyPrefixed = `${dll}:_${func}`;
            const variants = this.baseNameToKeys.get(bkeyPrefixed);
            if (variants?.length === 1) {
                cc = this.callingConventionCache.get(variants[0]);
                if (cc !== undefined) return cc;
            }
        }

        // 3. Fallback: Check if function exists in any module
        for (const [modName, mod] of this.modules) {
            const modKey = `${modName}:${func}`;
            const c = this.callingConventionCache.get(modKey);
            if (c !== undefined) return c;
        }

        return undefined;
    }

    /**
     * Returns argument count for a function by ordinal
     */
    public getArgCountByOrdinal(dllName: string, ordinal: number): number | undefined {
        const dll = dllName.toLowerCase().replace(/\.dll$/, "");
        const module = this.modules.get(dll);
        if (!module) return undefined;

        // First try to find by ordinal
        const func = module.functions.find(f => f.ordinal === ordinal);
        if (func) {
            return calculateStackCleanup(func.params) >> 2;
        }

        // Fallback: try to find by name "ord_${ordinal}"
        const ordName = `ord_${ordinal}`.toLowerCase();
        const funcByName = module.functions.find(f => f.name.toLowerCase() === ordName);
        if (funcByName) {
            return calculateStackCleanup(funcByName.params) >> 2;
        }

        return undefined;
    }

    /** Resolve an imported ordinal to its canonical exported name, if declared. */
    public getFunctionNameByOrdinal(dllName: string, ordinal: number): string | undefined {
        const dll = dllName.toLowerCase().replace(/\.dll$/, "");
        return this.modules.get(dll)?.functions.find(f => f.ordinal === ordinal)?.name;
    }

    /**
     * Returns all registered modules
     */
    public getModules(): ModuleDescriptor[] {
        return Array.from(this.modules.values());
    }

    /**
     * Returns all registered module names
     */
    public getModuleNames(): string[] {
        return Array.from(this.modules.keys());
    }

    /**
     * Check if a module (DLL) is registered (thunked)
     */
    public hasModule(dllName: string): boolean {
        const dll = dllName.toLowerCase().replace(/\.dll$/, "");
        return this.modules.has(dll);
    }

    /** True when a flat (non-interface) export is declared in the module's API descriptor. */
    public hasExportedFunction(dllName: string, functionName: string): boolean {
        const dll = dllName.toLowerCase().replace(/\.dll$/, "");
        const mod = this.modules.get(dll);
        if (!mod?.functions?.length) return false;
        const func = functionName.toLowerCase();
        return mod.functions.some((f) => f.name.toLowerCase() === func);
    }

    /**
     * Declared failure class for a name with no handler. Undefined ⇒ the caller applies
     * the default (see unimplemented-return.ts); this returns only what a descriptor said.
     * A COM vtable slot arrives here as "module:iface_method" and is always answered.
     */
    public getUnimplementedReturnClass(dllName: string, functionName: string): UnimplementedReturn | undefined {
        const dll = dllName.toLowerCase().replace(/\.dll$/, "");
        const func = functionName.toLowerCase();
        const exact = this.unimplementedReturnCache.get(`${dll}:${func}`);
        if (exact) return exact;
        // Same undecoration the argCount lookup uses: an IAT name may carry _Foo@8.
        const undecorated = func.replace(/^_+/, "").replace(/@\d+$/, "");
        if (undecorated !== func) {
            const hit = this.unimplementedReturnCache.get(`${dll}:${undecorated}`);
            if (hit) return hit;
        }
        return undefined;
    }

    /** True when this module, rather than some other descriptor, owns the function signature. */
    public hasModuleFunctionSignature(dllName: string, functionName: string): boolean {
        const dll = dllName.toLowerCase().replace(/\.dll$/, "");
        const func = functionName.toLowerCase();
        if (this.argCountCache.has(`${dll}:${func}`)) return true;

        const baseName = functionName.replace(/[WA]$/, "").toLowerCase();
        if (this.argCountCache.has(`${dll}:${baseName}`)) return true;

        if (!/@\d+$/i.test(functionName)) {
            if (this.baseNameToKeys.get(`${dll}:${func}`)?.length === 1) return true;
            if (this.baseNameToKeys.get(`${dll}:_${func}`)?.length === 1) return true;
        }
        return false;
    }
}
