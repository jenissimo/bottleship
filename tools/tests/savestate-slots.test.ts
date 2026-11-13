import { describe, expect, test } from "bun:test";
import { MemoryChunkStore } from "../../src/worker/savestate/chunk-store";
import { captureRam, RAM_CHUNK_SIZE } from "../../src/worker/savestate/ram";
import { decodeSavestate, encodeSavestate, incompatibilities, type CompatibilityKey } from "../../src/worker/savestate/container";
import { MemoryDir, OpfsDir, SlotStore } from "../../src/worker/savestate/slots";
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

    test("a state that cannot be read once during a collection costs no chunk; the next collection removes only what is unreferenced", async () => {
        const chunks = new MemoryChunkStore();
        const dir = new FlakyDir();
        const slots = new SlotStore(dir, chunks);
        await slots.save("slot1", await state(chunks, [1, 2, 3]), 0);
        await slots.save("slot2", await state(chunks, [1, 2, 4]), 0);
        const before = [...chunks.chunks.keys()].sort();
        expect(before.length).toBe(4);
        dir.failReads.set("slot2.bss", 1);
        expect(await slots.remove("slot1")).toBe(0);
        expect(dir.failReads.get("slot2.bss")).toBe(0);
        expect([...chunks.chunks.keys()].sort()).toEqual(before);
        expect(await slots.read("slot1")).toBeNull();
        expect(await slots.collectGarbage()).toBe(1);
        expect(chunks.chunks.size).toBe(3);
        const slot2 = decodeSavestate((await slots.read("slot2"))!);
        for (const [, hash] of slot2.header.ram.chunks) expect(chunks.chunks.has(hash)).toBe(true);
    });

    test("on OPFS, a state that cannot be read during a collection costs no chunk", async () => {
        const chunks = new MemoryChunkStore();
        const files = new Map<string, Uint8Array>();
        const reads = new Map<string, string[]>();
        const slots = new SlotStore(new OpfsDir(fakeHandle(files, { read: reads })), chunks);
        await slots.save("slot1", await state(chunks, [1, 2, 3]), 0);
        await slots.save("slot2", await state(chunks, [1, 2, 4]), 0);
        expect([...files.keys()].sort()).toEqual(["slot1.bss", "slot1.json", "slot2.bss", "slot2.json"]);
        reads.set("slot2.bss", ["NotReadableError", "NotReadableError"]);
        expect(await slots.remove("slot1")).toBe(0);
        expect(reads.get("slot2.bss")).toEqual([]);
        expect(chunks.chunks.size).toBe(4);
        reads.set("slot2.bss", ["NotReadableError"]);
        expect(await slots.collectGarbage()).toBe(1);
        const slot2 = decodeSavestate((await slots.read("slot2"))!);
        expect([...chunks.chunks.keys()].sort()).toEqual([...new Set(slot2.header.ram.chunks.map(([, h]) => h))].sort());
    });

    test("a collection that meets an unreadable or unparsable state throws a named error and removes nothing", async () => {
        const chunks = new MemoryChunkStore();
        const dir = new FlakyDir();
        const slots = new SlotStore(dir, chunks);
        await slots.save("slot1", await state(chunks, [1, 2]), 0);
        await slots.save("slot2", await state(chunks, [3]), 0);
        await dir.remove("slot1.bss");
        await dir.remove("slot1.json");
        dir.failReads.set("slot2.bss", 1);
        await expect(slots.collectGarbage()).rejects.toThrow("slot2.bss is busy");
        expect(chunks.chunks.size).toBe(3);
        await dir.write("slot2.bss", new Uint8Array([1, 2, 3]));
        await expect(slots.collectGarbage()).rejects.toThrow(/slot2\.bss cannot be parsed, so no chunk is collected/);
        expect(chunks.chunks.size).toBe(3);
    });

    test("a save whose collection cannot run is still a save", async () => {
        const chunks = new MemoryChunkStore();
        const dir = new FlakyDir();
        const slots = new SlotStore(dir, chunks);
        await slots.save("slot1", await state(chunks, [1]), 0);
        dir.failReads.set("slot1.bss", 1);
        const info = await slots.save("slot2", await state(chunks, [2]), 0);
        expect(info.slot).toBe("slot2");
        expect(await slots.read("slot2")).not.toBeNull();
        expect(chunks.chunks.size).toBe(2);
    });

    test("a slot whose state cannot be read is listed with the reason, a slot that disappeared is not listed", async () => {
        const chunks = new MemoryChunkStore();
        const dir = new FlakyDir();
        const slots = new SlotStore(dir, chunks);
        await slots.save("slot1", await state(chunks, [1]), 0);
        await slots.save("slot2", await state(chunks, [2]), 0);
        dir.failReads.set("slot1.bss", 1);
        dir.vanish.add("slot2.bss");
        const list = await slots.list(() => []);
        expect(list.map(s => s.slot)).toEqual(["slot1"]);
        expect(list[0]!.compatible).toBe(false);
        expect(list[0]!.reasons[0]).toMatch(/NotReadableError/);
    });
});

class FlakyDir extends MemoryDir {
    readonly failReads = new Map<string, number>();
    readonly vanish = new Set<string>();
    override async read(name: string): Promise<Uint8Array | null> {
        const left = this.failReads.get(name) ?? 0;
        if (left > 0) {
            this.failReads.set(name, left - 1);
            throw Object.assign(new Error(`${name} is busy`), { name: "NotReadableError" });
        }
        if (this.vanish.has(name)) return null;
        return super.read(name);
    }
}

const domError = (name: string) => Object.assign(new Error(name), { name });

type Faults = { open?: string; read?: Map<string, string[]> | string[]; remove?: string; dir?: string };

function fakeHandle(files: Map<string, Uint8Array>, faults: Faults = {}): FileSystemDirectoryHandle {
    const readFaults = (name: string): string[] => {
        const r = faults.read;
        if (!r) return [];
        if (Array.isArray(r)) return r;
        if (!r.has(name)) r.set(name, []);
        return r.get(name)!;
    };
    return {
        keys: async function* () { yield* [...files.keys()]; },
        getFileHandle: async (name: string, opts?: { create?: boolean }) => {
            if (faults.open) throw domError(faults.open);
            if (!files.has(name)) {
                if (!opts?.create) throw domError("NotFoundError");
                files.set(name, new Uint8Array());
            }
            return {
                getFile: async () => {
                    const fault = readFaults(name).shift();
                    const bytes = files.get(name)!;
                    return { arrayBuffer: async () => { if (fault) throw domError(fault); return bytes.slice().buffer; } };
                },
                createWritable: async () => {
                    let body = new Uint8Array();
                    return {
                        write: async (b: Uint8Array) => { body = b.slice(); },
                        close: async () => { files.set(name, body); },
                    };
                },
            };
        },
        removeEntry: async (name: string) => {
            if (faults.remove) throw domError(faults.remove);
            if (!files.delete(name)) throw domError("NotFoundError");
        },
        getDirectoryHandle: async (_name: string, opts: { create: boolean }) => {
            if (faults.dir) throw domError(faults.dir);
            if (!opts.create) throw domError("NotFoundError");
            return fakeHandle(new Map());
        },
    } as unknown as FileSystemDirectoryHandle;
}

describe("OpfsDir tells a missing file from one that cannot be read", () => {
    const files = () => new Map([["a.bss", new Uint8Array([7, 8])]]);

    test("null only for a file that does not exist", async () => {
        expect(await new OpfsDir(fakeHandle(files())).read("b.bss")).toBeNull();
        expect(await new OpfsDir(fakeHandle(files())).read("a.bss")).toEqual(new Uint8Array([7, 8]));
    });

    test("a stale file is read again once, a second failure throws", async () => {
        expect(await new OpfsDir(fakeHandle(files(), { read: ["NotReadableError"] })).read("a.bss")).toEqual(new Uint8Array([7, 8]));
        await expect(new OpfsDir(fakeHandle(files(), { read: ["NotReadableError", "NotReadableError"] })).read("a.bss"))
            .rejects.toThrow("savestate: a.bss cannot be read (NotReadableError: NotReadableError)");
    });

    test("a file that cannot be opened throws", async () => {
        await expect(new OpfsDir(fakeHandle(files(), { open: "TypeMismatchError" })).read("a.bss"))
            .rejects.toThrow("savestate: a.bss cannot be opened (TypeMismatchError: TypeMismatchError)");
        await expect(new OpfsDir(fakeHandle(files(), { open: "SecurityError" })).read("a.bss")).rejects.toThrow(/SecurityError/);
    });

    test("removing a missing file is fine, a failed removal throws", async () => {
        await new OpfsDir(fakeHandle(files())).remove("b.bss");
        const f = files();
        await new OpfsDir(fakeHandle(f)).remove("a.bss");
        expect(f.size).toBe(0);
        await expect(new OpfsDir(fakeHandle(files(), { remove: "NoModificationAllowedError" })).remove("a.bss"))
            .rejects.toThrow("savestate: a.bss cannot be removed (NoModificationAllowedError: NoModificationAllowedError)");
    });

    test("a directory is null only when it does not exist and is not to be created", async () => {
        expect(await new OpfsDir(fakeHandle(files())).dir("slots", false)).toBeNull();
        expect(await new OpfsDir(fakeHandle(files())).dir("slots", true)).not.toBeNull();
        await expect(new OpfsDir(fakeHandle(files(), { dir: "InvalidStateError" })).dir("slots", true)).rejects.toThrow(/directory slots cannot be opened/);
        await expect(new OpfsDir(fakeHandle(files(), { dir: "InvalidStateError" })).dir("slots", false)).rejects.toThrow(/InvalidStateError/);
    });
});
