/**
 * Regression for F8: CachedSource must never turn a SHORT inner read into a zero-filled
 * full-length buffer.
 *
 * The caller advances its cursor by the length it asked for, so zero padding is not a
 * visible failure — it is corruption that reads as data. Two halves: a short block must
 * not be CACHED (or every later hit serves the padding from RAM, with no second chance
 * to notice), and the assembled result must be TRUNCATED at the short block.
 */
import { describe, expect, test } from "bun:test";
import { CachedSource } from "../../src/worker/runtime/filesystem/cached-source";
import type { ZipSource } from "@bottleship/formats/zip";

const BLOCK = 1024;

/** A source that under-delivers a chosen block, then heals. */
function flakySource(size: number, opts: { shortFrom?: number; shortTo?: number; sync?: boolean }): {
    src: ZipSource;
    heal(): void;
    syncCalls: number[];
} {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i % 251) + 1; // never 0 — padding is detectable
    let broken = true;
    const syncCalls: number[] = [];

    const clampEnd = (start: number, end: number): number => {
        if (!broken) return end;
        const from = opts.shortFrom ?? 0;
        const to = opts.shortTo ?? size;
        if (start >= from && end > to) return to; // deliver less than asked
        return end;
    };

    const src: ZipSource = {
        size,
        async readRange(start: number, end: number) {
            return bytes.subarray(start, clampEnd(start, end));
        },
    };
    if (opts.sync !== false) {
        (src as { readRangeSync?: (s: number, e: number) => Uint8Array | null }).readRangeSync =
            (start: number, end: number) => {
                syncCalls.push(start);
                return bytes.subarray(start, clampEnd(start, end));
            };
    }
    return { src, heal: () => { broken = false; }, syncCalls };
}

describe("F8 — a short block is neither cached nor zero-filled", () => {
    test("readRangeSync returns the short prefix, not a padded full-length buffer", () => {
        // Block 0 is complete; block 1 comes back 100 bytes short of its end.
        const { src } = flakySource(4 * BLOCK, { shortFrom: BLOCK, shortTo: 2 * BLOCK - 100 });
        const cache = new CachedSource(src, { blockSize: BLOCK, maxBytes: 16 * BLOCK });

        const got = cache.readRangeSync(0, 2 * BLOCK);
        expect(got).not.toBeNull();
        // Whatever length comes back, every byte of it must be real data.
        expect(got!.length).toBeLessThan(2 * BLOCK);
        expect(got!.every((b) => b !== 0)).toBe(true);
    });

    test("a short block is not cached, so a later read re-faults and gets it right", async () => {
        const { src, heal } = flakySource(4 * BLOCK, { shortFrom: BLOCK, shortTo: 2 * BLOCK - 100 });
        const cache = new CachedSource(src, { blockSize: BLOCK, maxBytes: 16 * BLOCK });

        const short = cache.readRangeSync(BLOCK, 2 * BLOCK);
        expect(short!.length).toBeLessThan(BLOCK);

        // The source recovers. If the short block had been cached, this would still be
        // served from RAM — padded — forever.
        heal();
        const full = cache.readRangeSync(BLOCK, 2 * BLOCK);
        expect(full!.length).toBe(BLOCK);
        expect(full!.every((b) => b !== 0)).toBe(true);
    });

    test("the async path truncates at the short block too", async () => {
        const { src } = flakySource(4 * BLOCK, { shortFrom: 0, shortTo: BLOCK - 32 });
        const cache = new CachedSource(src, { blockSize: BLOCK, maxBytes: 16 * BLOCK });

        const got = await cache.readRange(0, 2 * BLOCK);
        expect(got.length).toBeLessThan(2 * BLOCK);
        expect(got.every((b) => b !== 0)).toBe(true);
    });

    test("a complete read is unaffected", async () => {
        const { src } = flakySource(4 * BLOCK, {});
        const cache = new CachedSource(src, { blockSize: BLOCK, maxBytes: 16 * BLOCK });
        (src as { readRangeSync?: unknown }).readRangeSync = undefined;

        const got = await cache.readRange(BLOCK / 2, 2 * BLOCK + 7);
        expect(got.length).toBe(2 * BLOCK + 7 - BLOCK / 2);
        expect(got.every((b) => b !== 0)).toBe(true);
    });
});
