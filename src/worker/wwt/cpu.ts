import { CPU_VIEW_OFFSETS as V, cpuViewsForBuffer } from "../core/cpu/cpu-views";
import { decodeF80, F80_SIZE, FPU_ST_OFFSET } from "../core/fpu-helper";
import { loadWwtProvider, type WwtMachine } from "./cpu-provider";
import { deliverProtectedFault, emulateProtectedInstruction, updateSegment } from "./cpu-protected";
import { emulateWwtPortIo } from "./port-io";
import { packMappedPe } from "./pe-aot";
import { PeAotCompileTimeoutError } from "./pe-aot-compiler";
import type { PeAotStatus } from "./pe-aot-progress";
import { PeProfileRecorder, peProfileEntries } from "./pe-profile";
import { peAotCacheStats } from "./pe-aot-cache";
import { sha256Hex } from "../savestate/chunk-store";
import { installWwtHypercall, type WwtHypercall } from "./hypercall";
import { WwtMmio } from "./mmio";
import { TimeService } from "../runtime/time";
import type { WwtMode } from "./mode";
import { WWT_WALL_QUANTUM_MS } from "./wall-clock";

const PAGE = 0x1000;
const ARITHMETIC_FLAGS = 0x8d5;
const SYSTEM_FLAGS = 0x00247300;
const EFLAGS_DIRECTION = 0x400;
const SLICE_MS = 5;
const DEFAULT_SLICE_BUDGET = 500_003;
const FPU_STACK_EMPTY = 816;
const FPU_STACK_TOP = 1032;
const FPU_CONTROL = 1036;
const FPU_STATUS = 1040;
const XMM = 832;
// The existing BottleShip FPU helpers use this marker for binary64 values stored in an F80 slot.
const RELAXED_TAG = 0x7ffe;

type WritePort = (value: number) => void;
type ReadPort = () => number;
interface PortDevice {
    device?: unknown;
    read8?: ReadPort;
    read16?: ReadPort;
    read32?: ReadPort;
    write8?: WritePort;
    write16?: WritePort;
    write32?: WritePort;
}

class WwtIo {
    readonly ports: Array<PortDevice | undefined> = [];
    readonly mmio = new WwtMmio();

    constructor(private readonly enableMmio: () => void) {}

    mmap_register(...args: Parameters<WwtMmio["register"]>): () => void {
        const release = this.mmio.register(...args);
        try {
            this.enableMmio();
            return release;
        } catch (error) {
            release();
            throw error;
        }
    }

    register_write(port: number, device: unknown, write8?: WritePort, write16?: WritePort, write32?: WritePort): void {
        this.ports[port] = { ...this.ports[port], device, write8, write16, write32 };
    }

    register_read(port: number, device: unknown, read8?: ReadPort, read16?: ReadPort, read32?: ReadPort): void {
        this.ports[port] = { ...this.ports[port], device, read8, read16, read32 };
    }
}

interface WwtCpuOptions {
    providerBase?: string;
    memorySize: number;
    directHypercall?: boolean;
    mode?: WwtMode;
    flatRam?: boolean;
    beginPeAot?: (name: string) => (status: PeAotStatus) => void;
}

interface ProtectedModeRegisters {
    eip: number;
    esp: number;
    gdtBase: number;
    idtBase: number;
}

export async function createWwtCpu(options: WwtCpuOptions): Promise<WwtCpu> {
    const { memorySize, providerBase = "/wwt-provider/", directHypercall = true } = options;
    if (!Number.isSafeInteger(memorySize) || memorySize <= 0 || memorySize % 0x10000 !== 0) {
        throw new RangeError("WWT guest RAM must be a positive multiple of 64 KiB");
    }
    // BottleShip implements host thunks in its own PE address space. Passing the
    // real RAM limit lets the compiler specialize bounds and lookup-table addresses.
    const machine = await loadWwtProvider(providerBase, memorySize, options.mode ?? options.flatRam);
    try {
        const cpuStateBase = machine.nativeAlloc(PAGE, PAGE);
        const hypercall = await installWwtHypercall(machine, memorySize, cpuStateBase);
        const portable = directHypercall ? hypercall.directInteger : undefined;
        machine.natives.hle_out32 = portable?.dispatch ?? (() => 0);
        machine.natives.hle_out32_config = portable?.configAddress ?? 0;
        return new WwtCpu(machine, memorySize, hypercall, cpuStateBase, options.beginPeAot);
    } catch (error) {
        machine.dispose?.();
        throw error;
    }
}

export class WwtCpu {
    readonly io = new WwtIo(() => {
        if (this.machine.enableMmio()) this.requestYield();
    });
    readonly mem8: Uint8Array;
    readonly mem16: Uint16Array;
    readonly mem32s: Int32Array;
    readonly wasm_memory: WebAssembly.Memory;
    readonly wm;
    readonly reg32;
    readonly reg16: Uint16Array;
    readonly reg8: Uint8Array;
    readonly instruction_pointer;
    readonly previous_ip;
    readonly instruction_counter;
    readonly flags;
    readonly flags_changed;
    readonly last_op1;
    readonly last_op_size;
    readonly last_result;
    readonly segment_offsets;
    readonly segment_is_null;
    readonly segment_limits;
    readonly sreg;
    readonly cr;
    readonly cpl;
    readonly prefixes;
    readonly protected_mode;
    readonly is_32;
    readonly memory_size;
    readonly mxcsr;
    readonly fpu_simd_dirty;
    readonly gdtr_offset: Int32Array;
    readonly gdtr_size: Int32Array;
    readonly idtr_offset: Int32Array;
    readonly idtr_size: Int32Array;
    readonly in_hlt: Uint8Array;
    readonly stack_size_32: Int32Array;
    readonly dreg: Int32Array;
    readonly reg_xmm: Int32Array;
    readonly fpu_stack_empty: Uint8Array;
    readonly fpu_stack_ptr: Uint8Array;
    readonly fpu_control_word: Uint16Array;
    readonly fpu_status_word: Uint16Array;
    readonly independentMmxRegisters: Uint8Array;

    is_jumping = false;
    private readonly data: DataView;
    private readonly words: Int32Array;
    private readonly bytes: Uint8Array;
    private readonly cycleBudget: Uint32Array;
    private readonly pageTlb: Uint32Array;
    private managedPageDirectory = 0;
    private profileRecorder?: PeProfileRecorder;
    private readonly moduleRanges: Array<{ start: number; end: number; writable: boolean }> = [];
    private readonly pageLimit: number;
    private cpu: number;
    private sliceDeadline = 0;
    private yieldRequested = false;
    private running = false;
    private faultCount = 0;
    private readonly recentPorts = new Uint32Array(8 * 6);
    private portCursor = 0;
    private readonly recentMisses = new Uint32Array(12);
    private missCursor = 0;
    private readonly retirePortIo = () => this.retireEmulatedInstruction(this.cpu);

    constructor(
        private readonly machine: WwtMachine,
        memorySize: number,
        readonly wwtHypercall: WwtHypercall,
        readonly cpuStateBase: number,
        private readonly beginPeAot?: WwtCpuOptions["beginPeAot"],
    ) {
        this.wasm_memory = machine.memory;
        const buffer = this.wasm_memory.buffer;
        // Keep the compatibility state in native memory. Guest resets and Win9x
        // accesses can then use page zero without changing host CPU registers.
        this.bytes = new Uint8Array(buffer);
        this.words = new Int32Array(buffer);
        this.data = new DataView(buffer);
        this.mem8 = new Uint8Array(buffer, 0, memorySize);
        this.mem16 = new Uint16Array(buffer, 0, memorySize >>> 1);
        this.mem32s = new Int32Array(buffer, 0, memorySize >>> 2);
        this.pageLimit = memorySize / PAGE;
        const views = cpuViewsForBuffer(buffer, cpuStateBase);
        this.reg32 = views.reg32;
        this.reg16 = new Uint16Array(buffer, cpuStateBase + V.reg32, 16);
        this.reg8 = new Uint8Array(buffer, cpuStateBase + V.reg32, 32);
        this.instruction_pointer = views.instructionPointer;
        this.previous_ip = views.previousIp;
        this.instruction_counter = views.instructionCounter;
        this.flags = views.flags;
        this.flags_changed = views.flagsChanged;
        this.last_op1 = views.lastOp1;
        this.last_op_size = views.lastOpSize;
        this.last_result = views.lastResult;
        this.segment_offsets = views.segmentOffsets;
        this.segment_is_null = views.segmentIsNull;
        this.segment_limits = views.segmentLimits;
        this.sreg = views.sreg;
        this.cr = views.cr;
        this.cpl = views.cpl;
        this.prefixes = views.prefixes;
        this.protected_mode = views.protectedMode;
        this.is_32 = views.is32;
        this.memory_size = views.memorySize;
        this.mxcsr = views.mxcsr;
        this.fpu_simd_dirty = views.fpuSimdDirty;
        this.idtr_size = new Int32Array(buffer, cpuStateBase + 564, 1);
        this.idtr_offset = new Int32Array(buffer, cpuStateBase + 568, 1);
        this.gdtr_size = new Int32Array(buffer, cpuStateBase + 572, 1);
        this.gdtr_offset = new Int32Array(buffer, cpuStateBase + 576, 1);
        this.in_hlt = new Uint8Array(buffer, cpuStateBase + 616, 1);
        this.stack_size_32 = new Int32Array(buffer, cpuStateBase + 808, 1);
        this.dreg = new Int32Array(buffer, cpuStateBase + 684, 8);
        this.reg_xmm = new Int32Array(buffer, cpuStateBase + XMM, 32);
        this.fpu_stack_empty = new Uint8Array(buffer, cpuStateBase + FPU_STACK_EMPTY, 1);
        this.fpu_stack_ptr = new Uint8Array(buffer, cpuStateBase + FPU_STACK_TOP, 1);
        this.fpu_control_word = new Uint16Array(buffer, cpuStateBase + FPU_CONTROL, 1);
        this.fpu_status_word = new Uint16Array(buffer, cpuStateBase + FPU_STATUS, 1);
        this.independentMmxRegisters = new Uint8Array(buffer, cpuStateBase + FPU_ST_OFFSET + 8 * F80_SIZE, 8 * 8);
        this.cpu = machine.newCpu();
        const budgetAddress = machine.nativeAlloc(4, 4);
        this.cycleBudget = new Uint32Array(buffer, budgetAddress, 1);
        const tlbBytes = (machine.abi.cpu.PAGE_TLB_SLOTS ?? 0) * 8;
        const tlbBase = tlbBytes === 0 ? 0 : machine.nativeAlloc(tlbBytes, 8);
        this.pageTlb = new Uint32Array(buffer, tlbBase, tlbBytes >>> 2);
        this.wm = {
            wasm_table: machine.table,
            exports: {
                memory: this.wasm_memory,
                ...(machine.wallClock && machine.setParkExit ? {
                    set_wwt_park_exit: (address: number) =>
                        machine.setParkExit!(address, (cpu, eip) => this.publishGuestState(cpu, eip)),
                } : {}),
                get_cycle_budget_ptr: () => budgetAddress,
                full_clear_tlb: () => this.invalidatePaging(),
                get_relaxed_fpu: () => 1,
                jit_dirty_cache: (start: number, end: number) => this.invalidateCode(start, end),
                jit_clear_cache_js: () => this.invalidateCode(0, memorySize),
            },
        };
        machine.codeEnd = address => this.codeEnd(address);
        machine.canExecute = address => address >= 0 && address < this.mem8.length
            && this.translateAddress(address, false) === address;
        const translateMiss = machine.onMiss;
        if (translateMiss) {
            machine.onMiss = (cpu, address) => {
                this.recentMisses[this.missCursor++ % this.recentMisses.length] = address;
                this.profileRecorder?.miss(address);
                return translateMiss(cpu, address);
            };
        }
        machine.onFault = (cpu, code, eip, info) => this.handleFault(cpu, code, eip, info);
        machine.onPreempt = (cpu, eip) => this.preempt(cpu, eip);
        machine.onMmio = (cpu, address, size, write) => {
            const offset = this.machine.abi.cpu.MMIO_DATA;
            if (offset === undefined) return address;
            return this.io.mmio.transfer(address, size, write, this.data, cpu + offset,
                this.mem8.length, this.translateMmio, this.invalidateMmio);
        };
        this.reset();
    }

    private peAotGeneration = 0;
    private wallDeadline = 0;
    private timerSliceMs = 0;
    private readCodePermission?: (address: number) => boolean;
    private readonly codeWriteOverrides = new Map<number, boolean>();

    get wallClockQuantumMs(): number | undefined {
        return this.machine.wallClock ? WWT_WALL_QUANTUM_MS : undefined;
    }

    setTimerSliceMs(ms: number): void { this.timerSliceMs = ms; }

    setClockRunning(running: boolean): void { this.machine.wallClock?.setRunning(running); }
    dispose(): void { this.machine.dispose?.(); }

    setCodePermissionReader(canWrite: (address: number) => boolean): void {
        this.readCodePermission = canWrite;
        this.machine.canWriteCode = address => this.canWriteCode(address);
    }

    updateCodePermissions(base: number, size: number): void {
        if (!this.machine.wallClock || !this.readCodePermission || size <= 0) return;
        const first = base >>> 12;
        const end = Math.min(this.pageLimit, Math.ceil((base + size) / PAGE));
        // The Windows loader's allocation record normally covers the whole image.
        // Once VirtualProtect changes an executable page, use its explicit protection.
        for (const range of this.moduleRanges) {
            const from = Math.max(first, range.start >>> 12);
            const to = Math.min(end, Math.ceil(range.end / PAGE));
            for (let page = from; page < to; page++) {
                this.codeWriteOverrides.set(page, this.readCodePermission(page * PAGE));
            }
        }
        if (this.machine.updateCodePermissions?.(first, end) && this.running) this.requestYield();
    }

    private canWriteCode(address: number): boolean {
        const overridden = this.codeWriteOverrides.get(address >>> 12);
        if (overridden !== undefined) return overridden;
        let executable = false;
        for (const range of this.moduleRanges) {
            if (range.start >= address + PAGE || address >= range.end) continue;
            if (range.writable) return true;
            executable = true;
        }
        return executable ? false : (this.readCodePermission?.(address) ?? true);
    }

    reset(): void {
        this.peAotGeneration++;
        this.profileRecorder?.reset();
        this.profileRecorder = undefined;
        this.bytes.fill(0, this.cpuStateBase, this.cpuStateBase + PAGE);
        this.invalidatePaging();
        this.managedPageDirectory = 0;
        this.memory_size[0] = this.mem8.length;
        this.flags[0] = 2;
        this.mxcsr[0] = 0x1f80;
        this.fpu_control_word[0] = 0x037f;
        this.fpu_stack_empty[0] = 0xff;
        this.cycleBudget[0] = DEFAULT_SLICE_BUDGET;
        this.moduleRanges.length = 0;
        this.codeWriteOverrides.clear();
        this.timerSliceMs = 0;
        this.machine.wallClock?.reset();
        this.invalidateCode(0, this.mem8.length);
        this.machine.freeCpu(this.cpu);
        this.cpu = this.machine.newCpu();
        this.yieldRequested = false;
        this.faultCount = 0;
        this.portCursor = 0;
        this.missCursor = 0;
    }

    enterProtectedMode({ eip, esp, gdtBase, idtBase }: ProtectedModeRegisters): void {
        this.instruction_pointer[0] = eip;
        this.previous_ip[0] = eip;
        this.reg32[4] = esp;
        this.gdtr_offset[0] = gdtBase;
        this.gdtr_size[0] = 31;
        this.idtr_offset[0] = idtBase;
        this.idtr_size[0] = 2047;
        this.sreg.set([0x10, 0x08, 0x10, 0x10, 0x18, 0x10]);
        for (let segment = 0; segment < 6; segment++) {
            updateSegment(this, this.data, segment, this.sreg[segment]);
        }
        this.cr[0] = 0x23; // PE, MP and NE; no x87 emulation.
        this.protected_mode[0] = 1;
        this.is_32[0] = 1;
        this.stack_size_32[0] = 1;
        this.in_hlt[0] = 0;
    }

    /** Captured between worker turns, after WWT has published its architectural registers. */
    saveRegisters(override: import("../savestate/participant").CpuOverride | null) {
        if (this.running) throw new Error("WWT register capture inside an active CPU slice");
        const registers = this.bytes.slice(this.cpuStateBase, this.cpuStateBase + PAGE);
        if (override) {
            const copy = cpuViewsForBuffer(registers.buffer);
            const {eax, ecx, edx, ebx, esp, ebp, esi, edi, eip, eflags} = override;
            copy.reg32.set([eax, ecx, edx, ebx, esp, ebp, esi, edi]);
            copy.instructionPointer[0] = copy.previousIp[0] = eip;
            copy.flags[0] = eflags;
            copy.flagsChanged[0] = 0;
        }
        return {format: "wwt-i386-1", memorySize: this.mem8.length, registers};
    }

    validateRegisterSnapshot(snapshot: unknown): Uint8Array {
        const s = snapshot as Partial<ReturnType<WwtCpu["saveRegisters"]>> | null;
        if (!s || s.format !== "wwt-i386-1" || s.memorySize !== this.mem8.length ||
            !(s.registers instanceof Uint8Array) || s.registers.length !== PAGE) {
            throw new Error("Incompatible WWT register snapshot");
        }
        return s.registers;
    }

    restoreRegisters(snapshot: unknown): void {
        if (this.running) throw new Error("WWT register restore inside an active CPU slice");
        this.bytes.set(this.validateRegisterSnapshot(snapshot), this.cpuStateBase);
        this.peAotGeneration++;
        this.invalidatePaging();
        // OSR ids, Wasm table slots and native call depths belong to the old run.
        this.invalidateCode(0, this.mem8.length);
        this.machine.freeCpu(this.cpu);
        this.cpu = this.machine.newCpu();
        this.applyHostState(this.cpu);
        const retired = this.machine.abi.cpu.RETIRED_INSNS;
        if (retired !== undefined) this.setCpuWord(this.cpu, retired, this.instruction_counter[0]);
        this.yieldRequested = false;
    }

    setIdentityPageTableDirectory(address: number): void {
        this.managedPageDirectory = address >>> 0;
        this.invalidatePaging();
    }

    invalidatePaging(): void {
        this.pageTlb.fill(0);
    }

    get_eflags(): number { return this.flags[0] >>> 0; }
    get_seg_base(index: number): number { return this.segment_offsets[index] >>> 0; }
    translate_address_system_read(address: number): number {
        const physical = this.translateAddress(address >>> 0, false);
        if (physical === undefined) throw new RangeError("WWT unreadable guest address");
        return physical;
    }
    translate_address_system_write(address: number): number {
        const physical = this.translateAddress(address >>> 0, true);
        if (physical === undefined) throw new RangeError("WWT unwritable guest address");
        return physical;
    }

    private readonly translateMmio = (address: number, write: boolean) => this.translateAddress(address, write, true);
    private readonly invalidateMmio = (start: number, end: number) => this.invalidateCode(start, end);

    private translateAddress(address: number, write: boolean, external = false): number | undefined {
        if (!(this.cr[0] & 0x80000000)) return address < this.mem8.length ? address : undefined;
        const directory = (this.cr[3] & -PAGE) >>> 0;
        if (directory === 0) return undefined;
        const pdeAt = directory + (address >>> 22) * 4;
        if (pdeAt + 4 > this.mem8.length) return undefined;
        const pde = this.data.getUint32(pdeAt, true);
        if ((pde & 0x81) !== 1 || (write && !(pde & 2))) return undefined;
        const pteAt = ((pde & -PAGE) >>> 0) + ((address >>> 12) & 1023) * 4;
        if (pteAt + 4 > this.mem8.length) return undefined;
        const pte = this.data.getUint32(pteAt, true);
        if ((pte & 1) === 0 || (write && !(pte & 2))) return undefined;
        const physical = ((pte & -PAGE) | (address & (PAGE - 1))) >>> 0;
        return physical < this.mem8.length || external ? physical : undefined;
    }

    fpu_get_sti_f64(index: number): number {
        return this.readFpuSlot((this.fpu_stack_ptr[0] + index) & 7);
    }

    getTranslationStats() { return { ...this.machine.translationStats, peAotCache: peAotCacheStats() }; }

    requestYield(): void {
        this.yieldRequested = true;
    }

    stop(): void { this.requestYield(); }

    flushPeProfile(): Promise<void> | undefined { return this.profileRecorder?.flush(); }

    main_loop(): number {
        if (this.running || this.in_hlt[0] || this.cycleBudget[0] === 0) return 0;
        this.yieldRequested = false;
        const clock = this.machine.wallClock;
        if (clock) {
            clock.setRunning(true);
            const duration = this.timerSliceMs > 0 ? Math.min(this.timerSliceMs, WWT_WALL_QUANTUM_MS) : WWT_WALL_QUANTUM_MS;
            const deadline = clock.arm(duration);
            if (deadline === undefined) return 1;
            this.wallDeadline = deadline;
        } else {
            this.sliceDeadline = performance.now() + SLICE_MS;
        }
        this.running = true;
        try {
            // RDTSC uses the same virtual clock as QPC and GetTickCount.
            if (!clock) this.words[this.machine.tickAddr >>> 2] = TimeService.getInstance().nowMs();
            const A = this.machine.abi.cpu;
            if (clock) {
                this.setCpuWord(this.cpu, A.PREEMPT_AT, this.wallDeadline);
            } else if (A.RETIRED_INSNS !== undefined) {
                const deadline = (this.cpuWord(this.cpu, A.RETIRED_INSNS) + this.cycleBudget[0]) >>> 0;
                this.setCpuWord(this.cpu, A.PREEMPT_AT, deadline);
            } else {
                this.setCpuWord(this.cpu, A.PREEMPT_AT, 0);
            }
            this.applyHostState(this.cpu);
            const eip = this.instruction_pointer[0] >>> 0;
            const result = this.machine.run(this.cpu, eip);
            if (result === this.machine.stopAddress) {
                this.publishGuestState(this.cpu, eip);
                this.in_hlt[0] = 1;
            }
        } finally {
            this.running = false;
        }
        return 0;
    }

    cycle(): void { this.main_loop(); }
    do_many_cycles(): void { this.main_loop(); }

    async registerPeImage(name: string, base: number, size: number, file: Uint8Array): Promise<void> {
        const options = globalThis as { __wwtPeAot?: boolean | "learn" | "auto" | string[]; __wwtPeAotLinkage?: "page-local" | "full" };
        const fast = this.machine.wallClock !== undefined;
        const defaultFast = fast && options.__wwtPeAot === undefined;
        const hasOpfs = typeof globalThis.navigator?.storage?.getDirectory === "function";
        const selector = options.__wwtPeAot ?? (fast ? true : hasOpfs ? "auto" : undefined);
        if (selector !== true && selector !== "learn" && selector !== "auto" && (!Array.isArray(selector) || !selector.includes(name.toLowerCase()))) return;
        if (base < 0 || size <= 0 || base + size > this.mem8.length) return;
        const ranges = this.moduleRanges.filter(range => range.start >= base && range.end <= base + size);
        if (ranges.length === 0) return;
        const reportFailure = (error: unknown) => console.warn(`[WWT AOT] ${name}: ${String(error)}`);
        const generation = this.peAotGeneration;
        let onStatus: ((status: PeAotStatus) => void) | undefined;
        try {
            const digest = await sha256Hex(file);
            const executable = (pc: number) => ranges.some(range => range.start <= pc && pc < range.end);
            const saved = selector === "learn" ? [] : await peProfileEntries(digest, base, size);
            // Keep the canonical RVA order and leave obsolete, non-executable entries
            // out of the cache key for the current image.
            const profile = defaultFast ? saved.filter(executable) : saved;
            if (this.peAotGeneration !== generation) return;
            const learnOnly = selector === "learn" || (selector === "auto" && !profile.length);
            if (!learnOnly && fast && options.__wwtPeAotLinkage === "page-local") return;
            if (learnOnly || (defaultFast && hasOpfs)) {
                this.profileRecorder ??= new PeProfileRecorder();
                this.profileRecorder.watch(digest, base, ranges);
            }
            if (learnOnly) return;
            const publish = this.beginPeAot?.(name);
            if (publish) {
                onStatus = status => {
                    if (this.peAotGeneration === generation) publish(status);
                };
                onStatus({ phase: "lookup" });
            }
            const packed = packMappedPe(this.mem8.subarray(base, base + size), file, base);
            const linkage = fast ? "full" : (options.__wwtPeAotLinkage ?? (selector === "auto" ? "full" : "page-local"));
            const imageBounds = linkage === "full" ? { base, end: base + size, executableRanges: ranges } : undefined;
            await this.machine.loadPeAot(packed, name, executable, () => {
                if (this.peAotGeneration !== generation) return false;
                const fresh = packMappedPe(this.mem8.subarray(base, base + size), file, base);
                return fresh.length === packed.length && fresh.every((byte, index) => byte === packed[index]);
            }, profile, imageBounds, onStatus);
        } catch (error) {
            reportFailure(error);
            onStatus?.(error instanceof PeAotCompileTimeoutError
                ? { phase: "fallback", reason: "timeout", budgetMs: error.budgetMs }
                : { phase: "fallback", reason: "error" });
        }
    }

    registerCodeRange(start: number, end: number, writable = true): void {
        if (start < 0 || end > this.mem8.length || start >= end) return;
        if (this.machine.wallClock) {
            for (let page = start >>> 12; page < Math.ceil(end / PAGE); page++) this.codeWriteOverrides.delete(page);
        }
        this.moduleRanges.push({ start, end, writable });
    }

    private codeEnd(address: number): number {
        for (let i = this.moduleRanges.length - 1; i >= 0; i--) {
            const range = this.moduleRanges[i];
            if (range.start <= address && address < range.end) return range.end;
        }
        // Keep default translation local to a page, with room to decode a straddling instruction.
        return this.machine.wallClock ? this.mem8.length : Math.min((address & ~(PAGE - 1)) + PAGE + 14, this.mem8.length);
    }

    invalidateCode(start: number, end: number): void {
        if (this.machine.invalidateTranslationPages) {
            const invalidated = this.machine.invalidateTranslationPages(start >>> 12,
                Math.min(this.pageLimit, Math.ceil(end / PAGE)));
            if (invalidated && this.running) this.requestYield();
            return;
        }
        // Include the preceding page: the final instruction there may straddle the write.
        const firstPage = Math.max(0, (start >>> 12) - 1);
        const endPage = Math.min(this.pageLimit, Math.ceil(end / PAGE));
        for (let page = firstPage; page < endPage; page++) {
            if (this.machine.l1At(page) !== this.machine.zeroL2) this.machine.setL1(page, this.machine.zeroL2);
        }
    }

    private cpuWord(cpu: number, offset: number): number { return this.words[(cpu + offset) >>> 2]; }
    private setCpuWord(cpu: number, offset: number, value: number): void { this.words[(cpu + offset) >>> 2] = value; }

    private readFpuSlot(index: number): number {
        const at = this.cpuStateBase + FPU_ST_OFFSET + index * F80_SIZE;
        const exponent = this.data.getUint16(at + 8, true);
        return exponent === RELAXED_TAG
            ? this.data.getFloat64(at, true)
            : decodeF80(this.data.getUint32(at, true), this.data.getUint32(at + 4, true), exponent);
    }

    private applyHostState(cpu: number): void {
        const A = this.machine.abi.cpu;
        this.words.set(this.reg32, (cpu + A.GPR) >>> 2);
        this.setCpuWord(cpu, A.EIP, this.instruction_pointer[0]);
        this.setCpuWord(cpu, A.FS_BASE, this.segment_offsets[4]);
        this.setCpuWord(cpu, A.GS_BASE, this.segment_offsets[5]);
        if (A.PAGE_DIRECTORY !== undefined) {
            const directory = (this.cr[0] & 0x80000000) ? ((this.cr[3] & -PAGE) || -1) >>> 0 : 0;
            this.setCpuWord(cpu, A.PAGE_DIRECTORY, directory);
            this.setCpuWord(cpu, A.PAGE_RAM_SIZE, this.mem8.length);
            if (A.PAGE_TLB !== undefined) {
                const cache = directory !== 0 && directory === this.managedPageDirectory && this.pageTlb.length > 0
                    && !(globalThis as { __wwtNoTlb?: boolean }).__wwtNoTlb;
                this.setCpuWord(cpu, A.PAGE_TLB, cache ? this.pageTlb.byteOffset : 0);
            }
            if (A.PAGE_HAS_MMIO !== undefined) this.setCpuWord(cpu, A.PAGE_HAS_MMIO, Number(this.io.mmio.hasApertures));
        }
        for (let segment = 0; segment < 6; segment++) this.data.setUint16(cpu + A.SEG_SEL + 2 * segment, this.sreg[segment], true);
        const flags = this.flags[0];
        this.setCpuWord(cpu, A.FK, 0);
        this.setCpuWord(cpu, A.FR, flags & ARITHMETIC_FLAGS);
        this.setCpuWord(cpu, A.DF, (flags & EFLAGS_DIRECTION) >>> 10);
        this.setCpuWord(cpu, A.EFLAGS_SYS, flags & SYSTEM_FLAGS);
        this.setCpuWord(cpu, A.FPU_TOP, this.fpu_stack_ptr[0] & 7);
        this.data.setUint16(cpu + A.FPU_CW, this.fpu_control_word[0], true);
        this.data.setUint16(cpu + A.FPU_SW, this.fpu_status_word[0] & ~0x3800, true);
        this.bytes[cpu + A.FPU_TAG] = ~this.fpu_stack_empty[0];
        let i64Valid = A.FPU_I64_VALID !== undefined ? this.bytes[cpu + A.FPU_I64_VALID] : 0;
        for (let i = 0; i < 8; i++) {
            const at = cpu + A.FPU_ST + i * 8;
            const before = this.data.getBigUint64(at, true);
            this.data.setFloat64(at, this.readFpuSlot(i), true);
            if (this.data.getBigUint64(at, true) !== before) i64Valid &= ~(1 << i);
        }
        if (A.FPU_I64_VALID !== undefined) this.bytes[cpu + A.FPU_I64_VALID] = i64Valid & this.bytes[cpu + A.FPU_TAG];
        this.setCpuWord(cpu, A.MXCSR, this.mxcsr[0]);
        this.bytes.copyWithin(cpu + A.XMM, this.reg_xmm.byteOffset, this.reg_xmm.byteOffset + 128);
        this.bytes.set(this.independentMmxRegisters, cpu + A.MMX);
    }

    private publishGuestState(cpu: number, eip: number): void {
        const A = this.machine.abi.cpu;
        if (A.RETIRED_INSNS !== undefined) this.instruction_counter[0] = this.cpuWord(cpu, A.RETIRED_INSNS) >>> 0;
        this.reg32.set(this.words.subarray((cpu + A.GPR) >>> 2, ((cpu + A.GPR) >>> 2) + 8));
        this.instruction_pointer[0] = eip;
        this.flags[0] = this.machine.eflags(cpu);
        this.flags_changed[0] = 0;
        this.segment_offsets[4] = this.cpuWord(cpu, A.FS_BASE);
        this.segment_offsets[5] = this.cpuWord(cpu, A.GS_BASE);
        for (let segment = 0; segment < 6; segment++) this.sreg[segment] = this.data.getUint16(cpu + A.SEG_SEL + 2 * segment, true);
        this.fpu_stack_ptr[0] = this.cpuWord(cpu, A.FPU_TOP) & 7;
        this.fpu_control_word[0] = this.data.getUint16(cpu + A.FPU_CW, true);
        this.fpu_status_word[0] = this.data.getUint16(cpu + A.FPU_SW, true);
        this.fpu_stack_empty[0] = ~this.bytes[cpu + A.FPU_TAG];
        for (let i = 0; i < 8; i++) {
            const at = this.cpuStateBase + FPU_ST_OFFSET + i * F80_SIZE;
            this.data.setFloat64(at, this.data.getFloat64(cpu + A.FPU_ST + i * 8, true), true);
            this.data.setUint16(at + 8, RELAXED_TAG, true);
        }
        this.mxcsr[0] = this.cpuWord(cpu, A.MXCSR);
        this.bytes.copyWithin(this.reg_xmm.byteOffset, cpu + A.XMM, cpu + A.XMM + 128);
        this.independentMmxRegisters.set(this.bytes.subarray(cpu + A.MMX, cpu + A.MMX + this.independentMmxRegisters.byteLength));
        this.fpu_simd_dirty[0] = 1;
    }

    private shouldYield(): boolean {
        if (this.yieldRequested || this.cycleBudget[0] === 0) return true;
        const clock = this.machine.wallClock;
        return clock ? clock.now() >= this.wallDeadline : performance.now() >= this.sliceDeadline;
    }

    private preempt(cpu: number, eip: number): boolean {
        const A = this.machine.abi.cpu;
        if (this.machine.wallClock) {
            if (!this.shouldYield()) return false;
            this.publishGuestState(cpu, eip);
            return true;
        }
        // A provider without instruction budgets calls here at backward edges, with
        // PREEMPT_AT set to the frozen tick. Count those observed retirements only.
        if (A.RETIRED_INSNS === undefined) {
            this.instruction_counter[0]++;
            if (!this.shouldYield()) return false;
        }
        this.publishGuestState(cpu, eip);
        return true;
    }

    private retireEmulatedInstruction(cpu: number): void {
        const retired = this.machine.abi.cpu.RETIRED_INSNS;
        this.instruction_counter[0]++;
        if (retired !== undefined) this.setCpuWord(cpu, retired, this.instruction_counter[0]);
    }

    /** Exact OUT DX,EAX used by the BottleShip thunk stubs. Leaves that only
     *  consume integer state can stay in the native WWT register file. */
    private dispatchIntegerPort(cpu: number, eip: number): boolean | null {
        if (this.mem8[eip] !== 0xef || !this.io.ports[0xb077]?.write32) return null;
        const A = this.machine.abi.cpu;
        const regs = (cpu + A.GPR) >>> 2;
        if ((this.words[regs + 2] & 0xffff) !== 0xb077) return null;
        const functionId = this.words[regs] >>> 0;
        if (functionId === 0 || functionId >= 65536) return null;
        const oldCounter = this.instruction_counter[0];
        const retired = A.RETIRED_INSNS;
        const nextCounter = ((retired === undefined ? oldCounter : this.cpuWord(cpu, retired)) + 1) >>> 0;
        this.reg32[0] = functionId;
        this.reg32[1] = this.words[regs + 1];
        this.reg32[4] = this.words[regs + 4];
        this.instruction_counter[0] = nextCounter;
        const dispatched = this.wwtHypercall.dispatchInteger(functionId);
        if (!dispatched) {
            this.instruction_counter[0] = oldCounter;
            return dispatched;
        }
        this.words[regs] = this.reg32[0];
        this.setCpuWord(cpu, A.EIP, eip + 1);
        if (retired !== undefined) this.setCpuWord(cpu, retired, nextCounter);
        return true;
    }

    private handleFault(cpu: number, code: number, eip: number, info: number): number | undefined {
        const F = this.machine.abi.fault;
        const directDeclined = code === F.PORT_OUT32 && (info | 0) < 0;
        if (code === F.PORT_OUT32) code = F.PRIVILEGED_INSTRUCTION;
        const portable = directDeclined ? false
            : code === F.PRIVILEGED_INSTRUCTION ? this.dispatchIntegerPort(cpu, eip) : null;
        if (portable) {
            if (!this.shouldYield()) return eip + 1;
            this.publishGuestState(cpu, eip + 1);
            this.previous_ip[0] = eip;
            return this.machine.yieldAddress;
        }
        this.publishGuestState(cpu, eip);
        this.previous_ip[0] = eip;

        const id = this.reg32[0];
        const esp = this.reg32[4] >>> 0;
        const returnAddress = esp + 4 <= this.mem8.length ? this.data.getUint32(esp, true) : 0;
        const portIo = (code === F.PRIVILEGED_INSTRUCTION || code === F.ILLEGAL_INSTRUCTION)
            && emulateWwtPortIo(this, eip, this.retirePortIo, portable !== false);
        if (portIo) {
            const index = (this.portCursor++ % (this.recentPorts.length / 6)) * 6;
            this.recentPorts[index] = id;
            this.recentPorts[index + 1] = eip;
            this.recentPorts[index + 2] = esp;
            this.recentPorts[index + 3] = returnAddress;
            this.recentPorts[index + 4] = this.instruction_pointer[0];
            this.recentPorts[index + 5] = this.reg32[4];
        }
        const privileged = (code === F.GENERAL_PROTECTION || code === F.PRIVILEGED_INSTRUCTION)
            && emulateProtectedInstruction(this, this.data, eip);
        if (!portIo && !privileged) {
            if (this.faultCount++ < 8) this.logGuestFault(code, eip, info);
            const present = (this.cr[0] & 0x80000000) !== 0 && this.translateAddress(info, false, true) !== undefined;
            if (!deliverProtectedFault(this, this.data, F, code, eip, info, present)) return undefined;
        } else if (privileged) {
            this.retireEmulatedInstruction(cpu);
        }
        this.applyHostState(cpu);
        return this.in_hlt[0] || this.shouldYield() ? this.machine.yieldAddress : this.instruction_pointer[0] >>> 0;
    }

    private logGuestFault(code: number, eip: number, info: number): void {
        const hex = (value: number) => (value >>> 0).toString(16);
        const regs = Array.from(this.reg32, hex);
        const bytes = Array.from(this.mem8.subarray(eip, eip + 15), value => hex(value).padStart(2, "0")).join(" ");
        console.warn(`[WWT] guest fault code=0x${hex(code)} eip=0x${hex(eip)} info=0x${hex(info)}`
            + ` flags=0x${hex(this.flags[0])} fs=0x${hex(this.segment_offsets[4])} bytes=[${bytes}]`
            + ` EAX=${regs[0]} ECX=${regs[1]} EDX=${regs[2]} EBX=${regs[3]}`
            + ` ESP=${regs[4]} EBP=${regs[5]} ESI=${regs[6]} EDI=${regs[7]}`);
        if (this.faultCount === 1) {
            const ports: string[] = [];
            for (let i = Math.max(0, this.portCursor - this.recentPorts.length / 6); i < this.portCursor; i++) {
                const at = (i % (this.recentPorts.length / 6)) * 6;
                ports.push(Array.from(this.recentPorts.subarray(at, at + 6), hex).join(":"));
            }
            const misses: string[] = [];
            for (let i = Math.max(0, this.missCursor - this.recentMisses.length); i < this.missCursor; i++) {
                misses.push(hex(this.recentMisses[i % this.recentMisses.length]));
            }
            console.warn(`[WWT] last ports (id:EIP:ESP:return:resume EIP:resume ESP) ${ports.join(" ")}; misses ${misses.join(" ")}`);
        }
    }
}
