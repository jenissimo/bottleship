/**
 * Join after reap: a wait on a TERMINATED thread's handle must satisfy from the kernel
 * object's `terminated` flag, which outlives the scheduler record reaping deletes.
 *
 * The wait sites used to consult only the live scheduler record, so a join that arrived
 * after the reaper dropped the record never satisfied: NT signals the thread OBJECT at
 * termination, permanently, but ours answered "not signaled" for a thread whose kernel
 * object said terminated (Pirates! 2004: ThreadWrapper::Stop joins a worker that exited
 * seconds ago → the game's loader wedges mid-boot, nondeterministically with reap timing).
 */

import { expect, test } from 'bun:test';
import { SyncObjectManager } from '../../src/worker/core/scheduler/sync-objects';
import { ThreadState } from '../../src/worker/core/scheduler/types';
import { SystemResourceProvider } from '../../src/worker/core/resources/system-resource-provider';

test('a wait on a terminated thread handle satisfies after the record is reaped', () => {
    const rp = SystemResourceProvider.getInstance();
    const handle = rp.registerKernelObject({ kind: 'thread', threadId: 17, terminated: false, exitCode: null });
    const objs = new SyncObjectManager();
    const alive = () => ({ state: ThreadState.RUNNING });

    // Alive: not ready — both the record and the object agree.
    expect(objs.isSignaled(handle, 1, alive)).toBe(false);
    expect(objs.checkWait([handle], false, 1, alive).ready).toBe(false);
    expect(objs.checkWait([handle], true, 1, alive).ready).toBe(false);

    // Terminated: the object flag answers even while the record still exists.
    (rp.getKernelObject(handle) as { terminated: boolean }).terminated = true;
    expect(objs.isSignaled(handle, 1, alive)).toBe(true);
    expect(objs.checkWait([handle], false, 1, alive).ready).toBe(true);

    // Reaped — the scheduler record is gone (lookup returns null) — and STILL ready:
    // the kernel object is the durable record, exactly like the NT thread object.
    const reaped = () => null;
    expect(objs.isSignaled(handle, 1, reaped)).toBe(true);
    const any = objs.checkWait([handle], false, 1, reaped);
    expect(any.ready).toBe(true);
    expect(any.result).toBe(0 /* WAIT_OBJECT_0 */);
    expect(objs.checkWait([handle], true, 1, reaped).ready).toBe(true);
});
