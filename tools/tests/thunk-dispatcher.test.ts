// Characterization harness for ThunkDispatcher (god-object #1).
// The constructor only needs a v86 handle
// (no WASM/DOM), so it instantiates clean in isolation with a fake. We then pin the
// pure sub-functions that the async-park / sync-RET paths depend on, ahead of the
// async-park atomicization. These are CHARACTERIZATION tests: they
// assert what the code does TODAY. Pin first, slice second.

import { describe, it, expect } from 'bun:test';
import { ThunkDispatcher } from '../../src/worker/core/thunking/thunk-dispatcher';
import { preemptionManager } from '../../src/worker/core/cpu/preemption-manager';

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

describe('ThunkDispatcher — WBUF dynarec lifecycle', () => {
    it('clears stale descriptors on reset and re-registers VS/PS/barrier hot slots', () => {
        let generation = 0;
        const names = [
            'IDirect3DDevice9_SetVertexShaderConstantF',
            'IDirect3DDevice9_SetPixelShaderConstantF',
            'IDirect3DDevice9_DrawIndexedPrimitive',
        ];
        const makeStubs = () => names.map((functionName, i) => ({
            dllName: 'd3d9', functionName,
            functionId: 100 + generation * 10 + i,
            address: 0x1000 + generation * 0x300 + i * 0x20,
            argCount: i < 2 ? 4 : 7,
            stackCleanupBytes: i < 2 ? 16 : 28,
        }));
        let stubs = makeStubs();
        const generator = {
            findStubsByName: (dll: string, fn: string) => stubs.filter(s =>
                s.dllName.toLowerCase() === dll.toLowerCase() && s.functionName.toLowerCase() === fn.toLowerCase()),
            getAllStubs: () => stubs,
            getStubById: (id: number) => stubs.find(s => s.functionId === id),
        };
        const registrations: number[][] = [];
        const hot: number[][] = [];
        let clears = 0;
        const exports = {
            jit_dirty_cache: () => {},
            jit_wbuf_intrinsic_set_enabled: () => {},
            jit_wbuf_intrinsic_register: (...args: number[]) => { registrations.push(args); return 1; },
            jit_wbuf_intrinsic_mark_hot: (...args: number[]) => { hot.push(args); return 1; },
            jit_wbuf_intrinsic_clear_registry: () => { clears++; },
        };
        const pm = preemptionManager as any;
        const oldExports = pm.wasmExports;
        pm.wasmExports = exports;
        try {
            const d = new ThunkDispatcher({ add_listener: () => {} } as any, generator as any) as any;
            bindMemory(d, 0x10000);
            d.writeBufControlAddr = 0x3000;
            d.writeBufDataBase = 0x4000;
            d.writeBufCapacity = 0x2000;
            d.writeBufTrampolineAddrs[12] = 0x2800; // seven-arg stdcall barrier
            d.writeBufTrampolineAddrs[20] = 0x2900; // shader constants
            const handler = () => {};

            d.registerShaderConstantWriteBufferFunction('d3d9', names[0], handler);
            d.registerShaderConstantWriteBufferFunction('d3d9', names[1], handler);
            d.registerWriteBufferFunction('d3d9', names[2], 7, handler, true, 0, { barrier: true });
            expect(hot.map(args => args[0])).toEqual([0, 1, 2]);

            d.reset();
            expect(clears).toBe(1);
            generation++;
            stubs = makeStubs();
            d.applyPendingRegistrations();

            expect(registrations.slice(-3).map(args => [args[0], args[1]])).toEqual(
                stubs.map(s => [s.address, s.functionId]),
            );
            expect(hot.slice(-3).map(args => args[0])).toEqual([0, 1, 2]);
        } finally {
            pm.wasmExports = oldExports;
        }
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

describe('ThunkDispatcher.drainWriteBuffer — prefix-fusion consumer that throws', () => {
    const F = 10;   // first-constant id that opens a pair run
    const M = 11;   // ordinary setter between the constant and the prefix draw
    const D = 12;   // draw id (the pair run's second half, and the prefix draw)
    const CONTROL = 0x3000;
    const DATA = 0x4000;

    /** Ring: F, M, D(prefix draw), then the exact F/D pair run the consumer is offered. */
    function layout(mem32: Uint32Array): number {
        const at = (offset: number) => (DATA + offset) >> 2;
        const ids = [F, M, D, F, D, F, D];
        ids.forEach((id, i) => { mem32[at(i * 8)] = id; });
        return ids.length * 8;
    }

    function setup(pairRunHandler: any) {
        const d = mkDispatcher();
        const mem = new Uint8Array(0x10000);
        const mem32 = new Uint32Array(mem.buffer);
        d.cachedMem8 = mem;
        d.cachedMem32 = mem32;
        d.memLength = mem.length;
        d.writeBufControlAddr = CONTROL;
        d.writeBufDataBase = DATA;
        d.writeBufCapacity = 0x2000;

        const calls: Array<{ id: number; offset: number }> = [];
        for (const id of [F, M, D]) {
            d.writeBufArgCountTable[id] = 1;
            d.writeBufHandlerTable[id] = (_m8: Uint8Array, _m32: Uint32Array, addr: number) => {
                calls.push({ id, offset: addr - 4 - DATA });
            };
        }
        d.writeBufBarrierTable[D] = 1;
        d.writeBufPairRunByFirst[F] = [{ secondIds: new Set([D]), handler: pairRunHandler }];

        const head = layout(mem32);
        mem32[CONTROL >> 2] = head;
        return { d, mem32, calls, head };
    }

    it('declines to the ordinary path instead of replaying the applied prefix entries', () => {
        // The consumer is offered the fused run first (7 args) and throws; the constant and the
        // middle setter it has already applied must not be applied a second time.
        const offers: number[] = [];
        const { d, mem32, calls, head } = setup((...args: any[]) => {
            offers.push(args.length);
            if (args.length > 5) throw new Error('consumer blew up mid-run');
            return false;
        });

        d.drainWriteBuffer();

        expect(offers[0]).toBe(7);
        // Every ring entry applied exactly once, in ring order.
        expect(calls).toEqual([
            { id: F, offset: 0 },
            { id: M, offset: 8 },
            { id: D, offset: 16 },
            { id: F, offset: 24 },
            { id: D, offset: 32 },
            { id: F, offset: 40 },
            { id: D, offset: 48 },
        ]);
        // Fully drained: the head reset only fires when wbufTail reached the segment end.
        expect(mem32[CONTROL >> 2]).toBe(0);
        expect(d.wbufTail).toBe(0);
        expect(d.getWbufStats().fusedConsumerThrows).toBe(1);
        expect(head).toBe(56);
    });

    it('consumes the fused run when the consumer accepts it', () => {
        const { d, mem32, calls } = setup(() => true);

        d.drainWriteBuffer();

        // The consumer owns the prefix draw and the whole tail run; only the constant and the
        // middle setter reach ordinary handlers.
        expect(calls).toEqual([
            { id: F, offset: 0 },
            { id: M, offset: 8 },
        ]);
        expect(mem32[CONTROL >> 2]).toBe(0);
        expect(d.getWbufStats().fusedConsumerThrows).toBe(0);
    });
});
