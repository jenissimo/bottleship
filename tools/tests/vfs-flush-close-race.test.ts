/**
 * flushFile (CloseHandle) commits a path by draining the entry's buffered run and then
 * closing its WritableFileStream. Draining was a SNAPSHOT: it awaited whatever
 * flushInFlight held at that instant.
 *
 * A flush that starts during that await installs its own flushInFlight, and
 * flushWriteBuffer takes the buffer out of the entry in the same turn it is called — so
 * by the time flushFile resumes, those bytes are in neither place it looks. It reads an
 * empty memoryBuffer, concludes there is nothing left, and closes the stream the other
 * run is about to write into. The write lands in a closed stream and the bytes are gone,
 * with no error raised on any path the guest can see: a silent write loss.
 *
 * Reaching it needs a second writer on a path whose CloseHandle is in flight — two guest
 * threads sharing a log or config file, which is ordinary. It is NOT specific to a title,
 * and it predates the flush-reentrancy fix rather than following from it.
 *
 * The invariant: flushFile closes a stream only when the entry is QUIESCENT. The entry is
 * retired from writerCache first so the write paths cannot attach a new run to it, which
 * is what gives the drain an end. Driven at the seam, not by racing timers.
 */
import { describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive } from "@bottleship/formats/zip";
import { installFakeOpfs, findFakeByName } from "./fixtures/fake-opfs";

const GENERIC_WRITE = 0x40000000;
const CREATE_ALWAYS = 2;

let seq = 0;

interface WriterEntry {
    writer: unknown;
    queue: Promise<unknown>;
    memoryBuffer: Uint8Array;
    flushInFlight: Promise<void> | null;
}
interface OverlayInternals {
    writerCache: Map<string, WriterEntry>;
    flushWriteBuffer(entry: WriterEntry): Promise<void>;
    flushFile(path: string): Promise<void>;
}

async function overlayWithOpenWriter(name: string) {
    const root = installFakeOpfs();
    const vfs = new VirtualFileSystem();
    vfs.mountRom(null as unknown as ZipArchive, "rom", new Map());
    await vfs.initOverlay(`test:flushclose${++seq}`);
    const overlay = (vfs as unknown as { overlay: OverlayInternals }).overlay;
    const key = `c:\\${name}`.toLowerCase();

    const handle = vfs.openSync(`C:\\${name}`, GENERIC_WRITE, CREATE_ALWAYS)!;
    vfs.writeSync(handle, new Uint8Array([0xAA]));
    // Land one run so the entry owns an open WritableFileStream — the branch flushFile
    // finishes through, and the one a late run can be closed out from under.
    await overlay.flushWriteBuffer(overlay.writerCache.get(key)!);
    expect(overlay.writerCache.get(key)!.writer).toBeTruthy();

    return { root, vfs, overlay, key, handle };
}

describe("flushFile does not close a writer that still has a run in flight", () => {
    test("bytes buffered by a flush that starts during the drain still reach OPFS", async () => {
        const { root, vfs, overlay, key, handle } = await overlayWithOpenWriter("log.txt");

        // B: taken by a run we hold open mid-flight.
        vfs.writeSync(handle, new Uint8Array([0xBB]));
        const entry = overlay.writerCache.get(key)!;
        let release!: () => void;
        entry.queue = entry.queue.then(() => new Promise<void>(r => { release = r; }));
        const first = overlay.flushWriteBuffer(entry);
        void first.catch(() => {});

        // flushFile parks on that run.
        const closing = overlay.flushFile("C:\\log.txt");
        void closing.catch(() => {});
        await Promise.resolve();

        // C: a second writer's bytes, taken by a run that starts while flushFile is parked.
        vfs.writeSync(handle, new Uint8Array([0xCC]));
        const second = overlay.flushWriteBuffer(entry);
        void second.catch(() => {});

        release();
        await Promise.allSettled([first, second, closing]);
        await vfs.flushAll();

        const file = findFakeByName(root, "log.txt");
        expect(file).not.toBeNull();
        expect([...file!.data]).toEqual([0xAA, 0xBB, 0xCC]);
    });

    test("the ordinary close still commits and still retires the entry", async () => {
        const { root, vfs, overlay, key, handle } = await overlayWithOpenWriter("cfg.ini");
        vfs.writeSync(handle, new Uint8Array([0xBB]));
        await overlay.flushFile("C:\\cfg.ini");

        expect(overlay.writerCache.has(key)).toBe(false);
        const file = findFakeByName(root, "cfg.ini");
        expect([...file!.data]).toEqual([0xAA, 0xBB]);
    });
});
