#!/usr/bin/env node
/**
 * Check the new Rust lowering's unit against the EXISTING unit verifier.
 *
 * The plan reuses `tools/aot/lib/verify.mjs` for exactly the part of the external ABI it really
 * checks. That is the fastest way for a second, independent emitter to find out it is wrong about
 * the module contract — the alternative is finding out at publication, where the failure mode is a
 * hung engine rather than a message.
 *
 * A verifier failure here is a RESULT, printed with the rule it names, not an exception.
 *
 *   node tools/aot/opt/verify-lowering.mjs [--case k3] [--json out.json]
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import path from "node:path";
import url from "node:url";

import { verifyUnit } from "../lib/verify.mjs";

const HERE = url.fileURLToPath(new URL(".", import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const MANIFEST = path.join(REPO, "tools", "aot", "opt", "compiler", "Cargo.toml");
const SPLIT_LINES = new RegExp("\\r?\\n");

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
};
const CASE = argOf("case", "k3");
const JSON_OUT = argOf("json", null);

const LOWERERS = { k3: "lower_k3" };
if (!LOWERERS[CASE]) {
    console.error(`no lowering binary for ${CASE}; known: ${Object.keys(LOWERERS).join(", ")}`);
    process.exit(2);
}

let lowered;
try {
    const out = execFileSync(
        "cargo",
        ["run", "--quiet", "--manifest-path", MANIFEST, "--bin", LOWERERS[CASE]],
        { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    lowered = JSON.parse(out.trim().split(SPLIT_LINES).at(-1));
} catch (e) {
    console.error(`lowering failed: ${String(e.stderr ?? e.message).slice(-400)}`);
    process.exit(1);
}
if (lowered.status !== "ok") {
    console.log(JSON.stringify({ status: lowered.status, why: lowered.why }, null, 2));
    process.exit(1);
}

const bytes = Uint8Array.from(lowered.hex.match(/../g).map((h) => Number.parseInt(h, 16)));

// The engine binary lets the verifier check that every imported name is actually exported —
// the difference between a unit that links and a `LinkError` at instantiation.
const v86Wasm = path.join(REPO, "vendor", "v86", "build", "v86.wasm");
const report = verifyUnit(bytes, {
    bodyStart: lowered.body_start,
    // One entry at offset 0 of its page: this lowering publishes a single entry point.
    entries: [[lowered.entry_eip & 0xfff, 0]],
    pageBase: lowered.entry_eip & ~0xfff,
    relocs: lowered.relocs,
    // B7's bound. The lowering emits no loop yet, so it declares the shipping value rather than a
    // lowered one that would let an experiment-only bound pass unnoticed.
    loopCounter: 100003,
}, {
    v86WasmPath: existsSync(v86Wasm) ? v86Wasm : undefined,
    offlineConstantsForbidden: true,
});

const failed = report.fail ?? [];
console.log(`### lowering verification — case ${CASE}`);
console.log(`bytes=${bytes.length} imports=${lowered.imports.join(", ")} relocs=${lowered.relocs.length}`);
console.log(`passed ${(report.pass ?? []).length} check(s)`);
if (!existsSync(v86Wasm)) {
    console.log("NOTE: vendor/v86/build/v86.wasm is absent, so import-name checks were SKIPPED, "
        + "not passed — a unit importing a name the engine does not export would still link-fail.");
}
for (const f of failed) console.log(`  FAIL ${f.id}: ${f.why}`);
console.log(`\n=== ${failed.length === 0 ? "PASS" : "FAIL"} — ${failed.length} rule(s) violated ===`);

if (JSON_OUT) {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify({ case: CASE, lowered: { ...lowered, hex: undefined }, report }, null, 2));
    console.log(`written: ${JSON_OUT}`);
}
process.exit(failed.length === 0 ? 0 : 1);
