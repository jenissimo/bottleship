import { describe, expect, test } from "bun:test";
import { CachedSource } from "../../src/worker/runtime/filesystem/cached-source";
import { SparseWgbCache } from "../../src/worker/runtime/filesystem/sparse-wgb-cache";
import { StreamIoRuntime } from "../../src/worker/runtime/filesystem/stream-io-runtime";
import { FakeDirHandle, FakeFileHandle } from "./fixtures/fake-opfs";
import { orderFilesByProfile, parseIoProfile, profileChunkOrder } from "@bottleship/formats/wgb/io-profile";
import { currentIoReadPolicy, withIoReadPolicy } from "../../src/worker/runtime/filesystem/io-read-policy";
import { VirtualFileSystem, type VfsFileHandle } from "../../src/worker/runtime/filesystem/vfs";
import { type ReadHint, type ZipSource, type ZipArchive, type ZipEntry } from "@bottleship/formats/zip";

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function bytes(n = 1024): Uint8Array {
    const out = Uint8Array.from({ length: n }, (_, i) => (i * 13 + (i >> 3)) & 255);
    new DataView(out.buffer).setUint32(n - 22, 0x06054b50, true);
    out.fill(0, n - 18);
    return out;
}
class Source implements ZipSource {
    readonly size: number;
    reads: Array<[number, number, boolean]> = [];
    active = 0;
    peak = 0;
    held: Array<() => void> = [];
    holding = false;
    constructor(readonly data: Uint8Array) { this.size = data.length; }
    async readRange(start: number, end: number, hint?: ReadHint): Promise<Uint8Array> {
        this.reads.push([start, end, hint?.speculative === true]);
        this.active++; this.peak = Math.max(this.peak, this.active);
        if (this.holding) await new Promise<void>(resolve => this.held.push(resolve));
        else await tick();
        this.active--;
        return this.data.slice(start, end);
    }
    release(): void { this.holding = false; for (const f of this.held.splice(0)) f(); }
}
function runtime(source: Source, disk: SparseWgbCache | null = null, cacheBytes = 128): StreamIoRuntime {
    return new StreamIoRuntime(source, { chunkBytes: 64, maxInflight: 4, cacheBytes, prefetchChunks: 4 }, disk);
}
function dir(): FileSystemDirectoryHandle { return new FakeDirHandle("cache") as unknown as FileSystemDirectoryHandle; }
const version = { url: "/apps/runtime-test.wgb", etag: '"v1"', size: 1024 };
async function disk(directory = dir(), etag = '"v1"'): Promise<{ cache: SparseWgbCache; residency: Int32Array }> {
    const residency = new Int32Array(new SharedArrayBuffer(4));
    const cache = await SparseWgbCache.open({ ...version, etag }, 64, residency, directory);
    expect(cache).not.toBeNull();
    return { cache: cache!, residency };
}

describe("stream transport", () => {
    test("parallel demand is bounded, coalesced and byte-exact with absolute ledgers", async () => {
        const source = new Source(bytes()); source.holding = true;
        const rt = runtime(source);
        const a = rt.read(0, 512), b = rt.read(32, 128);
        expect(source.active).toBe(4);
        source.release();
        const [first, second] = await Promise.all([a, b]);
        expect(first).toEqual(source.data.slice(0, 512));
        expect(second).toEqual(source.data.slice(32, 160));
        expect(source.peak).toBe(4);
        expect(source.reads.length).toBe(8);
        expect(rt.stats.chunksNeeded).toBe(11);
        expect(rt.stats.chunksFetchedCold).toBe(8);
        expect(rt.stats.chunksJoinedInflight).toBe(3);
        expect(rt.stats.netBytes).toBe(512);
        rt.close();
    });

    test("speculation reserves slots and a queued demand overtakes queued guesses", async () => {
        const source = new Source(bytes()); source.holding = true;
        const rt = runtime(source);
        const hint = { entryStart: 0, entryEnd: 1024, cursor: 0, sequential: false, speculative: true };
        const guesses = rt.read(0, 512, hint);
        expect(source.active).toBe(2);
        const demand = rt.read(768, 64);
        expect(source.reads[2][0]).toBe(768);
        expect(source.active).toBe(3);
        source.release();
        await Promise.all([guesses, demand]);
        expect(source.peak).toBeLessThanOrEqual(4);
        rt.close();
    });

    test("disk eviction and restart serve the same transcript without a new network fetch", async () => {
        const directory = dir();
        const { cache, residency } = await disk(directory);
        const source = new Source(bytes()); const rt = runtime(source, cache);
        const transcript = [[0, 64], [320, 64], [512, 64], [0, 64]];
        const output = [];
        for (const [off, len] of transcript) output.push(await rt.read(off, len));
        expect(source.reads.length).toBe(3);
        expect(rt.stats.chunksDiskHit).toBe(1);
        expect(rt.stats.chunksNeeded).toBe(4);
        expect(rt.stats.chunksFetchedCold).toBe(3);
        expect(rt.stats.netBytes).toBe(192);
        expect(Atomics.load(residency, 0)).toBe((1 << 0) | (1 << 5) | (1 << 8));
        rt.close(); await cache.close();

        const restored = await disk(directory); const other = new Source(source.data);
        const next = runtime(other, restored.cache);
        for (let i = 0; i < transcript.length; i++) expect(await next.read(...transcript[i] as [number, number])).toEqual(output[i]);
        expect(other.reads.length).toBe(0);
        expect(next.stats.chunksNeeded).toBe(4);
        expect(next.stats.chunksDiskHit + next.stats.chunksResidentHit).toBe(4);
        next.close(); await restored.cache.close();
    });

    test("fill fetches contiguous ranges only while idle and persists every chunk", async () => {
        const { cache } = await disk();
        const source = new Source(bytes()); source.holding = true;
        const rt = runtime(source, cache);
        const demand = rt.read(0, 64);
        rt.startFill([8]);
        expect(source.reads.length).toBe(1);
        source.release(); await demand;
        for (let tries = 0; cache.downloadedChunks < 16 && tries < 100; tries++) await tick();
        expect(cache.downloadedChunks).toBe(16);
        expect(source.reads[1][0]).toBe(512);
        expect(source.reads[1][2]).toBe(true);
        expect(rt.stats.fillFetches).toBe(2);
        expect(rt.stats.netBytes).toBe(1024);
        expect(rt.stats.fillBytes).toBe(960);
        rt.close(); await cache.close();
    });

    test("a new ETag discards a same-size sparse copy", async () => {
        const directory = dir(); const old = await disk(directory);
        old.cache.write(3, bytes().slice(192, 256)); await old.cache.close();
        const fresh = await disk(directory, '"v2"');
        expect(fresh.cache.has(3)).toBe(false);
        expect(Atomics.load(fresh.residency, 0)).toBe(0);
        await fresh.cache.close();
    });

    test("failed bitmap commit does not publish residency", async () => {
        const directory = dir(); const { cache, residency } = await disk(directory);
        const handle = await directory.getFileHandle("runtime-test.wgb.bitmap") as unknown as FakeFileHandle;
        const original = handle.createSyncAccessHandle;
        // Fail the handle the cache already owns, after its initialization flush.
        const internal = cache as unknown as { bitmap: { flush(): void } };
        internal.bitmap.flush = () => { throw new Error("disk full"); };
        expect(() => cache.write(2, bytes().slice(128, 192))).toThrow("disk full");
        expect(cache.has(2)).toBe(false);
        expect(Atomics.load(residency, 0)).toBe(0);
        handle.createSyncAccessHandle = original;
        await cache.close();
    });

    test("failed sparse initialization clears tentative residency before ready", async () => {
        const directory = dir();
        const old = await disk(directory);
        old.cache.write(2, bytes().slice(128, 192)); await old.cache.close();
        const bitFile = await directory.getFileHandle("runtime-test.wgb.bitmap") as unknown as FakeFileHandle;
        const original = bitFile.createSyncAccessHandle.bind(bitFile);
        bitFile.createSyncAccessHandle = async () => {
            const handle = await original();
            handle.flush = () => { throw new Error("bitmap unavailable"); };
            return handle;
        };
        const residency = new Int32Array(new SharedArrayBuffer(4));
        expect(await SparseWgbCache.open(version, 64, residency, directory)).toBeNull();
        expect(Atomics.load(residency, 0)).toBe(0);
    });
});

describe("block cache and profile", () => {
    test("async multi-block reads start together and synchronous runs align to one chunk", async () => {
        const source = new Source(bytes()); source.holding = true;
        const cached = new CachedSource(source, { blockSize: 64 });
        const read = cached.readRange(0, 512);
        expect(source.active).toBe(8);
        source.release(); expect(await read).toEqual(source.data.slice(0, 512));
        const ranges: Array<[number, number]> = [];
        const aligned = new CachedSource({ size: 1024, readRange: source.readRange.bind(source),
            readRangeSync: (s, e) => { ranges.push([s, e]); return source.data.slice(s, e); } },
            { blockSize: 64, syncReadaheadBlocks: 4, syncAlignmentBytes: 256 });
        expect(aligned.readRangeSync(128, 192)).toEqual(source.data.slice(128, 192));
        expect(ranges).toEqual([[0, 256]]);
    });

    test("profiles log delivered first touches in order, phases and filenames survive repacking", async () => {
        const source = new Source(bytes(192 * 1024));
        const cached = new CachedSource(source, { recordProfile: true });
        const hint = { entryName: "rom/b.bin", entryStart: 0, entryEnd: source.size, cursor: 0, sequential: false };
        await cached.readRange(65536, 65540, hint);
        cached.setProfilePhase("first-level");
        await cached.readRange(0, 4, { ...hint, entryName: "rom/a.bin" });
        await cached.readRange(65536, 65540, hint);
        const profile = parseIoProfile(cached.profile());
        expect(profile.accesses.map(a => [a.granule, a.phase, a.entryName])).toEqual([[1, "loading", "rom/b.bin"], [0, "first-level", "rom/a.bin"]]);
        expect(profileChunkOrder(profile, 65536, ["first-level"])).toEqual([0]);
        expect(orderFilesByProfile(new Map([["rom/a.bin", 1], ["rom/b.bin", 2], ["rom/c.bin", 3]]), profile).map(([n]) => n))
            .toEqual(["rom/b.bin", "rom/a.bin", "rom/c.bin"]);
    });

    test("read leases restore on exception and cannot leak between callers", () => {
        expect(currentIoReadPolicy()).toBe("may-block");
        expect(() => withIoReadPolicy("park-preferred", () => {
            expect(currentIoReadPolicy()).toBe("park-preferred");
            withIoReadPolicy("must-not-block", () => { throw new Error("stop"); });
        })).toThrow("stop");
        expect(currentIoReadPolicy()).toBe("may-block");
    });

    test("file ordering records small files even when their granule was touched by a header", async () => {
        const source = new Source(bytes());
        const cached = new CachedSource(source, { recordProfile: true });
        await cached.readRange(0, 30);
        const hint = { entryStart: 30, entryEnd: 1024, cursor: 30, sequential: false };
        await cached.readRange(30, 34, { ...hint, entryName: "rom/b" });
        await cached.readRange(60, 64, { ...hint, entryName: "rom/a" });
        const profile = parseIoProfile(cached.profile());
        expect(profile.accesses.length).toBe(1);
        expect(profile.files?.map(f => f.entryName)).toEqual(["rom/b", "rom/a"]);
        expect(orderFilesByProfile(new Map([["rom/a", 1], ["rom/b", 2]]), profile).map(([name]) => name)).toEqual(["rom/b", "rom/a"]);
    });

    test("parked reads serialize one file object, and guest targets are re-derived after await", async () => {
        const data = Uint8Array.from({ length: 16 }, (_, i) => i);
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const entry: ZipEntry = { name: "rom/a", compressedSize: 16, uncompressedSize: 16, compression: 0, localHeaderOffset: 0, isDirectory: false };
        const archive = { readEntryRangeSync: () => null, readEntry: async () => { await gate; return data; },
            readEntryRange: async (_: ZipEntry, offset: number, len: number) => { await gate; return data.slice(offset, offset + len); } } as unknown as ZipArchive;
        const vfs = new VirtualFileSystem(); vfs.mountRom(archive, "rom", new Map([["a", entry]]));
        const handle = vfs.openSync("C:\\a", 0x80000000, 3)! as VfsFileHandle;
        let target = new Uint8Array(16); const stale = target;
        const first = vfs.readInto(handle, () => target, 0, 4);
        const second = vfs.read(handle, 4);
        expect(vfs.readSync(handle, 4, "park-preferred")).toBeNull();
        expect(handle.position).toBe(0);
        target = new Uint8Array(16); release();
        expect(await first).toBe(4);
        expect(target.slice(0, 4)).toEqual(data.slice(0, 4));
        expect(stale.slice(0, 4)).toEqual(new Uint8Array(4));
        expect(await second).toEqual(data.slice(4, 8));
        expect(handle.position).toBe(8);
    });

    test("a multi-chunk readInto holds the cursor until its complete logical read finishes", async () => {
        const n = 6 * 1024 * 1024;
        const data = Uint8Array.from({ length: n + 8 }, (_, i) => (i >>> 20) + 1);
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const entry: ZipEntry = { name: "rom/large", compressedSize: data.length, uncompressedSize: data.length,
            compression: 0, localHeaderOffset: 0, isDirectory: false };
        const archive = { readEntryRangeSync: () => null,
            readEntry: async () => { await gate; return data; },
            readEntryRange: async (_: ZipEntry, offset: number, len: number) => { await gate; return data.slice(offset, offset + len); } } as unknown as ZipArchive;
        const vfs = new VirtualFileSystem(); vfs.mountRom(archive, "rom", new Map([["large", entry]]));
        const handle = vfs.openSync("C:\\large", 0x80000000, 3)!;
        const target = new Uint8Array(n);
        const first = vfs.readInto(handle, target, 0, n), second = vfs.read(handle, 8);
        release();
        const [nRead, tail] = await Promise.all([first, second]);
        expect(nRead).toBe(n);
        expect(target).toEqual(data.slice(0, n));
        expect(tail).toEqual(data.slice(n));
        expect(handle.position).toBe(n + 8);
    });
});
