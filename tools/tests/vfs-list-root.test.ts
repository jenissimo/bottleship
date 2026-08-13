/**
 * Directory enumeration must surface guest-written files in the DRIVE ROOT.
 *
 * The root is the one path that normalizes with a trailing separator ("C:\"), so a
 * prefix/depth test built from the raw string silently excludes every root child while
 * statEntry() still finds it. A game that gates its real open on FindFirstFile (Cossacks
 * does: no hit -> it looks the name up inside its own archive and never touches disk)
 * then cannot read back anything it just wrote.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive, ZipEntry } from "@bottleship/formats/zip";
import { installFakeOpfs } from "./fixtures/fake-opfs";

const GENERIC_WRITE = 0x40000000;
const CREATE_ALWAYS = 2;

function romEntry(name: string, size: number): [string, ZipEntry] {
    return [
        name,
        { name, compressedSize: size, uncompressedSize: size, compression: 0, localHeaderOffset: 0, isDirectory: false },
    ];
}

const origNavigator = (globalThis as unknown as { navigator: unknown }).navigator;
afterAll(() => { (globalThis as unknown as { navigator: unknown }).navigator = origNavigator; });

let seq = 0;
async function freshVfs(): Promise<VirtualFileSystem> {
    installFakeOpfs();
    const vfs = new VirtualFileSystem();
    vfs.mountRom(
        null as unknown as ZipArchive,
        "rom",
        new Map([romEntry("shipped.dat", 10), romEntry("Demo/script1.rec", 20)]),
    );
    await vfs.initOverlay(`test:list${++seq}`);
    return vfs;
}

function write(vfs: VirtualFileSystem, path: string, size: number): void {
    vfs.ensureParentDirsSync(path);
    const h = vfs.openSync(path, GENERIC_WRITE, CREATE_ALWAYS)!;
    expect(h).not.toBeNull();
    vfs.writeSync(h, new Uint8Array(size));
}

const names = (vfs: VirtualFileSystem, dir: string): string[] =>
    vfs.listDirectory(dir).map((e) => e.name).sort();

describe("VFS listDirectory surfaces overlay files", () => {
    test("a guest-written file in the drive root is listed, not just stat-able", async () => {
        const vfs = await freshVfs();
        write(vfs, "C:\\map.m3d", 64);

        // statEntry has always found it; the enumeration is what regressed.
        expect(vfs.statEntry("C:\\map.m3d")?.source).toBe("overlay");
        expect(names(vfs, "C:\\")).toContain("map.m3d");
        expect(names(vfs, "C:")).toContain("map.m3d");
        expect(names(vfs, ".")).toContain("map.m3d");

        const listed = vfs.listDirectory("C:\\").find((e) => e.name === "map.m3d")!;
        expect(listed.kind).toBe("file");
        expect(listed.size).toBe(64);
        expect(listed.source).toBe("overlay");
    });

    test("root listing merges overlay over ROM without dropping either", async () => {
        const vfs = await freshVfs();
        write(vfs, "C:\\map.m3d", 8);

        const root = names(vfs, "C:\\");
        expect(root).toContain("shipped.dat"); // ROM
        expect(root).toContain("map.m3d");     // overlay
        expect(root).toContain("Demo");        // ROM subdirectory
    });

    test("an overlay copy shadows the ROM entry exactly once", async () => {
        const vfs = await freshVfs();
        write(vfs, "C:\\shipped.dat", 99);

        const hits = vfs.listDirectory("C:\\").filter((e) => e.name.toLowerCase() === "shipped.dat");
        expect(hits).toHaveLength(1);
        expect(hits[0]!.source).toBe("overlay");
        expect(hits[0]!.size).toBe(99);
    });

    test("subdirectory listings keep working (the non-root path is unchanged)", async () => {
        const vfs = await freshVfs();
        write(vfs, "C:\\Demo\\saved.rec", 32);

        const demo = names(vfs, "C:\\Demo");
        expect(demo).toContain("script1.rec"); // ROM
        expect(demo).toContain("saved.rec");   // overlay
        // A root-level file must not leak into a subdirectory listing.
        expect(demo).not.toContain("shipped.dat");
    });

    test("a nested overlay file surfaces its top directory in the root, not its leaf", async () => {
        const vfs = await freshVfs();
        write(vfs, "C:\\Save\\slot1\\game.sav", 16);

        const root = vfs.listDirectory("C:\\");
        const save = root.find((e) => e.name === "Save");
        expect(save?.kind).toBe("dir");
        expect(root.map((e) => e.name)).not.toContain("game.sav");
        expect(names(vfs, "C:\\Save")).toContain("slot1");
        expect(names(vfs, "C:\\Save\\slot1")).toContain("game.sav");
    });
});
