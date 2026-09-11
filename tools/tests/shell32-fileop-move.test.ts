import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { VirtualFileSystem } from '../../src/worker/runtime/filesystem/vfs';
import { FO_MOVE, FO_RENAME, FOF_NORECURSION, performShFileOperation } from '../../src/worker/modules/shell32-fileop';
import { installFakeOpfs } from './fixtures/fake-opfs';

let vfs: VirtualFileSystem;
let previousVfs: VirtualFileSystem;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const bytes = Uint8Array.of(1, 2, 3);

beforeEach(async () => {
    installFakeOpfs();
    vfs = new VirtualFileSystem();
    await vfs.initOverlay('shell32-move-test');
    previousVfs = System.getInstance().fileSystem;
    System.getInstance().fileSystem = vfs;
});

afterEach(async () => {
    await vfs.flushAll();
    System.getInstance().fileSystem = previousVfs;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
});

async function seed(path: string): Promise<void> {
    vfs.ensureParentDirsSync(path);
    const handle = (await vfs.open(path, 0x40000000, 2))!;
    await vfs.write(handle, bytes);
}

async function contents(path: string): Promise<Uint8Array> {
    const handle = await vfs.open(path, 0x80000000, 3);
    expect(handle).not.toBeNull();
    return vfs.read(handle!, bytes.length);
}

for (const wFunc of [FO_MOVE, FO_RENAME]) {
    test(`operation ${wFunc} without recursion preserves skipped subdirectories`, async () => {
        await seed('C:\\src\\top.dat');
        await seed('C:\\src\\nested\\save.dat');
        vfs.ensureDirTreeSync('C:\\src\\empty');

        expect(await performShFileOperation({ wFunc, from: ['C:\\src'], to: ['C:\\dst'], flags: FOF_NORECURSION }))
            .toEqual({ result: 0, aborted: false, filesTouched: 1 });
        expect(await contents('C:\\dst\\top.dat')).toEqual(bytes);
        expect(vfs.fileExists('C:\\src\\top.dat')).toBe(false);
        expect(await contents('C:\\src\\nested\\save.dat')).toEqual(bytes);
        expect(vfs.directoryExists('C:\\src\\empty')).toBe(true);
        expect(vfs.directoryExists('C:\\dst\\nested')).toBe(false);
    });
}

test('a nonrecursive move removes the source directory when no children were skipped', async () => {
    await seed('C:\\src\\top.dat');
    expect((await performShFileOperation({ wFunc: FO_MOVE, from: ['C:\\src'], to: ['C:\\dst'], flags: FOF_NORECURSION })).result).toBe(0);
    expect(await contents('C:\\dst\\top.dat')).toEqual(bytes);
    expect(vfs.directoryExists('C:\\src')).toBe(false);
});

test('a recursive move transfers nested files and removes the source tree', async () => {
    await seed('C:\\src\\nested\\save.dat');
    expect((await performShFileOperation({ wFunc: FO_MOVE, from: ['C:\\src'], to: ['C:\\dst'], flags: 0 })).result).toBe(0);
    expect(await contents('C:\\dst\\nested\\save.dat')).toEqual(bytes);
    expect(vfs.directoryExists('C:\\src')).toBe(false);
});
