import { afterEach, expect, test } from 'bun:test';
import { loadDiagnostics } from '../../src/worker/core/diagnostics/load-diagnostics';

afterEach(() => loadDiagnostics.reset());

test('runtime DLL failures retain their search context, remain bounded and reset with a load', () => {
    loadDiagnostics.reset();
    const directories = ['C:\\PLUGIN\\'];
    for (let i = 0; i < 20; i++) loadDiagnostics.noteDllFailure({
        name: `dll${i}`, path: `C:\\PLUGIN\\dll${i}.dll`,
        searchDirectories: directories, reason: `link failure ${i}`,
    });
    directories[0] = 'C:\\OTHER\\';
    const failures = loadDiagnostics.listDllFailures();
    expect(failures).toHaveLength(16);
    expect(failures[0].name).toBe('dll4');
    expect(failures[15].reason).toBe('link failure 19');
    expect(failures[15].searchDirectories).toEqual(['C:\\PLUGIN\\']);
    failures.length = 0;
    expect(loadDiagnostics.listDllFailures()).toHaveLength(16);
    loadDiagnostics.reset();
    expect(loadDiagnostics.listDllFailures()).toEqual([]);
});
