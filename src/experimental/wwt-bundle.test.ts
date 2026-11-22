import { expect, test } from "bun:test";
import { buildZip } from "../../packages/formats/src/wgb/zip-build";
import { readWwtBundle, splitGuestArgs } from "./wwt-bundle";

test("legacy WGB uses backslashes in ZIP entries and slashes in the manifest", async () => {
    const exe = new Uint8Array(96);
    const header = new DataView(exe.buffer);
    header.setUint16(0, 0x5a4d, true);
    header.setUint32(0x3c, 64, true);
    header.setUint32(64, 0x4550, true);
    header.setUint16(68, 0x14c, true);
    const manifest = { formatVersion: 1, entrypoint: "rom/Game.EXE", args: '"DM Rankin" -nosound' };
    const files = new Map([
        ["manifest.json", new TextEncoder().encode(JSON.stringify(manifest))],
        ["rom\\game.exe", exe],
        ["rom\\data\\file.bin", new Uint8Array([17, 42])],
    ]);
    const bundle = await readWwtBundle(new Blob([Uint8Array.from(buildZip(files))]));
    expect(bundle.exePath).toBe("game.exe");
    expect(bundle.argv).toEqual(["DM Rankin", "-nosound"]);
    expect(new Uint8Array(bundle.files["data/file.bin"])).toEqual(new Uint8Array([17, 42]));
    files.set("rom/data/FILE.BIN", new Uint8Array());
    await expect(readWwtBundle(new Blob([Uint8Array.from(buildZip(files))]))).rejects.toThrow("Duplicate Windows path");
});

test("guest arguments preserve empty strings and Windows path separators", () => {
    expect(splitGuestArgs('"" "C:\\Map Pack\\map" -exec=..\\Benchmark\\timedemo.txt'))
        .toEqual(["", "C:\\Map Pack\\map", "-exec=..\\Benchmark\\timedemo.txt"]);
});
