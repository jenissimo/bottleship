import type { WwtMachine, WwtModule, WwtPeImageBounds } from "./cpu-provider";
import { WwtCompiler } from "./translator";
import { getOrBuild } from "./pe-aot-cache";

const PAGE = 4096;
const PAGE_COUNT = 1 << 20;
const TRANSLATION_WINDOW = 0x4000;
const STORE_MAP_CODE = 1;
const STORE_MAP_CODE_NEXT = 4;
type WasmFn = (...args: number[]) => number;

interface LinkedPeModule {
    sourcePages: Uint32Array;
    entryPages: Set<number>;
    firstSlot: number;
    slotCount: number;
}

function x87Math(op: number, a: number, b: number): number {
    switch (op) {
        case 0: return Math.sin(a);
        case 1: return Math.cos(a);
        case 2: return Math.tan(a);
        case 3: return Math.atan2(a, b);
        case 4: return Math.log2(a);
        case 5: return Math.expm1(a * Math.LN2);
        case 6: return a % b;
        case 7: {
            const remainder = a % b;
            const distance = Math.abs(remainder);
            const halfway = Math.abs(b) / 2;
            if (distance > halfway || (distance === halfway && Math.abs(Math.trunc(a / b) % 2) === 1)) {
                return remainder - Math.sign(a) * Math.abs(b);
            }
            return remainder;
        }
        case 8: return a * 2 ** Math.trunc(b);
        case 9: return Math.log1p(a) / Math.LN2;
        default: throw new Error(`Unknown x87 math operation ${op}`);
    }
}

/** Hosts the i386 compiler's generated modules in the BottleShip worker. */
export class BottleShipMachine implements WwtMachine {
    readonly abi;
    readonly memory: WebAssembly.Memory;
    readonly table = new WebAssembly.Table({initial: 2, element: "anyfunc"});
    readonly stopAddress;
    readonly yieldAddress;
    private restartAfterSmc: number | undefined;
    private linkedPeBySource = new Map<number, Set<LinkedPeModule>>();
    readonly zeroL2;
    readonly storeMap;
    readonly tickAddr;
    readonly natives: Record<string, WebAssembly.ImportValue> = {};
    private readonly lookupL1;
    private readonly bytes;
    private readonly words;
    private readonly allocatedL2 = new Map<number, number>();
    private readonly entriesByPage = new Map<number, Set<number>>();
    private readonly recycledCpus: number[] = [];
    readonly translationStats = { compiled: 0, compilerMs: 0, installMs: 0, wasmBytes: 0 };
    private cursor: number;
    private guestMmio = false;
    private kernelRun!: WasmFn;
    private evalFlags!: WasmFn;
    codeEnd?: (address: number) => number;
    canExecute?: (address: number) => boolean;
    onFault?: WwtMachine["onFault"];
    onPreempt?: WwtMachine["onPreempt"];
    onMmio?: WwtMachine["onMmio"];
    onMiss = (cpu: number, address: number): number => this.translateAt(cpu, address >>> 0);

    constructor(private readonly compiler: WwtCompiler, readonly guestLimit: number,
        private readonly regionWindow = TRANSLATION_WINDOW, private readonly regionOpt = 1) {
        if (![PAGE, TRANSLATION_WINDOW, 0x10000, 0x40000].includes(regionWindow) || (regionOpt !== 0 && regionOpt !== 1)) {
            throw new RangeError("Unsupported WWT demand-translation policy");
        }
        this.abi = compiler.abi;
        this.stopAddress = this.abi.stop_address;
        this.yieldAddress = this.abi.yield_address;
        this.lookupL1 = guestLimit + this.abi.native_layout.LOOKUP_L1;
        this.zeroL2 = guestLimit + this.abi.native_layout.ZERO_L2;
        this.storeMap = guestLimit + this.abi.native_layout.STORE_MAP;
        const pages = Math.ceil((guestLimit + (256 << 20)) / 65536);
        this.memory = new WebAssembly.Memory({initial: pages, maximum: pages, shared: true});
        this.bytes = new Uint8Array(this.memory.buffer);
        this.words = new Uint32Array(this.memory.buffer);
        this.cursor = this.storeMap + PAGE_COUNT;
        this.tickAddr = this.nativeAlloc(4);
        this.words.fill(this.zeroL2, this.lookupL1 / 4, this.lookupL1 / 4 + PAGE_COUNT);
        this.bytes.fill(2, this.storeMap, this.storeMap + Math.ceil(this.abi.null_limit / PAGE));
        this.bytes.fill(2, this.storeMap + Math.floor((guestLimit - 1) / PAGE), this.storeMap + PAGE_COUNT);
    }

    async init(): Promise<void> {
        const kernel = new WebAssembly.Instance(new WebAssembly.Module(this.compiler.kernel()), {env: {
            memory: this.memory, table: this.table, lookup_l1: this.lookupL1,
            thunk_base: 0, thunk_size: 0, miss: (cpu: number, address: number) => this.onMiss(cpu, address),
            host_call: () => { throw new Error("WWT host call outside BottleShip thunk dispatch"); },
        }});
        this.table.set(0, kernel.exports.miss_entry as WasmFn);
        this.table.set(1, kernel.exports.resume as WasmFn);
        this.kernelRun = kernel.exports.run as WasmFn;
        const helper = this.guestLimit - 0x20000;
        this.loadModuleSync(this.compiler.translate(Uint8Array.of(0xc3), helper, [], this.guestLimit), "flags");
        this.setL1(helper >>> 12, this.zeroL2);
    }

    nativeAlloc(size: number, alignment = 8): number {
        const start = Math.ceil(this.cursor / alignment) * alignment;
        if (start + size > this.bytes.length) throw new RangeError("WWT native memory exhausted");
        this.cursor = start + size;
        return start;
    }

    newCpu(): number {
        const A = this.abi.cpu;
        const at = this.recycledCpus.pop() ?? this.nativeAlloc(A.SIZE, 64);
        this.bytes.fill(0, at, at + A.SIZE);
        this.words[(at + A.CODE_WRITABLE) >>> 2] = 1;
        return at;
    }
    freeCpu(cpu: number): void { this.recycledCpus.push(cpu); }

    l1At(page: number): number { return this.words[this.lookupL1 / 4 + page]; }
    setL1(page: number, value: number): void { this.words[this.lookupL1 / 4 + page] = value; }
    lookup(address: number): number {
        return this.words[this.l1At(address >>> 12) / 4 + (address & (PAGE - 1))];
    }

    private flushSmc(cpu: number): boolean {
        const { SMC_FIRST_PAGE, SMC_END_PAGE } = this.abi.cpu;
        if (SMC_END_PAGE === undefined) return false;
        const endWord = (cpu + SMC_END_PAGE) >>> 2;
        const end = this.words[endWord];
        if (!end) return false;
        const first = this.words[(cpu + SMC_FIRST_PAGE) >>> 2];
        this.words[endWord] = 0;
        this.invalidateTranslationPages(first, end);
        return true;
    }

    private resumePreempt(cpu: number, eip: number): number {
        const wroteCode = this.flushSmc(cpu);
        if (this.onPreempt?.(cpu, eip) ?? true) return 1;
        if (!wroteCode) return 0;
        this.restartAfterSmc = eip;
        return 1;
    }

    private resumeFault(cpu: number, code: number, eip: number, info: number): number {
        const fault = code >>> 0;
        if (fault === this.abi.fault.SMC_EVICT) {
            this.invalidateTranslationPages(info >>> 0, (info >>> 0) + 1);
            return 0;
        }
        const wroteCode = this.flushSmc(cpu);
        if (fault === this.abi.fault.SMC_RESUME) {
            this.restartAfterSmc = eip >>> 0;
            return this.yieldAddress;
        }
        const next = this.onFault?.(cpu, fault, eip >>> 0, info >>> 0);
        if (next === undefined) throw new Error(`Unhandled WWT exception 0x${(code >>> 0).toString(16)} at 0x${(eip >>> 0).toString(16)}`);
        if (wroteCode && next !== this.yieldAddress && next !== this.stopAddress) {
            this.restartAfterSmc = next;
            return this.yieldAddress;
        }
        return next;
    }

    private unlinkPeModule(module: LinkedPeModule): void {
        for (const page of module.sourcePages) {
            const dependencies = this.linkedPeBySource.get(page)!;
            dependencies.delete(module);
            if (!dependencies.size) this.linkedPeBySource.delete(page);
        }
        for (const page of module.entryPages) {
            this.setL1(page, this.zeroL2);
            this.entriesByPage.delete(page);
        }
        for (let slot = module.firstSlot; slot < module.firstSlot + module.slotCount; slot++) {
            this.table.set(slot, null);
        }
    }

    invalidateTranslationPages(first: number, end: number): boolean {
        let invalidated = false;
        for (let page = first; page < end && this.linkedPeBySource.size; page++) {
            const dependencies = this.linkedPeBySource.get(page);
            if (dependencies) for (const module of dependencies) {
                this.unlinkPeModule(module);
                invalidated = true;
            }
        }
        // A region can inline or directly link any entry in its source window.
        // A separate translation rooted anywhere in that window can publish entries.
        const reach = this.abi.fault.SMC_RESUME === undefined ? 0 : this.regionWindow / PAGE;
        first = Math.max(0, first - Math.max(1, reach));
        end = Math.min(PAGE_COUNT, end + reach);
        for (let page = first; page < end; page++) {
            if (this.l1At(page) !== this.zeroL2) {
                this.setL1(page, this.zeroL2);
                invalidated = true;
            }
            this.entriesByPage.delete(page);
        }
        return invalidated;
    }

    enableMmio(): boolean {
        if (this.guestMmio) return false;
        this.guestMmio = true;
        while (this.linkedPeBySource.size) {
            const modules = this.linkedPeBySource.values().next().value!;
            this.unlinkPeModule(modules.values().next().value!);
        }
        // Generated modules enter through L1. Clearing every root removes
        // future entries into the old code. WwtCpu also unwinds active
        // Wasm frames, which can still hold direct intra-module links.
        for (const page of this.entriesByPage.keys()) {
            this.setL1(page, this.zeroL2);
            this.bytes[this.storeMap + page] &= ~1;
        }
        this.entriesByPage.clear();
        return true;
    }

    private translateAt(cpu: number, address: number): number {
        if (address >= this.guestLimit || (this.canExecute && !this.canExecute(address))) {
            this.words[(cpu + this.abi.cpu.EIP) >>> 2] = this.resumeFault(cpu, this.abi.fault.ACCESS_VIOLATION_EXECUTE, address, address);
            return 1;
        }
        const end = Math.min(address + this.regionWindow, this.codeEnd?.(address) ?? this.guestLimit, this.guestLimit);
        const source = this.bytes.subarray(address, end);
        const known: number[] = [];
        for (let page = address >>> 12; page <= (end - 1) >>> 12; page++) {
            const entries = this.entriesByPage.get(page);
            if (entries && this.l1At(page) !== this.zeroL2) for (const pc of entries) {
                if (pc > address && pc < end) known.push(pc);
            }
        }
        const start = performance.now();
        const wasm = this.compiler.translate(source, address, known, this.guestLimit, this.guestMmio, this.regionOpt);
        const built = performance.now();
        this.loadModuleSync(wasm, address.toString(16));
        if (this.abi.fault.SMC_RESUME !== undefined) {
            for (let page = address >>> 12; page <= (end - 1) >>> 12; page++) {
                this.markCodePage(page);
            }
        }
        this.translationStats.compiled++;
        this.translationStats.compilerMs += built - start;
        this.translationStats.installMs += performance.now() - built;
        this.translationStats.wasmBytes += wasm.byteLength;
        const slot = this.lookup(address);
        if (!slot) throw new Error(`Missing translated entry at 0x${address.toString(16)}`);
        return slot;
    }

    async loadPeAot(file: Uint8Array<ArrayBuffer>, name: string, executable: (address: number) => boolean,
        verifyCurrent: () => boolean, profile: number[] = [], fullImage?: WwtPeImageBounds): Promise<void> {
        const guestMmio = this.guestMmio;
        const policy = fullImage ? "linked-smc-v2" : "page-local-v2";
        const modeKey = `${this.compiler.cacheId}/${this.guestLimit}/${this.compiler.flags(this.guestLimit, guestMmio)}/${policy}-opt1`;
        const started = performance.now();
        let translateMs = 0;
        let translated = false;
        const profileKey = profile.length ? modeKey + "/seeds/" + profile.join(",") : modeKey;
        const bytes = await getOrBuild(file, profileKey, () => {
            const start = performance.now();
            const wasm = this.compiler.translatePe(file, profile, this.guestLimit, guestMmio, !fullImage);
            translateMs = performance.now() - start;
            translated = true;
            return wasm;
        });
        const compiling = performance.now();
        const compiled = await WebAssembly.compile(bytes);
        if (this.guestMmio !== guestMmio || !verifyCurrent()) return;
        const installing = performance.now();
        const module = this.installCompiledModule(compiled, name, executable, fullImage);
        const report = { name, policy, seeds: profile.length, source: translated ? "compiler" : "cache", translateMs,
            lookupAndStoreMs: compiling - started - translateMs, compileModuleMs: installing - compiling,
            installMs: performance.now() - installing,
            wasmBytes: bytes.length, entries: module.entries };
        console.info("[WWT AOT] " + JSON.stringify(report));
    }

    loadModuleSync(bytes: Uint8Array, name: string, canInstall?: (address: number) => boolean,
        fullImage?: WwtPeImageBounds): WwtModule & { entries: number } {
        return this.installCompiledModule(new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>), name, canInstall, fullImage);
    }

    private installCompiledModule(module: WebAssembly.Module, name: string, canInstall?: (address: number) => boolean,
        fullImage?: WwtPeImageBounds): WwtModule & { entries: number } {
        const [section] = WebAssembly.Module.customSections(module, this.abi.funcs_section);
        if (!section) throw new Error(`Missing i386 function map in ${name}`);
        const map = new Uint32Array(section);
        if (map[0] !== map.length - 1) throw new Error(`Invalid i386 function map in ${name}`);
        if (canInstall && map.subarray(1).some(pc => !canInstall(pc))) {
            throw new Error(`AOT address outside executable sections in ${name}`);
        }
        let sourcePages: Uint32Array | undefined;
        if (fullImage) {
            const [dependencies] = WebAssembly.Module.customSections(module, "wwt.smc_pages");
            if (!dependencies || dependencies.byteLength % 4 ||
                !Number.isInteger(fullImage.base) || !Number.isInteger(fullImage.end) ||
                fullImage.base < this.abi.null_limit || fullImage.base >= fullImage.end || fullImage.end > this.guestLimit) {
                throw new Error(`Invalid PE AOT dependency metadata in ${name}`);
            }
            const pages = new Uint32Array(dependencies);
            const min = fullImage.base >>> 12;
            const max = (fullImage.end - 1) >>> 12;
            let previous = min - 1;
            for (const page of pages) {
                if (page <= previous || page > max) {
                    throw new Error(`PE AOT dependency outside the mapped image in ${name}`);
                }
                previous = page;
            }
            const declared = new Set(pages);
            if (map.subarray(1).some(pc => !declared.has(pc >>> 12))) {
                throw new Error(`PE AOT entry missing a source dependency in ${name}`);
            }
            sourcePages = pages;
        }
        const base = this.table.grow(map[0]);
        const instance = new WebAssembly.Instance(module, {env: {
            memory: this.memory, table: this.table, table_base: base, lookup_l1: this.lookupL1,
            store_map: this.storeMap, zero_l2: this.zeroL2, tick: this.tickAddr,
            guest_limit: this.guestLimit - this.abi.null_limit - 16,
            fault: (cpu: number, code: number, pc: number, info: number) => this.resumeFault(cpu, code, pc, info),
            preempt: (cpu: number, pc: number) => this.resumePreempt(cpu, pc >>> 0),
            math: x87Math, sin: Math.sin, cos: Math.cos,
            mmio: (cpu: number, address: number, size: number, write: number) => this.onMmio?.(cpu, address >>> 0, size, !!write) ?? address,
            hle_out32: () => 0, hle_out32_config: 0, ...this.natives,
        }});
        this.evalFlags ??= instance.exports.eflags as WasmFn;
        for (let i = 1; i < map.length; i++) this.installEntry(map[i], base + i - 1);
        if (sourcePages?.length && map[0]) {
            const linked: LinkedPeModule = { sourcePages, firstSlot: base, slotCount: map[0],
                entryPages: new Set(map.subarray(1).map(pc => pc >>> 12)) };
            for (const page of sourcePages) {
                let dependencies = this.linkedPeBySource.get(page);
                if (!dependencies) this.linkedPeBySource.set(page, dependencies = new Set());
                dependencies.add(linked);
                this.markCodePage(page);
            }
        }
        return {instance, entries: map[0]};
    }

    private markCodePage(page: number): void {
        this.bytes[this.storeMap + page] |= STORE_MAP_CODE;
        // A write starting on the preceding page can straddle into this
        // code page. Keep that uncommon range check inside the map slow path.
        if (page > 0 && this.abi.fault.SMC_RESUME !== undefined) {
            this.bytes[this.storeMap + page - 1] |= STORE_MAP_CODE_NEXT;
        }
    }

    private installEntry(pc: number, slot: number): void {
        const page = pc >>> 12;
        let l2 = this.l1At(page);
        if (l2 === this.zeroL2) {
            l2 = this.allocatedL2.get(page) ?? this.nativeAlloc(PAGE * 4, 16);
            this.allocatedL2.set(page, l2);
            this.words.fill(0, l2 / 4, l2 / 4 + PAGE);
            this.setL1(page, l2);
            this.entriesByPage.set(page, new Set());
            this.markCodePage(page);
        }
        this.words[l2 / 4 + (pc & (PAGE - 1))] = slot;
        this.entriesByPage.get(page)!.add(pc);
    }

    eflags(cpu: number): number {
        const A = this.abi.cpu;
        const get = (offset: number) => this.words[(cpu + offset) >>> 2];
        return this.evalFlags(get(A.FK), get(A.FR), get(A.FA), get(A.FB), get(A.FC))
            | (get(A.DF) << 10) | get(A.EFLAGS_SYS) | 2;
    }

    run(cpu: number, eip: number): number {
        for (;;) {
            let result: number;
            try {
                result = this.kernelRun(cpu, eip) >>> 0;
            } finally {
                this.flushSmc(cpu);
            }
            const resume = this.restartAfterSmc;
            if (resume === undefined) return result;
            this.restartAfterSmc = undefined;
            eip = resume;
        }
    }
}
