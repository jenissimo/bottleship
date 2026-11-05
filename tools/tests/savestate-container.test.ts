import { afterEach, describe, expect, test } from "bun:test";
import { decodeValue, encodeValue, SaveValueError } from "../../src/worker/savestate/value-codec";
import { MemoryChunkStore } from "../../src/worker/savestate/chunk-store";
import { captureRam, collectGarbage, restoreRam, RAM_CHUNK_SIZE } from "../../src/worker/savestate/ram";
import {
    decodeSavestate, encodeSavestate, incompatibilities, type CompatibilityKey, type Savestate,
} from "../../src/worker/savestate/container";
import { adoptFreshGuestMemory, forgetGuestMemory, markGuestPagesDirty } from "../../src/worker/core/memory/guest-page-dirty";

afterEach(() => forgetGuestMemory());

const key = (over: Partial<CompatibilityKey> = {}): CompatibilityKey => ({
    buildSha: "abc1234", bundleHash: "b".repeat(64), configHash: "c".repeat(64), bootLayout: "d".repeat(64),
    participants: { cpu: 1, scheduler: 2 }, ...over,
});

describe("savestate value codec", () => {
    test("round-trips plain data, typed arrays and non-finite numbers", () => {
        const value = {
            a: [1, -2.5, "x", null, true], n: { inf: Infinity, nan: NaN, negZero: -0 },
            regs: new Int32Array([1, -1, 0x7fffffff]), bytes: new Uint8Array([0, 255]), f: new Float64Array([0.1]),
        };
        const back = decodeValue(encodeValue(value)) as any;
        expect(back.a).toEqual(value.a);
        expect(back.n.inf).toBe(Infinity);
        expect(Number.isNaN(back.n.nan)).toBe(true);
        expect(Object.is(back.n.negZero, -0)).toBe(true);
        expect(back.regs).toBeInstanceOf(Int32Array);
        expect([...back.regs]).toEqual([...value.regs]);
        expect([...back.bytes]).toEqual([0, 255]);
        expect(back.f[0]).toBe(0.1);
    });

    test("refuses behaviour and class instances, naming the path", () => {
        expect(() => encodeValue({ ok: 1, bad: [() => 0] } as any)).toThrow(SaveValueError);
        expect(() => encodeValue({ m: new Map() } as any)).toThrow(/\.m: Map is not a plain object/);
        expect(() => encodeValue({ $x: 1 } as any)).toThrow(/may not start with \$/);
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

    test("identical content is stored once and a second save only writes what changed", async () => {
        const mem = guest(4);
        mem[0] = 1; mem[RAM_CHUNK_SIZE] = 1; mem[2 * RAM_CHUNK_SIZE] = 2;
        const store = new MemoryChunkStore();
        const first = await captureRam(mem, store);
        expect(first.stats.written).toBe(2);
        expect(first.stats.reused).toBe(1);
        mem[2 * RAM_CHUNK_SIZE] = 3;
        const second = await captureRam(mem, store);
        expect(second.stats.written).toBe(1);
        expect(await collectGarbage(store, [second.manifest])).toBe(1);
        expect(store.chunks.size).toBe(2);
    });

    test("a missing or corrupt chunk fails the restore before any byte is written", async () => {
        const mem = guest(2);
        mem[0] = 1; mem[RAM_CHUNK_SIZE] = 2;
        const store = new MemoryChunkStore();
        const { manifest } = await captureRam(mem, store, false);
        const [, h1] = manifest.chunks[1];
        store.chunks.set(h1, new Uint8Array(RAM_CHUNK_SIZE));
        const target = guest(2);
        await expect(restoreRam(target, manifest, store)).rejects.toThrow(/corrupt/);
        expect(target[0]).toBe(0);
        store.chunks.delete(h1);
        await expect(restoreRam(target, manifest, store)).rejects.toThrow(/missing/);
        await expect(restoreRam(guest(3), manifest, store)).rejects.toThrow(/guest has/);
    });
});

describe("savestate container", () => {
    const sample = (): Savestate => ({
        header: {
            key: key(), overlay: "o".repeat(64), createdAt: 1700000000000, gameId: "game",
            ram: { chunkSize: RAM_CHUNK_SIZE, length: 2 * RAM_CHUNK_SIZE, compressed: true, chunks: [[1, "e".repeat(64)]] },
        },
        sections: new Map<string, any>([["cpu", { v: 1, regs: new Int32Array([1, 2]) }], ["scheduler", { v: 2, threads: [] }]]),
    });

    test("encodes and decodes header and sections", () => {
        const back = decodeSavestate(encodeSavestate(sample()));
        expect(back.header).toEqual(sample().header);
        expect([...back.sections.keys()]).toEqual(["cpu", "scheduler"]);
        expect([...(back.sections.get("cpu") as any).regs]).toEqual([1, 2]);
    });

    test("rejects foreign, truncated and padded input", () => {
        const bytes = encodeSavestate(sample());
        expect(() => decodeSavestate(new Uint8Array(8))).toThrow(/not a savestate/);
        expect(() => decodeSavestate(bytes.subarray(0, bytes.length - 3))).toThrow(/truncated/);
        const padded = new Uint8Array(bytes.length + 1);
        padded.set(bytes);
        expect(() => decodeSavestate(padded)).toThrow(/trailing/);
    });

    test("names every compatibility mismatch", () => {
        expect(incompatibilities(key(), key())).toEqual([]);
        expect(incompatibilities(key(), key({ bundleHash: "x", participants: { cpu: 2, gdi: 1 } }))).toEqual([
            "bundleHash differs",
            "participant cpu is v2, snapshot has v1",
            "participant scheduler is unknown to this build",
            "participant gdi is missing from the snapshot",
        ]);
    });
});
