import test from "node:test";
import assert from "node:assert/strict";
import { AudioPauseSync } from "../../src/audio/pause-sync";
import { AudioEngine } from "../../src/audio/audio-engine";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

function fakeEngine(gate?: () => Promise<void>) {
    const calls: string[] = [];
    return {
        calls,
        async pause() { calls.push("pause"); if (gate) await gate(); },
        async resume() { calls.push("resume"); if (gate) await gate(); },
    };
}

test("worker pause then resume is forwarded to the engine", async () => {
    const engine = fakeEngine();
    const sync = new AudioPauseSync(engine);
    await sync.set(true);
    await sync.set(false);
    assert.deepEqual(engine.calls, ["pause", "resume"]);
});

test("a UI request and the worker echo of it reach the engine once", async () => {
    const engine = fakeEngine();
    const sync = new AudioPauseSync(engine);
    const ui = sync.set(true);
    const echo = sync.set(true);
    await Promise.all([ui, echo]);
    await sync.set(true);
    assert.deepEqual(engine.calls, ["pause"]);
});

test("resume without a prior pause never touches the engine", async () => {
    const engine = fakeEngine();
    const sync = new AudioPauseSync(engine);
    await sync.set(false);
    assert.deepEqual(engine.calls, []);
});

test("rapid park/unpark flips coalesce to the latest state without overlapping engine calls", async () => {
    const gates: Array<ReturnType<typeof deferred>> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: string[] = [];
    const engine = {
        async pause() { await hold("pause"); },
        async resume() { await hold("resume"); },
    };
    async function hold(name: string) {
        calls.push(name);
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        const gate = deferred(); gates.push(gate);
        await gate.promise;
        inFlight--;
    }
    const sync = new AudioPauseSync(engine);
    const first = sync.set(true);
    sync.set(false); sync.set(true); sync.set(false); sync.set(true);
    assert.deepEqual(calls, ["pause"]);
    gates[0].resolve();
    await Promise.resolve(); await Promise.resolve();
    // Latest request is "paused", which is what the first call already applied.
    await first;
    assert.deepEqual(calls, ["pause"]);
    assert.equal(maxInFlight, 1);
});

test("a flip that lands during a pending call is applied afterwards", async () => {
    const gates: Array<ReturnType<typeof deferred>> = [];
    const engine = fakeEngine(() => { const g = deferred(); gates.push(g); return g.promise; });
    const sync = new AudioPauseSync(engine);
    const done = sync.set(true);
    sync.set(false);
    gates[0].resolve();
    await new Promise(r => setTimeout(r, 0));
    gates[1].resolve();
    await done;
    assert.deepEqual(engine.calls, ["pause", "resume"]);
});

test("an engine failure does not wedge later requests", async () => {
    const calls: string[] = [];
    let fail = true;
    const engine = {
        async pause() { calls.push("pause"); if (fail) { fail = false; throw new Error("boom"); } },
        async resume() { calls.push("resume"); },
    };
    const sync = new AudioPauseSync(engine);
    const warn = console.warn; console.warn = () => {};
    try { await sync.set(true); } finally { console.warn = warn; }
    await sync.set(false);
    assert.deepEqual(calls, ["pause", "resume"]);
});

test("with the real engine, the context ends suspended iff the last request was paused", async () => {
    const engine = new AudioEngine();
    const context = {
        state: "running",
        async resume() { await Promise.resolve(); this.state = "running"; },
        async suspend() { await Promise.resolve(); this.state = "suspended"; },
    };
    Object.assign(engine, {
        context, ensureContext: () => context,
        ensureReady: async () => {},
        node: { port: { postMessage: () => {} } },
    });
    const sync = new AudioPauseSync(engine);
    const pending = [true, false, true, false, false, true].map(p => sync.set(p));
    await Promise.all(pending);
    assert.equal(context.state, "suspended");
    await sync.set(false);
    assert.equal(context.state, "running");
    // An automatic unlock path must not undo a pause that is still in force.
    await sync.set(true);
    await engine.resumeIfNotPaused();
    assert.equal(context.state, "suspended");
});
