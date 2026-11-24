import { BottleShipMachine } from "./machine";
import { WwtCompiler } from "./translator";
import type { WwtMode } from "./mode";
import type { WwtWallClock } from "./wall-clock";

export const WWT_ABI11_SHA256 = "95f8ad6ee983acd0f7f466f25ebe71be3965da796d47befbc44b1cf56e958f42";

export interface WwtAbi {
    version: number;
    traps_section?: string;
    trap?: Record<string, number>;
    stop_address: number;
    yield_address: number;
    funcs_section: string;
    null_limit: number;
    native_layout: Record<string, number>;
    cpu: Record<string, number>;
    fault: Record<string, number>;
}

export interface WwtPeImageBounds {
    base: number;
    end: number;
    executableRanges?: readonly { start: number; end: number }[];
}

export interface WwtModule {
    instance: WebAssembly.Instance;
}

export interface WwtMachine {
    abi: WwtAbi;
    memory: WebAssembly.Memory;
    table: WebAssembly.Table;
    natives: WebAssembly.ModuleImports;
    readonly translationStats?: Readonly<{ compiled: number; compilerMs: number; installMs: number; wasmBytes: number }>;
    guestLimit: number;
    stopAddress: number;
    yieldAddress: number;
    zeroL2: number;
    storeMap: number;
    tickAddr: number;
    wallClock?: WwtWallClock;
    refreshWallTimers?: () => void;
    canWriteCode?: (pageAddress: number) => boolean;
    updateCodePermissions?(firstPage: number, endPage: number): boolean;
    setParkExit?(address: number, ownsPark: (pc: number) => boolean, publish: (cpu: number, pc: number) => void): () => void;
    dispose?(): void;
    codeEnd?: (address: number) => number;
    invalidateTranslationPages?(first: number, end: number): boolean;
    canExecute?: (address: number) => boolean;
    onMiss?: (cpu: number, address: number) => number;
    onFault?: (cpu: number, code: number, eip: number, info: number) => number | undefined;
    onPreempt?: (cpu: number, eip: number) => boolean;
    onMmio?: (cpu: number, address: number, size: number, write: boolean) => number;
    init(): Promise<void>;
    enableMmio(): boolean;
    newCpu(): number;
    freeCpu(cpu: number): void;
    nativeAlloc(size: number, alignment?: number): number;
    lookup(address: number): number;
    l1At(page: number): number;
    setL1(page: number, value: number): void;
    loadModuleSync(bytes: Uint8Array, name: string): WwtModule;
    loadPeAot(file: Uint8Array<ArrayBuffer>, name: string, executable: (address: number) => boolean,
        verifyCurrent: () => boolean, profile?: number[], fullImage?: WwtPeImageBounds): Promise<void>;
    eflags(cpu: number): number;
    run(cpu: number, eip: number): number;
}

export async function loadWwtProvider(base: string, guestLimit: number, mode: WwtMode | boolean = "fast"): Promise<WwtMachine> {
    const prefix = base.endsWith("/") ? base : base + "/";
    const fast = mode === "fast";
    const inlinePageWalk = Boolean((globalThis as { __wwtInlinePageWalk?: boolean }).__wwtInlinePageWalk);
    if (typeof SharedArrayBuffer === "undefined" || globalThis.crossOriginIsolated === false) {
        throw new Error("WWT needs cross-origin isolation (COOP and COEP) for shared WebAssembly memory");
    }
    const compiler = await WwtCompiler.load(prefix + (fast ? "wwt_abi11.wasm" : "wwt_wasm.wasm"),
        fast || mode === true, inlinePageWalk);
    if (fast && compiler.cacheId !== WWT_ABI11_SHA256) {
        throw new Error("Unexpected SHA-256 for the pinned WWT ABI11 provider");
    }
    if (fast ? compiler.abi.version !== 11 : compiler.abi.version !== 12) {
        throw new Error(`Unexpected WWT ABI ${compiler.abi.version} for the selected execution mode`);
    }
    const debug = globalThis as { __wwtRegionWindow?: number; __wwtRegionOpt?: number };
    const machine = new BottleShipMachine(compiler, guestLimit,
        fast ? 0x40000 : debug.__wwtRegionWindow, fast ? 0 : debug.__wwtRegionOpt);
    try {
        await machine.init();
        await machine.wallClock?.init();
        return machine;
    } catch (error) {
        machine.dispose();
        throw error;
    }
}
