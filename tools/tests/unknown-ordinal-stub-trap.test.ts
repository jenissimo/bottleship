import { expect, test } from 'bun:test';
import { ThunkGenerator } from '../../src/worker/core/thunking/thunk-generator';

test('a stdcall import without a known stack cleanup cannot be stubbed, so the loader traps it instead', () => {
    const gen = new ThunkGenerator();
    expect(gen.canGenerateStub('ord_4486', {})).toBe(false);
    expect(() => gen.generateStubDll('mfc42', [{ name: 'ord_4486' }])).toThrow();
});

test('imports with a known cleanup or a caller-cleaned convention are still stubbed', () => {
    const gen = new ThunkGenerator();
    expect(gen.canGenerateStub('ord_1', { argCount: 2 })).toBe(true);
    expect(gen.canGenerateStub('ord_2', { stackCleanupBytes: 0 })).toBe(true);
    expect(gen.canGenerateStub('ord_3', { callingConvention: 'cdecl' })).toBe(true);
    expect(gen.canGenerateStub('?f@@YGXH@Z', {})).toBe(true);
});
