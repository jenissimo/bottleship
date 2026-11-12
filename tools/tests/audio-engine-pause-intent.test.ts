import test from "node:test";
import assert from "node:assert/strict";
import { AudioEngine } from "../../src/audio/audio-engine";
import fs from "node:fs";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

function mockedEngine(initialState = "suspended") {
    const engine = new AudioEngine();
    const calls = { resume: 0, suspend: 0, ready: 0, messages: [] as unknown[] };
    const context = {
        state: initialState,
        async resume() { calls.resume++; this.state = "running"; },
        async suspend() { calls.suspend++; this.state = "suspended"; },
    };
    Object.assign(engine, {
        context, ensureContext: () => context,
        ensureReady: async () => { calls.ready++; },
        node: { port: { postMessage: (message: unknown) => calls.messages.push(message) } },
    });
    return { engine, context, calls, paused: () => (engine as unknown as { userPaused: boolean }).userPaused };
}

test("a gesture retries resume while a pre-gesture request is pending", async () => {
    const engine = new AudioEngine();
    let finishFirst!: () => void;
    let resumes = 0;
    let ready = 0;
    const context = {
        state: "suspended",
        resume() {
            resumes++;
            if (resumes === 1) return new Promise<void>(resolve => { finishFirst = resolve; });
            this.state = "running";
            return Promise.resolve();
        },
    };
    Object.assign(engine, { ensureContext: () => context, ensureReady: async () => { ready++; } });
    const first = engine.resume();
    const second = engine.resume();
    assert.equal(resumes, 2);
    await second;
    assert.equal(ready, 1);
    finishFirst();
    await first;
});

test("running-context requests share source restoration", async () => {
    const engine = new AudioEngine();
    let finishReady!: () => void;
    let ready = 0;
    Object.assign(engine, {
        ensureContext: () => ({ state: "running" }),
        ensureReady: () => { ready++; return new Promise<void>(resolve => { finishReady = resolve; }); },
    });
    const first = engine.resume();
    const second = engine.resume();
    assert.equal(ready, 1);
    finishReady();
    await Promise.all([first, second]);
});

test("automatic registration and gesture unlocks preserve harness pause; explicit resume works", async () => {
    const { engine, context, calls, paused } = mockedEngine("running");
    await engine.pause();
    // React can still think running: these are the App's automatic calls.
    await engine.resumeIfNotPaused();
    await engine.registerBuffer(7, new SharedArrayBuffer(64));
    await engine.resumeIfNotPaused();
    assert.equal(paused(), true);
    assert.equal(context.state, "suspended");
    assert.equal(calls.resume, 0);
    assert.equal((calls.messages).length, 1);
    await engine.resume();
    assert.equal(paused(), false);
    assert.equal(context.state, "running");
    assert.equal(calls.resume, 1);
});

test("automatic unlock still retries a pending autoplay resume when not paused", async () => {
    const { engine, context, calls } = mockedEngine();
    const pending = deferred();
    context.resume = async () => {
        calls.resume++;
        if (calls.resume === 1) await pending.promise;
        context.state = "running";
    };
    const first = engine.resumeIfNotPaused();
    await engine.resumeIfNotPaused();
    assert.equal(calls.resume, 2);
    pending.resolve();
    await first;
    assert.equal(context.state, "running");
});

test("late browser resume completion cannot undo a later pause", async () => {
    const { engine, context, calls, paused } = mockedEngine();
    const pending = deferred();
    context.resume = async () => {
        calls.resume++;
        await pending.promise;
        context.state = "running";
    };
    const automatic = engine.resumeIfNotPaused();
    await engine.pause();
    pending.resolve();
    await automatic;
    assert.equal(paused(), true);
    assert.equal(context.state, "suspended");
    assert.equal(calls.suspend, 1);
    assert.equal(calls.ready, 0);
});

test("pending buffer registration completes without clearing a later pause", async () => {
    const { engine, context, calls, paused } = mockedEngine("running");
    const ready = deferred();
    Object.assign(engine, { ensureReady: () => ready.promise });
    const registration = engine.registerBuffer(9, new SharedArrayBuffer(64));
    await engine.pause();
    ready.resolve();
    await registration;
    await engine.resumeIfNotPaused();
    assert.equal((calls.messages).length, 1);
    assert.equal(calls.resume, 0);
    assert.equal(context.state, "suspended");
    assert.equal(paused(), true);
});

test("pause during ensureReady leaves encoded restoration queued for explicit resume", async () => {
    const { engine, context, paused } = mockedEngine("running");
    const ready = deferred();
    let plays = 0;
    const source = { paused: true, async play() { plays++; this.paused = false; }, pause() { this.paused = true; } };
    const pausedIds = new Set([11]);
    Object.assign(engine, {
        ensureReady: () => ready.promise,
        encodedSources: new Map([[11, { element: source }]]), pausedEncodedSources: pausedIds,
    });
    const automatic = engine.resumeIfNotPaused();
    await engine.pause();
    ready.resolve();
    await automatic;
    assert.equal(plays, 0);
    assert.equal(pausedIds.has(11), true);
    assert.equal(paused(), true);
    assert.equal(context.state, "suspended");
    await engine.resume();
    assert.equal(plays, 1);
    assert.equal(pausedIds.size, 0);
});

test("pause during pending encoded play re-pauses it and retains remaining sources", async () => {
    const { engine, context, paused } = mockedEngine("running");
    const playing = deferred(), entered = deferred();
    let secondPlays = 0;
    const first = { paused: true, async play() { entered.resolve(); await playing.promise; this.paused = false; }, pause() { this.paused = true; } };
    const second = { paused: true, async play() { secondPlays++; this.paused = false; }, pause() { this.paused = true; } };
    const pausedIds = new Set([1, 2]);
    Object.assign(engine, { encodedSources: new Map([[1, { element: first }], [2, { element: second }]]), pausedEncodedSources: pausedIds });
    const automatic = engine.resumeIfNotPaused();
    await entered.promise;
    await engine.pause();
    playing.resolve();
    await automatic;
    assert.equal(first.paused, true);
    assert.equal(secondPlays, 0);
    assert.deepEqual([...pausedIds], [1, 2]);
    assert.equal(paused(), true);
    assert.equal(context.state, "suspended");
    await engine.resume();
    assert.equal(secondPlays, 1);
    assert.equal(pausedIds.size, 0);
});

test("App automatic calls use guarded unlock; explicit pause/resume goes only through AudioPauseSync", () => {
    const app = fs.readFileSync(new URL("../../src/app/App.tsx", import.meta.url), "utf8");
    assert.equal(app.match(/audioEngine\?\.resumeIfNotPaused\(\)/g)?.length, 4);
    assert.equal(app.match(/audioEngine\?\.resume\(\)/g)?.length ?? 0, 0);
    assert.equal(app.match(/audioEngine\??\.(pause|resume)\(\)/g)?.length ?? 0, 0);
    // UI button + the worker's guest_pause_state: one writer, so no double suspend/resume race.
    assert.equal(app.match(/audioPauseSync\?\.set\(/g)?.length, 2);
});

test("automatic unlock during pending suspend cannot clear pause intent", async () => {
    const { engine, context, calls, paused } = mockedEngine("running");
    const suspended = deferred();
    context.suspend = async () => { calls.suspend++; await suspended.promise; context.state = "suspended"; };
    const pause = engine.pause();
    await engine.resumeIfNotPaused();
    assert.equal(paused(), true);
    assert.equal(calls.resume, 0);
    suspended.resolve();
    await pause;
    assert.equal(context.state, "suspended");
});

test("explicit resume waits for an in-flight suspend before reopening context", async () => {
    const { engine, context, calls, paused } = mockedEngine("running");
    const suspended = deferred();
    context.suspend = async () => { calls.suspend++; await suspended.promise; context.state = "suspended"; };
    const pause = engine.pause();
    const resume = engine.resume();
    suspended.resolve();
    await Promise.all([pause, resume]);
    assert.equal(paused(), false);
    assert.equal(context.state, "running");
    assert.equal(calls.resume, 1);
});

test("gesture unlock listens for activation-triggering touch ends and only resumes when not paused", async () => {
    const listeners = new Map<string, () => void>();
    const g = globalThis as { window?: unknown };
    const hadWindow = "window" in g;
    const previous = g.window;
    g.window = { addEventListener: (type: string, fn: () => void) => { listeners.set(type, fn); } };
    try {
        const engine = new AudioEngine();
        let automatic = 0;
        let explicit = 0;
        Object.assign(engine, {
            resumeIfNotPaused: async () => { automatic++; },
            resume: async () => { explicit++; },
        });
        engine.armAutoResume();
        for (const type of ["pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "keydown"]) {
            assert.ok(listeners.has(type), type);
        }
        listeners.get("touchend")!();
        assert.equal(automatic, 1);
        assert.equal(explicit, 0);
    } finally {
        if (hadWindow) g.window = previous; else delete g.window;
    }
});
