/**
 * A thread handle stays signaled after its thread exits, including once the scheduler has
 * reaped the Thread record. A program that waits for a worker thread it started long ago
 * otherwise blocks forever on a thread that finished.
 */
import { expect, test } from 'bun:test';
import { SystemResourceProvider } from '../../src/worker/core/resources/system-resource-provider';
import { SyncObjectManager } from '../../src/worker/core/scheduler/sync-objects';
import { ThreadState } from '../../src/worker/core/scheduler/types';

const WAIT_OBJECT_0 = 0;
const reaped = () => null;
const running = () => ({ state: ThreadState.RUNNING });

function threadHandle(terminated: boolean): number {
    return SystemResourceProvider.getInstance().registerKernelObject({ kind: 'thread', threadId: 2, terminated });
}

test('the handle of a reaped thread satisfies a wait', () => {
    const objs = new SyncObjectManager();
    const h = threadHandle(true);
    expect(objs.isSignaled(h, 1, reaped)).toBe(true);
    expect(objs.checkWait([h], false, 1, reaped)).toMatchObject({ ready: true, result: WAIT_OBJECT_0 });
    expect(objs.checkWait([h], true, 1, reaped).ready).toBe(true);
});

test('the handle of a running thread does not', () => {
    const objs = new SyncObjectManager();
    const h = threadHandle(false);
    expect(objs.isSignaled(h, 1, running)).toBe(false);
    expect(objs.checkWait([h], false, 1, running).ready).toBe(false);
    expect(objs.checkWait([h], true, 1, running).ready).toBe(false);
});
