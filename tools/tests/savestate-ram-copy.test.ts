import { describe, expect, test } from "bun:test";
import { MemoryChunkStore } from "../../src/worker/savestate/chunk-store";
import { copyRam, hashRamCopy, RAM_CHUNK_SIZE, restoreRam, snapshotRam, writeRamChunks, type RamPatch } from "../../src/worker/savestate/ram";
import { ParticipantRegistry } from "../../src/worker/savestate/participant";
import { captureSession, restoreSession, type SavestateTarget } from "../../src/worker/savestate/session";
import { decodeSavestate, type CompatibilityKey } from "../../src/worker/savestate/container";
import { CaptureRefusal } from "../../src/worker/savestate/object-codecs";

const KEY: CompatibilityKey = { buildSha: "a", contentHash: "b", configHash: "c", bootLayout: "d", participants: {} };

function target(mem: Uint8Array): SavestateTarget {
    return {
        guestMemory: () => mem,
        compatibilityKey: () => ({ ...KEY }),
        overlayState: () => "",
        gameId: () => "g",
        touchedModules: () => [],
    };
}

function guest(chunks: number, seed: number): Uint8Array {
    const mem = new Uint8Array(chunks * RAM_CHUNK_SIZE - 4096);
    let x = seed >>> 0;
    for (let c = 0; c < chunks; c++) {
        const base = c * RAM_CHUNK_SIZE;
        const end = Math.min(mem.length, base + RAM_CHUNK_SIZE);
        if (c % 5 === 1) continue;
        if (c % 7 === 3) { mem.fill(0x5a, base, end); continue; }
        for (let i = base; i < end; i += 61) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; mem[i] = x >>> 24; }
        mem[base] = 1 + (c & 0x7f);
    }
    return mem;
}

const plain = (snap: { manifest: unknown; pending: Map<string, Uint8Array>; stats: unknown }) => ({
    manifest: snap.manifest,
    pending: [...snap.pending].map(([hash, bytes]) => [hash, Buffer.from(bytes).toString("base64")]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
    stats: snap.stats,
});

describe("RAM is copied while the guest is halted and hashed afterwards", () => {
    const PATCHES: RamPatch[] = [
        { address: 2 * RAM_CHUNK_SIZE + 10, bytes: [1, 2, 3] },
        { address: 6 * RAM_CHUNK_SIZE - 1, bytes: [9, 8] },
        { address: 8 * RAM_CHUNK_SIZE, bytes: [0] },
    ];

    test("copy then hash gives the manifest, pending chunks and counts of the one-turn snapshot", async () => {
        const mem = guest(24, 7);
        mem[8 * RAM_CHUNK_SIZE] = 4;
        mem.fill(0, 8 * RAM_CHUNK_SIZE + 1, 9 * RAM_CHUNK_SIZE);
        const first = snapshotRam(mem, new Set(), PATCHES);
        expect(first.stats.scannedZero).toBeGreaterThan(1);
        expect(first.stats.reused).toBeGreaterThan(0);
        const known = new Set([...first.pending.keys()].slice(0, 5));
        for (const k of [new Set<string>(), known]) {
            const want = plain(snapshotRam(mem, k, PATCHES));
            const copy = copyRam(mem, k, PATCHES);
            expect(copy instanceof Promise).toBe(false);
            expect(plain(await hashRamCopy(copy, k))).toEqual(want);
        }
    });

    test("a write to guest RAM after the copy does not reach the snapshot", async () => {
        const mem = guest(12, 3);
        const want = plain(snapshotRam(mem, new Set()));
        const copy = copyRam(mem, new Set());
        mem.fill(0xee);
        expect(plain(await hashRamCopy(copy, new Set()))).toEqual(want);
    });

    test("past the copy budget the remaining chunks are hashed in place, with the same result", async () => {
        const mem = guest(24, 11);
        const first = snapshotRam(mem, new Set());
        const known = new Set([...first.pending.keys()].slice(3, 9));
        for (const budget of [0, RAM_CHUNK_SIZE, 5 * RAM_CHUNK_SIZE + 1]) {
            const want = plain(snapshotRam(mem, known));
            const copy = copyRam(mem, known, [], budget);
            expect(copy.copied).toBeLessThanOrEqual(budget + RAM_CHUNK_SIZE);
            expect(copy.chunks.filter(c => c[1] !== null).length).toBe(Math.ceil(Math.min(budget, copy.copied) / RAM_CHUNK_SIZE));
            expect(copy.chunks.some(c => c[2] !== null)).toBe(true);
            mem[0] ^= 0xff;
            const got = plain(await hashRamCopy(copy, known));
            mem[0] ^= 0xff;
            expect(got).toEqual(want);
        }
    });

    test("a copy that cannot be allocated falls back to hashing in place", async () => {
        const mem = guest(10, 5);
        const want = plain(snapshotRam(mem, new Set()));
        const real = mem.slice.bind(mem);
        let calls = 0;
        (mem as { slice: typeof mem.slice }).slice = (...a) => { if (++calls === 3) throw new RangeError("Array buffer allocation failed"); return real(...a); };
        const copy = copyRam(mem, new Set());
        delete (mem as { slice?: unknown }).slice;
        expect(copy.chunks.filter(c => c[1] !== null).length).toBe(2);
        expect(copy.chunks.filter(c => c[2] !== null).length).toBeGreaterThan(3);
        expect(plain(await hashRamCopy(copy, new Set()))).toEqual(want);
    });

    test("a patched chunk that becomes zero is left out, and a bad patch is refused", async () => {
        const mem = new Uint8Array(3 * RAM_CHUNK_SIZE);
        mem[RAM_CHUNK_SIZE + 5] = 7;
        const snap = await hashRamCopy(copyRam(mem, new Set(), [{ address: RAM_CHUNK_SIZE + 5, bytes: [0] }]), new Set());
        expect(snap.manifest.chunks).toEqual([]);
        expect(snap.stats.scannedZero).toBe(3);
        expect(mem[RAM_CHUNK_SIZE + 5]).toBe(7);
        expect(() => copyRam(mem, new Set(), [{ address: mem.length, bytes: [1] }])).toThrow("outside guest memory");
    });

    test("fifty saves leave no copy behind: the copy list is emptied and pending drains into the store", async () => {
        const mem = guest(16, 9);
        const store = new MemoryChunkStore();
        for (let round = 0; round < 50; round++) {
            mem[(round % 16) * RAM_CHUNK_SIZE + 100] = round + 1;
            const known = new Set(await store.list());
            const copy = copyRam(mem, known);
            const snap = await hashRamCopy(copy, known);
            expect(copy.chunks.every(c => c[1] === null)).toBe(true);
            if (round > 0) expect(snap.pending.size).toBeLessThanOrEqual(1);
            await writeRamChunks(snap.pending, store);
            expect(snap.pending.size).toBe(0);
            const back = new Uint8Array(mem.length).fill(3);
            await restoreRam(back, snap.manifest, store);
            expect(Buffer.compare(Buffer.from(back), Buffer.from(mem))).toBe(0);
        }
    });
});

describe("captureSession lets the guest go before it hashes", () => {
    const registryWith = (log: string[]): ParticipantRegistry => {
        const reg = new ParticipantRegistry();
        reg.add({ id: "cpu", version: 1, order: 99, capture: () => { log.push("capture"); return null; }, restore: () => undefined });
        return reg;
    };

    test("the callback runs once, after the last readiness check and before any hash is awaited; RAM written from it is not saved", async () => {
        const mem = guest(8, 21);
        const before = mem.slice();
        const log: string[] = [];
        const store = new MemoryChunkStore();
        let turn = 0;
        void Promise.resolve().then(() => { turn++; });
        const pending = captureSession(target(mem), new Set(), () => { log.push("ready"); }, registryWith(log), () => {
            log.push(`resumed in turn ${turn}`);
            mem.fill(0x77);
        });
        const result = await pending;
        expect(log).toEqual(["ready", "capture", "ready", "resumed in turn 1"]);
        expect(result.ramCopyMs).toBeGreaterThanOrEqual(0);
        await writeRamChunks(result.pending, store);
        const back = new Uint8Array(mem.length);
        await restoreSession(target(back), decodeSavestate(result.bytes), store, registryWith([]));
        expect(Buffer.compare(Buffer.from(back), Buffer.from(before))).toBe(0);
    });

    test("a safe point lost during the capture refuses before the guest is let go", async () => {
        const mem = guest(4, 2);
        let checks = 0;
        let resumed = 0;
        const err = await captureSession(target(mem), new Set(), () => { if (++checks === 2) throw new CaptureRefusal("savestate: the safe point was lost"); }, registryWith([]), () => { resumed++; }).catch(e => e);
        expect(err).toBeInstanceOf(CaptureRefusal);
        expect(resumed).toBe(0);
    });
});
