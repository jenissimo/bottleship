/**
 * Regressions for the overlay write-buffer defects (F6, F7).
 *
 * Both are silent DATA LOSS: a buffered run of guest writes is dropped because the code
 * assumed flushWriteBuffer swaps `memoryBuffer` out synchronously (only true when no
 * flush was already in flight), or because a post-await assignment clobbered bytes
 * appended during the await. Both are driven here with a controllable promise — a gate
 * the test resolves by hand — so the interleaving is exact rather than hoped for.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive } from "@bottleship/formats/zip";
import { installFakeOpfs, findFakeByName, type FakeDirHandle } from "./fixtures/fake-opfs";

const GENERIC_WRITE = 0x40000000;
const CREATE_ALWAYS = 2;

const origNavigator = (globalThis as unknown as { navigator: unknown }).navigator;
afterAll(() => { (globalThis as unknown as { navigator: unknown }).navigator = origNavigator; });

let seq = 0;
async function freshVfs(): Promise<{ vfs: VirtualFileSystem; root: FakeDirHandle; gameId: string }> {
    const root = installFakeOpfs();
    const vfs = new VirtualFileSystem();
    vfs.mountRom(null as unknown as ZipArchive, "rom", new Map());
    const gameId = `test:wb${++seq}`;
    await vfs.initOverlay(gameId);
    return { vfs, root, gameId };
}

/** Reach into the live overlay's writer entry for this path. */
function writerEntry(vfs: VirtualFileSystem, path: string): {
    memoryBuffer: Uint8Array;
    bufferOffset: number;
    flushInFlight: Promise<void> | null;
} | undefined {
    const overlay = (vfs as unknown as { overlay: { writerCache: Map<string, never> } }).overlay;
    return (overlay.writerCache as unknown as Map<string, {
        memoryBuffer: Uint8Array; bufferOffset: number; flushInFlight: Promise<void> | null;
    }>).get(path.toLowerCase());
}

describe("F6 — writeFileSync does not drop a buffered run behind an in-flight flush", () => {
    test("a scattered write while a flush is in flight keeps the earlier run", async () => {
        const { vfs, root } = await freshVfs();
        const h = vfs.openSync("C:\\out.bin", GENERIC_WRITE, CREATE_ALWAYS)!;

        // Run A at offset 0. It is the buffered run that used to be dropped.
        vfs.writeSync(h, new Uint8Array([0xa1, 0xa2, 0xa3, 0xa4]));

        const entry = writerEntry(vfs, "C:\\out.bin")!;
        expect(entry.memoryBuffer.length).toBe(4);

        // Put a flush "in flight" — the state in which the old code's early return left
        // memoryBuffer in place, so the non-sequential write below overwrote it.
        let openGate!: () => void;
        entry.flushInFlight = new Promise<void>((r) => { openGate = () => r(); });

        // Run B at a far offset: non-sequential, so writeFileSync pre-flushes A.
        vfs.setPosition(h, 4096, 0);
        vfs.writeSync(h, new Uint8Array([0xb1, 0xb2]));

        openGate();
        await vfs.flushAll();

        const fake = findFakeByName(root, "out.bin");
        expect(fake).not.toBeNull();
        // Both runs must have reached the file.
        expect(Array.from(fake!.data.subarray(0, 4))).toEqual([0xa1, 0xa2, 0xa3, 0xa4]);
        expect(Array.from(fake!.data.subarray(4096, 4098))).toEqual([0xb1, 0xb2]);
    });

    test("the timer-driven flush path keeps a run written while it is committing", async () => {
        const { vfs, root } = await freshVfs();
        const h = vfs.openSync("C:\\timer.bin", GENERIC_WRITE, CREATE_ALWAYS)!;

        vfs.writeSync(h, new Uint8Array([1, 2, 3, 4]));
        const entry = writerEntry(vfs, "C:\\timer.bin")!;

        // The 50ms buffer timer fires and starts committing...
        const committing = (vfs as unknown as {
            overlay: { flushWriteBuffer(e: unknown): Promise<void> };
        }).overlay.flushWriteBuffer(entry);
        // ...and the guest keeps writing, sequentially, while it runs.
        vfs.writeSync(h, new Uint8Array([5, 6]));
        await committing;
        await vfs.flushAll();

        const fake = findFakeByName(root, "timer.bin");
        expect(Array.from(fake!.data.subarray(0, 6))).toEqual([1, 2, 3, 4, 5, 6]);
    });
});

describe("F7 — writeFile does not clear bytes appended during its awaits", () => {
    test("a sync write landing during an async write's awaits survives", async () => {
        const { vfs, root } = await freshVfs();
        const h = vfs.openSync("C:\\mixed.bin", GENERIC_WRITE, CREATE_ALWAYS)!;

        // A large async write (past the 256KB buffer threshold) takes the writer path
        // whose awaits used to be followed by `memoryBuffer = new Uint8Array(0)`.
        const big = new Uint8Array(300 * 1024).fill(0x77);
        const writing = vfs.write(h, big);

        // While it is in flight, a small sequential write is buffered.
        const tail = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
        vfs.setPosition(h, big.length, 0);
        vfs.writeSync(h, tail);

        await writing;
        await vfs.flushAll();

        const fake = findFakeByName(root, "mixed.bin");
        expect(fake).not.toBeNull();
        expect(fake!.data.length).toBe(big.length + tail.length);
        expect(Array.from(fake!.data.subarray(big.length))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    });
});
