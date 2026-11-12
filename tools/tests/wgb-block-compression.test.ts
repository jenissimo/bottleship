import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
    BufferSource, decodeBlockIndex, encodeBlockIndex, WGB_BLOCK_INDEX_ENTRY, ZipArchive,
    type ReadHint, type ZipSource,
} from "@bottleship/formats/zip";
import { ZipStoreWriter } from "../internal/zip-store-writer";
import { compressWgb } from "../wgb-compress";
import { buildRomIndex, checkBlockIndex, WgbLoader } from "../../src/worker/runtime/filesystem/wgb-loader";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import { installFakeOpfs } from "./fixtures/fake-opfs";

const BLOCK = 16 * 1024;
const logs = resolve("logs");
mkdirSync(logs, { recursive: true });
const root = mkdtempSync(join(logs, "wgb-block-compression-"));
afterAll(() => {
    if (!resolve(root).startsWith(logs + sep)) throw new Error("fixture outside logs");
    rmSync(root, { recursive: true, force: true });
});

function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function textLike(size: number, seed: number): Uint8Array {
    const r = rng(seed);
    const words = ["unit", "tank", "harvester", "ore", "power", "plant", "rocket", "soldier", "\r\n", "=", "1", "0"];
    const out = new Uint8Array(size);
    let p = 0;
    while (p < size) {
        const w = words[Math.floor(r() * words.length)];
        for (let i = 0; i < w.length && p < size; i++) out[p++] = w.charCodeAt(i);
        if (p < size) out[p++] = 32;
    }
    return out;
}

function noise(size: number, seed: number): Uint8Array {
    const r = rng(seed);
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) out[i] = Math.floor(r() * 256);
    return out;
}

const FILES: Record<string, Uint8Array> = {
    "manifest.json": new TextEncoder().encode(JSON.stringify({ formatVersion: 2, name: "fixture", entrypoint: "rom/game.exe", rom: "rom" })),
    "rom/game.exe": textLike(70_001, 1),
    "rom/data.mix": textLike(BLOCK * 9 + 777, 2),
    "rom/exact.bin": textLike(BLOCK * 4, 3),
    "rom/one.txt": textLike(12_000, 4),
    "rom/noise.bin": noise(BLOCK * 3 + 5, 5),
    "rom/empty.dat": new Uint8Array(0),
    "rom/theme.ogg": textLike(BLOCK * 2, 6),
};

function writeStored(path: string): void {
    const w = new ZipStoreWriter(path);
    for (const [name, data] of Object.entries(FILES)) w.addStored(name, data);
    w.finish();
}

const storedPath = join(root, "stored.wgb");
const packedPath = join(root, "packed.wgb");
writeStored(storedPath);
const report = await compressWgb(storedPath, packedPath, { blockKiB: BLOCK / 1024 });
const packed = new Uint8Array(readFileSync(packedPath));

class CountingSource implements ZipSource {
    readonly size: number;
    readonly hints: ReadHint[] = [];
    readonly syncSpans: Array<[number, number]> = [];
    syncAnswers = true;
    shortBy = 0;
    constructor(private readonly data: Uint8Array) { this.size = data.byteLength; }
    async readRange(start: number, end: number, hint?: ReadHint): Promise<Uint8Array> {
        if (hint) this.hints.push(hint);
        await Promise.resolve();
        return this.data.slice(start, end - this.shortBy);
    }
    readRangeSync(start: number, end: number, hint?: ReadHint): Uint8Array | null {
        if (!this.syncAnswers) return null;
        if (hint) this.hints.push(hint);
        if (hint) this.syncSpans.push([start, end]);
        return this.data.slice(start, end);
    }
}

async function open(bytes: Uint8Array, blockCacheBytes?: number, source?: ZipSource): Promise<ZipArchive> {
    const a = new ZipArchive(source ?? new BufferSource(bytes), blockCacheBytes === undefined ? {} : { blockCacheBytes });
    await a.init();
    return a;
}

describe("wgb-compress output", () => {
    test("compressible members are block-indexed DEFLATE, the rest stays STORED", async () => {
        const a = await open(packed);
        expect(a.getEntry("manifest.json")!.compression).toBe(0);
        expect(a.getEntry("rom/noise.bin")!.compression).toBe(0);
        expect(a.getEntry("rom/empty.dat")!.compression).toBe(0);
        expect(a.getEntry("rom/theme.ogg")!.compression).toBe(0);
        expect(a.blockIndexState).toBe("loaded");
        for (const n of ["rom/game.exe", "rom/data.mix", "rom/exact.bin", "rom/one.txt"]) {
            const e = a.getEntry(n)!;
            expect(e.compression).toBe(8);
            expect(e.blocks!.shift).toBe(14);
            expect(e.blocks!.offsets.length - 1).toBe(Math.ceil(FILES[n].length / BLOCK));
            expect(a.isRangeReadable(e)).toBe(true);
        }
        expect(report.deflated).toBe(4);
        expect(packed.byteLength).toBeLessThan(readFileSync(storedPath).byteLength);
    });

    test("every member is still a standard ZIP member: one raw-DEFLATE pass returns the file", async () => {
        const a = await open(packed);
        for (const [name, want] of Object.entries(FILES)) {
            if (name === "manifest.json") continue;
            const e = a.getEntry(name)!;
            expect(Buffer.from(await a.readEntry(e)).equals(Buffer.from(want))).toBe(true);
            if (e.compression !== 8) continue;
            const v = new DataView(packed.buffer, packed.byteOffset);
            const lho = e.localHeaderOffset;
            const start = lho + 30 + v.getUint16(lho + 26, true) + v.getUint16(lho + 28, true);
            const whole = inflateRawSync(packed.subarray(start, start + e.compressedSize));
            expect(Buffer.from(whole).equals(Buffer.from(want))).toBe(true);
        }
    });

    test("packing is deterministic", async () => {
        const again = join(root, "packed-again.wgb");
        await compressWgb(storedPath, again, { blockKiB: BLOCK / 1024 });
        expect(Buffer.from(readFileSync(again)).equals(Buffer.from(packed))).toBe(true);
    });

    test("re-packing a packed bundle gives the same bytes", async () => {
        const twice = join(root, "packed-twice.wgb");
        await compressWgb(packedPath, twice, { blockKiB: BLOCK / 1024 });
        expect(Buffer.from(readFileSync(twice)).equals(Buffer.from(packed))).toBe(true);
    });

    test("the index round-trips", () => {
        const rows = [{ name: "a/b.bin", localHeaderOffset: 2 ** 34 + 1, uncompressedSize: 2 ** 33 + 5, compressedSize: 2 ** 32 + 9, crc32: 0xdeadbeef, shift: 16, blockLengths: [1, 65536, 70000] }];
        const back = decodeBlockIndex(encodeBlockIndex(rows));
        expect(back[0].name).toBe("a/b.bin");
        expect(back[0].uncompressedSize).toBe(2 ** 33 + 5);
        expect(back[0].compressedSize).toBe(2 ** 32 + 9);
        expect(back[0].crc32).toBe(0xdeadbeef);
        expect(back[0].localHeaderOffset).toBe(2 ** 34 + 1);
        expect(Array.from(back[0].blockLengths)).toEqual([1, 65536, 70000]);
        expect(() => decodeBlockIndex(encodeBlockIndex(rows).subarray(0, 30))).toThrow(/CRC|truncated/);
        const flipped = encodeBlockIndex(rows);
        flipped[flipped.length - 1] ^= 1;
        expect(() => decodeBlockIndex(flipped)).toThrow(/CRC mismatch/);
    });
});

describe("block range reads", () => {
    const name = "rom/data.mix";
    const want = FILES[name];

    function check(got: Uint8Array | null, off: number, len: number): void {
        const exp = want.subarray(Math.min(off, want.length), Math.min(want.length, off + len));
        expect(got).not.toBeNull();
        expect(got!.length).toBe(exp.length);
        expect(Buffer.from(got!).equals(Buffer.from(exp))).toBe(true);
    }

    for (const budget of [undefined, 0, BLOCK * 2]) {
        test(`random reads match the original, sync and async (cache ${budget ?? "default"})`, async () => {
            const a = await open(packed, budget);
            const e = a.getEntry(name)!;
            const r = rng(42);
            for (let i = 0; i < 400; i++) {
                const off = Math.floor(r() * (want.length + BLOCK));
                const len = Math.floor(r() * BLOCK * 3);
                check(a.readEntryRangeSync(e, off, len), off, len);
                check(await a.readEntryRange(e, off, len), off, len);
            }
        });
    }

    test("block boundaries, the short last block and the end of the entry", async () => {
        const a = await open(packed, BLOCK);
        const e = a.getEntry(name)!;
        const cases: Array<[number, number]> = [
            [0, BLOCK], [BLOCK - 1, 2], [BLOCK, BLOCK], [BLOCK * 2 - 1, 1], [BLOCK * 3, BLOCK * 4],
            [BLOCK * 9, 777], [BLOCK * 9 - 3, 1000], [want.length - 1, 50], [want.length, 10], [want.length + 5, 10],
            [123, 0], [0, want.length], [0, want.length * 2],
        ];
        for (const [off, len] of cases) {
            check(a.readEntryRangeSync(e, off, len), off, len);
            check(await a.readEntryRange(e, off, len), off, len);
        }
        const exact = a.getEntry("rom/exact.bin")!;
        const got = a.readEntryRangeSync(exact, BLOCK * 3, BLOCK * 2)!;
        expect(Buffer.from(got).equals(Buffer.from(FILES["rom/exact.bin"].subarray(BLOCK * 3)))).toBe(true);
    });

    test("concurrent async reads with a one-block cache stay correct", async () => {
        const a = await open(packed, BLOCK, new CountingSource(packed));
        const e = a.getEntry(name)!;
        const r = rng(7);
        const reads: Array<[number, number]> = [];
        for (let i = 0; i < 64; i++) reads.push([Math.floor(r() * want.length), Math.floor(r() * BLOCK * 4) + 1]);
        const got = await Promise.all(reads.map(([o, l]) => a.readEntryRange(e, o, l)));
        reads.forEach(([o, l], i) => check(got[i], o, l));
    });

    test("only the missing compressed blocks are requested, with entry-bounded hints", async () => {
        const src = new CountingSource(packed);
        const a = await open(packed, undefined, src);
        const e = a.getEntry(name)!;
        src.hints.length = 0;
        a.readEntryRangeSync(e, BLOCK + 10, BLOCK);
        expect(src.hints.length).toBe(1);
        const h = src.hints[0];
        const offs = e.blocks!.offsets;
        expect(h.entryEnd - h.entryStart).toBe(e.compressedSize);
        expect(h.cursor - h.entryStart).toBe(offs[1]);
        expect(h.entryName).toBe(name);
        src.hints.length = 0;
        check(a.readEntryRangeSync(e, BLOCK + 20, 100), BLOCK + 20, 100);
        expect(src.hints.length).toBe(0);
        a.readEntryRangeSync(e, BLOCK * 2 + 5, BLOCK);
        expect(src.hints.length).toBe(1);
        expect(src.hints[0].cursor - src.hints[0].entryStart).toBe(offs[3]);
    });

    test("a cold sync miss returns null so the caller takes the async path", async () => {
        const src = new CountingSource(packed);
        const a = await open(packed, undefined, src);
        const e = a.getEntry(name)!;
        src.syncAnswers = false;
        expect(a.readEntryRangeSync(e, 0, 100)).toBeNull();
        check(await a.readEntryRange(e, 0, 100), 0, 100);
        expect(a.readEntryRangeSync(e, 50, 100)).not.toBeNull();
    });

    test("a structurally corrupted block never returns bytes: sync answers null, async throws", async () => {
        const a0 = await open(packed);
        const e0 = a0.getEntry(name)!;
        const lho = e0.localHeaderOffset;
        const v = new DataView(packed.buffer, packed.byteOffset);
        const start = lho + 30 + v.getUint16(lho + 26, true) + v.getUint16(lho + 28, true);
        const bad = packed.slice();
        const at = start + e0.blocks!.offsets[2];
        for (let i = 0; i < 64; i++) bad[at + i] ^= 0x5a;
        const a = new ZipArchive(new BufferSource(bad));
        await a.init();
        const e = a.getEntry(name)!;
        check(a.readEntryRangeSync(e, 0, BLOCK * 2), 0, BLOCK * 2);
        expect(a.readEntryRangeSync(e, BLOCK * 2, 10)).toBeNull();
        await expect(a.readEntryRange(e, BLOCK * 2, 10)).rejects.toThrow(/block inflate/);
        installFakeOpfs();
        const vfs = new VirtualFileSystem();
        vfs.mountRom(a, "rom", buildRomIndex(a, "rom"));
        await vfs.initOverlay("test:wgb-block-corrupt");
        const h = vfs.openSync("C:\\data.mix", 0x80000000, 3)!;
        vfs.setPosition(h, BLOCK * 2, 0);
        expect(vfs.readSync(h, 10)).toBeNull();
        await expect(vfs.read(h, 10)).rejects.toThrow(/inflate/);
    });

    test("a short async read is reported as one", async () => {
        const src = new CountingSource(packed);
        const a = await open(packed, 0, src);
        const e = a.getEntry(name)!;
        check(a.readEntryRangeSync(e, 0, 1), 0, 1);
        src.shortBy = 7;
        await expect(a.readEntryRange(e, 0, BLOCK * 2)).rejects.toThrow(/short read/);
    });

    test("a whole-member read of a block member carries an entry-bounded sequential hint", async () => {
        const src = new CountingSource(packed);
        const a = await open(packed, undefined, src);
        const e = a.getEntry(name)!;
        src.hints.length = 0;
        check(await a.readEntry(e), 0, want.length);
        expect(src.hints.length).toBe(1);
        const h = src.hints[0];
        expect(h.entryName).toBe(name);
        expect(h.cursor).toBe(h.entryStart);
        expect(h.entryEnd - h.entryStart).toBe(e.compressedSize);
        expect(h.sequential).toBe(true);
    });

    test("a sync VFS read widens only to the end of the block it touches", async () => {
        installFakeOpfs();
        const src = new CountingSource(packed);
        const a = await open(packed, undefined, src);
        const e = a.getEntry(name)!;
        const vfs = new VirtualFileSystem();
        vfs.mountRom(a, "rom", buildRomIndex(a, "rom"));
        await vfs.initOverlay("test:wgb-block-widen");
        const h = vfs.openSync("C:\\data.mix", 0x80000000, 3)!;
        src.syncSpans.length = 0;
        check(vfs.readSync(h, 100), 0, 100);
        expect(src.syncSpans.length).toBe(1);
        const [s0, s1] = src.syncSpans[0];
        expect(s1 - s0).toBe(e.blocks!.offsets[1] - e.blocks!.offsets[0]);
        check(vfs.readSync(h, BLOCK - 100), 100, BLOCK - 100);
        expect(src.syncSpans.length).toBe(1);
    });
});

describe("index validation and the VFS", () => {
    async function withIndex(mutate: (rows: ReturnType<typeof decodeBlockIndex>) => void): Promise<ZipArchive> {
        const a = await open(packed);
        const rows = decodeBlockIndex(await a.readEntry(a.getEntry(WGB_BLOCK_INDEX_ENTRY)!));
        mutate(rows);
        const idx = encodeBlockIndex(rows);
        const old = a.getEntry(WGB_BLOCK_INDEX_ENTRY)!;
        const lho = old.localHeaderOffset;
        const v = new DataView(packed.buffer, packed.byteOffset);
        const start = lho + 30 + v.getUint16(lho + 26, true) + v.getUint16(lho + 28, true);
        expect(idx.length).toBe(old.uncompressedSize);
        const copy = packed.slice();
        copy.set(idx, start);
        const b = new ZipArchive(new BufferSource(copy));
        await b.init();
        return b;
    }

    test("a row that no longer matches its member is ignored", async () => {
        const b = await withIndex(rows => { rows.find(r => r.name === "rom/data.mix")!.crc32 ^= 1; });
        expect(b.getEntry("rom/data.mix")!.blocks).toBeUndefined();
        expect(b.isRangeReadable(b.getEntry("rom/data.mix")!)).toBe(false);
        expect(b.getEntry("rom/game.exe")!.blocks).toBeDefined();
    });

    test("a row whose local header offset points elsewhere is ignored", async () => {
        const b = await withIndex(rows => { rows.find(r => r.name === "rom/game.exe")!.localHeaderOffset += 1; });
        expect(b.getEntry("rom/game.exe")!.blocks).toBeUndefined();
        expect(b.getEntry("rom/data.mix")!.blocks).toBeDefined();
    });

    test("a row whose blocks do not end exactly before the end marker is ignored", async () => {
        const b = await withIndex(rows => {
            const r = rows.find(x => x.name === "rom/data.mix")!;
            (r.blockLengths as Uint32Array)[r.blockLengths.length - 1] -= 1;
        });
        expect(b.getEntry("rom/data.mix")!.blocks).toBeUndefined();
    });

    test("a row whose block count disagrees with the size is ignored", async () => {
        const b = await withIndex(rows => {
            const r = rows.find(x => x.name === "rom/exact.bin")!;
            r.shift = 15;
        });
        expect(b.getEntry("rom/exact.bin")!.blocks).toBeUndefined();
    });

    test("the VFS mounts a block-compressed bundle, hides the index and serves the files", async () => {
        installFakeOpfs();
        const a = await open(packed);
        const index = buildRomIndex(a, "rom");
        expect([...index.keys()].some(k => k.includes(WGB_BLOCK_INDEX_ENTRY))).toBe(false);
        const vfs = new VirtualFileSystem();
        vfs.mountRom(a, "rom", index);
        await vfs.initOverlay("test:wgb-block-compression");
        const h = vfs.openSync("C:\\data.mix", 0x80000000, 3)!;
        expect(h).toBeTruthy();
        const got = new Uint8Array(FILES["rom/data.mix"].length);
        let p = 0;
        while (p < got.length) {
            const d = vfs.readSync(h, 3000)!;
            expect(d).not.toBeNull();
            if (d.length === 0) break;
            got.set(d, p);
            p += d.length;
        }
        expect(p).toBe(got.length);
        expect(Buffer.from(got).equals(Buffer.from(FILES["rom/data.mix"]))).toBe(true);
    });

    test("seeks, async reads, size queries and pinning all see the original bytes", async () => {
        installFakeOpfs();
        const a = await open(packed, BLOCK * 2);
        const vfs = new VirtualFileSystem();
        vfs.mountRom(a, "rom", buildRomIndex(a, "rom"));
        await vfs.initOverlay("test:wgb-block-compression-paths");
        const want = FILES["rom/data.mix"];
        expect(vfs.getFileSize("C:\\data.mix")).toBe(want.length);
        const h = vfs.openSync("C:\\data.mix", 0x80000000, 3)!;
        const r = rng(9);
        for (let i = 0; i < 60; i++) {
            const off = Math.floor(r() * want.length);
            const len = 1 + Math.floor(r() * BLOCK * 2);
            vfs.setPosition(h, off, 0);
            const got = i % 2 ? await vfs.read(h, len) : vfs.readSync(h, len)!;
            expect(Buffer.from(got).equals(Buffer.from(want.subarray(off, Math.min(want.length, off + len))))).toBe(true);
        }
        expect(await vfs.pinRomFiles(["one.txt", "game.exe"])).toBeGreaterThanOrEqual(0);
        const one = vfs.openSync("C:\\one.txt", 0x80000000, 3)!;
        expect(Buffer.from(vfs.readSync(one, 1 << 20)!).equals(Buffer.from(FILES["rom/one.txt"]))).toBe(true);
    });

    test("the VFS still rejects DEFLATE members without a valid index", async () => {
        installFakeOpfs();
        const b = await withIndex(rows => { rows.find(r => r.name === "rom/data.mix")!.compressedSize += 1; });
        const vfs = new VirtualFileSystem();
        expect(() => vfs.mountRom(b, "rom", buildRomIndex(b, "rom"))).toThrow(/block index/);
    });
});


test("the manifest names the index, and the loader checks the version it needs", async () => {
    const bundle = await WgbLoader.fromSource(new BufferSource(packed));
    expect(bundle.manifest.blockIndex).toEqual({ member: WGB_BLOCK_INDEX_ENTRY, version: 1 });
    expect(Buffer.from(bundle.entrypointBytes).equals(Buffer.from(FILES["rom/game.exe"]))).toBe(true);
    expect(() => checkBlockIndex({ blockIndex: { member: WGB_BLOCK_INDEX_ENTRY, version: 2 } }, bundle.archive)).toThrow(/needs block-index v2; this engine reads v1/);
    const stored = new ZipArchive(new BufferSource(new Uint8Array(readFileSync(storedPath))));
    await stored.init();
    expect(() => checkBlockIndex({ blockIndex: { member: WGB_BLOCK_INDEX_ENTRY, version: 1 } }, stored)).toThrow(/is missing/);
    expect(() => checkBlockIndex({}, stored)).not.toThrow();
});

test("an unreadable index leaves the members unindexed instead of failing the archive", async () => {
    const a = await open(packed);
    const idx = a.getEntry(WGB_BLOCK_INDEX_ENTRY)!;
    const lho = idx.localHeaderOffset;
    const v = new DataView(packed.buffer, packed.byteOffset);
    const start = lho + 30 + v.getUint16(lho + 26, true) + v.getUint16(lho + 28, true);
    const copy = packed.slice();
    copy[start] ^= 0xff;
    const b = new ZipArchive(new BufferSource(copy));
    await b.init();
    expect(b.getEntry("rom/data.mix")!.blocks).toBeUndefined();
    expect(b.blockIndexState).toBe("rejected");
    expect(b.blockIndexError).toMatch(/magic/);
    expect(() => checkBlockIndex({ blockIndex: { member: WGB_BLOCK_INDEX_ENTRY, version: 1 } }, b)).toThrow(/needs block-index v1, but wgb-blocks.idx is damaged/);
    expect(Buffer.from(await b.readEntry(b.getEntry("rom/data.mix")!)).equals(Buffer.from(FILES["rom/data.mix"]))).toBe(true);
});
