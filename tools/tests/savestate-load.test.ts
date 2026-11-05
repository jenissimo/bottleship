import { describe, expect, test } from "bun:test";
import { MemoryChunkStore, type ChunkStore } from "../../src/worker/savestate/chunk-store";
import { RAM_CHUNK_SIZE } from "../../src/worker/savestate/ram";
import { MemoryDir, type Dir } from "../../src/worker/savestate/slots";
import { ParticipantRegistry } from "../../src/worker/savestate/participant";
import { captureSession, restoreSession, RestoreFailed, type SavestateTarget } from "../../src/worker/savestate/session";
import { decodeSavestate, type CompatibilityKey } from "../../src/worker/savestate/container";
import { snapshotRam, writeRamChunks } from "../../src/worker/savestate/ram";
import { sha256HexSync } from "../../src/worker/savestate/sha256";
import { sha256Hex } from "../../src/worker/savestate/chunk-store";
import { CaptureRefusal } from "../../src/worker/savestate/object-codecs";
import {
    guestConfig, openGameStore, PENDING_TTL_MS, runPendingLoad, writePendingLoad, type SavestateStorage,
} from "../../src/worker/savestate/host";
import { haltAtSafePoint, HALT_ATTEMPTS, type HaltIo } from "../../src/worker/savestate/halt";
import type { Readiness } from "../../src/worker/savestate/readiness";

const KEY: CompatibilityKey = { buildSha: "a", contentHash: "b", configHash: "c", bootLayout: "d", participants: {} };

function target(mem: Uint8Array, gameId = "g"): SavestateTarget {
    return {
        guestMemory: () => mem,
        compatibilityKey: () => ({ ...KEY }),
        overlayState: () => "",
        gameId: () => gameId,
        touchedModules: () => [],
    };
}

function memoryStorage(): SavestateStorage & { root: MemoryDir; stores: Map<string, MemoryChunkStore> } {
    const root = new MemoryDir();
    const stores = new Map<string, MemoryChunkStore>();
    return {
        root, stores,
        gameDir: async (game) => (await root.dir(game, true)) as Dir,
        chunks: async (game) => {
            let s = stores.get(game);
            if (!s) { s = new MemoryChunkStore(); stores.set(game, s); }
            return s as ChunkStore;
        },
    };
}

function registry(log: string[], failOn?: string): ParticipantRegistry {
    const reg = new ParticipantRegistry();
    for (const id of ["time", "cpu"] as const) {
        let value = 0;
        reg.add({
            id, version: 1, order: id === "time" ? 1 : 99,
            capture: () => ({ value: ++value }),
            restore: (s) => {
                log.push(id);
                if (id === failOn) throw new Error(`${id} cannot restore`);
                value = (s as { value: number }).value;
            },
        });
    }
    return reg;
}

async function savedSlot(storage: ReturnType<typeof memoryStorage>, game: string, mem: Uint8Array, reg: ParticipantRegistry): Promise<void> {
    const store = await openGameStore(storage, game);
    const result = await captureSession(target(mem), new Set(), () => undefined, reg);
    await writeRamChunks(result.pending, store.chunkStore);
    await store.save("one", result.bytes, 0);
}

describe("prepare runs before any capture", () => {
    test("every prepare finishes, then readiness is checked, then participants capture and RAM is read", async () => {
        const mem = new Uint8Array(RAM_CHUNK_SIZE);
        const log: string[] = [];
        const reg = new ParticipantRegistry();
        reg.add({
            id: "time", version: 1, order: 1,
            prepare: async () => { await Promise.resolve(); mem[0] = 9; log.push("prepare time"); },
            capture: () => { log.push("capture time"); return null; },
            restore: () => undefined,
        });
        reg.add({ id: "cpu", version: 1, order: 99, capture: () => { log.push("capture cpu"); return null; }, restore: () => undefined });
        const result = await captureSession(target(mem), new Set(), () => { log.push("ready"); }, reg);
        expect(log).toEqual(["prepare time", "ready", "capture time", "capture cpu", "ready"]);
        expect([...result.pending.values()].some(b => b[0] === 9)).toBe(true);
        expect(Object.keys(result.captureMs).sort()).toEqual(["cpu", "time"]);
    });
});

describe("restore is all or nothing", () => {
    test("a missing chunk is found before anything is written", async () => {
        const mem = new Uint8Array(3 * RAM_CHUNK_SIZE).fill(7);
        const store = new MemoryChunkStore();
        const reg = registry([]);
        const result = await captureSession(target(mem), new Set(), () => undefined, reg);
        await writeRamChunks(result.pending, store);
        await store.delete([...store.chunks.keys()][0]!);
        const fresh = new Uint8Array(mem.length).fill(1);
        const err = await restoreSession(target(fresh), decodeSavestate(result.bytes), store, reg).catch(e => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(RestoreFailed);
        expect(String(err.message)).toContain("missing");
        expect(fresh.every(b => b === 1)).toBe(true);
    });

    test("a participant that throws after RAM was written is a RestoreFailed", async () => {
        const mem = new Uint8Array(2 * RAM_CHUNK_SIZE).fill(5);
        const store = new MemoryChunkStore();
        const result = await captureSession(target(mem), new Set(), () => undefined, registry([]));
        await writeRamChunks(result.pending, store);
        const log: string[] = [];
        const err = await restoreSession(target(new Uint8Array(mem.length)), decodeSavestate(result.bytes), store, registry(log, "time")).catch(e => e);
        expect(err).toBeInstanceOf(RestoreFailed);
        expect(log).toEqual(["time"]);
    });

    test("capture → restore through the session writes RAM and every participant", async () => {
        const mem = new Uint8Array(4 * RAM_CHUNK_SIZE);
        mem[RAM_CHUNK_SIZE + 3] = 9;
        const store = new MemoryChunkStore();
        const result = await captureSession(target(mem), new Set(), () => undefined, registry([]));
        await writeRamChunks(result.pending, store);
        const fresh = new Uint8Array(mem.length).fill(4);
        const log: string[] = [];
        await restoreSession(target(fresh), decodeSavestate(result.bytes), store, registry(log));
        expect(fresh).toEqual(mem);
        expect(log).toEqual(["time", "cpu"]);
    });
});

describe("pending load", () => {
    const run = (storage: SavestateStorage, game: string, mem: Uint8Array, opts: { fresh?: boolean; now?: number; log?: string[] } = {}) =>
        runPendingLoad({
            storage, game, target: target(mem), freshWorker: opts.fresh ?? true, now: opts.now ?? 1000,
            participants: registry(opts.log ?? []),
        });

    test("belongs to its game: booting another game leaves it in place", async () => {
        const storage = memoryStorage();
        const mem = new Uint8Array(RAM_CHUNK_SIZE).fill(3);
        await savedSlot(storage, "a", mem, registry([]));
        await writePendingLoad(storage, "a", "one", 1000);
        expect(await run(storage, "b", new Uint8Array(mem.length))).toEqual({ kind: "none" });
        expect(await (await storage.gameDir("a")).read("pending-load.json")).not.toBeNull();
        const into = new Uint8Array(mem.length);
        const outcome = await run(storage, "a", into);
        expect(outcome.kind).toBe("restored");
        expect(into).toEqual(mem);
        expect(await (await storage.gameDir("a")).read("pending-load.json")).toBeNull();
    });

    test("is kept for the next fresh worker when this worker has already booted", async () => {
        const storage = memoryStorage();
        await savedSlot(storage, "a", new Uint8Array(RAM_CHUNK_SIZE), registry([]));
        await writePendingLoad(storage, "a", "one", 1000);
        const log: string[] = [];
        expect(await run(storage, "a", new Uint8Array(RAM_CHUNK_SIZE), { fresh: false, log })).toEqual({ kind: "needs-fresh-worker", slot: "one" });
        expect(log).toEqual([]);
        expect(await (await storage.gameDir("a")).read("pending-load.json")).not.toBeNull();
    });

    test("expires", async () => {
        const storage = memoryStorage();
        await savedSlot(storage, "a", new Uint8Array(RAM_CHUNK_SIZE), registry([]));
        await writePendingLoad(storage, "a", "one", 1000);
        const log: string[] = [];
        expect(await run(storage, "a", new Uint8Array(RAM_CHUNK_SIZE), { now: 1000 + PENDING_TTL_MS + 1, log })).toEqual({ kind: "expired", slot: "one" });
        expect(log).toEqual([]);
    });
});

describe("boot identity", () => {
    test("host-only settings do not change the config key", () => {
        expect(guestConfig({ quality: 1, qualityUserPref: 2, network: { a: 1 }, screenResolution: 3 })).toEqual({ screenResolution: 3 });
    });
});

describe("halt", () => {
    const ready: Readiness = { ready: true, blockers: [], restartableParks: 0 };
    const busy: Readiness = { ready: false, blockers: [{ kind: "async-park", detail: "x" } as never], restartableParks: 0 };

    function io(over: Partial<HaltIo> & { paused?: boolean }): HaltIo & { calls: string[] } {
        const calls: string[] = [];
        let paused = over.paused ?? false;
        return {
            calls,
            isPaused: () => paused,
            pause: () => { calls.push("pause"); paused = true; },
            resume: () => { calls.push("resume"); paused = false; },
            isRunning: () => false,
            flushWriteBuffer: () => calls.push("flush"),
            readiness: () => ready,
            sleep: async () => undefined,
            ...over,
        };
    }

    test("a paused session is checked once and never resumed", async () => {
        const h = io({ paused: true, readiness: () => busy });
        await expect(haltAtSafePoint(h)).rejects.toBeInstanceOf(CaptureRefusal);
        expect(h.calls).toEqual(["pause", "flush"]);
        const ok = io({ paused: true });
        (await haltAtSafePoint(ok)).release();
        expect(ok.calls).not.toContain("resume");
    });

    test("refuses when v86 does not stop, and gives the session back", async () => {
        const h = io({ isRunning: () => true });
        await expect(haltAtSafePoint(h)).rejects.toThrow("v86 did not stop");
        expect(h.calls).toEqual(["pause", "resume"]);
    });

    test("no safe point is a CaptureRefusal after the attempts run out", async () => {
        const h = io({ readiness: () => busy });
        await expect(haltAtSafePoint(h)).rejects.toBeInstanceOf(CaptureRefusal);
        expect(h.calls.filter(c => c === "pause").length).toBe(HALT_ATTEMPTS);
    });
});

describe("synchronous RAM hash", () => {
    test("matches WebCrypto SHA-256 at every padding boundary", async () => {
        for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, RAM_CHUNK_SIZE]) {
            const bytes = new Uint8Array(n);
            for (let i = 0; i < n; i++) bytes[i] = (i * 131 + 7) & 0xff;
            expect(sha256HexSync(bytes)).toBe(await sha256Hex(bytes));
        }
    });

    test("snapshotRam runs in one turn", () => {
        const mem = new Uint8Array(2 * RAM_CHUNK_SIZE).fill(1);
        const snap = snapshotRam(mem, new Set());
        expect(snap instanceof Promise).toBe(false);
        expect(snap.manifest.chunks.length).toBe(2);
        expect(snap.pending.size).toBe(1);
    });

    test("a manifest for another RAM size is refused before anything is written", async () => {
        const mem = new Uint8Array(2 * RAM_CHUNK_SIZE).fill(5);
        const store = new MemoryChunkStore();
        const result = await captureSession(target(mem), new Set(), () => undefined, registry([]));
        await writeRamChunks(result.pending, store);
        const other = new Uint8Array(3 * RAM_CHUNK_SIZE).fill(1);
        const err = await restoreSession(target(other), decodeSavestate(result.bytes), store, registry([])).catch(e => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(RestoreFailed);
        expect(other.every(b => b === 1)).toBe(true);
    });
});
