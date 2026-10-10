import { expect, test } from "bun:test";
import { AudioEngine } from "../../src/audio/audio-engine";

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
    Object.assign(engine, { context, ensureReady: async () => { ready++; } });
    const first = engine.resume();
    const second = engine.resume();
    expect(resumes).toBe(2);
    await second;
    expect(ready).toBe(1);
    finishFirst();
    await first;
});

test("running-context requests share source restoration", async () => {
    const engine = new AudioEngine();
    let finishReady!: () => void;
    let ready = 0;
    Object.assign(engine, {
        context: { state: "running" },
        ensureReady: () => { ready++; return new Promise<void>(resolve => { finishReady = resolve; }); },
    });
    const first = engine.resume();
    const second = engine.resume();
    expect(ready).toBe(1);
    finishReady();
    await Promise.all([first, second]);
});
