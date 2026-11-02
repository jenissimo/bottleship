import { describe, expect, it } from 'bun:test';
import { ThunkDispatcher } from '../../src/worker/core/thunking/thunk-dispatcher';

const FAILURE = 0x80004005;
function fixture() {
    const d = new ThunkDispatcher({ add_listener() {} } as any, { getStubById: () => undefined } as any) as any;
    const ram = new WebAssembly.Memory({ initial: 1, maximum: 3 });
    let tid = 2, generation = 1, live = true;
    const restored: Array<{ tid: number; value: number; writes: unknown }> = [];
    const rejected: string[] = [];
    const scheduler = {
        getCurrentThreadId: () => tid,
        getCurrentThread: () => ({ id: tid, kernelPinCount: 0 }),
        wakeThreadForAsyncCompletion: () => true,
        markThreadRunningAfterAsyncWake() {},
        requestSwitchToThread() {},
        isThreadAsyncParked: () => true,
        validateAsyncRestoreTarget: (target: any) => ({ ok: live && target.asyncParkGeneration === generation, reason: 'stale-owner-lifetime' }),
        rejectAsyncRestore: (_tid: number, reason: string) => rejected.push(reason),
    };
    d.ensureScheduler = () => scheduler;
    d._callbackManager = { reset() {} };
    d.updateMemoryCache = () => { d.cachedMem8 = new Uint8Array(ram.buffer); };
    d.kickV86IfIdleForAsyncWake = () => {};
    // Record the single owner-safe restore, applying scalar output writes as the real restore does.
    d._restoreAsyncContext = (_info: unknown, _cpu: unknown, value: number, _cleanup: number, _name: string, writes: any[]) => {
        restored.push({ tid, value, writes });
        const view = new DataView(ram.buffer);
        for (const write of writes ?? []) view.setUint32(write.address, write.value, true);
    };
    const cpu = { instruction_pointer: [0x7000], reg32: [0, 0, 0, 0, 0x200] };
    const info = () => ({ epoch: d.asyncEpoch, functionId: 1, threadId: 1, asyncParkGeneration: 1, esp: 0x200, returnAddr: 0x401000, startTime: performance.now() });
    const queue = (resumeOnOwner: any, writes?: any[]) => {
        d._onAsyncComplete(Promise.resolve(), { value: FAILURE, resumeOnOwner, deferredWrites: writes }, info(), cpu, 0, 'OwnerContinuation', performance.now());
    };
    return { d, ram, cpu, restored, rejected, info, queue,
        setThread: (value: number) => { tid = value; },
        expireOwner: () => { live = false; generation++; },
        poll: () => d.tryApplyPendingAsyncRestoreAtSafePoint(cpu),
    };
}

describe('ThunkResult.resumeOnOwner', () => {
    it('waits for its owner, reacquires grown RAM, and applies a returned failure and outputs together', () => {
        const f = fixture();
        let calls = 0;
        const oldMemory = new Uint8Array(f.ram.buffer);
        f.queue((frame: any) => {
            calls++;
            expect(frame.esp).toBe(0x200);
            expect(frame.returnAddr).toBe(0x401000);
            expect(frame.mem.buffer).toBe(f.ram.buffer);
            expect(frame.mem.length).toBe(131072);
            expect(f.restored).toEqual([]);
            return { value: 0x80158100, deferredWrites: [{ address: 0x12000, size: 4, value: 96 }] };
        });
        expect(f.poll()).toBe(false);
        expect(calls).toBe(0);
        f.ram.grow(1);
        expect(oldMemory.byteLength).toBe(0);
        f.setThread(1);
        expect(f.poll()).toBe(true);
        expect(calls).toBe(1);
        expect(f.restored.map(r => [r.tid, r.value])).toEqual([[1, 0x80158100]]);
        expect(new DataView(f.ram.buffer).getUint32(0x12000, true)).toBe(96);
        expect(f.poll()).toBe(false);
        expect(calls).toBe(1);
    });

    it('does not invoke a terminated owner or a recycled park generation', () => {
        const f = fixture();
        let calls = 0;
        f.queue(() => { calls++; return 0; });
        f.expireOwner(); f.setThread(1);
        expect(f.poll()).toBe(false);
        expect(calls).toBe(0);
        expect(f.restored).toEqual([]);
        expect(f.rejected).toEqual(['stale-owner-lifetime']);
    });

    it('ignores Promise completion after reset even if thread numbers are reused', () => {
        const f = fixture();
        const oldInfo = f.info();
        let calls = 0;
        f.d.reset();
        f.d._onAsyncComplete(Promise.resolve(), { value: FAILURE, resumeOnOwner: () => { calls++; return 0; } },
            oldInfo, f.cpu, 0, 'stale', performance.now());
        f.setThread(1);
        expect(f.poll()).toBe(false);
        expect(calls).toBe(0);
        expect(f.d.pendingAsyncRestores).toEqual([]);
    });

    it('drops old output writes on throw and returns the explicit outer failure', () => {
        const f = fixture();
        f.queue(() => { throw new Error('allocation failed'); }, [{ address: 0x300, size: 4, value: 77 }]);
        f.setThread(1);
        expect(f.poll()).toBe(true);
        expect(f.restored.map(r => r.value)).toEqual([FAILURE]);
        expect(new DataView(f.ram.buffer).getUint32(0x300, true)).toBe(0);
        expect(f.restored[0].writes).toBeUndefined();
    });

    it('preserves the failure value and cleanup when a result accessor throws', () => {
        const f = fixture();
        f.queue(() => ({ value: 0, stackCleanup: 64, get deferredWrites() { throw new Error('late allocation failure'); } }));
        f.setThread(1);
        expect(f.poll()).toBe(true);
        expect(f.restored.map(r => r.value)).toEqual([FAILURE]);
        expect(f.restored[0].writes).toBeUndefined();
    });

    it('explicitly rejects an illegal owner switch instead of silently losing its completion', () => {
        const f = fixture();
        f.queue(() => { f.setThread(2); return 0; });
        f.setThread(1);
        expect(f.poll()).toBe(true);
        expect(f.restored).toEqual([]);
        expect(f.rejected).toEqual(['owner-changed-during-continuation']);
    });

    it('enforces synchronous results and rejects thenables without applying their outputs', () => {
        const f = fixture();
        f.queue(() => Promise.resolve({ value: 0 }));
        f.setThread(1);
        expect(f.poll()).toBe(true);
        expect(f.restored.map(r => r.value)).toEqual([FAILURE]);
    });

    it('does not restore old CPU state or remove a new completion when reset occurs inside the continuation', () => {
        const f = fixture();
        const replacement = { info: { ...f.info(), epoch: 1 }, completionName: 'replacement', returnValue: 4, cleanupBytes: 0 };
        f.queue(() => { f.d.reset(); f.d.pendingAsyncRestores.push(replacement); return 0; });
        f.setThread(1);
        expect(f.poll()).toBe(true);
        expect(f.restored).toEqual([]);
        expect(f.d.pendingAsyncRestores).toEqual([replacement]);
    });
});
