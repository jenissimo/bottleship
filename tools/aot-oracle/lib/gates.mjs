// aot-oracle — validity gates.
//
// The spike's rule, kept verbatim and extended: a run that fails a gate is reported INVALID,
// never as a number. A ratio taken from a run that was still tiering up, or that measured
// tier-1 code, or that measured a unit the engine had already freed, is not a small error —
// it is a different experiment wearing the answer's clothes.
//
// Gates come in TWO classes, and the difference is not cosmetic:
//
//   differential — "did the candidate arm run the candidate at all?" A unit that was refused
//                  (content hash, taken page, unavailable slot) or evicted leaves the JIT
//                  running the code, so the arms are the SAME implementation and identical
//                  output means nothing. Enforced ALWAYS, including in --check: otherwise a
//                  refused unit reports CORRECT off a JIT-vs-JIT comparison.
//   measurement  — "is the ratio believable?" (steady state, spread, tier-2). These
//                  are reported always and enforced only when a number is being claimed.

/** phase2/phase1 wall ratio must sit near 2.0, or the slope is junk. */
export const steady = (r) => {
    const ratio = r.phase_ns.p2 / r.phase_ns.p1;
    return { ratio, ok: ratio > 1.8 && ratio < 2.25 };
};

/**
 * `ns_per_outer` is a two-point slope, `(t2 - t1) / (n2 - n1)`. That is a RATE only if the
 * second phase — which does twice the work — cost at least as much wall time as the first.
 * When it did not (compilation inflating phase 1, a scheduler stall, `--outer 0` making the
 * denominator zero) the result comes out zero, negative or non-finite: a number that cannot
 * describe a duration.
 *
 * Today that condition also fails `steady_state` arithmetically (ns <= 0 implies p2/p1 <= 1),
 * so this gate adds no coverage — it adds the *statement*. `steady_state`'s remedy ("raise
 * --warmup") misdiagnoses a timer that went backwards, and an invariant an instrument relies
 * on without asserting is the failure mode this project keeps paying for.
 * @returns {{field:string, value:unknown}[]} empty when the arm's timing is a rate
 */
export const timingProblems = (r) => {
    const bad = [];
    const pos = (field, v) => {
        if (!(typeof v === "number" && Number.isFinite(v) && v > 0)) {
            bad.push({ field, value: typeof v === "number" ? v : (v ?? null) });
        }
    };
    pos("phase_ns.p1", r.phase_ns?.p1);
    pos("phase_ns.p2", r.phase_ns?.p2);
    pos("ns_per_outer", r.ns_per_outer);
    return bad;
};

export const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export const spreadPct = (xs) => {
    const m = median(xs);
    return m ? (Math.max(...xs) - Math.min(...xs)) / m * 100 : Infinity;
};

/**
 * @param {object} p
 * @param {object[]} p.refRuns reference-arm results, one per rep
 * @param {object[]} p.candRuns candidate-arm results, one per rep
 * @param {"unit"|"raw"} p.candClass
 * @param {boolean} p.reportsNumber whether a ratio is being claimed
 * @param {{memory_identical:boolean, state_compared:boolean, state_identical:boolean|null,
 *          first:string|null}} p.comparison the comparator's verdict — REQUIRED
 * @param {Record<string,number>} [p.requestedFlags] `--flags` overrides the run asked for
 * @param {number|null} [p.requestedRelaxed] `--relaxed` the run asked for, or null
 * @param {number} [p.maxSpreadPct]
 * @returns {{gates:object[], failedDifferential:object[], failedMeasurement:object[], measurementEnforced:boolean}}
 */
export function evaluateGates({ refRuns, candRuns, candClass, reportsNumber, comparison,
    requestedFlags = {}, requestedRelaxed = null, maxSpreadPct = 10 }) {
    const gates = [];
    const add = (id, cls, ok, value, why) => gates.push({ id, class: cls, ok, value, why });

    // ── the differential's own result is a gate, not only a verdict ───────────
    // The equality assertion belongs in the gate list with every other validity condition:
    // a consumer that decides usability from `gates_failed` must find the divergence there and
    // not only in a separate verdict field. Refusing an absent `comparison` is the same rule one
    // level up — a caller that forgets to pass it must not receive a green gate list.
    if (comparison === undefined || comparison === null) {
        throw new Error("evaluateGates: `comparison` is required — a gate list assembled without "
            + "the comparator's result would report a divergent run as fully gated");
    }
    // Every gate below is an `.every()`/`.filter()` over the reps. On an empty run they are all
    // vacuously true and the caller receives a fully green gate list for zero observations —
    // the same hole the `comparison` check above closes, one level down.
    if (!Array.isArray(refRuns) || refRuns.length === 0 || !Array.isArray(candRuns) || candRuns.length === 0) {
        throw new Error(`evaluateGates: needs at least one rep per arm (ref=${refRuns?.length ?? "none"}, `
            + `cand=${candRuns?.length ?? "none"}) — every gate is a quantifier over the reps and would pass vacuously`);
    }
    const memOk = comparison.memory_identical === true;
    // `state_compared: false` means the candidate class publishes no host-side state (a raw
    // module). That channel is then reported as UNCOMPARED and gated by state.spilled; it is
    // never silently counted as agreement here.
    const stateOk = comparison.state_compared ? comparison.state_identical === true : true;
    // `state_compared` is a single boolean over the WHOLE host-side view; the per-field
    // `uncompared` list it summarises gated nothing, so one field that could not be read on
    // both arms (a `get_eflags()` that threw) vanished from the differential while the coarse
    // flag stayed true. Between two v86-hosted arms every field is readable by construction,
    // so any entry here is a read that failed — not a modelling gap.
    const skipped = comparison.state_compared && candClass === "unit"
        ? (comparison.state_uncompared ?? []) : [];
    add("state.fields_compared", "differential", skipped.length === 0, skipped,
        "a state field went uncompared between two v86-hosted arms ⇒ that field was neither "
        + "shown equal nor reported divergent; the differential has a hole in it");

    add("output_identical", "differential", memOk && stateOk,
        { memory_identical: comparison.memory_identical,
            state_compared: comparison.state_compared,
            state_identical: comparison.state_identical ?? null,
            first_divergence: comparison.first ?? null },
        "the guest memory and/or the architectural register file differ between the arms ⇒ the "
        + "candidate computed something else; the first divergent address/register is in `value`");

    // ── the codegen shape is part of the experiment's identity ───────────────
    // A shape knob that never reached the engine turns an ablation into a rerun of the default,
    // and nothing else in the report can tell. The arms publish the shape they READ BACK, and it
    // is gated in the differential class — enforced even under --check, because "CORRECT under
    // 5=0" is a false claim if 5 was 1.
    const hosted = [["reference", refRuns]];
    if (candClass === "unit") hosted.push(["candidate", candRuns]);
    const shapeProblems = [];
    for (const [name, runs] of hosted) {
        runs.forEach((r, rep) => {
            if (!r.jit_flags) { shapeProblems.push({ arm: name, rep, why: "arm reported no jit_flags" }); return; }
            for (const [i, v] of Object.entries(requestedFlags)) {
                const got = r.jit_flags[i];
                if (got !== v) shapeProblems.push({ arm: name, rep, flag: Number(i), requested: v, effective: got ?? null });
            }
            if (requestedRelaxed !== null && r.relaxed_fpu !== requestedRelaxed) {
                shapeProblems.push({ arm: name, rep, relaxed_requested: requestedRelaxed, effective: r.relaxed_fpu ?? null });
            }
        });
    }
    add("shape.as_requested", "differential", shapeProblems.length === 0, shapeProblems,
        "a v86-hosted arm did not run the codegen shape the command line asked for ⇒ the run is not the experiment it is labelled as");

    // ── the register half of the differential must not be vacuous ────────────
    // STATE is compared like any other guest region, so if NEITHER arm ever spilled its
    // register file the comparison is two blocks of zeros reporting "identical". The image
    // zero-fills STATE precisely so that failure is detectable — this is where it is detected.
    const spill = [];
    for (const [name, runs] of [["reference", refRuns], ["candidate", candRuns]]) {
        runs.forEach((r, rep) => {
            const st = (r.regions ?? []).find((x) => x.name === "STATE");
            if (!st) { spill.push({ arm: name, rep, why: "no STATE region: this case does not compare the register file at all" }); return; }
            if (!/[1-9a-f]/.test(String(st.hex ?? ""))) {
                spill.push({ arm: name, rep, why: "STATE is all zeros: the register file was never spilled, so 'registers identical' proves nothing" });
            }
        });
    }
    add("state.spilled", "differential", spill.length === 0, spill,
        "an arm published no spilled register file ⇒ the register half of the differential is vacuous");

    if (candClass === "unit") {
        const disagree = [];
        const n = Math.min(refRuns.length, candRuns.length);
        for (let rep = 0; rep < n; rep++) {
            const a = refRuns[rep], b = candRuns[rep];
            if (JSON.stringify(a.jit_flags ?? null) !== JSON.stringify(b.jit_flags ?? null)) {
                disagree.push({ rep, reference: a.jit_flags ?? null, candidate: b.jit_flags ?? null });
            }
            if ((a.relaxed_fpu ?? null) !== (b.relaxed_fpu ?? null)) {
                disagree.push({ rep, reference_relaxed: a.relaxed_fpu ?? null, candidate_relaxed: b.relaxed_fpu ?? null });
            }
        }
        add("shape.arms_agree", "differential", disagree.length === 0, disagree,
            "the two arms ran DIFFERENT codegen shapes ⇒ any difference between them is attributable to the shape, not to the candidate");
    }

    // ── differential validity ───────────────────────────────────────────────
    if (candClass === "unit") {
        const reg = candRuns.map((r) => r.aot?.registered === true);
        add("aot.registered", "differential", reg.every(Boolean), reg,
            "the candidate unit was refused (content hash / page taken / slot unavailable) ⇒ the candidate arm ran the JIT: this is a JIT-vs-JIT comparison, not a differential");
        // Function identity in wasm_table, not "the page points at our slot": a freed slot is
        // recycled by the very next compilation, so a slot check credits the AOT unit with a
        // JIT module's work (handoff §3).
        const alive = candRuns.map((r) => r.aot?.alive === true);
        add("aot.alive", "differential", alive.every(Boolean), alive,
            "the unit was evicted before the end (handoff §2.1(3): registration does not mark the pages tier-2) ⇒ the JIT ran an unknown share of the work and the comparison cannot be attributed");
        const entered = candRuns.map((r) => r.aot?.entered === true);
        add("aot.entered", "differential", entered.every(Boolean), entered,
            "the unit was never entered ⇒ nothing of the candidate was executed");
        // A relocatable unit (design §S3) is patched at load time with values that are
        // properties of the live engine — its `tlb_data` address, and any future mem8 /
        // generation / slot. Those are re-derived from the instance after the run; a mismatch
        // means the unit executed against addresses nobody verified.
        const rel = candRuns.map((r) => r.aot_relocations).filter(Boolean);
        if (rel.length) {
            add("aot.relocations", "differential", rel.every((x) => x.ok),
                rel.map((x) => ({ applied: x.applied, measured: x.measured })),
                "a relocated engine constant did not match the value measured from the live instance");
        }
    }

    // ── measurement believability ───────────────────────────────────────────
    for (const [name, runs] of [["reference", refRuns], ["candidate", candRuns]]) {
        const nonRate = runs
            .map((r, i) => ({ rep: i, problems: timingProblems(r) }))
            .filter((x) => x.problems.length > 0);
        add(`timing_is_a_rate.${name}`, "measurement", nonRate.length === 0, nonRate,
            "a phase wall time or ns_per_outer was zero, negative or non-finite ⇒ the two-point "
            + "slope is not a rate (phase 2 does 2x the work and must not cost less than phase 1); "
            + "no ratio can be built from it");
        const bad = runs.map((r, i) => ({ rep: i, ...steady(r) })).filter((s) => !s.ok);
        add(`steady_state.${name}`, "measurement", bad.length === 0, bad,
            "phase2/phase1 must be 1.8..2.25 — raise --warmup / --warmup-calls");
        const sp = spreadPct(runs.map((r) => r.ns_per_outer));
        add(`spread_pct.${name}`, "measurement", sp <= maxSpreadPct, Number(sp.toFixed(2)),
            `median-relative spread over reps must be <= ${maxSpreadPct}% — quiet the machine`);
    }

    // The JIT-side gates have a subject only on the reference arm (a raw candidate compiles
    // nothing). Both are about WHAT was measured on the reference side, so they gate the
    // ratio regardless of the candidate class.
    // Per REP, and symmetric: tiering-on with no promotion and tiering-off with a promotion
    // both mean the reference is not the tier-1 reference it is labelled as, which
    // invalidates the ratio. A rep whose reading is absent (no jit_flags, jitFacts threw)
    // is unobservable and fails, not "0 under threshold 0".
    const tier2 = refRuns.map((r, rep) => {
        const flag = r.jit_flags?.[15] ?? r.jit_flags?.["15"];
        const promotions = r.jit?.tier2Promotions;
        return {
            rep,
            threshold: flag == null ? null : Number(flag),
            promotions: promotions == null ? null : Number(promotions),
        };
    });
    const tier2Bad = tier2.filter((x) => x.threshold == null || x.promotions == null
        || (x.threshold > 0 ? x.promotions <= 0 : x.promotions !== 0));
    add("tier2Promotions.reference", "measurement", tier2Bad.length === 0, tier2,
        "flag 15 nonzero with 0 promotions ⇒ the reference was measured as TIER-1 code; flag 15 zero "
        + "with promotions ⇒ the engine tiered anyway and this is not the tier-1 reference it is labelled as");
    // There is no fastmem gate: read-side fastmem is retired from the engine, so production
    // runs the TLB shape and a "did the fastmem shape compile" condition has no subject. The
    // store-side count still rides along in each run's `jit` facts, ungated — fastmem writes
    // are off in shipping, so zero is the expected reading there.

    const failed = gates.filter((g) => !g.ok);
    return {
        gates,
        failedDifferential: failed.filter((g) => g.class === "differential"),
        failedMeasurement: failed.filter((g) => g.class === "measurement"),
        measurementEnforced: reportsNumber,
    };
}
