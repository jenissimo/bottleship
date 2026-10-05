/**
 * Stage-1 WGB build service — pure helper tests (wgb-build.ts).
 *
 * Covers the parts that don't need OPFS or the inno-lzma WASM: source detection (folder /
 * zip / wgb passthrough / unknown), manifest merge/override semantics, and a buildZip →
 * ZipArchive round-trip (the packing primitive both the build and finalize paths rely on).
 */
import { describe, expect, test } from "bun:test";
import {
    detectSource,
    detectFromBytes,
    looksLikeWgb,
    collectExeDetections,
    mergeManifest,
    unzipStored,
    readDirectoryFiles,
    type BuildSource,
} from "../../src/worker/runtime/filesystem/wgb-build";
import { buildZip } from "@bottleship/formats/wgb/zip-build";
import { ZipArchive, BufferSource } from "@bottleship/formats/zip";

const enc = (s: string) => new TextEncoder().encode(s);

describe("directory handles", () => {
    const fileHandle = (name: string) => ({ name, kind: "file", getFile: async () => ({
        name, size: 5_000_000_000, arrayBuffer() { throw new Error("Whole-file read during enumeration"); },
    }) });
    const directory = (name: string, entries: Array<[string, unknown]>) => ({ name, kind: "directory",
        async *entries() { for (const entry of entries) yield entry; } }) as unknown as FileSystemDirectoryHandle;

    test("game folders enumerate nested snapshots and detect exes without reading payloads", async () => {
        const child = directory("data", [["huge.dat", fileHandle("huge.dat")]]);
        const root = directory("My Game", [["game.exe", fileHandle("game.exe")], ["data", child]]);
        const files = await readDirectoryFiles(root);
        expect([...files.keys()]).toEqual(["game.exe", "data/huge.dat"]);
        expect(files.get("data/huge.dat")!.size).toBe(5_000_000_000);
        expect(await detectSource({ directory: root, directoryMode: "installed" })).toMatchObject({
            kind: "game-folder", exeCandidates: ["game.exe"], suggestedEntrypoint: "game.exe",
        });
    });
    test("empty folders and folders containing several GOG installers explain how to select", async () => {
        await expect(readDirectoryFiles(directory("Empty", []))).rejects.toThrow("empty");
        await expect(detectSource({ directory: directory("Downloads", [
            ["setup_a.exe", fileHandle("setup_a.exe")], ["setup_b.exe", fileHandle("setup_b.exe")],
        ]), directoryMode: "gog-installer" })).rejects.toThrow("Choose files");
    });
});

// --- detectFromBytes / looksLikeWgb ----------------------------------------------

describe("byte/zip classification", () => {
    test("detectFromBytes flags a PK header as wgb (zip family)", () => {
        const zip = buildZip(new Map([["a.txt", enc("hi")]]));
        expect(detectFromBytes(zip)).toBe("wgb");
    });

    test("detectFromBytes flags non-MZ/non-PK as unknown", () => {
        expect(detectFromBytes(enc("not an exe or zip"))).toBe("unknown");
    });

    test("looksLikeWgb is true only when manifest.json is present", () => {
        expect(looksLikeWgb(["manifest.json", "rom/game.exe"])).toBe(true);
        expect(looksLikeWgb(["game.exe", "data/x.dat"])).toBe(false);
    });
});

// --- collectExeDetections --------------------------------------------------------

describe("exe detection", () => {
    test("picks a root non-installer exe and lists all candidates", () => {
        const d = collectExeDetections(["GAME.EXE", "setup.exe", "data/tool.exe"]);
        expect(d.exeCandidates).toContain("GAME.EXE");
        expect(d.exeCandidates).toContain("data/tool.exe");
        expect(d.suggestedEntrypoint).toBe("GAME.EXE");
    });

    test("backslash paths are normalized", () => {
        const d = collectExeDetections(["bin\\app.exe"]);
        expect(d.exeCandidates).toEqual(["bin/app.exe"]);
    });

    test("filters GOG junk exes from candidates", () => {
        const d = collectExeDetections(["game.exe", "unins000.exe"]);
        expect(d.exeCandidates).toEqual(["game.exe"]);
    });
});

// --- mergeManifest ---------------------------------------------------------------

describe("manifest merge / override semantics", () => {
    test("deep-merges nested objects, replaces scalars, keeps base immutable", () => {
        const base = {
            name: "Game",
            emulator: { osVersion: { major: 4 }, screenResolution: { width: 640, height: 480 } },
        };
        const patch = {
            name: "Game (patched)",
            emulator: { screenResolution: { width: 800 }, skipVideo: true },
        };
        const merged = mergeManifest(base, patch);
        expect(merged.name).toBe("Game (patched)");
        expect((merged.emulator as any).osVersion).toEqual({ major: 4 });
        expect((merged.emulator as any).screenResolution).toEqual({ width: 800, height: 480 });
        expect((merged.emulator as any).skipVideo).toBe(true);
        // base untouched
        expect(base.name).toBe("Game");
        expect((base.emulator.screenResolution as any).width).toBe(640);
    });

    test("undefined patch values do not clobber base", () => {
        const merged = mergeManifest({ a: 1, b: 2 }, { a: undefined as unknown as number, b: 9 });
        expect(merged).toEqual({ a: 1, b: 9 });
    });

    test("arrays are replaced wholesale, not merged", () => {
        const merged = mergeManifest({ args: ["-a", "-b"] }, { args: ["-x"] });
        expect(merged.args).toEqual(["-x"]);
    });
});

// --- buildZip → ZipArchive round-trip --------------------------------------------

describe("zip round-trip (buildZip → ZipArchive)", () => {
    test("reads back identical entries", async () => {
        const files = new Map<string, Uint8Array>([
            ["manifest.json", enc('{"name":"X","gameId":"app:x"}')],
            ["registry.json", enc("[]")],
            ["rom/GAME.EXE", enc("MZ-fake-bytes")],
            ["rom/data/big.dat", new Uint8Array(10000).fill(0xab)],
        ]);
        const zip = buildZip(files);

        const archive = new ZipArchive(new BufferSource(zip));
        await archive.init();

        // Same set of names.
        const names = archive.listEntries().map((e) => e.name).sort();
        expect(names).toEqual([...files.keys()].sort());

        // Byte-identical contents.
        for (const [name, expected] of files) {
            const entry = archive.getEntry(name)!;
            expect(entry).toBeDefined();
            expect(entry.uncompressedSize).toBe(expected.byteLength);
            const got = await archive.readEntry(entry);
            expect(Array.from(got)).toEqual(Array.from(expected));
        }
    });

    test("unzipStored returns the same map (sans directories)", async () => {
        const files = new Map<string, Uint8Array>([
            ["manifest.json", enc("{}")],
            ["rom/a.dat", enc("aaa")],
        ]);
        const zip = buildZip(files);
        const back = await unzipStored(zip);
        expect(back.size).toBe(2);
        expect(new TextDecoder().decode(back.get("rom/a.dat")!)).toBe("aaa");
    });
});

// --- detectSource (folder / zip / wgb passthrough / unknown) ----------------------

describe("detectSource", () => {
    test("classifies a folder of files as game-folder with exe detection", async () => {
        const files = new Map<string, Uint8Array>([
            ["GAME.EXE", enc("MZ")],
            ["setup.exe", enc("MZ")],
            ["data/x.dat", enc("x")],
        ]);
        const d = await detectSource({ files });
        expect(d.kind).toBe("game-folder");
        expect(d.suggestedEntrypoint).toBe("GAME.EXE");
        expect(d.note).toContain("executables");
    });

    test("classifies a wgb URL as wgb", async () => {
        const d = await detectSource({ url: "/apps/game.wgb" });
        expect(d.kind).toBe("wgb");
        expect(d.detectedFormat).toBe("wgb");
    });

    test("classifies a finished .wgb blob as wgb (manifest.json present)", async () => {
        const zip = buildZip(new Map([
            ["manifest.json", enc('{"name":"X","gameId":"app:x"}')],
            ["rom/GAME.EXE", enc("MZ")],
        ]));
        const d = await detectSource({ blob: new Blob([zip]) });
        expect(d.kind).toBe("wgb");
    });

    test("classifies a plain installer .zip blob as installer-zip", async () => {
        const zip = buildZip(new Map([
            ["GAME.EXE", enc("MZ")],
            ["data/x.dat", enc("x")],
        ]));
        const d = await detectSource({ blob: new Blob([zip]) });
        expect(d.kind).toBe("installer-zip");
        expect(d.suggestedEntrypoint).toBe("GAME.EXE");
    });

    test("classifies a disc image (CD001 at sector 16) as iso9660", async () => {
        // Minimal plain-ISO framing: the volume-descriptor magic at logical sector 16
        // is all detectSource needs to route a headless blob into the disc pipeline.
        const iso = new Uint8Array(34 * 2048);
        iso.set(enc("CD001"), 16 * 2048 + 1); // VD type byte at +0, "CD001" at +1
        const d = await detectSource({ blob: new Blob([iso]) });
        expect(d.kind).toBe("iso9660");
    });

    test("classifies a raw-sector (MODE1/2352) disc image as iso9660", async () => {
        const iso = new Uint8Array(18 * 2352);
        iso.set(enc("CD001"), 16 * 2352 + 16 + 1); // user-data window at +16, magic at +1
        const d = await detectSource({ blob: new Blob([iso]) });
        expect(d.kind).toBe("iso9660");
    });

    test("classifies an unrecognized blob as unknown", async () => {
        const d = await detectSource({ blob: new Blob([enc("just some text")]) });
        expect(d.kind).toBe("unknown");
        expect(d.detectedFormat).toBe("unknown");
    });

    test("empty source is unknown", async () => {
        const d = await detectSource({} as BuildSource);
        expect(d.kind).toBe("unknown");
    });
});

// --- self-extracting archive (SFX): prefix-delta + detection ---------------------

/** Fabricate a WinZip-style SFX: a fake PE stub (leads with "MZ") prepended to a ZIP. */
function makeSfx(zip: Uint8Array, stubSize: number): Uint8Array {
    const stub = new Uint8Array(stubSize);
    stub[0] = 0x4d; // "M"
    stub[1] = 0x5a; // "Z"
    const out = new Uint8Array(stub.length + zip.length);
    out.set(stub, 0);
    out.set(zip, stub.length);
    return out;
}

describe("self-extracting archive (SFX)", () => {
    test("ZipArchive reads a zip behind a PE stub (prefix delta)", async () => {
        const files = new Map<string, Uint8Array>([
            ["speeddemo.exe", enc("MZ-game-bytes")],
            ["cars/350Z/GEOMETRY.BIN", new Uint8Array(5000).fill(0x5a)],
        ]);
        const sfx = makeSfx(buildZip(files), 28160); // ~ the real NFSU SFX stub size
        const archive = new ZipArchive(new BufferSource(sfx));
        await archive.init();

        const names = archive.listEntries().map((e) => e.name).sort();
        expect(names).toEqual([...files.keys()].sort());
        for (const [name, expected] of files) {
            const got = await archive.readEntry(archive.getEntry(name)!);
            expect(Array.from(got)).toEqual(Array.from(expected));
        }
    });

    test("a plain zip (no stub) still reads — delta 0, behavior preserved", async () => {
        const back = await unzipStored(buildZip(new Map([["a.dat", enc("hello")]])));
        expect(new TextDecoder().decode(back.get("a.dat")!)).toBe("hello");
    });

    test("detectSource classifies an SFX exe as installer-sfx", async () => {
        const zip = buildZip(new Map<string, Uint8Array>([
            ["AutoRun.exe", enc("MZ")],
            ["compressed.zip", enc("inner-payload")],
            ["Sound/x.abk", enc("a")],
        ]));
        const d = await detectSource({ blob: new Blob([makeSfx(zip, 8192)]) });
        expect(d.kind).toBe("installer-sfx");
        expect(d.note).toContain("self-extracting");
    });
});
