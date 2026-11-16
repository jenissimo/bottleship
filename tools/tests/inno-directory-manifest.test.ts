import { describe, expect, test } from "bun:test";
import { synthesizeManifest } from "../../packages/repack/src/manifest-synth";
import type { InnoParseResult } from "@bottleship/formats/inno";

function directories(names: string[]): unknown {
    const parsed = {
        header: { appName: "Directory fixture", appVersion: "1" }, files: [], icons: [], registryEntries: [],
        directories: names.map(name => ({ name })), version: { isUnicode: () => false },
    } as unknown as InnoParseResult;
    return synthesizeManifest({ parsed, gameFiles: new Map(), cli: { exe: "fixture.exe" } }).manifest.emulator.createDirs;
}

describe("installer-created directories", () => {
    test("retains nested empty directories with either trailing separator", () => {
        expect(directories(["{app}\\save\\", "{app}/logs/", "{app}\\user\\photos\\\\"])).toEqual(["logs", "save", "user\\photos"]);
    });
    test("deduplicates and sorts after trimming", () => {
        expect(directories(["{app}/z/", "{app}\\a", "{app}\\a\\", "{app}/z//"])).toEqual(["a", "z"]);
    });
    test("does not create a directory for the install root or an empty entry", () => {
        expect(directories(["{app}", "{app}\\", "", "\\", "/"])).toBeUndefined();
    });
    test("still excludes installer-runtime paths and unresolved constants", () => {
        expect(directories(["{tmp}\\save\\", "{sys}\\x/", "{app}\\{code:Dir}\\", "relative\\save\\"])).toBeUndefined();
    });
    test("still rejects traversal, dot components and internal empty segments", () => {
        expect(directories(["{app}\\..\\escape\\", "{app}\\.\\save\\", "{app}\\save\\\\nested\\"])).toBeUndefined();
    });
    test("preserves support-directory normalization", () => {
        expect(directories(["__support\\app\\empty\\", "__support/save/config/"])).toEqual(["config", "empty"]);
    });
});
