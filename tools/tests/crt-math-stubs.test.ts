// The CRT math micro-thunks (writeCrtMathStubs) replace an OUT trap with REAL x86 that
// v86's JIT compiles, so nothing at runtime re-checks their semantics — a wrong rounding-
// control constant would silently shift every glyph quad by a pixel. This test pins the
// emitted bytes AND executes them through a strict decoder that models x87 semantics, so
// the encodings and the arithmetic they produce are both checked. The decoder REFUSES any
// byte pattern the emitter is not supposed to produce, which is itself a codegen check.

import { describe, it, expect } from 'bun:test';
import { writeCrtMathStubs } from '../../src/worker/modules/crt-math-stubs';
import type { StubAllocator } from '../../src/worker/core/thunking/thunk-memory-manager';

const MEM_SIZE = 1 << 16;
const STUB_BASE = 0x1000;
/** Guest stack for the interpreter, far from the stub block. */
const STACK_TOP = 0x8000;

function mkStubs() {
    const mem = new Uint8Array(MEM_SIZE);
    let bump = STUB_BASE;
    const allocator: StubAllocator = {
        alloc(size: number): number {
            const addr = bump;
            bump = (bump + size + 15) & ~15;
            return addr;
        },
    };
    const stubs = writeCrtMathStubs(allocator, () => mem);
    return { mem, stubs };
}

function hex(mem: Uint8Array, start: number, len: number): string {
    return Array.from(mem.subarray(start, start + len))
        .map(b => b.toString(16).padStart(2, '0')).join(' ');
}

// ─── Byte-level encoding pins ───────────────────────────────────────────────

describe('crt-math-stubs encodings', () => {
    const { mem, stubs } = mkStubs();

    // floor/ceil differ ONLY in the rounding-control immediate: 0x0400 (toward -inf)
    // vs 0x0800 (toward +inf), inside `or ax, imm16`.
    const roundBody = (rc: string) =>
        'dd 44 24 04 ' +      // fld    qword [esp+4]
        'd9 7c 24 04 ' +      // fnstcw word [esp+4]
        '66 8b 44 24 04 ' +   // mov    ax, [esp+4]
        '66 25 ff f3 ' +      // and    ax, 0xf3ff       (clear RC)
        `66 0d ${rc} ` +      // or     ax, RC
        '66 89 44 24 08 ' +   // mov    [esp+8], ax
        'd9 6c 24 08 ' +      // fldcw  word [esp+8]
        'd9 fc ' +            // frndint
        'd9 6c 24 04 ' +      // fldcw  word [esp+4]     (restore caller CW)
        'c3';                 // ret                     (cdecl)

    it('floor rounds toward -inf and restores the control word', () => {
        expect(hex(mem, stubs.floorStub, 37)).toBe(roundBody('00 04'));
    });

    it('ceil rounds toward +inf and restores the control word', () => {
        expect(hex(mem, stubs.ceilStub, 37)).toBe(roundBody('00 08'));
    });

    it('fabs is fld + FABS + ret', () => {
        expect(hex(mem, stubs.fabsStub, 7)).toBe('dd 44 24 04 d9 e1 c3');
    });

    it('sqrt is fld + FSQRT + ret', () => {
        expect(hex(mem, stubs.sqrtStub, 7)).toBe('dd 44 24 04 d9 fa c3');
    });

    it('_ftol truncates via FISTP and returns EDX:EAX', () => {
        expect(hex(mem, stubs.ftolStub, 42)).toBe(
            '83 ec 10 ' +        // sub    esp, 16
            'd9 3c 24 ' +        // fnstcw word [esp]
            '66 8b 04 24 ' +     // mov    ax, [esp]
            '66 0d 00 0c ' +     // or     ax, 0x0c00     (RC = truncate)
            '66 89 44 24 04 ' +  // mov    [esp+4], ax
            'd9 6c 24 04 ' +     // fldcw  word [esp+4]
            'df 7c 24 08 ' +     // fistp  qword [esp+8]
            'd9 2c 24 ' +        // fldcw  word [esp]      (restore caller CW)
            '8b 44 24 08 ' +     // mov    eax, [esp+8]
            '8b 54 24 0c ' +     // mov    edx, [esp+12]
            '83 c4 10 ' +        // add    esp, 16
            'c3');               // ret                    (cdecl: no args on the stack)
    });

    it('every stub ends in RET (cdecl — the caller cleans, never RET N)', () => {
        for (const [name, addr] of Object.entries(stubs)) {
            if (!name.endsWith('Stub')) continue;
            // Scan forward to the first C3/C2; it must be C3 and must come before the next stub.
            let i = addr;
            while (i < stubs.regionEnd && mem[i] !== 0xC3 && mem[i] !== 0xC2) i++;
            expect(`${name}:${mem[i].toString(16)}`).toBe(`${name}:c3`);
        }
    });

    it('the whole emission fits its region', () => {
        expect(stubs.regionEnd - stubs.regionBase).toBe(256);
        expect(stubs.ftolStub + 42).toBeLessThanOrEqual(stubs.regionEnd);
    });
});

// ─── x87 semantics, executed from the emitted bytes ─────────────────────────

/** x87 default control word: RC=nearest-even, PC=extended, all exceptions masked. */
const CW_DEFAULT = 0x037F;

function roundTiesEven(f: number): number {
    if (!Number.isFinite(f) || Number.isInteger(f)) return f; // keeps -0
    const fl = Math.floor(f);
    const diff = f - fl;
    if (diff > 0.5) return fl + 1;
    if (diff < 0.5) return fl;
    return fl % 2 === 0 ? fl : fl + 1;
}

/** FRNDINT / FISTP rounding, dispatched on the control word's RC field (bits 11:10). */
function roundByRc(f: number, cw: number): number {
    switch ((cw >> 10) & 3) {
        case 0: return roundTiesEven(f);
        case 1: return Math.floor(f);
        case 2: return Math.ceil(f);
        default: return Math.trunc(f);
    }
}

interface RunResult {
    st0: number | undefined;
    depth: number;
    cw: number;
    eax: number;
    edx: number;
    esp: number;
}

/**
 * Execute one emitted stub. Strict decoder: anything outside the instruction set the
 * emitter is allowed to produce throws, naming the offending bytes.
 */
function runStub(mem: Uint8Array, entry: number, arg?: number, st0In?: number, cwIn = CW_DEFAULT): RunResult {
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const fpu: number[] = st0In === undefined ? [] : [st0In]; // fpu[0] === ST(0)
    let eip = entry;
    let esp = STACK_TOP;
    let eax = 0xDEADBEEF, edx = 0xDEADBEEF;
    let cw = cwIn;

    dv.setUint32(esp, 0xC0FFEE, true);                     // return address
    if (arg !== undefined) dv.setFloat64(esp + 4, arg, true); // the cdecl double argument

    const at = (i: number, ...bytes: number[]) => bytes.every((b, k) => mem[i + k] === b);

    for (let guard = 0; guard < 64; guard++) {
        if (at(eip, 0xC3)) return { st0: fpu[0], depth: fpu.length, cw, eax, edx, esp };
        if (at(eip, 0xDD, 0x44, 0x24, 0x04)) { fpu.unshift(dv.getFloat64(esp + 4, true)); eip += 4; }
        else if (at(eip, 0xD9, 0x7C, 0x24)) { dv.setUint16(esp + mem[eip + 3], cw, true); eip += 4; }
        else if (at(eip, 0xD9, 0x3C, 0x24)) { dv.setUint16(esp, cw, true); eip += 3; }
        else if (at(eip, 0xD9, 0x6C, 0x24)) { cw = dv.getUint16(esp + mem[eip + 3], true); eip += 4; }
        else if (at(eip, 0xD9, 0x2C, 0x24)) { cw = dv.getUint16(esp, true); eip += 3; }
        else if (at(eip, 0xD9, 0xFC)) { fpu[0] = roundByRc(fpu[0], cw); eip += 2; }
        else if (at(eip, 0xD9, 0xE1)) { fpu[0] = Math.abs(fpu[0]); eip += 2; }
        else if (at(eip, 0xD9, 0xFA)) { fpu[0] = Math.sqrt(fpu[0]); eip += 2; }
        else if (at(eip, 0xDF, 0x7C, 0x24)) {
            const v = roundByRc(fpu.shift()!, cw);
            // x87 integer indefinite on NaN / out of range, exactly like the hardware.
            const ok = Number.isFinite(v) && v >= -(2 ** 63) && v < 2 ** 63;
            dv.setBigInt64(esp + mem[eip + 3], ok ? BigInt(v) : -(2n ** 63n), true);
            eip += 4;
        }
        else if (at(eip, 0x66, 0x8B, 0x44, 0x24)) { eax = (eax & ~0xFFFF) | dv.getUint16(esp + mem[eip + 4], true); eip += 5; }
        else if (at(eip, 0x66, 0x8B, 0x04, 0x24)) { eax = (eax & ~0xFFFF) | dv.getUint16(esp, true); eip += 4; }
        else if (at(eip, 0x66, 0x89, 0x44, 0x24)) { dv.setUint16(esp + mem[eip + 4], eax & 0xFFFF, true); eip += 5; }
        else if (at(eip, 0x66, 0x25)) { eax = (eax & ~0xFFFF) | ((eax & dv.getUint16(eip + 2, true)) & 0xFFFF); eip += 4; }
        else if (at(eip, 0x66, 0x0D)) { eax = (eax & ~0xFFFF) | ((eax | dv.getUint16(eip + 2, true)) & 0xFFFF); eip += 4; }
        else if (at(eip, 0x8B, 0x44, 0x24)) { eax = dv.getUint32(esp + mem[eip + 3], true); eip += 4; }
        else if (at(eip, 0x8B, 0x54, 0x24)) { edx = dv.getUint32(esp + mem[eip + 3], true); eip += 4; }
        else if (at(eip, 0x83, 0xEC)) { esp -= mem[eip + 2]; eip += 3; }
        else if (at(eip, 0x83, 0xC4)) { esp += mem[eip + 2]; eip += 3; }
        else throw new Error(`unexpected opcode at +0x${(eip - entry).toString(16)}: ${hex(mem, eip, 6)}`);
    }
    throw new Error('stub did not return');
}

describe('crt-math-stubs semantics', () => {
    const { mem, stubs } = mkStubs();
    const call = (entry: number, arg?: number, st0?: number) => runStub(mem, entry, arg, st0);

    it('floor matches IEEE floor, including the negative-fraction and -0.0 cases', () => {
        const cases: [number, number][] = [
            [2.5, 2], [3.0, 3], [-0.5, -1], [-2.5, -3], [-3.0, -3], [0.5, 0], [1e300, 1e300],
        ];
        for (const [x, want] of cases) {
            expect(`floor(${x})=${call(stubs.floorStub, x).st0}`).toBe(`floor(${x})=${want}`);
        }
        expect(Object.is(call(stubs.floorStub, -0.0).st0, -0.0)).toBe(true);
        expect(Object.is(call(stubs.floorStub, 0.0).st0, 0.0)).toBe(true);
        expect(call(stubs.floorStub, -Infinity).st0).toBe(-Infinity);
        expect(Number.isNaN(call(stubs.floorStub, NaN).st0!)).toBe(true);
    });

    it('ceil matches IEEE ceil, and ceil(-0.5) is -0.0 (not 0.0)', () => {
        const cases: [number, number][] = [[2.5, 3], [3.0, 3], [-2.5, -2], [-3.0, -3], [0.5, 1]];
        for (const [x, want] of cases) {
            expect(`ceil(${x})=${call(stubs.ceilStub, x).st0}`).toBe(`ceil(${x})=${want}`);
        }
        expect(Object.is(call(stubs.ceilStub, -0.5).st0, -0.0)).toBe(true);
        expect(Object.is(call(stubs.ceilStub, -0.0).st0, -0.0)).toBe(true);
        expect(call(stubs.ceilStub, Infinity).st0).toBe(Infinity);
    });

    it('floor and ceil leave one value on the x87 stack and restore the caller control word', () => {
        for (const entry of [stubs.floorStub, stubs.ceilStub]) {
            const r = call(entry, -1.5);
            expect(r.depth).toBe(1);
            expect(r.cw).toBe(CW_DEFAULT);
            expect(r.esp).toBe(STACK_TOP); // cdecl: the callee pops nothing
        }
    });

    it('fabs clears the sign, including -0.0, and never rounds', () => {
        expect(call(stubs.fabsStub, -3.5).st0).toBe(3.5);
        expect(call(stubs.fabsStub, 3.5).st0).toBe(3.5);
        expect(Object.is(call(stubs.fabsStub, -0.0).st0, 0.0)).toBe(true);
        expect(call(stubs.fabsStub, -Infinity).st0).toBe(Infinity);
        expect(call(stubs.fabsStub, -1e-320).st0).toBe(1e-320); // subnormal survives
        expect(call(stubs.fabsStub, -3.5).depth).toBe(1);
    });

    it('sqrt is exact for representable roots and preserves -0.0', () => {
        expect(call(stubs.sqrtStub, 4).st0).toBe(2);
        expect(call(stubs.sqrtStub, 2).st0).toBe(Math.SQRT2);
        expect(Object.is(call(stubs.sqrtStub, 0.0).st0, 0.0)).toBe(true);
        expect(Object.is(call(stubs.sqrtStub, -0.0).st0, -0.0)).toBe(true);
        expect(Number.isNaN(call(stubs.sqrtStub, -1).st0!)).toBe(true);
        expect(call(stubs.sqrtStub, 4).depth).toBe(1);
    });

    it('_ftol truncates toward zero and returns the full 64-bit value in EDX:EAX', () => {
        const cases: [number, bigint][] = [
            [2.9, 2n], [-2.9, -2n], [-0.5, 0n], [0.5, 0n], [-1, -1n],
            [3e9, 3000000000n],                       // > INT32_MAX: EAX alone would be wrong
            [4294967296 * 1.5, 6442450944n],          // needs EDX
            [-4294967296 * 1.5, -6442450944n],
        ];
        for (const [x, want] of cases) {
            const r = call(stubs.ftolStub, undefined, x);
            const got = BigInt.asIntN(64, (BigInt(r.edx) << 32n) | BigInt(r.eax));
            expect(`_ftol(${x})=${got}`).toBe(`_ftol(${x})=${want}`);
        }
    });

    it('_ftol pops ST(0), restores the control word and leaves ESP where it found it', () => {
        const r = call(stubs.ftolStub, undefined, 7.9);
        expect(r.depth).toBe(0);
        expect(r.cw).toBe(CW_DEFAULT);
        expect(r.esp).toBe(STACK_TOP);
    });

    it('_ftol yields the x87 integer indefinite on NaN / overflow', () => {
        for (const x of [NaN, 1e300, -1e300]) {
            const r = call(stubs.ftolStub, undefined, x);
            expect(`${x}:${r.edx.toString(16)}${r.eax.toString(16)}`).toBe(`${x}:800000000`);
        }
    });

    it('sets the rounding mode it needs instead of inheriting the guest\'s, and gives it back', () => {
        // A guest that left RC=truncate (any _controlfp caller) must still get a real
        // floor/ceil — and must get its own mode back, bit for bit.
        const CW_TRUNC = 0x0F7F;
        expect(runStub(mem, stubs.floorStub, -0.5, undefined, CW_TRUNC).st0).toBe(-1);
        expect(runStub(mem, stubs.ceilStub, 0.5, undefined, CW_TRUNC).st0).toBe(1);
        expect(runStub(mem, stubs.floorStub, -0.5, undefined, CW_TRUNC).cw).toBe(CW_TRUNC);
        expect(runStub(mem, stubs.ftolStub, undefined, -2.9, CW_TRUNC).cw).toBe(CW_TRUNC);
        // A guest in RC=up must not turn _ftol into a ceil.
        const CW_UP = 0x0B7F;
        const r = runStub(mem, stubs.ftolStub, undefined, -2.9, CW_UP);
        expect(BigInt.asIntN(64, (BigInt(r.edx) << 32n) | BigInt(r.eax))).toBe(-2n);
        expect(r.cw).toBe(CW_UP);
    });
});
