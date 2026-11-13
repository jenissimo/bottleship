import { beforeEach, afterEach, test, expect } from 'bun:test';
import { Msvcrt } from '../../src/worker/modules/msvcrt';
import { Crtdll } from '../../src/worker/modules/crtdll';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { System } from '../../src/worker/core/system';
import {
    NARROW_LENGTHS, WIDE_LENGTH, TOP_BYTES, GARBAGE, TIME_BOUND_MS, fallback, fillNarrow, fillWide,
} from '../runtime-test/string-long-cases.mjs';

// The JS fallbacks of the CRT string leaves answer like the string hypercalls: no length
// cap inside guest memory, and every scan bounded by readable memory. The hypercall arm of
// the same cases (tools/runtime-test/string-long-cases.mjs) is tools/runtime-test/string-long.mjs.

const RAM = 8 * 1024 * 1024;
const A = 0x100000, B = 0x400000;

let mem: Uint8Array, crt: any, crtdll: any, oldScheduler: any;
const callIn = (m: any, name: string, ...args: number[]) => m.exports[name]({}, mem, args) >>> 0;
const call = (name: string, ...args: number[]) => callIn(crt, name, ...args);

const narrow = (at: number, length: number, seed: number) => fillNarrow(mem, at, length, seed);
const wide = (at: number, length: number, seed: number) => fillWide(mem, at, length, seed);
function timed<T>(fn: () => T): { value: T; ms: number } {
    const t0 = performance.now();
    const value = fn();
    return { value, ms: performance.now() - t0 };
}

beforeEach(() => {
    const system = System.getInstance();
    oldScheduler = system.scheduler;
    system.scheduler = { getCurrentThread: () => ({ id: 1 }), isMainThread: () => true } as never;
    mem = new Uint8Array(RAM);
    Mem.bind(() => mem, (address, size) => address >= 0 && address + size <= mem.length);
    let heap = 0x7e0000;
    const process = {
        resetGeneration: 0,
        environment: new Map(),
        v86: { mem8: mem },
        addressSpace: { getRegion: () => null },
        memory: { alloc: (size: number) => { const p = heap; heap += size; return p; } },
    };
    crt = new Msvcrt();
    crt.registerDataExports = () => {};
    crt.initialize(process);
    crtdll = new Crtdll();
    (crtdll as any).registerDataExports = () => {};
    crtdll.initialize(process);
});
afterEach(() => {
    System.getInstance().scheduler = oldScheduler;
});

test('strlen/strcpy/strcmp/_stricmp/strstr answer whole strings over 1 MiB (msvcrt and crtdll)', () => {
    for (const length of NARROW_LENGTHS) {
        narrow(A, length, 1);
        for (const m of [crt, crtdll]) expect(callIn(m, 'strlen', A)).toBe(length);
        mem.fill(0xcd, B, B + length + 16);
        expect(call('strcpy', B, A)).toBe(B);
        expect(mem[B + length]).toBe(0);
        expect(mem[B + length + 1]).toBe(0xcd);
        expect(mem.subarray(B, B + length).every((v, i) => v === mem[A + i])).toBe(true);
        expect(call('strcmp', A, B)).toBe(0);
        mem[B + length - 1] = 0x7e;
        expect(call('strcmp', A, B) | 0).toBeLessThan(0);
        mem[B + length - 1] = mem[A + length - 1];
        mem[B + 10] ^= 0x20;
        expect(call('_stricmp', A, B)).toBe(0);
        mem[A + length - 3] = 0x21; mem[A + length - 2] = 0x22;
        mem[0x7f0000] = 0x21; mem[0x7f0001] = 0x22; mem[0x7f0002] = 0;
        expect(call('strstr', A, 0x7f0000)).toBe(A + length - 3);
        mem.fill(0xcd, B, B + length + 16);
        expect(callIn(crtdll, 'strcpy', B, A)).toBe(B);
        expect(mem[B + length]).toBe(0);
    }
});

test('wcslen/wcscpy/wcscat/_wcsicmp/wcschr/wcsstr answer whole strings over 1 MiB units', () => {
    const length = WIDE_LENGTH;
    wide(A, length, 2);
    expect(call('wcslen', A)).toBe(length);
    expect(callIn(crtdll, 'wcslen', A)).toBe(length);
    mem.fill(0xcd, B, B + length * 2 + 16);
    expect(call('wcscpy', B, A)).toBe(B);
    expect(mem[B + length * 2]).toBe(0);
    expect(mem[B + length * 2 + 1]).toBe(0);
    expect(mem[B + length * 2 + 2]).toBe(0xcd);
    expect(call('_wcsicmp', A, B)).toBe(0);
    mem[A + (length - 1) * 2] = 0x24; mem[A + (length - 1) * 2 + 1] = 0x02;
    expect(call('wcschr', A, 0x0224)).toBe(A + (length - 1) * 2);
    mem[0x7f0000] = 0x24; mem[0x7f0001] = 0x02; mem[0x7f0002] = 0; mem[0x7f0003] = 0;
    expect(call('wcsstr', A, 0x7f0000)).toBe(A + (length - 1) * 2);
    wide(B, 4, 3);
    wide(0x7f1000, 3, 4);
    expect(call('wcscat', B, 0x7f1000)).toBe(B);
    expect(call('wcslen', B)).toBe(7);
});

test('scans that run to the end of guest memory or start outside it end within the time bound', () => {
    mem.fill(0x41, RAM - TOP_BYTES, RAM);
    narrow(A, 8, 5);
    for (const [name, value] of [['strlen', fallback.strlenTop], ['wcslen', fallback.wcslenTop]] as const) {
        const r = timed(() => call(name, RAM - TOP_BYTES));
        expect(r.ms).toBeLessThan(TIME_BOUND_MS);
        expect(r.value).toBe(value);
    }
    expect(callIn(crtdll, 'strlen', RAM - TOP_BYTES)).toBe(fallback.strlenTop);
    for (const bad of GARBAGE) {
        for (const [name, args] of [['strlen', [bad]], ['wcslen', [bad]], ['strcmp', [bad, A]], ['_stricmp', [bad, A]],
            ['_wcsicmp', [bad, A]], ['wcschr', [bad, 0x41]], ['strstr', [bad, A]], ['wcsstr', [bad, A]]] as const) {
            const r = timed(() => call(name, ...(args as number[])));
            expect(r.ms).toBeLessThan(TIME_BOUND_MS);
        }
    }
    for (const bad of GARBAGE) {
        expect(call('strlen', bad)).toBe(fallback.strlenGarbage);
        expect(callIn(crtdll, 'strlen', bad)).toBe(fallback.strlenGarbage);
        expect(call('wcslen', bad)).toBe(fallback.wcslenGarbage);
        expect(call('wcschr', bad, 0x41)).toBe(fallback.wcschrGarbage);
        expect(call('strstr', bad, A)).toBe(fallback.strstrGarbageHaystack);
        expect(call('strstr', A, bad)).toBe(fallback.strstrGarbageNeedle);
        expect(call('wcsstr', bad, A)).toBe(fallback.wcsstrGarbageHaystack);
        expect(call('wcsstr', A, bad)).toBe(fallback.wcsstrGarbageNeedle);
    }
});
