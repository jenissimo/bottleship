import { IModule } from "../core/module";
import { Process } from "../core/process";
import { System } from "../core/system";
import { Logger, LogCategory } from "../core/logger";
import { WAIT_BLOCKED_NO_SWITCH, WAIT_IO_COMPLETION } from "../core/scheduler/types";

const CREATE_SUSPENDED = 0x00000004;
const STACK_SIZE_PARAM_IS_A_RESERVATION = 0x00010000;
const STATUS_SUCCESS = 0x00000000;
const STATUS_INVALID_PARAMETER = 0xC000000D;
const HEAP_ZERO_MEMORY = 0x00000008;

export class Ntdll implements IModule {
    name = "ntdll";
    exports: Record<string, (ctx: any, mem: Uint8Array, args: number[]) => any> = {};

    initialize(process: Process): void {
        const system = System.getInstance();

        // Critical section stubs - single-threaded for now
        // NTSTATUS RtlInitializeCriticalSection(PRTL_CRITICAL_SECTION)
        this.exports["RtlInitializeCriticalSection"] = (ctx, mem, args) => {
            // Stub: just return success
            return 0; // STATUS_SUCCESS
        };

        // NTSTATUS RtlInitializeCriticalSectionAndSpinCount(PRTL_CRITICAL_SECTION, ULONG)
        this.exports["RtlInitializeCriticalSectionAndSpinCount"] = (ctx, mem, args) => {
            return 0;
        };

        // NTSTATUS RtlDeleteCriticalSection(PRTL_CRITICAL_SECTION)
        this.exports["RtlDeleteCriticalSection"] = (ctx, mem, args) => {
            return 0;
        };

        // NTSTATUS RtlEnterCriticalSection(PRTL_CRITICAL_SECTION)
        this.exports["RtlEnterCriticalSection"] = (ctx, mem, args) => {
            // Stub: always succeeds (single-threaded assumption)
            return 0;
        };

        // BOOLEAN RtlTryEnterCriticalSection(PRTL_CRITICAL_SECTION)
        this.exports["RtlTryEnterCriticalSection"] = (ctx, mem, args) => {
            return 1; // Always succeeds
        };

        // NTSTATUS RtlLeaveCriticalSection(PRTL_CRITICAL_SECTION)
        this.exports["RtlLeaveCriticalSection"] = (ctx, mem, args) => {
            return 0;
        };

        // PVOID RtlAllocateHeap(PVOID HeapHandle, ULONG Flags, SIZE_T Size)
        this.exports["RtlAllocateHeap"] = (ctx, mem, args) => {
            const flags = args[1] >>> 0;
            const size = args[2] >>> 0;
            const process = system.process;
            if (!process || size === 0) return 0;

            try {
                const address = process.memory.alloc(size);
                if ((flags & HEAP_ZERO_MEMORY) !== 0) {
                    mem.fill(0, address, address + size);
                }
                return address >>> 0;
            } catch {
                return 0;
            }
        };

        // BOOLEAN RtlFreeHeap(PVOID HeapHandle, ULONG Flags, PVOID BaseAddress)
        this.exports["RtlFreeHeap"] = (ctx, mem, args) => {
            const address = args[2] >>> 0;
            const process = system.process;
            if (!process || address === 0) return 0;

            try {
                process.memory.free(address);
                return 1;
            } catch {
                return 0;
            }
        };

        // PVOID RtlReAllocateHeap(PVOID HeapHandle, ULONG Flags, PVOID BaseAddress, SIZE_T Size)
        this.exports["RtlReAllocateHeap"] = (ctx, mem, args) => {
            const flags = args[1] >>> 0;
            const oldAddress = args[2] >>> 0;
            const newSize = args[3] >>> 0;
            const process = system.process;
            if (!process || newSize === 0) return 0;

            try {
                const newAddress = process.memory.alloc(newSize);
                if (oldAddress !== 0) {
                    const oldSize = process.memory.getSize(oldAddress) ?? 0;
                    const copySize = Math.min(oldSize, newSize);
                    if (copySize > 0) {
                        mem.copyWithin(newAddress, oldAddress, oldAddress + copySize);
                    }
                    process.memory.free(oldAddress);
                }
                if ((flags & HEAP_ZERO_MEMORY) !== 0) {
                    mem.fill(0, newAddress, newAddress + newSize);
                }
                return newAddress >>> 0;
            } catch {
                return 0;
            }
        };

        // SIZE_T RtlSizeHeap(PVOID HeapHandle, ULONG Flags, PCVOID BaseAddress)
        this.exports["RtlSizeHeap"] = (ctx, mem, args) => {
            const address = args[2] >>> 0;
            const process = system.process;
            if (!process || address === 0) return 0xFFFFFFFF;
            const size = process.memory.getSize(address);
            return size === undefined ? 0xFFFFFFFF : (size >>> 0);
        };

        // VOID RtlFreeAnsiString(PANSI_STRING)
        this.exports["RtlFreeAnsiString"] = (ctx, mem, args) => {
            const pString = args[0] >>> 0;
            if (pString === 0 || pString + 8 > mem.length) return 0;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const bufferPtr = view.getUint32(pString + 4, true) >>> 0;
            if (bufferPtr !== 0) {
                try {
                    system.process?.memory.free(bufferPtr);
                } catch {
                    // Buffer may point to static memory; ignore in compatibility path.
                }
            }
            view.setUint16(pString + 0, 0, true);
            view.setUint16(pString + 2, 0, true);
            view.setUint32(pString + 4, 0, true);
            return 0;
        };

        // VOID RtlFreeOemString(POEM_STRING)
        this.exports["RtlFreeOemString"] = (ctx, mem, args) => {
            return this.exports["RtlFreeAnsiString"]!(ctx, mem, args);
        };

        // VOID RtlFreeUnicodeString(PUNICODE_STRING)
        this.exports["RtlFreeUnicodeString"] = (ctx, mem, args) => {
            const pString = args[0] >>> 0;
            if (pString === 0 || pString + 8 > mem.length) return 0;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const bufferPtr = view.getUint32(pString + 4, true) >>> 0;
            if (bufferPtr !== 0) {
                try {
                    system.process?.memory.free(bufferPtr);
                } catch {
                    // Buffer may point to static memory; ignore in compatibility path.
                }
            }
            view.setUint16(pString + 0, 0, true);
            view.setUint16(pString + 2, 0, true);
            view.setUint32(pString + 4, 0, true);
            return 0;
        };

        // NTSTATUS RtlCreateUserThread(...)
        this.exports["RtlCreateUserThread"] = (ctx, mem, args) => {
            const processHandle = args[0] >>> 0;
            const createSuspended = (args[2] >>> 0) !== 0;
            const stackReserved = args[4] >>> 0;
            const stackCommit = args[5] >>> 0;
            const startAddress = args[6] >>> 0;
            const startParameter = args[7] >>> 0;
            const outThreadHandlePtr = args[8] >>> 0;
            const outClientIdPtr = args[9] >>> 0;

            // RtlCreateUserThread takes both sizes explicitly, so pass the RESERVE when the
            // caller gave one — the commit only says how much of it starts backed.
            const stackSize = stackReserved || stackCommit || 0;
            const flags = (createSuspended ? CREATE_SUSPENDED : 0)
                | (stackReserved ? STACK_SIZE_PARAM_IS_A_RESERVATION : 0);

            Logger.log(
                LogCategory.KERNEL32,
                `NTDLL:RtlCreateUserThread(start=0x${startAddress.toString(16)}, param=0x${startParameter.toString(16)}, stack=${stackSize}, suspended=${createSuspended ? 1 : 0}, proc=0x${processHandle.toString(16)})`
            );

            const handle = system.scheduler.createThread(
                startAddress,
                startParameter,
                stackSize,
                flags,
                0,
                mem
            );

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            if (outThreadHandlePtr && outThreadHandlePtr + 4 <= mem.length) {
                view.setUint32(outThreadHandlePtr, handle >>> 0, true);
            }

            if (outClientIdPtr && outClientIdPtr + 8 <= mem.length) {
                const tid = system.scheduler.getCurrentThreadId();
                view.setUint32(outClientIdPtr + 0, 1234, true); // process id
                view.setUint32(outClientIdPtr + 4, tid >>> 0, true);
            }

            if (handle === 0) {
                system.scheduler.setLastError(8);
                return 0xC0000017; // STATUS_NO_MEMORY
            }

            return 0; // STATUS_SUCCESS
        };

        // NTSTATUS NtQueueApcThread(HANDLE ThreadHandle, PPS_APC_ROUTINE ApcRoutine, PVOID Arg1, PVOID Arg2, PVOID Arg3)
        this.exports["NtQueueApcThread"] = (ctx, mem, args) => {
            const threadHandle = args[0] >>> 0;
            const routine = args[1] >>> 0;
            const arg0 = args[2] >>> 0;
            const arg1 = args[3] >>> 0;
            const arg2 = args[4] >>> 0;

            if (routine === 0) {
                return STATUS_INVALID_PARAMETER;
            }

            const status = system.scheduler.queueNtApcByHandle(threadHandle, routine, arg0, arg1, arg2);
            return status >>> 0;
        };

        // NTSTATUS NtDelayExecution(BOOLEAN Alertable, PLARGE_INTEGER DelayInterval)
        this.exports["NtDelayExecution"] = (ctx, mem, args) => {
            const alertable = args[0] !== 0;
            const pDelayInterval = args[1] >>> 0;

            if (pDelayInterval === 0 || pDelayInterval + 8 > mem.length) {
                return STATUS_INVALID_PARAMETER;
            }

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const low = BigInt(view.getUint32(pDelayInterval, true));
            const high = BigInt(view.getInt32(pDelayInterval + 4, true));
            const interval = (high << 32n) | low;

            let delayMs = 0;
            if (interval < 0n) {
                delayMs = Number((-interval) / 10000n);
            }

            const returnAddr = view.getUint32(ctx.esp >>> 0, true) >>> 0;
            const postReturnEsp = (ctx.esp + 12) >>> 0; // 4 (ret) + 8 (2 args)

            const result = system.scheduler.sleepWithContext(
                delayMs >>> 0,
                returnAddr,
                postReturnEsp,
                { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags },
                alertable
            );

            if (result === WAIT_BLOCKED_NO_SWITCH) {
                return { value: STATUS_SUCCESS, blockedNoSwitch: true, stackCleanup: 8 };
            }
            if (result === WAIT_IO_COMPLETION) {
                return WAIT_IO_COMPLETION;
            }
            return STATUS_SUCCESS;
        };
    }
}
