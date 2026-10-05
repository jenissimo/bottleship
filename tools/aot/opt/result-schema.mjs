// Versioned fixed-work result contract for the optimizing-translator experiment.
//
// This module deliberately has no dependency on the compiler or on v86 internals.  Arm A
// produces a result through runner.mjs and later arms can use the same envelope, timing, digest,
// and oracle fields.  The existing tools/aot-oracle output remains an input to this contract, not
// the contract itself: the result is explicit about which facts are measured and which buckets
// are unavailable in an uninstrumented arm.

import crypto from "node:crypto";

export const RESULT_SCHEMA_NAME = "bottleship.aot.opt.fixed-work-result";
export const RESULT_SCHEMA_VERSION = 1;
export const RESULT_SCHEMA_ID = `${RESULT_SCHEMA_NAME}.v${RESULT_SCHEMA_VERSION}`;

export const ORACLE_VERDICTS = Object.freeze([
    "BASELINE",       // Arm A self-validated; no differential candidate was compared.
    "CORRECT",        // Reserved for a future differential result.
    "DIVERGENT",      // Reserved for a future differential result.
    "INVALID",        // A result exists, but a required validity gate failed.
    "ARM_FAILED",     // The arm did not produce a usable observation.
]);

// These names are part of the v1 result vocabulary.  An arm may leave a bucket unavailable, but
// it must not silently fold that cost into another bucket.  `total` and phase wall time are the
// only buckets Arm A can provide without changing the measured v86 arm.
export const TIMING_BUCKETS = Object.freeze([
    "total",
    "dispatch",
    "entry",
    "guard",
    "body",
    "memory_preparation",
    "materialization",
    "helper",
    "exit",
    "compile",
    "publication",
    "baseline_residual",
]);

const SHA256 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isFiniteNumber = (x) => typeof x === "number" && Number.isFinite(x);
const isPositiveFinite = (x) => isFiniteNumber(x) && x > 0;
const isInteger = (x) => Number.isInteger(x);

function cloneJson(value) {
    if (value === undefined) return undefined;
    if (typeof value === "number" && !Number.isFinite(value)) {
        throw new TypeError("canonical JSON cannot contain NaN or Infinity");
    }
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(cloneJson);
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = cloneJson(value[key]);
    return out;
}

/**
 * Stable JSON representation used for all experiment digests.
 * Object keys are sorted; array order is retained because order is meaningful for state and
 * instruction/effect transcripts.  JSON input cannot contain undefined, NaN, or Infinity.
 */
export function canonicalJson(value) {
    return JSON.stringify(cloneJson(value));
}

/** SHA-256 of bytes or UTF-8 text. */
export function sha256(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

/** SHA-256 of a JSON value with stable object-key ordering. */
export function digestObject(value) {
    return sha256(canonicalJson(value));
}

/**
 * p95 is the nearest-rank percentile.  This is intentionally labelled as an observed percentile
 * rather than a confidence interval: P0 has a small number of process-level samples.
 */
export function percentile(values, p = 0.95) {
    if (!Array.isArray(values) || values.length === 0) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const rank = Math.max(1, Math.ceil(p * sorted.length));
    return sorted[rank - 1];
}

export function median(values) {
    if (!Array.isArray(values) || values.length === 0) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Summarize positive nanosecond samples without inventing a statistical confidence interval. */
export function summarizeSamples(values) {
    if (!Array.isArray(values)) throw new TypeError("samples must be an array");
    const samples = values.map((x, i) => {
        if (!isPositiveFinite(x)) throw new TypeError(`sample[${i}] must be a positive finite number`);
        return x;
    });
    if (samples.length === 0) return null;
    const sorted = samples.slice().sort((a, b) => a - b);
    const sum = samples.reduce((a, b) => a + b, 0);
    const min = sorted[0], max = sorted[sorted.length - 1];
    return {
        count: samples.length,
        min_ns: min,
        median_ns: median(samples),
        p95_ns: percentile(samples, 0.95),
        max_ns: max,
        mean_ns: sum / samples.length,
        // This is an observed min/max interval, not a confidence interval.
        interval_ns: { kind: "observed_min_max", low_ns: min, high_ns: max },
    };
}

function regionBytes(region) {
    if (!isObject(region)) throw new TypeError("region must be an object");
    if (typeof region.hex !== "string" || !/^(?:[0-9a-f]{2})*$/i.test(region.hex)) {
        throw new TypeError(`region ${region.name ?? "?"} has invalid hex payload`);
    }
    const bytes = Buffer.from(region.hex, "hex");
    if (!isInteger(region.len) || region.len < 0 || bytes.length !== region.len) {
        throw new TypeError(`region ${region.name ?? "?"} length does not match hex payload`);
    }
    return bytes;
}

/** Digest the exact final guest regions, retaining payload bytes in the digest input. */
export function digestEffects(regions) {
    if (!Array.isArray(regions)) throw new TypeError("regions must be an array");
    const normalized = regions.map((region) => {
        const bytes = regionBytes(region);
        const actual = sha256(bytes);
        if (typeof region.sha256 !== "string" || region.sha256.toLowerCase() !== actual) {
            throw new TypeError(`region ${region.name ?? "?"} sha256 does not match hex payload`);
        }
        return {
            name: region.name,
            addr: region.addr,
            len: region.len,
            fields: region.fields ?? null,
            sha256: actual,
            hex: region.hex.toLowerCase(),
        };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.addr - b.addr);
    return digestObject(normalized);
}

export function digestState(state) {
    if (!isObject(state)) throw new TypeError("state must be an object");
    return digestObject(state);
}

function check(errors, condition, path, message) {
    if (!condition) errors.push({ path, message });
}

function checkSha(errors, value, path) {
    check(errors, typeof value === "string" && SHA256.test(value), path,
        "must be a lowercase hexadecimal SHA-256 digest");
}

function checkSampleSummary(errors, summary, values, path) {
    let expected;
    try { expected = summarizeSamples(values); }
    catch (e) {
        errors.push({ path, message: `cannot summarize samples: ${e.message}` });
        return;
    }
    if (expected === null) {
        check(errors, summary === null, path, "must be null when there are no samples");
        return;
    }
    check(errors, isObject(summary), path, "must be a summary object");
    if (!isObject(summary)) return;
    for (const key of ["count", "min_ns", "median_ns", "p95_ns", "max_ns", "mean_ns"]) {
        check(errors, summary[key] === expected[key], `${path}.${key}`, `must equal ${expected[key]}`);
    }
    check(errors, isObject(summary.interval_ns), `${path}.interval_ns`, "must be an interval object");
    if (isObject(summary.interval_ns)) {
        check(errors, summary.interval_ns.kind === "observed_min_max", `${path}.interval_ns.kind`,
            "must identify an observed min/max interval");
        check(errors, summary.interval_ns.low_ns === expected.interval_ns.low_ns,
            `${path}.interval_ns.low_ns`, `must equal ${expected.interval_ns.low_ns}`);
        check(errors, summary.interval_ns.high_ns === expected.interval_ns.high_ns,
            `${path}.interval_ns.high_ns`, `must equal ${expected.interval_ns.high_ns}`);
    }
}

function validateRegion(errors, region, path) {
    check(errors, isObject(region), path, "must be an object");
    if (!isObject(region)) return;
    check(errors, typeof region.name === "string" && region.name.length > 0, `${path}.name`, "must be non-empty");
    check(errors, isInteger(region.addr) && region.addr >= 0, `${path}.addr`, "must be a non-negative integer");
    check(errors, isInteger(region.len) && region.len >= 0, `${path}.len`, "must be a non-negative integer");
    checkSha(errors, region.sha256, `${path}.sha256`);
    try { regionBytes(region); }
    catch (e) { errors.push({ path: `${path}.hex`, message: e.message }); return; }
    try {
        const actual = sha256(Buffer.from(region.hex, "hex"));
        check(errors, region.sha256 === actual, `${path}.sha256`, `must equal payload digest ${actual}`);
    }
    catch (e) { errors.push({ path: `${path}.sha256`, message: e.message }); }
}

/** Validate the existing aot-oracle Arm A JSON before adapting it to the v1 result. */
export function validateArmARaw(raw, { caseId = null } = {}) {
    const errors = [];
    check(errors, isObject(raw), "$", "must be an object");
    if (!isObject(raw)) return { ok: false, errors };
    check(errors, raw.arm === "reference", "$.arm", "Arm A must come from the reference v86 arm");
    check(errors, raw.impl === "v86", "$.impl", "Arm A must report impl=v86");
    if (caseId !== null) check(errors, raw.case === caseId, "$.case", `must equal ${caseId}`);
    check(errors, raw.status === "ok", "$.status", "must be ok for a usable observation");
    if (raw.status !== "ok") return { ok: false, errors };

    check(errors, isObject(raw.outer), "$.outer", "must be an object");
    if (isObject(raw.outer)) {
        for (const key of ["warmup", "n1", "n2"]) {
            check(errors, isInteger(raw.outer[key]) && raw.outer[key] > 0, `$.outer.${key}`,
                "must be a positive integer");
        }
        if (isInteger(raw.outer.n1) && isInteger(raw.outer.n2)) {
            check(errors, raw.outer.n2 === raw.outer.n1 * 2, "$.outer.n2", "must be 2*n1 for the slope oracle");
        }
    }
    check(errors, isObject(raw.phase_ns), "$.phase_ns", "must be an object");
    if (isObject(raw.phase_ns)) {
        for (const key of ["p1", "p2"]) check(errors, isPositiveFinite(raw.phase_ns[key]), `$.phase_ns.${key}`,
            "must be a positive finite nanosecond value");
    }
    check(errors, isPositiveFinite(raw.ns_per_outer), "$.ns_per_outer", "must be a positive finite value");
    check(errors, isPositiveFinite(raw.guest_ins_per_outer), "$.guest_ins_per_outer",
        "must be a positive finite value");
    check(errors, isPositiveFinite(raw.guest_mips), "$.guest_mips", "must be a positive finite value");
    check(errors, Array.isArray(raw.regions), "$.regions", "must be an array");
    if (Array.isArray(raw.regions)) raw.regions.forEach((r, i) => validateRegion(errors, r, `$.regions[${i}]`));
    check(errors, isObject(raw.state), "$.state", "must contain host-side state for Arm A");
    check(errors, isObject(raw.jit), "$.jit", "must contain v86 JIT facts");
    check(errors, isObject(raw.jit_flags), "$.jit_flags", "must contain effective shipping JIT readback");
    check(errors, raw.relaxed_fpu === 0 || raw.relaxed_fpu === 1, "$.relaxed_fpu", "must be 0 or 1");
    check(errors, typeof raw.capture_eip === "string" && /^0x[0-9a-f]+$/i.test(raw.capture_eip),
        "$.capture_eip", "must be a hexadecimal guest EIP");
    return { ok: errors.length === 0, errors };
}

function missingBucket(reason = "not instrumented by this arm") {
    return { unit: "ns", status: "unavailable", source: "not-instrumented", samples_ns: null,
        summary: null, reason };
}

function measuredBucket(values, source) {
    return { unit: "ns", status: "measured", source, samples_ns: values, summary: summarizeSamples(values) };
}

function hexGuestAddress(value) {
    return `0x${(value >>> 0).toString(16)}`;
}

function defaultFunctionIdentity(caseDescriptor) {
    if (!isObject(caseDescriptor)) return null;
    const body = caseDescriptor.body;
    const bodyBytes = body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(body ?? []);
    const bodySha = sha256(bodyBytes);
    const entries = (caseDescriptor.calls ?? []).map((call) => (caseDescriptor.codeAddr + call.off) >>> 0);
    const key = { case_id: caseDescriptor.id, entry_eips: entries, body_sha256: bodySha };
    return {
        scheme: "guest-entry-set/body-sha256/v1",
        id: `guest:${caseDescriptor.id}:${digestObject(key).slice(0, 24)}`,
        case_id: caseDescriptor.id,
        entry_eips: entries.map(hexGuestAddress),
        code_page: (caseDescriptor.codeAddr >>> 12),
        body_bytes: bodyBytes.length,
        body_sha256: bodySha,
        source: caseDescriptor.provenance ?? null,
        observed: true,
        evidence: "aot-oracle corpus case identity plus final body hash",
    };
}

function expectedFunctionIdentityId(identity) {
    if (!isObject(identity) || !Array.isArray(identity.entry_eips) || typeof identity.case_id !== "string"
        || typeof identity.body_sha256 !== "string") return null;
    const entries = identity.entry_eips.map((entry) => {
        if (typeof entry !== "string" || !/^0x[0-9a-f]+$/i.test(entry)) return null;
        const parsed = Number.parseInt(entry, 16);
        return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 0xffffffff ? parsed : null;
    });
    if (entries.some((entry) => entry === null)) return null;
    const key = { case_id: identity.case_id, entry_eips: entries, body_sha256: identity.body_sha256 };
    return `guest:${identity.case_id}:${digestObject(key).slice(0, 24)}`;
}

function makeOracleChecks({ rawRuns, samples, functionIdentity, fixedWork, sampleErrors, envelope }) {
    const checks = [];
    const add = (id, ok, value, why) => checks.push({ id, ok: Boolean(ok), value, why });
    const allUsable = rawRuns.length > 0 && rawRuns.every((raw) => raw?.status === "ok");
    add("arm.reference-v86", rawRuns.length > 0 && rawRuns.every((raw) => raw?.arm === "reference" && raw?.impl === "v86"),
        rawRuns.map((raw) => ({ arm: raw?.arm ?? null, impl: raw?.impl ?? null })),
        "Arm A is the shipping v86 reference arm");
    add("arm.shipping-envelope", envelope?.jit?.matches_shipping === true
        && envelope?.jit?.relaxed_fpu === 1,
        { matches_shipping: envelope?.jit?.matches_shipping ?? null, relaxed_fpu: envelope?.jit?.relaxed_fpu ?? null },
        "Arm A must use the shipping JIT readback and relaxed FP policy");
    add("fixed-work.present", isObject(fixedWork) && typeof fixedWork.id === "string" && fixedWork.count > 0,
        { id: fixedWork?.id ?? null, count: fixedWork?.count ?? null },
        "fixed-work identity and count are required for a comparable measurement");
    add("function.identity", isObject(functionIdentity) && typeof functionIdentity.id === "string" && functionIdentity.observed === true,
        functionIdentity?.id ?? null, "attribution is keyed by observed guest entry/body identity");
    add("samples.usable", allUsable && samples.length === rawRuns.length && sampleErrors.length === 0,
        { raw_runs: rawRuns.length, usable_samples: samples.length, errors: sampleErrors.length },
        "every Arm A process must produce a valid fixed-work observation");
    add("state.digest", samples.length > 0 && samples.every((s) => typeof s.state_digest === "string" && SHA256.test(s.state_digest)),
        samples.map((s) => s.state_digest ?? null), "each sample must carry a state digest");
    add("effects.digest", samples.length > 0 && samples.every((s) => typeof s.effect_digest === "string" && SHA256.test(s.effect_digest)),
        samples.map((s) => s.effect_digest ?? null), "each sample must carry an exact effect digest");
    add("timing.rate", samples.length > 0 && samples.every((s) => isPositiveFinite(s.timing?.ns_per_outer)),
        samples.map((s) => s.timing?.ns_per_outer ?? null), "the two-point phase slope must be a positive rate");
    return checks;
}

/**
 * Adapt one or more existing `run-v86.mjs` reference results to the versioned Arm A envelope.
 * `rawRuns` entries may be raw results or `{ rep, raw }` records.
 */
export function makeArmAResult({
    rawRuns,
    caseDescriptor = null,
    workSpec,
    provenance,
    envelope,
    command = [],
    includeRaw = true,
    createdAt = new Date().toISOString(),
} = {}) {
    if (!Array.isArray(rawRuns) || rawRuns.length === 0) throw new TypeError("rawRuns must be non-empty");
    const raws = rawRuns.map((entry) => entry?.raw ?? entry);
    const caseId = workSpec?.case_id ?? raws.find((r) => r?.case)?.case ?? null;
    const sampleErrors = [];
    const rawChecks = raws.map((raw, i) => {
        const result = validateArmARaw(raw, { caseId });
        if (!result.ok) sampleErrors.push(...result.errors.map((e) => ({ ...e, rep: i })));
        return result;
    });
    const usable = raws.filter((raw, i) => rawChecks[i].ok);
    const first = usable[0] ?? null;
    const inferredN1 = first?.outer?.n1 ?? workSpec?.phase_counts?.p1 ?? workSpec?.count ?? null;
    const inferredN2 = first?.outer?.n2 ?? workSpec?.phase_counts?.p2 ?? (inferredN1 === null ? null : inferredN1 * 2);
    const inferredWarmup = first?.outer?.warmup ?? workSpec?.warmup ?? null;
    const inferredIns = first?.guest_ins_per_outer ?? workSpec?.guest_instructions_per_outer ?? null;
    const deltaCount = inferredN1 !== null && inferredN2 !== null ? inferredN2 - inferredN1 : null;
    const fixed = {
        schema_version: 1,
        id: workSpec?.id ?? `aot-oracle/${caseId ?? "unknown"}/outer-delta-v1`,
        case_id: caseId,
        unit: "outer-iterations",
        count: workSpec?.count ?? deltaCount,
        phase_counts: {
            warmup: workSpec?.phase_counts?.warmup ?? inferredWarmup,
            p1: workSpec?.phase_counts?.p1 ?? inferredN1,
            p2: workSpec?.phase_counts?.p2 ?? inferredN2,
            delta: workSpec?.phase_counts?.delta ?? deltaCount,
        },
        guest_instructions_per_unit: inferredIns,
        guest_instruction_count: inferredIns !== null && deltaCount !== null ? inferredIns * deltaCount : null,
        source: "aot-oracle phase markers and fixed outer-iteration contract",
        independent_of_engine_instruction_counter: true,
        ledger: {
            version: 1,
            authority: "runner-derived phase delta",
            completed_units: usable.length === raws.length ? (workSpec?.count ?? deltaCount) : null,
            completed_guest_instructions: usable.length === raws.length && inferredIns !== null && deltaCount !== null
                ? inferredIns * deltaCount : null,
            engine_instruction_counter_observed: usable.map((raw) => raw.state?.instruction_counter ?? null),
        },
    };

    const identity = workSpec?.function_identity ?? defaultFunctionIdentity(caseDescriptor);
    const samples = raws.map((raw, rep) => {
        const valid = rawChecks[rep].ok;
        if (!valid) return {
            rep,
            status: "arm_failed",
            timing: null,
            state_digest: null,
            effect_digest: null,
            raw: includeRaw ? raw : undefined,
        };
        const stateDigest = digestState(raw.state);
        const effectDigest = digestEffects(raw.regions);
        return {
            rep,
            status: "ok",
            timing: {
                phase_ns: { p1: raw.phase_ns.p1, p2: raw.phase_ns.p2 },
                phase_outer_count: { p1: raw.outer.n1, p2: raw.outer.n2 },
                delta_ns: raw.phase_ns.p2 - raw.phase_ns.p1,
                delta_outer_count: raw.outer.n2 - raw.outer.n1,
                ns_per_outer: raw.ns_per_outer,
                guest_ins_per_outer: raw.guest_ins_per_outer,
                guest_mips: raw.guest_mips,
            },
            state_digest: stateDigest,
            effect_digest: effectDigest,
            raw: includeRaw ? raw : undefined,
        };
    });
    const validSamples = samples.filter((s) => s.status === "ok");
    const totalNs = validSamples.map((s) => s.timing.ns_per_outer);
    const p1Ns = validSamples.map((s) => s.timing.phase_ns.p1);
    const p2Ns = validSamples.map((s) => s.timing.phase_ns.p2);
    const phaseSamples = samples.map((s) => ({
        rep: s.rep,
        status: s.status,
        p1_ns: s.timing?.phase_ns?.p1 ?? null,
        p2_ns: s.timing?.phase_ns?.p2 ?? null,
        delta_ns: s.timing?.delta_ns ?? null,
        delta_outer_count: s.timing?.delta_outer_count ?? null,
        ns_per_outer: s.timing?.ns_per_outer ?? null,
    }));
    const timing = {
        unit: "ns",
        clock: "process.hrtime.bigint (inside a child run-v86 process)",
        raw_samples: samples.map((s) => ({ rep: s.rep, status: s.status, ns_per_outer: s.timing?.ns_per_outer ?? null })),
        raw_samples_ns: totalNs,
        phase_samples: phaseSamples,
        summary: summarizeSamples(totalNs),
        buckets: {
            total: measuredBucket(totalNs, "v86 phase slope ns_per_outer"),
            phase_p1: measuredBucket(p1Ns, "v86 phase wall time"),
            phase_p2: measuredBucket(p2Ns, "v86 phase wall time"),
            dispatch: missingBucket(),
            entry: missingBucket(),
            guard: missingBucket(),
            body: missingBucket("Arm A does not instrument body separately from the v86 phase slope"),
            memory_preparation: missingBucket(),
            materialization: missingBucket(),
            helper: missingBucket(),
            exit: missingBucket(),
            compile: missingBucket("compilation/tiering is reported in raw jit facts, not wall-time bucketed"),
            publication: missingBucket("Arm A has no candidate publication"),
            baseline_residual: missingBucket(),
        },
    };

    const statePerSample = validSamples.map((s) => ({ rep: s.rep, digest: s.state_digest }));
    const effectPerSample = validSamples.map((s) => ({ rep: s.rep, digest: s.effect_digest }));
    const state = {
        algorithm: "sha256/canonical-json",
        source: "aot-oracle/lib/state.mjs readV86State",
        digest: statePerSample.length ? digestObject(statePerSample) : null,
        sample_digests: statePerSample,
        stable_across_samples: new Set(statePerSample.map((x) => x.digest)).size <= 1,
    };
    const effects = {
        algorithm: "sha256/canonical-json-of-final-regions",
        source: "aot-oracle/arms/run-v86.mjs regions()",
        digest: effectPerSample.length ? digestObject(effectPerSample) : null,
        sample_digests: effectPerSample,
        stable_across_samples: new Set(effectPerSample.map((x) => x.digest)).size <= 1,
        regions: validSamples[0]?.raw?.regions?.map((region) => ({
            name: region.name, addr: region.addr, len: region.len, sha256: region.sha256,
        })) ?? [],
    };
    const checks = makeOracleChecks({ rawRuns: raws, samples: validSamples, functionIdentity: identity,
        fixedWork: fixed, sampleErrors, envelope });
    const checksOk = checks.every((check) => check.ok);
    const hasArmFailure = raws.some((raw) => raw?.status !== "ok");
    const oracleVerdict = checksOk ? "BASELINE" : (hasArmFailure ? "ARM_FAILED" : "INVALID");
    const status = checksOk ? "ok" : (hasArmFailure ? "arm_failed" : "invalid");

    const result = {
        schema: { name: RESULT_SCHEMA_NAME, version: RESULT_SCHEMA_VERSION, id: RESULT_SCHEMA_ID },
        kind: "fixed-work-arm-result",
        arm: "A",
        implementation: { name: "v86-shipping", kind: "reference", version: envelope?.v86?.revision ?? null },
        status,
        created_at: createdAt,
        command: Array.isArray(command) ? command : [],
        provenance: provenance ?? {},
        envelope: envelope ?? {},
        fixed_work: fixed,
        function_identity: identity,
        timing,
        state,
        effects,
        oracle: {
            mode: "baseline-self-validation",
            verdict: oracleVerdict,
            comparable: false,
            differential_comparison: "not-run",
            checks,
            failures: checks.filter((c) => !c.ok).map((c) => ({ id: c.id, why: c.why, value: c.value })),
        },
        samples,
    };
    return result;
}

/** Validate a complete v1 result and return actionable paths rather than throwing. */
export function validateResult(result) {
    const errors = [];
    const warnings = [];
    check(errors, isObject(result), "$", "must be an object");
    if (!isObject(result)) return { ok: false, errors, warnings };
    check(errors, result.schema?.name === RESULT_SCHEMA_NAME, "$.schema.name", `must equal ${RESULT_SCHEMA_NAME}`);
    check(errors, result.schema?.version === RESULT_SCHEMA_VERSION, "$.schema.version", `must equal ${RESULT_SCHEMA_VERSION}`);
    check(errors, result.schema?.id === RESULT_SCHEMA_ID, "$.schema.id", `must equal ${RESULT_SCHEMA_ID}`);
    check(errors, result.kind === "fixed-work-arm-result", "$.kind", "must be fixed-work-arm-result");
    check(errors, result.arm === "A", "$.arm", "v1 runner currently validates Arm A only");
    check(errors, result.status === "ok" || result.status === "arm_failed" || result.status === "invalid",
        "$.status", "must be ok, arm_failed, or invalid");
    check(errors, typeof result.created_at === "string" && ISO.test(result.created_at), "$.created_at",
        "must be an ISO-8601 UTC timestamp with milliseconds");
    for (const key of ["provenance", "envelope", "fixed_work", "function_identity", "timing", "state", "effects", "oracle"]) {
        check(errors, isObject(result[key]), `$.${key}`, "must be an object");
    }
    check(errors, Array.isArray(result.samples) && result.samples.length > 0, "$.samples", "must be non-empty");
    if (!Array.isArray(result.samples) || result.samples.length === 0) return { ok: false, errors, warnings };

    const fixed = result.fixed_work;
    if (isObject(fixed)) {
        check(errors, typeof fixed.id === "string" && fixed.id.length > 0, "$.fixed_work.id", "must be non-empty");
        check(errors, fixed.unit === "outer-iterations", "$.fixed_work.unit", "must be outer-iterations");
        check(errors, isInteger(fixed.count) && fixed.count > 0, "$.fixed_work.count", "must be a positive integer");
        check(errors, isObject(fixed.phase_counts), "$.fixed_work.phase_counts", "must be an object");
        if (isObject(fixed.phase_counts)) {
            for (const key of ["warmup", "p1", "p2", "delta"]) {
                check(errors, isInteger(fixed.phase_counts[key]) && fixed.phase_counts[key] > 0,
                    `$.fixed_work.phase_counts.${key}`, "must be a positive integer");
            }
            if (isInteger(fixed.phase_counts.p1) && isInteger(fixed.phase_counts.p2)) {
                check(errors, fixed.phase_counts.p2 === fixed.phase_counts.p1 * 2,
                    "$.fixed_work.phase_counts.p2", "must be 2*p1");
                check(errors, fixed.phase_counts.delta === fixed.phase_counts.p2 - fixed.phase_counts.p1,
                    "$.fixed_work.phase_counts.delta", "must equal p2-p1");
                check(errors, fixed.count === fixed.phase_counts.delta, "$.fixed_work.count",
                    "must equal the measured fixed-work phase delta");
            }
        }
        check(errors, fixed.independent_of_engine_instruction_counter === true,
            "$.fixed_work.independent_of_engine_instruction_counter", "must explicitly separate the logical ledger");
    }
    const identity = result.function_identity;
    if (isObject(identity)) {
        check(errors, identity.scheme === "guest-entry-set/body-sha256/v1", "$.function_identity.scheme", "unsupported identity scheme");
        check(errors, typeof identity.id === "string" && identity.id.length > 0, "$.function_identity.id", "must be non-empty");
        check(errors, identity.case_id === fixed?.case_id, "$.function_identity.case_id", "must match fixed-work case_id");
        check(errors, Array.isArray(identity.entry_eips) && identity.entry_eips.length > 0,
            "$.function_identity.entry_eips", "must contain at least one guest entry");
        checkSha(errors, identity.body_sha256, "$.function_identity.body_sha256");
        const expectedId = expectedFunctionIdentityId(identity);
        check(errors, expectedId !== null && identity.id === expectedId, "$.function_identity.id",
            "must bind case_id, entry_eips, and body_sha256");
        check(errors, identity.observed === true, "$.function_identity.observed", "must be true for an attributed Arm A run");
    }
    const prov = result.provenance;
    if (isObject(prov)) {
        check(errors, isObject(prov.repository), "$.provenance.repository", "must contain repository provenance");
        check(errors, isObject(prov.v86), "$.provenance.v86", "must contain v86 provenance");
        check(errors, isObject(prov.runner), "$.provenance.runner", "must contain runner provenance");
        check(errors, isObject(prov.browser), "$.provenance.browser", "must contain browser revision (null is allowed)");
        if (isObject(prov.v86) && result.status === "ok") {
            checkSha(errors, prov.v86.engine_sha256, "$.provenance.v86.engine_sha256");
        }
    }
    const env = result.envelope;
    if (isObject(env)) {
        check(errors, isObject(env.v86), "$.envelope.v86", "must contain v86 identity");
        check(errors, isObject(env.jit), "$.envelope.jit", "must contain effective JIT readback");
        check(errors, isObject(env.memory), "$.envelope.memory", "must contain memory envelope");
        check(errors, isObject(env.abi), "$.envelope.abi", "must contain ABI versions");
        check(errors, isObject(env.execution), "$.envelope.execution", "must contain execution envelope");
        if (isObject(env.v86) && result.status === "ok") {
            checkSha(errors, env.v86.engine_sha256, "$.envelope.v86.engine_sha256");
        }
        if (isObject(env.jit) && result.status === "ok") {
            check(errors, env.jit.readback_verified === true, "$.envelope.jit.readback_verified",
                "must prove effective JIT values were read back");
            check(errors, env.jit.matches_shipping === true, "$.envelope.jit.matches_shipping",
                "Arm A result must use the shipping JIT shape");
            check(errors, env.jit.relaxed_fpu === 1, "$.envelope.jit.relaxed_fpu",
                "Arm A result must use relaxed FP policy 1");
        }
        if (isObject(env.memory)) check(errors, isInteger(env.memory.ram_size) && env.memory.ram_size > 0,
            "$.envelope.memory.ram_size", "must be a positive integer");
    }
    if (isObject(prov?.v86) && isObject(env?.v86) && result.status === "ok") check(errors,
        prov.v86.engine_sha256 === env.v86.engine_sha256,
        "$.envelope.v86.engine_sha256", "must match provenance.v86.engine_sha256");
    const seenReps = new Set();
    const stateDigests = [];
    const effectDigests = [];
    const timingNs = [];
    const usableRawRuns = [];
    for (const [i, sample] of result.samples.entries()) {
        const path = `$.samples[${i}]`;
        check(errors, isObject(sample), path, "must be an object");
        if (!isObject(sample)) continue;
        check(errors, isInteger(sample.rep) && sample.rep >= 0, `${path}.rep`, "must be a non-negative integer");
        if (seenReps.has(sample.rep)) errors.push({ path: `${path}.rep`, message: "duplicate repetition" });
        seenReps.add(sample.rep);
        check(errors, sample.status === "ok" || sample.status === "arm_failed", `${path}.status`, "unsupported sample status");
        check(errors, isObject(sample.raw), `${path}.raw`, "raw Arm A sample is required for auditability");
        if (isObject(sample.raw)) {
            if (sample.status === "ok") {
                const rawReport = validateArmARaw(sample.raw, { caseId: fixed?.case_id ?? null });
                if (!rawReport.ok) errors.push(...rawReport.errors.map((e) => ({ ...e, path: `${path}.raw${e.path === "$" ? "" : e.path.slice(1)}` })));
            }
            else {
                check(errors, sample.raw.arm === "reference", `${path}.raw.arm`,
                    "failed sample must identify the reference arm");
                check(errors, sample.raw.impl === "v86", `${path}.raw.impl`,
                    "failed sample must identify v86");
                check(errors, sample.raw.case === fixed?.case_id, `${path}.raw.case`,
                    "failed sample must retain the requested case");
                check(errors, sample.raw.status === "arm_failed", `${path}.raw.status`,
                    "failed sample raw status must be arm_failed");
                check(errors, typeof sample.raw.runner_error === "string" && sample.raw.runner_error.length > 0,
                    `${path}.raw.runner_error`, "failed sample must retain the runner error");
            }
            check(errors, (sample.status === "ok") === (sample.raw.status === "ok"), `${path}.status`,
                "must agree with raw Arm A status");
        }
        if (sample.status === "ok") {
            check(errors, isObject(sample.timing), `${path}.timing`, "must be present for an ok sample");
            if (isObject(sample.timing)) {
                check(errors, isPositiveFinite(sample.timing.ns_per_outer), `${path}.timing.ns_per_outer`, "must be positive");
                if (isPositiveFinite(sample.timing.ns_per_outer)) timingNs.push(sample.timing.ns_per_outer);
                check(errors, sample.timing.delta_outer_count === fixed?.phase_counts?.delta,
                    `${path}.timing.delta_outer_count`, "must equal fixed-work delta");
                check(errors, sample.timing.phase_ns?.p1 === sample.raw?.phase_ns?.p1,
                    `${path}.timing.phase_ns.p1`, "must equal raw phase p1");
                check(errors, sample.timing.phase_ns?.p2 === sample.raw?.phase_ns?.p2,
                    `${path}.timing.phase_ns.p2`, "must equal raw phase p2");
                check(errors, sample.timing.phase_outer_count?.p1 === sample.raw?.outer?.n1,
                    `${path}.timing.phase_outer_count.p1`, "must equal raw phase p1 count");
                check(errors, sample.timing.phase_outer_count?.p2 === sample.raw?.outer?.n2,
                    `${path}.timing.phase_outer_count.p2`, "must equal raw phase p2 count");
                check(errors, sample.timing.delta_ns === sample.raw?.phase_ns?.p2 - sample.raw?.phase_ns?.p1,
                    `${path}.timing.delta_ns`, "must equal raw phase delta");
                check(errors, sample.timing.ns_per_outer === sample.raw?.ns_per_outer,
                    `${path}.timing.ns_per_outer`, "must equal raw slope");
                check(errors, sample.timing.guest_ins_per_outer === sample.raw?.guest_ins_per_outer,
                    `${path}.timing.guest_ins_per_outer`, "must equal raw instruction rate");
            }
            checkSha(errors, sample.state_digest, `${path}.state_digest`);
            checkSha(errors, sample.effect_digest, `${path}.effect_digest`);
            if (isObject(sample.raw)) {
                try { check(errors, sample.state_digest === digestState(sample.raw.state), `${path}.state_digest`, "does not match raw state"); }
                catch (e) { errors.push({ path: `${path}.state_digest`, message: e.message }); }
                try { check(errors, sample.effect_digest === digestEffects(sample.raw.regions), `${path}.effect_digest`, "does not match raw effects"); }
                catch (e) { errors.push({ path: `${path}.effect_digest`, message: e.message }); }
            }
            stateDigests.push(sample.state_digest);
            effectDigests.push(sample.effect_digest);
            usableRawRuns.push(sample.raw);
        }
    }
    if (isObject(fixed)) {
        for (const [i, raw] of usableRawRuns.entries()) {
            check(errors, raw.outer?.warmup === fixed.phase_counts?.warmup,
                `$.samples[${i}].raw.outer.warmup`, "must equal fixed-work warmup");
            check(errors, raw.outer?.n1 === fixed.phase_counts?.p1,
                `$.samples[${i}].raw.outer.n1`, "must equal fixed-work phase p1");
            check(errors, raw.outer?.n2 === fixed.phase_counts?.p2,
                `$.samples[${i}].raw.outer.n2`, "must equal fixed-work phase p2");
            check(errors, raw.guest_ins_per_outer === fixed.guest_instructions_per_unit,
                `$.samples[${i}].raw.guest_ins_per_outer`, "must equal fixed-work instruction rate");
            if (isObject(env?.jit)) {
                check(errors, canonicalJson(raw.jit_flags) === canonicalJson(env.jit.readback),
                    `$.samples[${i}].raw.jit_flags`, "must equal envelope JIT readback");
                check(errors, raw.relaxed_fpu === env.jit.relaxed_fpu,
                    `$.samples[${i}].raw.relaxed_fpu`, "must equal envelope FP policy");
            }
        }
        const allSamplesUsable = usableRawRuns.length === result.samples.length;
        if (usableRawRuns.length > 0) {
            check(errors, fixed.guest_instruction_count === fixed.guest_instructions_per_unit * fixed.count,
                "$.fixed_work.guest_instruction_count", "must equal rate multiplied by fixed-work count");
        }
        else {
            check(errors, fixed.guest_instruction_count === null,
                "$.fixed_work.guest_instruction_count", "must be null with no usable samples");
        }
        check(errors, fixed.ledger?.completed_units === (allSamplesUsable ? fixed.count : null),
            "$.fixed_work.ledger.completed_units", "must match completed fixed work");
        check(errors, fixed.ledger?.completed_guest_instructions === (allSamplesUsable ? fixed.guest_instruction_count : null),
            "$.fixed_work.ledger.completed_guest_instructions", "must match completed guest work");
    }
    const timing = result.timing;
    if (isObject(timing)) {
        check(errors, timing.unit === "ns", "$.timing.unit", "must be nanoseconds");
        check(errors, Array.isArray(timing.raw_samples), "$.timing.raw_samples", "must be an array");
        check(errors, Array.isArray(timing.raw_samples_ns), "$.timing.raw_samples_ns", "must be an array");
        if (Array.isArray(timing.raw_samples)) {
            const expectedRawSamples = result.samples.map((sample) => ({
                rep: sample.rep, status: sample.status, ns_per_outer: sample.timing?.ns_per_outer ?? null,
            }));
            check(errors, JSON.stringify(timing.raw_samples) === JSON.stringify(expectedRawSamples),
                "$.timing.raw_samples", "does not match per-sample timing records");
        }
        if (Array.isArray(timing.raw_samples_ns)) {
            for (const [i, x] of timing.raw_samples_ns.entries()) check(errors, isPositiveFinite(x), `$.timing.raw_samples_ns[${i}]`, "must be positive");
            check(errors, JSON.stringify(timing.raw_samples_ns) === JSON.stringify(timingNs), "$.timing.raw_samples_ns", "does not match ok sample slopes");
            checkSampleSummary(errors, timing.summary, timing.raw_samples_ns, "$.timing.summary");
        }
        check(errors, isObject(timing.buckets), "$.timing.buckets", "must be an object");
        if (isObject(timing.buckets)) {
            for (const bucket of TIMING_BUCKETS) {
                check(errors, isObject(timing.buckets[bucket]), `$.timing.buckets.${bucket}`, "missing v1 bucket");
            }
            const total = timing.buckets.total;
            if (isObject(total) && Array.isArray(timing.raw_samples_ns)) {
                check(errors, JSON.stringify(total.samples_ns) === JSON.stringify(timing.raw_samples_ns),
                    "$.timing.buckets.total.samples_ns", "must equal timing.raw_samples_ns");
                checkSampleSummary(errors, total.summary, timing.raw_samples_ns, "$.timing.buckets.total.summary");
            }
        }
    }
    const state = result.state;
    if (isObject(state)) {
        check(errors, state.algorithm === "sha256/canonical-json", "$.state.algorithm", "unsupported state digest algorithm");
        check(errors, Array.isArray(state.sample_digests), "$.state.sample_digests", "must be an array");
        if (Array.isArray(state.sample_digests)) {
            if (state.sample_digests.length === 0) {
                check(errors, state.digest === null, "$.state.digest", "must be null with no usable samples");
            }
            else {
                checkSha(errors, state.digest, "$.state.digest");
                check(errors, digestObject(state.sample_digests) === state.digest, "$.state.digest", "does not match sample digests");
            }
            check(errors, JSON.stringify(state.sample_digests.map((x) => x.digest)) === JSON.stringify(stateDigests),
                "$.state.sample_digests", "does not match sample state digests");
        }
    }
    const effects = result.effects;
    if (isObject(effects)) {
        check(errors, effects.algorithm === "sha256/canonical-json-of-final-regions", "$.effects.algorithm", "unsupported effect digest algorithm");
        check(errors, Array.isArray(effects.sample_digests), "$.effects.sample_digests", "must be an array");
        if (Array.isArray(effects.sample_digests)) {
            if (effects.sample_digests.length === 0) {
                check(errors, effects.digest === null, "$.effects.digest", "must be null with no usable samples");
            }
            else {
                checkSha(errors, effects.digest, "$.effects.digest");
                check(errors, digestObject(effects.sample_digests) === effects.digest, "$.effects.digest", "does not match sample digests");
            }
            check(errors, JSON.stringify(effects.sample_digests.map((x) => x.digest)) === JSON.stringify(effectDigests),
                "$.effects.sample_digests", "does not match sample effect digests");
        }
    }
    const oracle = result.oracle;
    if (isObject(oracle)) {
        check(errors, ORACLE_VERDICTS.includes(oracle.verdict), "$.oracle.verdict", "unsupported oracle verdict");
        check(errors, oracle.mode === "baseline-self-validation", "$.oracle.mode", "unsupported Arm A oracle mode");
        check(errors, oracle.comparable === false, "$.oracle.comparable", "Arm A has no differential candidate");
        check(errors, Array.isArray(oracle.checks), "$.oracle.checks", "must be an array");
        if (Array.isArray(oracle.checks)) oracle.checks.forEach((entry, i) => {
            check(errors, isObject(entry), `$.oracle.checks[${i}]`, "must be an object");
            if (isObject(entry)) {
                check(errors, typeof entry.id === "string" && entry.id.length > 0,
                    `$.oracle.checks[${i}].id`, "must be non-empty");
                check(errors, typeof entry.ok === "boolean", `$.oracle.checks[${i}].ok`, "must be boolean");
            }
        });
        if (oracle.verdict === "BASELINE") {
            check(errors, result.status === "ok", "$.status", "BASELINE requires a usable result");
            check(errors, oracle.checks?.every((x) => x.ok === true), "$.oracle.checks", "BASELINE requires all checks to pass");
        }
        if (oracle.verdict === "ARM_FAILED") {
            check(errors, result.status === "arm_failed", "$.status", "ARM_FAILED requires arm_failed status");
        }
    }
    // `includeRaw=false` is intentionally rejected in v1: a baseline without the exact source
    // observation cannot be audited or re-digested after the fact.
    if (result.samples.some((sample) => !isObject(sample.raw))) warnings.push({
        path: "$.samples[*].raw", message: "raw sample missing; v1 requires raw evidence for accepted P0 baselines",
    });
    return { ok: errors.length === 0, errors, warnings };
}

export function assertValidResult(result) {
    const report = validateResult(result);
    if (!report.ok) {
        const detail = report.errors.map((e) => `${e.path}: ${e.message}`).join("\n");
        throw new Error(`invalid ${RESULT_SCHEMA_ID}:\n${detail}`);
    }
    return result;
}
