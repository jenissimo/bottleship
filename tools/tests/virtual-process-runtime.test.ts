import { afterEach, expect, test } from 'bun:test';
import { VirtualProcessManager, VIRTUAL_CURRENT_PROCESS_ID } from '../../src/worker/modules/kernel32/process/virtual-process-manager';
import { SystemResourceProvider } from '../../src/worker/core/resources/system-resource-provider';

const resources = SystemResourceProvider.getInstance();
let manager = new VirtualProcessManager();
const handles = new Set<number>();
const track = (handle: number) => { handles.add(handle); return handle; };
function child() {
    const proc = manager.createProcess({ applicationName: 'C:\\child.exe', commandLine: '',
        currentDirectory: 'C:\\', creationFlags: 0, runtimeBacked: true });
    track(proc.processHandle); track(proc.threadHandle);
    // The manager also owns an implicit current-process handle.
    const table = (manager as unknown as { processesByHandle: Map<number, unknown> }).processesByHandle;
    for (const handle of table.keys()) track(handle);
    return proc;
}
const signalled = (handle: number) => resources.getKernelObject(handle)?.signaled;

afterEach(() => {
    manager.reset();
    for (const handle of handles) resources.unregisterKernelObject(handle);
    handles.clear();
    manager = new VirtualProcessManager();
});

test('runtime exit signals duplicate and reopened handles after both originals close', () => {
    const proc = child();
    const runtime = { terminate() {}, cancel() {} };
    const complete = manager.bindRuntime(proc.processId, runtime);
    const processAlias = track(manager.duplicateHandle(proc.processHandle)!);
    const threadAlias = track(manager.duplicateHandle(proc.threadHandle)!);
    resources.unregisterKernelObject(proc.processHandle);
    resources.unregisterKernelObject(proc.threadHandle);
    const reopened = track(manager.openProcessById(proc.processId));
    complete(37);
    for (const handle of [processAlias, reopened]) {
        expect(manager.getExitCodeProcess(handle)).toBe(37);
        expect(signalled(handle)).toBe(true);
    }
    expect(manager.getExitCodeThread(threadAlias)).toBe(37);
    expect(signalled(threadAlias)).toBe(true);
    expect(manager.listProcessSnapshotEntries().map(p => p.pid)).toEqual([VIRTUAL_CURRENT_PROCESS_ID]);
    expect(manager.listThreadSnapshotEntries()).toEqual([]);
});

test('TerminateProcess reaches the runtime and signals only on its durable completion', () => {
    const proc = child();
    const codes: number[] = [];
    const complete = manager.bindRuntime(proc.processId, { terminate(code) { codes.push(code); }, cancel() {} });
    const alias = track(manager.duplicateHandle(proc.processHandle)!);
    resources.unregisterKernelObject(proc.processHandle);
    expect(manager.terminateProcess(alias, 83)).toBe(true);
    expect(codes).toEqual([83]);
    expect(manager.getExitCodeProcess(alias)).toBe(259);
    expect(signalled(alias)).toBe(false);
    complete(83);
    expect(manager.getExitCodeProcess(alias)).toBe(83);
    expect(manager.getExitCodeThread(proc.threadHandle)).toBe(83);
});

test('TerminateThread reaches the single primary child runtime through an alias', () => {
    const proc = child();
    let code: number | undefined;
    const complete = manager.bindRuntime(proc.processId, { terminate(value) { code = value; }, cancel() {} });
    const alias = track(manager.duplicateHandle(proc.threadHandle)!);
    resources.unregisterKernelObject(proc.threadHandle);
    expect(manager.terminateThread(alias, 53)).toBe(true);
    expect(code).toBe(53);
    expect(manager.getExitCodeThread(alias)).toBe(259);
    complete(53);
    expect(signalled(alias)).toBe(true);
    expect(manager.getExitCodeProcess(proc.processHandle)).toBe(53);
});

test('reset cancels the child and old completion cannot finish a reused PID', () => {
    const old = child();
    let cancelled = 0;
    const runtime = { terminate() {}, cancel() { cancelled++; } };
    const completeOld = manager.bindRuntime(old.processId, runtime);
    manager.reset();
    expect(cancelled).toBe(1);
    const next = child();
    expect(next.processId).toBe(old.processId);
    expect(manager.isRuntimeCurrent(next.processId, runtime)).toBe(false);
    completeOld(99);
    expect(manager.getExitCodeProcess(next.processHandle)).toBe(259);
    expect(signalled(next.processHandle)).toBe(false);
});

test('runtime-backed process stays active beyond the fake child auto-exit timer', async () => {
    const proc = child();
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(manager.getExitCodeProcess(proc.processHandle)).toBe(259);
    expect(manager.getExitCodeThread(proc.threadHandle)).toBe(259);
    expect(signalled(proc.processHandle)).toBe(false);
});
