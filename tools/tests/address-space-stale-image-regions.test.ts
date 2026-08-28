/**
 * A PE image must be mappable over the records of images that are no longer loaded.
 *
 * FreeLibrary leaves an unloaded image mapped on purpose, so ModuleRegistry can hand the
 * same VA out again while AddressSpace still holds the old record. `releaseRegion` keys on
 * an EXACT base, which only covers reloading the same DLL in place: recycled VA is
 * coalesced, so the next (larger) image can start BELOW a leftover record and cover it.
 * The exact-base drop then misses, registerRegion refuses the mapping, and LoadLibrary
 * answers ERROR_MOD_NOT_FOUND for a DLL that is present — Sea Dogs lost `land_sector.dll`
 * this way and rendered nothing for the rest of the session.
 *
 * The spans below are the ones the failure was observed with.
 */

import { expect, test } from "bun:test";
import { AddressSpace } from "../../src/worker/core/memory/address-space";

const MEM = new Uint8Array(0);
const mk = () => new AddressSpace(() => MEM);

const STALE_BASE = 0x24040000;
const STALE_SIZE = 0x0000c000;
const IMAGE_BASE = 0x24030000;   // below the stale record …
const IMAGE_SIZE = 0x00031000;   // … and covering it

test("a stale image record inside the new span is found (the exact-base drop misses it)", () => {
    const as = mk();
    as.mapRegion(STALE_BASE, STALE_SIZE, "rwx", "ROM", "PELoader", "dll");

    // What the old code did: drop by exact base. The stale record does not start there.
    expect(as.releaseRegion(IMAGE_BASE)).toBe(false);

    const hit = as.findRegionsIntersecting(IMAGE_BASE, IMAGE_SIZE)
        .filter(r => r.kind === "ROM" && r.owner === "PELoader");
    expect(hit.map(r => r.base)).toEqual([STALE_BASE]);
});

test("dropping the intersecting records lets the new image map", () => {
    const as = mk();
    as.mapRegion(STALE_BASE, STALE_SIZE, "rwx", "ROM", "PELoader", "dll");

    for (const r of as.findRegionsIntersecting(IMAGE_BASE, IMAGE_SIZE)) {
        if (r.kind === "ROM" && r.owner === "PELoader") as.releaseRegion(r.base);
    }
    expect(() => as.mapRegion(IMAGE_BASE, IMAGE_SIZE, "rwx", "ROM", "PELoader", "dll")).not.toThrow();
});

test("without the drop the mapping is refused — the check can fail", () => {
    const as = mk();
    as.mapRegion(STALE_BASE, STALE_SIZE, "rwx", "ROM", "PELoader", "dll");
    expect(() => as.mapRegion(IMAGE_BASE, IMAGE_SIZE, "rwx", "ROM", "PELoader", "dll")).toThrow(/region overlap/);
});

test("layout buckets are never offered for release", () => {
    const as = mk();
    // The ROM layout bucket spans every image VA and is marked allowOverlap; a span search
    // that returned it would have the loader dropping the bucket itself.
    const hits = as.findRegionsIntersecting(IMAGE_BASE, IMAGE_SIZE);
    expect(hits.every(r => r.owner !== "Layout")).toBe(true);
});
