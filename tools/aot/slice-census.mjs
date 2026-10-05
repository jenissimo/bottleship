#!/usr/bin/env node
// What fraction of real guest code does the current instruction slice cover, and what stops it?
//
//   node slice-census.mjs --exe tmp/nfsu/Speed.exe --pages 5d3,5d4,672,40c,5cb
//
// Method and its limit, stated up front: instruction boundaries come from a LINEAR sweep of
// each page, so jump tables, alignment padding and constant pools decode as instructions and
// inflate the "unsupported" side. plan/aot-compiler-design.md §1 calls exactly this out as a
// contaminated measurement. It is reported anyway because the RANKING of what blocks the slice
// is robust to that noise even when the absolute percentage is not — and the ranking is what
// decides which slice to write next.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { decodeOne } from "./lib/decode.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith("--")) continue;
    const n = process.argv[i + 1];
    if (n !== undefined && !n.startsWith("--")) { args[a.slice(2)] = n; i++; } else args[a.slice(2)] = "1";
}
const REPO = path.resolve(url.fileURLToPath(new URL(".", import.meta.url)), "../..");
const exePath = path.resolve(args.exe || path.join(REPO, "tmp/nfsu/Speed.exe"));
// trace2 per-page histogram, plan/nfsu-perf-next-10pct §8.3 (raw == virtual for this binary)
const pages = (args.pages || "5d3,5d4,672,40c,5cb").split(",").map((x) => parseInt(x, 16));
const imageBase = Number(args["image-base"] ?? 0x400000);

const exe = fs.readFileSync(exePath);
const perPage = [];
const reasons = new Map();
let total = 0, ok = 0;

for (const p of pages) {
    const va = p << 12;
    const off = va - imageBase;
    const bytes = new Uint8Array(exe.subarray(off, off + 4096));
    let n = 0, good = 0, i = 0;
    while (i < 4096) {
        const ins = decodeOne(bytes, i, va + i);
        n++;
        if (ins.kind === "unsupported" || ins.len === 0) {
            reasons.set(ins.why ?? "?", (reasons.get(ins.why ?? "?") ?? 0) + 1);
            i += 1;                       // resync a byte at a time, like a linear sweep must
        }
        else { good++; i += ins.len; }
    }
    total += n; ok += good;
    perPage.push({ page: "0x" + p.toString(16), decoded: n, inSlice: good, pct: +(good / n * 100).toFixed(1) });
}

const ranked = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([why, count]) => ({ why, count }));

console.log(JSON.stringify({
    exe: exePath, pages: pages.map((p) => "0x" + p.toString(16)),
    method: "linear sweep, 1-byte resync on a reject — contaminated by data/padding, see header",
    total: { decoded: total, inSlice: ok, pct: +(ok / total * 100).toFixed(1) },
    perPage, topRejects: ranked,
}, null, 2));
