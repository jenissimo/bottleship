/**
 * Guest-memory normalization.
 *
 * v86's fork wraps guest RAM (`cpu.mem8`) in a **Proxy** (vendor/v86/src/lib.js `view()`)
 * so that WASM memory growth — which detaches `memory.buffer` and allocates a fresh one —
 * is handled transparently: the proxy's trap re-resolves `memory.buffer` on access. The
 * cost is that EVERY `mem[i]` read/write goes through the proxy `get`/`set` trap (a
 * closure call + a `dbg_assert(/^\d+$/.test(property))` regex per element), which V8
 * cannot JIT — ~50× slower than a real Uint8Array. A single 800×600 surface colour-key
 * decode cost ~225ms instead of ~4ms, surfacing as the in-game Flip/Blt frame stalls.
 * (`mem.constructor.name` reads as "bound Uint8Array" because the trap returns
 * `Uint8Array.bind(view)` for the `constructor` property.)
 *
 * Re-wrapping as a *plain* `Uint8Array` over the SAME ArrayBuffer restores the JIT fast
 * path while reading/writing identical bytes, and bypasses the per-element trap. We do
 * this at the memory-cache boundary so every downstream HLE consumer gets the fast view.
 *
 * Growth-safe: the cache is keyed on the live `buffer` identity (read through the proxy),
 * NOT the proxy object (whose identity is stable across growth). When v86 grows memory the
 * buffer changes, the key misses, and we re-wrap over the new buffer — mirroring how the
 * proxy itself re-resolves. (The same boundary, ThunkDispatcher.updateMemoryCache, already
 * rebuilds its DataView/Uint32 views on buffer change.)
 */

let _lastBuffer: ArrayBufferLike | null = null;
let _lastPlain: Uint8Array | null = null;

/** Bumped on every borrow. The dispatcher samples it around each thunk to tell a slow
 *  thunk that DID ask for a fast view from one that indexed the Proxy per element —
 *  see FrameProfiler.recordThunk's `noBorrow` columns. */
let _borrows = 0;

/** Monotonic count of toPlainGuestMemory/borrowGuestMemory calls (diagnostic only). */
export function guestMemoryBorrowCount(): number {
    return _borrows;
}

/** Dev A/B switch — see setGuestMemoryBorrowBypass. */
let _bypass = false;

/**
 * Hand back v86's raw Proxy instead of a plain view, restoring the ~140x-slower
 * per-element trap everywhere at once. The only way to A/B an unwrap HONESTLY: both
 * arms then run in ONE session on ONE scene, so the µs/call comparison isn't confounded
 * by a different game state (and, unlike FPS, survives CPU contention). Never on in
 * normal operation. `dbg.memProxyBench(true)`.
 */
export function setGuestMemoryBorrowBypass(enabled: boolean): void {
    _bypass = enabled;
    if (enabled) { _lastBuffer = null; _lastPlain = null; }
}

export function isGuestMemoryBorrowBypassed(): boolean {
    return _bypass;
}

export function toPlainGuestMemory<T extends Uint8Array | null | undefined>(raw: T): T {
    _borrows++;
    if (_bypass) return raw;
    if (!raw) return raw;
    // Already a canonical Uint8Array (non-proxy / post-fix steady state) — nothing to do.
    if (raw.constructor === Uint8Array) return raw;
    const buffer = raw.buffer; // proxy get → the CURRENT (possibly just-grown) ArrayBuffer
    if (!buffer) return raw;
    if (buffer === _lastBuffer && _lastPlain) return _lastPlain as T;
    // NB: read `raw.length` (whitelisted in v86's view() Proxy get-trap), NOT
    // `raw.byteLength` (absent from the whitelist → trips dbg_assert in a DEBUG
    // v86 build). For a Uint8Array the two are identical.
    const plain = new Uint8Array(buffer, raw.byteOffset, raw.length);
    _lastBuffer = buffer;
    _lastPlain = plain;
    return plain as T;
}

/**
 * The most-recently-seen live guest-memory ArrayBuffer (updated by toPlainGuestMemory
 * every time it re-derives, i.e. at each dispatch/accessor boundary). Used by the
 * stale-view guard to detect a plain view that was held across a WASM memory growth.
 */
export function currentGuestBuffer(): ArrayBufferLike | null {
    return _lastBuffer;
}

// ---------------------------------------------------------------------------
// Stale-view guard (opt-in, dev/diagnostic only).
//
// Plain guest-memory views are bound to ONE ArrayBuffer. After a WASM memory
// growth the old buffer detaches and `mem.buffer` is replaced. A consumer that
// FIELD-CACHES or CLOSURE-CAPTURES a plain view across a re-entry into the guest
// (a thunk that invokes a WndProc callback, or an async-parked thunk that resumes
// after the guest ran and grew memory) will silently read undefined / drop writes
// on the detached view — the historical SetEvent/scheduler deadlock failure mode.
//
// When enabled (e.g. `dbg.memGuard(true)` before a canary run), borrowGuestMemory
// returns a Proxy that validates buffer identity on every access and THROWS with a
// stack on a stale touch — converting silent corruption into a located, loud fault.
// Off by default so dev runs keep the fast plain path; flip on to hunt held-view
// bugs or to validate the no-stale invariant on a known-fragile title (NFS-PU).
// ---------------------------------------------------------------------------

let _staleGuardEnabled = false;

export function setGuestMemoryStaleGuard(enabled: boolean): void {
    _staleGuardEnabled = enabled;
}

export function isGuestMemoryStaleGuardEnabled(): boolean {
    return _staleGuardEnabled;
}

function makeStaleGuard(view: Uint8Array): Uint8Array {
    const assertLive = (prop: string): void => {
        // Detached buffer → byteLength 0; or buffer identity drifted from the live one.
        if (view.byteLength === 0 || (_lastBuffer !== null && view.buffer !== _lastBuffer)) {
            throw new Error(
                `[guest-memory] STALE guest-memory view accessed after WASM growth ` +
                `(view held across a guest re-entry; prop=${prop}). This is the SetEvent/` +
                `scheduler stale-view class — re-fetch the view instead of caching it.`
            );
        }
    };
    return new Proxy(view, {
        get(target, prop, receiver) {
            if (typeof prop === "string" && (prop === "buffer" || prop === "byteLength" || /^\d+$/.test(prop))) {
                assertLive(prop);
            }
            const x = Reflect.get(target, prop, receiver);
            return typeof x === "function" ? x.bind(target) : x;
        },
        set(target, prop, value) {
            if (typeof prop === "string" && /^\d+$/.test(prop)) assertLive(prop);
            (target as unknown as Record<string, unknown>)[prop as string] = value;
            return true;
        },
    }) as unknown as Uint8Array;
}

/**
 * Canonical way to obtain a fast guest-memory view at a dispatch/accessor boundary.
 * Returns a plain (JIT-fast) Uint8Array in the steady state; when the stale-view guard
 * is enabled, returns a validating Proxy instead (slow, dev-only). Callers MUST NOT
 * cache the result across a re-entry into the guest — re-fetch it each time.
 */
export function borrowGuestMemory<T extends Uint8Array | null | undefined>(raw: T): T {
    const plain = toPlainGuestMemory(raw);
    if (_staleGuardEnabled && plain) return makeStaleGuard(plain as Uint8Array) as T;
    return plain;
}
