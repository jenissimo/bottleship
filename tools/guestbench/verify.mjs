#!/usr/bin/env bun
/**
 * Verify every guestbench fixture against its own declaration.
 *
 * A fixture's `perIteration()` is a claim about what it measures — "ten memory operands,
 * eight of them stack-relative". The census can check that claim against what actually
 * retired, so this script does, for every fixture. That closes the loop the roadmap opened:
 * the last campaign optimised against a proxy demo whose instruction mix nobody had
 * verified, and here a fixture that drifts from its own description fails a script instead
 * of quietly steering a decision.
 *
 * It also checks the two properties a perf fixture is worthless without:
 *   - the checksum is STABLE across repeated runs (otherwise no A/B using it means anything);
 *   - the checksum CHANGES when a parameter changes the work (otherwise it is not an oracle
 *     for that parameter, and an arm that skipped the work would score as correct).
 *
 *   bun tools/guestbench/verify.mjs [--iterations N] [--only <fixture>]
 */

import { existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runFixture, rollupCensus, LIBV86 } from "./lib/harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, "fixtures");

if (!existsSync(LIBV86)) {
    console.log("guestbench verify: SKIP — vendor/v86/build/libv86.mjs absent (run vendor/v86/build-wasm.sh)");
    process.exit(0);
}

const argv = process.argv.slice(2);
const iterIdx = argv.indexOf("--iterations");
const ITERATIONS = iterIdx >= 0 ? Number(argv[iterIdx + 1]) : 100_000;
const onlyIdx = argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;

/** A second parameter value per fixture, used for the "checksum reacts to work" check. */
const VARIANT = {
    stack_mix: { mix: 20 },
    x87_chain: { chain: 16 },
    flags_dense: { pairs: 4 },
    branchy: { coldArms: 8 },
    heap_walk: { nodes: 24 },
};

const failures = [];
const fail = (m) => { failures.push(m); console.log(`    FAIL ${m}`); };

for (const file of readdirSync(FIXTURE_DIR).filter((n) => n.endsWith(".mjs"))) {
    const fixture = (await import(resolve(FIXTURE_DIR, file))).default;
    if (ONLY && fixture.name !== ONLY) continue;
    const params = { ...(fixture.defaults ?? {}) };
    console.log(`\n${fixture.name} (${ITERATIONS} iterations)`);

    const a = await runFixture(fixture, { iterations: ITERATIONS, params, census: true, dispatch: true });
    if (a.status !== "halt") { fail(`${fixture.name} did not halt (${a.status})`); continue; }
    const r = await rollupCensus(a.census);

    console.log(`    ${a.measured.ms.toFixed(2)} ms, ${a.measured.retired} retired, `
        + `checksum 0x${a.checksum.toString(16).padStart(8, "0")}`);

    // Coverage, with the denominator's own bias stated rather than assumed away.
    //
    // `cpu.instruction_counter` is not an exact retired-instruction count: the JIT credits
    // `block.number_of_instructions` per block EXECUTION, and on these fixtures that runs
    // measurably ahead of the instructions the loop contains — exactly one per iteration on
    // every single-block loop here (a 5-instruction loop is credited 6). So a per-instruction
    // rate taken from it is biased high by roughly 1/blockLength on tight loops, which is
    // 20% on the smallest fixture. What can be asserted is the direction (the census cannot
    // count more than ran) and that the gap stays small.
    const overhead = a.measured.retired - r.counted;
    console.log(`    counted ${r.counted}, retired ${a.measured.retired} `
        + `(counter runs ${(overhead / ITERATIONS).toFixed(3)} ahead per iteration, ${a.dispatch.blockExecution} block executions)`);
    if (overhead < -Math.max(64, Math.round(ITERATIONS * 0.002))) {
        fail(`${fixture.name}: the census counted ${-overhead} MORE than the CPU retired — it is counting twice`);
    }
    if (overhead > 0.3 * a.measured.retired) {
        fail(`${fixture.name}: ${overhead} of ${a.measured.retired} retired instructions are uncounted `
            + "(>30%). The measured window is supposed to be fully compiled, so this is blocks running "
            + "without counters, not the counter's block-credit bias.");
    }

    // The two memory feeds are produced independently; they must agree.
    if (r.addrTotal !== r.memoryOps) {
        fail(`${fixture.name}: addressing census ${r.addrTotal} vs opcode census ${r.memoryOps} memory operands`);
    }

    const declared = fixture.perIteration ? fixture.perIteration(params) : null;
    if (declared) {
        const tol = Math.max(64, Math.round(ITERATIONS * 0.002));
        if (declared.memoryOps !== undefined) {
            const want = declared.memoryOps * ITERATIONS;
            const got = r.memoryOps;
            console.log(`    memory operands: ${got} (declared ${want})`);
            if (Math.abs(got - want) > tol) {
                fail(`${fixture.name}: ${got} memory operands, declares ${want} per ${ITERATIONS} iterations. `
                    + "The fixture's description and the code have drifted apart.");
            }
        }
        for (const [form, per] of Object.entries(declared.addr ?? {})) {
            const want = per * ITERATIONS;
            const got = r.byAddr.get(form) ?? 0;
            console.log(`    addr ${form}: ${got} (declared ${want})`);
            if (Math.abs(got - want) > tol) fail(`${fixture.name}: addr ${form} = ${got}, declares ${want}`);
        }
        if (declared.x87) {
            for (const [kind, per] of Object.entries(declared.x87)) {
                const want = per * ITERATIONS;
                const got = r.byClass.get(`x87.${kind}`) ?? 0;
                console.log(`    x87.${kind}: ${got} (declared ${want})`);
                if (Math.abs(got - want) > tol) fail(`${fixture.name}: x87.${kind} = ${got}, declares ${want}`);
            }
        }
    } else {
        console.log("    (no perIteration declaration to check)");
    }

    // Stability: the same arm twice must produce the same checksum, or nothing built on it
    // can distinguish a real difference from run-to-run noise in the work itself.
    const again = await runFixture(fixture, { iterations: ITERATIONS, params });
    if (again.checksum !== a.checksum) {
        fail(`${fixture.name}: checksum is not reproducible (0x${a.checksum.toString(16)} then 0x${again.checksum.toString(16)})`);
    }

    // Reactivity: a parameter that changes the work must change the checksum, or the
    // checksum is not an oracle for the arm it is meant to police.
    const variant = VARIANT[fixture.name];
    if (variant) {
        const v = await runFixture(fixture, { iterations: ITERATIONS, params: { ...params, ...variant } });
        const spec = Object.entries(variant).map(([k, x]) => `${k}=${x}`).join(",");
        console.log(`    variant ${spec}: checksum 0x${v.checksum.toString(16).padStart(8, "0")}`);
        if (v.checksum === a.checksum) {
            fail(`${fixture.name}: ${spec} did not change the checksum, so the checksum cannot tell an arm that `
                + "did the work from one that did not");
        }
    }
}

if (failures.length > 0) {
    console.log(`\nguestbench verify: FAIL (${failures.length})`);
    process.exit(1);
}
console.log("\nguestbench verify: OK");
