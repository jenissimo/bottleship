#!/usr/bin/env node
/**
 * Can the browser report's acceptance gate FAIL?
 *
 * The gate decides whether a browser number may be quoted as a result, and its own failure paths
 * are the ones a real run is least likely to exercise: a machine that stays quiet and a unit that
 * keeps its page produce a PASS every time, and nothing then says whether the refusals work. So
 * each refusal is fed the shape it exists for, through `--replay`, and is required to withhold.
 *
 * The shapes are the ones that would otherwise read as a result: a unit freed part-way through a
 * round with the rest of the time served by the ordinary JIT, a unit published and never entered,
 * a "reference" arm that is a second candidate, and two arms that did different work.
 *
 *   node tools/aot/opt/browser-gate-selftest.mjs
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const HERE = url.fileURLToPath(new URL(".", import.meta.url));
const REPORT = path.join(HERE, "browser-report.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aot-gate-"));

/** A published unit that is alive, owns its page and was entered — the healthy end state. */
const live = (over = {}) => ({
    registered: true, alive: true, entered: true, sameFn: true, ownsPage: true,
    units: 1, entries: 4096, executions: null, per_unit: [], ...over,
});
/** One arm's sample: a steady phase pair, the same work, and whatever AOT state is being tested. */
const arm = (ns, aot = null, state = { eax: 1 }) => ({
    ns_per_outer: ns,
    phase_ns: { p1: 1_000_000, p2: 2_000_000 },
    regions: [{ name: "out", addr: 0x1000, len: 4, hex: "01020304" }],
    state,
    aot,
});
const run = (rounds) => ({ status: "ok", rounds });
const healthy = () => Array.from({ length: 5 }, () => ({
    reference: arm(100), unit: arm(100, live()),
}));

const judge = (name, doc) => {
    const file = path.join(TMP, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(doc));
    try {
        const out = execFileSync("node", [REPORT, "--replay", file], { encoding: "utf8" });
        return { code: 0, out };
    } catch (e) {
        return { code: e.status ?? -1, out: String(e.stdout ?? "") };
    }
};

const checks = [];
const check = (id, ok, detail) => {
    checks.push(ok);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${id}${detail ? `  ${detail}` : ""}`);
};

console.log("### browser gate self-test — every refusal, fed the shape it refuses\n");

// The positive control FIRST: without it every refusal below is satisfied by a gate that
// withholds unconditionally.
{
    const r = judge("healthy", run(healthy()));
    check("a healthy run is accepted", r.code === 0 && r.out.includes("=== PASS"),
        `exit ${r.code}`);
}

// The defect this gate was rebuilt for: the unit ran, was freed, and the rest of the round was
// served by the ordinary JIT. A total entry count is positive and the time is the baseline's.
{
    const rounds = healthy();
    rounds[2].unit.aot = live({ ownsPage: false, alive: false, entered: false });
    const r = judge("freed-mid-round", run(rounds));
    check("a unit that lost its page mid-run is refused",
        r.code === 1 && /round 2: unit not ownsPage\/entered/.test(r.out), `exit ${r.code}`);
}

// Published, alive, never entered: the candidate arm is the baseline under another name.
{
    const rounds = healthy();
    for (const round of rounds) round.unit.aot = live({ entries: 0, entered: false });
    const r = judge("never-entered", run(rounds));
    check("a unit that was never entered is refused",
        r.code === 1 && /never entered/.test(r.out), `exit ${r.code}`);
}

// A "reference" arm carrying a unit: the round has no baseline in it.
{
    const rounds = healthy();
    rounds[0].reference.aot = live();
    const r = judge("reference-has-a-unit", run(rounds));
    check("a reference arm that published a unit is refused",
        r.code === 1 && /reference arm published a unit/.test(r.out), `exit ${r.code}`);
}

// Two arms that did different work: the ratio is between two different jobs.
{
    const rounds = healthy();
    rounds[1].unit = arm(100, live(), { eax: 2 });
    const r = judge("arms-disagree", run(rounds));
    check("arms that computed different things are refused",
        r.code === 1 && /arms disagree/.test(r.out), `exit ${r.code}`);
}

// And the machine gate itself, which the rounds above deliberately keep quiet.
{
    const rounds = healthy();
    rounds[4].unit = arm(400, live());
    const r = judge("wandering-machine", run(rounds));
    check("a wandering paired ratio is refused",
        r.code === 1 && /paired-ratio spread/.test(r.out), `exit ${r.code}`);
}

fs.rmSync(TMP, { recursive: true, force: true });
const failed = checks.filter((ok) => !ok).length;
console.log(`\n=== ${failed === 0 ? "PASS" : "FAIL"} — ${checks.length - failed}/${checks.length} checks ===`);
process.exit(failed === 0 ? 0 : 1);
