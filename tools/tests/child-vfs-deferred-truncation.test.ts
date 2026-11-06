import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CHILD_IO_BYTES, createChildVfsServer } from '../../src/worker/core/child-vfs';
import { VirtualFileSystem } from '../../src/worker/runtime/filesystem/vfs';
import { installFakeOpfs } from './fixtures/fake-opfs';

// UE2's render probe child (HP Chamber of Secrets) truncates Game.ini with CREATE_ALWAYS at
// exit and writes it in the next round trip, while the parent polls for Detected.ini. The
// parent read Game.ini in between, got 0 bytes, saved its empty config over the file and
// failed to start ("Can't find 'ini:Engine.Engine.GameEngine'").

const READ = 0x80000000, WRITE = 0x40000000;
const OPEN_EXISTING = 3, CREATE_ALWAYS = 2, TRUNCATE_EXISTING = 5;
const INI = 'C:\\My Documents\\Game.ini';
const OLD = new TextEncoder().encode('[Engine.Engine]\r\nGameEngine=Engine.GameEngine\r\n');

let vfs: VirtualFileSystem, oldNavigator: unknown, seq = 0;
let serve: ReturnType<typeof createChildVfsServer>, buffer: SharedArrayBuffer;

/** One child request, answered through the mailbox exactly as the child worker reads it. */
async function invoke(method: string, ...args: unknown[]): Promise<{ value?: any; error?: string }> {
    await serve({ method, args });
    const length = Atomics.load(new Int32Array(buffer), 1);
    return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, length).slice()));
}

/** What another process (the parent) reads from the file right now. */
async function parentReads(path = INI): Promise<number[] | null> {
    const handle = vfs.openSync(path, READ, OPEN_EXISTING);
    if (!handle) return null;
    return [...await vfs.read(handle, 4096)];
}

beforeEach(async () => {
    oldNavigator = globalThis.navigator;
    installFakeOpfs();
    vfs = new VirtualFileSystem();
    await vfs.initOverlay(`test:child-truncate-${++seq}`);
    vfs.createDirectorySync('C:\\My Documents');
    const h = vfs.openSync(INI, WRITE, CREATE_ALWAYS)!;
    vfs.writeSync(h, OLD);
    buffer = new SharedArrayBuffer(CHILD_IO_BYTES);
    serve = createChildVfsServer(vfs, buffer);
});

afterEach(async () => {
    await vfs.flushAll();
    (globalThis as any).navigator = oldNavigator;
});

describe('a child truncating a file that has contents', () => {
    test('the parent sees the old contents until the child writes, then only the new ones', async () => {
        const child = (await invoke('openSync', INI, WRITE, CREATE_ALWAYS)).value;
        expect(child.childHandle).toBeGreaterThan(0);
        expect(await parentReads()).toEqual([...OLD]);
        expect(vfs.getFileSize(INI)).toBe(OLD.length);

        expect((await invoke('write', child, Uint8Array.from([0x5b, 0x41, 0x5d]))).value).toBe(3);
        expect(await parentReads()).toEqual([0x5b, 0x41, 0x5d]);
        expect((await invoke('tell', child)).value).toBe(3);
    });

    test('the child itself sees an empty file all along', async () => {
        const child = (await invoke('openSync', INI, READ | WRITE, CREATE_ALWAYS)).value;
        expect((await invoke('getFileSize', INI)).value).toBe(0);
        expect((await invoke('fileExists', INI)).value).toBe(true);
        expect((await invoke('tell', child)).value).toBe(0);
        expect((await invoke('readSync', child, 16)).value.childBytes).toEqual([]);
        expect((await invoke('setPosition', child, 5, 1)).value).toBe(5);
        expect((await invoke('setPosition', child, 2, 2)).value).toBe(2);
        expect((await invoke('setPosition', child, -9, 1)).value).toBe(0);
        expect(await parentReads()).toEqual([...OLD]);
    });

    test('a seek before the first write carries over to the published file', async () => {
        const child = (await invoke('openSync', INI, WRITE, CREATE_ALWAYS)).value;
        await invoke('setPosition', child, 2, 0);
        await invoke('write', child, Uint8Array.from([7, 8]));
        expect(await parentReads()).toEqual([0, 0, 7, 8]);
    });

    test('TRUNCATE_EXISTING waits the same way', async () => {
        const child = (await invoke('open', INI, WRITE, TRUNCATE_EXISTING)).value;
        expect(await parentReads()).toEqual([...OLD]);
        await invoke('writeSync', child, Uint8Array.from([1]));
        expect(await parentReads()).toEqual([1]);
    });

    test('a file the child never writes is truncated when the child exits', async () => {
        await invoke('openSync', INI, WRITE, CREATE_ALWAYS);
        expect(await parentReads()).toEqual([...OLD]);
        await serve.close();
        expect(await parentReads()).toEqual([]);
    });

    test('another child operation on the path publishes the truncation first', async () => {
        await invoke('openSync', INI, WRITE, CREATE_ALWAYS);
        const reopened = (await invoke('openSync', INI, READ, OPEN_EXISTING)).value;
        expect(await parentReads()).toEqual([]);
        expect((await invoke('readSync', reopened, 16)).value.childBytes).toEqual([]);
    });

    test('a missing or empty file is created at once, as before', async () => {
        const fresh = 'C:\\My Documents\\Detected.ini';
        await invoke('openSync', fresh, WRITE, CREATE_ALWAYS);
        expect(vfs.fileExists(fresh)).toBe(true);
        expect(await parentReads(fresh)).toEqual([]);
    });
});
