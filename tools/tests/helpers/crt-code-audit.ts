import {preemptionManager} from "../../../src/worker/core/cpu/preemption-manager";
import {resetGuestCodeInvalidationState, takeGuestCodeAuditPages} from "../../../src/worker/core/memory/guest-code";

/** Exercise the real publication owner; only the WASM cache callback is recorded. */
export function crtCodeAudit(dispatcher: any) {
    const manager = preemptionManager as unknown as {wasmExports: unknown};
    const saved = manager.wasmExports, originalFault = dispatcher.setupGuestAccessViolationDispatch;
    const ranges: Array<{start: number; end: number}> = [];
    let beforeFault: number[] = [];
    let faultRangeCount = 0;
    resetGuestCodeInvalidationState(); takeGuestCodeAuditPages(true);
    manager.wasmExports = {jit_dirty_cache(start: number, end: number) {
        ranges.push({start, end});
    }};
    dispatcher.setupGuestAccessViolationDispatch = function(...args: unknown[]) {
        beforeFault = takeGuestCodeAuditPages(true);
        faultRangeCount = ranges.length;
        return originalFault.apply(this, args);
    };
    return {ranges,
        beforeFault: () => beforeFault,
        beforeFaultRanges: () => ranges.slice(0, faultRangeCount),
        pages: () => [...new Set([...beforeFault, ...takeGuestCodeAuditPages(false)])].sort((a, b) => a - b),
        restore() {
            dispatcher.setupGuestAccessViolationDispatch = originalFault;
            manager.wasmExports = saved;
            takeGuestCodeAuditPages(false); resetGuestCodeInvalidationState();
        },
    };
}
