/**
 * Single source of truth for harness.report() and crash/exit copyable reports.
 * Keeps the host "Copy report" text and `await harness.report()` in sync.
 */

import { serializeCpu, serializeThreads, proc, symbolize, guestMem } from "./serialize";
import { faultRecorder } from "../core/memory/fault-recorder";
import { stubRegistry } from "../core/diagnostics/stub-registry";
import { getProcAddressRegistry } from "../core/diagnostics/get-proc-address-registry";
import { apiCensus } from "../core/diagnostics/api-census";
import { getCxxExceptionRing, getSehDispatchTrace } from "../core/seh-dispatch";
import { getStackGuardViolations } from "../core/memory/stack-write-guard";
import { hypercallDataManager } from "../core/cpu/hypercall-data";
import { loadDiagnostics } from "../core/diagnostics/load-diagnostics";
import { getGpuErrorReport, type GpuErrorReport } from "../core/gpu-error-log";
import { pendingMessageBoxes } from "../runtime/dialog-bridge";

const hx = (v: number) => "0x" + (v >>> 0).toString(16);

export interface SerializedCpuSnapshot {
    eip: number;
    eipSym: string | null;
    regs: {
        eax: number; ecx: number; edx: number; ebx: number;
        esp: number; ebp: number; esi: number; edi: number;
    };
    eflags: number;
    segments: { es: number; cs: number; ss: number; ds: number; fs: number; gs: number } | null;
    fsBase: number;
}

export interface HarnessReport {
    cpu: SerializedCpuSnapshot | null;
    lastThunk: string | null;
    backtrace: Array<{ i: number; ret: string; sym: string | null; isThunk: boolean }>;
    lastThunks: string[];
    stubs: Array<{ api: string; id: string; count: number; firstCaller: string; firstCallerSym: string | null }>;
    /**
     * A non-zero `gpuTotal` is never normal: WebGPU reports validation asynchronously and
     * never throws for it, so the guest runs on believing it drew — the symptom is missing
     * geometry or a frozen picture, not an exception. (`total` also counts guarded
     * non-GPU callback throws.) Carried here because the log ring cannot hold the first one.
     */
    gpuErrors: GpuErrorReport;
    /**
     * Message boxes the guest is blocked on. The host draws them as DOM, so no canvas
     * capture can show one: without this, a guest waiting on an error box is indistinguishable
     * from a freeze, and the text naming the actual problem is invisible.
     */
    pendingModals: Array<{ id: number; text: string; caption: string; uType: number; waitingMs: number }>;
    silentStubs: Array<{ api: string; count: number; arity: number; lastCaller: string; lastCallerSym: string | null }>;
    getProcMisses: Array<{
        module: string; proc: string; count: number;
        firstCaller: string; firstCallerSym: string | null;
        lastCaller: string; lastCallerSym: string | null;
    }>;
    recentGetProc: Array<{
        module: string; proc: string; addr: string | null; kind: string;
        caller: string; callerSym: string | null;
    }>;
    /**
     * GetProcAddress lookups that RESOLVED but to nothing usable — a stub with no
     * handler, or a handler that ignores its arguments. Deliberately separate from
     * `getProcMisses`: a NULL makes the guest take its fallback path, whereas one of
     * these tells the guest it succeeded and then does nothing.
     */
    getProcStubbed: Array<{
        module: string; proc: string; kind: string; count: number;
        lastCaller: string; lastCallerSym: string | null;
    }>;
    /** `eipTrusted:false` ⇒ no instruction at `eip` addresses CR2 (the jit materializes only
     *  eip's low 12 bits) — read `cr2Candidates`/`badCall` instead of chasing that EIP. */
    faults: Array<{
        eip: string; eipTrusted?: boolean; faultAddr: string; cr2Candidates?: string[];
        badCall?: { callSite: number; slotAddr: number; slotValue: number; operand: string };
        lastThunk: string; threadId: number | null; outcome?: string;
    }>;
    /** Recent C++ (0xe06d7363) exceptions: decoded type/message + caught/unhandled outcome.
     *  The usual root cause of an MSVC/UE "Runtime Error! terminate" is an `unhandled` entry. */
    cxxExceptions: Array<{ seq: number; threadId: number; type: string; thrown: string; throwModule: string; rethrow: boolean; outcome: string; caughtBy: string }>;
    threads: ReturnType<typeof serializeThreads>;
    /** Recent thunks with arg0 and EAX return (from WinApiCallRing). */
    thunkTrace: string[];
    /** EVERY recent hypercall incl. fast-path Tier 1-3 (memcpy/memset/CS/strings). */
    lastHypercalls: string[];
    /** Dwords at [ESP..ESP+12] for post-mortem stack inspection. */
    stackAtEsp: string[];
    /** 16 bytes at EIP (hex). */
    eipHex: string;
    /** Loaded module containing EIP, if any. */
    eipModule: string | null;
    /** CRT/kernel32 heap-slab fast-path stats (getSlabStats). `allocs`/`frees` are slab-served
     *  ops; `fallbacks` are Rust >4KB deferrals. Read against the profiler's JS malloc count to
     *  see the slab hit rate; `used`≈`capacity` on the CURRENT generation means the arena is
     *  full and every further alloc is bumping/falling to JS (see kernel32/memory.ts slab notes). */
    slab: { allocs: number; frees: number; fallbacks: number; used: number; capacity: number };
    /** Parked-stack write-guard violations (newest last) — plant-time tripwire for the
     *  0x7c07 corruption class; each line carries the JS stack at write time. */
    stackGuardViolations: string[];
    /** Recent SEH catch dispatches (newest last) with descent windows + WILD-EBP notes. */
    sehDispatchTrace: string[];
    /** The crash that ended the run, INCLUDING one raised before any guest code ran
     *  (PE link failure) — where every live-state field below is legitimately empty. */
    crash: { reason: string; eip: string; faultAddr: string; threadId: number | null; lastThunk: string } | null;
    /** Imports with no known arity. A fatal one aborts the link ("Stub requires
     *  argCount..."); the rest are latent stack-cleanup corruption. Fix in the
     *  module's `*.api.ts` (or tools/reference/win32) — see the crash reason. */
    unknownArgCounts: Array<{ api: string; aliasedFrom: string | null; count: number }>;
}

function readStackWords(esp: number, count = 4): string[] {
    const mem = guestMem();
    if (!mem || esp < 0 || esp + count * 4 > mem.length) return [];
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
        out.push(hx(view.getUint32(esp + i * 4, true)));
    }
    return out;
}

function readEipBytes(eip: number, len = 16): string {
    const mem = guestMem();
    if (!mem || eip < 0 || eip >= mem.length) return "";
    const n = Math.min(len, mem.length - eip);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(mem[eip + i]!.toString(16).padStart(2, "0"));
    return out.join(" ");
}

function moduleAtEip(eip: number): string | null {
    const mod = proc()?.moduleRegistry?.getModuleContainingAddress?.(eip);
    if (!mod) return null;
    return `${mod.name}+${hx(eip - mod.baseAddress)}`;
}

/** Build the harness-grade incident report while guest state is still live. */
export function buildHarnessReport(esp?: number): HarnessReport {
    const d = proc()?.dispatcher as {
        getGuestCallStack?: (e?: number) => {
            esp: number; lastThunk: string; recent: string[];
            frames: Array<{ index: number; stackOffset: number; retAddr: number; moduleName: string | null; moduleOffset: number; isThunk: boolean }>;
        };
        getLastWinApiTrace?: (n: number) => string[];
        getLastWinApiCallsRich?: (n: number) => Array<{ name: string; esp: number; retAddrBefore: number }>;
        getLastHypercalls?: (n: number) => string[];
    } | undefined;
    const bt = d?.getGuestCallStack?.(esp);
    const cpuSnap = serializeCpu() as SerializedCpuSnapshot | null;
    const espVal = esp ?? cpuSnap?.regs.esp ?? 0;
    const eipVal = cpuSnap?.eip ?? 0;

    let thunkTrace: string[] = [];
    let lastHypercalls: string[] = [];
    try {
        thunkTrace = d?.getLastWinApiTrace?.(12) ?? [];
        lastHypercalls = d?.getLastHypercalls?.(48) ?? [];
    } catch { /* best-effort */ }

    return {
        cpu: cpuSnap,
        lastThunk: bt?.lastThunk ?? null,
        backtrace: (bt?.frames ?? []).map((f) => ({
            i: f.index,
            ret: hx(f.retAddr),
            sym: symbolize(f.retAddr) ?? (f.moduleName ? `${f.moduleName}+${hx(f.moduleOffset)}` : null),
            isThunk: f.isThunk,
        })),
        lastThunks: bt?.recent ?? [],
        gpuErrors: getGpuErrorReport(),
        pendingModals: pendingMessageBoxes(),
        stubs: stubRegistry.list().map((s) => ({
            api: s.key,
            id: hx(s.functionId),
            count: s.count,
            firstCaller: hx(s.firstCaller),
            firstCallerSym: symbolize(s.firstCaller),
        })),
        silentStubs: apiCensus.suspectStubs().map((s) => ({
            api: s.name,
            count: s.count,
            arity: s.arity,
            lastCaller: hx(s.lastCaller),
            lastCallerSym: symbolize(s.lastCaller),
        })),
        getProcMisses: getProcAddressRegistry.misses().map((h) => ({
            module: hx(h.hModule),
            proc: h.procName,
            count: h.count,
            firstCaller: hx(h.firstCaller),
            firstCallerSym: symbolize(h.firstCaller),
            lastCaller: hx(h.lastCaller),
            lastCallerSym: symbolize(h.lastCaller),
        })),
        recentGetProc: getProcAddressRegistry.recent(16).map((h) => ({
            module: hx(h.hModule),
            proc: h.procName,
            addr: h.address !== 0 ? hx(h.address) : null,
            kind: h.kind,
            caller: hx(h.caller),
            callerSym: symbolize(h.caller),
        })),
        getProcStubbed: getProcAddressRegistry.unsatisfied()
            .filter((h) => h.kind !== 'null')
            .slice(0, 12)
            .map((h) => ({
                module: h.dll ?? hx(h.hModule),
                proc: h.procName,
                kind: h.kind,
                count: h.count,
                lastCaller: hx(h.lastCaller),
                lastCallerSym: symbolize(h.lastCaller),
            })),
        faults: faultRecorder.recent(8).map((f) => ({
            eip: hx(f.eip),
            eipTrusted: f.eipTrusted,
            faultAddr: hx(f.faultAddr),
            cr2Candidates: f.cr2Candidates,
            badCall: f.badCall,
            lastThunk: f.lastThunk,
            threadId: f.threadId,
            outcome: f.outcome,
        })),
        cxxExceptions: getCxxExceptionRing().slice(-12).map((e) => ({
            seq: e.seq,
            threadId: e.threadId,
            type: e.typeName,
            thrown: e.thrownStr,
            throwModule: e.throwModule.trim(),
            rethrow: e.isRethrow,
            outcome: e.outcome,
            caughtBy: e.caughtBy,
        })),
        threads: serializeThreads(),
        thunkTrace,
        lastHypercalls,
        stackAtEsp: readStackWords(espVal),
        eipHex: readEipBytes(eipVal),
        eipModule: moduleAtEip(eipVal),
        slab: hypercallDataManager.getSlabStats(),
        stackGuardViolations: getStackGuardViolations(),
        sehDispatchTrace: getSehDispatchTrace(),
        crash: (() => {
            const f = loadDiagnostics.lastFailure();
            return f && {
                reason: f.reason,
                eip: hx(f.eip),
                faultAddr: hx(f.faultAddr),
                threadId: f.threadId,
                lastThunk: f.lastThunk,
            };
        })(),
        unknownArgCounts: loadDiagnostics.list().map((u) => ({
            api: u.key,
            aliasedFrom: u.aliasedFrom,
            count: u.count,
        })),
    };
}
