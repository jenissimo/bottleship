#!/usr/bin/env node
// Decoder oracle: for every instruction the slice claims to support, its decoded LENGTH must
// equal an independent disassembler's. A wrong length is the worst possible decoder bug — it
// does not throw, it silently shifts every following instruction and the unit computes
// something plausible and wrong — so it gets its own check rather than being left to the
// differential (which only ever sees the handful of instructions in the corpus).
//
//   python tools/aot/capstone-lengths.py > lengths.json    # ground truth
//   node   tools/aot/decoder-oracle.mjs --truth lengths.json
//
// The ground truth is a LINEAR sweep, so both sides see the same (occasionally nonsensical)
// byte stream; that is fine here, because the claim under test is "same bytes ⇒ same length",
// not "these bytes are code".

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
if (!args.truth) { process.stderr.write("usage: node decoder-oracle.mjs --truth <lengths.json>\n"); process.exit(2); }

const REPO = path.resolve(url.fileURLToPath(new URL(".", import.meta.url)), "../..");
const truth = JSON.parse(fs.readFileSync(path.resolve(args.truth), "utf8"));
const exe = fs.readFileSync(path.resolve(truth.exe ?? path.join(REPO, "tmp/nfsu/Speed.exe")));

let checked = 0, agreed = 0;
const mismatches = [];
const kinds = new Map();

for (const page of truth.pages) {
    const va = page.va;
    const bytes = new Uint8Array(exe.subarray(page.fileOff, page.fileOff + 4096));
    for (const [off, len, text] of page.instructions) {
        const ins = decodeOne(bytes, off, va + off);
        if (ins.kind === "unsupported") continue;
        checked++;
        kinds.set(ins.kind, (kinds.get(ins.kind) ?? 0) + 1);
        if (ins.len === len) { agreed++; continue; }
        if (mismatches.length < 25) {
            mismatches.push({
                va: "0x" + (va + off).toString(16), kind: ins.kind,
                mine: ins.len, truth: len, disasm: text,
                bytes: [...bytes.subarray(off, off + Math.max(len, ins.len))]
                    .map((x) => x.toString(16).padStart(2, "0")).join(""),
            });
        }
    }
}

const ok = mismatches.length === 0;
console.log(JSON.stringify({
    ok, checked, agreed, mismatches,
    kindHistogram: Object.fromEntries([...kinds.entries()].sort((a, b) => b[1] - a[1])),
}, null, 2));
process.exit(ok ? 0 : 1);
