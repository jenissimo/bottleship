/**
 * Running a table of guest `void (__cdecl *)(void)` pointers from inside a thunk.
 *
 * The CRT does this in three places — _initterm/_initterm_e over the .CRT$X sections
 * and _execute_onexit_table over a caller-owned onexit table — and all three have the
 * same requirement: the thunk cannot return until every entry has run, but JS cannot
 * call guest code synchronously. The callback manager re-enters the guest at each
 * pointer and chains the next one from the completion, restoring the thunk's own ESP
 * and return address when the last one finishes.
 */

import { Logger, LogCategory } from "../core/logger";
import { getCPU } from "../core/thunking/thunk-utils";
import type { ThunkResult } from "../core/thunking/thunk-dispatcher";
import type { Process } from "../core/process";

/**
 * Call `fns` in order, then resume the caller of the current (cdecl, caller-cleaned)
 * thunk with `result`. Returns the ThunkResult the handler must return: the callback
 * system owns EIP/ESP from here, so the dispatcher must not simulate a RET.
 *
 * `onComplete` runs after the last callback and decides what the chain answers with —
 * a `[[noreturn]]` caller uses it to end the process rather than resume.
 *
 * An empty list is answered immediately.
 */
export function invokeGuestVoidChain(
    process: Process,
    fns: number[],
    label: string,
    result = 0,
    onComplete?: () => number | null,
): ThunkResult {
    if (fns.length === 0) {
        onComplete?.();
        return { value: result, skipStackCheck: true };
    }

    const cpu = getCPU(process.v86);
    if (!cpu) {
        Logger.error(LogCategory.SYSTEM, `${label}: cannot get CPU — ${fns.length} callback(s) skipped`);
        onComplete?.();
        return { value: result, skipStackCheck: true };
    }

    const callbackManager = process.dispatcher.callbackManager;
    callbackManager.saveSuspendedThunkContext({ esp: cpu.reg32[4] >>> 0 }, 0, label);

    let index = 0;
    const step = (): number | null => {
        index++;
        if (index < fns.length) {
            callbackManager.invokeCallback(fns[index], [], 0, step, true, label);
            return null;
        }
        Logger.info(LogCategory.SYSTEM, `${label}: all ${fns.length} callback(s) completed`);
        // `onComplete` may end the process instead of resuming (quick_exit); returning its
        // null then means "nothing to RET to", the same shape the atexit chain finishes in.
        return onComplete ? onComplete() : result;
    };

    callbackManager.invokeCallback(fns[0], [], 0, step, true, label);
    return { value: result, skipStackCheck: true };
}

/** Non-null 32-bit function pointers in [begin, end), the .CRT$X section shape. */
export function readFunctionPointerTable(mem: Uint8Array, begin: number, end: number): number[] {
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const out: number[] = [];
    for (let addr = begin; addr + 4 <= end; addr += 4) {
        const ptr = dv.getUint32(addr, true);
        if (ptr !== 0) out.push(ptr);
    }
    return out;
}
