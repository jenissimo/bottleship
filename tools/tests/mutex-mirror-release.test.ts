import { afterEach, beforeEach, expect, test } from 'bun:test';
import { hypercallDataManager } from '../../src/worker/core/cpu/hypercall-data';
import { eventSlotForKernelHandle, packMutexMirrorWord } from '../../src/worker/core/cpu/hypercall-event-mirror';
import { SyncObjectManager } from '../../src/worker/core/scheduler/sync-objects';
import { ThreadState } from '../../src/worker/core/scheduler/types';

/**
 * A contended ReleaseMutex from a NESTED hold must leave the releasing thread the owner.
 *
 * The WASM tier takes and drops an uncontended mutex without JS seeing it, so the JS
 * KernelMutexObject's owner is whoever JS last granted it to. Writing that stale owner back
 * on a partial release (rec 2 -> 1) handed the mutex to a thread that had released it long
 * ago; that thread's next wait then stacked a second count on it, it released one, and the
 * real owner's next release was refused — a permanent deadlock (NFSU2 audio lock, triggered
 * by the window losing and regaining focus).
 */

const GUEST_BASE = 0x8000;
const MIRROR = 0x4000;
const HP_BASE = 0x1000;
const T_MAIN = 1;
const T_AUDIO = 8;

const m: any = hypercallDataManager;
const saved: Record<string, unknown> = {};
let buffer: ArrayBuffer;

beforeEach(() => {
    for (const k of ['cpu', 'wasmMemory', 'view', 'hpBase', 'initialized', 'mutexMirrorAddr']) saved[k] = m[k];
    buffer = new ArrayBuffer(0x20000);
    m.cpu = { wasm_memory: { buffer }, mem8: new Uint8Array(buffer, GUEST_BASE) };
    m.wasmMemory = buffer;
    m.view = new DataView(buffer);
    m.hpBase = HP_BASE;
    m.initialized = true;
    m.mutexMirrorAddr = MIRROR;
});

afterEach(() => {
    for (const [k, v] of Object.entries(saved)) m[k] = v;
});

/** What the WASM fast path does: rewrite the live word in guest RAM, nothing else. */
function wasmWrite(handle: number, owner: number, rec: number, hasWaiters = false): void {
    const slot = eventSlotForKernelHandle(handle)!;
    new Uint32Array(buffer)[(GUEST_BASE + MIRROR) / 4 + slot] = packMutexMirrorWord(owner, rec, true, hasWaiters);
}

const lookup = () => ({ state: ThreadState.RUNNING });

test('a contended partial release keeps the owner the fast path recorded', () => {
    const objs = new SyncObjectManager();
    const h = objs.createMutex(false, 0);

    // JS last handled a grant to the audio thread (a contended acquire)...
    const grant = objs.checkWait([h], false, T_AUDIO, lookup);
    expect(grant.ready).toBe(true);
    objs.consumeWait(grant, T_AUDIO);
    // ...which it then released uncontended, in WASM.
    wasmWrite(h, 0, 0);

    // The main thread takes it twice in WASM; the audio thread then waits on it.
    wasmWrite(h, T_MAIN, 2, true);
    expect(objs.checkWait([h], false, T_AUDIO, lookup).ready).toBe(false);

    // The waiter makes the release contended, so JS handles it.
    expect(objs.releaseMutex(h, T_MAIN)).toBe(true);
    const after = hypercallDataManager.readMutexMirrorState(h)!;
    expect(after.owner).toBe(T_MAIN);
    expect(after.recursion).toBe(1);
    expect(objs.checkWait([h], false, T_AUDIO, lookup).ready).toBe(false);

    // The outer release frees it, and only then is the waiter satisfiable.
    expect(objs.releaseMutex(h, T_MAIN)).toBe(true);
    expect(hypercallDataManager.readMutexMirrorState(h)!.owner).toBeNull();
    expect(objs.checkWait([h], false, T_AUDIO, lookup).ready).toBe(true);
});
