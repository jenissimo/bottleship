#!/usr/bin/env node
// Fail-closed one-call conformance adapter for the P1 k3 semantic slice.

import { execFileSync } from "node:child_process";
import path from "node:path";
import url from "node:url";
import { KERNELS } from "../../../aot-oracle/corpus/kernels.mjs";
import * as L from "../../../aot-oracle/corpus/layout.mjs";
import { CASES } from "../../../aot-oracle/corpus/cases.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const wireOnly = process.argv.includes("--wire-only");
const regs = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"];
const flags = { cf: 0, pf: 2, af: 4, zf: 6, sf: 7, of: 11 };

function runRust() {
    return JSON.parse(execFileSync("cargo", ["run", "--quiet", "--bin", "k3_wire"], {
        cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim());
}

function assertRust(result) {
    const work = result.work;
    if (result.wire_version !== 1 || result.status !== "ok" || result.authority.k3_sha256 !== KERNELS.k3.sha256
        || result.authority.entry_eip !== L.K3_ADDR || result.authority.dst3 !== L.DST3 || result.authority.source !== L.SRC1
        || work?.calls !== 1 || work.body_iterations !== L.COUNT || work.body_instructions !== L.COUNT * KERNELS.k3.insPerIter
        || work.analytic_instructions !== 3 + L.COUNT * KERNELS.k3.insPerIter + 1 || result.ledger?.effects !== L.COUNT * 2
        || result.ledger.accounting !== L.COUNT * KERNELS.k3.insPerIter || result.logical_continuation !== "wrapper-return") {
        throw new Error("Rust one-call wire authority/work contract mismatch");
    }
}

function read(object, key) { return key.split(".").reduce((value, part) => value?.[part], object); }
function compare(left, right) {
    const paths = ["status", "dst3_hex", "logical_continuation", "work.calls", "work.body_iterations", "work.body_instructions", "work.analytic_instructions"];
    regs.forEach((name) => paths.push(`gprs.${name}`));
    Object.keys(flags).forEach((name) => paths.push(`flags.${name}`));
    for (const key of paths) {
        const a = read(left, key), b = read(right, key);
        if (a === undefined || b === undefined || a === null) return { equal: false, reason: `uncompared:${key}` };
        if (JSON.stringify(a) !== JSON.stringify(b)) return { equal: false, reason: `divergent:${key}` };
    }
    return { equal: true };
}

function normalizeArm(result) {
    const dst = result.regions?.find((region) => region.name === "DST3");
    const eflags = result.state?.eflags;
    const work = result.conformance?.work;
    return {
        status: result.status === "ok" ? "ok" : result.status,
        dst3_hex: dst?.hex,
        gprs: result.state?.regs,
        logical_continuation: result.conformance?.logical_continuation,
        flags: eflags === null || eflags === undefined ? undefined : Object.fromEntries(Object.entries(flags).map(([name, bit]) => [name, Boolean(eflags & (1 << bit))])),
        work,
    };
}

const rust = runRust();
assertRust(rust);
const mutated = structuredClone(rust); mutated.dst3_hex = mutated.dst3_hex.replace(/^../, "ff");
const mutation = compare(rust, mutated);
if (mutation.equal) throw new Error("comparator accepted a deliberate DST3 divergence");

/** The arm prints one JSON object as its last line; line endings differ by platform. */
const SPLIT_LINES = new RegExp("\r?\n");

/**
 * Exercise one real #PF and check its identity and its effect frontier.
 *
 * `--fault` mutates INPUT BYTES; this uses `--mmu`, which revokes a page and makes the guest
 * take the fault through a real IDT gate. The two are not substitutes: a candidate can reproduce
 * every clean result and still restart a scope whose stores already landed.
 */
function permissionFaultGate(armPath) {
    const run = (args) => {
        try {
            const out = execFileSync(process.execPath, [armPath, ...args], {
                cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
            });
            return JSON.parse(out.trim().split(SPLIT_LINES).at(-1));
        } catch (e) {
            const out = String(e.stdout ?? "").trim();
            if (!out) return { status: `ARM_FAILED: ${String(e.stderr ?? e.message).slice(-200)}` };
            try { return JSON.parse(out.split(SPLIT_LINES).at(-1)); } catch { return { status: "UNPARSEABLE" }; }
        }
    };
    const base = ["--case", "k3", "--one-call", "--timeout", "60000"];
    const faulted = run([...base, "--mmu", "pf-absent-dst"]);
    const clean = run([...base, "--mmu", "ad-observe"]);
    const m = faulted.mmu;
    const dst = (r) => r.regions?.find((x) => x.name === "DST3")?.hex ?? null;
    const checks = {
        arm_ok: faulted.status === "ok" && clean.status === "ok",
        fault_taken: m?.observed?.taken === 1,
        // The k3 store is what must fault, so the error code has to say write, not read.
        fault_is_a_write: m?.observed?.error?.access === "write",
        cr2_is_the_revoked_page: m?.observed?.cr2 !== undefined
            && (m.observed.cr2 & ~0xfff) === Number.parseInt(m.patches?.[0]?.page ?? "0", 16),
        // The destination page was revoked before the first store, so nothing may have landed —
        // and the clean run must differ, or "unchanged" would prove nothing.
        no_store_landed: dst(faulted) !== null && /^0+$/.test(dst(faulted)),
        clean_run_differs: dst(clean) !== null && !/^0+$/.test(dst(clean)),
    };
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
    return {
        status: failed.length === 0 ? "PASS" : "FAIL",
        scenario: "pf-absent-dst",
        observed: m?.observed ?? null,
        checks,
        failed,
    };
}

/**
 * Compare the two arms ON A FAULT, not only on a clean run.
 *
 * Without this, a candidate could reproduce every clean result and still get the one thing a
 * scoped memory proof must not: restart a scope whose stores already landed, or stop at the wrong
 * access. The scenario is `pf-partial-dst`, the only one in the matrix where stores complete
 * BEFORE the fault, so "nothing was written" cannot pass for agreement.
 *
 * The two arms place the body at different addresses — the image prefixes a register prologue —
 * so the faulting EIP is compared as an OFFSET INTO THE BODY, and the offset is derived, never
 * assumed to be zero.
 */
function faultDifferential(armPath) {
    const COUNT = 1024;
    const dstPage = (L.DST3 & ~0xfff) >>> 0;
    const revokedPage = (dstPage + 0x1000) >>> 0;

    let rust;
    try {
        const out = execFileSync("cargo", ["run", "--quiet", "--bin", "k3_wire"], {
            cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, AOT_ORACLE_COUNT: String(COUNT), BS_K3_REVOKE_PAGE: revokedPage.toString(16) },
        });
        rust = JSON.parse(out.trim().split(SPLIT_LINES).at(-1));
    } catch (e) {
        return { status: "FAIL", why: `rust fault arm: ${String(e.stderr ?? e.message).slice(-200)}` };
    }

    let arm;
    try {
        const out = execFileSync(process.execPath,
            [armPath, "--case", "k3", "--one-call", "--mmu", "pf-partial-dst", "--timeout", "60000"],
            { cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
              env: { ...process.env, AOT_ORACLE_COUNT: String(COUNT) } });
        arm = JSON.parse(out.trim().split(SPLIT_LINES).at(-1));
    } catch (e) {
        const out = String(e.stdout ?? "").trim();
        if (!out) return { status: "FAIL", why: `v86 fault arm: ${String(e.stderr ?? e.message).slice(-200)}` };
        arm = JSON.parse(out.split(SPLIT_LINES).at(-1));
    }

    // The image's wrapper prologue sits between the case's code address and the body the wire
    // lifts, so the body offset is derived from the case rather than hardcoded.
    const prologueBytes = CASES.k3.calls[0].prologue.length * 5;   // each is `mov r32, imm32`
    const armBodyBase = CASES.k3.codeAddr + CASES.k3.calls[0].off + prologueBytes;
    const armOffset = arm.mmu?.observed?.taken === 1
        ? arm.mmu.observed.fault_eip - armBodyBase
        : null;
    const rustOffset = rust.fault?.taken ? rust.fault.guest_eip - L.K3_ADDR : null;

    const armDst = arm.regions?.find((r) => r.name === "DST3")?.hex ?? null;
    const checks = {
        both_faulted: rust.fault?.taken === true && arm.mmu?.observed?.taken === 1,
        same_body_offset: armOffset !== null && armOffset === rustOffset,
        same_access_kind: arm.mmu?.observed?.error?.access === "write"
            && rust.fault?.kind === "permission-write",
        // The decisive one: both arms must have completed the SAME stores before stopping.
        same_completed_effects: armDst !== null && armDst === rust.dst3_hex,
        // ...and that agreement must not be vacuous — a prefix really was written.
        prefix_is_not_empty: /[1-9a-f]/.test(rust.dst3_hex ?? ""),
    };
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
    return {
        status: failed.length === 0 ? "PASS" : "FAIL",
        scenario: "pf-partial-dst",
        count: COUNT,
        revoked_page: `0x${revokedPage.toString(16)}`,
        rust: rust.fault ?? null,
        v86: arm.mmu?.observed ?? null,
        body_offset: { rust: rustOffset, v86: armOffset },
        checks,
        failed,
    };
}

const report = {
    harness_version: 2,
    rust,
    mutation,
    permission_fault_gate: null,
    arm_a: null,
};
if (wireOnly) {
    report.status = "PASS_WIRE_ONLY";
    console.log(JSON.stringify(report));
    process.exit(0);
}

const armPath = path.resolve(here, "../../../aot-oracle/arms/run-v86.mjs");
try {
    const stdout = execFileSync(process.execPath, [armPath, "--case", "k3", "--one-call", "--timeout", "60000"], {
        cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    const raw = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    const arm = normalizeArm(raw);
    report.arm_a = { raw, normalized: arm };
    report.comparison = compare(rust, arm);
    const expectedLedger = raw.conformance?.expected_ledger;
    report.ledger_check = {
        source: expectedLedger?.source,
        equal: expectedLedger !== undefined
            && rust.ledger.effects === expectedLedger.effects
            && rust.ledger.accounting === expectedLedger.accounting,
        observed: rust.ledger,
        expected: expectedLedger,
    };
    // The Rust interpreter models faults; a differential that only ever compares clean runs
    // never exercises that. So the gate RUNS a real permission fault through Arm A and checks
    // the two things a candidate could get wrong without any clean run noticing: that the fault
    // happened on the access it was supposed to, and that no store past it landed.
    report.permission_fault_gate = permissionFaultGate(armPath);
    report.fault_differential = faultDifferential(armPath);
    report.status = report.comparison.equal
        && report.ledger_check.equal
        && report.permission_fault_gate.status === "PASS"
        && report.fault_differential.status === "PASS"
        ? "PASS"
        : "DIVERGENT";
} catch (error) {
    report.status = "ARM_FAILED";
    report.arm_a = { invocation_error: String(error.stderr ?? error.message ?? error) };
}
console.log(JSON.stringify(report));
process.exit(report.status === "PASS" ? 0 : 3);
