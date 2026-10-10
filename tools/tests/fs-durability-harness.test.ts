import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { ZipArchive } from '@bottleship/formats/zip';
import { System } from '../../src/worker/core/system';
import { VirtualFileSystem } from '../../src/worker/runtime/filesystem/vfs';
import { registerFsCommands } from '../../src/worker/harness/cmds/fs';
import { installFakeOpfs, findFakeByName, type FakeDirHandle } from './fixtures/fake-opfs';

const system = System.getInstance();
const originalVfs = system.fileSystem;
const originalNavigator = globalThis.navigator;
const handlers = new Map<string, (args: unknown[]) => any>();
const path = 'C:\\save.sav';
let vfs: VirtualFileSystem, root: FakeDirHandle;

beforeEach(async () => {
    root = installFakeOpfs();
    vfs = new VirtualFileSystem();
    vfs.mountRom(null as unknown as ZipArchive, 'rom', new Map());
    await vfs.initOverlay('test:durability');
    system.fileSystem = vfs;
    handlers.clear();
    registerFsCommands({ register: (name: string, handler: (args: unknown[]) => any) => handlers.set(name, handler) } as never);
});

afterEach(async () => {
    await vfs.flushAll();
    system.fileSystem = originalVfs;
    (globalThis as any).navigator = originalNavigator;
});

test('durability compares committed bytes rather than re-reading the authoritative cache', async () => {
    const handle = vfs.openSync(path, 0x40000000, 2)!;
    vfs.writeSync(handle, Uint8Array.of(74, 83, 65, 86, 3, 2, 1));
    const check = handlers.get('fsDurability')!;
    expect(await check([path])).toMatchObject({ matches: true, firstMismatch: -1, mismatches: 0 });
    findFakeByName(root, 'save.sav')!.data.fill(0, 0, 4);
    expect(await check([path])).toMatchObject({
        matches: false, firstMismatch: 0, mismatches: 4,
        guestPrefix: [74, 83, 65, 86, 3, 2, 1], committedPrefix: [0, 0, 0, 0, 3, 2, 1],
    });
});

test('write tracing captures the submitted offset and bytes before the file cursor advances', () => {
    const trace = handlers.get('fsTrace')!;
    trace(['start', { writes: true, path: '.sav' }]);
    const handle = vfs.openSync(path, 0x40000000, 2)!;
    const bytes = Uint8Array.of(74, 83, 65, 86);
    vfs.writeSync(handle, bytes);
    bytes.fill(0);
    const report = trace(['stop']);
    expect(report.entries.find((e: any) => e.op === 'writeSync')).toMatchObject({
        path, offset: 0, length: 4, written: 4, prefix: [74, 83, 65, 86],
    });
    expect(handle.position).toBe(4);
});
