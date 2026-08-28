#!/usr/bin/env bun
/**
 * Gate wrapper around the differential D3D9 capture comparison.
 *
 * `compare-capture.ts --reporting` exits 0 for EVERY outcome — mismatch, an unreadable capture
 * and a malformed one alike — so wiring it straight into the gate makes native-capture drift
 * invisible. This runs the same comparison and turns its verdict into an exit code:
 *
 *   unavailable / invalid  -> fail. The gate cannot be reporting-only about an answer it never got.
 *   mismatch               -> fail only on a mismatch (or missing vector) that is NOT in the
 *                             recorded baseline below. The recorded ones are the intentional
 *                             divergences of plan/dx9c-review-findings-2026-08-26.md §B2, so
 *                             today's state is green and a NEW divergence is red.
 *   pass                   -> pass.
 *
 * The ratchet is by VECTOR ID: a recorded row changing its values still passes. Tightening the
 * baseline as rows converge is the point — `--update-baseline` rewrites it.
 *
 * Usage: bun tools/gate-d3d9-capture.ts [capture.json] [--update-baseline]
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const update = args.includes("--update-baseline");
const capturePath = args.find(a => !a.startsWith("--"))
    ?? join(ROOT, "tools", "d3d9-parity", "captures", "native-d3d9-windows-current.json");
const baselinePath = join(ROOT, "tools", "d3d9-capture-expected.json");

interface Baseline { note?: string; missing: string[]; mismatches: string[] }

const run = spawnSync("bun", [join(ROOT, "tools", "d3d9-parity", "compare-capture.ts"), "--reporting", capturePath], {
    encoding: "utf8",
});
if (run.error || run.stdout === undefined) {
    console.error(`gate-d3d9-capture: could not run compare-capture (${run.error?.message ?? "no stdout"})`);
    process.exit(1);
}

let report: { status?: string; reason?: string; errors?: string[]; missing?: string[]; mismatches?: Array<{ id: string }> };
try {
    report = JSON.parse(run.stdout);
} catch {
    console.error(`gate-d3d9-capture: compare-capture did not emit a report:\n${run.stdout.slice(0, 400)}${run.stderr ?? ""}`);
    process.exit(1);
}

if (report.status === "unavailable" || report.status === "invalid") {
    console.error(`gate-d3d9-capture: capture is ${report.status} — ${report.reason ?? (report.errors ?? []).join("; ")}`);
    process.exit(1);
}

const missing = [...(report.missing ?? [])].sort();
const mismatches = [...(report.mismatches ?? []).map(m => m.id)].sort();

if (update) {
    const next: Baseline = {
        note: "Intentional D3D9 native-capture divergences (plan/dx9c-review-findings-2026-08-26.md B2). "
            + "A vector NOT listed here fails the gate; remove rows as they converge.",
        missing, mismatches,
    };
    writeFileSync(baselinePath, JSON.stringify(next, null, 2) + "\n");
    console.log(`gate-d3d9-capture: baseline written (${missing.length} missing, ${mismatches.length} mismatches)`);
    process.exit(0);
}

const baseline: Baseline = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, "utf8"))
    : { missing: [], mismatches: [] };

const newMissing = missing.filter(id => !baseline.missing.includes(id));
const newMismatches = mismatches.filter(id => !baseline.mismatches.includes(id));
const resolved = [
    ...baseline.missing.filter(id => !missing.includes(id)).map(id => `missing:${id}`),
    ...baseline.mismatches.filter(id => !mismatches.includes(id)).map(id => `mismatch:${id}`),
];

if (resolved.length) {
    console.log(`gate-d3d9-capture: ${resolved.length} recorded divergence(s) now converge — tighten the baseline `
        + `(bun tools/gate-d3d9-capture.ts --update-baseline): ${resolved.join(", ")}`);
}

if (newMissing.length || newMismatches.length) {
    console.error("gate-d3d9-capture: NEW divergence from the native D3D9 capture");
    for (const id of newMissing) console.error(`  missing vector: ${id}`);
    for (const id of newMismatches) console.error(`  mismatch: ${id}`);
    console.error(`\nRe-check the behaviour. If the divergence is intentional, record it: `
        + `bun tools/gate-d3d9-capture.ts --update-baseline`);
    process.exit(1);
}

console.log(`gate-d3d9-capture: OK (status=${report.status}; `
    + `${missing.length} missing + ${mismatches.length} mismatching vector(s), all recorded as intentional)`);
