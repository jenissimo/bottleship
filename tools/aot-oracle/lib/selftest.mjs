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
        jit: { tier2Promotions: 3, fastmemLoadsCompiled: 12 },
        aot: { registered: true, alive: true, entered: true }, ...over,
    });
    // Both classes together: a self-test must not care WHICH bucket a gate failed in, only
    // that it failed. (The two buckets differ in when they are ENFORCED — oracle.mjs's job.)
    const gateIds = (g) => [...g.failedDifferential, ...g.failedMeasurement].map((x) => x.id);

    t("a clean run fails no gate", () => {
        const g = evaluateGates({ refRuns: [okRun()], candRuns: [okRun()], candClass: "unit", reportsNumber: true });
        eq(gateIds(g).length, 0, "failed gates");
    });
    t("not-steady-state fails the gate", () => {
        const g = evaluateGates({ refRuns: [okRun({ phase_ns: { p1: 1000, p2: 1200 } })], candRuns: [okRun()], candClass: "raw", reportsNumber: true });
        if (!gateIds(g).includes("steady_state.reference")) throw new Error(gateIds(g).join(","));
    });
    t("tier2Promotions == 0 fails the gate (tier-1 code was measured)", () => {
        const g = evaluateGates({ refRuns: [okRun({ jit: { tier2Promotions: 0, fastmemLoadsCompiled: 9 } })], candRuns: [okRun()], candClass: "raw", reportsNumber: true });
        if (!gateIds(g).includes("tier2Promotions.reference")) throw new Error(gateIds(g).join(","));
    });
    t("fastmemLoadsCompiled == 0 fails the gate (TLB shape, not production)", () => {
        const g = evaluateGates({ refRuns: [okRun({ jit: { tier2Promotions: 2, fastmemLoadsCompiled: 0 } })], candRuns: [okRun()], candClass: "raw", reportsNumber: true });
        if (!gateIds(g).includes("fastmemLoadsCompiled.reference")) throw new Error(gateIds(g).join(","));
    });
    t("spread > 10% over reps fails the gate", () => {
        const g = evaluateGates({ refRuns: [okRun(), okRun({ ns_per_outer: 130 })], candRuns: [okRun(), okRun()], candClass: "raw", reportsNumber: true });
        if (!gateIds(g).includes("spread_pct.reference")) throw new Error(gateIds(g).join(","));
    });
    t("an evicted unit fails the aot.alive gate (a corpse is not a measurement)", () => {
        const g = evaluateGates({ refRuns: [okRun()], candRuns: [okRun({ aot: { registered: true, alive: false, entered: false } })], candClass: "unit", reportsNumber: true });
        const ids = gateIds(g);
        if (!ids.includes("aot.alive") || !ids.includes("aot.entered")) throw new Error(ids.join(","));
    });
    t("a never-entered unit fails the aot.entered gate (JIT vs JIT)", () => {
        const g = evaluateGates({ refRuns: [okRun()], candRuns: [okRun({ aot: { registered: true, alive: true, entered: false } })], candClass: "unit", reportsNumber: true });
        if (!gateIds(g).includes("aot.entered")) throw new Error(gateIds(g).join(","));
    });
    t("aot gates do not apply to a raw candidate", () => {
        const g = evaluateGates({ refRuns: [okRun()], candRuns: [okRun({ aot: null })], candClass: "raw", reportsNumber: true });
        eq(gateIds(g).length, 0, "failed gates");
    });

    const passed = tests.filter((x) => x.ok).length;
    return { ok: passed === tests.length, passed, tests };
}
