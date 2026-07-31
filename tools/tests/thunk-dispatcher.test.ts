// Characterization harness for ThunkDispatcher (god-object #1).
// The constructor only needs a v86 handle
// (no WASM/DOM), so it instantiates clean in isolation with a fake. We then pin the
// pure sub-functions that the async-park / sync-RET paths depend on, ahead of the
// async-park atomicization. These are CHARACTERIZATION tests: they
// assert what the code does TODAY. Pin first, slice second.

import { describe, it, expect } from 'bun:test';
import { ThunkDispatcher } from '../../src/worker/core/thunking/thunk-dispatcher';

const SPIN_ADDR = 0xdead0000;

/** Construct a dispatcher with fakes; no v86/DOM is touched (emulator-ready never fires). */
function mkDispatcher(): any {
    return new ThunkDispatcher({ add_listener: () => {} } as any, {} as any);
}

/** Bind a fresh guest-memory window so the cached-view-dependent helpers run. */
function bindMemory(d: any, size = 0x10000): { mem: Uint8Array; dv: DataView } {
    const mem = new Uint8Array(size);
    const dv = new DataView(mem.buffer);
    d.cachedMem8 = mem;
    d.cachedDataView = dv;
    d.memLength = mem.length;
    d.spinLoopAddress = SPIN_ADDR;
    return { mem, dv };
}

describe('ThunkDispatcher — instantiation', () => {
    it('constructs in isolation with a fake v86 (no WASM/DOM)', () => {
        expect(mkDispatcher()).toBeTruthy();
    });
});

describe('ThunkDispatcher.redirectStackToSpinLoop (async-park step b)', () => {
    it('overwrites [esp] with spinLoopAddress and returns the original return address', () => {
        const d = mkDispatcher();
        const { dv } = bindMemory(d);
        const esp = 0x200;
        dv.setUint32(esp, 0x12345678, true); // guest return address at [esp]

        const original = d.redirectStackToSpinLoop(esp);

        expect(original).toBe(0x12345678);
        expect(dv.getUint32(esp, true)).toBe(SPIN_ADDR); // RET N now lands on the spin loop
    });

    it('returns undefined for out-of-bounds esp (and leaves memory untouched)', () => {
        const d = mkDispatcher();
        const { mem } = bindMemory(d);
        expect(d.redirectStackToSpinLoop(0)).toBeUndefined();          // esp < 4
        expect(d.redirectStackToSpinLoop(mem.length)).toBeUndefined(); // esp + 4 > length
        expect(d.redirectStackToSpinLoop(mem.length - 2)).toBeUndefined();
    });

    it('returns undefined when no valid data view is bound', () => {
        const d = mkDispatcher();
        d.cachedDataView = null;
        d.cachedMem8 = null;
        expect(d.redirectStackToSpinLoop(0x200)).toBeUndefined();
    });
});

describe('ThunkDispatcher.resolveThunkCleanup (sync + async cleanup)', () => {
    const MAX = 65536;

    it('returns the cached stackCleanupTable value when present (authoritative)', () => {
        const d = mkDispatcher();
        d.stackCleanupTable[42] = 16;
        expect(d.resolveThunkCleanup(42, 99, 'test')).toBe(16);
    });

    it('treats cleanup 0 (cdecl / RET) as a valid cached value, not a miss', () => {
        const d = mkDispatcher();
        d.stackCleanupTable[7] = 0;
        // Stub decode so a miss would be detectable; it must NOT be consulted.
        d.decodeThunkStubCleanupById = () => 0xbad;
        expect(d.resolveThunkCleanup(7, 4, 'test')).toBe(0);
    });

    it('falls back to argCount*4 when neither cache nor stub decode resolves', () => {
        const d = mkDispatcher();
        d.stackCleanupTable[100] = -1;       // cache miss
        d.decodeThunkStubCleanupById = () => -1; // decode miss
        expect(d.resolveThunkCleanup(100, 5, 'test')).toBe(20);
        expect(d.resolveThunkCleanup(100, -1, 'test')).toBe(0); // unknown argCount -> 0
    });

    it('prefers stub decode over the argCount fallback on a cache miss', () => {
        const d = mkDispatcher();
        d.stackCleanupTable[101] = -1;
        d.decodeThunkStubCleanupById = () => 12;
        expect(d.resolveThunkCleanup(101, 99, 'test')).toBe(12);
    });

    it('skips the cache for out-of-range function ids', () => {
        const d = mkDispatcher();
        d.decodeThunkStubCleanupById = () => -1;
        expect(d.resolveThunkCleanup(0, 3, 'test')).toBe(12);   // id 0 -> no cache, fallback 3*4
        expect(d.resolveThunkCleanup(MAX, 2, 'test')).toBe(8);  // id >= MAX -> no cache, fallback 2*4
    });
});

describe('ThunkDispatcher.tryApplyPendingAsyncRestoreAtSafePoint — per-thread drain (no head-of-line)', () => {
    // Faithful-to-NT regression: async-thunk completions are PER-THREAD and independent
    // (IoCompleteRequest → KiUnwaitThread). The HP #7 livelock was head-of-line blocking — a
    // blocked head restore starved a ready cross-thread completion behind it. These tests pin
    // the two-phase drain: Phase 1 readies cross-thread waiters regardless of the head; Phase 2
    // applies the CURRENT thread's restore by thread-id lookup, not by FIFO position.
    function mkWithScheduler() {
        const d = mkDispatcher();
        bindMemory(d);
        const tr = { woken: [] as number[], switched: [] as number[], appliedTids: [] as number[], parked: new Set<number>(), rejected: [] as string[] };
        let currentTid = 1;
        const sched = {
            getCurrentThreadId: () => currentTid,
            getCurrentThread: () => ({ id: currentTid, kernelPinCount: 0, state: 2 /* RUNNING */ }),
            wakeThreadForAsyncCompletion: (tid: number) => { tr.woken.push(tid); return true; },
            markThreadRunningAfterAsyncWake: (_tid: number) => true,
            requestSwitchToThread: (tid: number) => { tr.switched.push(tid); },
            isThreadAsyncParked: (tid: number) => tr.parked.has(tid),
            traceTimerEvent: () => {},
            traceAsyncRestore: () => {},
            validateAsyncRestoreTarget: () => ({ ok: true }),
            rejectAsyncRestore: (_tid: number, reason: string) => { tr.rejected.push(reason); },
        };
        d.ensureScheduler = () => sched;
        d.updateMemoryCache = () => {};                          // avoid v86 deps
        d.isInAsyncCallbackStubRange = () => false;
        d.isInAsyncThunkStubReturnPath = () => false;
        // Stub the register-apply: we test SELECTION (which restore drains), not the CPU writes.
        d.applyPendingAsyncRestoreAtSafePoint = (pending: any) => { tr.appliedTids.push(pending.info.threadId); };
        return { d, tr, sched, setCurrent: (t: number) => { currentTid = t; } };
    }
    const cpu = { instruction_pointer: [0x401000], reg32: [0, 0, 0, 0, 0x200] }; // eip not at spin loop
    const restore = (threadId: number, name: string, gen = 1) => ({
        info: { threadId, asyncParkGeneration: gen, returnAddr: 0x401000, esp: 0x200, functionId: 0x44 },
        returnValue: 0,
        cleanupBytes: 0,
        completionName: name,
    });

    it('Phase 1: readies a cross-thread waiter even when the FIFO head is blocked (head-of-line eliminated)', () => {
        const { d, tr } = mkWithScheduler();
        tr.parked.add(3);                                        // T3 is async-parked & ready
        d._callbackManager = { hasInFlightCallbacks: () => true, getPendingCount: () => 1, hasSavedThunkContext: () => false }; // current (T1) blocked
        d.pendingAsyncRestores = [restore(1, 'blockedHead'), restore(3, 'readyCrossThread')];

        const applied = d.tryApplyPendingAsyncRestoreAtSafePoint(cpu);

        expect(tr.woken).toContain(3);                           // T3 readied despite blocked head
        expect(tr.switched).toContain(3);                        // switch requested toward T3
        expect(tr.appliedTids).toEqual([]);                      // nothing applied this tick (T1 blocked, T3 cross-thread)
        expect(applied).toBe(false);
        expect(d.pendingAsyncRestores.length).toBe(2);           // both still queued
    });

    it('Phase 2: applies the CURRENT thread\'s restore by thread-id, not the head', () => {
        const { d, tr, setCurrent } = mkWithScheduler();
        d._callbackManager = { hasInFlightCallbacks: () => false, getPendingCount: () => 0, hasSavedThunkContext: () => false };
        tr.parked.add(3);
        d.pendingAsyncRestores = [restore(1, 'otherThreadHead'), restore(3, 'currentParked')];
        setCurrent(3);                                           // scheduler switched to T3 (still parked)

        const applied = d.tryApplyPendingAsyncRestoreAtSafePoint(cpu);

        expect(applied).toBe(true);
        expect(tr.appliedTids).toEqual([3]);                     // T3's restore applied even though head is T1's
        expect(d.pendingAsyncRestores.some((p: any) => p.info.threadId === 3)).toBe(false); // T3 drained
        expect(d.pendingAsyncRestores.some((p: any) => p.info.threadId === 1)).toBe(true);  // T1's head untouched
    });

    it('preflight drops stale-generation restore before wake/apply', () => {
        const { d, tr, sched } = mkWithScheduler();
        sched.validateAsyncRestoreTarget = () => ({ ok: false, reason: 'stale-generation expected=1 actual=2 T3' });
        d._callbackManager = { hasInFlightCallbacks: () => false, getPendingCount: () => 0, hasSavedThunkContext: () => false };
        d.pendingAsyncRestores = [restore(3, 'stale', 1)];

        const applied = d.tryApplyPendingAsyncRestoreAtSafePoint(cpu, 'yieldToHost.resume');

        expect(applied).toBe(false);
        expect(d.pendingAsyncRestores.length).toBe(0);
        expect(tr.woken).toEqual([]);
        expect(tr.appliedTids).toEqual([]);
        expect(tr.rejected[0]).toContain('stale-generation');
    });

    it('preflight drops invalid return/ESP restore before touching the current CPU', () => {
        const { d, tr, sched, setCurrent } = mkWithScheduler();
        setCurrent(3);
        tr.parked.add(3);
        sched.validateAsyncRestoreTarget = () => ({ ok: false, reason: 'invalid-returnAddr 0x141 T3' });
        d._callbackManager = { hasInFlightCallbacks: () => false, getPendingCount: () => 0, hasSavedThunkContext: () => false };
        d.pendingAsyncRestores = [restore(3, 'badRet', 4)];

        const applied = d.tryApplyPendingAsyncRestoreAtSafePoint(cpu, 'yieldToHost.resume');

        expect(applied).toBe(false);
        expect(d.pendingAsyncRestores.length).toBe(0);
        expect(tr.woken).toEqual([]);
        expect(tr.appliedTids).toEqual([]);
        expect(tr.rejected[0]).toContain('invalid-returnAddr');
    });

    it('returns false (no work) when the queue is empty', () => {
        const { d } = mkWithScheduler();
        d.pendingAsyncRestores = [];
        expect(d.tryApplyPendingAsyncRestoreAtSafePoint(cpu)).toBe(false);
    });
});

// Async-restore ESP reconciliation — the invariant behind the Re-Volt mac wild-EBP wedge.
// `_restoreAsyncContext` used to force `esp = parkEsp + 4 + cleanupBytes` unconditionally; if
// the recorded cleanup disagreed with the RET N v86 actually executed on the same-thread
// early-wake path, ESP was shifted and a later `pop ebp` loaded a wrong slot → wild EBP.
// reconcileAsyncRestoreEsp() trusts v86's live ESP only when it provably ran a divergent RET N.
describe('ThunkDispatcher.reconcileAsyncRestoreEsp (async-restore ESP invariant)', () => {
    const parkEsp = 0x10ffbf0; // Re-Volt Flip park ESP from the crash trace

    it('keeps computed newEsp when v86 ran the matching RET N (normal case, no-op)', () => {
        // Flip cleanup=12: liveEsp = parkEsp+4+12 = computed newEsp → trust the computed value.
        const liveEsp = (parkEsp + 4 + 12) >>> 0;
        const r = ThunkDispatcher.reconcileAsyncRestoreEsp(parkEsp, 12, liveEsp);
        expect(r.esp).toBe((parkEsp + 4 + 12) >>> 0);
        expect(r.mismatch).toBe(false);
    });

    it('keeps computed newEsp on the cross-thread/context-restore state (liveEsp === parkEsp+4)', () => {
        // performSwitch restored the parked context with esp = parkEsp+4 (no stub RET N ran);
        // newEsp is authoritative here and must NOT be second-guessed.
        const liveEsp = (parkEsp + 4) >>> 0;
        const r = ThunkDispatcher.reconcileAsyncRestoreEsp(parkEsp, 12, liveEsp);
        expect(r.esp).toBe((parkEsp + 4 + 12) >>> 0);
        expect(r.mismatch).toBe(false);
    });

    it('trusts v86 live ESP when it ran a RET N divergent from the recorded cleanup', () => {
        // Recorded cleanup=12 but v86 actually executed RET 8 → liveEsp = parkEsp+4+8.
        // Forcing newEsp (parkEsp+16) would shift ESP up by 4 → wild EBP on the next pop.
        const liveEsp = (parkEsp + 4 + 8) >>> 0;
        const r = ThunkDispatcher.reconcileAsyncRestoreEsp(parkEsp, 12, liveEsp);
        expect(r.esp).toBe(liveEsp);
        expect(r.mismatch).toBe(true);
    });

    it('keeps computed newEsp when the stub RET N has not executed at all (liveEsp === parkEsp)', () => {
        // Early-wake applied the restore before v86 ever resumed the stub tail — ESP is
        // untouched since the OUT. Trusting the live ESP here applies the pre-RET-N value
        // (short by 4+cleanup) → wild EBP → guest SEH exit (NFSU LoadLibraryA cleanup=4 /
        // Present cleanup=20 crash signature; became frequent with the wasm park-exit).
        const liveEsp = parkEsp >>> 0;
        const r = ThunkDispatcher.reconcileAsyncRestoreEsp(parkEsp, 20, liveEsp);
        expect(r.esp).toBe((parkEsp + 4 + 20) >>> 0);
        expect(r.mismatch).toBe(false);
    });

    // A live ESP that cannot be a RET N from parkEsp belongs to ANOTHER thread: the completion
    // is applied from a peer's slice (the modal dialog pump dispatches callbacks while its peers
    // are parked), so the shared register file holds the peer's ESP. Adopting it gave the resumed
    // thread a foreign stack, whose next park recorded a saved ESP inside the peer's live frame;
    // the pump's next invokeCallback then overwrote the peer's return address and the peer RET'd
    // into the bootloader (HP CoS: EIP=0x7c07, "parked-stack write violation").
    it('ignores a live ESP below parkEsp (another thread stack) and keeps the recorded cleanup', () => {
        const t3ParkEsp = 0x170ffb0; // T3 parked in its own stack [0x1610000,0x1710000)
        const t1LiveEsp = 0x10fefc4; // T1's ESP — a different stack entirely
        const r = ThunkDispatcher.reconcileAsyncRestoreEsp(t3ParkEsp, 16, t1LiveEsp);
        expect(r.esp).toBe((t3ParkEsp + 4 + 16) >>> 0);
        expect(r.mismatch).toBe(false);
    });

    it('ignores a live ESP implausibly far ABOVE parkEsp', () => {
        const liveEsp = (parkEsp + 0x10000) >>> 0; // no stdcall stub pops 64 KiB
        const r = ThunkDispatcher.reconcileAsyncRestoreEsp(parkEsp, 12, liveEsp);
        expect(r.esp).toBe((parkEsp + 4 + 12) >>> 0);
        expect(r.mismatch).toBe(false);
    });

    it('ignores a misaligned live ESP (a RET N moves ESP in dword steps)', () => {
        const liveEsp = (parkEsp + 4 + 9) >>> 0;
        const r = ThunkDispatcher.reconcileAsyncRestoreEsp(parkEsp, 12, liveEsp);
        expect(r.esp).toBe((parkEsp + 4 + 12) >>> 0);
        expect(r.mismatch).toBe(false);
    });

    it('still trusts a divergent RET N at the top of the plausible range', () => {
        const liveEsp = (parkEsp + 4 + ThunkDispatcher.MAX_STUB_CLEANUP_BYTES) >>> 0;
        const r = ThunkDispatcher.reconcileAsyncRestoreEsp(parkEsp, 12, liveEsp);
        expect(r.esp).toBe(liveEsp);
        expect(r.mismatch).toBe(true);
    });
});

// EBP-sanity tripwire — a guest frame pointer outside the thread stack pointing at non-writable
// memory is the fingerprint of the Re-Volt mac wedge (EBP=0x2130d16 while the real saved-EBP
// chain stayed on the stack). Diagnostic-only: it records a note, never throws. Mirrors
// The park instruction is `JMP $` (EB FE) at spinLoopAddress and nothing else; the bytes after
// it are live SEH machinery (+2 the `JMP EAX` catch-funclet gadget, +4 the hardware-exception
// dispatch stub). Every caller of this predicate goes on to overwrite EIP/ESP/EAX, so treating
// a thread that is mid-unwind as "parked" destroys its continuation.
describe('ThunkDispatcher.isParkedAtSpinLoop (park vs SEH machinery)', () => {
    it('accepts only the exact park address', () => {
        const d = mkDispatcher();
        bindMemory(d);
        expect(d.isParkedAtSpinLoop(SPIN_ADDR)).toBe(true);
    });

    it('rejects the SEH stubs sharing the spin-loop page', () => {
        const d = mkDispatcher();
        bindMemory(d);
        for (const off of [1, 2, 3, 4, 0x200]) {
            expect(d.isParkedAtSpinLoop(SPIN_ADDR + off)).toBe(false);
        }
    });

    it('rejects everything while the spin loop is unallocated', () => {
        const d = mkDispatcher();
        d.spinLoopAddress = 0;
        expect(d.isParkedAtSpinLoop(0)).toBe(false);
    });
});

// checkEspSanity (stack bounds + FPO/alt-stack tolerance). No addressSpace is wired in the test,
// so an out-of-stack EBP is treated as not-writable → flagged.
describe('ThunkDispatcher.checkEbpSanity (frame-pointer tripwire)', () => {
    const STACK_BASE = 0x1000000, STACK_TOP = 0x1100000; // T1 stack from the crash dump
    const withBounds = (): any => {
        const d = mkDispatcher();
        d.curStackBase = STACK_BASE;
        d.curStackTop = STACK_TOP;
        return d;
    };

    it('stays quiet for an in-stack frame pointer', () => {
        const d = withBounds();
        d.checkEbpSanity(0x10ffb34, 'mss32:_AIL_start_sample@4'); // real saved-EBP from the dump
        expect(d.getLastWildEbpNote()).toBeNull();
    });

    it('skips the check when the thread stack bounds are unknown', () => {
        const d = mkDispatcher(); // curStackBase/Top default to 0
        d.checkEbpSanity(0x2130d16, 'mss32:_AIL_start_sample@4');
        expect(d.getLastWildEbpNote()).toBeNull();
    });

    it('flags an out-of-stack, non-writable EBP (the observed wedge value)', () => {
        const d = withBounds();
        d.checkEbpSanity(0x2130d16, 'mss32:_AIL_start_sample@4');
        const note = d.getLastWildEbpNote();
        expect(note).toBeTruthy();
        expect(note).toContain('wild EBP');
        expect(note).toContain('2130d16');
    });

    it('flags obvious garbage EBP', () => {
        const d = withBounds();
        d.checkEbpSanity(0xffffffff, 'k32:Sleep@4');
        expect(d.getLastWildEbpNote()).toContain('wild EBP');
    });

    // FPO callers hold a COM vtable / export-stub pointer in EBP at COM method entries; those
    // pointers live in the synthetic band [MEM_THUNK_CODE_BASE, MEM_THUNK_DATA_BASE+SIZE) =
    // [0x21000000, 0x23000000). Observed false positives: 0x21047930 (Surface8::Release),
    // 0x210458e0 (IMediaEventEx::GetEvent). A mis-popped saved-EBP lands in guest memory, not here.
    it('stays quiet for an EBP in the synthetic thunk/vtable band (FPO COM pointer)', () => {
        const d = withBounds();
        d.checkEbpSanity(0x210458e0, 'quartz:IMediaEventEx_GetEvent');
        expect(d.getLastWildEbpNote()).toBeNull();
        d.checkEbpSanity(0x21047930, 'd3d8:IDirect3DSurface8_Release');
        expect(d.getLastWildEbpNote()).toBeNull();
    });
});
