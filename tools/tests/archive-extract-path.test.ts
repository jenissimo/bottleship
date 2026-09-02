import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, win32 } from "path";
import { resolveArchiveExtractPath, tryResolveArchiveExtractPath } from "../internal/archive-extract-path";
import { EOCD_SIG, cdhFor, crc32Final, crc32Update, lfhFor, type OutEntry } from "../internal/zip-store-writer";

describe("archive extraction path containment", () => {
    const root = resolve("tmp", "archive-root");

    test("keeps ordinary nested entries under the root", () => {
        expect(resolveArchiveExtractPath(root, "rom/data/file.bin"))
            .toBe(resolve(root, "rom", "data", "file.bin"));
        expect(resolveArchiveExtractPath(root, "empty-dir/"))
            .toBe(resolve(root, "empty-dir"));
    });

    test.each([
        ["./rom/file.bin", ["rom", "file.bin"]],
        ["rom//file.bin", ["rom", "file.bin"]],
        ["rom/./data//file.bin", ["rom", "data", "file.bin"]],
        ["rom\\data\\file.bin", ["rom", "data", "file.bin"]],
    ])("normalises the benign Unix/DOS spelling %s", (entry, parts) => {
        expect(resolveArchiveExtractPath(root, entry)).toBe(resolve(root, ...parts));
    });

    test.each([
        ["../escape.bin", "traversal"],
        ["rom/../../escape.bin", "traversal"],
        ["rom\\..\\escape.bin", "traversal"],
        ["/absolute.bin", "absolute"],
        ["C:/absolute.bin", "absolute"],
        ["C:\\absolute.bin", "absolute"],
        ["//server/share/file.bin", "absolute"],
        ["rom/evil\0.bin", "nul"],
    ] as const)("refuses %s as %s", (entry, reason) => {
        const result = tryResolveArchiveExtractPath(root, entry);
        expect(result).toEqual({ ok: false, reason, entry });
        expect(() => resolveArchiveExtractPath(root, entry)).toThrow();
    });

    test.each(["", "./", "."])("reports an empty relative path as skippable: %p", (entry) => {
        const result = tryResolveArchiveExtractPath(root, entry);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.reason).toBe("empty");
    });

    // A slash-free, dot-free segment still escapes on win32: `resolve` reads `Q:` as a
    // drive-relative root. Only the post-resolution containment check catches it — delete
    // that block and this case returns a path on Q:.
    test("catches a drive-relative segment that the segment rules let through", () => {
        const winRoot = "C:\\archive-root";
        expect(tryResolveArchiveExtractPath(winRoot, "sub/Q:/evil.bin", win32))
            .toEqual({ ok: false, reason: "escapes-root", entry: "sub/Q:/evil.bin" });
        // The same name is an ordinary (if odd) file name on posix, and stays contained.
        expect(tryResolveArchiveExtractPath(winRoot, "sub/plain/evil.bin", win32))
            .toEqual({ ok: true, path: "C:\\archive-root\\sub\\plain\\evil.bin" });
    });
});

describe("every archive CLI shares the one containment idiom", () => {
    // A hand-rolled `startsWith(root + sep)` guard is how the idiom eroded before; the
    // import is the cheap structural proof that it has not grown back.
    test.each([
        "tools/wgb.ts",
        "tools/unshield-extract.ts",
        "tools/mpq-extract.ts",
        "tools/arc-extract.ts",
        "tools/gog-to-wgb.ts",
        "tools/cab-extract.ts",
        "tools/rar-extract.ts",
        "tools/re/bootstrap.ts",
    ])("%s imports the shared resolver", (file) => {
        const src = readFileSync(file, "utf8");
        expect(src).toMatch(/from ['"][^'"]*internal\/archive-extract-path['"]/);
        expect(src).toMatch(/\b(try)?[Rr]esolveArchiveExtractPath\(/);
    });
});

/** Store-only ZIP with hand-written names, including the ones a real Unix zipper emits. */
function writeZip(path: string, names: string[]): void {
    const chunks: Buffer[] = [];
    const entries: OutEntry[] = [];
    let off = 0;
    for (const name of names) {
        const data = Buffer.from(name.endsWith("/") ? "" : `body:${name}`);
        const crc = crc32Final(crc32Update(data));
        const nameBuf = Buffer.from(name, "utf8");
        const lfh = lfhFor(nameBuf, data.length, crc);
        entries.push({ nameBuf, size: data.length, crc, offset: off });
        chunks.push(lfh, data);
        off += lfh.length + data.length;
    }
    const cdStart = off;
    for (const e of entries) { const cdh = cdhFor(e); chunks.push(cdh); off += cdh.length; }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(off - cdStart, 12);
    eocd.writeUInt32LE(cdStart, 16);
    chunks.push(eocd);
    writeFileSync(path, Buffer.concat(chunks));
}

describe("wgb extract-dir skips a bad entry instead of abandoning the archive", () => {
    const work = mkdtempSync(join(tmpdir(), "wgb-extract-"));
    afterAll(() => rmSync(work, { recursive: true, force: true }));

    test("the prefix's own directory entry, ./ and // are not fatal; traversal is refused", () => {
        const archive = join(work, "hand.wgb");
        // "rom/" strips to an EMPTY relative path — the shape that used to throw and take
        // every remaining entry with it.
        writeZip(archive, ["rom/", "rom/./dot.bin", "rom//dbl.bin", "rom/../evil.bin", "rom/ok.bin", "rom/sub/deep.bin"]);
        const out = join(work, "out");
        mkdirSync(out, { recursive: true });

        const r = Bun.spawnSync(["bun", "tools/wgb.ts", "extract-dir", archive, "rom", out], { stdout: "pipe", stderr: "pipe" });
        const log = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
        expect(r.exitCode).toBe(0);
        expect(log).toContain("traversal");
        expect(log).toContain("1 rejected");

        for (const name of ["dot.bin", "dbl.bin", "ok.bin", join("sub", "deep.bin")]) {
            expect(existsSync(join(out, name))).toBe(true);
        }
        expect(existsSync(join(work, "evil.bin"))).toBe(false);
    });
});
