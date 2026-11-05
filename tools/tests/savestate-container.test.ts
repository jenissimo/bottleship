import { afterEach, describe, expect, test } from "bun:test";
import { decodeValue, encodeValue, SaveValueError } from "../../src/worker/savestate/value-codec";
import { deflate, MemoryChunkStore, sha256Hex } from "../../src/worker/savestate/chunk-store";
import { captureRam, collectGarbage, restoreRam, snapshotRam, RAM_CHUNK_SIZE, type RamManifest } from "../../src/worker/savestate/ram";
import {
    decodeSavestate, encodeSavestate, incompatibilities, SavestateFormatError, type CompatibilityKey, type Savestate,
} from "../../src/worker/savestate/container";
import { adoptFreshGuestMemory, forgetGuestMemory, markGuestPagesDirty } from "../../src/worker/core/memory/guest-page-dirty";

afterEach(() => forgetGuestMemory());

const key = (over: Partial<CompatibilityKey> = {}): CompatibilityKey => ({
    buildSha: "abc1234", contentHash: "b".repeat(64), configHash: "c".repeat(64), bootLayout: "d".repeat(64),
    participants: { cpu: { version: 1, schemaHash: "s1" }, scheduler: { version: 2, schemaHash: "s2" } }, ...over,
});

describe("savestate value codec", () => {
    test("round-trips plain data, typed arrays and non-finite numbers", () => {
        const value = {
            a: [1, -2.5, "x", null, true], n: { inf: Infinity, ninf: -Infinity, nan: NaN, negZero: -0 },
            regs: new Int32Array([1, -1, 0x7fffffff]), bytes: new Uint8Array([0, 255]), f: new Float64Array([0.1]),
        };
        const back = decodeValue(encodeValue(value)) as any;
        expect(back.a).toEqual(value.a);
        expect(back.n.inf).toBe(Infinity);
        expect(back.n.ninf).toBe(-Infinity);
        expect(Number.isNaN(back.n.nan)).toBe(true);
        expect(Object.is(back.n.negZero, -0)).toBe(true);
        expect(back.regs).toBeInstanceOf(Int32Array);
        expect([...back.regs]).toEqual([...value.regs]);
        expect([...back.bytes]).toEqual([0, 255]);
        expect(back.f[0]).toBe(0.1);
    });

    test("refuses behaviour, class instances, cycles and __proto__, naming the path", () => {
        expect(() => encodeValue({ ok: 1, bad: [() => 0] } as any)).toThrow(SaveValueError);
        expect(() => encodeValue({ m: new Map() } as any)).toThrow(/\.m: Map is not a plain object/);
        expect(() => encodeValue({ $x: 1 } as any)).toThrow(/may not start with \$/);
        const loop: any = { a: { b: {} } };
        loop.a.b.back = loop.a;
        expect(() => encodeValue(loop)).toThrow(/\.a\.b\.back: cycle/);
        const shared = { x: 1 };
        expect(decodeValue(encodeValue({ p: shared, q: shared }))).toEqual({ p: { x: 1 }, q: { x: 1 } });
        expect(() => encodeValue(JSON.parse('{"__proto__":{"x":1}}'))).toThrow(/__proto__/);
        expect(() => decodeValue({ json: '{"__proto__":{"x":1}}', blobs: [] })).toThrow(/reserved key/);
    });

    test("accepts null-prototype objects, refuses array subclasses and runaway depth", () => {
        const dict = Object.create(null);
        dict.k = 1;
        expect(decodeValue(encodeValue({ d: dict }))).toEqual({ d: { k: 1 } });
        class List extends Array {}
        expect(() => encodeValue({ l: List.from([1]) } as any)).toThrow(/not a plain array/);
        let deep: any = 1;
        for (let i = 0; i < 5000; i++) deep = [deep];
        expect(() => encodeValue(deep)).toThrow(SaveValueError);
        expect(() => decodeValue({ json: "[".repeat(5000) + "]".repeat(5000), blobs: [] })).toThrow(SaveValueError);
    });

    test("encodes keys in sorted order whatever order they were built in", () => {
        expect(encodeValue({ b: 1, a: 2, 2: 3 }).json).toBe(encodeValue({ 2: 3, a: 2, b: 1 }).json);
        expect(encodeValue({ b: 1, a: 2 }).json).toBe('{"a":2,"b":1}');
    });

    test("rejects bad typed arrays and special numbers on decode", () => {
        const twelve = new Uint8Array(12);
        expect(() => decodeValue({ json: '{"$typed":"f64","blob":0}', blobs: [twelve] })).toThrow(/whole number/);
        expect(() => decodeValue({ json: '{"$typed":"f64","blob":0.5}', blobs: [twelve] })).toThrow(/bad typed array/);
        expect(() => decodeValue({ json: '{"$typed":"toString","blob":0}', blobs: [twelve] })).toThrow(/bad typed array/);
        expect(() => decodeValue({ json: '{"$num":"12abc"}', blobs: [] })).toThrow(/bad number/);
        expect(() => decodeValue({ json: '{"$num":"NaN","extra":1}', blobs: [] })).toThrow(/unexpected key/);
        expect(() => decodeValue({ json: '{"$typed":"u8","blob":0,"x":1}', blobs: [new Uint8Array(1)] })).toThrow(/unexpected key/);
    });

    test("a typed array view is captured by its own bytes, not its whole buffer", () => {
        const buf = new Uint8Array([9, 9, 1, 2, 3, 9]);
        const enc = encodeValue({ v: buf.subarray(2, 5) });
        expect(enc.blobs[0].length).toBe(3);
        expect([...(decodeValue(enc) as any).v]).toEqual([1, 2, 3]);
    });
});

describe("RAM chunk store", () => {
    const guest = (chunks: number) => new Uint8Array(chunks * RAM_CHUNK_SIZE);

    test("known-zero and scanned-zero chunks are skipped; restore zeroes them in the target", async () => {
        const mem = guest(8);
        adoptFreshGuestMemory(mem, 0);
        markGuestPagesDirty(RAM_CHUNK_SIZE, 3 * RAM_CHUNK_SIZE);
        mem[RAM_CHUNK_SIZE + 5] = 7;
        mem[3 * RAM_CHUNK_SIZE] = 9;
        const store = new MemoryChunkStore();
        const { manifest, stats } = await captureRam(mem, store);
        expect(manifest.chunks.map(([i]) => i)).toEqual([1, 3]);
        expect(stats).toMatchObject({ chunks: 8, knownZero: 5, scannedZero: 1, written: 2 });

        forgetGuestMemory();
        const target = guest(8).fill(0xaa);
        await restoreRam(target, manifest, store);
        expect(target[RAM_CHUNK_SIZE + 5]).toBe(7);
        expect(target[3 * RAM_CHUNK_SIZE]).toBe(9);
        expect(target.reduce((n, b) => n + (b !== 0 ? 1 : 0), 0)).toBe(2);
    });

    test("pages known to be zero are not read", async () => {
        class Counting extends Uint8Array {
            reads: number[] = [];
            override slice(start?: number, end?: number): Uint8Array {
                this.reads.push(start ?? 0);
                return new Uint8Array(this.buffer, this.byteOffset, this.byteLength).slice(start, end);
            }
        }
        const mem = new Counting(8 * RAM_CHUNK_SIZE);
        adoptFreshGuestMemory(mem, 0);
        markGuestPagesDirty(2 * RAM_CHUNK_SIZE + 100, 10);
        mem[2 * RAM_CHUNK_SIZE + 100] = 1;
        const snap = await snapshotRam(mem, new Set());
        expect(mem.reads).toEqual([2 * RAM_CHUNK_SIZE]);
        expect(snap.stats.knownZero).toBe(7);
    });

    test("identical content is stored once and a second save only copies and writes what changed", async () => {
        const mem = guest(4);
        mem[0] = 1; mem[RAM_CHUNK_SIZE] = 1; mem[2 * RAM_CHUNK_SIZE] = 2;
        const store = new MemoryChunkStore();
        const first = await captureRam(mem, store);
        expect(first.stats.written).toBe(2);
        expect(first.stats.reused).toBe(1);
        mem[2 * RAM_CHUNK_SIZE] = 3;
        const snap = await snapshotRam(mem, new Set(await store.list()));
        expect(snap.pending.size).toBe(1);
        const second = await captureRam(mem, store);
        expect(second.stats.written).toBe(1);
        expect(await collectGarbage(store, [second.manifest])).toBe(1);
        expect(store.chunks.size).toBe(2);
    });

    test("each stored chunk names its own codec, so raw and compressed saves can share chunks", async () => {
        const mem = guest(2);
        mem[0] = 1; mem[RAM_CHUNK_SIZE] = 2;
        const store = new MemoryChunkStore();
        await captureRam(mem, store, false);
        mem[RAM_CHUNK_SIZE] = 3;
        const { manifest, stats } = await captureRam(mem, store, true);
        expect(stats.reused).toBe(1);
        const target = guest(2);
        await restoreRam(target, manifest, store);
        expect([target[0], target[RAM_CHUNK_SIZE]]).toEqual([1, 3]);
    });

    test("a missing or corrupt chunk fails the restore and names it", async () => {
        const mem = guest(2);
        mem[0] = 1; mem[RAM_CHUNK_SIZE] = 2;
        const store = new MemoryChunkStore();
        const { manifest } = await captureRam(mem, store, false);
        const [, h1] = manifest.chunks[1];
        const raw = new Uint8Array(RAM_CHUNK_SIZE + 1);
        store.chunks.set(h1, raw);
        await expect(restoreRam(guest(2), manifest, store)).rejects.toThrow(new RegExp(`${h1} is corrupt`));
        store.chunks.delete(h1);
        await expect(restoreRam(guest(2), manifest, store)).rejects.toThrow(new RegExp(`${h1} is missing`));
        await expect(restoreRam(guest(3), manifest, store)).rejects.toThrow(/guest has/);
    });

    test("a chunk that inflates past its size is stopped at the cap", async () => {
        const mem = guest(1);
        mem[0] = 1;
        const store = new MemoryChunkStore();
        const { manifest } = await captureRam(mem, store);
        const [, hash] = manifest.chunks[0];
        const bomb = await deflate(new Uint8Array(16 * RAM_CHUNK_SIZE));
        const file = new Uint8Array(bomb.length + 1);
        file[0] = 1;
        file.set(bomb, 1);
        store.chunks.set(hash, file);
        await expect(restoreRam(guest(1), manifest, store)).rejects.toThrow(/corrupt/);
    });

    test("a manifest entry that cannot be placed fails instead of being skipped", async () => {
        const mem = guest(2);
        mem[0] = 1;
        const store = new MemoryChunkStore();
        const { manifest } = await captureRam(mem, store);
        const hash = manifest.chunks[0][1];
        const bad = (chunks: unknown[]): RamManifest => ({ ...manifest, chunks: chunks as RamManifest['chunks'] });
        for (const chunks of [[[-1, hash]], [[0.5, hash]], [[2, hash]], [[0, hash], [0, hash]], [[1, hash], [0, hash]], [[0, "../x"]]]) {
            await expect(restoreRam(guest(2), bad(chunks), store)).rejects.toThrow(/ram: /);
        }
        await expect(store.get("../x")).rejects.toThrow(/not a chunk hash/);
    });
});

describe("savestate container", () => {
    const sample = (): Savestate => ({
        header: {
            key: key(), overlay: "o".repeat(64), createdAt: 1700000000000, gameId: "game",
            ram: { chunkSize: RAM_CHUNK_SIZE, length: 2 * RAM_CHUNK_SIZE, chunks: [[1, "e".repeat(64)]] },
        },
        sections: new Map<string, any>([["cpu", { v: 1, regs: new Int32Array([1, 2]) }], ["scheduler", { v: 2, threads: [] }]]),
    });

    test("encodes and decodes header and sections", () => {
        const back = decodeSavestate(encodeSavestate(sample()));
        expect(back.header).toEqual(sample().header);
        expect([...back.sections.keys()]).toEqual(["cpu", "scheduler"]);
        expect([...(back.sections.get("cpu") as any).regs]).toEqual([1, 2]);
    });

    test("rejects foreign, truncated, padded and damaged input with one error type", () => {
        const bytes = encodeSavestate(sample());
        const fails = (b: Uint8Array, msg: RegExp) => {
            expect(() => decodeSavestate(b)).toThrow(SavestateFormatError);
            expect(() => decodeSavestate(b)).toThrow(msg);
        };
        fails(new Uint8Array(8), /not a savestate/);
        fails(bytes.subarray(0, bytes.length - 3), /truncated/);
        const padded = new Uint8Array(bytes.length + 1);
        padded.set(bytes);
        fails(padded, /trailing/);
        const jsonAt = 12;
        const brokenJson = bytes.slice();
        brokenJson[jsonAt] = 0x7d;
        fails(brokenJson, /unreadable/);
        const badUtf8 = bytes.slice();
        badUtf8[jsonAt] = 0xff;
        fails(badUtf8, /unreadable/);
    });

    test("validates the header shape", () => {
        const withHeader = (over: Record<string, unknown>) => {
            const s = sample();
            Object.assign(s.header as unknown as Record<string, unknown>, over);
            return encodeSavestate(s);
        };
        expect(() => decodeSavestate(withHeader({ key: { ...key(), participants: null } }))).toThrow(/participants is not an object/);
        expect(() => decodeSavestate(withHeader({ key: { ...key(), participants: { cpu: 1 } } }))).toThrow(/participant cpu/);
        expect(() => decodeSavestate(withHeader({ gameId: 5 }))).toThrow(/gameId is not a string/);
        expect(() => decodeSavestate(withHeader({ ram: { chunkSize: RAM_CHUNK_SIZE, length: 12345, chunks: [] } }))).toThrow(/bad length/);
        expect(() => decodeSavestate(withHeader({ ram: { chunkSize: RAM_CHUNK_SIZE, length: RAM_CHUNK_SIZE, chunks: [[-1, "e".repeat(64)]] } }))).toThrow(SavestateFormatError);
    });

    test("names every compatibility mismatch", () => {
        expect(incompatibilities(key(), key())).toEqual([]);
        expect(incompatibilities(key(), key({
            contentHash: "x",
            participants: { cpu: { version: 2, schemaHash: "s1" }, gdi: { version: 1, schemaHash: "g" } },
        }))).toEqual([
            "contentHash differs",
            "participant cpu is v2, snapshot has v1",
            "participant scheduler is unknown to this build",
            "participant gdi is missing from the snapshot",
        ]);
        expect(incompatibilities(key(), key({ participants: { cpu: { version: 1, schemaHash: "other" }, scheduler: { version: 2, schemaHash: "s2" } } })))
            .toEqual(["participant cpu has a different schema"]);
    });

    test("hashes are hex SHA-256 of the raw chunk", async () => {
        expect(await sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });
});
