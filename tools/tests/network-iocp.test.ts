import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { exports as sync, captureFileIoCompletion, postFileIoCompletion, resetIoCompletionWaiters, resetSyncState, abandonIoCompletionWaiters } from '../../src/worker/modules/kernel32/sync';
import type { ThunkResult, X86Context } from '../../src/worker/core/thunking/thunk-dispatcher';
import { Process } from '../../src/worker/core/process';

const system = System.getInstance(), scheduler = system.scheduler, resources = system.resourceProvider;
const savedProcess = system.process, savedId = scheduler.getCurrentThreadId;
const savedError = scheduler.setLastError, savedOwnerError = scheduler.setLastErrorForThread;
let ram: Uint8Array, owner: Process, current: number, errors: Array<[number, number]>, handles: number[];
const context = {} as X86Context;
function invoke(name: string, args: number[]) { return sync[name](context, ram, args); }
function port() {
    const file = resources.registerFileHandle({});
    const handle = invoke('CreateIoCompletionPort', [file, 0, 0x1234, 0]) as number;
    handles.push(file, handle);
    return { file, handle };
}
beforeEach(() => {
    resetSyncState(); handles = []; errors = []; current = 7;
    ram = new Uint8Array(4096); Mem.bind(() => ram);
    owner = Object.create(Process.prototype) as Process; (owner as any).resetGeneration = 0;
    (owner as any).getMemory = () => ram;
    (owner as any).addressSpace = {
        validateRange: (address: number, length: number) => address > 0 && address + length <= ram.length,
        write: (address: number, bytes: Uint8Array) => { if (address < 1 || address + bytes.length > ram.length) return 0; ram.set(bytes, address); return bytes.length; },
    };
    system.process = owner;
    scheduler.getCurrentThreadId = () => current;
    scheduler.setLastError = code => { errors.push([current, code]); };
    scheduler.setLastErrorForThread = (id, code) => { errors.push([id, code]); };
});
afterEach(() => {
    resetSyncState();
    for (const handle of handles) {
        if (resources.getFileHandle(handle)) resources.unregisterFileHandle(handle);
        else resources.unregisterKernelObject(handle);
    }
    system.process = savedProcess; scheduler.getCurrentThreadId = savedId;
    scheduler.setLastError = savedError; scheduler.setLastErrorForThread = savedOwnerError;
});
test('successful queued and parked IOCP dequeues preserve the issuing thread error',async()=>{
    const {file,handle}=port();
    scheduler.setLastError(0x4567);errors=[];
    postFileIoCompletion(file,3,0x180);
    expect((invoke('GetQueuedCompletionStatus',[handle,8,12,16,0]) as ThunkResult).value).toBe(1);
    expect(errors).toEqual([]);
    const waiting=invoke('GetQueuedCompletionStatus',[handle,8,12,16,1000]) as Promise<ThunkResult>;
    expect(waiting).toBeInstanceOf(Promise);current=11;errors=[];
    postFileIoCompletion(file,4,0x184);
    expect((await waiting).value).toBe(1);expect(errors).toEqual([]);
});
test('failed I/O dequeues its original packet with FALSE and completion error', () => {
    const { file, handle } = port();
    expect(postFileIoCompletion(file, 3, 0x180, 995)).toBe(true);
    const result = invoke('GetQueuedCompletionStatus', [handle, 8, 12, 16, 0]) as ThunkResult;
    expect(result.value).toBe(0);
    expect(result.deferredWrites).toBeUndefined();
    expect([Mem.readUint32(8), Mem.readUint32(12), Mem.readUint32(16)]).toEqual([3, 0x1234, 0x180]);
    expect(errors).toEqual([[7, 995]]);
});
test('parked dequeue publishes error to the issuing thread while a foreign thread owns CPU', async () => {
    const { file, handle } = port();
    const waiting = invoke('GetQueuedCompletionStatus', [handle, 8, 12, 16, 1000]) as Promise<ThunkResult>;
    expect(waiting).toBeInstanceOf(Promise);
    current = 11;
    ram = new Uint8Array(8192);
    expect(postFileIoCompletion(file, 0, 0x180, 995)).toBe(true);
    const result = await waiting;
    expect(result.value).toBe(0); expect(errors).toEqual([[7, 995]]);
    expect(Mem.readUint32(16)).toBe(0);
    expect(result.deferredWrites?.[2].value).toBe(0x180);
});
test('closed port wakes a waiter with abandonment, and reset cannot corrupt a new thread error', async () => {
    const { handle } = port();
    let waiting = invoke('GetQueuedCompletionStatus', [handle, 8, 12, 16, 1000]) as Promise<ThunkResult>;
    current = 11; abandonIoCompletionWaiters(handle);
    expect((await waiting).value).toBe(0); expect(errors).toEqual([[7, 735]]);
    errors = []; current = 7;
    waiting = invoke('GetQueuedCompletionStatus', [handle, 8, 12, 16, 1000]) as Promise<ThunkResult>;
    owner.resetGeneration++; current = 11; resetIoCompletionWaiters();
    await waiting; expect(errors).toEqual([]);
});
test('queued dequeue publishes IOSB before notifying other result waiters', () => {
    const {file,handle}=port();let notices=0;
    const publication={deferredWrites:[{address:0x180,value:0,size:4 as const},{address:0x184,value:3,size:4 as const}],
        isCurrent:()=>true,didPublish:()=>{expect(Mem.readUint32(0x184)).toBe(3);expect(Mem.readUint32(0x180)).toBe(0);notices++;}};
    Mem.writeUint32(0x180,259);postFileIoCompletion(file,3,0x180,0,publication);
    expect((invoke('GetQueuedCompletionStatus',[handle,8,12,16,0]) as ThunkResult).value).toBe(1);
    expect(notices).toBe(1);
});
test('parked dequeue publishes only in fresh owner RAM before waking result waiters', async () => {
    const {file,handle}=port();let notices=0;
    Mem.writeUint32(0x180,259);
    const waiting=invoke('GetQueuedCompletionStatus',[handle,8,12,16,1000]) as Promise<ThunkResult>;
    current=11;const foreign=new Uint8Array(8192);Mem.bind(()=>foreign);
    postFileIoCompletion(file,3,0x180,0,{deferredWrites:[{address:0x180,value:0,size:4},{address:0x184,value:3,size:4}],
        isCurrent:()=>true,didPublish:()=>{expect(new DataView(ram.buffer).getUint32(0x184,true)).toBe(3);expect(new DataView(ram.buffer).getUint32(0x180,true)).toBe(0);notices++;}});
    const result=await waiting;
    expect(result.value).toBe(1);expect(notices).toBe(1);
    expect(foreign[0x184]).toBe(0);
    expect(result.deferredWrites?.map(write=>write.address)).toEqual([8,12,16]);
});
test('stale generations and freed IOSBs cannot signal a published completion', async () => {
    for(const mode of ['stale','reset','freed'] as const){
        const {file,handle}=port();let notices=0,currentPublication=true;
        Mem.writeUint32(0x180,259);
        const waiting=invoke('GetQueuedCompletionStatus',[handle,8,12,16,1000]) as Promise<ThunkResult>;
        if(mode==='freed') (owner as any).addressSpace.validateRange=(address:number,length:number)=>address!==0x180&&address>0&&address+length<=ram.length;
        postFileIoCompletion(file,3,0x180,0,{deferredWrites:[{address:0x180,value:0,size:4}],isCurrent:()=>currentPublication,didPublish:()=>{notices++;}});
        if(mode==='stale')currentPublication=false;else if(mode==='reset')owner.resetGeneration++;
        await waiting;expect(notices).toBe(0);expect(Mem.readUint32(0x180)).toBe(259);
    }
});
test('a timeout leaves byte count and key untouched while clearing only the OVERLAPPED output',()=>{
    const {handle}=port();Mem.writeUint32(8,0x11223344);Mem.writeUint32(12,0x55667788);Mem.writeUint32(16,0x12345678);
    expect((invoke('GetQueuedCompletionStatus',[handle,8,12,16,0]) as ThunkResult).value).toBe(0);
    expect([Mem.readUint32(8),Mem.readUint32(12),Mem.readUint32(16)]).toEqual([0x11223344,0x55667788,0]);expect(errors).toEqual([[7,258]]);
});
test('captured completion targets survive file close but reject closed ports and reset owners', () => {
    const {file,handle}=port(),target=captureFileIoCompletion(file)!;
    expect(target).toBeDefined();
    resources.unregisterFileHandle(file);
    expect(target.post(3,0x180)).toBe(true);
    expect((invoke('GetQueuedCompletionStatus',[handle,8,12,16,0]) as ThunkResult).value).toBe(1);
    expect(Mem.readUint32(12)).toBe(0x1234);
    owner.resetGeneration++;
    expect(target.post(4,0x180)).toBe(false);
    const fresh=port(),freshTarget=captureFileIoCompletion(fresh.file)!;
    resources.unregisterKernelObject(fresh.handle);
    expect(freshTarget.post(5,0x180)).toBe(false);
});
test('closing a completion port preserves the file object association', () => {
    const {file,handle}=port();
    abandonIoCompletionWaiters(handle);resources.unregisterKernelObject(handle);
    const replacement=invoke('CreateIoCompletionPort',[0xffffffff,0,0,0]) as number;handles.push(replacement);
    expect(invoke('CreateIoCompletionPort',[file,replacement,43,0])).toBe(0);
    expect(errors.at(-1)).toEqual([7,87]);
    expect(postFileIoCompletion(file,3,0x180)).toBe(false);
});
test('a handle can be associated once, preserving its original completion key', () => {
    const { file, handle } = port();
    expect(invoke('CreateIoCompletionPort', [file, handle, 0x5678, 0])).toBe(0);
    expect(errors).toEqual([[7, 87]]);
    expect(postFileIoCompletion(file, 4, 0x180)).toBe(true);
    const result = invoke('GetQueuedCompletionStatus', [handle, 8, 12, 16, 0]) as ThunkResult;
    expect(result.value).toBe(1); expect(Mem.readUint32(12)).toBe(0x1234);
    expect(invoke('CreateIoCompletionPort', [0xdeadbeef, 0, 0, 0])).toBe(0);
    expect(errors.at(-1)).toEqual([7, 6]);
});
