#!/usr/bin/env node
/**
 * Package the new compiler's unit as a publishable artifact — the P1.5 laboratory adapter.
 *
 * The unit is entered through the engine's OWN dispatch path (`wasm_table[slot + 1024]`), staged
 * by the same transaction the emulator uses. That is what makes this an adapter rather than a
 * bench: it proves the entry/exit contract against the real dispatcher, and it measures kernel,
 * guards and materialization — but NOT production publication lookup or live invalidation, which
 * this stand does not have and must not be reported as having.
 *
 * Identity is inherited from a LIVE capture (`capture-job.mjs`), never invented: the table slot,
 * the page hash, the state flags, the engine SHA and the TLB base all come from the job, so a
 * unit built against a different engine cannot be staged into this one.
 *
 *   node tools/aot/capture-job.mjs --case k3 --out tmp/job-k3.json --warmup 20000
 *   node tools/aot/opt/publish.mjs --job tmp/job-k3.json --out tmp/units/opt-k3
 *   node tools/aot-oracle/arms/run-v86.mjs --case k3 --aot tmp/units/opt-k3.json
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, basename } from "node:path";
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
const JOB = argOf("job", null);
const OUT = argOf("out", null);
const CASE = argOf("case", "k3");
/**
 * B7's bound. Production is 100003. A lower value makes the loop guard reachable inside a short
 * kernel — which is the only way to exercise the budget exit — and it is DECLARED in the manifest,
 * so a lowered bound cannot ship as if it were the shipping one.
 */
const LOOP_BOUND = argOf("loop-bound", "100003");
/**
 * Named optimizing passes, comma separated. Recorded in the manifest, so an arm is identified by
 * the artifact rather than by whoever reports its number.
 */
const PASSES = argOf("passes", "");
if (!JOB || !OUT) {
    console.error("usage: publish.mjs --job <job.json> --out <prefix> [--case k3]");
    process.exit(2);
}

const job = JSON.parse(readFileSync(JOB, "utf8"));
if (job.case !== CASE) {
    console.error(`job is for case ${job.case}, not ${CASE}`);
    process.exit(2);
}

// The code the unit implements is the code AT THE ENTRY, taken from the capture. A unit built
// from a corpus body while the entry holds a wrapper prologue runs that body with whatever the
// prologue was supposed to establish, which is a #GP with no obvious cause.
const pageBytes = Buffer.from(job.page.bytesBase64, "base64");
const entryOffset = job.page.entryOffsets[0];
const entryEip = (job.page.pageBase + entryOffset) >>> 0;
// How much of the page the region may cover. The whole tail by default; a smaller limit lowers a
// PREFIX, which is how a region that ends mid-page — and therefore hands control back on its own
// page — is produced deliberately.
const CODE_LIMIT = argOf("code-limit", null);
const codeEnd = CODE_LIMIT ? entryOffset + Number(CODE_LIMIT) : pageBytes.length;
if (!(codeEnd > entryOffset) || codeEnd > pageBytes.length) {
    console.error("--code-limit must leave at least one byte inside the page");
    process.exit(2);
}
const codeHex = pageBytes.subarray(entryOffset, codeEnd).toString("hex");

const out = execFileSync(
    "cargo",
    ["run", "--quiet", "--manifest-path", MANIFEST, "--bin", "lower_entry", "--",
        ...(PASSES ? ["--passes", PASSES] : []),
        entryEip.toString(16), codeHex, LOOP_BOUND],
    { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
const lowered = JSON.parse(out.trim().split(SPLIT_LINES).at(-1));
if (lowered.status !== "ok") {
    console.error(`lowering failed: ${lowered.why}`);
    process.exit(3);
}

const bytes = Buffer.from(lowered.hex, "hex");
const DIAGNOSTIC = lowered.passes.some((p) => p.endsWith("-diagnostic"));

// The unit's entry page must be the page the job captured, or the bytes describe code that is
// not there. Checked rather than assumed: publishing against a different page's hash is how a
// stale artifact silently takes over a live entry.
const pageBase = job.page.pageBase >>> 0;
if ((lowered.entry_eip & ~0xfff) !== pageBase) {
    console.error(`unit entry 0x${lowered.entry_eip.toString(16)} is not on the captured page `
        + `0x${pageBase.toString(16)}`);
    process.exit(3);
}

// Every block head the unit can resume at, not only the captured entry.
const entries = lowered.entries.map(([offset, index]) => [offset, index]);
const claimed = new Set(entries.map(([offset]) => offset));

/**
 * A unit OWNS its guest page, so it must be able to serve every address on that page it can hand
 * control back at.
 *
 * An exit whose continuation lies on the unit's own page but is not one of its entries makes the
 * engine dispatch there, find no entry, compile the page itself — and the compiled module then
 * owns the page, which FREES the unit. The run continues, produces the right answer, and reports
 * a published unit that stopped executing part-way through, so any timing taken there belongs to
 * the JIT.
 */
const onPageExits = (lowered.exit_eips ?? [])
    .filter((eip) => (eip & ~0xfff) === (lowered.entry_eip & ~0xfff))
    .map((eip) => eip & 0xfff)
    .filter((offset) => !claimed.has(offset));
const uncovered = [
    ...job.page.entryOffsets.filter((offset) => !claimed.has(offset)),
    ...onPageExits,
];
/**
 * Publish the hazard anyway, for the control that proves the rule above.
 *
 * The rule asserts a CONSEQUENCE in the engine, so a check that only ever refuses is an assertion
 * nobody validated. This flag builds the refused artifact so a run can demonstrate the page
 * really is taken back — and it stamps the manifest, so the artifact can never be mistaken for
 * one that passed.
 */
const HAZARD = argv.includes("--prove-on-page-exit-hazard");
if (uncovered.length && !HAZARD) {
    console.error(`the unit would hand control back at page offsets [${[...new Set(uncovered)]
        .join(", ")}] it does not serve; publishing it would hand the page to the JIT mid-run`);
    process.exit(3);
}
const report = verifyUnit(bytes, {
    bodyStart: lowered.body_start,
    entries,
    pageBase,
    relocs: lowered.relocs,
    loopCounter: Number(LOOP_BOUND),
}, {
    v86WasmPath: path.join(REPO, "vendor", "v86", "build", "v86.wasm"),
    offlineConstantsForbidden: true,
});
if (report.fail?.length) {
    console.error("REFUSED (verifier):");
    for (const f of report.fail) console.error(`  FAIL ${f.id}: ${f.why}`);
    process.exit(5);
}

const tableIndex = job.jitModuleForPage?.tableIndex;
if (!Number.isInteger(tableIndex) || tableIndex <= 0 || tableIndex >= 900) {
    console.error("job lacks a valid captured JIT table index");
    process.exit(4);
}

mkdirSync(dirname(OUT), { recursive: true });
const wasmName = `${basename(OUT)}.0.wasm`;
writeFileSync(path.join(dirname(OUT), wasmName), bytes);

const manifest = {
    tool: "aot/opt/publish",
    // A diagnostic unit answers "how much of the time is preparation", never "how fast can we
    // be": it is built by removing obligations, not by proving them away. The stamp travels with
    // the artifact because the contract verifier does NOT reject an unguarded access — it checks
    // module shape, imports, counters and exits, and an access that skips its TLB check passes
    // all 38 rules.
    ...(DIAGNOSTIC ? { diagnostic: lowered.passes.filter((p) => p.endsWith("-diagnostic")) } : {}),
    ...(uncovered.length ? { on_page_exit_hazard: [...new Set(uncovered)] } : {}),
    slice: "opt-conservative",
    case: CASE,
    compiler: {
        name: "bottleship-opt-compiler",
        lowering: lowered.passes.length ? "optimizing" : "conservative",
        passes: lowered.passes,
        ir_version: 1,
    },
    jit_flags: job.jitConfig,
    relaxed_fpu: job.relaxedFpu,
    loop_counter: Number(LOOP_BOUND),
    engine_sha256: job.engine.sha256,
    jit_identity: job.jit_identity,
    relocations: { tlb_data: job.engine.tlbDataBase },
    units: [{
        entryPage: job.page.physPage,
        tableIndex,
        file: wasmName,
        bytes: bytes.length,
        relocs: lowered.relocs,
        pages: [{
            physPage: job.page.physPage,
            stateFlags: job.page.stateFlags,
            entries,
            sha: job.page.sha256,
        }],
    }],
};
writeFileSync(`${OUT}.json`, JSON.stringify(manifest, null, 2));

console.log(JSON.stringify({
    status: "ok",
    case: CASE,
    ...(DIAGNOSTIC ? { diagnostic: true } : {}),
    manifest: `${OUT}.json`,
    wasm: path.join(dirname(OUT), wasmName),
    bytes: bytes.length,
    tableIndex,
    entries,
    imports: lowered.imports,
    verifier_checks_passed: report.pass.length,
    instructions_lifted: lowered.instructions,
    lifted_sha256: lowered.lifted_sha256,
    loop_bound: lowered.loop_bound,
    passes: lowered.passes,
    caveat: "an adapter run measures kernel, guards and materialization against the real "
        + "dispatcher; it does not measure production publication lookup or live invalidation",
}, null, 2));
