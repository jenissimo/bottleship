import { expect, test } from 'bun:test';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import type { Process } from '../../src/worker/core/process';
import { Msvcrt } from '../../src/worker/modules/msvcrt';

test('MinGW startup can dereference the __p__environ result and read the initial environment', () => {
    const mem = new Uint8Array(1 << 20);
    const data = new Map<string, number>();
    let next = 0x1000;
    const process = {
        resetGeneration: 0,
        environment: new Map([['PATH', 'C:\\WINDOWS']]),
        v86: { mem8: mem },
        getCurrentMemory: () => mem,
        addressSpace: { getRegion: () => null },
        memory: {
            alloc(size: number) {
                const ptr = next;
                next += (size + 7) & ~7;
                return ptr;
            },
        },
        thunkGenerator: {
            registerDataExport(_dll: string, name: string, ptr: number) { data.set(name, ptr); },
        },
    };
    Mem.bind(() => mem, (ptr, size) => ptr > 0 && ptr + size <= mem.length);
    const msvcrt = new Msvcrt();
    msvcrt.initialize(process as unknown as Process);

    const slot = msvcrt.exports.__p__environ!({} as never, mem, []) as number;
    expect(slot).toBeGreaterThan(0);
    expect(slot).toBe(data.get('_environ')!);
    const vector = Mem.readUint32(slot)!;
    expect(vector).toBeGreaterThan(0);
    const path = Mem.readUint32(vector)!;
    const bytes = Array.from(mem.subarray(path, mem.indexOf(0, path)));
    expect(String.fromCharCode(...bytes)).toBe('PATH=C:\\WINDOWS');
});
