/**
 * Guest-code writes — the ONE sanctioned way for JS to publish bytes the guest will execute.
 *
 * v86 caches JIT-compiled basic blocks per 4 KiB physical page and only drops them when it
 * observes a *guest* store into that page. A JS-side write through `mem8` is invisible to it,
 * so the CPU happily keeps running the block it compiled from the old bytes. v86's own
 * `CPU.write_blob` reflects the same contract (it calls `jit_dirty_cache` before `mem8.set`);
 * anything that writes code around it must do the same or it inherits the stale-block bug.
 *
 * The failure is silent and non-local: our thunk stubs are bump-allocated 16 bytes apart, so a
 * stub published into a page that already holds executing stubs can be entered through a cached
 * block belonging to a *different* stub — the dispatcher then runs the wrong WinAPI handler with
 * the caller's arguments. Matching `ret N` ⇒ a thread that spins forever; differing `ret N` ⇒
 * ESP drift ⇒ a wild `ret` into stack data ⇒ #GP.
 *
 * Use {@link writeGuestCode} for bulk writes and {@link invalidateGuestCode} for emitters that
 * assemble bytes in place. Both bump allocators that hand out executable guest memory
 * (`ThunkGenerator`, `MemoryManager` for executable kinds) invalidate what they hand out, so an
 * emitter that forgets is still covered — the guest cannot run between a JS allocation and the
 * JS write that fills it.
 */

import { preemptionManager } from "../cpu/preemption-manager";

/** Ranges seen before a wasm instance existed, replayed on the first successful resolve. */
const pending: number[] = [];
const PENDING_CAP = 4096;

let invalidatedRanges = 0;
let invalidatedBytes = 0;

/**
 * Resolve `jit_dirty_cache` fresh on every call. v86 is re-created per game load, so a cached
 * function object would dirty a dead wasm instance's JIT state while the live one keeps its
 * stale blocks. Bracket notation is mandatory — Closure Compiler renames dot-notation
 * properties on v86 objects.
 */
function resolveDirtyCache(): ((start: number, end: number) => void) | null {
    const exports = preemptionManager.getWasmExports();
    const fn = exports && exports["jit_dirty_cache"];
    return typeof fn === "function" ? fn : null;
}

/**
 * Drop v86's compiled blocks for `[address, address + length)`. Call after ANY JS write of
 * bytes the guest may execute — including in-place patches of code that is already live.
 *
 * Returns false only when no wasm instance exists yet; in that case there is no JIT cache to
 * drop, and the range is replayed once one appears.
 */
export function invalidateGuestCode(address: number, length: number): boolean {
    if (length <= 0) return true;
    // Diagnostic A/B only (`setWorkerFlag('__noCodeInvalidate', true)` before a load):
    // reproduces the stale-block failure on demand so a suspected staleness bug can be
    // confirmed instead of argued. Never a shipping configuration.
    if ((globalThis as { __noCodeInvalidate?: boolean }).__noCodeInvalidate) return true;
    const start = address >>> 0;
    const end = (start + length) >>> 0;
    if (end <= start) return true; // 4 GiB wrap — nothing sane to dirty

    // Diagnostic A/B: escalate every publication to a full cache clear. If a title
    // survives this but not the ranged dirty, the call sites are right and the fork's
    // page-level invalidation is leaving something behind (chained/speculated edges).
    if ((globalThis as { __codeInvalidateGlobal?: boolean }).__codeInvalidateGlobal) {
        const exports = preemptionManager.getWasmExports();
        const clear = exports && exports["jit_clear_cache_js"];
        if (typeof clear === "function") { clear(); invalidatedRanges++; return true; }
    }

    const dirty = resolveDirtyCache();
    if (!dirty) {
        if (pending.length < PENDING_CAP) pending.push(start, end);
        return false;
    }

    for (let i = 0; i < pending.length; i += 2) {
        try { dirty(pending[i]!, pending[i + 1]!); } catch { /* stale range, non-fatal */ }
    }
    pending.length = 0;

    try {
        dirty(start, end);
    } catch {
        return false;
    }
    invalidatedRanges++;
    invalidatedBytes += end - start;
    return true;
}

/**
 * Write guest-executable bytes and invalidate the range in one step — argument order mirrors
 * `mem.set(bytes, address)` so it reads as a drop-in for the raw write it replaces.
 *
 * Returns false if the write would run past the end of guest memory (nothing is written).
 */
export function writeGuestCode(mem: Uint8Array, bytes: Uint8Array, address: number): boolean {
    const start = address >>> 0;
    if (bytes.length === 0) return true;
    if (start + bytes.length > mem.length) return false;
    mem.set(bytes, start);
    invalidateGuestCode(start, bytes.length);
    return true;
}

/**
 * Diagnostic counters (harness `codeInvalidations`). `wired:false` — or a flat `ranges`
 * while stubs are being published — means the invariant is silently off; check that before
 * theorising about the guest.
 */
export function guestCodeInvalidationStats(): { wired: boolean; ranges: number; bytes: number; deferred: number } {
    return {
        wired: resolveDirtyCache() !== null,
        ranges: invalidatedRanges,
        bytes: invalidatedBytes,
        deferred: pending.length >> 1,
    };
}

/** Test hook — drops replay state and counters between cases. */
export function resetGuestCodeInvalidationState(): void {
    pending.length = 0;
    invalidatedRanges = 0;
    invalidatedBytes = 0;
}
