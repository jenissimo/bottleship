/**
 * An overlay file's sync access handle is warmed at OPEN, not at first read (perf plan
 * §4.2). Opening it is async, so a first read that finds none has to park the guest
 * thread — and the CRT's fopen/_open have no async escape at all.
 */
import { describe, expect, test } from "bun:test";
import { VirtualFileSystem, vfsIoCensus } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive } from "@bottleship/formats/zip";
import { installFakeOpfs, type FakeDirHandle, type FakeFileHandle } from "./fixtures/fake-opfs";

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;
const CREATE_ALWAYS = 2;

let seq = 0;

/** Lay a file down, then re-open the same OPFS as a fresh session — the in-memory
 *  content cache is empty there, so a read can only be served off a sync handle. */
async function seedAndRelaunch(name: string, payload: Uint8Array): Promise<{ vfs: VirtualFileSystem; gameId: string; root: FakeDirHandle }> {
    const gameId = `test:warm${++seq}`;
    const root = installFakeOpfs();
    const writer = new VirtualFileSystem();
    writer.mountRom(null as unknown as ZipArchive, "rom", new Map());
    await writer.initOverlay(gameId);
    const w = writer.openSync(`C:\\${name}`, GENERIC_WRITE, CREATE_ALWAYS)!;
    writer.writeSync(w, payload);
    await writer.flushAll();

    const vfs = new VirtualFileSystem();
    vfs.mountRom(null as unknown as ZipArchive, "rom", new Map());
    await vfs.initOverlay(gameId);
    await vfs.ensureOverlayIndex();
    return { vfs, gameId, root };
}

/** The overlay's FileSystemFileHandle for `name`, wherever the container hash put it. */
function findHandle(dir: FakeDirHandle, name: string): FakeFileHandle | null {
    for (const [childName, child] of dir.children) {
        if (child.kind === "file") {
            if (childName === name) return child;
        } else {
            const hit = findHandle(child, name);
            if (hit) return hit;
        }
    }
    return null;
}

function noModificationAllowed(): Error {
    const e = new Error("locked");
    (e as unknown as { name: string }).name = "NoModificationAllowedError";
    return e;
}

/**
 * OPFS's exclusive lock, which the fake does not model: a sync access handle and a
 * writable stream cannot coexist, and the lock is taken by the OPEN, not by its
 * resolution — so a writer racing an in-flight warm is refused too.
 */
function modelExclusiveLock(handle: FakeFileHandle, openDelayMs: number): void {
    let locked = 0;
    const createSync = handle.createSyncAccessHandle.bind(handle);
    const createWritable = handle.createWritable.bind(handle);
    handle.createSyncAccessHandle = async () => {
        locked++;
        await new Promise<void>((r) => setTimeout(r, openDelayMs));
        const sah = await createSync();
        const close = sah.close.bind(sah);
        sah.close = () => { locked--; close(); };
        return sah;
    };
    handle.createWritable = async (opts?: { keepExistingData?: boolean }) => {
        if (locked > 0) throw noModificationAllowed();
        return createWritable(opts);
    };
}

/** Let the fire-and-forget warm settle. It is deliberately un-awaited in production;
 *  a test that raced it would be asserting the scheduler, not the mechanism. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("§4.2 — the first read of an overlay file does not park", () => {
    test("a read-intent open warms the sync handle, so readSync answers", async () => {
        const payload = new Uint8Array(256);
        for (let i = 0; i < payload.length; i++) payload[i] = i;
        const { vfs } = await seedAndRelaunch("save.dat", payload);

        const h = vfs.openSync("C:\\save.dat", GENERIC_READ, OPEN_EXISTING)!;
        await settle();

        const got = vfs.readSync(h, 256);
        expect(got).not.toBeNull();
        expect(Array.from(got!)).toEqual(Array.from(payload));
    });

    test("a write-only open takes no read handle", async () => {
        const { vfs } = await seedAndRelaunch("log.txt", new Uint8Array([1, 2, 3, 4]));

        const h = vfs.openSync("C:\\log.txt", GENERIC_WRITE, OPEN_EXISTING)!;
        await settle();

        // Nothing was warmed for it, so the sync ladder still has no answer.
        expect(vfs.readSync(h, 4)).toBeNull();
    });

    // The sync access handle is an EXCLUSIVE lock. An "r+b" fopen is
    // GENERIC_READ|GENERIC_WRITE, so warming on the read bit alone locks a file whose
    // first write then has to break the lock — and the break races the open.
    test("a read/write open takes no read handle: the writer would only have to break it", async () => {
        const { vfs } = await seedAndRelaunch("cfg.dat", new Uint8Array([9, 8, 7, 6]));
        vfsIoCensus.reset();

        const h = vfs.openSync("C:\\cfg.dat", GENERIC_READ | GENERIC_WRITE, OPEN_EXISTING)!;
        await settle();

        expect(vfsIoCensus.warmAttempted).toBe(0);
        expect(vfs.readSync(h, 4)).toBeNull();
    });

    test("a write racing an in-flight warm still commits the guest's bytes", async () => {
        const { vfs, root } = await seedAndRelaunch("save.bin", new Uint8Array([1, 1, 1, 1]));
        modelExclusiveLock(findHandle(root, "save.bin")!, 25);

        // Read-only open → warm in flight (25 ms) and holding the lock.
        vfs.openSync("C:\\save.bin", GENERIC_READ, OPEN_EXISTING);

        // Past WRITE_BUFFER_THRESHOLD, so this goes straight at the writable stream: no
        // write buffer to fall back on, and a lock conflict that gives up here is the
        // guest's bytes gone.
        const payload = new Uint8Array(300 * 1024);
        payload.fill(0x5a);
        const w = vfs.openSync("C:\\save.bin", GENERIC_WRITE, OPEN_EXISTING)!;
        expect(await vfs.write(w, payload)).toBe(payload.length);
        await vfs.flushAll();

        // Re-open as a fresh session: only the committed bytes survive that.
        const vfs2 = new VirtualFileSystem();
        vfs2.mountRom(null as unknown as ZipArchive, "rom", new Map());
        await vfs2.initOverlay((vfs as unknown as { overlayGameId: string }).overlayGameId);
        await vfs2.ensureOverlayIndex();
        const r = vfs2.openSync("C:\\save.bin", GENERIC_READ, OPEN_EXISTING)!;
        expect(Array.from(await vfs2.read(r, 4))).toEqual([0x5a, 0x5a, 0x5a, 0x5a]);
    });

    // "Never ran" and "ran and did nothing" are different answers, and a warm that exits
    // without counting makes attempted+skipped* stop reconciling with the opens that
    // reached it — the census then cannot say why a file was never warmed.
    test("every prewarm exit is counted", async () => {
        const { vfs } = await seedAndRelaunch("world.dat", new Uint8Array([2, 2]));
        vfs.openSync("C:\\world.dat", GENERIC_READ, OPEN_EXISTING);
        await settle();

        vfsIoCensus.reset();
        // Already holds a handle from the warm above.
        vfs.openSync("C:\\world.dat", GENERIC_READ, OPEN_EXISTING);
        // Ephemeral by policy (*.log) — never worth a lock.
        vfs.openSync("C:\\trace.log", GENERIC_WRITE, 2 /* CREATE_ALWAYS */);
        vfs.openSync("C:\\trace.log", GENERIC_READ, OPEN_EXISTING);
        await settle();

        expect(vfsIoCensus.warmSkippedHandle).toBe(1);
        expect(vfsIoCensus.warmSkippedEphemeral).toBe(1);
        expect(vfsIoCensus.warmAttempted).toBe(0);
    });

    // The in-flight dedup shares ONE open per path. A speculative warm opens with
    // create=false, so a demand caller entitled to create the file must not inherit its
    // "no such file" null.
    test("a create=true caller does not inherit a create=false open's refusal", async () => {
        const { vfs } = await seedAndRelaunch("anchor.dat", new Uint8Array([3]));
        const overlay = (vfs as unknown as { overlay: { ensureSyncHandle(p: string, c?: boolean, s?: boolean): Promise<unknown> } }).overlay;

        const missing = "C:\\fresh\\new.dat";
        const speculative = overlay.ensureSyncHandle(missing, false, false);
        const demand = overlay.ensureSyncHandle(missing, true, false);

        expect(await speculative).toBeNull();
        expect(await demand).not.toBeNull();
    });

    test("warming never displaces a handle a real read established", async () => {
        // More files than MAX_SYNC_HANDLES, all opened for read: the speculative warms
        // must fill spare capacity and then stop, rather than evicting each other and
        // the handle the first file is still being read through.
        const gameId = `test:warmcap${++seq}`;
        installFakeOpfs();
        const writer = new VirtualFileSystem();
        writer.mountRom(null as unknown as ZipArchive, "rom", new Map());
        await writer.initOverlay(gameId);
        for (let i = 0; i < 48; i++) {
            const w = writer.openSync(`C:\\f${i}.dat`, GENERIC_WRITE, CREATE_ALWAYS)!;
            writer.writeSync(w, new Uint8Array([i, i, i, i]));
        }
        await writer.flushAll();

        const vfs = new VirtualFileSystem();
        vfs.mountRom(null as unknown as ZipArchive, "rom", new Map());
        await vfs.initOverlay(gameId);
        await vfs.ensureOverlayIndex();

        const first = vfs.openSync("C:\\f0.dat", GENERIC_READ, OPEN_EXISTING)!;
        await settle();
        expect(Array.from(vfs.readSync(first, 4)!)).toEqual([0, 0, 0, 0]);

        // One at a time: a burst of concurrent warms would all pass the capacity check
        // before any of them landed, and the test would be asserting the scheduler.
        for (let i = 1; i < 48; i++) {
            vfs.openSync(`C:\\f${i}.dat`, GENERIC_READ, OPEN_EXISTING);
            await settle();
        }

        // f0 is still readable synchronously: no warm took its handle away.
        vfs.setPosition(first, 0, 0);
        expect(Array.from(vfs.readSync(first, 4)!)).toEqual([0, 0, 0, 0]);
    });
});
