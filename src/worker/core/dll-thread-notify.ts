import type { ModuleRegistry } from "./module-registry";

/**
 * DLL_THREAD_ATTACH / DLL_THREAD_DETACH: Windows calls every loaded DLL's entry point when
 * a thread starts and again when it exits, in initialization order on attach and in reverse
 * on detach, except for DLLs that called DisableThreadLibraryCalls. Some libraries depend on
 * it: the Boehm GC inside Unity's mono.dll registers a thread only from its DllMain and later
 * aborts ("Thread %d calling into managed code is not registered with the GC") when an
 * unregistered thread calls into managed code.
 *
 * The calls are laid out as a return chain on the thread's own stack: each entry point's
 * return address is the next entry point, followed by its three arguments, and the last one
 * returns into the code that would have run without notifications. No host callback frame is
 * involved, so the chain is ordinary guest execution.
 */

export const DLL_THREAD_ATTACH = 2;
export const DLL_THREAD_DETACH = 3;

// @transient(load order of the running process's DLLs; a module restored from a savestate without a recorded position keeps registry order)
const initOrder: number[] = [];
// @transient(DisableThreadLibraryCalls of the running process; a savestate restore drops it and those DLLs are notified again)
const disabled = new Set<number>();
// @transient(threads that received DLL_THREAD_ATTACH and still owe DLL_THREAD_DETACH; a savestate restore drops it)
const attachedThreads = new Set<number>();

export interface ThreadNotifyTarget {
    base: number;
    entry: number;
}

export function resetDllThreadNotify(): void {
    initOrder.length = 0;
    disabled.clear();
    attachedThreads.clear();
}

/** A DLL's DllMain(DLL_PROCESS_ATTACH) was queued: it takes its place in initialization order. */
export function noteDllInitialized(base: number): void {
    const at = initOrder.indexOf(base >>> 0);
    if (at >= 0) initOrder.splice(at, 1);
    initOrder.push(base >>> 0);
}

/** A DLL was unloaded: it leaves the order, and its DisableThreadLibraryCalls goes with it. */
export function noteDllUnloaded(base: number): void {
    const at = initOrder.indexOf(base >>> 0);
    if (at >= 0) initOrder.splice(at, 1);
    disabled.delete(base >>> 0);
}

export function disableThreadLibraryCalls(base: number): void {
    disabled.add(base >>> 0);
}

/** The entry points to notify, in initialization order (reverse it for detach). */
export function threadNotifyTargets(registry: ModuleRegistry): ThreadNotifyTarget[] {
    const rank = new Map(initOrder.map((base, i) => [base, i]));
    return registry.getAllModules()
        .filter(m => m.isRealDll && !m.isExecutable && m.initialized && m.entryPoint !== 0
            && !disabled.has(m.baseAddress >>> 0))
        .sort((a, b) => (rank.get(a.baseAddress >>> 0) ?? Infinity) - (rank.get(b.baseAddress >>> 0) ?? Infinity))
        .map(m => ({ base: m.baseAddress >>> 0, entry: (m.baseAddress + m.entryPoint) >>> 0 }));
}

export function markThreadAttached(threadId: number): void {
    attachedThreads.add(threadId);
}

/** True once for a thread that got DLL_THREAD_ATTACH: its detach is now being delivered. */
export function takeThreadDetach(threadId: number): boolean {
    return attachedThreads.delete(threadId);
}

/**
 * Write the call chain below `top` and return the ESP to start it with (EIP = targets[0].entry).
 * After the last entry point returns, execution continues at `finalReturn` with `finalWords`
 * on the stack, exactly as if it had been entered directly.
 */
export function layNotifyChain(
    view: DataView, top: number, targets: readonly ThreadNotifyTarget[], reason: number,
    finalReturn: number, finalWords: readonly number[],
): number {
    const words: number[] = [];
    targets.forEach((t, i) => {
        words.push(i + 1 < targets.length ? targets[i + 1]!.entry : finalReturn, t.base, reason, 0);
    });
    words.push(...finalWords);
    const esp = ((top - words.length * 4) & ~3) >>> 0;
    words.forEach((w, i) => view.setUint32(esp + i * 4, w >>> 0, true));
    return esp;
}

/** The same chain entered by RET instead of a jump: the returned ESP holds targets[0].entry. */
export function layNotifyChainForRet(
    view: DataView, top: number, targets: readonly ThreadNotifyTarget[], reason: number,
    finalReturn: number, finalWords: readonly number[],
): number {
    const esp = (layNotifyChain(view, top, targets, reason, finalReturn, finalWords) - 4) >>> 0;
    view.setUint32(esp, targets[0]!.entry >>> 0, true);
    return esp;
}
