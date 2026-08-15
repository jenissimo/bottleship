// Native x86 micro-thunks for the pure-compute CRT math imports (floor/ceil/fabs/
// sqrt/_ftol). Codegen pinned by tools/tests/crt-math-stubs.test.ts.
// Caller: pe-loader (CRT-module import), via ThunkMemoryManager.stubAllocator.

import { Logger, LogCategory } from '../core/logger';
import type { StubAllocator } from '../core/thunking/thunk-memory-manager';

/** Micro-thunk entry points, as named on {@link CrtMathStubs}. */
export type CrtMathStubName = 'floorStub' | 'ceilStub' | 'fabsStub' | 'sqrtStub' | 'ftolStub';

export interface CrtMathStubs {
    floorStub: number;
    ceilStub: number;
    fabsStub: number;
    sqrtStub: number;
    ftolStub: number;
    regionBase: number;
    regionEnd: number;
}

/** x87 control-word rounding-control field (bits 11:10). */
const RC_MASK = 0x0C00;
const RC_DOWN = 0x0400;   // toward -inf  (floor)
const RC_UP = 0x0800;     // toward +inf  (ceil)
const RC_TRUNC = 0x0C00;  // toward zero  (_ftol)

/** 5 stubs, largest 42 bytes; one 256-byte block keeps them on one page. */
const REGION_SIZE = 256;

/**
 * Emit the pure-compute CRT math imports as REAL x86 in guest code memory.
 *
 * These already bypass JS dispatch via the WASM hypercall tier, but a hypercall
 * still costs the OUT trap out of the JIT block — a boundary no tier can remove,
 * and floor alone is tens of thousands of calls per second. Emitted as guest x86
 * the JIT compiles them like any other block and the boundary disappears.
 *
 * All five are __cdecl (see msvcrt.api.ts): the CALLER cleans the stack, so every
 * stub ends in RET (0xC3), never RET N. floor/ceil/fabs/sqrt take the double at
 * [ESP+4]; _ftol takes its operand in ST(0) and returns the full __int64 in EDX:EAX.
 * The double-returning ones leave the result in ST(0) — the x87 return register —
 * exactly like the hypercall's fpu_push.
 *
 * floor/ceil set the x87 rounding control around FRNDINT and restore the caller's
 * control word, which is what the real CRT does; _ftol sets RC=truncate around
 * FISTP, which is literally the shipped MSVC _ftol body. Scratch space is the
 * argument area ([ESP+4..+11], dead once loaded — in 32-bit cdecl the parameter
 * slots are the callee's to modify) for the double-arg stubs, and 16 bytes of
 * fresh stack for _ftol, which has no argument area.
 *
 * The caller MUST register [regionBase, regionEnd) as a scheduler non-preemptible
 * range: a preempt between the two FLDCWs would leave the softfloat rounding mode
 * set for another thread (fpuRestore writes fpu_control_word straight into WASM
 * memory and never calls set_control_word, so a context switch does not re-derive
 * it).
 */
export function writeCrtMathStubs(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
): CrtMathStubs {
    const base = allocator.alloc(REGION_SIZE, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    let off = base;
    const w = (...bytes: number[]) => { for (const b of bytes) mem[off++] = b & 0xFF; };

    // FLD qword [ESP+4]  ; DD /0 m64fp — load the cdecl double argument onto ST(0)
    const fldArg = () => w(0xDD, 0x44, 0x24, 0x04);

    /**
     * FRNDINT under an explicit rounding control, caller's control word restored.
     *   DD 44 24 04       fld    qword [esp+4]
     *   D9 7C 24 04       fnstcw word [esp+4]      ; save caller CW into the dead arg slot
     *   66 8B 44 24 04    mov    ax, [esp+4]
     *   66 25 FF F3       and    ax, ~RC_MASK
     *   66 0D <rc>        or     ax, rc
     *   66 89 44 24 08    mov    [esp+8], ax       ; upper half of the dead arg slot
     *   D9 6C 24 08       fldcw  word [esp+8]
     *   D9 FC             frndint                  ; ST(0) = round(ST(0)) under rc
     *   D9 6C 24 04       fldcw  word [esp+4]      ; restore caller CW
     *   C3                ret                      ; cdecl — caller cleans
     * EAX is clobbered (it holds the control word). The x86 ABI defines no integer
     * return for a double-returning function, so nothing may read it; the hypercall
     * handler clobbers EAX too.
     */
    const emitRound = (rc: number): number => {
        const stub = off;
        fldArg();
        w(0xD9, 0x7C, 0x24, 0x04);
        w(0x66, 0x8B, 0x44, 0x24, 0x04);
        w(0x66, 0x25, (~RC_MASK) & 0xFF, ((~RC_MASK) >> 8) & 0xFF);
        w(0x66, 0x0D, rc & 0xFF, (rc >> 8) & 0xFF);
        w(0x66, 0x89, 0x44, 0x24, 0x08);
        w(0xD9, 0x6C, 0x24, 0x08);
        w(0xD9, 0xFC);
        w(0xD9, 0x6C, 0x24, 0x04);
        w(0xC3);
        return stub;
    };

    const floorStub = emitRound(RC_DOWN);
    const ceilStub = emitRound(RC_UP);

    // double fabs(double): FABS clears the sign bit — rounding-mode independent,
    // and it quiets nothing, so NaN payloads survive as they do on hardware.
    //   DD 44 24 04   fld qword [esp+4]
    //   D9 E1         fabs
    //   C3            ret
    const fabsStub = off;
    fldArg();
    w(0xD9, 0xE1);
    w(0xC3);

    // double sqrt(double): FSQRT is correctly rounded under the CURRENT precision
    // control, which is what the real CRT emits — so a guest that set PC=single
    // gets the single-precision result the hardware would have given it.
    //   DD 44 24 04   fld qword [esp+4]
    //   D9 FA         fsqrt
    //   C3            ret
    const sqrtStub = off;
    fldArg();
    w(0xD9, 0xFA);
    w(0xC3);

    /**
     * __int64 _ftol(void): operand in ST(0), truncated toward zero, popped,
     * returned in EDX:EAX. The shipped MSVC body, minus the EBP frame:
     *   83 EC 10          sub    esp, 16
     *   D9 3C 24          fnstcw word [esp]
     *   66 8B 04 24       mov    ax, [esp]
     *   66 0D 00 0C       or     ax, RC_TRUNC     ; RC=11, both bits set — no AND needed
     *   66 89 44 24 04    mov    [esp+4], ax
     *   D9 6C 24 04       fldcw  word [esp+4]
     *   DF 7C 24 08       fistp  qword [esp+8]    ; store+pop the 64-bit integer
     *   D9 2C 24          fldcw  word [esp]       ; restore caller CW
     *   8B 44 24 08       mov    eax, [esp+8]
     *   8B 54 24 0C       mov    edx, [esp+12]
     *   83 C4 10          add    esp, 16
     *   C3                ret
     * Out-of-range/NaN yields the x87 integer indefinite (0x8000000000000000) rather
     * than the hypercall's saturation — hardware behavior, and the in-range results
     * every real caller uses are identical.
     */
    const ftolStub = off;
    w(0x83, 0xEC, 0x10);
    w(0xD9, 0x3C, 0x24);
    w(0x66, 0x8B, 0x04, 0x24);
    w(0x66, 0x0D, RC_TRUNC & 0xFF, (RC_TRUNC >> 8) & 0xFF);
    w(0x66, 0x89, 0x44, 0x24, 0x04);
    w(0xD9, 0x6C, 0x24, 0x04);
    w(0xDF, 0x7C, 0x24, 0x08);
    w(0xD9, 0x2C, 0x24);
    w(0x8B, 0x44, 0x24, 0x08);
    w(0x8B, 0x54, 0x24, 0x0C);
    w(0x83, 0xC4, 0x10);
    w(0xC3);

    if (off > base + REGION_SIZE) {
        // A silent overrun would corrupt whatever the allocator handed out next.
        throw new Error(`[crt-math-stubs] emitted ${off - base}B into a ${REGION_SIZE}B region`);
    }

    Logger.log(LogCategory.SYSTEM,
        `CRT math micro-thunks emitted (${off - base}B): floor=0x${floorStub.toString(16)} ` +
        `ceil=0x${ceilStub.toString(16)} fabs=0x${fabsStub.toString(16)} ` +
        `sqrt=0x${sqrtStub.toString(16)} _ftol=0x${ftolStub.toString(16)}`);

    return { floorStub, ceilStub, fabsStub, sqrtStub, ftolStub, regionBase: base, regionEnd: base + REGION_SIZE };
}
