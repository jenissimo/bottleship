import { afterEach, describe, expect, test } from "bun:test";
import { MemoryChunkStore } from "../../src/worker/savestate/chunk-store";
import { RAM_CHUNK_SIZE, writeRamChunks } from "../../src/worker/savestate/ram";
import { ParticipantRegistry, type CaptureContext } from "../../src/worker/savestate/participant";
import { captureSession, newCaptureRun, restoreSession, type SavestateTarget } from "../../src/worker/savestate/session";
import { decodeSavestate, type CompatibilityKey } from "../../src/worker/savestate/container";
import { BLOBS, PendingBlobs, blobHash, knownBlobHash, savedBlobs } from "../../src/worker/savestate/blobs";
import { sha256HexSync } from "../../src/worker/savestate/sha256";
import type { SaveValue } from "../../src/worker/savestate/value-codec";

const KEY: CompatibilityKey = { buildSha: "a", contentHash: "b", configHash: "c", bootLayout: "d", participants: {} };

function target(mem: Uint8Array): SavestateTarget {
    return { guestMemory: () => mem, compatibilityKey: () => ({ ...KEY }), overlayState: () => "", gameId: () => "g", touchedModules: () => [] };
}

const guest = (): Uint8Array => {
    const mem = new Uint8Array(2 * RAM_CHUNK_SIZE);
    mem[10] = 7;
    return mem;
};

let serial = 0;
const fresh = (length = 4000): Uint8Array => {
    serial++;
    return Uint8Array.from({ length }, (_, i) => (i * 13 + serial * 31) & 0xff);
};

function registry(capture: (ctx: CaptureContext) => SaveValue, back: Uint8Array[] = []): ParticipantRegistry {
    const reg = new ParticipantRegistry();
    reg.add({
        id: "time", version: 1,
        capture,
        restore: (s, ctx) => { for (const name of s as string[]) back.push(ctx.blob(name)); },
    });
    return reg;
}

const names = (held: Uint8Array[]) => (ctx: CaptureContext) => held.map(b => ctx.blob(b));

describe("blobs are named after the guest has resumed", () => {
    const subtle = crypto.subtle;
    const digest = subtle.digest;
    afterEach(() => { subtle.digest = digest; });

    test("nothing is hashed while the guest is halted, and the save is the one eager naming writes", async () => {
        const a = fresh(), b = fresh(70_000);
        let atResume: Array<string | undefined> = [];
        const result = await captureSession(target(guest()), new Set(), () => undefined, registry(names([a, b, a])),
            () => { atResume = [knownBlobHash(a), knownBlobHash(b)]; });
        expect(atResume).toEqual([undefined, undefined]);
        expect([knownBlobHash(a), knownBlobHash(b)]).toEqual([sha256HexSync(a), sha256HexSync(b)]);

        const eager = await captureSession(target(guest()), new Set(), () => undefined, registry(names([a, b, a])));
        const got = decodeSavestate(result.bytes), want = decodeSavestate(eager.bytes);
        expect(got.sections.get("time")).toEqual([sha256HexSync(a), sha256HexSync(b), sha256HexSync(a)]);
        expect([...got.sections]).toEqual([...want.sections]);
        expect(result.blobs).toEqual(eager.blobs);
        expect(result.sections).toEqual(eager.sections);
        expect([...result.pending.keys()].sort()).toEqual([...eager.pending.keys()].sort());
    });

    test("it comes back verified through a restore", async () => {
        const a = fresh(), b = fresh(3);
        const store = new MemoryChunkStore(), back: Uint8Array[] = [];
        const result = await captureSession(target(guest()), new Set(), () => undefined, registry(names([a, b])));
        await writeRamChunks(result.pending, store);
        const mem = new Uint8Array(2 * RAM_CHUNK_SIZE);
        await restoreSession(target(mem), decodeSavestate(result.bytes), store, registry(() => [], back));
        expect(back).toEqual([a, b]);
        expect(mem[10]).toBe(7);
    });

    test("two arrays with the same bytes are one blob, stored once", async () => {
        const a = fresh(), twin = a.slice();
        const store = new MemoryChunkStore();
        const result = await captureSession(target(guest()), new Set(), () => undefined, registry(names([a, twin])));
        expect(result.blobs).toEqual([[sha256HexSync(a), a.length]]);
        const section = decodeSavestate(result.bytes).sections.get("time") as string[];
        expect(section[0]).toBe(section[1]!);
        const ram = result.pending.size - 1;
        await writeRamChunks(result.pending, store);
        expect(store.chunks.size).toBe(ram + 1);
    });

    test("a name used as a key or nested in a record is resolved like any other", async () => {
        const a = fresh();
        const result = await captureSession(target(guest()), new Set(), () => undefined,
            registry(ctx => ({ byName: { [ctx.blob(a)]: 1 }, deep: [{ pixels: ctx.blob(a) }] })));
        const hash = sha256HexSync(a);
        expect(decodeSavestate(result.bytes).sections.get("time")).toEqual({ byName: { [hash]: 1 }, deep: [{ pixels: hash }] });
    });

    test("a name stored inside other text is refused by name and nothing is handed on to be written", async () => {
        const a = fresh();
        const failed = await captureSession(target(guest()), new Set(), () => undefined,
            registry(ctx => `tex:${ctx.blob(a)}`)).catch(e => e as Error);
        expect(failed).toBeInstanceOf(Error);
        expect((failed as Error).message).toBe("savestate: time stores a blob reference inside other text");
    });

    test("when the platform digest fails the hash is computed in place and the save is the same", async () => {
        const a = fresh();
        let calls = 0;
        subtle.digest = (() => { calls++; return Promise.reject(new Error("out of memory")); }) as never;
        const result = await captureSession(target(new Uint8Array(RAM_CHUNK_SIZE)), new Set(), () => undefined, registry(names([a])));
        subtle.digest = digest;
        expect(calls).toBeGreaterThan(0);
        expect(result.blobs).toEqual([[sha256HexSync(a), a.length]]);
    });

    test("an array that cannot be read any more after the resume fails the save by name", async () => {
        const a = fresh();
        const failed = await captureSession(target(guest()), new Set(), () => undefined, registry(names([a])),
            () => { structuredClone(a.buffer, { transfer: [a.buffer] }); }).catch(e => e as Error);
        expect(failed).toBeInstanceOf(Error);
        expect((failed as Error).message).toBe("savestate: a blob of 4000 bytes changed size after it was handed to the save; try saving again");
    });

    test("two captures that hold the same arrays at once agree", async () => {
        const a = fresh(200_000), b = fresh();
        const [one, two] = await Promise.all([
            captureSession(target(guest()), new Set(), () => undefined, registry(names([a, b]))),
            captureSession(target(guest()), new Set(), () => undefined, registry(names([b, a]))),
        ]);
        expect(one.blobs).toEqual(two.blobs);
        expect(decodeSavestate(one.bytes).sections.get("time")).toEqual([sha256HexSync(a), sha256HexSync(b)]);
        expect(decodeSavestate(two.bytes).sections.get("time")).toEqual([sha256HexSync(b), sha256HexSync(a)]);
    });

    test("an array an earlier save hashed is named on the spot and not hashed again", async () => {
        const a = fresh();
        await captureSession(target(guest()), new Set(), () => undefined, registry(names([a])));
        let calls = 0;
        subtle.digest = ((...args: Parameters<typeof digest>) => {
            if ((args[1] as Uint8Array).byteLength === a.length) calls++;
            return digest.apply(subtle, args);
        }) as never;
        let seen = "";
        const second = await captureSession(target(guest()), new Set(), () => undefined,
            registry(ctx => [seen = ctx.blob(a)]));
        expect(seen).toBe(sha256HexSync(a));
        expect(calls).toBe(0);
        expect(second.blobs).toEqual([[sha256HexSync(a), a.length]]);
    });

    test("fifty saves of changing arrays write each array once and leave one blob list per save", async () => {
        const store = new MemoryChunkStore();
        const keep = fresh();
        let ram = -1;
        for (let round = 0; round < 50; round++) {
            const changing = fresh(500 + round);
            const result = await captureSession(target(guest()), new Set(await store.list()), () => undefined, registry(names([keep, changing])));
            expect(savedBlobs(decodeSavestate(result.bytes)).length).toBe(2);
            await writeRamChunks(result.pending, store);
            if (ram < 0) ram = store.chunks.size - 2;
            expect(store.chunks.size).toBe(ram + 2 + round);
        }
    });

    test("a capture run made without deferral names every blob on the spot, as before", () => {
        const a = fresh();
        const run = newCaptureRun();
        expect(run.blob(a)).toBe(sha256HexSync(a));
        expect([...run.blobs.keys()]).toEqual([blobHash(a)]);
    });

    test("stand-ins of two runs never resolve each other", async () => {
        const a = fresh(), b = fresh();
        const one = new PendingBlobs(), two = new PendingBlobs();
        const tokenA = one.token(a), tokenB = two.token(b);
        expect(tokenA).not.toBe(tokenB);
        expect(one.token(a)).toBe(tokenA);
        expect(() => one.resolve(JSON.stringify([tokenA]), "x")).toThrow("savestate: blob names are asked for before the blobs are hashed");
        await one.hash(4);
        expect(one.resolve(JSON.stringify([tokenA, tokenB]), "x")).toBe(JSON.stringify([sha256HexSync(a), tokenB]));
    });

    test("a state without blobs has no blob section", async () => {
        const result = await captureSession(target(guest()), new Set(), () => undefined, registry(() => []));
        expect(decodeSavestate(result.bytes).sections.has(BLOBS)).toBe(false);
    });
});
