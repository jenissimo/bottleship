/**
 * D3D9 COM reference registry: the counts, the finalizers, the backing-store
 * disposers — and nothing else.
 *
 * Deliberately a LEAF module. The WebGPU backend holds real references on every
 * COM object it binds (textures, buffers, shaders), so it needs these functions;
 * importing them from shared-state would close a value-level cycle
 * (shared-state → resource-registry → d3d9-device → shared-state) that only
 * evaluates today because every use sits inside a method body.
 *
 * WHERE THE COUNT LIVES. Real COM keeps an object's refcount inside the object.
 * By default the count of record is a dword in the guest COM
 * block; the Map is then a MIRROR written from the same computed value by the
 * same single writer — never a second, independently-updated copy. That mirror is
 * what the differential oracle (`__d3d9RefcountVerify`) compares against, and it
 * is why flipping either flag mid-run is safe: the accessors below are the only
 * mutators of either store, and a flag transition reseeds the guest words.
 *
 * The point of the move is the FOLLOW-UP: with the count in the object, the
 * AddRef/Release vtable slots can become guest-side `inc [this+off]` stubs that
 * never trap. Storage correctness is the prerequisite, and this file is only that
 * prerequisite — the membership lookup below still costs a Map hit per call, so
 * moving the storage alone is not itself a speedup.
 */

import { Mem } from '../../core/memory/mem-accessor';

/**
 * Guest-block offset of the authoritative refcount. Offset 0 is the vtable
 * pointer (see com-memory's layout); d3d9 keeps every other per-object field in
 * JS registries, so the second dword of the 0x100-byte block is free, and
 * allocateComObject zero-fills the block before trackComObject seeds it at 1.
 *
 * Scoped to d3d9 on purpose: other modules' COM blocks stay opaque, so this is a
 * reservation d3d9 makes of its own objects, not of the shared layout.
 */
export const D3D9_COM_REFCOUNT_OFFSET = 4;

const comRefCounts: Map<number, number> = new Map();
const comFinalizers: Map<number, () => void> = new Map();
/** Frees the object's guest allocation; owned by whoever allocated it. */
const comDisposers: Map<number, () => void> = new Map();

interface RefcountFlags {
    /** Opt OUT of the guest block being the count of record (default: guest block wins). */
    __d3d9MirrorRefcount?: boolean;
    /** Maintain both stores and count disagreements (default off). */
    __d3d9RefcountVerify?: boolean;
}
const flags = globalThis as RefcountFlags;

/**
 * Real COM keeps the count inside the object, and so do we now: the guest block is the count
 * of record unless `__d3d9MirrorRefcount` asks for the old JS-Map-authoritative behaviour.
 * The differential oracle (below) is what makes this default safe to flip generically rather
 * than per-title — see docs/performance/nfsu-max-settings-ceiling-2026-09-02.md §4.1 for the
 * evidence this default rests on, including the 1->0 destruction path specifically.
 */
function guestRefcountWanted(): boolean {
    return !flags.__d3d9MirrorRefcount;
}

let guestStoreLive = false;
/**
 * Latched by the guest-side AddRef stub. Once guest code is
 * incrementing the word itself, the guest block is the count of record whatever the flag
 * says, and the JS mirror is knowingly behind between two JS-visible calls — so the flag may
 * not be allowed to hand authority back to a mirror that missed increments, and the mirror
 * comparison stops being an oracle and would only manufacture "disagreements".
 */
let guestStorePinned = false;
let oracleChecked = 0;
let oracleMismatch = 0;
let oracleFirst: string | null = null;
/** Objects whose guest block could not be read — see currentCount. */
let guestUnreadable = 0;

/**
 * The guest word, or `undefined` when it cannot be read.
 *
 * The distinction is load-bearing now that the guest block is the count of record by DEFAULT:
 * coercing an unreadable word to 0 says "this object is dead", which is the worst possible
 * wrong answer and is indistinguishable from a real zero. Every caller must decide what to do
 * with "no answer" rather than be handed a plausible one.
 */
function readGuestCount(key: number): number | undefined {
    const v = Mem.readUint32(key + D3D9_COM_REFCOUNT_OFFSET);
    return (v === undefined || v === null) ? undefined : v >>> 0;
}

function writeGuestCount(key: number, value: number): void {
    Mem.writeUint32(key + D3D9_COM_REFCOUNT_OFFSET, value >>> 0);
}

/**
 * Follow the LIVE flags. Read per call rather than latched at construction so one
 * boot can A/B both storages; a transition into guest storage reseeds every
 * tracked object's word from the mirror, so no object can be left with a stale
 * count by a flag flipped in the middle of a run.
 */
function syncStorageMode(): void {
    const want = guestStorePinned || guestRefcountWanted() || !!flags.__d3d9RefcountVerify;
    if (want === guestStoreLive) return;
    guestStoreLive = want;
    if (want) for (const [key, n] of comRefCounts) writeGuestCount(key, n);
}

/**
 * The count to mutate. Under verify BOTH stores are read and disagreements
 * counted; the authoritative one is still chosen by __d3d9MirrorRefcount, so
 * verify alone changes nothing the guest can observe.
 */
function currentCount(key: number, mirrored: number): number {
    if (!guestStoreLive) return mirrored;
    const guest = readGuestCount(key);
    if (guest === undefined) {
        // Unreadable guest word: the mirror is the only answer there is. Counted, because a
        // COM object whose block is not in readable guest memory is a real anomaly and a
        // silent fallback here would hide it.
        guestUnreadable++;
        return mirrored;
    }
    if (flags.__d3d9RefcountVerify && !guestStorePinned) {
        oracleChecked++;
        if (guest !== mirrored) {
            oracleMismatch++;
            if (oracleFirst === null) {
                oracleFirst = `0x${key.toString(16)}: guest=${guest} js=${mirrored}`;
            }
        }
    }
    return (guestStorePinned || guestRefcountWanted()) ? guest : mirrored;
}

/** The ONE writer of the count, in whichever stores are live. */
function storeCount(key: number, next: number): void {
    comRefCounts.set(key, next);
    if (guestStoreLive) writeGuestCount(key, next);
}

function dropCount(key: number): void {
    comRefCounts.delete(key);
    if (guestStoreLive) writeGuestCount(key, 0);
}

/**
 * Differential oracle readout. `checked: 0` means the oracle never ran — not that
 * it passed; a run is evidence only when `checked` is large AND `mismatch` is 0.
 */
export function d3d9RefcountStorageStats(reset = false): {
    guestAuthoritative: boolean;
    verify: boolean;
    guestStoreLive: boolean;
    guestStorePinned: boolean;
    tracked: number;
    guestUnreadable: number;
    checked: number;
    mismatch: number;
    firstMismatch: string | null;
    verdict: string;
} {
    const out = {
        guestAuthoritative: guestStorePinned || guestRefcountWanted(),
        verify: !!flags.__d3d9RefcountVerify,
        guestStoreLive,
        guestStorePinned,
        tracked: comRefCounts.size,
        guestUnreadable,
        checked: oracleChecked,
        mismatch: oracleMismatch,
        firstMismatch: oracleFirst,
        verdict: guestStorePinned
            ? 'not applicable: the guest AddRef stub owns the word, the mirror lags by design'
            : (oracleChecked === 0
                ? 'oracle did not run'
                : (oracleMismatch === 0 ? 'agree' : 'DISAGREE')),
    };
    if (reset) { oracleChecked = 0; oracleMismatch = 0; oracleFirst = null; guestUnreadable = 0; }
    return out;
}

/**
 * The guest word as it stands RIGHT NOW, for the AddRef/Release stub oracles.
 *
 * They need it because their own trap displaces what they measure: the guest
 * trampoline reads the word, then OUT-traps, and `handlePortWrite` drains the
 * WBUF ring before dispatching — and a drain handler (SetTexture releasing the
 * previously bound texture, say) can mutate this very count. The live stub
 * causes no trap and therefore no drain, so a prediction that disagrees with
 * the JS answer by exactly the drain's own delta is an artifact of running the
 * oracle, not a defect in the stub. Reading the word here is what lets the
 * oracle tell the two apart instead of reporting an unexplained mismatch.
 *
 * Returns **-1**, not 0, when there is no informative word: the mirror is
 * authoritative, or the object is not tracked at all. A sentinel rather than a
 * count because 0 is the answer JS gives for an untracked pointer, and an oracle
 * that accepted `answer === word` there would excuse every prediction it could
 * not explain — a check that cannot fail.
 */
export function readComRefGuestWord(ptr: number): number {
    const key = ptr >>> 0;
    if (!guestStoreLive || !comRefCounts.has(key)) return -1;
    return readGuestCount(key) ?? -1;
}

/**
 * Latch the guest block as the count of record for good. Called by the guest AddRef stub's
 * registration: once guest code increments the word with no JS in the loop, a flag flip back
 * to the mirror would silently drop every increment the stub made.
 */
export function pinGuestRefcountStore(): void {
    guestStorePinned = true;
    syncStorageMode();
}

/** Test hook: undo the latch (there is no runtime path that should). */
export function unpinGuestRefcountStoreForTests(): void {
    guestStorePinned = false;
    syncStorageMode();
}

/** Seed a freshly allocated COM object at refcount 1 (the creator's reference). */
export function trackComObject(ptr: number, dispose?: () => void): void {
    const key = ptr >>> 0;
    syncStorageMode();
    storeCount(key, 1);
    if (dispose) comDisposers.set(key, dispose);
}

export function addComRef(ptr: number): number | undefined {
    const key = ptr >>> 0;
    const mirrored = comRefCounts.get(key);
    if (mirrored === undefined) return undefined;
    syncStorageMode();
    const next = currentCount(key, mirrored) + 1;
    storeCount(key, next);
    return next;
}

export function releaseComRef(ptr: number): number | undefined {
    const key = ptr >>> 0;
    const mirrored = comRefCounts.get(key);
    if (mirrored === undefined) return undefined;
    syncStorageMode();
    const next = currentCount(key, mirrored) - 1;
    if (next > 0) {
        storeCount(key, next);
        return next;
    }

    dropCount(key);
    // Unregister before running: a finalizer that reaches back here (forgetComObject
    // on a subresource, a parent release) must not re-enter this object's teardown.
    const finalizer = comFinalizers.get(key);
    comFinalizers.delete(key);
    const dispose = comDisposers.get(key);
    comDisposers.delete(key);
    try {
        finalizer?.();
    } finally {
        dispose?.();
    }
    return 0;
}

export function registerComFinalizer(ptr: number, finalizer: () => void): void {
    comFinalizers.set(ptr >>> 0, finalizer);
}

/**
 * Keep a D3D9 device alive for the complete lifetime of one of its child COM
 * objects — real D3D9 holds a device reference for every resource, state block
 * and shader it created. The finally block guarantees a balanced parent
 * reference even if a resource-specific cleanup path throws.
 */
export function registerDeviceChildFinalizer(
    childPtr: number,
    devicePtr: number,
    finalizer: () => void,
): void {
    const retainedDevice = addComRef(devicePtr) !== undefined;
    registerComFinalizer(childPtr, () => {
        try {
            finalizer();
        } finally {
            if (retainedDevice) releaseComRef(devicePtr);
        }
    });
}

/** Drop an object outright (an implicit subresource dying with its owner). */
export function forgetComObject(ptr: number): void {
    const key = ptr >>> 0;
    syncStorageMode();
    dropCount(key);
    comFinalizers.delete(key);
    const dispose = comDisposers.get(key);
    comDisposers.delete(key);
    dispose?.();
}

export function getComRefCount(ptr: number): number | undefined {
    const key = ptr >>> 0;
    const mirrored = comRefCounts.get(key);
    if (mirrored === undefined) return undefined;
    syncStorageMode();
    return currentCount(key, mirrored);
}

/**
 * Run every outstanding finalizer once and drop the registry. Module reset must
 * go through here: the finalizers are what return GPU textures, VB/IB and WASM
 * block slots, and a reused WebGPU device would otherwise inherit all of them.
 * Guest allocations are NOT disposed — the address space goes with the session.
 */
export function drainComFinalizers(): void {
    const pending = [...comFinalizers.values()];
    comFinalizers.clear();
    for (const finalizer of pending) {
        try {
            finalizer();
        } catch {
            /* one broken finalizer must not strand the rest */
        }
    }
    if (guestStoreLive) for (const key of comRefCounts.keys()) writeGuestCount(key, 0);
    comRefCounts.clear();
    comDisposers.clear();
}
