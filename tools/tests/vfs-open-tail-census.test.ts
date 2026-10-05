/**
 * The re-open census (plan §11): `opens` per path, and the tail/payload split that
 * separates an archive reader's trailer hunt from the bytes it actually wanted.
 *
 * Both halves are asserted against a KNOWN read pattern rather than a plausible-looking
 * total, because the failure mode of a classifier is a believable number for the wrong
 * question: a tail test that only checked "tailReads > 0" would pass with the boundary
 * off by a megabyte, and an opens counter placed on the wrong side of the handle cache
 * would report the file count instead of the open count.
 */
import { describe, expect, test } from "bun:test";
import { VirtualFileSystem, vfsIoCensus } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive, ZipEntry } from "@bottleship/formats/zip";
import { installFakeOpfs } from "./fixtures/fake-opfs";

const GENERIC_READ = 0x80000000;
const OPEN_EXISTING = 3;
/** Must match VFS_TAIL_BYTES in vfs.ts — a ZIP reader's EOCD hunt window. */
const TAIL = 0x10000;
const SIZE = 8 * 1024 * 1024;

function archive(size: number): ZipArchive {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 7) & 0xff;
    return {
        readEntryRangeSync: (_e: ZipEntry, off: number, len: number) =>
            bytes.subarray(off, Math.min(size, off + len)),
        readEntryRange: async (_e: ZipEntry, off: number, len: number) =>
            bytes.subarray(off, Math.min(size, off + len)),
        readEntry: async () => bytes,
    } as unknown as ZipArchive;
}

let seq = 0;
async function romVfs(name: string): Promise<VirtualFileSystem> {
    installFakeOpfs();
    const vfs = new VirtualFileSystem();
    const entry: ZipEntry = {
        name, compressedSize: SIZE, uncompressedSize: SIZE, compression: 0,
        localHeaderOffset: 0, isDirectory: false,
    };
    vfs.mountRom(archive(SIZE), "rom", new Map([[name, entry]]));
    await vfs.initOverlay(`test:opencensus${++seq}`);
    return vfs;
}

function stat(vfs: VirtualFileSystem, path: string) {
    return vfsIoCensus.perPath.get(path)!;
}

describe("§11 — the re-open census", () => {
    test("opens counts handles, not files: N opens of one path read N", async () => {
        const vfs = await romVfs("data.pak");
        vfsIoCensus.reset();
        for (let i = 0; i < 7; i++) {
            const h = vfs.openSync("C:\\data.pak", GENERIC_READ, OPEN_EXISTING)!;
            vfs.readSync(h, 64);
        }
        expect(vfsIoCensus.opens).toBe(7);
        expect(stat(vfs, "C:\\data.pak").opens).toBe(7);
        expect(stat(vfs, "C:\\data.pak").reads).toBe(7);
    });

    test("the trailer hunt is separated from the payload at the exact boundary", async () => {
        const vfs = await romVfs("split.pak");
        const h = vfs.openSync("C:\\split.pak", GENERIC_READ, OPEN_EXISTING)!;
        vfsIoCensus.reset();

        // One byte inside the window is tail; one byte outside it is payload. A
        // classifier off by any amount fails one of these two.
        vfs.setPosition(h, SIZE - TAIL, 0);
        vfs.readSync(h, 16);
        vfs.setPosition(h, SIZE - TAIL - 1, 0);
        vfs.readSync(h, 16);
        vfs.setPosition(h, 0, 0);
        vfs.readSync(h, 16);

        const s = stat(vfs, "C:\\split.pak");
        expect(s.reads).toBe(3);
        expect(s.tailReads).toBe(1);
        expect(s.tailBytes).toBe(16);
        expect(s.size).toBe(SIZE);
        expect(vfsIoCensus.tailUnsized).toBe(0);
    });

    test("a path whose size never resolves is counted unclassified, not as payload", async () => {
        const vfs = await romVfs("stale.pak");
        const h = vfs.openSync("C:\\stale.pak", GENERIC_READ, OPEN_EXISTING)!;
        vfsIoCensus.reset();
        vfs.readSync(h, 16);
        const s = stat(vfs, "C:\\stale.pak");
        expect(s.size).toBe(SIZE);

        // A path the sizer cannot answer for stays at -1 and must land in tailUnsized —
        // the report's own warning that its tail split is a lower bound. Without this
        // branch such a read would be silently filed as payload and the split would read
        // as a clean answer to a question it never asked.
        s.size = -1;
        (vfs as unknown as { getFileSize(p: string): number }).getFileSize = () => 0;
        vfs.setPosition(h, SIZE - 16, 0);
        vfs.readSync(h, 16);
        expect(s.size).toBe(-1);
        expect(s.tailReads).toBe(0);   // NOT credited to either side
        expect(vfsIoCensus.tailUnsized).toBe(1);
    });
});
