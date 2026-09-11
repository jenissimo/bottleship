#!/usr/bin/env node
// Arm A fixed-work runner.
//
// It invokes the existing aot-oracle reference arm in a fresh child process for every
// repetition, then wraps those observations in the versioned result contract from
// result-schema.mjs.  The child is intentionally the unmodified shipping v86 arm: enabling
// capture/instrumentation here would change the timing being used as the baseline.
//
// Examples:
//   node tools/aot/opt/runner.mjs --case k3 --reps 3 --outer 20000 --warmup 4000 --out baseline.json
//   node tools/aot/opt/runner.mjs --validate baseline.json
//   node tools/aot/opt/runner.mjs --self-test

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import url from "node:url";

import { getCase } from "../../aot-oracle/corpus/cases.mjs";
import * as L from "../../aot-oracle/corpus/layout.mjs";
import {
    JIT_CONFIG_ABI_VERSION,
    JIT_CONFIG_SUPPORTED_MASK,
    SHIPPING_JIT,
} from "../../jit-config/shipping.mjs";
import {
    RESULT_SCHEMA_ID,
    RESULT_SCHEMA_NAME,
    RESULT_SCHEMA_VERSION,
    assertValidResult,
    digestEffects,
    digestState,
    makeArmAResult,
    sha256,
    summarizeSamples,
    validateResult,
} from "./result-schema.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const REPO = path.resolve(__dirname, "../../..");
const V86_ARM = path.join(REPO, "tools", "aot-oracle", "arms", "run-v86.mjs");
const DEFAULT_OUTER = 20_000;
const DEFAULT_WARMUP = 4_000;
const DEFAULT_REPS = 3;
const DEFAULT_TIMEOUT = 600_000;

const VALUE_ARGS = new Set([
    "case", "outer", "warmup", "reps", "timeout", "out", "browser-revision", "engine-dir",
    "fault", "flags", "relaxed",
]);
const SWITCH_ARGS = new Set(["self-test", "validate", "help"]);

function usage(message = null, code = 2) {
    if (message) process.stderr.write(`error: ${message}\n`);
    process.stderr.write(
        "usage: node tools/aot/opt/runner.mjs --case <id> [--reps N] [--outer N] [--warmup N] "
        + "[--out result.json]\n"
        + "       node tools/aot/opt/runner.mjs --validate <result.json>\n"
        + "       node tools/aot/opt/runner.mjs --self-test\n",
    );
    process.exit(code);
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith("--")) usage(`unexpected argument ${token}`);
        const name = token.slice(2);
        if (!VALUE_ARGS.has(name) && !SWITCH_ARGS.has(name)) usage(`unknown option --${name}`);
        if (SWITCH_ARGS.has(name)) {
            if (name === "help") usage(null, 0);
            if (args[name] !== undefined) usage(`duplicate option --${name}`);
            if (name === "validate") {
                const value = argv[++i];
                if (!value || value.startsWith("--")) usage("--validate needs a JSON path");
                args[name] = value;
            }
            else args[name] = true;
            continue;
        }
        const value = argv[++i];
        if (value === undefined || value.startsWith("--")) usage(`--${name} needs a value`);
        if (args[name] !== undefined) usage(`duplicate option --${name}`);
        args[name] = value;
    }
    return args;
}

function positiveInteger(value, name, fallback) {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) usage(`--${name} must be a positive integer`);
    return n;
}

function runGit(gitArgs) {
    const child = spawnSync("git", gitArgs, { cwd: REPO, encoding: "utf8", timeout: 15_000 });
    if (child.error || child.status !== 0) return null;
    const value = String(child.stdout ?? "").trim();
    return value || null;
}

function fileSha256(file) {
    try { return sha256(fs.readFileSync(file)); }
    catch { return null; }
}

function parseLastJson(stdout) {
    const lines = String(stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
        try {
            const value = JSON.parse(line);
            if (value && typeof value === "object") return value;
        }
        catch { /* diagnostic lines before the final arm result are allowed */ }
    }
    return null;
}

function runReference({ caseId, outer, warmup, timeout, engineDir, fault, flags, relaxed }) {
    const childArgs = [V86_ARM, "--case", caseId, "--outer", String(outer), "--warmup", String(warmup)];
    if (fault !== undefined) childArgs.push("--fault", fault);
    if (flags !== undefined) childArgs.push("--flags", flags);
    if (relaxed !== undefined) childArgs.push("--relaxed", relaxed);
    const env = { ...process.env, V86_ENGINE_DIR: engineDir };
    const child = spawnSync(process.execPath, childArgs, {
        cwd: REPO,
        env,
        encoding: "utf8",
        timeout,
        maxBuffer: 64 * 1024 * 1024,
    });
    const raw = parseLastJson(child.stdout);
    if (child.status === 0 && raw) return raw;
    const error = child.error?.code === "ETIMEDOUT"
        ? `reference arm timed out after ${timeout} ms`
        : child.error?.message ?? `reference arm exited with status ${child.status}`;
    return {
        arm: "reference", impl: "v86", case: caseId, status: "arm_failed",
        runner_error: error,
        child_status: child.status,
        child_stderr: String(child.stderr ?? "").slice(-4_000),
    };
}

function browserRevision(args) {
    return args["browser-revision"] ?? process.env.BS_BROWSER_REVISION ?? null;
}

function makeProvenance({ engineDir, command, browser }) {
    const enginePath = path.join(engineDir, "build", "v86.wasm");
    const repositoryRevision = runGit(["rev-parse", "HEAD"]);
    const v86Revision = runGit(["-C", path.relative(REPO, engineDir), "rev-parse", "HEAD"]);
    const dirty = runGit(["status", "--porcelain", "--untracked-files=no"]);
    return {
        contract: { name: RESULT_SCHEMA_NAME, version: RESULT_SCHEMA_VERSION, id: RESULT_SCHEMA_ID },
        repository: {
            root: REPO,
            revision: repositoryRevision,
            dirty: dirty === null ? null : dirty.length > 0,
            source: "git rev-parse/status",
        },
        v86: {
            directory: engineDir,
            revision: v86Revision,
            engine_path: enginePath,
            engine_sha256: fileSha256(enginePath),
            source: "V86_ENGINE_DIR/build/v86.wasm",
        },
        runner: {
            name: "tools/aot/opt/runner.mjs",
            version: RESULT_SCHEMA_ID,
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            command,
        },
        browser: {
            name: process.env.BS_BROWSER_NAME ?? null,
            revision: browser,
            source: browser ? "--browser-revision/BS_BROWSER_REVISION" : "not-running-in-browser",
        },
    };
}

function objectFlags(flags) {
    if (!flags || typeof flags !== "object") return {};
    return Object.fromEntries(Object.entries(flags).map(([key, value]) => [String(key), Number(value)]));
}

function makeEnvelope({ raw, engineDir, browser }) {
    const expectedFlags = Object.fromEntries([...SHIPPING_JIT].map(([index, value]) => [String(index), value]));
    const effectiveFlags = objectFlags(raw?.jit_flags);
    const sameFlags = Object.keys(expectedFlags).every((index) => effectiveFlags[index] === expectedFlags[index]);
    const enginePath = path.join(engineDir, "build", "v86.wasm");
    return {
        v86: {
            revision: runGit(["-C", path.relative(REPO, engineDir), "rev-parse", "HEAD"]),
            engine_sha256: fileSha256(enginePath),
        },
        jit: {
            config_source: "tools/jit-config/shipping.mjs",
            config_abi: JIT_CONFIG_ABI_VERSION,
            supported_mask: JIT_CONFIG_SUPPORTED_MASK >>> 0,
            requested: expectedFlags,
            readback: effectiveFlags,
            readback_verified: Object.keys(expectedFlags).every((index) => effectiveFlags[index] !== undefined),
            matches_shipping: sameFlags,
            overrides: raw?.jit_flag_overrides ?? {},
            relaxed_fpu: raw?.relaxed_fpu ?? null,
            readback_source: "tools/aot-oracle/arms/run-v86.mjs",
            fingerprint: null,
        },
        memory: {
            ram_size: L.MEM_SIZE,
            paging_on: raw?.paging_on ?? null,
            layout: "tools/aot-oracle/corpus/layout.mjs",
        },
        abi: {
            aot_publication: 5,
            oracle: 1,
            state_block: 1,
            helper_registry: null,
            compiler: null,
            fp: 1,
        },
        fp: {
            policy: raw?.relaxed_fpu === 1 ? "relaxed" : raw?.relaxed_fpu === 0 ? "strict" : null,
            abi: 1,
            source: "v86 state snapshot; Arm A does not alter FP policy",
        },
        execution: {
            arm: "A",
            dispatch: "shipping-v86-jit",
            single_cpu: true,
            scheduler_accounting: "v86 shipping instruction counter",
            browser_revision: browser,
        },
    };
}

function caseWorkSpec({ caseId, outer, warmup, fault, functionIdentity }) {
    const variant = fault ?? "base";
    return {
        id: `aot-oracle/${caseId}/${variant}/outer-delta-v1`,
        case_id: caseId,
        count: outer,
        warmup,
        phase_counts: { warmup, p1: outer, p2: outer * 2, delta: outer },
        input_variant: variant,
        function_identity: functionIdentity,
    };
}

function defaultFunctionIdentityForCase(caseDescriptor) {
    // `makeArmAResult` owns the actual v1 identity calculation.  Passing the descriptor through
    // workSpec would make a duplicate implementation, so this function only supplies a marker
    // when there is no corpus descriptor (which should be impossible for a normal run).
    return caseDescriptor ? undefined : null;
}

function syntheticRaw() {
    const payload = Buffer.from("01020304", "hex");
    const state = {
        source: "synthetic-self-test",
        regs: { eax: 1, ecx: 2, edx: 3, ebx: 4, esp: 5, ebp: 6, esi: 7, edi: 8 },
        eip: 0x1234, eflags: 0x202,
        lazy: { flags: 0, flags_changed: 0, last_op1: 0, last_result: 0, last_op_size: 0 },
        fpu: { stack_ptr: 0, stack_empty: 0, control_word: 0, status_word: 0, simd_dirty: 0, st: [] },
        simd: { mxcsr: 0, xmm: [] }, instruction_counter: 100,
    };
    return {
        arm: "reference", impl: "v86", case: "self", status: "ok", node: process.version,
        outer: { warmup: 1, n1: 10, n2: 20 }, phase_ns: { p1: 10_000, p2: 20_000 },
        ns_per_outer: 1_000, guest_ins_per_outer: 5, guest_mips: 5_000,
        jit: { pages: [], tier2Promotions: 0, tier2Pages: 0, speculatedStoresCompiled: 0 },
        jit_flags: Object.fromEntries([...SHIPPING_JIT].map(([i, v]) => [String(i), v])),
        jit_flag_overrides: {}, relaxed_fpu: 1, paging_on: true, capture_eip: "0x1234",
        regions: [{ name: "DATA", addr: 0x2000, len: payload.length, sha256: sha256(payload), hex: payload.toString("hex") }],
        state,
    };
}

export function selfTest() {
    const raw = syntheticRaw();
    const selfTestEngine = path.join(REPO, "vendor", "v86", "build", "v86.wasm");
    const selfTestEngineSha = fileSha256(selfTestEngine) ?? sha256(Buffer.from("engine"));
    const descriptor = {
        id: "self", body: new Uint8Array([0x90]), codeAddr: 0x1000, calls: [{ off: 0 }],
        provenance: { from: "runner self-test", va: null, sha256: null },
    };
    const provenance = {
        contract: { name: RESULT_SCHEMA_NAME, version: RESULT_SCHEMA_VERSION, id: RESULT_SCHEMA_ID },
        repository: { root: ".", revision: "self-test", dirty: false, source: "self-test" },
        v86: { directory: ".", revision: "self-test", engine_path: "v86.wasm", engine_sha256: selfTestEngineSha, source: "self-test" },
        runner: { name: "self-test", version: RESULT_SCHEMA_ID, node: process.version, platform: process.platform, arch: process.arch, command: [] },
        browser: { name: null, revision: null, source: "self-test" },
    };
    const envelope = makeEnvelope({ raw, engineDir: path.join(REPO, "vendor", "v86"), browser: null });
    const result = makeArmAResult({
        rawRuns: [raw], caseDescriptor: descriptor,
        workSpec: caseWorkSpec({ caseId: "self", outer: 10, warmup: 1, functionIdentity: undefined }),
        provenance, envelope, command: ["self-test"], createdAt: "2026-09-04T00:00:00.000Z",
    });
    assert.equal(result.oracle.verdict, "BASELINE");
    assert.equal(result.fixed_work.count, 10);
    assert.equal(result.timing.summary.median_ns, 1_000);
    assert.equal(result.timing.summary.p95_ns, 1_000);
    assert.equal(result.timing.buckets.total.summary.interval_ns.kind, "observed_min_max");
    assert.equal(validateResult(result).ok, true, JSON.stringify(validateResult(result).errors));
    assertValidResult(result);

    const badEffect = structuredClone(result);
    badEffect.samples[0].raw.regions[0].hex = "ffffffff";
    assert.equal(validateResult(badEffect).ok, false, "effect mutation must be detected");
    const badWork = structuredClone(result);
    badWork.fixed_work.count += 1;
    assert.equal(validateResult(badWork).ok, false, "fixed-work mutation must be detected");
    const badIdentity = structuredClone(result);
    badIdentity.function_identity.id = "";
    assert.equal(validateResult(badIdentity).ok, false, "function identity mutation must be detected");
    const badIdentityBody = structuredClone(result);
    badIdentityBody.function_identity.body_sha256 = "0".repeat(64);
    assert.equal(validateResult(badIdentityBody).ok, false, "identity body mutation must be detected");
    const badLedger = structuredClone(result);
    badLedger.fixed_work.ledger.completed_units = 999;
    assert.equal(validateResult(badLedger).ok, false, "ledger mutation must be detected");
    const badTiming = structuredClone(result);
    badTiming.samples[0].raw.phase_ns.p2 += 1;
    assert.equal(validateResult(badTiming).ok, false, "raw timing mutation must be detected");
    const badJitReadback = structuredClone(result);
    badJitReadback.samples[0].raw.jit_flags = {};
    assert.equal(validateResult(badJitReadback).ok, false, "JIT readback mutation must be detected");
    const badState = structuredClone(result);
    badState.samples[0].raw.state.regs.eax = 99;
    assert.equal(validateResult(badState).ok, false, "state mutation must be detected");
    assert.deepEqual(summarizeSamples([3, 1, 2]), {
        count: 3, min_ns: 1, median_ns: 2, p95_ns: 3, max_ns: 3, mean_ns: 2,
        interval_ns: { kind: "observed_min_max", low_ns: 1, high_ns: 3 },
    });
    assert.equal(digestState(raw.state), result.samples[0].state_digest);
    assert.equal(digestEffects(raw.regions), result.samples[0].effect_digest);

    // A child-process failure is evidence too. It must be serializable and independently valid,
    // rather than being misreported as malformed merely because it has no state/effect digest.
    const failedRaw = {
        arm: "reference", impl: "v86", case: "self", status: "arm_failed",
        runner_error: "synthetic self-test failure",
    };
    const failedEnvelope = makeEnvelope({ raw: failedRaw, engineDir: path.join(REPO, "vendor", "v86"), browser: null });
    const failed = makeArmAResult({
        rawRuns: [failedRaw], caseDescriptor: descriptor,
        workSpec: caseWorkSpec({ caseId: "self", outer: 10, warmup: 1, functionIdentity: undefined }),
        provenance, envelope: failedEnvelope, command: ["self-test-failure"], createdAt: "2026-09-04T00:00:00.000Z",
    });
    assert.equal(failed.status, "arm_failed");
    assert.equal(failed.oracle.verdict, "ARM_FAILED");
    assert.equal(validateResult(failed).ok, true, JSON.stringify(validateResult(failed).errors));
    return { ok: true, checks: 18, schema: RESULT_SCHEMA_ID };
}

function validateFile(file) {
    let result;
    try { result = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")); }
    catch (e) { process.stderr.write(`cannot read ${file}: ${e.message}\n`); process.exit(4); }
    const report = validateResult(result);
    console.log(JSON.stringify({ schema: RESULT_SCHEMA_ID, ...report }, null, 2));
    process.exit(report.ok ? 0 : 4);
}

function run(args) {
    if (args["self-test"]) {
        console.log(JSON.stringify(selfTest(), null, 2));
        return;
    }
    if (args.validate) validateFile(args.validate);
    if (!args.case) usage("--case is required");
    let descriptor;
    try { descriptor = getCase(args.case); }
    catch (e) { usage(e.message); }
    const outer = positiveInteger(args.outer, "outer", DEFAULT_OUTER);
    const warmup = positiveInteger(args.warmup, "warmup", DEFAULT_WARMUP);
    const reps = positiveInteger(args.reps, "reps", DEFAULT_REPS);
    const timeout = positiveInteger(args.timeout, "timeout", DEFAULT_TIMEOUT);
    const engineDir = path.resolve(args["engine-dir"] ?? process.env.V86_ENGINE_DIR ?? path.join(REPO, "vendor", "v86"));
    const browser = browserRevision(args);
    const command = [process.execPath, path.join("tools", "aot", "opt", "runner.mjs"), ...process.argv.slice(2)];
    const rawRuns = [];
    for (let rep = 0; rep < reps; rep++) {
        process.stderr.write(`Arm A ${descriptor.id} repetition ${rep + 1}/${reps}\n`);
        rawRuns.push(runReference({ caseId: descriptor.id, outer, warmup, timeout, engineDir,
            fault: args.fault, flags: args.flags, relaxed: args.relaxed }));
    }
    const provenance = makeProvenance({ engineDir, command, browser });
    const envelope = makeEnvelope({ raw: rawRuns.find((r) => r?.status === "ok") ?? rawRuns[0], engineDir, browser });
    const workSpec = caseWorkSpec({ caseId: descriptor.id, outer, warmup, fault: args.fault,
        functionIdentity: defaultFunctionIdentityForCase(descriptor) });
    const result = makeArmAResult({ rawRuns, caseDescriptor: descriptor, workSpec, provenance, envelope, command });
    const report = validateResult(result);
    const outPath = args.out ? path.resolve(args.out) : null;
    if (outPath) {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
    }
    if (!report.ok) {
        process.stderr.write(report.errors.map((e) => `${e.path}: ${e.message}`).join("\n") + "\n");
    }
    const summary = {
        schema: RESULT_SCHEMA_ID, arm: result.arm, status: result.status, verdict: result.oracle.verdict,
        case: descriptor.id, repetitions: result.samples.length,
        fixed_work: { id: result.fixed_work.id, count: result.fixed_work.count },
        timing: result.timing.summary,
        state_digest: result.state.digest, effect_digest: result.effects.digest,
        function_identity: result.function_identity?.id ?? null,
        valid: report.ok,
        file: outPath,
    };
    console.log(JSON.stringify(outPath ? summary : result, null, 2));
    process.exit(result.status === "arm_failed" ? 3 : report.ok ? 0 : 4);
}

run(parseArgs(process.argv.slice(2)));
