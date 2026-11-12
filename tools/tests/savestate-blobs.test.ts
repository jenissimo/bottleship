import { describe, expect, test } from "bun:test";
import { MemoryChunkStore } from "../../src/worker/savestate/chunk-store";
import { RAM_CHUNK_SIZE, writeRamChunks } from "../../src/worker/savestate/ram";
import { MemoryDir, SlotStore } from "../../src/worker/savestate/slots";
import { ParticipantRegistry, type RestoreContext } from "../../src/worker/savestate/participant";
import { captureSession, restoreSession, RestoreFailed, type SavestateTarget } from "../../src/worker/savestate/session";
import { decodeSavestate, encodeSavestate, type CompatibilityKey } from "../../src/worker/savestate/container";
import { BLOBS, blobHash, savedBlobs } from "../../src/worker/savestate/blobs";
import { newObjectGraph, objectCodecs, restoreObjectGraph } from "../../src/worker/savestate/object-codecs";
import { sha256HexSync } from "../../src/worker/savestate/sha256";

const KEY: CompatibilityKey = { buildSha: "a", contentHash: "b", configHash: "c", bootLayout: "d", participants: {} };

function target(mem: Uint8Array): SavestateTarget {
    return { guestMemory: () => mem, compatibilityKey: () => ({ ...KEY }), overlayState: () => "", gameId: () => "g", touchedModules: () => [] };
}

const guest = (): Uint8Array => {
    const mem = new Uint8Array(2 * RAM_CHUNK_SIZE);
    mem[10] = 7;
    return mem;
};

function registry(held: Uint8Array[], back: Uint8Array[] = []): ParticipantRegistry {
    const reg = new ParticipantRegistry();
    reg.add({
        id: "time", version: 1,
        capture: (ctx) => held.map(b => ctx.blob(b)),
        restore: (s, ctx) => { for (const hash of s as string[]) back.push(ctx.blob(hash)); },
    });
    return reg;
}

async function save(store: MemoryChunkStore, reg: ParticipantRegistry, mem = guest()) {
    const result = await captureSession(target(mem), new Set(await store.list()), () => undefined, reg);
    const written = result.pending.size;
    await writeRamChunks(result.pending, store);
    return { ...result, written };
}

describe("savestate blobs", () => {
    const a = Uint8Array.from({ length: 5000 }, (_, i) => i * 7), b = Uint8Array.from([1, 2, 3]);

    test("a blob is named by the SHA-256 of its bytes and comes back verified", async () => {
        const store = new MemoryChunkStore(), back: Uint8Array[] = [];
        const result = await save(store, registry([a, b, a.slice()], back));
        expect(result.blobs).toEqual([[sha256HexSync(a), a.length], [sha256HexSync(b), b.length]].sort() as never);
        expect(savedBlobs(decodeSavestate(result.bytes))).toEqual(result.blobs);
        await restoreSession(target(new Uint8Array(2 * RAM_CHUNK_SIZE)), decodeSavestate(result.bytes), store, registry([], back));
        expect(back).toEqual([a, b, a]);
        expect(back[0]).toBe(back[2]!);
    });

    test("identical blobs are stored once and a second save writes nothing", async () => {
        const store = new MemoryChunkStore();
        const first = await save(store, registry([a, a.slice(), b]));
        expect(first.written).toBe(3);
        const second = await save(store, registry([a, b]));
        expect(second.written).toBe(0);
        expect(store.chunks.size).toBe(3);
    });

    test("a state without blobs has no blob section", async () => {
        const result = await save(new MemoryChunkStore(), registry([]));
        expect(decodeSavestate(result.bytes).sections.has(BLOBS)).toBe(false);
        expect(result.blobs).toEqual([]);
    });

    test("a missing or corrupt blob is named before anything is written", async () => {
        const store = new MemoryChunkStore();
        const result = await save(store, registry([a]));
        const hash = sha256HexSync(a), file = store.chunks.get(hash)!;
        const fresh = new Uint8Array(2 * RAM_CHUNK_SIZE);
        store.chunks.delete(hash);
        const missing = await restoreSession(target(fresh), decodeSavestate(result.bytes), store, registry([])).catch(e => e);
        expect(missing).not.toBeInstanceOf(RestoreFailed);
        expect((missing as Error).message).toBe(`savestate: 1 blob(s) are missing, e.g. ${hash}`);
        store.chunks.set(hash, Uint8Array.from([0, ...a.subarray(1), 9]));
        const corrupt = await restoreSession(target(fresh), decodeSavestate(result.bytes), store, registry([])).catch(e => e);
        expect(corrupt).not.toBeInstanceOf(RestoreFailed);
        expect((corrupt as Error).message).toBe(`savestate: blob ${hash} is corrupt`);
        expect(fresh.every(v => v === 0)).toBe(true);
        store.chunks.set(hash, file);
        await restoreSession(target(fresh), decodeSavestate(result.bytes), store, registry([]));
        expect(fresh[10]).toBe(7);
    });

    test("a blob no saved state lists is refused by name, and a malformed list is a format error", async () => {
        const ctx: RestoreContext = restoreObjectGraph([]);
        expect(() => ctx.blob("f".repeat(64))).toThrow(`savestate: blob ${"f".repeat(64)} is missing`);
        const state = decodeSavestate((await save(new MemoryChunkStore(), registry([a]))).bytes);
        for (const bad of [{}, [["x", 1]], [[sha256HexSync(a), -1]], [[sha256HexSync(a)]]]) {
            state.sections.set(BLOBS, bad as never);
            expect(() => savedBlobs(decodeSavestate(encodeSavestate(state)))).toThrow("blob");
        }
    });

    test("a slot keeps its blobs through collection; they go with the last slot naming them", async () => {
        const chunks = new MemoryChunkStore();
        const slots = new SlotStore(new MemoryDir(), chunks);
        const one = await save(chunks, registry([a, b]));
        await slots.save("slot1", one.bytes, 0);
        const two = await save(chunks, registry([a]));
        await slots.save("slot2", two.bytes, 0);
        expect(chunks.chunks.has(sha256HexSync(a)) && chunks.chunks.has(sha256HexSync(b))).toBe(true);
        expect(await slots.remove("slot1")).toBe(1);
        expect(chunks.chunks.has(sha256HexSync(b))).toBe(false);
        expect(chunks.chunks.has(sha256HexSync(a))).toBe(true);
        await slots.remove("slot2");
        expect(chunks.chunks.size).toBe(0);
    });

    test("an object codec reaches the blobs of its graph, and a hash is computed once per array", () => {
        class Holder { constructor(public bytes: Uint8Array) {} }
        objectCodecs.add<Holder>({
            tag: "test-blob-holder",
            matches: (o): o is Holder => o instanceof Holder,
            capture: (o, _ref, blob) => blob(o.bytes),
            restore: (hash: string, ctx) => new Holder(ctx.blob(hash)),
        });
        const graph = newObjectGraph();
        const refs = [new Holder(a), new Holder(a), new Holder(b)].map((h, i) => graph.ref(h, `h${i}`));
        expect([...graph.blobs.keys()]).toEqual([sha256HexSync(a), sha256HexSync(b)]);
        const ctx = restoreObjectGraph(structuredClone(graph.objects), graph.blobs);
        expect(refs.map(r => (ctx.object(r) as Holder).bytes)).toEqual([a, a, b]);
        const edited = a.slice();
        const before = blobHash(edited);
        edited[0] ^= 1;
        expect(blobHash(edited)).toBe(before);
    });
});
