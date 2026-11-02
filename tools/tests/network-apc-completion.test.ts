import { describe, expect, test } from 'bun:test';
import { Scheduler } from '../../src/worker/core/scheduler/scheduler';
import { createInitialContext } from '../../src/worker/core/scheduler/scheduler-context';
import { ApcKind, ThreadState, WaitReason, WAIT_IO_COMPLETION, type Thread } from '../../src/worker/core/scheduler/types';
import { dispatchThreadApcs } from '../../src/worker/core/scheduler/apc-dispatch';
import { ThunkGenerator } from '../../src/worker/core/thunking/thunk-generator';
import { Process } from '../../src/worker/core/process';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { AddressSpace } from '../../src/worker/core/memory/address-space';
import { hypercallDataManager } from '../../src/worker/core/cpu/hypercall-data';

function setup(alertable: boolean, suspended = false) {
    const ram = new Uint8Array(8 << 20);
    Mem.bind(() => ram);
    const s = new Scheduler();
    const t = {
        id: 2, handle: 0x1002, state: ThreadState.WAITING,
        context: createInitialContext(0x401000, 0x280000),
        stackBase: 0x200000, stackTop: 0x300000, stackSize: 0x100000,
        waitInfo: { reason: WaitReason.SLEEP, handles: [], waitAll: false, timeoutTimerId: 0, alertable, csAddress: 0 },
        suspendCount: suspended ? 1 : 0, apcQueue: [], lastError: 0, tebAddress: 0, kernelPinCount: 0,
    } as unknown as Thread;
    const handlers = new Map<string, Function>();
    const generator = new ThunkGenerator();
    generator.setBaseAddress(0x500000);
    (s as any).process = { resetGeneration: 0, thunkGenerator: generator, getCurrentMemory: () => ram,
        addressSpace: { validateRange: (address: number, size: number) => address >= 0 && address + size <= ram.length },
        dispatcher: { callbackManager: {}, register: (_dll: string, name: string, fn: Function) => handlers.set(name, fn) } };
    (s as any).threads.set(t.id, t);
    return { s, t, ram, handlers };
}
describe('network asynchronous completion and owner APC', () => {
    test('blocking and async parks preserve the WASM last error across another thread completion', () => {
        const { s, t } = setup(true);
        const oldReady = hypercallDataManager.isInitialized, oldRead = hypercallDataManager.readLastError;
        const oldSync = hypercallDataManager.syncThreadData;
        let liveError = 0x2468;
        hypercallDataManager.isInitialized = () => true;
        hypercallDataManager.readLastError = () => liveError;
        hypercallDataManager.syncThreadData = (_id, error) => { liveError = error; };
        try {
            t.state = ThreadState.RUNNING; t.lastError = 997;
            (s as any).currentThreadId = t.id;
            expect(s.getLastError()).toBe(0x2468);
            expect((s as any).transitionTo(t, ThreadState.WAITING, t.waitInfo, t.context).success).toBe(true);
            expect(t.lastError).toBe(0x2468);
            liveError = 995; expect(s.getLastError()).toBe(0x2468);
            const other = { ...t, id: 3, state: ThreadState.READY, lastError: 995 } as Thread;
            (s as any).threads.set(other.id, other);
            (s as any).transitionTo(other, ThreadState.RUNNING, null, null);
            expect(liveError).toBe(995);
            (s as any).transitionTo(other, ThreadState.WAITING, t.waitInfo, t.context);
            (s as any).transitionTo(t, ThreadState.READY, null, t.context);
            (s as any).transitionTo(t, ThreadState.RUNNING, null, null);
            expect(liveError).toBe(0x2468); expect(other.lastError).toBe(995);
        } finally {
            hypercallDataManager.isInitialized = oldReady; hypercallDataManager.readLastError = oldRead;
            hypercallDataManager.syncThreadData = oldSync;
        }
    });
    test('late Winsock APC readies the alertable owner without touching a foreign CPU', () => {
        const { s, t, ram } = setup(true);
        expect(s.queueWsaCompletionApc(t.id, 0x402000, 0, 7, 0x410000, 0x20)).toBe(true);
        expect(t.state).toBe(ThreadState.READY);
        expect(t.context?.eip).toBe(0x500010);
        expect(t.context?.esp).toBe(0x27fffc);
        expect(t.context?.eax).toBe(WAIT_IO_COMPLETION);
        expect(new DataView(ram.buffer).getUint32(0x27fffc, true)).toBe(0x401000);
        expect(t.apcQueue[0]).toMatchObject({ kind: ApcKind.WSA_COMPLETION, arg3: 0x20 });
    });
    test('nonalertable owner stays parked; suspended alertable owner is readied only on ResumeThread', () => {
        for (const suspended of [false, true]) {
            const { s, t } = setup(suspended, suspended);
            s.queueWsaCompletionApc(t.id, 0x402000, 0, 1, 0x410000, 0);
            expect(t.state).toBe(suspended ? ThreadState.SUSPENDED : ThreadState.WAITING);
            expect(t.apcQueue).toHaveLength(1);
        }
    });
    test('APC callback has four arguments, drains on the owner, and retains the wait return', () => {
        const { s, t } = setup(true);
        s.queueWsaCompletionApc(t.id, 0x402000, 0, 7, 0x410000, 0x20);
        (s as any).currentThreadId = t.id;
        const calls: unknown[][] = [];
        let finish: Function | undefined;
        const manager = {
            saveSuspendedThunkContext: () => 9,
            invokeCallback: (...args: unknown[]) => { calls.push(args); finish = args[3] as Function; return { callbackId: 11 }; },
        };
        const result = dispatchThreadApcs(s, manager as any, { esp: 0x27fffc } as any, 'test', 0, () => 123);
        expect(result?.suspendedForCallback).toBe(true);
        expect(calls[0].slice(0, 3)).toEqual([0x402000, [0, 7, 0x410000, 0x20], 16]);
        expect(finish?.()).toBe(123);
        expect(t.apcQueue).toHaveLength(0);
    });
    test('owned APC storage is prepared only on the owner and released after guest return', () => {
        const {s,t}=setup(true);const calls:string[]=[];let complete:Function|undefined;
        s.queueWsaCompletionApc(t.id,0x402000,0,7,0x410000,0,{prepare(args){calls.push('prepare');return [args[0],0,0x420000,args[3]];},onReturn(){calls.push('return');},onDiscard(){calls.push('discard');}});
        expect(calls).toEqual([]);(s as any).currentThreadId=t.id;
        const manager={saveSuspendedThunkContext:()=>9,invokeCallback:(_routine:number,args:number[],_cleanup:number,finish:Function)=>{expect(args).toEqual([0,0,0x420000,0]);complete=finish;return{callbackId:12};}};
        dispatchThreadApcs(s,manager as any,{} as any,'owned',0);
        expect(calls).toEqual(['prepare']);complete!();expect(calls).toEqual(['prepare','return']);complete!();expect(calls).toEqual(['prepare','return']);
    });
    test('queued and active owned APCs are discarded on thread termination and callback startup failure', () => {
        for(const mode of ['queued','active','throw','zero','stale']as const){
            const {s,t}=setup(true);let released=0;
            s.queueWsaCompletionApc(t.id,0x402000,0,0,0x410000,0,{prepare(){return mode==='stale'?null:[0,0,0x420000,0];},onDiscard(){released++;}});
            if(mode!=='queued'){
                (s as any).currentThreadId=t.id;
                const manager={saveSuspendedThunkContext:()=>9,abandonSuspendedFrame:()=>true,invokeCallback:()=>{if(mode==='throw')throw Error('start');return{callbackId:mode==='zero'?0:12};}};
                if(mode==='throw')expect(()=>dispatchThreadApcs(s,manager as any,{}as any,'owned',0)).toThrow('start');
                else dispatchThreadApcs(s,manager as any,{}as any,'owned',0);
            }
            if(mode==='queued'||mode==='active'){(s as any).currentThreadId=null;(s as any).terminateThread(t.id,0);}
            expect(released).toBe(1);(s as any).discardThreadApcs(t);expect(released).toBe(1);
        }
        const {s}=setup(true);let rejected=0;
        expect(s.queueWsaCompletionApc(999,0x402000,0,0,0,0,{onDiscard(){rejected++;}})).toBe(false);expect(rejected).toBe(1);
    });
    test('completion copies descriptors, writes before signalling and survives RAM replacement', async () => {
        let ram = new Uint8Array(64);
        Mem.bind(() => ram);
        const process = { resetGeneration: 0,
            addressSpace: {
                validateRange: (address: number, size: number) => address > 0 && address + size <= ram.length,
                write: (address: number, bytes: Uint8Array) => { ram.set(bytes, address); return bytes.length; },
            } };
        const writes = [{ address: 8, size: 4 as const, value: 77 }];
        let observed = 0;
        Process.prototype.enqueueCompletion.call(process, writes, published => {
            expect(published).toBe(true); observed = Mem.readUint32(8)!;
        });
        writes[0].value = 88;
        ram = new Uint8Array(128);
        expect(observed).toBe(0);
        await Promise.resolve();
        expect(observed).toBe(77);
    });
    test('a completion writes the issuing Process even when Mem is bound to another one', async () => {
        const owner = new Uint8Array(64), foreign = new Uint8Array(64);
        Mem.bind(() => foreign);
        const addressSpace = new AddressSpace(() => owner);
        addressSpace.initializeLayout(owner.length);
        const process = { resetGeneration: 0, addressSpace };
        let signalled = false;
        Process.prototype.enqueueCompletion.call(process, [{ address: 8, size: 4, value: 0x12345678 }],
            ok => signalled = ok);
        await Promise.resolve();
        expect(signalled).toBe(true);
        expect(new DataView(owner.buffer).getUint32(8, true)).toBe(0x12345678);
        expect(Mem.readUint32(8)).toBe(0);
    });
    test('bad pointer publishes no partial writes; reset drops stale signals', async () => {
        const ram = new Uint8Array(32); Mem.bind(() => ram);
        const process = { resetGeneration: 0,
            addressSpace: {
                validateRange: (address: number, size: number) => address > 0 && address + size <= ram.length,
                write: (address: number, bytes: Uint8Array) => { ram.set(bytes, address); return bytes.length; },
            } };
        let published: boolean | undefined, stale = false;
        Process.prototype.enqueueCompletion.call(process,
            [{ address: 8, size: 4, value: 77 }, { address: 31, size: 4, value: 99 }], ok => published = ok);
        await Promise.resolve();
        expect(published).toBe(false); expect(Mem.readUint32(8)).toBe(0);
        Process.prototype.enqueueCompletion.call(process, [{ address: 8, size: 4, value: 22 }], () => stale = true);
        process.resetGeneration++;
        await Promise.resolve();
        expect(stale).toBe(false); expect(Mem.readUint32(8)).toBe(0);
    });
});
