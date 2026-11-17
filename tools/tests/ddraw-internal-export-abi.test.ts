import { expect, test } from 'bun:test';
import { ddrawModule } from '../../src/worker/api/ddraw.api';
import { APIRegistry } from '../../src/worker/core/api-registry';
import { ThunkGenerator } from '../../src/worker/core/thunking/thunk-generator';
import { ThunkDispatcher } from '../../src/worker/core/thunking/thunk-dispatcher';
import { resolveHleExportAddress } from '../../src/worker/core/thunking/export-resolver';
import { stubRegistry } from '../../src/worker/core/diagnostics/stub-registry';

// NT5 ddraw/main: ddsacc.c196-215, ddcsurf.c2348, ddcreate.c7866.
// Declared ABIs, not implementations of DDraw's private LCL surface/lock mechanism.
const contracts = [
    ['AcquireDDThreadLock', 0, 'void', 'unresolvable', 0],
    ['ReleaseDDThreadLock', 0, 'void', 'unresolvable', 0],
    ['DDInternalLock', 2, 'i32', 'hresult', 0x80004001],
    ['DDInternalUnlock', 1, 'i32', 'hresult', 0x80004001],
    ['CompleteCreateSysmemSurface', 1, 'u32', 'zero', 0],
    ['D3DParseUnknownCommand', 2, 'i32', 'hresult', 0x80004001],
] as const;
const registry = APIRegistry.getInstance();
registry.registerModule(ddrawModule);

function generated() {
    const gen = new ThunkGenerator();
    gen.setBaseAddress(0x21046000);
    const dll = gen.generateStubDll('ddraw', contracts.map(([name]) => ({
        name, argCount: registry.getArgCount('ddraw', name),
        stackCleanupBytes: registry.getStackCleanupBytes('ddraw', name),
        callingConvention: registry.getCallingConvention('ddraw', name),
    })));
    return { gen, dll };
}

test('six private exports bind with NT5 stdcall types and actual RET bytes', () => {
    const { gen, dll } = generated();
    expect(dll.exportTable.size).toBe(6);
    for (const [name, argc, type, policy] of contracts) {
        const fn = ddrawModule.functions.find(f => f.name === name)!;
        expect(fn).toBeDefined();
        expect(fn.params.length).toBe(argc);
        expect(fn.returnType).toBe(type);
        expect(fn.callingConvention).toBe('stdcall');
        expect(fn.onUnimplemented).toBe(policy);
        expect(registry.getArgCount('ddraw', name)).toBe(argc);
        expect(registry.getStackCleanupBytes('ddraw', name)).toBe(argc * 4);
        const address = dll.exportTable.get(name.toLowerCase())!;
        const stub = gen.getStubByAddress(address)!;
        expect(stub.stackCleanupBytes).toBe(argc * 4);
        const off = address - dll.baseAddress;
        expect(dll.stubCode[off + 10]).toBe(0xef); // actual OUT DX,EAX
        expect(Array.from(dll.stubCode.slice(off + 11, off + 11 + (argc ? 3 : 1))))
            .toEqual(argc ? [0xc2, argc * 4, 0] : [0xc3]);
    }
});

test('unsupported static imports record every call and return explicit failures without writing out parameters', () => {
    const { gen, dll } = generated();
    const d: any = new ThunkDispatcher({ add_listener() {} } as any, {} as any);
    const mem = new Uint8Array(0x4000).fill(0xa5);
    const view = new DataView(mem.buffer);
    d.cachedMem8 = mem; d.cachedDataView = view; d.memLength = mem.length;
    d.thunkGenerator = gen; d.markHleRegistrationComplete();
    let lastError = -1;
    d.ensureScheduler = () => ({ setLastError(value: number) { lastError = value; } });
    const cpu = { reg32: new Int32Array(8) };
    d.cachedReg32Raw = cpu.reg32; d.cachedWasmBuffer = mem.buffer;
    cpu.reg32[4] = 0x1000;
    view.setUint32(0x1000, 0x12345678, true);
    view.setUint32(0x1004, 0x2000, true);
    view.setUint32(0x1008, 0x2100, true);
    const before = mem.slice();
    // Leave any pre-existing registry data intact; compare counts by exact export.
    for (const [name, , , policy, expected] of contracts) {
        const previous = stubRegistry.list().find(x => x.key === 'ddraw:' + name)?.count ?? 0;
        const stub = gen.getStubByAddress(dll.exportTable.get(name.toLowerCase())!)!;
        lastError = -1;
        d._slowPathMissingImplementation(stub.functionId, cpu, 'ddraw:' + name);
        expect(cpu.reg32[0] >>> 0).toBe(expected);
        if (policy === 'hresult') expect(cpu.reg32[0]).toBeLessThan(0);
        expect(lastError).toBe(120);
        const hit = stubRegistry.list().find(x => x.key === 'ddraw:' + name)!;
        expect(hit.count).toBe(previous + 1);
        expect(hit.lastCaller).toBe(0x12345678);
        expect(cpu.reg32[4]).toBe(0x1000); // stub, not missing-handler path, owns RET cleanup
        expect(mem).toEqual(before);
    }
});

test('void locks are unavailable to dynamic lookup, not advertised as working no-op locks', () => {
    const { gen } = generated();
    for (const [name] of contracts.slice(0, 2)) {
        expect(gen.getExportAddress('ddraw:' + name)).toBeDefined(); // static IAT stub exists
        expect(resolveHleExportAddress({ thunkGenerator: gen }, 'ddraw', name)).toBe(0);
    }
    // A result-bearing unimplemented export remains resolvable because it can refuse.
    expect(resolveHleExportAddress({ thunkGenerator: gen }, 'ddraw', 'DDInternalLock')).toBeGreaterThan(0);
});
