/**
 * Regressions for the read-window / cursor defects (F2, F3, F5, F9, F11, F12, F13).
 *
 * The await-class cases are driven with a controllable promise — a gate the test resolves
 * by hand — rather than by hoping the scheduler interleaves. A race that reproduces once
 * in a hundred runs is not a regression test.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { VirtualFileSystem, type VfsFileHandle } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive, ZipEntry } from "@bottleship/formats/zip";
import { installFakeOpfs, findFakeByName, type FakeDirHandle } from "./fixtures/fake-opfs";

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;
const CREATE_ALWAYS = 2;

function romEntry(name: string, size: number): [string, ZipEntry] {
    return [
        name,
        { name, compressedSize: size, uncompressedSize: size, compression: 0, localHeaderOffset: 0, isDirectory: false },
    ];
}

/** ZipArchive stand-in over a known byte ramp. */
function rampArchive(size: number, opts: { sync?: boolean } = {}): { archive: ZipArchive; bytes: Uint8Array } {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = i & 0xff;
    const archive = {
        readEntryRangeSync: (_e: ZipEntry, off: number, len: number) =>
            opts.sync === false ? null : bytes.subarray(off, Math.min(size, off + len)),
        readEntryRange: async (_e: ZipEntry, off: number, len: number) =>
            bytes.subarray(off, Math.min(size, off + len)),
        readEntry: async () => bytes,
    } as unknown as ZipArchive;
    return { archive, bytes };
}

const origNavigator = (globalThis as unknown as { navigator: unknown }).navigator;
afterAll(() => { (globalThis as unknown as { navigator: unknown }).navigator = origNavigator; });

let seq = 0;
async function freshVfs(
    rom: Array<[string, ZipEntry]> = [],
    archive?: ZipArchive,
): Promise<{ vfs: VirtualFileSystem; root: FakeDirHandle }> {
    const root = installFakeOpfs();
    const vfs = new VirtualFileSystem();
    vfs.mountRom(archive ?? (null as unknown as ZipArchive), "rom", new Map(rom));
    await vfs.initOverlay(`test:${++seq}`);
    return { vfs, root };
}

/** Re-open an existing OPFS root as a new session: the in-memory content cache is empty,
 *  so reads go through the async path — which is what installs a read WINDOW. */
async function relaunch(gameId: string, rom: Array<[string, ZipEntry]> = [], archive?: ZipArchive): Promise<VirtualFileSystem> {
    const vfs = new VirtualFileSystem();
    vfs.mountRom(archive ?? (null as unknown as ZipArchive), "rom", new Map(rom));
    await vfs.initOverlay(gameId);
    await vfs.ensureOverlayIndex();
    return vfs;
}

/** Read through the async path and ASSERT a window was installed — the window is the
 *  precondition every test below is about, so a setup that silently stops installing one
 *  must fail loudly rather than pass vacuously. */
async function readWithWindow(vfs: VirtualFileSystem, h: VfsFileHandle, len: number): Promise<Uint8Array> {
    const data = await vfs.read(h, len);
    expect(h.buffer).toBeDefined();
    return data;
}

/** Lay a file down in a fresh overlay and hand back the game id to relaunch against. */
async function seedFile(name: string, bytes: number[]): Promise<string> {
    const gameId = `test:seed${++seq}`;
    installFakeOpfs();
    const writer = new VirtualFileSystem();
    writer.mountRom(null as unknown as ZipArchive, "rom", new Map());
    await writer.initOverlay(gameId);
    const w = writer.openSync(`C:\\${name}`, GENERIC_WRITE, CREATE_ALWAYS)!;
    writer.writeSync(w, new Uint8Array(bytes));
    await writer.flushAll();
    return gameId;
}

describe("F3 — writeSync invalidates the read window", () => {
    test("read-after-write on one handle sees the written bytes, not the pre-write ones", async () => {
        const gameId = await seedFile("save.dat", [1, 1, 1, 1, 1, 1, 1, 1]);
        const vfs = await relaunch(gameId);

        // fopen("r+b") → fread (installs a window) → fseek(0) → fwrite → fseek(0) → fread
        const h = vfs.openSync("C:\\save.dat", GENERIC_READ | GENERIC_WRITE, OPEN_EXISTING)! as VfsFileHandle;
        expect(Array.from(await readWithWindow(vfs, h, 8))).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);

        vfs.setPosition(h, 0, 0);
        vfs.writeSync(h, new Uint8Array([9, 9]));
        vfs.setPosition(h, 0, 0);

        const after = await vfs.read(h, 8);
        expect(Array.from(after.subarray(0, 2))).toEqual([9, 9]);
    });

    test("a ROM-backed handle promoted to overlay stops serving the ROM entry", async () => {
        const { archive } = rampArchive(8, { sync: false }); // force the window-installing path
        const { vfs } = await freshVfs([romEntry("cfg.txt", 8)], archive);

        const h = vfs.openSync("C:\\cfg.txt", GENERIC_READ | GENERIC_WRITE, OPEN_EXISTING)! as VfsFileHandle;
        expect(Array.from(await readWithWindow(vfs, h, 8))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

        vfs.setPosition(h, 0, 0);
        vfs.writeSync(h, new Uint8Array([0xaa, 0xbb]));
        vfs.setPosition(h, 0, 0);

        const after = await vfs.read(h, 2);
        expect(Array.from(after)).toEqual([0xaa, 0xbb]);
    });
});

describe("F12 — truncation reaches windows on handles the VFS cannot see", () => {
    test("SetEndOfFile invalidates another cursor's window instead of serving dead bytes", async () => {
        const gameId = await seedFile("log.bin", [1, 2, 3, 4, 5, 6, 7, 8]);
        const vfs = await relaunch(gameId);

        // A reader takes a window over all 8 bytes...
        const reader = vfs.openSync("C:\\log.bin", GENERIC_READ, OPEN_EXISTING)! as VfsFileHandle;
        expect((await readWithWindow(vfs, reader, 8)).length).toBe(8);

        // ...and a DIFFERENT handle truncates the file underneath it.
        await vfs.truncateAt("C:\\log.bin", 2);
        expect(vfs.getFileSize("C:\\log.bin")).toBe(2);

        vfs.setPosition(reader, 0, 0);
        const after = vfs.readSync(reader, 8) ?? await vfs.read(reader, 8);
        expect(after.length).toBeLessThanOrEqual(2);
    });

    test("a window taken before a re-create does not survive it", async () => {
        const gameId = await seedFile("cfg.ini", [0x41, 0x41, 0x41, 0x41]);
        const vfs = await relaunch(gameId);

        const reader = vfs.openSync("C:\\cfg.ini", GENERIC_READ, OPEN_EXISTING)! as VfsFileHandle;
        expect((await readWithWindow(vfs, reader, 4)).length).toBe(4);

        // CREATE_ALWAYS over the same path: the old contents are gone.
        const recreate = vfs.openSync("C:\\cfg.ini", GENERIC_WRITE, CREATE_ALWAYS)!;
        vfs.writeSync(recreate, new Uint8Array([0x5a]));

        vfs.setPosition(reader, 0, 0);
        const after = vfs.readSync(reader, 4) ?? await vfs.read(reader, 4);
        expect(after[0]).not.toBe(0x41);
    });
});

describe("F5 — a prefetch completing across a yield is not installed under a foreign offset", () => {
    test("an abandoned prefetch's bytes are never served as the window", async () => {
        const { archive } = rampArchive(4 * 1024 * 1024, { sync: false });
        const { vfs } = await freshVfs([romEntry("big.dat", 4 * 1024 * 1024)], archive);

        // Hand-controlled prefetch: the read parks on this gate, and only while it is
        // parked does the handle acquire a DIFFERENT prefetch offset — the exact
        // interleaving F5 describes (guard checked before the yield, install after it).
        let release!: (v: Uint8Array) => void;
        const gated = new Promise<Uint8Array>((r) => { release = r; });

        const h = vfs.openSync("C:\\big.dat", GENERIC_READ, OPEN_EXISTING)! as VfsFileHandle;
        h.prefetchPromise = gated;
        h.prefetchOffset = 0; // these bytes belong to offset 0

        const reading = vfs.read(h, 32);
        queueMicrotask(() => {
            // A concurrent completion seeks and arms a NEW prefetch for a new offset...
            vfs.setPosition(h, 4096, 0);
            h.prefetchPromise = Promise.resolve(new Uint8Array(64).fill(0x11));
            h.prefetchOffset = 4096;
            // ...and only then does the ORIGINAL prefetch (for offset 0) land.
            release(new Uint8Array(64).fill(0xee));
        });

        const data = await reading;
        // Serving offset-0 bytes under offset 4096 is the defect. The ramp byte at 4096
        // is 0x00; the fabricated filler is 0xEE.
        expect(data.length).toBeGreaterThan(0);
        expect(data.every((b) => b !== 0xee)).toBe(true);
        expect(data[0]).toBe(4096 & 0xff);
    });
});

describe("F2 — a duplicated cursor is independent of the guest's", () => {
    test("reading through a view handle across an await leaves the guest's position alone", async () => {
        const { archive } = rampArchive(1024, { sync: false });
        const { vfs } = await freshVfs([romEntry("map.dat", 1024)], archive);

        const guest = vfs.openSync("C:\\map.dat", GENERIC_READ, OPEN_EXISTING)!;
        vfs.setPosition(guest, 700, 0);

        // What MapViewOfFile does now: its own cursor at the mapping offset.
        const view = vfs.duplicateHandle(guest, 0);
        const reading = vfs.read(view, 256);

        // The guest legitimately seeks while the view read is in flight.
        vfs.setPosition(guest, 12, 0);
        const data = await reading;

        expect(data.length).toBeGreaterThan(0);
        expect(data[0]).toBe(0);              // the view read from the mapping offset
        expect(vfs.tell(guest)).toBe(12);     // ...and did not touch (or restore) the guest cursor
    });

    test("the mapped-view paths do not snapshot/restore the guest cursor", async () => {
        // The property above is only enforced if kernel32 actually takes its own cursor.
        // validate-file-cursor.ts cannot see this — file-io.ts is a declared owner — so
        // assert the absence of the save/restore pattern directly.
        const src = await Bun.file(
            new URL("../../src/worker/modules/kernel32/file-io.ts", import.meta.url),
        ).text();
        expect(src).not.toContain("originalPos");
        expect(src).toContain("vfs.duplicateHandle(");
    });
});

describe("F9 — a short OPFS sync read is not an EOF", () => {
    test("a dribbling access handle still yields the whole file", async () => {
        const gameId = "test:short-read";
        const root = installFakeOpfs();

        const writer = new VirtualFileSystem();
        writer.mountRom(null as unknown as ZipArchive, "rom", new Map());
        await writer.initOverlay(gameId);
        const w = writer.openSync("C:\\data.bin", GENERIC_WRITE, CREATE_ALWAYS)!;
        const payload = new Uint8Array(64);
        for (let i = 0; i < payload.length; i++) payload[i] = i + 1;
        writer.writeSync(w, payload);
        await writer.flushAll();

        const fake = findFakeByName(root, "data.bin");
        expect(fake).not.toBeNull();
        expect(fake!.data.length).toBe(64);
        fake!.shortReadLimit = 7; // never more than 7 bytes per read() call

        // Relaunch: a fresh VFS over the same OPFS, so reads go through a sync access
        // handle rather than the in-session content cache.
        const reader = new VirtualFileSystem();
        reader.mountRom(null as unknown as ZipArchive, "rom", new Map());
        await reader.initOverlay(gameId);
        await reader.ensureOverlayIndex();

        const h = reader.openSync("C:\\data.bin", GENERIC_READ, OPEN_EXISTING)!;
        const got = await reader.read(h, 64);
        expect(got.length).toBe(64);
        expect(Array.from(got.subarray(60))).toEqual([61, 62, 63, 64]);
    });
});

describe("F11 — the ROM underlay only covers bytes past the overlay's EOF", () => {
    test("a short overlay read is not patched with pre-write ROM bytes", async () => {
        const gameId = "test:underlay";
        const root = installFakeOpfs();
        const { archive } = rampArchive(64); // ROM: 0,1,2,... — the PRE-write content

        const writer = new VirtualFileSystem();
        writer.mountRom(archive, "rom", new Map([romEntry("world.pak", 64)]));
        await writer.initOverlay(gameId);
        // Partially overwrite (never truncate) so the ROM underlay stays live for the tail.
        const w = writer.openSync("C:\\world.pak", GENERIC_WRITE, OPEN_EXISTING)!;
        writer.writeSync(w, new Uint8Array(32).fill(0xcc));
        await writer.flushAll();

        const fake = findFakeByName(root, "world.pak");
        expect(fake).not.toBeNull();
        expect(fake!.data.length).toBe(32);
        // The index says 32 bytes; the access handle stops producing at 16 (a partial
        // commit). Looping cannot recover the rest — this is a genuine short read.
        fake!.readableUntil = 16;

        const reader = new VirtualFileSystem();
        reader.mountRom(archive, "rom", new Map([romEntry("world.pak", 64)]));
        await reader.initOverlay(gameId);
        await reader.ensureOverlayIndex();

        const h = reader.openSync("C:\\world.pak", GENERIC_READ, OPEN_EXISTING)!;
        const got = await reader.read(h, 32);

        // Every byte returned from inside the overlay's own extent must be overlay bytes.
        // Filling a short overlay read from ROM would put the pre-write ramp back in the
        // middle of a region the guest already overwrote.
        expect(got.length).toBeGreaterThan(0);
        expect(got.length).toBeLessThanOrEqual(16);
        expect(got.every((b) => b === 0xcc)).toBe(true);
    });
});

describe("F13 — 4 KiB alignment survives past 2 GiB", () => {
    test("fetchRange rounds down, and does not wrap to a negative offset", async () => {
        const size = 3 * 1024 * 1024 * 1024;              // 3 GiB entry
        const offset = 2 * 1024 * 1024 * 1024 + 8192 + 100; // past the int32 boundary, unaligned
        let sawStart = Number.NaN;
        const archive = {
            readEntryRangeSync: () => null,
            readEntryRange: async (_e: ZipEntry, off: number, len: number) => {
                // First call only — the read schedules a prefetch behind it.
                if (Number.isNaN(sawStart)) sawStart = off;
                return new Uint8Array(Math.min(len, 4096)).fill(7);
            },
            readEntry: async () => new Uint8Array(0),
        } as unknown as ZipArchive;

        const { vfs } = await freshVfs([romEntry("huge.pak", size)], archive);
        const h = vfs.openSync("C:\\huge.pak", GENERIC_READ, OPEN_EXISTING)!;
        vfs.setPosition(h, offset, 0);
        await vfs.read(h, 256);

        expect(sawStart).toBe(2 * 1024 * 1024 * 1024 + 8192);
    });
});
