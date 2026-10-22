/**
 * A PE image must be mappable over the records of images that are no longer loaded.
 *
 * FreeLibrary leaves an unloaded image mapped on purpose, so ModuleRegistry can hand the
 * same VA out again while AddressSpace still holds the old record. `releaseRegion` keys on
 * an EXACT base, which only covers reloading the same DLL in place: recycled VA is
 * coalesced, so the next image can start BELOW a leftover record and cover it. The
 * exact-base drop then misses, registerRegion refuses the mapping, and LoadLibrary
 * answers ERROR_MOD_NOT_FOUND for a DLL that is present.
 */

import { expect, test } from "bun:test";
import { AddressSpace } from "../../src/worker/core/memory/address-space";
import { PELoader } from "../../src/worker/core/pe-loader";
import { System } from "../../src/worker/core/system";

const MEM = new Uint8Array(0);
const mk = () => new AddressSpace(() => MEM);
/** initializeLayout sizes itself from the memory getter, so a laid-out space needs one
 *  that reports a real span; the buffer itself is never read here. */
const RAM_BYTES = 1024 * 1024 * 1024;
const mkWithLayout = () => {
    const as = new AddressSpace(() => ({ length: RAM_BYTES } as unknown as Uint8Array));
    as.initializeLayout(RAM_BYTES);
    return as;
};

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

function fragmentedImage() {
    const space = mkWithLayout();
    space.mapRegion(STALE_BASE, STALE_SIZE, "rwx", "ROM", "PELoader", "dll");
    expect(space.protect(STALE_BASE + 0x4000, 0x4000, "noaccess", 1)).toBe(true);
    const loader = new PELoader(() => MEM, {} as any, {} as any) as any;
    return { space, loader };
}

test("a live image remains mapped when only a non-base protection fragment overlaps", () => {
    const { space, loader } = fragmentedImage();
    loader.moduleRegistry = { getByBase: (base: number) => base === STALE_BASE ? {} : undefined };
    const before = space.getRegions();
    expect(loader.dropStaleImageRegions(space, STALE_BASE + 0x5000, 0x1000, "live")).toEqual([]);
    expect(space.getRegions()).toEqual(before);
    expect(space.validateRange(STALE_BASE + 0x5000, 1, "r")).toBe(false);
});

test("removing a stale image snapshots every sibling, including outside the new span", () => {
    const { space, loader } = fragmentedImage();
    loader.moduleRegistry = { getByBase: () => undefined };
    const before = space.findRegionsIntersecting(STALE_BASE, STALE_SIZE);
    const dropped = loader.dropStaleImageRegions(space, STALE_BASE + 0x5000, 0x1000, "stale");
    expect(dropped).toEqual(before);
    expect(dropped).toHaveLength(3);
    expect(space.findRegionsIntersecting(STALE_BASE, STALE_SIZE)).toHaveLength(0);
});

test("rejected preferred placement restores all image fragments and their allocation identity", () => {
    const { space, loader } = fragmentedImage();
    loader.moduleRegistry = { getByBase: () => undefined, allocateBase: () => 0x26000000 };
    const before = space.findRegionsIntersecting(STALE_BASE, STALE_SIZE);
    const snapshot = (entries: typeof before) => entries
        .map(({ id: _id, ...region }) => region).sort((a, b) => a.base - b.base);
    const system = System.getInstance() as any, saved = system.process;
    system.process = { addressSpace: space, memory: { canPlaceImageAt: () => false } };
    try {
        expect(loader.chooseDllBase(STALE_BASE + 0x5000, 0x1000, "fallback.dll")).toBe(0x26000000);
        const after = space.findRegionsIntersecting(STALE_BASE, STALE_SIZE);
        expect(snapshot(after)).toEqual(snapshot(before));
        expect(new Set(after.map(region => region.id)).size).toBe(after.length);
        expect(after.every(region => !before.some(old => old.id === region.id))).toBe(true);
        expect(space.protect(STALE_BASE + 0x3000, 0x6000, "r")).toBe(true);
        expect(space.validateRange(STALE_BASE + 0x3000, 0x6000, "r")).toBe(true);
        expect(space.releaseRegion(STALE_BASE)).toBe(true);
        expect(space.findRegionsIntersecting(STALE_BASE, STALE_SIZE)).toHaveLength(0);
    } finally { system.process = saved; }
});

test("the ROM layout bucket is never offered for release", () => {
    // Without a layout there is no bucket to exclude and the assertion below would pass
    // on an empty list — the ROM bucket spans every image VA and is allowOverlap, so a
    // span search that returned it would have the loader dropping the bucket itself.
    const as = mkWithLayout();
    const romBucket = as.getRegions().find(r => r.kind === "ROM" && r.owner === "Layout");
    expect(romBucket).toBeDefined();
    expect(romBucket!.base).toBeLessThanOrEqual(IMAGE_BASE);
    expect(romBucket!.base + romBucket!.size).toBeGreaterThanOrEqual(IMAGE_BASE + IMAGE_SIZE);

    as.mapRegion(STALE_BASE, STALE_SIZE, "rwx", "ROM", "PELoader", "dll");
    const hits = as.findRegionsIntersecting(IMAGE_BASE, IMAGE_SIZE);
    expect(hits.map(r => r.base)).toEqual([STALE_BASE]);
});
