/**
 * The STORED-entry sync range path installs a read window (perf plan §4.1).
 *
 * A run of small sequential reads through a pak must cross to the source ONCE and then
 * be served out of the handle's window. Every assertion here is byte-level as well as
 * count-level: a window that collapses the crossings while serving the wrong bytes is
 * exactly the failure this mechanism is capable of, and a count-only test would pass.
 */
import { describe, expect, test } from "bun:test";
import { VirtualFileSystem, vfsIoCensus } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive, ZipEntry } from "@bottleship/formats/zip";
import { installFakeOpfs } from "./fixtures/fake-opfs";

const GENERIC_READ = 0x80000000;
const OPEN_EXISTING = 3;

function romEntry(name: string, size: number): [string, ZipEntry] {
    return [
        name,
        { name, compressedSize: size, uncompressedSize: size, compression: 0, localHeaderOffset: 0, isDirectory: false },
    ];
}

interface Ramp {
    archive: ZipArchive;
    bytes: Uint8Array;
    /** Every sync range read that reached the source: [offset, length]. */
    calls: Array<[number, number]>;
}

/** ZipArchive stand-in over a byte ramp that COUNTS the crossings, and can be told to
 *  answer short (what CachedSource.assemble does at a partially-resident run). */
function rampArchive(size: number, opts: { shortTo?: number } = {}): Ramp {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 7) & 0xff;
    const calls: Array<[number, number]> = [];
    const archive = {
        readEntryRangeSync: (_e: ZipEntry, off: number, len: number) => {
            calls.push([off, len]);
            const capped = opts.shortTo !== undefined ? Math.min(len, opts.shortTo) : len;
            return bytes.subarray(off, Math.min(size, off + capped));
        },
        readEntryRange: async (_e: ZipEntry, off: number, len: number) =>
            bytes.subarray(off, Math.min(size, off + len)),
        readEntry: async () => bytes,
    } as unknown as ZipArchive;
    return { archive, bytes, calls };
}

let seq = 0;
async function romVfs(name: string, ramp: Ramp, size: number): Promise<VirtualFileSystem> {
    installFakeOpfs();
    const vfs = new VirtualFileSystem();
    vfs.mountRom(ramp.archive, "rom", new Map([romEntry(name, size)]));
    await vfs.initOverlay(`test:romwin${++seq}`);
    return vfs;
}

const ENTRY_SIZE = 4 * 1024 * 1024;

describe("§4.1 — a STORED-entry read run is served from one window", () => {
    test("N small sequential reads cross to the source once and hit the window N-1 times", async () => {
        const ramp = rampArchive(ENTRY_SIZE);
        const vfs = await romVfs("sounds.pak", ramp, ENTRY_SIZE);
        const h = vfs.openSync("C:\\sounds.pak", GENERIC_READ, OPEN_EXISTING)!;

        vfsIoCensus.reset();
        const N = 64, RECORD = 674;
        const got = new Uint8Array(N * RECORD);
        for (let i = 0; i < N; i++) {
            const d = vfs.readSync(h, RECORD)!;
            expect(d.length).toBe(RECORD);
            got.set(d, i * RECORD);
        }

        expect(ramp.calls.length).toBe(1);
        expect(vfsIoCensus.hitRomRangeSync).toBe(1);
        expect(vfsIoCensus.hitHandleWindow).toBe(N - 1);
        // The census tripwire: every byte-returning branch must name an arm.
        expect(vfsIoCensus.armUnattributed).toBe(0);
        expect(vfsIoCensus.reads).toBe(
            vfsIoCensus.hitHandleWindow + vfsIoCensus.hitRomCache + vfsIoCensus.hitRomRangeSync +
            vfsIoCensus.hitOverlaySync + vfsIoCensus.asyncFallbacks + vfsIoCensus.armUnattributed,
        );
        // Byte-identical to the un-windowed path.
        expect(Array.from(got)).toEqual(Array.from(ramp.bytes.subarray(0, N * RECORD)));
        expect(vfs.tell(h)).toBe(N * RECORD);
    });

    test("readIntoSync shares the same arm — the two ladders cannot drift", async () => {
        const ramp = rampArchive(ENTRY_SIZE);
        const vfs = await romVfs("objects.pak", ramp, ENTRY_SIZE);
        const h = vfs.openSync("C:\\objects.pak", GENERIC_READ, OPEN_EXISTING)!;

        const target = new Uint8Array(4096);
        for (let i = 0; i < 4; i++) {
            expect(vfs.readIntoSync(h, target, i * 1024, 1024)).toBe(1024);
        }
        expect(ramp.calls.length).toBe(1);
        expect(Array.from(target)).toEqual(Array.from(ramp.bytes.subarray(0, 4096)));
    });

    test("a handle that seeks around does not get widened reads", async () => {
        const ramp = rampArchive(ENTRY_SIZE);
        const vfs = await romVfs("textures.pak", ramp, ENTRY_SIZE);
        const h = vfs.openSync("C:\\textures.pak", GENERIC_READ, OPEN_EXISTING)!;

        vfs.readSync(h, 128);                    // first read of the handle: widened
        for (let i = 1; i <= 3; i++) {
            vfs.setPosition(h, i * 1_000_000, 0); // scattered — outside the window each time
            expect(vfs.readSync(h, 128)!.length).toBe(128);
        }
        for (const [, len] of ramp.calls.slice(1)) expect(len).toBe(128);
    });
});

describe("§4.1 — the window never over-reports", () => {
    test("a short source read yields only the bytes that came back", async () => {
        const SHORT = 300;
        const ramp = rampArchive(ENTRY_SIZE, { shortTo: SHORT });
        const vfs = await romVfs("level.pak", ramp, ENTRY_SIZE);
        const h = vfs.openSync("C:\\level.pak", GENERIC_READ, OPEN_EXISTING)!;

        const first = vfs.readSync(h, 674)!;
        expect(first.length).toBe(SHORT);
        expect(vfs.tell(h)).toBe(SHORT);
        expect(Array.from(first)).toEqual(Array.from(ramp.bytes.subarray(0, SHORT)));

        // Whatever the window holds, it must describe bytes that were actually read:
        // the next read continues exactly where the short one stopped.
        const second = vfs.readSync(h, 674)!;
        expect(Array.from(second)).toEqual(Array.from(ramp.bytes.subarray(SHORT, SHORT + second.length)));
    });

    test("readIntoSync does not report more than a short read delivered", async () => {
        const SHORT = 64;
        const ramp = rampArchive(ENTRY_SIZE, { shortTo: SHORT });
        const vfs = await romVfs("short.pak", ramp, ENTRY_SIZE);
        const h = vfs.openSync("C:\\short.pak", GENERIC_READ, OPEN_EXISTING)!;

        const target = new Uint8Array(1024).fill(0xcd);
        expect(vfs.readIntoSync(h, target, 0, 1024)).toBe(SHORT);
        expect(target[SHORT]).toBe(0xcd);      // nothing written past what was delivered
    });
});

describe("§4.1 — the window obeys the epoch", () => {
    test("a truncate on another handle invalidates the window this one installed", async () => {
        const ramp = rampArchive(ENTRY_SIZE);
        const vfs = await romVfs("cfg.pak", ramp, ENTRY_SIZE);
        const h = vfs.openSync("C:\\cfg.pak", GENERIC_READ, OPEN_EXISTING)!;

        vfs.readSync(h, 674);
        expect(h.buffer).toBeDefined();
        expect(ramp.calls.length).toBe(1);

        // CREATE_ALWAYS through a different handle bumps the window epoch.
        vfs.openSync("C:\\cfg.pak", 0x40000000, 2);

        // Back inside the window's extent: only the epoch can tell these bytes are dead.
        vfs.setPosition(h, 0, 0);
        const after = vfs.readSync(h, 674)!;
        expect(ramp.calls.length).toBe(2);     // re-read, not served from the stale window
        expect(Array.from(after)).toEqual(Array.from(ramp.bytes.subarray(0, 674)));
    });
});

/**
 * Phase-2 progressive prefetch may only spend what romCache can still HOLD. A budget
 * that starts at the full cap and charges nothing for entries already resident
 * over-commits, and the LRU then evicts exactly what phase-1 pinning fetched — work
 * done twice and kept never.
 */
describe("§4.1 — the progressive prefetch budget counts what is already resident", () => {
    const SIZE = 100;

    /** Entries the sync range path CANNOT serve, so they are prefetch candidates. */
    function nonSyncArchive(names: string[]): { archive: ZipArchive; fetched: string[] } {
        const fetched: string[] = [];
        const archive = {
            canRangeReadSync: () => false,
            readEntry: async (e: ZipEntry) => { fetched.push(e.name); return new Uint8Array(SIZE); },
            readEntryRange: async (_e: ZipEntry, _o: number, l: number) => new Uint8Array(l),
            readEntryRangeSync: () => null,
        } as unknown as ZipArchive;
        void names;
        return { archive, fetched };
    }

    test("bytes already in romCache are charged against the budget", async () => {
        installFakeOpfs();
        const names = ["a.dat", "b.dat", "c.dat", "d.dat"];
        const { archive, fetched } = nonSyncArchive(names);
        const vfs = new VirtualFileSystem();
        vfs.mountRom(archive, "rom", new Map(names.map((n) => romEntry(n, SIZE))));
        await vfs.initOverlay(`test:prefetchbudget${++seq}`);

        const priv = vfs as unknown as {
            ROM_CACHE_MAX_BYTES: number;
            romCache: { set(k: string, v: Uint8Array): boolean; byteSize: number; has(k: string): boolean };
        };
        priv.ROM_CACHE_MAX_BYTES = 4 * SIZE;
        // Phase 1 got there first and holds three quarters of the cache.
        priv.romCache.set("pinned.dat", new Uint8Array(3 * SIZE));

        vfs.startProgressivePrefetch();
        for (let i = 0; i < 40; i++) await new Promise<void>((r) => setTimeout(r, 0));

        // One entry fits in the quarter that is left; the rest must not be pulled.
        expect(fetched.length).toBe(1);
        expect(priv.romCache.has("pinned.dat")).toBe(true);
        expect(priv.romCache.byteSize).toBe(4 * SIZE);
    });
});
