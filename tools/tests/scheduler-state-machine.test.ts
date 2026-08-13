/**
 * Characterization harness — Scheduler thread state-machine + context save +
 * async-park invariants.
 *
 * This is the PREREQUISITE for safely slicing scheduler.ts: it pins the current
 * behavior of the riskiest invariants ("encode, don't remember") so any future
 * refactor that changes them fails here first. These are
 * CHARACTERIZATION tests: they assert what the code does TODAY, not an idealized
 * spec. If a deliberate behavior change lands, update the expectation with intent.
 *
 * Everything runs against a real `new Scheduler()` with fake V86Cpu / in-memory
 * threads — no v86, no DOM, no browser. The Scheduler instantiates cleanly in
 * isolation (verified): its only construction-time deps are benign singletons.
 */

import { describe, expect, test } from "bun:test";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import {
    ThreadState,
    THREAD_STATE_NAMES,
    WaitReason,
    TimerKind,
    ThunkBoundaryKind,
    isValidTransition,
    WAIT_OBJECT_0,
    WAIT_BLOCKED_NO_SWITCH,
    WAIT_TIMEOUT,
    INFINITE,
    type Thread,
    type CpuContext,
    type V86Cpu,
} from "../../src/worker/core/scheduler/types";
import { TimerWheel } from "../../src/worker/core/scheduler/timer-wheel";
import {
    saveCpuContext,
    createInitialContext,
    createPostReturnContext,
} from "../../src/worker/core/scheduler/scheduler-context";
import { TARGET_INSN_PER_MS } from "../../src/worker/core/scheduler/timing";
import {
    DEFAULT_SCHEDULER_CONFIG, MAXIMUM_SUSPEND_COUNT, ERROR_SIGNAL_REFUSED,
} from "../../src/worker/core/scheduler/types";
import { hypercallDataManager } from "../../src/worker/core/cpu/hypercall-data";
import { hasFpuSimdDirtyFlag } from "../../src/worker/core/fpu-helper";

const ALL_STATES: ThreadState[] = [
    ThreadState.CREATED,
    ThreadState.READY,
    ThreadState.RUNNING,
    ThreadState.WAITING,
    ThreadState.SUSPENDED,
    ThreadState.TERMINATED,
];

// ─── Fakes ──────────────────────────────────────────────────────────────────

function fakeCpu(init: { eax?: number; esp?: number; ebp?: number; eip?: number; eflags?: number; insn?: number } = {}): V86Cpu {
    const reg32 = new Int32Array(8);
    const instruction_pointer = new Int32Array(1);
    const flags = new Int32Array(1);
    const sreg = new Int16Array(8);
    const segment_offsets = new Int32Array(8); // index 4 = FS base (TEB)
    // Retired-instruction counter drives the preemption quantum. Default well above any quantum
    // (threads stamp lastSwitchInsn=0) so the quantum reads as expired — matching the legacy
    // "lastSwitchTime=0 ≫ minQuantumMs" default these tests were written against.
    const instruction_counter = new Int32Array(1);
    instruction_counter[0] = init.insn ?? 10_000_000;
    reg32[0] = init.eax ?? 0;
    reg32[4] = init.esp ?? 0;
    reg32[5] = init.ebp ?? 0;
    instruction_pointer[0] = init.eip ?? 0;
    flags[0] = init.eflags ?? 0;
    // No fpu_get_sti_f64 → fpuSnapshot() returns null → saveCpuContext sets fpu: undefined.
    return { reg32, instruction_pointer, flags, sreg, segment_offsets, instruction_counter, is_jumping: false } as unknown as V86Cpu;
}

function mkThread(id: number, state: ThreadState): Thread {
    return {
        id,
        handle: 0x1000 + id,
        state,
        context: null,
        stackBase: 0x00200000,
        stackSize: 0x00100000,
        stackTop: 0x00300000,
        startAddress: 0x00401000,
        parameter: 0,
        waitInfo: null,
        exitCode: null,
        tlsValues: new Map(),
        lastError: 0,
        suspendCount: 0,
        priority: 0,
        lastSwitchTime: 0,
        lastSwitchInsn: 0,
        tebAddress: 0,
        kernelPinCount: 0,
        apcQueue: [],
        quitPosted: false,
        quitExitCode: 0,
        asyncParkGeneration: 0,
    };
}

/** Inject a thread directly into scheduler bookkeeping (bypasses CreateThread). */
function inject(s: Scheduler, t: Thread, opts: { runnable?: boolean; current?: boolean } = {}): Thread {
    const any = s as any;
    any.threads.set(t.id, t);
    if (opts.runnable && !any.runQueue.includes(t.id)) any.runQueue.push(t.id);
    if (opts.current) any.currentThreadId = t.id;
    return t;
}

// ─── 1. Transition table (pure, zero-dependency) ──────────────────────────────

describe("scheduler/isValidTransition — legal transition matrix", () => {
    // The matrix exactly as encoded today (types.ts _validTransitions + the
    // TERMINATED sink). Pinning the full 6×6 grid means a slice can't silently
    // widen or narrow legality.
    const LEGAL: Record<ThreadState, ThreadState[]> = {
        [ThreadState.CREATED]: [ThreadState.READY, ThreadState.SUSPENDED],
        [ThreadState.READY]: [ThreadState.RUNNING, ThreadState.WAITING, ThreadState.SUSPENDED, ThreadState.TERMINATED],
        [ThreadState.RUNNING]: [ThreadState.READY, ThreadState.WAITING, ThreadState.SUSPENDED, ThreadState.TERMINATED],
        [ThreadState.WAITING]: [ThreadState.READY, ThreadState.SUSPENDED, ThreadState.TERMINATED],
        [ThreadState.SUSPENDED]: [ThreadState.READY, ThreadState.TERMINATED],
        [ThreadState.TERMINATED]: [ThreadState.TERMINATED],
    };

    for (const from of ALL_STATES) {
        for (const to of ALL_STATES) {
            const legal = LEGAL[from].includes(to);
            test(`${THREAD_STATE_NAMES[from]} -> ${THREAD_STATE_NAMES[to]} is ${legal ? "legal" : "illegal"}`, () => {
                expect(isValidTransition(from, to)).toBe(legal);
            });
        }
    }

    test("no self-transition is legal except TERMINATED->TERMINATED", () => {
        for (const s of ALL_STATES) {
            expect(isValidTransition(s, s)).toBe(s === ThreadState.TERMINATED);
        }
    });

    test("TERMINATED is an absorbing sink (only -> TERMINATED)", () => {
        for (const to of ALL_STATES) {
            expect(isValidTransition(ThreadState.TERMINATED, to)).toBe(to === ThreadState.TERMINATED);
        }
    });
});

// ─── 2. transitionTo side-effects (real Scheduler, no CPU) ────────────────────

describe("scheduler/transitionTo — side effects", () => {
    test("illegal transition is rejected and leaves state untouched", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(1, ThreadState.WAITING));
        const before = t.waitInfo;
        const r = (s as any).transitionTo(t, ThreadState.RUNNING, null, null);
        expect(r.success).toBe(false);
        expect(typeof r.error).toBe("string");
        expect(t.state).toBe(ThreadState.WAITING); // unchanged
        expect(t.waitInfo).toBe(before);
        expect((s as any).currentThreadId).toBeNull();
    });

    test("READY -> RUNNING: clears context, sets currentThreadId, leaves runQueue", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(1, ThreadState.READY), { runnable: true });
        t.context = { eip: 0x401000 } as CpuContext;
        const r = (s as any).transitionTo(t, ThreadState.RUNNING, null, null);
        expect(r.success).toBe(true);
        expect(t.state).toBe(ThreadState.RUNNING);
        expect(t.context).toBeNull(); // RUNNING ⇔ state lives in CPU
        expect((s as any).currentThreadId).toBe(1);
        expect((s as any).runQueue).not.toContain(1);
    });

    test("RUNNING -> WAITING: saves context, sets waitInfo, not enqueued", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        const ctx = { eip: 0x402000, esp: 0x290000 } as CpuContext;
        const wait = { reason: WaitReason.SLEEP, handles: [], waitAll: false, timeoutTimerId: 0, alertable: false, csAddress: 0 };
        const r = (s as any).transitionTo(t, ThreadState.WAITING, wait, ctx);
        expect(r.success).toBe(true);
        expect(t.state).toBe(ThreadState.WAITING);
        expect(t.waitInfo).toBe(wait);
        expect(t.context).toBe(ctx);
        expect((s as any).runQueue).not.toContain(1);
    });

    test("-> READY enqueues exactly once (no duplicates)", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        (s as any).transitionTo(t, ThreadState.READY, null, { eip: 0x401000 } as CpuContext);
        // Force a second READY arrival via SUSPENDED round-trip.
        (s as any).transitionTo(t, ThreadState.SUSPENDED, null, t.context);
        (s as any).transitionTo(t, ThreadState.READY, null, t.context);
        const occurrences = (s as any).runQueue.filter((id: number) => id === 1).length;
        expect(occurrences).toBe(1);
    });
});

// ─── 3. Context save (saveCpuContext) + async restore CPU write ─────────────────

describe("scheduler/saveCpuContext — CPU -> CpuContext snapshot", () => {
    test("captures all 8 GPRs + eip + eflags + domain; fpu undefined on bare CPU", () => {
        const s = new Scheduler();
        const cpu = fakeCpu({ eax: 0x11111111, esp: 0x0028ff00, ebp: 0x0028ff80, eip: 0x00401234, eflags: 0x202 });
        cpu.reg32[1] = 0x22222222; // ecx
        cpu.reg32[6] = 0x66666666; // esi
        const ctx: CpuContext = saveCpuContext(cpu, "spin");
        expect(ctx.eax >>> 0).toBe(0x11111111);
        expect(ctx.ecx >>> 0).toBe(0x22222222);
        expect(ctx.esi >>> 0).toBe(0x66666666);
        expect(ctx.esp >>> 0).toBe(0x0028ff00);
        expect(ctx.ebp >>> 0).toBe(0x0028ff80);
        expect(ctx.eip >>> 0).toBe(0x00401234);
        expect(ctx.eflags >>> 0).toBe(0x202);
        expect(ctx.domain).toBe("spin");
        expect(ctx.fpu).toBeUndefined();
    });
});

describe("scheduler/applyAsyncRestoreCpuState — writes eip/esp/eax + is_jumping", () => {
    test("overwrites exactly the documented registers and sets is_jumping", () => {
        const s = new Scheduler();
        const cpu = fakeCpu({ eax: 1, esp: 2, eip: 3 });
        const ok = s.applyAsyncRestoreCpuState(cpu, 0x00408000, 0x0028fe00, 0xdeadbeef, "test");
        expect(ok).toBe(true);
        expect(cpu.reg32[0] >>> 0).toBe(0xdeadbeef);
        expect(cpu.reg32[4] >>> 0).toBe(0x0028fe00);
        expect(cpu.instruction_pointer[0] >>> 0).toBe(0x00408000);
        expect(cpu.is_jumping).toBe(true);
    });

    test("with target metadata, rejects invalid return EIP and leaves CPU untouched", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(2, ThreadState.RUNNING), { current: true });
        t.asyncParkGeneration = 3;
        const cpu = fakeCpu({ eax: 0xaaaa, esp: 0x0028ff00, eip: 0x00401000 });
        const ok = s.applyAsyncRestoreCpuState(cpu, 0x141, 0x0028ff10, 0xbbbb, "test-invalid", {
            threadId: 2,
            asyncParkGeneration: 3,
            completionName: "bad",
            functionId: 0x44,
            cleanupBytes: 4,
        });
        expect(ok).toBe(false);
        expect(cpu.reg32[0] >>> 0).toBe(0xaaaa);
        expect(cpu.reg32[4] >>> 0).toBe(0x0028ff00);
        expect(cpu.instruction_pointer[0] >>> 0).toBe(0x00401000);
        expect(t.state).toBe(ThreadState.TERMINATED);
    });

    test("with target metadata, consumes the generation after a successful restore", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(2, ThreadState.RUNNING), { current: true });
        t.asyncParkGeneration = 3;
        const cpu = fakeCpu({ eax: 1, esp: 0x0028ff00, eip: 0x00401000 });
        const ok = s.applyAsyncRestoreCpuState(cpu, 0x00408000, 0x0028ff10, 0x2222, "test-valid", {
            threadId: 2,
            asyncParkGeneration: 3,
            completionName: "ok",
            functionId: 0x44,
            cleanupBytes: 4,
        });
        expect(ok).toBe(true);
        expect(cpu.reg32[0] >>> 0).toBe(0x2222);
        expect(t.asyncParkGeneration).toBe(4);
    });

    test("with target metadata, rejects stale async park generation", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(2, ThreadState.WAITING), { current: true });
        t.asyncParkGeneration = 7;
        t.waitInfo = { reason: WaitReason.ASYNC_THUNK, handles: [], waitAll: false, timeoutTimerId: 0, alertable: false, csAddress: 0 };
        const cpu = fakeCpu({ eax: 0x1111, esp: 0x0028ff00, eip: 0x00401000 });
        const ok = s.applyAsyncRestoreCpuState(cpu, 0x00408000, 0x0028ff10, 0x2222, "test-stale", {
            threadId: 2,
            asyncParkGeneration: 6,
            completionName: "stale",
            functionId: 0x45,
            cleanupBytes: 4,
        });
        expect(ok).toBe(false);
        expect(cpu.reg32[0] >>> 0).toBe(0x1111);
        expect(t.state).toBe(ThreadState.WAITING); // stale restore is dropped, not applied/terminated
    });
});

// ─── 4. Async-park marquee invariant ─────────────────────────────────────────

describe("scheduler/markThreadAsyncParked — RUNNING -> WAITING(ASYNC_THUNK)", () => {
    test("parks a RUNNING thread as WAITING with reason ASYNC_THUNK and saves context", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        const cpu = fakeCpu({ eip: 0x00405000, esp: 0x0028ff00 });
        const ok = s.markThreadAsyncParked(1, cpu);
        expect(ok).toBe(true);
        expect(t.state).toBe(ThreadState.WAITING);
        expect(t.waitInfo?.reason).toBe(WaitReason.ASYNC_THUNK);
        expect(s.isThreadAsyncParked(1)).toBe(true);
        expect(t.context).not.toBeNull(); // saved for later restore
        expect(t.asyncParkGeneration).toBe(1);
        expect(s.getAsyncParkGeneration(1)).toBe(1);
    });

    test("refuses to park a thread that is not RUNNING", () => {
        const s = new Scheduler();
        inject(s, mkThread(1, ThreadState.READY), { runnable: true });
        expect(s.markThreadAsyncParked(1, fakeCpu())).toBe(false);
        expect((s as any).threads.get(1).state).toBe(ThreadState.READY);
    });

    test("refuses a nested park (already WAITING)", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        expect(s.markThreadAsyncParked(1, fakeCpu({ eip: 0x405000 }))).toBe(true);
        expect(s.markThreadAsyncParked(1, fakeCpu({ eip: 0x405000 }))).toBe(false); // nested
        expect(t.state).toBe(ThreadState.WAITING);
        expect(t.asyncParkGeneration).toBe(1);
    });
});

describe("scheduler/markThreadRunningAfterAsyncWake — READY(current) -> RUNNING", () => {
    test("promotes the current READY thread to RUNNING", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(1, ThreadState.READY), { runnable: true, current: true });
        expect(s.markThreadRunningAfterAsyncWake(1)).toBe(true);
        expect(t.state).toBe(ThreadState.RUNNING);
    });

    test("refuses when the thread is not the current thread", () => {
        const s = new Scheduler();
        inject(s, mkThread(1, ThreadState.READY), { runnable: true });
        inject(s, mkThread(2, ThreadState.RUNNING), { current: true });
        expect(s.markThreadRunningAfterAsyncWake(1)).toBe(false);
        expect((s as any).threads.get(1).state).toBe(ThreadState.READY);
    });
});

// ─── 5. suspend / resume / terminate (the bespoke-side-effect state writes) ────
// These paths bypass transitionTo to manage their own side effects; characterize
// them before routing their raw `.state =` through the guarded setThreadState.

describe("scheduler/suspendThread", () => {
    test("RUNNING -> SUSPENDED, suspendCount++, returns previous count", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        expect(s.suspendThread(t.handle)).toBe(0); // prev count
        expect(t.state).toBe(ThreadState.SUSPENDED);
        expect(t.suspendCount).toBe(1);
    });

    test("READY -> SUSPENDED removes it from the run queue", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(1, ThreadState.READY), { runnable: true });
        s.suspendThread(t.handle);
        expect(t.state).toBe(ThreadState.SUSPENDED);
        expect((s as any).runQueue).not.toContain(1);
    });

    test("WAITING -> SUSPENDED (deferred resume checks suspendCount later)", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(1, ThreadState.WAITING));
        s.suspendThread(t.handle);
        expect(t.state).toBe(ThreadState.SUSPENDED);
    });

    test("nested suspend increments count, stays SUSPENDED", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        s.suspendThread(t.handle);
        expect(s.suspendThread(t.handle)).toBe(1); // prev = 1
        expect(t.suspendCount).toBe(2);
        expect(t.state).toBe(ThreadState.SUSPENDED);
    });

    test("TERMINATED thread is rejected (returns -1, state untouched)", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(1, ThreadState.TERMINATED));
        expect(s.suspendThread(t.handle) >>> 0).toBe(0xFFFFFFFF);
        expect(t.state).toBe(ThreadState.TERMINATED);
    });

    // Engines that use Suspend/Resume as a spin-sync primitive out-suspend their own
    // resumes; Win32 refuses past MAXIMUM_SUSPEND_COUNT instead of counting on forever.
    test("refuses past MAXIMUM_SUSPEND_COUNT: -1, count pinned, ERROR_SIGNAL_REFUSED", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        t.suspendCount = MAXIMUM_SUSPEND_COUNT - 1;
        expect(s.suspendThread(t.handle)).toBe(MAXIMUM_SUSPEND_COUNT - 1); // last one allowed
        expect(t.suspendCount).toBe(MAXIMUM_SUSPEND_COUNT);

        expect(s.suspendThread(t.handle) >>> 0).toBe(0xFFFFFFFF);
        expect(t.suspendCount).toBe(MAXIMUM_SUSPEND_COUNT); // NOT 128
        expect(t.lastError).toBe(ERROR_SIGNAL_REFUSED);
    });

    // The fast path must defer at the cap: it cannot set a last error itself.
    test("suspendThreadFast defers to the slow path at the cap", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        t.suspendCount = MAXIMUM_SUSPEND_COUNT - 1;
        expect(s.suspendThreadFast(t.handle)).toBe(MAXIMUM_SUSPEND_COUNT - 1);
        expect(s.suspendThreadFast(t.handle)).toBeNull();
        expect(t.suspendCount).toBe(MAXIMUM_SUSPEND_COUNT);
    });
});

describe("scheduler/resumeThread", () => {
    test("last resume (count 1->0) flips SUSPENDED -> READY and enqueues", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(1, ThreadState.SUSPENDED));
        t.suspendCount = 1;
        expect(s.resumeThread(t.handle)).toBe(1); // prev count
        expect(t.state).toBe(ThreadState.READY);
        expect((s as any).runQueue).toContain(1);
    });

    test("still-suspended (count 2->1) stays SUSPENDED", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(1, ThreadState.SUSPENDED));
        t.suspendCount = 2;
        expect(s.resumeThread(t.handle)).toBe(2);
        expect(t.suspendCount).toBe(1);
        expect(t.state).toBe(ThreadState.SUSPENDED);
    });
});

describe("scheduler/terminateThread", () => {
    test("any live state -> TERMINATED, clears context/waitInfo, dequeues", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        t.context = { eip: 0x401000 } as CpuContext;
        (s as any).terminateThread(1, 0x2a);
        expect(t.state).toBe(ThreadState.TERMINATED);
        expect(t.exitCode).toBe(0x2a);
        expect(t.context).toBeNull();
        expect(t.waitInfo).toBeNull();
        expect((s as any).runQueue).not.toContain(1);
    });

    test("already TERMINATED is a no-op", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(1, ThreadState.TERMINATED));
        t.exitCode = 7;
        (s as any).terminateThread(1, 99);
        expect(t.exitCode).toBe(7); // unchanged
    });
});

// ─── 6. context save/restore round-trip + EIP-domain policy ───────────────────
// The "CPU state survives a context switch" invariant. (FPU round-trip needs a
// richer CPU fake with fpu_get_sti_f64 — deferred; here fpu is undefined and the
// restore path skips fpuRestore, which is the documented bare-CPU behavior.)

describe("scheduler/saveCpuContext -> restoreContext round-trip", () => {
    test("preserves all 8 GPRs + eip + eflags across save/restore", () => {
        const s = new Scheduler();
        const src = fakeCpu({ eip: 0x00401234, eflags: 0x246 });
        for (let i = 0; i < 8; i++) src.reg32[i] = (0x11111111 * (i + 1)) | 0;
        const ctx: CpuContext = saveCpuContext(src, "guest");

        const dst = fakeCpu(); // zeroed — simulates another thread having run
        const ok = (s as any).restoreContext(dst, ctx);
        expect(ok).toBe(true);
        for (let i = 0; i < 8; i++) expect(dst.reg32[i] >>> 0).toBe(src.reg32[i] >>> 0);
        expect(dst.instruction_pointer[0] >>> 0).toBe(0x00401234);
        expect(dst.flags[0] >>> 0).toBe(0x246);
        expect(dst.is_jumping).toBe(true);
    });

    test("rejects an out-of-range (non-guest) EIP and writes nothing", () => {
        const s = new Scheduler();
        const ctx = createInitialContext(0x00401000, 0x00290000);
        ctx.eip = 0x50; // below GUEST_CODE_MIN (0x100000)
        const dst = fakeCpu({ eax: 0x0000aaaa });
        const ok = (s as any).restoreContext(dst, ctx);
        expect(ok).toBe(false);
        expect(dst.reg32[0] >>> 0).toBe(0x0000aaaa); // untouched
    });

    test("materializes lazy EFLAGS on save and clears flags_changed on restore", () => {
        // v86 computes arithmetic flags lazily (flags + flags_changed + last_op*/
        // last_result). Guest threads share that state; a switch must (a) save the
        // MATERIALIZED flags via get_eflags — raw flags[0] is stale while
        // flags_changed != 0 — and (b) clear flags_changed on restore (popf
        // semantics) so the resumed thread doesn't recompute ZF/CF/SF/OF from the
        // OUTGOING thread's last ALU result. Wrong branch on resume → random
        // memory corruption (NFSU random-crash class; same family as fpu/simd).
        const s = new Scheduler();
        const src = fakeCpu({ eip: 0x00401234, eflags: 0x286 }); // raw: SF set, ZF clear
        (src as any).flags_changed = new Int32Array([0xc4]);     // lazy bits pending
        (src as any).get_eflags = () => 0x246;                   // real flags: ZF set, SF clear
        const ctx: CpuContext = saveCpuContext(src, "guest");
        expect(ctx.eflags >>> 0).toBe(0x246); // materialized, not raw flags[0]

        const dst = fakeCpu();
        (dst as any).flags_changed = new Int32Array([0xff]); // outgoing thread's leftovers
        expect((s as any).restoreContext(dst, ctx)).toBe(true);
        expect(dst.flags[0] >>> 0).toBe(0x246);
        expect((dst as any).flags_changed[0]).toBe(0); // authoritative flags, no lazy recompute
    });

    test("denies a transient_seh context when no SEH runtime is active", () => {
        const s = new Scheduler();
        const ctx = createInitialContext(0x00401000, 0x00290000);
        ctx.domain = "transient_seh";
        ctx.domainGen = 1;
        const dst = fakeCpu({ eax: 0x0000bbbb });
        expect((s as any).restoreContext(dst, ctx)).toBe(false);
        expect(dst.reg32[0] >>> 0).toBe(0x0000bbbb); // untouched
    });
});

describe("scheduler/context factories", () => {
    test("createInitialContext: entry eip/esp, eflags=0x202, guest domain, GPRs zeroed", () => {
        const s = new Scheduler();
        const ctx = createInitialContext(0x00401000, 0x00290000);
        expect(ctx.eip >>> 0).toBe(0x00401000);
        expect(ctx.esp >>> 0).toBe(0x00290000);
        expect(ctx.eflags >>> 0).toBe(0x202);
        expect(ctx.domain).toBe("guest");
        expect(ctx.eax).toBe(0);
        expect(ctx.ebp).toBe(0);
    });

    test("createPostReturnContext: eax=returnValue, eip=returnAddr, caller regs preserved", () => {
        const s = new Scheduler();
        const caller = { ecx: 1, edx: 2, ebx: 3, ebp: 4, esi: 5, edi: 6, eflags: 0x202 };
        const ctx = createPostReturnContext(0x00408000, 0x0028ff00, caller, 0x7b);
        expect(ctx.eax >>> 0).toBe(0x7b);
        expect(ctx.eip >>> 0).toBe(0x00408000);
        expect(ctx.esp >>> 0).toBe(0x0028ff00);
        expect(ctx.ecx).toBe(1);
        expect(ctx.edi).toBe(6);
        expect(ctx.domain).toBe("guest");
    });
});

// ─── 7. SSE state (XMM + MXCSR) save/restore — the FPU-bug-class gap ───────────
// v86 implements SSE/SSE2 and we advertise it to guests; XMM + MXCSR are a shared
// register file like the x87 stack, so they must travel with the thread context.
// These offsets mirror vendor/v86 global_pointers.rs: mxcsr @ 824, reg_xmm @ 832.

const MXCSR_WASM_OFFSET = 824;
const REG_XMM_WASM_OFFSET = 832;
const FPU_SIMD_DIRTY_WASM_OFFSET = 632;
const FPU_ST_WASM_OFFSET = 1152;

/** Mimics vendor/v86/src/lib.js view() — Proxy over WASM memory, not instanceof Uint8Array. */
function v86ViewProxy(buffer: ArrayBuffer, offset: number, length: number): unknown {
    let cached: Uint8Array | null = null;
    let cachedBuffer: ArrayBuffer | null = null;
    const resolve = (): Uint8Array => {
        if (cachedBuffer !== buffer) {
            cachedBuffer = buffer;
            cached = new Uint8Array(buffer, offset, length);
        }
        return cached!;
    };
    return new Proxy(
        {},
        {
            get(_target, prop) {
                const b = resolve();
                const x = (b as Record<string | symbol, unknown>)[prop];
                if (typeof x === "function") return (x as Function).bind(b);
                return x;
            },
            set(_target, prop, value) {
                resolve()[prop as number] = value;
                return true;
            },
        },
    );
}

/** Fake CPU backed by a WASM-memory ArrayBuffer so simd/fpu snapshot can read it. */
function fakeCpuWithWasm(opts?: { exportDirtyFlag?: boolean; v86ViewProxy?: boolean }): V86Cpu {
    const buffer = new ArrayBuffer(4096);
    const cpu: Record<string, unknown> = {
        reg32: new Int32Array(8),
        instruction_pointer: new Int32Array(1),
        flags: new Int32Array(1),
        sreg: new Int16Array(8),
        is_jumping: false,
        wasm_memory: { buffer },
    };
    if (opts?.exportDirtyFlag !== false) {
        cpu.fpu_simd_dirty = opts?.v86ViewProxy
            ? v86ViewProxy(buffer, FPU_SIMD_DIRTY_WASM_OFFSET, 1)
            : new Uint8Array(buffer, FPU_SIMD_DIRTY_WASM_OFFSET, 1);
    }
    return cpu as unknown as V86Cpu;
}

describe("scheduler/SSE state survives a context switch (XMM + MXCSR)", () => {
    test("saveCpuContext captures and restoreContext restores MXCSR + XMM0..15", () => {
        const s = new Scheduler();
        const cpu = fakeCpuWithWasm();
        cpu.instruction_pointer[0] = 0x00401234; // valid guest EIP for restore
        const buf = (cpu as any).wasm_memory.buffer as ArrayBuffer;
        const dv = new DataView(buf);
        const bytes = new Uint8Array(buf);

        // Thread A's live SSE state: a non-default MXCSR + marked XMM0 / XMM7 bytes.
        // 32-bit mode has 8 XMM regs (128 bytes); XMM7's last byte is at +127.
        dv.setUint32(MXCSR_WASM_OFFSET, 0x00009fc0, true); // round-to-zero + flags
        bytes[REG_XMM_WASM_OFFSET] = 0xab;                 // XMM0, byte 0
        bytes[REG_XMM_WASM_OFFSET + 127] = 0xcd;           // XMM7, last byte
        // Guard: the byte just past the XMM file (current_tsc @ 960) must NOT be captured.
        bytes[REG_XMM_WASM_OFFSET + 128] = 0x77;

        const ctx = saveCpuContext(cpu, "guest");
        expect(ctx.simd).toBeInstanceOf(Uint8Array);

        // Thread B runs and clobbers the shared SSE register file + the TSC byte.
        dv.setUint32(MXCSR_WASM_OFFSET, 0x00001f80, true); // default MXCSR
        bytes[REG_XMM_WASM_OFFSET] = 0x00;
        bytes[REG_XMM_WASM_OFFSET + 127] = 0x00;
        bytes[REG_XMM_WASM_OFFSET + 128] = 0x11;

        // Thread A resumes — restore must bring its SSE state back, and must NOT
        // touch current_tsc (would corrupt the timestamp counter / page tables).
        expect((s as any).restoreContext(cpu, ctx)).toBe(true);
        expect(dv.getUint32(MXCSR_WASM_OFFSET, true)).toBe(0x00009fc0);
        expect(bytes[REG_XMM_WASM_OFFSET]).toBe(0xab);
        expect(bytes[REG_XMM_WASM_OFFSET + 127]).toBe(0xcd);
        expect(bytes[REG_XMM_WASM_OFFSET + 128]).toBe(0x11); // untouched by SSE restore
    });

    test("bare CPU (no WASM memory) yields undefined simd — graceful, like fpu", () => {
        const s = new Scheduler();
        const ctx = saveCpuContext(fakeCpu({ eip: 0x00401000 }), "guest");
        expect(ctx.simd).toBeUndefined();
        expect(ctx.fpu).toBeUndefined();
    });
});

// ─── 8. full performSwitch — the end-to-end switch (FS base + onThreadSwitch) ──
// restoreContext (sections 6/7) does NOT touch the FS base; performSwitch does.
// The "FS base must be updated on every switch" invariant lived
// by discipline across 3 sites — pin it here so a slice can't silently drop it.

describe("scheduler/lazy FPU+SIMD save/restore", () => {
    test("clean live owner reuses cached FP/SIMD state without snapshotting wasm", () => {
        const s = new Scheduler();
        const cpu = fakeCpuWithWasm();
        cpu.instruction_pointer[0] = 0x00401234;
        const wasm = new Uint8Array((cpu as any).wasm_memory.buffer);
        wasm[FPU_ST_WASM_OFFSET] = 0xaa;
        wasm[REG_XMM_WASM_OFFSET] = 0xbb;
        (cpu as any).fpu_simd_dirty[0] = 0;

        const t = inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        t.lastFpuState = new Uint8Array(134);
        t.lastFpuState[0] = 0x11;
        t.lastSimdState = new Uint8Array(132);
        t.lastSimdState[4] = 0x22;
        (s as any).fpuLiveOwnerThreadId = 1;

        const ctx = (s as any).saveCurrentThreadContext(cpu, "guest") as CpuContext;

        expect(ctx.fpu).toBe(t.lastFpuState);
        expect(ctx.simd).toBe(t.lastSimdState);
        expect(ctx.fpu?.[0]).toBe(0x11);
        expect(ctx.simd?.[4]).toBe(0x22);
        expect(s.fpuSwitchStats.savesSkippedClean).toBe(1);
        expect(s.fpuSwitchStats.saves).toBe(0);
    });

    test("dirty live owner snapshots FP/SIMD and clears the v86 dirty byte", () => {
        const s = new Scheduler();
        const cpu = fakeCpuWithWasm();
        cpu.instruction_pointer[0] = 0x00401234;
        const wasm = new Uint8Array((cpu as any).wasm_memory.buffer);
        wasm[FPU_ST_WASM_OFFSET] = 0xcc;
        wasm[REG_XMM_WASM_OFFSET] = 0xdd;
        (cpu as any).fpu_simd_dirty[0] = 1;

        const t = inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        t.lastFpuState = new Uint8Array(134);
        t.lastSimdState = new Uint8Array(132);
        (s as any).fpuLiveOwnerThreadId = 1;

        const ctx = (s as any).saveCurrentThreadContext(cpu, "guest") as CpuContext;

        expect(ctx.fpu?.[0]).toBe(0xcc);
        expect(ctx.simd?.[4]).toBe(0xdd);
        expect(t.lastFpuState).toBe(ctx.fpu);
        expect(t.lastSimdState).toBe(ctx.simd);
        expect((cpu as any).fpu_simd_dirty[0]).toBe(0);
        expect(s.fpuSwitchStats.savesDirty).toBe(1);
        expect(s.fpuSwitchStats.saves).toBe(1);
    });

    test("v86 view() Proxy export is detected and enables skip-save when clean", () => {
        const s = new Scheduler();
        const cpu = fakeCpuWithWasm({ v86ViewProxy: true });
        expect(hasFpuSimdDirtyFlag({ cpu })).toBe(true);
        expect((cpu as any).fpu_simd_dirty instanceof Uint8Array).toBe(false);

        cpu.instruction_pointer[0] = 0x00401234;
        (cpu as any).fpu_simd_dirty[0] = 0;

        const t = inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        t.lastFpuState = new Uint8Array(134);
        t.lastFpuState[0] = 0x11;
        t.lastSimdState = new Uint8Array(132);
        t.lastSimdState[4] = 0x22;
        (s as any).fpuLiveOwnerThreadId = 1;

        (s as any).saveCurrentThreadContext(cpu, "guest");

        expect(s.fpuSwitchStats.savesSkippedClean).toBe(1);
        expect(s.fpuSwitchStats.savesNoDirtyFlag).toBe(0);
        expect(s.fpuSwitchStats.saves).toBe(0);
    });

    test("pre-rebuild CPU (no fpu_simd_dirty export) always snapshots — never skip-save", () => {
        const s = new Scheduler();
        const cpu = fakeCpuWithWasm({ exportDirtyFlag: false });
        cpu.instruction_pointer[0] = 0x00401234;
        const wasm = new Uint8Array((cpu as any).wasm_memory.buffer);
        wasm[FPU_ST_WASM_OFFSET] = 0xcc;
        wasm[REG_XMM_WASM_OFFSET] = 0xdd;

        const t = inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        t.lastFpuState = new Uint8Array(134);
        t.lastFpuState[0] = 0x11;
        t.lastSimdState = new Uint8Array(132);
        t.lastSimdState[4] = 0x22;
        (s as any).fpuLiveOwnerThreadId = 1;

        const ctx = (s as any).saveCurrentThreadContext(cpu, "guest") as CpuContext;

        expect(ctx.fpu?.[0]).toBe(0xcc);
        expect(ctx.simd?.[4]).toBe(0xdd);
        expect(s.fpuSwitchStats.savesNoDirtyFlag).toBe(1);
        expect(s.fpuSwitchStats.savesSkippedClean).toBe(0);
        expect(s.fpuSwitchStats.saves).toBe(1);
    });

    test("restore skips matching live owner but restores when ownership changes", () => {
        const s = new Scheduler();
        const cpu = fakeCpuWithWasm();
        const wasm = new Uint8Array((cpu as any).wasm_memory.buffer);
        wasm[FPU_ST_WASM_OFFSET] = 0xaa;
        wasm[REG_XMM_WASM_OFFSET] = 0xbb;
        (cpu as any).fpu_simd_dirty[0] = 0;

        const sameOwnerCtx: CpuContext = {
            eax: 1, ecx: 2, edx: 3, ebx: 4,
            esp: 0x1000, ebp: 5, esi: 6, edi: 7,
            eip: 0x00401000, eflags: 0x202, domain: "guest",
            fpu: new Uint8Array(134),
            simd: new Uint8Array(132),
        };
        sameOwnerCtx.fpu![0] = 0x11;
        sameOwnerCtx.simd![4] = 0x22;
        (s as any).fpuLiveOwnerThreadId = 1;

        (s as any).applyContextState(cpu, sameOwnerCtx, sameOwnerCtx.esp, 1);
        expect(wasm[FPU_ST_WASM_OFFSET]).toBe(0xaa);
        expect(wasm[REG_XMM_WASM_OFFSET]).toBe(0xbb);
        expect(s.fpuSwitchStats.restoresSkippedOwner).toBe(1);

        const nextOwnerCtx: CpuContext = {
            ...sameOwnerCtx,
            fpu: new Uint8Array(134),
            simd: new Uint8Array(132),
        };
        nextOwnerCtx.fpu![0] = 0x33;
        nextOwnerCtx.simd![4] = 0x44;

        (s as any).applyContextState(cpu, nextOwnerCtx, nextOwnerCtx.esp, 2);
        expect(wasm[FPU_ST_WASM_OFFSET]).toBe(0x33);
        expect(wasm[REG_XMM_WASM_OFFSET]).toBe(0x44);
        expect((s as any).fpuLiveOwnerThreadId).toBe(2);
        expect((cpu as any).fpu_simd_dirty[0]).toBe(0);
        expect(s.fpuSwitchStats.restores).toBe(1);
    });

    test("eligible timer callback borrows previous FP/SIMD owner and saves cached timer state", () => {
        const s = new Scheduler();
        const cpu = fakeCpuWithWasm();
        const wasm = new Uint8Array((cpu as any).wasm_memory.buffer);
        wasm[FPU_ST_WASM_OFFSET] = 0xaa;
        wasm[REG_XMM_WASM_OFFSET] = 0xbb;
        (cpu as any).fpu_simd_dirty[0] = 0;

        const timer = mkThread(2, ThreadState.RUNNING);
        timer.lastFpuState = new Uint8Array(134);
        timer.lastFpuState[0] = 0x11;
        timer.lastSimdState = new Uint8Array(132);
        timer.lastSimdState[4] = 0x22;
        inject(s, timer, { current: true });

        (s as any).fpuLiveOwnerThreadId = 1;
        (s as any).timerNoFpuProfiles.set(0x63eaa0, {
            clean: 16,
            dirty: 0,
            eligible: true,
            disabled: false,
        });
        (s as any).timerFpuRestoreSkipPending = {
            threadId: 2,
            callbackAddr: 0x63eaa0,
            previousOwnerThreadId: 1,
        };

        const timerCtx: CpuContext = {
            eax: 0, ecx: 0, edx: 0, ebx: 0,
            esp: 0x2000, ebp: 0, esi: 0, edi: 0,
            eip: 0x00401000, eflags: 0x202, domain: "guest",
            fpu: new Uint8Array(134),
            simd: new Uint8Array(132),
        };
        timerCtx.fpu![0] = 0x77;
        timerCtx.simd![4] = 0x88;

        (s as any).applyContextState(cpu, timerCtx, timerCtx.esp, 2);

        expect(wasm[FPU_ST_WASM_OFFSET]).toBe(0xaa);
        expect(wasm[REG_XMM_WASM_OFFSET]).toBe(0xbb);
        expect((s as any).fpuLiveOwnerThreadId).toBe(1);
        expect(s.fpuSwitchStats.timerNoFpuRestoreSkipped).toBe(1);

        const savedCtx = saveCpuContext(cpu, "guest", 0, { snapshotFpuSimd: false });
        (s as any).fillContextFpuSimdState(cpu, timer, savedCtx);

        expect(savedCtx.fpu).toBe(timer.lastFpuState);
        expect(savedCtx.simd).toBe(timer.lastSimdState);
        expect(savedCtx.fpu?.[0]).toBe(0x11);
        expect(savedCtx.simd?.[4]).toBe(0x22);
        expect((s as any).fpuLiveOwnerThreadId).toBe(1);
        expect(s.fpuSwitchStats.timerNoFpuBorrowedSave).toBe(1);
        expect(s.fpuSwitchStats.saves).toBe(0);
    });

    test("borrowed timer callback dirty violation disables no-FPU profile", () => {
        const s = new Scheduler();
        const cpu = fakeCpuWithWasm();
        const wasm = new Uint8Array((cpu as any).wasm_memory.buffer);
        wasm[FPU_ST_WASM_OFFSET] = 0xaa;
        (cpu as any).fpu_simd_dirty[0] = 0;

        const timer = mkThread(2, ThreadState.RUNNING);
        timer.lastFpuState = new Uint8Array(134);
        timer.lastFpuState[0] = 0x11;
        timer.lastSimdState = new Uint8Array(132);
        timer.lastSimdState[4] = 0x22;
        inject(s, timer, { current: true });

        (s as any).fpuLiveOwnerThreadId = 1;
        (s as any).timerNoFpuProfiles.set(0x63eaa0, {
            clean: 16,
            dirty: 0,
            eligible: true,
            disabled: false,
        });
        (s as any).timerFpuRestoreSkipPending = {
            threadId: 2,
            callbackAddr: 0x63eaa0,
            previousOwnerThreadId: 1,
        };

        const timerCtx: CpuContext = {
            eax: 0, ecx: 0, edx: 0, ebx: 0,
            esp: 0x2000, ebp: 0, esi: 0, edi: 0,
            eip: 0x00401000, eflags: 0x202, domain: "guest",
            fpu: new Uint8Array(134),
            simd: new Uint8Array(132),
        };

        (s as any).applyContextState(cpu, timerCtx, timerCtx.esp, 2);
        wasm[FPU_ST_WASM_OFFSET] = 0xee;
        (cpu as any).fpu_simd_dirty[0] = 1;

        const savedCtx = saveCpuContext(cpu, "guest", 0, { snapshotFpuSimd: false });
        (s as any).fillContextFpuSimdState(cpu, timer, savedCtx);
        const profile = (s as any).timerNoFpuProfiles.get(0x63eaa0);

        expect(savedCtx.fpu).toBe(timer.lastFpuState);
        expect(savedCtx.fpu?.[0]).toBe(0x11);
        expect((s as any).fpuLiveOwnerThreadId).toBeNull();
        expect((cpu as any).fpu_simd_dirty[0]).toBe(0);
        expect(profile.disabled).toBe(true);
        expect(profile.eligible).toBe(false);
        expect(s.fpuSwitchStats.timerNoFpuDirty).toBe(1);
        expect(s.fpuSwitchStats.timerNoFpuDisabled).toBe(1);
    });
});

describe("scheduler/performSwitch (GUEST_CODE)", () => {
    test("saves the running thread, resumes the next, swaps FS base + fires onThreadSwitch", () => {
        const s = new Scheduler();
        const t1 = inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        const t2 = mkThread(2, ThreadState.READY);
        (t2 as any).tebAddress = 0x00050000;
        t2.context = createInitialContext(0x00402000, 0x00290000);
        inject(s, t2, { runnable: true });

        const switches: Array<[number, number]> = [];
        s.onThreadSwitchCallback = (oldId, newId) => switches.push([oldId, newId]);

        const cpu = fakeCpu({ eip: 0x00401000, esp: 0x0028ff00 });
        const switched = (s as any).performSwitch(cpu, ThunkBoundaryKind.GUEST_CODE, 0);

        expect(switched).toBe(true);
        // Outgoing thread parked READY with its CPU state captured.
        expect(t1.state).toBe(ThreadState.READY);
        expect(t1.context?.eip >>> 0).toBe(0x00401000);
        // Incoming thread is RUNNING with state now live in the CPU.
        expect(t2.state).toBe(ThreadState.RUNNING);
        expect(t2.context).toBeNull();
        expect((s as any).currentThreadId).toBe(2);
        // CPU resumed at T2's EIP, and — the invariant under test — FS base follows T2's TEB.
        expect(cpu.instruction_pointer[0] >>> 0).toBe(0x00402000);
        expect((cpu as any).segment_offsets[4] >>> 0).toBe(0x00050000);
        // Dispatcher notified with the correct (old, new) pair.
        expect(switches).toEqual([[1, 2]]);
    });

    test("self-restore: with no other runnable thread, marks current RUNNING and does not switch", () => {
        const s = new Scheduler();
        const t1 = inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        let notified = false;
        s.onThreadSwitchCallback = () => { notified = true; };

        const cpu = fakeCpu({ eip: 0x00401000 });
        const switched = (s as any).performSwitch(cpu, ThunkBoundaryKind.GUEST_CODE, 0);

        expect(switched).toBe(false);      // no real switch
        expect(t1.state).toBe(ThreadState.RUNNING);
        expect((s as any).currentThreadId).toBe(1);
        expect(notified).toBe(false);      // onThreadSwitch not fired for a self-restore
    });

    test("invalid worker EIP terminates that thread once and switches to a runnable peer", () => {
        const s = new Scheduler();
        const bad = inject(s, mkThread(2, ThreadState.RUNNING), { current: true });
        const next = mkThread(3, ThreadState.READY);
        next.context = createInitialContext(0x00402000, 0x00290000);
        inject(s, next, { runnable: true });

        const cpu = fakeCpu({ eip: 0x141, esp: 0x0028fec0 });
        const switched = (s as any).performSwitch(cpu, ThunkBoundaryKind.GUEST_CODE, 0);

        expect(switched).toBe(true);
        expect(bad.state).toBe(ThreadState.TERMINATED);
        expect(next.state).toBe(ThreadState.RUNNING);
        expect(cpu.instruction_pointer[0] >>> 0).toBe(0x00402000);
        expect((s as any).currentThreadId).toBe(3);
    });
});

// ─── 8b. thread-exit liveness — survivor must be switched in after a sibling exits ─
// Regression for the Re-Volt "random hang after a worker thread terminates": a sibling
// thread exits while the sole survivor is parked; currentThreadId is never reassigned,
// so once the dead thread is reaped getCurrentThread()→null and the old `if(current)`
// gate skipped the switch → survivor never scheduled → worker stranded with
// is_running()===true → 12s watchdog hang. These pin the three fixes.

describe("scheduler/thread-exit liveness — survivor switched in after a sibling exits", () => {
    function mkProcSched(): Scheduler {
        const s = new Scheduler();
        // Minimal process so preemptAtTickBoundary's timer-callback step no-ops.
        // getCurrentMemory: detectDeadlock() reads guest memory (bounds-guarded),
        // so the fake must provide it — a tiny buffer makes every read skip.
        (s as any).process = { id: 1, getModule: () => undefined, getCurrentMemory: () => new Uint8Array(0x100) };
        // Determinism: detectDeadlock() gates on `performance.now() - lastDeadlockCheckMs > 2000`
        // from a 0 start, so its body runs ONLY when the suite has been up >2s by the time this
        // test executes — i.e. only in slow/loaded runs. Pin it off entirely.
        (s as any).lastDeadlockCheckMs = Number.MAX_SAFE_INTEGER;
        return s;
    }

    test("Gap B: current thread reaped (getCurrentThread→null) + runnable survivor → switch to survivor", () => {
        const s = mkProcSched();
        // currentThreadId still points at the reaped (deleted) sibling.
        (s as any).currentThreadId = 3;
        const survivor = mkThread(1, ThreadState.READY);
        (survivor as any).tebAddress = 0x00050000;
        survivor.context = createInitialContext(0x00402000, 0x00290000);
        inject(s, survivor, { runnable: true });
        expect((s as any).getCurrentThread()).toBeNull(); // sibling is gone

        const cpu = fakeCpu({ eip: 0x00401000, esp: 0x0028ff00 });
        (s as any).preemptAtTickBoundary(cpu);

        // The survivor must be RUNNING — NOT stranded.
        expect(survivor.state).toBe(ThreadState.RUNNING);
        expect((s as any).currentThreadId).toBe(1);
        expect(cpu.instruction_pointer[0] >>> 0).toBe(0x00402000);
    });

    test("Gap A: current thread TERMINATED with nothing runnable → worker parks (yieldToHost), not busy-spin", () => {
        const s = mkProcSched();
        let yielded = false;
        (s as any).yieldToHost = () => { yielded = true; }; // spy (avoid touching v86)
        const dead = inject(s, mkThread(3, ThreadState.RUNNING), { current: true });
        dead.state = ThreadState.TERMINATED; // simulate post-exit, pre-reap

        (s as any).preemptAtTickBoundary(fakeCpu({ eip: 0x00401000 }));

        // Must park (re-arming the startScheduler restart backstop), not fall through
        // and busy-spin v86 with is_running()===true.
        expect(yielded).toBe(true);
    });

    test("F4: the reaper does not delete the thread still marked current (no +5s door-slam)", () => {
        const s = mkProcSched();
        inject(s, mkThread(3, ThreadState.TERMINATED), { current: true });
        (s as any).reapQueue.push({ threadId: 3, terminatedAt: 0 });
        (s as any).reapTerminatedThreads(1e9); // now ≫ REAP_GRACE_MS

        // Still present because it is currentThreadId — deleting it is what slammed the door.
        expect((s as any).threads.has(3)).toBe(true);
    });

    // HoMM3-demo Sleep boot freeze: the sole thread is woken WAITING→READY (wait-engine path, no
    // async restore) but stays currentThreadId; quantum never fires at the spin loop, so pre-fix
    // it was never promoted. Step 7 must switch a READY current, not only WAITING.
    test("woken sole READY current (quantum not expired) is switched in", () => {
        const s = mkProcSched();
        // Spin-loop region so performSwitch's self-restore takes the FULL-restore branch (live EIP
        // at the spin loop, saved context at the post-Sleep return).
        (s as any).spinLoopBase = 0x21040000;
        (s as any).spinLoopEnd = 0x21041000;

        const t = mkThread(1, ThreadState.READY);
        (t as any).tebAddress = 0x00050000;
        t.context = createInitialContext(0x00402000, 0x00290000);
        inject(s, t, { runnable: true, current: true });

        const cpu = fakeCpu({ eip: 0x21040000, esp: 0x0028ff00, insn: 0 });
        expect((s as any).quantumExpired(t, cpu)).toBe(false); // freeze precondition
        expect((s as any).switchRequested).toBeFalsy();

        (s as any).preemptAtTickBoundary(cpu);

        expect(t.state).toBe(ThreadState.RUNNING);
        expect((s as any).currentThreadId).toBe(1);
        expect(cpu.instruction_pointer[0] >>> 0).toBe(0x00402000);
    });
});

// ─── 9. stackBasedRestore — the RET-trick restore path also carries FPU + SSE ──
// stackBasedRestore writes the target EIP onto the stack (RET N pops it) instead
// of setting instruction_pointer. It shares applyContextState with restoreContext,
// so it now restores the FULL saved state incl. FPU/SSE — previously it dropped
// them, letting the x87 control word / MXCSR drift on the sync-return switch path.

describe("scheduler/stackBasedRestore", () => {
    test("writes EIP to the stack, sets GPRs/EFLAGS, and restores FPU + SSE", () => {
        const s = new Scheduler();
        const mem = new Uint8Array(0x2000);
        (s as any).process = { getCurrentMemory: () => mem };

        const cpu = fakeCpuWithWasm();
        const wasm = new Uint8Array((cpu as any).wasm_memory.buffer);

        // Saved FPU (134B) + SSE (260B) snapshots with recognizable markers.
        const fpu = new Uint8Array(134);
        fpu[0] = 0x11;   // ST(0) byte 0      -> wasm[1152]
        fpu[130] = 0x33; // control word low  -> wasm[1036]
        const simd = new Uint8Array(132); // mxcsr(4) + 8×XMM(128)
        simd[0] = 0x9f;        // MXCSR byte 0       -> wasm[824]
        simd[4] = 0xab;        // XMM0 byte 0        -> wasm[832]
        simd[131] = 0xcd;      // XMM7 last byte     -> wasm[959]

        const target: CpuContext = {
            eax: 0xa, ecx: 0xc, edx: 0xd, ebx: 0xb,
            esp: 0x1000, ebp: 0xbb, esi: 0x5, edi: 0x6,
            eip: 0x00401000, eflags: 0x246, domain: "thunk_stub", fpu, simd,
        };

        (s as any).stackBasedRestore(cpu, target, 0); // cleanup=0 -> adjustedEsp = 0x1000-4 = 0xFFC

        const dv = new DataView(mem.buffer);
        expect(dv.getUint32(0x0ffc, true)).toBe(0x00401000); // EIP pushed for RET N
        expect(cpu.reg32[4] >>> 0).toBe(0x0ffc);             // ESP = adjustedEsp
        expect(cpu.reg32[0] >>> 0).toBe(0xa);                // EAX
        expect(cpu.reg32[6] >>> 0).toBe(0x5);                // ESI
        expect(cpu.flags[0] >>> 0).toBe(0x246);              // EFLAGS
        // The fix: FPU + SSE travel on this path now.
        expect(wasm[1152]).toBe(0x11);
        expect(wasm[1036]).toBe(0x33); // FPU control word — NOT clobbered by the SSE copy
        expect(wasm[824]).toBe(0x9f);
        expect(wasm[832]).toBe(0xab);
        expect(wasm[959]).toBe(0xcd);  // XMM7 last byte (832+127)
    });
});

// ─── 10. non-preemptible inline-stub regions (heap/CRT slab atomicity fix) ─────
// The inline x86 HeapAlloc/HeapFree (and CRT malloc/free) stubs do a non-atomic
// free-list pop/push/bump on shared slab state. Under the 1ms preemptive quantum,
// a thread switch mid-sequence lets two guest threads pop the SAME block → "two
// owners, one block" (D2 Fog/Storm corruption). The fix: preemptAtTickBoundary
// defers the switch while EIP is inside a registered stub region. These tests pin
// that the defer fires (and ONLY inside the range), and that the range is bounded.

describe("scheduler/non-preemptible slab-stub region", () => {
    // Drive a real preemptAtTickBoundary with the quantum elapsed and a runnable peer.
    function setup(eip: number) {
        const s = new Scheduler();
        // Minimal process: getModule() lets dispatchTimerThreadCallbacks no-op (no winmm).
        // getCurrentMemory: required by detectDeadlock() on the tick path (bounds-guarded reads).
        (s as any).process = { id: 1, getModule: () => undefined, getCurrentMemory: () => new Uint8Array(0x100) };
        // Pin detectDeadlock off — its 2s wall-clock gate makes it run only in slow/loaded
        // suite runs, which is exactly the nondeterminism these tests must not have.
        (s as any).lastDeadlockCheckMs = Number.MAX_SAFE_INTEGER;
        const t1 = inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        const t2 = mkThread(2, ThreadState.READY);
        (t2 as any).tebAddress = 0x00050000;
        t2.context = createInitialContext(0x00402000, 0x00290000);
        inject(s, t2, { runnable: true });
        // lastSwitchTime=0 → elapsed ≫ minQuantumMs → quantum expired, switch is due.
        const cpu = fakeCpu({ eip, esp: 0x0028ff00 });
        return { s, t1, t2, cpu };
    }

    test("EIP outside any region → the due switch happens", () => {
        const { s, cpu } = setup(0x00401000); // ordinary guest code
        (s as any).registerNonPreemptibleRange(0x21000000, 0x21000200);
        (s as any).preemptAtTickBoundary(cpu);
        expect((s as any).currentThreadId).toBe(2); // switched
    });

    test("EIP inside a registered region → the switch is DEFERRED, not dropped", () => {
        const { s, cpu } = setup(0x21000100); // inside [0x21000000, 0x21000200)
        (s as any).registerNonPreemptibleRange(0x21000000, 0x21000200);
        const before = (s as any).currentThreadId;
        (s as any).preemptAtTickBoundary(cpu);
        expect((s as any).currentThreadId).toBe(before);     // did NOT switch
        expect((s as any).switchRequested).toBe(true);       // deferred, will retry
        expect((s as any).getNonPreemptibleDeferCount()).toBe(1);
    });

    test("range is [base, end): base inclusive, end exclusive", () => {
        const s = new Scheduler();
        (s as any).registerNonPreemptibleRange(0x21000000, 0x21000200);
        const inRange = (eip: number) => (s as any).isEipNonPreemptible(eip);
        expect(inRange(0x21000000)).toBe(true);   // base inclusive
        expect(inRange(0x210001ff)).toBe(true);   // last byte
        expect(inRange(0x21000200)).toBe(false);  // end exclusive
        expect(inRange(0x20ffffff)).toBe(false);  // below
    });

    test("registration is idempotent and ignores empty/inverted ranges", () => {
        const s = new Scheduler();
        (s as any).registerNonPreemptibleRange(0x21000000, 0x21000200);
        (s as any).registerNonPreemptibleRange(0x21000000, 0x21000200); // dup
        (s as any).registerNonPreemptibleRange(0x22000000, 0x22000000); // empty
        (s as any).registerNonPreemptibleRange(0x23000200, 0x23000000); // inverted
        expect((s as any).nonPreemptibleRanges.length).toBe(1);
    });

    test("reset() drops registered regions (re-registered after stub regen)", () => {
        const s = new Scheduler();
        (s as any).registerNonPreemptibleRange(0x21000000, 0x21000200);
        s.reset();
        expect((s as any).nonPreemptibleRanges.length).toBe(0);
        expect((s as any).isEipNonPreemptible(0x21000100)).toBe(false);
    });
});

// The callback pin (WndProc / Enum* chains) may delay a preemptive switch, but it may not
// starve queued peers forever: guest code inside such a callback can wait on a peer thread
// (UE1 runs its whole engine tick inside DispatchMessage and Core.dll spins `while(lock)
// Sleep(0)`), and an unbounded defer makes that wait unsatisfiable — a hard freeze with a
// non-empty run queue and zero context switches.
describe("scheduler/callback pin cannot starve queued peers forever", () => {
    function setup() {
        const s = new Scheduler();
        (s as any).process = { id: 1, getModule: () => undefined, getCurrentMemory: () => new Uint8Array(0x100) };
        (s as any).lastDeadlockCheckMs = Number.MAX_SAFE_INTEGER;
        const t1 = inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        const t2 = mkThread(2, ThreadState.READY);
        (t2 as any).tebAddress = 0x00050000;
        t2.context = createInitialContext(0x00402000, 0x00290000);
        inject(s, t2, { runnable: true });
        t1.kernelPinCount = 1;                                  // inside a callback chain
        return { s, t1, t2, cpu: fakeCpu({ eip: 0x00401000, esp: 0x0028ff00 }) };
    }

    test("a short pinned callback is NOT split", () => {
        const { s, cpu } = setup();
        (s as any).preemptAtTickBoundary(cpu);
        expect((s as any).currentThreadId).toBe(1);             // pin honored
        expect((s as any).pinStarvationForced).toBe(0);
    });

    test("past the starvation bound the switch is forced", () => {
        const { s, cpu } = setup();
        (s as any).preemptAtTickBoundary(cpu);                  // starts the defer window
        expect((s as any).currentThreadId).toBe(1);
        // Backdate the window past the bound — the guest has held the pin too long.
        (s as any).pinDeferSinceMs -= (Scheduler as any).PIN_STARVATION_MAX_MS + 1;
        (s as any).preemptAtTickBoundary(cpu);
        expect((s as any).currentThreadId).toBe(2);             // peer finally runs
        expect((s as any).pinStarvationForced).toBe(1);
    });

    test("releasing the pin ends the defer window", () => {
        const { s, t1, cpu } = setup();
        (s as any).preemptAtTickBoundary(cpu);
        expect((s as any).pinDeferSinceMs).toBeGreaterThan(0);
        t1.kernelPinCount = 0;
        (s as any).preemptAtTickBoundary(cpu);
        expect((s as any).currentThreadId).toBe(2);
        expect((s as any).pinDeferSinceMs).toBe(0);
        expect((s as any).pinStarvationForced).toBe(0);         // not a starvation escape
    });

    test("unpinThread releases the OWNER's pin, not the current thread's", () => {
        const { s, t1, t2 } = setup();
        t2.kernelPinCount = 0;
        (s as any).currentThreadId = 2;                         // owner is no longer current
        s.unpinThread(1);
        expect(t1.kernelPinCount).toBe(0);                      // owner released
        expect(t2.kernelPinCount).toBe(0);                      // and nobody else charged
    });
});

// The preemption quantum is measured in RETIRED GUEST INSTRUCTIONS (cpu.instruction_counter),
// not performance.now(). This makes the switch point a deterministic function of guest state —
// identical on Mac and PC — which removes the platform-dependent interleaving that shifted the
// async/JIT OUT+RET-N window into the Re-Volt mac wild-ESP/EBP corruption. The budget is
// minQuantumMs * TARGET_INSN_PER_MS — derived here, not restated, so retuning the quantum for
// fidelity cannot silently invalidate these assertions.
describe("scheduler/preemption quantum is instruction-based (deterministic)", () => {
    const QUANTUM = DEFAULT_SCHEDULER_CONFIG.minQuantumMs * TARGET_INSN_PER_MS;

    test("not expired below the instruction budget; expired at/above it", () => {
        const s = new Scheduler();
        const t = mkThread(1, ThreadState.RUNNING);
        t.lastSwitchInsn = 1000;
        expect((s as any).quantumExpired(t, fakeCpu({ insn: 1000 + QUANTUM - 1 }))).toBe(false);
        expect((s as any).quantumExpired(t, fakeCpu({ insn: 1000 + QUANTUM }))).toBe(true);
        expect((s as any).quantumExpired(t, fakeCpu({ insn: 1000 + QUANTUM * 5 }))).toBe(true);
    });

    test("decision is a pure function of instruction state (no wall-clock dependence)", () => {
        const s = new Scheduler();
        const t = mkThread(1, ThreadState.RUNNING);
        t.lastSwitchInsn = 50_000;
        const cpu = fakeCpu({ insn: 50_000 + QUANTUM });
        // Same instruction state → same decision, every time, regardless of real elapsed time.
        expect((s as any).quantumExpired(t, cpu)).toBe(true);
        expect((s as any).quantumExpired(t, cpu)).toBe(true);
    });

    test("a thread that has retired no instructions is never preempted by the quantum", () => {
        const s = new Scheduler();
        const t = mkThread(1, ThreadState.RUNNING);
        t.lastSwitchInsn = 777;
        expect((s as any).quantumExpired(t, fakeCpu({ insn: 777 }))).toBe(false);
    });

    test("handles the 32-bit instruction_counter wrap via an unsigned delta", () => {
        const s = new Scheduler();
        const t = mkThread(1, ThreadState.RUNNING);
        t.lastSwitchInsn = (0xffffffff - 10) >>> 0; // near the 32-bit ceiling
        const wrapped = (t.lastSwitchInsn + QUANTUM) >>> 0;        // wraps below lastSwitchInsn
        expect((s as any).quantumExpired(t, fakeCpu({ insn: wrapped }))).toBe(true);
        const wrappedShort = (t.lastSwitchInsn + QUANTUM - 100) >>> 0;
        expect((s as any).quantumExpired(t, fakeCpu({ insn: wrappedShort }))).toBe(false);
    });
});

// ─── Lost-wakeup guard — auto-reset event SetEvent/Wait race ──────────────────
//
// Regression cover for the HP Galaxy-audio freeze root cause. blockThread() runs
// AFTER the caller's
// checkWait pre-check found the wait not-ready. In the window between that
// pre-check and registerWait, EVT_HAS_WAITERS is not yet set, so a SetEvent
// arriving there is handled entirely inside WASM (hypercall.rs handle_set_event
// latches EVT_SIGNALED into the mirror and returns true — no JS fall-through, no
// wake). Once registerWait sets EVT_HAS_WAITERS, every FUTURE SetEvent falls
// through to JS — but THIS one already happened. The invariant: blockThread must
// re-evaluate the wait once after registerWait (checkWait reads the live WASM
// mirror) and, if already satisfied, consume + wake instead of parking forever.
//
// These tests model the WASM latch by writing the event mirror signaled WITHOUT
// touching the JS event.signaled field — exactly the stale-JS / fresh-mirror
// split the real fast-path produces. In unit tests no WASM view is wired, so the
// mirror lives in hypercallDataManager's shadow (liveEventFlags fallback), which
// createEvent/writeEventMirrorSignaled maintain identically.

/** A current, RUNNING thread ready to be parked by blockThread. */
describe("scheduler/timer wheel kinds", () => {
    test("DSound notification timers are scheduler-wheel timers with their own tally", () => {
        const wheel = new TimerWheel();
        let fired = 0;
        wheel.add(10, true, TimerKind.DSOUND_NOTIFY, () => { fired++; }, 100);

        expect(wheel.poll(109)).toBe(0);
        expect(fired).toBe(0);
        expect(wheel.poll(110)).toBe(1);
        expect(fired).toBe(1);
        expect(wheel.firedByKind[TimerKind.DSOUND_NOTIFY]).toBe(1);

        expect(wheel.poll(120)).toBe(1);
        expect(fired).toBe(2);
        expect(wheel.firedByKind[TimerKind.DSOUND_NOTIFY]).toBe(2);
    });

    test("a throwing callback is isolated — remaining due timers still fire this tick", () => {
        const wheel = new TimerWheel();
        let bFired = 0;
        // A (due at 10) throws; B (due at 10) must still run in the same poll, and
        // the throw must not propagate out of poll() into the scheduler tick.
        wheel.add(5, false, TimerKind.USER32_TIMER, () => { throw new Error("boom"); }, 5);
        wheel.add(5, false, TimerKind.DSOUND_NOTIFY, () => { bFired++; }, 5);

        expect(() => wheel.poll(10)).not.toThrow();
        expect(bFired).toBe(1);
    });

    test("a periodic timer can cancel itself from its callback before re-arm", () => {
        const wheel = new TimerWheel();
        let fired = 0;
        let id = 0;
        id = wheel.add(5, true, TimerKind.USER32_TIMER, () => {
            fired++;
            expect(wheel.cancel(id)).toBe(true);
        }, 10);

        expect(wheel.poll(15)).toBe(1);
        expect(fired).toBe(1);
        expect(wheel.poll(20)).toBe(0);
        expect(fired).toBe(1);
    });

    test("equal-fireAt timers fire in deterministic add order (id FIFO tie-break)", () => {
        // Several pumps coming due in the same poll (an idle virtual-time jump) must fire
        // in a reproducible order — ascending id, i.e. the order they were added — not in
        // a layout-dependent heap order. Add out of insertion-vs-priority symmetry so a
        // naive heap would scramble them.
        const wheel = new TimerWheel();
        const order: number[] = [];
        // USER32_TIMER floor is 1ms → all due at the same fireAt (base 0 + 1 = 1).
        for (let n = 0; n < 6; n++) {
            wheel.add(1, false, TimerKind.USER32_TIMER, () => { order.push(n); }, 0);
        }
        expect(wheel.poll(1)).toBe(6);
        expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    });

    test("periodic pumps re-armed in the same tick keep deterministic relative order", () => {
        const wheel = new TimerWheel();
        const order: string[] = [];
        // Two periodic pumps with the same period added in a known order. After both fire
        // and re-arm at the same fireAt, the next poll must replay the same A-before-B order.
        wheel.add(5, true, TimerKind.DSOUND_NOTIFY, () => { order.push("A"); }, 0);
        wheel.add(5, true, TimerKind.WINMM_TIMER, () => { order.push("B"); }, 0);
        wheel.poll(5);
        wheel.poll(10);
        expect(order).toEqual(["A", "B", "A", "B"]);
    });

    test("reschedule moves an existing timer without changing its periodic cadence", () => {
        const wheel = new TimerWheel();
        let fired = 0;
        const id = wheel.add(5, true, TimerKind.WINMM_TIMER, () => { fired++; }, 0);

        expect(wheel.reschedule(id, 20, true, TimerKind.WINMM_TIMER, 1)).toBe(true);
        expect(wheel.poll(20)).toBe(0);
        expect(fired).toBe(0);
        expect(wheel.poll(21)).toBe(1);
        expect(fired).toBe(1);

        expect(wheel.poll(40)).toBe(0);
        expect(wheel.poll(41)).toBe(1);
        expect(fired).toBe(2);
    });

    test("reschedule preserves heap order when moving timers earlier and later", () => {
        const wheel = new TimerWheel();
        const order: string[] = [];
        const a = wheel.add(30, false, TimerKind.USER32_TIMER, () => { order.push("A"); }, 0);
        const b = wheel.add(10, false, TimerKind.USER32_TIMER, () => { order.push("B"); }, 0);
        const c = wheel.add(20, false, TimerKind.USER32_TIMER, () => { order.push("C"); }, 0);

        expect(wheel.reschedule(a, 5, false, TimerKind.USER32_TIMER, 0)).toBe(true);
        expect(wheel.reschedule(b, 40, false, TimerKind.USER32_TIMER, 0)).toBe(true);

        expect(wheel.poll(5)).toBe(1);
        expect(wheel.poll(20)).toBe(1);
        expect(wheel.poll(40)).toBe(1);
        expect(order).toEqual(["A", "C", "B"]);
    });
});

function mkBlockableCurrent(s: Scheduler, id: number): Thread {
    const t = inject(s, mkThread(id, ThreadState.RUNNING), { current: true });
    return t;
}

describe("scheduler/blockThread — lost-wakeup guard (WASM SetEvent/Wait race)", () => {
    test("auto-reset event latched in the mirror during the window wakes the thread (not stuck WAITING)", () => {
        const s = new Scheduler();
        const t = mkBlockableCurrent(s, 1);
        const h = s.createEvent(false, false); // auto-reset, initially unsignaled

        // Simulate the WASM SetEvent fast-path latching a signal with NO JS fall-through:
        // mirror byte goes signaled, JS event.signaled stays stale-false.
        hypercallDataManager.writeEventMirrorSignaled(h, true, false);
        expect((s as any).syncObjects._getEvent(h).signaled).toBe(false);       // JS state stale
        expect(hypercallDataManager.readEventMirrorState(h)!.signaled).toBe(true); // mirror fresh

        const ctx = { eip: 0x402000, esp: 0x290000 } as CpuContext;
        (s as any).blockThread(t, WaitReason.SINGLE_OBJECT, [h], false, null, false, 0, ctx);

        // The post-register re-check must have caught the latched signal: woken, not parked.
        expect(t.state).toBe(ThreadState.READY);
        expect(t.context!.eax >>> 0).toBe(WAIT_OBJECT_0);
        // Auto-reset must have been CONSUMED exactly once (mirror cleared).
        expect(hypercallDataManager.readEventMirrorState(h)!.signaled).toBe(false);
        // And the thread is no longer registered as a waiter on the handle.
        expect((s as any).waitEngine.getHandleWaiters(h)).not.toContain(1);
    });

    test("control: a genuinely unsignaled auto-reset event leaves the thread WAITING", () => {
        const s = new Scheduler();
        const t = mkBlockableCurrent(s, 1);
        const h = s.createEvent(false, false); // auto-reset, unsignaled, no latch

        const ctx = { eip: 0x402000, esp: 0x290000 } as CpuContext;
        (s as any).blockThread(t, WaitReason.SINGLE_OBJECT, [h], false, null, false, 0, ctx);

        // No signal present → the guard's re-check finds not-ready → stays parked.
        expect(t.state).toBe(ThreadState.WAITING);
        expect((s as any).waitEngine.getHandleWaiters(h)).toContain(1);
    });

    test("wait-any: a latched signal on the second handle still wakes the thread", () => {
        const s = new Scheduler();
        const t = mkBlockableCurrent(s, 1);
        const h0 = s.createEvent(false, false); // auto-reset, stays unsignaled
        const h1 = s.createEvent(false, false); // auto-reset, latched below

        hypercallDataManager.writeEventMirrorSignaled(h1, true, false);

        const ctx = { eip: 0x402000, esp: 0x290000 } as CpuContext;
        (s as any).blockThread(t, WaitReason.MULTIPLE_OBJECTS, [h0, h1], false, null, false, 0, ctx);

        expect(t.state).toBe(ThreadState.READY);
        // Only the satisfied handle (h1) is consumed; the other stays untouched.
        expect(hypercallDataManager.readEventMirrorState(h1)!.signaled).toBe(false);
        expect(hypercallDataManager.readEventMirrorState(h0)!.signaled).toBe(false); // was never set
    });

    test("manual-reset event latched in the window also wakes (pendingWake honored)", () => {
        const s = new Scheduler();
        const t = mkBlockableCurrent(s, 1);
        const h = s.createEvent(true, false); // manual-reset, initially unsignaled

        hypercallDataManager.writeEventMirrorSignaled(h, true, true); // sets SIGNALED + PENDING_WAKE

        const ctx = { eip: 0x402000, esp: 0x290000 } as CpuContext;
        (s as any).blockThread(t, WaitReason.SINGLE_OBJECT, [h], false, null, false, 0, ctx);

        expect(t.state).toBe(ThreadState.READY);
        expect(t.context!.eax >>> 0).toBe(WAIT_OBJECT_0);
        // Manual-reset stays signaled after the wait (only pendingWake is consumed).
        expect(hypercallDataManager.readEventMirrorState(h)!.signaled).toBe(true);
    });
});

describe("scheduler/shouldPumpIdleVirtualTime — wheel-driven wakeups (audio-pump regression)", () => {
    // An event-only waiter (WaitForSingleObject INFINITE, no timeoutTimerId, reason
    // SINGLE_OBJECT) is woken solely by a virtual-time wheel pump (winmm WHDR_DONE /
    // dsound notify / MSS mixer SetEvent). If the idle pump doesn't advance virtual time
    // for it, the wheel freezes and the wakeup never fires → silent deadlock. The pump
    // must engage whenever every thread is blocked and the wheel holds active timers.
    function blockOnEvent(s: Scheduler, id: number): Thread {
        const t = inject(s, mkThread(id, ThreadState.WAITING), {});
        t.waitInfo = {
            reason: WaitReason.SINGLE_OBJECT,
            handles: [0x1234],
            waitAll: false,
            timeoutTimerId: undefined,
        } as any;
        return t;
    }

    test("all threads blocked on an event + active wheel timer → pump engages", () => {
        const s = new Scheduler();
        blockOnEvent(s, 1);
        s.timerWheel.add(5, true, TimerKind.WINMM_TIMER, () => {}, 0);
        expect((s as any).shouldPumpIdleVirtualTime()).toBe(true);
    });

    test("control: all threads blocked on an event but EMPTY wheel → no pump (nothing to fire)", () => {
        const s = new Scheduler();
        blockOnEvent(s, 1);
        expect((s as any).shouldPumpIdleVirtualTime()).toBe(false);
    });

    test("control: a RUNNING thread → never pump (guest owns the clock)", () => {
        const s = new Scheduler();
        inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        s.timerWheel.add(5, true, TimerKind.WINMM_TIMER, () => {}, 0);
        expect((s as any).shouldPumpIdleVirtualTime()).toBe(false);
    });

    test("an async-thunk waiter is not counted; an active wheel alone doesn't force a pump", () => {
        const s = new Scheduler();
        const t = inject(s, mkThread(1, ThreadState.WAITING), {});
        t.waitInfo = { reason: WaitReason.ASYNC_THUNK, handles: [], waitAll: false } as any;
        s.timerWheel.add(5, true, TimerKind.WINMM_TIMER, () => {}, 0);
        // Only an ASYNC_THUNK waiter exists (woken by its JS promise) → no non-async waiter
        // for the wheel to wake → don't pump.
        expect((s as any).shouldPumpIdleVirtualTime()).toBe(false);
    });
});

describe("scheduler/waitForSingleObjectWithContext — blocked with runnable peer", () => {
    test("zero-timeout probe stays non-blocking but yields fairly to a READY peer", () => {
        const s = new Scheduler();
        const t1 = mkBlockableCurrent(s, 1);
        inject(s, mkThread(2, ThreadState.READY), { runnable: true });
        const h = s.createEvent(true, false);

        const ret = s.waitForSingleObjectWithContext(
            h,
            0,
            0x401000,
            0x10ffa00,
            { ecx: 0, edx: 0, ebx: 0, ebp: 0, esi: 0, edi: 0, eflags: 0x202 },
        );

        expect(ret).toBe(WAIT_TIMEOUT);
        expect(t1.state).toBe(ThreadState.RUNNING);
        expect(t1.waitInfo).toBeNull();
        expect((s as any).switchRequested).toBe(true);
    });

    test("returns WAIT_BLOCKED_NO_SWITCH when blocking with requestSwitch (not WAIT_OBJECT_0 to sync thunk)", () => {
        const s = new Scheduler();
        const t1 = mkBlockableCurrent(s, 1);
        inject(s, mkThread(2, ThreadState.READY), { runnable: true });
        const h = s.createEvent(false, false);

        const ret = s.waitForSingleObjectWithContext(
            h,
            INFINITE,
            0x401000,
            0x10ffa00,
            { ecx: 0, edx: 0, ebx: 0, ebp: 0, esi: 0, edi: 0, eflags: 0x202 },
        );

        expect(ret).toBe(WAIT_BLOCKED_NO_SWITCH);
        expect(t1.state).toBe(ThreadState.WAITING);
        expect(t1.context!.eip >>> 0).toBe(0x401000);
        expect(t1.context!.esp >>> 0).toBe(0x10ffa00);
    });

    // A finite timeout is CONSUMED, never answered early — even with nothing else to run.
    // Guests measure it: Blade of Darkness calibrates its RDTSC game clock from the TSC
    // delta across WaitForSingleObject(sem, 100), so an early WAIT_TIMEOUT scales every
    // frame it will ever render.
    test("sole runnable thread parks for the full timeout instead of returning WAIT_TIMEOUT", () => {
        const s = new Scheduler();
        const t1 = mkBlockableCurrent(s, 1);
        const sem = s.createSemaphore(0, 1);   // count 0 → the wait cannot be satisfied

        const ret = s.waitForSingleObjectWithContext(
            sem,
            100,
            0x401000,
            0x10ffa00,
            { ecx: 0, edx: 0, ebx: 0, ebp: 0, esi: 0, edi: 0, eflags: 0x202 },
        );

        expect(ret).not.toBe(WAIT_TIMEOUT);
        expect(ret).toBe(WAIT_BLOCKED_NO_SWITCH);
        expect(t1.state).toBe(ThreadState.WAITING);
        expect(t1.waitInfo!.timeoutTimerId).toBeGreaterThan(0);

        // The wheel entry carries the WHOLE timeout — that deadline is what the guest measures.
        const wheel = (s as any).timerWheel as TimerWheel;
        const now = (s as any).timeService.nowMs();
        expect(wheel.nextFireIn(now)).toBeGreaterThan(95);
        expect(wheel.nextFireIn(now)).toBeLessThanOrEqual(100);

        // Parked with nobody READY/RUNNING ⇒ pollTimeouts' idle pump owns the clock and
        // paces the wait in wall time. Without this the park would freeze virtual time
        // and the deadline could never come due.
        expect((s as any).shouldPumpIdleVirtualTime()).toBe(true);
    });
});

describe("scheduler/parkCurrentThreadUntil — synchronous HLE deadline", () => {
    test("always parks a sole runnable thread and prebuilds a zero return context", () => {
        const s = new Scheduler();
        const t1 = mkBlockableCurrent(s, 1);

        const ret = s.parkCurrentThreadUntil(
            25,
            0x401000,
            0x10ffa00,
            { ecx: 1, edx: 2, ebx: 3, ebp: 4, esi: 5, edi: 6, eflags: 0x202 },
        );

        expect(ret).toBe(WAIT_BLOCKED_NO_SWITCH);
        expect(t1.state).toBe(ThreadState.WAITING);
        expect(t1.waitInfo?.reason).toBe(WaitReason.SLEEP);
        expect(t1.waitInfo?.timeoutTimerId).toBeGreaterThan(0);
        expect(t1.context?.eip >>> 0).toBe(0x401000);
        expect(t1.context?.esp >>> 0).toBe(0x10ffa00);
        expect(t1.context?.eax >>> 0).toBe(0);

        const wheel = (s as any).timerWheel as TimerWheel;
        const now = (s as any).timeService.nowMs();
        expect(wheel.nextFireIn(now)).toBeGreaterThan(20);
        expect(wheel.nextFireIn(now)).toBeLessThanOrEqual(25);
        expect((s as any).shouldPumpIdleVirtualTime()).toBe(true);
    });
});

// ─── 11. timer dispatch pre-guard (Task B — cheap boundary reject) ─────────────

describe("scheduler/timer dispatch pre-guard", () => {
    test("non-timer current thread rejects at gate without inner calls counter", () => {
        const s = new Scheduler();
        (s as any).process = { id: 1, getModule: () => ({ timerThreadId: 3, timerWakeEvent: 0x30014 }), getCurrentMemory: () => new Uint8Array(0x100) };
        s.notifyWinmmTimerThread(3, 0x30014);
        inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        const cpu = fakeCpu({ eip: 0x21047000, esp: 0x0028ff00 });
        (s as any).spinLoopBase = 0x21047000;
        (s as any).spinLoopEnd = 0x21048000;

        expect((s as any).tryDispatchTimerThreadCallbacks(cpu)).toBe(false);
        expect(s.timerDispatchStats.gateNotTimerThread).toBe(1);
        expect(s.timerDispatchStats.calls).toBe(0);
        expect(s.timerDispatchStats.gateCacheMismatch).toBe(0);
    });

    test("gateNoTimerThread when cache is empty", () => {
        const s = new Scheduler();
        (s as any).process = { id: 1, getModule: () => undefined, getCurrentMemory: () => new Uint8Array(0x100) };
        inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        const cpu = fakeCpu({ eip: 0x00401000, esp: 0x0028ff00 });

        expect((s as any).tryDispatchTimerThreadCallbacks(cpu)).toBe(false);
        expect(s.timerDispatchStats.gateNoTimerThread).toBe(1);
        expect(s.timerDispatchStats.calls).toBe(0);
    });

    test("reset clears cached timer thread metadata", () => {
        const s = new Scheduler();
        s.notifyWinmmTimerThread(7, 0x30020);
        s.reset();
        expect((s as any).cachedWinmmTimerThreadId).toBe(0);
        expect((s as any).cachedWinmmTimerWakeEvent).toBe(0);
    });
});
