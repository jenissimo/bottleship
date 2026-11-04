/**
 * make-wgb applies a shim database only when told the installer registers it (--sdb): on
 * Windows a .sdb lying in the game folder does nothing until sdbinst installs it.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { BufferSource, ZipArchive } from "@bottleship/formats/zip";
import { buildSdb } from "./fixtures/sdb-builder";

const SHIM = "ADDREDIRECT(HKLM\\SOFTWARE\\Illusion%20Softworks\\Mafia^HKCU\\Software\\Illusion%20Softworks\\Mafia)";

function fixture(): { root: string; game: string; output: string } {
    const logs = resolve("logs"); mkdirSync(logs, { recursive: true });
    const root = mkdtempSync(join(logs, "make-wgb-sdb-"));
    const game = join(root, "game");
    mkdirSync(game);
    for (const name of ["Game.exe", "Setup.exe"]) writeFileSync(join(game, name), name);
    writeFileSync(join(game, "mafia.sdb"), buildSdb([
        { name: "Game.exe", shims: [{ name: "VirtualRegistry", cmd: SHIM }] },
        { name: "Setup.exe", shims: [{ name: "VirtualRegistry", cmd: SHIM }] },
        { name: "Other.exe", shims: [{ name: "VirtualRegistry", cmd: SHIM }] },
    ]));
    return { root, game, output: join(root, "mafia.wgb") };
}

function cleanup(root: string): void {
    if (!resolve(root).startsWith(resolve("logs") + sep)) throw new Error("Fixture outside logs");
    rmSync(root, { recursive: true, force: true });
}

async function makeWgb(game: string, output: string, extra: string[]) {
    const child = Bun.spawn(["bun", "tools/make-wgb.ts", game, output, "--game-id", "app:sdb-fixture", "--exe", "Game.exe", ...extra],
        { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
}

async function manifestOf(output: string): Promise<{ emulator?: { registryRedirects?: unknown } }> {
    const archive = new ZipArchive(new BufferSource(new Uint8Array(await Bun.file(output).arrayBuffer())));
    await archive.init();
    return JSON.parse(new TextDecoder().decode(await archive.readEntry(archive.getEntry("manifest.json")!)));
}

describe("make-wgb --sdb", () => {
    test("without the flag a found .sdb is reported, not applied", async () => {
        const { root, game, output } = fixture();
        try {
            const { code, stdout, stderr } = await makeWgb(game, output, []);
            expect(code, stderr).toBe(0);
            expect(stdout).toContain("rom/mafia.sdb");
            expect(stdout).toContain("--sdb");
            expect((await manifestOf(output)).emulator?.registryRedirects).toBeUndefined();
        } finally { cleanup(root); }
    });

    test("with the flag each shipped exe gets its own rules", async () => {
        const { root, game, output } = fixture();
        try {
            const { code, stderr } = await makeWgb(game, output, ["--sdb", "mafia.sdb"]);
            expect(code, stderr).toBe(0);
            expect(stderr).toContain("Other.exe");
            const rule = { from: "HKLM\\SOFTWARE\\Illusion Softworks\\Mafia", to: "HKCU\\Software\\Illusion Softworks\\Mafia" };
            expect((await manifestOf(output)).emulator?.registryRedirects).toEqual([
                { exe: "Game.exe", ...rule },
                { exe: "Setup.exe", ...rule },
            ]);
        } finally { cleanup(root); }
    });

    test("a --sdb that names no file in the game directory is an error", async () => {
        const { root, game, output } = fixture();
        try {
            const { code, stderr } = await makeWgb(game, output, ["--sdb", "missing.sdb"]);
            expect(code).toBe(1);
            expect(stderr).toContain("missing.sdb");
        } finally { cleanup(root); }
    });
});
