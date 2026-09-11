import { afterEach, expect, test } from 'bun:test';
import { startGuestHostTool } from '../../src/worker/core/guest-host-tool';
import { stopChildProcesses, pendingChildHandoff } from '../../src/worker/core/child-process';
import type { HostToolResult } from '../../src/worker/core/host-tool-bridge';
import { VirtualFileSystem } from '../../src/worker/runtime/filesystem/vfs';
import { installFakeOpfs } from './fixtures/fake-opfs';

const request = { imagePath: 'C:\\fxc.exe', commandLine: '/Fo output.bin "input file.fx"', currentDirectory: 'C:\\' };
const result: HostToolResult = { exitCode: 7, stdout: '', stderr: '', outputs: [{ name: 'output.bin', bytes: Uint8Array.of(3, 1, 4) }] };
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
afterEach(() => {
    stopChildProcesses();
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
});

async function filesystem() {
    installFakeOpfs();
    const vfs = new VirtualFileSystem();
    await vfs.initOverlay('guest-host-tool-test');
    const input = (await vfs.open('C:\\input file.fx', 0x40000000, 2))!;
    await vfs.write(input, Uint8Array.of(9, 8));
    await vfs.flushAll();
    return vfs;
}

async function until(predicate: () => boolean) {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(predicate()).toBe(true);
}

test('host launch returns a pending task and completes only after output import and flush', async () => {
    const vfs = await filesystem();
    let release!: (result: HostToolResult) => void;
    let releaseFlush!: () => void;
    let invocation: unknown;
    const flush = vfs.flushAll.bind(vfs);
    vfs.flushAll = () => new Promise(resolve => { releaseFlush = () => { void flush().then(resolve); }; });
    const task = startGuestHostTool(vfs, request, (tool, args, files, signal) => {
        invocation = { tool, args, files, aborted: signal!.aborted };
        return new Promise(resolve => { release = resolve; });
    });
    expect(pendingChildHandoff()).toBe(task.record);
    expect(task.record.exitCode).toBeUndefined();
    await until(() => !!release);
    expect(invocation).toEqual({ tool: 'fxc', args: ['/Fo', 'output.bin', 'input file.fx'],
        files: [{ name: 'input file.fx', bytes: Uint8Array.of(9, 8) }], aborted: false });
    release(result);
    await until(() => !!releaseFlush);
    expect(task.record.exitCode).toBeUndefined();
    releaseFlush();
    expect(await task.completion).toBe(7);
    const output = (await vfs.open('C:\\output.bin', 0x80000000, 3))!;
    expect(await vfs.read(output, 3)).toEqual(Uint8Array.of(3, 1, 4));
    expect(pendingChildHandoff()).toBeNull();
});

test('termination aborts the host request and prevents a late response from writing guest files', async () => {
    const vfs = await filesystem();
    let signal!: AbortSignal;
    let release!: (result: HostToolResult) => void;
    const task = startGuestHostTool(vfs, request, (_tool, _args, _files, value) => {
        signal = value!;
        return new Promise(resolve => { release = resolve; });
    });
    await until(() => !!release);
    task.terminate(63);
    expect(signal.aborted).toBe(true);
    release(result);
    expect(await task.completion).toBe(63);
    expect(vfs.fileExists('C:\\output.bin')).toBe(false);
    expect(pendingChildHandoff()).toBeNull();
});

test('session cancellation during input I/O prevents the host launch', async () => {
    const vfs = await filesystem();
    let release!: () => void;
    vfs.read = () => new Promise(resolve => { release = () => resolve(Uint8Array.of(9, 8)); });
    let launched = false;
    const task = startGuestHostTool(vfs, request, async () => { launched = true; return result; });
    const rejected = task.completion.catch(e => e);
    await until(() => !!release);
    stopChildProcesses();
    release();
    expect(String(await rejected)).toContain('Parent session ended');
    expect(launched).toBe(false);
    expect(pendingChildHandoff()).toBeNull();
});

test('refused tool and failed output import remain explicit execution failures', async () => {
    const vfs = await filesystem();
    const refused = startGuestHostTool(vfs, request, async () => null);
    expect(String(await refused.completion.catch(e => e))).toContain('refused or unavailable');
    vfs.write = async () => 0;
    const failed = startGuestHostTool(vfs, request, async () => result);
    expect(String(await failed.completion.catch(e => e))).toContain('Short write');
    expect(failed.record.exitCode).toBeUndefined();
    expect(pendingChildHandoff()).toBe(failed.record);
});
