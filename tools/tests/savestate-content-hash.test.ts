import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { BufferSource, WGB_BLOCK_INDEX_ENTRY, ZipArchive } from "@bottleship/formats/zip";
import { ZipStoreWriter } from "../internal/zip-store-writer";
import { compressWgb, type CompressOptions } from "../wgb-compress";
import { noteBootIdentity, type BundleEntryKey } from "../../src/worker/savestate/host";

const hash = async (entries: BundleEntryKey[], manifest: unknown = { gameId: "app:test" }) =>
    (await noteBootIdentity({ gameId: "app:test", manifest, entries, config: {}, layout: {} })).contentHash;

const ENTRIES: BundleEntryKey[] = [
    { name: "rom/game.exe", size: 4096, crc32: 0x11223344 },
    { name: "rom/data.bin", size: 100000, crc32: 0x55667788 },
];

describe("bundle content hash", () => {
    test("is the same however the bundle was packed", async () => {
        const stored = ENTRIES.map(e => ({ ...e, compressedSize: e.size }));
        const deflated = ENTRIES.map(e => ({ ...e, compressedSize: e.size >> 1 }));
        expect(await hash(stored)).toBe(await hash(ENTRIES));
        expect(await hash(deflated)).toBe(await hash(ENTRIES));
    });

    test("does not depend on the order of the entries", async () => {
        expect(await hash([...ENTRIES].reverse())).toBe(await hash(ENTRIES));
    });

    test("changes with a name, an uncompressed size, a CRC, an added entry or the manifest", async () => {
        const base = await hash(ENTRIES);
        const changed: BundleEntryKey[][] = [
            [{ ...ENTRIES[0]!, name: "rom/game2.exe" }, ENTRIES[1]!],
            [{ ...ENTRIES[0]!, size: 4097 }, ENTRIES[1]!],
            [{ ...ENTRIES[0]!, crc32: 0x11223345 }, ENTRIES[1]!],
            [...ENTRIES, { name: "rom/extra.txt", size: 1, crc32: 1 }],
        ];
        for (const entries of changed) expect(await hash(entries)).not.toBe(base);
        expect(await hash(ENTRIES, { gameId: "app:test", entrypoint: "rom/game.exe" })).not.toBe(base);
    });
});

const logs = resolve("logs");
mkdirSync(logs, { recursive: true });
const root = mkdtempSync(join(logs, "savestate-content-hash-"));
afterAll(() => {
    if (!resolve(root).startsWith(logs + sep)) throw new Error("fixture outside logs");
    rmSync(root, { recursive: true, force: true });
});

const fill = (size: number, phrase: string) => new TextEncoder().encode(phrase.repeat(Math.ceil(size / phrase.length)).slice(0, size));

const GAME: Record<string, Uint8Array> = {
    "manifest.json": new TextEncoder().encode(JSON.stringify({ formatVersion: 2, name: "fixture", entrypoint: "rom/game.exe", rom: "rom" })),
    "rom/game.exe": fill(70_001, "unit tank harvester "),
    "rom/data.mix": fill(150_000, "ore power plant rocket "),
    "rom/theme.ogg": fill(20_000, "soldier "),
};

function writeStored(name: string, files: Record<string, Uint8Array>): string {
    const path = join(root, name);
    const w = new ZipStoreWriter(path);
    for (const [member, data] of Object.entries(files)) w.addStored(member, data);
    w.finish();
    return path;
}

async function pack(stored: string, name: string, options: CompressOptions): Promise<string> {
    const path = join(root, name);
    await compressWgb(stored, path, options);
    return path;
}

async function open(path: string): Promise<ZipArchive> {
    const archive = new ZipArchive(new BufferSource(new Uint8Array(readFileSync(path))));
    await archive.init();
    return archive;
}

async function bundleHash(path: string): Promise<string> {
    const archive = await open(path);
    const manifest = JSON.parse(new TextDecoder().decode(await archive.readEntry(archive.getEntry("manifest.json")!)));
    const entries = archive.listEntries().map(e => ({ name: e.name, size: e.uncompressedSize, crc32: e.crc32 }));
    return hash(entries, manifest);
}

describe("bundle content hash of built bundles", () => {
    test("a store-only build and its wgb-compress repacks hash the same", async () => {
        const stored = writeStored("stored.wgb", GAME);
        const packed = await pack(stored, "packed.wgb", { blockKiB: 16 });
        const repacked = await pack(stored, "repacked.wgb", { blockKiB: 64, level: 1 });

        const a = await open(packed), b = await open(repacked);
        expect(a.getEntry(WGB_BLOCK_INDEX_ENTRY)).toBeDefined();
        expect(a.getEntry("rom/data.mix")!.compression).toBe(8);
        expect(await a.readEntry(a.getEntry(WGB_BLOCK_INDEX_ENTRY)!)).not.toEqual(await b.readEntry(b.getEntry(WGB_BLOCK_INDEX_ENTRY)!));

        const base = await bundleHash(stored);
        expect(await bundleHash(packed)).toBe(base);
        expect(await bundleHash(repacked)).toBe(base);
    });

    test("a changed member or manifest still changes it, packed or not", async () => {
        const base = await bundleHash(writeStored("base.wgb", GAME));
        const patched = { ...GAME, "rom/data.mix": fill(150_000, "ore power plant rocket ").fill(0x58, 100, 101) };
        const patchedStored = writeStored("patched.wgb", patched);
        expect(await bundleHash(patchedStored)).not.toBe(base);
        expect(await bundleHash(await pack(patchedStored, "patched.packed.wgb", { blockKiB: 16 }))).not.toBe(base);

        const retargeted = { ...GAME, "manifest.json": new TextEncoder().encode(JSON.stringify({ formatVersion: 2, name: "fixture", entrypoint: "rom/other.exe", rom: "rom" })) };
        expect(await bundleHash(await pack(writeStored("retargeted.wgb", retargeted), "retargeted.packed.wgb", { blockKiB: 16 }))).not.toBe(base);
    });
});
