#!/usr/bin/env node
// aotc — the AOT compiler front end. One compile job in, one publishable AotUnit out.
//
//   node aotc.mjs --job jobs/k3.json [--out units/k3] [--v86 vendor/v86/build/v86.wasm]
//
// Pipeline: compile (lib/emit.mjs) -> verify against the contract checklist (lib/verify.mjs)
// -> pack a manifest the oracle's publication path can consume. A verifier failure is a
// REFUSAL: nothing is written (contract N73 — a half-published unit cannot be unwound safely,
// so the only safe failure is "no unit").

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";
import { compileUnit } from "./lib/emit.mjs";
import { verifyUnit } from "./lib/verify.mjs";
import { parseModule, bodyStats } from "./lib/wdis.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const REPO = path.resolve(__dirname, "../..");

const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith("--")) continue;
    const n = process.argv[i + 1];
    if (n !== undefined && !n.startsWith("--")) { args[a.slice(2)] = n; i++; } else args[a.slice(2)] = "1";
}
if (!args.job) { process.stderr.write("usage: node aotc.mjs --job <job.json> [--out <prefix>]\n"); process.exit(2); }

const jobPath = path.resolve(args.job);
const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
const outPrefix = path.resolve(args.out || jobPath.replace(/\.json$/, "-unit"));
const v86WasmPath = path.resolve(args.v86 || path.join(REPO, "vendor/v86/build/v86.wasm"));

const pageBytes = new Uint8Array(Buffer.from(job.page.bytesBase64, "base64"));
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
if (sha256(Buffer.from(pageBytes)) !== job.page.sha256) {
    process.stderr.write("job page bytes do not match their recorded sha256\n"); process.exit(3);
}

const pageBase = job.page.pageBase;
const entryAddrs = job.page.entryOffsets.map((o) => pageBase + o);
if (!entryAddrs.length) { process.stderr.write("job has no entry offsets\n"); process.exit(3); }

let unit;
try {
    unit = compileUnit({
        pageBase, pageBytes, entryAddrs,
        stateFlags: job.page.stateFlags, jitConfig: job.jitConfig,
        // --loop-bound lowers B7's bound so a short kernel REACHES it; the differential stand then
        // proves the guard is taken and that taking it changes nothing. Production never sets it.
        loopCounter: args["loop-bound"] === undefined ? undefined : Number(args["loop-bound"]),
    });
}
catch (e) {
    process.stderr.write(`REFUSED (compile): ${e.message}\n`); process.exit(4);
}

// Every entry the engine's dispatcher publishes for this page must exist in the unit, or the
// guest can enter at an address we did not compile — the takeover path of design §4.2.
const entrySet = new Map(unit.entries);
const missing = job.page.entryOffsets.filter((o) => !entrySet.has(o));
if (missing.length) {
    process.stderr.write(`REFUSED: engine entry offsets not published by the unit: ${missing.map((x) => "0x" + x.toString(16)).join(",")}\n`);
    process.exit(4);
}

const report = verifyUnit(unit.bytes, unit, {
    v86WasmPath,
    offlineConstantsForbidden: [job.engine.mem8 >>> 0, job.engine.tlbDataBase >>> 0],
});
if (!report.ok) {
    process.stderr.write("REFUSED (verifier):\n");
    for (const f of report.fail) process.stderr.write(`  FAIL ${f.id}: ${f.why}\n`);
    process.exit(5);
}

fs.mkdirSync(path.dirname(outPrefix), { recursive: true });
const wasmName = `${path.basename(outPrefix)}.0.wasm`;
fs.writeFileSync(path.join(path.dirname(outPrefix), wasmName), Buffer.from(unit.bytes));

const manifest = {
    tool: "aot/aotc", slice: "integer-core", case: job.case,
    jit_flags: job.jitConfig, relaxed_fpu: job.relaxedFpu,
    // B7's bound, recorded so a lowered (experiment-only) bound cannot ship unnoticed.
    loop_counter: unit.loopCounter,
    engine_sha256: job.engine.sha256,
    // Values the loader patches in; the body carries a padded LEB placeholder at each site.
    relocations: { tlb_data: job.engine.tlbDataBase },
    units: [{
        entryPage: job.page.physPage,
        // null = "any free slot": this body names no wasm table index at all (contract E1),
        // so it is publishable wherever the engine has room.
        tableIndex: null,
        file: wasmName,
        bytes: unit.bytes.length,
        relocs: unit.relocs.map((r) => ({ kind: r.kind, fileOffset: r.fileOffset, width: r.width })),
        pages: [{
            physPage: job.page.physPage,
            stateFlags: job.page.stateFlags,
            entries: unit.entries,
            sha: job.page.sha256,
        }],
    }],
};
fs.writeFileSync(`${outPrefix}.json`, JSON.stringify(manifest, null, 2));

const mod = parseModule(unit.bytes);
const stats = bodyStats(unit.bytes, mod.code.instrStart, mod.code.instrEnd - 1);
console.log(JSON.stringify({
    ok: true, manifest: `${outPrefix}.json`, wasm: wasmName,
    slice: "integer-core",
    guest: {
        instructions: unit.guestInstructions, bytes: unit.guestBytes,
        blocks: unit.blocks.length,
        blockKinds: unit.blocks.reduce((a, b) => (a[b.ty] = (a[b.ty] ?? 0) + 1, a), {}),
        unsupported: unit.unsupported,
        // Empty is the healthy value: a call whose return point is not a published entry
        // dispatches to a miss on return and the JIT then displaces the unit (design §4.2/K5).
        callReturnPointsUnpublished: unit.callReturnPointsUnpublished.map((a) => "0x" + a.toString(16)),
        // Entries the unit answers that the ENGINE's dispatcher does not publish: block
        // discovery splits further than v86's `marked_as_entry`, so the candidate arm takes
        // dispatch hits where the reference would miss. Not a correctness difference (each
        // block starts at its published address, and the prologue seeds all locals — N24) but
        // it is a property any ratio must be read against, so it is counted, not assumed.
        entriesBeyondEngine: unit.entriesBeyondEngine.length,
    },
    module: {
        bytes: unit.bytes.length, bodyBytes: stats.bytes, wasmInstructions: stats.instructions,
        locals: mod.code.localCount, imports: report.imports, relocs: unit.relocs.length,
        wasmBytesPerGuestInstruction: +(stats.bytes / unit.guestInstructions).toFixed(1),
    },
    verifier: { passed: report.pass.length, failed: report.fail.length, checks: report.pass.map((p) => p.id) },
}, null, 2));
