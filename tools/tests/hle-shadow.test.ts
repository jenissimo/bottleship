/**
 * Guarded Inner-Loop HLE — shadow validator unit tests.
 *
 * Gate for step 0: the validator must catch a deliberately-broken
 * kernel (wrong bytes / wrong EAX / out-of-contract write) and permanently
 * disable the hook, while a correct kernel accumulates N clean calls and
 * goes active. Pure pieces only — the in-game path is exercised by the first
 * real descriptor.
 */

import { describe, expect, test } from 'bun:test';
import {
    LiveShadowView,
    ScratchShadowView,
    ShadowHookRuntime,
    compareShadowOutputs,
    rangesAreSane,
} from '../../src/worker/core/hle-lib/shadow-validator';
import { validatePrologueBytes } from '../../src/worker/core/hle-lib/lib-patcher';
import type { ShadowRange, ShadowSpec } from '../../src/worker/core/hle-lib/types';

const MEM_SIZE = 0x10000;
function mkMem(): Uint8Array {
    const mem = new Uint8Array(MEM_SIZE);
    for (let i = 0; i < MEM_SIZE; i++) mem[i] = (i * 7 + 3) & 0xFF;
    return mem;
}

describe('validatePrologueBytes', () => {
    test('accepts the canonical MSVC prologue', () => {
        // push ebp; mov ebp,esp; sub esp, 0x40
        const bytes = new Uint8Array([0x55, 0x8B, 0xEC, 0x83, 0xEC, 0x40]);
        expect(validatePrologueBytes(bytes)).toBeNull();
    });
    test('accepts push-heavy prologue with imm32 sub', () => {
        // push ebx; push esi; push edi; sub esp, imm32
        const bytes = new Uint8Array([0x53, 0x56, 0x57, 0x81, 0xEC, 0x00, 0x01, 0x00, 0x00]);
        expect(validatePrologueBytes(bytes)).toBeNull();
    });
    test('accepts a register load of an immediate', () => {
        // push ebp; mov ecx, 0x100
        const bytes = new Uint8Array([0x55, 0xB9, 0x00, 0x01, 0x00, 0x00]);
        expect(validatePrologueBytes(bytes)).toBeNull();
    });
    test('rejects relative call (E8) — position-dependent', () => {
        const bytes = new Uint8Array([0x55, 0x8B, 0xEC, 0xE8, 0x00, 0x00, 0x00, 0x00]);
        expect(validatePrologueBytes(bytes)).toContain('unsupported');
    });
    test('rejects a length that splits an instruction', () => {
        // 5 bytes cutting into `sub esp, imm32` (81 EC needs 6)
        const bytes = new Uint8Array([0x55, 0x8B, 0xEC, 0x81, 0xEC]);
        expect(validatePrologueBytes(bytes)).not.toBeNull();
    });
    test('rejects too-short prologue', () => {
        expect(validatePrologueBytes(new Uint8Array([0x55, 0x8B, 0xEC]))).toContain('< 5');
    });
});

describe('ScratchShadowView', () => {
    const ranges: ShadowRange[] = [{ addr: 0x2000, len: 0x100 }];

    test('reads inside ranges come from the scratch copy, writes stay off guest memory', () => {
        const mem = mkMem();
        const before = mem.slice(0x2000, 0x2100);
        const v = new ScratchShadowView(mem, ranges);
        expect(v.readU8(0x2005)).toBe(before[5]);
        v.writeU32(0x2008, 0xDEADBEEF);
        expect(v.readU32(0x2008) >>> 0).toBe(0xDEADBEEF);
        // guest memory untouched
        expect(mem.slice(0x2000, 0x2100)).toEqual(before);
    });

    test('reads outside ranges hit live memory', () => {
        const mem = mkMem();
        const v = new ScratchShadowView(mem, ranges);
        expect(v.readU8(0x3000)).toBe(mem[0x3000]);
    });

    test('out-of-contract write is detected, not applied', () => {
        const mem = mkMem();
        const v = new ScratchShadowView(mem, ranges);
        const before = mem[0x3000];
        v.writeU8(0x3000, 0xAA);
        expect(mem[0x3000]).toBe(before);
        expect(v.outOfContractWrite).toContain('0x3000');
    });
});

describe('compareShadowOutputs', () => {
    const ranges: ShadowRange[] = [{ addr: 0x2000, len: 8 }];

    test('clean pass', () => {
        const mem = mkMem();
        const scratch = [mem.slice(0x2000, 0x2008)];
        expect(compareShadowOutputs(mem, ranges, scratch, 7, 7)).toBeNull();
    });
    test('EAX mismatch', () => {
        const mem = mkMem();
        const scratch = [mem.slice(0x2000, 0x2008)];
        const m = compareShadowOutputs(mem, ranges, scratch, 7, 8);
        expect(m?.kind).toBe('eax');
    });
    test('byte mismatch names the first diff', () => {
        const mem = mkMem();
        const scratch = [mem.slice(0x2000, 0x2008)];
        scratch[0][3] ^= 0xFF;
        const m = compareShadowOutputs(mem, ranges, scratch, 0, 0);
        expect(m?.kind).toBe('bytes');
        expect(m?.detail).toContain('0x2003');
    });
    test('f32 ULP tolerance forgives tiny drift, catches real drift', () => {
        const mem = mkMem();
        const live = new DataView(mem.buffer, 0x2000, 8);
        live.setFloat32(0, 1.0, true);
        live.setFloat32(4, 2.0, true);
        const scratch = [mem.slice(0x2000, 0x2008)];
        const sv = new DataView(scratch[0].buffer);
        // 1 ulp off
        sv.setUint32(0, live.getUint32(0, true) + 1, true);
        expect(compareShadowOutputs(mem, ranges, scratch, 0, 0, 2)).toBeNull();
        // way off
        sv.setFloat32(0, 1.5, true);
        expect(compareShadowOutputs(mem, ranges, scratch, 0, 0, 2)?.kind).toBe('bytes');
        // and byte-exact mode rejects even the 1-ulp drift
        sv.setUint32(0, live.getUint32(0, true) + 1, true);
        expect(compareShadowOutputs(mem, ranges, scratch, 0, 0)?.kind).toBe('bytes');
    });
});

describe('rangesAreSane', () => {
    test('accepts normal ranges, rejects junk', () => {
        expect(rangesAreSane([{ addr: 0x2000, len: 64 }], MEM_SIZE)).toBe(true);
        expect(rangesAreSane([{ addr: 0x2000, len: MEM_SIZE }], MEM_SIZE)).toBe(false);
        expect(rangesAreSane([{ addr: 0, len: 4 }], MEM_SIZE)).toBe(false);
        expect(rangesAreSane([{ addr: 8192.5, len: 4 }], MEM_SIZE)).toBe(false);
    });
});

// ─── The step-0 gate: state machine end-to-end over a fake guest function ───

/** Guest "function": sums `len` bytes at `src` into a u32 at `dst`, returns the sum. */
function guestSumBytes(mem: Uint8Array, src: number, len: number, dst: number): number {
    let acc = 0;
    for (let i = 0; i < len; i++) acc = (acc + mem[src + i]) >>> 0;
    new DataView(mem.buffer).setUint32(dst, acc, true);
    return acc;
}

function specFor(kernelBug: 'none' | 'wrong-byte' | 'wrong-eax' | 'stray-write'): ShadowSpec {
    return {
        n: 4,
        ranges: (args) => [{ addr: args[2], len: 4 }],
        kernel: (view, args) => {
            const [src, len, dst] = args;
            let acc = 0;
            for (let i = 0; i < len; i++) acc = (acc + view.readU8(src + i)) >>> 0;
            if (kernelBug === 'wrong-byte') acc = (acc + 1) >>> 0;
            view.writeU32(dst, acc, );
            if (kernelBug === 'stray-write') view.writeU8(dst + 64, 0xAA);
            return kernelBug === 'wrong-eax' ? 0x1234 : acc;
        },
    };
}

/** Drive one shadowed call the way buildShadowHandler does (kernel→scratch,
 *  original→live, compare) and feed the runtime. */
function driveShadowCall(rt: ShadowHookRuntime, spec: ShadowSpec, mem: Uint8Array, args: number[]): void {
    const live = new LiveShadowView(mem);
    const ranges = spec.ranges(args, live);
    expect(rangesAreSane(ranges, mem.length)).toBe(true);
    const scratch = new ScratchShadowView(mem, ranges);
    let kernelEax = 0;
    try {
        kernelEax = spec.kernel(scratch, args) >>> 0;
    } catch (e) {
        rt.recordMismatch({ kind: 'kernel-threw', detail: String(e) });
        return;
    }
    if (scratch.outOfContractWrite) {
        rt.recordMismatch({ kind: 'out-of-contract-write', detail: scratch.outOfContractWrite });
        return;
    }
    const guestEax = guestSumBytes(mem, args[0], args[1], args[2]) >>> 0; // original, authoritative
    const mismatch = compareShadowOutputs(mem, ranges, scratch.scratch, kernelEax, guestEax, spec.f32UlpTolerance);
    if (mismatch) rt.recordMismatch(mismatch);
    else rt.recordCleanCall();
}

describe('ShadowHookRuntime — the step-0 gate', () => {
    test('correct kernel validates after N clean calls', () => {
        let disabled = 0;
        const spec = specFor('none');
        const rt = new ShadowHookRuntime('test', 'sum', spec, () => { disabled++; });
        const mem = mkMem();
        for (let i = 0; i < 4; i++) driveShadowCall(rt, spec, mem, [0x1000 + i * 32, 16, 0x4000]);
        expect(rt.state).toBe('active');
        expect(disabled).toBe(0);
    });

    test('GATE: deliberately-broken kernel (wrong bytes) is caught and disabled on call 1', () => {
        let disabled = 0;
        const spec = specFor('wrong-byte');
        const rt = new ShadowHookRuntime('test', 'sum', spec, () => { disabled++; });
        driveShadowCall(rt, spec, mkMem(), [0x1000, 16, 0x4000]);
        expect(rt.state).toBe('disabled');
        expect(rt.mismatches).toBe(1);
        expect(disabled).toBe(1);
    });

    test('GATE: wrong-EAX kernel is caught', () => {
        const spec = specFor('wrong-eax');
        const rt = new ShadowHookRuntime('test', 'sum', spec, () => {});
        driveShadowCall(rt, spec, mkMem(), [0x1000, 16, 0x4000]);
        expect(rt.state).toBe('disabled');
        expect(rt.lastMismatch).toContain('eax');
    });

    test('GATE: out-of-contract write is caught before the original even runs', () => {
        const spec = specFor('stray-write');
        const rt = new ShadowHookRuntime('test', 'sum', spec, () => {});
        driveShadowCall(rt, spec, mkMem(), [0x1000, 16, 0x4000]);
        expect(rt.state).toBe('disabled');
        expect(rt.lastMismatch).toContain('out-of-contract');
    });

    test('rearm resets counters but never resurrects a disabled hook', () => {
        const okSpec = specFor('none');
        const rt = new ShadowHookRuntime('test', 'sum', okSpec, () => {});
        const mem = mkMem();
        for (let i = 0; i < 4; i++) driveShadowCall(rt, okSpec, mem, [0x1000, 16, 0x4000]);
        expect(rt.state).toBe('active');
        expect(rt.rearm(2)).toBe(true);
        expect(rt.state).toBe('shadowing');
        expect(rt.cleanCalls).toBe(0);

        const badSpec = specFor('wrong-byte');
        const rt2 = new ShadowHookRuntime('test', 'sum', badSpec, () => {});
        driveShadowCall(rt2, badSpec, mkMem(), [0x1000, 16, 0x4000]);
        expect(rt2.state).toBe('disabled');
        expect(rt2.rearm()).toBe(false);
        expect(rt2.state).toBe('disabled');
    });
});
