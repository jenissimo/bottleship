/**
 * User32 Hook Registry
 *
 * Stores installed hooks (SetWindowsHookEx) and provides lookup by type.
 * Dispatched hook types: WH_CBT (MFC dialog/window creation), WH_KEYBOARD
 * (fired from GetMessage/PeekMessage on WM_(SYS)KEYDOWN/KEYUP retrieval), and
 * WH_GETMESSAGE (fired from Get/PeekMessage on ANY message about to be returned).
 */

export const WH_KEYBOARD = 2;
export const WH_GETMESSAGE = 3;
export const WH_CBT = 5;
export const HCBT_CREATEWND = 3;
export const HC_ACTION = 0;
export const HC_NOREMOVE = 3;

export interface HookRegistration {
    handle: number;
    idHook: number;
    lpfn: number;      // x86 callback address
    hMod: number;
    dwThreadId: number;
}

// @participant(user32)
let nextHookHandle = 1;
// @participant(user32)
const hooksByHandle = new Map<number, HookRegistration>();
// @participant(user32)
const hookTypeCounts = new Map<number, number>();

export function installHook(idHook: number, lpfn: number, hMod: number, dwThreadId: number): number {
    const handle = nextHookHandle++;
    hooksByHandle.set(handle, { handle, idHook, lpfn, hMod, dwThreadId });
    hookTypeCounts.set(idHook, (hookTypeCounts.get(idHook) ?? 0) + 1);
    return handle;
}

export function uninstallHook(handle: number): boolean {
    const reg = hooksByHandle.get(handle);
    if (reg) hookTypeCounts.set(reg.idHook, (hookTypeCounts.get(reg.idHook) ?? 1) - 1);
    return hooksByHandle.delete(handle);
}

/** O(1) presence check — safe to call on hot paths (PeekMessage). */
export function hasHooksOfType(idHook: number): boolean {
    return (hookTypeCounts.get(idHook) ?? 0) > 0;
}

/** Returns hooks of given type in LIFO order (last installed fires first). */
export function getHooksOfType(idHook: number): HookRegistration[] {
    const result: HookRegistration[] = [];
    for (const reg of hooksByHandle.values()) {
        if (reg.idHook === idHook) result.push(reg);
    }
    result.reverse();
    return result;
}

/**
 * Chain traversal for CallNextHookEx: given the handle of the hook that is currently
 * executing, return the NEXT hook in its chain — the one installed just BEFORE it.
 * Hooks fire most-recently-installed first; CallNextHookEx passes control one step
 * DOWN the chain. Filtered to hooks visible on the calling thread (dwThreadId 0 =
 * global, fires on every thread). Returns undefined at the end of the chain, or when
 * `handle` is 0/unknown/stale (all of which mean "no next hook → default processing").
 */
export function getNextHookInChain(handle: number, threadId: number): HookRegistration | undefined {
    const cur = hooksByHandle.get(handle);
    if (!cur) return undefined;
    const chain = getHooksOfType(cur.idHook).filter(h => h.dwThreadId === 0 || h.dwThreadId === threadId);
    const pos = chain.findIndex(h => h.handle === handle);
    if (pos < 0) return undefined;
    return chain[pos + 1];
}

// Active-hook call stack: handles of hook procs currently executing (innermost last).
// CallNextHookEx consults this to identify the CURRENT hook when the guest passes NULL
// for hhk — the modern "hhk is ignored" idiom. Real Windows tracks the current hook
// per-thread internally rather than via the hhk argument; we mirror that here. Hook
// chains run synchronously on a single pinned thread (the suspended-frame pin blocks
// preemption), so one global stack is sufficient — no per-thread keying needed.
// @refuse(a hook procedure is running)
const activeHookStack: number[] = [];

/** Mark `handle`'s proc as the innermost executing hook (call before invoking it). */
export function pushActiveHook(handle: number): void {
    activeHookStack.push(handle >>> 0);
}

/** Pop the innermost executing hook (call when its proc returns / invoke fails). */
export function popActiveHook(): void {
    activeHookStack.pop();
}

/** Handle of the hook proc currently executing (0 = none tracked). */
export function currentActiveHook(): number {
    return activeHookStack.length > 0 ? activeHookStack[activeHookStack.length - 1] : 0;
}

export function resetHooks(): void {
    hooksByHandle.clear();
    hookTypeCounts.clear();
    activeHookStack.length = 0;
    nextHookHandle = 1;
}

export interface HookState { hooks: HookRegistration[]; nextHookHandle: number }

export function captureHooks(): HookState {
    if (activeHookStack.length > 0) throw new Error('user32: a hook procedure is running');
    return { hooks: [...hooksByHandle.values()].map(h => ({ ...h })), nextHookHandle };
}

export function restoreHooks(s: HookState): void {
    hooksByHandle.clear();
    hookTypeCounts.clear();
    for (const h of s.hooks) {
        hooksByHandle.set(h.handle, { ...h });
        hookTypeCounts.set(h.idHook, (hookTypeCounts.get(h.idHook) ?? 0) + 1);
    }
    nextHookHandle = s.nextHookHandle;
    activeHookStack.length = 0;
}
