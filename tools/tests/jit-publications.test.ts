import { test, expect } from 'bun:test';
import { createJitPublicationCapture } from '../../src/worker/harness/jit-publications';
import { joinJitProfile, sha256 } from '../bench-v86/join-jit-profile.mjs';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('real finalize hook records actual published, mutated bytes and failed instantiations', async () => {
    const source = readFileSync('vendor/v86/src/cpu.js', 'utf8');
    const begin = source.indexOf('CPU.prototype.codegen_finalize = function');
    const end = source.indexOf('CPU.prototype.log_uncompiled_code', begin);
    const capture = createJitPublicationCapture();
    const pending: Array<{ resolve: (value: any) => void; reject: (error: any) => void }> = [];
    const CPU = function () {} as any;
    runInNewContext(source.slice(begin, end), {
        CPU, Uint8Array, DEBUG: false, WASM_TABLE_SIZE: 1024, WASM_TABLE_OFFSET: 1024,
        dbg_assert() {}, h: String, console: { error() {} },
        __jitPublicationCapture: capture,
        WebAssembly: { CompileError: WebAssembly.CompileError, LinkError: WebAssembly.LinkError,
            instantiate: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) },
    });
    const cpu = new CPU();
    const published: number[] = [];
    cpu.wasm_memory = { buffer: new Uint8Array([1, 2]).buffer };
    cpu.wm = { wasm_table: { set: (slot: number) => published.push(slot) } };
    cpu.codegen_finalize_finished = () => {};
    cpu.codegen_finalize_failed = () => 0;
    cpu.test_hook_did_generate_wasm = (bytes: Uint8Array) => { bytes[0] = 9; };
    cpu.codegen_finalize(1, 0x1000, 0, 0, 2);
    cpu.codegen_finalize(1, 0x1000, 0, 0, 2);
    pending[1].resolve({ instance: { exports: { f() {} } } });
    pending[0].reject(new WebAssembly.CompileError('test'));
    await new Promise(resolve => setTimeout(resolve, 0));
    capture.seal();
    const out = await capture.export();
    expect(published).toEqual([1025]);
    expect(out.events.map(e => e.status)).toEqual(['failed', 'published']);
    expect(out.events[1].sha256).toBe(sha256(new Uint8Array([9, 2])));
    expect(new Uint8Array(cpu.wasm_memory.buffer)[0]).toBe(1);
});

test('publication order follows completion, retaining same-page versions and slot reuse', async () => {
    const capture = createJitPublicationCapture();
    const source = new Uint8Array([1, 2]);
    const a = capture.begin(0x1000, 1, 1025, source)!;
    source[0] = 3;
    const b = capture.begin(0x1000, 1, 1025, source)!;
    b.published(); a.published();
    capture.seal();
    const out = await capture.export();
    expect(out.events.map(e => e.publicationOrder)).toEqual([2, 1]);
    expect(out.events.map(e => e.sha256)).toEqual([sha256(new Uint8Array([1, 2])), sha256(source)]);
    expect(out.modules.length).toBe(2);
});

test('bounds include pending records; loss counters and generation gaps survive', async () => {
    const capture = createJitPublicationCapture({ maxBytes: 3, maxRecords: 2 });
    capture.begin(1, 1, 1, new Uint8Array(4));
    capture.begin(1, 1, 1, new Uint8Array(2))!.published();
    capture.begin(1, 1, 1, new Uint8Array(1));
    expect(capture.begin(1, 1, 1, new Uint8Array(0))).toBeNull();
    capture.seal();
    const out = await capture.export();
    expect(out.dropped).toBe(2);
    expect(out.droppedBytes).toBe(4);
    expect(out.retainedBytes).toBe(3);
    expect(out.events.map(e => e.generation)).toEqual([2, 3]);
    expect(out.events[1].status).toBe('pending');
});

test('seal freezes pending callbacks and exports deduplicated bytes without losing events', async () => {
    const capture = createJitPublicationCapture();
    capture.begin(1, 1, 1, new Uint8Array([1]))!.published();
    const pending = capture.begin(1, 1, 1, new Uint8Array([1]))!;
    await expect(capture.export()).rejects.toThrow('Seal');
    capture.seal(); pending.published();
    const out = await capture.export();
    expect(out.modules.length).toBe(1);
    expect(out.events.length).toBe(2);
    expect(out.events[1].status).toBe('pending');
    expect(capture.begin(1, 1, 1, new Uint8Array(0))).toBeNull();
});

test('join uses script byte identity, never the current owner of a recycled slot', () => {
    const profile = { nodes: [
        { id: 1, callFrame: { scriptId: 'old', functionName: 'g1000@t1', url: 'wasm://old' } },
        { id: 2, callFrame: { scriptId: 'new', functionName: 'g1000@t1', url: 'wasm://new' } },
        { id: 3, callFrame: { scriptId: 'missing', functionName: 'g1000@t1', url: 'wasm://missing' } },
    ], samples: [1, 2, 1, 3], timeDeltas: [10, 20, 30, 40] };
    const scripts = [{ scriptId: 'old', sha256: 'a' }, { scriptId: 'new', sha256: 'b' }];
    const journal = { dropped: 0, completeFromWorkerStart: true, events: [
        { status: 'published', sha256: 'a', generation: 1, tableSlot: 1 },
        { status: 'published', sha256: 'b', generation: 2, tableSlot: 1 },
    ] };
    const out = joinJitProfile(profile, scripts, journal);
    expect(out.byteResolvedSamples).toBe(3);
    expect(out.publicationResolvedSamples).toBe(3);
    expect(out.rows.find(r => r.nodeId === 1)?.generation).toBe(1);
    expect(out.rows.find(r => r.nodeId === 3)?.generation).toBeNull();
    journal.events.push({ status: 'published', sha256: 'a', generation: 3, tableSlot: 1 });
    expect(joinJitProfile(profile, scripts, journal).publicationResolvedSamples).toBe(1);
    journal.dropped = 1;
    expect(joinJitProfile(profile, scripts, journal).publicationResolvedSamples).toBe(0);
    journal.dropped = 0;
    journal.completeFromWorkerStart = false;
    expect(joinJitProfile(profile, scripts, journal).publicationResolvedSamples).toBe(0);
});

test('invalid bounds and incomplete profile data fail visibly', () => {
    for (const maxBytes of [0, -1, Infinity, NaN, 2 ** 30]) {
        expect(() => createJitPublicationCapture({ maxBytes })).toThrow();
    }
    expect(() => joinJitProfile({ samples: [1], timeDeltas: [], nodes: [] }, [], {})).toThrow();
    expect(() => joinJitProfile({ samples: [1], timeDeltas: [10], nodes: [] }, [], {})).toThrow();
    expect(() => joinJitProfile({ samples: [], timeDeltas: [], nodes: [] }, [{ scriptId: '1' }, { scriptId: '1' }], {})).toThrow();
});
