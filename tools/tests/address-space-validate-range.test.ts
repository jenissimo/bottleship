/**
 * AddressSpace.validateRange — differential test against the reference sweep.
 *
 * validateRange is the mandated check on every guest-supplied pointer, so it is on
 * every HLE hot path; it answers from a stabbing index rather than a linear sweep of
 * `regions` (a loaded level registers ~1900 of them). The index is only sound if it
 * returns the SAME narrowest containing region as the sweep it replaced, including
 * for the deliberately-overlapping layout buckets — so the sweep is kept here as the
 * oracle and both are run over a randomised region map.
 *
 * The oracle is exercised negatively too (`the index must be able to disagree`): a
 * differential test that cannot fail is not a test.
 */

import { expect, test } from "bun:test";
import { AddressSpace, type RegionEntry, type RegionPerms } from "../../src/worker/core/memory/address-space";

const MEM = new Uint8Array(0);
const mk = () => new AddressSpace(() => MEM);

/** The pre-index implementation, verbatim, as the oracle. */
function sweepNarrowest(regions: RegionEntry[], address: number, size: number): RegionEntry | undefined {
    const end = address + size;
    let best: RegionEntry | undefined;
    for (const region of regions) {
        if (address < region.base || end > region.base + region.size) continue;
        if (!best || region.size < best.size) best = region;
    }
    return best;
}

function sweepValidate(regions: RegionEntry[], address: number, size: number, perms: string): boolean {
    if (address < 0 || size < 0) return false;
    const best = sweepNarrowest(regions, address, size);
    if (!best) return false;
    if (best.perms === "noaccess") return false;
    if (perms.includes("w") && !best.perms.includes("w")) return false;
    if (perms.includes("x") && !best.perms.includes("x")) return false;
    return true;
}

// Deterministic PRNG so a failure is reproducible.
let seed = 0x2545f491;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
const ri = (n: number) => Math.floor(rnd() * n);

const PERMS: RegionPerms[] = ["r", "rw", "rx", "rwx", "noaccess"];

/** A map shaped like a real one: overlapping layout buckets + many small disjoint regions. */
function buildMap(space: AddressSpace): RegionEntry[] {
    const add = (e: Omit<RegionEntry, "id">) => { space.registerRegion(e); };
    // Layout buckets: wide, overlapping, allowOverlap — the reason "narrowest wins" exists.
    add({ base: 0x0100_0000, size: 0x0400_0000, perms: "rw", kind: "HEAP", owner: "Layout", allowOverlap: true });
    add({ base: 0x0500_0000, size: 0x0400_0000, perms: "rw", kind: "SURFACE", owner: "Layout", allowOverlap: true });
    add({ base: 0x0900_0000, size: 0x0100_0000, perms: "r", kind: "ROM", owner: "Layout", allowOverlap: true });
    // Many small regions inside them, some with tighter perms than their bucket.
    let cursor = 0x0500_0000;
    for (let i = 0; i < 400; i++) {
        const size = (1 + ri(64)) * 0x1000;
        add({
            base: cursor, size,
            perms: PERMS[ri(PERMS.length)],
            kind: "SURFACE", owner: "test", allowOverlap: true, skipOverlapCheck: true,
        });
        cursor += size + ri(4) * 0x1000; // occasional gap
    }
    // A nested pair (region inside region) so "narrowest" is genuinely exercised.
    add({ base: 0x0200_0000, size: 0x0010_0000, perms: "rw", kind: "HEAP", owner: "test", allowOverlap: true, skipOverlapCheck: true });
    add({ base: 0x0200_1000, size: 0x0000_2000, perms: "r", kind: "HEAP", owner: "test", allowOverlap: true, skipOverlapCheck: true });
    // Read-only image inside the ROM bucket.
    add({ base: 0x0900_4000, size: 0x0002_0000, perms: "rx", kind: "ROM", owner: "test", allowOverlap: true, skipOverlapCheck: true });
    // Mirror = what the space actually holds (incl. the constructor's LOW_MEM region),
    // so the oracle can never be fed a different map than the implementation.
    return space.getRegions();
}

test("validateRange agrees with the linear sweep over a realistic map", () => {
    const space = mk();
    const mirror = buildMap(space);
    let disagreements = 0;
    let trues = 0;
    for (let i = 0; i < 20000; i++) {
        // Mix targeted probes (inside/at the edges of known regions) with random ones.
        const r = mirror[ri(mirror.length)];
        const addr = i % 3 === 0
            ? ri(0x0A00_0000)
            : r.base + ri(Math.max(1, r.size)) - ri(3);
        const size = ri(4) === 0 ? 0 : ri(0x8000);
        const perms = ["r", "rw", "rx"][ri(3)];
        const ours = space.validateRange(addr, size, perms);
        const oracle = sweepValidate(mirror, addr, size, perms);
        if (ours !== oracle) disagreements++;
        if (oracle) trues++;
    }
    // Both outcomes must actually occur, or the comparison proves nothing.
    expect(trues).toBeGreaterThan(100);
    expect(trues).toBeLessThan(19900);
    expect(disagreements).toBe(0);
});

test("agrees after regions are added and released mid-life (index invalidation)", () => {
    const space = mk();
    buildMap(space);
    const probe = () => {
        const mirror = space.getRegions();
        for (let i = 0; i < 2000; i++) {
            const r = mirror[ri(mirror.length)];
            const addr = r.base + ri(Math.max(1, r.size));
            const size = ri(0x2000);
            expect(space.validateRange(addr, size, "rw")).toBe(sweepValidate(mirror, addr, size, "rw"));
        }
    };
    // Query FIRST so the index is already built and a missing invalidation is observable
    // (a lazily-built index that has never been built cannot be stale).
    probe();

    // A readable address, chosen deterministically, that a new NOACCESS hole will cover.
    // Unique base: releaseRegion() matches the FIRST non-Layout region with that base,
    // so a hole sharing a base with an existing region would release the wrong one.
    const host = space.getRegions().find(
        (m) => m.owner === "test" && m.perms !== "noaccess" && m.size >= 0x4000,
    )!;
    const holeBase = host.base + 0x800;
    expect(space.validateRange(holeBase, 0x10, "r")).toBe(true);

    space.registerRegion({
        base: holeBase, size: 0x1000, perms: "noaccess", kind: "RESERVED",
        owner: "hole", allowOverlap: true, skipOverlapCheck: true,
    });
    // Fails loudly if registerRegion stops invalidating the index.
    expect(space.validateRange(holeBase, 0x10, "r")).toBe(false);
    probe();

    space.releaseRegion(holeBase);
    expect(space.getRegions().some((m) => m.owner === "hole")).toBe(false);
    // Fails loudly if releaseRegion stops invalidating the index.
    expect(space.validateRange(holeBase, 0x10, "r")).toBe(true);
    probe();

    // protect() mutates perms in place; the index holds references, so perms must be read
    // live (no invalidation needed) — assert that rather than assume it.
    space.protect(host.base, host.size, "noaccess");
    expect(space.validateRange(host.base, 1, "r")).toBe(false);
    probe();
});

test("the oracle can disagree — a corrupted index would be caught", () => {
    // Feed the oracle a map missing the narrow read-only region and confirm it then
    // reports writable where the real space reports not-writable. Without this, a
    // vacuously-passing comparison above would look identical to a real one.
    const space = mk();
    const mirror = buildMap(space);
    const narrow = mirror.find((m) => m.base === 0x0200_1000)!;
    expect(narrow.perms).toBe("r");
    expect(space.validateRange(narrow.base, 0x100, "w")).toBe(false);
    const without = mirror.filter((m) => m !== narrow);
    expect(sweepValidate(without, narrow.base, 0x100, "w")).toBe(true);
});

test("a range ending EXACTLY at a region's end is contained", () => {
    // The stabbing prune compares the running max end against the query's end; using
    // `<=` there silently drops the region that ends exactly at it, and the caller sees
    // a perfectly in-bounds buffer rejected (a dropped draw). Boundary, so pinned.
    const space = mk();
    space.registerRegion({ base: 0x0100_0000, size: 0x0400_0000, perms: "rw", kind: "HEAP", owner: "Layout", allowOverlap: true });
    space.registerRegion({ base: 0x0200_0000, size: 0x0001_0000, perms: "r", kind: "ROM", owner: "test", allowOverlap: true, skipOverlapCheck: true });
    const end = 0x0200_0000 + 0x0001_0000;
    // Flush against the region's last byte: contained, and the NARROW read-only region
    // must win over the writable bucket.
    expect(space.validateRange(end - 0x100, 0x100, "r")).toBe(true);
    expect(space.validateRange(end - 0x100, 0x100, "w")).toBe(false);
    // One byte past it: only the bucket contains it, so it is writable again.
    expect(space.validateRange(end, 0x100, "w")).toBe(true);
    // Whole region exactly.
    expect(space.validateRange(0x0200_0000, 0x0001_0000, "r")).toBe(true);
});

test("agrees under alloc/free churn that crosses the rebuild threshold", () => {
    // The index folds recent adds and removal tombstones in only once enough accumulate,
    // so the interesting states are the ones BETWEEN rebuilds — reached only by churning
    // with queries interleaved, which is exactly what MemoryManager does.
    const space = mk();
    buildMap(space);
    const live: number[] = [];
    let base = 0x0800_0000;
    for (let round = 0; round < 400; round++) {
        if (round % 3 !== 2 || live.length === 0) {
            base += 0x2000;
            space.registerRegion({
                base, size: 0x1000, perms: PERMS[ri(PERMS.length)], kind: "SURFACE",
                owner: "churn", allowOverlap: true, skipOverlapCheck: true,
            });
            live.push(base);
        } else {
            const [gone] = live.splice(ri(live.length), 1);
            space.releaseRegion(gone);
        }
        // Query every round so stale state would be observed, not skipped over.
        const mirror = space.getRegions();
        for (let i = 0; i < 12; i++) {
            const r = mirror[ri(mirror.length)];
            const addr = r.base + ri(Math.max(1, r.size)) - ri(2);
            const size = ri(0x1000);
            const perms = ["r", "rw", "rx"][ri(3)];
            expect(space.validateRange(addr, size, perms)).toBe(sweepValidate(mirror, addr, size, perms));
        }
    }
    expect(live.length).toBeGreaterThan(64); // threshold really was crossed
});
