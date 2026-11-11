// Native x86 micro-thunks for the pure-compute CRT math imports (floor/ceil/fabs/
// sqrt/_ftol/_finite/_isnan). Codegen pinned by tools/tests/crt-math-stubs.test.ts.
// Caller: pe-loader (CRT-module import), via ThunkMemoryManager.stubAllocator.

import { Logger, LogCategory } from '../core/logger';
import type { StubAllocator } from '../core/thunking/thunk-memory-manager';
import { FTOL_TRUNCATE_BODY } from '../core/hle-lib/native-leaves';

/** Micro-thunk entry points, as named on {@link CrtMathStubs}. */
export type CrtMathStubName = 'floorStub' | 'ceilStub' | 'fabsStub' | 'sqrtStub' | 'ftolStub' | 'finiteStub' | 'isnanStub';

export interface CrtMathStubs {
    floorStub: number;
    ceilStub: number;
    fabsStub: number;
    sqrtStub: number;
    ftolStub: number;
    finiteStub: number;
    isnanStub: number;
    regionBase: number;
    regionEnd: number;
}

/** x87 control-word rounding-control field (bits 11:10). */
const RC_MASK = 0x0C00;
const RC_DOWN = 0x0400;   // toward -inf  (floor)
const RC_UP = 0x0800;     // toward +inf  (ceil)

/** 7 stubs, largest 37 bytes; one 256-byte block keeps them on one page. */
const REGION_SIZE = 256;

/**
 * Emit the pure-compute CRT math imports as REAL x86 in guest code memory.
 *
 * These already bypass JS dispatch via the WASM hypercall tier, but a hypercall
 * still costs the OUT trap out of the JIT block — a boundary no tier can remove,
 * and floor alone is tens of thousands of calls per second. Emitted as guest x86
 * the JIT compiles them like any other block and the boundary disappears.
 *
 * All of them are __cdecl (see msvcrt.api.ts): the CALLER cleans the stack, so every
 * stub ends in RET (0xC3), never RET N. floor/ceil/fabs/sqrt take the double at
 * [ESP+4]; _ftol takes its operand in ST(0) and returns the full __int64 in EDX:EAX.
 * The double-returning ones leave the result in ST(0) — the x87 return register —
 * exactly like the hypercall's fpu_push.
 *
 * floor/ceil set the x87 rounding control around FRNDINT and restore the caller's
 * control word, which is what the real CRT does; _ftol is FISTTP, which truncates
 * without touching the control word (shared with the static-CRT copies, native-leaves.ts).
 * Scratch space is the argument area ([ESP+4..+11], dead once loaded — in 32-bit cdecl
 * the parameter slots are the callee's to modify) for the double-arg stubs, and 8 bytes
 * of fresh stack for _ftol, which has no argument area.
 *
 * The FLDCW window is preempt-safe: the control word is per-thread state — saved and
 * restored with the rest of the x87 snapshot (fpu-helper.ts) — and softfloat reads RC/PC
 * from it live, so a thread switch inside a stub hands nobody our rounding mode.
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

    // __int64 _ftol(void): operand in ST(0), truncated toward zero, popped, returned in
    // EDX:EAX — see FTOL_TRUNCATE_BODY.
    const ftolStub = off;
    w(...FTOL_TRUNCATE_BODY);

    // int _finite(double): 1 unless the exponent field is all ones (Inf/NaN). Integer-only,
    // so no x87 state is touched and the control word is irrelevant.
    //   8B 44 24 08       mov   eax, [esp+8]       ; high dword of the double
    //   25 00 00 F0 7F    and   eax, 0x7FF00000
    //   3D 00 00 F0 7F    cmp   eax, 0x7FF00000
    //   0F 95 C0          setne al
    //   0F B6 C0          movzx eax, al
    //   C3                ret
    const finiteStub = off;
    w(0x8B, 0x44, 0x24, 0x08);
    w(0x25, 0x00, 0x00, 0xF0, 0x7F);
    w(0x3D, 0x00, 0x00, 0xF0, 0x7F);
    w(0x0F, 0x95, 0xC0);
    w(0x0F, 0xB6, 0xC0);
    w(0xC3);

    // int _isnan(double): NaN iff (hi & 0x7FFFFFFF) + (lo != 0) > 0x7FF00000 unsigned — the
    // sum cannot carry out of 31 bits, so one compare covers both "exponent all ones with a
    // non-zero high mantissa" and "high mantissa zero but low mantissa non-zero". ECX is
    // caller-saved in cdecl.
    //   8B 44 24 08       mov   eax, [esp+8]
    //   25 FF FF FF 7F    and   eax, 0x7FFFFFFF
    //   8B 4C 24 04       mov   ecx, [esp+4]       ; low dword
    //   F7 D9             neg   ecx                ; CF = (lo != 0)
    //   83 D0 00          adc   eax, 0
    //   3D 00 00 F0 7F    cmp   eax, 0x7FF00000
    //   0F 97 C0          seta  al
    //   0F B6 C0          movzx eax, al
    //   C3                ret
    const isnanStub = off;
    w(0x8B, 0x44, 0x24, 0x08);
    w(0x25, 0xFF, 0xFF, 0xFF, 0x7F);
    w(0x8B, 0x4C, 0x24, 0x04);
    w(0xF7, 0xD9);
    w(0x83, 0xD0, 0x00);
    w(0x3D, 0x00, 0x00, 0xF0, 0x7F);
    w(0x0F, 0x97, 0xC0);
    w(0x0F, 0xB6, 0xC0);
    w(0xC3);

    if (off > base + REGION_SIZE) {
        // A silent overrun would corrupt whatever the allocator handed out next.
        throw new Error(`[crt-math-stubs] emitted ${off - base}B into a ${REGION_SIZE}B region`);
    }

    Logger.log(LogCategory.SYSTEM,
        `CRT math micro-thunks emitted (${off - base}B): floor=0x${floorStub.toString(16)} ` +
        `ceil=0x${ceilStub.toString(16)} fabs=0x${fabsStub.toString(16)} ` +
        `sqrt=0x${sqrtStub.toString(16)} _ftol=0x${ftolStub.toString(16)} ` +
        `_finite=0x${finiteStub.toString(16)} _isnan=0x${isnanStub.toString(16)}`);

    return { floorStub, ceilStub, fabsStub, sqrtStub, ftolStub, finiteStub, isnanStub, regionBase: base, regionEnd: base + REGION_SIZE };
}
