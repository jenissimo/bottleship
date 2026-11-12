/**
 * Stage-5 test: per-container save export → import round-trip (save-export.ts).
 * Uses an in-memory OPFS fake (no OPFS under bun) + the real store-only zip writer/reader.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { exportContainer, importContainer } from "../../src/worker/runtime/filesystem/save-export";
import { exportGameContainer, importGameContainer } from "../../src/storage-manager";
import { gameIdToContainerDir } from "@bottleship/formats/wgb/container-id";
import { getContainerDir, SHADOW_INDEX_FILE } from "../../src/worker/runtime/filesystem/container-store";

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

const flows = [
    { name: "worker", export: exportContainer, import: importContainer },
    { name: "library", export: (id: string) => exportGameContainer(gameIdToContainerDir(id)),
        import: (id: string, bytes: Uint8Array) => importGameContainer(gameIdToContainerDir(id), bytes) },
];
for (const exporter of flows) for (const importer of flows) {
    test(`${exporter.name} export / ${importer.name} import preserves a replaced ROM file's EOF`, async () => {
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
        const zip = await exporter.export("test:shadow-export-source");
        expect(zip).not.toBeNull();
        await importer.import("test:shadow-export-target", zip!);
        const restored = await mount("test:shadow-export-target");
        expect(restored.getFileSize("C:\\state.dat")).toBe(2);
        const input = await restored.open("C:\\state.dat", 0x80000000, 3);
        expect(input).not.toBeNull();
        expect(Array.from(await restored.read(input!, 8))).toEqual([9, 10]);
    });
}

for (const flow of flows) {
    test(`${flow.name} import of an older export removes stale tombstones`, async () => {
        const id = "test:legacy-import";
        await seed(id);
        const container = (await getContainerDir(id, false))!;
        const writer = await (await container.getFileHandle(SHADOW_INDEX_FILE, { create: true })).createWritable();
        await writer.write('{"stale":true}'); await writer.close();
        const zip = buildZip(new Map([["registry.json", new TextEncoder().encode('{"v":3}')]]));
        expect(await flow.import(id, zip)).toBe(1);
        await expect(container.getFileHandle(SHADOW_INDEX_FILE)).rejects.toHaveProperty("name", "NotFoundError");
        // Re-importing when no sidecar exists is also valid.
        expect(await flow.import(id, zip)).toBe(1);
    });

    test(`${flow.name} import replaces an existing sidecar with the archive's index`, async () => {
        const id = "test:replace-index";
        const container = (await getContainerDir(id, true))!;
        const writer = await (await container.getFileHandle(SHADOW_INDEX_FILE, { create: true })).createWritable();
        await writer.write('{"stale":true}'); await writer.close();
        const replacement = '{"state.dat":true}';
        expect(await flow.import(id, buildZip(new Map([
            [SHADOW_INDEX_FILE, new TextEncoder().encode(replacement)],
        ])))).toBe(1);
        expect(await (await (await container.getFileHandle(SHADOW_INDEX_FILE)).getFile()).text()).toBe(replacement);
    });

    test(`${flow.name} import failure does not remove the existing sidecar`, async () => {
        const id = "test:failed-import";
        const container = (await getContainerDir(id, true))!;
        const writer = await (await container.getFileHandle(SHADOW_INDEX_FILE, { create: true })).createWritable();
        await writer.write('{"stale":true}'); await writer.close();
        const registry = await container.getFileHandle("registry.json", { create: true });
        registry.createWritable = async () => { throw new Error("write failed"); };
        await expect(flow.import(id, buildZip(new Map([
            ["registry.json", new Uint8Array([1])],
        ])))).rejects.toThrow("write failed");
        expect(await (await (await container.getFileHandle(SHADOW_INDEX_FILE)).getFile()).text()).toBe('{"stale":true}');
    });
}
