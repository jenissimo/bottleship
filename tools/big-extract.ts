/**
 * EA BIG archives (SAGE: Generals, BFME, C&C3, Red Alert 3) — list, extract, or grep.
 *
 * `grep` is the reason this exists: a SAGE game's UI strings, INI tables and APT movies are all
 * RefPack-compressed inside the .big, so searching the archive bytes for a string finds nothing
 * and reads as "the game does not ship it". Every entry is decompressed before matching.
 *
 *   bun tools/big-extract.ts list  <a.big> [--filter s]
 *   bun tools/big-extract.ts x     <a.big> <out-dir> [--filter s]
 *   bun tools/big-extract.ts cat   <a.big> <entry> [out-file]
 *   bun tools/big-extract.ts grep  <needle> <a.big> [more.big ...] [--ascii|--utf16|--both]
 */
import { openSync, readSync, closeSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BigArchive, type BigSource } from "../packages/formats/src/big";

function fileSource(path: string): { source: BigSource; close: () => void } {
    const fd = openSync(path, "r");
    const size = statSync(path).size;
    return {
        source: {
            size,
            readSync(start, end) {
                const len = Math.max(0, Math.min(end, size) - start);
                const buf = Buffer.allocUnsafe(len);
                // readSync is free to come back short on a large entry; the caller checks the
                // LENGTH, which a partial read still satisfies, so the loop is the check.
                let got = 0;
                while (got < len) {
                    const n = readSync(fd, buf, got, len - got, start + got);
                    if (n <= 0) break;
                    got += n;
                }
                return new Uint8Array(buf.buffer, buf.byteOffset, got);
            },
        },
        close: () => closeSync(fd),
    };
}

function open(path: string): { big: BigArchive; close: () => void } {
    const { source, close } = fileSource(path);
    const big = new BigArchive(source);
    big.init();
    return { big, close };
}

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "";
const flagIdx = argv.findIndex((a) => a.startsWith("--"));
const flags = new Set(flagIdx >= 0 ? argv.slice(flagIdx).filter((a) => a.startsWith("--")) : []);
const filterAt = argv.indexOf("--filter");
const filter = filterAt >= 0 ? (argv[filterAt + 1] ?? "").toLowerCase() : "";
const positional = argv.slice(1).filter((a, i) => {
    if (a.startsWith("--")) return false;
    return !(filterAt >= 0 && argv[filterAt + 1] === a && argv.indexOf(a) === filterAt + 1 && i === filterAt);
});

if (cmd === "list") {
    const { big, close } = open(positional[0]!);
    for (const e of big.listEntries()) {
        if (filter && !e.name.toLowerCase().includes(filter)) continue;
        console.log(`${String(e.size).padStart(11)}  ${String(big.contentSize(e)).padStart(11)}  ${e.name}`);
    }
    console.log(`${big.listEntries().length} entries (${big.kind}); columns: stored, content, name`);
    close();
} else if (cmd === "x" || cmd === "extract") {
    const { big, close } = open(positional[0]!);
    const outDir = positional[1]!;
    let n = 0;
    for (const e of big.listEntries()) {
        if (filter && !e.name.toLowerCase().includes(filter)) continue;
        const parts = e.name.split(String.fromCharCode(92)).join("/").split("/").filter((p) => p !== "" && p !== ".");
        // A name is archive data. One `..` segment writes outside the output directory.
        if (parts.length === 0 || parts.some((p) => p === "..")) {
            console.error(`  !! refusing ${e.name}: the entry name escapes the output directory`);
            continue;
        }
        const dest = join(outDir, ...parts);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, big.read(e));
        n++;
    }
    console.log(`extracted ${n} entr${n === 1 ? "y" : "ies"} -> ${outDir}`);
    close();
} else if (cmd === "cat") {
    const { big, close } = open(positional[0]!);
    const e = big.find(positional[1]!);
    if (!e) { console.error(`entry not found: ${positional[1]}`); process.exit(1); }
    const bytes = big.read(e!);
    if (positional[2]) { writeFileSync(positional[2], bytes); console.log(`${bytes.length} bytes -> ${positional[2]}`); }
    else process.stdout.write(bytes);
    close();
} else if (cmd === "grep") {
    const needle = positional[0]!;
    const wantAscii = !flags.has("--utf16") || flags.has("--both");
    const wantUtf16 = flags.has("--utf16") || flags.has("--both");
    const patterns: Array<{ label: string; bytes: Uint8Array }> = [];
    if (wantAscii) patterns.push({ label: "ascii", bytes: new TextEncoder().encode(needle) });
    if (wantUtf16) {
        const u = new Uint8Array(needle.length * 2);
        for (let i = 0; i < needle.length; i++) { u[i * 2] = needle.charCodeAt(i) & 0xff; u[i * 2 + 1] = needle.charCodeAt(i) >> 8; }
        patterns.push({ label: "utf16", bytes: u });
    }
    const indexOf = (hay: Uint8Array, pat: Uint8Array, from: number): number => {
        outer: for (let i = from; i + pat.length <= hay.length; i++) {
            for (let j = 0; j < pat.length; j++) if (hay[i + j] !== pat[j]) continue outer;
            return i;
        }
        return -1;
    };
    let total = 0;
    for (const path of positional.slice(1)) {
        let big: BigArchive, close: () => void;
        try { ({ big, close } = open(path)); } catch (e) { console.error(`${path}: ${e}`); continue; }
        for (const e of big.listEntries()) {
            if (filter && !e.name.toLowerCase().includes(filter)) continue;
            let bytes: Uint8Array;
            // A corrupt or unknown-compression entry must not stop the sweep: say so and go on,
            // or one bad entry hides every later hit.
            try { bytes = big.read(e); } catch (err) { console.error(`  !! ${path}:${e.name}: ${err}`); continue; }
            for (const p of patterns) {
                const at = indexOf(bytes, p.bytes, 0);
                if (at < 0) continue;
                let count = 1;
                for (let i = indexOf(bytes, p.bytes, at + 1); i >= 0; i = indexOf(bytes, p.bytes, i + 1)) count++;
                console.log(`${path}  ${e.name}  [${p.label}] x${count} @0x${at.toString(16)}`);
                total += count;
            }
        }
        close();
    }
    console.log(`${total} match${total === 1 ? "" : "es"}`);
} else {
    console.log(`usage:
  bun tools/big-extract.ts list  <a.big> [--filter s]
  bun tools/big-extract.ts x     <a.big> <out-dir> [--filter s]
  bun tools/big-extract.ts cat   <a.big> <entry> [out-file]
  bun tools/big-extract.ts grep  <needle> <a.big> [more.big ...] [--ascii|--utf16|--both] [--filter s]`);
    process.exit(cmd ? 1 : 0);
}
