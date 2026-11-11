import { prepareUnit, runV86Arm, sha256Hex } from "../../aot-oracle/browser/fixed-work.mjs";
import { flattenState } from "../../aot-oracle/lib/state.mjs";
import { median, spreadPct, steady, timingProblems } from "../../aot-oracle/lib/gates.mjs";
import { checkK8Payload } from "./stack-oracle.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function orderForRound(names, index) {
    const rotation = Math.floor(index / 2) % names.length;
    const rotated = [...names.slice(rotation), ...names.slice(0, rotation)];
    return index % 2 ? rotated.reverse() : rotated;
}

export async function runIsolatedSample(options, workerFactory = (url, opts) => new Worker(url, opts)) {
    const worker = workerFactory("/tools/aot/opt/stack-sample.mjs", { type: "module" });
    let timer;
    try {
        return await new Promise((resolve, reject) => {
            timer = setTimeout(() => resolve({ status: "SAMPLE_WORKER_TIMEOUT" }), (options.timeoutMs ?? 300_000) + 30_000);
            worker.onmessage = ({ data }) => {
                if (data.type === "result") resolve(data.sample);
            };
            worker.onerror = (e) => resolve({ status: "SAMPLE_WORKER_ERROR", why: e.message });
            worker.onmessageerror = () => resolve({ status: "SAMPLE_WORKER_MESSAGE_ERROR" });
            try { worker.postMessage(options); } catch (e) { reject(e); }
        });
    } finally {
        clearTimeout(timer);
        worker.terminate();
    }
}

export function noLoadedModules(probe) {
    return Array.isArray(probe?.state?.modules) && probe.state.modules.length === 0;
}

export function hostGuestQuiescent(probe) {
    const ping = probe?.ping;
    return ping?.ok === true && (ping.hasProcess === false && probe.state?.cpu === null
        || ping.hasProcess === true && ping.paused === true);
}

export function compareHosted(reference, candidate) {
    const problems = [];
    const expected = new Map(reference.regions.map((r) => [r.name, r]));
    if (candidate.regions.length !== expected.size) problems.push("region count differs");
    for (const r of candidate.regions) {
        const e = expected.get(r.name);
        if (!e || e.addr !== r.addr || e.len !== r.len || e.hex !== r.hex) {
            problems.push(`region ${r.name} differs`);
        }
        expected.delete(r.name);
    }
    if (expected.size) problems.push(`missing regions ${[...expected.keys()].join(",")}`);
    const a = flattenState(reference.state), b = new Map(flattenState(candidate.state));
    if (a.length !== b.size) problems.push("state field count differs");
    for (const [key, value] of a) {
        if (value == null || b.get(key) == null) problems.push(`state ${key} uncompared`);
        else if (b.get(key) !== value) problems.push(`state ${key} differs: ${value}/${b.get(key)}`);
    }
    if (JSON.stringify(reference.shape) !== JSON.stringify(candidate.shape)) problems.push("JIT shape differs");
    if (reference.workload_sha256 !== candidate.workload_sha256) problems.push("workload hash differs");
    return problems;
}

export function validateHosted(sample, requiresUnit) {
    const problems = [];
    if (sample.status !== "ok") return [`arm status ${sample.status}`];
    const ledger = sample.ledger;
    if (!ledger || ledger.instruction_counter_wrap_risk
        || ledger.retired.p1 !== ledger.expected.p1 || ledger.retired.p2 !== ledger.expected.p2) {
        problems.push("phase retired-instruction ledger differs from canonical image");
    }
    try { checkK8Payload(sample.regions); } catch (e) { problems.push(String(e.message)); }
    const spill = sample.regions.find((r) => r.name === "STATE");
    if (!spill || !/[1-9a-f]/.test(spill.hex)) problems.push("guest register spill missing");
    if (requiresUnit) {
        for (const key of ["registered", "alive", "sameFn", "ownsPage", "entered"]) {
            if (sample.aot?.[key] !== true) problems.push(`candidate not ${key}`);
        }
        if (!(sample.aot?.entries > 0)) problems.push("candidate has no measured entries");
    } else if (sample.aot) problems.push("shipping baseline published a unit");
    return problems;
}

async function idleProbe() {
    const latenessMs = [];
    for (let i = 0; i < 10; i++) {
        const before = performance.now();
        await pause(20);
        latenessMs.push(Math.max(0, performance.now() - before - 20));
    }
    return { requested_ms: 20, lateness_ms: latenessMs, median_ms: median(latenessMs),
        max_ms: Math.max(...latenessMs) };
}

function unitIdentity(unit) {
    return { manifest_sha256: unit.manifest_sha256,
        unit_sha256: unit.units.map((u) => u.sha256),
        relocations: unit.manifest.relocations ?? {}, jit_identity: unit.manifest.jit_identity,
        compiler: unit.manifest.compiler ?? null, loop_counter: unit.manifest.loop_counter ?? null,
        diagnostic: unit.manifest.diagnostic ?? null };
}

function sameUnits(a, b) {
    const strip = (u) => ({ sha256: u.sha256, tableIndex: u.tableIndex, pages: u.pages,
        relocs: u.relocs ?? [] });
    return JSON.stringify(a.units.map(strip)) === JSON.stringify(b.units.map(strip))
        && JSON.stringify(a.manifest.relocations ?? {}) === JSON.stringify(b.manifest.relocations ?? {});
}

export function judgeStackReport(report, { minRounds = 6, maxSpreadPct = 10 } = {}) {
    const correctness = [], measurement = [];
    const names = report.arm_names;
    if (!report.rounds.length) correctness.push("no samples");
    if (!report.identity_bytes_equal) correctness.push("identity control does not carry semantic arm bytes");
    if (report.rounds.length < minRounds) measurement.push(`need ${minRounds} rounds`);
    if (report.rounds.length % 2) measurement.push("order is unbalanced");
    if (report.environment?.occupancy_ok !== true) measurement.push("browser occupancy unverified");
    if (report.environment?.host_guest_quiescent !== true) measurement.push("host guest quiescence unverified");
    if (report.environment?.no_loaded_modules !== true) measurement.push("host loaded-module absence unverified");
    if (report.environment?.stock_browser !== true) measurement.push("stock browser command line unverified");
    for (const round of report.rounds) {
        const shipping = round.samples.shipping;
        for (const name of names) {
            const sample = round.samples[name];
            if (!sample) { correctness.push(`round ${round.index} missing ${name}`); continue; }
            if (name === "emscripten") {
                try { checkK8Payload(sample.regions); } catch (e) { correctness.push(String(e.message)); }
                const n = report.config.outer, w = report.config.warmup;
                const calls = sample.completedCalls;
                if (!calls || calls.warmup !== w || calls.p1 !== n || calls.p2 !== n * 2
                    || calls.total !== w + n * 3) correctness.push("direct reference completed-call ledger differs");
            } else {
                correctness.push(...validateHosted(sample, name !== "shipping")
                    .map((p) => `round ${round.index} ${name}: ${p}`));
                if (shipping?.status === "ok" && sample.status === "ok") {
                    correctness.push(...compareHosted(shipping, sample).map((p) => `round ${round.index} ${name}: ${p}`));
                }
            }
            if (sample.status !== "ok" || timingProblems(sample).length || !steady(sample).ok) {
                measurement.push(`round ${round.index} ${name} timing is not steady`);
            }
        }
    }
    const stats = {};
    for (const name of names) {
        const raw = report.rounds.map((r) => r.samples[name]?.ns_per_outer);
        if (raw.some((x) => !(Number.isFinite(x) && x > 0))) continue;
        stats[name] = { raw_ns_per_outer: raw, median_ns_per_outer: median(raw), spread_pct: spreadPct(raw) };
    }
    const ratios = {};
    for (const [label, first, second] of [["semantic/identity", "semantic", "identity"],
        ["semantic/stack", "semantic", "stack"], ["shipping/stack", "shipping", "stack"],
        ["stack/emscripten", "stack", "emscripten"]]) {
        if (!names.includes(second)) continue;
        const raw = report.rounds.map((r) => r.samples[first]?.ns_per_outer / r.samples[second]?.ns_per_outer);
        if (raw.some((x) => !(Number.isFinite(x) && x > 0))) continue;
        ratios[label] = { raw, median: median(raw), spread_pct: spreadPct(raw) };
        if (spreadPct(raw) > maxSpreadPct) measurement.push(`${label} paired spread exceeds ${maxSpreadPct}%`);
    }
    const control = ratios["semantic/identity"];
    const noiseFloorPct = control ? Math.max(...control.raw.map((r) => Math.abs(r - 1) * 100)) : null;
    if (noiseFloorPct === null) measurement.push("identity noise floor unavailable");
    const improvement = ratios["semantic/stack"] ? (ratios["semantic/stack"].median - 1) * 100 : null;
    const measured = correctness.length === 0 && measurement.length === 0;
    const aboveNoise = improvement !== null && noiseFloorPct !== null && Math.abs(improvement) > noiseFloorPct;
    return {
        correctness_ok: correctness.length === 0, measurement_valid: measured,
        performance_accepted: measured && aboveNoise,
        causal_speedup_accepted: measured && aboveNoise && improvement > 0,
        attribution: !measured ? "withheld" : !aboveNoise ? "directional-only-within-noise"
            : improvement > 0 ? "measured-speedup" : "measured-regression",
        correctness_problems: correctness, measurement_problems: measurement, stats, paired_ratios: ratios,
        noise_floor: { method: "max-absolute-paired-identity-delta", pct: noiseFloorPct,
            contract: "same-byte semantic AOT module, fresh engines, same workload and window" },
        candidate_delta_pct: improvement,
        candidate_delta_above_noise: aboveNoise,
    };
}

/** Stock-browser orchestrator; each sample owns a fresh engine and optionally a fresh worker. */
export async function runStackExperiment(config, progress = () => {}) {
    const { outer, warmup, rounds, engineDir, engineSha } = config;
    if (![outer, warmup, rounds].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("invalid counts");
    if (rounds % 2) throw new Error("rounds must be even for balanced order");
    const engineBytes = new Uint8Array(await (await fetch(`${engineDir}/v86.wasm`)).arrayBuffer());
    const actualEngineSha = await sha256Hex(engineBytes);
    if (actualEngineSha !== engineSha) throw new Error("served engine hash differs from configured binary");
    const engineModule = await WebAssembly.compile(engineBytes);
    const V86 = config.freshSampleWorkers ? null : (await import(`${engineDir}/libv86.mjs`)).V86;
    const prepared = {};
    for (const name of ["semantic", "identity", "stack"]) prepared[name] = await prepareUnit(config.units[name]);
    const direct = config.directReference;
    let directBytes = null, directHashes = null;
    if (direct) {
        const source = new Uint8Array(await (await fetch(direct.moduleUrl)).arrayBuffer());
        directBytes = new Uint8Array(await (await fetch(direct.wasmUrl)).arrayBuffer());
        directHashes = { module_sha256: await sha256Hex(source), wasm_sha256: await sha256Hex(directBytes) };
        if (directHashes.module_sha256 !== direct.moduleSha || directHashes.wasm_sha256 !== direct.wasmSha) {
            throw new Error("served direct-reference hashes differ from configured build: " + JSON.stringify({
                moduleUrl: direct.moduleUrl, wasmUrl: direct.wasmUrl,
                expected: { module_sha256: direct.moduleSha, wasm_sha256: direct.wasmSha }, actual: directHashes,
            }));
        }
    }
    const referenceAdapter = direct && !config.freshSampleWorkers ? await import(direct.adapterUrl) : null;
    const names = ["shipping", "semantic", "identity", "stack", ...(direct ? ["emscripten"] : [])];
    const report = {
        experiment: "k8-stack-load-forwarding", version: 1, status: "running",
        config, arm_names: names, engine_sha256: actualEngineSha,
        execution_mode: config.freshSampleWorkers ? "fresh-sample-workers" : "shared-worker",
        schedule: { method: "rotating-reversed-pairs", complete_position_blocks: rounds % (names.length * 2) === 0 },
        direct_reference_hashes: directHashes,
        units: Object.fromEntries(Object.entries(prepared).map(([name, unit]) => [name, unitIdentity(unit)])),
        identity_bytes_equal: sameUnits(prepared.semantic, prepared.identity),
        environment: { ...config.environment, user_agent: navigator.userAgent,
            hardware_concurrency: navigator.hardwareConcurrency, cross_origin_isolated: crossOriginIsolated,
            timer_resolution_ms: await timerResolution(), idle_before: await idleProbe() },
        rounds: [],
    };
    for (let index = 0; index < rounds; index++) {
        const order = orderForRound(names, index);
        const samples = {};
        for (const name of order) {
            progress({ round: index, arm: name });
            let sample;
            try {
                sample = config.freshSampleWorkers
                    ? await runIsolatedSample({ name, outer, warmup, engineDir, engineSha, engineModule,
                        unit: name === "shipping" || name === "emscripten" ? null : prepared[name],
                        direct, directBytes, timeoutMs: config.sampleTimeoutMs })
                    : name === "emscripten"
                    ? await (await referenceAdapter.createReference(direct.moduleUrl, { wasmBinary: directBytes })).runOnce({ outer, warmup })
                    : await runV86Arm({ V86, caseId: "k8", outer, warmup, engineDir, engineSha,
                        engineModule, unit: name === "shipping" ? null : prepared[name], timeoutMs: config.sampleTimeoutMs });
            } catch (e) { sample = { status: "ARM_ERROR", why: String(e?.stack ?? e) }; }
            samples[name] = sample;
            await pause(50);
        }
        report.rounds.push({ index, order, samples });
        progress({ completed_rounds: report.rounds.length });
    }
    report.environment.idle_after = await idleProbe();
    report.status = "ok";
    report.verdict = judgeStackReport(report, config.gates);
    return report;
}

async function timerResolution() {
    let previous = performance.now(), minimum = Infinity;
    for (let i = 0; i < 10_000; i++) {
        const now = performance.now();
        if (now > previous) minimum = Math.min(minimum, now - previous);
        previous = now;
    }
    return Number.isFinite(minimum) ? minimum : null;
}

if (typeof process === "undefined" && typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
    self.onmessage = async ({ data }) => {
        try {
            const result = await runStackExperiment(data, (progress) => self.postMessage({ type: "progress", progress }));
            self.postMessage({ type: "result", result });
        } catch (e) { self.postMessage({ type: "error", error: String(e?.stack ?? e) }); }
    };
}
