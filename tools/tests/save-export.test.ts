/**
 * Stage-5 test: per-container save export → import round-trip (save-export.ts).
 * Uses an in-memory OPFS fake (no OPFS under bun) + the real store-only zip writer/reader.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { exportContainer, importContainer } from "../../src/worker/runtime/filesystem/save-export";
import { getContainerDir } from "../../src/worker/runtime/filesystem/container-store";

import { installFakeOpfs, FakeDirHandle } from "./fixtures/fake-opfs";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import { ZipArchive, BufferSource } from "@bottleship/formats/zip";
import { buildZip } from "@bottleship/formats/wgb/zip-build";

let root: FakeDirHandle;
const orig = (globalThis as any).navigator;
beforeEach(() => { root = installFakeOpfs(); });
afterAll(() => { (globalThis as any).navigator = orig; });

async function seed(gameId: string) {
    const c = await getContainerDir(gameId, true);
    const reg = await c!.getFileHandle("registry.json", { create: true });
    const regWriter = await reg.createWritable();
    await regWriter.write(new TextEncoder().encode('{"v":2}'));
    await regWriter.close();
    const overlay = await c!.getDirectoryHandle("overlay", { create: true });
    const saves = await overlay.getDirectoryHandle("saves", { create: true });
    const slot = await saves.getFileHandle("slot1.sav", { create: true });
    const slotWriter = await slot.createWritable();
    await slotWriter.write(new Uint8Array([1, 2, 3, 4, 5]));
    await slotWriter.close();
}

describe("container save export/import", () => {
    test("exports the persistent layer (registry + overlay tree)", async () => {
        await seed("app:game-a");
        const zip = await exportContainer("app:game-a");
        expect(zip).not.toBeNull();
        expect(zip!.length).toBeGreaterThan(0);
    });

    test("export of an unknown game is null", async () => {
        expect(await exportContainer("app:never")).toBeNull();
    });

    test("round-trips into a different container", async () => {
        await seed("app:src");
        const zip = await exportContainer("app:src");
        const n = await importContainer("app:dst", zip!);
        expect(n).toBe(2); // registry.json + overlay/saves/slot1.sav

        const dst = await getContainerDir("app:dst", false);
        const slot = await (await (await dst!.getDirectoryHandle("overlay")).getDirectoryHandle("saves")).getFileHandle("slot1.sav");
        const bytes = new Uint8Array(await (await slot.getFile()).arrayBuffer());
        expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5]);
    });
});

test("export/import preserves the authoritative EOF of a replaced ROM file", async () => {
    const archive = new ZipArchive(new BufferSource(buildZip(new Map([
        ["rom/state.dat", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])],
    ]))));
    await archive.init();
    const mount = async (id: string) => {
        const vfs = new VirtualFileSystem();
        vfs.mountRom(archive, "rom", new Map(archive.listEntries().map(e => [e.name.replace(/^rom\//, ""), e])));
        await vfs.initOverlay(id);
        await vfs.ensureOverlayIndex();
        return vfs;
    };
    const source = await mount("test:shadow-export-source");
    const out = source.openSync("C:\\state.dat", 0x40000000, 2)!;
    source.writeSync(out, new Uint8Array([9, 10]));
    await source.flushAll();
    const zip = await exportContainer("test:shadow-export-source");
    expect(zip).not.toBeNull();
    await importContainer("test:shadow-export-target", zip!);
    const restored = await mount("test:shadow-export-target");
    expect(restored.getFileSize("C:\\state.dat")).toBe(2);
    const input = await restored.open("C:\\state.dat", 0x80000000, 3);
    expect(input).not.toBeNull();
    expect(Array.from(await restored.read(input!, 8))).toEqual([9, 10]);
});
