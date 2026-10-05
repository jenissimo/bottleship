// CachedSource under a cursor hint (plan/streamed-io-architecture.md, stage 3).
//
// The hint is what separates "streaming through one 50 MB entry" from "two unrelated
// reads that happen to be adjacent in the archive". Without it a block cache can only
// speculate linearly, which at a file boundary fetches somebody else's bytes and on a
// seek keeps filling the window of the file the guest just left.
//
// Each counter here is exercised in BOTH directions — the case that must move it and
// the case that must leave it alone — because a waste counter that only ever goes up
// and a waste counter that is wired to the wrong event look identical from one side.

import { describe, it, expect } from "bun:test";
import { CachedSource } from "../../src/worker/runtime/filesystem/cached-source";
import type { ReadHint, ZipSource } from "@bottleship/formats/zip";

const BLOCK = 16;

function ramp(n: number): Uint8Array {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = i & 0xff;
    return a;
}

/** Sync AND async capable (like SabIoSource), recording what each path was asked for. */
class FakeSource implements ZipSource {
    size: number;
    syncRanges: Array<[number, number]> = [];
    asyncRanges: Array<[number, number]> = [];
    asyncHints: Array<ReadHint | undefined> = [];
    private data: Uint8Array;

    constructor(data: Uint8Array) { this.data = data; this.size = data.byteLength; }

    readRangeSync(start: number, end: number): Uint8Array {
        this.syncRanges.push([start, end]);
        return this.data.slice(start, Math.min(end, this.size));
    }

    async readRange(start: number, end: number, hint?: ReadHint): Promise<Uint8Array> {
        this.asyncRanges.push([start, end]);
        this.asyncHints.push(hint);
        return this.data.slice(start, Math.min(end, this.size));
    }
}

function hint(entryStart: number, entryEnd: number, cursor: number, sequential: boolean): ReadHint {
    return { entryStart, entryEnd, cursor, sequential };
}

/** Let the prefetch promises settle. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("CachedSource cursor hint", () => {
    it("never reads ahead past the entry's end", async () => {
        const fake = new FakeSource(ramp(1600));
        const c = new CachedSource(fake, { blockSize: BLOCK, prefetchAheadBlocks: 4, prefetchDepthRuns: 2 });
        // Entry occupies [0, 160): reading its last blocks must not pull the archive
        // bytes past it, which belong to a file nobody asked for.
        c.readRangeSync(128, 144, hint(0, 160, 128, true));
        await settle();
        for (const [, end] of fake.asyncRanges) expect(end).toBeLessThanOrEqual(160);
        expect(fake.asyncRanges.length).toBeGreaterThan(0);
    });

    it("does not speculate for a caller that says it is not scanning", async () => {
        const fake = new FakeSource(ramp(1600));
        const c = new CachedSource(fake, { blockSize: BLOCK, prefetchAheadBlocks: 4, prefetchDepthRuns: 2 });
        c.readRangeSync(0, 16, hint(0, 1600, 0, false));
        await settle();
        expect(fake.asyncRanges.length).toBe(0);
        // …and the same source DOES speculate once the caller is sequential, so the
        // zero above is the gate working, not prefetch being broken outright.
        c.readRangeSync(16, 32, hint(0, 1600, 16, true));
        await settle();
        expect(fake.asyncRanges.length).toBeGreaterThan(0);
    });

    it("re-anchors on an entry change instead of filling the file the guest left", async () => {
        const fake = new FakeSource(ramp(1600));
        const c = new CachedSource(fake, { blockSize: BLOCK, prefetchAheadBlocks: 4, prefetchDepthRuns: 1 });
        c.readRangeSync(128, 144, hint(0, 160, 128, true));
        await settle();
        fake.asyncRanges.length = 0;
        // A different entry, 40 blocks away — a station switch, in the workload this
        // was written for. Readahead must follow it immediately.
        c.readRangeSync(640, 656, hint(640, 800, 640, true));
        await settle();
        expect(fake.asyncRanges.length).toBeGreaterThan(0);
        for (const [start, end] of fake.asyncRanges) {
            expect(start).toBeGreaterThanOrEqual(640);
            expect(end).toBeLessThanOrEqual(800);
        }
    });

    it("passes the entry down to the inner source's speculative reads", async () => {
        const fake = new FakeSource(ramp(1600));
        const c = new CachedSource(fake, { blockSize: BLOCK, prefetchAheadBlocks: 4, prefetchDepthRuns: 1 });
        c.readRangeSync(0, 16, hint(0, 160, 0, true));
        await settle();
        expect(fake.asyncHints.length).toBeGreaterThan(0);
        expect(fake.asyncHints[0]?.entryEnd).toBe(160);
        expect(fake.asyncHints[0]?.sequential).toBe(true);
    });
});

describe("CachedSource stage-3 counters", () => {
    it("counts unique first-touched bytes once, and only for new ground", () => {
        const fake = new FakeSource(ramp(1 << 20));
        const c = new CachedSource(fake, { blockSize: BLOCK });
        const granule = c.stats().touchGranuleBytes;

        c.readRangeSync(0, 16);
        const first = c.stats().uniqueTouchedBytes;
        expect(first).toBe(granule);

        c.readRangeSync(0, 16); // a re-read must not grow it — that is the whole point
        expect(c.stats().uniqueTouchedBytes).toBe(first);

        c.readRangeSync(granule, granule + 16); // new ground must
        expect(c.stats().uniqueTouchedBytes).toBe(first + granule);
    });

    it("charges prefetched blocks that were evicted unread — and only those", async () => {
        // Budget for 4 blocks, so a prefetched run that nothing reads gets pushed out.
        const fake = new FakeSource(ramp(1600));
        const c = new CachedSource(fake, {
            blockSize: BLOCK, maxBytes: 4 * BLOCK, prefetchAheadBlocks: 2, prefetchDepthRuns: 1,
        });
        c.readRangeSync(0, 16, hint(0, 1600, 0, true));
        await settle();
        // Walk far away, block by block, evicting everything speculated behind us.
        for (let b = 20; b < 40; b++) c.readRangeSync(b * BLOCK, b * BLOCK + BLOCK, hint(0, 1600, b * BLOCK, false));
        await settle();
        expect(c.stats().prefetchEvictedUnreadBytes).toBeGreaterThan(0);

        // The other direction: a prefetched block the guest DOES read is not waste, and
        // must not be charged when it is later evicted.
        const f2 = new FakeSource(ramp(1600));
        const c2 = new CachedSource(f2, {
            blockSize: BLOCK, maxBytes: 4 * BLOCK, prefetchAheadBlocks: 2, prefetchDepthRuns: 1,
        });
        c2.readRangeSync(0, 16, hint(0, 5 * BLOCK, 0, true));
        await settle();
        // Consume the whole entry, so every block speculation pulled was read…
        for (let b = 1; b < 5; b++) { c2.readRangeSync(b * BLOCK, b * BLOCK + BLOCK, hint(0, 5 * BLOCK, b * BLOCK, true)); await settle(); }
        // …then evict all of it by reading elsewhere with speculation off.
        for (let b = 60; b < 70; b++) c2.readRangeSync(b * BLOCK, b * BLOCK + BLOCK, hint(600 * BLOCK, 700 * BLOCK, b * BLOCK, false));
        expect(c2.stats().prefetchEvictedUnreadBytes).toBe(0);
    });
});
