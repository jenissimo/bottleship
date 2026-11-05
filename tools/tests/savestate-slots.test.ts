import { describe, expect, test } from "bun:test";
import { MemoryChunkStore } from "../../src/worker/savestate/chunk-store";
import { captureRam, RAM_CHUNK_SIZE } from "../../src/worker/savestate/ram";
import { encodeSavestate, incompatibilities, type CompatibilityKey } from "../../src/worker/savestate/container";
import { MemoryDir, SlotStore } from "../../src/worker/savestate/slots";
import { withGameLock } from "../../src/worker/savestate/host";

const key = (buildSha = "a"): CompatibilityKey => ({ buildSha, contentHash: "b", configHash: "c", bootLayout: "d", participants: { cpu: { version: 1, schemaHash: "s" } } });

async function state(store: MemoryChunkStore, fill: number[], buildSha = "a"): Promise<Uint8Array> {
    const mem = new Uint8Array(4 * RAM_CHUNK_SIZE);
    fill.forEach((v, i) => { mem[i * RAM_CHUNK_SIZE] = v; });
    const { manifest } = await captureRam(mem, store);
    return encodeSavestate({
        header: { key: key(buildSha), overlay: "", createdAt: 1, gameId: "g", ram: manifest },
        sections: new Map([["cpu", { v: 1 }]]),
    });
}

describe("savestate slots", () => {
    test("slots share chunks; deleting one keeps the chunks the other still needs", async () => {
        const chunks = new MemoryChunkStore();
        const slots = new SlotStore(new MemoryDir(), chunks);
        await slots.save("slot1", await state(chunks, [1, 2, 3]), 0);
        await slots.save("slot2", await state(chunks, [1, 2, 4]), 0);
        expect(chunks.chunks.size).toBe(4);
        expect(await slots.remove("slot1")).toBe(1);
        expect(chunks.chunks.size).toBe(3);
        expect(await slots.remove("slot2")).toBe(3);
        expect(chunks.chunks.size).toBe(0);
    });

    test("an overwritten slot releases the chunks only it used", async () => {
        const chunks = new MemoryChunkStore();
        const slots = new SlotStore(new MemoryDir(), chunks);
        await slots.save("slot1", await state(chunks, [5, 6]), 0);
        await slots.save("slot1", await state(chunks, [5, 7]), 0);
        expect(chunks.chunks.size).toBe(2);
    });

    test("each game has its own chunk store, so one game's collection cannot drop another's chunks", async () => {
        const a = new SlotStore(new MemoryDir(), new MemoryChunkStore());
        const b = new SlotStore(new MemoryDir(), new MemoryChunkStore());
        await a.save("slot1", await state(a.chunkStore as MemoryChunkStore, [8]), 0);
        await b.save("slot1", await state(b.chunkStore as MemoryChunkStore, [8]), 0);
        await a.remove("slot1");
        expect((b.chunkStore as MemoryChunkStore).chunks.size).toBe(1);
    });

    test("a slot from another build is listed as incompatible, not as an error", async () => {
        const chunks = new MemoryChunkStore();
        const slots = new SlotStore(new MemoryDir(), chunks);
        await slots.save("slot1", await state(chunks, [1]), 123);
        await slots.save("slot2", await state(chunks, [1], "old"), 0);
        const list = await slots.list((s) => incompatibilities(s.header.key, key()));
        expect(list.map(s => [s.slot, s.compatible])).toEqual([["slot1", true], ["slot2", false]]);
        expect(list[0]!.chunkBytes).toBe(123);
        expect(list[1]!.reasons).toEqual(["buildSha differs"]);
        expect(await slots.read("slot3")).toBeNull();
    });

    test("a collection never runs inside a save of the same game", async () => {
        const order: string[] = [];
        let releaseSave!: () => void;
        const save = withGameLock("g", async () => {
            order.push("save:start");
            await new Promise<void>(r => { releaseSave = r; });
            order.push("save:end");
        });
        const collect = withGameLock("g", async () => { order.push("collect"); });
        const other = withGameLock("h", async () => { order.push("other game"); });
        await other;
        releaseSave();
        await Promise.all([save, collect]);
        expect(order).toEqual(["save:start", "other game", "save:end", "collect"]);
    });
});
