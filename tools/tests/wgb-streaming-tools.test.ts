import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { BufferSource, ZipArchive } from "@bottleship/formats/zip";
import { wgbEtag } from "../../deploy/wgb-etag";
import { WgbCache } from "../../src/worker/runtime/filesystem/wgb-cache";
import { FakeDirHandle } from "./fixtures/fake-opfs";
import { ZipStoreWriter } from "../internal/zip-store-writer";

function fixture(): string {
    const logs = resolve("logs"); mkdirSync(logs, { recursive: true });
    return mkdtempSync(join(logs, "runtime-io-tools-"));
}
function cleanup(root: string): void {
    if (!resolve(root).startsWith(resolve("logs") + sep)) throw new Error("Fixture outside logs");
    rmSync(root, { recursive: true, force: true });
}

test("add-dir replaces Windows-spelled entries without creating path aliases", async () => {
    const root = fixture(), archivePath = join(root, "assets.wgb"), assets = join(root, "assets");
    mkdirSync(assets);
    const writer = new ZipStoreWriter(archivePath);
    writer.addBuffer("Assets\\Texture.bmp", Buffer.from("old"));
    writer.finish();
    writeFileSync(join(assets, "texture.bmp"), "replacement");
    try {
        for (let i = 0; i < 2; i++) {
            const child = Bun.spawn(["bun", "tools/wgb.ts", "add-dir", archivePath, "assets", assets], { stdout: "pipe", stderr: "pipe" });
            const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
            expect(code, stderr).toBe(0);
            const zip = new ZipArchive(new BufferSource(new Uint8Array(await Bun.file(archivePath).arrayBuffer())));
            await zip.init();
            expect(zip.listEntries()).toHaveLength(1);
            const entry = zip.listEntries()[0]!;
            expect(new TextDecoder().decode(await zip.readEntry(entry))).toBe("replacement");
        }
    } finally { cleanup(root); }
});

test("local WGB ETags coalesce probes and detect a same-size rewrite", async () => {
    const root = fixture(), path = join(root, "test.wgb");
    try {
        writeFileSync(path, "abcd");
        const expected = `"${createHash("sha256").update("abcd").digest("hex")}"`;
        expect(await Promise.all([wgbEtag(path), wgbEtag(path)])).toEqual([expected, expected]);
        writeFileSync(path, "wxyz");
        utimesSync(path, new Date(), new Date(Date.now() + 1000));
        expect(await wgbEtag(path)).toBe(`"${createHash("sha256").update("wxyz").digest("hex")}"`);
    } finally { cleanup(root); }
});

test("an old full cache is rejected even when another tab prevents its removal", async () => {
    const directory = new FakeDirHandle("cache");
    const file = await directory.getFileHandle("locked.wgb", { create: true });
    file.file.data = new Uint8Array(32);
    new DataView(file.file.data.buffer).setUint32(10, 0x06054b50, true);
    const metadata = await directory.getFileHandle("locked.wgb.version.json", { create: true });
    metadata.file.data = new TextEncoder().encode(JSON.stringify({ url: "/apps/locked.wgb", size: 32, etag: '"old"' }));
    directory.removeEntry = async () => { throw new Error("reader held by another tab"); };
    const internal = WgbCache as unknown as { cacheDir: FileSystemDirectoryHandle | null };
    const previousDir = internal.cacheDir, originalFetch = globalThis.fetch;
    internal.cacheDir = directory as unknown as FileSystemDirectoryHandle;
    globalThis.fetch = (async () => new Response(null, { headers: { "Content-Length": "32", ETag: '"new"' } })) as typeof fetch;
    try { expect(await WgbCache.openSyncSourceForUrl("/apps/locked.wgb")).toBeNull(); }
    finally { WgbCache.releaseMountedSource(); internal.cacheDir = previousDir; globalThis.fetch = originalFetch; }
});

test("make-wgb applies filename order and emits a content-addressed copy", async () => {
    const root = fixture(), game = join(root, "game"), output = join(root, "example.wgb"), profile = join(root, "example.wgb.profile");
    mkdirSync(game);
    for (const name of ["a.bin", "b.bin", "game.exe"]) writeFileSync(join(game, name), name);
    writeFileSync(profile, JSON.stringify({ version: 1, size: 1000, granuleBytes: 65536, accesses: [],
        files: [{ entryName: "rom/b.bin", ms: 0, phase: "loading" }, { entryName: "rom/game.exe", ms: 1, phase: "loading" }] }));
    try {
        const process = Bun.spawn(["bun", "tools/make-wgb.ts", game, output, "--game-id", "app:io-fixture",
            "--order", profile, "--content-addressed"], { stdout: "pipe", stderr: "pipe" });
        const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
        expect(code, stderr).toBe(0);
        const bytes = new Uint8Array(await Bun.file(output).arrayBuffer());
        const archive = new ZipArchive(new BufferSource(bytes)); await archive.init();
        expect(archive.listEntries().map(e => e.name)).toEqual(["manifest.json", "registry.json", "rom/b.bin", "rom/game.exe", "rom/a.bin"]);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const immutable = join(root, `example.${hash}.wgb`);
        expect(stdout).toContain(basename(immutable));
        expect(new Uint8Array(await Bun.file(immutable).arrayBuffer())).toEqual(bytes);
    } finally { cleanup(root); }
});
