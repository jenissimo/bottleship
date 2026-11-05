import { System } from '../core/system';
import { TimeService } from '../runtime/time';
import { hypercallDataManager, type HypercallState } from '../core/cpu/hypercall-data';
import { ThreadState, type KernelEventObject, type KernelMutexObject, type KernelSemaphoreObject, type KernelThreadObject } from '../core/scheduler/types';
import { THREAD_FIELDS, type SchedulerState } from '../core/scheduler/scheduler';
import type { ResourceProviderState } from '../core/resources/system-resource-provider';
import type { MemoryManagerState } from '../core/process';
import type { ThunkGeneratorState } from '../core/thunking/thunk-generator';
import { captureKernel32Memory, restoreKernel32Memory, type Kernel32MemoryState } from '../modules/kernel32/memory';
import { pickSaved, savestateParticipants, type FieldPolicy } from './participant';
import { CPU_FIELDS, captureCpu, restoreCpu, type V86Cpu } from './participants/cpu';
import { objectCodecs } from './object-codecs';
import { ramPatches } from './session';
import { registerKernel32Participant } from '../modules/kernel32/savestate';
import type { SaveValue } from './value-codec';

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

function rewindRestartableParks(state: SchedulerState): void {
    const p = process();
    for (const park of p.dispatcher.restartableParks()) {
        const stub = p.thunkGenerator.getStubById(park.functionId);
        const thread = state.threads.find(t => t.id === park.threadId);
        if (!stub || !thread?.context) throw new Error(`savestate: cannot rewind thread ${park.threadId}`);
        thread.context = { ...thread.context, eip: stub.address, esp: park.esp };
        thread.state = ThreadState.READY;
        thread.waitInfo = null;
        if (!state.runQueue.includes(thread.id)) state.runQueue.push(thread.id);
        const r = park.returnAddr >>> 0;
        ramPatches.push(
            { address: park.esp, bytes: [r & 0xff, (r >>> 8) & 0xff, (r >>> 16) & 0xff, (r >>> 24) & 0xff] },
            { address: park.spinAddr, bytes: park.spinBytes },
        );
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

export function registerCoreParticipants(): void {
    registerKernelRecordCodecs();
    registerKernel32Participant();

    savestateParticipants.add({
        id: 'time', version: 1, order: 1,
        capture: () => save(TimeService.getInstance().captureClock()),
        restore: (s) => TimeService.getInstance().restoreClock(as<{ nowMs: number }>(s)),
    });
    savestateParticipants.add({
        id: 'address-space', version: 1, order: 2,
        capture: () => {
            if (process().pageTableManager?.hasExternalDataPages()) throw new Error('address space: external data page mappings are not part of a v1 savestate');
            return save(process().addressSpace.captureState());
        },
        restore: (s) => {
            const p = process();
            p.addressSpace.restoreState(as(s));
            p.pageTableManager?.rebuildWriteMap(p.addressSpace.getFastWritableRanges());
        },
    });
    savestateParticipants.add({
        id: 'memory-manager', version: 1, order: 3,
        capture: () => save(process().memory.captureState()),
        restore: (s) => process().memory.restoreState(as<MemoryManagerState>(s)),
    });
    savestateParticipants.add({
        id: 'kernel32-memory', version: 1, order: 4, covers: ['kernel32'],
        capture: () => save(captureKernel32Memory()),
        restore: (s) => restoreKernel32Memory(as<Kernel32MemoryState>(s)),
    });
    savestateParticipants.add({
        id: 'thunk-generator', version: 1, order: 5,
        capture: () => save(process().thunkGenerator.captureState()),
        restore: (s) => process().thunkGenerator.restoreState(as<ThunkGeneratorState>(s)),
    });
    savestateParticipants.add({
        id: 'resources', version: 1, order: 10, schema: KERNEL_RECORDS as unknown as SaveValue,
        capture: (ctx) => save(System.getInstance().resourceProvider.captureState((o, w) => ctx.ref(o, w))),
        restore: (s, ctx) => System.getInstance().resourceProvider.restoreState(as<ResourceProviderState>(s), r => ctx.object(r)),
    });
    savestateParticipants.add({
        id: 'hypercall-page', version: 1, order: 11,
        capture: () => save(hypercallDataManager.captureState()),
        restore: (s) => hypercallDataManager.restoreState(as<HypercallState>(s)),
    });
    savestateParticipants.add({
        id: 'scheduler', version: 1, order: 20, schema: THREAD_FIELDS as unknown as SaveValue,
        capture: (ctx) => {
            const state = System.getInstance().scheduler.captureState((o, w) => ctx.ref(o, w));
            rewindRestartableParks(state);
            return save(state);
        },
        restore: (s, ctx) => System.getInstance().scheduler.restoreState(as<SchedulerState>(s), r => ctx.object(r)),
    });
    savestateParticipants.add({
        id: 'timer-wheel', version: 1, order: 21,
        capture: () => save(System.getInstance().scheduler.timerWheel.captureState()),
        restore: (s) => System.getInstance().scheduler.timerWheel.restoreState(as<{ nextId: number; entries: number[][] }>(s)),
    });
    savestateParticipants.add({
        id: 'dispatcher', version: 1, order: 90,
        capture: () => save(process().dispatcher.captureState()),
        restore: (s) => process().dispatcher.restoreState(as(s)),
    });
    savestateParticipants.add({
        id: 'cpu', version: 1, order: 99, schema: CPU_FIELDS as unknown as SaveValue,
        capture: () => captureCpu(v86Cpu()),
        restore: (s) => restoreCpu(v86Cpu(), s),
    });
}

export function touchedModules(): string[] {
    const out = new Set<string>();
    for (const stub of process().thunkGenerator.getAllStubs()) out.add(stub.dllName);
    return [...out];
}
