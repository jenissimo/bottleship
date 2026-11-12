import { System } from '../core/system';
import { loadedHleModules } from '../core/hle-module-images';
import { resolveThunkedDllAlias } from '../core/dll-aliases';
import { TimeService, type ClockState } from '../runtime/time';
import type { AddressSpace, RegionEntry } from '../core/memory/address-space';
import type { TimerWheel } from '../core/scheduler/timer-wheel';
import type { ThunkDispatcher } from '../core/thunking/thunk-dispatcher';
import type { CallbackManager } from '../core/thunking/callback-manager';
import { hypercallDataManager, type HypercallState } from '../core/cpu/hypercall-data';
import { ThreadState, WaitReason, type KernelEventObject, type KernelMutexObject, type KernelSemaphoreObject, type KernelThreadObject } from '../core/scheduler/types';
import { THREAD_FIELDS, type SchedulerState } from '../core/scheduler/scheduler';
import type { ResourceProviderState } from '../core/resources/system-resource-provider';
import type { MemoryManagerState } from '../core/process';
import type { ThunkGeneratorState, ThunkStub } from '../core/thunking/thunk-generator';
import { captureKernel32Memory, restoreKernel32Memory, type Kernel32MemoryState } from '../modules/kernel32/memory';
import { pickSaved, savestateParticipants, stateKeys, type CaptureContext, type FieldPolicy } from './participant';
import { CPU_FIELDS, captureCpu, restoreCpu, type V86Cpu } from './participants/cpu';
import { MODULE_IMAGES_SCHEMA, moduleImagesHooks } from './participants/module-images';
import { CaptureRefusal, objectCodecs } from './object-codecs';
import { registerKernel32Participant } from '../modules/kernel32/savestate';
import { registerUser32Participants } from '../modules/user32/savestate';
import { registerGdi32Participants } from '../modules/gdi32/savestate';
import type { SaveValue } from './value-codec';
import { STATELESS_MODULES } from './stateless-modules';

function v86Cpu(): V86Cpu {
    const v86 = System.getInstance().process?.v86 as { cpu?: V86Cpu; v86?: { cpu?: V86Cpu } } | undefined;
    const cpu = v86?.cpu ?? v86?.v86?.cpu;
    if (!cpu) throw new Error('savestate: no CPU');
    return cpu;
}

function process() {
    const p = System.getInstance().process;
    if (!p) throw new Error('savestate: no process');
    return p;
}

const as = <T>(v: SaveValue) => v as unknown as T;
const save = (v: unknown) => v as SaveValue;

function rewindRestartableParks(state: SchedulerState, ctx: CaptureContext): void {
    const p = process();
    const sched = System.getInstance().scheduler;
    const spinPatched = new Set<number>();
    for (const park of p.dispatcher.restartableParks()) {
        const stub = p.thunkGenerator.getStubById(park.functionId);
        const thread = state.threads.find(t => t.id === park.threadId);
        const what = `thread ${park.threadId} in ${park.functionName}`;
        if (!stub || !thread?.context) throw new CaptureRefusal(`savestate: cannot rewind ${what}`);
        if (thread.state !== ThreadState.WAITING || thread.waitInfo?.reason !== WaitReason.ASYNC_THUNK
            || park.generation === 0 || sched.getAsyncParkGeneration(thread.id) !== park.generation) {
            throw new CaptureRefusal(`savestate: ${what} is not parked`);
        }
        const argBytes = park.argBytes;
        if (park.args.length < argBytes) throw new CaptureRefusal(`savestate: the arguments of ${what} were not kept`);
        const regs = { eip: stub.address, esp: park.esp };
        thread.context = { ...thread.context, ...regs };
        thread.waitInfo = null;
        if (thread.id === state.currentThreadId) {
            const owner = sched.lazyFpuOwnerThreadId();
            if (owner !== null && owner !== thread.id) throw new CaptureRefusal(`savestate: the live FPU of ${what} belongs to thread ${owner}`);
            thread.state = ThreadState.RUNNING;
            const c = thread.context;
            ctx.overrideCpu({ ...regs, eax: c.eax, ecx: c.ecx, edx: c.edx, ebx: c.ebx, ebp: c.ebp, esi: c.esi, edi: c.edi, eflags: c.eflags });
        } else {
            thread.state = ThreadState.READY;
            if (!state.runQueue.includes(thread.id)) state.runQueue.push(thread.id);
        }
        const r = park.returnAddr >>> 0;
        ctx.patchRam(park.esp, [r & 0xff, (r >>> 8) & 0xff, (r >>> 16) & 0xff, (r >>> 24) & 0xff, ...park.args.subarray(0, argBytes)]);
        const [b0, b1] = park.spinBytes;
        if (!spinPatched.has(park.spinAddr) && !(b0 === 0xeb && b1 === 0xfe)) {
            spinPatched.add(park.spinAddr);
            ctx.patchRam(park.spinAddr, park.spinBytes);
        }
    }
    for (const t of state.threads) {
        if (t.state === ThreadState.WAITING && t.waitInfo?.reason === WaitReason.ASYNC_THUNK) {
            throw new CaptureRefusal(`savestate: thread ${t.id} waits on host work that cannot be re-issued`);
        }
    }
}

function refusing<T>(what: string, run: () => T): T {
    try {
        return run();
    } catch (e) {
        if (e instanceof CaptureRefusal) throw e;
        throw new CaptureRefusal(e instanceof Error ? e.message : `${what}: ${String(e)}`);
    }
}

export const KERNEL_THREAD_FIELDS = {
    basicInformation: 'save', kind: 'save', threadId: 'save', terminated: 'save', exitCode: 'save',
} as const satisfies Record<keyof KernelThreadObject, FieldPolicy>;

export const KERNEL_EVENT_FIELDS = {
    kind: 'save', manualReset: 'save', signaled: 'save', pendingWake: 'save',
} as const satisfies Record<keyof KernelEventObject, FieldPolicy>;

export const KERNEL_SEMAPHORE_FIELDS = {
    kind: 'save', count: 'save', max: 'save',
} as const satisfies Record<keyof KernelSemaphoreObject, FieldPolicy>;

export const KERNEL_MUTEX_FIELDS = {
    kind: 'save', ownerThreadId: 'save', recursion: 'save', abandoned: 'save',
} as const satisfies Record<keyof KernelMutexObject, FieldPolicy>;

const KERNEL_RECORDS = {
    thread: KERNEL_THREAD_FIELDS,
    event: KERNEL_EVENT_FIELDS,
    semaphore: KERNEL_SEMAPHORE_FIELDS,
    mutex: KERNEL_MUTEX_FIELDS,
} as const;

type KernelRecord = KernelThreadObject | KernelEventObject | KernelSemaphoreObject | KernelMutexObject;

function isKernelRecord(o: unknown): o is KernelRecord {
    return o !== null && typeof o === 'object' && Object.getPrototypeOf(o) === Object.prototype
        && Object.prototype.hasOwnProperty.call(KERNEL_RECORDS, String((o as { kind?: unknown }).kind));
}

function withoutUndefined(record: Record<string, unknown>): Record<string, SaveValue> {
    const out: Record<string, SaveValue> = {};
    for (const [k, v] of Object.entries(record)) {
        if (v === undefined) continue;
        out[k] = (v !== null && typeof v === 'object' ? { ...v } : v) as SaveValue;
    }
    return out;
}

function registerKernelRecordCodecs(): void {
    objectCodecs.add<KernelRecord>({
        tag: 'kernel-record',
        matches: isKernelRecord,
        capture: (o) => withoutUndefined(pickSaved(o as never, KERNEL_RECORDS[o.kind] as Record<string, FieldPolicy>)),
        restore: (d: Record<string, SaveValue>) => {
            const policy = KERNEL_RECORDS[d.kind as KernelRecord['kind']] as Record<string, FieldPolicy> | undefined;
            if (!policy) throw new Error(`savestate: unknown kernel record kind ${String(d.kind)}`);
            return withoutUndefined(pickSaved(d as never, policy)) as unknown as KernelRecord;
        },
    });
}

const SCHEMAS = {
    time: stateKeys<ClockState>({ nowMs: true }),
    addressSpace: {
        state: stateKeys<ReturnType<AddressSpace['captureState']>>({ nextRegionId: true, regions: true, buckets: true }),
        region: stateKeys<RegionEntry>({ id: true, base: true, size: true, perms: true, kind: true, owner: true, tag: true, allowOverlap: true, skipOverlapCheck: true, allocationId: true, allocationBase: true, allocationSize: true, allocationPerms: true, allocationProtect: true, protection: true }),
    },
    memoryManager: stateKeys<MemoryManagerState>({ allocs: true, totalAllocated: true, currentBytes: true, peakBytes: true, freeBlocks: true, largeFreeBlocks: true, bucketState: true, sysPoolArena: true, sysPoolFree: true, systemPoolGeneration: true }),
    kernel32Memory: stateKeys<Kernel32MemoryState>({ createdHeaps: true, nextCreatedHeapHandle: true, heapCompatibility: true, terminationOnCorruption: true, slabRanges: true, totalSlabBytes: true, nextSlabSize: true, virtualAllocRegions: true, decommittedPages: true, freeVirtualPages: true, vaFreeCache: true, vaProtectionTouched: true }),
    thunkGenerator: {
        state: stateKeys<ThunkGeneratorState>({ currentAddress: true, nextFunctionId: true, stubs: true, aliases: true, names: true, dataExports: true }),
        stub: stateKeys<ThunkStub>({ address: true, dllName: true, functionName: true, functionId: true, argCount: true, stackCleanupBytes: true, absentDll: true, redirectedTo: true }),
    },
    resources: { state: stateKeys<ResourceProviderState>({ com: true, gdi: true, kernel: true, user: true, file: true, attributes: true, addressToHandle: true, handleToAddress: true, handleToPrimaryAddress: true, surfacePtrs: true, counters: true, freeCom: true, freeUser: true, freeFile: true, comGenerations: true, userGenerations: true }), kernelRecords: KERNEL_RECORDS },
    hypercallPage: stateKeys<HypercallState>({ registered: true, enabled: true, slabControlAddr: true, mutexMirrorAddr: true, eaglTokenCfgAddr: true, eventTable: true, flsAllocated: true, flsValues: true, flsCurrentTid: true, captureHwnd: true, suspendSlots: true, suspendTable: true, wasmStringWritersOff: true }),
    scheduler: { state: stateKeys<SchedulerState>({ threads: true, currentThreadId: true, nextThreadId: true, mainThreadId: true, runQueue: true, bootstrapUntilFirstWait: true, tlsSlots: true, nextTlsIndex: true, criticalSectionOwners: true, csLockSemaphores: true, stackPool: true, stackBytesPooled: true, stackBytesReserved: true, ownedStackBases: true, mainStack: true, threadExitStubAddr: true, apcDispatchStub: true, apcDispatchGeneration: true, alertedWaitResults: true, reapQueue: true, reapRetryQueue: true, teb: true, sync: true }), thread: THREAD_FIELDS },
    timerWheel: stateKeys<ReturnType<TimerWheel['captureState']>>({ nextId: true, entries: true }),
    dispatcher: {
        state: stateKeys<ReturnType<ThunkDispatcher['captureState']>>({ wbufTail: true, asyncEpoch: true, uef: true, callbacks: true }),
        callbacks: stateKeys<ReturnType<CallbackManager['captureState']>>({ nextCallbackId: true, nextFrameId: true, stubs: true }),
    },
    cpu: CPU_FIELDS,
} as const;

const schema = (v: unknown) => v as SaveValue;

export function registerCoreParticipants(): void {
    for (const [module, reason] of Object.entries(STATELESS_MODULES)) savestateParticipants.stateless(module, reason);
    registerKernelRecordCodecs();
    registerKernel32Participant();
    registerUser32Participants();
    registerGdi32Participants();

    savestateParticipants.add({
        id: 'time', version: 1, order: 1, schema: schema(SCHEMAS.time),
        capture: () => save(refusing('time', () => TimeService.getInstance().captureClock())),
        restore: (s) => TimeService.getInstance().restoreClock(as<ClockState>(s)),
    });
    savestateParticipants.add({
        id: 'address-space', version: 1, order: 2, schema: schema(SCHEMAS.addressSpace),
        capture: () => {
            if (process().pageTableManager?.hasExternalDataPages()) throw new CaptureRefusal('address space: external data page mappings are not part of a v1 savestate');
            return save(process().addressSpace.captureState());
        },
        restore: (s) => {
            const p = process();
            p.addressSpace.restoreState(as(s));
            p.pageTableManager?.rebuildWriteMap(p.addressSpace.getFastWritableRanges());
        },
    });
    savestateParticipants.add({
        id: 'memory-manager', version: 1, order: 3, schema: schema(SCHEMAS.memoryManager),
        capture: () => save(process().memory.captureState()),
        restore: (s) => process().memory.restoreState(as<MemoryManagerState>(s)),
    });
    // kernel32-memory v2: the VirtualAlloc recycler's parked blocks are live in a v1
    // snapshot's MemoryManager state with nothing recording them as parked.
    savestateParticipants.add({
        id: 'kernel32-memory', version: 2, order: 4, covers: ['kernel32'], schema: schema(SCHEMAS.kernel32Memory),
        capture: () => save(refusing('kernel32 memory', captureKernel32Memory)),
        restore: (s) => restoreKernel32Memory(as<Kernel32MemoryState>(s)),
    });
    savestateParticipants.add({
        id: 'thunk-generator', version: 1, order: 5, schema: schema(SCHEMAS.thunkGenerator),
        capture: () => save(process().thunkGenerator.captureState()),
        restore: (s) => process().thunkGenerator.restoreState(as<ThunkGeneratorState>(s)),
    });
    const moduleImages = moduleImagesHooks(() => ({ registry: process().moduleRegistry, loader: process().loader }));
    savestateParticipants.add({
        id: 'module-images', version: 1, order: 7, schema: schema(MODULE_IMAGES_SCHEMA),
        capture: (ctx) => refusing('module images', () => moduleImages.capture(ctx)),
        verify: moduleImages.verify,
        restore: moduleImages.restore,
    });
    savestateParticipants.add({
        id: 'resources', version: 1, order: 10, schema: schema(SCHEMAS.resources),
        capture: (ctx) => save(System.getInstance().resourceProvider.captureState((o, w) => ctx.ref(o, w))),
        restore: (s, ctx) => System.getInstance().resourceProvider.restoreState(as<ResourceProviderState>(s), r => ctx.object(r)),
    });
    savestateParticipants.add({
        id: 'hypercall-page', version: 1, order: 11, schema: schema(SCHEMAS.hypercallPage),
        capture: () => save(hypercallDataManager.captureState()),
        restore: (s) => hypercallDataManager.restoreState(as<HypercallState>(s)),
    });
    // scheduler v2: TEB TLS arrays hold all 1088 TlsAlloc indices (teb-manager.ts). A v1
    // snapshot's arrays are 64 slots in guest RAM, so restoring one would let a key >= 64 be
    // written past its end.
    savestateParticipants.add({
        id: 'scheduler', version: 2, order: 20, schema: schema(SCHEMAS.scheduler),
        capture: (ctx) => {
            const state = refusing('scheduler', () => System.getInstance().scheduler.captureState((o, w) => ctx.ref(o, w)));
            refusing('scheduler', () => rewindRestartableParks(state, ctx));
            return save(state);
        },
        restore: (s, ctx) => System.getInstance().scheduler.restoreState(as<SchedulerState>(s), r => ctx.object(r)),
    });
    savestateParticipants.add({
        id: 'timer-wheel', version: 1, order: 21, schema: schema(SCHEMAS.timerWheel),
        capture: () => save(refusing('timer wheel', () => System.getInstance().scheduler.timerWheel.captureState())),
        restore: (s) => System.getInstance().scheduler.timerWheel.restoreState(as<{ nextId: number; entries: number[][] }>(s)),
    });
    savestateParticipants.add({
        id: 'dispatcher', version: 1, order: 90, schema: schema(SCHEMAS.dispatcher),
        capture: () => save(refusing('dispatcher', () => process().dispatcher.captureState())),
        restore: (s) => process().dispatcher.restoreState(as(s)),
    });
    savestateParticipants.add({
        id: 'loaded-modules', version: 1, order: 98, schema: { modules: ['name'] },
        capture: () => touchedModules().sort(),
        restore: (s) => checkLoadedModules(s as string[], touchedModules()),
    });
    savestateParticipants.add({
        id: 'cpu', version: 1, order: 99, schema: schema(SCHEMAS.cpu),
        capture: (ctx) => captureCpu(v86Cpu(), ctx.cpuOverride()),
        restore: (s) => restoreCpu(v86Cpu(), s),
    });
}

export function checkLoadedModules(saved: readonly string[], now: readonly string[]): void {
    const have = new Set(now);
    const want = new Set(saved);
    const missing = saved.filter(m => !have.has(m));
    const extra = now.filter(m => !want.has(m));
    if (missing.length || extra.length) {
        throw new Error(`savestate: the restored session loads different modules (missing ${missing.join(', ') || 'none'}, extra ${extra.join(', ') || 'none'})`);
    }
}

export function touchedModules(loaded: () => ReadonlyArray<{ name: string }> = loadedHleModules): string[] {
    return [...new Set(loaded().map(m => m.name))];
}

export function coverageModules(loaded: () => ReadonlyArray<{ name: string }> = loadedHleModules): string[] {
    return [...new Set(loaded().map(m => resolveThunkedDllAlias(m.name)))];
}
