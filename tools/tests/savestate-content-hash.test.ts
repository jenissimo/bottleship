import { describe, expect, test } from "bun:test";
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
