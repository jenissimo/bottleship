import { expect, test } from 'bun:test';
import { APIRegistry } from '../../src/worker/core/api-registry';
import { bindTimeCallingConvention, resolveImportBinding, type ImportBindingDeps } from '../../src/worker/core/pe-import-binding';

const registry = APIRegistry.getInstance();

function registryDeps(shipped: string[]): ImportBindingDeps {
    return {
        hasThunkedModule: (n) => n === 'msvcrt' || n === 'msvcr71' || n === 'kernel32',
        findDllPath: (n) => (shipped.includes(n.toLowerCase()) ? `C:\\GAME\\${n}.dll` : null),
        appDirRule: () => null,
        isUnderSystemDirectory: () => false,
        exportFacts: (thunked, f) => (f.name === undefined ? {} : f.name === 'printf' ? { callingConvention: 'cdecl' } : {
            callingConvention: registry.getCallingConvention(thunked, f.name),
            argCount: registry.getArgCount(thunked, f.name),
            stackCleanupBytes: registry.getStackCleanupBytes(thunked, f.name),
        }),
        log: () => {},
        warn: () => {},
    };
}

test('at bind time an undescribed C runtime export takes cdecl; other DLLs and known exports keep theirs', () => {
    for (const dll of ['msvcrt', 'MSVCRT.DLL', 'msvcr71.dll', 'msvcr100d', 'crtdll.dll', 'ucrtbase', 'api-ms-win-crt-runtime-l1-1-0.dll'])
        expect(bindTimeCallingConvention(dll, undefined, undefined)).toBe('cdecl');
    expect(bindTimeCallingConvention('kernel32', undefined, undefined)).toBeUndefined();
    expect(bindTimeCallingConvention('msvcp60', undefined, undefined)).toBeUndefined();
    expect(bindTimeCallingConvention('msvcrt', undefined, 2)).toBeUndefined();
    expect(bindTimeCallingConvention('msvcrt', 'stdcall', undefined)).toBe('stdcall');
});

test('the registry itself does not guess, so coverage is unchanged', () => {
    expect(registry.getCallingConvention('msvcrt', 'zz_no_such_crt_export')).toBeUndefined();
    expect(registry.getCallingConvention('msvcr71', 'zz_no_such_crt_export')).toBeUndefined();
});

test('a shipped msvcrt.dll with an undescribed import is still loaded natively', () => {
    const functions = [{ name: 'printf' }, { name: 'zz_no_such_crt_export' }];
    expect(resolveImportBinding('MSVCRT.dll', functions, registryDeps(['msvcrt'])).isThunked).toBe(false);
    expect(resolveImportBinding('MSVCRT.dll', [{ name: 'printf' }], registryDeps(['msvcrt'])).isThunked).toBe(true);
});
