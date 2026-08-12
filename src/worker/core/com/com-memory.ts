import { Logger, LogCategory } from '../logger';
import { Mem } from '../memory/mem-accessor';

export const COM_OBJECT_SIZE = 0x100;
export const COM_GUARD_SIZE = 16;
export const COM_GUARD_VALUE = 0xDEADBEEF;
const COM_TOTAL_SIZE = COM_GUARD_SIZE + COM_OBJECT_SIZE + COM_GUARD_SIZE;

interface ComMemoryAlloc {
    allocSystemBlock(size: number): number;
}

interface ComMemoryFree {
    freeSystemBlock(addr: number, size: number): void;
}

// ─── vtable ownership ────────────────────────────────────────────────────────
// Which HLE module published a given vtable. Registered by both vtable builders
// (createVTablesFromDescriptor, installComVtable), so every COM object's owner is
// derivable from the vtable pointer its call site already passes — no call-site
// churn across the 40-odd allocateComObject sites.
const vtableOwner = new Map<number, string>();
/** Human-readable name of the vtable, for the released-object trap's message. */
const vtableLabel = new Map<number, string>();

export function registerComVtableOwner(vtableAddr: number, moduleName: string, ifaceName?: string): void {
    if (!vtableAddr) return;
    vtableOwner.set(vtableAddr >>> 0, moduleName);
    if (ifaceName) vtableLabel.set(vtableAddr >>> 0, ifaceName);
}

export function comVtableOwner(vtableAddr: number): string {
    return vtableOwner.get(vtableAddr >>> 0) ?? "unknown";
}

export function comVtableLabel(vtableAddr: number): string {
    const a = vtableAddr >>> 0;
    return vtableLabel.get(a) ?? `vtable@0x${a.toString(16)}`;
}

// ─── the released-object trap ────────────────────────────────────────────────
// A vtable whose every slot is an OUT-trap stub that reports a named fatal. Point
// a freed block's vptr at it and a guest that dispatches through a stale interface
// pointer lands on a diagnosis instead of on whichever object recycled the block.
//
// OPT-IN (`__comPoisonReleased`), because rewriting the vptr on EVERY free is not a
// pure diagnostic: it changes what a stale dispatch does. A title that quietly lived
// with a released pointer — reaching a real handler that answers "no such object"
// with a documented error code — takes a hard failure instead, and can die on the
// error path the poison put it on without the trap ever firing. The always-on halves
// are the lifecycle census and the double-free guard below, which are pure observation.
let releasedVtableAddr = 0;
let warnedNoTrap = false;

export function setReleasedComVtable(addr: number): void {
    releasedVtableAddr = addr >>> 0;
}

export function getReleasedComVtable(): number {
    return releasedVtableAddr;
}

/** What a poisoned block used to be, so the trap can name it. Keyed by object address. */
export interface ReleasedComRecord {
    iface: string;
    owner: string;
    vtable: number;
    freedAt: number;
    /** Guest call site of the final Release — the other half of a use-after-free. */
    freedBy: string;
}
const releasedBlocks = new Map<number, ReleasedComRecord>();

export function lookupReleasedComObject(objAddr: number): ReleasedComRecord | undefined {
    return releasedBlocks.get(objAddr >>> 0);
}

/** Shallow module-labelled guest backtrace; empty before the dispatcher exists. */
function guestSite(): string {
    try { return (globalThis as any).__guestBtLite?.() ?? ""; } catch { return ""; }
}

// ─── lifecycle ring ──────────────────────────────────────────────────────────
// A use-after-free needs BOTH halves: where the block was released and where it
// was reclaimed. COM frees are rare (no hot path), so each one carries a guest
// backtrace and lands in a ring the harness can read after the fact.
export interface ComLifecycleEvent {
    seq: number;
    op: "free" | "recycle";
    objAddr: number;
    iface: string;
    owner: string;
    /** For a recycle: the interface the block is being handed to. */
    intoIface?: string;
    intoOwner?: string;
    by: string;
    t: number;
}
const LIFECYCLE_RING = 512;
const lifecycle: ComLifecycleEvent[] = [];
let lifecycleSeq = 0;

function noteLifecycle(e: Omit<ComLifecycleEvent, "seq" | "t">): void {
    const entry: ComLifecycleEvent = { ...e, seq: ++lifecycleSeq, t: performance.now() };
    if (lifecycle.length < LIFECYCLE_RING) lifecycle.push(entry);
    else lifecycle[lifecycleSeq % LIFECYCLE_RING] = entry;
}

/** Diagnostics: recent COM free/recycle events, oldest first. `addr` filters to one block. */
export function comLifecycleLog(addr?: number): ComLifecycleEvent[] {
    const target = addr === undefined ? undefined : addr >>> 0;
    return lifecycle
        .filter((e) => e && (target === undefined || e.objAddr === target))
        .sort((a, b) => a.seq - b.seq);
}

// ─── per-owner block recycling ───────────────────────────────────────────────
// On Windows each system DLL allocates its COM objects from its OWN heap, so a
// released ddraw vertex buffer's block can be reused by another ddraw object and by
// nothing else. One shared pool breaks that: a stale pointer to a freed ddraw buffer
// starts naming, say, an IDirectInput7A whose slot 4 takes 5 args (RET 20) where the
// buffer's took 1 (RET 4) — a stack skew that walks the caller off its own frame.
//
// Every COM object is the same size, so partitioning is just one free list per
// owning module. Blocks are recycled OLDEST-FIRST: LIFO hands the most recently
// freed block to the very next allocation, which is precisely the window in which
// a stale guest pointer is still live.
class OwnerBlockPool {
    private readonly blocks: number[] = [];
    private head = 0;

    push(addr: number): void {
        this.blocks.push(addr >>> 0);
    }

    /** Most recently freed block — the pre-partition behaviour, kept for A/B control only. */
    popNewest(): number {
        if (this.head >= this.blocks.length) return 0;
        return this.blocks.pop()!;
    }

    /** Oldest free block, or 0 when the pool is empty. */
    pop(): number {
        if (this.head >= this.blocks.length) return 0;
        const addr = this.blocks[this.head++];
        if (this.head > 64 && this.head * 2 >= this.blocks.length) {
            this.blocks.splice(0, this.head);
            this.head = 0;
        }
        return addr;
    }

    get size(): number { return this.blocks.length - this.head; }
}

const ownerPools = new Map<string, OwnerBlockPool>();

// Every address here belongs to ONE MemoryManager's system-object arena. A worker that
// builds a second process (a launcher re-execing the real exe is the normal case, not an
// edge one) gets a fresh arena, and a block address carried over from the previous one
// points at whatever the new layout put there. The old code could not have this problem —
// it handed blocks back to MemoryManager.freeSystemBlock, which dies with the process —
// so the pools have to be told when the process underneath them changed.
let poolArenaOwner: object | null = null;

function ensurePoolEpoch(memory: object): void {
    if (poolArenaOwner === memory) return;
    poolArenaOwner = memory;
    ownerPools.clear();
    releasedBlocks.clear();
    freeBlocks.clear();
    crossOwnerReuse.clear();
    doubleFrees = 0;
    lifecycle.length = 0;
    lifecycleSeq = 0;
    // The trap's own address is NOT reset here: ensureReleasedComTrap re-installs it per
    // process by verifying the slots, and it runs at module registration — before the
    // first COM allocation, so clearing it here would discard the fresh one.
}

function poolFor(owner: string): OwnerBlockPool {
    let p = ownerPools.get(owner);
    if (!p) { p = new OwnerBlockPool(); ownerPools.set(owner, p); }
    return p;
}

/** Diagnostics: free-block count per owning module. */
export function comPoolStats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [owner, pool] of ownerPools) out[owner] = pool.size;
    return out;
}

// Census of block reuse that crosses interfaces — the hazard the partition removes.
// Partitioning makes this structurally impossible, so a non-zero count here can only
// come from the `__comSharedPool` A/B switch; it is what makes the switch a real
// control rather than a claim.
const crossOwnerReuse = new Map<string, number>();

/** Diagnostics: `"ddraw:IDirect3DVertexBuffer7 -> dinput" -> count`. */
export function comReuseStats(): Record<string, number> {
    return Object.fromEntries(crossOwnerReuse);
}

// ─── double-free guard ───────────────────────────────────────────────────────
// A block that is on a free list twice is handed to TWO objects that are both
// LIVE, and the second one's vtable silently replaces the first's — the guest's
// perfectly valid interface pointer starts dispatching into another interface,
// with that interface's stack cleanup. That is not a use-after-free the guest
// can be blamed for and no amount of poisoning can catch it, because neither
// pointer is stale. A real heap answers a double HeapFree with a corruption
// report, and so do we: the second free is REFUSED and named.
const freeBlocks = new Set<number>();
let doubleFrees = 0;

/** Diagnostics: refused double frees this session (>0 means an HLE module frees a block it does not own). */
export function comDoubleFreeCount(): number {
    return doubleFrees;
}

/** Test/diagnostic hook: drop all pooled state (process reset). */
export function resetComMemory(): void {
    ownerPools.clear();
    releasedBlocks.clear();
    crossOwnerReuse.clear();
    freeBlocks.clear();
    doubleFrees = 0;
    lifecycle.length = 0;
    lifecycleSeq = 0;
}

/**
 * Allocates a COM object with guard bytes and proper layout.
 * Layout: [GUARD 16b] [VTABLE_PTR 4b] [DATA...] [GUARD 16b]
 * Returns the address of the VTable pointer (the object's 'this' pointer).
 *
 * COM objects live in the system-object pool (MemoryManager.allocSystemBlock),
 * NOT the game's HEAP bucket. On real Windows, system DLLs (ddraw etc.) allocate
 * from their own heap: a block the game frees keeps its contents until the GAME
 * reuses it, and a released COM object's memory survives until the next
 * same-class system allocation claims it. The pool reproduces both properties —
 * per owning module, so the reuse can never cross interfaces (see OwnerBlockPool).
 */
export const allocateComObject = (
    memory: ComMemoryAlloc,
    mem8: Uint8Array,
    vtableAddr: number,
): number => {
    ensurePoolEpoch(memory);
    const totalSize = COM_TOTAL_SIZE;
    const owner = comVtableOwner(vtableAddr);
    const recycled = (globalThis as any).__comSharedPool
        ? poolFor("shared").popNewest()   // A/B control: pre-partition shared LIFO
        : poolFor(owner).pop();
    const addr = recycled || memory.allocSystemBlock(totalSize);
    freeBlocks.delete(addr >>> 0);
    if (recycled) {
        const prevObjAddr = (recycled + COM_GUARD_SIZE) >>> 0;
        const prev = releasedBlocks.get(prevObjAddr);
        if (prev) {
            if (prev.owner !== owner) {
                const key = `${prev.owner}:${prev.iface} -> ${owner}`;
                crossOwnerReuse.set(key, (crossOwnerReuse.get(key) ?? 0) + 1);
            }
            noteLifecycle({
                op: "recycle",
                objAddr: prevObjAddr,
                iface: prev.iface,
                owner: prev.owner,
                intoIface: comVtableLabel(vtableAddr),
                intoOwner: owner,
                by: guestSite(),
            });
        }
        releasedBlocks.delete(prevObjAddr);
    }

    // Get fresh memory view after potential grow during alloc
    const freshMem8 = Mem.getView();
    if (!freshMem8) throw new Error("Mem.getView() failed during allocateComObject");

    // Fill with zero using fresh view
    freshMem8.fill(0, addr, addr + totalSize);

    // Write guards using Mem accessors
    for (let i = 0; i < COM_GUARD_SIZE; i += 4) {
        Mem.writeUint32(addr + i, COM_GUARD_VALUE);
        Mem.writeUint32(addr + totalSize - COM_GUARD_SIZE + i, COM_GUARD_VALUE);
    }

    // Object address is after the first guard
    const objAddr = addr + COM_GUARD_SIZE;
    Mem.writeUint32(objAddr, vtableAddr);

    // DIAGNOSTIC: Log COM object allocation with guard addresses
    Logger.verbose(LogCategory.COM, `[COM ALLOC] objAddr=0x${objAddr.toString(16)}, guardStart=0x${addr.toString(16)}, vtable=0x${vtableAddr.toString(16)}, owner=${owner}${recycled ? " (recycled)" : ""}`);

    return objAddr;
};

/**
 * Rewrites a COM object's vptr to the released-object trap and remembers what it
 * was. The block keeps its DATA bytes — a benign read-after-release still sees what
 * it saw on Windows — but any DISPATCH through the stale pointer now names itself
 * instead of silently calling whatever interface later recycles the block.
 * Exposed on its own so fault injection can prove the trap fires. Returns the owner.
 */
export function poisonComObject(objAddr: number, force = false): string {
    const vtable = (Mem.readUint32(objAddr) ?? 0) >>> 0;
    const owner = comVtableOwner(vtable);
    const iface = comVtableLabel(vtable);
    const by = guestSite();
    if (!force) noteLifecycle({ op: "free", objAddr: objAddr >>> 0, iface, owner, by });

    if (releasedVtableAddr && (force || (globalThis as any).__comPoisonReleased)) {
        releasedBlocks.set(objAddr >>> 0, { iface, owner, vtable, freedAt: performance.now(), freedBy: by });
        Mem.writeUint32(objAddr, releasedVtableAddr);
    } else if (!releasedVtableAddr && force && !warnedNoTrap) {
        warnedNoTrap = true;
        Logger.warn(LogCategory.COM, "released-COM trap is not installed — nothing to poison with");
    }
    return owner;
}

/**
 * Returns the backing block of a COM object to its owning module's free list, after
 * poisoning the vptr (see poisonComObject).
 */
export function freeComObject(memory: ComMemoryFree, objAddr: number): void {
    if (!objAddr) return;
    ensurePoolEpoch(memory);
    const blockAddr = (objAddr - COM_GUARD_SIZE) >>> 0;

    if (freeBlocks.has(blockAddr)) {
        doubleFrees++;
        const prev = releasedBlocks.get(objAddr >>> 0);
        Logger.error(LogCategory.COM,
            `DOUBLE FREE of COM block 0x${objAddr.toString(16)} (${prev?.iface ?? "unknown interface"}) — refused. ` +
            `First free at ${prev?.freedBy || "unknown"}; this one at ${guestSite()}. ` +
            `Two owners are freeing one block; a second hand-out would alias two LIVE objects.`);
        return;
    }
    freeBlocks.add(blockAddr);

    const owner = poisonComObject(objAddr);

    // Recycled within the owning module only. A vtable we never saw registered has
    // no owner to pool under, so it goes back to the shared system pool as before.
    if (owner === "unknown") {
        memory.freeSystemBlock(blockAddr, COM_TOTAL_SIZE);
        return;
    }
    poolFor((globalThis as any).__comSharedPool ? "shared" : owner).push(blockAddr);
}

/**
 * Verifies that the guard bytes around a COM object are intact.
 * Returns true if valid, false if corrupted.
 */
/** Thunk stub prologue: MOV EAX, imm32 */
export const COM_STUB_PROLOGUE = 0xb8;

/**
 * Verifies a vtable slot points at a valid OUT-trap stub (starts with MOV EAX).
 */
export const verifyComVtableSlot = (mem8: Uint8Array, stubAddr: number): boolean => {
    if (!stubAddr || stubAddr >= mem8.length) return false;
    return mem8[stubAddr] === COM_STUB_PROLOGUE;
};

export const checkComGuard = (mem8: Uint8Array, objAddr: number): boolean => {
    const view = new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);
    const addr = objAddr - COM_GUARD_SIZE;
    const totalSize = COM_GUARD_SIZE + COM_OBJECT_SIZE + COM_GUARD_SIZE;

    // Check bounds
    if (addr < 0 || addr + totalSize > mem8.length) {
        return false;
    }

    for (let i = 0; i < COM_GUARD_SIZE; i += 4) {
        if (view.getUint32(addr + i, true) !== COM_GUARD_VALUE) return false;
        if (view.getUint32(addr + totalSize - COM_GUARD_SIZE + i, true) !== COM_GUARD_VALUE) return false;
    }
    return true;
};
