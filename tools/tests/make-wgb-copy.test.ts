/**
 * make-wgb --copy: a file an installer SCRIPT creates by copying one it shipped (a
 * language pack chosen in the setup dialog, a config cloned from a template) is in no
 * cabinet, so an extracted tree lacks it. --copy stores the source again under the
 * destination name, as its own entry.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { BufferSource, ZipArchive } from "@bottleship/formats/zip";

function fixture(): { root: string; game: string; output: string } {
    const logs = resolve("logs"); mkdirSync(logs, { recursive: true });
    const root = mkdtempSync(join(logs, "make-wgb-copy-"));
    const game = join(root, "game");
    mkdirSync(join(game, "Data", "Lang"), { recursive: true });
    writeFileSync(join(game, "Game.exe"), "MZ");
    writeFileSync(join(game, "Data", "Lang", "english.pak"), "english strings");
    writeFileSync(join(game, "Data", "Lang", "german.pak"), "german strings");
    writeFileSync(join(game, "Data", "current.pak"), "already here");
    return { root, game, output: join(root, "copy.wgb") };
}

function cleanup(root: string): void {
    if (!resolve(root).startsWith(resolve("logs") + sep)) throw new Error("Fixture outside logs");
    rmSync(root, { recursive: true, force: true });
}

async function makeWgb(game: string, output: string, extra: string[]) {
    const child = Bun.spawn(["bun", "tools/make-wgb.ts", game, output, "--game-id", "app:copy-fixture", "--exe", "Game.exe", ...extra],
        { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
}

async function entries(output: string): Promise<Map<string, string>> {
    const archive = new ZipArchive(new BufferSource(new Uint8Array(await Bun.file(output).arrayBuffer())));
    await archive.init();
    const out = new Map<string, string>();
    for (const name of ["rom/Data/Lang/english.pak", "rom/Data/Locale.pak", "rom/Data/Lang/german.pak"]) {
        const e = archive.getEntry(name);
        if (e) out.set(name, new TextDecoder().decode(await archive.readEntry(e)));
    }
    return out;
}

describe("make-wgb --copy", () => {
    test("stores the source under the destination as well, backslashes and case accepted", async () => {
        const { root, game, output } = fixture();
        try {
            const { code, stderr, stdout } = await makeWgb(game, output, ["--copy", "data\\lang\\ENGLISH.pak=Data\\Locale.pak"]);
            expect(code, stderr).toBe(0);
            expect(stdout).toContain("Data/Lang/english.pak -> Data/Locale.pak");
            const got = await entries(output);
            expect(got.get("rom/Data/Locale.pak")).toBe("english strings");
            expect(got.get("rom/Data/Lang/english.pak")).toBe("english strings");
            expect(got.get("rom/Data/Lang/german.pak")).toBe("german strings");
        } finally { cleanup(root); }
    });

    test("a missing source is an error", async () => {
        const { root, game, output } = fixture();
        try {
            const { code, stderr } = await makeWgb(game, output, ["--copy", "Data/Lang/french.pak=Data/Locale.pak"]);
            expect(code).toBe(1);
            expect(stderr).toContain("french.pak");
        } finally { cleanup(root); }
    });

    test("a destination that already exists, in any case, is an error", async () => {
        const { root, game, output } = fixture();
        try {
            const { code, stderr } = await makeWgb(game, output, ["--copy", "Data/Lang/english.pak=DATA/Current.PAK"]);
            expect(code).toBe(1);
            expect(stderr).toContain("already exists");
        } finally { cleanup(root); }
    });

    test("a malformed pair or a path leaving the game directory is an error", async () => {
        const { root, game, output } = fixture();
        try {
            for (const bad of ["Data/Lang/english.pak", "=Data/Locale.pak", "Data/Lang/english.pak=../escape.pak"]) {
                const { code, stderr } = await makeWgb(game, output, ["--copy", bad]);
                expect(code, bad).toBe(1);
                expect(stderr).toContain("--copy");
            }
        } finally { cleanup(root); }
    });
});
