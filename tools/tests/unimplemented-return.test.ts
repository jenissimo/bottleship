// A declared export with no handler must answer with something the CALLER can recognize
// as failure. The historical answer, ERROR_NOT_SUPPORTED (50), is a failure under no
// convention at all — these tests pin that it never comes back.
//
// The predicates are the guest's, not ours: SUCCEEDED(hr) is "high bit clear", a BOOL is
// "non-zero is TRUE", a find/create handle is "!= INVALID_HANDLE_VALUE", MMRESULT and
// MCIERROR are "0 is success". Each acute name is asserted against the predicate its own
// caller would apply.

import { describe, it, expect } from 'bun:test';
import { ThunkDispatcher } from '../../src/worker/core/thunking/thunk-dispatcher';
import { APIRegistry } from '../../src/worker/core/api-registry';
import { kernel32Module } from '../../src/worker/api/kernel32.api';
import { winmmModule } from '../../src/worker/api/winmm.api';
import { ole32Module } from '../../src/worker/api/ole32.api';
import { shfolderModule } from '../../src/worker/api/shfolder.api';
import { resolveHleExportAddress } from '../../src/worker/core/thunking/export-resolver';

const LEGACY_ERROR_NOT_SUPPORTED = 50;

// Vite's import.meta.glob does not run under bun, so the descriptors this test cares
// about are registered explicitly — the same registerModule() the worker calls.
const registry = APIRegistry.getInstance();
for (const m of [kernel32Module, winmmModule, ole32Module, shfolderModule]) registry.registerModule(m as any);

/** Run the real dispatcher slow path for a stub with no implementation; return EAX. */
function callUnimplemented(dllName: string, functionName: string, functionId = 0x100): number {
    const d: any = new ThunkDispatcher({ add_listener: () => { } } as any, {} as any);
    const mem = new Uint8Array(0x10000);
    d.cachedMem8 = mem;
    d.cachedDataView = new DataView(mem.buffer);
    d.memLength = mem.length;
    d.thunkGenerator = { getStubById: () => ({ dllName, functionName, functionId, argCount: 0 }) };
    d.markHleRegistrationComplete();
    const cpu = { reg32: new Int32Array(8) };
    cpu.reg32[4] = 0x1000; // ESP
    d._slowPathMissingImplementation(functionId, cpu, `${dllName}:${functionName}`);
    return cpu.reg32[0] >>> 0;
}

const succeeded = (hr: number): boolean => (hr & 0x80000000) === 0;

describe('unimplemented exports never answer "success"', () => {
    it('the legacy sentinel would have passed every success test (why this matters)', () => {
        expect(succeeded(LEGACY_ERROR_NOT_SUPPORTED)).toBe(true);   // SUCCEEDED(50)
        expect(LEGACY_ERROR_NOT_SUPPORTED !== 0).toBe(true);        // BOOL TRUE
        expect(LEGACY_ERROR_NOT_SUPPORTED !== 0xFFFFFFFF).toBe(true); // != INVALID_HANDLE_VALUE
    });

    it('BOOL/pointer exports answer FALSE/NULL', () => {
        expect(callUnimplemented('kernel32', 'GetFileAttributesExW')).toBe(0);
        expect(callUnimplemented('kernel32', 'ExpandEnvironmentStringsA')).toBe(0);
        expect(callUnimplemented('kernel32', 'GetHandleInformation')).toBe(0);
        expect(callUnimplemented('kernel32', 'WriteFileEx')).toBe(0);
        expect(callUnimplemented('kernel32', 'WriteProfileStringA')).toBe(0);
    });

    it('handle-returning exports answer INVALID_HANDLE_VALUE, not NULL and not 50', () => {
        const h = callUnimplemented('kernel32', 'FindFirstFileExA');
        expect(h).toBe(0xFFFFFFFF);
        expect(h).not.toBe(LEGACY_ERROR_NOT_SUPPORTED);
        expect(callUnimplemented('kernel32', 'CreateNamedPipeW')).toBe(0xFFFFFFFF);
    });

    it('HRESULT exports answer a FAILED() code', () => {
        for (const name of ['CoGetClassObject', 'CoMarshalInterface', 'CoRegisterMessageFilter']) {
            const hr = callUnimplemented('ole32', name);
            expect(succeeded(hr)).toBe(false);
            expect(hr).toBe(0x80004001); // E_NOTIMPL
        }
        expect(succeeded(callUnimplemented('shfolder', 'SHGetFolderPathW'))).toBe(false);
    });

    it('a COM vtable slot with no descriptor still answers E_NOTIMPL, not S_OK', () => {
        // Interfaces implemented in JS have no api-table entry; the IFoo_Method naming is
        // what makes them recognizable as HRESULT returns.
        expect(callUnimplemented('quartz', 'IMediaSeeking_GetDuration')).toBe(0x80004001);
    });

    it('MMRESULT/MCIERROR exports answer a non-zero error (0 is success there)', () => {
        expect(callUnimplemented('winmm', 'midiOutOpen')).toBe(8);   // MMSYSERR_NOTSUPPORTED
        expect(callUnimplemented('winmm', 'mciSendCommandW')).toBe(274); // MCIERR_UNSUPPORTED_FUNCTION
        expect(callUnimplemented('winmm', 'waveOutMessage')).not.toBe(0);
    });

    it('no acute name answers the legacy sentinel any more', () => {
        const acute: Array<[string, string]> = [
            ['kernel32', 'GetTickCount64'], ['kernel32', 'FindFirstFileExA'],
            ['kernel32', 'WriteFileEx'], ['kernel32', 'GetFileAttributesExA'],
            ['kernel32', 'GetFileAttributesExW'], ['kernel32', 'ExpandEnvironmentStringsA'],
            ['kernel32', 'ExpandEnvironmentStringsW'], ['kernel32', 'GetLongPathNameW'],
            ['kernel32', 'GetHandleInformation'], ['kernel32', 'WriteProfileStringA'],
            ['kernel32', 'WriteProfileStringW'],
        ];
        for (const [dll, fn] of acute) {
            expect(callUnimplemented(dll, fn)).not.toBe(LEGACY_ERROR_NOT_SUPPORTED);
        }
    });
});

describe('GetProcAddress does not hand out an export that cannot report failure', () => {
    // A stub already exists for the name; the resolver would otherwise return its address.
    const dispatcherWithStub = {
        thunkGenerator: {
            getDataExportAddress: () => undefined,
            getExportAddress: () => 0x00401234,
        },
    };

    it('answers NULL for GetTickCount64 — a 64-bit tick count has no failure value', () => {
        expect(resolveHleExportAddress(dispatcherWithStub, 'kernel32', 'GetTickCount64')).toBe(0);
    });

    it('still resolves an ordinary unimplemented export (its stub CAN report failure)', () => {
        expect(resolveHleExportAddress(dispatcherWithStub, 'kernel32', 'WriteFileEx')).toBe(0x00401234);
    });
});
