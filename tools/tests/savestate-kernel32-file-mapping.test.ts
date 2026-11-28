import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { AddressSpace } from '../../src/worker/core/memory/address-space';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { MemoryManager, type Process } from '../../src/worker/core/process';
import { SystemResourceProvider } from '../../src/worker/core/resources/system-resource-provider';
import { System } from '../../src/worker/core/system';
import { Advapi32 } from '../../src/worker/modules/advapi32';
import { exports as fileIo, resetFileIoState } from '../../src/worker/modules/kernel32/file-io';
import type { VfsFileHandle } from '../../src/worker/runtime/filesystem/vfs';
import { registerCoreParticipants } from '../../src/worker/savestate/core-participants';
import { newObjectGraph, restoreObjectGraph } from '../../src/worker/savestate/object-codecs';
import { savestateParticipants, type CaptureContext } from '../../src/worker/savestate/participant';
import { decodeValue, encodeValue, type SaveValue } from '../../src/worker/savestate/value-codec';
import { preserveMemBinding, preserveSavestateParticipants } from './helpers/scoped-process-state';

preserveMemBinding();
preserveSavestateParticipants();

const system = System.getInstance();
const originalProcess = system.process;
const originalProvider = system.resourceProvider;
const name = 0x100000;
let ram: Uint8Array;
let addressSpace: AddressSpace;
let memory: MemoryManager;

function freshProcess(bytes = new Uint8Array(4 << 20)): void {
    ram = bytes;
    addressSpace = new AddressSpace(() => ram);
    memory = new MemoryManager(addressSpace);
    system.resourceProvider = new SystemResourceProvider();
    system.process = { addressSpace, memory, resourceProvider: system.resourceProvider } as Process;
    Mem.bind(() => ram, (base, size, perms) => addressSpace.validateRange(base, size, perms));
    resetFileIoState();
}

function call(method: string, ...args: number[]) {
    return fileIo[method]!({} as never, ram, args);
}

function roundTrip(migrateFromV1 = false): void {
    const participant = savestateParticipants.all().find(p => p.id === 'resources')!;
    const graph = newObjectGraph();
    let state = participant.capture(graph as CaptureContext);
    if (migrateFromV1) {
        const { fileMappings, ...previous } = state as Record<string, SaveValue>;
        expect(fileMappings).toEqual({ names: [], views: [] });
        const migration = savestateParticipants.migrationFor('resources', {
            version: 1, schemaHash: 'de537d8b445269ef',
        });
        expect(migration).toBeDefined();
        state = migration!.migrate(previous);
    }
    const snapshot = encodeValue([state, graph.objects] as SaveValue);
    const savedAddressSpace = addressSpace.captureState();
    const savedMemory = memory.captureState();
    freshProcess(ram.slice());
    addressSpace.restoreState(savedAddressSpace);
    memory.restoreState(savedMemory);
    const [saved, objects] = decodeValue(snapshot) as [SaveValue, Array<[string, SaveValue]>];
    participant.restore(saved, restoreObjectGraph(objects));
}

beforeEach(() => {
    freshProcess();
    addressSpace.registerRegion({ base: name, size: 2 << 20, kind: 'HEAP', perms: 'rw', owner: 'Layout' });
    memory.refreshLayoutBuckets();
    expect(memory.alloc(128)).toBe(name);
    ram.set(new TextEncoder().encode('section\0'), name);
    const wide = new Uint16Array(ram.buffer, name + 64, 8);
    wide.set([...('section\0')].map(c => c.charCodeAt(0)));
    registerCoreParticipants();
});

afterEach(() => {
    resetFileIoState();
    system.process = originalProcess;
    system.resourceProvider = originalProvider;
});

test('restores a named pagefile section and both views after the last handle closes', async () => {
    const section = call('CreateFileMappingA', 0xffffffff, 0, 4, 0, 0x20000, name) as number;
    const a = await call('MapViewOfFile', section, 2, 0, 0, 64) as number;
    const b = await call('MapViewOfFile', section, 4, 0, 0x10000, 64) as number;
    const alias = call('OpenFileMappingW', 4, 0, name + 64) as number;
    expect(alias).not.toBe(section);
    expect(system.resourceProvider.getKernelObject(alias)).toBe(system.resourceProvider.getKernelObject(section));
    expect(call('CloseHandle', section)).toBe(1);
    expect(call('CloseHandle', alias)).toBe(1);
    Mem.writeUint32(a + 16, 0xabcd1234);
    Mem.writeUint32(b + 16, 0x98765432);

    roundTrip();

    expect(system.resourceProvider.getKernelObject(section)).toBeNull();
    expect(Mem.readUint32(a + 16)).toBe(0xabcd1234);
    expect(Mem.readUint32(b + 16)).toBe(0x98765432);
    expect(allocations()).toContain(a);
    expect(allocations()).toContain(b);
    const reopened = call('OpenFileMappingA', 4, 0, name) as number;
    expect(reopened).toBeGreaterThan(0);
    expect(system.resourceProvider.getKernelObject(reopened)).toMatchObject({ kind: 'file_mapping', file: null, size: 0x20000, protect: 4, name: 'section' });
    expect(await call('UnmapViewOfFile', a)).toMatchObject({ value: 1 });
    expect(await call('UnmapViewOfFile', b)).toMatchObject({ value: 1 });
    expect(allocations()).not.toContain(a);
    expect(allocations()).not.toContain(b);
    expect(call('CloseHandle', reopened)).toBe(1);
    expect(call('OpenFileMappingA', 4, 0, name)).toBe(0);
});

function allocations(): number[] {
    return memory.captureState().allocs.map(([base]) => base);
}

test('restores a file-backed mapping with independent write and copy views', async () => {
    const path = 'C:\\test.dat';
    const backing: VfsFileHandle = { kind: 'file', path, source: 'overlay', access: 0xc0000000, position: 91 };
    const reads = spyOn(system.fileSystem, 'read').mockImplementation(async (_, size) => new Uint8Array(size).fill(3));
    const writes = spyOn(system.fileSystem, 'write').mockImplementation(async (_, bytes) => bytes.length);
    const flush = spyOn(system.fileSystem, 'flushFile').mockResolvedValue(undefined);
    try {
        const source = system.resourceProvider.registerFileHandle({ vfsHandle: backing, close() {} });
        const section = call('CreateFileMappingW', source, 0, 4, 0, 0x40000, name + 64) as number;
        const writeView = await call('MapViewOfFile', section, 2, 0, 0x10000, 64) as number;
        const copyView = await call('MapViewOfFile', section, 1, 0, 0x20000, 64) as number;
        expect(call('CloseHandle', source)).toBe(1);
        Mem.writeUint32(writeView, 0xa1b2c3d4);
        Mem.writeUint32(copyView, 0x11223344);
        expect(backing.position).toBe(91);
        const alias = call('OpenFileMappingA', 4, 0, name) as number;
        roundTrip();

        expect(system.resourceProvider.getKernelObject(alias)).toBe(system.resourceProvider.getKernelObject(section));
        expect(Mem.readUint32(writeView)).toBe(0xa1b2c3d4);
        expect(Mem.readUint32(copyView)).toBe(0x11223344);
        expect(reads).toHaveBeenCalledTimes(2);
        expect(writes).not.toHaveBeenCalled();
        expect(await call('FlushViewOfFile', copyView, 4)).toMatchObject({ value: 1 });
        expect(await call('UnmapViewOfFile', copyView)).toMatchObject({ value: 1 });
        expect(writes).not.toHaveBeenCalled();
        expect(await call('FlushViewOfFile', writeView, 4)).toMatchObject({ value: 1 });
        expect(writes).toHaveBeenCalledTimes(1);
        expect(writes.mock.calls[0]).toEqual([
            { ...backing, position: 0x10000 },
            new Uint8Array([0xd4, 0xc3, 0xb2, 0xa1]),
        ]);
    } finally {
        reads.mockRestore();
        writes.mockRestore();
        flush.mockRestore();
    }
});

test('restores existing resource slots from schema v1 without mappings', () => {
    const event = { kind: 'event', manualReset: true, signaled: false };
    const handle = system.resourceProvider.registerKernelObject(event);
    roundTrip(true);
    expect(system.resourceProvider.getKernelObject(handle)).toEqual(event);
    expect(call('OpenFileMappingA', 4, 0, name)).toBe(0);
});

test('restores an open registry key with its handle and key path', () => {
    const open = (parent: number, output: number): number => {
        const advapi = new Advapi32();
        advapi.initialize(system.process!);
        expect(advapi.exports.RegOpenKeyExA!({} as never, ram, [parent, 0, 0, 0, output])).toMatchObject({ value: 0 });
        return Mem.readUint32(output)!;
    };
    const handle = open(0x80000001, name + 96);

    roundTrip();

    const child = open(handle, name + 100);
    expect(system.resourceProvider.getKernelObject(handle)).toEqual({ kind: 'reg', key: 'HKCU' });
    expect(system.resourceProvider.getKernelObject(child)).toEqual({ kind: 'reg', key: 'HKCU' });
});
