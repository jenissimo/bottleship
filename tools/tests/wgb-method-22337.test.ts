import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRomIndex, WgbLoader } from "../../src/worker/runtime/filesystem/wgb-loader";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";

const fixtures = join(import.meta.dir, "fixtures/wgb-method-22337");
const name = "rom/sample.wav";

function load(file: string) {
    return WgbLoader.fromBuffer(new Uint8Array(readFileSync(join(fixtures, file))));
}

test("method 22337 mounts and serves identical WAV bytes to STORE", async () => {
    const stored = await load("store.wgb");
    const packed = await load("vorbis.wgb");
    const reference = stored.archive.getEntry(name)!;
    const audio = packed.archive.getEntry(name)!;
    expect(reference.compression).toBe(0);
    expect(audio.compression).toBe(22337);

    const vfs = new VirtualFileSystem();
    vfs.mountRom(packed.archive, "rom", buildRomIndex(packed.archive, "rom"));
    const expected = await stored.archive.readEntry(reference);
    const file = vfs.openSync("C:\\sample.wav", 0x80000000, 3)!;
    expect(vfs.getFileSize("C:\\sample.wav")).toBe(expected.length);
    expect(vfs.readSync(file, 44)).toEqual(expected.subarray(0, 44));

    const ranges = [[43, 1], [4093, 4110], [15003, 6109], [expected.length - 48, 64]];
    const concurrent = await Promise.all(ranges.map(([offset, length]) =>
        packed.archive.readEntryRange(audio, offset, length)));
    for (const [i, [offset, length]] of ranges.entries()) {
        const bytes = expected.subarray(offset, offset + length);
        expect(concurrent[i]).toEqual(bytes);
        vfs.setPosition(file, offset, 0);
        expect(vfs.readSync(file, length)).toEqual(bytes);
    }
    expect(await packed.archive.readEntry(audio)).toEqual(expected);
});

test("the loader rejects a damaged audio index", async () => {
    const packed = new Uint8Array(readFileSync(join(fixtures, "vorbis.wgb")));
    const index = Buffer.from(packed.buffer).indexOf("WGBA");
    expect(index).toBeGreaterThan(0);
    packed[index + 16] ^= 1;
    await expect(WgbLoader.fromBuffer(packed)).rejects.toThrow(/audio-index.*damaged.*CRC mismatch/);
});
