/**
 * COM interface pointer -> stable D3D9 resource id. The ONE owner of that mapping.
 *
 * WHY IT EXISTS. The ingest tier stores what a setter names, and a guest COM pointer is not a
 * name: `SetTexture`, `SetStreamSource`, `SetIndices`, `SetVertexShader`, `SetPixelShader` and
 * `SetVertexDeclaration` all hand us an address out of a recycled block pool, so an address
 * identifies a *block*, not a resource. An id minted here identifies the resource for as long as
 * the resource exists and never again afterwards.
 *
 * WHY IDS ARE NEVER REUSED. A recycled id would reintroduce exactly the aliasing this table is
 * built to remove: a shadow bank still holding id N would start naming whatever took N next. Ids
 * are monotonic; a released id stays dead forever and `isResourceIdLive` can always answer
 * honestly. The cost is 5 bytes per id ever minted, which is the price of the guarantee.
 *
 * WHY INVALIDATION IS NOT OPTIONAL. COM blocks come from a shared pool: when an interface is
 * released to zero its block is handed to the next allocation, and a surviving pointer->id entry
 * then dispatches into whoever reused the block. `com-refs` calls `invalidateResourceId` on every
 * 1->0 transition, on `forgetComObject`, and on `drainComFinalizers`. The guest-side Release stub
 * cannot bypass that: it declines (traps) at a count of 1, so the destroying Release is always a
 * JS call — see `guest-release-stub.ts`.
 *
 * SHAPE. Open-addressed, linear-probed, power-of-two: two `Int32Array`s for the probe and two
 * side arrays indexed by id. No Map, no object per entry, nothing allocated on a lookup or on an
 * invalidation — only a rehash allocates, and that is amortized. The layout is deliberately flat
 * because the Rust ingest tier is meant to run the same probe over the same words later
 * (`docs`/ABI note: `d3d9ResourceIdTableAbi`).
 *
 * SELF-CHECK. `idPtr[id]` is the reverse of the probe, so `idPtr[id] === key` is an invariant of
 * this single table rather than a second source of truth. A lookup that finds an entry failing it
 * refuses to answer and counts `staleHits`. That catches the table tearing (a bad rehash, a bad
 * backward-shift delete) — NOT a missed invalidation, which leaves both halves agreeing on a
 * pointer the allocator has since recycled. Nothing inside this module can detect that; the wire
 * is what guarantees it, and `__d3d9ResourceIdNoInvalidate` breaks the wire so
 * `d3d9-resource-id-invalidation.test.ts` can show the stale entry it leaves behind.
 */

/** Kind tags. Ids share ONE space across kinds, so a texture id can never equal a shader id. */
export const D3D9ResourceKind = {
    Texture: 1,
    VertexBuffer: 2,
    IndexBuffer: 3,
    VertexShader: 4,
    PixelShader: 5,
    VertexDeclaration: 6,
} as const;
export type D3D9ResourceKind = (typeof D3D9ResourceKind)[keyof typeof D3D9ResourceKind];

/** The NULL interface pointer. A real binding of "nothing", not a failure. */
export const D3D9_RESOURCE_ID_NONE = 0;
/**
 * No live resource of the requested kind stands behind this pointer.
 *
 * A sentinel rather than 0 because 0 is the answer for an unbound slot: a caller that conflated
 * them would silently turn "we lost track of this texture" into "the guest unbound the stage",
 * which renders plausibly and reports nothing.
 */
export const D3D9_RESOURCE_ID_UNRESOLVED = -1;

const KIND_COUNT = 7; // 1..6 used; index 0 reserved so a kind is never falsy

type LiveProbe = (ptr: number) => boolean;

interface ResourceIdFlags {
    /**
     * TEST BYPASS. Makes `invalidateResourceId` a no-op so the recycling failure can be
     * reproduced on demand. There is no production reason to set it.
     */
    __d3d9ResourceIdNoInvalidate?: boolean;
}
const flags = globalThis as ResourceIdFlags;

const INITIAL_BITS = 10; // 1024 slots
let bits = INITIAL_BITS;
let mask = (1 << bits) - 1;
let keys = new Int32Array(1 << bits);
let vals = new Int32Array(1 << bits);
let used = 0;

let idCapacity = 1024;
/** Guest pointer behind each id, 0 once the id is dead. Index 0 is never a live id. */
let idPtr = new Int32Array(idCapacity);
let idKind = new Uint8Array(idCapacity);
let nextId = 1;

const probes: (LiveProbe | null)[] = new Array(KIND_COUNT).fill(null);

let hits = 0;
let minted = 0;
let misses = 0;
let kindMismatch = 0;
let staleHits = 0;
let invalidated = 0;
let probeMissing = 0;
let rehashes = 0;

function slotOf(key: number): number {
    return (Math.imul(key, 0x9e3779b1) >>> (32 - bits)) & mask;
}

/** Index of `key`, or of the empty slot it would occupy. `keys[i] === 0` distinguishes them. */
function findSlot(key: number): number {
    let i = slotOf(key);
    for (;;) {
        const k = keys[i]!;
        if (k === key || k === 0) return i;
        i = (i + 1) & mask;
    }
}

function grow(): void {
    const oldKeys = keys;
    const oldVals = vals;
    bits++;
    mask = (1 << bits) - 1;
    keys = new Int32Array(1 << bits);
    vals = new Int32Array(1 << bits);
    rehashes++;
    for (let i = 0; i < oldKeys.length; i++) {
        const k = oldKeys[i]!;
        if (k === 0) continue;
        const slot = findSlot(k);
        keys[slot] = k;
        vals[slot] = oldVals[i]!;
    }
}

function growIds(): void {
    idCapacity *= 2;
    const nextPtrs = new Int32Array(idCapacity);
    nextPtrs.set(idPtr);
    idPtr = nextPtrs;
    const nextKinds = new Uint8Array(idCapacity);
    nextKinds.set(idKind);
    idKind = nextKinds;
}

/**
 * Remove an occupied slot, shifting the probe chain back so no tombstone is needed.
 * Tombstones would accumulate over a session of create/destroy churn and slowly turn every
 * lookup into a full-table scan.
 */
function removeAt(hole: number): void {
    keys[hole] = 0;
    vals[hole] = 0;
    used--;
    let j = hole;
    for (;;) {
        j = (j + 1) & mask;
        const k = keys[j]!;
        if (k === 0) return;
        const home = slotOf(k);
        if (((j - home) & mask) >= ((j - hole) & mask)) {
            keys[hole] = k;
            vals[hole] = vals[j]!;
            keys[j] = 0;
            vals[j] = 0;
            hole = j;
        }
    }
}

/**
 * Declare how to tell whether a pointer is still a live resource of this kind. The table mints an
 * id only for a pointer the owning registry vouches for, so it can never name a block that was
 * never a resource. Installed once per kind at module init (`installD3D9ResourceKindProbes`).
 */
export function registerResourceKindProbe(kind: D3D9ResourceKind, probe: LiveProbe): void {
    probes[kind] = probe;
}

/**
 * The hot path: one probe, one compare, no allocation.
 *
 * Returns `D3D9_RESOURCE_ID_NONE` for a null pointer, a positive id for a live resource of
 * `kind`, and `D3D9_RESOURCE_ID_UNRESOLVED` for everything else — a pointer no registry
 * recognises, a pointer of the wrong kind, or an entry that failed the reverse check. Each of
 * those three is counted separately; none of them is answered with a plausible id.
 */
export function resolveResourceId(ptr: number, kind: D3D9ResourceKind): number {
    const key = ptr | 0;
    if (key === 0) return D3D9_RESOURCE_ID_NONE;
    const slot = findSlot(key);
    const id = vals[slot]!;
    if (id !== 0) {
        if (idPtr[id] !== key) {
            // The two halves of this table disagree about the same entry. Refuse.
            staleHits++;
            removeAt(slot);
            return D3D9_RESOURCE_ID_UNRESOLVED;
        }
        if (idKind[id] !== kind) {
            kindMismatch++;
            return D3D9_RESOURCE_ID_UNRESOLVED;
        }
        hits++;
        return id;
    }
    return mint(key, kind, slot);
}

/** Cold half of `resolveResourceId`: first sighting of a pointer. */
function mint(key: number, kind: D3D9ResourceKind, slot: number): number {
    const probe = probes[kind];
    if (!probe) {
        probeMissing++;
        return D3D9_RESOURCE_ID_UNRESOLVED;
    }
    if (!probe(key >>> 0)) {
        misses++;
        return D3D9_RESOURCE_ID_UNRESOLVED;
    }
    const id = nextId++;
    if (id >= idCapacity) growIds();
    idPtr[id] = key;
    idKind[id] = kind;
    keys[slot] = key;
    vals[slot] = id;
    used++;
    minted++;
    // Grow AFTER inserting: `slot` was computed against the current table.
    if (used * 10 > (1 << bits) * 7) grow();
    return id;
}

/**
 * The id already minted for this pointer, without minting one. `D3D9_RESOURCE_ID_UNRESOLVED`
 * when the pointer is not in the table — used by tests and by diagnostics that must not have
 * side effects on the table they are inspecting.
 */
export function peekResourceId(ptr: number): number {
    const key = ptr | 0;
    if (key === 0) return D3D9_RESOURCE_ID_NONE;
    const slot = findSlot(key);
    const id = vals[slot]!;
    return id === 0 ? D3D9_RESOURCE_ID_UNRESOLVED : id;
}

/**
 * Release-to-zero wire. Called by `com-refs` for every COM object that dies, whether it was ever
 * interned here or not — an unknown pointer is a cheap probe and a no-op.
 *
 * Returns whether an entry was actually dropped, so a caller can count destroys that mattered.
 */
export function invalidateResourceId(ptr: number): boolean {
    if (flags.__d3d9ResourceIdNoInvalidate) return false;
    const key = ptr | 0;
    if (key === 0) return false;
    const slot = findSlot(key);
    const id = vals[slot]!;
    if (id === 0) return false;
    idPtr[id] = 0;
    idKind[id] = 0;
    removeAt(slot);
    invalidated++;
    return true;
}

/** Whether the resource an id names still exists. A dead id never becomes live again. */
export function isResourceIdLive(id: number): boolean {
    return id > 0 && id < idCapacity && idPtr[id] !== 0;
}

/** The kind an id was minted for, or 0 once it is dead. */
export function resourceIdKind(id: number): number {
    return id > 0 && id < idCapacity ? idKind[id]! : 0;
}

/** The pointer an id names, or 0 once it is dead. The reverse of the probe. */
export function resourceIdPtr(id: number): number {
    return id > 0 && id < idCapacity ? (idPtr[id]! >>> 0) : 0;
}

/**
 * Session teardown. Ids restart at 1, which is safe only because every consumer of an id is torn
 * down in the same reset (`resetD3D9SharedState` drains the finalizers first).
 */
export function resetResourceIds(): void {
    bits = INITIAL_BITS;
    mask = (1 << bits) - 1;
    keys = new Int32Array(1 << bits);
    vals = new Int32Array(1 << bits);
    used = 0;
    idCapacity = 1024;
    idPtr = new Int32Array(idCapacity);
    idKind = new Uint8Array(idCapacity);
    nextId = 1;
    hits = 0; minted = 0; misses = 0; kindMismatch = 0;
    staleHits = 0; invalidated = 0; probeMissing = 0; rehashes = 0;
}

/** Test hook: drop the installed probes so a suite can declare its own. */
export function clearResourceKindProbesForTests(): void {
    probes.fill(null);
}

/**
 * Readout. `minted: 0` means the table was never consulted — NOT that it is healthy; the
 * setters do not call `resolveResourceId` yet (§9 steps 1-3), so that is the expected reading
 * today and it must not be mistaken for a clean bill of health.
 *
 * `staleHits > 0` is the only value here that indicts this module: a pointer resolved to an id
 * whose reverse entry did not name it, i.e. the probe and the reverse map have torn apart. A
 * MISSED invalidation is invisible from here by construction — see SELF-CHECK above.
 */
export function d3d9ResourceIdStats(reset = false): {
    live: number;
    minted: number;
    hits: number;
    misses: number;
    kindMismatch: number;
    staleHits: number;
    invalidated: number;
    probeMissing: number;
    rehashes: number;
    capacity: number;
    idsEverMinted: number;
    verdict: string;
} {
    const out = {
        live: used,
        minted,
        hits,
        misses,
        kindMismatch,
        staleHits,
        invalidated,
        probeMissing,
        rehashes,
        capacity: 1 << bits,
        idsEverMinted: nextId - 1,
        verdict: minted === 0
            ? 'never consulted'
            : (staleHits > 0 ? 'TORN: the probe and the reverse map disagree' : 'consistent'),
    };
    if (reset) {
        hits = 0; minted = 0; misses = 0; kindMismatch = 0;
        staleHits = 0; invalidated = 0; probeMissing = 0; rehashes = 0;
    }
    return out;
}

/**
 * The exact words a Rust reader would walk. Diagnostics today — the arrays live on the JS heap,
 * so `hypercall_eagl.rs` cannot reach them until they are moved into the arena's linear memory.
 * The layout is chosen so that move is a relocation and not a redesign:
 *
 *   keys[slots]  i32  guest pointer, 0 = empty      probe: i = imul(key, 0x9e3779b1) >>> (32-bits)
 *   vals[slots]  i32  resource id, 0 = empty        linear probe forward, wrap at `slots-1`
 *   idPtr[n]     i32  reverse map, 0 = dead id      an entry is valid iff idPtr[vals[i]] == keys[i]
 *   idKind[n]    u8   D3D9ResourceKind, 0 = dead
 *
 * A reader must treat `bits`/`slots` and both base pointers as re-readable per lookup: a mint
 * can rehash and an id past capacity can reallocate. Mutation stays single-writer in JS —
 * Rust reads, JS mints and invalidates — so no lock is needed on the one worker thread.
 */
export function d3d9ResourceIdTableAbi(): {
    bits: number;
    slots: number;
    keys: Int32Array;
    vals: Int32Array;
    idPtr: Int32Array;
    idKind: Uint8Array;
    nextId: number;
    hashMultiplier: number;
} {
    return {
        bits,
        slots: 1 << bits,
        keys,
        vals,
        idPtr,
        idKind,
        nextId,
        hashMultiplier: 0x9e3779b1,
    };
}
