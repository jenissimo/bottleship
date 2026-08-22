/**
 * D3D8 LockRect semantics as a scene that judges itself.
 *
 * Same shape as the DDraw Lock conformance scene, one layer down: these are the statements
 * DXVK's `LockImage` makes about the D3DLOCK_* flag set (d3d9_device.cpp — D3D8 and D3D9
 * share the flags and the driver contract), checked against `decideD3D8LockSync`. Every row
 * prints EXPECTED and OBSERVED rather than a bare boolean, because a row that cannot say
 * what it saw is not evidence.
 *
 * The GPU half — that a render-target Lock really does get this frame's pixels — is already
 * covered by `ddraw-lock-conformance.harness.ts`: D3D8 render surfaces ARE DDraw render
 * surfaces and are read back by the same sync manager. What is NOT covered anywhere else,
 * and is what actually changed here, is the flag algebra, which is pure and so belongs in a
 * deterministic suite rather than behind a GPU.
 *
 * Each row is then SHOWN capable of failing: MUTATIONS re-runs the table against a
 * deliberately broken algebra, and the verdict is taken against the CLEAN run. A row that
 * was already red proves nothing — crediting a mutation with it would turn "the suite is
 * red" into "every mutation is caught" — so it reports UNPROVABLE, which is neither a pass
 * nor a miss but a statement that the baseline must be fixed first.
 */
import { describe, expect, test } from "bun:test";
import {
    decideD3D8LockSync,
    locksFullResource,
    d3d8LockMustNotBlock,
    d3d8LockCounters,
    noteD3D8Lock,
    type D3D8LockSurfaceShape,
    type LockRect,
} from "../../src/worker/modules/d3d8/lock-flags";

const D3DLOCK_READONLY = 0x00000010;
const D3DLOCK_NOOVERWRITE = 0x00001000;
const D3DLOCK_DISCARD = 0x00002000;
const D3DLOCK_DONOTWAIT = 0x20000000;

const RT: D3D8LockSurfaceShape = { width: 64, height: 32, splitStorage: true, poolDefault: true };
const MANAGED: D3D8LockSurfaceShape = { width: 64, height: 32, splitStorage: true, poolDefault: false };
const FULL: LockRect = { left: 0, top: 0, right: 64, bottom: 32 };
const SUB: LockRect = { left: 8, top: 4, right: 16, bottom: 12 };

interface Row {
    name: string;
    /** Where the statement comes from. */
    src: string;
    expected: string;
    observed: (decide: typeof decideD3D8LockSync) => string;
}

/** The conformance table. `observed` is a function of the algebra so a mutation can swap it. */
const ROWS: Row[] = [
    {
        name: "readonly.narrowsWriteNotReadback",
        src: "dxvk d3d9_device.cpp:4878-4880 + :5033-5041 (renderable ⇒ needsReadback)",
        expected: "read=true write=false",
        observed: (d) => {
            const r = d(RT, D3DLOCK_READONLY, null);
            return `read=${r.read} write=${r.write}`;
        },
    },
    {
        name: "plainLock.impliesWrite",
        src: "dxvk: READONLY absent ⇒ the app may write",
        expected: "read=true write=true preserveForWrite=true",
        observed: (d) => {
            const r = d(RT, 0, null);
            return `read=${r.read} write=${r.write} preserveForWrite=${r.preserveForWrite}`;
        },
    },
    {
        name: "discard.fullDefaultPoolHonoured",
        src: "dxvk :5025-5026 — DISCARD survives a full-resource POOL_DEFAULT lock",
        expected: "discard=true read=false",
        observed: (d) => {
            const r = d(RT, D3DLOCK_DISCARD, FULL);
            return `discard=${r.discard} read=${r.read}`;
        },
    },
    {
        name: "discard.strippedOnSubRect",
        src: "dxvk :5025-5026 — `if (!fullResource) Flags &= ~D3DLOCK_DISCARD`",
        expected: "discard=false read=true",
        observed: (d) => {
            const r = d(RT, D3DLOCK_DISCARD, SUB);
            return `discard=${r.discard} read=${r.read}`;
        },
    },
    {
        name: "discard.strippedOnManagedPool",
        src: "dxvk :5025-5026 — DISCARD is a POOL_DEFAULT renaming hint",
        expected: "discard=false",
        observed: (d) => `discard=${d(MANAGED, D3DLOCK_DISCARD, FULL).discard}`,
    },
    {
        name: "discard.losesToNoOverwrite",
        src: "dxvk :4965-4966 — DISCARD|NOOVERWRITE strips DISCARD",
        expected: "discard=false",
        observed: (d) => `discard=${d(RT, D3DLOCK_DISCARD | D3DLOCK_NOOVERWRITE, FULL).discard}`,
    },
    {
        name: "discard.readonlyDefaultPoolInvalid",
        src: "dxvk :4955-4957 — DISCARD|READONLY on POOL_DEFAULT is D3DERR_INVALIDCALL",
        expected: "invalid=true",
        observed: (d) => `invalid=${d(RT, D3DLOCK_DISCARD | D3DLOCK_READONLY, FULL).invalid}`,
    },
    {
        name: "box.scopedOnlyForReadOnly",
        src: "a writable Unlock uploads a bounding box that covers pixels no lock preserved",
        expected: "readonlySub=8x8 writableSub=null",
        observed: (d) => {
            const ro = d(RT, D3DLOCK_READONLY, SUB).box;
            const rw = d(RT, 0, SUB).box;
            return `readonlySub=${ro ? `${ro.right - ro.left}x${ro.bottom - ro.top}` : "null"} `
                + `writableSub=${rw ? "set" : "null"}`;
        },
    },
    {
        name: "box.fullRectIsWholeSurface",
        src: "readback-region.clipLockRect — a rect covering the surface is not a sub-rect",
        expected: "box=null fullResource=true",
        observed: (d) => {
            const r = d(RT, D3DLOCK_READONLY, FULL);
            return `box=${r.box === null ? "null" : "set"} fullResource=${locksFullResource(FULL, 64, 32)}`;
        },
    },
    {
        name: "donotwait.strippedForImages",
        src: "dxvk :4959-4961 — apps spin on Map, so a texture Lock never says WASSTILLDRAWING",
        expected: "mustNotBlock=false",
        observed: () => `mustNotBlock=${d3d8LockMustNotBlock(D3DLOCK_DONOTWAIT)}`,
    },
];

// ── mutations: each must break the rows it names ────────────────────────────────────
type Mutation = "honour-discard-on-subrect" | "readonly-skips-readback" | "scope-writable-lock";

const MUTATIONS: Record<Mutation, { how: string; rows: string[] }> = {
    "honour-discard-on-subrect": {
        how: "drop the `!fullResource` strip, so a DISCARD lock of a sub-rect wipes the whole surface",
        rows: ["discard.strippedOnSubRect"],
    },
    "readonly-skips-readback": {
        how: "treat READONLY as 'the app will not read', so no GPU round trip is requested",
        rows: ["readonly.narrowsWriteNotReadback"],
    },
    "scope-writable-lock": {
        how: "scope a WRITABLE lock's download to its rect, so the preserve leaves stale pixels outside it",
        rows: ["box.scopedOnlyForReadOnly"],
    },
};

const mutated = (m: Mutation): typeof decideD3D8LockSync => (surface, flags, rect) => {
    const real = decideD3D8LockSync(surface, flags, rect);
    switch (m) {
        case "honour-discard-on-subrect": {
            const discard = (flags & D3DLOCK_DISCARD) !== 0 && surface.poolDefault;
            return { ...real, discard, read: discard ? false : real.read };
        }
        case "readonly-skips-readback":
            return (flags & D3DLOCK_READONLY) !== 0 ? { ...real, read: false } : real;
        case "scope-writable-lock":
            return { ...real, box: rect ? { ...rect } : null };
    }
};

const evaluate = (d: typeof decideD3D8LockSync): Map<string, { observed: string; pass: boolean }> => {
    const out = new Map<string, { observed: string; pass: boolean }>();
    for (const row of ROWS) {
        let observed: string;
        try {
            observed = row.observed(d);
        } catch (e) {
            observed = `threw ${e}`;
        }
        out.set(row.name, { observed, pass: observed === row.expected });
    }
    return out;
};

describe("d3d8 lock conformance (dxvk LockImage statements)", () => {
    const clean = evaluate(decideD3D8LockSync);

    test("every conformance row states expected and observed", () => {
        const w = Math.max(...ROWS.map((r) => r.name.length));
        for (const row of ROWS) {
            const got = clean.get(row.name)!;
            console.log(`  ${got.pass ? "PASS" : "FAIL"}  ${row.name.padEnd(w)}  `
                + `expected ${row.expected}  observed ${got.observed}`);
            if (!got.pass) console.log(`        ${row.src}`);
        }
        const failed = ROWS.filter((r) => !clean.get(r.name)!.pass);
        expect(failed.map((r) => `${r.name}: ${clean.get(r.name)!.observed}`)).toEqual([]);
    });

    for (const [name, spec] of Object.entries(MUTATIONS) as [Mutation, { how: string; rows: string[] }][]) {
        test(`mutation '${name}' is caught`, () => {
            const dirty = evaluate(mutated(name));
            const verdicts = spec.rows.map((rowName) => {
                const before = clean.get(rowName)!;
                const after = dirty.get(rowName)!;
                // A row already red before the mutation proves nothing about it.
                if (!before.pass) return { rowName, verdict: "UNPROVABLE" as const, after };
                return { rowName, verdict: after.pass ? "MISSED" as const : "CAUGHT" as const, after };
            });
            for (const v of verdicts) {
                console.log(`  ${v.verdict.padEnd(10)} ${name} -> ${v.rowName}  observed ${v.after.observed}`);
            }
            console.log(`        how: ${spec.how}`);
            expect(verdicts.filter((v) => v.verdict !== "CAUGHT")).toEqual([]);
        });
    }
});

describe("d3d8 lock census", () => {
    test("records the opportunity, and can say it was never wired", () => {
        d3d8LockCounters.reset();
        // A bare zero is ambiguous; the census reads zero ONLY when nothing was recorded.
        expect(d3d8LockCounters.locks).toBe(0);

        const sub = decideD3D8LockSync(RT, D3DLOCK_READONLY, SUB);
        noteD3D8Lock(RT, D3DLOCK_READONLY, SUB, sub);
        expect(d3d8LockCounters.locks).toBe(1);
        expect(d3d8LockCounters.partialRectLocks).toBe(1);
        expect(d3d8LockCounters.scopableLocks).toBe(1);
        // 8x8 named out of 64x32 — the saving scoping could buy.
        expect(d3d8LockCounters.requestedPixels).toBe(64);
        expect(d3d8LockCounters.surfacePixels).toBe(64 * 32);

        const full = decideD3D8LockSync(RT, D3DLOCK_READONLY, null);
        noteD3D8Lock(RT, D3DLOCK_READONLY, null, full);
        // A full-surface lock names every pixel, so scoping can save nothing for it.
        expect(d3d8LockCounters.requestedPixels).toBe(64 + 64 * 32);

        const stripped = decideD3D8LockSync(RT, D3DLOCK_DISCARD, SUB);
        noteD3D8Lock(RT, D3DLOCK_DISCARD, SUB, stripped);
        expect(d3d8LockCounters.discardRequested).toBe(1);
        expect(d3d8LockCounters.discardStripped).toBe(1);
        d3d8LockCounters.reset();
    });
});
