#!/usr/bin/env bun
/**
 * Gate step: `tlb_data` has exactly ONE writer.
 *
 * The permission bitmap (vendor/v86/src/rust/cpu/perm_map.rs) is a mirror of `tlb_data`,
 * and generated code reads the mirror instead of the source. A drift between them does not
 * crash: the guest reads the wrong page, or a revoked page keeps being served out of a
 * compiled block, and nothing anywhere notices. The differential
 * (`tools/perm-map-differential.mjs`) can catch a drift that a test happens to exercise;
 * only a structural rule can stop one being introduced.
 *
 * The rule is the same shape the project already uses for JIT invalidation
 * (validate-guest-code-writes): `cpu::set_tlb_entry` writes both tables in one statement
 * and is the only place allowed to assign `tlb_data[...]`. Reads are unrestricted.
 *
 * Run: bun tools/validate-tlb-mirror.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const RUST_DIR = resolve(REPO, "vendor/v86/src/rust");
const OWNER = "cpu/cpu.rs";
const OWNER_FN = "set_tlb_entry";

if (!existsSync(RUST_DIR)) {
    console.log("validate-tlb-mirror: SKIP — vendor/v86 not checked out");
    process.exit(0);
}

/** Every .rs under the v86 crate. */
function* walk(dir) {
    const { readdirSync, statSync } = require("node:fs");
    for (const e of readdirSync(dir)) {
        const full = resolve(dir, e);
        if (statSync(full).isDirectory()) yield* walk(full);
        else if (e.endsWith(".rs")) yield full;
    }
}

// `tlb_data[<anything>] =` in any assignment spelling — plain or compound (`&=`, `|=`, ...)
// but not `==`. A ban on the plain spelling alone is a ban on a spelling: the one second
// writer in the tree clears TLB_HAS_CODE with `&=`, and a regex anchored on `] =` reads
// that file as clean and prints "OK (1 assignment)".
const ASSIGN = /\btlb_data\s*\[[^\]]*\]\s*(?:<<|>>|[-+*\/%&|^])?=(?!=)/;

const violations = [];
let ownerAssignments = 0;

for (const file of walk(RUST_DIR)) {
    const rel = file.slice(RUST_DIR.length + 1).split("\\").join("/");
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    // The owner's own assignment is the point of the rule; find its body so an assignment
    // added ELSEWHERE in cpu.rs is still a violation.
    let inOwner = false, depth = 0;
    lines.forEach((line, i) => {
        if (rel === OWNER) {
            if (!inOwner && new RegExp(`fn\\s+${OWNER_FN}\\s*\\(`).test(line)) { inOwner = true; depth = 0; }
            if (inOwner) {
                depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
            }
        }
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;    // comments may name it
        if (ASSIGN.test(line)) {
            if (rel === OWNER && inOwner) ownerAssignments++;
            else violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
        if (inOwner && depth <= 0 && /\}/.test(line)) inOwner = false;
    });
}

if (ownerAssignments === 0) {
    console.error("validate-tlb-mirror: FAIL");
    console.error(`  - ${OWNER} has no \`tlb_data[...] =\` inside \`${OWNER_FN}\`. Either the owner was renamed or`);
    console.error("    the mirror is no longer written where the source is — this check cannot pass vacuously.");
    process.exit(1);
}

if (violations.length > 0) {
    console.error("validate-tlb-mirror: FAIL");
    console.error(`  \`tlb_data\` must be assigned only by \`cpu::${OWNER_FN}\`, which writes the permission`);
    console.error("  bitmap in the same statement. A second writer desyncs the mirror silently:");
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
}

console.log(`validate-tlb-mirror: OK (${ownerAssignments} assignment(s), all inside cpu::${OWNER_FN})`);
