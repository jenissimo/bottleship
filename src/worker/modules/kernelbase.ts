/**
 * KERNELBASE.DLL — the host of most kernel32 (and some advapi32/shlwapi) functionality,
 * and of every api-set contract the schema points at it (dll-aliases).
 *
 * One implementation per function: the exports shared with kernel32/advapi32/shlwapi are
 * those modules' own handlers, bound under this module's name; only what exists in
 * kernelbase alone (WaitOnAddress & co., most AppPolicyGet*) is implemented here. Which
 * names appear at all is the descriptor's business (api/kernelbase.api.ts), so
 * GetProcAddress(kernel32, "WaitOnAddress") stays NULL while the api-set lookup succeeds.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { System } from "../core/system";
import { Mem } from "../core/memory/mem-accessor";
import { WAIT_BLOCKED_NO_SWITCH, WAIT_FAILED, WAIT_OBJECT_0 } from "../core/scheduler/types";
import { kernelbaseModule } from "../api/kernelbase.api";
import { appPolicyExport } from "./kernel32/process/vista-system";

const ERROR_INVALID_PARAMETER = 87;
const ERROR_TIMEOUT = 1460;

/** WaitOnAddress: guest address -> the event its waiters park on. */
const addressWaitEvents = new Map<number, number>();

// WaitOnAddress parks on a per-address wake event. Like a condition variable it carries
// no state of its own: a Wake with no waiter is lost, which is the documented contract.
function addressWaitEvent(address: number, create: boolean): number {
    let evt = addressWaitEvents.get(address) ?? 0;
    if (!evt && create) {
        evt = System.getInstance().scheduler.createEvent(false, false);
        addressWaitEvents.set(address, evt);
    }
    return evt;
}

function createKernelbaseOwnExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // BOOL WaitOnAddress(volatile VOID *Address, PVOID CompareAddress, SIZE_T AddressSize, DWORD dwMilliseconds)
    exports["WaitOnAddress"] = (ctx, _mem, args) => {
        const address = args[0] >>> 0;
        const compareAddress = args[1] >>> 0;
        const size = args[2] >>> 0;
        const dwMilliseconds = args[3] >>> 0;
        const sched = System.getInstance().scheduler;

        if (size !== 1 && size !== 2 && size !== 4 && size !== 8) {
            sched.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 16 };
        }
        const current = Mem.readBytes(address, size);
        const expected = Mem.readBytes(compareAddress, size);
        if (!current || !expected) {
            sched.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 16 };
        }
        for (let i = 0; i < size; i++) {
            if (current[i] !== expected[i]) return { value: 1, stackCleanup: 16 };
        }

        const onWake = (waitResult: number) => waitResult === WAIT_OBJECT_0
            ? { value: 1 }
            : { value: 0, lastError: ERROR_TIMEOUT };
        const returnAddr = Mem.readUint32(ctx.esp) ?? 0;
        const result = sched.waitForObjectsWithContext(
            [addressWaitEvent(address, true)], false, dwMilliseconds, returnAddr, ctx.esp + 20,
            { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags },
            false, onWake,
        );
        if (result === WAIT_BLOCKED_NO_SWITCH) {
            return { value: 0, blockedNoSwitch: true, stackCleanup: 16 };
        }
        if (result === WAIT_FAILED) return { value: 0, stackCleanup: 16 };
        const done = onWake(result);
        if (done.lastError !== undefined) sched.setLastError(done.lastError);
        return { value: done.value, stackCleanup: 16 };
    };

    // VOID WakeByAddressSingle(PVOID Address)
    exports["WakeByAddressSingle"] = (_ctx, _mem, args) => {
        const evt = addressWaitEvent(args[0] >>> 0, false);
        if (evt) System.getInstance().scheduler.wakeConditionVariable(evt, false);
        return { value: 0, stackCleanup: 4 };
    };

    // VOID WakeByAddressAll(PVOID Address)
    exports["WakeByAddressAll"] = (_ctx, _mem, args) => {
        const evt = addressWaitEvent(args[0] >>> 0, false);
        if (evt) System.getInstance().scheduler.wakeConditionVariable(evt, true);
        return { value: 0, stackCleanup: 4 };
    };

    exports["AppPolicyGetProcessTerminationMethod"] = appPolicyExport(0); // ExitProcess
    exports["AppPolicyGetThreadInitializationType"] = appPolicyExport(0); // None
    exports["AppPolicyGetShowDeveloperDiagnostic"] = appPolicyExport(1);  // ShowUI

    return exports;
}

/** kernelbase's own handlers, for callers that exercise them without a Process. */
export const kernelbaseOwnExports: Record<string, ThunkImplementation> = createKernelbaseOwnExports();

export class Kernelbase implements IModule {
    name = "kernelbase";
    exports: Record<string, ThunkImplementation> = {};
    private hosts: Array<{ exports: Record<string, ThunkImplementation> }> = [];

    /** The modules whose handlers kernelbase shares, in the descriptor's precedence order. */
    setHosts(hosts: Array<{ exports: Record<string, ThunkImplementation> }>): void {
        this.hosts = hosts;
    }

    /** Must run after the hosts' own initialize, which is what fills their tables. */
    initialize(_process: Process): void {
        for (const key of Object.keys(this.exports)) delete this.exports[key];
        for (const fn of kernelbaseModule.functions) {
            const impl = kernelbaseOwnExports[fn.name]
                ?? this.hosts.map(h => h.exports[fn.name]).find(Boolean);
            if (impl) this.exports[fn.name] = impl;
        }
    }

    reset(): void {
        addressWaitEvents.clear();
    }
}
