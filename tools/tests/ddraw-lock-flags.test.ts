/**
 * DirectDraw Lock flag algebra (wine wined3dmapflags_from_ddrawmapflags) and the
 * decision the Lock prologue builds on top of it.
 * Flag values inlined so this file does not pull ddraw/d3d module init.
 */
import { describe, expect, test } from "bun:test";
import {
    lockImpliesRead,
    lockImpliesWrite,
    lockImpliesReadOrWrite,
    decideLockSync,
    lockMustNotBlock,
    noteReadLockServedStale,
    compareStaleServe,
    skipStaleServeComparison,
    readLockDivergenceCounters,
} from "../../src/worker/modules/ddraw/lock-flags";
import { clipLockRect, landRegionRows, regionOfBox } from "../../src/worker/modules/ddraw/readback-region";

const DDLOCK_WAIT = 0x00000001;
const DDLOCK_READONLY = 0x00000010;
const DDLOCK_WRITEONLY = 0x00000020;
const DDLOCK_NOOVERWRITE = 0x00001000;
const DDLOCK_DISCARDCONTENTS = 0x00002000;
const DDLOCK_DONOTWAIT = 0x00004000;

const SPLIT = { width: 64, height: 32, splitStorage: true };
const UNIFIED = { width: 64, height: 32, splitStorage: false };

describe("ddraw lock flags (wine algebra)", () => {
    test("READONLY implies read only", () => {
        expect(lockImpliesRead(DDLOCK_READONLY)).toBe(true);
        expect(lockImpliesWrite(DDLOCK_READONLY)).toBe(false);
        expect(lockImpliesReadOrWrite(DDLOCK_READONLY)).toEqual({ read: true, write: false });
    });

    test("WRITEONLY implies write only — no download", () => {
        // BoD HUD: DDLOCK_WAIT | DDLOCK_WRITEONLY = 0x21
        const flags = DDLOCK_WAIT | DDLOCK_WRITEONLY;
        expect(lockImpliesRead(flags)).toBe(false);
        expect(lockImpliesWrite(flags)).toBe(true);
    });

    test("DISCARD / NOOVERWRITE suppress READ", () => {
        expect(lockImpliesRead(DDLOCK_DISCARDCONTENTS)).toBe(false);
        expect(lockImpliesRead(DDLOCK_NOOVERWRITE)).toBe(false);
        expect(lockImpliesWrite(DDLOCK_DISCARDCONTENTS)).toBe(true);
    });

    test("flagless Lock implies read+write", () => {
        expect(lockImpliesRead(0)).toBe(true);
        expect(lockImpliesWrite(0)).toBe(true);
    });

    test("WAIT alone does not suppress READ", () => {
        expect(lockImpliesRead(DDLOCK_WAIT)).toBe(true);
        expect(lockImpliesRead(DDLOCK_WAIT | DDLOCK_READONLY)).toBe(true);
    });
});

describe("decideLockSync", () => {
    test("the app's own READ survives into the decision", () => {
        const d = decideLockSync(SPLIT, DDLOCK_WAIT | DDLOCK_READONLY, null);
        expect(d).toMatchObject({ read: true, write: false, preserveForWrite: false, wait: true });
    });

    test("split render storage preserves GPU pixels for WRITEONLY/NOOVERWRITE", () => {
        for (const flags of [DDLOCK_WRITEONLY, DDLOCK_NOOVERWRITE]) {
            const d = decideLockSync(SPLIT, flags, null);
            expect(d.read).toBe(true);
            expect(d.write).toBe(true);
            // The rule is named: this READ is ours, not the app's.
            expect(d.preserveForWrite).toBe(true);
        }
        expect(decideLockSync(UNIFIED, DDLOCK_WRITEONLY, null).read).toBe(false);
        expect(decideLockSync(UNIFIED, DDLOCK_WRITEONLY, null).preserveForWrite).toBe(false);
    });

    test("DISCARDCONTENTS is the only split-storage write lock that may skip preservation", () => {
        expect(decideLockSync(SPLIT, DDLOCK_DISCARDCONTENTS, null).read).toBe(false);
        expect(decideLockSync(SPLIT, DDLOCK_DISCARDCONTENTS | DDLOCK_WRITEONLY, null).read).toBe(false);
    });

    test("a read-only sub-rect Lock is box-scoped", () => {
        // ddraw7.c get_surface_color(): the canonical read lock is a 1x1 READONLY rect.
        const d = decideLockSync(SPLIT, DDLOCK_READONLY, { left: 5, top: 7, right: 6, bottom: 8 });
        expect(d.box).toEqual({ left: 5, top: 7, right: 6, bottom: 8 });
    });

    test("a rect that covers the surface, or clips to nothing, is not a box", () => {
        expect(decideLockSync(SPLIT, DDLOCK_READONLY, { left: 0, top: 0, right: 64, bottom: 32 }).box).toBeNull();
        expect(decideLockSync(SPLIT, DDLOCK_READONLY, { left: 9, top: 9, right: 9, bottom: 9 }).box).toBeNull();
        expect(decideLockSync(SPLIT, DDLOCK_READONLY, { left: 200, top: 0, right: 300, bottom: 4 }).box).toBeNull();
    });

    test("a lock that may write is never box-scoped", () => {
        // Unlock uploads the UNION of written rects, and that bounding box covers pixels
        // no rect-scoped preserve ever downloaded.
        const rect = { left: 1, top: 1, right: 4, bottom: 4 };
        expect(decideLockSync(SPLIT, 0, rect).box).toBeNull();
        expect(decideLockSync(SPLIT, DDLOCK_WRITEONLY, rect).box).toBeNull();
    });
});

describe("DDERR_WASSTILLDRAWING contract", () => {
    test("DDLOCK_WAIT accepts blocking", () => {
        const d = decideLockSync(SPLIT, DDLOCK_WAIT | DDLOCK_READONLY, null);
        expect(lockMustNotBlock(d, DDLOCK_WAIT | DDLOCK_READONLY)).toBe(false);
    });

    // Wine strips DDLOCK_WAIT as a no-op (utils.c:578) and the conformance suite locks with a
    // bare DDLOCK_READONLY and asserts success (ddraw7.c:461-462): only DDLOCK_DONOTWAIT is
    // an opt-out, and "WAIT absent" is not its inverse.
    test("only an explicit DONOTWAIT forbids blocking", () => {
        expect(lockMustNotBlock(decideLockSync(SPLIT, DDLOCK_READONLY, null), DDLOCK_READONLY)).toBe(false);
        const flags = DDLOCK_WAIT | DDLOCK_DONOTWAIT;
        expect(lockMustNotBlock(decideLockSync(SPLIT, flags, null), flags)).toBe(true);
        expect(lockMustNotBlock(decideLockSync(SPLIT, DDLOCK_DONOTWAIT, null), DDLOCK_DONOTWAIT)).toBe(true);
    });

    test("__noLockDoNotWait reverts to always blocking", () => {
        const g = globalThis as { __noLockDoNotWait?: boolean };
        g.__noLockDoNotWait = true;
        try {
            expect(lockMustNotBlock(decideLockSync(SPLIT, DDLOCK_READONLY, null), DDLOCK_READONLY)).toBe(false);
        } finally {
            delete g.__noLockDoNotWait;
        }
    });
});

describe("readback region geometry", () => {
    test("a boxed download and a full download land identical bytes", () => {
        const width = 7, height = 5, bpp = 2, pitch = 20; // padded pitch, odd width
        const truth = new Uint8Array(width * height * bpp);
        for (let i = 0; i < truth.length; i++) truth[i] = (i * 37 + 11) & 0xff;

        const full = new Uint8Array(pitch * height);
        landRegionRows(truth, width * bpp, height, full, 0, pitch);

        // Same surface assembled from four boxes that tile it.
        const tiled = new Uint8Array(pitch * height);
        const boxes = [
            { left: 0, top: 0, right: 3, bottom: 2 },
            { left: 3, top: 0, right: 7, bottom: 2 },
            { left: 0, top: 2, right: 7, bottom: 5 },
            { left: 0, top: 4, right: 7, bottom: 5 }, // deliberate overlap: must be idempotent
        ];
        for (const box of boxes) {
            const r = regionOfBox(clipLockRect(box, width, height), width, height);
            const rowBytes = r.width * bpp;
            const mapped = new Uint8Array(rowBytes * r.height);
            for (let y = 0; y < r.height; y++) {
                const src = (r.y + y) * width * bpp + r.x * bpp;
                mapped.set(truth.subarray(src, src + rowBytes), y * rowBytes);
            }
            landRegionRows(mapped, rowBytes, r.height, tiled, r.y * pitch + r.x * bpp, pitch);
        }

        expect(Array.from(tiled)).toEqual(Array.from(full));
    });

    test("landing respects the destination pitch (no shear)", () => {
        const dest = new Uint8Array(3 * 4);
        landRegionRows(new Uint8Array([1, 2, 3, 4, 5, 6]), 2, 3, dest, 1, 4);
        expect(Array.from(dest)).toEqual([0, 1, 2, 0, 0, 3, 4, 0, 0, 5, 6, 0]);
    });
});

describe("read-lock divergence instrument", () => {
    test("counts diverged pixels and the largest byte delta", () => {
        readLockDivergenceCounters.reset();
        const surface = {};
        noteReadLockServedStale(surface, 4);

        // 2x2 ARGB surface at a padded pitch; one pixel differs by 0x20 in one channel.
        const pitch = 12;
        const served = new Uint8Array(pitch * 2);
        const truth = new Uint8Array(2 * 4 * 2);
        served.set([1, 2, 3, 4, 5, 6, 7, 8], 0);
        served.set([9, 10, 11, 12, 13, 14, 15, 16], pitch);
        truth.set([1, 2, 3, 4, 5, 6, 7, 8], 0);
        truth.set([9, 10, 11, 12, 13, 14 + 0x20, 15, 16], 8);

        compareStaleServe(surface, 4, served, 0, pitch, truth, 8, 2, 4);

        expect(readLockDivergenceCounters.locksServedStale).toBe(1);
        expect(readLockDivergenceCounters.readbacksCompared).toBe(1);
        expect(readLockDivergenceCounters.framesDiverged).toBe(1);
        expect(readLockDivergenceCounters.pixelsDiverged).toBe(1);
        expect(readLockDivergenceCounters.maxChannelDelta).toBe(0x20);
    });

    test("a version bump between serve and readback cancels the comparison", () => {
        readLockDivergenceCounters.reset();
        const surface = {};
        noteReadLockServedStale(surface, 4);
        const bytes = new Uint8Array(8);
        compareStaleServe(surface, 5, bytes, 0, 8, new Uint8Array(8).fill(0xff), 8, 1, 4);
        expect(readLockDivergenceCounters.readbacksCompared).toBe(0);
        expect(readLockDivergenceCounters.pixelsDiverged).toBe(0);
    });

    test("an un-comparable readback path is counted, not silently dropped", () => {
        readLockDivergenceCounters.reset();
        const surface = {};
        noteReadLockServedStale(surface, 1);
        skipStaleServeComparison(surface);
        expect(readLockDivergenceCounters.comparisonsSkipped).toBe(1);
        // The debt is settled: a later readback must not attribute itself to this serve.
        skipStaleServeComparison(surface);
        expect(readLockDivergenceCounters.comparisonsSkipped).toBe(1);
    });

    test("no stale serve means no comparison, so a zero row is structural", () => {
        readLockDivergenceCounters.reset();
        compareStaleServe({}, 1, new Uint8Array(8), 0, 8, new Uint8Array(8).fill(0xff), 8, 1, 4);
        expect(readLockDivergenceCounters.readbacksCompared).toBe(0);
        expect(readLockDivergenceCounters.framesDiverged).toBe(0);
    });
});
