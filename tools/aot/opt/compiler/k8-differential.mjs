#!/usr/bin/env node
// Fail-closed conformance adapter for the k8 semantic slice: the Rust IR interpreter against v86.
//
// k8 is a real cdecl function with its own prologue, loop and epilogue, so the two arms do NOT
// share an architectural surface the way k3's did. What each side knows:
//
//   * the DESTINATION bytes are fully determined by the kernel, and are the whole point;
//   * EAX/ECX/EDX at the exit are determined by it too (the loop counter and the two advanced
//     pointers), and the image's wrapper epilogue does not touch them;
//   * EBX/EBP/ESI/EDI/ESP depend on what the driver had in them when it called, which an
//     isolated interpreter does not share.
//
// The last group is reported UNCOMPARED rather than compared-and-equal. Declaring a match on
// state neither side established is how a differential comes to agree about nothing.

import { execFileSync } from "node:child_process";
import path from "node:path";
import url from "node:url";
import { KERNELS } from "../../../aot-oracle/corpus/kernels.mjs";
import * as L from "../../../aot-oracle/corpus/layout.mjs";
import { CASES } from "../../../aot-oracle/corpus/cases.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const SPLIT_LINES = new RegExp("\\r?\\n");
const COMPARED_REGS = ["eax", "ecx", "edx"];
const UNCOMPARED_REGS = ["ebx", "esp", "ebp", "esi", "edi"];
const FLAG_BITS = { cf: 0, pf: 2, af: 4, zf: 6, sf: 7, of: 11 };

function runRust() {
    const out = execFileSync("cargo", ["run", "--quiet", "--bin", "k8_wire"], {
        cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out.trim().split(SPLIT_LINES).at(-1));
}

/**
 * The interpreter's own view of the layout must be the layout. It hardcodes the addresses so the
 * crate needs no JS at runtime; that is only safe if a drift is a refusal, which is this.
 */
function assertAuthority(r) {
    const a = r.authority;
    const expected = {
        entry_eip: L.K8_ADDR, src: L.K8_SRC, dst: L.K8_DST, stack_top: L.STACK_TOP,
        src_stride: L.K8_SRC_STRIDE, bias: L.K8_BIAS, rows: L.K8_ROWS, cols: L.K8_COLS,
        row_dst_stride: L.K8_ROW_DST_STRIDE, k8_sha256: KERNELS.k8.sha256,
    };
    const wrong = Object.entries(expected).filter(([k, v]) => a[k] !== v);
    if (r.wire_version !== 1 || r.status !== "ok" || wrong.length) {
        throw new Error(`k8 wire authority mismatch: ${JSON.stringify(wrong)} (status ${r.status})`);
    }
    // The region models its own `ret`, so it leaves at the address the fixture pushed — not at
    // the `ret`'s own address. Leaving there instead is the shape that spins the engine: it
    // dispatches at that address, re-enters, and leaves again without retiring anything.
    const returnTo = L.K8_ADDR + KERNELS.k8.bytes.length;
    if (r.exit.reason !== "branch-taken" || r.exit.continuation_eip !== returnTo) {
        throw new Error(`k8 exited as ${r.exit.reason} at 0x${r.exit.continuation_eip.toString(16)}, `
            + `expected branch-taken at the pushed return address 0x${returnTo.toString(16)}`);
    }
    // Every instruction of the call, the return included.
    if (r.work.accounting !== CASES.k8.insPerCall) {
        throw new Error(`k8 retired ${r.work.accounting}, expected ${CASES.k8.insPerCall} `
            + `(insPerCall, the modelled ret included)`);
    }
}

function runArmA() {
    const armPath = path.resolve(here, "../../../aot-oracle/arms/run-v86.mjs");
    const out = execFileSync(process.execPath, [armPath, "--case", "k8", "--one-call", "--timeout", "60000"], {
        cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out.trim().split(SPLIT_LINES).at(-1));
}

function armState(raw) {
    const state = raw.regions.find((r) => r.name === "STATE");
    const dst = raw.regions.find((r) => r.name === "K8_DST");
    if (!state || !dst) throw new Error("arm produced no STATE / K8_DST region");
    const dwords = state.hex.match(/.{8}/g).map((h) => Number.parseInt(h.match(/../g).reverse().join(""), 16) >>> 0);
    const named = Object.fromEntries(state.fields.map(([n, off]) => [n, dwords[off / 4]]));
    const eflags = named.eflags;
    return {
        gprs: named,
        flags: Object.fromEntries(Object.entries(FLAG_BITS).map(([n, b]) => [n, Boolean((eflags >>> b) & 1)])),
        dst_hex: dst.hex,
    };
}

const rust = runRust();

/** Compare one Rust result against one arm result, returning the fields that differ. */
function compare(rustSide, armSide) {
    const differences = [];
    if (armSide.dst_hex !== rustSide.dst_hex) differences.push("dst_hex");
    for (const name of COMPARED_REGS) {
        if (armSide.gprs[name] !== rustSide.gprs[name]) differences.push(`gprs.${name}`);
    }
    for (const name of Object.keys(FLAG_BITS)) {
        if (armSide.flags[name] !== rustSide.flags[name]) differences.push(`flags.${name}`);
    }
    return differences;
}

const report = { harness_version: 1, case: "k8", rust, arm_a: null };
try {
    // Inside the try: an authority or contract mismatch is a RESULT, and throwing it past the
    // reporter leaves a stack trace where the fields identifying which semantic went wrong
    // should be. Fail-closed on the exit code, informative on stdout.
    assertAuthority(rust);
    const raw = runArmA();
    const arm = armState(raw);
    report.arm_a = { raw, normalized: arm };
    const differences = compare(rust, arm);
    // The comparator is run against three deliberate corruptions and must reject each. A
    // "mutation seen" flag computed without running the comparator proves only that a string
    // changed.
    const mutations = [
        ["dst_hex", { ...rust, dst_hex: `ff${rust.dst_hex.slice(2)}` }],
        ["gprs.ecx", { ...rust, gprs: { ...rust.gprs, ecx: rust.gprs.ecx + 4 } }],
        ["flags.zf", { ...rust, flags: { ...rust.flags, zf: !rust.flags.zf } }],
    ].map(([field, corrupted]) => ({ field, caught: compare(corrupted, arm).includes(field) }));
    report.comparison = {
        equal: differences.length === 0,
        differences,
        compared: ["dst_hex", ...COMPARED_REGS.map((r) => `gprs.${r}`), ...Object.keys(FLAG_BITS).map((f) => `flags.${f}`)],
        uncompared: UNCOMPARED_REGS.map((r) => `gprs.${r}`),
        uncompared_why: "these depend on what the driver held when it called; an isolated "
            + "interpreter does not share that entry state, so a match would mean nothing",
    };
    report.mutation = { checks: mutations, all_caught: mutations.every((m) => m.caught) };
    report.status = report.comparison.equal && report.mutation.all_caught ? "PASS" : "DIVERGENT";
} catch (error) {
    report.status = "FAILED";
    report.failure = String(error.stderr ?? error.message ?? error);
}
console.log(JSON.stringify(report));
process.exit(report.status === "PASS" ? 0 : 3);
