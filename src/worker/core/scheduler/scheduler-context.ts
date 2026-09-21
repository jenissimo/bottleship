/**
 * CPU ↔ CpuContext marshaling primitives (scheduler responsibility #2, the pure
 * half).
 *
 * Side-effect-free pieces of context save/restore: snapshot live v86 registers
 * into a CpuContext, build the well-known initial / post-RET contexts, and
 * classify a guest EIP. They touch only the passed-in CPU (+ the FPU snapshot
 * helper) — no scheduler state — so they are independently unit-testable
 * (tools/tests/scheduler-state-machine.test.ts).
 *
 * The stateful half (restoreContext's domain/EIP-validation, which reads the
 * active SEH runtime, spin-loop bounds and the current thread's stack) stays in
 * scheduler.ts and calls isValidGuestEip() from here.
 */

import type { CpuContext, V86Cpu } from "./types";
import { cpuViews } from "../cpu/cpu-views";
import { createDefaultFpuSnapshot, createDefaultSimdSnapshot, fpuSnapshot, simdSnapshot } from "../fpu-helper";

/** Guest code address window — an EIP outside this is not a plain guest resume point. */
export const GUEST_CODE_MIN = 0x100000;
export const GUEST_CODE_MAX = 0x80000000;

export function isValidGuestEip(eip: number): boolean {
    return eip >= GUEST_CODE_MIN && eip < GUEST_CODE_MAX;
}

/**
 * Snapshot the live CPU (all 8 GPRs + EIP + EFLAGS + x87 FPU) into a CpuContext.
 * `domain`/`domainGen` tag the snapshot for the strict restore-policy checks.
 * On a CPU without FPU accessors, fpuSnapshot returns null → fpu is undefined.
 */
export function saveCpuContext(
    cpu: V86Cpu,
    domain: CpuContext["domain"] = "guest",
    domainGen: number = 0,
    options?: { snapshotFpuSimd?: boolean; fpu?: Uint8Array; simd?: Uint8Array },
): CpuContext {
    const v = cpuViews(cpu);
    const reg = v.reg32;
    const snapshotFpuSimd = options?.snapshotFpuSimd !== false;
    return {
        eax: reg[0] >>> 0, ecx: reg[1] >>> 0, edx: reg[2] >>> 0, ebx: reg[3] >>> 0,
        esp: reg[4] >>> 0, ebp: reg[5] >>> 0, esi: reg[6] >>> 0, edi: reg[7] >>> 0,
        eip: v.instructionPointer[0] >>> 0,
        // MATERIALIZE lazy flags (get_eflags folds last_op1/last_result into the
        // arithmetic bits). Raw flags[0] is stale whenever flags_changed != 0 —
        // saving it loses the preempted thread's live ZF/CF/SF/OF across the
        // switch (wrong branch on resume → random corruption; NFSU crash-class).
        eflags: (cpu.get_eflags ? cpu.get_eflags() : v.flags[0]) >>> 0,
        domain,
        domainGen: domainGen >>> 0,
        fpu: snapshotFpuSimd ? (fpuSnapshot({ cpu }) ?? undefined) : options?.fpu,
        simd: snapshotFpuSimd ? (simdSnapshot({ cpu }) ?? undefined) : options?.simd,
    };
}

/** Fresh thread entry context: EIP = entry point, ESP = stack top, IF set. */
export function createInitialContext(startAddress: number, esp: number): CpuContext {
    return {
        eax: 0, ecx: 0, edx: 0, ebx: 0,
        esp: esp >>> 0, ebp: 0, esi: 0, edi: 0,
        eip: startAddress >>> 0,
        eflags: 0x202,
        domain: "guest",
        fpu: createDefaultFpuSnapshot(),
        simd: createDefaultSimdSnapshot(),
    };
}

/**
 * Context as it would be immediately after a thunk's RET: EAX = return value,
 * EIP = return address, ESP already past the popped args, callee-saved + caller
 * registers carried through.
 */
export function createPostReturnContext(
    returnAddr: number,
    postReturnEsp: number,
    callerCtx: { ecx: number; edx: number; ebx: number; ebp: number; esi: number; edi: number; eflags: number },
    returnValue: number = 0,
): CpuContext {
    return {
        eax: returnValue,
        ecx: callerCtx.ecx, edx: callerCtx.edx, ebx: callerCtx.ebx,
        esp: postReturnEsp >>> 0, ebp: callerCtx.ebp,
        esi: callerCtx.esi, edi: callerCtx.edi,
        eip: returnAddr >>> 0,
        eflags: callerCtx.eflags,
        domain: "guest",
    };
}
