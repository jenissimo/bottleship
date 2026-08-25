/**
 * SEH chain dispatch for MSVC C++ exceptions (0xe06d7363).
 *
 * Walks the structured exception handler chain from TEB[0x00],
 * parses MSVC FuncInfo structures, and redirects execution to
 * the matching catch block.
 *
 * Supports two MSVC layouts:
 *   VC5/6 (__except_handler3 / __CxxFrameHandler):
 *     [sehHead+0]=next, [+4]=handler, [+8]=scopetable/FuncInfo, [+12]=trylevel
 *     EBP = sehHead + 12 (our _EH_prolog only pushes {prev, scopetable, trylevel} —
 *     no separate "handler" field — so the record is 12 bytes, not 16; matches VC7+ below)
 *     Catch handlers are inline code (JMP to continuation at end)
 *
 *   VC7+ (__CxxFrameHandler3):
 *     [sehHead+0]=next, [+4]=handler_thunk, [+8]=state/trylevel
 *     EBP = sehHead + 12
 *     FuncInfo encoded in handler thunk: MOV EAX, &FuncInfo; JMP __CxxFrameHandler3
 *     Catch handlers are funclets: called by __CxxFrameHandler3, return
 *     continuation address in EAX, then RET.
 *
 * Shared between kernel32:RaiseException and msvcrt:_CxxThrowException.
 */

import { ThunkResult } from './thunking/thunk-dispatcher';
import { invalidateGuestCode } from './memory/guest-code';
import { Logger, LogCategory } from './logger';
import { System } from './system';
import { debugSession } from './debug/debug-session';
import { recordSehFrame, repairSehSelfLoop } from './tools/seh-chain-repair';
import { guardStackWrite } from './memory/stack-write-guard';
import { isValidAddress } from './memory/address-guard';

/**
 * EBP offset (from the SEH registration record's own address, `sehHead`) for any frame
 * set up through our shared native `_EH_prolog` stub (crt-eh-prolog.ts). That stub pushes
 * exactly {prev, scopetable/FuncInfo-thunk, trylevel/state} — 12 bytes, no separate
 * "handler" field — then does `lea ebp, [esp+0xc]`, so EBP always lands at sehHead+12.
 * Applies to BOTH the VC5/6 (FuncInfo-in-record) and VC7+ (FuncInfo-via-handler-thunk)
 * shapes below, since both go through this one prolog. Do NOT copy this as a bare literal —
 * a stray `+ 16` here (the real, undocumented Windows `_except_handler3` record IS 16 bytes,
 * with a genuine "handler" field we don't emit) is what caused the msvcirt.dll static-init
 * crash (this+0x38 computed from the wrong EBP).
 */
const EH_PROLOG_EBP_DELTA = 12;

/**
 * FuncInfo unwind-map field offsets (read by both readUnwindActions() and
 * collectCatchingFrameUnwindActions() — keep them in sync, or better, prefer the shared
 * helper over adding a third copy).
 */
const FUNCINFO_MAX_STATE_OFF = 4;
const FUNCINFO_UNWIND_MAP_OFF = 8;
/** UnwindMapEntry (8 bytes): +0 toState (int32), +4 action (uint32, 0 = no destructor). */
const UNWIND_MAP_ENTRY_SIZE = 8;
const UNWIND_MAP_ACTION_OFF = 4;

/**
 * _s__ThrowInfo → CatchableTypeArray → CatchableType chain offsets, shared by
 * matchesThrowType() (real RTTI match) and dispatchCxxException()'s thrown-value probe
 * (best-effort string decode for logging). See matchesThrowType's doc comment for the
 * full struct layout; these are just the fields both call sites actually dereference.
 */
const THROWINFO_CATCHABLE_ARRAY_OFF = 12;
const CATCHABLE_ARRAY_FIRST_TYPE_OFF = 4; // CatchableTypeArray: +0 nTypes, +4 arrayOfTypes[0]
const CATCHABLE_TYPE_TYPEDESC_OFF = 4;

// MSVC C++ EH FuncInfo magic numbers: 0x19930520 (VC6), 0x19930521 (VC7/2003),
// 0x19930522 (VC8/2005+). The first 5 FuncInfo fields (magic, maxState, pUnwindMap,
// nTryBlocks, pTryBlockMap) and the 20-byte TryBlockMap / 16-byte Handler layouts are
// identical across all three, and 32-bit binaries use absolute (not RVA) map pointers —
// so tryMatchCatch parses VC7/VC8 the same as VC6. Accepting the newer magics keeps
// modern-MSVC titles (e.g. patched engine builds using VC8 EH tables) on the clean JS catch
// path instead of the fragile x86-stub fallback (the latter accumulates SEH frames and
// self-loops across sequential catches — see seh-chain-repair.ts).
const MSVC_MAGIC = 0x19930520;
function isMsvcEhMagic(magic: number): boolean {
    return magic === MSVC_MAGIC || magic === 0x19930521 || magic === 0x19930522;
}

/**
 * Per-thread active exception state for re-throw support.
 * When `throw;` is called (pObj=0, pThrow=0), MSVC reuses the current
 * in-flight exception. We track it here keyed by TEB address (unique per thread).
 */
interface ActiveException {
    pExceptionObject: number;
    pThrowInfo: number;
}
// Stack per thread — nested exceptions (e.g., destructor throws during unwind)
// push onto the stack; re-throw peeks top; catch completion pops top.
const activeExceptions = new Map<number, ActiveException[]>();

/**
 * Diagnostic ring of recent C++ (0xe06d7363) exceptions seen by the dispatcher, so
 * `report()` / `sehLog()` can answer "what did the game throw and was it caught?" in one
 * call instead of grepping the firehose. Each throw records its decoded type/message and
 * the eventual outcome (caught by which module, rethrown, or unhandled→terminate).
 */
export interface CxxExceptionRecord {
    seq: number;
    threadId: number;
    typeName: string;       // decorated type descriptor name (".PAD" = char*, etc.)
    thrownStr: string;      // decoded string payload for TCHAR* throws ("" otherwise)
    throwEip: number;
    throwModule: string;    // module label of the throw site
    isRethrow: boolean;     // true for `throw;` (pObj=0)
    outcome: 'pending' | 'caught' | 'unhandled' | 'deferred-x86';
    caughtBy: string;       // module label of the catching frame (when outcome=caught)
}
const cxxExceptionRing: CxxExceptionRecord[] = [];
const CXX_RING_MAX = 64;
let cxxSeq = 0;
/** The most-recent throw record, updated in-place by tryMatchCatch/dispatch end. */
let currentThrowRecord: CxxExceptionRecord | null = null;

function recordCxxThrow(rec: Omit<CxxExceptionRecord, 'seq' | 'outcome' | 'caughtBy'>): CxxExceptionRecord {
    const full: CxxExceptionRecord = { ...rec, seq: ++cxxSeq, outcome: 'pending', caughtBy: '' };
    cxxExceptionRing.push(full);
    if (cxxExceptionRing.length > CXX_RING_MAX) cxxExceptionRing.shift();
    currentThrowRecord = full;
    return full;
}

/** Recent C++ exceptions, newest last. Consumed by build-report and the `sehLog` harness verb. */
export function getCxxExceptionRing(): CxxExceptionRecord[] {
    return cxxExceptionRing.slice();
}

// ── SEH dispatch trace ring (always-on, crash-report grade) ────────────────────
// One compact line per emitted catch dispatch, plus the dead "descent window"
// [scratchEsp, throwEsp) its trampoline/funclet executed in. After a bootloader
// escape (0x7c07 family) the exception dumper cross-references the faulting EIP and
// the suspect return-address slot against these windows — a hit means the SEH
// dispatch planted the corruption; no hit exonerates it. Kept tiny and allocation-
// light: it must survive to the post-mortem, not narrate the firehose.
interface SehDispatchWindow { seq: number; tid: number; lo: number; hi: number }
const sehDispatchTrace: string[] = [];
const sehDispatchWindows: SehDispatchWindow[] = [];
const SEH_DISPATCH_TRACE_MAX = 16;

function recordSehDispatchTrace(line: string, win?: SehDispatchWindow): void {
    if (sehDispatchTrace.length >= SEH_DISPATCH_TRACE_MAX) sehDispatchTrace.shift();
    sehDispatchTrace.push(line);
    if (win) {
        if (sehDispatchWindows.length >= SEH_DISPATCH_TRACE_MAX) sehDispatchWindows.shift();
        sehDispatchWindows.push(win);
    }
}

/** Recent catch dispatches (newest last) for the crash report / `report()`. */
export function getSehDispatchTrace(): string[] {
    return sehDispatchTrace.slice();
}

// One line per RtlUnwind and per frame it classified. The unwind pass is a DECISION the
// log firehose cannot carry (a per-frame VERBOSE line is dropped by the log socket long
// before a late crash fires), yet "which frames got their handler and which were skipped,
// and why" is the whole answer when a non-MSVC runtime's teardown does not run. Bounded,
// allocation-light, read via harness `sehTrace`.
const sehUnwindTrace: string[] = [];
const SEH_UNWIND_TRACE_MAX = 512;

export function recordSehUnwindTrace(line: string): void {
    if (sehUnwindTrace.length >= SEH_UNWIND_TRACE_MAX) sehUnwindTrace.shift();
    sehUnwindTrace.push(line);
}

/** Recent RtlUnwind frame decisions (newest last). `clear` empties the ring. */
export function getSehUnwindTrace(clear = false): string[] {
    const out = sehUnwindTrace.slice();
    if (clear) sehUnwindTrace.length = 0;
    return out;
}

/** Does addr fall inside a recently used dispatch descent window? (crash forensics) */
export function findSehWindowHit(addr: number): string | null {
    const a = addr >>> 0;
    for (let i = sehDispatchWindows.length - 1; i >= 0; i--) {
        const w = sehDispatchWindows[i];
        if (a >= w.lo && a < w.hi) {
            return `0x${a.toString(16)} is inside SEH dispatch window #${w.seq} T${w.tid} ` +
                `[0x${w.lo.toString(16)},0x${w.hi.toString(16)})`;
        }
    }
    return null;
}

export function setActiveException(tebAddr: number, pObj: number, pThrow: number): void {
    let stack = activeExceptions.get(tebAddr);
    if (!stack) {
        stack = [];
        activeExceptions.set(tebAddr, stack);
    }
    stack.push({ pExceptionObject: pObj, pThrowInfo: pThrow });
}

export function getActiveException(tebAddr: number): ActiveException | undefined {
    const stack = activeExceptions.get(tebAddr);
    if (!stack || stack.length === 0) return undefined;
    return stack[stack.length - 1]; // peek top
}

export function clearActiveException(tebAddr: number): void {
    const stack = activeExceptions.get(tebAddr);
    if (!stack || stack.length <= 1) {
        // Last entry or empty — remove the whole key
        activeExceptions.delete(tebAddr);
    } else {
        stack.pop(); // pop top, preserving outer exception
    }
}

export function clearAllActiveExceptions(tebAddr: number): void {
    activeExceptions.delete(tebAddr);
    activeCatchRecords.delete(tebAddr);
}

/**
 * Clear ALL in-flight SEH / C++-exception dispatch state. Called on System.reset()
 * (harness reload / game switch): the maps are keyed by TEB address, and a fresh
 * run reuses the same TEB addresses, so leftover entries from the previous run would be
 * matched as if they belonged to the new process — a stale in-flight exception or an
 * active-catch record leaking across a reload corrupts the very first throw of the new run.
 * Clears the two live dispatch registries (activeExceptions, activeCatchRecords) plus the
 * diagnostic rings so post-reset forensics don't cross-reference the previous run's throws
 * or dead dispatch windows.
 */
export function resetSehDispatchState(): void {
    activeExceptions.clear();
    activeCatchRecords.clear();
    cxxExceptionRing.length = 0;
    currentThrowRecord = null;
    cxxSeq = 0;
    sehDispatchTrace.length = 0;
    sehDispatchWindows.length = 0;
    sehUnwindTrace.length = 0;
}

/**
 * Active-catch record — one per catch funclet the thread is currently executing
 * (LIFO, mirrors the CRT's CallCatchBlock invocation stack + CatchGuard nodes).
 *
 * This is the state the x86 CRT keeps implicitly on its own dispatch stack and we
 * must keep explicitly, because our JS dispatch returns before the funclet runs:
 *  - `savedTryEsp` — the try-entry ESP saved by the function prologue at [pRN-4]
 *    (PRN_STACK). CallCatchBlock snapshots it on entry and restores it in its
 *    __finally on EVERY exit (normal return, rethrow, new throw), because a try
 *    nested inside the catch body overwrites the slot.
 *  - a throw while the record exists originates INSIDE the catch body. The CRT
 *    intercepts a rethrow at CallCatchBlock (ExFilterRethrow), unwinds the catch's
 *    own state to its parent (__FrameUnwindToState) and resumes the ORIGINAL
 *    dispatch above the catching frame — we replay exactly that in
 *    dispatchCxxException's record-exit loop.
 *  - `stubHome`/`scratchEsp` — dead dispatch-window addresses reserved at catch
 *    entry, reused at completion time to emit the exception-object destructor stub
 *    (CRT: __DestructExceptionObject in CallCatchBlock's __finally, only when the
 *    funclet returned a non-NULL continuation).
 */
export interface ActiveCatchRecord {
    pRN: number;             // SEH registration node of the catching frame
    savedTryEsp: number;     // [pRN-4] snapshot at catch entry (0 = implausible/unavailable)
    catchEbp: number;        // pRN + EH_PROLOG_EBP_DELTA
    funcInfoPtr: number;
    stateOffset: number;     // 8 (VC7 layout) — records are only created for funclet paths
    tryLow: number;
    tryHigh: number;
    catchHigh: number;
    pExceptionObject: number; // exception this catch was entered with
    pThrowInfo: number;
    catchAddr: number;        // funclet address (diagnostics)
    stubHome: number;         // dead-window address for the completion-time dtor stub (0 = none)
    scratchEsp: number;       // dead-window scratch ESP for the dtor stub run (0 = none)
    continuationEsp: number;  // the ESP the continuation resumes on (diagnostics)
    seq: number;              // CxxExceptionRecord.seq of the throw that entered this catch
}
const activeCatchRecords = new Map<number, ActiveCatchRecord[]>();

function pushCatchRecord(tebAddr: number, rec: ActiveCatchRecord): void {
    let stack = activeCatchRecords.get(tebAddr);
    if (!stack) {
        stack = [];
        activeCatchRecords.set(tebAddr, stack);
    }
    stack.push(rec);
}

function peekCatchRecord(tebAddr: number): ActiveCatchRecord | undefined {
    const stack = activeCatchRecords.get(tebAddr);
    return stack && stack.length > 0 ? stack[stack.length - 1] : undefined;
}

function popCatchRecord(tebAddr: number): ActiveCatchRecord | undefined {
    const stack = activeCatchRecords.get(tebAddr);
    if (!stack || stack.length === 0) return undefined;
    const rec = stack.pop();
    if (stack.length === 0) activeCatchRecords.delete(tebAddr);
    return rec;
}

/** Snapshot of the per-thread active-catch stack (report()/sehLog diagnostics). */
export function getActiveCatchRecords(tebAddr?: number): Array<{ teb: number; records: ActiveCatchRecord[] }> {
    const out: Array<{ teb: number; records: ActiveCatchRecord[] }> = [];
    for (const [teb, records] of activeCatchRecords) {
        if (tebAddr !== undefined && teb !== tebAddr) continue;
        out.push({ teb, records: records.slice() });
    }
    return out;
}

/**
 * Is the exception object still referenced by another live catch (a nested catch
 * of the same object, or another active-exception entry)? Mirrors the CRT's
 * FRAMEINFO chain check (IsExceptionObjectToBeDestroyed): the object is destroyed
 * only by its OUTERMOST user.
 */
function isExceptionObjectReferenced(tebAddr: number, pExceptionObject: number): boolean {
    const records = activeCatchRecords.get(tebAddr);
    if (records) {
        for (const r of records) {
            if (r.pExceptionObject === pExceptionObject) return true;
        }
    }
    const excs = activeExceptions.get(tebAddr);
    if (excs) {
        for (const e of excs) {
            if (e.pExceptionObject === pExceptionObject) return true;
        }
    }
    return false;
}

/** ThrowInfo.pmfnUnwind — the thrown object's destructor (0 = trivially destructible). */
function readThrowInfoUnwindFunc(dv: DataView, mem: Uint8Array, pThrowInfo: number): number {
    if (pThrowInfo < 0x1000 || pThrowInfo + 8 > mem.length) return 0;
    return dv.getUint32(pThrowInfo + 4, true) >>> 0;
}

/**
 * Read the saved try-entry ESP from [pRN-4] (PRN_STACK) with plausibility checks:
 * must sit above the current throw point (the continuation resumes in the catching
 * frame, which is above everything the throw descended through) and point into
 * committed writable memory (fiber/Watcom alt-stacks included — same rule as the
 * scheduler's isEspInWritableMemory). Returns 0 when implausible; callers fall
 * back to pRN (the historical heuristic) and log.
 */
function readSavedTryEsp(dv: DataView, mem: Uint8Array, pRN: number, throwEsp: number): number {
    if (pRN < 4 || pRN + 4 > mem.length) return 0;
    const v = dv.getUint32((pRN - 4) >>> 0, true) >>> 0;
    if (v < 0x1000 || v + 4 > mem.length) return 0;
    // The saved try-ESP belongs to the catching frame: strictly above the throw
    // point, at/below the registration node (the node is pushed after locals).
    if (v <= throwEsp || v > pRN + 0x10000) return 0;
    try {
        const as = System.getInstance().process?.addressSpace as
            { validateRange?: (a: number, s: number, p: string) => boolean } | undefined;
        if (as?.validateRange && !as.validateRange(v, 4, 'rw')) return 0;
    } catch { /* early boot — accept */ }
    return v;
}

/**
 * Plausibility check for a frame EBP derived from an FS:[0] record (log-only tripwire,
 * same writable-memory rule as readSavedTryEsp). A stale/garbage record that passes the
 * magic checks yields an EBP pointing anywhere — the dispatch would then write the catch
 * variable / run destructors against it, planting corruption. We do NOT (yet) skip such
 * frames — this wave is diagnostics-only — but the SEH trace + ERROR log names them.
 */
function isImplausibleFrameEbp(frameEbp: number, memLen: number): boolean {
    if (frameEbp < 0x1000 || frameEbp + 4 > memLen) return true;
    try {
        const as = System.getInstance().process?.addressSpace as
            { validateRange?: (a: number, s: number, p: string) => boolean } | undefined;
        if (as?.validateRange && !as.validateRange(frameEbp >>> 0, 4, 'rw')) return true;
    } catch { /* early boot — accept */ }
    return false;
}

/** One step of work the catch-dispatch trampoline must execute before the funclet. */
type DispatchAction =
    | { kind: 'dtor'; fn: number; frameEbp: number }        // MOV EBP, frameEbp; CALL fn
    | { kind: 'thisCall'; fn: number; obj: number }          // MOV ECX, obj; CALL fn  (__thiscall, 0 args)
    | { kind: 'copyCtor'; fn: number; src: number; dst: number }; // PUSH src; MOV ECX, dst; CALL fn

/**
 * Tiny x86-32 code emitter for the dispatch trampolines. Every instruction we emit
 * is absolute-immediate or rel32, so the encodings stay trivial and auditable.
 */
class X86Emit {
    off: number;
    constructor(private dv: DataView, public readonly base: number) {
        this.off = base;
    }
    movEspImm(v: number): void { this.dv.setUint8(this.off, 0xBC); this.dv.setUint32(this.off + 1, v >>> 0, true); this.off += 5; }
    movEbpImm(v: number): void { this.dv.setUint8(this.off, 0xBD); this.dv.setUint32(this.off + 1, v >>> 0, true); this.off += 5; }
    movEcxImm(v: number): void { this.dv.setUint8(this.off, 0xB9); this.dv.setUint32(this.off + 1, v >>> 0, true); this.off += 5; }
    movEaxImm(v: number): void { this.dv.setUint8(this.off, 0xB8); this.dv.setUint32(this.off + 1, v >>> 0, true); this.off += 5; }
    pushImm(v: number): void { this.dv.setUint8(this.off, 0x68); this.dv.setUint32(this.off + 1, v >>> 0, true); this.off += 5; }
    pushad(): void { this.dv.setUint8(this.off, 0x60); this.off += 1; }
    popad(): void { this.dv.setUint8(this.off, 0x61); this.off += 1; }
    callAbs(target: number): void { this.dv.setUint8(this.off, 0xE8); this.dv.setInt32(this.off + 1, (target - (this.off + 5)) | 0, true); this.off += 5; }
    jmpAbs(target: number): void { this.dv.setUint8(this.off, 0xE9); this.dv.setInt32(this.off + 1, (target - (this.off + 5)) | 0, true); this.off += 5; }
    jmpEax(): void { this.dv.setUint8(this.off, 0xFF); this.dv.setUint8(this.off + 1, 0xE0); this.off += 2; }
    size(): number { return this.off - this.base; }
    /** Publish the emitted bytes: these trampolines live on the guest stack, so the same
     *  address carries different code on every dispatch — v86 must drop the old block. */
    commit(): number { invalidateGuestCode(this.base, this.off - this.base); return this.size(); }
}

/** Emit the action sequence (inside a PUSHAD/POPAD window when non-empty). */
function emitActions(e: X86Emit, actions: DispatchAction[]): void {
    if (actions.length === 0) return;
    e.pushad();
    for (const a of actions) {
        if (a.kind === 'dtor') {
            e.movEbpImm(a.frameEbp);
            e.callAbs(a.fn);
        } else if (a.kind === 'thisCall') {
            e.movEcxImm(a.obj);
            e.callAbs(a.fn);
        } else {
            e.pushImm(a.src);
            e.movEcxImm(a.dst);
            e.callAbs(a.fn);
        }
    }
    e.popad();
}

/** Bytes emitActions() will produce (size pre-computation for placement). */
function actionsSize(actions: DispatchAction[]): number {
    if (actions.length === 0) return 0;
    let n = 2; // PUSHAD + POPAD
    for (const a of actions) n += a.kind === 'copyCtor' ? 15 : 10;
    return n;
}

/**
 * HandlerType.adjectives bitmask constants.
 * HT_IsCompSimple  (0x01): catch variable is a simple type (no copy-ctor needed)
 * HT_IsVolatile    (0x02): catch volatile T
 * HT_IsUnaligned   (0x04): catch __unaligned T
 * HT_IsReference   (0x08): catch T& (reference)
 */
const HT_IsCompSimple = 0x01;
const HT_IsReference = 0x08;

interface UnwindAction {
    fromState: number;
    toState: number;
    action: number; // destructor address, 0 = no action
}

/** Info about a matched CatchableType — used for copy-constructor dispatch. */
interface CatchableTypeMatch {
    copyFunction: number;   // 0 = no copy-ctor
    sizeOrOffset: number;   // size of the catchable type (for memcpy fallback)
    thisDisplacement: number; // PMD.mdisp — offset to apply to exception object pointer
}

interface SkippedFrameInfo {
    sehHead: number;
    handlerAddr: number;
    state: number;
    isVC7: boolean;
    funcInfoPtr: number;
    frameEbp: number;
    unwindActions: UnwindAction[];
}

/**
 * Read the unwind map from a FuncInfo structure and return entries
 * that have destructors (action != 0) reachable from the current state.
 *
 * FuncInfo layout:
 *   +0: magic (0x19930520)
 *   +4: maxState (= nUnwindMapEntries)
 *   +8: pUnwindMap
 *
 * UnwindMapEntry (8 bytes):
 *   +0: toState (int32)  — state to transition to after running action
 *   +4: action  (uint32) — destructor address (0 = no action)
 *
 * Walk: start at currentState, follow toState chain until -1.
 */
function readUnwindActions(
    dv: DataView,
    mem: Uint8Array,
    funcInfoPtr: number,
    currentState: number,
): UnwindAction[] {
    const actions: UnwindAction[] = [];
    if (currentState < 0) return actions;

    const maxState = dv.getInt32(funcInfoPtr + FUNCINFO_MAX_STATE_OFF, true);
    const pUnwindMap = dv.getUint32(funcInfoPtr + FUNCINFO_UNWIND_MAP_OFF, true);
    if (maxState <= 0 || pUnwindMap < 0x10000 || pUnwindMap + maxState * UNWIND_MAP_ENTRY_SIZE > mem.length) {
        return actions;
    }

    let state = currentState;
    let safety = 0;
    while (state >= 0 && state < maxState && safety < 64) {
        safety++;
        const entryPtr = pUnwindMap + state * UNWIND_MAP_ENTRY_SIZE;
        if (entryPtr + UNWIND_MAP_ENTRY_SIZE > mem.length) break;

        const toState = dv.getInt32(entryPtr, true);
        const action = dv.getUint32(entryPtr + UNWIND_MAP_ACTION_OFF, true);
        actions.push({ fromState: state, toState, action });
        state = toState;
    }

    return actions;
}

/**
 * Read a null-terminated mangled type name from a TypeDescriptor.
 * TypeDescriptor layout (MSVC): +0 pVFTable, +4 spare, +8 name[]
 * Returns empty string on invalid pointer.
 */
function readTypeName(mem: Uint8Array, typeDescPtr: number): string {
    if (typeDescPtr < 0x1000 || typeDescPtr + 16 >= mem.length) return '';
    let name = '';
    for (let i = 0; i < 256; i++) {
        const off = typeDescPtr + 8 + i;
        if (off >= mem.length) break;
        const ch = mem[off];
        if (ch === 0) break;
        name += String.fromCharCode(ch);
    }
    return name;
}

/**
 * Check if a thrown exception type matches a catch handler's expected type.
 *
 * Parses the ThrowInfo → CatchableTypeArray → CatchableType[] chain and
 * compares mangled type names against the catch handler's TypeDescriptor.
 *
 * @param catchTypeDescPtr  HandlerType.pType (0 = catch(...), always matches)
 * @param pThrowInfo        _s__ThrowInfo pointer from _CxxThrowException
 * @returns  The matching CatchableType info, or null if no match.
 *
 * _s__ThrowInfo layout:
 *   +0  attributes (DWORD)
 *   +4  pmfnUnwind (pointer to unwind dtor, or 0)
 *   +8  pForwardCompat
 *   +12 pCatchableTypeArray
 *
 * CatchableTypeArray:
 *   +0  nTypes (int)
 *   +4  arrayOfTypes[nTypes] (pointers to CatchableType)
 *
 * CatchableType:
 *   +0  properties (DWORD)
 *   +4  pTypeDescriptor (TypeDescriptor*)
 *   +8  PMD.mdisp (int32 — displacement of this pointer)
 *   +12 PMD.pdisp (int32)
 *   +16 PMD.vdisp (int32)
 *   +20 sizeOrOffset (int32)
 *   +24 copyFunction (pointer, may be 0)
 */
function matchesThrowType(
    dv: DataView,
    mem: Uint8Array,
    catchTypeDescPtr: number,
    pThrowInfo: number,
): CatchableTypeMatch | null {
    // catch (...) — always matches
    if (catchTypeDescPtr === 0) {
        return { copyFunction: 0, sizeOrOffset: 0, thisDisplacement: 0 };
    }

    if (pThrowInfo < 0x1000 || pThrowInfo + 16 > mem.length) return null;

    // Read the catch handler's expected type name
    const catchTypeName = readTypeName(mem, catchTypeDescPtr);
    if (!catchTypeName) return null;

    // Parse ThrowInfo → CatchableTypeArray
    const pCatchableTypeArray = dv.getUint32(pThrowInfo + THROWINFO_CATCHABLE_ARRAY_OFF, true);
    if (pCatchableTypeArray < 0x1000 || pCatchableTypeArray + 4 > mem.length) return null;

    const nTypes = dv.getInt32(pCatchableTypeArray, true);
    if (nTypes <= 0 || nTypes > 128) return null;

    // Iterate through catchable types — the thrown object's type hierarchy
    for (let k = 0; k < nTypes; k++) {
        const ctPtrOffset = pCatchableTypeArray + CATCHABLE_ARRAY_FIRST_TYPE_OFF + k * 4;
        if (ctPtrOffset + 4 > mem.length) break;

        const pCatchableType = dv.getUint32(ctPtrOffset, true);
        if (pCatchableType < 0x1000 || pCatchableType + 28 > mem.length) continue;

        const throwTypeDescPtr = dv.getUint32(pCatchableType + CATCHABLE_TYPE_TYPEDESC_OFF, true);
        const throwTypeName = readTypeName(mem, throwTypeDescPtr);

        if (throwTypeName && throwTypeName === catchTypeName) {
            return {
                copyFunction: dv.getUint32(pCatchableType + 24, true),
                sizeOrOffset: dv.getInt32(pCatchableType + 20, true),
                thisDisplacement: dv.getInt32(pCatchableType + 8, true),
            };
        }
    }

    return null;
}

/**
 * Try to extract FuncInfo pointer from a VC7+ handler thunk.
 * Pattern: B8 xx xx xx xx E9/EB/...  (MOV EAX, imm32; JMP ...)
 */
function extractFuncInfoFromThunk(mem: Uint8Array, handlerAddr: number): number {
    if (handlerAddr < 0x1000 || handlerAddr + 10 >= mem.length) return 0;
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    // Fast path (VC7): bare thunk `mov eax, FuncInfo` (B8 imm32) at offset 0.
    if (mem[handlerAddr] === 0xB8) {
        return dv.getUint32(handlerAddr + 1, true);
    }
    // VC8 /GS-cookie thunk: a cookie-check preamble precedes the `mov eax, FuncInfo`, e.g.
    //   90 90; mov edx,[esp+8]; lea eax,[edx+0xc]; mov ecx,[edx-0x54]; xor ecx,eax;
    //   call __security_check_cookie; B8 <FuncInfo>; E9 <jmp __CxxFrameHandler3>
    // (typical patched engine DLL). Scan a small window for the `B8 imm32 E9` thunk tail whose
    // imm32 points at a struct with a valid MSVC EH magic — precise enough that a real
    // _except_handler4 function (no such tail) won't false-positive.
    for (let i = 1; i <= 32 && handlerAddr + i + 9 <= mem.length; i++) {
        if (mem[handlerAddr + i] !== 0xB8 || mem[handlerAddr + i + 5] !== 0xE9) continue;
        const candidate = dv.getUint32(handlerAddr + i + 1, true) >>> 0;
        if (candidate < 0x10000 || candidate + 4 > mem.length) continue;
        let magic = 0;
        try { magic = dv.getUint32(candidate, true) >>> 0; } catch { continue; }
        if (isMsvcEhMagic(magic)) return candidate;
    }
    return 0;
}

/**
 * Detect VC7+ simple funclet pattern: B8 xx xx xx xx C3 (MOV EAX, imm32; RET)
 * Returns the continuation address, or 0 if not a simple funclet.
 */
function detectSimpleFunclet(mem: Uint8Array, catchAddr: number): number {
    if (catchAddr + 6 > mem.length) return 0;
    if (mem[catchAddr] === 0xB8 && mem[catchAddr + 5] === 0xC3) {
        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        return dv.getUint32(catchAddr + 1, true);
    }
    return 0;
}

/**
 * Get the JMP EAX gadget address from the thunk memory manager.
 * Returns 0 if not available.
 */
function getJmpEaxGadget(): number {
    try {
        const system = System.getInstance();
        const regions = system.process?.dispatcher?.getThunkMemoryRegions?.();
        return regions?.jmpEaxGadgetAddress ?? 0;
    } catch {
        return 0;
    }
}

/**
 * Get the SEH catch-completion gadget address. Catch-funclet continuations jump here
 * (with EAX = continuation) so the dispatcher pops the thread's active exception on
 * NORMAL completion; a rethrowing funclet never reaches it. Returns 0 if unavailable
 * (callers then fall back to a bare JMP EAX / direct jump — no completion signal).
 */
function getCatchCompletionGadget(): number {
    try {
        const system = System.getInstance();
        const regions = system.process?.dispatcher?.getThunkMemoryRegions?.();
        return regions?.catchCompletionGadgetAddress ?? 0;
    } catch {
        return 0;
    }
}

/**
 * Get the SEH scratch stack top from ThunkMemoryRegions.
 * This is a pre-allocated 4KB stack in THUNK_DATA for funclet execution,
 * preventing funclet stack usage from overwriting exception data on the dead stack.
 * Returns 0 if not available.
 */
function getSehStackTop(): number {
    try {
        const system = System.getInstance();
        const regions = system.process?.dispatcher?.getThunkMemoryRegions?.();
        return regions?.sehStackTop ?? 0;
    } catch {
        return 0;
    }
}

/**
 * Try to match a catch handler in FuncInfo's try block map.
 *
 * @param isVC7 If true, catch handlers are funclets (need special dispatch)
 * @param isRethrow True when this dispatch is a `throw;` (affects exception-object lifetime)
 * @param pendingExitActions Deferred work from catch records exited earlier in THIS
 *        dispatch (catch-body local destructors, dying exception objects). Runs first
 *        in the generated trampoline — in the CRT these ran at rethrow-interception
 *        time, before the continued search found this frame.
 * @param innerOfCatch When set, only try blocks nested INSIDE the given catch body
 *        are considered (tryLow > tryHighAbove && tryHigh <= catchHighMax) — the
 *        CatchGuardHandler / _GetRangeOfTrysToCheck depth filter.
 */
function tryMatchCatch(
    dv: DataView,
    mem: Uint8Array,
    funcInfoPtr: number,
    trylevel: number,
    frameEbp: number,
    sehHead: number,
    stateOffset: number,
    tebAddr: number,
    next: number,
    pExceptionObject: number,
    pThrowInfo: number,
    cpu: any,
    thunkCleanupBytes: number,
    isVC7: boolean,
    skippedFrames: SkippedFrameInfo[],
    throwEsp: number,
    isRethrow: boolean,
    pendingExitActions: DispatchAction[],
    innerOfCatch?: { tryHighAbove: number; catchHighMax: number },
): ThunkResult | null {
    const nTryBlocks = dv.getUint32(funcInfoPtr + 12, true);
    const pTryBlockMap = dv.getUint32(funcInfoPtr + 16, true);
    if (nTryBlocks === 0 || pTryBlockMap < 0x10000) return null;

    Logger.log(LogCategory.SYSTEM,
        `  -> FuncInfo OK: nTryBlocks=${nTryBlocks} pTryBlockMap=0x${pTryBlockMap.toString(16)} trylevel=${trylevel}`);

    for (let i = 0; i < nTryBlocks && i < 32; i++) {
        const tBase = pTryBlockMap + i * 20;
        if (tBase + 20 > mem.length) break;

        const tryLow = dv.getInt32(tBase, true);
        const tryHigh = dv.getInt32(tBase + 4, true);
        const catchHigh = dv.getInt32(tBase + 8, true);
        const nCatches = dv.getInt32(tBase + 12, true);
        const pHandlerArray = dv.getUint32(tBase + 16, true);

        if (trylevel < tryLow || trylevel > tryHigh) continue;
        if (nCatches <= 0 || pHandlerArray < 0x10000) continue;
        // CatchGuard depth filter: while a catch funclet is executing, only try
        // blocks nested inside THAT catch body may handle a new exception here.
        if (innerOfCatch &&
            !(tryLow > innerOfCatch.tryHighAbove && tryHigh <= innerOfCatch.catchHighMax)) {
            continue;
        }

        for (let j = 0; j < nCatches && j < 16; j++) {
            const hBase = pHandlerArray + j * 16;
            if (hBase + 16 > mem.length) break;

            const adjectives = dv.getUint32(hBase + 0, true);
            const pType = dv.getUint32(hBase + 4, true); // TypeDescriptor* (0 = catch(...))
            const dispCatchObj = dv.getInt32(hBase + 8, true);
            const catchAddr = dv.getUint32(hBase + 12, true);
            if (catchAddr < 0x10000 || catchAddr >= mem.length) continue;

            // --- RTTI type matching ---
            const typeMatch = matchesThrowType(dv, mem, pType, pThrowInfo);
            if (!typeMatch) {
                // This catch block doesn't match the thrown type — skip to next
                const catchTypeName = pType ? readTypeName(mem, pType) : '(...)';
                Logger.log(LogCategory.SYSTEM,
                    `  -> catch[${j}] type "${catchTypeName}" does NOT match thrown type, skipping`);
                continue;
            }

            const catchModule = identifyModule(catchAddr);
            const handlerModule = identifyModule(dv.getUint32(sehHead + 4, true));
            const catchTypeName = pType ? readTypeName(mem, pType) : '(...)';
            // Record the outcome in the diagnostic ring (this throw was caught here).
            if (currentThrowRecord && currentThrowRecord.outcome === 'pending') {
                currentThrowRecord.outcome = 'caught';
                currentThrowRecord.caughtBy = (catchModule || '').replace(/^ \[|\]$/g, '') || 'unknown';
            }
            // A matched catch is normal control flow (MFC/STL/engine try-catch), so log
            // at SYSTEM (not warn) to keep the firehose quiet on the hot dispatch path.
            Logger.log(LogCategory.SYSTEM,
                `SEH dispatch: catch at 0x${catchAddr.toString(16)}${catchModule} ` +
                `type="${catchTypeName}" adj=0x${adjectives.toString(16)} ` +
                `frame=0x${sehHead.toString(16)} EBP=0x${frameEbp.toString(16)} ` +
                `throwEsp=0x${throwEsp.toString(16)} ` +
                `handler${handlerModule} try=${tryLow}-${tryHigh} trylevel=${trylevel} vc7=${isVC7}`);

            if (debugSession.isSehCaptureEnabled()) {
                debugSession.onSehDispatch('match', {
                    funcInfoPtr,
                    nTryBlocks,
                    pTryBlockMap,
                    tryIdx: i,
                    tryLow,
                    tryHigh,
                    catchHigh,
                    j,
                    hBase,
                    adjectives,
                    pType,
                    dispCatchObj: dispCatchObj | 0,
                    catchAddr,
                    catchTypeName,
                    frameEbp: frameEbp >>> 0,
                    sehHead,
                    trylevel,
                    isVC7,
                    pExceptionObject,
                    pThrowInfo,
                    throwEsp,
                    catchModule,
                    handlerModule,
                });
            }

            // State on catch entry: the CRT's CatchIt does SetState(TBME_HIGH + 1) —
            // the funclet body then advances the state itself as it constructs locals.
            // (Setting catchHigh here would over-state the frame and break the
            // exit-to-parent computation when the funclet rethrows.)
            guardStackWrite(sehHead + stateOffset, 4, 'seh:catchEntryState');
            dv.setInt32(sehHead + stateOffset, tryHigh + 1, true);

            // Write exception object to catch variable (EBP-relative offset)
            if (dispCatchObj !== 0) {
                const isReference = (adjectives & HT_IsReference) !== 0;
                const isSimple = (adjectives & HT_IsCompSimple) !== 0;

                if (isReference || pType === 0) {
                    // catch (T&) or catch (...): store pointer to exception object
                    const objPtr = pExceptionObject + typeMatch.thisDisplacement;
                    guardStackWrite(frameEbp + dispCatchObj, 4, 'seh:catchVarPtr', objPtr);
                    dv.setUint32(frameEbp + dispCatchObj, objPtr, true);
                } else if (isSimple || typeMatch.copyFunction === 0) {
                    // Simple type (int, enum, pointer) or no copy-ctor: memcpy
                    const srcAddr = pExceptionObject + typeMatch.thisDisplacement;
                    const destAddr = frameEbp + dispCatchObj;
                    const copySize = typeMatch.sizeOrOffset > 0 ? Math.min(typeMatch.sizeOrOffset, 256) : 4;
                    guardStackWrite(destAddr, copySize, 'seh:catchVarCopy');
                    for (let b = 0; b < copySize; b++) {
                        if (srcAddr + b < mem.length && destAddr + b < mem.length) {
                            mem[destAddr + b] = mem[srcAddr + b];
                        }
                    }
                } else {
                    // Complex type with copy-constructor — runs as a trampoline action
                    // (before the destructors, matching CatchIt's BuildCatchObject order).
                }
            }

            // Restore SEH chain to this frame's Next (rethrow/throw inside the catch now
            // resumes the walk ABOVE this catching frame, matching __CxxFrameHandler).
            dv.setUint32(tebAddr, next, true);

            // Saved try-entry ESP (PRN_STACK, [pRN-4]): _JumpToContinuation restores the
            // continuation ESP from this slot, NOT from pRN. Snapshot it now — the
            // completion handler restores it on exit (CallCatchBlock's __finally), since
            // a try nested inside the catch body overwrites it.
            const savedTryEsp = readSavedTryEsp(dv, mem, sehHead, throwEsp);
            const continuationEsp = savedTryEsp || sehHead;
            if (!savedTryEsp) {
                Logger.warn(LogCategory.SYSTEM,
                    `SEH dispatch: implausible saved try-ESP at [pRN-4] ` +
                    `(pRN=0x${sehHead.toString(16)}), continuation falls back to pRN`);
            }

            // --- Assemble the trampoline work list ---
            // CRT order: catch-exit unwinds deferred from records exited in this dispatch
            // (they ran at rethrow-interception time) → BuildCatchObject (copy-ctor) →
            // _UnwindNestedFrames (skipped frames' destructors) → __FrameUnwindToState
            // (catching frame's partial unwind down to the try's low state).
            const actions: DispatchAction[] = [];
            for (const a of pendingExitActions) actions.push(a);

            if (dispCatchObj !== 0) {
                const isReference = (adjectives & HT_IsReference) !== 0;
                const isSimple = (adjectives & HT_IsCompSimple) !== 0;
                if (!isReference && !isSimple && pType !== 0 && typeMatch.copyFunction !== 0) {
                    actions.push({
                        kind: 'copyCtor',
                        fn: typeMatch.copyFunction,
                        src: pExceptionObject + typeMatch.thisDisplacement,
                        dst: frameEbp + dispCatchObj,
                    });
                }
            }

            // Destructors from skipped intermediate frames (throw→catch order); mark
            // each frame fully unwound (re-entrancy safety).
            for (const sf of skippedFrames) {
                if (sf.isVC7) {
                    guardStackWrite(sf.sehHead + 8, 4, 'seh:markUnwound');
                    dv.setInt32(sf.sehHead + 8, -1, true);
                } else {
                    guardStackWrite(sf.sehHead + 12, 4, 'seh:markUnwound');
                    dv.setInt32(sf.sehHead + 12, -1, true);
                }
                for (const act of sf.unwindActions) {
                    if (act.action !== 0) {
                        actions.push({ kind: 'dtor', fn: act.action, frameEbp: sf.frameEbp });
                    }
                }
            }

            // Catching frame's own partial unwind: trylevel → tryLow (CRT:
            // __FrameUnwindToState(pEstablisher, TBME_LOW) — destroys everything
            // constructed after try entry). __sehNoCatchFrameUnwind reverts to the
            // old behavior (which unwound to catchHigh, i.e. collected nothing).
            if (!(globalThis as Record<string, unknown>).__sehNoCatchFrameUnwind) {
                for (const act of collectUnwindActionsTo(dv, mem, funcInfoPtr, trylevel, tryLow)) {
                    if (act.action !== 0) {
                        actions.push({ kind: 'dtor', fn: act.action, frameEbp });
                    }
                }
            }

            // --- Choose the dispatch variant & emit the trampoline ---
            const completionGadget = getCatchCompletionGadget();
            const gadget = completionGadget || getJmpEaxGadget();
            // Records (and the coupled active-exception entry) are pushed only when
            // the completion gadget exists to pop them on normal funclet return.
            let recordCatch = false;
            const plan: CatchDispatchPlan = { actions, throwEsp, thunkCleanupBytes };
            if (isVC7) {
                const simpleContinuation = detectSimpleFunclet(mem, catchAddr);
                recordCatch = completionGadget !== 0;
                if (simpleContinuation && gadget) {
                    // Trivial catch body (`mov eax, cont; ret`): skip the funclet, jump
                    // straight to the continuation through the completion gadget.
                    plan.direct = {
                        target: simpleContinuation, ebp: frameEbp, esp: continuationEsp,
                        viaGadgetEax: true, gadget,
                    };
                } else if (gadget) {
                    plan.funclet = {
                        addr: catchAddr, catchEbp: frameEbp, continuationEsp, gadget,
                    };
                } else {
                    Logger.error(LogCategory.SYSTEM,
                        `SEH dispatch: complex funclet but no gadget available — direct jump fallback`);
                    recordCatch = false;
                    plan.direct = {
                        target: catchAddr, ebp: frameEbp, esp: continuationEsp,
                        viaGadgetEax: false, gadget: 0,
                    };
                }
            } else {
                // VC5/6 inline handler: catch code is inline in the function (no funclet
                // return contract, no completion signal). ESP heuristic (= pRN) kept —
                // [pRN-4] validity is unknown for frames established through our shared
                // _EH_prolog stub.
                plan.direct = {
                    target: catchAddr, ebp: frameEbp, esp: sehHead,
                    viaGadgetEax: false, gadget: 0,
                };
            }

            logSkippedFrameUnwindDiagnostics(
                skippedFrames, actions.some(a => a.kind === 'dtor'));

            const emitted = emitCatchDispatch(dv, mem, cpu, plan);
            if (!emitted) {
                // The descent window below throwEsp is not committed writable memory —
                // deeply pathological (throw at the very bottom of a guard page).
                // Legacy direct plant without destructors, so the game at least reaches
                // the handler.
                Logger.error(LogCategory.SYSTEM,
                    `SEH dispatch: descent window below throwEsp=0x${throwEsp.toString(16)} ` +
                    `unwritable — legacy direct plant, ${actions.length} action(s) dropped`);
                const fallbackTarget = plan.direct ? plan.direct.target : catchAddr;
                const adjustedEsp = sehHead - 4 - thunkCleanupBytes;
                cpu.reg32[5] = frameEbp;
                cpu.reg32[4] = adjustedEsp;
                guardStackWrite(adjustedEsp, 4, 'seh:legacyPlant', fallbackTarget);
                dv.setUint32(adjustedEsp, fallbackTarget, true);
                return { value: 0, skipStackCheck: true };
            }

            if (recordCatch) {
                // Enter the catch: the exception becomes the thread's current exception
                // for the duration of the catch body (CallCatchBlock saves/sets
                // _pCurrentException), popped together with the record on completion or
                // on a throw that exits the catch. Never cleared on entry — UE's
                // `unguard` bare `throw;` chains depend on it.
                setActiveException(tebAddr, pExceptionObject, pThrowInfo);
                pushCatchRecord(tebAddr, {
                    pRN: sehHead, savedTryEsp, catchEbp: frameEbp, funcInfoPtr, stateOffset,
                    tryLow, tryHigh, catchHigh, pExceptionObject, pThrowInfo, catchAddr,
                    stubHome: emitted.stubHome, scratchEsp: emitted.scratchEsp,
                    continuationEsp, seq: currentThrowRecord?.seq ?? 0,
                });
            }

            Logger.warn(LogCategory.SYSTEM,
                `SEH dispatch: catch entry via ${plan.funclet ? 'funclet' : 'direct'} trampoline ` +
                `at 0x${emitted.codeBase.toString(16)} actions=${actions.length} ` +
                `contEsp=0x${continuationEsp.toString(16)} record=${recordCatch} ` +
                `(cleanup=${thunkCleanupBytes})`);

            // Post-mortem trace: window [scratchEsp, throwEsp) = everything this dispatch
            // wrote/executed below the throw point (trampoline, stub home, retSlot, scratch).
            const planEsp = plan.funclet ? plan.funclet.continuationEsp : plan.direct!.esp;
            recordSehDispatchTrace(
                `#${currentThrowRecord?.seq ?? 0} T${currentThrowRecord?.threadId ?? '?'} ` +
                `${plan.funclet ? 'funclet' : 'direct'} catch=0x${catchAddr.toString(16)}${catchModule} ` +
                `pRN=0x${sehHead.toString(16)} ebp=0x${frameEbp.toString(16)} ` +
                `contEsp=0x${planEsp.toString(16)}${savedTryEsp ? '' : '(FALLBACK=pRN)'} ` +
                `win=[0x${emitted.scratchEsp.toString(16)},0x${throwEsp.toString(16)}) ` +
                `code=0x${emitted.codeBase.toString(16)} actions=${actions.length} cleanup=${thunkCleanupBytes}`,
                {
                    seq: currentThrowRecord?.seq ?? 0,
                    tid: currentThrowRecord?.threadId ?? 0,
                    lo: emitted.scratchEsp >>> 0,
                    hi: throwEsp >>> 0,
                },
            );

            if (debugSession.isSehCaptureEnabled()) {
                debugSession.onSehDispatch('dispatch-emit', {
                    codeBase: emitted.codeBase,
                    stubHome: emitted.stubHome,
                    scratchEsp: emitted.scratchEsp,
                    throwEsp,
                    continuationEsp,
                    savedTryEsp,
                    actionCount: actions.length,
                    variant: plan.funclet ? 'funclet' : 'direct',
                    recordCatch,
                    catchAddr,
                    frameEbp: frameEbp >>> 0,
                    thunkCleanupBytes,
                    dispCatchObj: dispCatchObj | 0,
                    catchTypeName,
                });
            }
            return emitted.result;
        }
    }
    return null;
}

/**
 * Identify which loaded module an address belongs to (for diagnostics).
 */
function identifyModule(addr: number): string {
    try {
        const reg = System.getInstance().process?.moduleRegistry;
        if (!reg) return '';
        const mod = reg.getModuleContainingAddress(addr);
        if (mod) return ` [${mod.name}${mod.isRealDll ? ' (native)' : ''}]`;
    } catch { /* */ }
    return '';
}

/**
 * Collect a frame's unwind actions from `fromState` down to (excluding) `targetState`,
 * following the unwind-map toState chain — the CRT's __FrameUnwindToState:
 * `while (curState != targetState) { nxt = toState; if (action) run; cur = nxt; }`.
 * Used for the catching frame's partial unwind on catch entry (target = tryLow) and
 * for the catch's own exit-to-parent unwind on rethrow/throw out of a catch body.
 */
function collectUnwindActionsTo(
    dv: DataView,
    mem: Uint8Array,
    funcInfoPtr: number,
    fromState: number,
    targetState: number,
): UnwindAction[] {
    const result: UnwindAction[] = [];
    if (fromState < 0 || fromState === targetState) return result;

    const maxState = dv.getInt32(funcInfoPtr + FUNCINFO_MAX_STATE_OFF, true);
    const pUnwindMap = dv.getUint32(funcInfoPtr + FUNCINFO_UNWIND_MAP_OFF, true);
    if (maxState <= 0 || pUnwindMap < 0x10000 || pUnwindMap + maxState * UNWIND_MAP_ENTRY_SIZE > mem.length) {
        return result;
    }

    let state = fromState;
    let safety = 0;
    while (state >= 0 && state !== targetState && state < maxState && safety < 64) {
        safety++;
        const entryPtr = pUnwindMap + state * UNWIND_MAP_ENTRY_SIZE;
        if (entryPtr + UNWIND_MAP_ENTRY_SIZE > mem.length) break;

        const toState = dv.getInt32(entryPtr, true);
        const action = dv.getUint32(entryPtr + UNWIND_MAP_ACTION_OFF, true);
        if (action !== 0) {
            result.push({ fromState: state, toState, action });
        }
        state = toState;
    }

    return result;
}

/**
 * The state a catch's frame unwinds to when the catch body is exited by a throw —
 * the CRT's CallCatchBlock __except(ExFilterRethrow) block: find the try block whose
 * catch range contains the live state (tryHigh < s <= catchHigh, innermost first in
 * map order), then take unwindMap[tryHigh+1].toState (the parent of the catch-entry
 * state). Returns `liveState` unchanged when it isn't inside a recognizable catch.
 */
function computeCatchExitTargetState(
    dv: DataView,
    mem: Uint8Array,
    funcInfoPtr: number,
    liveState: number,
): number {
    if (liveState < 0) return liveState;
    const maxState = dv.getInt32(funcInfoPtr + FUNCINFO_MAX_STATE_OFF, true);
    const pUnwindMap = dv.getUint32(funcInfoPtr + FUNCINFO_UNWIND_MAP_OFF, true);
    const nTryBlocks = dv.getUint32(funcInfoPtr + 12, true);
    const pTryBlockMap = dv.getUint32(funcInfoPtr + 16, true);
    if (maxState <= 0 || pUnwindMap < 0x10000 || nTryBlocks === 0 || pTryBlockMap < 0x10000) {
        return liveState;
    }
    for (let i = 0; i < nTryBlocks && i < 32; i++) {
        const tBase = pTryBlockMap + i * 20;
        if (tBase + 20 > mem.length) break;
        const tryHigh = dv.getInt32(tBase + 4, true);
        const catchHigh = dv.getInt32(tBase + 8, true);
        if (liveState > tryHigh && liveState <= catchHigh) {
            const catchEntryState = tryHigh + 1;
            if (catchEntryState >= 0 && catchEntryState < maxState) {
                const entryPtr = pUnwindMap + catchEntryState * UNWIND_MAP_ENTRY_SIZE;
                if (entryPtr + UNWIND_MAP_ENTRY_SIZE <= mem.length) {
                    return dv.getInt32(entryPtr, true);
                }
            }
        }
    }
    return liveState;
}

/**
 * Everything the catch-entry trampoline must do, in one plan:
 * deferred exit-unwinds + copy-ctor + destructors (`actions`), then either CALL a
 * catch funclet and _JumpToContinuation through the completion gadget (`funclet`)
 * or jump to an inline handler / known continuation (`direct`).
 */
interface CatchDispatchPlan {
    actions: DispatchAction[];
    throwEsp: number;
    thunkCleanupBytes: number;
    funclet?: { addr: number; catchEbp: number; continuationEsp: number; gadget: number };
    direct?: { target: number; ebp: number; esp: number; viaGadgetEax: boolean; gadget: number };
}

/** Reserved bytes for the completion-time exception-object destructor stub. */
const DTOR_STUB_HOME_SIZE = 36;

/**
 * Emit the unified catch-entry trampoline in the DESCENT WINDOW below throwEsp —
 * the region the real x86 CRT dispatch itself descends through (RaiseException →
 * ntdll dispatcher → frame handler → CallCatchBlock → funclet all execute below the
 * throw point on the same thread stack). Everything below throwEsp is dead:
 * the thrown object and both frames' live locals sit ABOVE it.
 *
 * Layout (addresses decrease downward):
 *   [throwEsp)                       ← ESP at throw; dead space starts below
 *   [stubHome .. +36)                ← completion-time dtor stub home (patched later)
 *   [codeBase .. codeBase+codeSize)  ← trampoline code
 *   [retSlot]                        ← thunk RET N pops this into EIP (= codeBase)
 *   [scratchEsp]                     ← execution ESP for actions + funclet (descends)
 *
 * NEVER place trampoline code near the catching frame's registration node — that
 * region is the frame's LIVE LOCALS; destructors and the funclet write them via
 * [EBP-x] and shred the code mid-flight (the historical Max Payne wild-EIP crash).
 *
 * Returns null when the window is not committed writable memory.
 */
function emitCatchDispatch(
    dv: DataView,
    mem: Uint8Array,
    cpu: any,
    plan: CatchDispatchPlan,
): { result: ThunkResult; codeBase: number; stubHome: number; scratchEsp: number } | null {
    const bodySize = plan.funclet
        ? 25 // MOV EBP + CALL funclet + MOV ESP + MOV EBP + JMP gadget
        : 10 + (plan.direct!.viaGadgetEax ? 10 : 5); // MOV EBP + MOV ESP + (MOV EAX + JMP | JMP)
    const codeSize = 5 + actionsSize(plan.actions) + bodySize; // 5 = leading MOV ESP
    const stubHome = ((plan.throwEsp - 8 - DTOR_STUB_HOME_SIZE) >>> 0) & ~3;
    const codeBase = ((stubHome - codeSize) >>> 0) & ~3;
    const retSlot = ((codeBase - 8 - plan.thunkCleanupBytes) >>> 0) & ~3;
    const scratchEsp = ((retSlot - 32) >>> 0) & ~15;

    if (scratchEsp < 0x1000 || plan.throwEsp > mem.length) return null;
    try {
        const as = System.getInstance().process?.addressSpace as
            { validateRange?: (a: number, s: number, p: string) => boolean } | undefined;
        if (as?.validateRange &&
            !as.validateRange(scratchEsp >>> 0, (plan.throwEsp - scratchEsp) >>> 0, 'rw')) {
            return null;
        }
    } catch { /* early boot — accept */ }

    // Tripwire: the whole descent window belongs to the CURRENT thread's dead zone.
    // Hitting a parked thread's live stack = wrong throwEsp/thread mixup — corruption.
    guardStackWrite(scratchEsp, (plan.throwEsp - scratchEsp) >>> 0, 'seh:dispatchWindow');

    const e = new X86Emit(dv, codeBase);
    e.movEspImm(scratchEsp);
    emitActions(e, plan.actions);
    if (plan.funclet) {
        // _CallSettingFrame: EBP = pRN + FRAME_OFFSET, CALL funclet (returns the
        // continuation in EAX); then _JumpToContinuation: ESP = [pRN-4], EBP =
        // pRN + FRAME_OFFSET, jump through the completion gadget (OUT → dispatcher
        // pops the record/active exception, may chain the object dtor → JMP EAX).
        e.movEbpImm(plan.funclet.catchEbp);
        e.callAbs(plan.funclet.addr);
        e.movEspImm(plan.funclet.continuationEsp);
        e.movEbpImm(plan.funclet.catchEbp);
        e.jmpAbs(plan.funclet.gadget);
    } else {
        const d = plan.direct!;
        e.movEbpImm(d.ebp);
        e.movEspImm(d.esp);
        if (d.viaGadgetEax) {
            e.movEaxImm(d.target);
            e.jmpAbs(d.gadget);
        } else {
            e.jmpAbs(d.target);
        }
    }
    e.commit();

    // Thunk RET N lands here: EIP = [retSlot] = codeBase, ESP = retSlot+4+N (< codeBase,
    // irrelevant — the first trampoline instruction re-bases ESP).
    dv.setUint32(retSlot, codeBase >>> 0, true);
    cpu.reg32[4] = retSlot;

    return {
        result: {
            value: 0,
            skipStackCheck: true,
            sehTrampoline: { base: codeBase, end: codeBase + e.size() },
        },
        codeBase,
        stubHome,
        scratchEsp,
    };
}

/**
 * SEH catch-completion hypercall (the gadget's OUT fired: a catch funclet returned a
 * non-NULL continuation). Mirrors CallCatchBlock's __finally on the NORMAL path:
 *   - pop the active-catch record + the active-exception entry it owns,
 *   - restore PRN_STACK ([pRN-4] = saved try-entry ESP) — an inner try inside the
 *     catch body overwrites the slot,
 *   - destroy the exception object (ThrowInfo.pmfnUnwind, __thiscall) iff this catch
 *     was its last user (CRT IsExceptionObjectToBeDestroyed) — by patching the
 *     gadget's saved-EAX slot to a stub that runs the destructor on the (now dead)
 *     dispatch scratch stack and then resumes the continuation.
 *
 * At the OUT instruction the gadget has done `push eax`, so [ESP] holds the
 * continuation address and ESP+4 is the ESP the continuation will resume on.
 */
export function sehOnCatchCompletion(cpu: any): void {
    const tebAddr = (cpu.segment_offsets?.[4] ?? 0) >>> 0;
    if (!tebAddr) return;
    const rec = popCatchRecord(tebAddr);
    clearActiveException(tebAddr);
    if (!rec) return; // legacy entry (no record was pushed) — nothing more to do

    let mem: Uint8Array | null = null;
    try {
        const sys = System.getInstance();
        mem = (sys.process as unknown as { getMemory?: () => Uint8Array })?.getMemory?.() ?? null;
    } catch { /* */ }
    if (!mem) return;
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    // Restore PRN_STACK (CallCatchBlock's __finally: PRN_STACK(pRN) = saveESP).
    if (rec.savedTryEsp && rec.pRN >= 4 && rec.pRN + 4 <= mem.length) {
        guardStackWrite((rec.pRN - 4) >>> 0, 4, 'seh:prnStackRestore', rec.savedTryEsp);
        dv.setUint32((rec.pRN - 4) >>> 0, rec.savedTryEsp >>> 0, true);
    }

    // RELINK the catching frame. Catch entry sets FS:[0] to the frame's `next` so a throw
    // from INSIDE the catch body resumes above it (__CxxFrameHandler gets that from the
    // frame's state, we get it by unlinking). That unlink is only valid for the duration of
    // the catch body: the function keeps running afterwards, and MSVC never removes a live
    // frame's registration. Leaving it out means every LATER throw from another try block of
    // the same function finds no handler — Serious Sam caught its Controls/ConsoleHistory
    // opens and then died on the next one because CGame::InitInternal was no longer on the
    // chain. Only undo OUR OWN unlink: relink when the head is still exactly this frame's
    // next, so a try registered deeper since is never clobbered.
    if (rec.pRN >= 0x1000 && rec.pRN + 4 <= mem.length) {
        const frameNext = dv.getUint32(rec.pRN, true) >>> 0;
        const head = dv.getUint32(tebAddr, true) >>> 0;
        if (head === frameNext) {
            dv.setUint32(tebAddr, rec.pRN >>> 0, true);
        }
    }

    if ((globalThis as Record<string, unknown>).__sehNoObjDtor) return;
    const pmfnUnwind = readThrowInfoUnwindFunc(dv, mem, rec.pThrowInfo);
    if (!pmfnUnwind || !rec.pExceptionObject || !rec.stubHome || !rec.scratchEsp) return;
    if (isExceptionObjectReferenced(tebAddr, rec.pExceptionObject)) return;

    const esp = cpu.reg32[4] >>> 0;
    if (esp < 4 || esp + 4 > mem.length) return;
    const continuation = dv.getUint32(esp, true) >>> 0;
    if (continuation < 0x1000 || continuation >= mem.length) return;
    if (rec.stubHome + DTOR_STUB_HOME_SIZE > mem.length) return;

    // Stub (runs after the gadget's `pop eax; jmp eax`, ESP back at continuation ESP):
    //   MOV ESP, scratchEsp   — descend into the dead dispatch window for the dtor call
    //   MOV ECX, obj          — __thiscall this
    //   CALL pmfnUnwind
    //   MOV ESP, contEsp      — back to the continuation ESP
    //   MOV EBP, catchEbp     — the dtor may have clobbered EBP
    //   MOV EAX, continuation — real CRT leaves EAX = target after _JumpToContinuation
    //   JMP EAX
    const contEsp = (esp + 4) >>> 0;
    guardStackWrite(rec.stubHome, DTOR_STUB_HOME_SIZE, 'seh:completionStub');
    const e = new X86Emit(dv, rec.stubHome);
    e.movEspImm(rec.scratchEsp);
    e.movEcxImm(rec.pExceptionObject);
    e.callAbs(pmfnUnwind);
    e.movEspImm(contEsp);
    e.movEbpImm(rec.catchEbp);
    e.movEaxImm(continuation);
    e.jmpEax();
    e.commit();
    guardStackWrite(esp, 4, 'seh:completionEaxPatch', rec.stubHome);
    dv.setUint32(esp, rec.stubHome >>> 0, true); // gadget pops this into EAX → jmp stub

    recordSehDispatchTrace(
        `#${rec.seq} completion: objDtor=0x${pmfnUnwind.toString(16)} obj=0x${rec.pExceptionObject.toString(16)} ` +
        `stub=0x${rec.stubHome.toString(16)} cont=0x${continuation.toString(16)} contEsp=0x${contEsp.toString(16)}`);

    Logger.warn(LogCategory.SYSTEM,
        `SEH completion: destroying exception object 0x${rec.pExceptionObject.toString(16)} ` +
        `via pmfnUnwind=0x${pmfnUnwind.toString(16)} (stub at 0x${rec.stubHome.toString(16)}, ` +
        `continuation 0x${continuation.toString(16)})`);
}

/**
 * Pop (and clean up) catch records whose frames are being unwound past by a
 * non-C++ unwind (RtlUnwind / longjmp) targeting `targetFrame`. Frames strictly
 * below the target are torn down, so any catch record registered on them can never
 * complete — restore PRN_STACK and drop the record + its active-exception entry
 * (the CRT equivalent: CallCatchBlock's __finally runs during RtlUnwind).
 */
function sweepCatchRecordsBelowFrame(
    dv: DataView,
    mem: Uint8Array,
    tebAddr: number,
    targetFrame: number,
): void {
    const stack = activeCatchRecords.get(tebAddr);
    if (!stack) return;
    while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if ((top.pRN >>> 0) >= (targetFrame >>> 0)) break;
        if (top.savedTryEsp && top.pRN >= 4 && top.pRN + 4 <= mem.length) {
            dv.setUint32((top.pRN - 4) >>> 0, top.savedTryEsp >>> 0, true);
        }
        stack.pop();
        clearActiveException(tebAddr);
        Logger.warn(LogCategory.SYSTEM,
            `SEH unwind: catch record pRN=0x${top.pRN.toString(16)} swept by ` +
            `RtlUnwind/longjmp to 0x${targetFrame.toString(16)}`);
    }
    if (stack.length === 0) activeCatchRecords.delete(tebAddr);
}


/**
 * Log diagnostics for all SEH frames that were skipped (no catch match)
 * on the way to a matching catch handler. Shows unwind map entries
 * with destructor addresses that we're NOT executing.
 */
function logSkippedFrameUnwindDiagnostics(skippedFrames: SkippedFrameInfo[], executedDestructors: boolean): void {
    if (skippedFrames.length === 0) return;

    const destructorFrames = skippedFrames.filter(
        f => f.unwindActions.some(a => a.action !== 0)
    );

    if (destructorFrames.length === 0) {
        Logger.log(LogCategory.SYSTEM,
            `[SEH-UNWIND] ${skippedFrames.length} intermediate frame(s) skipped, none have destructors`);
        return;
    }

    if (executedDestructors) {
        Logger.log(LogCategory.SYSTEM,
            `[SEH-UNWIND] ${destructorFrames.length} frame(s) with destructors — trampoline will execute them`);
        return;
    }

    Logger.warn(LogCategory.SYSTEM,
        `[SEH-UNWIND] WARNING: ${destructorFrames.length} of ${skippedFrames.length} skipped frame(s) have MISSED DESTRUCTORS:`);

    for (const frame of destructorFrames) {
        const handlerModule = identifyModule(frame.handlerAddr);
        Logger.warn(LogCategory.SYSTEM,
            `[SEH-UNWIND]   Frame 0x${frame.sehHead.toString(16)} ` +
            `handler=0x${frame.handlerAddr.toString(16)}${handlerModule} ` +
            `${frame.isVC7 ? 'VC7+' : 'VC5/6'} state=${frame.state} ` +
            `EBP=0x${frame.frameEbp.toString(16)} FuncInfo=0x${frame.funcInfoPtr.toString(16)}`);

        for (const act of frame.unwindActions) {
            const actionModule = act.action !== 0 ? identifyModule(act.action) : '';
            const tag = act.action !== 0 ? 'DESTRUCTOR' : 'no-op';
            Logger.warn(LogCategory.SYSTEM,
                `[SEH-UNWIND]     state ${act.fromState} -> ${act.toState}: ` +
                `${tag} action=0x${act.action.toString(16)}${actionModule}`);
        }
    }
}

/**
 * Evaluate an SEH filter function statically by reading its bytes.
 * Returns 1 (EXECUTE_HANDLER), 0 (CONTINUE_SEARCH), -1 (CONTINUE_EXECUTION),
 * or null if the filter is too complex to evaluate statically.
 *
 * Only handles trivial catch-all patterns. Complex filters return null.
 */
export function evaluateSimpleFilter(
    mem: Uint8Array,
    filterAddr: number,
    memLength: number,
    exceptionCode: number = 0xC0000005,
): number | null {
    if (filterAddr + 6 > memLength) return null;

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

    // Pattern 3: GetExceptionCode() comparison:
    //   MOV EAX,[EBP-14h]; MOV EAX,[EAX]; MOV EAX,[EAX];
    //   CMP EAX,imm32; SETE AL; MOVZX EAX,AL; RET
    if (filterAddr + 19 <= memLength &&
        mem[filterAddr] === 0x8B && mem[filterAddr + 1] === 0x45 && mem[filterAddr + 2] === 0xEC &&
        mem[filterAddr + 3] === 0x8B && mem[filterAddr + 4] === 0x00 &&
        mem[filterAddr + 5] === 0x8B && mem[filterAddr + 6] === 0x00 &&
        mem[filterAddr + 7] === 0x3D &&
        mem[filterAddr + 12] === 0x0F && mem[filterAddr + 13] === 0x94 && mem[filterAddr + 14] === 0xC0 &&
        mem[filterAddr + 15] === 0x0F && mem[filterAddr + 16] === 0xB6 && mem[filterAddr + 17] === 0xC0 &&
        mem[filterAddr + 18] === 0xC3) {
        const cmpImm = (mem[filterAddr + 8] | (mem[filterAddr + 9] << 8) |
            (mem[filterAddr + 10] << 16) | (mem[filterAddr + 11] << 24)) >>> 0;
        return (exceptionCode >>> 0) === cmpImm ? 1 : 0;
    }

    // Pattern 4: VC6-style "_XcptFilter(GetExceptionCode(), GetExceptionInformation())"
    if (filterAddr + 20 <= memLength &&
        mem[filterAddr] === 0x8B && mem[filterAddr + 1] === 0x45 && mem[filterAddr + 2] === 0xEC &&
        mem[filterAddr + 3] === 0x8B && mem[filterAddr + 4] === 0x08 &&
        mem[filterAddr + 5] === 0x8B && mem[filterAddr + 6] === 0x09 &&
        mem[filterAddr + 10] === 0x50 && mem[filterAddr + 11] === 0x51 &&
        mem[filterAddr + 12] === 0xE8 &&
        mem[filterAddr + 17] === 0x59 && mem[filterAddr + 18] === 0x59 &&
        mem[filterAddr + 19] === 0xC3) {
        const code = exceptionCode >>> 0;
        if (code === 0x80000003 || code === 0x80000004) return -1;
        if ((code & 0xC0000000) === 0xC0000000) return 1;
        return 0;
    }

    return null; // Too complex
}

/**
 * The unwind pass of RtlUnwind: walk the SEH chain from FS:[0] to targetFrame and call
 * EVERY frame's registered handler with EH_UNWINDING, via an x86 trampoline on the dead
 * stack below the RtlUnwind frame.
 *
 * "Every frame's handler" is the whole contract (Wine __regs_RtlUnwind, NT RtlUnwind) and
 * the reason we do not classify frames here. An EXCEPTION_REGISTRATION_RECORD is exactly
 * two fields; everything from +8 on belongs to whoever registered it, so reading a scope
 * table and a trylevel out of those words only ever produces a GUESS — and two saved
 * callee-saved registers satisfy that guess as readily as a real scope table. Running the
 * __finally funclets ourselves for frames that pass it means the frame's real handler never
 * runs, which is invisible for MSVC (we imitate what _except_handler3 would have done) and
 * fatal for anyone else: LuaJIT registers lj_err_unwind_win on every cframe and pops its
 * internal C frames ONLY on this pass, so a skipped frame leaves the VM running on frames
 * that no longer exist. Calling _except_handler3 — the app's own or our HLE one — does the
 * local unwind for MSVC frames anyway, so there is nothing to imitate.
 *
 * Trampoline layout (dead stack below ctx_esp):
 *   MOV ESP, sehStackTop       ; 5  — safe stack so CALL return addrs stay off the guest's
 *   { PUSH 0 / ctx / frame / rec ; CALL handler ; ADD ESP,16 ; MOV [teb],frame->next } × N
 *   MOV [tebAddr], finalHead   ; 10 — re-confirm the end state
 *   MOV EAX, returnValue       ; 5
 *   MOV ESP, callerEsp         ; 5  — restore caller's ESP (after stdcall cleanup)
 *   JMP retAddr                ; 5  — rel32 jump to return address
 *
 * Returns ThunkResult with skipStackCheck=true if a trampoline was generated, or null when
 * there is nothing between FS:[0] and targetFrame (caller returns normally).
 *
 * @param ctx_esp   ESP captured at thunk entry (ctx.esp from ThunkImplementation)
 * @param thunkCleanupBytes  RET N value for this thunk's stub (16 for RtlUnwind)
 */
export function dispatchUnwindPass(
    mem: Uint8Array,
    cpu: any,
    ctx_esp: number,
    tebAddr: number,
    targetFrame: number,
    returnValue: number,
    thunkCleanupBytes: number,
    excRecPtr: number = 0,
): ThunkResult | null {
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    // Every frame strictly below targetFrame is gone once this pass completes, so a catch
    // funclet registered on one of them can never complete — drop its record. The boundary
    // covers targetFrame's own records too: RtlUnwind is called BY the catching handler, so
    // the funclet that is about to run pushes its record after this point, not before it.
    if (targetFrame !== 0 && targetFrame !== 0xFFFFFFFF) {
        sweepCatchRecordsBelowFrame(dv, mem, tebAddr, (targetFrame + 1) >>> 0);
    }

    // Unwind-order work list (innermost → outermost): one entry per frame, each of which
    // gets its own registered handler called with EH_UNWINDING. See the header comment for
    // why there is no second, "we know better than the frame" shape here.
    interface UnwindStep { handler: number; frame: number; next: number }
    const steps: UnwindStep[] = [];

    let frame = dv.getUint32(tebAddr, true) >>> 0;
    let frameCount = 0;
    /** Set when the walk stopped on something wrong with the chain rather than on the
     *  target. `frame` is then a cycle member, an out-of-bounds pointer or a frame past
     *  the target — none of which may become the new FS:[0]. */
    let aborted = false;
    const visitedFrames = new Set<number>();
    recordSehUnwindTrace(`unwind head=0x${frame.toString(16)} target=0x${targetFrame.toString(16)} ` +
        `excRec=0x${excRecPtr.toString(16)}`);
    while (frame !== 0xFFFFFFFF && frame !== 0 && frame !== targetFrame && frameCount < 64) {
        if (visitedFrames.has(frame)) {
            Logger.error(LogCategory.SYSTEM,
                `[SEH-UNWIND] cycle detected at frame 0x${frame.toString(16)} — breaking`);
            aborted = true;
            break;
        }
        visitedFrames.add(frame);
        frameCount++;
        if (frame + 16 > mem.length) { aborted = true; break; }

        // Stacks grow down, so an outer frame always sits at a HIGHER address. Walking past
        // the target means the target was never on this chain — Windows raises
        // STATUS_INVALID_UNWIND_TARGET rather than unwinding everything. Stop instead of
        // raising (a bad guess here would kill the process), but say so: silently unwinding
        // the whole chain is how a wrong target turns into a corruption nobody can trace.
        if (targetFrame !== 0 && targetFrame !== 0xFFFFFFFF && frame > targetFrame) {
            recordSehUnwindTrace(`  => STOPPED: frame 0x${frame.toString(16)} is past ` +
                `target 0x${targetFrame.toString(16)} (invalid unwind target)`);
            Logger.warn(LogCategory.SYSTEM,
                `[SEH-UNWIND] frame 0x${frame.toString(16)} is past target ` +
                `0x${targetFrame.toString(16)} — stopping, target is not on this chain`);
            aborted = true;
            break;
        }

        const next = dv.getUint32(frame, true) >>> 0;
        const handlerWord = dv.getUint32(frame + 4, true) >>> 0;
        // A BOUNDS test, not an executability one — and it cannot be more than that: PE
        // images are registered "r" in the region map (THUNK_CODE is the only "rx"
        // bucket), so asking isValidAddress for 'rx' would reject the game's own
        // __except_handler3 and disable SEH wholesale. Say what is actually checked.
        const usable = handlerWord >= 0x10000 && handlerWord < mem.length;
        recordSehUnwindTrace(`  frame=0x${frame.toString(16)} handler=0x${handlerWord.toString(16)}` +
            `${identifyModule(handlerWord)} => ${usable ? "unwind pass" : "UNUSABLE handler (out of range) — skipped"}`);
        if (usable) {
            steps.push({ handler: handlerWord, frame, next });
            Logger.log(LogCategory.SYSTEM,
                `[SEH-UNWIND] frame=0x${frame.toString(16)} handler=0x${handlerWord.toString(16)}` +
                `${identifyModule(handlerWord)} — unwind pass`);
        } else {
            Logger.warn(LogCategory.SYSTEM,
                `[SEH-UNWIND] frame=0x${frame.toString(16)} handler=0x${handlerWord.toString(16)} ` +
                `out of range — skipping its unwind pass`);
        }

        frame = next;
    }
    if (frameCount >= 64 && frame !== targetFrame) {
        recordSehUnwindTrace(`  => TRUNCATED at 64 frames, target 0x${targetFrame.toString(16)} not reached`);
        Logger.warn(LogCategory.SYSTEM,
            `[SEH-UNWIND] chain walk hit the 64-frame cap before target ` +
            `0x${targetFrame.toString(16)} — the rest of the chain keeps its handlers unrun`);
    }

    // End state: FS:[0] is the frame the walk stopped at. Wine pops each frame as it goes
    // and exits the loop on `frame == pEndFrame`, so the TARGET FRAME STAYS on the chain —
    // it is the catching frame, and for _except_handler3 (one registration per function,
    // shared across its __try blocks via trylevel) the function keeps running into its
    // __except block still relying on its own registration being live. This value and the
    // no-steps path in RtlUnwind must agree; they used to disagree, one unlinking the very
    // frame the other kept.
    //
    // An ABNORMAL stop is the exception: `frame` is then the very thing we just rejected —
    // a cycle member, an out-of-bounds pointer, or a frame past the target — and writing it
    // back republishes the damage the walk exists to detect (the next throw walks the same
    // loop again). Fall back to the target, which is the frame the caller is unwinding TO
    // and the one it keeps.
    const truncated = frameCount >= 64 && frame !== targetFrame;
    const targetUsable = targetFrame !== 0 && targetFrame !== 0xFFFFFFFF;
    const finalHead = (aborted || truncated) && targetUsable ? targetFrame : frame;
    dv.setUint32(tebAddr, finalHead, true);

    if (steps.length === 0) {
        recordSehUnwindTrace(`  => NO STEPS in ${frameCount} frame(s) — nothing runs`);
        Logger.log(LogCategory.SYSTEM,
            `[SEH-UNWIND] Nothing to unwind in ${frameCount} frame(s), returning normally`);
        return null;
    }

    const retAddr = dv.getUint32(ctx_esp, true) >>> 0;
    // After stdcall RET thunkCleanupBytes: ESP = ctx_esp + 4 + thunkCleanupBytes
    const callerEsp = (ctx_esp + 4 + thunkCleanupBytes) >>> 0;

    // Place the trampoline BELOW the RtlUnwind frame, not above callerEsp. "Above the
    // caller's stack pointer" is not reliably dead: lj_vm_rtlunwind parks the unwinder
    // address and errcode there on purpose and pops them with the RET that follows
    // RtlUnwind, so a trampoline written at callerEsp ate its continuation. Everything
    // below ctx_esp is genuinely free — the trampoline's first instruction moves ESP to
    // the SEH scratch stack, so no handler call ever pushes into the guest stack.
    //
    // Per step: 4 pushes (2+5+5+5) + MOV EAX,imm32 + CALL EAX + ADD ESP,16 +
    // MOV [teb],imm32 (5+2+3+10) = 37. Prologue 5 + epilogue 25. The first 32 bytes of the
    // block hold a synthesized EXCEPTION_RECORD when the caller passed none, so the depth
    // is derived from the step count rather than a fixed reservation that a deep chain
    // would silently overrun.
    // sizeof(EXCEPTION_RECORD) on 32-bit: 5 DWORDs + ExceptionInformation[15] = 0x50.
    // Under-reserving it puts the trampoline's own bytes inside the record a handler is
    // entitled to read in full.
    const RECORD_SLOT = 0x50;
    // The trampoline's return slot gets its own word BELOW the code and ABOVE the record.
    // Folding it into the record's tail would write machine code into
    // ExceptionInformation, which is only invisible while NumberParameters is 0.
    const RET_SLOT = 4;
    const trampolineSize = 30 + steps.length * 37;
    const scratchBase = ((ctx_esp - (RECORD_SLOT + RET_SLOT + trampolineSize + 16)) & ~3) >>> 0;
    const trampolineAddr = (scratchBase + RECORD_SLOT + RET_SLOT) >>> 0;

    // The block must be writable guest memory the region map agrees about, not merely
    // in-bounds. ctx_esp is the RtlUnwind caller's stack in the normal case, but a handler
    // called from a previous trampoline runs on the SEH scratch stack, and a nested unwind
    // from there would place this block below that stack — off the end of the region.
    if (scratchBase < 0x10000 || scratchBase >= ctx_esp || (ctx_esp - scratchBase) > 0x2000
        || trampolineAddr + trampolineSize > mem.length
        || !isValidAddress(mem, scratchBase, RECORD_SLOT + RET_SLOT + trampolineSize, 'rw')) {
        Logger.warn(LogCategory.SYSTEM,
            `[SEH-UNWIND] No room below the frame for a ${trampolineSize}-byte trampoline ` +
            `(scratchBase=0x${scratchBase.toString(16)} ctx_esp=0x${ctx_esp.toString(16)})`);
        return null;
    }

    const sehStackTop = getSehStackTop();
    if (!sehStackTop) {
        Logger.warn(LogCategory.SYSTEM, `[SEH-UNWIND] No SEH scratch stack — cannot generate trampoline`);
        return null;
    }

    // Windows never calls a handler with a NULL ExceptionRecord: RtlUnwind builds a
    // STATUS_UNWIND record on its own stack when the caller passes none, and an exit unwind
    // (no target frame) is marked as such. Handing the handler a NULL instead makes an
    // ordinary field read fault inside somebody's runtime.
    let recordPtr = excRecPtr;
    if (recordPtr === 0) {
        const STATUS_UNWIND = 0xC0000027;
        const EH_UNWINDING = 0x02, EH_EXIT_UNWIND = 0x04;
        recordPtr = scratchBase;
        dv.setUint32(recordPtr, STATUS_UNWIND, true);                                  // ExceptionCode
        dv.setUint32(recordPtr + 4, EH_UNWINDING | (targetFrame ? 0 : EH_EXIT_UNWIND), true);
        dv.setUint32(recordPtr + 8, 0, true);                                          // ExceptionRecord
        dv.setUint32(recordPtr + 12, dv.getUint32(ctx_esp, true), true);               // ExceptionAddress
        dv.setUint32(recordPtr + 16, 0, true);                                         // NumberParameters
        recordSehUnwindTrace(`  synthesized STATUS_UNWIND record at 0x${recordPtr.toString(16)}`);
    }

    // ContextRecord/DispatcherContext for the unwind pass. Windows hands the UNWINDER's
    // captured context here, not the fault's, and neither _except_handler3 nor a VM
    // runtime reads it on this pass — RtlUnwind's contract is "run your teardown". We
    // have no captured context at this point, so pass NULL rather than a pointer to
    // something that is not one; a handler that dereferences it faults visibly instead of
    // reading another dispatch's registers as its own.
    const contextPtr = 0;

    // Generate trampoline
    let off = trampolineAddr;

    // MOV ESP, sehStackTop — switch to safe stack so CALL return addrs don't corrupt dead stack
    dv.setUint8(off, 0xBC); dv.setUint32(off + 1, sehStackTop, true); off += 5;

    for (const st of steps) {
        // handler(ExceptionRecord, EstablisherFrame, ContextRecord, DispatcherContext), cdecl.
        // Pushed in reverse. The record already carries EH_UNWINDING (set by the caller).
        dv.setUint8(off, 0x6A); dv.setUint8(off + 1, 0x00); off += 2;               // PUSH 0 (dispatcher)
        dv.setUint8(off, 0x68); dv.setUint32(off + 1, contextPtr, true); off += 5;  // PUSH ContextRecord
        dv.setUint8(off, 0x68); dv.setUint32(off + 1, st.frame, true); off += 5;    // PUSH EstablisherFrame
        dv.setUint8(off, 0x68); dv.setUint32(off + 1, recordPtr, true); off += 5;   // PUSH ExceptionRecord
        dv.setUint8(off, 0xB8); dv.setUint32(off + 1, st.handler, true); off += 5;  // MOV EAX, handler
        dv.setUint8(off, 0xFF); dv.setUint8(off + 1, 0xD0); off += 2;               // CALL EAX
        dv.setUint8(off, 0x83); dv.setUint8(off + 1, 0xC4); dv.setUint8(off + 2, 0x10); off += 3; // ADD ESP,16
        // Pop the frame only after its handler ran — Windows unlinks in that order, and a
        // handler that walks FS:[0] must still see itself on the chain.
        dv.setUint8(off, 0xC7); dv.setUint8(off + 1, 0x05);
        dv.setUint32(off + 2, tebAddr, true); dv.setUint32(off + 6, st.next, true);
        off += 10;
    }

    // MOV DWORD PTR [tebAddr], finalHead — re-confirm the end state (C7 05 addr32 imm32).
    // Same value the per-step pops arrive at; the store makes it true even if a handler
    // left the chain somewhere else.
    dv.setUint8(off, 0xC7); dv.setUint8(off + 1, 0x05);
    dv.setUint32(off + 2, tebAddr, true); dv.setUint32(off + 6, finalHead, true);
    off += 10;

    // MOV EAX, returnValue
    dv.setUint8(off, 0xB8); dv.setUint32(off + 1, returnValue, true); off += 5;

    // MOV ESP, callerEsp — restore caller's stack pointer
    dv.setUint8(off, 0xBC); dv.setUint32(off + 1, callerEsp, true); off += 5;

    // JMP retAddr (rel32) — return to caller of RtlUnwind
    dv.setUint8(off, 0xE9); dv.setInt32(off + 1, retAddr - (off + 5), true); off += 5;
    invalidateGuestCode(trampolineAddr, off - trampolineAddr);

    Logger.warn(LogCategory.SYSTEM,
        `[SEH-UNWIND] Trampoline at 0x${trampolineAddr.toString(16)} size=${off - trampolineAddr} ` +
        `steps=${steps.length} retAddr=0x${retAddr.toString(16)} callerEsp=0x${callerEsp.toString(16)}`);

    // Set up CPU so the thunk stub's RET N lands at trampolineAddr.
    // RET N: EIP = [ESP]; ESP += 4 + N
    // We place trampolineAddr at [trampolineAddr - 4] and set ESP = trampolineAddr - 4.
    // That word is RET_SLOT — its own reservation between the record and the code, so
    // neither the handler's view of the record nor the trampoline's first byte overlaps it.
    dv.setUint32(trampolineAddr - 4, trampolineAddr, true);
    cpu.reg32[4] = trampolineAddr - 4;

    return {
        value: 0,
        skipStackCheck: true,
        sehTrampoline: { base: trampolineAddr, end: trampolineAddr + trampolineSize },
    };
}

/**
 * msvcrt:__CxxLongjmpUnwind support — the MSVC compiler emits a call to this function
 * right before an actual longjmp() call site whenever C++ objects with destructors might
 * be in scope between the setjmp() point and the longjmp(). It receives the guest's own
 * _JUMP_BUFFER (as populated by _setjmp3 — Registration is at byte offset 24, same slot
 * in both the real MS layout and our simplified jmp_buf) and must run every destructor for
 * frames being unwound between the current SEH head and that Registration frame, then
 * return normally (the caller performs the actual longjmp() afterwards).
 *
 * Unlike RtlUnwind/dispatchUnwindPass (which only understands trylevel/scopetable
 * __finally frames), this walks BOTH VC5/6 (__except_handler3 FuncInfo) and VC7+
 * (__CxxFrameHandler3 funclet) EH frames — mirroring dispatchCxxException's frame
 * recognition — and fully unwinds each frame's own unwind map (every destructor reachable
 * from its current state), since the frame is being torn down entirely, not just partially.
 */
export function dispatchLongjmpUnwind(
    mem: Uint8Array,
    cpu: any,
    ctx_esp: number,
    tebAddr: number,
    targetFrame: number,
    thunkCleanupBytes: number,
): ThunkResult | null {
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    // longjmp unwinds frames strictly below the setjmp-time registration frame —
    // catch funclets registered on them can never complete; clean their records up.
    if (targetFrame !== 0 && targetFrame !== 0xFFFFFFFF) {
        sweepCatchRecordsBelowFrame(dv, mem, tebAddr, targetFrame >>> 0);
    }

    const actions: Array<{ action: number; frameEbp: number }> = [];
    let sehHead = dv.getUint32(tebAddr, true) >>> 0;
    let frameCount = 0;
    const visitedFrames = new Set<number>();

    while (sehHead !== 0xFFFFFFFF && sehHead !== 0 && sehHead !== targetFrame && frameCount < 64) {
        if (visitedFrames.has(sehHead)) {
            Logger.error(LogCategory.SYSTEM,
                `[CXX-LONGJMP] cycle detected at frame 0x${sehHead.toString(16)} — breaking`);
            break;
        }
        visitedFrames.add(sehHead);
        frameCount++;
        if (sehHead + 16 > mem.length) break;

        const next = dv.getUint32(sehHead, true) >>> 0;
        const handlerAddr = dv.getUint32(sehHead + 4, true) >>> 0;
        const field8 = dv.getUint32(sehHead + 8, true) >>> 0;
        const field12 = dv.getInt32(sehHead + 12, true);
        let matched = false;

        // VC5/6 layout: [+8]=FuncInfo, [+12]=trylevel, EBP=frame+12 (our shared
        // _EH_prolog only pushes {prev, scopetable, trylevel} — see dispatchCxxException).
        if (field8 >= 0x10000 && field8 + 20 < mem.length && field12 >= -1 && field12 < 256) {
            let magic = 0;
            try { magic = dv.getUint32(field8, true); } catch { /* */ }
            if (isMsvcEhMagic(magic)) {
                const frameEbp = sehHead + EH_PROLOG_EBP_DELTA;
                for (const act of readUnwindActions(dv, mem, field8, field12)) {
                    if (act.action !== 0) actions.push({ action: act.action, frameEbp });
                }
                matched = true;
            }
        }

        // VC7+ layout: [+8]=state, FuncInfo encoded in the handler thunk, EBP=frame+12
        if (!matched) {
            const vc7State = dv.getInt32(sehHead + 8, true);
            if (vc7State >= -1 && vc7State < 256) {
                const funcInfoFromThunk = extractFuncInfoFromThunk(mem, handlerAddr);
                if (funcInfoFromThunk >= 0x10000 && funcInfoFromThunk + 20 < mem.length) {
                    let magic = 0;
                    try { magic = dv.getUint32(funcInfoFromThunk, true); } catch { /* */ }
                    if (isMsvcEhMagic(magic)) {
                        const frameEbp = sehHead + EH_PROLOG_EBP_DELTA;
                        for (const act of readUnwindActions(dv, mem, funcInfoFromThunk, vc7State)) {
                            if (act.action !== 0) actions.push({ action: act.action, frameEbp });
                        }
                    }
                }
            }
        }

        sehHead = next;
    }

    // Unlink unwound frames — FS:[0] = targetFrame. The setjmp-time frame stays in the
    // chain (same Win32 contract as RtlUnwind): execution resumes inside it via longjmp.
    if (targetFrame !== 0 && targetFrame !== 0xFFFFFFFF) {
        dv.setUint32(tebAddr, targetFrame, true);
    }

    if (actions.length === 0) {
        Logger.log(LogCategory.SYSTEM,
            `[CXX-LONGJMP] No destructors in ${frameCount} frame(s), returning normally`);
        return null;
    }

    const retAddr = dv.getUint32(ctx_esp, true) >>> 0;
    // cdecl: after our simulated RET the pushed jmp_buf arg is left for the caller's own
    // stack cleanup, so callerEsp only pops the return address (+ thunkCleanupBytes, 0 here).
    const callerEsp = (ctx_esp + 4 + thunkCleanupBytes) >>> 0;
    const trampolineAddr = (callerEsp + 3) & ~3;
    // Preamble MOV ESP(5) + PUSHAD(1) + N×{MOV EBP(5)+CALL(5)} + POPAD(1) + MOV ESP(5) + JMP(5)
    const trampolineSize = 5 + 1 + actions.length * 10 + 1 + 5 + 5;

    if (targetFrame === 0 || targetFrame === 0xFFFFFFFF) {
        Logger.warn(LogCategory.SYSTEM,
            `[CXX-LONGJMP] Invalid target frame — skipping ${actions.length} destructor(s)`);
        return null;
    }

    const deadSpace = targetFrame - trampolineAddr;
    if (deadSpace < trampolineSize + 16) {
        Logger.warn(LogCategory.SYSTEM,
            `[CXX-LONGJMP] Dead stack too small for trampoline: need ${trampolineSize + 16}, have ${deadSpace} ` +
            `(trampolineAddr=0x${trampolineAddr.toString(16)} targetFrame=0x${targetFrame.toString(16)})`);
        return null;
    }

    const sehStackTop = getSehStackTop();
    if (!sehStackTop) {
        Logger.warn(LogCategory.SYSTEM, `[CXX-LONGJMP] No SEH scratch stack — cannot generate trampoline`);
        return null;
    }

    let off = trampolineAddr;

    // MOV ESP, sehStackTop — run destructors on the scratch stack, not the dead game stack.
    dv.setUint8(off, 0xBC); dv.setUint32(off + 1, sehStackTop, true); off += 5;
    // PUSHAD — protect caller's registers across the destructor calls.
    dv.setUint8(off, 0x60); off += 1;

    for (const { action, frameEbp } of actions) {
        // MOV EBP, frameEbp
        dv.setUint8(off, 0xBD); dv.setUint32(off + 1, frameEbp, true); off += 5;
        // CALL rel32 destructor
        dv.setUint8(off, 0xE8); dv.setInt32(off + 1, action - (off + 5), true); off += 5;
    }

    // POPAD
    dv.setUint8(off, 0x61); off += 1;
    // MOV ESP, callerEsp — back to the real (post-return) stack.
    dv.setUint8(off, 0xBC); dv.setUint32(off + 1, callerEsp, true); off += 5;
    // JMP retAddr — resume the caller (which will perform the actual longjmp).
    dv.setUint8(off, 0xE9); dv.setInt32(off + 1, retAddr - (off + 5), true); off += 5;
    invalidateGuestCode(trampolineAddr, off - trampolineAddr);

    Logger.warn(LogCategory.SYSTEM,
        `[CXX-LONGJMP] Trampoline at 0x${trampolineAddr.toString(16)} size=${off - trampolineAddr} ` +
        `destructors=${actions.length} retAddr=0x${retAddr.toString(16)} callerEsp=0x${callerEsp.toString(16)}`);

    for (let i = 0; i < actions.length; i++) {
        const act = actions[i];
        Logger.warn(LogCategory.SYSTEM,
            `[CXX-LONGJMP]   destructor[${i}]: 0x${act.action.toString(16)}${identifyModule(act.action)} ` +
            `EBP=0x${act.frameEbp.toString(16)}`);
    }

    dv.setUint32(trampolineAddr - 4, trampolineAddr, true);
    cpu.reg32[4] = trampolineAddr - 4;

    return {
        value: 0,
        skipStackCheck: true,
        sehTrampoline: { base: trampolineAddr, end: trampolineAddr + trampolineSize },
    };
}

/**
 * Returned when the JS walk hits a registration it cannot parse as MSVC C++ EH
 * (e.g. a __try/__except frame via _except_handler4) BEFORE finding a catch.
 * Windows RtlDispatchException calls EVERY handler in chain order — such a frame's
 * filter may claim the exception, so the caller must re-dispatch the whole
 * exception through x86 SEH (guest handlers) instead of trusting the JS scan.
 * Carries the rethrow-resolved object/throwInfo so the x86 record can be
 * completed when the active exception was tracked only on the JS side.
 */
export interface CxxDispatchDefer {
    deferToX86: true;
    pExceptionObject: number;
    pThrowInfo: number;
}

/** How a registration in the FS:[0] chain parses as an MSVC C++ EH frame. */
interface CxxFrameShape {
    funcInfoPtr: number;
    state: number;
    /** Byte offset of the try-level field inside the registration record. */
    stateOffset: number;
    isVC7: boolean;
    frameEbp: number;
}

/**
 * Classify one FS:[0] registration. THE single definition of "is this ours" — the read-only
 * search pass and the mutating walk both go through it, so the pass that decides to defer
 * cannot disagree with the pass that would have caught.
 */
export function classifyCxxFrame(dv: DataView, mem: Uint8Array, sehHead: number, handlerAddr: number): CxxFrameShape | null {
    const frameEbp = sehHead + EH_PROLOG_EBP_DELTA;

    // VC5/6: FuncInfo* at [+8], try-level at [+12].
    const field8 = dv.getUint32(sehHead + 8, true);
    const field12 = dv.getInt32(sehHead + 12, true);
    if (field8 >= 0x10000 && field8 + 20 < mem.length && field12 >= -1 && field12 < 256) {
        let magic = 0;
        try { magic = dv.getUint32(field8, true); } catch { /* */ }
        if (isMsvcEhMagic(magic)) {
            return { funcInfoPtr: field8, state: field12, stateOffset: 12, isVC7: false, frameEbp };
        }
    }

    // VC7+: try-level at [+8], FuncInfo* extracted from the handler thunk.
    const vc7State = dv.getInt32(sehHead + 8, true);
    if (vc7State >= -1 && vc7State < 256) {
        const funcInfo = extractFuncInfoFromThunk(mem, handlerAddr);
        if (funcInfo >= 0x10000 && funcInfo + 20 < mem.length) {
            let magic = 0;
            try { magic = dv.getUint32(funcInfo, true); } catch { /* */ }
            if (isMsvcEhMagic(magic)) {
                return { funcInfoPtr: funcInfo, state: vc7State, stateOffset: 8, isVC7: true, frameEbp };
            }
        }
    }
    return null;
}

/**
 * Read-only half of tryMatchCatch: would this FuncInfo catch this throw at `trylevel`?
 * Extracted so the defer decision can be taken BEFORE any frame state is written; the
 * matching rules must stay identical to tryMatchCatch's, which is why both read the same
 * TryBlockMap fields in the same order.
 */
export function frameCatchesThrow(
    dv: DataView,
    mem: Uint8Array,
    funcInfoPtr: number,
    trylevel: number,
    pThrowInfo: number,
    innerOfCatch?: { tryHighAbove: number; catchHighMax: number },
): boolean {
    const nTryBlocks = dv.getUint32(funcInfoPtr + 12, true);
    const pTryBlockMap = dv.getUint32(funcInfoPtr + 16, true);
    if (nTryBlocks === 0 || pTryBlockMap < 0x10000) return false;

    for (let i = 0; i < nTryBlocks && i < 32; i++) {
        const tBase = pTryBlockMap + i * 20;
        if (tBase + 20 > mem.length) break;
        const tryLow = dv.getInt32(tBase, true);
        const tryHigh = dv.getInt32(tBase + 4, true);
        const nCatches = dv.getInt32(tBase + 12, true);
        const pHandlerArray = dv.getUint32(tBase + 16, true);
        if (trylevel < tryLow || trylevel > tryHigh) continue;
        if (nCatches <= 0 || pHandlerArray < 0x10000) continue;
        if (innerOfCatch &&
            !(tryLow > innerOfCatch.tryHighAbove && tryHigh <= innerOfCatch.catchHighMax)) {
            continue;
        }
        for (let j = 0; j < nCatches && j < 16; j++) {
            const hBase = pHandlerArray + j * 16;
            if (hBase + 16 > mem.length) break;
            const pType = dv.getUint32(hBase + 4, true);
            const catchAddr = dv.getUint32(hBase + 12, true);
            if (catchAddr < 0x10000 || catchAddr >= mem.length) continue;
            if (matchesThrowType(dv, mem, pType, pThrowInfo)) return true;
        }
    }
    return false;
}

/**
 * SEARCH PHASE, read-only. Windows' RtlDispatchException calls EVERY handler in chain order,
 * so a registration we cannot parse (typically __except_handler3/4, whose filter may well
 * claim a C++ throw) must run natively when it stands BEFORE any catch we could serve.
 *
 * This runs before the dispatch mutates anything. Deciding later — after the catch-funclet
 * exit loop has written the try-level, restored PRN_STACK and popped the record + active
 * exception — would drop the exception object's pmfnUnwind and every catch-body local
 * destructor, and leave a later bare `throw;` with no active exception to resolve.
 */
function chainDefersToX86(
    dv: DataView,
    mem: Uint8Array,
    tebAddr: number,
    pThrowInfo: number,
): number | null {
    // Active catch funclets first: the exit loop consults them ahead of the FS:[0] walk.
    const records = activeCatchRecords.get(tebAddr) ?? [];
    for (let r = records.length - 1; r >= 0; r--) {
        const R = records[r];
        if (R.pRN + R.stateOffset + 4 > mem.length || R.pRN < 4) continue;
        const liveState = dv.getInt32(R.pRN + R.stateOffset, true);
        if (frameCatchesThrow(dv, mem, R.funcInfoPtr, liveState, pThrowInfo,
            { tryHighAbove: R.tryHigh, catchHighMax: R.catchHigh })) return null;
        const exitTarget = computeCatchExitTargetState(dv, mem, R.funcInfoPtr, liveState);
        if (frameCatchesThrow(dv, mem, R.funcInfoPtr, exitTarget, pThrowInfo)) return null;
    }

    let head = dv.getUint32(tebAddr, true) >>> 0;
    const visited = new Set<number>();
    for (let n = 0; n < 64 && head !== 0xFFFFFFFF && head !== 0; n++) {
        if (visited.has(head) || head + 16 >= mem.length) break;
        visited.add(head);
        const handlerAddr = dv.getUint32(head + 4, true);
        const shape = classifyCxxFrame(dv, mem, head, handlerAddr);
        if (!shape) return head; // unparseable registration reached first — x86 owns this throw
        if (frameCatchesThrow(dv, mem, shape.funcInfoPtr, shape.state, pThrowInfo)) return null;
        head = dv.getUint32(head, true) >>> 0;
    }
    return null;
}

/**
 * Walk the SEH chain and dispatch a C++ exception to the first matching catch block.
 *
 * `allowDeferToX86: false` suppresses the defer verdict — for a caller whose x86 re-dispatch
 * refused (nesting depth, no stub), so the JS walk keeps going past the unparseable frame and
 * a catch further up is still found rather than the throw going unhandled.
 */
export function dispatchCxxException(
    mem: Uint8Array,
    cpu: any,
    pExceptionObject: number,
    pThrowInfo: number,
    thunkCleanupBytes: number,
    opts?: { allowDeferToX86?: boolean },
): ThunkResult | CxxDispatchDefer | null {
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const tebAddr = cpu.segment_offsets[4];
    let sehHead = dv.getUint32(tebAddr, true);

    // Re-throw support: `throw;` passes pObj=0, pThrow=0 — resolve from the stored
    // exception. NOTE the lifecycle (matches CRT CallCatchBlock, NOT the old model):
    // a NEW throw does not touch the active-exception stack here — the exception
    // becomes "current" only when a catch is ENTERED (tryMatchCatch pushes it,
    // coupled to the ActiveCatchRecord) and it is popped when that catch exits
    // (completion gadget on normal return, or the record-exit loop below when a
    // throw leaves the catch body). This keeps the stack balanced across arbitrary
    // rethrow chains and nested exceptions.
    const isRethrow = pExceptionObject === 0 && pThrowInfo === 0;
    if (isRethrow) {
        const active = getActiveException(tebAddr);
        if (active) {
            pExceptionObject = active.pExceptionObject;
            pThrowInfo = active.pThrowInfo;
            Logger.warn(LogCategory.SYSTEM,
                `SEH dispatch: re-throw resolved from active exception ` +
                `pObj=0x${pExceptionObject.toString(16)} pThrow=0x${pThrowInfo.toString(16)}`);
        } else {
            Logger.error(LogCategory.SYSTEM,
                `SEH dispatch: re-throw (pObj=0 pThrow=0) but no active exception for TEB=0x${tebAddr.toString(16)}`);
            return null;
        }
    }

    // Log throw context — which module is throwing?
    const throwEIP = (cpu.instruction_pointer?.[0] ?? 0) >>> 0; // EIP at throw
    const throwEsp = cpu.reg32[4] >>> 0; // ESP at throw time (lower bound of dead stack)
    const throwModule = identifyModule(throwEIP);
    // PROBE: decode the thrown object when it's a string pointer (TCHAR*). The char width
    // depends on the build: an ANSI build (e.g. XIII/msvcr70) throws `char*` (type desc ".PAD"),
    // a Unicode build throws `wchar_t*` (".PA_W"/"…W"). We pick narrow vs wide from the thrown
    // type descriptor so the logged text is readable (UE uses these for "Can't find ini:…" etc.).
    let thrownStr = '';
    let typeName = '';
    try {
        let wide = false;
        if (pThrowInfo >= 0x1000 && pThrowInfo + 16 <= mem.length) {
            const pCTA = dv.getUint32(pThrowInfo + THROWINFO_CATCHABLE_ARRAY_OFF, true) >>> 0; // CatchableTypeArray
            if (pCTA >= 0x1000 && pCTA + 8 <= mem.length) {
                const pCT = dv.getUint32(pCTA + CATCHABLE_ARRAY_FIRST_TYPE_OFF, true) >>> 0;     // first CatchableType
                if (pCT >= 0x1000 && pCT + 8 <= mem.length) {
                    const pTD = dv.getUint32(pCT + CATCHABLE_TYPE_TYPEDESC_OFF, true) >>> 0;  // TypeDescriptor
                    typeName = pTD ? readTypeName(mem, pTD) : '';
                    wide = /_W(@|$)/.test(typeName); // wchar_t* decorated name ends in _W
                }
            }
        }
        if (pExceptionObject !== 0 && pExceptionObject + 4 <= mem.length) {
            const strPtr = dv.getUint32(pExceptionObject, true) >>> 0;
            if (strPtr !== 0) {
                const step = wide ? 2 : 1;
                const chars: number[] = [];
                for (let i = 0; i < 256 && strPtr + i * step + step <= mem.length; i++) {
                    const c = wide ? dv.getUint16(strPtr + i * 2, true) : mem[strPtr + i];
                    if (c === 0) break;
                    chars.push(c);
                }
                thrownStr = String.fromCharCode(...chars);
            }
        }
    } catch { /* ignore decode errors */ }

    // Record in the diagnostic ring (outcome filled in by tryMatchCatch / dispatch end).
    let threadId = 0;
    try { threadId = (System.getInstance().scheduler as { getCurrentThreadId?: () => number })?.getCurrentThreadId?.() ?? 0; } catch { /* */ }
    recordCxxThrow({ threadId, typeName, thrownStr, throwEip: throwEIP, throwModule, isRethrow });

    Logger.warn(LogCategory.SYSTEM,
        `SEH dispatch: C++ exception thrown at EIP=0x${(throwEIP >>> 0).toString(16)}${throwModule} ` +
        `ESP=0x${throwEsp.toString(16)} objPtr=0x${pExceptionObject.toString(16)}` +
        (typeName ? ` type="${typeName}"` : '') +
        (thrownStr ? ` thrown="${thrownStr}"` : ''));

    // SEARCH PHASE — decide before anything is written (see chainDefersToX86).
    if (opts?.allowDeferToX86 !== false) {
        const deferFrame = chainDefersToX86(dv, mem, tebAddr, pThrowInfo);
        if (deferFrame !== null) {
            Logger.warn(LogCategory.SYSTEM,
                `SEH dispatch: frame 0x${deferFrame.toString(16)} ` +
                `(handler=0x${(dv.getUint32(deferFrame + 4, true) >>> 0).toString(16)}) is not MSVC C++ EH and ` +
                `precedes any catch we could serve — deferring dispatch to x86 SEH so its filter runs faithfully`);
            if (currentThrowRecord && currentThrowRecord.outcome === 'pending') {
                currentThrowRecord.outcome = 'deferred-x86';
            }
            return { deferToX86: true, pExceptionObject, pThrowInfo };
        }
    }

    let frameCount = 0;
    const skippedFrames: SkippedFrameInfo[] = [];
    // Catch-exit work (catch-body local destructors, dying exception objects) deferred
    // from records exited below — prepended to whatever trampoline the eventual catch
    // match emits (in the CRT these ran immediately at rethrow-interception time).
    const pendingExitActions: DispatchAction[] = [];

    // ---- Throw originating INSIDE an active catch funclet ----
    // Replays the CRT composite for a throw out of a catch body:
    //   1. CatchGuardHandler: only try blocks nested inside the executing catch may
    //      handle it (checked against the frame's LIVE state — the funclet advances
    //      the state as it constructs locals / enters inner trys).
    //   2. ExFilterRethrow interception at CallCatchBlock: the catch's own state
    //      unwinds to its parent (destructors of catch-body locals), PRN_STACK is
    //      restored, the record + its active-exception entry are dropped; a NEW
    //      throw additionally destroys the old exception object (last-user check).
    //   3. FindHandler keeps scanning: an ENCLOSING try of the SAME frame may catch
    //      (checked at the parent state), else the frame's remaining unwind queues up
    //      and the search continues with enclosing records, then the FS:[0] walk.
    let recordGuardLoops = 0;
    while (peekCatchRecord(tebAddr) && recordGuardLoops++ < 16) {
        const R = peekCatchRecord(tebAddr)!;
        if (R.pRN + R.stateOffset + 4 > mem.length || R.pRN < 4) {
            Logger.error(LogCategory.SYSTEM,
                `SEH dispatch: active catch record pRN=0x${R.pRN.toString(16)} out of bounds — dropping`);
            popCatchRecord(tebAddr);
            clearActiveException(tebAddr);
            continue;
        }
        const liveState = dv.getInt32(R.pRN + R.stateOffset, true);
        const liveNext = dv.getUint32(R.pRN, true) >>> 0;

        // (1) CatchGuard: a try nested inside this catch body?
        const inner = tryMatchCatch(
            dv, mem, R.funcInfoPtr, liveState, R.catchEbp, R.pRN,
            R.stateOffset, tebAddr, liveNext, pExceptionObject, pThrowInfo, cpu,
            thunkCleanupBytes, true, skippedFrames, throwEsp, isRethrow,
            pendingExitActions,
            { tryHighAbove: R.tryHigh, catchHighMax: R.catchHigh },
        );
        if (inner) return inner;

        // (2) The throw exits this catch: unwind its state to the parent, restore
        // PRN_STACK, drop the record + its active-exception entry.
        const exitTarget = computeCatchExitTargetState(dv, mem, R.funcInfoPtr, liveState);
        const exitActions = collectUnwindActionsTo(dv, mem, R.funcInfoPtr, liveState, exitTarget);
        guardStackWrite(R.pRN + R.stateOffset, 4, 'seh:catchExitState');
        dv.setInt32(R.pRN + R.stateOffset, exitTarget, true);
        if (R.savedTryEsp) {
            guardStackWrite((R.pRN - 4) >>> 0, 4, 'seh:prnStackRestore', R.savedTryEsp);
            dv.setUint32((R.pRN - 4) >>> 0, R.savedTryEsp >>> 0, true);
        }
        popCatchRecord(tebAddr);
        clearActiveException(tebAddr);
        // A NEW throw exiting the catch ends the old exception object's lifetime
        // (CRT: __DestructExceptionObject in CallCatchBlock's __finally — which
        // RtlUnwind reaches BEFORE the establisher frame's own local unwinds, so the
        // object dtor is queued ahead of the catch-body local destructors) unless an
        // enclosing catch still references it.
        if (!isRethrow && R.pExceptionObject !== pExceptionObject
            && !(globalThis as Record<string, unknown>).__sehNoObjDtor
            && !isExceptionObjectReferenced(tebAddr, R.pExceptionObject)) {
            const objDtor = readThrowInfoUnwindFunc(dv, mem, R.pThrowInfo);
            if (objDtor) {
                pendingExitActions.push({ kind: 'thisCall', fn: objDtor, obj: R.pExceptionObject });
            }
        }
        for (const act of exitActions) {
            pendingExitActions.push({ kind: 'dtor', fn: act.action, frameEbp: R.catchEbp });
        }
        Logger.warn(LogCategory.SYSTEM,
            `SEH dispatch: throw exits catch pRN=0x${R.pRN.toString(16)} ` +
            `state ${liveState}->${exitTarget} exitDtors=${exitActions.length} ` +
            `${isRethrow ? '(rethrow)' : '(new throw)'}`);

        // (3) An ENCLOSING try of the same frame may catch at the parent state.
        const again = tryMatchCatch(
            dv, mem, R.funcInfoPtr, exitTarget, R.catchEbp, R.pRN,
            R.stateOffset, tebAddr, liveNext, pExceptionObject, pThrowInfo, cpu,
            thunkCleanupBytes, true, skippedFrames, throwEsp, isRethrow,
            pendingExitActions,
        );
        if (again) return again;

        // Frame fully abandoned — queue its remaining unwind like any skipped frame
        // and continue with the enclosing record (if any), then the FS:[0] walk.
        skippedFrames.push({
            sehHead: R.pRN, handlerAddr: 0, state: exitTarget, isVC7: true,
            funcInfoPtr: R.funcInfoPtr, frameEbp: R.catchEbp,
            unwindActions: readUnwindActions(dv, mem, R.funcInfoPtr, exitTarget),
        });
    }

    const visitedFrames = new Set<number>();
    while (sehHead !== 0xFFFFFFFF && sehHead !== 0 && frameCount < 64) {
        // Cycle detection: if we've seen this frame before, the chain is corrupted.
        // A self-loop (frame.next == frame) is a known sequential-catch corruption — try
        // to splice the last known-good next back in (keyed on frame addr + handler) and
        // keep walking, so outer guard handlers stay reachable. See seh-chain-repair.ts.
        if (visitedFrames.has(sehHead)) {
            const loopHandler = (sehHead + 8 <= mem.length) ? (dv.getUint32(sehHead + 4, true) >>> 0) : 0;
            const repaired = repairSehSelfLoop(dv, sehHead, loopHandler, mem.length);
            if (repaired !== null && repaired !== 0xFFFFFFFF && repaired !== 0 && !visitedFrames.has(repaired >>> 0)) {
                sehHead = repaired >>> 0;
                continue;
            }
            Logger.error(LogCategory.SYSTEM,
                `SEH dispatch: cycle detected at frame 0x${sehHead.toString(16)} after ${frameCount} frames — breaking`);
            break;
        }
        visitedFrames.add(sehHead);
        frameCount++;
        if (sehHead + 16 >= mem.length) break;

        const next = dv.getUint32(sehHead, true);
        const handlerAddr = dv.getUint32(sehHead + 4, true);
        const field8 = dv.getUint32(sehHead + 8, true);
        const field12 = dv.getInt32(sehHead + 12, true);

        // Remember this frame's healthy next so a later self-loop can be repaired.
        recordSehFrame(sehHead, next, handlerAddr);

        Logger.log(LogCategory.SYSTEM,
            `SEH frame #${frameCount}: addr=0x${sehHead.toString(16)} next=0x${(next >>> 0).toString(16)} ` +
            `handler=0x${handlerAddr.toString(16)} [+8]=0x${field8.toString(16)} [+12]=0x${(field12 >>> 0).toString(16)}`);

        const shape = classifyCxxFrame(dv, mem, sehHead, handlerAddr);
        if (!shape) {
            // Not a recognizable C++ EH frame — a __try/__except registration
            // (__except_handler4: shared handler, cookie-XORed scope table). Whether its
            // filter gets to run was already settled by the search phase; here it can only
            // be skipped, so an outer catch stays reachable.
            Logger.log(LogCategory.SYSTEM,
                `  -> frame handler=0x${handlerAddr.toString(16)} is not MSVC C++ EH — skipping`);
            sehHead = next;
            continue;
        }

        Logger.log(LogCategory.SYSTEM,
            `  -> ${shape.isVC7 ? 'VC7+' : 'VC5/6'} layout: FuncInfo=0x${shape.funcInfoPtr.toString(16)} ` +
            `state=${shape.state} EBP=0x${shape.frameEbp.toString(16)}`);
        if (isImplausibleFrameEbp(shape.frameEbp, mem.length)) {
            Logger.error(LogCategory.SYSTEM,
                `SEH walk: implausible ${shape.isVC7 ? 'VC7+' : 'VC5/6'} frame EBP=0x${shape.frameEbp.toString(16)} ` +
                `(pRN=0x${sehHead.toString(16)}, handler=0x${handlerAddr.toString(16)}) — stale/garbage record?`);
            recordSehDispatchTrace(
                `WILD-EBP ${shape.isVC7 ? 'vc7' : 'vc56'} pRN=0x${sehHead.toString(16)} ` +
                `ebp=0x${shape.frameEbp.toString(16)} handler=0x${handlerAddr.toString(16)}`);
        }
        const result = tryMatchCatch(
            dv, mem, shape.funcInfoPtr, shape.state,
            shape.frameEbp, sehHead, shape.stateOffset, tebAddr, next,
            pExceptionObject, pThrowInfo, cpu, thunkCleanupBytes, shape.isVC7,
            skippedFrames, throwEsp, isRethrow, pendingExitActions,
        );
        if (result) {
            return result;
        }
        // No catch match — record as skipped with unwind info
        skippedFrames.push({
            sehHead, handlerAddr, state: shape.state, isVC7: shape.isVC7,
            funcInfoPtr: shape.funcInfoPtr, frameEbp: shape.frameEbp,
            unwindActions: readUnwindActions(dv, mem, shape.funcInfoPtr, shape.state),
        });
        sehHead = next;
    }

    // No guest catch found — this throw will fall through to UnhandledExceptionFilter →
    // (typically) std::terminate. Record it so report()/sehLog surface the uncaught throw.
    if (currentThrowRecord && currentThrowRecord.outcome === 'pending') {
        currentThrowRecord.outcome = 'unhandled';
    }
    Logger.error(LogCategory.SYSTEM,
        `SEH dispatch: NO catch handler found (${frameCount} frames scanned, ` +
        `TEB=0x${tebAddr.toString(16)} sehHead=0x${(dv.getUint32(tebAddr, true) >>> 0).toString(16)} ` +
        `throwInfo=0x${pThrowInfo.toString(16)} objPtr=0x${pExceptionObject.toString(16)} ` +
        `ESP=0x${(cpu.reg32[4] >>> 0).toString(16)} EBP=0x${(cpu.reg32[5] >>> 0).toString(16)})`);
    return null;
}
