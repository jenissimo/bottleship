import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Msvcrt } from '../../src/worker/modules/msvcrt';
import { msvcrtModule } from '../../src/worker/api/msvcrt.api';
import { Mem } from '../../src/worker/core/memory/mem-accessor';

let memory: Uint8Array;
let crt: Msvcrt;
let environment: Map<string, string>;
let savedMem: Record<string, unknown>;

beforeEach(() => {
    savedMem = Object.fromEntries(['memoryGetter', 'validateRange', 'getRegion']
        .map(key => [key, (Mem as any)[key]]));
    memory = new Uint8Array(0x20000);
    Mem.bind(() => memory);
    let next = 0x1000;
    environment = new Map([['TZ', 'UTC0']]);
    const process = {
        resetGeneration: 0, environment,
        memory: { alloc: (size: number) => { const p = next; next += size; return p; } },
    };
    crt = new Msvcrt();
    (crt as any).registerDataExports = () => {};
    crt.initialize(process as never);
});

afterEach(() => { Object.assign(Mem, savedMem); });

test('_tzset is declared as a zero-argument cdecl export with a real handler', () => {
    const descriptor = msvcrtModule.functions.find(fn => fn.name === '_tzset');
    expect(descriptor).toBeDefined();
    expect(descriptor!.callingConvention).toBe('cdecl');
    expect(descriptor!.params).toHaveLength(0);
    expect(typeof crt.exports._tzset).toBe('function');
});

test('calling the guest _tzset export refreshes timezone data without moving its cells', () => {
    const state = (crt as any).timezoneState;
    const addresses = [state.timezone, state.daylight, state.dstbias, state.tzname];
    expect(Mem.readInt32(state.timezone)).toBe(0);
    environment.set('TZ', 'IST-5:30');
    expect(typeof crt.exports._tzset).toBe('function');
    crt.exports._tzset!(null as never, memory, []);
    expect(Mem.readInt32(state.timezone)).toBe(-19800);
    expect(Mem.readInt32(state.daylight)).toBe(0);
    expect(state.name(0)).toBe('IST');
    expect([state.timezone, state.daylight, state.dstbias, state.tzname]).toEqual(addresses);
});
