// aot-oracle — self-test of the oracle's own logic.
//
// An oracle that cannot fail is worthless: every assertion here injects a divergence and
// checks that the comparator NAMES it, and every gate is checked in its failing state. Runs
// in-process in milliseconds — no v86, no candidate, no timing.
//
//   node oracle.mjs --self-test

import crypto from "node:crypto";
import { compareRegions, compareState, describeFirst } from "./compare.mjs";
import { evaluateGates } from "./gates.mjs";
import { readCandidateStateBlock, STATE_BLOCK_MAGIC, STATE_BLOCK_ABI, REG_NAMES } from "./state.mjs";
import { parseArgs, parseFlagOverrides } from "./args.mjs";
import * as L from "../corpus/layout.mjs";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

function region(name, addr, bytes, fields = null) {
    const b = Buffer.from(bytes);
    return { name, addr, len: b.length, fields, sha256: sha(b), hex: b.toString("hex") };
}

function v86State(over = {}) {
    const regs = {};
    REG_NAMES.forEach((r, i) => { regs[r] = 0x1000 + i; });
    return {
        source: "v86", regs, eip: 0x101234, eflags: 0x246,
        lazy: { flags: 0x246, flags_changed: 0, last_op1: 1, last_result: 0, last_op_size: 31 },
        fpu: { stack_ptr: 0, stack_empty: 0xff, control_word: 0x37f, status_word: 0, simd_dirty: 0, st: new Array(32).fill(0) },
        simd: { mxcsr: 0x1f80, xmm: new Array(32).fill(0) },
        instruction_counter: 12345,
        ...over,
    };
}

/** A fake candidate module: just enough exports for readCandidateStateBlock. */
function fakeCandidate({ magic = STATE_BLOCK_MAGIC, abi = STATE_BLOCK_ABI, withBlock = true } = {}) {
    const memory = { buffer: new ArrayBuffer(4096) };
    const dv = new DataView(memory.buffer);
    const p = 256;
    dv.setUint32(p, magic, true);
    dv.setUint32(p + 4, abi, true);
    REG_NAMES.forEach((_, i) => dv.setUint32(p + 8 + i * 4, 0x2000 + i, true));
    dv.setUint32(p + 40, 0xdeadbeef, true);   // eip
    dv.setUint32(p + 44, 0x202, true);        // eflags
    dv.setUint32(p + 140, 999, true);         // instruction_counter
    const ex = { memory, bs_state_abi: () => abi, bs_state_ptr: () => p };
    if (!withBlock) { delete ex.bs_state_ptr; delete ex.bs_state_abi; }
    return ex;
}

export function runSelfTest() {
    const tests = [];
    const t = (name, fn) => {
        try { const detail = fn(); tests.push({ name, ok: true, detail: detail ?? null }); }
        catch (e) { tests.push({ name, ok: false, detail: String(e.message ?? e) }); }
    };
    const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };

    // ── memory comparison ───────────────────────────────────────────────────
    t("identical regions compare identical", () => {
        const a = [region("DST1", L.DST1, [1, 2, 3, 4])];
        const b = [region("DST1", L.DST1, [1, 2, 3, 4])];
        eq(compareRegions(a, b).identical, true, "identical");
    });

    t("a one-byte data divergence is reported at its guest address", () => {
        const a = [region("DST1", L.DST1, [1, 2, 3, 4, 5, 6, 7, 8])];
        const b = [region("DST1", L.DST1, [1, 2, 3, 4, 5, 0x99, 7, 8])];
        const r = compareRegions(a, b);
        eq(r.identical, false, "identical");
        eq(r.first.guest_addr, "0x" + (L.DST1 + 5).toString(16), "guest_addr");
        eq(r.first.ref_byte, "0x06", "ref_byte");
        eq(r.first.cand_byte, "0x99", "cand_byte");
        eq(r.first.differing_bytes, 1, "differing_bytes");
        return r.first.guest_addr;
    });

    t("a divergence inside the spilled register file is named by REGISTER", () => {
        const base = new Uint8Array(L.STATE_LEN);
        const dv = new DataView(base.buffer);
        for (let i = 0; i < 9; i++) dv.setUint32(i * 4, 0x11111111 * (i + 1), true);
        const mut = new Uint8Array(base);
        new DataView(mut.buffer).setUint32(0x0c, 0xBADC0DE, true);      // ebx
        const r = compareRegions([region("STATE", L.STATE, base, L.STATE_FIELDS)],
            [region("STATE", L.STATE, mut, L.STATE_FIELDS)]);
        eq(r.identical, false, "identical");
        eq(r.first.field, "ebx", "field");
        eq(r.first.guest_addr, "0x" + (L.STATE + 0x0c).toString(16), "guest_addr");
        const human = describeFirst(r.first, null);
        if (!human.includes("STATE.ebx")) throw new Error(`human summary lost the register name: ${human}`);
        return human;
    });

    t("eflags divergence is named, not swallowed into a byte offset", () => {
        const base = new Uint8Array(L.STATE_LEN);
        const mut = new Uint8Array(L.STATE_LEN);
        new DataView(mut.buffer).setUint32(0x20, 0x246, true);
        const r = compareRegions([region("STATE", L.STATE, base, L.STATE_FIELDS)],
            [region("STATE", L.STATE, mut, L.STATE_FIELDS)]);
        eq(r.first.field, "eflags", "field");
    });

    t("a region the candidate never produced is a failure, not a pass", () => {
        const r = compareRegions([region("STATE", L.STATE, new Uint8Array(4))], []);
        eq(r.identical, false, "identical");
        eq(r.regions[0].status, "MISSING_IN_CANDIDATE", "status");
    });

    // ── architectural state comparison ──────────────────────────────────────
    t("identical host state compares identical", () => {
        eq(compareState(v86State(), v86State()).identical, true, "identical");
    });

    t("a register divergence is reported first, by name", () => {
        const b = v86State();
        b.regs.ecx = 0xFFFF;
        const r = compareState(v86State(), b);
        eq(r.identical, false, "identical");
        eq(r.first.field, "ecx", "field");
        return `${r.first.field} ${r.first.ref} vs ${r.first.cand}`;
    });

    t("a lazy-flag tuple divergence is caught even when get_eflags agrees", () => {
        // The exact hazard G1 exists for: identical materialized EFLAGS, incoherent tuple.
        const b = v86State();
        b.lazy.last_op_size = 7;
        const r = compareState(v86State(), b);
        eq(r.identical, false, "identical");
        eq(r.first.field, "lazy.last_op_size", "field");
    });

    t("an x87 slot divergence is caught", () => {
        const b = v86State();
        b.fpu.st = b.fpu.st.slice(); b.fpu.st[3] = 0x7FFE;
        const r = compareState(v86State(), b);
        eq(r.first.field, "fpu.st[3]", "field");
    });

    t("instruction_counter divergence is caught", () => {
        const b = v86State(); b.instruction_counter = 12346;
        eq(compareState(v86State(), b).first.field, "instruction_counter", "field");
    });

    t("no candidate state ⇒ 'unavailable', never 'equal'", () => {
        const r = compareState(v86State(), null);
        eq(r.available, false, "available");
        eq(r.identical, null, "identical");
    });

    t("fields the candidate does not model are listed as UNCOMPARED, not equal", () => {
        const b = v86State();
        b.simd = { mxcsr: null, xmm: null };
        b.fpu = { ...b.fpu, control_word: null, status_word: null, simd_dirty: null };
        const r = compareState(v86State(), b);
        eq(r.identical, true, "identical");
        if (!r.uncompared.includes("simd.mxcsr")) throw new Error(`uncompared list lost simd.mxcsr: ${r.uncompared}`);
        return r.uncompared.join(",");
    });

    // ── candidate state block ABI ───────────────────────────────────────────
    t("state block is parsed from a candidate that publishes one", () => {
        const s = readCandidateStateBlock(fakeCandidate());
        eq(s.regs.eax, 0x2000, "eax");
        eq(s.eip, 0xdeadbeef, "eip");
        eq(s.eflags, 0x202, "eflags");
        eq(s.instruction_counter, 999, "instruction_counter");
    });
    t("a candidate without a state block yields null (and the STATE region still gates it)", () => {
        eq(readCandidateStateBlock(fakeCandidate({ withBlock: false })), null, "null");
    });
    t("a wrong state-block magic is an error, not a zero-filled snapshot", () => {
        let threw = false;
        try { readCandidateStateBlock(fakeCandidate({ magic: 0xDEAD })); } catch { threw = true; }
        eq(threw, true, "threw");
    });
    t("a state-block ABI mismatch is an error", () => {
        let threw = false;
        try { readCandidateStateBlock(fakeCandidate({ abi: 99 })); } catch { threw = true; }
        eq(threw, true, "threw");
    });

    // ── validity gates ──────────────────────────────────────────────────────
    const okRun = (over = {}) => ({
        phase_ns: { p1: 1000, p2: 2000 }, ns_per_outer: 100,
        jit: { tier2Promotions: 3, speculatedStoresCompiled: 12 },
        // The shape the arm READ BACK out of the engine; the shape gates compare this with what
        // the command line asked for, and with the other arm's.
        jit_flags: { 5: 1, 9: 1, 15: 19200000, 19: 0, 21: 0 }, relaxed_fpu: 1,
        // A spilled register file: without one, "registers identical" is two zero blocks.
        regions: [{ name: "STATE", addr: L.STATE, len: L.STATE_LEN, hex: "01000000".repeat(9) }],
        aot: { registered: true, alive: true, entered: true }, ...over,
    });
    // Both classes together: a self-test must not care WHICH bucket a gate failed in, only
    // that it failed. (The two buckets differ in when they are ENFORCED — oracle.mjs's job.)
    const gateIds = (g) => [...g.failedDifferential, ...g.failedMeasurement].map((x) => x.id);

    // Every gate call must carry the comparator's result (gates.mjs refuses one that does not),
    // so the gate tests supply an "everything agreed" comparison unless they are testing the
    // equality gate itself.
    const CMP_IDENTICAL = { memory_identical: true, state_compared: true, state_identical: true, first: null };
    const gatesOf = (p) => evaluateGates({ comparison: CMP_IDENTICAL, ...p });

    t("a clean run fails no gate", () => {
        const g = gatesOf({ refRuns: [okRun()], candRuns: [okRun()], candClass: "unit", reportsNumber: true });
        eq(gateIds(g).length, 0, "failed gates");
    });
    t("a memory divergence fails the output_identical gate and the gate names the address", () => {
        const g = gatesOf({ refRuns: [okRun()], candRuns: [okRun()], candClass: "unit", reportsNumber: true,
            comparison: { memory_identical: false, state_compared: true, state_identical: true,
                first: "DST3 @ guest 0x1108fc: ref 0x1 vs candidate 0x0" } });
        const ids = g.failedDifferential.map((x) => x.id);
        if (!ids.includes("output_identical")) throw new Error(ids.join(","));
        const v = g.gates.find((x) => x.id === "output_identical").value;
        if (!String(v.first_divergence).includes("0x1108fc")) throw new Error(JSON.stringify(v));
        return v.first_divergence;
    });
    t("a register-only divergence fails the same gate (memory identical is not enough)", () => {
        const g = gatesOf({ refRuns: [okRun()], candRuns: [okRun()], candClass: "unit", reportsNumber: true,
            comparison: { memory_identical: true, state_compared: true, state_identical: false,
                first: "STATE.esi (guest 0x10c318): ref 0x10c240 vs candidate 0x10c230" } });
        if (!g.failedDifferential.map((x) => x.id).includes("output_identical")) throw new Error(gateIds(g).join(","));
    });
    t("host state the candidate cannot publish is not counted as agreement either way", () => {
        // A raw candidate publishes no host-side state: that channel is UNCOMPARED (reported,
        // and gated by state.spilled), so it must neither pass nor fail output_identical.
        const g = gatesOf({ refRuns: [okRun()], candRuns: [okRun({ aot: null })], candClass: "raw", reportsNumber: true,
            comparison: { memory_identical: true, state_compared: false, state_identical: null, first: null } });
        eq(gateIds(g).length, 0, "failed gates");
        eq(g.gates.find((x) => x.id === "output_identical").value.state_compared, false, "state_compared");
    });
    t("a gate list assembled without the comparator's result is refused, not reported green", () => {
        let threw = null;
        try { evaluateGates({ refRuns: [okRun()], candRuns: [okRun()], candClass: "unit", reportsNumber: true }); }
        catch (e) { threw = e; }
        if (!threw) throw new Error("a missing `comparison` produced a gate list");
        if (!threw.message.includes("comparison")) throw new Error(threw.message);
        return threw.message.split(" — ")[0];
    });
    t("not-steady-state fails the gate", () => {
        const g = gatesOf({ refRuns: [okRun({ phase_ns: { p1: 1000, p2: 1200 } })], candRuns: [okRun()], candClass: "raw", reportsNumber: true });
        if (!gateIds(g).includes("steady_state.reference")) throw new Error(gateIds(g).join(","));
    });
    t("a negative ns/outer is refused as 'not a rate', not diagnosed as warm-up", () => {
        // The condition observed on k6: phase 2 (2x the work) came back CHEAPER than phase 1, so
        // the slope is negative. steady_state also fails here, but its remedy is the wrong one.
        const g = gatesOf({ refRuns: [okRun({ phase_ns: { p1: 2000, p2: 1000 }, ns_per_outer: -857 })],
            candRuns: [okRun()], candClass: "raw", reportsNumber: true });
        const ids = gateIds(g);
        if (!ids.includes("timing_is_a_rate.reference")) throw new Error(ids.join(","));
        const v = g.gates.find((x) => x.id === "timing_is_a_rate.reference").value;
        return JSON.stringify(v[0].problems.map((p) => p.field));
    });
    t("a zero-denominator (non-finite) ns/outer is refused too", () => {
        const g = gatesOf({ refRuns: [okRun()], candRuns: [okRun({ ns_per_outer: Infinity })],
            candClass: "raw", reportsNumber: true });
        if (!gateIds(g).includes("timing_is_a_rate.candidate")) throw new Error(gateIds(g).join(","));
    });
    t("tier2Promotions == 0 fails the gate (tier-1 code was measured)", () => {
        const g = gatesOf({ refRuns: [okRun({ jit: { tier2Promotions: 0, speculatedStoresCompiled: 9 } })], candRuns: [okRun()], candClass: "raw", reportsNumber: true });
        if (!gateIds(g).includes("tier2Promotions.reference")) throw new Error(gateIds(g).join(","));
    });
    // The other direction of the same gate: shipping runs with tiering OFF, so "0 promotions"
    // is the expected reading there and a promotion is the anomaly.
    const tier2Off = (over = {}) => okRun({ jit_flags: { 5: 1, 15: 0, 19: 0, 21: 0 }, ...over });
    t("tier-2 off with 0 promotions passes (the gate is not one-sided)", () => {
        const run = tier2Off({ jit: { tier2Promotions: 0, speculatedStoresCompiled: 12 } });
        const g = gatesOf({ refRuns: [run], candRuns: [run], candClass: "raw", reportsNumber: true });
        eq(gateIds(g).length, 0, "failed gates");
    });
    t("tier-2 off with promotions > 0 fails the gate (not the tier-1 reference it claims)", () => {
        const g = gatesOf({ refRuns: [tier2Off({ jit: { tier2Promotions: 4, speculatedStoresCompiled: 12 } })],
            candRuns: [okRun()], candClass: "raw", reportsNumber: true });
        if (!gateIds(g).includes("tier2Promotions.reference")) throw new Error(gateIds(g).join(","));
    });
    t("a rep with no tier-2 reading fails the gate rather than reading as 0 under threshold 0", () => {
        for (const bad of [okRun({ jit: { error: "jitFacts threw", tier2Promotions: null } }),
            okRun({ jit_flags: undefined })]) {
            const g = gatesOf({ refRuns: [bad], candRuns: [okRun()], candClass: "raw", reportsNumber: true });
            if (!gateIds(g).includes("tier2Promotions.reference")) throw new Error(gateIds(g).join(","));
        }
    });
    t("one rep with tiering off does not disarm the gate for the others", () => {
        const g = gatesOf({
            refRuns: [okRun({ jit: { tier2Promotions: 0, speculatedStoresCompiled: 12 } }),
                tier2Off({ jit: { tier2Promotions: 0, speculatedStoresCompiled: 12 } })],
            candRuns: [okRun(), okRun()], candClass: "raw", reportsNumber: true,
        });
        if (!gateIds(g).includes("tier2Promotions.reference")) throw new Error(gateIds(g).join(","));
        const v = g.gates.find((x) => x.id === "tier2Promotions.reference").value;
        eq(v[0].threshold, 19200000, "rep 0 threshold");
        return JSON.stringify(v);
    });
    t("a zero fastmem store count is NOT a gate failure (writes are off in shipping)", () => {
        const g = gatesOf({ refRuns: [okRun({ jit: { tier2Promotions: 2, speculatedStoresCompiled: 0 } })],
            candRuns: [okRun()], candClass: "raw", reportsNumber: true });
        eq(gateIds(g).length, 0, "failed gates");
    });
    t("spread > 10% over reps fails the gate", () => {
        const g = gatesOf({ refRuns: [okRun(), okRun({ ns_per_outer: 130 })], candRuns: [okRun(), okRun()], candClass: "raw", reportsNumber: true });
        if (!gateIds(g).includes("spread_pct.reference")) throw new Error(gateIds(g).join(","));
    });
    t("an evicted unit fails the aot.alive gate (a corpse is not a measurement)", () => {
        const g = gatesOf({ refRuns: [okRun()], candRuns: [okRun({ aot: { registered: true, alive: false, entered: false } })], candClass: "unit", reportsNumber: true });
        const ids = gateIds(g);
        if (!ids.includes("aot.alive") || !ids.includes("aot.entered")) throw new Error(ids.join(","));
    });
    t("a never-entered unit fails the aot.entered gate (JIT vs JIT)", () => {
        const g = gatesOf({ refRuns: [okRun()], candRuns: [okRun({ aot: { registered: true, alive: true, entered: false } })], candClass: "unit", reportsNumber: true });
        if (!gateIds(g).includes("aot.entered")) throw new Error(gateIds(g).join(","));
    });
    t("aot gates do not apply to a raw candidate", () => {
        const g = gatesOf({ refRuns: [okRun()], candRuns: [okRun({ aot: null })], candClass: "raw", reportsNumber: true });
        eq(gateIds(g).length, 0, "failed gates");
    });

    t("an all-zero STATE region fails a gate (a vacuous 'registers identical')", () => {
        const zeroed = okRun({ regions: [{ name: "STATE", addr: L.STATE, len: L.STATE_LEN, hex: "00".repeat(L.STATE_LEN) }] });
        const g = gatesOf({ refRuns: [zeroed], candRuns: [zeroed], candClass: "unit", reportsNumber: true });
        if (!gateIds(g).includes("state.spilled")) throw new Error(gateIds(g).join(","));
    });
    t("an arm that publishes no STATE region at all fails the same gate", () => {
        const g = gatesOf({ refRuns: [okRun({ regions: [] })], candRuns: [okRun()], candClass: "unit", reportsNumber: true });
        if (!gateIds(g).includes("state.spilled")) throw new Error(gateIds(g).join(","));
    });

    // ── codegen shape (design F-d: an ablation that silently ran the default) ─
    t("a shape override the engine honoured passes", () => {
        // The fixture states tiering off, so its promotion count must say so too — the tier-2
        // gate reads both halves and a fixture that disagrees with itself is not a clean run.
        const ablated = okRun({ jit_flags: { 5: 0, 15: 0, 19: 0, 21: 0 },
            jit: { tier2Promotions: 0, speculatedStoresCompiled: 12 } });
        const g = gatesOf({ refRuns: [ablated], candRuns: [ablated], candClass: "unit",
            reportsNumber: true, requestedFlags: { 5: 0 } });
        eq(gateIds(g).length, 0, "failed gates");
    });
    t("a requested --flags override the arm did not run FAILS a differential gate", () => {
        // Exactly F-d: --flags 5=0 asked for, both arms ran 5=1, everything else looks perfect.
        const g = gatesOf({ refRuns: [okRun()], candRuns: [okRun()], candClass: "unit",
            reportsNumber: true, requestedFlags: { 5: 0 } });
        if (!g.failedDifferential.map((x) => x.id).includes("shape.as_requested")) throw new Error(gateIds(g).join(","));
        const v = g.gates.find((x) => x.id === "shape.as_requested").value;
        eq(v[0].flag, 5, "named flag"); eq(v[0].requested, 0, "requested"); eq(v[0].effective, 1, "effective");
        return `${v.length} problems, first: flag 5 requested 0 effective 1`;
    });
    t("an arm that reports no shape at all is not credited with the requested one", () => {
        const g = gatesOf({ refRuns: [okRun({ jit_flags: undefined })], candRuns: [okRun()],
            candClass: "unit", reportsNumber: true, requestedFlags: { 5: 0 } });
        if (!gateIds(g).includes("shape.as_requested")) throw new Error(gateIds(g).join(","));
    });
    t("arms running DIFFERENT shapes fail a differential gate", () => {
        const g = gatesOf({ refRuns: [okRun()], candRuns: [okRun({ jit_flags: { 5: 0, 9: 1, 19: 0, 21: 0 } })],
            candClass: "unit", reportsNumber: true });
        if (!gateIds(g).includes("shape.arms_agree")) throw new Error(gateIds(g).join(","));
    });
    t("a relaxed-FPU mismatch against the request fails a differential gate", () => {
        const g = gatesOf({ refRuns: [okRun()], candRuns: [okRun()], candClass: "unit",
            reportsNumber: true, requestedRelaxed: 0 });
        if (!gateIds(g).includes("shape.as_requested")) throw new Error(gateIds(g).join(","));
    });
    t("arms with different relaxed-FPU modes fail a differential gate", () => {
        const g = gatesOf({ refRuns: [okRun()], candRuns: [okRun({ relaxed_fpu: 0 })],
            candClass: "unit", reportsNumber: true });
        if (!gateIds(g).includes("shape.arms_agree")) throw new Error(gateIds(g).join(","));
    });

    // ── command line ────────────────────────────────────────────────────────
    t("an unknown option is refused, not ignored", () => {
        let threw = null;
        try { parseArgs(["node", "x", "--flagz", "5=0"], ["flags"]); } catch (e) { threw = e; }
        if (!threw) throw new Error("--flagz was accepted");
        if (!threw.message.includes("--flagz")) throw new Error(`message does not name the option: ${threw.message}`);
        return threw.message.split("\n")[0];
    });
    t("a known option is parsed with its value", () => {
        const a = parseArgs(["node", "x", "--flags", "5=0", "--check"], ["flags", "check"]);
        eq(a.flags, "5=0", "flags"); eq(a.check, "1", "check");
    });
    t("--flags is parsed into integer overrides and refuses garbage", () => {
        eq([...parseFlagOverrides("5=0,21=1")].map((p) => p.join(":")).join(","), "5:0,21:1", "overrides");
        let threw = false;
        try { parseFlagOverrides("five=0"); } catch { threw = true; }
        eq(threw, true, "threw");
    });

    const passed = tests.filter((x) => x.ok).length;
    return { ok: passed === tests.length, passed, tests };
}
