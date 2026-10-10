import { expect, test } from 'bun:test';
import { registerCrtMathExports } from '../../src/worker/modules/crt-math';
import { FPU_ST_OFFSET } from '../../src/worker/core/fpu-helper';
import { APIRegistry } from '../../src/worker/core/api-registry';
import { msvcrtModule } from '../../src/worker/api/msvcrt.api';
import { unimplementedReturnValue } from '../../src/worker/core/thunking/unimplemented-return';
import type { Process } from '../../src/worker/core/process';
import type { ThunkImplementation } from '../../src/worker/core/thunking/thunk-dispatcher';

test('_hypot passes two stack doubles and returns ST(0), avoiding intermediate overflow and underflow', () => {
    const v86 = { cpu: { wasm_memory: { buffer: new ArrayBuffer(0x2000) },
        wm: { exports: { get_relaxed_fpu: () => 1 } } } };
    const exports: Record<string, ThunkImplementation> = {};
    const pair = new ArrayBuffer(8);
    const bits = new Uint32Array(pair);
    const values = new Float64Array(pair);
    let error = 0;
    registerCrtMathExports(exports, {
        process: { v86 } as unknown as Process,
        u32PairToDouble(lo, hi) { bits[0] = lo; bits[1] = hi; return values[0]; },
        setErrno(value) { error = value; },
    });
    const call = (x: number, y: number) => {
        values[0] = x;
        const args = [bits[0], bits[1]];
        values[0] = y;
        args.push(bits[0], bits[1]);
        exports._hypot(null as never, new Uint8Array(0), args);
        const view = new DataView(v86.cpu.wasm_memory.buffer);
        return view.getFloat64(FPU_ST_OFFSET + (view.getUint8(1032) & 7) * 16, true);
    };
    expect(call(-3, 4)).toBe(5);
    expect(call(3e200, 4e200) / 1e200).toBeCloseTo(5, 12);
    expect(call(3e-200, 4e-200) / 1e-200).toBeCloseTo(5, 12);
    expect(call(0, -0)).toBe(0);
    expect(call(Infinity, NaN)).toBe(Infinity);
    expect(error).toBe(0);
    expect(call(Number.MAX_VALUE, Number.MAX_VALUE)).toBe(Infinity);
    expect(error).toBe(34);
});

test('CRT import descriptors specify cdecl double slots and failing sentinels for unsupported fd calls', () => {
    const registry = APIRegistry.getInstance();
    registry.registerModule(msvcrtModule);
    expect(registry.getArgCount('msvcrt', '_hypot')).toBe(4);
    expect(registry.getStackCleanupBytes('msvcrt', '_hypot')).toBe(16);
    expect(registry.getCallingConvention('msvcrt', '_hypot')).toBe('cdecl');
    for (const name of ['_dup', '_locking']) {
        expect(registry.getCallingConvention('msvcrt', name)).toBe('cdecl');
        expect(unimplementedReturnValue(registry.getUnimplementedReturnClass('msvcrt', name)!)).toBe(0xffffffff);
    }
});
