import test from "node:test";
import assert from "node:assert/strict";
import { compareHosted, judgeStackReport, hostGuestQuiescent, noLoadedModules, orderForRound, runIsolatedSample } from "./browser-stack.mjs";
import { bytesHex, expectedK8Payload } from "./stack-oracle.mjs";
import * as L from "../../aot-oracle/corpus/layout.mjs";

const state = () => ({
    regs: Object.fromEntries(["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"].map((r) => [r, 0])),
    eip: 0x20000, eflags: 2,
    lazy: { flags: 2, flags_changed: 0, last_op1: 0, last_result: 0, last_op_size: 0 },
    fpu: { stack_ptr: 0, stack_empty: 255, control_word: 895, status_word: 0, simd_dirty: 0, st: Array(32).fill(0) },
    simd: { mxcsr: 8064, xmm: Array(32).fill(0) }, instruction_counter: 50200,
});
const arm = (unit) => ({
    status: "ok", phase_ns: { p1: 1e6, p2: 2e6 }, ns_per_outer: 10000,
    ledger: { retired: { p1: 50204, p2: 100404 }, expected: { p1: 50204, p2: 100404 },
        instruction_counter_wrap_risk: false },
    regions: [{ name: "K8_DST", addr: L.K8_DST, len: expectedK8Payload().length, hex: bytesHex(expectedK8Payload()) },
        { name: "STATE", addr: L.STATE, len: 36, hex: "01".repeat(36) }],
    state: state(), shape: { shipping: 1 }, workload_sha256: "same",
    aot: unit ? { registered: true, alive: true, sameFn: true, ownsPage: true, entered: true, entries: 100 } : null,
});
const report = () => ({
    config: { outer: 100, warmup: 100 }, identity_bytes_equal: true,
    environment: { occupancy_ok: true, stock_browser: true, host_guest_quiescent: true, no_loaded_modules: true },
    arm_names: ["shipping", "semantic", "identity", "stack"],
    rounds: Array.from({ length: 6 }, (_, index) => ({ index,
        samples: { shipping: arm(false), semantic: arm(true), identity: arm(true), stack: arm(true) } })),
});

test("same-byte control accepts a steady, identical workload", () => {
    const verdict = judgeStackReport(report());
    assert.equal(verdict.correctness_ok, true);
    assert.equal(verdict.measurement_valid, true);
    assert.equal(verdict.performance_accepted, false);
    assert.equal(verdict.attribution, "directional-only-within-noise");
    assert.equal(verdict.noise_floor.pct, 0);
    assert.equal(verdict.candidate_delta_above_noise, false);
});

test("hex differences are compared without optional hashes", () => {
    const a = arm(false), b = arm(true);
    b.regions[0].hex = "ff" + b.regions[0].hex.slice(2);
    assert.ok(compareHosted(a, b).includes("region K8_DST differs"));
});

test("speedup must exceed the measured identical-byte floor", () => {
    const r = report();
    for (const round of r.rounds) {
        round.samples.identity.ns_per_outer = 10200;
        round.samples.stack.ns_per_outer = 9900;
    }
    const within = judgeStackReport(r);
    assert.equal(within.measurement_valid, true);
    assert.equal(within.performance_accepted, false);
    assert.equal(within.causal_speedup_accepted, false);
    assert.equal(within.attribution, "directional-only-within-noise");
    for (const round of r.rounds) round.samples.stack.ns_per_outer = 8000;
    const above = judgeStackReport(r);
    assert.equal(above.performance_accepted, true);
    assert.equal(above.causal_speedup_accepted, true);
    assert.equal(above.attribution, "measured-speedup");
});

for (const [label, change] of [
    ["lost function ownership", (r) => { r.rounds[2].samples.stack.aot.sameFn = false; }],
    ["wrong absolute ledger", (r) => { r.rounds[2].samples.stack.ledger.retired.p1--; }],
    ["unreadable CPU state", (r) => { r.rounds[2].samples.stack.state.eflags = null; }],
    ["canonical output divergence", (r) => { r.rounds[2].samples.stack.regions[0].hex = "00".repeat(1024); }],
    ["identity byte mismatch", (r) => { r.identity_bytes_equal = false; }],
]) {
    test(`refuses ${label}`, () => {
        const r = report(); change(r);
        assert.equal(judgeStackReport(r).correctness_ok, false);
        assert.equal(judgeStackReport(r).performance_accepted, false);
    });
}

test("correctness survives a short run while performance is withheld", () => {
    const r = report(); r.rounds.splice(2);
    const verdict = judgeStackReport(r);
    assert.equal(verdict.correctness_ok, true);
    assert.equal(verdict.performance_accepted, false);
});

test("unverified browser occupancy or V8 flags withhold attribution", () => {
    for (const key of ["occupancy_ok", "stock_browser", "host_guest_quiescent", "no_loaded_modules"]) {
        const r = report(); r.environment[key] = false;
        assert.equal(judgeStackReport(r).correctness_ok, true);
        assert.equal(judgeStackReport(r).performance_accepted, false);
    }
});

test("an unpaused BIOS process refuses host quiescence", () => {
    const probe = { ping: { ok: true, hasProcess: true, paused: false },
        state: { cpu: { eip: 0xffff0 }, modules: [] } };
    assert.equal(noLoadedModules(probe), true);
    assert.equal(hostGuestQuiescent(probe), false);
    probe.ping.paused = true;
    assert.equal(hostGuestQuiescent(probe), true);
    probe.state.modules.push({ name: "game.exe" });
    assert.equal(noLoadedModules(probe), false);
});

test("ten rounds balance every arm twice in every position and reverse each pair", () => {
    const names = ["shipping", "semantic", "identity", "stack", "emscripten"];
    const counts = Object.fromEntries(names.map((name) => [name, Array(names.length).fill(0)]));
    const orders = Array.from({ length: 10 }, (_, index) => orderForRound(names, index));
    for (let index = 0; index < orders.length; index++) {
        assert.deepEqual([...orders[index]].sort(), [...names].sort());
        if (index % 2) assert.deepEqual(orders[index], [...orders[index - 1]].reverse());
        orders[index].forEach((name, position) => counts[name][position]++);
    }
    for (const row of Object.values(counts)) assert.deepEqual(row, [2, 2, 2, 2, 2]);
});

function sampleWorker(onPost) {
    const worker = { terminated: false, posted: null,
        postMessage(options) { this.posted = options; onPost?.(worker); },
        terminate() { this.terminated = true; } };
    const factory = (url, options) => {
        assert.equal(url, "/tools/aot/opt/stack-sample.mjs");
        assert.deepEqual(options, { type: "module" });
        return worker;
    };
    return { worker, factory };
}

test("fresh sample worker returns raw data and terminates on success", async () => {
    const sample = arm(false);
    const { worker, factory } = sampleWorker((w) => queueMicrotask(() => w.onmessage({ data: { type: "result", sample } })));
    const options = { name: "shipping", engineModule: "module-clone" };
    assert.deepEqual(await runIsolatedSample(options, factory), sample);
    assert.equal(worker.posted, options);
    assert.equal(worker.terminated, true);
});

test("fresh sample worker terminates on execution error", async () => {
    const { worker, factory } = sampleWorker((w) => queueMicrotask(() => w.onerror({ message: "failed import" })));
    assert.deepEqual(await runIsolatedSample({}, factory), { status: "SAMPLE_WORKER_ERROR", why: "failed import" });
    assert.equal(worker.terminated, true);
});

test("fresh sample worker terminates when structured clone fails", async () => {
    const { worker, factory } = sampleWorker(() => { throw new Error("clone failed"); });
    await assert.rejects(runIsolatedSample({}, factory), /clone failed/);
    assert.equal(worker.terminated, true);
});

test("fresh sample worker terminates after its parent deadline", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { worker, factory } = sampleWorker();
    const pending = runIsolatedSample({ timeoutMs: 1000 }, factory);
    t.mock.timers.tick(31000);
    assert.deepEqual(await pending, { status: "SAMPLE_WORKER_TIMEOUT" });
    assert.equal(worker.terminated, true);
});
