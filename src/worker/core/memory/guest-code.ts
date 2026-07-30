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
 * Audit mode (harness `codeAudit`): the set of 4 KiB pages this chokepoint has dirtied
 * since the last audit sweep. A page whose bytes changed WITHOUT appearing here was
 * written by something that bypassed the chokepoint — i.e. the missing call site.
 * Off (null) unless the sweep armed it, so the hot path pays one null check.
 */
let auditCovered: Set<number> | null = null;

/** Arm/disarm the audit page set. Returns the pages covered since the previous call. */
export function takeGuestCodeAuditPages(arm: boolean): number[] {
    const prev = auditCovered ? [...auditCovered] : [];
    auditCovered = arm ? new Set() : null;
    return prev;
}

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

    if (auditCovered) {
        for (let p = start >>> 12; p <= (end - 1) >>> 12; p++) auditCovered.add(p);
    }

    // Diagnostic A/B: escalate every publication to a full cache clear.
    //
    // Read the result NARROWLY. `jit_clear_cache` is literally `jit_dirty_page_ctx` over
    // every page that has code, so it cannot invalidate anything a ranged dirty leaves
    // behind on the SAME page — the only two things it adds are (a) pages nobody named and
    // (b) a JIT that never stays warm. (b) is not a coherence property: a title that
    // survives only under this flag may simply be one whose hot modules never reach the
    // tier-2 re-entry threshold, and free-running tiering is what actually breaks it.
    // Before concluding "a call site is missing", confirm with `codeAudit` (which names the
    // page and the writer) and rule out tiering with `dbgCall('jitTier2', 0)` — JIT ON,
    // invalidation unchanged, no cache clear, promotion off. Two titles read as a missing
    // call site on this flag alone and neither was: House of 1000 Doors and Blade of
    // Darkness both come back on `jitTier2(0)`, and BoD reaches its tutorial level that way.
    if ((globalThis as { __codeInvalidateGlobal?: boolean }).__codeInvalidateGlobal) {
        const exports = preemptionManager.getWasmExports();
        const clear = exports && exports["jit_clear_cache_js"];
        if (typeof clear === "function") { clear(); invalidatedRanges++; return true; }
    }

    // Diagnostic A/B (`setWorkerFlag('__codeInvalidatePadPages', n)`): widen every dirty by
    // n pages on each side. Separates "the written page was dirtied but the code that
    // depended on it lives in a module spanning NEIGHBOURING pages" from the two things a
    // full clear also does (drop unrelated pages, keep the JIT permanently cold). A title
    // that needs the pad but not the full clear is describing a page→module bookkeeping
    // gap, not a missing call site.
    const pad = (globalThis as { __codeInvalidatePadPages?: number }).__codeInvalidatePadPages;
    const padded = typeof pad === "number" && pad > 0;
    const lo = padded ? Math.max(0, start - pad * 0x1000) >>> 0 : start;
    const hi = padded ? (end + pad * 0x1000) >>> 0 : end;

    const dirty = resolveDirtyCache();
    if (!dirty) {
        if (pending.length < PENDING_CAP) pending.push(lo, hi);
        return false;
    }

    for (let i = 0; i < pending.length; i += 2) {
        try { dirty(pending[i]!, pending[i + 1]!); } catch { /* stale range, non-fatal */ }
    }
    pending.length = 0;

    try {
        dirty(lo, hi);
    } catch {
        return false;
    }
    invalidatedRanges++;
    invalidatedBytes += end - start;
    return true;
}

/**
 * Drop every compiled block. Only for the case where the caller genuinely does not know the
 * range — `FlushInstructionCache(h, NULL, 0)` means "the whole process" per the SDK. Prefer
 * {@link invalidateGuestCode}: a full clear costs the guest every hot block it had.
 */
export function invalidateAllGuestCode(): boolean {
    const exports = preemptionManager.getWasmExports();
    const clear = exports && exports["jit_clear_cache_js"];
    if (typeof clear !== "function") return false;
    try { clear(); } catch { return false; }
    invalidatedRanges++;
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
