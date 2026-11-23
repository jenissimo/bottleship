import { BottleShipMachine } from "./machine";
import { WwtCompiler } from "./translator";

export interface WwtAbi {
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

export async function loadWwtProvider(base: string, guestLimit: number, flatRam = false): Promise<WwtMachine> {
    const prefix = base.endsWith("/") ? base : base + "/";
    const inlinePageWalk = Boolean((globalThis as { __wwtInlinePageWalk?: boolean }).__wwtInlinePageWalk);
    const compiler = await WwtCompiler.load(prefix + "wwt_wasm.wasm", flatRam, inlinePageWalk);
    const debug = globalThis as { __wwtRegionWindow?: number; __wwtRegionOpt?: number };
    const machine = new BottleShipMachine(compiler, guestLimit, debug.__wwtRegionWindow, debug.__wwtRegionOpt);
    await machine.init();
    return machine;
}
