/**
 * The two pieces of the D3D9 lock work that decide a verdict without needing a GPU: the
 * D3DLOCK_* algebra itself, and whether an injected bug was actually caught.
 *
 * Both can be wrong in ways that still print something plausible — a strip rule that never
 * fires makes DISCARD look honoured, and an inverted blind-group test turns "the mutation
 * changed nothing" into a proof that the assertion works. Every row prints expected AND
 * observed, and each is shown able to fail by mutating the decision it checks.
 *
 * Rules and their source (DXVK `src/d3d9/d3d9_device.cpp`, function `LockImage` at :4939):
 *   :4956-4958  DISCARD | READONLY on POOL_DEFAULT is D3DERR_INVALIDCALL
 *   :4964-4965  DISCARD | NOOVERWRITE — DISCARD loses
 *   :5026-5027  DISCARD honoured only for a full-resource lock on POOL_DEFAULT
 */

import { describe, expect, it } from "bun:test";
import {
    D3DLOCK_DISCARD, D3DLOCK_NOOVERWRITE, D3DLOCK_READONLY,
    decideLockFlags, locksFullResource, makeLockCensus, noteLock,
} from "../../src/worker/modules/d3d-common/lock-flags";
import { groupVerdict } from "../../src/worker/harness/cmds/conformance-verdict";
import {
    MUTATIONS, decodeXrgb, swapRb, mutationVerdict,
    type ConformanceCheck, type Mutation,
} from "../../src/worker/harness/cmds/d3d9-conformance-eval";

const W = 64, H = 64;
const full = null;
const sub = { left: 0, top: 0, right: 8, bottom: 8 };

const row = (name: string, pass: boolean): ConformanceCheck =>
    ({ name, source: "", expected: "", observed: "", pass });

const allGreenFor = (checks: ConformanceCheck[]): ConformanceCheck[] =>
    checks.map((c) => ({ ...c, pass: true }));

describe("D3DLOCK_* algebra (DXVK LockImage)", () => {
    it("honours DISCARD for a full-resource POOL_DEFAULT lock (:5026-5027)", () => {
        const d = decideLockFlags(D3DLOCK_DISCARD, full, W, H, true);
        expect({ discard: d.discard, stripped: d.discardStripped })
            .toEqual({ discard: true, stripped: false });
    });

    it("strips DISCARD when the lock named a sub-rect (:5026-5027)", () => {
        // The bug this rule prevents: honouring it here wipes the 4032 pixels the app
        // never named.
        const d = decideLockFlags(D3DLOCK_DISCARD, sub, W, H, true);
        expect({ discard: d.discard, stripped: d.discardStripped })
            .toEqual({ discard: false, stripped: true });
    });

    it("strips DISCARD outside POOL_DEFAULT (:5026-5027)", () => {
        expect(decideLockFlags(D3DLOCK_DISCARD, full, W, H, false).discard).toBe(false);
    });

    it("lets NOOVERWRITE beat DISCARD (:4964-4965)", () => {
        expect(decideLockFlags(D3DLOCK_DISCARD | D3DLOCK_NOOVERWRITE, full, W, H, true).discard)
            .toBe(false);
    });

    it("rejects DISCARD | READONLY on POOL_DEFAULT (:4956-4958)", () => {
        expect(decideLockFlags(D3DLOCK_DISCARD | D3DLOCK_READONLY, full, W, H, true).invalid)
            .toBe(true);
        // …and only on POOL_DEFAULT.
        expect(decideLockFlags(D3DLOCK_DISCARD | D3DLOCK_READONLY, full, W, H, false).invalid)
            .toBe(false);
    });

    it("reports READONLY as not-writable, and a bare lock as writable", () => {
        expect(decideLockFlags(D3DLOCK_READONLY, full, W, H, true).write).toBe(false);
        expect(decideLockFlags(0, full, W, H, true).write).toBe(true);
    });

    it("calls a rect that covers every pixel a full-resource lock", () => {
        expect(locksFullResource({ left: 0, top: 0, right: W, bottom: H }, W, H)).toBe(true);
        expect(locksFullResource(sub, W, H)).toBe(false);
        expect(locksFullResource(null, W, H)).toBe(true);
    });
});

describe("lock census", () => {
    it("separates a stripped DISCARD from one that was never asked for", () => {
        const c = makeLockCensus();
        const decision = decideLockFlags(D3DLOCK_DISCARD, sub, W, H, true);
        noteLock(c, { width: W, height: H, splitStorage: true }, decision,
            { discard: true, read: true, scopable: false });
        noteLock(c, { width: W, height: H, splitStorage: true },
            decideLockFlags(0, full, W, H, true),
            { discard: false, read: true, scopable: false });
        expect({ locks: c.locks, requested: c.discardRequested, stripped: c.discardStripped })
            .toEqual({ locks: 2, requested: 1, stripped: 1 });
    });

    it("prices only the resources whose pixels also live on the GPU", () => {
        const c = makeLockCensus();
        noteLock(c, { width: W, height: H, splitStorage: false },
            decideLockFlags(0, full, W, H, true), { discard: false, read: true, scopable: false });
        expect({ locks: c.locks, gpu: c.renderSurfaceLocks, pixels: c.surfacePixels })
            .toEqual({ locks: 1, gpu: 0, pixels: 0 });
    });
});

describe("pixel decode", () => {
    it("ignores the X channel of an X8R8G8B8 word", () => {
        expect(decodeXrgb(0xff00ff00)).toBe(0x00ff00);
        expect(decodeXrgb(0x00123456)).toBe(0x123456);
    });

    it("names the red/blue exchange a channel-order slip produces", () => {
        expect(swapRb(0xff0000)).toBe(0x0000ff);
        expect(swapRb(0x00ff00)).toBe(0x00ff00);
        expect(swapRb(0x123456)).toBe(0x563412);
    });
});

describe("mutation effectiveness", () => {
    it("calls a mutation blind when the rows it targets stayed green", () => {
        const allGreen = Object.values(MUTATIONS).flatMap((m) => m.groups)
            .map((g) => row(`${g}probe`, true));
        for (const name of Object.keys(MUTATIONS) as Mutation[]) {
            expect(mutationVerdict(allGreen, allGreen, name).blind)
                .toEqual(MUTATIONS[name]!.groups);
        }
    });

    it("clears a group as soon as ONE row in it fails", () => {
        const checks = [row("sublock.pixelAt(0,0)", true), row("sublock.pixelAt(17,5)", false)];
        expect(mutationVerdict(allGreenFor(checks), checks, "ignore-subrect").caught)
            .toEqual(["sublock."]);
    });

    it("reports a group that was ALREADY red as unprovable, not as caught", () => {
        // Crediting the mutation with a row the clean run had already failed turns "the
        // suite is red" into "every mutation is caught" — the failure this whole scene
        // exists to prevent.
        const baseline = [row("rtdata.clearGreen", false)];
        const mutated = [row("rtdata.clearGreen", false)];
        const v = groupVerdict(["rtdata."], baseline, mutated);
        expect({ caught: v.caught, blind: v.blind, unprovable: v.unprovable })
            .toEqual({ caught: [], blind: [], unprovable: ["rtdata."] });
    });

    it("does not accept an unrelated failure as proof", () => {
        const checks = [row("rtdata.clearGreen", false), row("sublock.pixelAt(0,0)", true)];
        expect(mutationVerdict(allGreenFor(checks), checks, "ignore-subrect").blind)
            .toEqual(["sublock."]);
    });

    it("names every row group in the roster after a real assertion row", () => {
        // A group prefix matching no row the scene emits can never fail, so its mutation
        // would report itself blind forever.
        const emitted = [
            "rtdata.clearGreen", "rtdata.clearBlue", "rtlock.readsRenderedPixels",
            "sublock.pixelAt(0,0)", "sublock.pixelAt(17,5)", "sublock.pixelAt(63,63)",
            "lockflags.discardKeepsUnnamedPixels", "lockflags.readonlyDoesNotUpload",
        ];
        for (const m of Object.values(MUTATIONS)) {
            for (const g of m.groups) {
                expect(emitted.some((name) => name.startsWith(g))).toBe(true);
            }
        }
    });
});
