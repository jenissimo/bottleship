/**
 * Per-Lock/Unlock cost profiler for DirectDraw surfaces.
 *
 * `perfThunks` prices `IDirectDrawSurface7_Lock` as one number. This says WHICH part of
 * it is expensive, which is the difference between "the round trip to the GPU" and "our
 * own pixel loop". Phases:
 *
 *   setup     COM lookup, arg validation, op-ring record
 *   gdi       GDI canvas → CPU sync for a surface with a live HDC
 *   decide    needsCPUSync + z-buffer depth sync + the DDLOCK flag algebra
 *   scratch   syncSurfaceToMemoryFromScratch — the synchronous cached-RGBA sync
 *   readback  the awaited syncSurfaceToMemory (real GPU→CPU round trip)
 *   convert   NESTED in scratch/readback: convertRGBAToSurface. Our conversion and the
 *             store into guest memory at surfacePtr are one pass, so they are one phase.
 *   validate  pointer / rect / region validation
 *   desc      writeSurfaceDesc + the post-write lpSurface verification
 *   lease     createLease + dirty-region bookkeeping
 *   snap      NESTED in lease: captureActiveLeaseSnapshot (the pre-Lock pixel copy)
 *   ucompare  Unlock: consumeActiveLeaseWriteState (did the guest write anything?)
 *   udirty    NESTED in ucompare: dirtyBoxFromLeaseDiff (the dirty-region computation)
 *   ustate    Unlock: authority/mode bookkeeping + lease revoke
 *   upresent  NESTED in ustate: the primary auto-present kick. Fire-and-forget, so this
 *             is its synchronous prologue only, never the present itself.
 *   uupload   Unlock: marking the surface dirty for the CPU→GPU upload
 *
 * Rows are split by lock CLASS — a writable lock and a read-only lock take different
 * branches and cost different amounts, and averaging them hides both. `other` collects
 * conversion work reached from outside a Lock (the readback prefetch, Flip's GDI sync):
 * that row growing while `read`/`write` stay flat is what "the work moved off the Lock
 * critical path" looks like.
 *
 * Every phase reports its own `calls`. A phase that never ran reads `calls: 0`, which is
 * a different statement from `calls: N, perCallUs: 0` — the instrument can say it was
 * never wired rather than silently reporting a plausible zero.
 *
 * Singleton, like drawCostProfiler. ZERO overhead when disabled: call sites read the
 * public `enabled` boolean first and `now()` returns 0 when off, so `add()` early-outs.
 */

export const LOCK_COST_PHASES = [
    "setup",
    "gdi",
    "decide",
    "scratch",
    "readback",
    "convert",
    "validate",
    "desc",
    "lease",
    "snap",
    "ucompare",
    "udirty",
    "ustate",
    "upresent",
    "uupload",
] as const;
export type LockCostPhase = typeof LOCK_COST_PHASES[number];

/** Phase indices — used at call sites to avoid string lookups in the hot path. */
export const LP = {
    setup: 0,
    gdi: 1,
    decide: 2,
    scratch: 3,
    readback: 4,
    convert: 5,
    validate: 6,
    desc: 7,
    lease: 8,
    snap: 9,
    ucompare: 10,
    udirty: 11,
    ustate: 12,
    upresent: 13,
    uupload: 14,
} as const;

/** Lock classes. A Lock picks its class from DDLOCK_READONLY; an Unlock from the lease. */
export const LC = {
    /** Writable lock (DDLOCK_READONLY clear) — NFS's 0x821 WAIT|WRITEONLY|NOSYSLOCK. */
    write: 0,
    /** Read-only lock (DDLOCK_READONLY set) — NFS's 0x811. */
    read: 1,
    /** Reached from outside a Lock/Unlock: prefetch, Flip GDI sync, Blt. */
    other: 2,
} as const;
export type LockClass = typeof LC[keyof typeof LC];

const LOCK_CLASS_NAMES = ["write", "read", "other"] as const;

/** Phases whose time is already counted inside another phase — excluded from the total. */
const NESTED = new Set<number>([LP.convert, LP.snap, LP.udirty, LP.upresent]);

const NPHASE = LOCK_COST_PHASES.length;
const NCLASS = LOCK_CLASS_NAMES.length;

class LockCostProfiler {
    /** Public so hot-path sites can branch on it without a method call. */
    enabled = false;

    /**
     * Class attributed to work reached through a call chain that cannot pass one down
     * (convertRGBAToSurface is shared by Lock, the prefetch and Flip). Lock/Unlock set it
     * for their synchronous span and restore it on the way out; anything else lands in
     * `other`, which is the honest answer for a conversion nobody's Lock was waiting on.
     * It stays set across the one await (the readback), so a conversion another guest
     * thread starts inside that window is attributed to the awaiting Lock's class.
     */
    activeClass: LockClass = LC.other;

    private readonly sum = new Float64Array(NCLASS * NPHASE);
    private readonly max = new Float64Array(NCLASS * NPHASE);
    private readonly count = new Float64Array(NCLASS * NPHASE);
    private readonly locks = new Float64Array(NCLASS);
    private readonly unlocks = new Float64Array(NCLASS);
    private flips = 0;
    private windowStart = 0;

    enable(): void {
        this.reset();
        this.enabled = true;
    }

    disable(): void {
        this.enabled = false;
        this.activeClass = LC.other;
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    reset(): void {
        this.sum.fill(0);
        this.max.fill(0);
        this.count.fill(0);
        this.locks.fill(0);
        this.unlocks.fill(0);
        this.flips = 0;
        this.activeClass = LC.other;
        this.windowStart = performance.now();
    }

    /** Phase-start timestamp. Returns 0 when disabled so add() is a no-op. */
    now(): number {
        return this.enabled ? performance.now() : 0;
    }

    /** Accumulate elapsed since `start` into `phase` for `cls` (default: activeClass). */
    add(phase: number, start: number, cls: LockClass = this.activeClass): void {
        if (!this.enabled || start === 0) return;
        const i = cls * NPHASE + phase;
        const d = performance.now() - start;
        this.count[i]++;
        if (d > 0) {
            this.sum[i] += d;
            if (d > this.max[i]) this.max[i] = d;
        }
    }

    countLock(cls: LockClass): void {
        if (this.enabled) this.locks[cls]++;
    }

    countUnlock(cls: LockClass): void {
        if (this.enabled) this.unlocks[cls]++;
    }

    /** One guest Flip — the frame denominator for a flip-chain title. */
    countFlip(): void {
        if (this.enabled) this.flips++;
    }

    report() {
        const windowMs = performance.now() - this.windowStart;
        const classes = LOCK_CLASS_NAMES.map((name, c) => {
            const calls = this.locks[c] + this.unlocks[c];
            const denom = calls || 1;
            let totalMs = 0;
            for (let p = 0; p < NPHASE; p++) {
                if (!NESTED.has(p)) totalMs += this.sum[c * NPHASE + p];
            }
            const phases = LOCK_COST_PHASES.map((phaseName, p) => {
                const i = c * NPHASE + p;
                return {
                    phase: phaseName,
                    nested: NESTED.has(p) || undefined,
                    calls: this.count[i],
                    totalMs: +this.sum[i].toFixed(3),
                    perCallUs: this.count[i] ? +((this.sum[i] / this.count[i]) * 1000).toFixed(2) : 0,
                    maxUs: +(this.max[i] * 1000).toFixed(2),
                    pct: +((this.sum[i] / (totalMs || 1)) * 100).toFixed(1),
                };
            }).sort((a, b) => b.totalMs - a.totalMs);

            return {
                class: name,
                locks: this.locks[c],
                unlocks: this.unlocks[c],
                // null, not 0: no Flip in the window means there is no frame denominator,
                // which is a different fact from "zero locks per frame".
                locksPerFrame: this.flips ? +(this.locks[c] / this.flips).toFixed(2) : null,
                unlocksPerFrame: this.flips ? +(this.unlocks[c] / this.flips).toFixed(2) : null,
                measuredMs: +totalMs.toFixed(3),
                perCallUs: +((totalMs / denom) * 1000).toFixed(2),
                msPerFrame: this.flips ? +(totalMs / this.flips).toFixed(3) : null,
                phases,
            };
        });

        return {
            windowMs: +windowMs.toFixed(1),
            flips: this.flips,
            fastPixelStore: !(globalThis as { __noFastPixelStore?: boolean }).__noFastPixelStore,
            classes,
        };
    }
}

export const lockCostProfiler = new LockCostProfiler();
