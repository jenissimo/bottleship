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
//   measurement  — "is the ratio believable?" (steady state, spread, tier-2, fastmem). These
//                  are reported always and enforced only when a number is being claimed.

/** phase2/phase1 wall ratio must sit near 2.0, or the slope is junk. */
export const steady = (r) => {
    const ratio = r.phase_ns.p2 / r.phase_ns.p1;
    return { ratio, ok: ratio > 1.8 && ratio < 2.25 };
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
 * @param {number} [p.maxSpreadPct]
 * @returns {{gates:object[], failedDifferential:object[], failedMeasurement:object[], measurementEnforced:boolean}}
 */
export function evaluateGates({ refRuns, candRuns, candClass, reportsNumber, maxSpreadPct = 10 }) {
    const gates = [];
    const add = (id, cls, ok, value, why) => gates.push({ id, class: cls, ok, value, why });

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
    const t2 = refRuns.map((r) => r.jit?.tier2Promotions ?? 0);
    add("tier2Promotions.reference", "measurement", t2.every((n) => n > 0), t2,
        "0 ⇒ the reference was measured as TIER-1 code; production hot pages reach tier-2");
    const fm = refRuns.map((r) => r.jit?.fastmemLoadsCompiled ?? 0);
    add("fastmemLoadsCompiled.reference", "measurement", fm.every((n) => n > 0), fm,
        "0 ⇒ paging/RAM setup broke and the reference ran the TLB shape, not production's fastmem");

    const failed = gates.filter((g) => !g.ok);
    return {
        gates,
        failedDifferential: failed.filter((g) => g.class === "differential"),
        failedMeasurement: failed.filter((g) => g.class === "measurement"),
        measurementEnforced: reportsNumber,
    };
}
