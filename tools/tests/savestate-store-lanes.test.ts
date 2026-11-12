import { describe, expect, test } from "bun:test";
import { MemoryChunkStore, sha256Hex } from "../../src/worker/savestate/chunk-store";
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
