import { describe, expect, test } from "bun:test";
import { MemoryChunkStore, MemoryPackDir, PackedChunkStore, sha256Hex } from "../../src/worker/savestate/chunk-store";
import { RAM_CHUNK_SIZE, STORE_LANES, inLanes, readChunk, restoreRam, snapshotRam, writeRamChunks } from "../../src/worker/savestate/ram";

const tick = () => new Promise<void>(r => setTimeout(r, 1));

class SlowStore extends MemoryChunkStore {
    active = 0;
    most = 0;
    puts = 0;
    failOn = "";
    override async put(hash: string, bytes: Uint8Array): Promise<void> {
        this.active++;
        this.most = Math.max(this.most, this.active);
        this.puts++;
        await tick();
        this.active--;
        if (hash === this.failOn) throw new Error(`disk full at ${hash.slice(0, 8)}`);
        await super.put(hash, bytes);
    }
}

async function chunks(count: number): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    for (let i = 0; i < count; i++) {
        const bytes = new Uint8Array(RAM_CHUNK_SIZE);
        for (let k = 0; k < bytes.length; k += 97) bytes[k] = (i * 31 + k) & 0xff;
        bytes[0] = i & 0xff; bytes[1] = i >> 8;
        out.set(await sha256Hex(bytes), bytes);
    }
    return out;
}

describe("savestate store lanes", () => {
    test("inLanes visits every item once, never runs more than its lanes, and does run them side by side", async () => {
        const seen: number[] = [];
        let active = 0, most = 0;
        await inLanes([...Array(50).keys()], 6, async (i) => {
            active++; most = Math.max(most, active);
            await tick();
            seen.push(i); active--;
        });
        expect(seen.slice().sort((a, b) => a - b)).toEqual([...Array(50).keys()]);
        expect(most).toBe(6);
        await inLanes([], 6, async () => { throw new Error("never"); });
        const one: number[] = [];
        await inLanes([1, 2, 3], 1, async (i) => { await tick(); one.push(i); });
        expect(one).toEqual([1, 2, 3]);
    });

    test("inLanes rethrows the first failure and starts nothing new after it", async () => {
        let started = 0;
        const err = await inLanes([...Array(40).keys()], 4, async (i) => {
            started++;
            await tick();
            if (i === 5) throw new Error("item 5");
        }).catch(e => e as Error);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe("item 5");
        expect(started).toBeLessThan(12);
    });

    test("pending chunks are written side by side; the files, the sizes and the emptied map are what one lane gives", async () => {
        const pending = await chunks(40);
        const hashes = [...pending.keys()];
        const originals = new Map([...pending].map(([h, b]) => [h, b.slice()]));
        const store = new SlowStore();
        const sizes = await writeRamChunks(pending, store);
        expect(store.most).toBe(STORE_LANES);
        expect(store.puts).toBe(40);
        expect(pending.size).toBe(0);
        expect([...sizes.keys()].sort()).toEqual(hashes.slice().sort());
        for (const hash of hashes) {
            expect(sizes.get(hash)).toBe(await store.size(hash));
            expect([...(await readChunk(store, hash, RAM_CHUNK_SIZE)).subarray(0, 8)]).toEqual([...originals.get(hash)!.subarray(0, 8)]);
        }
        const serial = new MemoryChunkStore();
        for (const [hash, bytes] of originals) await writeRamChunks(new Map([[hash, bytes]]), serial);
        for (const hash of hashes) expect(Buffer.from((await store.get(hash))!).equals(Buffer.from((await serial.get(hash))!))).toBe(true);
    });

    test("a failed write stops the run: the error comes out, written chunks left the map, the failed one stays for the next try", async () => {
        const pending = await chunks(40);
        const hashes = [...pending.keys()];
        const store = new SlowStore();
        store.failOn = hashes[20]!;
        const err = await writeRamChunks(pending, store).catch(e => e as Error);
        expect((err as Error).message).toContain("disk full");
        expect(pending.has(hashes[20]!)).toBe(true);
        expect(store.puts).toBeLessThan(40);
        for (const hash of hashes) expect(pending.has(hash)).toBe(!store.chunks.has(hash));
        store.failOn = "";
        await writeRamChunks(pending, store);
        expect(pending.size).toBe(0);
        expect(store.chunks.size).toBe(40);
    });

    test("fifty rounds leave nothing running and nothing held", async () => {
        const store = new SlowStore();
        for (let round = 0; round < 50; round++) {
            const pending = await chunks(3);
            await writeRamChunks(pending, store);
            expect(pending.size).toBe(0);
            expect(store.active).toBe(0);
        }
        expect(store.chunks.size).toBe(3);
    });

    test("a restore reads its chunks side by side and gives the same memory as the snapshot, gaps zeroed", async () => {
        class SlowReads extends MemoryChunkStore {
            active = 0; most = 0;
            override async get(hash: string): Promise<Uint8Array | null> {
                this.active++; this.most = Math.max(this.most, this.active);
                await tick();
                this.active--;
                return super.get(hash);
            }
        }
        const mem = new Uint8Array(48 * RAM_CHUNK_SIZE);
        for (let c = 0; c < 48; c++) if (c % 3 !== 1) for (let k = 0; k < RAM_CHUNK_SIZE; k += 61) mem[c * RAM_CHUNK_SIZE + k] = (c * 7 + k) & 0xff || 1;
        const snap = snapshotRam(mem, new Set());
        expect(snap.manifest.chunks.length).toBe(32);
        const store = new SlowReads();
        await writeRamChunks(snap.pending, store);
        const fresh = new Uint8Array(mem.length).fill(0xee);
        await restoreRam(fresh, snap.manifest, store);
        expect(store.most).toBe(STORE_LANES);
        expect(Buffer.from(fresh).equals(Buffer.from(mem))).toBe(true);

        await store.delete(snap.manifest.chunks[10]![1]);
        const err = await restoreRam(new Uint8Array(mem.length), snap.manifest, store).catch(e => e as Error);
        expect((err as Error).message).toContain("is missing");
    });
});

describe("packed chunk store", () => {
    const packsOf = (dir: MemoryPackDir) => [...dir.files.keys()].filter(n => n.endsWith(".pack"));

    test("one save is one pack and one index; has, size and list need no file access; a reopened store reads the same chunks", async () => {
        const dir = new MemoryPackDir();
        const store = await PackedChunkStore.open(dir);
        const pending = await chunks(40);
        const originals = new Map([...pending].map(([h, b]) => [h, b.slice()]));
        const sizes = await writeRamChunks(pending, store);
        expect(pending.size).toBe(0);
        expect(dir.writes).toBe(2);
        expect(packsOf(dir).length).toBe(1);
        dir.reads = 0;
        for (const [hash, size] of sizes) {
            expect(await store.has(hash)).toBe(true);
            expect(await store.size(hash)).toBe(size);
        }
        expect((await store.list()).sort()).toEqual([...originals.keys()].sort());
        expect(dir.reads).toBe(0);

        const again = await PackedChunkStore.open(dir);
        expect((await again.list()).sort()).toEqual([...originals.keys()].sort());
        for (const [hash, bytes] of originals) expect(Buffer.from(await readChunk(again, hash, RAM_CHUNK_SIZE)).equals(Buffer.from(bytes))).toBe(true);

        await writeRamChunks(new Map(originals), again);
        expect(packsOf(dir).length).toBe(1);
        const more = await chunks(45);
        for (const hash of originals.keys()) more.delete(hash);
        expect(more.size).toBe(5);
        await writeRamChunks(more, again);
        expect(packsOf(dir).length).toBe(2);
    });

    test("a snapshot written to a packed store restores to the same memory", async () => {
        const mem = new Uint8Array(24 * RAM_CHUNK_SIZE);
        for (let c = 0; c < 24; c++) if (c % 4) for (let k = 0; k < RAM_CHUNK_SIZE; k += 53) mem[c * RAM_CHUNK_SIZE + k] = (c * 11 + k) & 0xff || 1;
        const store = await PackedChunkStore.open(new MemoryPackDir());
        const snap = snapshotRam(mem, new Set(await store.list()));
        await writeRamChunks(snap.pending, store);
        const fresh = new Uint8Array(mem.length).fill(0x77);
        await restoreRam(fresh, snap.manifest, store);
        expect(Buffer.from(fresh).equals(Buffer.from(mem))).toBe(true);
        const second = snapshotRam(mem, new Set(await store.list()));
        expect(second.pending.size).toBe(0);
    });

    test("deleting: a pack that keeps most of its chunks only gets a new index, one that keeps few is rewritten, an empty one goes away", async () => {
        const dir = new MemoryPackDir();
        const store = await PackedChunkStore.open(dir);
        const pending = await chunks(20);
        const hashes = [...pending.keys()];
        const originals = new Map([...pending].map(([h, b]) => [h, b.slice()]));
        await writeRamChunks(pending, store);
        const first = packsOf(dir)[0]!;
        await store.deleteMany!(hashes.slice(0, 4));
        expect(packsOf(dir)).toEqual([first]);
        expect((await store.list()).length).toBe(16);
        expect(await store.get(hashes[0]!)).toBeNull();
        expect((await (await PackedChunkStore.open(dir)).list()).length).toBe(16);

        await store.deleteMany!(hashes.slice(4, 17));
        expect(packsOf(dir).length).toBe(1);
        expect(packsOf(dir)[0]).not.toBe(first);
        const kept = hashes.slice(17);
        for (const reopened of [store, await PackedChunkStore.open(dir)]) {
            expect((await reopened.list()).sort()).toEqual(kept.slice().sort());
            for (const hash of kept) expect(Buffer.from(await readChunk(reopened, hash, RAM_CHUNK_SIZE)).equals(Buffer.from(originals.get(hash)!))).toBe(true);
        }
        await store.deleteMany!(kept);
        expect(dir.files.size).toBe(0);
    });

    test("opening removes nothing; leftovers go in sweep: a pack without an index, an index without its pack, a broken index", async () => {
        const dir = new MemoryPackDir();
        const store = await PackedChunkStore.open(dir);
        const pending = await chunks(3);
        const hashes = [...pending.keys()];
        await writeRamChunks(pending, store);
        const pack = packsOf(dir)[0]!;
        dir.files.set("pabc-1.pack", new Uint8Array(10));
        dir.files.set("pabc-2.pack.idx", new TextEncoder().encode(JSON.stringify({ v: 1, pack: "pabc-2.pack", bytes: 0, chunks: [] })));
        dir.files.set("pabc-3.pack", new Uint8Array(4));
        dir.files.set("pabc-3.pack.idx", new TextEncoder().encode("{not json"));
        dir.files.set("notes.txt", new Uint8Array(1));
        const before = [...dir.files.keys()].sort();
        const reopened = await PackedChunkStore.open(dir);
        expect([...dir.files.keys()].sort()).toEqual(before);
        expect((await reopened.list()).sort()).toEqual(hashes.slice().sort());
        expect(await reopened.sweep()).toEqual({ removed: 4, migrated: 0 });
        expect([...dir.files.keys()].sort()).toEqual(["notes.txt", pack, pack + ".idx"].sort());
        expect(await reopened.sweep()).toEqual({ removed: 0, migrated: 0 });
    });

    test("a pack whose index is not written yet survives another open, and the save that owns it completes", async () => {
        const dir = new MemoryPackDir();
        const saving = await PackedChunkStore.open(dir);
        const pending = await chunks(4);
        const hashes = [...pending.keys()];
        const write = dir.write.bind(dir);
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        let listed: string[] | null = null;
        dir.write = async (name, bytes) => {
            if (name.endsWith(".idx")) {
                listed = await (await PackedChunkStore.open(dir)).list();
                await gate;
            }
            await write(name, bytes);
        };
        const done = writeRamChunks(pending, saving);
        await new Promise(r => setTimeout(r, 5));
        expect(packsOf(dir).length).toBe(1);
        release();
        await done;
        expect(listed).toEqual([]);
        const after = await PackedChunkStore.open(dir);
        expect((await after.list()).sort()).toEqual(hashes.slice().sort());
        for (const hash of hashes) expect((await readChunk(after, hash, RAM_CHUNK_SIZE)).byteLength).toBe(RAM_CHUNK_SIZE);
    });

    test("a save whose index cannot be written adopts nothing and leaves one orphan pack that the next sweep removes", async () => {
        const dir = new MemoryPackDir();
        const store = await PackedChunkStore.open(dir);
        const pending = await chunks(3);
        const hashes = [...pending.keys()];
        const write = dir.write.bind(dir);
        dir.write = async (name, bytes) => { if (name.endsWith(".idx")) throw new Error("quota"); await write(name, bytes); };
        expect(await writeRamChunks(pending, store).catch(e => (e as Error).message)).toBe("quota");
        expect(pending.size).toBe(3);
        expect(await store.has(hashes[0]!)).toBe(false);
        expect(await store.list()).toEqual([]);
        dir.write = write;
        const next = await PackedChunkStore.open(dir);
        expect(await next.list()).toEqual([]);
        expect(await next.sweep()).toEqual({ removed: 1, migrated: 0 });
        expect(dir.files.size).toBe(0);
        await writeRamChunks(pending, next);
        expect((await next.list()).sort()).toEqual(hashes.slice().sort());
    });

    test("loose chunk files of the layout before packs stay readable and are moved into a pack by sweep; a failed move keeps them", async () => {
        const dir = new MemoryPackDir();
        const body = new Map<string, Uint8Array>();
        for (let i = 0; i < 40; i++) {
            const file = new Uint8Array([0, 1, 2, i]);
            const hash = await sha256Hex(new Uint8Array([9, i]));
            body.set(hash, file);
            dir.files.set(hash, file);
        }
        const hashes = [...body.keys()];
        const store = await PackedChunkStore.open(dir);
        expect((await store.list()).sort()).toEqual(hashes.slice().sort());
        expect(await store.has(hashes[3]!)).toBe(true);
        expect(await store.size(hashes[3]!)).toBe(4);
        expect([...(await store.get(hashes[3]!))!]).toEqual([...body.get(hashes[3]!)!]);
        expect(dir.files.size).toBe(40);

        const write = dir.write.bind(dir);
        dir.write = async () => { throw new Error("quota"); };
        expect(await store.sweep().catch(e => (e as Error).message)).toBe("quota");
        dir.write = write;
        expect([...(await store.get(hashes[3]!))!]).toEqual([...body.get(hashes[3]!)!]);
        for (const hash of hashes) expect(dir.files.has(hash)).toBe(true);

        const again = await PackedChunkStore.open(dir);
        expect((await again.sweep()).migrated).toBe(40);
        expect(packsOf(dir).length).toBe(1);
        expect([...dir.files.keys()].filter(n => /^[0-9a-f]{64}$/.test(n))).toEqual([]);
        const reopened = await PackedChunkStore.open(dir);
        for (const hash of hashes) expect([...(await reopened.get(hash))!]).toEqual([...body.get(hash)!]);
        await reopened.delete(hashes[0]!);
        expect(await reopened.has(hashes[0]!)).toBe(false);
    });

    test("a reopened store still knows a pack's real size, so a pack that is mostly dead is compacted", async () => {
        const dir = new MemoryPackDir();
        const store = await PackedChunkStore.open(dir);
        const items: Array<[string, Uint8Array]> = [];
        for (let i = 0; i < 10; i++) items.push([await sha256Hex(new Uint8Array([7, i])), new Uint8Array(1000).fill(i + 1)]);
        await store.putMany(items);
        const pack = packsOf(dir)[0]!;
        expect(dir.files.get(pack)!.byteLength).toBe(10000);
        await store.deleteMany(items.slice(6).map(([hash]) => hash));
        expect(packsOf(dir)).toEqual([pack]);
        const reopened = await PackedChunkStore.open(dir);
        await reopened.deleteMany(items.slice(3, 6).map(([hash]) => hash));
        expect(packsOf(dir).length).toBe(1);
        expect(packsOf(dir)[0]).not.toBe(pack);
        expect(dir.files.get(packsOf(dir)[0]!)!.byteLength).toBe(3000);
        const last = await PackedChunkStore.open(dir);
        for (const [hash, bytes] of items.slice(0, 3)) expect([...(await last.get(hash))!]).toEqual([...bytes]);
    });

    test("a compaction that cannot write keeps the old pack readable for the next open", async () => {
        const dir = new MemoryPackDir();
        const store = await PackedChunkStore.open(dir);
        const items: Array<[string, Uint8Array]> = [];
        for (let i = 0; i < 4; i++) items.push([await sha256Hex(new Uint8Array([5, i])), new Uint8Array(100).fill(i + 1)]);
        await store.putMany(items);
        const write = dir.write.bind(dir);
        dir.write = async () => { throw new Error("quota"); };
        expect(await store.deleteMany(items.slice(1).map(([hash]) => hash)).catch(e => (e as Error).message)).toBe("quota");
        dir.write = write;
        const reopened = await PackedChunkStore.open(dir);
        expect([...(await reopened.get(items[0]![0]))!]).toEqual([...items[0]![1]]);
    });

    test("a save larger than the pack limit is split into several packs", async () => {
        const dir = new MemoryPackDir();
        const store = await PackedChunkStore.open(dir, 2500);
        const items: Array<[string, Uint8Array]> = [];
        for (let i = 0; i < 7; i++) items.push([await sha256Hex(new Uint8Array([3, i])), new Uint8Array(1000).fill(i + 1)]);
        await store.putMany(items);
        expect(packsOf(dir).map(n => dir.files.get(n)!.byteLength).sort()).toEqual([1000, 2000, 2000, 2000]);
        const reopened = await PackedChunkStore.open(dir, 2500);
        for (const [hash, bytes] of items) expect([...(await reopened.get(hash))!]).toEqual([...bytes]);
    });

    test("fifty saves and collections leave only what the last manifest names", async () => {
        const dir = new MemoryPackDir();
        const mem = new Uint8Array(8 * RAM_CHUNK_SIZE);
        let last: ReturnType<typeof snapshotRam> | null = null;
        for (let round = 0; round < 50; round++) {
            for (let c = 0; c < 8; c++) mem[c * RAM_CHUNK_SIZE + 5] = (round % 3 === 0 || c < 2) ? round + 1 : mem[c * RAM_CHUNK_SIZE + 5]! || 1;
            const store = await PackedChunkStore.open(dir);
            last = snapshotRam(mem, new Set(await store.list()));
            await writeRamChunks(last.pending, store);
            const dead = (await store.list()).filter(h => !last!.manifest.chunks.some(([, x]) => x === h));
            await store.deleteMany!(dead);
        }
        const store = await PackedChunkStore.open(dir);
        expect((await store.list()).sort()).toEqual([...new Set(last!.manifest.chunks.map(([, h]) => h))].sort());
        const fresh = new Uint8Array(mem.length);
        await restoreRam(fresh, last!.manifest, store);
        expect(Buffer.from(fresh).equals(Buffer.from(mem))).toBe(true);
        expect(packsOf(dir).length).toBeLessThan(12);
    });
});
