import type { WwtMachine, WwtModule, WwtPeImageBounds } from "./cpu-provider";
import { WwtCompiler, WwtTranslationStackOverflow } from "./translator";
import { getOrBuild } from "./pe-aot-cache";
import { compileAbi11Pe } from "./pe-aot-compiler";
import type { PeAotStatus } from "./pe-aot-progress";
import { WwtWallClock } from "./wall-clock";
import { trapAddress, WwtTrapMap } from "./traps";

const PAGE = 4096;
const PAGE_COUNT = 1 << 20;
const MAX_INSTRUCTION_BYTES = 15;
const ZERO_RUN = 64;
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
    readonly wallClock?: WwtWallClock;
    refreshWallTimers?: () => void;
    canWriteCode?: (address: number) => boolean;
    private readonly traps?: WwtTrapMap;
    private readonly writableCodePages = new Set<number>();
    private readonly cpus = new Set<number>();
    private tableUsed = 2;
    private parkExit?: { address: number; publish: (cpu: number, pc: number) => void };
    private parkTrampoline?: WebAssembly.Module;
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
        if (this.abi.version === 11) {
            this.wallClock = new WwtWallClock(this.memory, this.tickAddr);
            if (compiler.memTraps) this.traps = new WwtTrapMap();
        }
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
        const helperPage = helper >>> 12;
        this.setL1(helperPage, this.zeroL2);
        this.entriesByPage.delete(helperPage);
        this.traps?.remove(helper);
        this.bytes[this.storeMap + helperPage] &= ~STORE_MAP_CODE;
        this.writableCodePages.delete(helperPage);
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
        if (this.wallClock) this.cpus.add(at);
        this.words[(at + A.CODE_WRITABLE) >>> 2] = Number(!this.wallClock || this.writableCodePages.size > 0);
        return at;
    }
    freeCpu(cpu: number): void {
        this.cpus.delete(cpu);
        this.recycledCpus.push(cpu);
    }

    dispose(): void {
        this.wallClock?.dispose();
        this.refreshWallTimers = undefined;
        this.parkExit = undefined;
        this.traps?.clear();
    }

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
        const fullReset = first === 0 && end >= Math.ceil(this.guestLimit / PAGE);
        const reach = this.abi.fault.SMC_RESUME === undefined && !this.wallClock ? 0 : this.regionWindow / PAGE;
        first = Math.max(0, first - Math.max(1, reach));
        end = Math.min(PAGE_COUNT, end + reach);
        for (let page = first; page < end; page++) {
            if (this.l1At(page) !== this.zeroL2) {
                this.setL1(page, this.zeroL2);
                invalidated = true;
            }
            const entries = this.entriesByPage.get(page);
            if (entries && this.traps) for (const pc of entries) this.traps.remove(pc);
            this.entriesByPage.delete(page);
            if (this.wallClock) {
                this.bytes[this.storeMap + page] &= ~STORE_MAP_CODE;
                this.writableCodePages.delete(page);
            }
        }
        if (fullReset) this.traps?.clear();
        this.publishCodeWritePolicy();
        return invalidated;
    }

    enableMmio(): boolean {
        if (this.wallClock) throw new Error("This device needs MMIO. Select protected WWT mode.");
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

    setParkExit(address: number, publish: (cpu: number, pc: number) => void): () => void {
        if (!this.wallClock || !Number.isInteger(address) || address <= 0 || address + 1 >= this.guestLimit) {
            throw new RangeError("Invalid WWT scheduler park address");
        }
        if (this.parkExit) this.invalidateParkEntry(this.parkExit.address);
        const binding = { address, publish };
        this.parkExit = binding;
        const slot = this.lookup(address);
        if (slot > 1) this.wrapParkEntry(address, slot);
        return () => {
            if (this.parkExit !== binding) return;
            this.parkExit = undefined;
            this.invalidateParkEntry(address);
        };
    }

    private invalidateParkEntry(address: number): void {
        this.invalidateTranslationPages(address >>> 12, ((address + 1) >>> 12) + 1);
    }

    private isParkInstruction(address: number): boolean {
        return this.bytes[address] === 0xeb && this.bytes[address + 1] === 0xfe;
    }

    private wrapParkEntry(address: number, slot: number): void {
        const binding = this.parkExit;
        if (binding?.address !== address || !this.isParkInstruction(address)) return;
        const original = this.table.get(slot);
        if (typeof original !== "function") throw new Error("Missing WWT scheduler park entry");
        const decide = (cpu: number): number => {
            if (!this.isParkInstruction(address) || this.canExecute?.(address) === false ||
                ((address & (PAGE - 1)) === PAGE - 1 && this.canExecute?.(address + 1) === false)) {
                this.invalidateParkEntry(address);
                this.restartAfterSmc = address;
                return this.yieldAddress;
            }
            if (this.parkExit !== binding) return 0;
            // Give the scheduler a boundary even if the current thread has not
            // completed its transition into a wait state.
            binding.publish(cpu, address);
            return this.yieldAddress;
        };
        // A park decision exits the kernel; otherwise tail-call the original entry.
        // Both functions and the dispatcher use the same (cpu: i32) -> pc signature.
        const body = [1, 1, 0x7f, 0x20, 0, 0x10, 0, 0x22, 1, 0x04, 0x40,
            0x20, 1, 0x0f, 0x0b, 0x20, 0, 0x12, 1, 0x0b];
        const name = (value: string) => [value.length, ...new TextEncoder().encode(value)];
        const section = (id: number, data: number[]) => [id, data.length, ...data];
        const imported = (field: string) => [...name("env"), ...name(field), 0, 0];
        this.parkTrampoline ??= new WebAssembly.Module(Uint8Array.of(
            0, 97, 115, 109, 1, 0, 0, 0,
            ...section(1, [1, 0x60, 1, 0x7f, 1, 0x7f]),
            ...section(2, [2, ...imported("decide"), ...imported("original")]),
            ...section(3, [1, 0]), ...section(7, [1, ...name("enter"), 0, 2]),
            ...section(10, [1, body.length, ...body]),
        ));
        const wrapped = new WebAssembly.Instance(this.parkTrampoline, { env: { decide, original } });
        this.table.set(slot, wrapped.exports.enter as WasmFn);
    }

    private zeroRunEnd(address: number, end: number): number {
        const words = ZERO_RUN >>> 2;
        let run = 0;
        for (let word = (address + 3) >>> 2, last = end >>> 2; word < last; word++) {
            if (this.words[word] !== 0) {
                run = 0;
            } else if (++run === words) {
                return Math.min(end, Math.max((word + 1 - words) << 2, address + MAX_INSTRUCTION_BYTES));
            }
        }
        return end;
    }

    private translateAt(cpu: number, address: number): number {
        if (address >= this.guestLimit || (this.canExecute && !this.canExecute(address))) {
            this.words[(cpu + this.abi.cpu.EIP) >>> 2] = this.resumeFault(cpu, this.abi.fault.ACCESS_VIOLATION_EXECUTE, address, address);
            return 1;
        }
        const codeEnd = this.codeEnd?.(address) ?? this.guestLimit;
        let end = Math.min(address + this.regionWindow, codeEnd, this.guestLimit);
        if (codeEnd >= this.guestLimit) end = this.zeroRunEnd(address, end);
        let known: number[] = [];
        for (let page = address >>> 12; page <= (end - 1) >>> 12; page++) {
            const entries = this.entriesByPage.get(page);
            if (entries && this.l1At(page) !== this.zeroL2) for (const pc of entries) {
                if (pc > address && pc < end) known.push(pc);
            }
        }
        const start = performance.now();
        let wasm: Uint8Array<ArrayBuffer>;
        for (;;) {
            try {
                wasm = this.compiler.translate(this.bytes.subarray(address, end), address, known,
                    this.guestLimit, this.guestMmio, this.regionOpt);
                break;
            } catch (error) {
                if (!(error instanceof WwtTranslationStackOverflow)) throw error;
                // Bound the compiler's recursive CFG walk. The shortest retry
                // still has room to decode a complete x86 instruction.
                const shorterEnd = address + (end - address > PAGE ? PAGE : MAX_INSTRUCTION_BYTES);
                if (shorterEnd >= end) throw error;
                end = shorterEnd;
                known = known.filter(pc => pc < end);
            }
        }
        const built = performance.now();
        this.installCompiledModule(new WebAssembly.Module(wasm), address.toString(16),
            undefined, undefined, this.wallClock !== undefined);
        // ABI 11 publishes CODE when an entry first installs an L2 for its page.
        // A demand window contains potential input, including unused writable pages.
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
        verifyCurrent: () => boolean, profile: number[] = [], fullImage?: WwtPeImageBounds,
        onStatus?: (status: PeAotStatus) => void): Promise<void> {
        const guestMmio = this.guestMmio;
        if (this.wallClock && (!fullImage || !this.canLinkUpstreamImage(fullImage))) {
            onStatus?.({ phase: "fallback", reason: "ineligible" });
            return;
        }
        const policy = this.wallClock ? "upstream-linked-v1" : fullImage ? "linked-smc-v2" : "page-local-v2";
        const modeKey = `${this.compiler.cacheId}/${this.guestLimit}/${this.compiler.flags(this.guestLimit, guestMmio)}/${policy}-opt1`;
        const started = performance.now();
        let translateMs = 0;
        let translated = false;
        const profileKey = profile.length ? modeKey + "/seeds/" + profile.join(",") : modeKey;
        const bytes = await getOrBuild(file, profileKey, async () => {
            const start = performance.now();
            let wasm: Uint8Array<ArrayBuffer>;
            if (this.wallClock && typeof Worker !== "undefined") {
                onStatus?.({ phase: "starting" });
                wasm = await compileAbi11Pe({
                    module: this.compiler.module,
                    cacheId: this.compiler.cacheId,
                    file,
                    profile,
                    guestLimit: this.guestLimit,
                }, ({ startedAt, work }) => onStatus?.({ phase: "compiling", startedAt, work }));
            } else {
                onStatus?.({ phase: "compiling", startedAt: performance.timeOrigin + performance.now() });
                wasm = this.compiler.translatePe(file, profile, this.guestLimit, guestMmio, !fullImage);
            }
            translateMs = performance.now() - start;
            translated = true;
            onStatus?.({ phase: "output" });
            return wasm;
        });
        const source = translated ? "compiler" : "cache";
        onStatus?.({ phase: "finalizing", source });
        const compiling = performance.now();
        const compiled = await WebAssembly.compile(bytes);
        if (this.guestMmio !== guestMmio || !verifyCurrent()) {
            onStatus?.({ phase: "fallback", reason: "image-changed" });
            return;
        }
        if (this.wallClock && fullImage && !this.canLinkUpstreamImage(fullImage)) {
            onStatus?.({ phase: "fallback", reason: "ineligible" });
            return;
        }
        const installing = performance.now();
        const module = this.installCompiledModule(compiled, name, executable, fullImage);
        const report = { name, policy, seeds: profile.length, source, translateMs,
            lookupAndStoreMs: compiling - started - translateMs, compileModuleMs: installing - compiling,
            installMs: performance.now() - installing,
            wasmBytes: bytes.length, entries: module.entries };
        console.info("[WWT AOT] " + JSON.stringify(report));
        onStatus?.({ phase: "ready", source });
    }

    loadModuleSync(bytes: Uint8Array, name: string, canInstall?: (address: number) => boolean,
        fullImage?: WwtPeImageBounds): WwtModule & { entries: number } {
        return this.installCompiledModule(new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>), name, canInstall, fullImage);
    }

    private installCompiledModule(module: WebAssembly.Module, name: string, canInstall?: (address: number) => boolean,
        fullImage?: WwtPeImageBounds, keepExisting = false): WwtModule & { entries: number } {
        const [section] = WebAssembly.Module.customSections(module, this.abi.funcs_section);
        if (!section) throw new Error(`Missing i386 function map in ${name}`);
        const map = new Uint32Array(section);
        if (map[0] !== map.length - 1) throw new Error(`Invalid i386 function map in ${name}`);
        if (canInstall && map.subarray(1).some(pc => !canInstall(pc))) {
            throw new Error(`AOT address outside executable sections in ${name}`);
        }
        let sourcePages: Uint32Array | undefined;
        if (fullImage) {
            let [dependencies] = WebAssembly.Module.customSections(module, "wwt.smc_pages");
            if (this.wallClock && fullImage.executableRanges) {
                const pages = new Set<number>();
                for (const range of fullImage.executableRanges) {
                    for (let page = range.start >>> 12; page <= (range.end - 1) >>> 12; page++) pages.add(page);
                }
                dependencies = Uint32Array.from([...pages].sort((a, b) => a - b)).buffer;
            }
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
            // The stock compiler can directly link across executable pages. Only
            // install an upstream linked image while all of its source is read-only.
            if (this.wallClock && pages.some(page => this.isWritableCodePage(page))) {
                throw new Error(`Cannot link writable executable pages in ${name}`);
            }
            sourcePages = pages;
        }
        const base = this.wallClock ? this.reserveUpstreamTableSlots(map[0]) : this.table.grow(map[0]);
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
        const traps = this.abi.traps_section && WebAssembly.Module.customSections(module, this.abi.traps_section)[0];
        if (traps) this.traps?.register(map.subarray(1), traps);
        for (let i = 1; i < map.length; i++) {
            if (!keepExisting || !this.lookup(map[i])) this.installEntry(map[i], base + i - 1);
        }
        if (sourcePages?.length && map[0]) {
            const linked: LinkedPeModule = { sourcePages, firstSlot: base, slotCount: map[0],
                entryPages: new Set(map.subarray(1).map(pc => pc >>> 12)) };
            for (const page of sourcePages) {
                let dependencies = this.linkedPeBySource.get(page);
                if (!dependencies) this.linkedPeBySource.set(page, dependencies = new Set());
                dependencies.add(linked);
                if (!this.wallClock) this.markCodePage(page);
            }
        }
        return {instance, entries: map[0]};
    }

    private reserveUpstreamTableSlots(count: number): number {
        const base = this.tableUsed;
        const end = base + count;
        if (end > this.table.length) this.table.grow(Math.max(this.table.length, end - this.table.length));
        this.tableUsed = end;
        return base;
    }

    private canLinkUpstreamImage(image: WwtPeImageBounds): boolean {
        if (!image.executableRanges?.length) return false;
        for (const range of image.executableRanges) {
            for (let page = range.start >>> 12; page <= (range.end - 1) >>> 12; page++) {
                if (this.isWritableCodePage(page)) return false;
            }
        }
        return true;
    }

    private isWritableCodePage(page: number): boolean {
        const address = page * PAGE;
        return address >= this.abi.null_limit && (this.canWriteCode?.(address) ?? true);
    }

    private publishCodeWritePolicy(): void {
        if (!this.wallClock) return;
        // A guest write can clear CODE inside translated Wasm before the next host update.
        for (const page of this.writableCodePages) {
            if (!(this.bytes[this.storeMap + page] & STORE_MAP_CODE)) this.writableCodePages.delete(page);
        }
        const writable = Number(this.writableCodePages.size > 0);
        for (const cpu of this.cpus) this.words[(cpu + this.abi.cpu.CODE_WRITABLE) >>> 2] = writable;
    }

    updateCodePermissions(first: number, end: number): boolean {
        if (!this.wallClock) return false;
        let invalidated = false;
        for (let page = first; page < end; page++) {
            if (!(this.bytes[this.storeMap + page] & STORE_MAP_CODE) && !this.linkedPeBySource.has(page)) continue;
            const writable = this.isWritableCodePage(page);
            if (writable && this.linkedPeBySource.has(page)) {
                invalidated = this.invalidateTranslationPages(page, page + 1) || invalidated;
            }
            if (writable && (this.bytes[this.storeMap + page] & STORE_MAP_CODE)) this.writableCodePages.add(page);
            else this.writableCodePages.delete(page);
        }
        this.publishCodeWritePolicy();
        return invalidated;
    }

    private markCodePage(page: number): void {
        this.bytes[this.storeMap + page] |= STORE_MAP_CODE;
        if (this.wallClock && this.isWritableCodePage(page) && !this.writableCodePages.has(page)) {
            this.writableCodePages.add(page);
            this.publishCodeWritePolicy();
        }
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
        if (this.parkExit?.address === pc) this.wrapParkEntry(pc, slot);
    }

    eflags(cpu: number): number {
        const A = this.abi.cpu;
        const get = (offset: number) => this.words[(cpu + offset) >>> 2];
        return this.evalFlags(get(A.FK), get(A.FR), get(A.FA), get(A.FB), get(A.FC))
            | (get(A.DF) << 10) | get(A.EFLAGS_SYS) | 2;
    }

    run(cpu: number, eip: number): number {
        const depth = this.abi.cpu.CALL_DEPTH;
        const depthWord = (cpu + depth) >>> 2;
        const savedDepth = this.wallClock && depth !== undefined ? this.words[depthWord] : undefined;
        try {
            for (;;) {
                let result: number;
                try {
                    result = this.kernelRun(cpu, eip) >>> 0;
                } catch (error) {
                    const site = this.traps?.find(error);
                    if (!site) throw error;
                    if (savedDepth !== undefined) this.words[depthWord] = savedDepth;
                    this.words[(cpu + this.abi.cpu.EIP) >>> 2] = site.eip;
                    const fault = (site.flags & this.abi.trap!.WRITE)
                        ? this.abi.fault.ACCESS_VIOLATION_WRITE : this.abi.fault.ACCESS_VIOLATION;
                    eip = this.resumeFault(cpu, fault, site.eip, trapAddress(this.words, this.abi, cpu, site));
                    if (eip === this.stopAddress || eip === this.yieldAddress) return eip;
                    continue;
                } finally {
                    this.flushSmc(cpu);
                }
                const resume = this.restartAfterSmc;
                if (resume === undefined) return result;
                this.restartAfterSmc = undefined;
                eip = resume;
            }
        } finally {
            if (savedDepth !== undefined) this.words[depthWord] = savedDepth;
        }
    }
}
