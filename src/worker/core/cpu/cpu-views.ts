/**
 * The ONE owner of plain typed-array views over v86's CPU-state block.
 *
 * v86 publishes `cpu.reg32`, `cpu.instruction_pointer`, `cpu.segment_offsets`, … as
 * `view()` Proxies (vendor/v86/src/lib.js) so that WASM memory growth stays transparent
 * to every consumer. The price is paid per ACCESS, not per grow: `cpu.reg32[4]` is a
 * property get on the Proxy, a `resolve()` closure call, a buffer-identity compare and
 * only then the element read. On the thunk/scheduler hot paths — which touch these
 * fields several times per dispatched WinAPI call — that is measurable worker CPU spent
 * re-answering a question whose answer changes a handful of times per session.
 *
 * This module answers it once. `cpuViews(cpu)` hands back plain typed arrays built
 * directly on `cpu.wasm_memory.buffer` at the offsets pinned by
 * `vendor/v86/src/rust/cpu/global_pointers.rs`, and rebuilds them only when that buffer's
 * identity changes (a WebAssembly.Memory grow detaches the old one). Reading a scalar CPU
 * field through these is exactly as correct as reading it through the Proxy and costs an
 * ordinary typed-array index.
 *
 * WHY THIS IS SAFE WHERE A CACHED GUEST-RAM VIEW IS NOT: these are FIXED offsets into the
 * CPU state block, re-validated against the live buffer on every hand-out, and every
 * consumer is synchronous (no `await` between `cpuViews()` and the access). The per-turn rule for
 * guest RAM (§3.1, `validate-guest-memory-views`) exists because a plain guest view is
 * stored in a field and outlives the turn; a `CpuViews` must be treated the same way —
 * call `cpuViews(cpu)` at the point of use, never hold the returned object in a field.
 *
 * FALLBACK: a CPU without `wasm_memory` (unit-test fakes that set `reg32` to a real
 * Int32Array) gets its own arrays back, so call sites need no branch.
 *
 * Enforced by `tools/validate-cpu-proxy-reads.ts`.
 */

/**
 * WASM offsets — vendor/v86/src/rust/cpu/global_pointers.rs. Do not re-derive.
 * Exported so `tools/tests/cpu-views.test.ts` can pin them against that file directly,
 * rather than against a second hand-copy that would share any mistake.
 */
export const CPU_VIEW_OFFSETS = {
    reg32: 64,
    lastOpSize: 96,
    flagsChanged: 100,
    lastOp1: 104,
    lastResult: 112,
    flags: 120,
    instructionPointer: 556,
    previousIp: 560,
    cr: 580,
    cpl: 612,
    fpuSimdDirty: 632,
    prefixes: 648,
    instructionCounter: 664,
    sreg: 668,
    segmentIsNull: 724,
    segmentOffsets: 736,
    segmentLimits: 768,
    protectedMode: 800,
    is32: 804,
    memorySize: 812,
    mxcsr: 824,
} as const;

/** One past the highest byte any view above reaches (mxcsr: 824 + 4). Below this the CPU
 *  state block is not yet mapped and nothing here may be built. */
const MIN_BUFFER_BYTES = 832;

export interface CpuViews {
    /** The buffer these views were built on — compare to detect a stale hold. */
    readonly buffer: ArrayBufferLike | null;
    /** EAX ECX EDX EBX ESP EBP ESI EDI. */
    readonly reg32: Int32Array;
    readonly instructionPointer: Int32Array;
    readonly previousIp: Int32Array;
    /** 32-bit retired-instruction counter (wraps). */
    readonly instructionCounter: Uint32Array;
    /** Raw EFLAGS — STALE while `flagsChanged[0] !== 0`; use `cpu.get_eflags()` to read
     *  a materialized value (§3.6 lazy-EFLAGS rule). */
    readonly flags: Int32Array;
    readonly flagsChanged: Int32Array;
    readonly lastOp1: Int32Array;
    readonly lastOpSize: Int32Array;
    readonly lastResult: Int32Array;
    /** ES CS SS DS FS GS (+2 unused) — index 4 is FS, the per-thread TEB base. */
    readonly segmentOffsets: Int32Array;
    readonly segmentIsNull: Uint8Array;
    readonly segmentLimits: Uint32Array;
    readonly sreg: Uint16Array;
    readonly cr: Int32Array;
    readonly cpl: Uint8Array;
    readonly prefixes: Uint8Array;
    readonly protectedMode: Int32Array;
    readonly is32: Int32Array;
    readonly memorySize: Uint32Array;
    readonly mxcsr: Int32Array;
    readonly fpuSimdDirty: Uint8Array;
    /** False when built from the CPU's own (possibly Proxy) fields because the CPU has no
     *  WASM memory — a unit-test fake. Nothing depends on it but diagnostics. */
    readonly flat: boolean;
}

const EMPTY_I32 = new Int32Array(0);
const EMPTY_U32 = new Uint32Array(0);
const EMPTY_U16 = new Uint16Array(0);
const EMPTY_U8 = new Uint8Array(0);

/** Views for a CPU with no WASM memory: hand back whatever the object itself carries. */
function fallbackViews(cpu: any): CpuViews {
    return {
        buffer: null,
        reg32: cpu?.reg32 ?? EMPTY_I32,
        instructionPointer: cpu?.instruction_pointer ?? EMPTY_I32,
        previousIp: cpu?.previous_ip ?? EMPTY_I32,
        instructionCounter: cpu?.instruction_counter ?? EMPTY_U32,
        flags: cpu?.flags ?? EMPTY_I32,
        flagsChanged: cpu?.flags_changed ?? EMPTY_I32,
        lastOp1: cpu?.last_op1 ?? EMPTY_I32,
        lastOpSize: cpu?.last_op_size ?? EMPTY_I32,
        lastResult: cpu?.last_result ?? EMPTY_I32,
        segmentOffsets: cpu?.segment_offsets ?? EMPTY_I32,
        segmentIsNull: cpu?.segment_is_null ?? EMPTY_U8,
        segmentLimits: cpu?.segment_limits ?? EMPTY_U32,
        sreg: cpu?.sreg ?? EMPTY_U16,
        cr: cpu?.cr ?? EMPTY_I32,
        cpl: cpu?.cpl ?? EMPTY_U8,
        prefixes: cpu?.prefixes ?? EMPTY_U8,
        protectedMode: cpu?.protected_mode ?? EMPTY_I32,
        is32: cpu?.is_32 ?? EMPTY_I32,
        memorySize: cpu?.memory_size ?? EMPTY_U32,
        mxcsr: cpu?.mxcsr ?? EMPTY_I32,
        fpuSimdDirty: cpu?.fpu_simd_dirty ?? EMPTY_U8,
        flat: false,
    };
}

function buildViews(buffer: ArrayBufferLike): CpuViews {
    return {
        buffer,
        reg32: new Int32Array(buffer, CPU_VIEW_OFFSETS.reg32, 8),
        instructionPointer: new Int32Array(buffer, CPU_VIEW_OFFSETS.instructionPointer, 1),
        previousIp: new Int32Array(buffer, CPU_VIEW_OFFSETS.previousIp, 1),
        instructionCounter: new Uint32Array(buffer, CPU_VIEW_OFFSETS.instructionCounter, 1),
        flags: new Int32Array(buffer, CPU_VIEW_OFFSETS.flags, 1),
        flagsChanged: new Int32Array(buffer, CPU_VIEW_OFFSETS.flagsChanged, 1),
        lastOp1: new Int32Array(buffer, CPU_VIEW_OFFSETS.lastOp1, 1),
        lastOpSize: new Int32Array(buffer, CPU_VIEW_OFFSETS.lastOpSize, 1),
        lastResult: new Int32Array(buffer, CPU_VIEW_OFFSETS.lastResult, 1),
        segmentOffsets: new Int32Array(buffer, CPU_VIEW_OFFSETS.segmentOffsets, 8),
        segmentIsNull: new Uint8Array(buffer, CPU_VIEW_OFFSETS.segmentIsNull, 8),
        segmentLimits: new Uint32Array(buffer, CPU_VIEW_OFFSETS.segmentLimits, 8),
        sreg: new Uint16Array(buffer, CPU_VIEW_OFFSETS.sreg, 8),
        cr: new Int32Array(buffer, CPU_VIEW_OFFSETS.cr, 8),
        cpl: new Uint8Array(buffer, CPU_VIEW_OFFSETS.cpl, 1),
        prefixes: new Uint8Array(buffer, CPU_VIEW_OFFSETS.prefixes, 1),
        protectedMode: new Int32Array(buffer, CPU_VIEW_OFFSETS.protectedMode, 1),
        is32: new Int32Array(buffer, CPU_VIEW_OFFSETS.is32, 1),
        memorySize: new Uint32Array(buffer, CPU_VIEW_OFFSETS.memorySize, 1),
        mxcsr: new Int32Array(buffer, CPU_VIEW_OFFSETS.mxcsr, 1),
        fpuSimdDirty: new Uint8Array(buffer, CPU_VIEW_OFFSETS.fpuSimdDirty, 1),
        flat: true,
    };
}

// One live WASM buffer per worker; keyed on its identity so a grow is the only rebuild.
let cachedBuffer: ArrayBufferLike | null = null;
let cachedViews: CpuViews | null = null;

/**
 * Plain views over the CPU-state block at the head of `buffer` (v86 maps the CPU state at
 * the base of the same WASM linear memory that backs guest RAM, so `mem8.buffer` is this
 * buffer). For callers that hold the memory but not the CPU object.
 */
export function cpuViewsForBuffer(buffer: ArrayBufferLike): CpuViews {
    if (cachedViews !== null && cachedBuffer === buffer) return cachedViews;
    const views = buildViews(buffer);
    noteWasmBuffer(buffer, views.instructionPointer[0] >>> 0);
    cachedBuffer = buffer;
    cachedViews = views;
    return views;
}

/**
 * Plain views over `cpu`'s state block, rebuilt iff the WASM buffer changed.
 *
 * Cheap enough to call at the point of use — two property reads plus an identity compare
 * on the hit path. CALL IT AT THE POINT OF USE; do not store the result in a field.
 */
export function cpuViews(cpu: any): CpuViews {
    const buffer: ArrayBufferLike | undefined = cpu?.wasm_memory?.buffer;
    if (!buffer || buffer.byteLength < MIN_BUFFER_BYTES) return fallbackViews(cpu);
    return cpuViewsForBuffer(buffer);
}

/** Live guest EIP, unsigned. The single most-read CPU scalar in the worker. */
export function readEip(cpu: any): number {
    return cpuViews(cpu).instructionPointer[0] >>> 0;
}

/** Live guest ESP, unsigned. */
export function readEsp(cpu: any): number {
    return cpuViews(cpu).reg32[4] >>> 0;
}

/** Retired guest instructions (v86's 32-bit counter; wraps ~every 42 s at target MIPS, so
 *  callers must use an unsigned delta over a sub-quantum window). */
export function readRetiredInsns(cpu: any): number {
    return (cpuViews(cpu).instructionCounter[0] ?? 0) >>> 0;
}

/**
 * A/B INSTRUMENT — route the hot reads back through v86's `view()` Proxy.
 *
 * The plain-view conversion is structural, not a feature, so there is no natural "off".
 * This is the off: when armed, the call sites that were converted read through the Proxy
 * again, reproducing the per-access trap the conversion removed. That makes the two arms
 * one build and one load, which is what a paired A/B needs (§3.4).
 *
 * A mutable object rather than a function or a `globalThis` lookup: the per-thunk sites
 * read `.on`, one load off a monomorphic object, so the DISARMED arm is not itself a
 * measurement of the guard.
 *
 * What it does NOT reproduce: a handler that unwrapped the Proxy by hand before this round
 * (all of `locale.ts` did) stays fast in the armed arm too — as it was in the real
 * baseline. The armed arm is therefore a floor on the change, never an exaggeration of it.
 *
 * `setWorkerFlag('__v86ProxyBaseline', true)` / `resetWorkerFlags()`.
 */
export const PROXY_BASELINE = { on: false };

/** Re-read the worker flag into the cached object. Called where an arm is switched. */
export function syncProxyBaselineFlag(): boolean {
    PROXY_BASELINE.on = (globalThis as Record<string, unknown>)["__v86ProxyBaseline"] === true;
    return PROXY_BASELINE.on;
}

/** Drop the module cache (test teardown / a new v86 instance). */
export function resetCpuViews(): void {
    cachedBuffer = null;
    cachedViews = null;
}

// ─── WASM growth ledger ─────────────────────────────────────────────────────────
//
// How often the WASM buffer actually changes identity is the safety margin of every
// cached-view decision in the worker: a Proxy that re-resolves on every access is only
// earning its cost if the thing it guards against happens. This counts it.
//
// Deduplicated by buffer identity, so the several observers of the same event (this
// module's `ensure`, ThunkDispatcher.updateMemoryCache) record ONE growth between them.
// The first buffer ever seen is the initial mapping, not a growth.

export interface WasmGrowthEvent {
    /** Guest EIP at the moment the new buffer was first observed, when known. */
    eip: number;
    /** ms since worker start. */
    atMs: number;
    bytes: number;
    /** Growth in bytes over the previously observed buffer (0 for the first). */
    deltaBytes: number;
    /** Who observed it first. */
    by: string;
}

const MAX_GROWTH_EVENTS = 64;

let lastSeenBuffer: ArrayBufferLike | null = null;
let lastSeenBytes = 0;
let growthCount = 0;
let growthEvents: WasmGrowthEvent[] = [];
let ledgerSince = 0;

/**
 * Record that `buffer` is the live WASM buffer. Returns true when this call is the one
 * that observed a CHANGE (so a caller can log it once).
 *
 * `eip` is a hint only — pass 0 when the caller cannot read it cheaply.
 */
export function noteWasmBuffer(buffer: ArrayBufferLike, eip: number, by: string = "cpu-views"): boolean {
    if (lastSeenBuffer === buffer) return false;
    const bytes = buffer.byteLength;
    const first = lastSeenBuffer === null;
    const deltaBytes = first ? 0 : bytes - lastSeenBytes;
    lastSeenBuffer = buffer;
    lastSeenBytes = bytes;
    if (first) {
        ledgerSince = performance.now();
        return true;
    }
    growthCount++;
    if (growthEvents.length < MAX_GROWTH_EVENTS) {
        growthEvents.push({ eip: eip >>> 0, atMs: performance.now(), bytes, deltaBytes, by });
    }
    return true;
}

export interface WasmGrowthStats {
    /** Buffer-identity changes AFTER the initial mapping — i.e. actual grows. */
    growths: number;
    /** Live buffer size. */
    bytes: number;
    /** ms covered by this ledger. */
    windowMs: number;
    /** Up to MAX_GROWTH_EVENTS; a longer run truncates rather than ring-buffers, because
     *  the interesting question is WHEN THEY STOP, which the head answers. */
    events: WasmGrowthEvent[];
    truncated: boolean;
}

export function getWasmGrowthStats(): WasmGrowthStats {
    return {
        growths: growthCount,
        bytes: lastSeenBytes,
        windowMs: ledgerSince === 0 ? 0 : performance.now() - ledgerSince,
        events: growthEvents.slice(),
        truncated: growthCount > growthEvents.length,
    };
}

/** Start a fresh measurement window. The live buffer is re-observed as the INITIAL
 *  mapping, so the count that follows is "grows since the reset", not one more. */
export function resetWasmGrowthStats(): void {
    growthCount = 0;
    growthEvents = [];
    lastSeenBuffer = null;
    lastSeenBytes = 0;
    ledgerSince = performance.now();
}
