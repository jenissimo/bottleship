/**
 * Container → installer recursion seam (gog-import/container-extract.ts).
 *
 * This is the shared layer the WGB build pipeline (worker `wgb-build.ts`) and the headless
 * `iso-to-wgb` CLI both call once a container (disc image / 7z / zip / folder) has been
 * unwrapped to a flat rel-path → bytes map: "is there an installer inside, and if so what
 * are the real game files?". Heavy real-cabinet extraction is covered by installshield.test.ts;
 * here we pin the detection + routing + pass-through contract with light fixtures.
 */
import { describe, expect, test } from "bun:test";
import {
    detectInstallShield,
    extractInstallerFromFiles,
    createInstallShieldExternalResolver,
} from "@bottleship/repack/container-extract";
import { buildZip } from "@bottleship/formats/wgb/zip-build";
import { createHash } from 'node:crypto';

const enc = (s: string) => new TextEncoder().encode(s);
const mz = (extra = "") => enc("MZ" + extra);

test('loose cabinet files resolve by directory and size when basenames collide', () => {
    const first = enc('wrong-ini'), second = enc('right-ini');
    const resolve = createInstallShieldExternalResolver(new Map([
        ['Disc1/Scripts/Default.ini', first],
        ['Disc1/Scripts/GLSettings/Default.ini', second],
        ['other/Default.ini', enc('short')],
    ]));
    expect(resolve('DEFAULT.INI', second.length, 'Scripts\\GLSettings\\Default.ini')).toBe(second);
    expect(resolve('Default.ini', 5, 'missing/Default.ini')).toEqual(enc('short'));
    expect(resolve('Default.ini', second.length, 'missing/Default.ini',
        createHash('md5').update(second).digest())).toBe(second);
    expect(() => resolve('Default.ini', first.length, 'missing/Default.ini')).toThrow('Ambiguous');
    expect(resolve('absent.exe', 12, 'absent.exe')).toBeNull();
    const copies = createInstallShieldExternalResolver(new Map([
        ['Disk1/Controls/default.ini', first], ['Disk2/Controls/default.ini', first.slice()],
    ]));
    expect(copies('default.ini', first.length, 'Controls/default.ini')).toEqual(first);
});

describe("detectInstallShield", () => {
    test("finds the cabinet stem from a data1.hdr / data1.cab pair", () => {
        const d = detectInstallShield(["data1.hdr", "data1.cab", "setup.exe", "data2.cab"]);
        expect(d.stem).toBe("data");
    });

    test("matches case-insensitively through sub-directory paths", () => {
        const d = detectInstallShield(["disc1/Setup/DATA1.HDR", "disc1/Setup/Data1.Cab"]);
        expect(d.stem).toBe("data");
    });

    test("returns no stem when the cabinet pair is incomplete", () => {
        expect(detectInstallShield(["data1.hdr", "setup.exe"]).stem).toBeNull();
        expect(detectInstallShield(["game.exe", "readme.txt"]).stem).toBeNull();
    });

    test("flags loose InstallShield markers even without a cabinet", () => {
        const d = detectInstallShield(["_INST32I.EX_", "setup.ins", "data.tag"]);
        expect(d.hasMarkers).toBe(true);
    });
});

describe("extractInstallerFromFiles", () => {
    test("passes the map through unchanged when no installer is present", async () => {
        const files = new Map<string, Uint8Array>([
            ["GAME.EXE", mz()],
            ["data/world.pak", enc("payload")],
        ]);
        const r = await extractInstallerFromFiles(files);
        expect(r.via).toBe("none");
        expect(r.gameFiles).toBe(files); // same reference — no copy
        expect(r.note).toContain("no supported installer");
    });

    test("does not treat a bare .exe as Inno without the LZMA wasm", async () => {
        // An MZ that isn't a self-contained Inno installer, and no innoWasm supplied →
        // the Inno scan is skipped entirely and the container is packaged as-is.
        const files = new Map<string, Uint8Array>([["setup.exe", mz("\x00not-inno")]]);
        const r = await extractInstallerFromFiles(files); // no innoWasm
        expect(r.via).toBe("none");
    });

    test("detects a FreeArc payload by magic and routes to the freearc path", async () => {
        // A FreeArc archive (ArC\x01) with no innoWasm → the freearc format can't decode its
        // control blocks, so it can't extract; with a bogus tiny archive it throws/declines
        // and the recursion falls through to "none" rather than aborting the build.
        const files = new Map<string, Uint8Array>([
            ["data001.pak", new Uint8Array([0x41, 0x72, 0x43, 0x01, 0, 0, 0, 0])],
        ]);
        const r = await extractInstallerFromFiles(files); // no innoWasm
        expect(r.via).toBe("none"); // declined gracefully — not a crash
    });

    test("routes an InstallShield cabinet to the installshield path", async () => {
        // Bogus header/cab bytes: detection picks InstallShield (so `via` is NOT "none"),
        // and the real extractor rejects the malformed cabinet by throwing — which is the
        // correct contract (a truncated/corrupt cabinet must not silently pass through).
        const files = new Map<string, Uint8Array>([
            ["data1.hdr", new Uint8Array(64)],
            ["data1.cab", new Uint8Array(64)],
        ]);
        await expect(extractInstallerFromFiles(files)).rejects.toThrow();
    });
});

describe("EA WinZip self-installer (ea-winzip)", () => {
    test("unzips compressed.zip + resolves common_filelist.txt loose files, drops shell", async () => {
        // The game tree lives in compressed.zip…
        const compressed = buildZip(new Map<string, Uint8Array>([
            ["speeddemo.exe", mz("-game")],
            ["cars/350Z/GEOMETRY.BIN", enc("geo")],
            ["languages/English.bin", enc("lang")],
        ]));
        // …and common_filelist.txt names the loose files setup.exe copies alongside it.
        const filelist = [
            "1,1,Support\\*.* /s",            // wildcard + recurse
            "1,1,eauninstall.exe",            // literal loose file
            "1,1,Sndstreams\\STRM_Music.ast",
            "1,1,Sound\\FE\\FE_MB.abk",
        ].join("\r\n");
        const files = new Map<string, Uint8Array>([
            ["compressed.zip", compressed],
            ["common_filelist.txt", enc(filelist)],
            ["eauninstall.exe", mz("-uninst")],
            ["Sndstreams/STRM_Music.ast", enc("stream")],
            ["Sound/FE/FE_MB.abk", enc("bank")],
            ["Support/lisezmoi.txt", enc("readme-fr")],
            ["Support/sub/extra.dat", enc("nested")],
            // installer / autorun shell — NOT in the filelist → must be dropped:
            ["AutoRun.exe", mz()],
            ["setup.exe", mz()],
            ["autorun.inf", enc("[autorun]")],
            ["ReadMe/en.txt", enc("readme")],
        ]);

        const r = await extractInstallerFromFiles(files);
        expect(r.via).toBe("ea-winzip");
        const g = r.gameFiles;

        // from compressed.zip
        expect(g.has("speeddemo.exe")).toBe(true);
        expect(g.has("cars/350Z/GEOMETRY.BIN")).toBe(true);
        expect(new TextDecoder().decode(g.get("languages/English.bin")!)).toBe("lang");
        // loose, listed in common_filelist.txt
        expect(g.has("eauninstall.exe")).toBe(true);
        expect(g.has("Sndstreams/STRM_Music.ast")).toBe(true);
        expect(g.has("Sound/FE/FE_MB.abk")).toBe(true);
        // wildcard `Support\*.* /s` recurses into sub-dirs
        expect(g.has("Support/lisezmoi.txt")).toBe(true);
        expect(g.has("Support/sub/extra.dat")).toBe(true);
        // installer / autorun shell dropped
        expect(g.has("AutoRun.exe")).toBe(false);
        expect(g.has("setup.exe")).toBe(false);
        expect(g.has("autorun.inf")).toBe(false);
        expect(g.has("ReadMe/en.txt")).toBe(false);
        // the compressed.zip wrapper itself is consumed, not leaked into the game tree
        expect(g.has("compressed.zip")).toBe(false);
    });

    test("does not match without the common_filelist.txt manifest", async () => {
        const files = new Map<string, Uint8Array>([
            ["compressed.zip", buildZip(new Map([["game.exe", mz()]]))],
            ["game.exe", mz()],
        ]);
        const r = await extractInstallerFromFiles(files);
        expect(r.via).toBe("none"); // a bare compressed.zip is not the EA signature
    });
});
