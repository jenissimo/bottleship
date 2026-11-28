import {afterAll, expect, test} from 'bun:test';
import {readCompoundStreams, writeCompoundStreams} from '@bottleship/formats/msi';
import type {Process} from '../../src/worker/core/process';
import {Mem} from '../../src/worker/core/memory/mem-accessor';
import {System} from '../../src/worker/core/system';
import {ThunkGenerator} from '../../src/worker/core/thunking/thunk-generator';
import type {ThunkImplementation, X86Context} from '../../src/worker/core/thunking/thunk-dispatcher';
import {StructuredStorage} from '../../src/worker/modules/ole32-storage';
import {VirtualFileSystem} from '../../src/worker/runtime/filesystem/vfs';
import {installFakeOpfs} from './fixtures/fake-opfs';
import {preserveComVtableOwners, preserveMemBinding} from './helpers/scoped-process-state';

preserveMemBinding();
preserveComVtableOwners();

const navigatorBefore = globalThis.navigator;
afterAll(() => { Object.defineProperty(globalThis, 'navigator', {configurable: true, value: navigatorBefore}); });

test('compound files round-trip empty, mini FAT, FAT and extended DIFAT chains', () => {
    const sizes = [0, 63, 65, 4095, 4096, 8 * 1024 * 1024];
    const streams = new Map(sizes.map((size, i) => ['Stream' + i, new Uint8Array(size).fill(i + 1)]));
    const compound = writeCompoundStreams(streams);
    expect(compound.slice(0, 8)).toEqual(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    expect(new DataView(compound.buffer).getUint32(72, true)).toBeGreaterThan(0);
    expect(readCompoundStreams(compound, true)).toEqual(streams);
    expect(readCompoundStreams(writeCompoundStreams(new Map()), true).size).toBe(0);
    expect(() => writeCompoundStreams(new Map([['Stream', new Uint8Array()], ['STREAM', new Uint8Array()]]))).toThrow();
});

test('direct structured storage writes, commits, and reopens a Win32 compound save in fresh OPFS', async () => {
    installFakeOpfs();
    const system = System.getInstance();
    const previous = system.fileSystem;
    const mem = new Uint8Array(0x400000);
    const view = new DataView(mem.buffer);
    Mem.bind(() => mem, (a, n) => a >= 0 && a + n <= mem.length);
    const writeWide = (ptr: number, value: string) => {
        for (let i = 0; i < value.length; i++) view.setUint16(ptr + 2 * i, value.charCodeAt(i), true);
        view.setUint16(ptr + 2 * value.length, 0, true);
    };
    writeWide(0x90000, 'C:\\slot.sav');
    writeWide(0x90100, 'state');

    const handlers = new Map<string, Record<string, ThunkImplementation>>();
    const generator = new ThunkGenerator();
    generator.setBaseAddress(0x1000);
    let next = 0x100000;
    const alloc = (bytes: number) => { const address = next; next += Math.max(4, (bytes + 3) & ~3); return address; };
    const process = {
        memory: {alloc, allocAt: () => undefined, allocSystemBlock: alloc, freeSystemBlock: () => undefined},
        dispatcher: {
            registerModule: (name: string, methods: Record<string, ThunkImplementation>) => { handlers.set(name, methods); },
            applyPendingRegistrations: () => undefined,
        },
        thunkGenerator: generator,
        getCurrentMemory: () => mem,
    } as unknown as Process;
    const call = (iface: string, method: string, ...args: number[]) => handlers.get(iface)![method]!({} as X86Context, mem, args);
    const fromDisk = async () => {
        const vfs = new VirtualFileSystem();
        await vfs.initOverlay('test:structured-storage');
        await vfs.ensureOverlayIndex();
        return vfs;
    };

    try {
        system.fileSystem = await fromDisk();
        const storage = new StructuredStorage(process, alloc);
        expect(await storage.open(mem, [0x90000, 0x1012, 0, 0x90200], true)).toBe(0);
        const root = view.getUint32(0x90200, true);
        expect(await storage.open(mem, [0x90000, 0, 0x12, 0, 0, 0x90220], false)).toBe(0x80030020);
        expect(call('ole32-istorage', 'CreateStream', root, 0x90100, 0x1012, 0, 0, 0x90204)).toBe(0);
        const stream = view.getUint32(0x90204, true);
        mem.set([3, 7, 11], 0x90300);
        expect(call('ole32-istream', 'Write', stream, 0x90300, 3, 0x90208)).toBe(0);
        expect(view.getUint32(0x90208, true)).toBe(3);
        expect(call('ole32-istream', 'Seek', stream, 5, 0, 0, 0)).toBe(0);
        expect(call('ole32-istream', 'Write', stream, 0x90300, 1, 0)).toBe(0);
        expect(await call('ole32-istorage', 'Commit', root, 0)).toBe(0);
        await call('ole32-istream', 'Release', stream);
        await call('ole32-istorage', 'Release', root);
        expect(storage.hasOpenObjects).toBe(false);

        system.fileSystem = await fromDisk();
        writeWide(0x90100, 'STATE');
        const reopened = new StructuredStorage(process, alloc);
        expect(await reopened.open(mem, [0x90000, 0, 0x20, 0, 0, 0x90200], false)).toBe(0);
        const reloadedRoot = view.getUint32(0x90200, true);
        expect(await reopened.open(mem, [0x90000, 0, 0x20, 0, 0, 0x90220], false)).toBe(0);
        const secondReader = view.getUint32(0x90220, true);
        expect(await reopened.open(mem, [0x90000, 0, 0x12, 0, 0, 0x90224], false)).toBe(0x80030020);
        expect(call('ole32-istorage', 'OpenStream', reloadedRoot, 0x90100, 0, 0x10, 0, 0x90204)).toBe(0);
        const reloadedStream = view.getUint32(0x90204, true);
        expect(call('ole32-istream', 'Read', reloadedStream, 0x90300, 8, 0x90208)).toBe(1);
        expect(view.getUint32(0x90208, true)).toBe(6);
        expect([...mem.slice(0x90300, 0x90306)]).toEqual([3, 7, 11, 0, 0, 3]);
        await call('ole32-istream', 'Release', reloadedStream);
        await call('ole32-istorage', 'Release', reloadedRoot);
        expect(await reopened.open(mem, [0x90000, 0, 0x10, 0, 0, 0x90224], false)).toBe(0x80030020);
        await call('ole32-istorage', 'Release', secondReader);
        expect(await reopened.open(mem, [0x90000, 0, 0x12, 0, 0, 0x90224], false)).toBe(0);
        await call('ole32-istorage', 'Release', view.getUint32(0x90224, true));
        expect(reopened.hasOpenObjects).toBe(false);
    } finally {
        system.fileSystem = previous;
    }
});
