import type { FastPathRegistrar, ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { getCurrentProcessPriorityClass } from '../kernel32/process/process';
import { VIRTUAL_CURRENT_PROCESS_ID } from '../kernel32/process/virtual-process-manager';

const SIZE = 28;
const STATUS_NOT_IMPLEMENTED = 0xc0000002, STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;
const STATUS_ACCESS_VIOLATION = 0xc0000005, STATUS_INVALID_HANDLE = 0xc0000008;
const STATUS_DATATYPE_MISALIGNMENT = 0x80000002, STATUS_NOT_SUPPORTED = 0xc00000bb;
// @transient(constant table)
const CLASS_BASES = new Map([[0x40,4],[0x4000,6],[0x20,8],[0x8000,10],[0x80,13],[0x100,24]]);

/** NT effective priority, not THREAD_BASIC_INFORMATION.BasePriority (which is relative).
 * The HLE scheduler has no dynamic priority boosts, so report the unboosted value.
 */
export function effectiveThreadPriority(priorityClass: number, relative: number): number | null {
    const base = CLASS_BASES.get(priorityClass);
    if (base === undefined) return null;
    const realtime = priorityClass === 0x100;
    if (relative === -15) return realtime ? 16 : 1;
    if (relative === 15) return realtime ? 31 : 15;
    return Math.max(realtime ? 16 : 1, Math.min(realtime ? 31 : 15, base + relative));
}

/** Validate the complete extent before any output, without a per-call closure. */
function writable(system: System, memoryLength: number, ptr: number, size: number): boolean {
    return ptr > 0 && ptr + size <= memoryLength
        && (!system.process?.addressSpace || system.process.addressSpace.validateRange(ptr, size, 'w'));
}

export const queryThreadBasicInformation: ThunkImplementation = (_ctx, mem, args): number => {
    const handle = args[0] >>> 0, infoClass = args[1] >>> 0;
    const out = args[2] >>> 0, length = args[3] >>> 0, returnLength = args[4] >>> 0;
    if (infoClass !== 0) return STATUS_NOT_IMPLEMENTED;
    const system = System.getInstance();
    // Size validation precedes handle lookup and buffer probing (native x86 contract).
    if (length !== SIZE) {
        if (returnLength && !(returnLength & 3) && writable(system, mem.length, returnLength, 4)) Mem.writeUint32(returnLength, SIZE);
        return STATUS_INFO_LENGTH_MISMATCH;
    }
    if ((out & 3) || (returnLength & 3)) return STATUS_DATATYPE_MISALIGNMENT;
    if (!writable(system, mem.length, out, SIZE)
        || (returnLength && !writable(system, mem.length, returnLength, 4))) return STATUS_ACCESS_VIOLATION;
    const thread = system.scheduler.getThreadBasicInformation(handle);
    if (!thread) return STATUS_INVALID_HANDLE;
    const priority = effectiveThreadPriority(getCurrentProcessPriorityClass(), thread.relativePriority);
    if (priority === null) return STATUS_NOT_SUPPORTED;
    // No temporary struct/view: retain Mem validation, write traps and watchpoints.
    // Preflight both extents above; there is no yield between these writes.
    // Signed priorities retain their two's-complement DWORD representation.
    if (!Mem.writeUint32(out, thread.exitStatus)
        || !Mem.writeUint32(out + 4, thread.tebAddress)
        || !Mem.writeUint32(out + 8, VIRTUAL_CURRENT_PROCESS_ID)
        || !Mem.writeUint32(out + 12, thread.id)
        || !Mem.writeUint32(out + 16, 1) // Existing single-vCPU affinity model.
        || !Mem.writeUint32(out + 20, priority)
        || !Mem.writeUint32(out + 24, thread.relativePriority)) return STATUS_ACCESS_VIOLATION;
    // Deliberately last: ReturnLength may alias any DWORD in the struct.
    if (returnLength && !Mem.writeUint32(returnLength, SIZE)) return STATUS_ACCESS_VIOLATION;
    return 0;
};

const THREAD_BASIC_INFORMATION_CLASS = 0;
const fastArgs = [0, 0, 0, 0, 0];

/**
 * FastPath tier for Nt/ZwQueryInformationThread(ThreadBasicInformation): the same body as the
 * slow path, without the generic dispatch overhead. Mono/Unity runtimes query it on every
 * thread-state check. Other information classes defer to the slow path.
 */
export function registerFastPathThreadInformation(dispatcher: FastPathRegistrar): void {
    const fastPath = (esp: number, view: DataView, mem8: Uint8Array): number | null => {
        if (esp + 24 > mem8.length) return null;
        if (view.getUint32(esp + 8, true) !== THREAD_BASIC_INFORMATION_CLASS) return null;
        for (let i = 0; i < 5; i++) fastArgs[i] = view.getUint32(esp + 4 + (i << 2), true);
        return queryThreadBasicInformation(undefined as never, mem8, fastArgs) as number;
    };
    dispatcher.registerFastPath('ntdll', 'NtQueryInformationThread', fastPath);
    dispatcher.registerFastPath('ntdll', 'ZwQueryInformationThread', fastPath);
}
