/**
 * VFS directory enumeration: the cached ROM child index must be observationally
 * identical to the full-index scan it replaced.
 *
 * The reference implementation below is the PRE-CHANGE listRomDirectory copied
 * verbatim — the oracle for this refactor. Every case that made the old scan
 * interesting is exercised: original-case names, implicit directories, explicit ZIP
 * directory entries, a name that is both a file and a directory prefix, and ROM
 * whiteouts (which are applied at read time, so a deleted file must NOT reappear and
 * a directory whose whole subtree is deleted must vanish exactly as before).
 */
import { describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive, ZipEntry } from "@bottleship/formats/zip";

function normalizePath(p: string): string {
    const cleaned = p.replace(/\//g, "\\");
    const driveMatch = cleaned.match(/^([A-Za-z]):/);
    const drive = driveMatch ? driveMatch[1].toUpperCase() : "C";
    const rest = cleaned.replace(/^[A-Za-z]:\\?/, "");
    const stack: string[] = [];
    for (const part of rest.split("\\").filter(Boolean)) {
        if (part === ".") continue;
        if (part === "..") { stack.pop(); continue; }
        stack.push(part);
    }
    return `${drive}:\\${stack.join("\\")}`;
}

function relRomPath(full: string): string {
    const normalized = normalizePath(full);
    if (!normalized.startsWith("C:\\")) return "";
    return normalized.slice(3).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "");
}

/** PRE-CHANGE VirtualFileSystem.listRomDirectory — the oracle. */
function refList(
    lowerIndex: Map<string, ZipEntry>,
    romPrefix: string,
    whiteouts: Set<string>,
    path: string,
): unknown[] {
    const originalRelOf = (entry: ZipEntry, lowerRel: string): string => {
        let p = entry.name.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
        if (romPrefix && p.toLowerCase().startsWith(`${romPrefix.toLowerCase()}/`)) {
            p = p.slice(romPrefix.length + 1);
        }
        return p.toLowerCase() === lowerRel ? p : lowerRel;
    };
    const romPathFromRel = (rel: string): string => normalizePath(`C:\\${rel.replace(/\//g, "\\")}`);

    if (!normalizePath(path).startsWith("C:\\")) return [];
    const rel = relRomPath(path).toLowerCase();
    const prefix = rel ? `${rel}/` : "";
    const out = new Map<string, unknown>();
    for (const [relPath, entry] of lowerIndex.entries()) {
        if (prefix && !relPath.startsWith(prefix)) continue;
        if (whiteouts.has(relPath)) continue;
        const originalRel = originalRelOf(entry, relPath);
        const parts = originalRel.slice(prefix.length).split("/");
        const name = parts[0];
        if (!name) continue;
        if (parts.length === 1) {
            out.set(name.toLowerCase(), {
                path: romPathFromRel(originalRel), name, kind: "file",
                size: entry.uncompressedSize, source: "rom",
            });
        } else if (!out.has(name.toLowerCase())) {
            out.set(name.toLowerCase(), {
                path: romPathFromRel(`${prefix}${name}`.replace(/\/+$/, "")),
                name, kind: "dir", size: 0, source: "rom",
            });
        }
    }
    return Array.from(out.values());
}

function zipEntry(name: string, size: number, isDirectory = false): ZipEntry {
    return {
        name, compressedSize: size, uncompressedSize: size, compression: 0,
        localHeaderOffset: 0, isDirectory,
    } as ZipEntry;
}

const ROM_PREFIX = "rom";

/**
 * `buildRomIndex` keys entries by their rel path (prefix stripped) while `entry.name`
 * keeps the archive prefix — mirror that, or the original-case recovery is not tested.
 */
function makeIndex(relPaths: Array<[string, number]>): Map<string, ZipEntry> {
    const index = new Map<string, ZipEntry>();
    for (const [rel, size] of relPaths) {
        index.set(rel, zipEntry(`${ROM_PREFIX}/${rel}`, size, rel.endsWith("/")));
    }
    return index;
}

const FIXTURE = makeIndex([
    ["Morrowind.exe", 1000],
    ["Data Files/Bloodmoon.esm", 123],
    ["Data Files/Morrowind.esm", 456],
    ["Data Files/Music/Explore/title.mp3", 789],
    ["Data Files/Music/Battle/fight.mp3", 42],
    ["Data Files/MENU", 7],            // a file whose name looks like a directory
    ["Data Files/MENU/inner.txt", 8],  // ...and a directory with the same name
    ["deep/a/b/c/d/leaf.bin", 1],
    ["MixedCase/README.TXT", 2],
    ["emptyish/", 0],                  // explicit ZIP directory entry
]);

function mount(index: Map<string, ZipEntry>): { vfs: VirtualFileSystem; lower: Map<string, ZipEntry> } {
    const vfs = new VirtualFileSystem();
    // Enumeration never reads archive content, so a null archive stub is enough.
    vfs.mountRom(null as unknown as ZipArchive, ROM_PREFIX, index);
    const lower = new Map<string, ZipEntry>();
    for (const [k, v] of index) lower.set(k.toLowerCase(), v);
    return { vfs, lower };
}

const QUERIES = [
    "C:\\", "C:\\Data Files", "C:\\data files", "C:\\Data Files\\Music",
    "C:\\Data Files\\Music\\Explore", "C:\\Data Files\\MENU", "C:\\deep",
    "C:\\deep\\a", "C:\\deep\\a\\b\\c", "C:\\deep\\a\\b\\c\\d", "C:\\MixedCase",
    "C:\\emptyish", "C:\\Morrowind.exe", "C:\\nope", "C:\\nope\\deeper", "D:\\", "D:\\Data Files",
];

function expectIdentical(whiteouts: string[]): void {
    const { vfs, lower } = mount(FIXTURE);
    const wset = (vfs as unknown as { romWhiteouts: Set<string> }).romWhiteouts;
    for (const w of whiteouts) wset.add(w);
    for (const q of QUERIES) {
        expect(JSON.stringify(vfs.listDirectory(q)), `listDirectory(${q})`)
            .toBe(JSON.stringify(refList(lower, ROM_PREFIX, wset, vfs.resolvePath(q))));
    }
}

describe("VFS listDirectory — cached ROM child index vs. full index scan", () => {
    test("identical with no whiteouts", () => {
        expectIdentical([]);
    });

    test("identical with a single whited-out file", () => {
        expectIdentical(["data files/bloodmoon.esm"]);
    });

    test("identical when a leaf directory's only file is whited out", () => {
        // The directory must disappear from its parent's listing, exactly as before.
        expectIdentical(["data files/music/battle/fight.mp3"]);
    });

    test("identical when a whole subtree is whited out", () => {
        expectIdentical([
            "data files/music/battle/fight.mp3",
            "data files/music/explore/title.mp3",
        ]);
    });

    test("identical when every ROM file is whited out", () => {
        // Whiteout keys come from romWhiteoutKey(), which normalizes: never a trailing
        // slash, so an explicit ZIP directory entry can never be whited out.
        expectIdentical([...FIXTURE.keys()].map(k => k.toLowerCase().replace(/\/+$/, "")));
    });

    test("names keep the archive's original case", () => {
        const { vfs } = mount(FIXTURE);
        const root = vfs.listDirectory("C:\\").map(e => e.name).sort();
        expect(root).toContain("Morrowind.exe");
        expect(root).toContain("Data Files");
        expect(root).toContain("MixedCase");
        const mixed = vfs.listDirectory("C:\\mixedcase");
        expect(mixed).toHaveLength(1);
        expect(mixed[0].name).toBe("README.TXT");
        expect(mixed[0].path).toBe("C:\\MixedCase\\README.TXT");
    });

    test("a whited-out file does not reappear in an enumeration", () => {
        const { vfs } = mount(FIXTURE);
        const wset = (vfs as unknown as { romWhiteouts: Set<string> }).romWhiteouts;
        expect(vfs.listDirectory("C:\\Data Files").map(e => e.name)).toContain("Bloodmoon.esm");
        wset.add("data files/bloodmoon.esm");
        expect(vfs.listDirectory("C:\\Data Files").map(e => e.name)).not.toContain("Bloodmoon.esm");
        // ...and comes back when the whiteout is cleared (CREATE_ALWAYS over a ROM file).
        wset.delete("data files/bloodmoon.esm");
        expect(vfs.listDirectory("C:\\Data Files").map(e => e.name)).toContain("Bloodmoon.esm");
    });

    test("directoryExists stays O(1)-correct for every intermediate parent", () => {
        const { vfs } = mount(FIXTURE);
        for (const d of ["C:\\", "C:\\Data Files", "C:\\Data Files\\Music",
                         "C:\\deep\\a\\b\\c\\d", "C:\\MixedCase", "C:\\emptyish"]) {
            expect(vfs.directoryExists(d), d).toBe(true);
        }
        expect(vfs.directoryExists("C:\\Morrowind.exe")).toBe(false);
        expect(vfs.directoryExists("C:\\nope")).toBe(false);
    });

    test("a remount rebuilds the index (no stale children from the previous game)", () => {
        const { vfs } = mount(FIXTURE);
        expect(vfs.listDirectory("C:\\").length).toBeGreaterThan(1);
        vfs.mountRom(null as unknown as ZipArchive, ROM_PREFIX, makeIndex([["only.txt", 5]]));
        expect(vfs.listDirectory("C:\\").map(e => e.name)).toEqual(["only.txt"]);
        expect(vfs.directoryExists("C:\\Data Files")).toBe(false);
        vfs.reset();
        expect(vfs.listDirectory("C:\\")).toEqual([]);
    });
});
