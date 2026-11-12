/**
 * Kernel32 fibers: ConvertThreadToFiber(Ex), CreateFiber(Ex), SwitchToFiber, DeleteFiber,
 * ConvertFiberToThread.
 *
 * A fiber is a saved register file plus a stack, switched cooperatively on the calling
 * thread. The scheduler never sees it: the thread keeps its id, TEB and handle, only ESP
 * moves to another stack (the scheduler and the ESP tripwires already tolerate that).
 *
 * The fiber object lives in guest memory because the guest reads it directly:
 * GetCurrentFiber() is `mov eax, fs:[0x10]` and GetFiberData() is `*(void**)GetCurrentFiber()`,
 * both inline in the SDK headers. So TEB.FiberData points at the object and its first
 * dword is the fiber's parameter.
 *
 * SwitchToFiber follows the setjmp/longjmp contract the thunk stub already supports: the
 * handler swaps the callee-saved registers and ESP, and the stub's own `RET 4` then pops
 * the target's return address and argument slot. A fiber that has never run is given a
 * stack shaped the same way, so that RET lands on its start routine with the parameter in
 * place and the thread-exit stub as its return address (a fiber routine that returns ends
 * the thread, as on Windows).
 */

import { ThunkImplementation, ThunkResult } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Mem } from '../../core/memory/mem-accessor';
import { System } from '../../core/system';
import { getCPU } from '../../core/thunking/thunk-utils';
import { cpuViews } from '../../core/cpu/cpu-views';
import { invalidateGuestCode } from '../../core/memory/guest-code';
import { threadStackReserve } from '../../core/scheduler/types';

const ERROR_ALREADY_FIBER = 1280;
const ERROR_ALREADY_THREAD = 1281;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NOT_ENOUGH_MEMORY = 8;

// Fiber object layout (guest memory). Offset 0 is fixed by GetFiberData().
const F_DATA = 0x00;
const F_EXCEPTION_LIST = 0x04;
const F_STACK_BASE = 0x08;     // top of the stack (TEB.StackBase)
const F_STACK_LIMIT = 0x0C;    // bottom of the stack (TEB.StackLimit)
const F_EBX = 0x10;
const F_ESI = 0x14;
const F_EDI = 0x18;
const F_EBP = 0x1C;
const F_ESP = 0x20;
const F_MAGIC = 0x24;
const F_STACK_ALLOC = 0x28;    // scheduler stack block (allocateStack); 0 for a fiber made from a thread
const F_FLAGS = 0x2C;
const F_STACK_SIZE = 0x30;     // size passed to allocateStack, needed to give the block back
const FIBER_SIZE = 0x40;

const FIBER_MAGIC = 0x52424946;
const FLAG_THREAD_FIBER = 1;

// TEB (NT_TIB) fields a fiber owns.
const TEB_EXCEPTION_LIST = 0x00;
const TEB_STACK_BASE = 0x04;
const TEB_STACK_LIMIT = 0x08;
const TEB_FIBER_DATA = 0x10;

const DEFAULT_STACK_RESERVE = 0x100000;
const MAX_STACK = 0x40000000;

// @transient(identity of the owning process object)
let fiberOwner: unknown = null;
// @transient(identity of the owning process object)
let fiberOwnerResetGeneration = -1;
// @transient(guest code allocated per process)
let retStub = 0;

function ensureProcessLocal(): void {
    const process = System.getInstance().process;
    const gen = process?.resetGeneration ?? 0;
    if (process === fiberOwner && gen === fiberOwnerResetGeneration) return;
    fiberOwner = process;
    fiberOwnerResetGeneration = gen;
    retStub = 0;
}

export function resetFiberState(): void {
    fiberOwner = null;
    fiberOwnerResetGeneration = -1;
    retStub = 0;
}

/**
 * A guest `RET 4`. SwitchToFiber leaves ESP at the target's [return address, argument]
 * pair and points EIP here, so the target resumes the same way whether the dispatcher
 * continues at the new EIP or runs the thunk stub's own `RET 4` first.
 */
function ensureRetStub(): number {
    if (retStub && Mem.readUint8(retStub) === 0xC2 && Mem.readUint8(retStub + 1) === 0x04 && Mem.readUint8(retStub + 2) === 0x00) return retStub;
    const process = System.getInstance().process;
    if (!process) return 0;
    try { retStub = process.memory.alloc(16, 'THUNK_DATA') >>> 0; } catch { return 0; }
    Mem.writeUint8(retStub, 0xC2);
    Mem.writeUint8(retStub + 1, 0x04);
    Mem.writeUint8(retStub + 2, 0x00);
    invalidateGuestCode(retStub, 16);
    return retStub;
}

function rd(addr: number): number {
    return (Mem.readUint32(addr) ?? 0) >>> 0;
}

function setLastError(code: number): void {
    System.getInstance().scheduler.setLastError(code);
}

function isFiber(fiber: number): boolean {
    return fiber !== 0 && rd(fiber + F_MAGIC) === FIBER_MAGIC;
}

function tebAddress(cpu: any): number {
    return (cpuViews(cpu).segmentOffsets[4] ?? 0) >>> 0;
}

function newFiberObject(param: number): number {
    const process = System.getInstance().process;
    if (!process) return 0;
    let fiber: number;
    try { fiber = process.memory.alloc(FIBER_SIZE) >>> 0; } catch { return 0; }
    for (let off = 0; off < FIBER_SIZE; off += 4) Mem.writeUint32(fiber + off, 0);
    Mem.writeUint32(fiber + F_DATA, param >>> 0);
    Mem.writeUint32(fiber + F_MAGIC, FIBER_MAGIC);
    return fiber;
}

function convertThreadToFiber(param: number): number {
    ensureProcessLocal();
    const cpu = getCPU(System.getInstance().process?.v86);
    const teb = cpu ? tebAddress(cpu) : 0;
    if (!teb) return 0;
    const current = rd(teb + TEB_FIBER_DATA);
    if (isFiber(current)) {
        setLastError(ERROR_ALREADY_FIBER);
        return 0;
    }
    const fiber = newFiberObject(param);
    if (!fiber) { setLastError(ERROR_NOT_ENOUGH_MEMORY); return 0; }
    Mem.writeUint32(fiber + F_STACK_BASE, rd(teb + TEB_STACK_BASE));
    Mem.writeUint32(fiber + F_STACK_LIMIT, rd(teb + TEB_STACK_LIMIT));
    Mem.writeUint32(fiber + F_FLAGS, FLAG_THREAD_FIBER);
    Mem.writeUint32(teb + TEB_FIBER_DATA, fiber);
    Logger.log(LogCategory.KERNEL32, `ConvertThreadToFiber(param=0x${param.toString(16)}) -> 0x${fiber.toString(16)}`);
    return fiber;
}

function createFiber(stackCommit: number, stackReserve: number, start: number, param: number): number {
    ensureProcessLocal();
    const system = System.getInstance();
    const process = system.process;
    if (!process || !start) { setLastError(ERROR_INVALID_PARAMETER); return 0; }
    const reserve = (stackReserve >>> 0) || system.scheduler.getImageStackReserve();
    const size = threadStackReserve(stackCommit >>> 0, 0, reserve, DEFAULT_STACK_RESERVE);
    // The scheduler's thread-stack path: NOACCESS guard page below, so an overflow faults
    // instead of landing in the neighbouring allocation, and a pooled block is re-zeroed.
    const stack = size <= MAX_STACK ? system.scheduler.allocateStack(size) >>> 0 : 0;
    if (!stack) { setLastError(ERROR_NOT_ENOUGH_MEMORY); return 0; }
    const fiber = newFiberObject(param);
    if (!fiber) { system.scheduler.releaseStackBlock(stack, size); setLastError(ERROR_NOT_ENOUGH_MEMORY); return 0; }

    const top = (stack + size) >>> 0;
    // [esp]   start routine     ← popped by SwitchToFiber's RET 4
    // [esp+4] argument slot     ← discarded by that RET 4
    // [esp+8] thread-exit stub  ← the start routine's return address
    // [esp+12] lpParameter      ← its argument
    const exitStub = system.scheduler.getThreadExitStubAddress();
    const esp = (top - 16) >>> 0;
    Mem.writeUint32(esp, start >>> 0);
    Mem.writeUint32(esp + 4, 0);
    Mem.writeUint32(esp + 8, exitStub >>> 0);
    Mem.writeUint32(esp + 12, param >>> 0);

    Mem.writeUint32(fiber + F_EXCEPTION_LIST, 0xFFFFFFFF);
    Mem.writeUint32(fiber + F_STACK_BASE, top);
    Mem.writeUint32(fiber + F_STACK_LIMIT, stack);
    Mem.writeUint32(fiber + F_ESP, esp);
    Mem.writeUint32(fiber + F_STACK_ALLOC, stack);
    Mem.writeUint32(fiber + F_STACK_SIZE, size);
    Logger.log(LogCategory.KERNEL32,
        `CreateFiber(stack=0x${size.toString(16)}, start=0x${start.toString(16)}, param=0x${param.toString(16)}) -> 0x${fiber.toString(16)}`);
    return fiber;
}

export const exports: Record<string, ThunkImplementation> = {
    'ConvertThreadToFiber': (_ctx, _mem, args) => convertThreadToFiber(args[0] ?? 0),
    'ConvertThreadToFiberEx': (_ctx, _mem, args) => convertThreadToFiber(args[0] ?? 0),

    'CreateFiber': (_ctx, _mem, args) => createFiber(args[0] ?? 0, 0, args[1] ?? 0, args[2] ?? 0),
    // CreateFiberEx(dwStackCommitSize, dwStackReserveSize, dwFlags, lpStartAddress, lpParameter)
    'CreateFiberEx': (_ctx, _mem, args) =>
        createFiber(args[0] ?? 0, args[1] ?? 0, args[3] ?? 0, args[4] ?? 0),

    'SwitchToFiber': (_ctx, _mem, args): ThunkResult | number => {
        ensureProcessLocal();
        const target = (args[0] ?? 0) >>> 0;
        const cpu = getCPU(System.getInstance().process?.v86);
        if (!cpu?.reg32) return 0;
        const teb = tebAddress(cpu);
        if (!teb || !isFiber(target)) {
            Logger.warn(LogCategory.KERNEL32, `SwitchToFiber(0x${target.toString(16)}): not a fiber`);
            return 0;
        }
        const current = rd(teb + TEB_FIBER_DATA);
        if (current === target) return 0;
        const stub = ensureRetStub();
        if (!stub) return 0;
        const views = cpuViews(cpu);
        const reg = views.reg32;
        if (isFiber(current)) {
            Mem.writeUint32(current + F_EBX, reg[3] >>> 0);
            Mem.writeUint32(current + F_ESI, reg[6] >>> 0);
            Mem.writeUint32(current + F_EDI, reg[7] >>> 0);
            Mem.writeUint32(current + F_EBP, reg[5] >>> 0);
            Mem.writeUint32(current + F_ESP, reg[4] >>> 0);
            Mem.writeUint32(current + F_EXCEPTION_LIST, rd(teb + TEB_EXCEPTION_LIST));
            Mem.writeUint32(current + F_STACK_BASE, rd(teb + TEB_STACK_BASE));
            Mem.writeUint32(current + F_STACK_LIMIT, rd(teb + TEB_STACK_LIMIT));
        }
        Mem.writeUint32(teb + TEB_EXCEPTION_LIST, rd(target + F_EXCEPTION_LIST));
        Mem.writeUint32(teb + TEB_STACK_BASE, rd(target + F_STACK_BASE));
        Mem.writeUint32(teb + TEB_STACK_LIMIT, rd(target + F_STACK_LIMIT));
        Mem.writeUint32(teb + TEB_FIBER_DATA, target);
        const esp = rd(target + F_ESP);
        reg[3] = rd(target + F_EBX) | 0;
        reg[6] = rd(target + F_ESI) | 0;
        reg[7] = rd(target + F_EDI) | 0;
        reg[5] = rd(target + F_EBP) | 0;
        reg[4] = esp | 0;
        views.instructionPointer[0] = stub;
        return { value: 0, skipStackCheck: true };
    },

    'DeleteFiber': (_ctx, _mem, args): ThunkResult | number => {
        ensureProcessLocal();
        const fiber = (args[0] ?? 0) >>> 0;
        if (!isFiber(fiber)) return 0;
        const system = System.getInstance();
        const process = system.process;
        const cpu = getCPU(process?.v86);
        const teb = cpu ? tebAddress(cpu) : 0;
        const stackAlloc = rd(fiber + F_STACK_ALLOC);
        if (cpu && teb && rd(teb + TEB_FIBER_DATA) === fiber) {
            // Deleting the running fiber ends the thread with exit code 1 (RtlExitUserThread(1)).
            // The thread is still on this fiber's stack, so the stack is left allocated.
            const stub = ensureRetStub();
            const exitStub = system.scheduler.getThreadExitStubAddress();
            if (!stub || !exitStub) return 0;
            const views = cpuViews(cpu);
            Mem.writeUint32(fiber + F_MAGIC, 0);
            Mem.writeUint32(teb + TEB_FIBER_DATA, 0);
            process?.memory.free(fiber);
            Mem.writeUint32(views.reg32[4] >>> 0, exitStub >>> 0);
            views.instructionPointer[0] = stub;
            return { value: 1, skipStackCheck: true };
        }
        Mem.writeUint32(fiber + F_MAGIC, 0);
        if (stackAlloc) system.scheduler.releaseStackBlock(stackAlloc, rd(fiber + F_STACK_SIZE));
        process?.memory.free(fiber);
        return 0;
    },

    'ConvertFiberToThread': () => {
        ensureProcessLocal();
        const process = System.getInstance().process;
        const cpu = getCPU(process?.v86);
        const teb = cpu ? tebAddress(cpu) : 0;
        if (!teb) return 0;
        const fiber = rd(teb + TEB_FIBER_DATA);
        if (!isFiber(fiber) || (rd(fiber + F_FLAGS) & FLAG_THREAD_FIBER) === 0) { setLastError(ERROR_ALREADY_THREAD); return 0; }
        Mem.writeUint32(fiber + F_MAGIC, 0);
        Mem.writeUint32(teb + TEB_FIBER_DATA, 0);
        process?.memory.free(fiber);
        return 1;
    },

    'IsThreadAFiber': () => {
        ensureProcessLocal();
        const cpu = getCPU(System.getInstance().process?.v86);
        const teb = cpu ? tebAddress(cpu) : 0;
        return teb && isFiber(rd(teb + TEB_FIBER_DATA)) ? 1 : 0;
    },
};
