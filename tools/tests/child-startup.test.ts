import { expect, test } from "bun:test";
import { ChildStartupGate } from "../../src/worker/core/child-startup";

const turn = async () => { await Promise.resolve(); await Promise.resolve(); };

test("child preparation publishes readiness while every guest instruction remains held", async () => {
    const observations: string[] = [], errors: unknown[] = [];
    const gate = new ChildStartupGate(() => observations.push("ready"), error => errors.push(error));
    gate.prepare(() => { observations.push("network-final"); }, () => {
        expect(gate.canRun).toBe(true);
        observations.push("instruction");
    });
    await turn();
    expect(gate.canRun).toBe(false);
    expect(observations).toEqual(["ready"]);
    gate.resume(); gate.resume();
    await turn();
    expect(observations).toEqual(["ready", "network-final", "instruction"]);
    expect(errors).toEqual([]);
});

test("early resume waits for final process preparation and preserves its preparation data", async () => {
    const observations: unknown[] = [];
    const gate = new ChildStartupGate<{ value: number }>(() => observations.push("ready"), error => { throw error; });
    gate.resume({ value: 17 });
    await turn();
    expect(observations).toEqual([]);
    gate.prepare(preparation => { observations.push(preparation); }, () => observations.push("instruction"));
    await turn();
    expect(observations).toEqual(["ready", { value: 17 }, "instruction"]);
});

test("termination while final readiness is pending prevents a late first instruction", async () => {
    let settle!: () => void, instructions = 0;
    const gate = new ChildStartupGate(() => {}, error => { throw error; });
    gate.prepare(() => new Promise<void>(resolve => { settle = resolve; }), () => { instructions++; });
    gate.resume();
    expect(gate.canRun).toBe(false);
    gate.cancel(); settle();
    await turn();
    gate.resume();
    await turn();
    expect(instructions).toBe(0);
    expect(gate.canRun).toBe(false);
});

test("a renewed initial suspension revokes an early resume across an asynchronous readiness check", async () => {
    const releases: Array<() => void> = [];
    let instructions = 0;
    const gate = new ChildStartupGate(() => {}, error => { throw error; });
    gate.prepare(() => new Promise<void>(resolve => releases.push(resolve)), () => { instructions++; });
    gate.resume(); gate.hold(); releases.shift()!();
    await turn();
    expect(instructions).toBe(0);
    gate.resume(); releases.shift()!();
    await turn();
    expect(instructions).toBe(1);
});

test("a failed child finalization reports failure and never permits CPU resume", async () => {
    const errors: unknown[] = [];
    let instructions = 0;
    const error = new Error("network lifetime closed");
    const gate = new ChildStartupGate(() => {}, value => errors.push(value));
    gate.prepare(() => { throw error; }, () => { instructions++; });
    gate.resume();
    await turn();
    gate.resume();
    expect(errors).toEqual([error]);
    expect(instructions).toBe(0);
    expect(gate.canRun).toBe(false);
});
