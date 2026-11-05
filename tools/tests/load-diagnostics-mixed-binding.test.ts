import { beforeEach, expect, test } from 'bun:test';
import { loadDiagnostics } from '../../src/worker/core/diagnostics/load-diagnostics';

beforeEach(() => loadDiagnostics.reset());

test('one DLL name bound to the HLE module and to the shipped file is reported once', () => {
    expect(loadDiagnostics.noteImportBinding('MSVCRT.dll', true)).toBe(false);
    expect(loadDiagnostics.noteImportBinding('msvcrt.dll', true)).toBe(false);
    expect(loadDiagnostics.noteImportBinding('MSVCRT.DLL', false)).toBe(true);
    expect(loadDiagnostics.noteImportBinding('msvcrt', true)).toBe(false);
    expect(loadDiagnostics.listMixedBindings()).toEqual(['msvcrt']);
});

test('consistent bindings are not reported, and reset forgets the process', () => {
    loadDiagnostics.noteImportBinding('kernel32.dll', true);
    loadDiagnostics.noteImportBinding('KERNEL32.dll', true);
    loadDiagnostics.noteImportBinding('engine.dll', false);
    loadDiagnostics.noteImportBinding('engine.dll', false);
    expect(loadDiagnostics.listMixedBindings()).toEqual([]);
    loadDiagnostics.noteImportBinding('msvcrt.dll', false);
    loadDiagnostics.reset();
    expect(loadDiagnostics.noteImportBinding('msvcrt.dll', true)).toBe(false);
});
