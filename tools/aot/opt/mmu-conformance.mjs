#!/usr/bin/env node
/**
 * P0 gate: the MMU scenario matrix, run against the shipping v86 arm.
 *
 * These are real #PFs taken by the guest through a real IDT gate — not the corpus's `--fault`,
 * which mutates input bytes and proves only that the comparator notices a changed result.
 *
 * What each run has to establish is not "it faulted" but four separable facts:
 *   - the fault happened at all (`taken`, written last by the handler, so an untaken record
 *     and a run that never faulted are not the same zeros);
 *   - its IDENTITY: CR2, the error code's cause/access class, the faulting EIP;
 *   - which effects had already landed, and that nothing past the faulting instruction did;
 *   - what the page tables looked like afterwards, i.e. the accessed/dirty bits the walker
 *     wrote, which is the metadata a scoped memory proof would have to reproduce.
 *
 * Mutation proofs run last. A gate that cannot fail is worse than no gate, so each oracle is
 * fed the bypass it is meant to catch and must reject it.
 *
 *   node tools/aot/opt/mmu-conformance.mjs [--case k3] [--json out.json]
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import path from "node:path";
import url from "node:url";

import { MMU_SCENARIOS, describeErrorCode } from "../../aot-oracle/corpus/mmu.mjs";
import { CASES } from "../../aot-oracle/corpus/cases.mjs";

const HERE = url.fileURLToPath(new URL(".", import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const ARM = path.join(REPO, "tools", "aot-oracle", "arms", "run-v86.mjs");

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
};
const CASE = argOf("case", "k3");
/** The register each case advances as its destination cursor, declared by the case itself. */
const CASE_CURSOR = Object.fromEntries(
    Object.entries(CASES).map(([id, c]) => [id, c.mmuCursor ?? null]));
const JSON_OUT = argOf("json", null);
/** pf-partial-dst needs the destination to reach the next page; k3 does that at 1024 elements. */
const PARTIAL_COUNT = Number(argOf("partial-count", 1024));

function runArm({ scenario, count = null, extraEnv = {} }) {
    const env = { ...process.env, ...extraEnv };
    if (count !== null) env.AOT_ORACLE_COUNT = String(count);
    const args = [ARM, "--case", CASE, "--one-call"];
    if (scenario) args.push("--mmu", scenario);
    // The arm exits nonzero whenever the run's STATUS is not "ok" — including the useful case
    // of a scenario that expected a fault and did not take one. That JSON is the answer, not an
    // error, so stdout is parsed either way and only a genuinely unparseable run is a failure.
    let out, status = 0;
    try {
        out = execFileSync("node", args, { cwd: REPO, encoding: "utf8", env, maxBuffer: 64 << 20 });
    } catch (e) {
        out = String(e.stdout ?? "");
        status = e.status ?? -1;
        if (!out.trim()) {
            return { ok: false, error: `arm exited ${status} with no stdout: ${String(e.stderr ?? "").split("\n").slice(-6).join(" | ")}` };
        }
    }
    const last = out.trim().split("\n").at(-1);
    try { return { ok: true, raw: JSON.parse(last), exit_status: status }; } catch {
        return { ok: false, error: `arm exited ${status} and printed no JSON: ${last?.slice(0, 200)}` };
    }
}

const region = (raw, name) => raw.regions?.find((r) => r.name === name) ?? null;
/** A region's bytes as little-endian dwords, which is how every compared region is laid out. */
const dwords = (r) => (r?.hex.match(/.{8}/g) ?? [])
    .map((h) => Number.parseInt(h.match(/../g).reverse().join(""), 16) >>> 0);
const named = (r, field) => {
    const f = (r?.fields ?? []).find(([n]) => n === field);
    return f ? dwords(r)[f[1] / 4] : null;
};

const checks = [];
const skipped = [];
function check(id, ok, detail) {
    checks.push({ id, ok: Boolean(ok), detail });
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${id}${detail ? `  ${detail}` : ""}`);
    return Boolean(ok);
}
/** A scenario the case's layout cannot express. Counted and printed, never folded into PASS. */
function skip(id, reason) {
    skipped.push({ id, reason });
    console.log(`  SKIP  ${id}  ${reason}`);
}
/** The arm refuses an inapplicable scenario by name, so a skip is its verdict, not our guess. */
const inapplicable = (r) => r.ok && r.raw.status === "MMU_SCENARIO_INAPPLICABLE";

console.log(`### MMU conformance — case ${CASE}\n`);

// ── 1. clean control ──────────────────────────────────────────────────────────────────────
// Everything below compares against this: without a clean run that still computes the right
// answer, a scenario that "faulted" proves only that we broke the image.
console.log("[ad-observe] clean control + accessed/dirty metadata");
const cleanScenario = runArm({ scenario: "ad-observe" });
const cleanBare = runArm({ scenario: null });
let ok = true;
if (!cleanScenario.ok || !cleanBare.ok) {
    ok = check("clean-runs", false, cleanScenario.error ?? cleanBare.error);
} else {
    // The decisive control: installing a GDT/IDT and a fault handler must not change ANYTHING
    // the case compares. If it does, every scenario below is measuring our scaffolding. Every
    // region the bare run produced is checked, so this cannot go stale when a case is added.
    const bareRegions = cleanBare.raw.regions ?? [];
    const drift = bareRegions.filter((r) => region(cleanScenario.raw, r.name)?.sha256 !== r.sha256);
    ok &= check("scaffolding-is-transparent", bareRegions.length > 0 && drift.length === 0,
        drift.length ? `differs in: ${drift.map((r) => r.name).join(", ")}` : `${bareRegions.length} region(s) identical`);
    ok &= check("clean-verdict", cleanScenario.raw.mmu?.verdict === "AS_EXPECTED", cleanScenario.raw.mmu?.verdict);
    ok &= check("clean-took-no-fault", cleanScenario.raw.mmu?.observed.taken === 0);

    const ptes = cleanScenario.raw.mmu?.ptes ?? [];
    const codePte = ptes.find((p) => Number.parseInt(p.page, 16) === (cleanScenario.raw.mmu.patches[0]?.page ?? -1));
    // A page only fetched must be accessed and NOT dirty; a page stored to must be both. That
    // asymmetry is the whole content of the A/D contract, so it is asserted rather than dumped.
    const anyReadOnlyTouched = ptes.some((p) => p.accessed && !p.dirty);
    const anyWritten = ptes.some((p) => p.accessed && p.dirty);
    ok &= check("ad-accessed-not-dirty-exists", anyReadOnlyTouched,
        `pages read but never written: ${ptes.filter((p) => p.accessed && !p.dirty).map((p) => p.page).join(", ") || "none"}`);
    ok &= check("ad-dirty-exists", anyWritten,
        `pages written: ${ptes.filter((p) => p.dirty).map((p) => p.page).join(", ") || "none"}`);
    ok &= check("ad-no-dirty-without-accessed", !ptes.some((p) => p.dirty && !p.accessed));
    void codePte;
}

// ── 2. fault matrix ───────────────────────────────────────────────────────────────────────
const FAULT_EXPECTATIONS = {
    "pf-absent-src": { cause: "not-present", access: "read" },
    "pf-absent-dst": { cause: "not-present", access: "write" },
    "pf-readonly-dst": { cause: "protection-violation", access: "write" },
    // The same fault with the translation ALREADY CACHED and permitting reads. Every other
    // read-only scenario leaves the entry invalid, so anything that checks presence and ignores
    // writability refuses them for the wrong reason and looks correct.
    "pf-readonly-dst-cached": { cause: "protection-violation", access: "write" },
    "mapping-change-src": { cause: "not-present", access: "read" },
    "pf-absent-code": { cause: "not-present", access: "read", cr2_is_eip: true },
    "pf-partial-dst": { cause: "not-present", access: "write", count: PARTIAL_COUNT },
};

/**
 * Scenarios that must NOT fault. Each exists to make a faulting scenario mean something: without
 * them, `pf-readonly-dst` would pass on a CPU that faulted on every read-only store, and
 * `mapping-change-src` would pass without INVLPG doing anything at all.
 */
const CLEAN_CONTROLS = {
    "readonly-dst-no-wp": {
        pairs_with: "pf-readonly-dst",
        why: "a supervisor store to a read-only page does not fault without CR0.WP",
    },
    "mapping-change-src-no-invlpg": {
        pairs_with: "mapping-change-src",
        why: "the stale TLB entry keeps serving the revoked mapping until INVLPG",
    },
    "warm-clean": {
        pairs_with: "pf-readonly-dst-cached",
        why: "both data pages are cached AND permitted, so nothing declines and nothing faults",
    },
};

const results = { clean: cleanScenario.raw ?? null, scenarios: {} };
const faultEips = {};
for (const [id, want] of Object.entries(FAULT_EXPECTATIONS)) {
    const scenario = MMU_SCENARIOS[id];
    console.log(`\n[${id}] ${scenario.expect} / ${scenario.when}${scenario.wp ? " / CR0.WP" : ""}`);
    const r = runArm({ scenario: id, count: want.count ?? null });
    if (inapplicable(r)) { skip(id, r.raw.mmu.reason); continue; }
    if (!r.ok) { ok &= check(`${id}:runs`, false, r.error); continue; }
    results.scenarios[id] = r.raw;
    const m = r.raw.mmu;
    const err = describeErrorCode(m.observed.error_code);
    ok &= check(`${id}:verdict`, m.verdict === "AS_EXPECTED", m.verdict);
    ok &= check(`${id}:taken`, m.observed.taken === 1);
    ok &= check(`${id}:cause`, err?.cause === want.cause, `${err?.cause} (code 0x${m.observed.error_code.toString(16)})`);
    ok &= check(`${id}:access`, err?.access === want.access, err?.access);
    ok &= check(`${id}:cr2-is-the-patched-page`,
        (m.observed.cr2 & ~0xfff) === Number.parseInt(m.patches[0].page, 16),
        `cr2=0x${m.observed.cr2.toString(16)} patched=${m.patches[0].page}`);
    if (want.cr2_is_eip) {
        // Without CR4.PAE+NX the error code carries no I/D bit, so this equality is the only
        // available witness that the CPU faulted fetching rather than reading data.
        ok &= check(`${id}:fetch-fault-cr2-equals-eip`, m.observed.cr2 === m.observed.fault_eip,
            `cr2=0x${m.observed.cr2.toString(16)} eip=0x${m.observed.fault_eip.toString(16)}`);
    }
    faultEips[id] = m.observed.fault_eip;
}

// The read and the store are different instructions, so their faults must be at different
// EIPs. Equal ones would mean the scenarios are not actually reaching different accesses.
if (faultEips["pf-absent-src"] && faultEips["pf-absent-dst"] && faultEips["pf-readonly-dst"]) {
    console.log("\n[fault ordering]");
    ok &= check("read-faults-before-store",
        faultEips["pf-absent-src"] < faultEips["pf-absent-dst"],
        `read@0x${faultEips["pf-absent-src"].toString(16)} < store@0x${faultEips["pf-absent-dst"].toString(16)}`);
    ok &= check("readonly-and-absent-store-fault-at-the-same-instruction",
        faultEips["pf-readonly-dst"] === faultEips["pf-absent-dst"]);
}

// ── 2b. clean controls ────────────────────────────────────────────────────────────────────
for (const [id, spec] of Object.entries(CLEAN_CONTROLS)) {
    console.log(`
[${id}] control for ${spec.pairs_with}`);
    const r = runArm({ scenario: id });
    if (inapplicable(r)) { skip(id, r.raw.mmu.reason); continue; }
    // A control exists to be compared with its partner. If the partner does not apply to this
    // case, neither does the control: running it would assert "nothing faulted" against nothing,
    // which is the shape of a check that cannot fail.
    if (results.scenarios[spec.pairs_with] === undefined) {
        skip(id, `its partner ${spec.pairs_with} does not apply to this case`);
        continue;
    }
    if (!r.ok) { ok &= check(`${id}:runs`, false, r.error); continue; }
    results.scenarios[id] = r.raw;
    ok &= check(`${id}:completes-without-faulting`,
        r.raw.status === "ok" && r.raw.mmu.observed.taken === 0,
        `${spec.why} — status=${r.raw.status} taken=${r.raw.mmu.observed.taken}`);
    // The pair is only evidence if the two arms DISAGREE. Equal outcomes would mean the
    // difference between them (WP, INVLPG) changes nothing.
    const partner = results.scenarios[spec.pairs_with];
    ok &= check(`${id}:differs-from-${spec.pairs_with}`,
        partner !== undefined && partner.mmu.observed.taken === 1,
        partner ? `partner taken=${partner.mmu.observed.taken}` : "partner did not run");
    // ...and the control must still compute the right answer, or "no fault" would just mean
    // "nothing happened".
    // Compare every region the clean run produced rather than guessing which one is the
    // destination: a name-matching heuristic silently compares nothing when a case names its
    // output differently, and "nothing differed" is what that looks like.
    // The case's OWN regions only: a scenario patches a PTE and may record a fault, so PTE /
    // FAULT / SFAULT differ by construction and comparing them would make this always fail.
    const SCENARIO_OWNED = new Set(["PTE", "FAULT", "SFAULT"]);
    const cleanRegions = (cleanScenario.raw?.regions ?? []).filter((x) => !SCENARIO_OWNED.has(x.name));
    const differing = cleanRegions.filter(
        (x) => region(r.raw, x.name)?.sha256 !== x.sha256);
    ok &= check(`${id}:still-computes-the-clean-result`,
        cleanRegions.length > 0 && differing.length === 0,
        differing.length ? `differs in: ${differing.map((x) => x.name).join(", ")}`
            : `${cleanRegions.length} region(s) identical`);
}

// ── 3. completed effects at the fault ─────────────────────────────────────────────────────
// The case a restart-happy guard gets wrong: some stores already landed. The prefix must equal
// what a clean run produced, and nothing past the faulting element may have been touched.
const partial = results.scenarios["pf-partial-dst"];
if (partial) {
    console.log("\n[partial effects]");
    const cleanBig = runArm({ scenario: "ad-observe", count: PARTIAL_COUNT });
    const dstName = region(partial, "DST3") ? "DST3" : "DST4";
    const got = dwords(region(partial, dstName));
    const want = cleanBig.ok ? dwords(region(cleanBig.raw, dstName)) : [];
    // Which register carries the destination cursor is a property of the KERNEL, so the case
    // states it. Hardcoding ECX here would silently produce a wrong `done` count for any case
    // whose cursor is a different register.
    const cursorReg = CASE_CURSOR[CASE];
    const cursor = cursorReg ? named(region(partial, "SFAULT"), cursorReg) : null;
    const dstAddr = region(partial, dstName)?.addr ?? 0;
    const done = cursor === null ? null : (cursor - dstAddr) / 4;
    ok &= check("partial:cursor-at-page-boundary",
        cursor !== null && (cursor & 0xfff) === 0,
        cursorReg ? `${cursorReg}=0x${(cursor ?? 0).toString(16)}` : `case ${CASE} declares no mmuCursor`);
    ok &= check("partial:completed-prefix-matches-a-clean-run",
        done !== null && want.length >= done && got.slice(0, done).every((v, i) => v === want[i]),
        `${done} elements compared`);
    ok &= check("partial:nothing-past-the-fault-was-written",
        done !== null && got.slice(done).every((v) => v === 0),
        `${got.length - (done ?? 0)} elements after the fault`);
    // Not vacuous only if the clean run actually wrote something in the untouched tail.
    ok &= check("partial:tail-is-not-vacuously-zero",
        done !== null && want.slice(done).some((v) => v !== 0),
        "a clean run writes nonzero values past the fault point, so the zeros above mean 'not executed'");
}

// ── 4. mutation proofs ────────────────────────────────────────────────────────────────────
// Each of these deliberately breaks one premise; the corresponding oracle must notice.
console.log("\n[mutation proofs — each of these MUST be rejected]");
{
    // Expect-a-fault where none can happen: ad-observe patches nothing.
    const r = runArm({ scenario: "ad-observe" });
    ok &= check("mutation:clean-run-cannot-report-a-fault",
        r.ok && r.raw.mmu.observed.taken === 0 && r.raw.mmu.verdict === "AS_EXPECTED",
        "a clean scenario reporting taken=1 would mean the handler runs unprompted");
}
{
    // The same absent-source scenario at a count too small to reach the next page must still
    // fault on the FIRST access — proving the fault comes from the patch, not from the size.
    const r = runArm({ scenario: "pf-absent-src", count: 4 });
    ok &= check("mutation:absent-src-faults-independently-of-element-count",
        r.ok && r.raw.mmu.observed.taken === 1
        && r.raw.mmu.observed.fault_eip === faultEips["pf-absent-src"],
        `eip=0x${(r.ok ? r.raw.mmu.observed.fault_eip : 0).toString(16)}`);
}
{
    // pf-partial-dst at a count whose destination never leaves its page cannot fault for the
    // reason it names. The arm must REFUSE it rather than run it: a scenario that faults for a
    // different reason than the one on its label is the failure this whole matrix guards against.
    const r = runArm({ scenario: "pf-partial-dst", count: 64 });
    ok &= check("mutation:partial-dst-is-refused-when-the-span-stays-on-one-page",
        inapplicable(r), r.ok ? `status=${r.raw.status}` : r.error);
    ok &= check("mutation:the-refusal-names-the-span-as-the-reason",
        inapplicable(r) && /never leaves its page/.test(r.raw.mmu.reason ?? ""),
        r.ok ? String(r.raw.mmu?.reason).slice(0, 90) : "");
}
{
    // `mapping-change-src` must be distinguishable from `pf-absent-src`. They patch the same
    // page to the same value; only the touch and the INVLPG differ, so if their no-invlpg
    // control ever faulted, the two would be one fixture under two names.
    const changed = results.scenarios["mapping-change-src"];
    const control = results.scenarios["mapping-change-src-no-invlpg"];
    if (control === undefined) {
        // The control is inapplicable to this case (its kernel writes the touched page, so a
        // write re-walk faults with no INVLPG involved). Skipped, not passed: on this case the
        // mapping-change scenario is NOT distinguished from a plain absent-source one.
        skip("mutation:the-mapping-change-scenario-is-not-a-second-absent-src",
            "its no-invlpg control is inapplicable here, so the distinction is unproven for this case");
    } else {
        ok &= check("mutation:the-mapping-change-scenario-is-not-a-second-absent-src",
            changed?.mmu?.observed?.taken === 1 && control?.mmu?.observed?.taken === 0,
            `with invlpg taken=${changed?.mmu?.observed?.taken}, without it taken=${control?.mmu?.observed?.taken}`);
    }
}

// ── verdict ───────────────────────────────────────────────────────────────────────────────
const failed = checks.filter((c) => !c.ok);
console.log(`\n=== ${failed.length === 0 ? "PASS" : "FAIL"} — ${checks.length - failed.length}/${checks.length} checks ===`);
for (const f of failed) console.log(`  failed: ${f.id} ${f.detail ?? ""}`);
if (JSON_OUT) {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify({
        case: CASE, checks, skipped, passed: failed.length === 0, results,
    }, null, 2));
    console.log(`written: ${JSON_OUT}`);
}
process.exit(failed.length === 0 ? 0 : 1);
