// The predicate the ROM-prefetch policy rests on: "is this entry already readable
// without awaiting?".
//
// It decides whether a boot pulls a file's whole body into RAM before the guest runs.
// Getting it wrong in the permissive direction is silent and expensive — Far Cry moved
// 2.6 GB to reach its main menu to serve 37 MB of guest reads, because every STORED
// entry was copied into romCache for a capability it already had. Getting it wrong in
// the strict direction is silent and WORSE: a config file that is not pinned and cannot
// be range-read synchronously reads as empty (Morrowind aborts with "Font 0 not found").
//
// So both directions are pinned here, including the one that made the original
// formulation (`typeof source.readRangeSync === "function"`) wrong: a block cache over
// an async-only transport HAS the method and still answers null for a cold block.

import { describe, it, expect } from "bun:test";
import { ZipArchive } from "@bottleship/formats/zip";
import type { ZipEntry, ZipSource } from "@bottleship/formats/zip";
import { CachedSource } from "../../src/worker/runtime/filesystem/cached-source";

class AsyncOnlySource implements ZipSource {
    size = 4096;
    async readRange(start: number, end: number): Promise<Uint8Array> {
        return new Uint8Array(Math.max(0, end - start));
    }
}

class SyncSource implements ZipSource {
    size = 4096;
    async readRange(start: number, end: number): Promise<Uint8Array> {
        return new Uint8Array(Math.max(0, end - start));
    }
    readRangeSync(start: number, end: number): Uint8Array | null {
        return new Uint8Array(Math.max(0, end - start));
    }
}

function entry(compression: number): ZipEntry {
    return {
        name: "game/data.pak",
        compressedSize: 1024,
        uncompressedSize: 1024,
        compression,
        localHeaderOffset: 0,
        isDirectory: false,
    };
}

describe("ROM-prefetch policy predicate (ZipArchive.canRangeReadSync)", () => {
    it("a STORED entry over a sync source needs no RAM copy", () => {
        expect(new ZipArchive(new SyncSource()).canRangeReadSync(entry(0))).toBe(true);
    });

    it("a DEFLATED entry never qualifies — a range read cannot inflate", () => {
        expect(new ZipArchive(new SyncSource()).canRangeReadSync(entry(8))).toBe(false);
    });

    it("an async-only source never qualifies", () => {
        expect(new ZipArchive(new AsyncOnlySource()).canRangeReadSync(entry(0))).toBe(false);
    });

    it("a block cache over an async-only source does NOT qualify, method or not", () => {
        // The regression this exists for: CachedSource exposes readRangeSync, so a
        // presence check calls this sync-readable — and the first read of a cold block
        // returns null, which the caller above reads as EOF.
        const cache = new CachedSource(new AsyncOnlySource());
        expect(typeof cache.readRangeSync).toBe("function");
        expect(cache.syncFaultCapable).toBe(false);
        expect(new ZipArchive(cache).canRangeReadSync(entry(0))).toBe(false);
    });

    it("a block cache over a sync source does qualify", () => {
        const cache = new CachedSource(new SyncSource());
        expect(cache.syncFaultCapable).toBe(true);
        expect(new ZipArchive(cache).canRangeReadSync(entry(0))).toBe(true);
    });
});
