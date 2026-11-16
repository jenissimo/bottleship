import type { FastPathRegistrar, ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { getCurrentProcessPriorityClass } from '../kernel32/process/process';
import { VIRTUAL_CURRENT_PROCESS_ID } from '../kernel32/process/virtual-process-manager';
import { TEB_OFFSETS } from '../../core/teb-manager';
import type { StubAllocator } from '../../core/thunking/thunk-memory-manager';

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

/** The proof the guest stub relies on: every byte of the thread's [StackLimit, StackBase)
 *  is writable now. Withdrawn by Scheduler.forgetPriorityMirrorsOverlapping on change. */
function stackWritable(system: System, memoryLength: number, teb: number): boolean {
    const stackBase = (Mem.readUint32(teb + TEB_OFFSETS.stackBase) ?? 0) >>> 0;
    const stackLimit = (Mem.readUint32(teb + TEB_OFFSETS.stackLimit) ?? 0) >>> 0;
    return stackLimit < stackBase && writable(system, memoryLength, stackLimit, stackBase - stackLimit);
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
    // The guest stub answers the next calls on this thread from these two TEB words until a
    // priority input changes (Scheduler.forgetPriorityMirror clears the first one).
    if (thread.tebAddress && stackWritable(system, mem.length, thread.tebAddress)) {
        Mem.writeUint32(thread.tebAddress + TEB_OFFSETS.priorityRelative, thread.relativePriority);
        Mem.writeUint32(thread.tebAddress + TEB_OFFSETS.priorityEffective, priority);
    }
    return 0;
};

const CURRENT_THREAD = 0xFFFFFFFE;
const STATUS_PENDING = 0x103;
const STUB_REGION = 256;

/**
 * Trap-free guest x86 for the one shape engines issue thousands of times a second:
 * NtQueryInformationThread(GetCurrentThread(), ThreadBasicInformation, &tbi, 28, &len?)
 * with &tbi (and &len) on the caller's own stack. Everything it writes is already in the
 * calling thread's TEB — Self, ClientId and the priority pair the JS handler mirrors there.
 * Any other handle, class, length, an unaligned or off-stack buffer, or a thread whose mirror
 * is not published yet takes the export's own OUT trap, so the JS handler stays the single
 * definition of every other case (status codes, probing, other threads). The stub skips the
 * probe only under a maintained proof: the handler publishes the mirror only while the whole
 * [StackLimit, StackBase) is writable, and any protect, release or decommit that touches the
 * stack withdraws it (Scheduler.forgetPriorityMirrorsOverlapping). stdcall(5); touches
 * EAX/ECX/EDX and EFLAGS only.
 */
export function writeThreadInformationStub(
    allocator: StubAllocator, getMemory: () => Uint8Array, trapFunctionId: number,
): number {
    const base = allocator.alloc(STUB_REGION, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = base;
    const limit = base + STUB_REGION;
    const room = (n: number) => { if (off + n > limit) throw new Error(`[ntqit-stub] emit past ${STUB_REGION}B`); };
    const w = (...b: number[]) => { room(b.length); for (const x of b) mem[off++] = x & 0xFF; };
    const u32 = (v: number) => { room(4); dv.setUint32(off, v >>> 0, true); off += 4; };
    const traps: number[] = [];
    const toTrap = (cc: number) => { w(0x0F, cc); traps.push(off); u32(0); };       // jcc rel32 -> trap
    const fs = (op: number[], field: number) => { w(0x64, ...op); u32(field); };    // fs: moffs/modrm disp32

    w(0x81, 0x7C, 0x24, 0x04); u32(CURRENT_THREAD); toTrap(0x85);                  // cmp [esp+4],-2 ; jne
    w(0x83, 0x7C, 0x24, 0x08, 0x00); toTrap(0x85);                                   // cmp [esp+8],0  ; jne
    w(0x83, 0x7C, 0x24, 0x10, SIZE); toTrap(0x85);                                   // cmp [esp+16],28; jne
    w(0x8B, 0x54, 0x24, 0x0C);                                                       // mov edx,[esp+12]
    w(0xF6, 0xC2, 0x03); toTrap(0x85);                                               // test dl,3 ; jnz
    fs([0x3B, 0x15], TEB_OFFSETS.stackLimit); toTrap(0x82);                          // cmp edx,fs:[8] ; jb
    w(0x8B, 0xC2, 0x83, 0xC0, SIZE); toTrap(0x82);                                   // mov eax,edx ; add eax,28 ; jc
    fs([0x3B, 0x05], TEB_OFFSETS.stackBase); toTrap(0x87);                           // cmp eax,fs:[4] ; ja
    w(0x8B, 0x4C, 0x24, 0x14);                                                       // mov ecx,[esp+20]
    w(0x85, 0xC9); w(0x74, 0); const noLen = off;                                    // test ecx,ecx ; jz noLen
    w(0xF6, 0xC1, 0x03); toTrap(0x85);                                               // test cl,3 ; jnz
    fs([0x3B, 0x0D], TEB_OFFSETS.stackLimit); toTrap(0x82);                          // cmp ecx,fs:[8] ; jb
    w(0x8B, 0xC1, 0x83, 0xC0, 0x04); toTrap(0x82);                                   // mov eax,ecx ; add eax,4 ; jc
    fs([0x3B, 0x05], TEB_OFFSETS.stackBase); toTrap(0x87);                           // cmp eax,fs:[4] ; ja
    mem[noLen - 1] = (off - noLen) & 0xFF;
    fs([0xA1], TEB_OFFSETS.priorityEffective);                                       // mov eax,fs:[FF8]
    w(0x85, 0xC0); toTrap(0x84);                                                     // test eax,eax ; jz
    w(0xC7, 0x02); u32(STATUS_PENDING);                                              // ExitStatus
    w(0x89, 0x42, 0x14);                                                             // Priority
    fs([0xA1], TEB_OFFSETS.priorityRelative); w(0x89, 0x42, 0x18);                   // BasePriority
    fs([0xA1], TEB_OFFSETS.self); w(0x89, 0x42, 0x04);                               // TebBaseAddress
    fs([0xA1], TEB_OFFSETS.clientIdProcess); w(0x89, 0x42, 0x08);                    // ClientId.UniqueProcess
    fs([0xA1], TEB_OFFSETS.clientIdThread); w(0x89, 0x42, 0x0C);                     // ClientId.UniqueThread
    w(0xC7, 0x42, 0x10); u32(1);                                                     // AffinityMask
    w(0x85, 0xC9); w(0x74, 6); w(0xC7, 0x01); u32(SIZE);                             // ReturnLength last
    w(0x31, 0xC0); w(0xC2, 20, 0);                                                   // STATUS_SUCCESS
    const trap = off;
    w(0xB8); u32(trapFunctionId); w(0xBA, 0x77, 0xB0, 0x00, 0x00); w(0xEF); w(0xC2, 20, 0);
    for (const at of traps) dv.setInt32(at, trap - (at + 4), true);
    return base;
}

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
