/**
 * Unit tests for the persist/ephemeral path policy (#12 — the ".gitignore" analog).
 * Default = persist-by-default (only declared/global ephemeral globs are dropped); persistOnly flips
 * to allowlist. Patterns match the overlay-relative posix path, gitignore-style.
 */
import { describe, expect, test } from "bun:test";
import { PathPolicy, toOverlayRel } from "../../src/worker/runtime/filesystem/path-policy";

describe("toOverlayRel", () => {
    test("strips drive, lowercases, posix-izes", () => {
        expect(toOverlayRel("C:\\Game\\Save\\Foo.SAV")).toBe("game/save/foo.sav");
        expect(toOverlayRel("D:/cd/data.bin")).toBe("cd/data.bin");
    });
});

describe("persist-by-default", () => {
    const p = new PathPolicy();
    test("saves/configs persist", () => {
        expect(p.classify("C:\\Game\\profile.sav")).toBe("persist");
        expect(p.classify("C:\\Game\\settings.ini")).toBe("persist");
        expect(p.classify("C:\\Game\\player.dat")).toBe("persist");
    });
    test("global ephemeral globs are ephemeral", () => {
        expect(p.isEphemeral("C:\\Game\\debug.log")).toBe(true);
        expect(p.isEphemeral("C:\\Game\\foo.tmp")).toBe(true);
        expect(p.isEphemeral("C:\\Game\\Temp\\scratch.bin")).toBe(true);
    });
    test("a cache directory persists — its content is expensive, not disposable", () => {
        expect(p.isEphemeral("C:\\Game\\cache\\tex0.bin")).toBe(false);
        expect(p.isEphemeral("C:\\Game\\Shaders\\Cache\\CGPShaders\\a$b.cgps")).toBe(false);
    });
    test("*.log matches in any directory (basename rule)", () => {
        expect(p.isEphemeral("C:\\Game\\Logs\\Deep\\a.log")).toBe(true);
    });
});

describe("per-game ephemeral additions", () => {
    const p = new PathPolicy({ ephemeral: ["DxCache/**", "*.scratch"] });
    test("manifest globs add to the ephemeral set", () => {
        expect(p.isEphemeral("C:\\Game\\DxCache\\shaders.bin")).toBe(true);
        expect(p.isEphemeral("C:\\Game\\x.scratch")).toBe(true);
    });
    test("non-matching still persists", () => {
        expect(p.classify("C:\\Game\\save01.sav")).toBe("persist");
    });
});

describe("persistOnly (allowlist)", () => {
    const p = new PathPolicy({ persistOnly: true, persist: ["saves/**"] });
    test("only allowlisted + default-save globs persist", () => {
        expect(p.classify("C:\\Game\\saves\\slot1.bin")).toBe("persist");
        expect(p.classify("C:\\Game\\profile.sav")).toBe("persist");      // default persist glob
    });
    test("everything else is ephemeral", () => {
        expect(p.isEphemeral("C:\\Game\\world.dat")).toBe(false);          // *.dat is a default persist glob
        expect(p.isEphemeral("C:\\Game\\random.bin")).toBe(true);
        expect(p.isEphemeral("C:\\Game\\notes.txt")).toBe(true);
    });
});
