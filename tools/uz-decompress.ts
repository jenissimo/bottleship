/**
 * uz-decompress: expand Unreal Engine 1 `.uz` packages (what `ucc decompress` does), using
 * packages/formats/src/uz.
 *
 * Usage:
 *   bun tools/uz-decompress.ts <file.uz|dir> [more...] [--out <dir>] [--delete]
 *
 * A directory argument expands every `*.uz` directly inside it. Output goes next to the input
 * (or into --out) under the name the archive recorded. --delete removes each `.uz` once its
 * output is written. An output that does not start with the Unreal package tag is an error.
 */
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, mkdirSync } from "fs";
import { basename, dirname, join } from "path";
import { decodeUz } from "@bottleship/formats/uz";

const PACKAGE_TAG = 0x9e2a83c1;

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help")) {
    console.log("Usage: bun tools/uz-decompress.ts <file.uz|dir> [more...] [--out <dir>] [--delete]");
    process.exit(args.length === 0 ? 1 : 0);
}
const outIdx = args.indexOf("--out");
const outDir = outIdx >= 0 ? args[outIdx + 1] : undefined;
const del = args.includes("--delete");
const inputs = args.filter((a, i) => !a.startsWith("--") && (outIdx < 0 || i !== outIdx + 1));

const files: string[] = [];
for (const inp of inputs) {
    if (statSync(inp).isDirectory()) {
        for (const n of readdirSync(inp)) if (n.toLowerCase().endsWith(".uz")) files.push(join(inp, n));
    } else files.push(inp);
}
if (files.length === 0) { console.error("uz-decompress: no .uz files"); process.exit(1); }
if (outDir) mkdirSync(outDir, { recursive: true });

let failed = 0;
let inBytes = 0;
let outBytes = 0;
for (const f of files.sort()) {
    try {
        const src = readFileSync(f);
        const { originalName, data } = decodeUz(src);
        const tag = data.length >= 4 ? new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true) : 0;
        if (tag !== PACKAGE_TAG) throw new Error(`output is not an Unreal package (tag 0x${tag.toString(16)})`);
        const name = basename(originalName.replace(/\\/g, "/")) || basename(f).replace(/\.uz$/i, "");
        const dst = join(outDir ?? dirname(f), name);
        writeFileSync(dst, data);
        if (del) unlinkSync(f);
        inBytes += src.length;
        outBytes += data.length;
        console.log(`  ${basename(f)} -> ${name} (${data.length} bytes)`);
    } catch (e) {
        failed++;
        console.error(`  FAIL ${f}: ${(e as Error).message}`);
    }
}
console.log(`${files.length - failed}/${files.length} decompressed, ${(inBytes / 1048576).toFixed(1)} MB -> ${(outBytes / 1048576).toFixed(1)} MB`);
process.exit(failed ? 1 : 0);
