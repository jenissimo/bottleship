#!/usr/bin/env bun
/**
 * Quality-gate check: every `toMatchSnapshot()` must have a snapshot to match.
 *
 * `bun test` WRITES a missing snapshot and exits 0 — with no `--ci`-style refusal in bun 1.3
 * (measured: neither `--ci` nor `CI=1` stops it). So on any checkout without the `.snap` files
 * every snapshot assertion in the suite passes vacuously: the d3d9 ALU / PS3-IO / SM3 tests can
 * be made to emit anything at all and the gate stays green. The file being present is what makes
 * those assertions assertions, and the file being TRACKED is what makes it present.
 *
 * Usage: bun tools/validate-snapshots.ts
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..");
const TESTS = join(ROOT, "tools", "tests");
const SNAPS = join(TESTS, "__snapshots__");

const users: string[] = [];
for (const entry of readdirSync(TESTS)) {
    if (!entry.endsWith(".test.ts")) continue;
    const text = readFileSync(join(TESTS, entry), "utf8");
    // Inline snapshots carry their expectation in the source, so they need no file.
    if (/\btoMatchSnapshot\s*\(/.test(text)) users.push(entry);
}

const missing = users.filter(entry => !existsSync(join(SNAPS, `${entry}.snap`)));

// Tracked, not merely present: an untracked .snap is missing on every other checkout, where the
// suite then re-writes it and passes.
let untracked: string[] = [];
const ls = spawnSync("git", ["ls-files", "--error-unmatch", "--", ...users.map(e => relative(ROOT, join(SNAPS, `${e}.snap`)))], {
    cwd: ROOT, encoding: "utf8",
});
// Outside a git checkout the tracking half cannot be answered — say so instead of reporting
// the presence check under the tracking check's name.
const gitChecked = !ls.error && ls.status !== null && !/not a git repository/i.test(ls.stderr ?? "");
if (gitChecked && ls.stderr) {
    untracked = users.filter(entry => ls.stderr.includes(`${entry}.snap`)).filter(entry => !missing.includes(entry));
}

if (missing.length || untracked.length) {
    for (const entry of missing) console.error(`  no snapshot file for ${entry} — every toMatchSnapshot() in it passes vacuously`);
    for (const entry of untracked) console.error(`  ${entry}.snap is UNTRACKED — absent on a fresh checkout, where bun writes it and the assertions pass vacuously`);
    console.error("\nCommit tools/tests/__snapshots__/*.snap (regenerate with `bun test -u` only when the change is intended).");
    process.exit(1);
}

console.log(`validate-snapshots: OK (${users.length} snapshot test file(s) with a .snap`
    + `${gitChecked ? ", all tracked)" : "; tracking NOT verified — no git checkout here)"}`);
