#!/usr/bin/env node
// aot-oracle — corpus provenance check.
//
// The oracle's whole claim is "the same GUEST WORK through both arms". That claim is only as
// good as the corpus being what it says it is: byte-exact retail code, not something that
// drifted. This re-extracts every case body from the binary it was taken from and fails on any
// difference — the same guard `verify-kernels.mjs` gave the spike, over the case registry.
//
//   node verify-corpus.mjs [--exe tmp/nfsu/Speed.exe]
//
// Exits 0 if every case verified or was skipped for a missing binary, 1 on drift.
// A missing binary is reported as SKIPPED, never as a pass.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";
import { CASES } from "./corpus/cases.mjs";
import { KERNELS } from "./corpus/kernels.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const REPO = path.resolve(__dirname, "../..");

const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith("--")) continue;
    const next = process.argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { args[a.slice(2)] = next; i++; }
    else args[a.slice(2)] = "1";
}

const exePath = path.resolve(REPO, args.exe || "tmp/nfsu/Speed.exe");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const out = { exe: exePath, exe_present: fs.existsSync(exePath), cases: {}, ok: true };
const buf = out.exe_present ? fs.readFileSync(exePath) : null;
if (out.exe_present) out.exe_sha256 = sha(buf);

for (const [id, c] of Object.entries(CASES)) {
    const k = KERNELS[id];
    const rec = { va: "0x" + (c.provenance?.va ?? 0).toString(16), bytes: c.body.length,
        declared_sha256: c.provenance?.sha256 ?? null };

    // 1. The declared hash must describe the bytes the corpus actually ships, binary or not.
    rec.embedded_sha256 = sha(Buffer.from(c.body));
    rec.embedded_matches_declared = rec.embedded_sha256 === rec.declared_sha256;
    if (!rec.embedded_matches_declared) { rec.status = "DRIFT_IN_CORPUS"; out.ok = false; out.cases[id] = rec; continue; }

    // 2. And, when the binary is here, the bytes must still be in it at the stated offset.
    if (!out.exe_present || k?.fileOff === undefined) { rec.status = "SKIPPED_NO_BINARY"; out.cases[id] = rec; continue; }
    const slice = buf.subarray(k.fileOff, k.fileOff + c.body.length);
    rec.file_offset = "0x" + k.fileOff.toString(16);
    rec.binary_sha256 = sha(slice);
    rec.status = Buffer.compare(Buffer.from(c.body), slice) === 0 && rec.binary_sha256 === rec.declared_sha256
        ? "VERIFIED" : "DRIFT_VS_BINARY";
    if (rec.status !== "VERIFIED") out.ok = false;
    out.cases[id] = rec;
}

for (const [id, r] of Object.entries(out.cases)) {
    process.stderr.write(`${id.padEnd(6)} ${r.status.padEnd(18)} ${r.va} ${r.bytes}B ${r.embedded_sha256.slice(0, 16)}\n`);
}
if (!out.exe_present) process.stderr.write(`\n${exePath} not present — binary re-extraction SKIPPED (not passed)\n`);
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
