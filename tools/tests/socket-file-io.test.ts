import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { RootNetworkNamespace } from '../../src/worker/core/network-namespace';
import { LanNetwork } from '../../src/worker/net/lan-network';
import { createWsaActorTable } from '../../src/worker/modules/wsa-actor-table';
import { Process } from '../../src/worker/core/process';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { getWsaProcessState } from '../../src/worker/modules/wsa-stub-shared';
import { getWsaOverlapped } from '../../src/worker/modules/wsa-overlapped';
import { ipv4Address } from '../../src/worker/modules/wsa-network';
import { socketFileIo, cancelSocketFileIo } from '../../src/worker/modules/kernel32/socket-file-io';
import { exports as sync, resetSyncState } from '../../src/worker/modules/kernel32/sync';
import { exports as fileIo } from '../../src/worker/modules/kernel32/file-io';
import type { ThunkResult } from '../../src/worker/core/thunking/thunk-dispatcher';

const system = System.getInstance(), scheduler = system.scheduler, resources = system.resourceProvider;
const savedProcess = system.process;
let memory: Uint8Array, owner: Process, table: ReturnType<typeof getWsaProcessState>['table'];
let thread: number, errors: Array<[number, number]>, undo: Array<() => void>, handles: number[];
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const set = (ptr: number, value: number) => Mem.writeUint32(ptr, value);
const get = (ptr: number) => Mem.readUint32(ptr);
function apply(result: ThunkResult) {
    for (const write of result.deferredWrites ?? []) {
        if (write.size === 1) Mem.writeUint8(write.address, write.value);
        else Mem.writeUint32(write.address, write.value);
    }
}
function pair() {
    const a = table.socket(2), b = table.socket(2), address = table.network.ipv4;
    table.bind(a, ipv4Address(address, 30001)); table.bind(b, ipv4Address(address, 30002));
    table.connect(a, ipv4Address(address, 30002)); table.connect(b, ipv4Address(address, 30001));
    return [a, b];
}
function event() { const h = scheduler.createEvent(true, false); handles.push(h); return h; }
function iocp(socket: number) {
    const h = sync.CreateIoCompletionPort({} as never, memory, [socket, 0, 42, 0]) as number;
    expect(h).not.toBe(0); handles.push(h); return h;
}
function dequeue(port: number) {
    return sync.GetQueuedCompletionStatus({} as never, memory, [port, 0x100, 0x104, 0x108, 0]) as ThunkResult;
}
beforeEach(() => {
    memory = new Uint8Array(1024 * 1024); Mem.bind(() => memory);
    thread = 7; errors = []; undo = []; handles = []; resetSyncState();
    owner = Object.create(Process.prototype) as Process;
    Object.assign(owner, { resetGeneration: 0, getMemory: () => memory, addressSpace: {
        validateRange: (ptr: number, size: number) => ptr > 0 && ptr + size <= memory.length,
        write: (ptr: number, bytes: Uint8Array) => { memory.set(bytes, ptr); return bytes.length; },
    } });
    system.process = owner; table = getWsaProcessState(owner).table;
    for (const [method, fn] of [
        ['getCurrentThreadId', () => thread],
        ['setLastError', (code: number) => { errors.push([thread, code]); }],
        ['setLastErrorForThread', (id: number, code: number) => { errors.push([id, code]); }],
    ] as const) {
        const spy = spyOn(scheduler, method).mockImplementation(fn as never); undo.push(() => spy.mockRestore());
    }
});
afterEach(() => {
    table.reset(); resetSyncState();
    for (const h of handles) resources.unregisterKernelObject(h);
    for (const fn of undo.reverse()) fn();
    system.process = savedProcess;
});
test('default socket rejects missing OVERLAPPED while synchronous socket reads and writes real packets', () => {
    const [a,b] = pair(); set(0x100, 0xfeed);
    expect((socketFileIo(owner, table, 'write', [a,0x1000,3,0x100,0]) as ThunkResult).value).toBe(0);
    expect(errors.at(-1)).toEqual([7,87]); expect(get(0x100)).toBe(0);
    table.get(a).overlapped = false;
    expect(sync.CreateIoCompletionPort({} as never,memory,[a,0,42,0])).toBe(0);
    expect(errors.at(-1)).toEqual([7,87]);
    memory.set([1,2,3],0x1000);
    expect((socketFileIo(owner,table,'write',[a,0x1000,3,0x100,0]) as ThunkResult).value).toBe(1);
    expect([...table.receive(b,16).data]).toEqual([1,2,3]); expect(get(0x100)).toBe(3);
    table.send(b,Uint8Array.of(4,5));
    expect((socketFileIo(owner,table,'read',[a,0x2000,16,0x100,0]) as ThunkResult).value).toBe(1);
    expect([...memory.slice(0x2000,0x2002)]).toEqual([4,5]); expect(get(0x100)).toBe(2);
});
test('kernel file entry points use native socket handles with a zero Winsock startup count', () => {
    const [a,b] = pair(); table.get(a).overlapped = false;
    expect(getWsaProcessState(owner).counter.count).toBe(0);
    memory.set([1,2,3],0x1000); set(0x100,0xfeed);
    const sent=fileIo.WriteFile!({} as never,memory,[a,0x1000,3,0x100,0]) as ThunkResult;
    expect(sent.value).toBe(1); expect(get(0x100)).toBe(3);
    expect([...table.receive(b,8).data]).toEqual([1,2,3]);
    table.send(b,Uint8Array.of(4,5));
    const received=fileIo.ReadFile!({} as never,memory,[a,0x2000,8,0x100,0]) as ThunkResult;
    expect(received.value).toBe(1); expect(get(0x100)).toBe(2);
    expect([...memory.slice(0x2000,0x2002)]).toEqual([4,5]);
    expect(getWsaProcessState(owner).counter.count).toBe(0); expect(errors).toEqual([]);
});
test('CloseHandle releases native socket descriptors and GetFileType rejects the closed handle', () => {
    const [a,b]=pair();
    expect(fileIo.GetFileType!({} as never,memory,[a])).toBe(3); expect(errors).toEqual([]);
    expect(fileIo.CloseHandle!({} as never,memory,[a])).toBe(1); expect(errors).toEqual([]);
    expect(table.isValid(a)).toBe(false); expect(table.isValid(b)).toBe(true);
    expect(fileIo.GetFileType!({} as never,memory,[a])).toBe(0); expect(errors.at(-1)).toEqual([7,6]);
    errors.length=0;
    expect(fileIo.CloseHandle!({} as never,memory,[a])).toBe(0); expect(errors).toEqual([[7,6]]);
});
test('invalid native socket handles report Win32 error6 and zero file byte counts', () => {
    const socket=table.socket(2); table.closesocket(socket);
    for(const direction of ['ReadFile','WriteFile'] as const){
        errors.length=0;set(0x100,0xfeed);
        const answer=fileIo[direction]!({} as never,memory,[socket,0x1000,8,0x100,0]);
        expect(typeof answer==='number'?answer:(answer as ThunkResult).value).toBe(0);
        expect(errors.at(-1)).toEqual([7,6]); expect(get(0x100)).toBe(0);
    }
});
test('kernel native I/O lease ownership ends once across sync completion, engine rejection and cancellation',async()=>{
    const [a,b]=pair(); let acquired=0,released=0;
    const acquire=table.acquireNativeIo.bind(table);
    const leaseSpy=spyOn(table,'acquireNativeIo').mockImplementation(socket=>{
        const lease=acquire(socket); acquired++;
        return {table:lease.table,release(){released++;lease.release()}};
    });undo.push(()=>leaseSpy.mockRestore());
    table.get(a).overlapped=false;table.send(b,Uint8Array.of(1));
    const immediate=socketFileIo(owner,table,'read',[a,0x1000,8,0x100,0]) as ThunkResult;
    expect(immediate.value).toBe(1);expect([acquired,released]).toEqual([1,1]);
    const waiting=socketFileIo(owner,table,'read',[a,0x1000,8,0x100,0]);
    expect(waiting).toBeInstanceOf(Promise);expect([acquired,released]).toEqual([2,1]);
    table.send(b,Uint8Array.of(2));await waiting;expect([acquired,released]).toEqual([2,2]);
    table.get(a).overlapped=true;set(0x310,0x7fffffff);
    expect((socketFileIo(owner,table,'read',[a,0x1000,8,0x100,0x300]) as ThunkResult).value).toBe(0);
    expect([acquired,released]).toEqual([3,3]);
    set(0x310,0);
    socketFileIo(owner,table,'read',[a,0x1000,8,0x100,0x340]);
    expect([acquired,released]).toEqual([4,3]);
    getWsaOverlapped(table,owner).cancel(a,0x340);await tick();
    expect([acquired,released]).toEqual([4,4]);
});
test('immediate kernel socket failures preserve IOSB high without creating event, APC or IOCP completion', async () => {
    const calls: number[][] = [];
    const spy = spyOn(scheduler, 'queueIoCompletionApc').mockImplementation((...args) => { calls.push(args); return true; });
    undo.push(() => spy.mockRestore());
    for (const operation of [0, 1, 2]) for (const mode of [0, 1, 2]) {
        const socket = table.socket(operation === 2 ? 2 : 1), h = event();
        scheduler.setEvent(h); const port = mode === 1 ? iocp(socket) : 0;
        set(0x300, 0x1234); set(0x304, 0x5678); set(0x310, h); set(0x100, 0xfeed);
        memory.fill(0xab, 0x1000, 0x1008);
        const answer = socketFileIo(owner, table, operation === 0 ? 'read' : 'write',
            [socket, 0x1000, 8, mode === 2 ? 0 : 0x100, 0x300], mode === 2 ? 0x800 : 0) as ThunkResult;
        expect(answer.value).toBe(0); expect(errors.at(-1)).toEqual([7, 59]);
        expect(get(0x100)).toBe(mode === 2 ? 0xfeed : 0);
        expect([get(0x300), get(0x304)]).toEqual([mode === 2 ? 0x1234 : 259, 0x5678]);
        expect([...memory.slice(0x1000, 0x1008)]).toEqual(Array(8).fill(0xab));
        expect((resources.getKernelObject(h) as any).signaled).toBe(mode === 2);
        await tick(); expect(calls).toEqual([]);
        if (port) {
            set(0x100, 0x9876); set(0x104, 0x7654);
            expect(dequeue(port).value).toBe(0); expect(errors.at(-1)).toEqual([7, 258]);
            expect([get(0x100), get(0x104), get(0x108)]).toEqual([0x9876, 0x7654, 0]);
        }
        table.closesocket(socket);
    }
});
test('kernel IOCP holds IOSB until dequeue, while publishing payload first into fresh RAM', async () => {
    const [a,b] = pair(), port = iocp(a);
    set(0x308,0x11223344); set(0x30c,0x55667788);
    const issued = socketFileIo(owner,table,'read',[a,0x1000,16,0x100,0x300]) as ThunkResult;
    expect(issued.value).toBe(0); expect(errors.at(-1)).toEqual([7,997]);
    const next = new Uint8Array(memory.length*2); next.set(memory); memory = next; thread = 11;
    table.send(b,Uint8Array.of(7,8,9)); await tick();
    expect(get(0x300)).toBe(259); expect(get(0x304)).toBe(0);
    expect([...memory.slice(0x1000,0x1003)]).toEqual([7,8,9]);
    expect(dequeue(port).value).toBe(1);
    expect([get(0x300),get(0x304),get(0x100),get(0x104),get(0x108)]).toEqual([0,3,3,42,0x300]);
    expect([get(0x308),get(0x30c)]).toEqual([0x11223344,0x55667788]);
});
test('CancelIoEx shares provider requests and returns the Win32 error in the deferred IOCP packet', async () => {
    const [a] = pair(), port = iocp(a);
    socketFileIo(owner,table,'read',[a,0x1000,16,0x100,0x300]);
    expect(getWsaOverlapped(table,owner).cancel(a,0x300)).toBe(1); await tick();
    expect(get(0x300)).toBe(259);
    expect(dequeue(port).value).toBe(0); expect(errors.at(-1)).toEqual([7,995]);
    expect([get(0x300),get(0x304)]).toEqual([0xc0000120,0]);
});
test('explicit event publishes status before signal and UDP truncation reports ERROR_MORE_DATA', async () => {
    const [a,b] = pair(), h = event(); set(0x310,h); table.send(b,Uint8Array.of(1,2,3));
    const result = socketFileIo(owner,table,'read',[a,0x1000,2,0x100,0x300]) as ThunkResult;
    expect(result.value).toBe(0); expect(errors.at(-1)).toEqual([7,997]);
    await tick();
    expect([get(0x300),get(0x304),get(0x100)]).toEqual([0x80000005,2,0]);
    expect([...memory.slice(0x1000,0x1002)]).toEqual([1,2]);
    expect((resources.getKernelObject(h) as any).signaled).toBe(true);
});
test('mixed WSA and Win32 receives consume the stream in shared issue order', async () => {
    const [a,b] = pair(), h = event(); set(0x310,h);
    const provider = getWsaOverlapped(table,owner);
    provider.issue(a,0x300,0,'read',() => { const p=table.receive(a,1); return {bytes:p.data.length,flags:0,writes:[{address:0x1000,value:p.data[0],size:1}]}; },()=>[]);
    socketFileIo(owner,table,'read',[a,0x1001,1,0x100,0x340]);
    table.send(b,Uint8Array.of(11)); table.send(b,Uint8Array.of(22)); await tick();
    expect([...memory.slice(0x1000,0x1002)]).toEqual([11,22]);
});
test('synchronous pending read returns deferred output to its caller without cross-thread TEB writes', async () => {
    const [a,b] = pair(); table.get(a).overlapped=false; table.get(a).nonBlocking=true;
    const result = socketFileIo(owner,table,'read',[a,0x1000,8,0x100,0]);
    expect(result).toBeInstanceOf(Promise); thread=11; table.send(b,Uint8Array.of(3));
    const answer=await result; expect(get(0x100)).toBe(0); apply(answer);
    expect(answer.value).toBe(1); expect(get(0x100)).toBe(1); expect(memory[0x1000]).toBe(3); expect(errors).toEqual([]);
});
test('file completion routines use three arguments, retain the issuing thread and leave hEvent unsignaled', async () => {
    const [a,b]=pair(), h=event(), calls:number[][]=[];
    const spy=spyOn(scheduler,'queueIoCompletionApc').mockImplementation((...args)=>{calls.push(args);return true;});
    undo.push(()=>spy.mockRestore()); set(0x310,h);
    const result=socketFileIo(owner,table,'read',[a,0x1000,8,0,0x300],0x800) as ThunkResult;
    expect(result.value).toBe(1); expect(get(0x300)).toBe(0); expect(calls).toEqual([]);
    thread=11; table.send(b,Uint8Array.of(7,8)); await tick();
    expect(calls).toEqual([[7,0x800,0,2,0x300]]);
    expect([get(0x300),get(0x304)]).toEqual([0,2]);
    expect((resources.getKernelObject(h) as any).signaled).toBe(false);
});
test('file APC warning carries the received prefix with success, while IOCP binding rejects APC I/O', () => {
    const [a,b]=pair(), calls:number[][]=[];
    const spy=spyOn(scheduler,'queueIoCompletionApc').mockImplementation((...args)=>{calls.push(args);return true;});
    undo.push(()=>spy.mockRestore()); table.send(b,Uint8Array.of(1,2,3));
    expect((socketFileIo(owner,table,'read',[a,0x1000,2,0,0x300],0x800) as ThunkResult).value).toBe(1);
    expect(calls).toEqual([[7,0x800,0,2,0x300]]); expect(get(0x300)).toBe(0x80000005);
    iocp(a);
    expect((socketFileIo(owner,table,'write',[a,0x1000,2,0,0x340],0x800) as ThunkResult).value).toBe(0);
    expect(errors.at(-1)).toEqual([7,87]); expect(calls).toHaveLength(1);
});
test('CancelIoEx NULL cancels synchronous Win32 I/O while exact OVERLAPPED and foreign CancelIo do not', async () => {
    const [a,b]=pair(); table.get(a).overlapped=false;
    const waiting=socketFileIo(owner,table,'read',[a,0x1000,8,0x100,0]);
    thread=11;
    expect(cancelSocketFileIo(owner,a,0x300)).toBe(0);
    expect(cancelSocketFileIo(owner,a,0,11)).toBe(0);
    expect(cancelSocketFileIo(owner,a)).toBe(1);
    expect(cancelSocketFileIo(owner,a)).toBe(0);
    expect((await waiting).value).toBe(0); expect(errors.at(-1)).toEqual([7,995]);
    table.send(b,Uint8Array.of(9)); expect([...table.receive(a,8).data]).toEqual([9]);
});
test('reset before arrival prevents an old file request from consuming data or queuing a new APC', async () => {
    const [a,b]=pair(), calls:number[][]=[];
    const spy=spyOn(scheduler,'queueIoCompletionApc').mockImplementation((...args)=>{calls.push(args);return true;});
    undo.push(()=>spy.mockRestore());
    socketFileIo(owner,table,'read',[a,0x1000,8,0,0x300],0x800);
    owner.resetGeneration++; memory.fill(0x77,0x300,0x308);
    table.send(b,Uint8Array.of(5)); await tick();
    expect(calls).toEqual([]); expect(get(0x300)).toBe(0x77777777);
    expect([...table.receive(a,8).data]).toEqual([5]); expect(memory[0x1000]).toBe(0);
});
test('synchronous file cancellation follows the shared object after its issuing alias closes', async () => {
    const network=new LanNetwork(),host=new RootNetworkNamespace(network,8,28001);
    table=createWsaActorTable(network,()=>host.socketActorClient());getWsaProcessState(owner).table=table;
    try{
        const source=table.socket(2);table.bind(source,ipv4Address(network.ipv4,7631));table.get(source).overlapped=false;
        const alias=table.duplicate(source,28001);
        const waiting=socketFileIo(owner,table,'read',[alias,0x1000,8,0x100,0]);
        expect(waiting).toBeInstanceOf(Promise);
        expect(fileIo.CloseHandle!({} as never,memory,[alias])).toBe(1);
        expect(cancelSocketFileIo(owner,source,0,11)).toBe(0);
        expect(cancelSocketFileIo(owner,source)).toBe(1);
        expect((await waiting).value).toBe(0);expect(errors.at(-1)).toEqual([7,995]);
        expect(table.nativeHandleView.isValid(source)).toBe(true);
    }finally{table.reset();await host.close();}
});
test('socket duplicates share one IOCP binding and retain pending completions after alias close', async () => {
    const network=new LanNetwork(),host=new RootNetworkNamespace(network,8,28002);
    table=createWsaActorTable(network,()=>host.socketActorClient());getWsaProcessState(owner).table=table;
    try{
        const source=table.socket(2),peer=table.socket(2),address=ipv4Address(network.ipv4,7632);
        table.bind(source,address);const alias=table.duplicate(source,28002),port=iocp(source);
        expect(sync.CreateIoCompletionPort({} as never,memory,[alias,port,43,0])).toBe(0);
        expect(errors.at(-1)).toEqual([7,87]);
        expect((socketFileIo(owner,table,'read',[alias,0x1000,8,0x100,0x300]) as ThunkResult).value).toBe(0);
        expect(fileIo.CloseHandle!({} as never,memory,[alias])).toBe(1);
        table.send(peer,Uint8Array.of(97,98,99),address);
        const deadline=Date.now()+3000;
        while(memory[0x1000]!==97){if(Date.now()>deadline)throw Error('Alias IOCP payload timeout');await new Promise(resolve=>setTimeout(resolve,2));}
        expect([get(0x300),get(0x304)]).toEqual([259,0]);
        expect(dequeue(port).value).toBe(1);
        expect([get(0x100),get(0x104),get(0x108),get(0x300),get(0x304)]).toEqual([3,42,0x300,0,3]);
    }finally{table.reset();await host.close();}
});
test('a pending read observes a later IOCP association through its surviving alias', async () => {
    const network=new LanNetwork(),host=new RootNetworkNamespace(network,8,28004);
    table=createWsaActorTable(network,()=>host.socketActorClient());getWsaProcessState(owner).table=table;
    try{
        const source=table.socket(2),peer=table.socket(2),address=ipv4Address(network.ipv4,7634);
        table.bind(source,address);const alias=table.duplicate(source,28004);
        socketFileIo(owner,table,'read',[alias,0x1000,8,0x100,0x300]);
        expect(fileIo.CloseHandle!({} as never,memory,[alias])).toBe(1);const port=iocp(source);
        table.send(peer,Uint8Array.of(97,98,99),address);
        const deadline=Date.now()+3000;
        while(get(0x300)===259){if(Date.now()>deadline)throw Error('Late IOCP association read timeout');await new Promise(resolve=>setTimeout(resolve,2));}
        expect([get(0x300),get(0x304)]).toEqual([0,3]);
        expect(dequeue(port).value).toBe(1);expect([get(0x100),get(0x104),get(0x108)]).toEqual([3,42,0x300]);
    }finally{table.reset();await host.close();}
});
test('last-alias closure delivers cancellation to the issued IOCP destination', async () => {
    const network=new LanNetwork(),host=new RootNetworkNamespace(network,8,28003);
    table=createWsaActorTable(network,()=>host.socketActorClient());getWsaProcessState(owner).table=table;
    try{
        const source=table.socket(2);table.bind(source,ipv4Address(network.ipv4,7633));const port=iocp(source);
        socketFileIo(owner,table,'read',[source,0x1000,8,0x100,0x300]);
        expect(fileIo.CloseHandle!({} as never,memory,[source])).toBe(1);
        const deadline=Date.now()+3000;
        let result=dequeue(port);
        while(errors.at(-1)?.[1]===258){if(Date.now()>deadline)throw Error('Closed socket IOCP cancellation timeout');await new Promise(resolve=>setTimeout(resolve,2));result=dequeue(port);}
        expect(result.value).toBe(0);expect(errors.at(-1)).toEqual([7,995]);
        expect([get(0x100),get(0x104),get(0x108),get(0x300),get(0x304)]).toEqual([0,42,0x300,0xc0000120,0]);
    }finally{table.reset();await host.close();}
});
test('a closed IOCP retains its socket association and no-event IOSB publication policy',async()=>{
    for(const withEvent of [false,true]){
        const [a,b]=pair(),closed=iocp(a),h=withEvent?event():0;
        expect(fileIo.CloseHandle!({} as never,memory,[closed])).toBe(1);
        const replacement=sync.CreateIoCompletionPort({} as never,memory,[0xffffffff,0,0,0]) as number;handles.push(replacement);
        expect(sync.CreateIoCompletionPort({} as never,memory,[a,replacement,43,0])).toBe(0);
        expect(errors.at(-1)).toEqual([7,87]);
        set(0x300,0);set(0x304,0);set(0x310,h);
        socketFileIo(owner,table,'read',[a,0x1000,8,0x100,0x300]);
        table.send(b,Uint8Array.of(97,98,99));await tick();
        expect([...memory.slice(0x1000,0x1003)]).toEqual([97,98,99]);
        expect([get(0x300),get(0x304)]).toEqual(withEvent?[0,3]:[259,0]);
        if(h)expect((resources.getKernelObject(h) as any).signaled).toBe(true);
        expect(dequeue(replacement).value).toBe(0);expect(errors.at(-1)).toEqual([7,258]);
        table.closesocket(a);table.closesocket(b);
    }
});
test('reset fences deferred IOCP IOSB from recycled guest memory', async () => {
    const [a,b]=pair(), port=iocp(a);
    socketFileIo(owner,table,'read',[a,0x1000,8,0x100,0x300]); table.send(b,Uint8Array.of(3)); await tick();
    owner.resetGeneration++; memory.fill(0x77,0x300,0x308);
    dequeue(port); expect(get(0x300)).toBe(0x77777777); expect(get(0x304)).toBe(0x77777777);
});
