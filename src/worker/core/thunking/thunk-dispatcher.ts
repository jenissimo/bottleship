import { ThunkGenerator, ThunkStub } from './thunk-generator';
import { CallbackManager } from './callback-manager';
import { Logger, LogCategory } from '../logger';
import { System } from '../system';
import { profiler } from '../profiler';
import { frameProfiler } from '../frame-profiler';
import { ThunkMemoryManager, ThunkMemoryRegions, SEH_CATCH_COMPLETION_FUNCID } from './thunk-memory-manager';
import {
    writeShadowTrampoline,
    writeOwnerDisarmScalarTrampoline,
    writeStructCaptureTrampoline,
    writeUpDrawCaptureTrampoline,
} from '../../modules/d3d9/capture-trampolines';
import type { ShadowTrampolineSpec } from '../../modules/d3d9/capture-trampolines';
import { sehOnCatchCompletion } from '../seh-dispatch';
import { JMP_REL8, JMP_LOOP, HLT } from './thunk-constants';
import { parseStdcallCleanup, normalizeApiName } from './thunk-utils';
import { BusyWaitDetector } from './busy-wait-detector';
import { WinApiCallRing } from './winapi-call-ring';
import { dumpExceptionContext } from './exception-context-dumper';
import { guardStackWrite } from '../memory/stack-write-guard';
import * as DispatcherForensics from './dispatcher-forensics';
import { ERROR_NOT_SUPPORTED } from './thunk-errors';
import { thunkChecksumManager } from '../memory/thunk-checksum';
import { invalidateGuestCode } from '../memory/guest-code';
import { hypercallDataManager } from '../cpu/hypercall-data';
import { preemptionManager } from '../cpu/preemption-manager';
import { PF_HALT_TARGET } from '../bootloader';
import { faultRecorder, cr2RegisterCandidates, isFaultEipConsistent, analyzeIndirectCallFault } from '../memory/fault-recorder';
import { stubRegistry } from '../diagnostics/stub-registry';
import { apiCensus } from '../diagnostics/api-census';
import { MEM_THUNK_CODE_BASE, MEM_THUNK_DATA_BASE, MEM_THUNK_DATA_SIZE } from '../cpu/emulator-config';
import type { Scheduler } from '../scheduler/scheduler';
import { ThunkBoundaryKind } from '../scheduler/types';
import type { PendingAsyncRestoreDescriptor } from './types/async-restore';
import { TimeService } from '../../runtime/time';
import { debugSession } from '../debug/debug-session';
import { apiBreaks as harnessApiBreaks } from '../../harness/api-breaks';
import { memWriteTrap } from '../memory/mem-write-trap';
import {
    SEH_SCRATCH_LAYOUT,
    EH3_FILTER_CTX_LAYOUT,
    SEH_FRAME_LIST_MAX,
} from './seh-layout';
import { type SehFrameSnapshot } from '../tools/seh-postmortem';

export interface X86Context {
    eax: number; ecx: number; edx: number; ebx: number;
    esp: number; ebp: number; esi: number; edi: number;
    eip: number; eflags: number;
}

export type ThunkImplementation = (
    ctx: X86Context,
    memory: Uint8Array,
    args: number[]
) => number | Promise<number> | ThunkResult | Promise<ThunkResult>;

export type FastPathImplementation = (
    cpu: any,
    mem8: Uint8Array,
    mem32: Uint32Array,
    dataView: DataView
) => number | null | undefined;

/**
 * Tier-0 write-buffer drain handler.
 * Called during drainWriteBuffer() for each buffered entry.
 * @param mem8   - Guest memory byte view
 * @param mem32  - Guest memory u32 view (same buffer)
 * @param dataPtr - Byte offset in mem8 of first arg (funcId already consumed)
 */
export type WriteBufHandler = (mem8: Uint8Array, mem32: Uint32Array, dataPtr: number) => void;

/** writeBufArgCountTable sentinel: ring entry stride = (4 + vec4Count×4) × 4 bytes. */
export const WBUF_ARG_SHADER_CONSTANT = 255;

/** writeBufArgCountTable sentinel for captured UP draws: ring entry =
 *  [funcId][this][primType][primCount][stride][byteCount][payload…], stride = 24 + byteCount. */
export const WBUF_ARG_UP_DRAW = 254;

/**
 * Represents a write to be applied after async thunk completion.
 * Used to defer writes to output pointers until stack is in known-good state.
 */
export interface DeferredWrite {
    address: number;      // Guest memory address
    value: number;        // Value to write
    size: 1 | 2 | 4 | 8;  // Write size in bytes
}

export interface ThunkResult {
    value: number;
    stackCleanup?: number;
    suspendedForCallback?: boolean;
    callbackId?: number;
    terminated?: boolean;
    skipStackCheck?: boolean;
    blockedNoSwitch?: boolean;  // Thread is WAITING, redirect EIP to spin loop (no runnable peers)
    deferredWrites?: DeferredWrite[];  // Writes to apply after async completion
    dllInits?: Array<{ baseAddress: number; entryPoint: number; name: string }>;  // DllMains to invoke after async load
    sehTrampoline?: { base: number; end: number };  // Trampoline code range for SEH unwind (seh-dispatch.ts)
    /**
     * Async-only: defer initiation of a guest-callback chain to the safe apply point.
     * INVARIANT: an async thunk handler MUST NOT call CallbackManager.invokeCallback eagerly inside
     * its Promise body. The issuing thread is async-parked (WAITING at the spin loop); mutating the
     * live CPU there is lost when the saved spin-loop context is restored, and _onAsyncComplete's
     * return-to-guest restore then collides with the half-set-up callback frame (stack corruption →
     * bootloader escape 0x7c07). Instead return this. The apply point un-parks the thread (RUNNING,
     * CPU live at the spin loop — exactly where the dllInits DllMain chain runs) and calls it with the
     * genuine guest return frame captured at park, so the chain's saveSuspendedThunkContext records the
     * real caller and invokeCallback runs on a live, RUNNING CPU. Mirror of the dllInits mechanism,
     * generalized for any async-initiated callback chain (e.g. inproc-COM CoCreateInstance after a DLL load).
     */
    startCallbackChain?: (frame: { esp: number; returnAddr: number; mem: Uint8Array }) => boolean;
}

interface ActiveAsyncThunk {
    functionId: number; // Changed from string name to ID for perf
    functionName?: string;
    startTime: number;
    threadId?: number;
    asyncParkGeneration?: number;
    esp?: number;
    returnAddr?: number;
    stackSnapshot?: Uint8Array;
    spinAddr?: number;
    originalSpinBytes?: [number, number];
    /** Caller's module base at call time (for offset->linear patch on async return) */
    callerModuleBase?: number;
}

interface PendingAsyncRestore {
    info: ActiveAsyncThunk;
    returnValue: number;
    cleanupBytes: number;
    deferredWrites?: DeferredWrite[];
    dllInits?: Array<{ baseAddress: number; entryPoint: number; name: string }>;
    errorFlag: boolean;
    completionName: string;
    /** Deferred guest-callback chain (see ThunkResult.startCallbackChain). Applied at the safe point. */
    startCallbackChain?: (frame: { esp: number; returnAddr: number; mem: Uint8Array }) => boolean;
    /** Consecutive TRANSIENT validation failures (target stack page momentarily non-writable
     *  during CoW/decommit churn). Retried up to ASYNC_RESTORE_MAX_VALIDATION_RETRIES before
     *  escalating, so a transient miss doesn't discard the thread's only completion → park forever. */
    transientValidationRetries?: number;
}

interface SehFaultSignature {
    faultEip: number;
    faultAddr: number;
    generation: number;
}

/** Per-dispatch context for nested SEH/C++ exception dispatch. */
interface SehDispatchContext {
    generation: number;
    startEsp: number;
    scratchAddr: number;
    lastFaultSignature: SehFaultSignature | null;
    kind: 'av' | 'cxx';
}

// Configuration
const MAX_THUNK_ID = 65536; // Adjust based on your max expected ID
const DEFAULT_ARGS_COUNT = 16;
const SPIN_LOOP_ADDR_DEFAULT = 0x01F80000;

// Memory region constants for validation (fail-fast diagnostics)
const BOOTLOADER_START = 0x7c00;
const BOOTLOADER_END = 0x9000;
const STACK_REGION_START = 0x80000;
const STACK_REGION_END = 0x100000;
const GUEST_CODE_START = 0x100000;  // After LOW_MEM region
const THUNK_REGION_START = 0x10000000;
const THUNK_REGION_END = 0x11000000;

export class ThunkDispatcher {
    // --- DOD: Flat Arrays for O(1) Access ---
    private dispatchTable: Array<ThunkImplementation | null> = new Array(MAX_THUNK_ID).fill(null);
    private fastPathTable: Array<FastPathImplementation | null> = new Array(MAX_THUNK_ID).fill(null);

    // Metadata tables (SoA - Struct of Arrays) to avoid object lookups in hot path
    private argCountsTable: Int8Array = new Int8Array(MAX_THUNK_ID).fill(-1);
    // Stack cleanup bytes cache - avoids getStubById() Map lookup on hot path
    // -1 means not set (use argCount * 4 fallback)
    private stackCleanupTable: Int16Array = new Int16Array(MAX_THUNK_ID).fill(-1);
    // Debug info table (only accessed in slow path)
    private namesTable: Array<string | null> = new Array(MAX_THUNK_ID).fill(null);
    private thunkCallCounts: Uint32Array = new Uint32Array(MAX_THUNK_ID);
    // Slow-path profiling: counts per thunk name that hit _handlePortWriteSlow phase 6+
    // (fast path miss or no fast path registered). Used to identify fast-path candidates.
    // Gated by profileSlowPathEnabled — Map.set per slow-path thunk is expensive at >100K/s.
    private slowPathHitCounts: Map<string, number> = new Map();
    private profileSlowPathEnabled: boolean = false;
    private wasmMissWarned: Set<number> = new Set();
    // Static DLL forwarding table: source DLL > target DLL
    // shfolder.dll forwards all exports to shell32.dll on real Windows
    private static readonly DLL_FORWARDS: Record<string, string> = {
        'shfolder': 'shell32',
        'msvcr90': 'msvcrt',
    };
    private static readonly DLL_FORWARD_FUNCTIONS: Record<string, Record<string, string>> = {
        'msvcr90': {
            '__cxxframehandler3': '__CxxFrameHandler',
        },
    };
    // Trivial fast-path flag: 1 = skip scheduler boundary (state-setting thunks like SetRenderState).
    // Boundary still fires every TRIVIAL_BOUNDARY_INTERVAL calls or on Draw*/async thunks.
    private trivialFastPathTable: Uint8Array = new Uint8Array(MAX_THUNK_ID);
    private fastPathSinceLastBoundary = 0;

    // --- Tier-0 Write-Buffer Tables (parallel to fastPathTable) ---
    // Handlers called during drainWriteBuffer(); stubs use JMP trampoline instead of OUT trap.
    private writeBufHandlerTable: Array<WriteBufHandler | null> = new Array(MAX_THUNK_ID).fill(null);
    private writeBufArgCountTable: Uint8Array = new Uint8Array(MAX_THUNK_ID);
    private writeBufCoalesceMaskTable: Uint8Array = new Uint8Array(MAX_THUNK_ID);
    // Ring entries that OBSERVE buffered state (draw calls): the coalescer must not
    // apply a later same-key setter across one — it splits the ring into segments.
    private writeBufBarrierTable: Uint8Array = new Uint8Array(MAX_THUNK_ID);
    // Write-buffer ring addresses (populated from thunkMemoryManager regions)
    private writeBufControlAddr = 0;
    private writeBufDataBase = 0;
    private writeBufCapacity = 0;
    private writeBufTrampolineAddrs: number[] = [];

    // --- Cached Singletons to avoid GC ---
    private busyWaitDetector = new BusyWaitDetector();
    private fastPathCallCount = 0; // For sampling fast path history
    /** When non-null, record every fast-path call (name → count +
     *  last return value). Fast-path thunks (GetTickCount/QPC/PeekMessage/timeGetTime)
     *  bypass the WinApi ring, so this is the only window into the per-frame polls the
     *  intro uses to decide whether to advance. Null = zero overhead. */
    public dbgFastPathRec: Map<number, { count: number; lastRet: number; lastCaller: number }> | null = null;
    private reusableContext: X86Context = {
        eax: 0, ecx: 0, edx: 0, ebx: 0,
        esp: 0, ebp: 0, esi: 0, edi: 0,
        eip: 0, eflags: 0
    };
    // Pre-allocate array for args to avoid `new Array()` every frame
    // V8 loves fixed size arrays with integers
    private reusableArgs: number[] = new Array(32).fill(0);

    // Cached Memory Views
    private cachedMem8: Uint8Array | null = null;
    private cachedDataView: DataView | null = null;
    private cachedMem32: Uint32Array | null = null;
    private memLength: number = 0;

    // Cached CPU + Scheduler references (set once at init, avoids property chain + singleton on every call)
    private cachedCpu: any = null;
    private cachedReg32: Int32Array | null = null;
    private cachedInstructionPointer: Int32Array | null = null;
    private cachedFlags: Int32Array | null = null;
    private cachedScheduler: Scheduler | null = null;

    // Direct Int32Array views into wasm_memory.buffer, bypassing v86's view() Proxy (which
    // allocates a fresh typed array on every indexed access — see vendor/v86/src/lib.js:17).
    // Offsets are fixed by v86's CPU state layout (vendor/v86/src/cpu.js:64,120,556,736).
    // Rebuilt in updateMemoryCache() when mem8.buffer changes (WASM memory growth).
    private cachedReg32Raw: Int32Array | null = null;
    private cachedIpRaw: Int32Array | null = null;
    private cachedFlagsRaw: Int32Array | null = null;
    private cachedSegOffsetsRaw: Int32Array | null = null;
    private cachedWasmBuffer: ArrayBufferLike | null = null;

    // Deferred JIT invalidations for WBUF stubs patched before cachedCpu was available

    private v86: any;
    private thunkGenerator: ThunkGenerator;
    private _callbackManager: CallbackManager | null = null;
    private getMemory: (() => Uint8Array) | null = null;

    private activeAsyncThunks: Map<Promise<number | ThunkResult>, ActiveAsyncThunk> = new Map();
    private pendingAsyncRestores: PendingAsyncRestore[] = [];

    // Async-park telemetry: per-thunk wall-clock spent parked (spin loop) per thread.
    // This is the idle-classification instrument — names which async thunk drives the
    // worker idle (e.g. GetMessage) and how long its parks last. Always-on; one
    // Map.get/set per async-thunk completion (~hundreds/sec) is negligible.
    private asyncParkStats: Map<string, {
        count: number; totalMs: number; maxMs: number;
        byTid: Map<number, { count: number; totalMs: number }>;
        buckets: { le1: number; le5: number; le16: number; le50: number; gt50: number };
    }> = new Map();
    private asyncParkStatsSince = performance.now();

    private recordAsyncPark(name: string, tid: number, parkMs: number): void {
        if (!(parkMs >= 0) || !Number.isFinite(parkMs)) return;
        let s = this.asyncParkStats.get(name);
        if (!s) {
            s = { count: 0, totalMs: 0, maxMs: 0, byTid: new Map(),
                  buckets: { le1: 0, le5: 0, le16: 0, le50: 0, gt50: 0 } };
            this.asyncParkStats.set(name, s);
        }
        s.count++;
        s.totalMs += parkMs;
        if (parkMs > s.maxMs) s.maxMs = parkMs;
        if (parkMs <= 1) s.buckets.le1++;
        else if (parkMs <= 5) s.buckets.le5++;
        else if (parkMs <= 16) s.buckets.le16++;
        else if (parkMs <= 50) s.buckets.le50++;
        else s.buckets.gt50++;
        let t = s.byTid.get(tid);
        if (!t) { t = { count: 0, totalMs: 0 }; s.byTid.set(tid, t); }
        t.count++;
        t.totalMs += parkMs;
    }

    // Pending registrations for stubs that aren't created yet
    private pendingRegistrations: Map<string, { impl: ThunkImplementation; dllName: string; functionName: string }> = new Map();
    private pendingFastPathRegistrations: Map<string, { impl: FastPathImplementation; dllName: string; functionName: string; trivial?: boolean }> = new Map();
    private pendingWriteBufRegistrations: Map<string, { handler: WriteBufHandler; dllName: string; functionName: string; argCount: number; isStdcall: boolean; ptrDeref?: boolean; floatCount?: number; shaderConstant?: boolean; coalesceArgMask?: number; shadowSpec?: ShadowTrampolineSpec; barrier?: boolean; structCapture?: { ptrArgIndex: number; payloadDwords: number }; upDraw?: boolean; ownerDisarm?: boolean }> = new Map();
    private pendingConstStubRegistrations: Map<string, { dllName: string; functionName: string; value: number; popBytes: number }> = new Map();

    /** Shared "active owner" pointer (guest RAM) for setter-shadow trampolines (the bound COM
     *  device `this`). Allocated lazily on first shadowed registration; seeded via setShadowOwner. */
    private shadowOwnerGlobal = 0;
    /** Per-(dll:func) shadow trampoline handles, for the registering module to seed/invalidate/A-B. */
    private shadowHandles = new Map<string, { trampAddr: number; shadowBase: number; slotCount: number; sentinel: number; skipCounterAddr: number }>();

    // Virtual time compensation: credit wall-clock time spent in sync thunk handlers.
    // Without this, sync thunks (which replaced async spin-loop thunks) create a virtual
    // time deficit � game sees too little time passing > lag compensation speeds up simulation.
    private cachedTimeService: TimeService | null = null;

    // Diagnostics
    private lastThunkId = 0;
    private lastThunkName: string | null = null;
    private lastThunkTime = 0;
    private thunkCount = 0;
    /** Ring buffer of recent WinAPI calls for crash forensics (raw numbers, lazy formatting). */
    private winApiRing = new WinApiCallRing(this.namesTable);
    // ── Hypercall ring (crash-hunt): EVERY OUT 0xB077 incl. fast-path Tier 1-3 (memcpy/
    // memset/CS/strings) which winApiRing (slow-path only) misses. Zero-alloc flat rings;
    // formatted lazily in getLastHypercalls(). Read via `report` (lastHypercalls).
    private hcRingId = new Int32Array(256);
    private hcRingThread = new Int32Array(256);
    private hcRingCaller = new Int32Array(256);
    private hcRingHead = new Int32Array(256);   // guest [hcWatchAddr] at each hypercall
    private hcRingPos = 0;
    hcWatchAddr = 0;                            // set from harness to sample a guest dword per hypercall
    // Default OFF: recording every hypercall (incl. fast-path Tier 1-3) is measurable on the
    // hottest path (~5 typed-array writes + a DataView read per OUT 0xB077). Armed by the
    // `headWatch` harness verb for crash-hunt; the slow-path winApiRing still feeds the fault
    // snapshot for ordinary sessions, so nothing user-facing is lost when this is off.
    hcRingEnabled = false;
    private profilerSampleCounter = 0;
    private readonly profilerSampleMask = 0x3FF;
    private hotThunkProfileSampleCounter = 0;
    private readonly hotThunkProfileSampleMask = 0x3F;
    private readonly sampledProfilerThunks = new Set([
        "winmm:timegettime",
        "user32:isiconic",
        "user32:peekmessagea",
        "user32:peekmessagew",
        "kernel32:entercriticalsection",
        "kernel32:leavecriticalsection",
    ]);
    private readonly checksumIntervalMs = 500;
    private nextChecksumAt = 0;
    private checksumInProgress = false;
    private thunkMemoryManager: ThunkMemoryManager | null = null;
    private spinLoopAddress: number = SPIN_LOOP_ADDR_DEFAULT;
    private sehDispatchStubAddress = 0;
    private sehFilterStubAddress = 0;
    private sehScratchAddr = 0;
    private sehScratchSize = 0;
    private sehStackBase = 0;
    private sehStackTop = 0;
    private sehDispatchStack: SehDispatchContext[] = [];
    private sehDispatchGeneration = 0;
    private sehRuntimePinned = false;
    private unhandledExceptionFilterAddr = 0;
    private callbackStubPoolBase = 0;
    private callbackStubPoolEnd = 0;
    private thunkGeneratorBase = 0;
    private thunkGeneratorEnd = 0;

    /** Expected ESP after previous thunk's RET N � used to catch wrong argCount (stack corruption) */
    private lastExpectedEspAfterReturn = 0;
    private lastThunkIdAfterReturn = 0;
    private lastThunkNameAfterReturn = "";

    /** Per-thread ESP tracking - flat typed arrays for zero-allocation thread switching.
     *  Index = threadId. Max 128 threads supported. */
    private static readonly MAX_THREADS = 128;
    private espPerThread: Uint32Array = new Uint32Array(ThunkDispatcher.MAX_THREADS);   // [threadId] = expectedEsp
    private thunkIdPerThread: Uint16Array = new Uint16Array(ThunkDispatcher.MAX_THREADS); // [threadId] = lastThunkId
    /** String names still kept in sparse array for error logging only (not hot path) */
    private thunkNamePerThread: Array<string> = new Array(ThunkDispatcher.MAX_THREADS).fill("");
    private currentThreadId = 1; // Default to thread 1 (main thread)

    /** Current thread's stack bounds, refreshed on every onThreadSwitch (zero hot-path
     *  cost). Used by the ESP-sanity tripwire to flag a thunk entered with ESP outside
     *  its thread's stack — the signature of control-flow/stack corruption (see the
     *  Re-Volt mac 0x4100: ESP jumped to 0x3f64xxxx, far outside [stackBase,stackTop)).
     *  0/0 = unknown (don't check). */
    private curStackBase = 0;
    private curStackTop = 0;
    /** Most recent "thunk entered with wild ESP" note, surfaced in the crash report so
     *  the exact corrupting call (thunk name + ESP + thread) lands in the error window.
     *  Diagnostic only — NON-FATAL (a fatal gate would risk false-positives on legit
     *  alternate stacks, e.g. fibers, which we can't runtime-verify here). */
    private lastWildEspNote: string | null = null;

    /** Most recent "thunk entered with wild EBP" note, surfaced in the crash report.
     *  Sibling of {@link lastWildEspNote}: a guest frame pointer (EBP) must never point
     *  into the synthetic emulator band (>= MEM_THUNK_CODE_BASE: THUNK_CODE / CALLBACK_STUB /
     *  THUNK_DATA / SPIN_LOOP) — guest images/stacks/heap all sit below it. A `pop ebp` that
     *  loads such a value means a transient ESP misalignment grabbed the wrong stack slot
     *  (the Re-Volt mac wedge: EBP=0x2130d16 inside the thunk band while the real saved-EBP
     *  chain was intact on the stack). Diagnostic only — NON-FATAL. */
    private lastWildEbpNote: string | null = null;

    /** Most recent async-restore RET N mismatch note, surfaced in the crash report. Set when
     *  {@link _restoreAsyncContext} found v86 had already executed a stub `RET N` that disagrees
     *  with the recorded cleanupBytes (the wrong/double-RET-N corruption vector). An explicit
     *  field — not just a log line — so it lands in the copyable crash report directly. */
    private lastAsyncRetMismatchNote: string | null = null;

    // Shadow stack guard ring for thunk return invariants.
    private static readonly SHADOW_STACK_RING_SIZE = 64;
    // Shadow-stack guard ring as parallel typed arrays (SoA). recordShadowStackGuard
    // runs on EVERY thunk (fast AND slow path); the old object-literal-per-entry ring
    // allocated ~480K objects/sec under NFSU and was a measurable GC driver (~2-3%).
    // Preallocated slots → zero allocation on the hot path.
    private ssTs = new Float64Array(ThunkDispatcher.SHADOW_STACK_RING_SIZE);
    private ssThreadId = new Uint32Array(ThunkDispatcher.SHADOW_STACK_RING_SIZE);
    private ssThunkId = new Uint32Array(ThunkDispatcher.SHADOW_STACK_RING_SIZE);
    private ssEspEntry = new Uint32Array(ThunkDispatcher.SHADOW_STACK_RING_SIZE);
    private ssExpectedPost = new Uint32Array(ThunkDispatcher.SHADOW_STACK_RING_SIZE);
    private ssRetAddr = new Uint32Array(ThunkDispatcher.SHADOW_STACK_RING_SIZE);
    private shadowStackRingCount = 0; // valid entries, saturates at SHADOW_STACK_RING_SIZE
    private shadowStackRingIdx = 0;

    /** Caller's module base (from return address at entry) � used when patching segment offset to linear (DLL/codec) */
    private lastCallerModuleBase = 0;

    // Flags
    private isWaitingForEipDump: boolean = false;

    constructor(v86: any, thunkGenerator: ThunkGenerator) {
        this.v86 = v86;
        this.thunkGenerator = thunkGenerator;
        // Arrays already initialized above

        this.v86.add_listener('emulator-ready', () => {
            Logger.log(LogCategory.SYSTEM, 'v86 emulator ready, setting up IO hook');
            this.updateMemoryCache(); // Init cache
            this.setupPortHook();
        });

        // Lightweight caller backtrace for the MemoryManager large-alloc log
        // (process.ts logLargeEvent). Top module-labelled frames only, shallow scan,
        // no allocation churn — lets the allocator attribute each ≥64KB block to its
        // caller module (Storm/Fog/CRT) without importing the dispatcher.
        (globalThis as any).__guestBtLite = (): string => {
            try {
                const bt = this.getGuestCallStack(undefined, 0x200, 6);
                return bt.frames.slice(0, 6)
                    .map(f => f.moduleName ? `${f.moduleName}+0x${f.moduleOffset.toString(16)}` : `0x${f.retAddr.toString(16)}`)
                    .join(' <- ');
            } catch { return ''; }
        };
    }

    /**
     * Safely check if DataView is valid (not detached)
     * We check through cachedMem8 to avoid accessing byteLength on detached DataView
     */
    private isDataViewValid(): boolean {
        if (!this.cachedDataView || !this.cachedMem8) return false;
        // Check through cachedMem8, as reading byteLength on detached DataView throws error
        try {
            return this.cachedMem8.byteLength > 0 &&
                this.cachedDataView.buffer === this.cachedMem8.buffer;
        } catch {
            return false; // Buffer is detached
        }
    }

    public clearStackCheck(): void {
        this.lastThunkNameAfterReturn = "";
    }

    /**
     * What a thunk id will actually do when called: the handler's declared parameter
     * count and the export's declared argument count, or null when nothing is
     * registered (the dispatcher would answer ERROR_NOT_SUPPORTED).
     *
     * Lets a caller that only holds an ADDRESS — GetProcAddress handing a stub back to
     * the guest — say whether that address leads to a real handler, to a stub, or to a
     * handler that ignores the arguments it was given. Read-only; no dispatch effects.
     */
    public getImplementationInfo(functionId: number): { arity: number; argCount: number } | null {
        const impl = this.dispatchTable[functionId];
        if (!impl) return null;
        const argCount = this.argCountsTable[functionId];
        return { arity: impl.length, argCount: argCount < 0 ? -1 : argCount };
    }

    /**
     * Call this whenever emulator memory buffer might have changed (resize/init)
     */
    public updateMemoryCache(): void {
        // cachedMem8 MUST stay v86's always-live Proxy: the dispatcher detects WASM growth by
        // comparing the live buffer (cachedMem8.buffer, re-resolved by the Proxy) against its
        // cached DataView/Int32 views' buffers (isDataViewValid). It also writes the guest stack
        // / return EIP through this view AFTER a thunk may have re-entered the guest (WndProc
        // callbacks) and grown memory. A plain snapshot here silently drops those post-grow
        // writes into a detached buffer → corrupt return → 0x7c07 escape-to-bootloader. The
        // plain (JIT-fast) view is taken at the leaf hot loops instead (synchronous, no re-entry).
        const mem8 = this.getMemory ? this.getMemory() : (this.v86.mem8 || (this.v86.v86 && this.v86.v86.cpu.mem8));
        if (mem8 && mem8.byteLength > 0) {
            this.cachedMem8 = mem8;
            this.memLength = mem8.length;
            // Only recreate DataView if buffer changed or was detached
            // Use cachedMem8.byteLength check instead of cachedDataView.byteLength to avoid errors
            if (!this.cachedDataView || this.cachedDataView.buffer !== mem8.buffer || (this.cachedMem8 && this.cachedMem8.byteLength === 0)) {
                this.cachedDataView = new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);
            }
            if ((mem8.byteOffset & 3) === 0) {
                const length32 = mem8.byteLength >>> 2;
                if (!this.cachedMem32 ||
                    this.cachedMem32.buffer !== mem8.buffer ||
                    this.cachedMem32.byteOffset !== mem8.byteOffset ||
                    this.cachedMem32.length !== length32) {
                    this.cachedMem32 = new Uint32Array(mem8.buffer, mem8.byteOffset, length32);
                }
            } else {
                this.cachedMem32 = null;
            }

            // Direct CPU-state views. mem8.buffer === wasm_memory.buffer (v86 routes both
            // mem8 and reg32 through the same wasm linear memory). Rebuild when the buffer
            // identity changes (WebAssembly.Memory growth detaches the old ArrayBuffer).
            if (this.cachedWasmBuffer !== mem8.buffer) {
                this.cachedWasmBuffer = mem8.buffer;
                this.cachedReg32Raw      = new Int32Array(mem8.buffer, 64,  8);
                this.cachedFlagsRaw      = new Int32Array(mem8.buffer, 120, 1);
                this.cachedIpRaw         = new Int32Array(mem8.buffer, 556, 1);
                this.cachedSegOffsetsRaw = new Int32Array(mem8.buffer, 736, 8);
            }
        }
    }

    initializeCallbackManager(getMemory: () => Uint8Array, thunkMemoryManager?: ThunkMemoryManager): void {
        this.getMemory = getMemory;
        this.updateMemoryCache(); // Ensure cache is valid
        this.thunkMemoryManager = thunkMemoryManager || null;

        if (thunkMemoryManager) {
            const regions = thunkMemoryManager.getRegions();
            const oldSpinLoop = this.spinLoopAddress;
            this.spinLoopAddress = regions.spinLoopAddress;
            this.sehDispatchStubAddress = regions.sehDispatchStubAddress;
            this.sehFilterStubAddress = regions.sehFilterStubAddress;
            this.sehScratchAddr = regions.sehScratchAddr;
            this.sehScratchSize = regions.sehScratchSize;
            this.sehStackBase = regions.sehStackBase;
            this.sehStackTop = regions.sehStackTop;
            this.thunkGeneratorBase = regions.thunkGeneratorBase;
            this.thunkGeneratorEnd = regions.thunkGeneratorBase + regions.thunkGeneratorSize;

            // Tier-0 write-buffer addresses
            this.writeBufControlAddr = regions.writeBufControlAddr;
            this.writeBufDataBase    = regions.writeBufDataBase;
            this.writeBufCapacity    = regions.writeBufCapacity;
            this.writeBufTrampolineAddrs = regions.writeBufTrampolineAddrs
                ? [...regions.writeBufTrampolineAddrs]
                : [];
            if (this.writeBufTrampolineAddrs.length > 0) {
                // Conservative trampoline code range for the drain race guard.
                // Trampolines are written sequentially; shader-constant WBUF copies inline
                // and is longer than the scalar/ptr-deref variants.
                this.wbufTrampLo = Math.min(...this.writeBufTrampolineAddrs);
                this.wbufTrampHi = Math.max(...this.writeBufTrampolineAddrs) + 256;
            }

            Logger.verbose(LogCategory.THUNK,
                `initializeCallbackManager: spinLoopAddress 0x${oldSpinLoop.toString(16)} > 0x${this.spinLoopAddress.toString(16)}`);
        }

        this._callbackManager = new CallbackManager(this.v86, this.thunkGenerator, getMemory);
        this._callbackManager.initialize(thunkMemoryManager);
        const stubPoolRange = this._callbackManager.getStubPoolRange();
        this.callbackStubPoolBase = stubPoolRange.base;
        this.callbackStubPoolEnd = stubPoolRange.end;
    }

    get callbackManager(): CallbackManager {
        if (!this._callbackManager) {
            throw new Error('CallbackManager not initialized. Call initializeCallbackManager first.');
        }
        return this._callbackManager;
    }

    /**
     * Called by Scheduler when switching threads.
     * Saves current thread's ESP tracking and restores new thread's state.
     */
    onThreadSwitch(oldThreadId: number, newThreadId: number): void {
        const maxT = ThunkDispatcher.MAX_THREADS;
        // Save current thread's ESP tracking state (flat typed array, zero-alloc)
        if (oldThreadId > 0 && oldThreadId < maxT) {
            this.espPerThread[oldThreadId] = this.lastExpectedEspAfterReturn;
            this.thunkIdPerThread[oldThreadId] = this.lastThunkIdAfterReturn;
            this.thunkNamePerThread[oldThreadId] = this.lastThunkNameAfterReturn;
            Logger.verboseLazy(LogCategory.THUNK, () =>
                `?? Thread switch ${oldThreadId}>${newThreadId}: Saved ESP=0x${this.lastExpectedEspAfterReturn.toString(16)}, last=${this.lastThunkNameAfterReturn}`);
        }

        // Restore new thread's ESP tracking state
        if (newThreadId > 0 && newThreadId < maxT) {
            this.lastExpectedEspAfterReturn = this.espPerThread[newThreadId];
            this.lastThunkIdAfterReturn = this.thunkIdPerThread[newThreadId];
            this.lastThunkNameAfterReturn = this.thunkNamePerThread[newThreadId] || "";
            Logger.verboseLazy(LogCategory.THUNK, () =>
                `?? Thread ${newThreadId}: Restored ESP=0x${this.lastExpectedEspAfterReturn.toString(16)}, last=${this.lastThunkNameAfterReturn}`);
        } else {
            // Thread ID out of range - reset tracking
            this.lastExpectedEspAfterReturn = 0;
            this.lastThunkIdAfterReturn = 0;
            this.lastThunkNameAfterReturn = "";
        }

        this.currentThreadId = newThreadId;

        // Refresh cached stack bounds for the ESP-sanity tripwire (zero hot-path cost —
        // only on switch). Unknown bounds (0/0) disable the check for that thread.
        const bounds = this.cachedScheduler?.getThreadStackBounds?.(newThreadId);
        this.curStackBase = bounds ? bounds.base >>> 0 : 0;
        this.curStackTop = bounds ? bounds.top >>> 0 : 0;
    }

    // === Scheduler Hooks ===

    /** Ensure cachedScheduler is populated (lazy init for cases where scheduler starts after port hook) */
    private ensureScheduler(): Scheduler {
        if (!this.cachedScheduler) {
            this.cachedScheduler = System.getInstance().scheduler;
        }
        return this.cachedScheduler;
    }

    /**
     * Call the scheduler's onThunkEnter hook.
     */
    private callSchedulerOnThunkEnter(cpu: any): void {
        this.ensureScheduler().onThunkEnter();
    }

    // Boundary state: set before calling notifySchedulerBoundary()
    private boundaryKind: ThunkBoundaryKind = ThunkBoundaryKind.THUNK_STUB;
    private boundaryCleanup: number = 0;

    /** Try to ensure cachedMem8 and cachedDataView are valid. Returns true if valid. */
    private ensureValidMemory(): boolean {
        if (!this.cachedMem8 || this.cachedMem8.byteLength === 0 || !this.isDataViewValid()) {
            this.updateMemoryCache();
        }
        return !!(this.cachedMem8 && this.cachedMem8.byteLength > 0 && this.isDataViewValid());
    }

    /** Common error-exit for suspended-thunk validation failures: zero EAX + THUNK_STUB boundary. */
    private handleSuspendedThunkError(cpu: any, cleanup: number): void {
        cpu.reg32[0] = 0;
        this.boundaryKind = ThunkBoundaryKind.THUNK_STUB;
        this.boundaryCleanup = cleanup;
    }

    /** Shared tail for fast-path sync thunk completion: ESP tracking, shadow stack, boundary notify. */
    private completeFastPathSync(functionId: number, espAtEntry: number, cleanupBytes: number, cpu: any): void {
        this.lastExpectedEspAfterReturn = espAtEntry + 4 + cleanupBytes;
        this.lastThunkIdAfterReturn = functionId;
        this.recordShadowStackAtEntry(functionId, espAtEntry);
        this.boundaryKind = ThunkBoundaryKind.THUNK_STUB;
        this.boundaryCleanup = cleanupBytes;

        // Deferred boundary: trivial state-setting thunks skip the scheduler boundary
        // unless we've accumulated enough calls. Draw* and async thunks always notify.
        if (this.trivialFastPathTable[functionId]) {
            if (++this.fastPathSinceLastBoundary < 16) return;
        }
        this.fastPathSinceLastBoundary = 0;
        this.notifySchedulerBoundary(cpu);
    }

    /**
     * Notify the scheduler of a thunk boundary.
     * Uses boundaryKind + boundaryCleanup set by the caller.
     */
    private notifySchedulerBoundary(cpu: any): void {
        this.ensureScheduler().onThunkBoundary(cpu, this.boundaryKind, this.boundaryCleanup);
    }

    /** Set boundary state and immediately notify the scheduler. */
    private setBoundaryAndNotify(cpu: any, kind: ThunkBoundaryKind, cleanup: number): void {
        this.boundaryKind = kind;
        this.boundaryCleanup = cleanup;
        this.notifySchedulerBoundary(cpu);
    }

    /**
     * Dump callback-manager and callback-queue forensic state.
     * Called only on critical faults to keep hot path clean.
     */
    private logCallbackForensics(reason: string): void {
        // Cold-path forensic dump — see dispatcher-forensics.ts.
        DispatcherForensics.logCallbackForensics(this, reason);
    }

    public dumpCriticalForensics(reason: string): void {
        this.logCallbackForensics(reason);
        this.dumpShadowStackGuard(reason);
    }

    /**
     * Forensic call-stack dump for a *clean* process/thread exit (ExitProcess,
     * FatalAppExit, last-thread ExitThread). Unlike the fault path this is not a
     * trap, so the worker `error` snapshot never fires — yet "the game vanished"
     * (e.g. a CRT exit()/__amsg_exit graceful-abort) is exactly when we most want
     * to know who called exit. Logs the last WinAPI calls + a module-labelled
     * reconstructed call stack (deep scan), reusing the same primitives as the
     * exception dumper. `esp` defaults to the live CPU esp when omitted.
     */
    public dumpExitCallStack(reason: string, esp?: number): void {
        // Cold-path forensic dump — see dispatcher-forensics.ts.
        DispatcherForensics.dumpExitCallStack(this, reason, esp);
    }

    /**
     * Data-returning guest call-stack reconstruction — the on-demand backbone for
     * the harness `backtrace` verb and for enriching API-break / fault snapshots.
     * Reuses reconstructCallStack (module-labelled, deep scan). `esp` defaults to
     * the live cached CPU esp. Pure read; safe to call any time.
     */
    public getGuestCallStack(esp?: number, scanBytes: number = 0x800, maxFrames: number = 48): {
        esp: number;
        lastThunk: string;
        recent: string[];
        frames: Array<{ index: number; stackOffset: number; retAddr: number; moduleName: string | null; moduleOffset: number; isThunk: boolean }>;
    } {
        const espVal = (esp ?? this.cachedReg32?.[4] ?? 0) >>> 0;
        const lastThunk = this.lastThunkName || '';
        const recent = this.getLastWinApiCalls(48, { includeNoisy: true });
        const mem8 = this.cachedMem8;
        if (!mem8 || !espVal) return { esp: espVal, lastThunk, recent, frames: [] };
        const view = (this.isDataViewValid() && this.cachedDataView)
            ? this.cachedDataView
            : new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);
        const raw = this.reconstructCallStack(espVal, mem8, view, scanBytes, maxFrames);
        return { esp: espVal, lastThunk, recent, frames: raw.map((f, index) => ({ index, ...f })) };
    }

    /**
     * Check if function ID is the thread exit stub.
     */
    private isSchedulerThreadExitId(functionId: number): boolean {
        return this.ensureScheduler().isThreadExitId(functionId);
    }

    /**
     * Handle thread exit stub.
     */
    private handleSchedulerThreadExitStub(cpu: any, mem: Uint8Array): void {
        this.ensureScheduler().handleThreadExitStub(cpu, mem);
    }

    // =========================================================================
    // Tier-0 Write-Buffer Drain
    // =========================================================================

    /**
     * Drain the Tier-0 write-buffer ring and invoke registered handlers.
     * Called at the top of handlePortWrite() so state changes are applied before
     * any flush trigger (DrawPrimitive, glEnd, wglSwapBuffers, etc.) executes.
     *
     * Cost when ring is empty: one branch + one u32 read (~2 ns).
     */
    private wbufDrainCount = 0;
    private wbufFrameDrainCalls = 0;
    private wbufFrameEntries = 0;
    private wbufFrameCounter = 0;
    private wbufMissLogCount = 0; // Limit WBUF miss diagnostics
    // Telemetry (cumulative): how often WBUF-registered funcIds drain vs fall to OUT trap.
    // Use getWbufStats() from DevTools after a game run.
    private wbufHitsTotal = 0;         // entries drained from the ring
    private wbufOutTrapHitsTotal = 0;  // WBUF-registered funcIds that still hit handlePortWrite
    private wbufCoalescedSkipsTotal = 0; // WBUF entries superseded within the same drain
    private wbufBarrierEntriesTotal = 0; // barrier (draw) entries drained from the ring
    /** Drained-up-to watermark (byte offset into the ring). Entries in [wbufTail, head)
     *  are pending; [0, wbufTail) have been applied. The guest head is only reset to 0
     *  when the ring is fully drained AND no preempted thread sits inside a trampoline
     *  (mid-entry write with a stale head in EDX) — resetting under such a thread used
     *  to orphan its entry → lost SetTexture/SetRenderState → one-frame surface flicker. */
    private wbufTail = 0;
    private wbufResetDeferredTotal = 0; // times the head reset was blocked by a mid-trampoline thread
    private wbufTrampLo = 0;
    private wbufTrampHi = 0;
    private wbufCoalesceCap = 0;
    private wbufCoalesceUsed: Uint32Array = new Uint32Array(0);
    private wbufCoalesceKey0: Uint32Array = new Uint32Array(0);
    private wbufCoalesceKey1: Uint32Array = new Uint32Array(0);
    private wbufCoalesceKey2: Uint32Array = new Uint32Array(0);
    private wbufCoalesceKey3: Uint32Array = new Uint32Array(0);
    private wbufCoalesceOffset: Int32Array = new Int32Array(0);
    private wbufCoalesceEpoch = 1;
    private wbufCoalescingEnabled = false;

    private ensureWbufCoalesceCapacity(entryBudget: number): void {
        let cap = 256;
        const want = Math.max(256, entryBudget * 2);
        while (cap < want) cap <<= 1;
        if (this.wbufCoalesceCap >= cap) return;
        this.wbufCoalesceCap = cap;
        this.wbufCoalesceUsed = new Uint32Array(cap);
        this.wbufCoalesceKey0 = new Uint32Array(cap);
        this.wbufCoalesceKey1 = new Uint32Array(cap);
        this.wbufCoalesceKey2 = new Uint32Array(cap);
        this.wbufCoalesceKey3 = new Uint32Array(cap);
        this.wbufCoalesceOffset = new Int32Array(cap);
    }

    private beginWbufCoalesce(entryBudget: number): void {
        this.ensureWbufCoalesceCapacity(entryBudget);
        this.wbufCoalesceEpoch++;
        if (this.wbufCoalesceEpoch === 0xffffffff) {
            this.wbufCoalesceUsed.fill(0);
            this.wbufCoalesceEpoch = 1;
        }
    }

    private wbufCoalesceHash(k0: number, k1: number, k2: number, k3: number): number {
        let h = Math.imul(k0 ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
        h = Math.imul(h ^ k1, 0xc2b2ae35) >>> 0;
        h = Math.imul(h ^ k2, 0x27d4eb2d) >>> 0;
        h = Math.imul(h ^ k3, 0x165667b1) >>> 0;
        return h >>> 0;
    }

    private wbufCoalesceSlot(k0: number, k1: number, k2: number, k3: number): number {
        const mask = this.wbufCoalesceCap - 1;
        let slot = this.wbufCoalesceHash(k0, k1, k2, k3) & mask;
        while (this.wbufCoalesceUsed[slot] === this.wbufCoalesceEpoch) {
            if (
                this.wbufCoalesceKey0[slot] === k0 &&
                this.wbufCoalesceKey1[slot] === k1 &&
                this.wbufCoalesceKey2[slot] === k2 &&
                this.wbufCoalesceKey3[slot] === k3
            ) {
                return slot;
            }
            slot = (slot + 1) & mask;
        }
        return slot;
    }

    private wbufCoalescePut(mem32: Uint32Array, dataPtr: number, funcId: number, mask: number, offset: number, segment: number): void {
        const w = dataPtr >> 2;
        // Segment (barrier count so far) in the high half: same-key setters on opposite
        // sides of a draw must NOT coalesce. funcId < MAX_THUNK_ID (65536) fits low 16 bits;
        // a 512 KiB ring holds < 2^16 entries, so segment can't wrap within one drain.
        const k0 = (funcId | (segment << 16)) >>> 0;
        const k1 = (mask & 1) ? (mem32[w] >>> 0) : 0;
        const k2 = (mask & 2) ? (mem32[w + 1] >>> 0) : 0;
        const k3 = (mask & 4) ? (mem32[w + 2] >>> 0) : 0;
        const slot = this.wbufCoalesceSlot(k0, k1, k2, k3);
        this.wbufCoalesceUsed[slot] = this.wbufCoalesceEpoch;
        this.wbufCoalesceKey0[slot] = k0;
        this.wbufCoalesceKey1[slot] = k1;
        this.wbufCoalesceKey2[slot] = k2;
        this.wbufCoalesceKey3[slot] = k3;
        this.wbufCoalesceOffset[slot] = offset;
    }

    private wbufCoalesceLatest(mem32: Uint32Array, dataPtr: number, funcId: number, mask: number, segment: number): number {
        const w = dataPtr >> 2;
        const k0 = (funcId | (segment << 16)) >>> 0;
        const k1 = (mask & 1) ? (mem32[w] >>> 0) : 0;
        const k2 = (mask & 2) ? (mem32[w + 1] >>> 0) : 0;
        const k3 = (mask & 4) ? (mem32[w + 2] >>> 0) : 0;
        const slot = this.wbufCoalesceSlot(k0, k1, k2, k3);
        return this.wbufCoalesceUsed[slot] === this.wbufCoalesceEpoch ? this.wbufCoalesceOffset[slot] : -1;
    }

    private getWbufEntryStride(mem32: Uint32Array, dataBase: number, offset: number, argCount: number): number {
        if (argCount === WBUF_ARG_SHADER_CONSTANT) {
            const vec4Count = mem32[(dataBase + offset + 12) >> 2] >>> 0;
            if (!vec4Count || vec4Count > 256) return -1;
            return (4 + vec4Count * 4) * 4;
        }
        if (argCount === WBUF_ARG_UP_DRAW) {
            const byteCount = mem32[(dataBase + offset + 20) >> 2] >>> 0;
            if (!byteCount || byteCount > 65536 || (byteCount & 3) !== 0) return -1;
            return 24 + byteCount;
        }
        return (argCount + 1) * 4;
    }

    private buildWbufCoalesceIndex(mem32: Uint32Array, dataBase: number, start: number, head: number): boolean {
        this.beginWbufCoalesce(Math.max(1, (head - start) >>> 3));
        let offset = start;
        let segment = 0;
        while (offset < head) {
            const funcId = mem32[(dataBase + offset) >> 2];
            if (!(funcId > 0 && funcId < MAX_THUNK_ID)) return false;
            const argCount = this.writeBufArgCountTable[funcId];
            if (!this.writeBufHandlerTable[funcId] || argCount <= 0) return false;
            const stride = this.getWbufEntryStride(mem32, dataBase, offset, argCount);
            if (stride <= 0) return false;
            // Barrier (draw) entry: everything after it keys into a new segment.
            // MUST mirror the identical walk in drainWriteBuffer.
            if (this.writeBufBarrierTable[funcId]) segment++;
            const mask = this.writeBufCoalesceMaskTable[funcId];
            if (mask) {
                this.wbufCoalescePut(mem32, dataBase + offset + 4, funcId, mask, offset, segment);
            }
            offset += stride;
        }
        return offset === head;
    }

    private drainWriteBuffer(): void {
        if (this.writeBufControlAddr === 0) return;
        let mem32 = this.cachedMem32;

        // Refresh if stale or doesn't cover the WBUF control address.
        // This can happen early in startup before v86 has expanded to full memory.
        const headWordIdx = this.writeBufControlAddr >> 2;
        if (!mem32 || headWordIdx >= mem32.length) {
            this.updateMemoryCache();
            mem32 = this.cachedMem32;
            if (!mem32 || headWordIdx >= mem32.length) return;
        }

        const head = mem32[headWordIdx];
        if (!head) { this.wbufTail = 0; return; }  // 0 or undefined — ring is empty
        if (head === this.wbufTail) {
            // Everything drained but head not yet reset — try the safe reset below.
            this.tryResetWbufHead(mem32, headWordIdx, head);
            return;
        }

        // One-time log to confirm the write-buffer drain path is reached
        const verbose = this.wbufDrainCount < 5;
        if (this.wbufDrainCount++ < 5) {
            Logger.log(LogCategory.THUNK, `[WBUF] drain #${this.wbufDrainCount}: head=${head} bytes`);
        }

        // Stack integrity check: read game's return address from [ESP] during first drains
        if (verbose) {
            const cpu = this.cachedCpu;
            if (cpu) {
                const esp = cpu.reg32[4] >>> 0;
                const espWord = (esp > 0 && esp + 4 <= mem32.length * 4) ? mem32[esp >> 2] : 0;
                Logger.log(LogCategory.THUNK,
                    `[WBUF] stack check: ESP=0x${esp.toString(16)} [ESP]=0x${(espWord >>> 0).toString(16).padStart(8, '0')}`);
            }
        }

        const mem8 = this.cachedMem8!;
        const dataBase = this.writeBufDataBase;
        let offset = this.wbufTail;
        let segment = 0; // barrier (draw) count — must mirror buildWbufCoalesceIndex's walk
        const coalescing = this.wbufCoalescingEnabled && this.buildWbufCoalesceIndex(mem32, dataBase, offset, head);
        while (offset < head) {
            const funcId = mem32[(dataBase + offset) >> 2];
            if (funcId > 0 && funcId < MAX_THUNK_ID) {
                const handler = this.writeBufHandlerTable[funcId];
                const argCount = this.writeBufArgCountTable[funcId];
                if (handler && argCount > 0) {
                    const stride = this.getWbufEntryStride(mem32, dataBase, offset, argCount);
                    if (stride <= 0) {
                        const vec4Count = mem32[(dataBase + offset + 12) >> 2] >>> 0;
                        Logger.warn(LogCategory.THUNK,
                            `drainWriteBuffer: bad shader-constant vec4Count ${vec4Count} at offset ${offset}`);
                        offset = head;
                        break;
                    }
                    // Verbose: dump each ring entry during first drains
                    if (verbose) {
                        const name = this.namesTable[funcId] || `id_${funcId}`;
                        const args: string[] = [];
                        const dumpCount = argCount === WBUF_ARG_SHADER_CONSTANT
                            ? 3 + (mem32[(dataBase + offset + 12) >> 2] >>> 0) * 4
                            : argCount === WBUF_ARG_UP_DRAW ? 5
                            : Math.min(argCount, 12);
                        for (let a = 0; a < dumpCount; a++) {
                            args.push(`0x${(mem32[(dataBase + offset + 4 + a * 4) >> 2] >>> 0).toString(16)}`);
                        }
                        Logger.log(LogCategory.THUNK,
                            `[WBUF]   @${offset}: ${name}(${args.join(', ')})`);
                    }
                    if (this.writeBufBarrierTable[funcId]) {
                        segment++;
                        this.wbufBarrierEntriesTotal++;
                    }
                    const coalesceMask = coalescing ? this.writeBufCoalesceMaskTable[funcId] : 0;
                    if (coalesceMask && this.wbufCoalesceLatest(mem32, dataBase + offset + 4, funcId, coalesceMask, segment) !== offset) {
                        this.wbufCoalescedSkipsTotal++;
                    } else {
                        handler(mem8, mem32, dataBase + offset + 4);
                    }
                    offset += stride;
                    this.wbufHitsTotal++;
                } else {
                    // No registered handler or zero argCount — ring is corrupt, bail
                    Logger.warn(LogCategory.THUNK, `drainWriteBuffer: unregistered funcId ${funcId} (argCount=${argCount}) in ring at offset ${offset}`);
                    offset = head; // skip corrupt tail; reset below clears the ring
                    break;
                }
            } else {
                // Corrupted/unknown funcId — reset and abort to avoid infinite loop
                Logger.warn(LogCategory.THUNK, `drainWriteBuffer: unexpected funcId 0x${funcId.toString(16)} at offset ${offset}`);
                offset = head;
                break;
            }
        }
        this.wbufTail = offset;
        this.tryResetWbufHead(mem32, headWordIdx, mem32[headWordIdx]);

        // Lightweight drain stats — log every 60 drain-bearing OUT traps
        if (head > 0) {
            this.wbufFrameDrainCalls++;
            this.wbufFrameEntries += (offset / 4) | 0; // approximate entry words
            if (++this.wbufFrameCounter % 60 === 0) {
                Logger.log(LogCategory.THUNK,
                    `[WBUF] stats: ${this.wbufFrameDrainCalls} drains, ~${this.wbufFrameEntries} words, ring peak ${head}/${this.writeBufCapacity} bytes (${((head / this.writeBufCapacity) * 100).toFixed(1)}%), resetDeferred=${this.wbufResetDeferredTotal}`);
                this.wbufFrameDrainCalls = 0;
                this.wbufFrameEntries = 0;
            }
        }
    }

    /** Reset the guest ring head to 0 — but ONLY when fully drained and no preempted
     *  thread is parked inside a WBUF trampoline (it holds the pre-reset head in EDX;
     *  resetting under it orphans its entry and desyncs head — the historical source
     *  of randomly lost SetTexture/SetRenderState → one-frame surface flicker).
     *  When deferred, the ring keeps appending monotonically; on exhaustion the
     *  trampoline's overflow branch falls back to the OUT trap, so ordering holds. */
    private tryResetWbufHead(mem32: Uint32Array, headWordIdx: number, head: number): void {
        if (!head || this.wbufTail !== head) return; // not fully drained yet
        if (this.wbufTrampLo !== 0) {
            const sched = System.getInstance().scheduler;
            if (sched && (sched as any).hasParkedThreadInRange?.(this.wbufTrampLo, this.wbufTrampHi)) {
                this.wbufResetDeferredTotal++;
                return;
            }
        }
        mem32[headWordIdx] = 0;
        this.wbufTail = 0;
    }

    private setupPortHook(): void {
        const cpu = this.v86.cpu || (this.v86.v86 && this.v86.v86.cpu);
        if (!cpu) {
            Logger.error(LogCategory.SYSTEM, 'Could not find CPU object on v86 instance!');
            return;
        }

        // Cache CPU reference (never changes after init)
        this.cachedCpu = cpu;
        // Cache typed-array references — avoids repeated property lookup on every thunk.
        // Note: cpu.reg32 / cpu.instruction_pointer / cpu.flags are Proxy objects
        // (vendor/v86/src/lib.js:17). Hot paths use cachedReg32Raw/cachedIpRaw/etc. which
        // are direct Int32Array views into wasm_memory.buffer, bypassing the Proxy.
        this.cachedReg32 = cpu.reg32 || null;
        this.cachedInstructionPointer = cpu.instruction_pointer || null;
        this.cachedFlags = cpu.flags || null;
        // Ensure raw views are up-to-date. updateMemoryCache() may have been called before
        // CPU was available; refresh now via cachedMem8.buffer.
        if (this.cachedMem8 && this.cachedWasmBuffer !== this.cachedMem8.buffer) {
            this.cachedWasmBuffer = this.cachedMem8.buffer;
            this.cachedReg32Raw      = new Int32Array(this.cachedMem8.buffer, 64,  8);
            this.cachedFlagsRaw      = new Int32Array(this.cachedMem8.buffer, 120, 1);
            this.cachedIpRaw         = new Int32Array(this.cachedMem8.buffer, 556, 1);
            this.cachedSegOffsetsRaw = new Int32Array(this.cachedMem8.buffer, 736, 8);
        }

        // Cache scheduler reference (lazy - set on first use since scheduler may init later)
        try { this.cachedScheduler = System.getInstance().scheduler; } catch { }

        const ioBus = cpu.io || (cpu.devices && cpu.devices.io) || cpu.io_bus;
        if (!ioBus) {
            Logger.warn(LogCategory.SYSTEM, 'Cannot find IO Bus!');
            return;
        }

        const thunkDevice = {
            write32: (value: number) => {
                this.handlePortWrite(value >>> 0);
            },
            write16: (value: number) => {
                Logger.warn(LogCategory.THUNK, 'Valid thunk call should be 32-bit (OUT DX, EAX)!');
            },
            write8: (value: number) => {
                Logger.warn(LogCategory.THUNK, 'Valid thunk call should be 32-bit!');
            },
            read32: () => 0,
            read16: () => 0,
            read8: () => 0
        };

        if (ioBus.ports && Array.isArray(ioBus.ports)) {
            ioBus.ports[0xB077] = thunkDevice;
            Logger.log(LogCategory.SYSTEM, 'I/O hook installed on port 0xB077');
        } else {
            Logger.error(LogCategory.SYSTEM, 'ioBus.ports is missing or not an array!');

            if (typeof ioBus.register_write === 'function') {
                ioBus.register_write(0xB077, thunkDevice, undefined, undefined, 4);
            }
        }
    }

    // =========================================================================
    // HOT PATH - Main Dispatcher
    // =========================================================================
    private handlePortWrite(functionId: number): void {
        // Early bail if paused � v86.stop() is async so CPU may still fire thunks briefly
        if (System.getInstance().isPaused) {
            try { this.v86.stop(); } catch { }
            return;
        }

        // ── Hypercall ring (crash-hunt): record EVERY hypercall (fast + slow). Zero-alloc.
        // Gated: only records when armed (headWatch verb) — off by default to keep the hot path free.
        if (this.hcRingEnabled) {
            const p = this.hcRingPos++ & 255;
            this.hcRingId[p] = functionId | 0;
            this.hcRingThread[p] = (this.currentThreadId ?? 0) | 0;
            const esp = this.cachedReg32Raw ?? this.cachedReg32;
            let caller = 0, head = 0;
            if (this.cachedDataView && this.isDataViewValid()) {
                if (esp) { const sp = esp[4] >>> 0; if (sp + 4 <= this.memLength) caller = this.cachedDataView.getUint32(sp, true) >>> 0; }
                if (this.hcWatchAddr && this.hcWatchAddr + 4 <= this.memLength) head = this.cachedDataView.getUint32(this.hcWatchAddr, true) >>> 0;
            }
            this.hcRingCaller[p] = caller | 0;
            this.hcRingHead[p] = head | 0;
        }

        // Non-local-jump detection for SEH dispatch: if a handler caught via longjmp
        // (RtlUnwind + jump to except block), the dispatch context is still on the stack.
        // Detect this early (before fast path) by checking if ESP moved above startEsp.
        // Cost when stack is empty: one branch on length (always predicted taken for 0).
        if (this.sehDispatchStack.length > 0 && functionId !== 0x7FFF0002) {
            this._checkSehNonLocalJump(functionId);
        }

        // Drain Tier-0 write-buffer ring before processing this OUT trap.
        // State-setter stubs (SetRenderState, glVertex*, etc.) write args directly into
        // the ring via JMP trampolines and never trigger an OUT trap themselves.
        // The ring is drained here so that all pending state changes are applied before
        // the flush trigger (DrawPrimitive, glEnd, wglSwapBuffers) executes.
        // Cost when ring is empty: ~2 ns (one branch + one u32 read).
        this.drainWriteBuffer();

        // WBUF miss diagnostic: if a WBUF-registered function hits OUT trap,
        // read back stub bytes to determine why the JMP patch isn't executing.
        if (functionId > 0 && functionId < MAX_THUNK_ID &&
            this.writeBufHandlerTable[functionId]) {
            this.wbufOutTrapHitsTotal++;
            if (this.wbufMissLogCount < 5) {
                this.wbufMissLogCount++;
                const name = this.namesTable[functionId] || `id_${functionId}`;
                const stubs = this.thunkGenerator.getAllStubs();
                const stub = stubs.find(s => s.functionId === functionId);
                if (stub && this.cachedMem8) {
                    const a = stub.address;
                    const m = this.cachedMem8;
                    const bytes = Array.from(m.slice(a, a + 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
                    Logger.warn(LogCategory.THUNK,
                        `[WBUF] MISS: ${name} (id=${functionId}) hit OUT trap! ` +
                        `stub@0x${a.toString(16)}: [${bytes}] ` +
                        `(byte5=${m[a+5]===0xE9?'JMP(patched)':'0x'+m[a+5].toString(16)+'(NOT patched)'})`);
                } else {
                    Logger.warn(LogCategory.THUNK,
                        `[WBUF] MISS: ${name} (id=${functionId}) hit OUT trap but stub not found or mem not ready`);
                }
            }
        }

        // ULTRA-FAST PATH: Check fast table BEFORE any other work.
        // Normal thunk IDs are small positive numbers (< MAX_THUNK_ID).
        // Magic markers have high bits set (0xDEADxxxx, 0x80xxxxxx, 0xFFFFFFFF).
        if (functionId > 0 && functionId < MAX_THUNK_ID) {
            const fastImpl = this.fastPathTable[functionId];
            if (fastImpl) {
                // Ensure memory cache is valid
                if (!this.cachedMem8 || this.cachedMem8.byteLength === 0) this.updateMemoryCache();
                const cpu = this.cachedCpu;
                if (!cpu || !this.cachedMem8) return;

                // Scheduler enter hook (uses cached reference)
                this.ensureScheduler().onThunkEnter();

                // Use cached reg32 reference to avoid repeated property lookup on every thunk
                const reg32 = this.cachedReg32Raw ?? this.cachedReg32 ?? cpu.reg32;
                const espAtEntry = reg32[4];
                this.fastPathCallCount++;
                const doProfile = (this.fastPathCallCount & 0x1F) === 0; // Sample 1/32

                if (doProfile) {
                    frameProfiler.markThunkStart();
                    const thunkStart = frameProfiler.startTimer();
                    const res = fastImpl(cpu, this.cachedMem8, this.cachedMem32!, this.cachedDataView!);

                    if (this.dbgFastPathRec !== null) this._recordFastPath(functionId, res);
                    if (res === undefined) {
                        // Context Switch signaled
                        const thunkName = this.namesTable[functionId] || "unknown";
                        const duration = frameProfiler.endTimer("thunk", thunkStart);
                        frameProfiler.recordThunk(thunkName, duration * 32, 32);
                        frameProfiler.markThunkEnd();
                        return;
                    }

                    if (res !== null) {
                        // Success (Fast Path)
                        reg32[0] = res >>> 0;
                        const thunkName = this.namesTable[functionId] || "unknown";
                        const duration = frameProfiler.endTimer("thunk", thunkStart);
                        frameProfiler.recordThunk(thunkName, duration * 32, 32);
                        frameProfiler.markThunkEnd();

                        // Inline ESP tracking
                        const cachedCleanup = this.stackCleanupTable[functionId];
                        const fastArgCount = this.argCountsTable[functionId];
                        const cleanupBytes = cachedCleanup >= 0 ? cachedCleanup : ((fastArgCount >= 0 ? fastArgCount : 0) * 4);
                        this.completeFastPathSync(functionId, espAtEntry, cleanupBytes, cpu);
                        return;
                    }
                    // null = fallthrough to slow path
                    frameProfiler.markThunkEnd();
                } else {
                    // ZERO OVERHEAD PATH (no profiling)
                    const res = fastImpl(cpu, this.cachedMem8, this.cachedMem32!, this.cachedDataView!);

                    if (this.dbgFastPathRec !== null) this._recordFastPath(functionId, res);
                    if (res === undefined) return; // Context switch

                    if (res !== null) {
                        // Success
                        reg32[0] = res >>> 0;

                        const cachedCleanup = this.stackCleanupTable[functionId];
                        const fastArgCount = this.argCountsTable[functionId];
                        const cleanupBytes = cachedCleanup >= 0 ? cachedCleanup : ((fastArgCount >= 0 ? fastArgCount : 0) * 4);
                        this.completeFastPathSync(functionId, espAtEntry, cleanupBytes, cpu);
                        return;
                    }
                    // null = fallthrough to slow path
                }

                // Fast path returned null > fall through to slow path
                // (scheduler enter already called above)
                this._handlePortWriteSlow(functionId, true);
                return;
            }
        }

        // All non-fast-path calls go through the slow path
        this._handlePortWriteSlow(functionId, false);
    }


    /** Record a fast-path call's name + last return value (intro/splash probe). */
    private _recordFastPath(functionId: number, res: number | null | undefined | object): void {
        const rec = this.dbgFastPathRec;
        if (!rec) return;
        let e = rec.get(functionId);
        if (!e) { e = { count: 0, lastRet: 0, lastCaller: 0 }; rec.set(functionId, e); }
        e.count++;
        e.lastRet = (res === undefined) ? -2 : (res === null) ? -1 : (typeof res === 'number' ? (res | 0) : -3);
        // Caller return address = [esp] at the OUT trap (pushed by the guest CALL to the stub).
        const reg32 = this.cachedReg32Raw ?? this.cachedReg32;
        const dv = this.cachedDataView;
        if (reg32 && dv) {
            const esp = reg32[4] >>> 0;
            if (esp + 4 <= this.memLength) e.lastCaller = dv.getUint32(esp, true) >>> 0;
        }
    }

    /** Start/stop fast-path recording; returns JSON-able summary on stop/dump. */
    dbgFastPathStart(): void { this.dbgFastPathRec = new Map(); }
    dbgFastPathDump(): Array<{ name: string; count: number; lastRet: string; lastCaller: string }> {
        const rec = this.dbgFastPathRec;
        if (!rec) return [];
        const out: Array<{ name: string; count: number; lastRet: string; lastCaller: string }> = [];
        for (const [id, e] of rec.entries()) {
            out.push({ name: this.namesTable[id] || `id_0x${id.toString(16)}`, count: e.count, lastRet: `0x${(e.lastRet >>> 0).toString(16)}`, lastCaller: `0x${(e.lastCaller >>> 0).toString(16)}` });
        }
        out.sort((a, b) => b.count - a.count);
        return out;
    }
    dbgFastPathStop(): void { this.dbgFastPathRec = null; }

    /**
     * Slow path for handlePortWrite - contains all safety checks, magic markers,
     * codec detection, and standard thunk dispatch.
     * @param schedulerEnterAlreadyCalled - true if fast path already called onThunkEnter
     */
    private _handlePortWriteSlow(functionId: number, schedulerEnterAlreadyCalled: boolean): void {
        const system = System.getInstance();

        // 0. Pause & Exit checks
        if (system.isPaused) {
            Logger.warn(LogCategory.THUNK, `Thunk call 0x${functionId.toString(16)} during PAUSE! Stopping CPU.`);
            try { this.v86.stop(); } catch { }
            return;
        }
        if (system.isExiting) {
            Logger.verbose(LogCategory.THUNK, `Ignoring thunk call during exit: 0x${functionId.toString(16)}`);
            try { this.v86.stop(); } catch { }
            return;
        }

        // Ensure memory cache is valid
        if (!this.cachedMem8 || this.cachedMem8.byteLength === 0) this.updateMemoryCache();
        if (!this.cachedMem8) return;
        const cpu = this.cachedCpu || (this.v86.cpu || (this.v86.v86 && this.v86.v86.cpu));
        if (!cpu) return;

        // Non-local-jump detection already handled in handlePortWrite (before fast path).

        // --- PHASE 1: Waiting for EIP Dump (Marker for faulting address) ---
        if (this.isWaitingForEipDump) {
            this.isWaitingForEipDump = false;
            let bytesInfo = '';
            const eipValue = functionId >>> 0;
            if (this.cachedMem8 && eipValue > 0 && eipValue < this.memLength) {
                const start = Math.max(0, eipValue - 5);
                const codeBytes = Array.from(this.cachedMem8.slice(start, Math.min(this.memLength, start + 15)));
                bytesInfo = ` | Bytes around EIP: ${codeBytes.map((b: any) => (b as number).toString(16).padStart(2, '0')).join(' ')}`;
            }
            Logger.error(LogCategory.SYSTEM, `[DIAG] Faulting EIP captured: 0x${eipValue.toString(16)}${bytesInfo}`);

            const aligned = eipValue & ~0xF;
            const stub = this.thunkGenerator.getStubByAddress(aligned);
            if (stub) {
                const offset = eipValue - stub.address;
                Logger.error(LogCategory.SYSTEM, `   Faulting EIP is inside thunk stub ${stub.dllName}:${stub.functionName} +0x${offset.toString(16)}`);
            } else {
                if (eipValue >= 0x80000 && eipValue < 0x100000) {
                    Logger.error(LogCategory.SYSTEM, `Execution escaped to STACK at 0x${eipValue.toString(16)}!`);
                    if (this.cachedMem8 && this.isDataViewValid()) {
                        const bytes = Array.from(this.cachedMem8.slice(eipValue, Math.min(this.memLength, eipValue + 16)));
                        Logger.error(LogCategory.SYSTEM, `   Stack bytes at EIP: ${bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
                    }
                    this.logCallbackForensics(`stack_escape_eip_0x${eipValue.toString(16)}`);
                }
            }
            this.boundaryKind = ThunkBoundaryKind.GUEST_CODE;
            this.boundaryCleanup = 0;
            this.notifySchedulerBoundary(cpu);
            return;
        }

        // --- PHASE 2: Magic Debug Markers (0xDEADxxxx) ---
        // MUST be before callback return because 0xDEAD has bit 31 set!
        if ((functionId >>> 16) === 0xDEAD) {
            this._slowPathHandleDebugMarker(functionId, cpu);
            return;
        }

        // --- PHASE 2b: SEH Dispatch Result (0x7FFF0002) ---
        // Fired by the SEH dispatch stub after calling all handlers natively.
        if (functionId === 0x7FFF0002) {
            this._handleSehDispatchResult(cpu);
            return;
        }

        // --- PHASE 2c: SEH catch-completion (SEH_CATCH_COMPLETION_FUNCID) ---
        // Emitted by the catch-completion gadget when a C++ catch funclet returns NORMALLY
        // (did not rethrow). sehOnCatchCompletion pops the active-catch record + active
        // exception, restores PRN_STACK, and (last user only) chains the exception
        // object's destructor by patching the gadget's saved-EAX slot. A rethrowing
        // funclet never reaches the gadget, so its exception correctly survives.
        if (functionId === SEH_CATCH_COMPLETION_FUNCID) {
            sehOnCatchCompletion(cpu);
            return;
        }

        // --- PHASE 3: Callback Returns (0x80xxxxxx) ---
        if ((functionId & 0x80000000) !== 0) {
            if (this._callbackManager) {
                const reg32 = this.cachedReg32Raw ?? cpu.reg32;
                const ipRaw = this.cachedIpRaw;
                const preEsp = reg32[4];
                this._callbackManager.handleCallbackReturn(functionId);
                const postEsp = reg32[4];
                const postEip = ipRaw ? ipRaw[0] : (cpu.instruction_pointer?.[0] ?? 0);

                this.lastExpectedEspAfterReturn = postEsp;
                this.lastThunkNameAfterReturn = '';

                if (preEsp !== postEsp) {
                    let stackVals = '';
                    if (this.cachedMem8 && this.isDataViewValid() && postEsp >= 0 && postEsp + 8 <= this.memLength) {
                        const sv = this.cachedDataView!;
                        stackVals = ` stack@ESP=[0x${sv.getUint32(postEsp, true).toString(16)},0x${sv.getUint32(postEsp + 4, true).toString(16)}]`;
                    }
                    Logger.verbose(LogCategory.THUNK,
                        `CB return 0x${functionId.toString(16)}: ESP 0x${preEsp.toString(16)}>0x${postEsp.toString(16)} EIP=0x${postEip.toString(16)}${stackVals}`);
                }
            }
            return;
        }

        // --- PHASE 4: Invalid Sentinel Check ---
        if (functionId === 0xffffffff || functionId === 0) {
            const eipVal = (this.cachedIpRaw ? this.cachedIpRaw[0] : (cpu.instruction_pointer?.[0] ?? 0)) >>> 0;
            Logger.warn(LogCategory.THUNK, `Thunk port write 0x${functionId.toString(16)} (invalid ID, ignored) context: EIP=0x${eipVal.toString(16)}`);
            this.boundaryKind = ThunkBoundaryKind.GUEST_CODE;
            this.boundaryCleanup = 0;
            this.notifySchedulerBoundary(cpu);
            return;
        }

        // --- PHASE 5: Offset +5 Detection ---
        const eip = (this.cachedIpRaw ? this.cachedIpRaw[0] : (cpu.instruction_pointer?.[0] ?? 0)) >>> 0;

        if (this.cachedMem8 && eip >= 11 && eip < this.memLength) {
            const stubStart = eip - 11;
            if (stubStart >= 0) {
                const b = this.cachedMem8;
                if (b[stubStart] === 0xB8 && b[stubStart + 5] === 0xBA && b[stubStart + 10] === 0xEF) {
                    const stubId = b[stubStart + 1] | (b[stubStart + 2] << 8) | (b[stubStart + 3] << 16) | (b[stubStart + 4] << 24);
                    if (functionId !== stubId) {
                        Logger.error(LogCategory.THUNK, `?? OFFSET +5 CALL DETECTED! Correcting ID ${functionId} -> ${stubId}`);
                        functionId = stubId;
                    }
                }
            }
        }

        // --- PHASE 6: Scheduler & Standard Thunk Prep ---
        if (!schedulerEnterAlreadyCalled) {
            this.callSchedulerOnThunkEnter(cpu);
        }

        if (this.isSchedulerThreadExitId(functionId)) {
            this.handleSchedulerThreadExitStub(cpu, this.cachedMem8!);
            // Note: Set EIP to spin loop BEFORE calling onThunkComplete.
            // Without this, v86 resumes the thunk stub's RET N on the terminated
            // thread's stack > jumps to garbage > #UD crash. Also redirect [ESP] so a
            // JIT-merged OUT+RET N can't pop that garbage. See redirectStackToSpinLoop.
            cpu.instruction_pointer[0] = this.spinLoopAddress;
            this.redirectStackToSpinLoop((this.cachedReg32Raw ?? cpu.reg32)[4] >>> 0);
            this.lastExpectedEspAfterReturn = 0;
            this.setBoundaryAndNotify(cpu, ThunkBoundaryKind.SPIN_LOOP, 0);
            return;
        }

        if (functionId >= MAX_THUNK_ID) {
            this._slowPathHandleInvalidId(functionId, cpu);
            this.setBoundaryAndNotify(cpu, ThunkBoundaryKind.GUEST_CODE, 0);
            return;
        }

        const thunkName = this.namesTable[functionId] || "unknown";
        const reg32Raw = this.cachedReg32Raw ?? cpu.reg32;
        const espAtEntry = reg32Raw[4];
        // Debug session hook (zero-cost when disabled)
        if (debugSession.isEnabled()) {
            const eipNow = (this.cachedIpRaw ? this.cachedIpRaw[0] : (cpu.instruction_pointer?.[0] ?? 0)) >>> 0;
            const threadId = this.ensureScheduler().getCurrentThread()?.id ?? 0;
            debugSession.onThunkCall(thunkName, threadId, eipNow, espAtEntry);
        }

        // Harness API breakpoints: zero-cost when disarmed, JS layer so
        // no JIT-off needed. Logic lives in src/worker/harness/api-breaks.ts.
        if (harnessApiBreaks.active) {
            const eipNow = (this.cachedIpRaw ? this.cachedIpRaw[0] : (cpu.instruction_pointer?.[0] ?? 0)) >>> 0;
            harnessApiBreaks.check(thunkName, eipNow, espAtEntry);
        }

        // Slow-path profiling: count hits per thunk (gated — zero overhead when disabled)
        if (this.profileSlowPathEnabled) {
            this.slowPathHitCounts.set(thunkName, (this.slowPathHitCounts.get(thunkName) ?? 0) + 1);
        }

        // One-time warning per functionId: if WASM handler is registered but JS is handling it
        if (hypercallDataManager.isEnabled() && !this.wasmMissWarned.has(functionId)) {
            try {
                const hpView = (hypercallDataManager as any).view as DataView | null;
                const hpBase = (hypercallDataManager as any).hpBase as number;
                if (hpView && hpBase) {
                    const handlerId = hpView.getUint8(hpBase + 0x100 + functionId);
                    if (handlerId !== 0) {
                        Logger.warn(LogCategory.THUNK,
                            `[WASM MISS] ${thunkName} (funcId=${functionId}) has WASM handler ${handlerId} but hit JS slow path`);
                        this.wasmMissWarned.add(functionId);
                    }
                }
            } catch (_) {
                // DataView may reference a detached buffer � skip diagnostic
            }
        }

        // Polling detection
        if ((this.thunkCount & 0x3F) === 0) {
            const sched = this.ensureScheduler();
            const isTimePoll = thunkName === 'winmm:timeGetTime' || thunkName === 'kernel32:GetTickCount' || thunkName === 'kernel32:QueryPerformanceCounter';
            if (isTimePoll) {
                const current = sched.getCurrentThread();
                this.thunkCallCounts[functionId]++;
                if (current && (this.thunkCallCounts[functionId] % 4) === 0) {
                    // Instruction-based half-quantum gate (deterministic, platform-independent) —
                    // a wall-clock (performance.now) measure here made the force-switch land on
                    // different guest-instruction boundaries per host speed. See insnQuantumFraction.
                    if (sched.insnQuantumFraction(current, 0.5) && sched.hasOtherRunnableThreads(current.id)) {
                        sched.requestSwitch();
                    }
                }
            }
            if (this.busyWaitDetector.check(thunkName, (cpu.instruction_counter?.[0] ?? 0) >>> 0)) {
                sched.requestSwitch();
            }
        }

        // Module base for return address patches
        if (this.cachedMem8 && this.isDataViewValid() && espAtEntry >= 0 && espAtEntry + 4 <= this.memLength) {
            const retAddrAtEntry = this.cachedDataView!.getUint32(espAtEntry, true) >>> 0;
            if (retAddrAtEntry >= GUEST_CODE_START) {
                const mod = System.getInstance().process?.moduleRegistry.getModuleContainingAddress(retAddrAtEntry);
                this.lastCallerModuleBase = mod ? mod.baseAddress : 0;
            } else {
                this.lastCallerModuleBase = 0;
            }
        }

        const profilerEnabled = profiler.isEnabled();
        const sampleProfiler = profilerEnabled && ((this.profilerSampleCounter++ & this.profilerSampleMask) === 0);
        if (sampleProfiler) profiler.start("thunk_dispatch");

        // Read first arg for ring buffer (cheap: 1 memory read)
        let ringArg0 = 0;
        try {
            if (this.cachedDataView && this.isDataViewValid() && espAtEntry + 8 <= this.memLength) {
                ringArg0 = this.cachedDataView.getUint32(espAtEntry + 4, true) >>> 0;
            }
        } catch { /* detached buffer */ }
        this.recordWinApiCall(thunkName, functionId, espAtEntry, ringArg0);
        this.checkEspSanity(espAtEntry, thunkName);
        this.checkEbpSanity(cpu.reg32[5] >>> 0, thunkName);
        const profileThunk = profilerEnabled && this.shouldProfileThunk(thunkName);
        if (profileThunk) profiler.startAsync(thunkName);

        // --- PHASE 7: Implementation Dispatch ---
        let impl = this.dispatchTable[functionId];
        if (!impl) {
            impl = this._trySameNameLookup(functionId) || this._tryDllForward(functionId) || this._tryPendingRegistration(functionId);
        }
        let argCount = this.argCountsTable[functionId];
        if (!impl) {
            this._slowPathMissingImplementation(functionId, cpu, thunkName);
            if (profileThunk) profiler.endAsync(thunkName);
            this.setBoundaryAndNotify(cpu, ThunkBoundaryKind.THUNK_STUB, 0);
            if (sampleProfiler) profiler.end("thunk_dispatch");
            return;
        }

        if (argCount < 0) {
            Logger.warn(LogCategory.THUNK, `?? STACK DRIFT RISK: ${thunkName} (id=0x${functionId.toString(16)}) has no argCount, using ${DEFAULT_ARGS_COUNT}`);
            argCount = DEFAULT_ARGS_COUNT;
        }

        this.fillStackArgs(espAtEntry, argCount);

        const allowStubPoolRet = thunkName.includes('DefWindowProc');
        if (!this.validateReturnAddrFast(espAtEntry, allowStubPoolRet)) {
            this._slowPathInvalidReturnPreCall(functionId, thunkName, espAtEntry, cpu);
            if (profileThunk) profiler.endAsync(thunkName);
            this.setBoundaryAndNotify(cpu, ThunkBoundaryKind.THUNK_STUB, 0);
            if (sampleProfiler) profiler.end("thunk_dispatch");
            return;
        }

        this.lastThunkId = functionId;
        this.lastThunkName = thunkName;
        this.thunkCount++;

        let result: any;
        frameProfiler.markThunkStart();
        const thunkStart = frameProfiler.startTimer();
        // PERF: Capture wall-clock time for virtual time compensation.
        // Sync thunks don't spin-loop > instruction counter doesn't advance > virtual time
        // falls behind wall-clock. Credit handler time to keep game timing consistent.
        const implWallStart = performance.now();
        try {
            const regsRaw = this.cachedReg32 || cpu.reg32;
            const ctx = this.reusableContext;
            ctx.eax = regsRaw[0]; ctx.ecx = regsRaw[1]; ctx.edx = regsRaw[2]; ctx.ebx = regsRaw[3];
            ctx.esp = regsRaw[4]; ctx.ebp = regsRaw[5]; ctx.esi = regsRaw[6]; ctx.edi = regsRaw[7];
            ctx.eip = (this.cachedInstructionPointer || cpu.instruction_pointer)[0];
            // Materialize lazy arithmetic flags: this ctx.eflags feeds
            // createPostReturnContext for async/blocked thunks, whose restore
            // clears flags_changed — a raw flags[0] here would bake stale
            // ZF/CF/SF/OF into the resumed context (see saveCpuContext).
            ctx.eflags = (cpu as any)["get_eflags"] ? (cpu as any)["get_eflags"]() : (this.cachedFlags || cpu.flags)[0];

            // API census — record EVERY unique JS-dispatched thunk/COM method the guest
            // calls this session (deduped → one Map entry per name, bumped on repeat) and
            // flag likely SILENT STUBS (impl.length===0 = ignores ctx/mem/args, the
            // `()=>D3D_OK` pattern; plus curated SILENT_STUBS). Surfaced in report(): the
            // full unique-call list narrows "where is the buggy impl?", and the stub subset
            // catches "a stub pretends to work and the game derails far away" (the hot
            // string/sync/memcpy traffic rides the WASM hypercall tier, not this JS path,
            // so this stays cheap). See diagnostics/api-census.ts.
            const censusCaller = (this.cachedDataView && this.isDataViewValid() && espAtEntry < this.memLength - 4)
                ? this.cachedDataView.getUint32(espAtEntry, true) >>> 0 : 0;
            apiCensus.record(thunkName, impl.length, censusCaller);

            result = impl(ctx, this.cachedMem8, this.reusableArgs);
        } catch (e) {
            this._slowPathHandleThunkError(functionId, thunkName, e, cpu);
            if (profileThunk) profiler.endAsync(thunkName);
            this.setBoundaryAndNotify(cpu, ThunkBoundaryKind.THUNK_STUB, 0);
            if (sampleProfiler) profiler.end("thunk_dispatch");
            const dur = frameProfiler.endTimer("thunk", thunkStart);
            frameProfiler.recordThunk(thunkName, dur);
            frameProfiler.markThunkEnd();
            return;
        }

        const isAsync = result instanceof Promise;
        if (isAsync) {
            this._handleAsyncResult(result, functionId, thunkName, cpu, espAtEntry, argCount, thunkStart);
        } else {
            const dur = frameProfiler.endTimer("thunk", thunkStart);
            if ((this.thunkCount & 0xF) === 0) frameProfiler.recordThunk(thunkName, dur * 16);
            frameProfiler.markThunkEnd();
            this._handleSyncResult(result, functionId, thunkName, cpu, this.reusableContext, argCount, espAtEntry);

            // Sync virtual time with wall-clock after each sync thunk.
            // Spin-wait loops (e.g. AVI: while (GetTickCount() < next) { SwapBuffers(); })
            // spin indefinitely if virtual time never catches up to wall-clock, because
            // instruction-count-based advance is too slow when all cycles are thunk overhead.
            // Strategy: if wall-clock has moved forward and virtual time is behind, advance
            // virtual time by the deficit (capped at 16ms to avoid large jumps).
            // Also refresh the hypercall page so the WASM GetTickCount hypercall sees the
            // updated value within the same tick (it reads OFF_HC_TICK_COUNT directly).
            const ts = this.cachedTimeService || (this.cachedTimeService = TimeService.getInstance());
            const wallNow = performance.now();
            const deficit = wallNow - ts.nowMs();
            if (deficit > 0.5) {
                ts.advanceVirtualTime(Math.min(deficit, 16));
            }
            // Always refresh the hypercall page so WASM GetTickCount sees current
            // virtual time — even when deficit ≈ 0 (e.g. right after reanchorToWallClock).
            hypercallDataManager.refreshTimeAfterThunk(cpu);
        }

        this.notifySchedulerBoundary(cpu);

        if (!isAsync) {
            if (profileThunk) profiler.endAsync(thunkName);
            if (sampleProfiler) profiler.end("thunk_dispatch");
        }
    }


    private shouldProfileThunk(thunkName: string): boolean {
        const key = thunkName.toLowerCase();
        if (!this.sampledProfilerThunks.has(key)) {
            return true;
        }
        return (this.hotThunkProfileSampleCounter++ & this.hotThunkProfileSampleMask) === 0;
    }

    // =========================================================================
    // Helpers (Inlined manually or small)
    // =========================================================================

    /**
     * OPTIMIZED: Fill stack arguments.
     * Memory validity is checked in handlePortWrite, but we handle detached buffers gracefully.
     */
    private fillStackArgs(esp: number, count: number): void {
        const arr = this.reusableArgs;

        // Safety bounds check
        if (esp < 0 || esp + 4 + (count * 4) > this.memLength) {
            for (let i = 0; i < count; i++) arr[i] = 0;
            return;
        }

        try {
            // Fastest path: use Uint32Array if ESP is aligned (99% of cases)
            if (this.cachedMem32 && (esp & 3) === 0) {
                const baseIndex = (esp >>> 2) + 1;
                const endIndex = baseIndex + count;
                if (endIndex <= this.cachedMem32.length) {
                    const mem32 = this.cachedMem32;
                    for (let i = 0; i < count; i++) {
                        arr[i] = mem32[baseIndex + i];
                    }
                    return;
                }
            }

            // Fallback: use DataView
            const view = this.cachedDataView!;
            for (let i = 0; i < count; i++) {
                arr[i] = view.getUint32(esp + 4 + (i << 2), true);
            }
        } catch (e) {
            // Buffer was detached! Update cache and retry ONCE.
            this.updateMemoryCache();
            if (!this.cachedMem8 || this.cachedMem8.byteLength === 0) {
                for (let i = 0; i < count; i++) arr[i] = 0;
                return;
            }

            // Retry logic (simplified)
            const freshView = this.cachedDataView!;
            const freshMem32 = this.cachedMem32;

            if (freshMem32 && (esp & 3) === 0) {
                const baseIndex = (esp >>> 2) + 1;
                for (let i = 0; i < count; i++) {
                    arr[i] = freshMem32[baseIndex + i];
                }
            } else {
                for (let i = 0; i < count; i++) {
                    arr[i] = freshView.getUint32(esp + 4 + (i << 2), true);
                }
            }
        }
    }

    /**
     * OPTIMIZED: Validate return address with minimal checks.
     * Memory validity is checked once per thunk, handles detached buffers.
     */
    private validateReturnAddrFast(esp: number, allowStubPoolRet = false): boolean {
        // Minimal bounds check. NOTE: ESP need NOT be 4-byte aligned. x86 permits
        // an unaligned stack pointer, and real compilers genuinely produce one:
        // Watcom (cw3220 CRT) passes a `long double` by value as 10 bytes on the
        // stack, so for the duration of any nested call — including a Win32 API
        // call like GetModuleFileNameA from __errormessage/sprintf("%Lf") — ESP is
        // legitimately 2-byte unaligned. The return address it points at is still
        // perfectly valid; only its *value* matters. Rejecting on alignment alone
        // turned a valid call into a false "thunk stack desync, pre-call" crash
        // (Discworld Noir boot). Validate the value, not the alignment.
        if (esp < 0 || esp + 4 > this.memLength) return false;

        try {
            // Fast path: cached Uint32Array — only valid for a 4-byte-aligned ESP.
            // For an unaligned ESP fall through to the DataView path, which reads
            // unaligned offsets correctly.
            if (this.cachedMem32 && (esp & 3) === 0) {
                const index = esp >>> 2;
                if (index < this.cachedMem32.length) {
                    const retAddr = this.cachedMem32[index];
                    // Quick validation
                    if (retAddr < 0x1000 || retAddr >= this.memLength || retAddr === 0) return false;
                    if (retAddr >= BOOTLOADER_START && retAddr < BOOTLOADER_END) return false; // Bootloader range
                    if (!allowStubPoolRet && this.callbackStubPoolBase !== 0 &&
                        retAddr >= this.callbackStubPoolBase && retAddr < this.callbackStubPoolEnd) {
                        return false;
                    }
                    // STACK CORRUPTION CHECK: return address pointing to stack area (suspicious!)
                    if (retAddr >= STACK_REGION_START && retAddr < STACK_REGION_END) {
                        Logger.error(LogCategory.THUNK,
                            `?? STACK CORRUPTION: Return address 0x${retAddr.toString(16)} points to STACK! ` +
                            `ESP=0x${esp.toString(16)}, current thunk may return to garbage. ` +
                            `Last thunk: ${this.lastThunkName}`);
                    }
                    return true;
                }
            }

            // Fallback: DataView
            const view = this.cachedDataView!;
            const retAddr = view.getUint32(esp, true);
            if (retAddr < 0x1000 || retAddr >= this.memLength || retAddr === 0) return false;
            if (retAddr >= BOOTLOADER_START && retAddr < BOOTLOADER_END) return false;
            if (!allowStubPoolRet && this.callbackStubPoolBase !== 0 &&
                retAddr >= this.callbackStubPoolBase && retAddr < this.callbackStubPoolEnd) {
                return false;
            }
            // STACK CORRUPTION CHECK
            if (retAddr >= STACK_REGION_START && retAddr < STACK_REGION_END) {
                Logger.error(LogCategory.THUNK,
                    `?? STACK CORRUPTION: Return address 0x${retAddr.toString(16)} points to STACK! ` +
                    `ESP=0x${esp.toString(16)}, Last thunk: ${this.lastThunkName}`);
            }
            return true;
        } catch (e) {
            // Buffer was detached! Update cache and retry ONCE.
            this.updateMemoryCache();
            if (!this.cachedMem8 || this.cachedMem8.byteLength === 0) return false;

            // Retry with fresh cache
            const freshMem32 = this.cachedMem32;
            const freshView = this.cachedDataView!;

            let retAddr = 0;
            if (freshMem32 && (esp & 3) === 0) {
                retAddr = freshMem32[esp >>> 2];
            } else {
                retAddr = freshView.getUint32(esp, true);
            }

            if (retAddr < 0x1000 || retAddr >= this.memLength || retAddr === 0) return false;
            if (retAddr >= BOOTLOADER_START && retAddr < BOOTLOADER_END) return false;
            if (!allowStubPoolRet && this.callbackStubPoolBase !== 0 &&
                retAddr >= this.callbackStubPoolBase && retAddr < this.callbackStubPoolEnd) {
                return false;
            }
            return true;
        }
    }

    private validateReturnAddr(mem: Uint8Array, esp: number, label: string, allowStubPoolRet = false): boolean {
        if (esp < 0 || esp + 4 > mem.length) {
            Logger.error(LogCategory.THUNK, `${label}: invalid ESP 0x${esp.toString(16)} (mem size=0x${mem.length.toString(16)})`);
            return false;
        }

        // ESP should be 4-byte aligned in most cases
        if (esp % 4 !== 0) {
            Logger.warn(LogCategory.THUNK, `${label}: unaligned ESP 0x${esp.toString(16)}`);
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const returnAddr = view.getUint32(esp, true);

        // Check for common poison values or invalid ranges
        if (returnAddr < 0x1000 || returnAddr >= mem.length ||
            returnAddr === 0xcccccccc || returnAddr === 0xdeadbeef || returnAddr === 0) {
            Logger.error(LogCategory.THUNK, `${label}: invalid returnAddr 0x${returnAddr.toString(16)} (mem size=0x${mem.length.toString(16)})`);
            return false;
        }
        if (returnAddr >= BOOTLOADER_START && returnAddr < BOOTLOADER_END) {
            Logger.error(LogCategory.THUNK,
                `${label}: returnAddr 0x${returnAddr.toString(16)} in bootloader region (0x${BOOTLOADER_START.toString(16)}-0x${BOOTLOADER_END.toString(16)}) - stack already corrupted (wrong RET N in a prior thunk?). Check Recent WinAPI calls.`);
            return false;
        }
        if (!allowStubPoolRet && this.callbackStubPoolBase !== 0 &&
            returnAddr >= this.callbackStubPoolBase &&
            returnAddr < this.callbackStubPoolEnd) {
            Logger.error(LogCategory.THUNK,
                `${label}: returnAddr 0x${returnAddr.toString(16)} points into stub pool (0x${this.callbackStubPoolBase.toString(16)}-0x${this.callbackStubPoolEnd.toString(16)})`);
            return false;
        }

        // STACK CORRUPTION CHECK: return address pointing to stack area (suspicious!)
        if (returnAddr >= STACK_REGION_START && returnAddr < STACK_REGION_END) {
            Logger.error(LogCategory.THUNK,
                `${label}: ?? STACK CORRUPTION: Return address 0x${returnAddr.toString(16)} points to STACK! ` +
                `ESP=0x${esp.toString(16)}. Refusing to jump there.`);
            return false;
        }

        // Check the code at the return address
        // 0x00 0x00 is ADD [EAX], AL - very common in empty memory or uninitialized sections
        if (mem[returnAddr] === 0 && mem[returnAddr + 1] === 0) {
            Logger.warn(LogCategory.THUNK, `${label}: returnAddr 0x${returnAddr.toString(16)} points to zeroed memory (00 00...)`);
        }

        return true;
    }

    // =========================================================================
    // Sync Result Handling
    // =========================================================================

    private _handleSyncResult(result: any, id: number, name: string, cpu: any, ctx: X86Context, argCount: number, espAtEntry: number): void {
        // Direct Int32Array view — bypasses v86 Proxy trap on reg32 access.
        const reg32 = this.cachedReg32Raw ?? cpu.reg32;
        // Check if thread/process terminated
        if (typeof result === 'object' && result !== null && (result as ThunkResult).terminated) {
            Logger.log(LogCategory.THUNK, 'Thread/process terminated - handling context switch');

            // Note: After ExitThread/TerminateThread, we must NOT let CPU execute
            // the RET instruction from the thunk stub - it would use garbage from the
            // terminated thread's stack.

            // First, set EIP to spin loop to prevent executing RET with corrupt stack.
            // Also redirect [ESP] so a JIT-merged OUT+RET N pops the spin loop rather than
            // the terminated thread's garbage stack. See redirectStackToSpinLoop.
            cpu.instruction_pointer[0] = this.spinLoopAddress;
            this.redirectStackToSpinLoop(espAtEntry >>> 0);

            const sched = System.getInstance().scheduler;
            // Get thread summary to see if there are other runnable threads
            const summary = sched.getThreadSummary();
            // Note: Also consider WAITING threads - they may wake up!
            const hasOtherThreads = (summary.running + summary.ready + summary.waiting) > 0;

            Logger.log(LogCategory.THUNK,
                `Thread terminated: running=${summary.running}, ready=${summary.ready}, waiting=${summary.waiting}, terminated=${summary.terminated}, total=${summary.total}, hasOther=${hasOtherThreads}`);

            if (!hasOtherThreads || System.getInstance().isExiting) {
                // No other threads, or process is exiting (ExitProcess) - stop v86 completely
                Logger.log(LogCategory.THUNK, `No runnable threads or process exiting - stopping v86 (isExiting=${System.getInstance().isExiting})`);
                if (this.v86?.stop) {
                    this.v86.stop();
                }
            }
            // EIP is at spin loop � scheduler will switch to next thread
            this.boundaryKind = ThunkBoundaryKind.SPIN_LOOP;
            this.boundaryCleanup = 0;
            return;
        }

        // Check if thunk is suspended for callback
        if (typeof result === 'object' && result !== null && (result as ThunkResult).suspendedForCallback) {
            const suspendedResult = result as ThunkResult;

            // DO NOT write to EAX
            // DO NOT execute RET
            // DO NOT stop CPU

            // Capture CPU state at thunk entry (before any stack manipulation)
            const suspendErrCleanup = this.resolveThunkCleanup(id, argCount, `sync:suspended-err:${name}`);

            if (!this.ensureValidMemory()) {
                Logger.error(LogCategory.THUNK, 'Cannot suspend thunk: memory/DataView not available');
                this.handleSuspendedThunkError(cpu, suspendErrCleanup);
                return;
            }

            const mem8 = this.cachedMem8!;
            const view = this.cachedDataView!;
            const esp = reg32[4];  // Points to RetAddr on stack

            // Validate ESP before reading return address
            if (esp < 4 || esp + 4 > mem8.length) {
                Logger.error(LogCategory.THUNK,
                    `Invalid ESP when suspending thunk: 0x${esp.toString(16)} (memory size: 0x${mem8.length.toString(16)})`);
                this.handleSuspendedThunkError(cpu, suspendErrCleanup);
                return;
            }

            const returnAddr = view.getUint32(esp, true);

            // Validate returnAddr
            if (returnAddr < 0x1000 || returnAddr >= mem8.length) {
                Logger.error(LogCategory.THUNK,
                    `Invalid returnAddr when suspending thunk: 0x${returnAddr.toString(16)} (memory size: 0x${mem8.length.toString(16)})`);
                this.handleSuspendedThunkError(cpu, suspendErrCleanup);
                return;
            }

            // Get stack cleanup from stub (stdcall)
            const stackCleanup = argCount * 4;

            // Only save context if not already saved by the thunk itself (via CallbackManager.saveSuspendedThunkContext)
            const hasSavedThunkContext = this._callbackManager?.hasSavedThunkContext?.() ?? false;
            if (this._callbackManager && !hasSavedThunkContext) {
                this._callbackManager.saveSuspendedThunkContext(ctx, stackCleanup, name);
                Logger.verbose(LogCategory.THUNK,
                    `Suspended thunk (auto-saved context via stack): ESP=0x${esp.toString(16)}, EIP=0x${returnAddr.toString(16)}, stackCleanup=${stackCleanup}`);
            }

            // Park the callback-return stub's RET at the spin loop; otherwise it pops the
            // original game return address and resumes with a stack corrupted by the
            // missing stdcall cleanup. See redirectStackToSpinLoop.
            this.redirectStackToSpinLoop(espAtEntry);

            this.lastThunkNameAfterReturn = ""; // Don't blame this thunk for ESP mismatch after callback

            // Fix: Resume v86 to execute the callback
            // invokeCallback() sets up EIP/ESP but doesn't start execution
            // We must call v86.run() here, otherwise CPU stays halted
            if (!System.getInstance().isPaused) {
                Logger.verbose(LogCategory.THUNK, `Resuming v86 after suspending thunk for callback`);
                this.v86.run();
            }
            // Debug: Log CPU state before returning
            Logger.verbose(LogCategory.THUNK,
                `suspendedForCallback return: EIP=0x${(cpu.instruction_pointer?.[0] ?? 0).toString(16)} ` +
                `ESP=0x${(cpu.reg32[4] >>> 0).toString(16)} is_jumping=${cpu.is_jumping ?? '?'} ` +
                `thunk=${name}`);
            // EIP is at callback target � use CALLBACK_STUB (forceSave, no post-return construction)
            this.boundaryKind = ThunkBoundaryKind.CALLBACK_STUB;
            this.boundaryCleanup = 0;
            return;
        }

        // Thread blocked with no runnable peers � redirect to spin loop.
        // The thread is already in WAITING state; sleeping threads will eventually wake
        // and may signal the event. performSwitch (at tick boundary) will restore context.
        if (typeof result === 'object' && result !== null && (result as ThunkResult).blockedNoSwitch) {
            cpu.instruction_pointer[0] = this.spinLoopAddress;
            // Setting EIP alone is not enough (OUT+RET JIT atomicity) — without the [ESP]
            // redirect the RET N resumes guest code on a WAITING thread, which re-blocks
            // and trips "Invalid transition WAITING->WAITING". See redirectStackToSpinLoop.
            this.redirectStackToSpinLoop(espAtEntry);
            // Don't set EAX or clean the stack — the thread's saved post-return context
            // holds the correct values for when it's woken.
            this.lastExpectedEspAfterReturn = 0;
            this.boundaryKind = ThunkBoundaryKind.SPIN_LOOP;
            this.boundaryCleanup = 0;
            // (c) of the async-park invariant: the handler already moved
            // the thread to WAITING (blockThread), so this matches the primary parkThreadAsync
            // path — pop v86 out of its cycle loop immediately. Without this, v86 honestly
            // JIT-executes the JMP $ spin loop for the rest of the quantum (measured ~25% of
            // worker CPU) instead of yielding to the scheduler. Safe because the current thread
            // is WAITING here (cycle_limit=0 is valid only while WAITING/async-parked; the
            // per-tick prepareForExecution restores the budget for the next thread).
            preemptionManager.requestImmediateExit();
            return;
        }

        // Compute cleanup once � used by number, null, and ThunkResult branches below
        const baseCleanup = this.resolveThunkCleanup(id, argCount, `sync:${name}`);

        // Check for stack corruption (internal check)
        // Skip if skipStackCheck is set (e.g., for DispatchMessageA which calls callbacks)
        const skipStackCheck = typeof result === 'object' && result !== null && (result as ThunkResult).skipStackCheck;
        const currentEsp = reg32[4];
        if (!skipStackCheck && currentEsp !== espAtEntry && !cpu.is_jumping) {
            Logger.warn(LogCategory.THUNK, `?? STACK DRIFT: ${name} changed ESP: 0x${espAtEntry.toString(16)} -> 0x${currentEsp.toString(16)}`);
        }

        // Optimized check for simple number return
        if (typeof result === 'number') {
            reg32[0] = result >>> 0;
            this.winApiRing.recordReturnValue(result >>> 0); // crash-diagnosis ring
            const allowStub = name.includes('DefWindowProc');
            if (!this.validateReturnAddrFast(espAtEntry, allowStub)) {
                this._slowPathInvalidReturn(id, name, espAtEntry, result, cpu);
                this.boundaryKind = ThunkBoundaryKind.THUNK_STUB;
                this.boundaryCleanup = 0;
                return;
            }

            const syncCleanup = baseCleanup;
            this.boundaryKind = ThunkBoundaryKind.THUNK_STUB;
            this.boundaryCleanup = syncCleanup;
            this.lastExpectedEspAfterReturn = espAtEntry + 4 + syncCleanup;
            this.lastThunkIdAfterReturn = id;
            this.lastThunkNameAfterReturn = name;
            this.recordShadowStackAtEntry(id, espAtEntry);

            // Note: Track ESP drift - only log ERRORS (POSITIVE drift = stack corruption!)
            // Negative drift is normal (guest code does PUSH between WinAPI calls)
            if (this.lastExpectedEspAfterReturn !== 0) {
                const drift = (reg32[4] - this.lastExpectedEspAfterReturn) | 0;

                // Only ERROR log on POSITIVE drift (ESP moved UP = potential RET N bug)
                if (drift > 0) {
                    Logger.error(LogCategory.THUNK,
                        `?? ESP DRIFT UP ??! After ${this.lastThunkNameAfterReturn}, ` +
                        `expected ESP=0x${this.lastExpectedEspAfterReturn.toString(16)}, ` +
                        `actual ESP=0x${reg32[4].toString(16)}, drift=+${drift} bytes. ` +
                        `Now entering: ${name}`);
                    this.dumpShadowStackGuard(`esp_drift_${name}`);
                }
            }
            return;
        }

        // Object Result
        if (result === null) {
            reg32[0] = 0;
            const nullCleanup = baseCleanup;
            this.boundaryKind = ThunkBoundaryKind.THUNK_STUB;
            this.boundaryCleanup = nullCleanup;
            this.lastExpectedEspAfterReturn = espAtEntry + 4 + nullCleanup;
            this.lastThunkIdAfterReturn = id;
            this.lastThunkNameAfterReturn = name;
            this.recordShadowStackAtEntry(id, espAtEntry);
            return;
        }

        const thunkRes = result as ThunkResult;
        reg32[0] = thunkRes.value >>> 0;
        this.winApiRing.recordReturnValue(thunkRes.value >>> 0); // crash-diagnosis ring

        const mem8 = this.cachedMem8;
        const allowStubSync = name.includes('DefWindowProc');
        // Skip return address validation for SEH/callback thunks � ESP was moved to catch frame
        if (mem8 && !skipStackCheck && !this.validateReturnAddr(mem8, espAtEntry, `Sync thunk ${name}`, allowStubSync)) {
            Logger.error(LogCategory.THUNK,
                `Invalid return address for ${name}! ` +
                `ESP=0x${espAtEntry.toString(16)}, EAX=0x${thunkRes.value.toString(16)}. ` +
                `Preventing RET execution to avoid crash.`);

            reg32[0] = (thunkRes.value >>> 0);
            this.boundaryKind = ThunkBoundaryKind.THUNK_STUB;
            this.boundaryCleanup = 0;
            this.v86.stop();
            return;
        }
        // Fix: Use result.stackCleanup if provided (overrides stackCleanupTable)
        const decodedStubCleanup = baseCleanup;
        let finalCleanup = decodedStubCleanup;

        // Note: ThunkResult.stackCleanup takes precedence over cached value
        if (thunkRes.stackCleanup !== undefined) {
            finalCleanup = thunkRes.stackCleanup;
        }

        // Handle descriptor/stub drift: if ThunkResult.stackCleanup differs from the stub's
        // RET N, we need to adjust. But NEVER use is_jumping to set EIP directly � it's
        // unreliable in v86 JIT (OUT+RET can be compiled as one block, ignoring is_jumping).
        // Instead, use stack-based approach: adjust ESP so the stub's RET N lands correctly.
        // Note: Skip for callback-invoking thunks (skipStackCheck=true, e.g. DispatchMessage).
        if (thunkRes.stackCleanup !== undefined && !thunkRes.skipStackCheck) {
            const stubCleanup = decodedStubCleanup;
            if (finalCleanup !== stubCleanup) {
                // Drift: stub has wrong RET N. Adjust ESP so RET N lands at the right final ESP.
                // RET N does: EIP = [ESP], ESP = ESP + 4 + N
                // We want final ESP = espAtEntry + 4 + finalCleanup
                // So: adjustedEsp + 4 + stubCleanup = espAtEntry + 4 + finalCleanup
                // => adjustedEsp = espAtEntry + (finalCleanup - stubCleanup)
                if (this.isDataViewValid()) {
                    const retAddr = this.cachedDataView!.getUint32(espAtEntry, true) >>> 0;
                    const adjustedEsp = (espAtEntry + (finalCleanup - stubCleanup)) >>> 0;
                    guardStackWrite(adjustedEsp, 4, 'thunk:driftFix', retAddr);
                    this.cachedDataView!.setUint32(adjustedEsp, retAddr, true);
                    reg32[4] = adjustedEsp;
                    Logger.verbose(LogCategory.THUNK,
                        `Stack-based drift fix for ${name}: stubCleanup=${stubCleanup}, finalCleanup=${finalCleanup}, adjustedEsp=0x${adjustedEsp.toString(16)}`);
                } else {
                    Logger.error(LogCategory.THUNK, `Stack-based drift fix failed for ${name}: DataView detached`);
                }
            }
            // When stubCleanup === finalCleanup, RET N handles everything � no intervention needed
        }

        // Note: If skipStackCheck is set, a callback was invoked (EIP/ESP modified).
        // Must use CALLBACK_STUB so saveContext uses forceSave (raw CPU state), not
        // post-return construction which would read [ESP] as a return address � but
        // ESP now points at callback args, not the thunk's return address.
        this.boundaryKind = skipStackCheck
            ? ThunkBoundaryKind.CALLBACK_STUB
            : ThunkBoundaryKind.THUNK_STUB;
        this.boundaryCleanup = skipStackCheck ? 0 : finalCleanup;
        this.lastExpectedEspAfterReturn = skipStackCheck ? 0 : (espAtEntry + 4 + finalCleanup);
        this.lastThunkIdAfterReturn = id;
        this.lastThunkNameAfterReturn = name;
        this.recordShadowStackAtEntry(id, espAtEntry);

        // NOTE: SEH trampoline code lives on the thread's own stack (dead zone between
        // throwEsp and desiredEsp). We do NOT enter critical runtime here because:
        // 1. The trampoline calls funclets/destructors that make normal thunk calls.
        //    These would trigger SWITCH_DEFERRED_SEH_RUNTIME indefinitely since the
        //    catch handler's ESP overlaps with the funclet's ESP range — we can't
        //    distinguish "trampoline running" from "catch handler running normally".
        // 2. Stack-aware EIP validation in scheduler already handles preemption
        //    mid-trampoline: saveContext/isValidEipForRestore accept EIPs on the thread's
        //    stack. The trampoline code on the dead stack won't be overwritten by other
        //    threads (each thread has its own stack).
    }

    // =========================================================================
    // Async Result Handling
    // =========================================================================
    /**
     * Async thunk parking invariant:
     *
     * Any path that parks guest EIP at `spinLoopAddress` waiting for a JS
     * Promise MUST transition the current thread to WAITING before handing
     * control back to v86. Otherwise v86 burns a full quantum JIT-executing
     * the `JMP $` parking loop (measured as ~25% of worker CPU in a running
     * game before this invariant was enforced).
     *
     * Park  : scheduler.markThreadAsyncParked(tid, cpu) +
     *         preemptionManager.requestImmediateExit()
     * Wake  : _onAsyncComplete / _onAsyncError → pendingAsyncRestores →
     *         onPollAsyncRestores → tryApplyPendingAsyncRestoreAtSafePoint →
     *         scheduler.wakeThreadForAsyncCompletion(tid) (WAITING → READY),
     *         then scheduler.markThreadRunningAfterAsyncWake(tid) on the
     *         same-thread branch, then applyAsyncRestoreCpuState writes
     *         EIP/ESP/EAX.
     *
     * Safety net: preemptAtTickBoundary detects the "RUNNING with
     * eip===spinLoopBase" inconsistency, logs a warning, and retro-marks.
     * SEH stubs at spinLoop+2/+4/+0x200 are NOT async parking — the net
     * uses strict equality on spinLoopBase to avoid interfering.
     */
    private _handleAsyncResult(
        promise: Promise<any>,
        id: number,
        name: string,
        cpu: any,
        esp: number,
        argCount: number,
        thunkStartTime: number
    ): void {
        // NOTE: profiler.end() is now called in _onAsyncComplete/_onAsyncError
        // to measure full async duration, not just sync part.
        const thunkInfo = this.parkThreadAsync(promise, id, name, cpu, esp);
        if (!thunkInfo) return;

        const asyncStart = thunkStartTime;
        // Closure is inevitable here, but it's async so less critical
        promise.then((res) => {
            this._onAsyncComplete(promise, res, thunkInfo, cpu, argCount, name, asyncStart);
        }).catch((err) => {
            this._onAsyncError(promise, err, thunkInfo, cpu, argCount, name, asyncStart);
        });
    }

    /**
     * Atomically park the current thread on the async spin loop while a JS Promise is
     * pending. Performs the THREE steps that MUST happen together so no
     * call site can do a partial park:
     *   (a) write JMP $ (0xEB 0xFE) at spinLoopAddress;
     *   (b) overwrite [esp] so the stub's RET N lands on the spin loop instead of resuming
     *       guest code (v86's JIT can compile OUT+RET N as one block, so is_jumping alone
     *       is not enough — see redirectStackToSpinLoop);
     *   (c) transition the thread to WAITING + pop v86 out of its cycle loop immediately
     *       (else v86 JIT-burns a full quantum on JMP $, ~25% of worker CPU).
     * Registers the parking record in activeAsyncThunks (keyed by promise) and sets the
     * scheduler boundary to SPIN_LOOP. Returns the record, or null if guest memory is
     * unavailable (caller then skips promise wiring). Wake path: see _onAsyncComplete.
     */
    private parkThreadAsync(
        promise: Promise<any>,
        id: number,
        name: string,
        cpu: any,
        esp: number
    ): ActiveAsyncThunk | null {
        const mem = this.cachedMem8;
        if (!mem) return null;
        const spinAddr = this.spinLoopAddress;
        const originalBytes: [number, number] = [mem[spinAddr] || 0x00, mem[spinAddr + 1] || 0x00];

        // (a) Write JMP $ — spins until async completes (HLT doesn't play well with v86).
        mem[spinAddr] = JMP_REL8;
        mem[spinAddr + 1] = JMP_LOOP;

        // (b) Stack-based redirect: overwrite [ESP] so the stub's RET N pops the spin loop.
        // returnAddr is the original guest return address (restored on async completion);
        // stackSnapshot guards against corruption during the spin.
        const returnAddr = this.redirectStackToSpinLoop(esp);
        let stackSnapshot: Uint8Array | undefined;
        if (returnAddr !== undefined) {
            if (this.thunkGeneratorBase !== 0 &&
                returnAddr >= this.thunkGeneratorBase && returnAddr < this.thunkGeneratorEnd) {
                Logger.error(LogCategory.THUNK,
                    `SUSPICIOUS: Async thunk ${name} returnAddr 0x${returnAddr.toString(16)} inside THUNK region! ESP=0x${esp.toString(16)}`);
            }
            stackSnapshot = mem.slice(esp, Math.min(esp + 16, mem.length));
        }

        const tid = System.getInstance().scheduler.getCurrentThreadId();
        const thunkInfo: ActiveAsyncThunk = {
            functionId: id,
            functionName: name,
            startTime: performance.now(),
            threadId: tid,
            asyncParkGeneration: 0,
            esp,
            returnAddr,
            stackSnapshot,
            spinAddr,
            originalSpinBytes: originalBytes,
            callerModuleBase: this.lastCallerModuleBase
        };

        // Set boundary state for scheduler: CPU is now at spin loop.
        this.boundaryKind = ThunkBoundaryKind.SPIN_LOOP;
        this.boundaryCleanup = 0;

        // (c) HLE async parking: move the current thread to WAITING so the scheduler skips
        // it and v86 leaves its cycle loop immediately. If the guard rejects (unexpected
        // state, feature flag off), fall back to legacy spin behaviour — no regression.
        const scheduler = System.getInstance().scheduler;
        if (scheduler.markThreadAsyncParked(tid, cpu)) {
            thunkInfo.asyncParkGeneration = scheduler.getAsyncParkGeneration(tid);
            (scheduler as any).traceAsyncRestore?.("parkThreadAsync", cpu,
                `thunk=${name},fn=0x${(id >>> 0).toString(16)},T${tid}/g${thunkInfo.asyncParkGeneration},` +
                `esp=0x${(esp >>> 0).toString(16)},ret=0x${((returnAddr ?? 0) >>> 0).toString(16)}`);
            preemptionManager.requestImmediateExit();
        } else {
            (scheduler as any).traceAsyncRestore?.("parkThreadAsync", cpu,
                `legacy-spin fallback thunk=${name},fn=0x${(id >>> 0).toString(16)},T${tid},` +
                `esp=0x${(esp >>> 0).toString(16)},ret=0x${((returnAddr ?? 0) >>> 0).toString(16)}`);
        }

        this.activeAsyncThunks.set(promise, thunkInfo);
        return thunkInfo;
    }

    private _onAsyncComplete(promise: any, res: any, info: ActiveAsyncThunk, _cpu: any, defaultArgCount: number, name: string, asyncStart: number): void {
        this.activeAsyncThunks.delete(promise);
        this.recordAsyncPark(name, info.threadId ?? 0, performance.now() - info.startTime);
        const duration = frameProfiler.endTimer("thunk", asyncStart);
        frameProfiler.recordThunk(name, duration);
        frameProfiler.markThunkEnd();

        // End profiler span for async thunk (measures full async duration)
        if (profiler.isEnabled()) profiler.endAsync(name);

        let val: number = 0;
        let cleanupBytes = this.resolveThunkCleanup(info.functionId, defaultArgCount, `async:${name}`);

        if (typeof res === 'object' && res !== null) {
            val = res.value;
            if (res.stackCleanup !== undefined) {
                cleanupBytes = res.stackCleanup;
            }
        } else {
            val = res as number;
        }

        // Auto-parse stackCleanup from @N decoration if not explicitly provided.
        if (cleanupBytes === 0) {
            const thunkName = this.namesTable[info.functionId] || '';
            const parsedCleanup = parseStdcallCleanup(thunkName);
            if (parsedCleanup !== null) {
                cleanupBytes = parsedCleanup;
                Logger.verbose(LogCategory.THUNK,
                    `Auto-parsed stackCleanup=${parsedCleanup} from function name: ${thunkName}`);
            }
        }

        const deferredWrites = (typeof res === 'object' && res !== null) ? res.deferredWrites : undefined;
        const dllInits = typeof res === 'object' && res !== null ? (res as ThunkResult).dllInits : undefined;
        const startCallbackChain = (typeof res === 'object' && res !== null) ? (res as ThunkResult).startCallbackChain : undefined;

        // Faithful invariant: a parked thread has ≤1 outstanding async syscall (it cannot issue
        // another until this one returns). A duplicate here means a double-park / lost resume.
        if (info.threadId !== undefined && this.indexOfPendingRestoreForThread(info.threadId) >= 0) {
            Logger.warn(LogCategory.THUNK,
                `Async-restore invariant violated: T${info.threadId} already has a pending restore on push of ${name} ` +
                `(a parked thread should have ≤1 outstanding async syscall) — possible double-park / lost resume.`);
        }
        this.pendingAsyncRestores.push({
            info,
            returnValue: val >>> 0,
            cleanupBytes: cleanupBytes >>> 0,
            deferredWrites,
            dllInits,
            startCallbackChain,
            errorFlag: false,
            completionName: name,
        });
        if (info.threadId !== undefined) {
            (this.ensureScheduler() as any).traceTimerEvent?.(info.threadId,
                `restoreQueued ${name} ret=0x${((info.returnAddr ?? 0) >>> 0).toString(16)}`);
            (this.ensureScheduler() as any).traceAsyncRestore?.("onAsyncComplete", null,
                `queued thunk=${name},fn=0x${(info.functionId >>> 0).toString(16)},` +
                `T${info.threadId}/g${info.asyncParkGeneration ?? 0},ret=0x${((info.returnAddr ?? 0) >>> 0).toString(16)},` +
                `esp=0x${((info.esp ?? 0) >>> 0).toString(16)},cleanup=${cleanupBytes >>> 0},queue=${this.pendingAsyncRestores.length}`);
        }

        // If every guest thread had parked, v86 has left its run loop entirely
        // and no tick hook will fire to drain this restore — restart it.
        this.kickV86IfIdleForAsyncWake();
    }

    private _onAsyncError(promise: any, err: any, info: ActiveAsyncThunk, _cpu: any, defaultArgCount: number, name: string, asyncStart: number): void {
        this.activeAsyncThunks.delete(promise);
        this.recordAsyncPark(name, info.threadId ?? 0, performance.now() - info.startTime);

        const duration = frameProfiler.endTimer("thunk", asyncStart);
        frameProfiler.recordThunk(name, duration);
        frameProfiler.markThunkEnd();

        // End profiler span for async thunk (measures full async duration including error)
        if (profiler.isEnabled()) profiler.endAsync(name);

        Logger.error(LogCategory.THUNK, `Async error in thunk ${name} (ID ${info.functionId}): ${err}`);

        const cleanupBytes = this.resolveThunkCleanup(info.functionId, defaultArgCount, `async_error:${name}`);
        if (info.threadId !== undefined && this.indexOfPendingRestoreForThread(info.threadId) >= 0) {
            Logger.warn(LogCategory.THUNK,
                `Async-restore invariant violated: T${info.threadId} already has a pending restore on error-push of ${name} ` +
                `(a parked thread should have ≤1 outstanding async syscall) — possible double-park / lost resume.`);
        }
        this.pendingAsyncRestores.push({
            info,
            returnValue: 0,
            cleanupBytes: cleanupBytes >>> 0,
            deferredWrites: undefined,
            dllInits: undefined,
            errorFlag: true,
            completionName: name,
        });
        if (info.threadId !== undefined) {
            (this.ensureScheduler() as any).traceAsyncRestore?.("onAsyncError", null,
                `queued-error thunk=${name},fn=0x${(info.functionId >>> 0).toString(16)},` +
                `T${info.threadId}/g${info.asyncParkGeneration ?? 0},ret=0x${((info.returnAddr ?? 0) >>> 0).toString(16)},` +
                `esp=0x${((info.esp ?? 0) >>> 0).toString(16)},cleanup=${cleanupBytes >>> 0},queue=${this.pendingAsyncRestores.length}`);
        }

        this.kickV86IfIdleForAsyncWake();
    }

    /**
     * Restart v86 if it has fully stopped while an async restore is pending.
     *
     * When the last runnable guest thread parks on an async thunk, the park path
     * calls preemptionManager.requestImmediateExit() and the scheduler's idle
     * handling stops v86 — but a Promise that resolves AFTER that point only
     * pushes onto pendingAsyncRestores; nothing re-enters preemptAtTickBoundary /
     * onPollAsyncRestores to apply it. The guest CPU then stays dead forever
     * (heartbeat: "v86 is NOT running", pendingRestores>0; T_n READY at spinLoop).
     * One run() lets the tick-hook machinery wake the target thread and drain the
     * restore. v86.run() is safe to call redundantly — main.js's tick_counter
     * guard ignores all but the latest scheduled tick.
     *
     * Skipped when a yieldToHost pause is active (intentionalYield): its resume()
     * already drains restores and restarts v86.
     */
    private kickV86IfIdleForAsyncWake(): void {
        const sys = System.getInstance();
        if (sys.isExiting || sys.isPaused) return;
        const scheduler = sys.scheduler;
        (scheduler as any)?.traceAsyncRestore?.("kickV86IfIdleForAsyncWake", null,
            `pending=${this.pendingAsyncRestores.length},intentionalYield=${scheduler?.intentionalYield ? 1 : 0}`);
        if (scheduler?.intentionalYield) {
            // The worker is parked in a setTimeout-based idle yield (e.g. "allBlocked",
            // capped at ~50ms). This completion just queued a restore — resume the yield
            // now rather than waiting out the timer; resume() drains restores + runs v86.
            // wakeEarlyFromIdleYield returns false for the MessageChannel fast-path yield
            // and when a resume is already in flight; in those cases fall through to the
            // is_running check below rather than trusting the flag and doing nothing.
            if (scheduler.wakeEarlyFromIdleYield()) return;
        }
        const v86 = this.v86 ?? sys.process?.v86;
        if (!v86?.run) return;
        if (v86.is_running?.()) return;
        v86.run();
    }

    hasPendingAsyncRestores(): boolean {
        return this.pendingAsyncRestores.length > 0;
    }

    /** See CallbackManager.hasLiveFrameForThread — scheduler pump-park gate. */
    threadOwnsSuspendedFrame(threadId: number): boolean {
        return this._callbackManager?.hasLiveFrameForThread(threadId) ?? false;
    }

    hasPendingAsyncRestoreForThread(threadId: number | null): boolean {
        if (this.pendingAsyncRestores.length === 0) return false;
        if (threadId === null) return true;
        const target = threadId >>> 0;
        for (let i = 0; i < this.pendingAsyncRestores.length; i++) {
            const pendingThreadId = this.pendingAsyncRestores[i].info.threadId;
            if ((pendingThreadId ?? 0) === target) return true;
        }
        return false;
    }

    peekPendingAsyncRestoreDescriptor(): PendingAsyncRestoreDescriptor | null {
        if (this.pendingAsyncRestores.length === 0) return null;
        const pending = this.pendingAsyncRestores[0];
        return {
            threadId: (pending.info.threadId ?? 0) >>> 0,
            asyncParkGeneration: (pending.info.asyncParkGeneration ?? 0) >>> 0,
            functionId: pending.info.functionId >>> 0,
            returnValue: pending.returnValue >>> 0,
            cleanupBytes: pending.cleanupBytes >>> 0,
            completionName: pending.completionName,
            errorFlag: !!pending.errorFlag,
            esp: pending.info.esp ?? 0,
            returnAddr: pending.info.returnAddr ?? 0,
            deferredWrites: pending.deferredWrites,
            dllInits: pending.dllInits,
        };
    }

    /**
     * Drain ready async-thunk completions — FAITHFUL to NT thread-wait semantics: completions are
     * PER-THREAD and independent (IoCompleteRequest → KiUnwaitThread readies one thread; there is no
     * cross-thread ordering). The old code drained only pendingAsyncRestores[0] under a single guard,
     * so a blocked head starved every other thread's already-ready completion — head-of-line blocking
     * that NT could never exhibit, and the root of a class of livelocks (a thread's restore queued-but-never-
     * applied behind a blocked head while another thread spins forever). Two phases, mirroring the kernel:
     *
     *   Phase 1 — SIGNAL (≙ KiUnwaitThread): ready every completed CROSS-thread waiter. A pure
     *     scheduler state transition — no CPU registers touched → ALWAYS safe, independent of what the
     *     current thread is doing. Per-thread, so no head-of-line blocking.
     *   Phase 2 — RESUME (≙ dispatch): apply the CURRENT thread's own completion at its safe
     *     blocked-point (it is parked at the spin loop). The current thread is the ONLY one whose live
     *     stack a restore could clobber, so the safe-point guards apply here and only here. A readied
     *     cross-thread waiter resumes via this same path once the scheduler switches to it.
     */
    tryApplyPendingAsyncRestoreAtSafePoint(cpu: any, source: string = "onPollAsyncRestores"): boolean {
        if (this.pendingAsyncRestores.length === 0) return false;

        const scheduler = this.ensureScheduler();
        (scheduler as any).traceAsyncRestore?.(source, cpu,
            `poll pending=${this.pendingAsyncRestores.length},current=${scheduler.getCurrentThreadId?.() ?? 0}`);

        for (let i = this.pendingAsyncRestores.length - 1; i >= 0; i--) {
            const pending = this.pendingAsyncRestores[i];
            const cls = this.classifyPendingAsyncRestore(pending, `${source}:preflight`);
            if (cls.ok) { pending.transientValidationRetries = 0; continue; }
            if (cls.transient) {
                // The target stack page is momentarily non-writable (CoW fault / decommit-recommit
                // window during heavy ddraw+audio churn). newEsp is stable; its writability is live.
                // Keep the restore queued and re-validate on a later drain instead of killing the
                // thread — a dropped completion strands an async-parked thread forever (no other waker).
                const n = (pending.transientValidationRetries = (pending.transientValidationRetries ?? 0) + 1);
                if (n < ThunkDispatcher.ASYNC_RESTORE_MAX_VALIDATION_RETRIES) {
                    if (n === 1 || (n & 7) === 0) {
                        Logger.warn(LogCategory.THUNK,
                            `async restore transient miss for ${pending.completionName} (${cls.reason}) — retry ${n}/${ThunkDispatcher.ASYNC_RESTORE_MAX_VALIDATION_RETRIES}`);
                    }
                    continue;
                }
                // Exhausted: the target never became writable → genuinely bad. Escalate as before.
            }
            this.rejectPendingAsyncRestore(pending, cpu, `${source}:preflight`, cls.reason);
            this.pendingAsyncRestores.splice(i, 1);
        }
        if (this.pendingAsyncRestores.length === 0) return false;

        const currentTid = scheduler.getCurrentThreadId();

        // ── Phase 1 — SIGNAL: ready every completed cross-thread waiter (idempotent, register-free).
        let switchTarget = -1;
        for (let i = 0; i < this.pendingAsyncRestores.length; i++) {
            const tid = this.pendingAsyncRestores[i].info.threadId;
            if (tid === undefined || (tid >>> 0) === ((currentTid ?? -1) >>> 0)) continue;
            if (scheduler.wakeThreadForAsyncCompletion(tid) && switchTarget < 0) switchTarget = tid >>> 0;
        }

        // ── Phase 2 — RESUME: apply the current thread's own completion, if at a safe point.
        if (currentTid !== null) {
            const idx = this.indexOfPendingRestoreForThread(currentTid);
            if (idx >= 0 && this.canApplyCurrentThreadRestore(cpu, this.pendingAsyncRestores[idx])) {
                const pending = this.pendingAsyncRestores[idx];
                scheduler.wakeThreadForAsyncCompletion(currentTid);     // WAITING→READY (idempotent)
                scheduler.markThreadRunningAfterAsyncWake(currentTid);  // READY→RUNNING; regs are live, no performSwitch
                this.applyPendingAsyncRestoreAtSafePoint(pending, cpu);
                this.pendingAsyncRestores.splice(idx, 1);
                (scheduler as any).traceTimerEvent?.(currentTid,
                    `restoreApplied ${pending.completionName} ret=0x${((pending.info.returnAddr ?? 0) >>> 0).toString(16)}`);
                return true;  // applied this tick → caller early-returns
            }
        }

        // ── Drive a switch toward a readied cross-thread target so Phase 2 applies it there next tick.
        // Defer while the current thread is pinned mid callback-chain (its stack must stay intact);
        // the readied threads are already in the run queue, so the normal quantum logic picks them up
        // once the pin releases.
        if (switchTarget >= 0) {
            const current = (scheduler as any).getCurrentThread?.();
            if (!(current && current.kernelPinCount > 0)) {
                scheduler.requestSwitchToThread(switchTarget);
            }
        }
        return false;
    }

    /** Max consecutive transient (target-page-not-writable) validation retries before escalating. */
    private static readonly ASYNC_RESTORE_MAX_VALIDATION_RETRIES = 16;

    /**
     * Classify a pending restore's validity WITHOUT side effects. `transient: true` flags a failure
     * worth retrying on a later drain (a momentarily non-writable target stack page during CoW/
     * decommit churn — the address is stable, only its writability is live); every other failure is
     * a stable property (terminated/missing thread, stale generation, bad returnAddr, misalignment)
     * where retrying cannot help. Pure so the preflight can decide retry-vs-escalate per reason.
     */
    private classifyPendingAsyncRestore(pending: PendingAsyncRestore, source: string): { ok: boolean; transient: boolean; reason: string } {
        const scheduler: any = this.ensureScheduler();
        const info = pending.info;
        if (info.threadId === undefined) return { ok: false, transient: false, reason: 'no-threadId' };
        if (info.esp === undefined) return { ok: false, transient: false, reason: 'missing-park-esp' };

        const newEsp = (info.esp + 4 + (pending.cleanupBytes >>> 0)) >>> 0;
        const valid = scheduler.validateAsyncRestoreTarget?.({
            threadId: info.threadId,
            asyncParkGeneration: (info.asyncParkGeneration ?? 0) >>> 0,
            returnAddr: info.returnAddr ?? 0,
            newEsp,
            source,
            completionName: pending.completionName,
            functionId: info.functionId,
            cleanupBytes: pending.cleanupBytes,
        });
        if (valid && !valid.ok) {
            const reason = valid.reason ?? 'invalid-async-restore';
            return { ok: false, transient: reason.startsWith('newEsp-not-writable'), reason };
        }
        return { ok: true, transient: false, reason: '' };
    }

    /** Side-effecting rejection (terminate worker thread / fatal-guard main / log) for a pending
     *  restore that failed validation terminally or exhausted its transient retries. */
    private rejectPendingAsyncRestore(pending: PendingAsyncRestore, cpu: any, source: string, reason: string): void {
        const info = pending.info;
        const threadId = info.threadId;
        if (threadId === undefined) {
            Logger.error(LogCategory.THUNK,
                `ASYNC_RESTORE_REJECT: ${pending.completionName} has no threadId; dropping pending restore`);
            return;
        }
        const scheduler: any = this.ensureScheduler();
        const esp = info.esp ?? 0;
        const newEsp = (esp + 4 + (pending.cleanupBytes >>> 0)) >>> 0;
        const generation = (info.asyncParkGeneration ?? 0) >>> 0;
        scheduler.rejectAsyncRestore?.(
            threadId,
            reason,
            source,
            cpu,
            `name=${pending.completionName},fn=0x${(info.functionId >>> 0).toString(16)},` +
            `T${threadId}/g${generation},ret=0x${((info.returnAddr ?? 0) >>> 0).toString(16)},` +
            `esp=0x${(esp >>> 0).toString(16)},newEsp=0x${newEsp.toString(16)},cleanup=${pending.cleanupBytes >>> 0}`,
        );
    }

    /** Index of the (at most one) pending async restore belonging to a thread; -1 if none.
     *  A blocked thread has ≤1 outstanding async syscall — it cannot issue another until that one
     *  returns — so per-thread lookup is well-defined and replaces the old head-only scan. (The
     *  dead `tryApplyPendingAsyncRestoreLivelockOverride` that used to live here was a manual
     *  by-threadId bypass of head-of-line blocking; the two-phase drain makes it the normal path.) */
    private indexOfPendingRestoreForThread(threadId: number | null): number {
        if (threadId === null) return -1;
        const t = threadId >>> 0;
        for (let i = 0; i < this.pendingAsyncRestores.length; i++) {
            if (((this.pendingAsyncRestores[i].info.threadId ?? -1) >>> 0) === t) return i;
        }
        return -1;
    }

    /**
     * Safe-point guard for resuming the CURRENT thread's own async completion (Phase 2 of
     * tryApplyPendingAsyncRestoreAtSafePoint). The only thread whose live stack a register restore
     * can corrupt is the current one, so these guards are scoped to it. Cross-thread completions
     * never reach here — they are READY-signalled in Phase 1 and resume at their own spin-loop safe
     * point once the scheduler switches to them.
     */
    private canApplyCurrentThreadRestore(cpu: any, pending: PendingAsyncRestore): boolean {
        if (!this._callbackManager) return false;
        this.updateMemoryCache();
        const eip = cpu.instruction_pointer[0] >>> 0;

        // At the spin loop: always safe — the CPU is parked waiting for this very async result.
        if (this.spinLoopAddress > 0 && eip >= this.spinLoopAddress && eip < this.spinLoopAddress + 4) {
            return true;
        }
        // Current thread resuming its OWN async-parked syscall: always safe. Its live EIP is residue
        // of the OUT that started the async (often resting inside a thunk/callback stub), NOT an active
        // stub frame — applyAsyncRestoreCpuState overwrites EIP/ESP wholesale (it uses info.returnAddr,
        // not [ESP]). Without this the stub-range guards below would jam a parked thread's own resume.
        const tid = pending.info.threadId;
        if (tid !== undefined && (this.ensureScheduler() as any).isThreadAsyncParked?.(tid)) {
            return true;
        }
        // Otherwise protect the current thread's in-flight callback chain / stack: a restore here
        // would clobber a live callback frame. Defer until the chain unwinds.
        const cbMgr = this._callbackManager;
        const hasInFlightCallbacks = typeof (cbMgr as any).hasInFlightCallbacks === 'function'
            ? (cbMgr as any).hasInFlightCallbacks()
            : cbMgr.getPendingCount() > 0;
        if (hasInFlightCallbacks || cbMgr.hasSavedThunkContext()) {
            return false;
        }
        if (this.isInAsyncCallbackStubRange(eip)) return false;
        if (this.isInAsyncThunkStubReturnPath(eip)) return false;
        return true;
    }


    private isInAsyncCallbackStubRange(eip: number): boolean {
        return this.callbackStubPoolBase > 0 &&
            this.callbackStubPoolEnd > this.callbackStubPoolBase &&
            eip >= this.callbackStubPoolBase &&
            eip < this.callbackStubPoolEnd;
    }

    private isInAsyncThunkStubReturnPath(eip: number): boolean {
        if (this.thunkGeneratorBase === 0 || eip < this.thunkGeneratorBase || eip >= this.thunkGeneratorEnd) {
            return false;
        }
        const stubStart = (eip & ~0xF) >>> 0;
        const offset = (eip - stubStart) >>> 0;
        if (offset < 10 || offset > 13) return false;

        const mem = this.cachedMem8;
        if (!mem || stubStart + 14 > mem.length) {
            return true;
        }
        if (mem[stubStart] !== 0xB8 || mem[stubStart + 5] !== 0xBA || mem[stubStart + 10] !== 0xEF) {
            return true;
        }
        return true;
    }

    private applyPendingAsyncRestoreAtSafePoint(pending: PendingAsyncRestore, cpu: any): void {
        const { info, returnValue, cleanupBytes, completionName, deferredWrites, dllInits, startCallbackChain } = pending;

        // Deferred guest-callback chain (ThunkResult.startCallbackChain): the async handler described a
        // callback chain instead of mutating the CPU eagerly. The thread is now RUNNING with the CPU live
        // at the spin loop (the same safe state the dllInits branch below relies on). Restore the spin-loop
        // bytes (no longer spinning) and initiate the chain with the genuine guest return frame captured at
        // park, so its saveSuspendedThunkContext records the real caller. invokeCallback inside sets EIP/ESP
        // to the first callback; the chain runs to completion and returns to the guest via its own suspended
        // frame — so we must NOT also _restoreAsyncContext (that double-restore is the 0x7c07 corruption).
        if (startCallbackChain) {
            this.updateMemoryCache();
            if (info.spinAddr !== undefined && info.originalSpinBytes && this.cachedMem8) {
                this.cachedMem8[info.spinAddr] = info.originalSpinBytes[0];
                this.cachedMem8[info.spinAddr + 1] = info.originalSpinBytes[1];
            }
            if (!this.cachedMem8) {
                Logger.error(LogCategory.THUNK, `startCallbackChain (${completionName}): memory unavailable`);
                this._restoreAsyncContext(info, cpu, returnValue, cleanupBytes, completionName, deferredWrites);
                return;
            }
            let started = false;
            try {
                started = startCallbackChain({ esp: info.esp ?? 0, returnAddr: (info.returnAddr ?? 0) >>> 0, mem: this.cachedMem8 });
            } catch (e) {
                Logger.error(LogCategory.THUNK, `startCallbackChain (${completionName}) threw: ${e}`);
                started = false;
            }
            if (!started) {
                // Chain did not set up the callback (no CPU mutation happened) — resume the guest normally
                // so the parked thread is never stranded at the spin loop.
                Logger.warn(LogCategory.THUNK, `startCallbackChain (${completionName}) did not start — falling back to plain return`);
                this._restoreAsyncContext(info, cpu, returnValue, cleanupBytes, completionName, deferredWrites);
            }
            return;
        }

        const baseName = completionName.includes(':') ? completionName.split(':')[1] : completionName;
        const isLoadLibrary = baseName === 'LoadLibraryExW' || baseName === 'LoadLibraryExA' ||
            baseName === 'LoadLibraryW' || baseName === 'LoadLibraryA';

        if (dllInits && dllInits.length > 0 && isLoadLibrary && this._callbackManager) {
            const baseAddress = returnValue >>> 0;
            const esp = info.esp ?? 0;
            const returnAddr = info.returnAddr;

            this.updateMemoryCache();
            if (info.spinAddr !== undefined && info.originalSpinBytes && this.cachedMem8) {
                this.cachedMem8[info.spinAddr] = info.originalSpinBytes[0];
                this.cachedMem8[info.spinAddr + 1] = info.originalSpinBytes[1];
            }

            Logger.warn(LogCategory.THUNK,
                `[DllMain] Invoking ${dllInits.length} DllMain(s) for ${completionName}: ` +
                `${dllInits.map(d => `${d.name}@0x${d.entryPoint.toString(16)}`).join(', ')}`);

            const dllMainFrameId = this._callbackManager.saveSuspendedThunkContext(
                { esp, returnAddr } as unknown as X86Context,
                cleanupBytes,
                'DllMainChain'
            );
            if (!dllMainFrameId) {
                Logger.error(LogCategory.THUNK, `[DllMain] Failed to save suspended thunk frame for ${completionName}`);
                this._restoreAsyncContext(info, cpu, returnValue, cleanupBytes, completionName, deferredWrites);
                return;
            }

            let initIndex = 0;
            const completeThunk = (_ret: number): number | null => {
                initIndex++;
                if (initIndex < dllInits.length) {
                    const next = dllInits[initIndex];
                    Logger.log(LogCategory.THUNK,
                        `[DllMain] Chaining to ${next.name} DllMain at 0x${next.entryPoint.toString(16)}`);
                    try {
                        this._callbackManager!.invokeCallback(
                            next.entryPoint,
                            [next.baseAddress, 1, 0],
                            0,
                            completeThunk,
                            false,
                            'DllMainChain',
                            dllMainFrameId
                        );
                        return null;
                    } catch (e) {
                        Logger.warn(LogCategory.THUNK, `[DllMain] Failed to invoke ${next.name}: ${e}`);
                        return baseAddress;
                    }
                }
                Logger.log(LogCategory.THUNK, `[DllMain] All ${dllInits.length} DllMain(s) completed`);
                return baseAddress;
            };

            const first = dllInits[0];
            this._callbackManager.invokeCallback(
                first.entryPoint,
                [first.baseAddress, 1, 0],
                0,
                completeThunk,
                false,
                'DllMainChain',
                dllMainFrameId
            );

            return;
        }

        this._restoreAsyncContext(info, cpu, returnValue, cleanupBytes, completionName, deferredWrites);
    }

    /**
     * Pure decision for the async-restore target ESP (see {@link _restoreAsyncContext}).
     *
     * `newEsp = parkEsp + 4 + cleanupBytes` is the RET-N result derived from the *recorded*
     * cleanup. v86 may already have executed the stub's genuine `RET N` on the same-thread
     * early-wake path, in which case `liveEsp` is the ground truth. We trust `liveEsp` only
     * when it equals NEITHER the computed `newEsp` NOR the park-time `parkEsp+4`:
     *  - `liveEsp === newEsp`     → recorded cleanup was right; nothing to do.
     *  - `liveEsp === parkEsp+4`  → cross-thread/context-restore state (v86 did NOT run the
     *                               stub RET N); `newEsp` is authoritative — must NOT override.
     *  - otherwise                → v86 ran a RET N that disagrees with our recorded cleanup;
     *                               forcing `newEsp` would misalign ESP → wild EBP. Trust v86.
     */
    static reconcileAsyncRestoreEsp(parkEsp: number, cleanupBytes: number, liveEsp: number): { esp: number; mismatch: boolean } {
        const newEsp = (parkEsp + 4 + cleanupBytes) >>> 0;
        const parkEspPlus4 = (parkEsp + 4) >>> 0;
        const le = liveEsp >>> 0;
        // liveEsp === parkEsp ⇒ the stub tail (RET N) has NOT executed at all: the thread
        // parked at the OUT and the restore is being applied before v86 ever resumed the
        // stub (early-wake path — frequent once the wasm park-exit stopped burning slice
        // tails in the spin loop). The recorded cleanup is authoritative; "trusting" the
        // live ESP here would apply the pre-RET-N ESP → frame short by 4+cleanup bytes →
        // wild EBP → guest SEH → silent ExitProcess(0) (observed on NFSU: LoadLibraryA
        // cleanup=4 and Present cleanup=20, both with liveEsp===parkEsp in the report).
        if (le === (parkEsp >>> 0)) {
            return { esp: newEsp, mismatch: false };
        }
        if (le !== newEsp && le !== parkEspPlus4) {
            return { esp: le, mismatch: true };
        }
        return { esp: newEsp, mismatch: false };
    }

    private _restoreAsyncContext(info: ActiveAsyncThunk, cpu: any, returnValue: number, cleanupBytes: number, name: string, deferredWrites?: DeferredWrite[]): void {
        // Refresh memory cache after async operations
        this.updateMemoryCache();

        if (!this.cachedMem8 || this.cachedMem8.byteLength === 0) {
            Logger.error(LogCategory.THUNK, `Cannot restore async context: memory is detached`);
            return;
        }

        // Ensure DataView is valid - use safe check through cachedMem8
        if (!this.isDataViewValid()) {
            this.updateMemoryCache();
            if (!this.isDataViewValid()) {
                Logger.error(LogCategory.THUNK, `Cannot restore async context: DataView is detached`);
                return;
            }
        }

        const mem8 = this.cachedMem8!;
        const view = this.cachedDataView!;

        // Restore spin bytes
        if (info.spinAddr !== undefined && info.originalSpinBytes) {
            mem8[info.spinAddr] = info.originalSpinBytes[0];
            mem8[info.spinAddr + 1] = info.originalSpinBytes[1];
        }

        // Simulate RET N
        const esp = info.esp!; // Captured at call time

        if (!this.validateReturnAddr(mem8, esp, `Async thunk return (${name})`)) {
            Logger.error(LogCategory.THUNK, `Stopping due to invalid return address (async). ` +
                `Saved returnAddr=0x${(info.returnAddr ?? 0).toString(16)}, ESP=0x${esp.toString(16)}`);
            System.getInstance().isExiting = true;
            try {
                const sched = System.getInstance().scheduler;
                sched.reportFatalGuard(0x2001, info.functionId >>> 0, info.threadId ?? 0);
            } catch { }
            return;
        }

        // Stack integrity: [ESP] should still contain our spinAddr write.
        // If it doesn't, something corrupted the stack during the async wait.
        const retAddr = view.getUint32(esp, true);
        if (info.spinAddr !== undefined && retAddr !== info.spinAddr) {
            Logger.error(LogCategory.THUNK,
                `Async thunk ${name} stack corrupted during spin: [ESP]=0x${retAddr.toString(16)} expected spinAddr=0x${info.spinAddr.toString(16)} (ESP=0x${esp.toString(16)})`);
        }

        // Restore to the saved game return address (we overwrote [ESP] with spinAddr on entry)
        const eipLinear = (info.returnAddr ?? retAddr) >>> 0;

        // Note: Apply deferred writes BEFORE simulating RET N
        // At this point ESP is still at original position (captured at call time)
        // Out-params on stack are still valid and writable
        const newEsp = esp + 4 + cleanupBytes;

        // ── ESP reconciliation (Re-Volt mac wild-EBP wedge class) ───────────────────────
        // `newEsp` is computed from the *recorded* cleanupBytes. On the same-thread early-wake
        // path v86's JIT has already executed the stub's genuine `RET N` (OUT+RET N compiled in
        // one block → the RET ran, landed on the spin loop, and the thread was spinning in place
        // with no further pushes), so the LIVE esp is ground truth: liveEsp = esp + 4 + actualN.
        // If that disagrees with newEsp, the recorded cleanupBytes is wrong for this thunk and
        // forcing newEsp would shift esp by (cleanupBytes − actualN); ESP re-aligns on a later
        // RET N but a `pop ebp` in between loads the wrong slot → wild EBP / control-flow
        // corruption (the observed wedge). Trust v86's actual execution and log it.
        // We only override when liveEsp is NEITHER newEsp NOR the park-time `esp+4`: the latter
        // is the cross-thread/context-restore state where v86 did NOT run the stub RET N and
        // newEsp is authoritative — never second-guess that path.
        const liveEsp = (cpu.reg32?.[4] ?? newEsp) >>> 0;
        const recon = ThunkDispatcher.reconcileAsyncRestoreEsp(esp >>> 0, cleanupBytes, liveEsp);
        const finalEsp = recon.esp;
        if (recon.mismatch) {
            const note =
                `async RET N mismatch for ${name}: recorded cleanup=${cleanupBytes} → ` +
                `newEsp=0x${(newEsp >>> 0).toString(16)}, but v86 already executed the stub RET N to ` +
                `liveEsp=0x${liveEsp.toString(16)} (parkEsp=0x${(esp >>> 0).toString(16)}). ` +
                `Trusting v86's ESP to avoid frame-pointer corruption.`;
            Logger.error(LogCategory.THUNK, note);
            this.lastAsyncRetMismatchNote = note;
        }

        if (deferredWrites && deferredWrites.length > 0) {
            this.applyDeferredWrites(deferredWrites, esp, name);  // < Use original ESP, not newEsp!
        }

        // Now simulate RET N through scheduler-owned CPU mutation path.
        const scheduler = this.ensureScheduler();
        if (!scheduler.applyAsyncRestoreCpuState(cpu, eipLinear, finalEsp, returnValue >>> 0, `async_restore:${name}`, {
            threadId: info.threadId ?? scheduler.getCurrentThreadId?.() ?? 0,
            asyncParkGeneration: info.asyncParkGeneration ?? 0,
            completionName: name,
            functionId: info.functionId,
            cleanupBytes,
        })) {
            return;
        }

        this.lastExpectedEspAfterReturn = finalEsp;
        this.lastThunkIdAfterReturn = info.functionId;
        this.lastThunkNameAfterReturn = name;
        this.recordShadowStackGuard(
            info.threadId ?? this.currentThreadId,
            info.functionId,
            esp >>> 0,
            finalEsp >>> 0,
            retAddr >>> 0
        );

        Logger.verbose(LogCategory.THUNK, `Async thunk completed: ${name}, EIP=0x${eipLinear.toString(16)}, ESP=0x${cpu.reg32[4].toString(16)}`);

        // Note: Only resume v86 if system is NOT paused
        if (System.getInstance().isPaused) {
            Logger.verbose(LogCategory.THUNK, `Async thunk ${name} context restored during pause, skipping v86.run()`);
            return;
        }

        // Async thunk context restored, v86 will resume naturally
    }

    // =========================================================================
    // Registration (Populates Tables)
    // =========================================================================

    /**
     * Find all stubs matching (dllName, functionName). Uses exact case-insensitive
     * match first, then falls back to normalize-api-name (strip leading `_` and
     * trailing `@N`). Returns all matches at whichever tier hits; empty if neither.
     * Callers that only need one stub take `findStubsByName(...)[0]`.
     */
    private findStubsByName(dllName: string, functionName: string): ThunkStub[] {
        return this.thunkGenerator.findStubsByName(dllName, functionName);
    }

    register(dllName: string, functionName: string, impl: ThunkImplementation): void {
        const stub = this.findStubsByName(dllName, functionName)[0];

        if (stub) {
            const id = stub.functionId;
            if (id < MAX_THUNK_ID) {
                this.dispatchTable[id] = impl;
                this.argCountsTable[id] = stub.argCount ?? DEFAULT_ARGS_COUNT;
                // Cache stackCleanupBytes to avoid Map lookup in hot path
                this.stackCleanupTable[id] = stub.stackCleanupBytes ?? -1;
                this.namesTable[id] = `${dllName}:${functionName}`;
                Logger.verbose(LogCategory.THUNK, `Registered thunk [${id}] ${dllName}:${functionName}`);

                hypercallDataManager.registerFunction(dllName, functionName, id);

                // Remove from pending if it was there
                const key = `${dllName}:${functionName}`.toLowerCase();
                this.pendingRegistrations.delete(key);
            } else {
                Logger.error(LogCategory.THUNK, `Thunk ID ${id} out of bounds for table`);
            }
        } else {
            // Store pending registration for later application when stubs are created
            const key = `${dllName}:${functionName}`.toLowerCase();
            this.pendingRegistrations.set(key, { impl, dllName, functionName });
        }
    }

    registerFastPath(dllName: string, functionName: string, impl: FastPathImplementation, options?: { trivial?: boolean }): void {
        // Always record in pendingFastPathRegistrations so applyPendingRegistrations can
        // re-bind this to the new stub IDs after Process.reset() regenerates stubs.
        // Without this, fast-paths registered once at worker boot are lost on game load.
        const key = `${dllName}:${functionName}`.toLowerCase();
        this.pendingFastPathRegistrations.set(key, { impl, dllName, functionName, trivial: options?.trivial });

        const matchingStubs = this.findStubsByName(dllName, functionName);
        if (matchingStubs.length === 0) {
            Logger.verbose(LogCategory.THUNK, `Fast-path stub not found for ${dllName}:${functionName}, registration deferred`);
            return;
        }
        for (const stub of matchingStubs) {
            if (stub.functionId < MAX_THUNK_ID) {
                this.fastPathTable[stub.functionId] = impl;
                if (options?.trivial) this.trivialFastPathTable[stub.functionId] = 1;
                Logger.verbose(LogCategory.THUNK, `Registered fast-path [${stub.functionId}] ${dllName}:${functionName}${options?.trivial ? ' (trivial)' : ''}`);
            }
        }
    }

    /**
     * Register a Tier-0 write-buffer function.
     *
     * Patches the existing OUT-trap stub at the function's address to use a JMP-trampoline
     * instead of OUT 0xB077.  The trampoline writes [funcId, arg0…argN] to the ring buffer
     * in THUNK_DATA; the ring is drained at the next flush trigger (DrawPrimitive, glEnd, etc.).
     *
     * Overflow safety: if the ring is full the trampoline falls back to OUT 0xB077, which
     * hits the existing fast-path or slow-path handler as usual.
     *
     * NOTE: Display-list recording (glNewList/GL_COMPILE) is NOT supported for write-buffer
     * functions.  Vertex calls during display-list compilation will be buffered and executed
     * immediately (GL_COMPILE_AND_EXECUTE) or lost (GL_COMPILE).  Add a WBUF_DISABLED flag
     * mechanism if display-list correctness is required.
     *
     * @param dllName   DLL name (e.g. 'ddraw', 'opengl32')
     * @param funcName  Export name (exact or normalised)
     * @param argCount  Number of args pushed by the caller (funcId excluded)
     * @param handler   Called with (mem8, mem32, dataPtr) during drain; dataPtr points to arg0
     * @param isStdcall true for stdcall (RET N), false for cdecl (RET)
     * @param coalesceArgMask Optional bitmask over arg0..arg2 that defines the state slot.
     *                        During one drain only the last entry per (funcId + selected args)
     *                        is applied; use only for scalar last-write-wins state setters.
     */
    registerWriteBufferFunction(
        dllName: string,
        funcName: string,
        argCount: number,
        handler: WriteBufHandler,
        isStdcall: boolean = true,
        coalesceArgMask: number = 0,
        opts?: { trampolineOverride?: number; shadowSpec?: ShadowTrampolineSpec; barrier?: boolean; ownerDisarm?: boolean },
    ): void {
        if (this.writeBufControlAddr === 0) {
            Logger.warn(LogCategory.THUNK,
                `registerWriteBufferFunction: write-buffer not initialised, skipping ${dllName}:${funcName}`);
            return;
        }
        if (argCount < 1 || argCount > 8) {
            Logger.warn(LogCategory.THUNK,
                `registerWriteBufferFunction: argCount ${argCount} out of range 1-8 for ${dllName}:${funcName}`);
            return;
        }

        // Always record in pendingWriteBufRegistrations so applyPendingRegistrations can
        // re-patch the new stubs after Process.reset() regenerates them.
        const key = `${dllName}:${funcName}`.toLowerCase();
        this.pendingWriteBufRegistrations.set(key, {
            handler, dllName, functionName: funcName, argCount, isStdcall,
            coalesceArgMask: coalesceArgMask & 0x7,
            shadowSpec: opts?.shadowSpec,
            barrier: opts?.barrier,
            ownerDisarm: opts?.ownerDisarm,
        });

        const stub = this.findStubsByName(dllName, funcName)[0];
        if (!stub || stub.functionId >= MAX_THUNK_ID) {
            Logger.verbose(LogCategory.THUNK,
                `Write-buffer stub not found for ${dllName}:${funcName}, registration deferred`);
            return;
        }

        // Look up trampoline address for (argCount, convention) — or use a caller-supplied
        // override (e.g. a shadow trampoline that short-circuits redundant setters in guest code).
        const trampolineIdx = (argCount - 1) * 2 + (isStdcall ? 0 : 1);
        const trampolineAddr = opts?.trampolineOverride ?? this.writeBufTrampolineAddrs[trampolineIdx];
        if (!trampolineAddr) {
            Logger.warn(LogCategory.THUNK,
                `registerWriteBufferFunction: no trampoline for argCount=${argCount} isStdcall=${isStdcall}`);
            return;
        }

        // Patch the 16-byte stub in guest memory:
        // [0–4]  B8 ID ID ID ID  — MOV EAX, funcId  (keep)
        // [5]    E9               — JMP rel32         (was BA port high)
        // [6–9]  rel32            — trampolineAddr - (stubAddr + 10)
        // [10–15] 90 90 90 90 90 90 — NOP padding
        let mem8 = this.cachedMem8;
        if (!mem8 || mem8.byteLength === 0) {
            this.updateMemoryCache();
            mem8 = this.cachedMem8;
        }
        if (!mem8 || mem8.byteLength === 0) {
            Logger.warn(LogCategory.THUNK,
                `registerWriteBufferFunction: mem8 not ready, cannot patch stub for ${dllName}:${funcName}`);
            return;
        }
        const stubAddr = stub.address;
        const rel32 = (trampolineAddr - (stubAddr + 10)) | 0;
        mem8[stubAddr + 5]  = 0xE9;
        mem8[stubAddr + 6]  = rel32 & 0xFF;
        mem8[stubAddr + 7]  = (rel32 >> 8)  & 0xFF;
        mem8[stubAddr + 8]  = (rel32 >> 16) & 0xFF;
        mem8[stubAddr + 9]  = (rel32 >> 24) & 0xFF;
        mem8[stubAddr + 10] = 0x90;
        mem8[stubAddr + 11] = 0x90;
        mem8[stubAddr + 12] = 0x90;
        mem8[stubAddr + 13] = 0x90;
        mem8[stubAddr + 14] = 0x90;
        mem8[stubAddr + 15] = 0x90;

        // Drop the cached OUT-trap block so the new JMP bytes are re-compiled.
        const jitDirtied = invalidateGuestCode(stubAddr, 16);

        // Register the drain handler
        const id = stub.functionId;
        this.writeBufHandlerTable[id]  = handler;
        this.writeBufArgCountTable[id] = argCount;
        this.writeBufCoalesceMaskTable[id] = coalesceArgMask & 0x7;
        this.writeBufBarrierTable[id] = opts?.barrier ? 1 : 0;
        // Ring-level coalescing is DEFAULT-OFF: the guest-side setter
        // shadow already kills ~97% of redundant setters before they reach the ring, and
        // draws-on-ring barrier segments split what's left — measured NFSU in-race skip
        // rate fell to ~2.2% of entries while the coalesce-index build+hash walks EVERY
        // entry twice (~0.8 ms/frame, wbufCoalesceSlot visible in profiles). Masks stay
        // registered; opt back in via globalThis.__wbufCoalesce = true (boot) or
        // dispatcher.wbufCoalescingEnabled = true (live) if a profile justifies it.
        if (coalesceArgMask && (globalThis as { __wbufCoalesce?: boolean }).__wbufCoalesce) {
            this.wbufCoalescingEnabled = true;
        }

        // Read-back verification: confirm patch bytes are visible in memory
        const readBack = Array.from(mem8.slice(stubAddr, stubAddr + 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
        const patchOk = mem8[stubAddr + 5] === 0xE9;

        // Also check via fresh memory reference to detect stale cachedMem8
        let freshMatch = true;
        if (this.getMemory) {
            const freshMem = this.getMemory();
            freshMatch = freshMem[stubAddr + 5] === 0xE9;
            if (!freshMatch) {
                Logger.error(LogCategory.THUNK,
                    `[WBUF] STALE MEMORY! cachedMem8 patch ok but fresh getMemory() shows byte5=0x${freshMem[stubAddr + 5].toString(16)}. ` +
                    `cachedMem8.buffer === freshMem.buffer: ${mem8.buffer === freshMem.buffer}`);
            }
        }

        Logger.log(LogCategory.THUNK,
            `[WBUF] Registered [${id}] ${dllName}:${funcName} ` +
            `(${argCount} args, ${isStdcall ? 'stdcall' : 'cdecl'}, stub=0x${stubAddr.toString(16)}, trampoline=0x${trampolineAddr.toString(16)}, ` +
            `${coalesceArgMask ? `coalesceMask=0x${(coalesceArgMask & 0x7).toString(16)}, ` : ''}` +
            `jit_dirty=${jitDirtied}, deferred=${!jitDirtied}, readback=${patchOk?'OK':'FAIL'}, freshMem=${freshMatch?'OK':'STALE'}) ` +
            `bytes=[${readBack}]`);
    }

    /**
     * Like registerWriteBufferFunction, but installs a guest-side value-shadow trampoline that
     * RETs immediately on a redundant (same-value) call — no ring entry, no JS drain. A real change
     * updates the shadow and falls through to the SAME ring-write + drain handler. The module owns
     * the coherence lifecycle: bind the owner (setShadowOwner) and re-sentinel (resetShadow) wherever
     * the device / its JS state-of-record is (re)created. Kill-switch `globalThis.__noSetterShadow`
     * disables the shadow (plain WBUF registration) for clean A/B.
     */
    registerShadowedWriteBufferFunction(
        dllName: string,
        funcName: string,
        argCount: number,
        handler: WriteBufHandler,
        coalesceArgMask: number,
        spec: ShadowTrampolineSpec,
    ): void {
        // Kill-switch → plain WBUF (no shadow). Pure A/B toggle.
        if ((globalThis as { __noSetterShadow?: boolean }).__noSetterShadow) {
            this.registerWriteBufferFunction(dllName, funcName, argCount, handler, true, coalesceArgMask);
            return;
        }
        const key = `${dllName}:${funcName}`.toLowerCase();
        if (this.writeBufControlAddr === 0 || !this.thunkMemoryManager || !this.getMemory) {
            // Not ready yet — record pending so applyPendingRegistrations re-runs the shadowed path.
            this.pendingWriteBufRegistrations.set(key, {
                handler, dllName, functionName: funcName, argCount, isStdcall: true,
                coalesceArgMask: coalesceArgMask & 0x7, shadowSpec: spec,
            });
            return;
        }
        if (this.shadowOwnerGlobal === 0) this.shadowOwnerGlobal = this.thunkMemoryManager.allocShadowOwnerGlobal();

        const h = writeShadowTrampoline(
            this.thunkMemoryManager.stubAllocator,
            this.getMemory, this.writeBufControlAddr, this.writeBufDataBase, this.writeBufCapacity,
            this.shadowOwnerGlobal, spec);

        // The shadow cmp/mov RMW must not interleave a quantum switch (mirrors heap/getc stubs).
        try { System.getInstance().scheduler?.registerNonPreemptibleRange(h.codeRegionBase, h.codeRegionEnd); } catch { /* non-fatal */ }

        // Reuse the exact stub-patch path, but JMP to the shadow trampoline; record shadowSpec so
        // applyPendingRegistrations re-emits after Process.reset().
        this.registerWriteBufferFunction(dllName, funcName, argCount, handler, true, coalesceArgMask,
            { trampolineOverride: h.trampAddr, shadowSpec: spec });

        this.shadowHandles.set(key, {
            trampAddr: h.trampAddr, shadowBase: h.shadowBase, slotCount: h.slotCount,
            sentinel: h.sentinel, skipCounterAddr: h.skipCounterAddr,
        });
        Logger.log(LogCategory.THUNK,
            `[WBUF] Shadowed ${dllName}:${funcName} → tramp 0x${h.trampAddr.toString(16)} ` +
            `(slots=${h.slotCount}, owner@0x${this.shadowOwnerGlobal.toString(16)}, skipCtr@0x${h.skipCounterAddr.toString(16)})`);
    }

    /**
     * Register a ring function whose guest trampoline DISARMS the setter-shadow owner gate
     * (mov [shadowOwnerGlobal], 0) before writing its entry — for ring-deferred operations
     * that WRITE state the shadows mirror (canonical case: IDirect3DStateBlock9_Apply).
     * The drain handler MUST re-arm via setShadowOwner(ownerPtr) after syncing the shadows,
     * or shadow skipping stays off (correct but slow). When no shadow trampolines are active
     * (shadowOwnerGlobal === 0) this degrades to the plain ring registration — a plain ring
     * entry is already correctly ordered when nothing skips at call time. Stdcall scalar only.
     */
    registerOwnerDisarmWriteBufferFunction(
        dllName: string,
        funcName: string,
        argCount: number,
        handler: WriteBufHandler,
        coalesceArgMask: number = 0,
        opts?: { barrier?: boolean },
    ): void {
        const key = `${dllName}:${funcName}`.toLowerCase();
        if (this.writeBufControlAddr === 0 || !this.thunkMemoryManager || !this.getMemory) {
            // Not ready — record pending so applyPendingRegistrations re-runs this path.
            this.pendingWriteBufRegistrations.set(key, {
                handler, dllName, functionName: funcName, argCount, isStdcall: true,
                coalesceArgMask: coalesceArgMask & 0x7, barrier: opts?.barrier, ownerDisarm: true,
            });
            return;
        }
        if (this.shadowOwnerGlobal === 0) {
            // No shadow trampolines registered — nothing to disarm. Keep ownerDisarm in the
            // pending record so a later re-apply (after shadows appear) upgrades the path.
            this.registerWriteBufferFunction(dllName, funcName, argCount, handler, true,
                coalesceArgMask, { barrier: opts?.barrier, ownerDisarm: true });
            return;
        }
        const h = writeOwnerDisarmScalarTrampoline(
            this.thunkMemoryManager.stubAllocator,
            this.getMemory, this.writeBufControlAddr, this.writeBufDataBase, this.writeBufCapacity,
            argCount, this.shadowOwnerGlobal);
        this.registerWriteBufferFunction(dllName, funcName, argCount, handler, true,
            coalesceArgMask, { trampolineOverride: h.trampAddr, barrier: opts?.barrier, ownerDisarm: true });
    }

    /** Bind the active owner (e.g. COM device `this`) for all setter-shadow trampolines. */
    setShadowOwner(ownerPtr: number): void {
        if (this.shadowOwnerGlobal === 0 || !this.getMemory) return;
        const mem = this.getMemory();
        new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setUint32(this.shadowOwnerGlobal, ownerPtr >>> 0, true);
    }

    /** Re-sentinel a shadow table (every slot → "never set"), forcing the next set of each slot to
     *  pass through. MUST be called wherever the module's JS state-of-record is (re)created/reset,
     *  else a stale "equal" would wrongly skip a needed set. */
    resetShadow(dllName: string, funcName: string): void {
        const h = this.shadowHandles.get(`${dllName}:${funcName}`.toLowerCase());
        if (!h || !this.getMemory) return;
        const mem = this.getMemory();
        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < h.slotCount; i++) dv.setUint32(h.shadowBase + i * 4, h.sentinel, true);
        dv.setUint32(h.skipCounterAddr, 0, true);
    }

    /** Keep a guest shadow slot in sync with the authoritative tracked value. The module's device
     *  MUST call this whenever the tracked value actually changes via ANY path — including ones that
     *  bypass the guest setter (state-block Apply calls device.setRenderState/SetSamplerState
     *  directly). Without it the guest shadow drifts behind the tracker and wrong-skips a later set
     *  that matches the stale shadow (the NFSU state-block translucency/untexture bug). */
    writeShadowSlot(dllName: string, funcName: string, slot: number, value: number): void {
        const h = this.shadowHandles.get(`${dllName}:${funcName}`.toLowerCase());
        if (!h || !this.getMemory || slot < 0 || slot >= h.slotCount) return;
        const mem = this.getMemory();
        new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setInt32(h.shadowBase + slot * 4, value | 0, true);
    }

    /** Raw guest-RAM shadow slot values for a shadowed setter (diagnostic: diff vs the JS
     *  state-of-record to find wrong-skip desyncs). Returns null if unknown/not ready. */
    dumpShadowValues(dllName: string, funcName: string): number[] | null {
        const h = this.shadowHandles.get(`${dllName}:${funcName}`.toLowerCase());
        if (!h || !this.getMemory) return null;
        const mem = this.getMemory();
        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const out: number[] = new Array(h.slotCount);
        for (let i = 0; i < h.slotCount; i++) out[i] = dv.getInt32(h.shadowBase + i * 4, true);
        return out;
    }

    /**
     * WBUF ring + setter-shadow plumbing for the inner-loop EAGL token-dispatch
     * hook (hle-lib libs/eagl/token-dispatch.ts): the WASM handler 132 config
     * block needs the ring control/data addresses, the shadow-table addresses
     * of the shadowed setters it replicates, the owner-gate global, and each
     * setter stub's functionId (the ring-entry tag). Returns null until the
     * WBUF ring exists. Addresses are stable for the process lifetime.
     */
    getWbufRingInfo(): { ctrlAddr: number; dataBase: number; capacity: number; ownerGlobalAddr: number } | null {
        if (this.writeBufControlAddr === 0) return null;
        return {
            ctrlAddr: this.writeBufControlAddr,
            dataBase: this.writeBufDataBase,
            capacity: this.writeBufCapacity,
            ownerGlobalAddr: this.shadowOwnerGlobal,
        };
    }

    /** Shadow-table info for one shadowed setter (see getWbufRingInfo). Null when
     *  the setter is registered plain (no shadow) or not yet registered. */
    getShadowTrampolineInfo(dllName: string, funcName: string):
        { shadowBase: number; slotCount: number; skipCounterAddr: number } | null {
        const h = this.shadowHandles.get(`${dllName}:${funcName}`.toLowerCase());
        if (!h) return null;
        return { shadowBase: h.shadowBase, slotCount: h.slotCount, skipCounterAddr: h.skipCounterAddr };
    }

    /** functionId + guest address of a registered thunk stub (ring-entry tag +
     *  WBUF-patch probe surface), or null. */
    getThunkStubInfo(dllName: string, funcName: string): { functionId: number; address: number } | null {
        const stub = this.findStubsByName(dllName, funcName)[0];
        return stub ? { functionId: stub.functionId, address: stub.address } : null;
    }

    /** Guest-side skip counters per shadowed setter (the only direct A/B signal of the win). */
    getShadowStats(): Record<string, number> {
        const out: Record<string, number> = {};
        if (!this.getMemory) return out;
        const mem = this.getMemory();
        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (const [key, h] of this.shadowHandles) out[key] = dv.getUint32(h.skipCounterAddr, true);
        return out;
    }

    /**
     * Register a pointer-dereference write-buffer function.
     * The trampoline reads ONE pointer from the stack, dereferences floatCount floats
     * inline in x86, and writes them to the ring buffer.  The drain handler sees the
     * same layout as the scalar variant (floatCount u32s after funcId).
     *
     * @param dllName    DLL (e.g. 'opengl32')
     * @param funcName   Export name
     * @param floatCount Number of floats to dereference (2 or 3)
     * @param handler    Drain handler — dataPtr points to float0 bits
     * @param isStdcall  true for stdcall (RET 4), false for cdecl (RET)
     */
    registerPtrDerefWriteBufferFunction(
        dllName: string,
        funcName: string,
        floatCount: number,
        handler: WriteBufHandler,
        isStdcall: boolean = true,
    ): void {
        if (this.writeBufControlAddr === 0) {
            Logger.warn(LogCategory.THUNK,
                `registerPtrDerefWriteBufferFunction: write-buffer not initialised, skipping ${dllName}:${funcName}`);
            return;
        }
        if (floatCount !== 2 && floatCount !== 3) {
            Logger.warn(LogCategory.THUNK,
                `registerPtrDerefWriteBufferFunction: floatCount must be 2 or 3, got ${floatCount} for ${dllName}:${funcName}`);
            return;
        }

        // Always record in pendingWriteBufRegistrations for re-apply after reset.
        const key = `${dllName}:${funcName}`.toLowerCase();
        this.pendingWriteBufRegistrations.set(key, {
            handler, dllName, functionName: funcName,
            argCount: floatCount, isStdcall, ptrDeref: true, floatCount,
        });

        const stub = this.findStubsByName(dllName, funcName)[0];
        if (!stub || stub.functionId >= MAX_THUNK_ID) {
            Logger.verbose(LogCategory.THUNK,
                `PtrDeref write-buffer stub not found for ${dllName}:${funcName}, registration deferred`);
            return;
        }

        // PtrDeref trampoline indices: 16=3F stdcall, 17=3F cdecl, 18=2F stdcall, 19=2F cdecl
        const trampolineIdx = floatCount === 3
            ? (16 + (isStdcall ? 0 : 1))
            : (18 + (isStdcall ? 0 : 1));
        const trampolineAddr = this.writeBufTrampolineAddrs[trampolineIdx];
        if (!trampolineAddr) {
            Logger.warn(LogCategory.THUNK,
                `registerPtrDerefWriteBufferFunction: no trampoline for floatCount=${floatCount} isStdcall=${isStdcall}`);
            return;
        }

        // Patch the stub: MOV EAX,id + JMP trampoline (same as standard WBUF)
        let mem8 = this.cachedMem8;
        if (!mem8 || mem8.byteLength === 0) {
            this.updateMemoryCache();
            mem8 = this.cachedMem8;
        }
        if (!mem8 || mem8.byteLength === 0) {
            Logger.warn(LogCategory.THUNK,
                `registerPtrDerefWriteBufferFunction: mem8 not ready, cannot patch stub for ${dllName}:${funcName}`);
            return;
        }
        const stubAddr = stub.address;
        const rel32 = (trampolineAddr - (stubAddr + 10)) | 0;
        mem8[stubAddr + 5]  = 0xE9;
        mem8[stubAddr + 6]  = rel32 & 0xFF;
        mem8[stubAddr + 7]  = (rel32 >> 8)  & 0xFF;
        mem8[stubAddr + 8]  = (rel32 >> 16) & 0xFF;
        mem8[stubAddr + 9]  = (rel32 >> 24) & 0xFF;
        mem8[stubAddr + 10] = 0x90;
        mem8[stubAddr + 11] = 0x90;
        mem8[stubAddr + 12] = 0x90;
        mem8[stubAddr + 13] = 0x90;
        mem8[stubAddr + 14] = 0x90;
        mem8[stubAddr + 15] = 0x90;

        invalidateGuestCode(stubAddr, 16);

        // Register drain handler — floatCount is the argCount for stride calculation
        const id = stub.functionId;
        this.writeBufHandlerTable[id]  = handler;
        this.writeBufArgCountTable[id] = floatCount;
        this.writeBufCoalesceMaskTable[id] = 0;
        this.writeBufBarrierTable[id] = 0;

        Logger.log(LogCategory.THUNK,
            `[WBUF] Registered PtrDeref [${id}] ${dllName}:${funcName} ` +
            `(${floatCount} floats, ${isStdcall ? 'stdcall' : 'cdecl'}, stub=0x${stubAddr.toString(16)}, trampoline=0x${trampolineAddr.toString(16)})`);
    }

    /**
     * Register a D3D9-style shader-constant write-buffer function.
     * Trampoline captures float bits inline at call time (variable vec4Count).
     * Ring layout: funcId, thisPtr, startReg, vec4Count, [vec4Count×4 float bits].
     */
    registerShaderConstantWriteBufferFunction(
        dllName: string,
        funcName: string,
        handler: WriteBufHandler,
    ): void {
        if (this.writeBufControlAddr === 0) {
            Logger.warn(LogCategory.THUNK,
                `registerShaderConstantWriteBufferFunction: write-buffer not initialised, skipping ${dllName}:${funcName}`);
            return;
        }

        const key = `${dllName}:${funcName}`.toLowerCase();
        this.pendingWriteBufRegistrations.set(key, {
            handler, dllName, functionName: funcName,
            argCount: WBUF_ARG_SHADER_CONSTANT, isStdcall: true, shaderConstant: true,
        });

        const stub = this.findStubsByName(dllName, funcName)[0];
        if (!stub || stub.functionId >= MAX_THUNK_ID) {
            Logger.verbose(LogCategory.THUNK,
                `Shader-constant write-buffer stub not found for ${dllName}:${funcName}, registration deferred`);
            return;
        }

        const trampolineAddr = this.writeBufTrampolineAddrs[20];
        if (!trampolineAddr) {
            Logger.warn(LogCategory.THUNK,
                `registerShaderConstantWriteBufferFunction: no shader-constant trampoline for ${dllName}:${funcName}`);
            return;
        }

        let mem8 = this.cachedMem8;
        if (!mem8 || mem8.byteLength === 0) {
            this.updateMemoryCache();
            mem8 = this.cachedMem8;
        }
        if (!mem8 || mem8.byteLength === 0) {
            Logger.warn(LogCategory.THUNK,
                `registerShaderConstantWriteBufferFunction: mem8 not ready, cannot patch stub for ${dllName}:${funcName}`);
            return;
        }
        const stubAddr = stub.address;
        const rel32 = (trampolineAddr - (stubAddr + 10)) | 0;
        mem8[stubAddr + 5]  = 0xE9;
        mem8[stubAddr + 6]  = rel32 & 0xFF;
        mem8[stubAddr + 7]  = (rel32 >> 8)  & 0xFF;
        mem8[stubAddr + 8]  = (rel32 >> 16) & 0xFF;
        mem8[stubAddr + 9]  = (rel32 >> 24) & 0xFF;
        mem8[stubAddr + 10] = 0x90;
        mem8[stubAddr + 11] = 0x90;
        mem8[stubAddr + 12] = 0x90;
        mem8[stubAddr + 13] = 0x90;
        mem8[stubAddr + 14] = 0x90;
        mem8[stubAddr + 15] = 0x90;

        invalidateGuestCode(stubAddr, 16);

        const id = stub.functionId;
        this.writeBufHandlerTable[id]  = handler;
        this.writeBufArgCountTable[id] = WBUF_ARG_SHADER_CONSTANT;
        this.writeBufCoalesceMaskTable[id] = 0;
        this.writeBufBarrierTable[id] = 0;

        Logger.log(LogCategory.THUNK,
            `[WBUF] Registered ShaderConstant [${id}] ${dllName}:${funcName} ` +
            `(stub=0x${stubAddr.toString(16)}, trampoline=0x${trampolineAddr.toString(16)})`);
    }

    /** Shared tail for the capture-family registrations: emit-time guards, stub JMP patch,
     *  JIT invalidation, drain-table writes. Returns the stub id or -1 when not ready. */
    private patchStubToTrampoline(dllName: string, funcName: string, trampolineAddr: number): number {
        const stub = this.findStubsByName(dllName, funcName)[0];
        if (!stub || stub.functionId >= MAX_THUNK_ID) return -1;
        let mem8 = this.cachedMem8;
        if (!mem8 || mem8.byteLength === 0) { this.updateMemoryCache(); mem8 = this.cachedMem8; }
        if (!mem8 || mem8.byteLength === 0) return -1;
        const stubAddr = stub.address;
        const rel32 = (trampolineAddr - (stubAddr + 10)) | 0;
        mem8[stubAddr + 5] = 0xE9;
        mem8[stubAddr + 6] = rel32 & 0xFF;
        mem8[stubAddr + 7] = (rel32 >> 8) & 0xFF;
        mem8[stubAddr + 8] = (rel32 >> 16) & 0xFF;
        mem8[stubAddr + 9] = (rel32 >> 24) & 0xFF;
        for (let i = 10; i < 16; i++) mem8[stubAddr + i] = 0x90;
        invalidateGuestCode(stubAddr, 16);
        return stub.functionId;
    }

    /**
     * Capture-at-call WBUF registration for a stdcall setter with ONE fixed-size struct pointer
     * arg (SetTransform/SetMaterial/SetLight/SetViewport/SetClipPlane class). The trampoline
     * copies payloadDwords from *ptr into the ring inline; the drain handler reads the payload
     * from the RING (guest RAM) — never dereferences the guest pointer at drain. The FastPath
     * handler must stay registered (ring-overflow / bad-pointer fallback path).
     */
    registerStructCaptureWriteBufferFunction(
        dllName: string,
        funcName: string,
        argCount: number,
        ptrArgIndex: number,
        payloadDwords: number,
        handler: WriteBufHandler,
    ): void {
        const key = `${dllName}:${funcName}`.toLowerCase();
        this.pendingWriteBufRegistrations.set(key, {
            handler, dllName, functionName: funcName, argCount, isStdcall: true,
            structCapture: { ptrArgIndex, payloadDwords },
        });
        if (this.writeBufControlAddr === 0 || !this.thunkMemoryManager || !this.getMemory) return;
        const h = writeStructCaptureTrampoline(
            this.thunkMemoryManager.stubAllocator,
            this.getMemory, this.writeBufControlAddr, this.writeBufDataBase, this.writeBufCapacity,
            { argCount, ptrArgIndex, payloadDwords });
        try { System.getInstance().scheduler?.registerNonPreemptibleRange(h.codeRegionBase, h.codeRegionEnd); } catch { /* non-fatal */ }
        const id = this.patchStubToTrampoline(dllName, funcName, h.trampAddr);
        if (id < 0) {
            Logger.verbose(LogCategory.THUNK, `StructCapture stub not found for ${dllName}:${funcName}, registration deferred`);
            return;
        }
        this.writeBufHandlerTable[id] = handler;
        // Standard stride formula (n+1)*4 with n = scalars + payload dwords.
        this.writeBufArgCountTable[id] = argCount + payloadDwords;
        this.writeBufCoalesceMaskTable[id] = 0;
        this.writeBufBarrierTable[id] = 0;
        Logger.log(LogCategory.THUNK,
            `[WBUF] Registered StructCapture [${id}] ${dllName}:${funcName} ` +
            `(args=${argCount} ptrIdx=${ptrArgIndex} payload=${payloadDwords}dw, trampoline=0x${h.trampAddr.toString(16)})`);
    }

    /**
     * Capture-at-call WBUF registration for DrawPrimitiveUP. The trampoline copies the UP vertex
     * bytes into the ring at call time (guest may reuse the buffer immediately after RET); the
     * drain handler passes the ring address of the captured bytes to the device. Registered as a
     * coalescer BARRIER (a draw observes buffered state). FastPath stays as the fallback.
     */
    registerUpDrawWriteBufferFunction(dllName: string, funcName: string, handler: WriteBufHandler): void {
        const key = `${dllName}:${funcName}`.toLowerCase();
        this.pendingWriteBufRegistrations.set(key, {
            handler, dllName, functionName: funcName, argCount: 5, isStdcall: true, upDraw: true,
        });
        if (this.writeBufControlAddr === 0 || !this.thunkMemoryManager || !this.getMemory) return;
        const h = writeUpDrawCaptureTrampoline(
            this.thunkMemoryManager.stubAllocator,
            this.getMemory, this.writeBufControlAddr, this.writeBufDataBase, this.writeBufCapacity);
        try { System.getInstance().scheduler?.registerNonPreemptibleRange(h.codeRegionBase, h.codeRegionEnd); } catch { /* non-fatal */ }
        const id = this.patchStubToTrampoline(dllName, funcName, h.trampAddr);
        if (id < 0) {
            Logger.verbose(LogCategory.THUNK, `UpDraw stub not found for ${dllName}:${funcName}, registration deferred`);
            return;
        }
        this.writeBufHandlerTable[id] = handler;
        this.writeBufArgCountTable[id] = WBUF_ARG_UP_DRAW;
        this.writeBufCoalesceMaskTable[id] = 0;
        this.writeBufBarrierTable[id] = 1;
        Logger.log(LogCategory.THUNK,
            `[WBUF] Registered UpDrawCapture [${id}] ${dllName}:${funcName} (trampoline=0x${h.trampAddr.toString(16)})`);
    }

    /**
     * Patch a thunk stub to return a CONSTANT with zero boundary crossing:
     * `mov eax, value; ret popBytes` written over the 16-byte stub. For dummy-refcount COM
     * AddRef/Release (our objects are never reference-freed) this removes the trap entirely —
     * behavior-identical to the constant FastPath it replaces. Survives Process.reset() via
     * pendingConstStubRegistrations.
     */
    registerConstantReturnStub(dllName: string, funcName: string, value: number, popBytes: number): void {
        const key = `${dllName}:${funcName}`.toLowerCase();
        this.pendingConstStubRegistrations.set(key, { dllName, functionName: funcName, value, popBytes });
        const stub = this.findStubsByName(dllName, funcName)[0];
        if (!stub) return;
        let mem8 = this.cachedMem8;
        if (!mem8 || mem8.byteLength === 0) { this.updateMemoryCache(); mem8 = this.cachedMem8; }
        if (!mem8 || mem8.byteLength === 0) return;
        const a = stub.address;
        mem8[a] = 0xB8;                                   // mov eax, imm32
        mem8[a + 1] = value & 0xFF;
        mem8[a + 2] = (value >> 8) & 0xFF;
        mem8[a + 3] = (value >> 16) & 0xFF;
        mem8[a + 4] = (value >> 24) & 0xFF;
        mem8[a + 5] = 0xC2;                               // ret imm16
        mem8[a + 6] = popBytes & 0xFF;
        mem8[a + 7] = (popBytes >> 8) & 0xFF;
        for (let i = 8; i < 16; i++) mem8[a + i] = 0x90;
        invalidateGuestCode(a, 16);
        Logger.log(LogCategory.THUNK,
            `[WBUF] Constant-return stub [${stub.functionId}] ${dllName}:${funcName} = ${value} (ret ${popBytes}, stub=0x${a.toString(16)})`);
    }

    registerModule(moduleName: string, exports: Record<string, ThunkImplementation>): void {
        for (const [name, impl] of Object.entries(exports)) {
            this.register(moduleName, name, impl);
        }
    }

    /**
     * Check if a function has a fast path implementation
     */
    hasFastPath(dllName: string, functionName: string): boolean {
        const stubs = this.thunkGenerator.getAllStubs();
        const stub = stubs.find(s =>
            s.dllName.toLowerCase() === dllName.toLowerCase() &&
            s.functionName.toLowerCase() === functionName.toLowerCase()
        );
        return stub ? (this.fastPathTable[stub.functionId] !== null) : false;
    }

    /**
     * Get list of currently active async thunks (for diagnostics)
     */
    getActiveAsyncThunks(): ActiveAsyncThunk[] {
        return Array.from(this.activeAsyncThunks.values());
    }

    /**
     * Resolved-but-not-yet-applied async restores (diagnostics). A thread sitting here
     * means its Promise completed but the safe-point apply (wakeThreadForAsyncCompletion →
     * tryApplyPendingAsyncRestoreAtSafePoint) hasn't run — distinct from getActiveAsyncThunks()
     * (Promise still pending). Used by harness `asyncParked` to classify a stuck ASYNC_THUNK thread.
     */
    getPendingAsyncRestores(): Array<{ threadId?: number; asyncParkGeneration?: number; completionName: string; returnAddr?: number; esp?: number }> {
        return this.pendingAsyncRestores.map((r) => ({
            threadId: r.info.threadId,
            asyncParkGeneration: r.info.asyncParkGeneration,
            completionName: r.completionName,
            returnAddr: r.info.returnAddr,
            esp: r.info.esp,
        }));
    }

    getPendingAsyncRestoreDiagnostics(): Array<{
        threadId?: number;
        asyncParkGeneration?: number;
        functionId: number;
        completionName: string;
        returnAddr?: number;
        esp?: number;
        cleanupBytes: number;
        returnValue: number;
        errorFlag: boolean;
    }> {
        return this.pendingAsyncRestores.map((r) => ({
            threadId: r.info.threadId,
            asyncParkGeneration: r.info.asyncParkGeneration,
            functionId: r.info.functionId >>> 0,
            completionName: r.completionName,
            returnAddr: r.info.returnAddr,
            esp: r.info.esp,
            cleanupBytes: r.cleanupBytes >>> 0,
            returnValue: r.returnValue >>> 0,
            errorFlag: !!r.errorFlag,
        }));
    }

    /**
     * Check if there are any active async thunks (fast path for callback guards).
     * Timer callbacks should NOT fire while async thunks are pending - they corrupt the stack.
     */
    hasActiveAsyncThunks(): boolean {
        return this.activeAsyncThunks.size > 0 || this.pendingAsyncRestores.length > 0;
    }

    /**
     * Check if the CURRENT thread has an active async thunk.
     * Unlike hasActiveAsyncThunks() which is global, this only checks the running thread.
     * Use this for callback processing guards � other threads' async thunks (e.g. GetMessageW
     * awaiting messages) should NOT block callback dispatch on the current thread.
     */
    hasActiveAsyncThunkForThread(threadId: number | null): boolean {
        if (threadId === null) return false;
        for (const thunk of this.activeAsyncThunks.values()) {
            if (thunk.threadId === threadId) return true;
        }
        for (let i = 0; i < this.pendingAsyncRestores.length; i++) {
            if (this.pendingAsyncRestores[i].info.threadId === threadId) return true;
        }
        return false;
    }

    /**
     * Get last thunk info (for diagnostics)
     */
    getLastThunkInfo(): { name: string | null; time: number; id: number; count: number } {
        return {
            name: this.lastThunkName,
            time: this.lastThunkTime,
            id: this.lastThunkId,
            count: this.thunkCount
        };
    }

    /**
     * Get post-return ESP for the last completed thunk.
     * Used by scheduler to construct a post-return context when EIP is in thunk region.
     */
    getLastPostReturnEsp(): number {
        return this.lastExpectedEspAfterReturn;
    }

    private decodeThunkStubCleanupById(functionId: number): number {
        if (functionId <= 0 || functionId >= MAX_THUNK_ID) return -1;
        const stub = this.thunkGenerator.getStubById(functionId);
        if (!stub) return -1;
        const mem = this.cachedMem8;
        if (!mem || mem.byteLength === 0) return -1;
        const stubStart = stub.address >>> 0;
        if (stubStart + 14 > mem.length) return -1;

        // Canonical thunk signature: MOV EAX,id | MOV EDX,0xB077 | OUT DX,EAX | RET{N}
        if (mem[stubStart] !== 0xB8 || mem[stubStart + 5] !== 0xBA || mem[stubStart + 10] !== 0xEF) {
            return -1;
        }

        const retOp = mem[stubStart + 11];
        if (retOp === 0xC3) return 0;
        if (retOp === 0xC2) {
            return (mem[stubStart + 12] | (mem[stubStart + 13] << 8)) >>> 0;
        }
        return -1;
    }

    /**
     * Park a thunk stub's `RET N` at the spin loop by overwriting [esp] with
     * spinLoopAddress. v86's JIT can compile the stub's `OUT`+`RET N` into one block, so
     * the RET N may execute despite an EIP change and pop [esp] over our redirect; writing
     * spinLoopAddress there makes RET N land on the spin loop instead of resuming guest
     * code. Safe because a woken thread restores its saved post-return context, never live
     * [esp]. Returns the original value at [esp] (the guest return address) if readable,
     * else undefined. Used by the async, suspended-callback, and blockedNoSwitch paths.
     */
    private redirectStackToSpinLoop(esp: number): number | undefined {
        if (!this.cachedDataView || !this.isDataViewValid() || !this.cachedMem8) return undefined;
        if (esp < 4 || esp + 4 > this.cachedMem8.length) return undefined;
        try {
            const original = this.cachedDataView.getUint32(esp, true);
            guardStackWrite(esp, 4, 'thunk:parkSpinLoop', this.spinLoopAddress);
            this.cachedDataView.setUint32(esp, this.spinLoopAddress, true);
            return original;
        } catch {
            return undefined;
        }
    }

    private resolveThunkCleanup(functionId: number, argCount: number, source: string): number {
        // Cache-first: stackCleanupTable is populated from stub.stackCleanupBytes at
        // registration time (applyPendingRegistrations). Stub RET N bytes in THUNK_CODE
        // are immutable (RX region), so the cached value is authoritative.
        // Only decode from guest memory on cache miss.
        if (functionId > 0 && functionId < MAX_THUNK_ID) {
            const cached = this.stackCleanupTable[functionId];
            if (cached >= 0) return cached >>> 0;
        }
        const decoded = this.decodeThunkStubCleanupById(functionId);
        if (decoded >= 0) return decoded >>> 0;
        return ((argCount >= 0 ? argCount : 0) * 4) >>> 0;
    }

    /**
     * Get the stack cleanup bytes (RET N) for the last completed thunk stub.
     * Used by scheduler for stack-based context restore that doesn't rely on is_jumping.
     * Returns -1 if unknown.
     */
    getLastThunkStubCleanup(): number {
        const id = this.lastThunkIdAfterReturn;
        if (id <= 0 || id >= MAX_THUNK_ID) return -1;
        // Cache-first: see resolveThunkCleanup for rationale.
        const cached = this.stackCleanupTable[id];
        if (cached >= 0) return cached;
        return this.decodeThunkStubCleanupById(id);
    }

    getThunkCleanupAtEip(eip: number): number {
        const addr = eip >>> 0;
        if (this.thunkGeneratorBase === 0 || addr < this.thunkGeneratorBase || addr >= this.thunkGeneratorEnd) {
            return -1;
        }
        const stubStart = (addr & ~0xF) >>> 0;
        const stub = this.thunkGenerator.getStubByAddress(stubStart);
        if (!stub) return -1;
        if (stub.stackCleanupBytes !== undefined) {
            return stub.stackCleanupBytes >>> 0;
        }
        const id = stub.functionId >>> 0;
        if (id > 0 && id < MAX_THUNK_ID) {
            const cached = this.stackCleanupTable[id];
            if (cached >= 0) return cached >>> 0;
        }
        if ((stub.argCount ?? -1) >= 0) {
            return ((stub.argCount ?? 0) * 4) >>> 0;
        }
        return -1;
    }

    /** Record shadow stack guard entry for a thunk at espAtEntry (reads retAddr from stack). */
    private recordShadowStackAtEntry(functionId: number, espAtEntry: number): void {
        if (this.cachedDataView && this.isDataViewValid() && espAtEntry + 4 <= this.memLength) {
            const retAddr = this.cachedDataView.getUint32(espAtEntry, true) >>> 0;
            this.recordShadowStackGuard(
                this.currentThreadId,
                functionId,
                espAtEntry >>> 0,
                this.lastExpectedEspAfterReturn >>> 0,
                retAddr
            );
        }
    }

    private recordShadowStackGuard(
        threadId: number,
        thunkId: number,
        espEntry: number,
        expectedPostEsp: number,
        retAddr: number
    ): void {
        const i = this.shadowStackRingIdx;
        this.ssTs[i] = performance.now();
        this.ssThreadId[i] = threadId >>> 0;
        this.ssThunkId[i] = thunkId >>> 0;
        this.ssEspEntry[i] = espEntry >>> 0;
        this.ssExpectedPost[i] = expectedPostEsp >>> 0;
        this.ssRetAddr[i] = retAddr >>> 0;
        this.shadowStackRingIdx = (i + 1) % ThunkDispatcher.SHADOW_STACK_RING_SIZE;
        if (this.shadowStackRingCount < ThunkDispatcher.SHADOW_STACK_RING_SIZE) this.shadowStackRingCount++;
    }

    private dumpShadowStackGuard(reason: string): void {
        const len = this.shadowStackRingCount;
        if (len === 0) return;
        const SIZE = ThunkDispatcher.SHADOW_STACK_RING_SIZE;
        // Oldest entry: index 0 while not yet wrapped, else the next-write slot.
        const start = len < SIZE ? 0 : this.shadowStackRingIdx;
        const lines = [`[SHADOW STACK] ${reason} (${len} entries)`];
        for (let i = 0; i < len; i++) {
            const e = (start + i) % SIZE;
            lines.push(
                `  [${i}] t=${this.ssTs[e].toFixed(1)} T${this.ssThreadId[e]} thunk=0x${this.ssThunkId[e].toString(16)} ` +
                `espEntry=0x${this.ssEspEntry[e].toString(16)} expectedPost=0x${this.ssExpectedPost[e].toString(16)} ` +
                `ret=0x${this.ssRetAddr[e].toString(16)}`
            );
        }
        Logger.error(LogCategory.THUNK, lines.join('\n'));
    }

    getThunkMemoryRegions(): ThunkMemoryRegions | null {
        return this.thunkMemoryManager?.getRegions() ?? null;
    }

    /** Get the SEH scratch area address (for use by handler implementations). */
    getSehScratchAddr(): number {
        return this.sehScratchAddr;
    }

    /** Get current SEH dispatch nesting depth (0 = idle). */
    getSehDispatchDepth(): number {
        return this.sehDispatchStack.length;
    }

    /**
     * Called from RtlUnwind when a handler catches during active SEH dispatch.
     * RtlUnwind only fires when a handler decided to catch (second pass).
     * Pop the dispatch context so SWITCH_DEFERRED stops for the handler's remaining funclet calls.
     */
    notifySehHandlerCaught(targetFrame: number): void {
        if (this.sehDispatchStack.length === 0) return;
        const top = this.sehDispatchStack[this.sehDispatchStack.length - 1];
        Logger.warn(LogCategory.SYSTEM,
            `SEH dispatch: RtlUnwind(targetFrame=0x${targetFrame.toString(16)}) during active dispatch ` +
            `(gen=${top.generation}) — handler caught, popping context`);
        this.sehDispatchStack.pop();
        this._leaveSehCriticalRuntime('rtlunwind_caught', top.generation);
    }

    /** Update cached SEH scratch area address (called after THUNK_DATA allocation). */
    updateSehScratchAddr(addr: number): void {
        this.sehScratchAddr = addr >>> 0;
        const regions = this.thunkMemoryManager?.getRegions() ?? null;
        if (regions) {
            this.sehDispatchStubAddress = regions.sehDispatchStubAddress >>> 0;
            this.sehFilterStubAddress = regions.sehFilterStubAddress >>> 0;
            this.sehScratchSize = regions.sehScratchSize >>> 0;
            this.sehStackBase = regions.sehStackBase >>> 0;
            this.sehStackTop = regions.sehStackTop >>> 0;
        }
    }

    /** Store the app's registered UnhandledExceptionFilter address. */
    setUnhandledExceptionFilter(addr: number): number {
        const old = this.unhandledExceptionFilterAddr;
        this.unhandledExceptionFilterAddr = addr >>> 0;
        return old;
    }

    private _registerSehTransientRanges(): void {
        const sched = this.ensureScheduler();
        if (this.sehDispatchStubAddress) {
            sched.registerTransientExecRange('seh_dispatch_stub', this.sehDispatchStubAddress >>> 0, (this.sehDispatchStubAddress + 0x100) >>> 0);
        }
        if (this.sehFilterStubAddress) {
            sched.registerTransientExecRange('seh_filter_stub', this.sehFilterStubAddress >>> 0, (this.sehFilterStubAddress + 0x100) >>> 0);
        }
        if (this.sehStackBase && this.sehStackTop) {
            const lo = (this.sehStackBase - 0x100) >>> 0;
            const hi = this.sehStackTop >>> 0;
            if (hi > lo) {
                sched.registerTransientExecRange('seh_scratch_stack', lo, hi);
            }
        }
    }

    private _clearSehTransientRanges(): void {
        const sched = this.ensureScheduler();
        sched.unregisterTransientExecRange('seh_dispatch_stub');
        sched.unregisterTransientExecRange('seh_filter_stub');
        sched.unregisterTransientExecRange('seh_scratch_stack');
    }

    private _enterSehCriticalRuntime(generation: number): void {
        const sched = this.ensureScheduler();
        const ownerThreadId = sched.getCurrentThreadId();
        this._registerSehTransientRanges();
        sched.enterCriticalRuntime('seh_dispatch', ownerThreadId >>> 0, generation >>> 0);
        if (!this.sehRuntimePinned) {
            sched.pinCurrentThread();
            this.sehRuntimePinned = true;
        }
    }

    private _leaveSehCriticalRuntime(reason: string, generation: number): void {
        const sched = this.ensureScheduler();
        const ownerThreadId = sched.getCurrentThreadId();
        sched.exitCriticalRuntime('seh_dispatch', ownerThreadId >>> 0, generation >>> 0, reason);

        // If there's still an outer dispatch context on the stack, re-enter critical runtime
        // with its generation. The scheduler's activeCriticalRuntime is a single slot, so
        // exiting the inner context clears it — we must restore the outer context's protection.
        if (this.sehDispatchStack.length > 0) {
            const outer = this.sehDispatchStack[this.sehDispatchStack.length - 1];
            sched.enterCriticalRuntime('seh_dispatch', ownerThreadId >>> 0, outer.generation >>> 0);
            // Keep transient ranges and pin active
        } else {
            this._clearSehTransientRanges();
            if (this.sehRuntimePinned) {
                sched.unpinCurrentThread();
                this.sehRuntimePinned = false;
            }
        }
    }

    /**
     * Check if ESP moved above any active SEH dispatch context's startEsp,
     * indicating the handler caught via longjmp (non-local jump).
     * Pop all resolved contexts from the stack.
     * Called from handlePortWrite (before fast path) to ensure detection
     * even for thunks that never reach _handlePortWriteSlow.
     */
    private _checkSehNonLocalJump(functionId: number): void {
        const cpu = this.cachedCpu;
        if (!cpu) return;
        const espNow = cpu.reg32[4] >>> 0;
        while (this.sehDispatchStack.length > 0) {
            const top = this.sehDispatchStack[this.sehDispatchStack.length - 1];
            if (top.startEsp !== 0 && espNow > top.startEsp) {
                Logger.warn(LogCategory.SYSTEM,
                    `SEH dispatch abort: non-local transition detected ` +
                    `(func=0x${functionId.toString(16)} esp=0x${espNow.toString(16)} ` +
                    `dispatchStartEsp=0x${top.startEsp.toString(16)} gen=${top.generation} depth=${this.sehDispatchStack.length})`);
                this.sehDispatchStack.pop();
                this._leaveSehCriticalRuntime('non_local_jump', top.generation);
            } else {
                break;
            }
        }
    }

    private _setSehDispatchIdle(reason: string): void {
        if (this.sehDispatchStack.length === 0) return;
        // Pop all contexts
        while (this.sehDispatchStack.length > 0) {
            const ctx = this.sehDispatchStack.pop()!;
            this._leaveSehCriticalRuntime(reason, ctx.generation);
        }
        Logger.log(LogCategory.SYSTEM,
            `SEH dispatch state: all contexts cleared (${reason}, gen=${this.sehDispatchGeneration})`);
    }

    private _collectSehFramesFromScratch(view: DataView): SehFrameSnapshot[] {
        // Cold-path forensic collector — see dispatcher-forensics.ts.
        return DispatcherForensics.collectSehFramesFromScratch(this, view);
    }

    public captureSehRuntimeDump(
        reason: string,
        details: {
            faultAddr?: number;
            faultEip?: number;
            sehHead?: number;
            filterAddr?: number;
            handlerAddr?: number;
            frameList?: SehFrameSnapshot[];
            force?: boolean;
        } = {},
    ): void {
        // Cold-path forensic dump — see dispatcher-forensics.ts.
        DispatcherForensics.captureSehRuntimeDump(this, reason, details);
    }

    private _logSehCorruptionProtocol(reason: string, faultingEip: number, faultAddr: number): void {
        // Cold-path forensic dump — see dispatcher-forensics.ts.
        DispatcherForensics.logSehCorruptionProtocol(this, reason, faultingEip, faultAddr);
    }

    public notifySehDispatchAborted(reason: string): void {
        this._setSehDispatchIdle(reason);
    }

    public prepareEh3ComplexFilterRedirect(
        cpu: any,
        frameAddr: number,
        previousTryLevel: number,
        currentTryLevel: number,
        filterAddr: number,
        handlerAddr: number,
    ): boolean {
        const view = this.cachedDataView;
        if (!view || !this.isDataViewValid()) return false;
        if (!this.sehScratchAddr || !this.sehFilterStubAddress) return false;

        const esp = (cpu?.reg32?.[4] ?? 0) >>> 0;
        if (esp + 4 > this.memLength) return false;

        const continuationEip = view.getUint32(esp, true) >>> 0;
        const ctxAddr = this.sehScratchAddr + SEH_SCRATCH_LAYOUT.EH3_FILTER_CTX;
        if (ctxAddr + EH3_FILTER_CTX_LAYOUT.SIZE > this.memLength) return false;

        view.setUint32(ctxAddr + EH3_FILTER_CTX_LAYOUT.FILTER_ADDR, filterAddr >>> 0, true);
        view.setUint32(ctxAddr + EH3_FILTER_CTX_LAYOUT.FRAME_ADDR, frameAddr >>> 0, true);
        view.setInt32(ctxAddr + EH3_FILTER_CTX_LAYOUT.PREV_TRY_LEVEL, previousTryLevel | 0, true);
        view.setUint32(ctxAddr + EH3_FILTER_CTX_LAYOUT.HANDLER_ADDR, handlerAddr >>> 0, true);
        view.setUint32(ctxAddr + EH3_FILTER_CTX_LAYOUT.FRAME_EBP, (frameAddr + 16) >>> 0, true);
        view.setUint32(ctxAddr + EH3_FILTER_CTX_LAYOUT.CONTINUATION_EIP, continuationEip, true);
        view.setInt32(ctxAddr + EH3_FILTER_CTX_LAYOUT.CURRENT_TRY_LEVEL, currentTryLevel | 0, true);

        // Rewrite the thunk return target: RET from _except_handler3 goes to static filter stub.
        guardStackWrite(esp, 4, 'thunk:eh3FilterRedirect', this.sehFilterStubAddress);
        view.setUint32(esp, this.sehFilterStubAddress >>> 0, true);

        // Ensure filter has stable frame/scratch registers.
        cpu.reg32[5] = (frameAddr + 16) | 0;      // EBP
        cpu.reg32[7] = this.sehScratchAddr | 0;   // EDI

        this.captureSehRuntimeDump('eh3-complex-filter', {
            filterAddr,
            handlerAddr,
            frameList: this._collectSehFramesFromScratch(view),
        });

        return true;
    }

    /**
     * OPTIMIZED: Record WinAPI call without string allocation (hot path).
     * Strings are generated lazily only when getLastWinApiCalls() is called.
     * Also records returnAddrBefore and stack fingerprint for jump-into-stack forensics.
     */
    private recordWinApiCall(name: string, id: number, esp: number, arg0: number = 0): void {
        // H1 Stack: always capture the return address at entry for crash forensics.
        let retAddrBefore = 0;
        if (this.cachedDataView && this.isDataViewValid() && esp >= 0 && esp + 4 <= this.memLength) {
            retAddrBefore = this.cachedDataView.getUint32(esp, true) >>> 0;
        }
        this.winApiRing.record(id, esp, arg0, retAddrBefore, this.currentThreadId);
    }

    /**
     * ESP-sanity tripwire (NON-FATAL). A thunk should always be entered with ESP inside
     * the current thread's stack (or the SEH dispatch stack while unwinding). When ESP is
     * outside both, the thread's stack pointer has gone wild — control-flow/stack
     * corruption — and the eventual RET will jump to garbage (the Re-Volt mac 0x4100:
     * ESP=0x3f6418f8 vs T1 stack [0x1000000,0x1100000), RET into the IDT stub region).
     * We record a note (surfaced in the crash report) instead of crashing here, because a
     * blanket fatal gate would risk false-positives on legitimate alternate stacks (e.g.
     * guest fibers) that we cannot runtime-verify. The note names the exact corrupting
     * call so the next occurrence is root-causable from the error window alone.
     */
    private checkEspSanity(esp: number, thunkName: string): void {
        const base = this.curStackBase, top = this.curStackTop;
        if (top <= base) return; // bounds unknown for this thread → skip
        if (esp >= base && esp < top) return; // normal: ESP within thread stack
        // SEH dispatch runs thunks on its own stack (sehStackBase-0x100 .. sehStackTop).
        if (this.sehStackTop > 0 && esp >= (this.sehStackBase - 0x100 >>> 0) && esp < this.sehStackTop) return;
        // ESP outside the registered stack is not corruption if it still points into
        // committed writable memory — guests run on alternate stacks (fibers, VM/
        // coroutine stacks, the Watcom runtime stack) carved from their own heap.
        // Only a wild ESP (unmapped/RO) is reported.
        const as: any = System.getInstance().process?.addressSpace;
        if (as?.validateRange?.(esp >>> 0, 4, "rw")) return;
        const note =
            `wild ESP entering ${thunkName} on T${this.currentThreadId}: ` +
            `esp=0x${(esp >>> 0).toString(16)} outside stack ` +
            `[0x${base.toString(16)},0x${top.toString(16)}) — stack/control-flow corruption`;
        // Log once per distinct note to avoid flooding if the thread keeps faulting.
        if (note !== this.lastWildEspNote) {
            Logger.error(LogCategory.THUNK, note);
        }
        this.lastWildEspNote = note;
    }

    /** Most recent wild-ESP note (or null). Surfaced in the crash report. */
    getLastWildEspNote(): string | null {
        return this.lastWildEspNote;
    }

    /**
     * EBP-sanity tripwire (NON-FATAL). Sibling of {@link checkEspSanity}: at a thunk entry the
     * caller is compiled C whose frame pointer (EBP) normally lives inside the current thread's
     * stack. When EBP is outside the stack AND points at memory that is neither our synthetic
     * thunk/vtable band nor committed-writable, it is wild — a `pop ebp` grabbed the wrong slot
     * after a transient ESP misalignment (wrong/double RET N) that has since re-aligned ESP,
     * leaving only EBP poisoned. That is the Re-Volt mac wedge (EBP=0x2130d16 — a guest address —
     * while the real saved-EBP chain stayed intact on the stack). We tolerate two non-corruption
     * cases: (1) EBP in our synthetic band (>= MEM_THUNK_CODE_BASE) — an FPO caller holding a COM
     * vtable / export-stub pointer there, common at COM method entries; (2) EBP into committed
     * writable memory — FPO callers using EBP as a general register holding a heap/object pointer,
     * and guests on alternate stacks (fibers, VM/Watcom runtime). Both would be false positives we
     * can't runtime-verify. Diagnostic only; the note names the call whose return poisoned EBP.
     * Caveat: a corrupt EBP that happens to land on committed memory is indistinguishable from a
     * legit FPO pointer and is NOT caught, and a wedge that never reaches another thunk is only
     * caught by the hang watchdog.
     */
    private checkEbpSanity(ebp: number, thunkName: string): void {
        const base = this.curStackBase, top = this.curStackTop;
        if (top <= base) return;                        // bounds unknown for this thread → skip
        if (ebp >= base && ebp < top) return;           // normal: frame pointer within thread stack
        // SEH dispatch runs on its own stack (same whitelist as the ESP tripwire).
        if (this.sehStackTop > 0 && ebp >= (this.sehStackBase - 0x100 >>> 0) && ebp < this.sehStackTop) return;
        // FPO + synthetic-band tolerance: an EBP pointing into our own thunk/vtable band
        // (THUNK_CODE / CALLBACK_STUB / SPIN_LOOP / THUNK_DATA) is not corruption — it is an
        // FPO (/Oy) caller using EBP as a general register that currently holds a COM vtable /
        // export-stub pointer (these live at >= MEM_THUNK_CODE_BASE). This is common right at
        // COM method entries (e.g. Surface8::Release, IMediaEventEx::GetEvent) and was a
        // systematic false positive. A genuinely mis-popped saved-EBP pulls a *guest* stack
        // slot → a guest address (the Re-Volt wedge EBP=0x2130d16), never the synthetic band,
        // so the real catch below is preserved.
        if (ebp >= MEM_THUNK_CODE_BASE && ebp < (MEM_THUNK_DATA_BASE + MEM_THUNK_DATA_SIZE)) return;
        // FPO/alt-stack tolerance: EBP into committed writable memory is not corruption.
        const as: any = System.getInstance().process?.addressSpace;
        if (as?.validateRange?.(ebp >>> 0, 4, "rw")) return;
        const note =
            `wild EBP entering ${thunkName} on T${this.currentThreadId}: ` +
            `ebp=0x${(ebp >>> 0).toString(16)} outside stack ` +
            `[0x${base.toString(16)},0x${top.toString(16)}) and not writable — ` +
            `possible frame-pointer corruption (or FPO scratch register)`;
        // Quiet breadcrumb, NOT a live ERROR. EBP is a general register: FPO (/Oy) callers
        // park arbitrary scratch in it — vtable pointers (synthetic band, tolerated above),
        // but also plain constants like a D3DCOLOR 0xff000000 at SetTexture, counters, loop
        // bounds. Those are non-writable yet harmless, so live-logging every distinct value
        // spammed ERROR on optimized game binaries. The note's only job is to land in the
        // crash report (System.wildEbp) when an actual fault occurs — record it silently and
        // let the funnel surface it. Verbose tier keeps it inspectable when explicitly chasing.
        if (note !== this.lastWildEbpNote) {
            Logger.verbose(LogCategory.THUNK, note);
        }
        this.lastWildEbpNote = note;
    }

    /** Most recent wild-EBP note (or null). Surfaced in the crash report. */
    getLastWildEbpNote(): string | null {
        return this.lastWildEbpNote;
    }

    /** Most recent async-restore RET N mismatch note (or null). Surfaced in the crash report. */
    getLastAsyncRetMismatchNote(): string | null {
        return this.lastAsyncRetMismatchNote;
    }

    /** Recent WinAPI calls as formatted strings (lazy; only allocated on errors). */
    getLastWinApiCalls(count: number = 8, options?: { includeNoisy?: boolean }): string[] {
        return this.winApiRing.getCalls(count, options);
    }

    /** Recent WinAPI calls made by ONE thread (oldest..newest), each tagged with the
     *  ESP at entry and the [esp] return address. For crash forensics: isolates the
     *  crashing thread's tail from a busy peer (render/audio) that floods the global
     *  ring, and surfaces a wild/corrupt ESP directly. Lazy string alloc. */
    getLastWinApiCallsForThread(threadId: number, count: number = 24): string[] {
        return this.winApiRing.getThreadTail(threadId, count);
    }

    /** Recent WinAPI calls with rich data (retAddrBefore, stackHash) for jump-into-stack forensics. */
    getLastWinApiCallsRich(count: number = 50): Array<{ id: number; name: string; esp: number; retAddrBefore: number; stackHash: number }> {
        return this.winApiRing.getCallsRich(count);
    }

    /** Recent hypercalls (crash-hunt): EVERY OUT 0xB077 incl. fast-path, oldest→newest. */
    getLastHypercalls(count: number = 48): string[] {
        const n = Math.min(count, 256);
        const out: string[] = [];
        for (let i = n; i >= 1; i--) {
            const p = (this.hcRingPos - i) & 255;
            const id = this.hcRingId[p] | 0;
            if (id === 0 && this.hcRingThread[p] === 0 && this.hcRingCaller[p] === 0) continue;
            const name = (id > 0 && id < this.namesTable.length ? this.namesTable[id] : null) || `id_${id >>> 0}`;
            const h = this.hcRingHead[p] >>> 0;
            out.push(`T${this.hcRingThread[p]} ${name} <-0x${(this.hcRingCaller[p] >>> 0).toString(16)}${this.hcWatchAddr ? ` head=0x${h.toString(16)}${h === 0 ? " *TORN*" : ""}` : ""}`);
        }
        return out;
    }

    getLastWinApiTrace(count: number = 16): string[] {
        return this.winApiRing.getTrace(count);
    }

    /**
     * Schedule checksum validation at safe points (e.g., heartbeat).
     * Avoids running on the main thunk hot path by throttling based on time and CPU state.
     */
    maybeScheduleChecksumValidation(force: boolean = false): void {
        if (System.getInstance().isExiting) return;
        const now = performance.now();
        if (!force && now < this.nextChecksumAt) return;
        const running = this.v86?.is_running?.() ?? false;
        if (running) return;

        this.updateMemoryCache();
        const mem8 = this.cachedMem8;
        if (!mem8 || mem8.byteLength === 0) return;

        this.nextChecksumAt = now + this.checksumIntervalMs;
        this.checksumInProgress = true;
        thunkChecksumManager.validateThunkRegion(mem8, "heartbeat")
            .then(valid => {
                if (!valid) {
                    Logger.error(LogCategory.SYSTEM, "Thunk checksum validation failed during heartbeat - halting emulator");
                    System.getInstance().isExiting = true;
                }
            })
            .catch(err => {
                Logger.error(LogCategory.SYSTEM, `Thunk checksum validation error: ${err}`);
            })
            .finally(() => {
                this.checksumInProgress = false;
            });
    }

    // =========================================================================
    // Deferred Writes (for async thunk output parameters)
    // =========================================================================

    /**
     * Validates if an address is safe for deferred write.
     * Rejects: out of bounds, below current ESP (stale stack after RET), in THUNK_CODE/CALLBACK_STUB regions.
     *
     * @param addr - Address to write to
     * @param size - Size of write
     * @param currentEsp - ESP after RET N simulation (not original ESP at call time!)
     */
    private isAddressSafeForDeferredWrite(addr: number, size: number, currentEsp: number, thunkName: string): boolean {
        // Out of bounds check
        if (addr < 0 || addr + size > this.memLength) {
            Logger.warn(LogCategory.THUNK,
                `Deferred write blocked: addr 0x${addr.toString(16)} out of bounds (memLen=0x${this.memLength.toString(16)})`);
            return false;
        }

        // Stack safety check: allow writes within caller's stack frame
        // currentEsp is the original ESP captured at call time (BEFORE RET N simulation)
        const isStackRegion = addr >= STACK_REGION_START && addr < STACK_REGION_END;
        if (isStackRegion) {
            // Note: Block writes to return address slot (currentEsp+0 to currentEsp+3)
            // This is the most dangerous case: overwriting return address causes #GP
            const overlapsReturnAddr = (addr >= currentEsp && addr < currentEsp + 4) ||
                (addr < currentEsp + 4 && addr + size > currentEsp);
            if (overlapsReturnAddr) {
                Logger.error(LogCategory.THUNK,
                    `?? BLOCKED: Deferred write OVERLAPS RETURN ADDRESS! ${thunkName}: addr=0x${addr.toString(16)}, size=${size}, ESP=0x${currentEsp.toString(16)}\n` +
                    `Return address slot is [ESP+0] to [ESP+3]. Writing here would cause #GP!\n` +
                    `This is likely a bug in thunk implementation - out-params should not point to return address slot!`);
                return false;
            }

            // Allow writes ABOVE or AT currentEsp (caller's stack frame and above)
            // Block writes BELOW currentEsp (freed stack frames, potential corruption)
            if (addr < currentEsp) {
                Logger.error(LogCategory.THUNK,
                    `?? BLOCKED: Deferred write to FREED STACK! ${thunkName}: addr=0x${addr.toString(16)}, size=${size}, originalEsp=0x${currentEsp.toString(16)}\n` +
                    `This would corrupt freed stack frames (race condition with callbacks)`);
                return false;
            }
            // addr >= currentEsp: write is in caller's frame or above, ALLOWED
            Logger.verbose(LogCategory.THUNK,
                `Deferred write to stack out-param: ${thunkName} addr=0x${addr.toString(16)} (originalEsp=0x${currentEsp.toString(16)})`);
        }

        // Check if address is in THUNK_CODE or CALLBACK_STUB regions (immutable)
        if (this.thunkGeneratorBase !== 0 &&
            addr >= this.thunkGeneratorBase && addr < this.thunkGeneratorEnd) {
            Logger.error(LogCategory.THUNK,
                `?? ASYNC WRITE GUARD: Blocked write to THUNK_CODE region! ${thunkName}: addr=0x${addr.toString(16)}`);
            return false;
        }
        if (this.callbackStubPoolBase !== 0 &&
            addr >= this.callbackStubPoolBase && addr < this.callbackStubPoolEnd) {
            Logger.error(LogCategory.THUNK,
                `?? ASYNC WRITE GUARD: Blocked write to CALLBACK_STUB region! ${thunkName}: addr=0x${addr.toString(16)}`);
            return false;
        }

        return true;
    }

    /**
     * Applies deferred writes from async thunk result.
     * Called during _restoreAsyncContext after registers are restored but before v86.run().
     *
     * @param writes - Array of deferred writes to apply
     * @param currentEsp - ESP after RET N simulation (addresses below this are stale)
     * @param thunkName - Name of thunk for logging
     */
    private applyDeferredWrites(writes: DeferredWrite[], currentEsp: number, thunkName: string): void {
        if (!writes || writes.length === 0) return;

        // Ensure memory cache is valid
        if (!this.cachedMem8 || this.cachedMem8.byteLength === 0 || !this.isDataViewValid()) {
            this.updateMemoryCache();
            if (!this.cachedMem8 || this.cachedMem8.byteLength === 0 || !this.isDataViewValid()) {
                Logger.error(LogCategory.THUNK,
                    `Cannot apply deferred writes for ${thunkName}: memory detached`);
                return;
            }
        }

        const view = this.cachedDataView!;

        for (const write of writes) {
            if (!this.isAddressSafeForDeferredWrite(write.address, write.size, currentEsp, thunkName)) {
                Logger.error(LogCategory.THUNK,
                    `? Skipping UNSAFE deferred write for ${thunkName}: addr=0x${write.address.toString(16)}, ` +
                    `size=${write.size}, value=0x${write.value.toString(16)}, ESP=0x${currentEsp.toString(16)}`);
                continue;
            }

            try {
                switch (write.size) {
                    case 1:
                        view.setUint8(write.address, write.value & 0xFF);
                        break;
                    case 2:
                        view.setUint16(write.address, write.value & 0xFFFF, true);
                        break;
                    case 4:
                        view.setUint32(write.address, write.value >>> 0, true);
                        break;
                    case 8:
                        view.setBigInt64(write.address, BigInt(write.value), true);
                        break;
                }
            } catch (e) {
                Logger.error(LogCategory.THUNK,
                    `Failed to apply deferred write for ${thunkName} at 0x${write.address.toString(16)}: ${e}`);
            }
        }
    }

    // =========================================================================
    // SLOW PATHS (Moved out of hot loop to help JIT)
    // =========================================================================

    private _slowPathHandleDebugMarker(functionId: number, cpu: any): void {
        if (System.getInstance().isExiting) return;

        const marker = functionId & 0xFFFF;

        // Recoverable #DE (Division Error, vector 0) � skip the faulting DIV/IDIV
        // Handler uses IRET so we must fix up the interrupt frame before returning
        if (marker === 0x0000) {
            this._handleRecoverableDivisionError(cpu);
            return;
        }

        // Recoverable #PF (Page Fault, vector 14) � handler uses IRET to retry
        if (marker === 0x000E) {
            this._handleRecoverablePageFault(cpu);
            return;
        }

        // Recoverable #UD (vector 6) / #GP (vector 13) — handler uses IRET; the JS
        // side picks the outcome (SEH dispatch / thread termination / halt) by
        // rewriting the frame's return EIP.
        if (marker === 0x0006 || marker === 0x000D) {
            this._handleRecoverableCpuException(marker, cpu);
            return;
        }

        // DllMain result reporter (from bootloader hook)
        if (marker === 0x000a) {
            const result = cpu.reg32[1] >>> 0; // ECX holds the result
            Logger.warn(LogCategory.SYSTEM, `[DIAG] DllMain call finished. Result (EAX): 0x${result.toString(16)}`);
            return;
        }

        const markers: Record<number, string> = {
            0x0001: "Bootloader started (16-bit)",
            0x0002: "GDT loaded (16-bit)",
            0x0003: "Entered 32-bit protected mode + IDT loaded!",
            0x0004: "Segments configured, jumping to PE entry",
            0x00EE: "EXCEPTION: Generic/Unknown vector",
            0x0080: "EXCEPTION: int 0x80 (Linux syscall)",
            0x02EE: "EXCEPTION: int 0x2E (Windows syscall/NT)",
        };
        const isException = marker >= 0x0006 && marker <= 0x00EE;
        const msg = markers[marker] || `Unknown marker 0x${marker.toString(16)}`;

        if (isException) {
            this._dumpExceptionContext(marker, cpu);
            this.isWaitingForEipDump = true;
        } else {
            Logger.log(LogCategory.SYSTEM, msg);

            // Enable paging right after PM + IDT are ready
            if (marker === 0x0003) {
                const ptm = System.getInstance().process?.pageTableManager;
                if (ptm && !ptm.isPagingEnabled()) {
                    ptm.enablePaging(cpu);
                }
                // Set up TEB before game code starts � the game's CRT startup will
                // immediately do `push fs:[0]; mov fs:[0], esp` to install SEH.
                // If FS base is 0 (no TEB), this reads from the null guard page > #PF.
                const scheduler = System.getInstance().scheduler;
                if (scheduler) {
                    scheduler.initializeMainThreadTeb();
                }
            }
        }
    }

    private _dumpExceptionContext(marker: number, cpu: any): void {
        // Cold-path forensic dump — see exception-context-dumper.ts.
        dumpExceptionContext(this, marker, cpu);
    }

    /**
     * Handle recoverable #DE (Division Error, vector 0).
     * Parses the faulting DIV/IDIV instruction, advances EIP past it,
     * sets EAX=EDX=0, and lets the IRET in the handler resume execution.
     *
     * Interrupt frame (no error code): [ESP+0]=EIP, [ESP+4]=CS, [ESP+8]=EFLAGS
     */
    /**
     * Handle SEH dispatch result from the x86 trampoline stub.
     * Fired when the stub does OUT DX, EAX with marker 0x7FFF0002.
     * The stub has already called all SEH handlers natively.
     *
     * If a handler caught the exception (__except_handler3 longjmps to except block),
     * this OUT never fires � the trampoline is abandoned and game continues.
     */
    private _handleSehDispatchResult(cpu: any): void {
        // Pop the topmost dispatch context — read results from its scratchAddr
        const ctx = this.sehDispatchStack.pop();
        if (ctx) {
            this._leaveSehCriticalRuntime('dispatch_result', ctx.generation);
            Logger.log(LogCategory.SYSTEM,
                `SEH dispatch result: popped gen=${ctx.generation}, remaining depth=${this.sehDispatchStack.length}`);
        } else {
            // Fallback: no context on stack (shouldn't happen, but be safe)
            Logger.warn(LogCategory.SYSTEM, `SEH dispatch result: no context on stack (idle?)`);
        }

        const view = this.cachedDataView;
        const scratchAddr = ctx?.scratchAddr ?? this.sehScratchAddr;
        if (!view || scratchAddr === 0) {
            Logger.error(LogCategory.SYSTEM,
                `SEH dispatch result: no scratch area or DataView`);
            return;
        }

        const result = view.getUint32(scratchAddr + SEH_SCRATCH_LAYOUT.DISPATCH_RESULT, true);
        const faultingEip = view.getUint32(scratchAddr + SEH_SCRATCH_LAYOUT.FAULT_EIP, true);
        const lastHandlerResult = view.getUint32(scratchAddr + SEH_SCRATCH_LAYOUT.LAST_HANDLER_RESULT, true) >>> 0;
        const lastHandlerFrame = view.getUint32(scratchAddr + SEH_SCRATCH_LAYOUT.LAST_HANDLER_FRAME, true) >>> 0;
        const lastHandlerAddr = view.getUint32(scratchAddr + SEH_SCRATCH_LAYOUT.LAST_HANDLER_ADDR, true) >>> 0;
        const esp = cpu.reg32[4] >>> 0;

        if (result === 0) {
            // ContinueExecution — retry the faulting instruction.
            // Restore full register state from CONTEXT — the handler/filter may have
            // modified registers (e.g., fixing the faulting pointer). On real Windows,
            // NtContinue restores the full CONTEXT including any modifications.
            const ctxBase = scratchAddr + SEH_SCRATCH_LAYOUT.CONTEXT;
            cpu.reg32[7] = view.getUint32(ctxBase + 0x9C, true); // EDI
            cpu.reg32[6] = view.getUint32(ctxBase + 0xA0, true); // ESI
            cpu.reg32[3] = view.getUint32(ctxBase + 0xA4, true); // EBX
            cpu.reg32[2] = view.getUint32(ctxBase + 0xA8, true); // EDX
            cpu.reg32[1] = view.getUint32(ctxBase + 0xAC, true); // ECX
            cpu.reg32[0] = view.getUint32(ctxBase + 0xB0, true); // EAX
            cpu.reg32[5] = view.getUint32(ctxBase + 0xB4, true); // EBP
            const ctxEip = view.getUint32(ctxBase + 0xB8, true); // EIP from CONTEXT

            Logger.warn(LogCategory.SYSTEM,
                `SEH dispatch: handler returned ContinueExecution, retrying EIP=0x${ctxEip.toString(16)}`);
            // Write restored EIP at [ESP] so RET pops it → retries the instruction
            if (esp + 4 <= this.memLength) {
                guardStackWrite(esp, 4, 'thunk:sehContinueExec', ctxEip);
                view.setUint32(esp, ctxEip, true);
            }
        } else {
            // Unhandled — all handlers returned ContinueSearch.
            // Try UnhandledExceptionFilter before halting.
            // Covers BOTH the UEF and halt paths.
            this._recordFaultEip(faultingEip);
            Logger.warn(LogCategory.SYSTEM,
                `SEH dispatch: unhandled result=${result} lastDisposition=0x${lastHandlerResult.toString(16)} ` +
                `lastFrame=0x${lastHandlerFrame.toString(16)} lastHandler=0x${lastHandlerAddr.toString(16)}`);
            if (this.unhandledExceptionFilterAddr !== 0 && this.cachedMem8) {
                const epPtr = scratchAddr + SEH_SCRATCH_LAYOUT.EXCEPTION_POINTERS;
                const uefAddr = this.unhandledExceptionFilterAddr;
                Logger.warn(LogCategory.SYSTEM,
                    `SEH dispatch: all handlers exhausted, invoking UEF at 0x${uefAddr.toString(16)}`);

                // Write a small call frame below the current ESP
                const curEsp = cpu.reg32[4] >>> 0;
                if (curEsp >= 16) {
                    const frameEsp = (curEsp - 8) >>> 0;
                    guardStackWrite(frameEsp, 8, 'thunk:uefFrame');
                    view.setUint32(frameEsp, PF_HALT_TARGET, true);
                    view.setUint32(frameEsp + 4, epPtr, true);

                    // Write stub in scratch area to set ESP and JMP to UEF
                    const stubAddr = scratchAddr + SEH_SCRATCH_LAYOUT.EH3_FILTER_CTX;
                    const mem = this.cachedMem8;
                    let off = stubAddr;
                    mem[off++] = 0xBC; // MOV ESP, imm32
                    view.setUint32(off, frameEsp, true); off += 4;
                    mem[off++] = 0xB8; // MOV EAX, imm32
                    view.setUint32(off, uefAddr, true); off += 4;
                    mem[off++] = 0xFF; mem[off++] = 0xE0; // JMP EAX

                    // After dispatch stub's OUT, the RET pops [ESP]. Write stub address there.
                    if (esp + 4 <= this.memLength) {
                        guardStackWrite(esp, 4, 'thunk:uefRedirect', stubAddr);
                        view.setUint32(esp, stubAddr, true);
                    }
                    return;
                }
            }

            Logger.error(LogCategory.SYSTEM,
                `SEH dispatch: all handlers exhausted (unhandled), halting. Fault EIP=0x${faultingEip.toString(16)}`);
            if (esp + 4 <= this.memLength) {
                view.setUint32(esp, PF_HALT_TARGET, true);
            }
        }
    }

    /**
     * Set up a call to the registered UnhandledExceptionFilter when no SEH handler
     * caught the access violation.
     *
     * Builds EXCEPTION_POINTERS + EXCEPTION_RECORD + CONTEXT in the scratch area,
     * writes a small x86 stub that switches ESP to the safe stack and JMPs to UEF,
     * and redirects the #PF IRET to that stub.
     *
     * UEF is stdcall: LONG WINAPI UEF(EXCEPTION_POINTERS*).
     * If UEF returns, execution goes to PF_HALT_TARGET (halt).
     * If UEF is a thunk, it will trap to JS as normal.
     *
     * Returns true if setup succeeded (IRET redirected).
     */
    private _setupUnhandledExceptionFilterCall(
        cpu: any,
        faultAddr: number,
        faultingEip: number,
        isWrite: boolean,
        esp: number,
        savedEax: number,
        savedEdx: number,
        view: DataView,
        exceptionCode: number = 0xC0000005,
    ): boolean {
        const mem = this.cachedMem8;
        if (!mem) return false;

        const scratchAddr = this.sehScratchAddr;
        if (scratchAddr === 0) return false;

        const regs = cpu.reg32;
        const preFaultEsp = (esp + 24) >>> 0;
        const uefAddr = this.unhandledExceptionFilterAddr;

        // Build EXCEPTION_RECORD in scratch area (params: AV carries 2, others 0)
        const numParams = exceptionCode === 0xC0000005 ? 2 : 0;
        const excRec = scratchAddr + SEH_SCRATCH_LAYOUT.EXCEPTION_RECORD;
        view.setUint32(excRec + 0, exceptionCode, true);      // ExceptionCode
        view.setUint32(excRec + 4, 0, true);                  // ExceptionFlags
        view.setUint32(excRec + 8, 0, true);                  // ExceptionRecord
        view.setUint32(excRec + 12, faultingEip, true);       // ExceptionAddress
        view.setUint32(excRec + 16, numParams, true);         // NumberParameters
        view.setUint32(excRec + 20, numParams ? (isWrite ? 1 : 0) : 0, true); // [0] = read/write
        view.setUint32(excRec + 24, numParams ? faultAddr : 0, true);         // [1] = fault address

        // Build minimal CONTEXT
        const ctxBase = scratchAddr + SEH_SCRATCH_LAYOUT.CONTEXT;
        for (let i = 0; i < 716; i += 4) view.setUint32(ctxBase + i, 0, true);
        view.setUint32(ctxBase + 0x00, 0x10007, true);  // ContextFlags
        view.setUint32(ctxBase + 0x9C, regs[7], true);  // EDI
        view.setUint32(ctxBase + 0xA0, regs[6], true);  // ESI
        view.setUint32(ctxBase + 0xA4, regs[3], true);  // EBX
        view.setUint32(ctxBase + 0xA8, savedEdx, true); // EDX
        view.setUint32(ctxBase + 0xAC, regs[1], true);  // ECX
        view.setUint32(ctxBase + 0xB0, savedEax, true); // EAX
        view.setUint32(ctxBase + 0xB4, regs[5], true);  // EBP
        view.setUint32(ctxBase + 0xB8, faultingEip, true); // EIP
        view.setUint32(ctxBase + 0xC4, preFaultEsp, true); // ESP

        // Build EXCEPTION_POINTERS
        const epPtr = scratchAddr + SEH_SCRATCH_LAYOUT.EXCEPTION_POINTERS;
        view.setUint32(epPtr, excRec, true);
        view.setUint32(epPtr + 4, ctxBase, true);

        // Build call frame on the game stack below the fault point
        const frameEsp = (preFaultEsp - 0x208) >>> 0;
        view.setUint32(frameEsp, PF_HALT_TARGET, true);  // return addr (halt if UEF returns)
        view.setUint32(frameEsp + 4, epPtr, true);       // arg: EXCEPTION_POINTERS*

        // Write x86 stub in scratch EH3_FILTER_CTX region:
        //   MOV ESP, frameEsp    ; switch to safe stack with call frame
        //   MOV EAX, uefAddr     ; UEF entry point
        //   JMP EAX              ; call UEF (stdcall, pops arg on return)
        const stubAddr = scratchAddr + SEH_SCRATCH_LAYOUT.EH3_FILTER_CTX;
        let off = stubAddr;
        mem[off++] = 0xBC; // MOV ESP, imm32
        view.setUint32(off, frameEsp, true); off += 4;
        mem[off++] = 0xB8; // MOV EAX, imm32
        view.setUint32(off, uefAddr, true); off += 4;
        mem[off++] = 0xFF; mem[off++] = 0xE0; // JMP EAX

        // Restore saved EAX/EDX on the interrupt frame and redirect IRET to stub
        view.setUint32(esp, savedEdx, true);
        view.setUint32(esp + 4, savedEax, true);
        view.setUint32(esp + 12, stubAddr, true);

        Logger.warn(LogCategory.SYSTEM,
            `SEH AV unhandled: invoking UnhandledExceptionFilter at 0x${uefAddr.toString(16)} ` +
            `via stub at 0x${stubAddr.toString(16)}, EXCEPTION_POINTERS at 0x${epPtr.toString(16)}`);

        return true;
    }

    /**
     * Fault-time SEH dispatch-stack hygiene, shared by the #PF and #UD/#GP paths.
     * Pops contexts left stale by a longjmp catch, then blocks pathological loops:
     * fault at dispatch depth >= 2, or the exact same fault signature repeating at
     * the same generation (infinite retry). On block, redirects the frame's IRET
     * target ([ESP+12]) to the halt stub and returns false; the crash funnel fires
     * via the scheduler's halt watch. Returns true when dispatch may proceed.
     */
    private _sehFaultDispatchGuard(
        esp: number,
        faultingEip: number,
        faultAddr: number,
        view: DataView | null,
    ): boolean {
        if (this.sehDispatchStack.length > 0) {
            // preFaultEsp = esp + 24 (undo PUSH EDX + PUSH EAX + error code + EIP + CS + EFLAGS).
            // A dispatch context whose ESP is below it was already caught via longjmp — stale.
            const preFaultEsp = (esp + 24) >>> 0;
            while (this.sehDispatchStack.length > 0) {
                const staleTop = this.sehDispatchStack[this.sehDispatchStack.length - 1];
                if (staleTop.startEsp !== 0 && preFaultEsp > staleTop.startEsp) {
                    Logger.warn(LogCategory.SYSTEM,
                        `SEH dispatch stale: fault at ESP=0x${preFaultEsp.toString(16)} above dispatch ESP=0x${staleTop.startEsp.toString(16)} ` +
                        `(gen=${staleTop.generation}) — handler caught, popping context`);
                    this.sehDispatchStack.pop();
                    this._leaveSehCriticalRuntime('stale_context_at_fault', staleTop.generation);
                } else {
                    break;
                }
            }
        }

        if (this.sehDispatchStack.length > 0) {
            const top = this.sehDispatchStack[this.sehDispatchStack.length - 1];
            const currentSig: SehFaultSignature = {
                faultEip: faultingEip >>> 0,
                faultAddr: faultAddr >>> 0,
                generation: top.generation >>> 0,
            };
            const prevSig = top.lastFaultSignature;
            const isRepeat = !!prevSig &&
                prevSig.generation === currentSig.generation &&
                prevSig.faultEip === currentSig.faultEip &&
                prevSig.faultAddr === currentSig.faultAddr;
            top.lastFaultSignature = currentSig;

            // Fault-inside-fault at depth >= 2 is pathological — halt
            if (this.sehDispatchStack.length >= 2) {
                Logger.error(LogCategory.SYSTEM,
                    `Fault inside active SEH dispatch (depth=${this.sehDispatchStack.length}, gen=${top.generation}) ` +
                    `faultEIP=0x${faultingEip.toString(16)} faultAddr=0x${faultAddr.toString(16)} ` +
                    `${isRepeat ? '[repeat signature]' : '[nested signature]'} - halting (max depth)`);
                this._logSehCorruptionProtocol(
                    'seh_nested_fault_max_depth',
                    faultingEip,
                    faultAddr
                );
                this._setSehDispatchIdle('nested_fault_max_depth');
                if (view && esp + 16 <= this.memLength) {
                    view.setUint32(esp + 12, PF_HALT_TARGET, true);
                }
                return false;
            }

            // Repeat same fault signature at same generation — infinite retry
            if (isRepeat) {
                Logger.error(LogCategory.SYSTEM,
                    `Fault inside active SEH dispatch (gen=${top.generation}) ` +
                    `faultEIP=0x${faultingEip.toString(16)} faultAddr=0x${faultAddr.toString(16)} ` +
                    `[repeat signature] - halting`);
                this._logSehCorruptionProtocol('seh_repeat_fault_signature', faultingEip, faultAddr);
                this._setSehDispatchIdle('repeat_fault');
                if (view && esp + 16 <= this.memLength) {
                    view.setUint32(esp + 12, PF_HALT_TARGET, true);
                }
                return false;
            }

            // Single nesting (depth 0→1): allow — this is the AV→CxxThrow pattern.
            Logger.warn(LogCategory.SYSTEM,
                `Fault inside active SEH dispatch (gen=${top.generation}, depth=${this.sehDispatchStack.length}) ` +
                `faultEIP=0x${faultingEip.toString(16)} faultAddr=0x${faultAddr.toString(16)} ` +
                `- allowing nested dispatch`);
        }
        return true;
    }

    /**
     * Stash the fault EIP in globals readable live from the derailed worker
     * (the streamed log routinely drops the crash line). Read via:
     *   bun tools/cdp-worker-eval.ts "globalThis.__lastFaultEip?.toString(16)"
     */
    private _recordFaultEip(faultingEip: number): void {
        const g = globalThis as any;
        g.__lastFaultEip = faultingEip >>> 0;
        const hist: number[] = (g.__faultEipHist ??= []);
        hist.push(faultingEip >>> 0);
        if (hist.length > 64) hist.splice(0, hist.length - 64);
    }

    /**
     * Handle recoverable #UD (vector 6) / #GP (vector 13) from guest code.
     *
     * Frame during the OUT (the #UD handler pushes a dummy error code so both
     * vectors share the #PF frame shape):
     *   [ESP+0]  = saved EDX
     *   [ESP+4]  = saved EAX
     *   [ESP+8]  = error code (real for #GP, 0 for #UD)
     *   [ESP+12] = faulting EIP (IRET return target)
     *   [ESP+16] = CS
     *   [ESP+20] = EFLAGS
     *
     * Outcome hierarchy (Windows-faithful order): SEH chain dispatch with the
     * vector's NT status (#UD → STATUS_ILLEGAL_INSTRUCTION, #GP → the
     * STATUS_ACCESS_VIOLATION/0xFFFFFFFF form Windows reports for user-mode #GP),
     * then UnhandledExceptionFilter, then termination: the whole process when the
     * MAIN thread faulted (IRET → halt stub → scheduler halt watch → crash funnel),
     * or just the faulting WORKER thread (terminate + IRET → spin loop + immediate
     * reschedule) so the rest of the VM keeps running instead of freezing at CLI;HLT.
     */
    private _handleRecoverableCpuException(vector: number, cpu: any): void {
        const esp = cpu.reg32[4] >>> 0;
        const view = this.cachedDataView;
        const vecName = vector === 0x06 ? '#UD' : '#GP';
        if (!this.cachedMem8 || !this.isDataViewValid() || !view || esp + 24 > this.memLength) {
            Logger.error(LogCategory.SYSTEM,
                `${vecName}: fault frame unreadable at ESP=0x${esp.toString(16)} — cannot recover`);
            return;
        }

        const savedEdx = view.getUint32(esp, true) >>> 0;
        const savedEax = view.getUint32(esp + 4, true) >>> 0;
        const errorCode = view.getUint32(esp + 8, true) >>> 0;
        const faultingEip = view.getUint32(esp + 12, true) >>> 0;

        const isUd = vector === 0x06;
        const exceptionCode = isUd ? 0xC000001D : 0xC0000005;
        const faultAddr = isUd ? faultingEip : 0xFFFFFFFF;

        // Live EAX/EDX hold the OUT scratch; the handler tail POPs the real values
        // back from the frame, so restoring them here only fixes the forensics below.
        cpu.reg32[0] = savedEax | 0;
        cpu.reg32[2] = savedEdx | 0;

        this._recordFaultEip(faultingEip);

        const moduleRegistry = System.getInstance().process?.moduleRegistry;
        const mod = moduleRegistry?.getModuleContainingAddress(faultingEip);
        Logger.error(LogCategory.SYSTEM,
            `${vecName} at EIP=0x${faultingEip.toString(16)}` +
            `${mod ? ` (${mod.name}+0x${(faultingEip - mod.baseAddress).toString(16)})` : ''} ` +
            `error_code=0x${errorCode.toString(16)} last_thunk=${this.lastThunkName || 'unknown'}`);

        // Full forensic dump. The dumper expects ESP at the error-code slot for
        // error-code vectors and at the EIP slot otherwise — see espOverride.
        dumpExceptionContext(this, vector, cpu, isUd ? esp + 12 : esp + 8);

        const sys = System.getInstance();
        if (sys.isExiting) {
            // The dump escalated to the crash funnel (bootloader/stack escape) —
            // the process is tearing down; park the frame on the halt stub.
            view.setUint32(esp + 12, PF_HALT_TARGET, true);
            return;
        }

        // Durable fault record (harness `faults()` verb / fault-event payload).
        const r = cpu.reg32;
        const gameEsp = (esp + 24) >>> 0;
        const stackDump: number[] = [];
        if (gameEsp + 128 <= this.memLength) {
            for (let i = 0; i < 32; i++) stackDump.push(view.getUint32(gameEsp + i * 4, true) >>> 0);
        }
        const scheduler = this.ensureScheduler();
        const currentThread = scheduler.getCurrentThread?.() ?? null;
        faultRecorder.record({
            ts: performance.now(),
            eip: faultingEip >>> 0,
            faultAddr: faultAddr >>> 0,
            errorCode: exceptionCode >>> 0,
            threadId: currentThread?.id ?? null,
            lastThunk: this.lastThunkName || 'unknown',
            kind: "unhandled",
            regs: { ecx: r[1] >>> 0, ebx: r[3] >>> 0, esp: r[4] >>> 0, ebp: r[5] >>> 0, esi: r[6] >>> 0, edi: r[7] >>> 0 },
            recentCalls: this.winApiRing?.getCrashTraceLines?.(48) ?? [],
            gameEsp,
            stackDump,
        });

        if (!this._sehFaultDispatchGuard(esp, faultingEip, faultAddr, view)) return;

        const dispatched = this._tryDispatchAccessViolation(
            cpu, faultAddr, faultingEip, false, esp, savedEax, savedEdx, view, exceptionCode
        );
        if (dispatched) return;

        if (this.unhandledExceptionFilterAddr !== 0) {
            const uefDispatched = this._setupUnhandledExceptionFilterCall(
                cpu, faultAddr, faultingEip, false, esp, savedEax, savedEdx, view, exceptionCode
            );
            if (uefDispatched) return;
        }

        if (!currentThread || scheduler.isMainThread(currentThread.id)) {
            Logger.error(LogCategory.SYSTEM,
                `${vecName}: unhandled on ${currentThread ? 'MAIN thread' : 'unknown thread'} — fatal, ` +
                `redirecting IRET to halt stub (fault EIP=0x${faultingEip.toString(16)})`);
            view.setUint32(esp + 12, PF_HALT_TARGET, true);
            return;
        }

        Logger.error(LogCategory.SYSTEM,
            `${vecName}: unhandled on worker T${currentThread.id} — terminating thread ` +
            `with 0x${exceptionCode.toString(16)}, VM continues (fault EIP=0x${faultingEip.toString(16)})`);
        sys.reportGuestThreadFault({
            reason: `Unhandled ${vecName} (${isUd ? 'illegal instruction' : 'general protection'}) on worker thread — thread terminated`,
            eip: faultingEip,
            threadId: currentThread.id,
            exceptionCode,
        });
        scheduler.terminateCurrentThreadForFault(exceptionCode,
            `${vecName} at EIP=0x${faultingEip.toString(16)}`);
        view.setUint32(esp + 12, this.spinLoopAddress, true);
        preemptionManager.requestImmediateExit();
    }

    /**
     * Handle recoverable #PF (Page Fault).
     * The #PF handler saves EAX/EDX, does OUT, restores, pops error code, then IRET.
     *
     * Stack layout during OUT (after PUSH EAX, PUSH EDX in handler):
     *   [ESP+0]  = saved EDX
     *   [ESP+4]  = saved EAX
     *   [ESP+8]  = error code (CPU pushed)
     *   [ESP+12] = faulting EIP (CPU pushed — IRET return target)
     *   [ESP+16] = CS
     *   [ESP+20] = EFLAGS
     *
     * For unrecoverable faults, we overwrite [ESP+12] to redirect IRET to
     * CLI;HLT;JMP$ dead code inside the handler, preventing infinite retry.
     */
    private _handleRecoverablePageFault(cpu: any): void {
        const faultAddr = cpu.cr[2] >>> 0; // CR2 = faulting linear address
        const esp = cpu.reg32[4] >>> 0;
        const view = this.cachedDataView;

        // Stack offsets (+8 from saved EAX/EDX)
        let errorCode = 0;
        let faultingEip = 0;
        if (this.cachedMem8 && this.isDataViewValid() && esp + 16 <= this.memLength) {
            errorCode = view!.getUint32(esp + 8, true) >>> 0;
            faultingEip = view!.getUint32(esp + 12, true) >>> 0;
        }

        // Diagnostic write-trap (harness): if this fault is an armed page-write
        // trap, record the writer EIP, un-protect the page so the IRET retry of
        // the store lands, and return — the guest never sees the fault. Checked
        // before SEH/halt so a trapped store is never mistaken for an AV.
        if (memWriteTrap.isArmed()) {
            const isWriteFault = !!(errorCode & 0x02);
            const isPresentFault = !!(errorCode & 0x01);
            // NOTE: cpu.reg32 EAX/EDX are clobbered here (the #PF stub pushed them
            // before OUT); ECX/EBX/EBP/ESI/EDI are the guest's live values.
            if (memWriteTrap.tryHandle(faultAddr, faultingEip, isWriteFault, isPresentFault, this.lastThunkName || "", cpu)) {
                return;
            }
        }

        if (!this._sehFaultDispatchGuard(esp, faultingEip, faultAddr, view)) return;
        const isWrite = !!(errorCode & 0x02);
        const isPresent = !!(errorCode & 0x01); // 0 = not-present, 1 = protection violation

        // Module info for logging
        const moduleRegistry = System.getInstance().process?.moduleRegistry;
        let modInfo = '';
        if (moduleRegistry) {
            const mod = moduleRegistry.getModuleContainingAddress(faultingEip);
            if (mod) {
                modInfo = ` (${mod.name}+0x${(faultingEip - mod.baseAddress).toString(16)})`;
            }
        }

        Logger.error(LogCategory.SYSTEM,
            `#PF at EIP=0x${faultingEip.toString(16)}${modInfo}: ` +
            `${isWrite ? 'write' : 'read'} to 0x${faultAddr.toString(16)} ` +
            `[${isPresent ? 'protection' : 'not-present'}] ` +
            `error_code=0x${errorCode.toString(16)} ` +
            `last_thunk=${this.lastThunkName || 'unknown'}`);

        // Durable fault record (harness `faults()` verb) — survives the log firehose.
        const r = cpu.reg32;
        // Guest ESP sits above the #PF interrupt frame: handler PUSH EAX+EDX (8) +
        // CPU error_code+EIP+CS+EFLAGS (16) = 24 bytes. Capture 32 stack words for
        // the report's return-address chain (same data as the logged stack dump).
        const faultGameEsp = ((r[4] >>> 0) + 24) >>> 0;
        const faultStackDump: number[] = [];
        if (view && faultGameEsp > 0 && faultGameEsp + 128 <= this.memLength) {
            for (let i = 0; i < 32; i++) faultStackDump.push(view.getUint32(faultGameEsp + i * 4, true) >>> 0);
        }
        // EAX/EDX live in the #PF stub's saved copies, not cpu.reg32 (the stub's
        // MOV EAX,id / MOV EDX,port clobbered them before the OUT).
        let savedEax = 0, savedEdx = 0;
        if (view && esp + 8 <= this.memLength) {
            savedEdx = view.getUint32(esp, true) >>> 0;
            savedEax = view.getUint32(esp + 4, true) >>> 0;
        }
        const faultRegs = {
            eax: savedEax, ecx: r[1] >>> 0, edx: savedEdx, ebx: r[3] >>> 0,
            esp: r[4] >>> 0, ebp: r[5] >>> 0, esi: r[6] >>> 0, edi: r[7] >>> 0,
        };
        const cr2Candidates = cr2RegisterCandidates(faultAddr, faultRegs);
        const eipConsistent = this.cachedMem8
            ? isFaultEipConsistent(this.cachedMem8, faultingEip, faultAddr, faultRegs)
            : null;
        // No register explains CR2 ⇒ likely an instruction-fetch fault from an indirect
        // CALL whose slot (vtable/IAT) held a bad target. Name the slot.
        const badCall = (this.cachedMem8 && cr2Candidates.length === 0 && eipConsistent !== true)
            ? analyzeIndirectCallFault(this.cachedMem8, faultGameEsp, faultRegs)
            : null;
        faultRecorder.record({
            ts: performance.now(),
            eip: faultingEip >>> 0,
            faultAddr: faultAddr >>> 0,
            errorCode: errorCode >>> 0,
            threadId: System.getInstance().scheduler?.getCurrentThread?.()?.id ?? null,
            lastThunk: this.lastThunkName || 'unknown',
            kind: "unhandled",
            regs: faultRegs,
            cr2Candidates,
            eipTrusted: eipConsistent ?? undefined,
            badCall: badCall ?? undefined,
            recentCalls: this.winApiRing?.getCrashTraceLines?.(48) ?? [],
            gameEsp: faultGameEsp,
            stackDump: faultStackDump,
        });

        const regs = cpu.reg32;
        Logger.error(LogCategory.SYSTEM,
            `  EAX=0x${savedEax.toString(16)} ECX=0x${(regs[1] >>> 0).toString(16)} ` +
            `EDX=0x${savedEdx.toString(16)} EBX=0x${(regs[3] >>> 0).toString(16)}\n` +
            `  ESP=0x${esp.toString(16)} EBP=0x${(regs[5] >>> 0).toString(16)} ` +
            `ESI=0x${(regs[6] >>> 0).toString(16)} EDI=0x${(regs[7] >>> 0).toString(16)}`);
        if (cr2Candidates.length) {
            Logger.error(LogCategory.SYSTEM, `  CR2 = ${cr2Candidates.join(' | ')}`);
        }
        if (eipConsistent === false) {
            Logger.error(LogCategory.SYSTEM,
                `  !! reported EIP does NOT address CR2 — v86 materializes only eip's low 12 bits on a jit ` +
                `fault, so the page (and sometimes the offset) can be stale. Trust CR2 + registers, not this EIP.`);
        }
        if (badCall) {
            const mod = moduleRegistry?.getModuleContainingAddress(badCall.callSite);
            Logger.error(LogCategory.SYSTEM,
                `  !! BAD INDIRECT CALL: call ${badCall.operand} at 0x${badCall.callSite.toString(16)}` +
                `${mod ? ` (${mod.name}+0x${(badCall.callSite - mod.baseAddress).toString(16)})` : ''} ` +
                `fetched target 0x${badCall.slotValue.toString(16)} from slot 0x${badCall.slotAddr.toString(16)} ` +
                `— the CALL pushed its return address and the FETCH faulted. Inspect that slot's owner ` +
                `(COM vtable / IAT), not the reported EIP.`);
        }

        // Dump instruction bytes at faulting EIP and stack contents
        if (view && faultingEip > 0 && faultingEip + 16 <= this.memLength) {
            const instrBytes: string[] = [];
            for (let i = 0; i < 16; i++) {
                instrBytes.push(view.getUint8(faultingEip + i).toString(16).padStart(2, '0'));
            }
            Logger.error(LogCategory.SYSTEM,
                `  EIP bytes: ${instrBytes.join(' ')}`);
        }
        // Game's actual ESP = after removing #PF handler pushes + CPU interrupt frame
        // Handler pushes: PUSH EAX + PUSH EDX = 8 bytes
        // CPU pushes: error_code + EIP + CS + EFLAGS = 16 bytes
        // Total: 24 bytes above current esp
        const gameEsp = esp + 24;
        Logger.error(LogCategory.SYSTEM, `  Game ESP before fault: 0x${gameEsp.toString(16)}`);
        if (view && gameEsp > 0 && gameEsp + 128 <= this.memLength) {
            const stackWords: string[] = [];
            for (let i = 0; i < 32; i++) {
                const addr = gameEsp + i * 4;
                const val = view.getUint32(addr, true) >>> 0;
                // Annotate values that look like code addresses vs floats
                let annotation = '';
                if (val >= 0x400000 && val < 0x600000) annotation = ' (code?)';
                else if (val >= MEM_THUNK_CODE_BASE && val < (MEM_THUNK_DATA_BASE + MEM_THUNK_DATA_SIZE)) annotation = ' (thunk?)';
                else if (val >= 0x3E000000 && val < 0x48000000 && val !== 0x44000000 && val !== 0x40000000) {
                    const fb = new DataView(new ArrayBuffer(4));
                    fb.setUint32(0, val, false);
                    annotation = ` (float: ${fb.getFloat32(0).toFixed(4)})`;
                }
                stackWords.push(`  [GameESP+0x${(i * 4).toString(16).padStart(2, '0')}] = 0x${val.toString(16).padStart(8, '0')}${annotation}`);
            }
            Logger.error(LogCategory.SYSTEM,
                `  Game stack dump (32 words from 0x${gameEsp.toString(16)}):\n${stackWords.join('\n')}`);
        }

        // Dump recent thunk calls (ring buffer) for crash diagnosis
        {
            const lines = this.winApiRing.getCrashTraceLines(50);
            Logger.error(LogCategory.SYSTEM, `#PF crash trace — last ${lines.length} thunks:\n${lines.join('\n')}`);
        }

        // Null pointer detection (first 64KB is unmapped, matching Windows NOACCESS guard)
        if (faultAddr < 0x10000) {
            Logger.error(LogCategory.SYSTEM,
                `#PF: NULL POINTER ${isWrite ? 'write' : 'read/execute'} at 0x${faultAddr.toString(16)} ` +
                `from EIP=0x${faultingEip.toString(16)}${modInfo} � ` +
                `on real Windows this would be STATUS_ACCESS_VIOLATION (0xC0000005)`);
        }

        // Try SEH dispatch before halting � games with __try/__except expect
        // EXCEPTION_ACCESS_VIOLATION to be dispatched through the SEH chain.
        if (view && esp + 16 <= this.memLength) {
            const dispatched = this._tryDispatchAccessViolation(
                cpu, faultAddr, faultingEip, isWrite, esp, savedEax, savedEdx, view
            );
            if (dispatched) return; // SEH handler found, IRET will go to except block

            // No SEH handler caught — try UnhandledExceptionFilter fallback.
            // On real Windows, if no handler catches, ntdll calls the registered
            // top-level exception filter before terminating.
            if (this.unhandledExceptionFilterAddr !== 0) {
                const uefDispatched = this._setupUnhandledExceptionFilterCall(
                    cpu, faultAddr, faultingEip, isWrite, esp, savedEax, savedEdx, view
                );
                if (uefDispatched) return;
            }

            // No SEH handler and no UEF — redirect IRET to halt target to prevent infinite retry.
            view.setUint32(esp + 12, PF_HALT_TARGET, true);
        }
    }

    /**
     * Try to dispatch an EXCEPTION_ACCESS_VIOLATION (0xC0000005) through the SEH chain.
     *
     * Like real Windows, calls EVERY handler in the chain with the standard 4-argument
     * protocol: (ExceptionRecord*, EstablisherFrame, Context*, DispatcherContext).
     * Each handler returns its disposition (0=ContinueExecution, 1=ContinueSearch).
     * If a handler catches (longjmp), it never returns.
     *
     * Two-tier approach:
     * 1. Fast path: for __except_handler3 frames with trivial filters (MOV EAX,1;RET),
     *    jump directly to the except block without the trampoline.
     * 2. Slow path: if any frame has a non-trivial filter OR is not __except_handler3,
     *    collect ALL frames into the frame list and use the static dispatch stub.
     *
     * Returns true if dispatch was handled (IRET redirected).
     */
    private _tryDispatchAccessViolation(
        cpu: any,
        faultAddr: number,
        faultingEip: number,
        isWrite: boolean,
        esp: number,
        savedEax: number,
        savedEdx: number,
        view: DataView,
        exceptionCode: number = 0xC0000005,
    ): boolean {
        const mem = this.cachedMem8;
        if (!mem) return false;
        const previewBytes = (addr: number, count: number): string => {
            if (addr < 0 || addr + count > this.memLength) return 'n/a';
            const bytes: string[] = [];
            for (let i = 0; i < count; i++) {
                bytes.push(mem[addr + i].toString(16).padStart(2, '0'));
            }
            return bytes.join(' ');
        };

        const tebAddr = cpu.segment_offsets?.[4] ?? 0;
        if (tebAddr === 0 || tebAddr + 4 > this.memLength) {
            Logger.warn(LogCategory.SYSTEM,
                `SEH AV dispatch: no TEB (FS base=0x${tebAddr.toString(16)})`);
            return false;
        }

        const sehHead = view.getUint32(tebAddr, true);

        Logger.warn(LogCategory.SYSTEM,
            `SEH AV dispatch: TEB=0x${tebAddr.toString(16)} sehHead=0x${(sehHead >>> 0).toString(16)} ` +
            `faultAddr=0x${faultAddr.toString(16)} faultEIP=0x${faultingEip.toString(16)}`);
        this.captureSehRuntimeDump('seh-av', {
            faultAddr,
            faultEip: faultingEip,
            sehHead: sehHead >>> 0,
        });

        // --- First pass: try fast path on all frames ---
        // Walk the chain. For __except_handler3 frames with trivial filters,
        // we can handle directly. For handler4, raw, or complex frames,
        // fall through to slow path (native x86 handler execution).

        let frameCount = 0;
        let needsSlowPath = false;
        let walkHead = sehHead;

        while (walkHead !== 0xFFFFFFFF && walkHead !== 0 && frameCount < SEH_FRAME_LIST_MAX) {
            frameCount++;
            if (walkHead + 16 > this.memLength) break;

            const next = view.getUint32(walkHead, true);
            const handler = view.getUint32(walkHead + 4, true);
            const scopeTable = view.getUint32(walkHead + 8, true);
            const trylevel = view.getInt32(walkHead + 12, true);

            Logger.warn(LogCategory.SYSTEM,
                `SEH AV frame #${frameCount}: addr=0x${walkHead.toString(16)} next=0x${(next >>> 0).toString(16)} ` +
                `handler=0x${handler.toString(16)} scopeTable=0x${scopeTable.toString(16)} trylevel=${trylevel}`);
            Logger.warn(LogCategory.SYSTEM,
                `SEH AV frame #${frameCount} preview: handler[0..31]=${previewBytes(handler, 32)} ` +
                `scope[0..31]=${previewBytes(scopeTable, 32)}`);

            // Check if this is an __except_handler3 frame (scopeTable is a valid pointer, trylevel in range)
            const isHandler3 = scopeTable >= 0x10000 && trylevel >= -1 && trylevel <= 255;

            if (!isHandler3) {
                // Raw SEH handler or VC7+ __CxxFrameHandler3 — can't evaluate statically
                Logger.warn(LogCategory.SYSTEM,
                    `SEH AV: frame #${frameCount} is not handler3 (scopeTable=0x${scopeTable.toString(16)}) > slow path`);
                needsSlowPath = true;
                break;
            }

            // Detect __except_handler4 scope tables: they start with a 16-byte header
            // [+0]=GSCookieOffset (typically -2/0xFFFFFFFE), [+4]=GSCookieXOROffset,
            // [+8]=EHCookieOffset, [+12]=EHCookieXOROffset.
            // Entries are at +16 and XOR'd with __security_cookie.
            // If the first "previousTryLevel" looks like a GS cookie marker (-2),
            // this is handler4 — must use slow path for correct decoding.
            if (scopeTable + 4 <= this.memLength) {
                const firstField = view.getInt32(scopeTable, true);
                const secondField = view.getUint32(scopeTable + 4, true);
                if (firstField === -2 || (firstField === -1 && secondField < 0x10000)) {
                    // Handler4 header: GSCookieOffset=-2, or -1 with low XOR offset
                    Logger.warn(LogCategory.SYSTEM,
                        `SEH AV: frame #${frameCount} has handler4-style scope table ` +
                        `(first=${firstField}, second=0x${secondField.toString(16)}) > slow path`);
                    needsSlowPath = true;
                    break;
                }
            }

            // Walk scope table entries from current trylevel backwards
            let level = trylevel;
            while (level >= 0 && level < 256) {
                const entryBase = scopeTable + level * 12;
                if (entryBase + 12 > this.memLength) break;

                const previousTryLevel = view.getInt32(entryBase, true);
                const filterAddr = view.getUint32(entryBase + 4, true);
                const handlerAddr = view.getUint32(entryBase + 8, true);
                Logger.warn(LogCategory.SYSTEM,
                    `SEH AV scope level=${level}: prev=${previousTryLevel} filter=0x${filterAddr.toString(16)} ` +
                    `handler=0x${handlerAddr.toString(16)} filter[0..47]=${previewBytes(filterAddr, 48)}`);

                // Skip __finally blocks (filterAddr == 0)
                if (filterAddr === 0 || filterAddr + 6 > this.memLength) {
                    level = previousTryLevel;
                    continue;
                }

                // Try to evaluate the filter statically
                const filterResult = this._evaluateSimpleFilter(mem, filterAddr, exceptionCode);

                if (filterResult === 1) {
                    // EXCEPTION_EXECUTE_HANDLER — jump to except block (fast path)
                    Logger.warn(LogCategory.SYSTEM,
                        `SEH dispatch (fast): ACCESS_VIOLATION at 0x${faultAddr.toString(16)} ` +
                        `(EIP=0x${faultingEip.toString(16)}) caught by handler at 0x${handlerAddr.toString(16)} ` +
                        `(frame=0x${walkHead.toString(16)} trylevel=${level})`);
                    // A guest __except that swallows an AV turns a crash into a clean-looking
                    // quit; record it so the exit trace can name the fault it descended from.
                    faultRecorder.annotateLast(
                        `ACCESS_VIOLATION caught by guest __except handler 0x${handlerAddr.toString(16)}`);

                    view.setUint32(esp, savedEdx, true);
                    view.setUint32(esp + 4, savedEax, true);
                    cpu.reg32[5] = (walkHead + 16) | 0;
                    view.setUint32(esp + 12, handlerAddr, true);
                    view.setInt32(walkHead + 12, previousTryLevel, true);
                    view.setUint32(tebAddr, walkHead, true);
                    return true;
                } else if (filterResult === -1) {
                    Logger.warn(LogCategory.SYSTEM,
                        `SEH dispatch (fast): ACCESS_VIOLATION at 0x${faultAddr.toString(16)} ` +
                        `- filter says CONTINUE_EXECUTION, retrying`);
                    view.setUint32(esp, savedEdx, true);
                    view.setUint32(esp + 4, savedEax, true);
                    return true;
                } else if (filterResult === 0) {
                    // CONTINUE_SEARCH — try next scope level
                    level = previousTryLevel;
                    continue;
                } else {
                    // filterResult === null: can't evaluate statically > slow path
                    Logger.warn(LogCategory.SYSTEM,
                        `SEH AV: filter at 0x${filterAddr.toString(16)} too complex > slow path`);
                    needsSlowPath = true;
                    break;
                }
            }

            if (needsSlowPath) break;
            walkHead = next;
        }

        if (!needsSlowPath) {
            // All frames were handler3 with trivial filters, none caught > unhandled
            Logger.warn(LogCategory.SYSTEM,
                `SEH AV dispatch: fast path exhausted ${frameCount} frame(s), no handler caught`);
            return false;
        }

        // --- Slow path: collect ALL frames and use static dispatch stub ---
        return this._setupSehDispatchStub(
            cpu, faultAddr, faultingEip, isWrite, esp, savedEax, savedEdx, view, tebAddr, sehHead, exceptionCode
        );
    }

    /**
     * Set up the static SEH dispatch stub to call ALL handlers in the chain.
     *
     * Populates EXCEPTION_RECORD, CONTEXT, and frame list in the scratch area,
     * then redirects IRET to the static dispatch stub at sehDispatchStubAddress.
     * The stub calls each handler with the standard 4-argument protocol:
     *   CALL handler(ExceptionRecord*, EstablisherFrame, Context*, NULL)
     * Handler returns: 0=ContinueExecution, 1=ContinueSearch.
     * If handler catches > longjmp, never returns.
     */
    private _setupSehDispatchStub(
        cpu: any,
        faultAddr: number,
        faultingEip: number,
        isWrite: boolean,
        esp: number,
        savedEax: number,
        savedEdx: number,
        view: DataView,
        tebAddr: number,
        sehHead: number,
        exceptionCode: number = 0xC0000005,
    ): boolean {
        if (this.sehScratchAddr === 0) {
            Logger.error(LogCategory.SYSTEM, `SEH dispatch stub: scratch area not initialized`);
            return false;
        }
        // AV dispatch: allow depth 0→1 (for AV during CxxThrow handler), block depth >= 2
        if (this.sehDispatchStack.length >= 2) {
            Logger.error(LogCategory.SYSTEM,
                `SEH dispatch re-entry blocked (depth=${this.sehDispatchStack.length}, gen=${this.sehDispatchGeneration})`);
            this._logSehCorruptionProtocol('seh_dispatch_reentry', faultingEip, faultAddr);
            return false;
        }

        const isNested = this.sehDispatchStack.length > 0;

        // For nested dispatch, place scratch data on the game stack below the handler's ESP
        // to avoid overwriting the outer dispatch's scratch area.
        // For the first dispatch, use the shared scratch area.
        const preFaultEsp = (esp + 24) >>> 0;
        const scratchAddr = isNested
            ? ((preFaultEsp - 0x800) & ~0xF) >>> 0   // game stack, 16-byte aligned
            : this.sehScratchAddr;

        if (isNested) {
            Logger.warn(LogCategory.SYSTEM,
                `SEH AV dispatch: NESTED (depth=${this.sehDispatchStack.length}), ` +
                `scratch on game stack at 0x${scratchAddr.toString(16)}`);
        }

        const regs = cpu.reg32;

        // --- Build EXCEPTION_RECORD ---
        // AVs carry 2 ExceptionInformation params (read/write flag + address);
        // other statuses (e.g. STATUS_ILLEGAL_INSTRUCTION) carry none.
        const numParams = exceptionCode === 0xC0000005 ? 2 : 0;
        view.setUint32(scratchAddr + SEH_SCRATCH_LAYOUT.EXCEPTION_RECORD + 0, exceptionCode, true);
        view.setUint32(scratchAddr + SEH_SCRATCH_LAYOUT.EXCEPTION_RECORD + 4, 0, true);
        view.setUint32(scratchAddr + SEH_SCRATCH_LAYOUT.EXCEPTION_RECORD + 8, 0, true);
        view.setUint32(scratchAddr + SEH_SCRATCH_LAYOUT.EXCEPTION_RECORD + 12, faultingEip, true);
        view.setUint32(scratchAddr + SEH_SCRATCH_LAYOUT.EXCEPTION_RECORD + 16, numParams, true);
        view.setUint32(scratchAddr + SEH_SCRATCH_LAYOUT.EXCEPTION_RECORD + 20, numParams ? (isWrite ? 1 : 0) : 0, true);
        view.setUint32(scratchAddr + SEH_SCRATCH_LAYOUT.EXCEPTION_RECORD + 24, numParams ? faultAddr : 0, true);

        // --- Build minimal CONTEXT ---
        const ctxBase = scratchAddr + SEH_SCRATCH_LAYOUT.CONTEXT;
        for (let i = 0; i < 716; i += 4) {
            view.setUint32(ctxBase + i, 0, true);
        }
        view.setUint32(ctxBase + 0, 0x10007, true);           // ContextFlags
        view.setUint32(ctxBase + 0x9C, regs[7], true);        // EDI
        view.setUint32(ctxBase + 0xA0, regs[6], true);        // ESI
        view.setUint32(ctxBase + 0xA4, regs[3], true);        // EBX
        view.setUint32(ctxBase + 0xA8, savedEdx, true);       // EDX
        view.setUint32(ctxBase + 0xAC, regs[1], true);        // ECX
        view.setUint32(ctxBase + 0xB0, savedEax, true);       // EAX
        view.setUint32(ctxBase + 0xB4, regs[5], true);        // EBP
        view.setUint32(ctxBase + 0xB8, faultingEip, true);    // EIP
        view.setUint32(ctxBase + 0xC4, preFaultEsp, true);    // ESP

        // --- Build EXCEPTION_POINTERS ---
        const epPtr = scratchAddr + SEH_SCRATCH_LAYOUT.EXCEPTION_POINTERS;
        view.setUint32(epPtr, scratchAddr, true);              // ExceptionRecord*
        view.setUint32(epPtr + 4, ctxBase, true);              // Context*

        // --- Store faulting EIP and dispatch ESP ---
        // Use the GAME's stack for dispatch (512 bytes below fault point), not the safe
        // THUNK_DATA stack. On real Windows, SEH dispatch runs on the faulting thread's stack.
        view.setUint32(scratchAddr + SEH_SCRATCH_LAYOUT.FAULT_EIP, faultingEip, true);
        const dispatchEsp = (preFaultEsp - 0x200) >>> 0;
        view.setUint32(scratchAddr + SEH_SCRATCH_LAYOUT.SAFE_ESP, dispatchEsp, true);
        view.setUint32(scratchAddr + SEH_SCRATCH_LAYOUT.DISPATCH_RESULT, 1, true);
        view.setUint32(scratchAddr + SEH_SCRATCH_LAYOUT.LAST_HANDLER_RESULT, 0, true);
        view.setUint32(scratchAddr + SEH_SCRATCH_LAYOUT.LAST_HANDLER_FRAME, 0, true);
        view.setUint32(scratchAddr + SEH_SCRATCH_LAYOUT.LAST_HANDLER_ADDR, 0, true);

        // --- Populate frame list ---
        let frameListOff = scratchAddr + SEH_SCRATCH_LAYOUT.FRAME_LIST;
        let walkHead = sehHead;
        let frameCount = 0;

        const visitedAvFrames = new Set<number>();
        while (walkHead !== 0xFFFFFFFF && walkHead !== 0 && frameCount < SEH_FRAME_LIST_MAX) {
            if (walkHead + 8 > this.memLength) break;
            // Cycle detection: a self-referential SEH frame (next == itself) would otherwise
            // fill the frame list with one address (observed in unreal-gold: 0x1f3f4e4 after a
            // gen-1 catch). Stop at the first repeat so we don't dispatch the same handler 64×.
            if (visitedAvFrames.has(walkHead)) {
                Logger.warn(LogCategory.SYSTEM,
                    `SEH AV dispatch: SEH chain cycle at 0x${walkHead.toString(16)} after ${frameCount} frames — truncating`);
                break;
            }
            visitedAvFrames.add(walkHead);
            view.setUint32(frameListOff, walkHead, true);
            frameListOff += 4;
            frameCount++;
            walkHead = view.getUint32(walkHead, true); // next
        }
        // Sentinel
        view.setUint32(frameListOff, 0xFFFFFFFF, true);

        // --- Restore saved EAX/EDX on the interrupt stack frame ---
        view.setUint32(esp, savedEdx, true);
        view.setUint32(esp + 4, savedEax, true);

        // --- Set EDI = scratchAddr (paramBase for static stub) ---
        cpu.reg32[7] = scratchAddr | 0;

        // --- Redirect IRET to static dispatch stub ---
        view.setUint32(esp + 12, this.sehDispatchStubAddress, true);

        // --- Push dispatch context ---
        this.sehDispatchGeneration = (this.sehDispatchGeneration + 1) >>> 0;
        const dispatchCtx: SehDispatchContext = {
            generation: this.sehDispatchGeneration,
            startEsp: dispatchEsp,
            scratchAddr,
            lastFaultSignature: {
                faultEip: faultingEip >>> 0,
                faultAddr: faultAddr >>> 0,
                generation: this.sehDispatchGeneration,
            },
            kind: 'av',
        };
        this.sehDispatchStack.push(dispatchCtx);
        this._enterSehCriticalRuntime(this.sehDispatchGeneration);

        Logger.warn(LogCategory.SYSTEM,
            `SEH dispatch: static stub at 0x${this.sehDispatchStubAddress.toString(16)}, ` +
            `${frameCount} frame(s), dispatchEsp=0x${dispatchEsp.toString(16)} ` +
            `faultEIP=0x${faultingEip.toString(16)} gen=${this.sehDispatchGeneration} depth=${this.sehDispatchStack.length}`);
        // Same reason as the fast path: a guest that swallows its own AV exits looking clean,
        // so the exit trace must be able to name the fault it descended from.
        faultRecorder.annotateLast(`dispatched to ${frameCount} guest SEH frame(s)`);

        // Log frame list
        let listAddr = scratchAddr + SEH_SCRATCH_LAYOUT.FRAME_LIST;
        for (let i = 0; i < frameCount; i++) {
            const frameAddr = view.getUint32(listAddr, true);
            const handler = view.getUint32(frameAddr + 4, true);
            Logger.log(LogCategory.SYSTEM,
                `  frame[${i}]: addr=0x${frameAddr.toString(16)} handler=0x${handler.toString(16)}`);
            listAddr += 4;
        }

        this.captureSehRuntimeDump('seh-dispatch-start', {
            faultAddr,
            faultEip: faultingEip,
            sehHead,
            frameList: this._collectSehFramesFromScratch(view),
        });

        return true;
    }

    /**
     * Set up x86 SEH dispatch for a C++ exception (0xe06d7363) from thunk context.
     * Called when JS-side dispatchCxxException fails to parse handler FuncInfo.
     * Falls back to calling real x86 handlers via the static dispatch stub.
     *
     * Returns ThunkResult with skipStackCheck=true to redirect execution,
     * or null if setup fails.
     */
    public setupCxxExceptionX86Dispatch(
        cpu: any,
        mem: Uint8Array,
        thunkEsp: number,
        exceptionCode: number,
        exceptionFlags: number,
        nArgs: number,
        lpArguments: number,
        thunkCleanupBytes: number,
    ): ThunkResult | null {
        if (this.sehScratchAddr === 0) {
            Logger.error(LogCategory.SYSTEM, `CxxException x86 dispatch: scratch area not initialized`);
            return null;
        }
        // Allow nested CxxException dispatch (e.g., AV handler throws C++ exception).
        // Block at depth >= 4 to prevent infinite recursion.
        const isNested = this.sehDispatchStack.length > 0;
        if (this.sehDispatchStack.length >= 4) {
            Logger.error(LogCategory.SYSTEM,
                `CxxException x86 dispatch: max nesting depth reached (depth=${this.sehDispatchStack.length})`);
            return null;
        }
        if (!this.sehDispatchStubAddress) {
            Logger.error(LogCategory.SYSTEM, `CxxException x86 dispatch: no dispatch stub`);
            return null;
        }

        if (isNested) {
            Logger.warn(LogCategory.SYSTEM,
                `CxxException x86 dispatch: NESTED (depth=${this.sehDispatchStack.length})`);
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const regs = cpu.reg32;
        const tebAddr = cpu.segment_offsets?.[4] ?? 0;
        if (tebAddr === 0) {
            Logger.error(LogCategory.SYSTEM, `CxxException x86 dispatch: no TEB`);
            return null;
        }

        const sehHead = view.getUint32(tebAddr, true);

        // Place the per-dispatch block (EXCEPTION_RECORD/CONTEXT/frame list/stub state)
        // on the game stack just below the raise site — mirroring where RtlRaiseException
        // keeps the record on real Windows. A fixed scratch address ALIASES records
        // across dispatches: guest CRT state (ptd->_curexception set on catch entry)
        // keeps pointing at the old record, and a `throw;` inside that catch builds its
        // new record over it — native FindHandler then reads pThrowInfo==NULL from both
        // and terminates ("rethrow with no active exception"). Distinct stack depths per
        // throw keep every live record unique.
        let scratchAddr = ((thunkEsp - 0x800) & ~0xF) >>> 0;   // game stack, 16-byte aligned
        if (scratchAddr < 0x10000) {
            scratchAddr = this.sehScratchAddr;
        }

        // --- Build EXCEPTION_RECORD for C++ exception ---
        const eip = (cpu.instruction_pointer?.[0] ?? 0) >>> 0;
        const excRec = scratchAddr + SEH_SCRATCH_LAYOUT.EXCEPTION_RECORD;
        view.setUint32(excRec + 0, exceptionCode, true);    // ExceptionCode = 0xe06d7363
        view.setUint32(excRec + 4, exceptionFlags, true);   // ExceptionFlags (NONCONTINUABLE=1)
        view.setUint32(excRec + 8, 0, true);                // ExceptionRecord* (chained)
        view.setUint32(excRec + 12, eip, true);              // ExceptionAddress = EIP
        view.setUint32(excRec + 16, nArgs, true);            // NumberParameters
        // Copy ExceptionInformation from lpArguments
        for (let i = 0; i < Math.min(nArgs, 4); i++) {
            const param = lpArguments ? view.getUint32(lpArguments + i * 4, true) : 0;
            view.setUint32(excRec + 20 + i * 4, param, true);
        }

        // --- Build CONTEXT ---
        const ctxBase = scratchAddr + SEH_SCRATCH_LAYOUT.CONTEXT;
        for (let i = 0; i < 716; i += 4) {
            view.setUint32(ctxBase + i, 0, true);
        }
        view.setUint32(ctxBase + 0, 0x10007, true);           // ContextFlags
        view.setUint32(ctxBase + 0x9C, regs[7], true);        // EDI
        view.setUint32(ctxBase + 0xA0, regs[6], true);        // ESI
        view.setUint32(ctxBase + 0xA4, regs[3], true);        // EBX
        view.setUint32(ctxBase + 0xA8, regs[2], true);        // EDX
        view.setUint32(ctxBase + 0xAC, regs[1], true);        // ECX
        view.setUint32(ctxBase + 0xB0, regs[0], true);        // EAX
        view.setUint32(ctxBase + 0xB4, regs[5], true);        // EBP
        view.setUint32(ctxBase + 0xB8, eip, true);              // EIP
        view.setUint32(ctxBase + 0xC4, thunkEsp, true);       // ESP

        // --- Build EXCEPTION_POINTERS ---
        const epPtr = scratchAddr + SEH_SCRATCH_LAYOUT.EXCEPTION_POINTERS;
        view.setUint32(epPtr, excRec, true);              // ExceptionRecord*
        view.setUint32(epPtr + 4, ctxBase, true);         // Context*

        // --- Store metadata ---
        // Dispatch runs on the game stack BELOW the per-dispatch block, so handler /
        // catch-funclet execution can never grow down into the live EXCEPTION_RECORD.
        view.setUint32(scratchAddr + SEH_SCRATCH_LAYOUT.FAULT_EIP, eip, true);
        const dispatchEsp = (scratchAddr < thunkEsp ? (scratchAddr - 0x10) : (thunkEsp - 0x200)) >>> 0;
        view.setUint32(scratchAddr + SEH_SCRATCH_LAYOUT.SAFE_ESP, dispatchEsp, true);
        view.setUint32(scratchAddr + SEH_SCRATCH_LAYOUT.DISPATCH_RESULT, 1, true);
        view.setUint32(scratchAddr + SEH_SCRATCH_LAYOUT.LAST_HANDLER_RESULT, 0, true);
        view.setUint32(scratchAddr + SEH_SCRATCH_LAYOUT.LAST_HANDLER_FRAME, 0, true);
        view.setUint32(scratchAddr + SEH_SCRATCH_LAYOUT.LAST_HANDLER_ADDR, 0, true);

        // --- Populate frame list ---
        let frameListOff = scratchAddr + SEH_SCRATCH_LAYOUT.FRAME_LIST;
        let walkHead = sehHead;
        let frameCount = 0;

        const visitedFrames = new Set<number>();
        while (walkHead !== 0xFFFFFFFF && walkHead !== 0 && frameCount < SEH_FRAME_LIST_MAX) {
            if (walkHead + 8 > this.memLength) break;
            // Cycle detection: a self-referential or looping SEH chain (corruption, or a
            // `mov fs:[0],esp` that re-points a frame at itself) would otherwise spin the
            // frame list full of one address. Stop the walk at the first repeat.
            if (visitedFrames.has(walkHead)) {
                Logger.warn(LogCategory.SYSTEM,
                    `CxxException x86 dispatch: SEH chain cycle at 0x${walkHead.toString(16)} after ${frameCount} frames — truncating`);
                break;
            }
            visitedFrames.add(walkHead);
            view.setUint32(frameListOff, walkHead, true);
            frameListOff += 4;
            frameCount++;
            walkHead = view.getUint32(walkHead, true);
        }
        view.setUint32(frameListOff, 0xFFFFFFFF, true);

        if (frameCount === 0) {
            Logger.error(LogCategory.SYSTEM, `CxxException x86 dispatch: empty SEH chain`);
            return null;
        }

        // --- Set up CPU to jump to dispatch stub ---
        cpu.reg32[7] = scratchAddr | 0;  // EDI = paramBase

        // Overwrite [ESP] with dispatch stub address so RET N lands there.
        view.setUint32(thunkEsp, this.sehDispatchStubAddress, true);

        // --- Push dispatch context ---
        this.sehDispatchGeneration = (this.sehDispatchGeneration + 1) >>> 0;
        const dispatchCtx: SehDispatchContext = {
            generation: this.sehDispatchGeneration,
            startEsp: dispatchEsp,
            scratchAddr,
            lastFaultSignature: null,
            kind: 'cxx',
        };
        this.sehDispatchStack.push(dispatchCtx);
        this._enterSehCriticalRuntime(this.sehDispatchGeneration);

        Logger.warn(LogCategory.SYSTEM,
            `CxxException x86 dispatch: stub at 0x${this.sehDispatchStubAddress.toString(16)}, ` +
            `${frameCount} frame(s), gen=${this.sehDispatchGeneration} depth=${this.sehDispatchStack.length}`);

        return {
            value: 0,
            skipStackCheck: true,
        };
    }

    /**
     * Try to evaluate an SEH filter function statically by reading its bytes.
     * Returns 1 (EXECUTE_HANDLER), 0 (CONTINUE_SEARCH), -1 (CONTINUE_EXECUTION),
     * or null if the filter is too complex to evaluate statically.
     *
     * Only handles trivial catch-all patterns. Complex filters (those that call
     * helper functions, dereference EXCEPTION_POINTERS, etc.) return null and
     * are handled by the SEH dispatch trampoline which runs them as native x86.
     */
    private _evaluateSimpleFilter(mem: Uint8Array, filterAddr: number, exceptionCode: number): number | null {
        if (filterAddr + 6 > this.memLength) return null;

        // Pattern 1: MOV EAX, imm32; RET = B8 xx xx xx xx C3
        if (mem[filterAddr] === 0xB8 && mem[filterAddr + 5] === 0xC3) {
            const imm = mem[filterAddr + 1] | (mem[filterAddr + 2] << 8) |
                        (mem[filterAddr + 3] << 16) | (mem[filterAddr + 4] << 24);
            if (imm === 1) return 1;   // EXCEPTION_EXECUTE_HANDLER
            if (imm === -1) return -1; // EXCEPTION_CONTINUE_EXECUTION
            if (imm === 0) return 0;   // EXCEPTION_CONTINUE_SEARCH
            return null;
        }

        // Pattern 2: XOR EAX, EAX; RET = 33 C0 C3
        if (mem[filterAddr] === 0x33 && mem[filterAddr + 1] === 0xC0 && mem[filterAddr + 2] === 0xC3) {
            return 0; // EXCEPTION_CONTINUE_SEARCH
        }

        // Pattern 3: GetExceptionCode() comparison — common __except filter pattern.
        // __except_handler3 stores EXCEPTION_POINTERS* at [EBP-0x14] before calling filter.
        // Filter dereferences it to get ExceptionCode and compares:
        //   8B 45 EC          MOV EAX, [EBP-14h]     (EXCEPTION_POINTERS*)
        //   8B 00             MOV EAX, [EAX]          (EXCEPTION_RECORD*)
        //   8B 00             MOV EAX, [EAX]          (ExceptionCode)
        //   3D xx xx xx xx    CMP EAX, imm32          (e.g., 0xC0000005)
        //   0F 94 C0          SETE AL
        //   0F B6 C0          MOVZX EAX, AL
        //   C3                RET
        // Total: 19 bytes. Returns 1 if code matches, 0 otherwise.
        if (filterAddr + 19 <= this.memLength &&
            mem[filterAddr]     === 0x8B && mem[filterAddr + 1]  === 0x45 && mem[filterAddr + 2]  === 0xEC &&  // MOV EAX,[EBP-14h]
            mem[filterAddr + 3] === 0x8B && mem[filterAddr + 4]  === 0x00 &&                                   // MOV EAX,[EAX]
            mem[filterAddr + 5] === 0x8B && mem[filterAddr + 6]  === 0x00 &&                                   // MOV EAX,[EAX]
            mem[filterAddr + 7] === 0x3D &&                                                                    // CMP EAX, imm32
            mem[filterAddr + 12] === 0x0F && mem[filterAddr + 13] === 0x94 && mem[filterAddr + 14] === 0xC0 && // SETE AL
            mem[filterAddr + 15] === 0x0F && mem[filterAddr + 16] === 0xB6 && mem[filterAddr + 17] === 0xC0 && // MOVZX EAX, AL
            mem[filterAddr + 18] === 0xC3) {                                                                    // RET
            const cmpImm = (mem[filterAddr + 8] | (mem[filterAddr + 9] << 8) |
                           (mem[filterAddr + 10] << 16) | (mem[filterAddr + 11] << 24)) >>> 0;
            return (exceptionCode >>> 0) === cmpImm ? 1 : 0;
        }

        // Pattern 4: VC6-style "_XcptFilter(GetExceptionCode(), GetExceptionInformation())"
        // Common shape:
        //   MOV EAX,[EBP-14h]      ; EXCEPTION_POINTERS*
        //   MOV ECX,[EAX]          ; EXCEPTION_RECORD*
        //   MOV ECX,[ECX]          ; ExceptionCode
        //   ... (optional spills)
        //   PUSH EAX               ; EXCEPTION_POINTERS*
        //   PUSH ECX               ; ExceptionCode
        //   CALL rel32             ; _XcptFilter-like helper
        //   POP ECX
        //   POP ECX
        //   RET
        //
        // Keep this matcher tolerant to optional 1-2 instructions between the
        // code load and PUSH/PUSH sequence (seen in VC6 builds).
        if (filterAddr + 17 <= this.memLength &&
            mem[filterAddr] === 0x8B && mem[filterAddr + 1] === 0x45 && mem[filterAddr + 2] === 0xEC &&
            mem[filterAddr + 3] === 0x8B && mem[filterAddr + 4] === 0x08 &&
            mem[filterAddr + 5] === 0x8B && mem[filterAddr + 6] === 0x09) {
            const searchLimit = Math.min(filterAddr + 40, this.memLength - 10);
            for (let p = filterAddr + 7; p <= searchLimit; p++) {
                if (mem[p] === 0x50 && mem[p + 1] === 0x51 &&
                    mem[p + 2] === 0xE8 &&
                    mem[p + 7] === 0x59 && mem[p + 8] === 0x59 &&
                    mem[p + 9] === 0xC3) {
                    const code = exceptionCode >>> 0;
                    if (code === 0x80000003 || code === 0x80000004) return -1;
                    if (((code & 0xC0000000) >>> 0) === 0xC0000000) return 1;
                    return 0;
                }
            }
        }

        return null; // Too complex — trampoline will handle it
    }

    private _handleRecoverableDivisionError(cpu: any): void {
        const mem = this.cachedMem8;
        if (!mem || !this.isDataViewValid()) {
            Logger.error(LogCategory.SYSTEM, `#DE: Cannot recover - memory not available`);
            return;
        }

        const esp = cpu.reg32[4] >>> 0;
        const view = this.cachedDataView!;

        if (esp + 12 > this.memLength) {
            Logger.error(LogCategory.SYSTEM, `#DE: Cannot recover - ESP=0x${esp.toString(16)} out of range`);
            return;
        }

        const faultingEip = view.getUint32(esp, true) >>> 0;

        // Parse the faulting DIV/IDIV instruction to determine its length
        const instrLen = this._getDivInstructionLength(mem, faultingEip);
        if (instrLen < 0) {
            Logger.error(LogCategory.SYSTEM,
                `#DE: Cannot parse instruction at 0x${faultingEip.toString(16)}, falling back to fatal`);
            this._dumpExceptionContext(0x0000, cpu);
            return;
        }

        const newEip = (faultingEip + instrLen) >>> 0;

        // Advance EIP on the interrupt frame so IRET resumes past the faulting instruction
        view.setUint32(esp, newEip, true);

        // Set EAX=0 (quotient), EDX=0 (remainder) � safe "result" for division by zero
        cpu.reg32[0] = 0;
        cpu.reg32[2] = 0;

        // Log with module info
        const moduleRegistry = System.getInstance().process?.moduleRegistry;
        let modInfo = '';
        if (moduleRegistry) {
            const mod = moduleRegistry.getModuleContainingAddress(faultingEip);
            if (mod) {
                modInfo = ` (${mod.name}+0x${(faultingEip - mod.baseAddress).toString(16)})`;
            }
        }

        // Dump 16 bytes of instruction context around the faulting address
        let instrContext = '';
        const contextStart = Math.max(0, faultingEip - 4);
        const contextEnd = Math.min(this.memLength, faultingEip + 12);
        if (contextEnd > contextStart) {
            const ctxBytes: string[] = [];
            for (let i = contextStart; i < contextEnd; i++) {
                // Mark the faulting instruction start with brackets
                if (i === faultingEip) ctxBytes.push('[');
                ctxBytes.push(mem[i].toString(16).padStart(2, '0'));
                if (i === faultingEip + instrLen - 1) ctxBytes.push(']');
            }
            instrContext = ` ctx@0x${contextStart.toString(16)}: ${ctxBytes.join(' ')}`;
        }

        // Full register dump
        const regDump =
            `EAX=0x${(cpu.reg32[0] >>> 0).toString(16).padStart(8, '0')} ` +
            `ECX=0x${(cpu.reg32[1] >>> 0).toString(16).padStart(8, '0')} ` +
            `EDX=0x${(cpu.reg32[2] >>> 0).toString(16).padStart(8, '0')} ` +
            `EBX=0x${(cpu.reg32[3] >>> 0).toString(16).padStart(8, '0')}\n` +
            `  ESP=0x${(cpu.reg32[4] >>> 0).toString(16).padStart(8, '0')} ` +
            `EBP=0x${(cpu.reg32[5] >>> 0).toString(16).padStart(8, '0')} ` +
            `ESI=0x${(cpu.reg32[6] >>> 0).toString(16).padStart(8, '0')} ` +
            `EDI=0x${(cpu.reg32[7] >>> 0).toString(16).padStart(8, '0')}`;

        // Diagnostic: when the divisor is a memory operand [base+disp], dump the
        // containing struct + a guest backtrace. Distinguishes "descriptor page
        // zeroed / never initialised" (all-zero) from "one bad field". Reusable.
        let divDiag = '';
        const opnd = this._decodeDivMemOperand(mem, faultingEip);
        if (opnd && cpu.reg32) {
            const base = cpu.reg32[opnd.regIdx] >>> 0;
            const structAddr = (base + opnd.disp) >>> 0; // start of the divisor's struct (disp folds the field off)
            const dumpFrom = base >>> 0;
            if (dumpFrom + 0x40 <= this.memLength) {
                const words: string[] = [];
                for (let i = 0; i < 0x40; i += 4) {
                    words.push(`+${i.toString(16).padStart(2, '0')}=0x${(view.getUint32(dumpFrom + i, true) >>> 0).toString(16).padStart(8, '0')}`);
                }
                divDiag = `\n  divisor base=${opnd.name}=0x${base.toString(16)} disp=0x${opnd.disp.toString(16)} (operand@0x${structAddr.toString(16)})\n` +
                    `  struct[${opnd.name}]: ${words.join(' ')}`;
            }
        }
        // Classify the divisor base address: which AddressSpace region/kind/owner owns
        // it (HEAP vs MODULES vs a VirtualAlloc/mmap region), to tell "heap block" from
        // "VirtualAlloc/mmap overlap". Also classify the struct's +0 'next' pointer.
        let regDiag = '';
        try {
            const proc: any = System.getInstance().process;
            const as: any = proc?.addressSpace ?? proc?.memory?.addressSpace;
            const describe = (a: number): string => {
                const r = as?.getRegion?.(a >>> 0);
                if (!r) return `0x${(a >>> 0).toString(16)}:<no-region>`;
                return `0x${(a >>> 0).toString(16)}:${r.kind}${r.owner ? '/' + r.owner : ''}${r.tag ? '(' + r.tag + ')' : ''}@0x${r.base.toString(16)}+0x${r.size.toString(16)}`;
            };
            if (opnd && cpu.reg32) {
                const base = cpu.reg32[opnd.regIdx] >>> 0;
                const nextPtr = (this.cachedDataView && base + 4 <= this.memLength) ? (view.getUint32(base, true) >>> 0) : 0;
                regDiag = `\n  region[base]=${describe(base)}\n  region[+0 next=0x${nextPtr.toString(16)}]=${describe(nextPtr)}`;
            }
        } catch { /* best-effort */ }
        // Slab free-list health at fault time. A cycle / self-pointer / bad-header /
        // out-of-bounds entry is the signature of a double-free or a cross-thread
        // free-list race (same block handed out twice → MPQ handle aliases the Fog
        // descriptor). ok=true means the slab list is clean → corruption is elsewhere.
        let slabDiag = '';
        try {
            const audit = (globalThis as any).slabFreelistAudit?.();
            if (audit) slabDiag = `\n  slabFreelist: ok=${audit.ok} corruptBins=[${(audit.corruptBins || []).join(',')}]`;
            const classify = (globalThis as any).classifyHeapPtr;
            if (classify && opnd && cpu.reg32) {
                const base = cpu.reg32[opnd.regIdx] >>> 0;
                // EDI/ECX are the usual param_2 / region-base regs at these two sites.
                const edi = cpu.reg32[7] >>> 0, ecx = cpu.reg32[1] >>> 0;
                slabDiag += `\n  classify[descriptor ${opnd.name}]=${JSON.stringify(classify(base))}` +
                    `\n  classify[EDI=0x${edi.toString(16)}]=${JSON.stringify(classify(edi))}` +
                    `\n  classify[ECX=0x${ecx.toString(16)}]=${JSON.stringify(classify(ecx))}`;
            }
        } catch { /* best-effort */ }
        // Large-alloc lifecycle history of the divisor's base address (the Fog
        // descriptor pointer). The alloc/free SEQUENCE + per-event caller module is
        // decisive: alloc→free→alloc(by a different module) = UAF-reuse; alloc→alloc
        // with no intervening free = double-hand-out; a single allocator only = the
        // Fog table field was stomped (corruption). Pulls from the long ≥64KB ring
        // that survives the whole session (process.ts), unlike the generic event ring.
        let histDiag = '';
        try {
            const hist = (globalThis as any).largeAllocHistory;
            if (hist && opnd && cpu.reg32) {
                const base = cpu.reg32[opnd.regIdx] >>> 0;
                const h = hist(base, 0x20000);
                if (h && h.length) {
                    histDiag = `\n  largeAllocHistory[0x${base.toString(16)} ±0x20000] (${h.length} events, last 14):` +
                        h.slice(-14).map((e: any) =>
                            `\n    ${e.t} ${e.op.padEnd(5)} ${e.addr} sz=${e.size}${e.overlaps ? ' *' : ''}  ${e.bt}`).join('');
                } else {
                    histDiag = `\n  largeAllocHistory[0x${base.toString(16)}]: (no ≥64KB events in range)`;
                }
            }
        } catch { /* best-effort */ }

        let btDiag = '';
        try {
            const bt = this.getGuestCallStack(undefined, 0x400, 8);
            btDiag = `\n  bt: ${bt.frames.slice(0, 8).map(f => f.moduleName ? `${f.moduleName}+0x${f.moduleOffset.toString(16)}` : `0x${f.retAddr.toString(16)}`).join(' <- ')}`;
        } catch { /* best-effort */ }

        Logger.warn(LogCategory.SYSTEM,
            `#DE (Division Error) at 0x${faultingEip.toString(16)}${modInfo}${instrContext}\n` +
            `  ${regDump}\n` +
            `  Skipping ${instrLen}-byte instruction, EAX=EDX=0, resuming at 0x${newEip.toString(16)}` +
            divDiag + regDiag + slabDiag + histDiag + btDiag);
    }

    /**
     * Decode the memory operand of a DIV/IDIV (F6/F7 /6|/7) into its base GP
     * register index + displacement, for diagnostic struct dumps. Returns null
     * for register operands (mod=3), SIB-indexed, or unparseable forms — the
     * common game cases ([reg+disp8]/[reg+disp32]) are what we care about.
     */
    private _decodeDivMemOperand(mem: Uint8Array, eip: number): { regIdx: number; name: string; disp: number } | null {
        if (eip + 16 > this.memLength) return null;
        let offset = 0;
        while (offset < 8) {
            const b = mem[eip + offset];
            if (b === 0x66 || b === 0x67 || b === 0xF0 || b === 0xF2 || b === 0xF3 ||
                b === 0x26 || b === 0x2E || b === 0x36 || b === 0x3E || b === 0x64 || b === 0x65) { offset++; } else { break; }
        }
        const opcode = mem[eip + offset]; offset++;
        if (opcode !== 0xF6 && opcode !== 0xF7) return null;
        const modrm = mem[eip + offset]; offset++;
        const mod = (modrm >> 6) & 3;
        const rm = modrm & 7;
        if (mod === 3 || rm === 4) return null; // register operand or SIB — skip
        if (mod === 0 && rm === 5) return null; // [disp32], no base reg
        let disp = 0;
        if (mod === 1) { disp = (mem[eip + offset] << 24) >> 24; } // sign-extend disp8
        else if (mod === 2) { disp = (mem[eip + offset] | mem[eip + offset + 1] << 8 | mem[eip + offset + 2] << 16 | mem[eip + offset + 3] << 24); }
        const names = ['EAX', 'ECX', 'EDX', 'EBX', 'ESP', 'EBP', 'ESI', 'EDI'];
        return { regIdx: rm, name: names[rm], disp };
    }

    /**
     * Parse the length of a DIV/IDIV instruction at the given address.
     * Handles: F6 /6 (DIV r/m8), F6 /7 (IDIV r/m8),
     *          F7 /6 (DIV r/m32), F7 /7 (IDIV r/m32), D4 ib (AAM).
     * Returns -1 if the instruction cannot be parsed.
     */
    private _getDivInstructionLength(mem: Uint8Array, eip: number): number {
        if (eip + 16 > this.memLength) return -1;

        let offset = 0;

        // Skip instruction prefixes
        while (offset < 8) {
            const b = mem[eip + offset];
            if (b === 0x66 || b === 0x67 || b === 0xF0 || b === 0xF2 || b === 0xF3 ||
                b === 0x26 || b === 0x2E || b === 0x36 || b === 0x3E || b === 0x64 || b === 0x65) {
                offset++;
            } else {
                break;
            }
        }

        const opcode = mem[eip + offset];
        offset++; // past opcode

        // AAM imm8 (D4 ib) � can cause #DE if imm8 = 0
        if (opcode === 0xD4) {
            return offset + 1;
        }

        // DIV/IDIV: F6 (byte) or F7 (dword)
        if (opcode !== 0xF6 && opcode !== 0xF7) {
            return -1;
        }

        // Parse ModR/M byte
        const modrm = mem[eip + offset];
        offset++; // past ModR/M

        const mod = (modrm >> 6) & 3;
        const rm = modrm & 7;

        // mod=11: register operand, no displacement
        if (mod === 3) {
            return offset;
        }

        // SIB byte if rm=4
        let sibBase = 0;
        if (rm === 4) {
            sibBase = mem[eip + offset] & 7;
            offset++; // past SIB
        }

        // Displacement
        if (mod === 0) {
            // Special cases: rm=5 > disp32, SIB with base=5 > disp32
            if (rm === 5 || (rm === 4 && sibBase === 5)) {
                offset += 4;
            }
        } else if (mod === 1) {
            offset += 1; // disp8
        } else {
            offset += 4; // disp32
        }

        return offset;
    }

    private _slowPathHandleInvalidId(functionId: number, cpu: any): void {
        // Detailed error logging, stack dumping, backtracking logic
        // This is where you put all the heavy "Error: Thunk ID 0" logic
        const eip = cpu?.instruction_pointer?.[0] ?? 0;
        const esp = cpu?.reg32?.[4] ?? 0;
        const eax = cpu?.reg32?.[0] ?? 0;

        Logger.error(LogCategory.THUNK,
            `Invalid thunk ID ${functionId} detected! EIP=0x${eip.toString(16)}, EAX=0x${eax.toString(16)}, ESP=0x${esp.toString(16)}`);

        // Dump context for debugging
        const mem8 = this.cachedMem8;
        if (mem8 && esp > 0 && esp < mem8.length - 16) {
            // Ensure DataView is valid - use safe check through cachedMem8
            if (this.isDataViewValid()) {
                const view = this.cachedDataView!;
                const stackValues = [];
                for (let i = 0; i < 8; i++) {
                    const addr = esp + i * 4;
                    if (addr + 4 <= mem8.length) {
                        stackValues.push(`[ESP+${i * 4}]=0x${view.getUint32(addr, true).toString(16)}`);
                    }
                }
                Logger.error(LogCategory.THUNK, `Stack at ID ${functionId} error: ${stackValues.join(' ')}`);
            }
        }

        // Try to recover: check if we're in a callback return stub
        if (this._callbackManager && this.thunkMemoryManager) {
            const mem8 = this.cachedMem8;
            if (mem8 && eip > 0) {
                // Check if EIP points to POP EAX in a return stub (0x58 at offset 12)
                // Get stub base from ThunkMemoryManager
                const regions = this.thunkMemoryManager.getRegions();
                const stubBase = regions.callbackStubPoolBase;
                const stubEnd = stubBase + regions.callbackStubPoolSize;
                if (eip >= stubBase && eip < stubEnd) {
                    const offset = eip - stubBase;
                    if (offset % 32 === 12 && mem8[eip] === 0x58) {
                        // We're in a return stub, just continue execution
                        Logger.verbose(LogCategory.THUNK, `Recovered: EIP points to POP EAX in return stub`);
                        return;
                    }
                }
            }
        }

        // Enhanced logging for missing thunk
        if (functionId !== 0) {
            const stub = this.thunkGenerator.getStubById(functionId);
            if (!stub) {
                const mem8 = this.cachedMem8;
                const eip = cpu?.instruction_pointer?.[0] ?? 0;

                if (mem8 && eip > 0) {
                    for (let back = 0; back < 16; back++) {
                        const p = eip - back;
                        if (p < 0) break;

                        if (mem8[p] === 0xB8 &&
                            mem8[p + 5] === 0xBA && mem8[p + 6] === 0x77 &&
                            mem8[p + 7] === 0xB0 && mem8[p + 8] === 0x00 &&
                            mem8[p + 9] === 0x00 && mem8[p + 10] === 0xEF) {

                            // Ensure DataView is valid - use safe check through cachedMem8
                            if (this.isDataViewValid()) {
                                const view = this.cachedDataView!;
                                const recoveredId = view.getUint32(p + 1, true);
                                Logger.verbose(LogCategory.THUNK, `Recovered ID ${recoveredId} from backtrack`);
                                return this.handlePortWrite(recoveredId);
                            }
                        }
                    }
                }

                const ebx = cpu?.reg32?.[3] ?? 0;
                const ecx = cpu?.reg32?.[1] ?? 0;
                const edx = cpu?.reg32?.[2] ?? 0;
                const esi = cpu?.reg32?.[6] ?? 0;
                const edi = cpu?.reg32?.[7] ?? 0;
                const ebp = cpu?.reg32?.[5] ?? 0;

                Logger.error(LogCategory.THUNK, `?? Thunk ID ${functionId} (0x${functionId.toString(16)}) not found! EIP=0x${eip.toString(16)} ESP=0x${esp.toString(16)}`);
                Logger.error(LogCategory.THUNK, `  > Registers: EAX=0x${eax.toString(16)} EBX=0x${ebx.toString(16)} ECX=0x${ecx.toString(16)} EDX=0x${edx.toString(16)} ESI=0x${esi.toString(16)} EDI=0x${edi.toString(16)} EBP=0x${ebp.toString(16)}`);

                // Note: Dump memory at faulting EIP to see what code is being executed
                if (mem8 && eip > 0 && eip < mem8.length - 16) {
                    const codeSlice = Array.from(mem8.slice(eip, eip + 16)) as number[];
                    Logger.error(LogCategory.THUNK, `  > Bytes at EIP 0x${eip.toString(16)}: ${codeSlice.map((b: number) => b.toString(16).padStart(2, '0')).join(' ')}`);
                }

                // Check if ESP change is massive
                const lastThunkEsp = this.activeAsyncThunks.size > 0 ? Array.from(this.activeAsyncThunks.values())[0].esp : undefined;
                if (lastThunkEsp !== undefined) {
                    const diff = (esp - lastThunkEsp) >>> 0;
                    if (diff > 0x100) {
                        Logger.error(LogCategory.THUNK, `  > MASSIVE Stack Change Detected! Prev ESP=0x${lastThunkEsp.toString(16)}, Current ESP=0x${esp.toString(16)} (Diff: +0x${diff.toString(16)})`);
                    }
                }

                // Check if this ID is close to any registered ID (might be off by one or similar)
                const allStubs = this.thunkGenerator.getAllStubs();
                const closeStubs = allStubs.filter(s => Math.abs(s.functionId - functionId) < 10);
                if (closeStubs.length > 0) {
                    Logger.error(LogCategory.THUNK, `  > Close thunk IDs found:`);
                    for (const stub of closeStubs.slice(0, 5)) {
                        Logger.error(LogCategory.THUNK, `    - ID=${stub.functionId} (0x${stub.functionId.toString(16)}) > ${stub.dllName}:${stub.functionName} (diff=${Math.abs(stub.functionId - functionId)})`);
                    }
                }
            }
        }
    }

    /**
     * Try to resolve a missing implementation by finding another stub with the same
     * (dllName, functionName) that already has an implementation registered.
     * This handles runtime-loaded DLLs (LoadLibrary) that import functions already
     * thunked for the main EXE � their new stubs get different functionIds but
     * should share the same JS implementation and WASM hypercall registration.
     */
    private _trySameNameLookup(functionId: number): ThunkImplementation | null {
        const stub = this.thunkGenerator.getStubById(functionId);
        if (!stub) return null;

        const dllLower = stub.dllName.toLowerCase();
        const funcName = stub.functionName;

        const allStubs = this.thunkGenerator.getAllStubs();
        for (const s of allStubs) {
            if (s.functionId === functionId) continue;
            if (s.dllName.toLowerCase() !== dllLower || s.functionName !== funcName) continue;

            const existingImpl = this.dispatchTable[s.functionId];
            if (existingImpl) {
                this.dispatchTable[functionId] = existingImpl;
                this.argCountsTable[functionId] = this.argCountsTable[s.functionId];
                if (this.stackCleanupTable[s.functionId] >= 0) {
                    this.stackCleanupTable[functionId] = this.stackCleanupTable[s.functionId];
                }
                this.namesTable[functionId] = `${stub.dllName}:${funcName}`;

                const fp = this.fastPathTable[s.functionId];
                if (fp) this.fastPathTable[functionId] = fp;
                if (this.trivialFastPathTable[s.functionId]) {
                    this.trivialFastPathTable[functionId] = 1;
                }

                hypercallDataManager.registerFunction(stub.dllName, funcName, functionId);

                Logger.info(LogCategory.THUNK,
                    `Same-name lookup: ${stub.dllName}:${funcName} id ${functionId} < id ${s.functionId}`);
                return existingImpl;
            }
        }
        return null;
    }

    /**
     * Try to resolve a missing implementation via DLL forwarding.
     * E.g. shfolder!SHGetFolderPathW > shell32!SHGetFolderPathW.
     */
    private _tryDllForward(functionId: number): ThunkImplementation | null {
        const stub = this.thunkGenerator.getStubById(functionId);
        if (!stub) return null;

        const srcDll = stub.dllName.toLowerCase();
        let targetDll = ThunkDispatcher.DLL_FORWARDS[srcDll];
        if (!targetDll && /^d3dx9d?_\d+$/i.test(srcDll)) {
            targetDll = "d3dx9";
        }
        if (!targetDll) return null;

        const funcName = stub.functionName;
        const targetFuncName =
            ThunkDispatcher.DLL_FORWARD_FUNCTIONS[srcDll]?.[funcName.toLowerCase()] ?? funcName;

        // Search existing stubs for matching (targetDll, functionName) with an implementation
        const allStubs = this.thunkGenerator.getAllStubs();
        for (const s of allStubs) {
            if (s.dllName.toLowerCase() === targetDll && s.functionName === targetFuncName) {
                const targetImpl = this.dispatchTable[s.functionId];
                if (targetImpl) {
                    // Cache so next call is fast-path
                    this.dispatchTable[functionId] = targetImpl;
                    this.argCountsTable[functionId] = this.argCountsTable[s.functionId];
                    if (this.stackCleanupTable[s.functionId] >= 0) {
                        this.stackCleanupTable[functionId] = this.stackCleanupTable[s.functionId];
                    }
                    this.namesTable[functionId] = `${stub.dllName}:${funcName}>${targetDll}`;
                    // Also copy fast-path if available
                    const targetFastPath = this.fastPathTable[s.functionId];
                    if (targetFastPath) {
                        this.fastPathTable[functionId] = targetFastPath;
                    }
                    // Register with WASM hypercall dispatch
                    hypercallDataManager.registerFunction(stub.dllName, funcName, functionId);
                    Logger.info(LogCategory.THUNK,
                        `DLL forward: ${stub.dllName}:${funcName} > ${targetDll}:${targetFuncName} (id ${s.functionId})`);
                    return targetImpl;
                }
            }
        }

        // Check pendingRegistrations
        const pendingKey = `${targetDll}:${targetFuncName}`.toLowerCase();
        const pending = this.pendingRegistrations.get(pendingKey);
        if (pending) {
            this.dispatchTable[functionId] = pending.impl;
            const targetStub = allStubs.find(s =>
                s.dllName.toLowerCase() === targetDll && s.functionName === targetFuncName
            );
            this.argCountsTable[functionId] = stub.argCount ?? targetStub?.argCount ?? -1;
            const cleanupBytes = stub.stackCleanupBytes ?? targetStub?.stackCleanupBytes;
            if (cleanupBytes !== undefined) {
                this.stackCleanupTable[functionId] = cleanupBytes;
            }
            this.namesTable[functionId] = `${stub.dllName}:${funcName}>${targetDll}:${targetFuncName}`;
            // Register with WASM hypercall dispatch
            hypercallDataManager.registerFunction(stub.dllName, funcName, functionId);
            Logger.info(LogCategory.THUNK,
                `DLL forward (pending): ${stub.dllName}:${funcName} > ${targetDll}:${targetFuncName}`);
            return pending.impl;
        }

        return null;
    }

    /**
     * Last-resort fallback: check if a pending registration matches this stub.
     * Handles DLLs loaded after applyPendingRegistrations() (e.g. via LoadLibrary).
     */
    private bindPendingImplementation(
        functionId: number,
        stub: ThunkStub,
        pending: { impl: ThunkImplementation; dllName: string; functionName: string }
    ): ThunkImplementation {
        this.dispatchTable[functionId] = pending.impl;
        this.argCountsTable[functionId] = stub.argCount ?? DEFAULT_ARGS_COUNT;
        this.stackCleanupTable[functionId] = stub.stackCleanupBytes ?? -1;
        this.namesTable[functionId] = `${pending.dllName}:${pending.functionName}`;
        hypercallDataManager.registerFunction(pending.dllName, pending.functionName, functionId);
        return pending.impl;
    }

    private applyPendingFastPathForStub(functionId: number, stub: ThunkStub): void {
        const exactKey = `${stub.dllName}:${stub.functionName}`.toLowerCase();
        const normalizedKey = `${stub.dllName}:${normalizeApiName(stub.functionName)}`.toLowerCase();
        const pending =
            this.pendingFastPathRegistrations.get(exactKey) ??
            (normalizedKey !== exactKey ? this.pendingFastPathRegistrations.get(normalizedKey) : undefined);

        if (!pending) return;

        this.fastPathTable[functionId] = pending.impl;
        if (pending.trivial) this.trivialFastPathTable[functionId] = 1;
    }

    private applyPendingWriteBufferForStub(stub: ThunkStub): void {
        const exactKey = `${stub.dllName}:${stub.functionName}`.toLowerCase();
        const normalizedKey = `${stub.dllName}:${normalizeApiName(stub.functionName)}`.toLowerCase();
        const pending =
            this.pendingWriteBufRegistrations.get(exactKey) ??
            (normalizedKey !== exactKey ? this.pendingWriteBufRegistrations.get(normalizedKey) : undefined);

        if (!pending) return;

        if (pending.ptrDeref && pending.floatCount) {
            this.registerPtrDerefWriteBufferFunction(
                pending.dllName,
                pending.functionName,
                pending.floatCount,
                pending.handler,
                pending.isStdcall
            );
            return;
        }

        if (pending.shaderConstant) {
            this.registerShaderConstantWriteBufferFunction(
                pending.dllName,
                pending.functionName,
                pending.handler,
            );
            return;
        }

        if (pending.structCapture) {
            this.registerStructCaptureWriteBufferFunction(
                pending.dllName, pending.functionName, pending.argCount,
                pending.structCapture.ptrArgIndex, pending.structCapture.payloadDwords,
                pending.handler);
            return;
        }

        if (pending.upDraw) {
            this.registerUpDrawWriteBufferFunction(pending.dllName, pending.functionName, pending.handler);
            return;
        }

        if (pending.ownerDisarm) {
            this.registerOwnerDisarmWriteBufferFunction(
                pending.dllName, pending.functionName, pending.argCount,
                pending.handler, pending.coalesceArgMask ?? 0,
                pending.barrier ? { barrier: true } : undefined);
            return;
        }

        this.registerWriteBufferFunction(
            pending.dllName,
            pending.functionName,
            pending.argCount,
            pending.handler,
            pending.isStdcall,
            pending.coalesceArgMask ?? 0,
            pending.barrier ? { barrier: true } : undefined,
        );
    }

    /**
     * Re-bind pending regular/fast-path/write-buffer registrations for one specific stub.
     * Used by on-demand stub creation paths to avoid a full applyPendingRegistrations() pass.
     */
    bindPendingRegistrationsForFunctionId(functionId: number): boolean {
        return this._tryPendingRegistration(functionId) !== null;
    }

    private _tryPendingRegistration(functionId: number): ThunkImplementation | null {
        const stub = this.thunkGenerator.getStubById(functionId);
        if (!stub) return null;

        const key = `${stub.dllName}:${stub.functionName}`.toLowerCase();
        let pending = this.pendingRegistrations.get(key);
        // Win32 macro imports: GetVersionEx vs GetVersionExA (and similar A-suffixed APIs).
        if (!pending && !/[aw]$/i.test(stub.functionName)) {
            pending = this.pendingRegistrations.get(`${stub.dllName}:${stub.functionName}A`.toLowerCase());
        }
        if (!pending && /a$/i.test(stub.functionName)) {
            pending = this.pendingRegistrations.get(`${stub.dllName}:${stub.functionName.slice(0, -1)}`.toLowerCase());
        }
        if (pending) {
            const impl = this.bindPendingImplementation(functionId, stub, pending);
            this.applyPendingFastPathForStub(functionId, stub);
            this.applyPendingWriteBufferForStub(stub);

            Logger.info(LogCategory.THUNK,
                `Late pending registration: ${stub.dllName}:${stub.functionName} id=${functionId}`);
            return impl;
        }

        // Also try normalized name lookup in pending
        const normKey = `${stub.dllName}:${normalizeApiName(stub.functionName)}`.toLowerCase();
        if (normKey !== key) {
            // Search all pending registrations for normalized match
            for (const [pKey, pVal] of this.pendingRegistrations.entries()) {
                const pNorm = `${pVal.dllName}:${normalizeApiName(pVal.functionName)}`.toLowerCase();
                if (pNorm === normKey || pKey === normKey) {
                    const impl = this.bindPendingImplementation(functionId, stub, pVal);
                    this.applyPendingFastPathForStub(functionId, stub);
                    this.applyPendingWriteBufferForStub(stub);
                    Logger.info(LogCategory.THUNK,
                        `Late pending registration (normalized): ${stub.dllName}:${stub.functionName} id=${functionId}`);
                    return impl;
                }
            }
        }

        return null;
    }

    private _slowPathMissingImplementation(functionId: number, cpu: any, name: string): void {
        const stub = this.thunkGenerator.getStubById(functionId);
        const esp = cpu.reg32[4];
        const argCount = stub?.argCount ?? this.argCountsTable[functionId] ?? 0;

        // Video codecs (Smacker, Bink) should return 0 (NULL) so game skips video
        // ERROR_NOT_SUPPORTED (50) would be interpreted as valid handle!
        const dllNameLower = stub?.dllName?.toLowerCase() || '';
        const isVideoCodec = dllNameLower.includes('smack') || dllNameLower.includes('bink');
        const returnValue = isVideoCodec ? 0 : ERROR_NOT_SUPPORTED;

        // Caller (guest return address) — the RE entry point for "who hit this stub".
        const caller = (this.cachedDataView && this.isDataViewValid() && esp < this.memLength - 4)
            ? this.cachedDataView.getUint32(esp, true) >>> 0 : 0;

        // Log with ESP and argCount for debugging stack issues
        if (stub) {
            Logger.warn(LogCategory.THUNK,
                `UNIMPLEMENTED: ${stub.dllName}:${stub.functionName} (id=0x${functionId.toString(16)}) ` +
                `ESP=0x${esp.toString(16)} argCount=${argCount} caller=0x${caller.toString(16)} -> returning ${isVideoCodec ? '0 (skip video)' : 'ERROR_NOT_SUPPORTED'}`);
            Logger.unimplemented(stub.dllName, stub.functionName);
            stubRegistry.record(stub.dllName, stub.functionName, functionId, caller);
        } else {
            Logger.warn(LogCategory.THUNK,
                `UNIMPLEMENTED: ${name} (id=0x${functionId.toString(16)}) ` +
                `ESP=0x${esp.toString(16)} caller=0x${caller.toString(16)} -> returning ${returnValue}`);
            Logger.unimplemented("DLL", name);
            // name is "module:Func" when the vtable knew it, else "unknown".
            const ci = name.indexOf(":");
            stubRegistry.record(ci > 0 ? name.slice(0, ci) : "", ci > 0 ? name.slice(ci + 1) : name, functionId, caller);
        }
        cpu.reg32[0] = returnValue;
    }

    private _slowPathHandleThunkError(id: number, name: string, e: any, cpu: any): void {
        Logger.error(LogCategory.THUNK, `Error executing thunk ${name} (ID ${id}): ${e}`);
        cpu.reg32[0] = 0;
    }

    private _slowPathInvalidReturnPreCall(id: number, name: string, esp: number, cpu: any): void {
        const retAddr = (this.cachedDataView && this.isDataViewValid() && esp < this.memLength - 4) ?
            this.cachedDataView.getUint32(esp, true) >>> 0 : 0;

        Logger.error(LogCategory.THUNK,
            `Invalid return address for ${name} (pre-call)! ` +
            `ESP=0x${esp.toString(16)}, [ESP]=0x${retAddr.toString(16)}. ` +
            `Preventing execution to avoid crash.`);

        // Route through the single crash funnel so the host shows the crash dialog
        // (with a copyable report) and the harness 'fault' event fires — instead of
        // a silent v86.stop() that froze the screen with no indication.
        this._reportInvalidReturnCrash(name, esp, retAddr, cpu, "pre-call");
    }

    private _slowPathInvalidReturn(id: number, name: string, esp: number, val: number, cpu: any): void {
        const retAddr = (this.cachedDataView && this.isDataViewValid() && esp < this.memLength - 4) ?
            this.cachedDataView.getUint32(esp, true) >>> 0 : 0;

        Logger.error(LogCategory.THUNK,
            `Invalid return address for ${name}! ` +
            `ESP=0x${esp.toString(16)}, EAX=0x${val.toString(16)}. ` +
            `Preventing RET execution to avoid crash.`);

        cpu.reg32[0] = (val >>> 0);
        this._reportInvalidReturnCrash(name, esp, retAddr, cpu, "post-call");
    }

    /**
     * Build a uniform crash report from CPU/stack state for a bad-return-address
     * fault (there was no #PF, so faultRecorder is stale here — we synthesize the
     * fault fields) and hand it to the single System crash funnel.
     */
    private _reportInvalidReturnCrash(name: string, esp: number, retAddr: number, cpu: any, phase: string): void {
        // Cold-path crash-funnel report — see dispatcher-forensics.ts.
        DispatcherForensics.reportInvalidReturnCrash(this, name, esp, retAddr, cpu, phase);
    }

    /**
     * Reconstruct call stack by scanning stack memory for return addresses.
     * Returns array of stack frames with module information.
     */
    private reconstructCallStack(
        esp: number,
        mem8: Uint8Array,
        view: DataView,
        maxScanBytes: number = 256,
        maxFrames: number = 32
    ): Array<{
        stackOffset: number;
        retAddr: number;
        moduleName: string | null;
        moduleOffset: number;
        isThunk: boolean;
    }> {
        // Cold-path forensic scanner — see dispatcher-forensics.ts.
        return DispatcherForensics.reconstructCallStack(this, esp, mem8, view, maxScanBytes, maxFrames);
    }

    // =========================================================================
    // Public Utils
    // =========================================================================

    /**
     * Apply pending registrations that were deferred because stubs weren't created yet.
     * Call this after new stubs are generated (e.g., after PE loading).
     */
    applyPendingRegistrations(): void {
        let applied = 0;

        // Apply pending regular registrations.
        // NOTE: Multiple DLLs can import the same function (e.g. both HP.exe and core.dll
        // import msvcrt:_exit). Each gets a separate stub with a different functionId — we
        // must register the impl for ALL matching stubs, not just the first one.
        for (const [, pending] of this.pendingRegistrations.entries()) {
            let matchingStubs = this.findStubsByName(pending.dllName, pending.functionName);
            // Interface-prefix fallback (defensive — covers legacy path where some DLLs may
            // register qualified names against short-named stubs, e.g. IDirectDraw2_CreateSurface
            // → CreateSurface). Kept only on the regular-registration path; fast-path / WBUF
            // registrations always use qualified names that match qualified stubs directly.
            if (matchingStubs.length === 0 && pending.functionName.includes('_')) {
                const shortName = pending.functionName.substring(pending.functionName.lastIndexOf('_') + 1);
                if (shortName && shortName !== pending.functionName) {
                    matchingStubs = this.findStubsByName(pending.dllName, shortName);
                }
            }
            for (const stub of matchingStubs) {
                const id = stub.functionId;
                if (id < MAX_THUNK_ID) {
                    this.dispatchTable[id] = pending.impl;
                    this.argCountsTable[id] = stub.argCount ?? DEFAULT_ARGS_COUNT;
                    this.stackCleanupTable[id] = stub.stackCleanupBytes ?? -1;
                    this.namesTable[id] = `${pending.dllName}:${pending.functionName}`;
                    hypercallDataManager.registerFunction(stub.dllName, stub.functionName, id);
                    Logger.verbose(LogCategory.THUNK, `Applied pending registration [${id}] ${pending.dllName}:${pending.functionName}`);
                    applied++;
                }
            }
            // Keep pending entry — late-loaded DLLs may need it; also survives reset+reload.
        }

        // Apply pending fast-path registrations (re-binds against new stub IDs after reset).
        for (const [, pending] of this.pendingFastPathRegistrations.entries()) {
            for (const stub of this.findStubsByName(pending.dllName, pending.functionName)) {
                if (stub.functionId < MAX_THUNK_ID) {
                    this.fastPathTable[stub.functionId] = pending.impl;
                    if (pending.trivial) this.trivialFastPathTable[stub.functionId] = 1;
                    Logger.verbose(LogCategory.THUNK, `Applied pending fast-path [${stub.functionId}] ${pending.dllName}:${pending.functionName}${pending.trivial ? ' (trivial)' : ''}`);
                    applied++;
                }
            }
        }

        // Apply pending constant-return stubs (zero-crossing patches) — re-patches the new stubs.
        for (const [, pending] of this.pendingConstStubRegistrations.entries()) {
            if (this.findStubsByName(pending.dllName, pending.functionName)[0]) {
                this.registerConstantReturnStub(pending.dllName, pending.functionName, pending.value, pending.popBytes);
                applied++;
            }
        }

        // Apply pending write-buffer registrations (standard + PtrDeref) — re-patches the new stubs.
        for (const [, pending] of this.pendingWriteBufRegistrations.entries()) {
            const stub = this.findStubsByName(pending.dllName, pending.functionName)[0];
            if (stub && stub.functionId < MAX_THUNK_ID) {
                if (pending.ptrDeref && pending.floatCount) {
                    this.registerPtrDerefWriteBufferFunction(
                        pending.dllName, pending.functionName,
                        pending.floatCount, pending.handler, pending.isStdcall);
                } else if (pending.shaderConstant) {
                    this.registerShaderConstantWriteBufferFunction(
                        pending.dllName, pending.functionName, pending.handler);
                } else if (pending.structCapture) {
                    this.registerStructCaptureWriteBufferFunction(
                        pending.dllName, pending.functionName, pending.argCount,
                        pending.structCapture.ptrArgIndex, pending.structCapture.payloadDwords,
                        pending.handler);
                } else if (pending.upDraw) {
                    this.registerUpDrawWriteBufferFunction(
                        pending.dllName, pending.functionName, pending.handler);
                } else if (pending.shadowSpec) {
                    this.registerShadowedWriteBufferFunction(
                        pending.dllName, pending.functionName, pending.argCount,
                        pending.handler, pending.coalesceArgMask ?? 0, pending.shadowSpec);
                } else if (pending.ownerDisarm) {
                    this.registerOwnerDisarmWriteBufferFunction(
                        pending.dllName, pending.functionName, pending.argCount,
                        pending.handler, pending.coalesceArgMask ?? 0,
                        pending.barrier ? { barrier: true } : undefined);
                } else {
                    this.registerWriteBufferFunction(
                        pending.dllName, pending.functionName,
                        pending.argCount, pending.handler, pending.isStdcall,
                        pending.coalesceArgMask ?? 0,
                        pending.barrier ? { barrier: true } : undefined);
                }
                applied++;
            }
        }

        if (applied > 0) {
            Logger.verbose(LogCategory.THUNK, `Applied ${applied} pending registrations`);
        }

        this.resyncHypercallRegistrations();
    }

    /**
     * Ensure every stub with a bound JS impl is registered in the WASM dispatch table.
     * register() and applyPendingRegistrations can miss hypercall wiring when stubs
     * appear after module registration or when the stub DLL name differs from the
     * canonical module name (e.g. msvcr90 vs msvcrt).
     */
    private resyncHypercallRegistrations(): void {
        if (!hypercallDataManager.isInitialized()) return;
        for (const stub of this.thunkGenerator.getAllStubs()) {
            const id = stub.functionId;
            if (id <= 0 || id >= MAX_THUNK_ID) continue;
            if (!this.dispatchTable[id]) continue;
            hypercallDataManager.registerFunction(stub.dllName, stub.functionName, id);
        }
    }


    /**
     * Return sorted slow-path hit counts for profiling.
     * Usage: dispatcher.getSlowPathReport() in browser DevTools console.
     * Shows which thunks miss the fast-path table most often � top candidates for fast-path.
     * Requires enableSlowPathProfile() first — collection is off by default to avoid
     * per-call Map.set overhead on hot slow-path thunks.
     */
    getSlowPathReport(): Array<{ name: string; hits: number }> {
        return [...this.slowPathHitCounts.entries()]
            .map(([name, hits]) => ({ name, hits }))
            .sort((a, b) => b.hits - a.hits);
    }

    /** Enable slow-path hit counting. Adds one Map.set per slow-path thunk — off by default. */
    enableSlowPathProfile(): void {
        this.profileSlowPathEnabled = true;
    }

    /**
     * Async-park telemetry report — per async thunk, total wall-clock parked at the
     * spin loop plus a park-duration histogram and per-thread split. The headline
     * idle-classification tool: ranks which async thunk (GetMessage, WaitForSingleObject,
     * Flip, …) actually drives the worker idle, and whether its parks are short
     * (~4ms WM_NULL polling = inherent waiting) or long (genuine blocks).
     * Usage: dispatcher.getAsyncParkReport() — or asyncParkReport() in worker console.
     */
    getAsyncParkReport(): {
        windowMs: number;
        rows: Array<{
            name: string; count: number; totalMs: number; avgMs: number; maxMs: number;
            pctOfWindow: string;
            buckets: { le1: number; le5: number; le16: number; le50: number; gt50: number };
            byTid: Array<{ tid: number; count: number; totalMs: number }>;
        }>;
    } {
        const windowMs = performance.now() - this.asyncParkStatsSince;
        const rows = [...this.asyncParkStats.entries()]
            .map(([name, s]) => ({
                name,
                count: s.count,
                totalMs: Math.round(s.totalMs),
                avgMs: s.count > 0 ? +(s.totalMs / s.count).toFixed(2) : 0,
                maxMs: Math.round(s.maxMs),
                pctOfWindow: windowMs > 0 ? (s.totalMs / windowMs * 100).toFixed(1) + "%" : "0.0%",
                buckets: { ...s.buckets },
                byTid: [...s.byTid.entries()]
                    .map(([tid, t]) => ({ tid, count: t.count, totalMs: Math.round(t.totalMs) }))
                    .sort((a, b) => b.totalMs - a.totalMs),
            }))
            .sort((a, b) => b.totalMs - a.totalMs);
        return { windowMs: Math.round(windowMs), rows };
    }

    /** Reset async-park telemetry and restart its measurement window. */
    resetAsyncParkStats(): void {
        this.asyncParkStats.clear();
        this.asyncParkStatsSince = performance.now();
    }

    /**
     * Return Tier-0 write-buffer telemetry. Use from DevTools after a game run to
     * distinguish trampoline success vs OUT-trap fallback.
     *   - hits: ring entries drained (trampoline path worked)
     *   - outTrapHits: WBUF-registered funcIds that still reached handlePortWrite
     *     (deferred JIT invalidation race, or stub never patched)
     *   - coalescedSkips: entries skipped because a later entry in the same drain
     *     overwrote the same scalar state slot before any trap/draw observed it
     *   - registered: number of WBUF-registered funcIds
     * Interpretation:
     *   - outTrapHits > 0 && hits == 0 → patching failed (check [WBUF] Registered logs)
     *   - outTrapHits > hits          → JIT invalidation race
     *   - hits >> outTrapHits         → WBUF working; investigate unregistered thunks elsewhere
     */
    getWbufStats(): { hits: number; outTrapHits: number; coalescedSkips: number; barrierEntries: number; registered: number } {
        let registered = 0;
        for (let i = 0; i < this.writeBufHandlerTable.length; i++) {
            if (this.writeBufHandlerTable[i]) registered++;
        }
        return {
            hits: this.wbufHitsTotal,
            outTrapHits: this.wbufOutTrapHitsTotal,
            coalescedSkips: this.wbufCoalescedSkipsTotal,
            barrierEntries: this.wbufBarrierEntriesTotal,
            registered,
        };
    }

    resetWbufStats(): void {
        this.wbufHitsTotal = 0;
        this.wbufOutTrapHitsTotal = 0;
        this.wbufCoalescedSkipsTotal = 0;
        this.wbufBarrierEntriesTotal = 0;
    }

    /** Disable slow-path hit counting. Existing counts remain accessible via getSlowPathReport(). */
    disableSlowPathProfile(): void {
        this.profileSlowPathEnabled = false;
    }

    /**
     * Reset slow-path hit counters.
     */
    resetSlowPathStats(): void {
        this.slowPathHitCounts.clear();
    }

    reset(): void {
        this.isWaitingForEipDump = false;
        this.activeAsyncThunks.clear();
        this.pendingAsyncRestores.length = 0;
        this.pendingRegistrations.clear();
        // NOTE: pendingFastPathRegistrations and pendingWriteBufRegistrations are
        // intentionally NOT cleared on reset. Both are populated once from
        // module.initialize() (which runs exactly once at worker boot) and must survive
        // Process.reset() so applyPendingRegistrations() can re-bind them against the
        // new stub IDs after thunkGenerator.reset() regenerates stubs on PE reload.
        //
        // Without this, fast-paths / WBUF trampolines registered at boot are lost the
        // first time the user loads a game — slow-path hits soar for D3D state setters.
        this.dispatchTable.fill(null);
        this.fastPathTable.fill(null);
        this.writeBufHandlerTable.fill(null);
        this.writeBufArgCountTable.fill(0);
        this.writeBufCoalesceMaskTable.fill(0);
        this.wbufCoalescingEnabled = false;
        this.argCountsTable.fill(-1);
        this.namesTable.fill(null);
        if (this._callbackManager) this._callbackManager.reset();
        this.winApiRing.reset();
        this.profilerSampleCounter = 0;
        this.nextChecksumAt = 0;
        this.checksumInProgress = false;
        if (this.sehRuntimePinned) {
            try { this.ensureScheduler().unpinCurrentThread(); } catch { }
            this.sehRuntimePinned = false;
        }
        try { this._clearSehTransientRanges(); } catch { }
        try {
            while (this.sehDispatchStack.length > 0) {
                const ctx = this.sehDispatchStack.pop()!;
                const tid = this.ensureScheduler().getCurrentThreadId();
                this.ensureScheduler().exitCriticalRuntime('seh_dispatch', tid >>> 0, ctx.generation >>> 0, 'dispatcher_reset');
            }
        } catch { }
        this.sehDispatchStack = [];
        this.sehDispatchGeneration = 0;
    }
}
