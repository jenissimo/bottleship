import { describe, expect, test } from "bun:test";
import {
    arenaRunEncodingComplete,
    arenaRunExpectedLogicalDraws,
    arenaRunVsBudgetBytes,
    encodeMegaBatchRunDraw,
    estimateProgrammableArenaNeeds,
    planArenaRunUniformReplay,
    uniformBlockBytes,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-backend-executor";
import type { ProgrammableDrawState, RenderFrame } from "../../src/worker/backends/webgpu/render-frame";
import { reconcileD3D9ArenaRuns } from "../../src/worker/modules/d3d9/d3d9-perf";

function drawState(vsLen: number, psLen: number): ProgrammableDrawState {
    return { vsLen, psLen } as ProgrammableDrawState;
}

describe("D3D9 arena-run programmable uniform budget", () => {
    test("budgets one distinct VS block per arena pair in addition to frame templates", () => {
        const frame = {
            drawStateCount: 1,
            drawStates: [drawState(16, 8)],
            arenaIndexedRuns: [{ bindStateIndex: 0, expectedPairCount: 7 }],
        } as Pick<RenderFrame, "drawStateCount" | "drawStates" | "arenaIndexedRuns">;

        // Each small block occupies one 256-byte dynamic-offset slot. The ordinary template
        // costs one slot and the seven arena pairs cost seven more. PS remains shared/cached.
        expect(estimateProgrammableArenaNeeds(frame)).toEqual({
            vsNeeded: 8 * 256,
            psNeeded: 1 * 256,
        });
    });

    test("counts every run even when runs reference the same pooled template slot", () => {
        const frame = {
            drawStateCount: 1,
            drawStates: [drawState(4, 4)],
            arenaIndexedRuns: [
                { bindStateIndex: 0, expectedPairCount: 3 },
                { bindStateIndex: 0, expectedPairCount: 4 },
            ],
        } as Pick<RenderFrame, "drawStateCount" | "drawStates" | "arenaIndexedRuns">;

        expect(estimateProgrammableArenaNeeds(frame).vsNeeded).toBe(8 * 256);
    });

    test("reserves a distinct VS slot for a fused prefix draw", () => {
        const frame = {
            drawStateCount: 1,
            drawStates: [drawState(4, 4)],
            arenaIndexedRuns: [{
                bindStateIndex: 0,
                expectedPairCount: 7,
                prefixVsBits: new Uint32Array(4),
            }],
        } as Pick<RenderFrame, "drawStateCount" | "drawStates" | "arenaIndexedRuns">;

        // One pooled template + one prefix + seven captured pairs.
        expect(estimateProgrammableArenaNeeds(frame).vsNeeded).toBe(9 * 256);
    });
});

describe("D3D9 arena-run absolute logical ledger", () => {
    test("accounts the canonical mixed frame as 2511 pairs plus 360 prefixes", () => {
        const runs = Array.from({ length: 363 }, (_, index) => ({
            expectedPairCount: index < 354 ? 7 : index < 360 ? 4 : 3,
            prefixVsBits: index < 360 ? new Uint32Array(1) : undefined,
        }));
        const pairs = runs.reduce((sum, run) => sum + run.expectedPairCount, 0);
        const logical = runs.reduce((sum, run) => sum + arenaRunExpectedLogicalDraws(run), 0);

        expect(pairs).toBe(2511);
        expect(logical).toBe(2871);
        expect(arenaRunEncodingComplete(runs[0], 7, 7)).toBe(false);
        expect(arenaRunEncodingComplete(runs[0], 7, 8)).toBe(true);
    });
});

describe("D3D9 arena-run producer/executor reconciliation", () => {
    test("is healthy only when runs, pairs, execution, and API indexed draws agree", () => {
        const healthy = reconcileD3D9ArenaRuns(
            { pairRuns: 10, pairs: 70 },
            { drawIndexedPrimitive: 80 },
            { arenaRunCommands: 10, arenaRunExpectedPairs: 70,
                arenaRunExecutedPairs: 70, drawIndexedCalls: 80 },
        );
        expect(healthy.healthy).toBe(true);
        expect(healthy.runDelta).toBe(0);
        expect(healthy.expectedDelta).toBe(0);
        expect(healthy.executedDelta).toBe(0);
        expect(healthy.apiDrawDelta).toBe(0);

        const dropped = reconcileD3D9ArenaRuns(
            { pairRuns: 10, pairs: 70 },
            { drawIndexedPrimitive: 80 },
            { arenaRunCommands: 4, arenaRunExpectedPairs: 28,
                arenaRunExecutedPairs: 25, drawIndexedCalls: 35 },
        );
        expect(dropped.healthy).toBe(false);
        expect(dropped.runDelta).toBe(-6);
        expect(dropped.expectedDelta).toBe(-42);
        expect(dropped.executedDelta).toBe(-3);
        expect(dropped.apiDrawDelta).toBe(-45);
    });
});

/** A pass encoder that records what it was actually handed. The executed ledger must be
 *  readable off this transcript alone — a ledger that agrees with the plan but not with the
 *  transcript is intention accounting. */
function recordingEncoder() {
    const transcript: Array<{
        indexCount: number; instanceCount: number; firstIndex: number;
        baseVertex: number; firstInstance: number;
    }> = [];
    return {
        transcript,
        drawIndexed(indexCount: number, instanceCount: number, firstIndex: number,
            baseVertex: number, firstInstance: number) {
            transcript.push({ indexCount, instanceCount, firstIndex, baseVertex, firstInstance });
        },
    };
}

type MegaPlanProbe = Parameters<typeof encodeMegaBatchRunDraw>[1];

function megaPlan(instanceCount: number, encodedPairCount: number,
    fusedDrawCommand = -1): MegaPlanProbe {
    return {
        indexCount: 36, instanceCount, startIndex: 0, baseVertex: 0, firstSlot: 0,
        encodedPairCount, fusedDrawCommand,
    };
}

/** Accumulate one run into the shape reconcileD3D9ArenaRuns consumes, exactly as the
 *  executor's DrawIndexedArenaRun branch does. */
function backendLedger(
    run: { expectedPairCount: number; prefixVsBits?: Uint32Array },
    issued: ReturnType<typeof encodeMegaBatchRunDraw>,
    transcriptInstances: number,
) {
    return {
        arenaRunCommands: 1,
        arenaRunExpectedPairs: run.expectedPairCount,
        arenaRunExecutedPairs: issued.encodedPairs,
        drawIndexedCalls: transcriptInstances,
    };
}

describe("D3D9 MegaBatch executed ledger", () => {
    test("counts the instances the encoder received, prefix instance included", () => {
        const run = { expectedPairCount: 7, prefixVsBits: new Uint32Array(4) };
        const encoder = recordingEncoder();
        const issued = encodeMegaBatchRunDraw(encoder, megaPlan(8, 7), run);

        expect(encoder.transcript).toHaveLength(1);
        expect(encoder.transcript[0]!.instanceCount).toBe(8);
        // The ledger is readable off the transcript, not off the plan.
        expect(issued.encodedRunLogicalDraws).toBe(encoder.transcript[0]!.instanceCount);
        expect(issued.encodedPairs).toBe(7);
        expect(issued.packConsistent).toBe(true);
        expect(arenaRunEncodingComplete(run, issued.encodedPairs, issued.encodedRunLogicalDraws))
            .toBe(true);

        const reconcile = reconcileD3D9ArenaRuns(
            { pairRuns: 1, pairs: 7 }, { drawIndexedPrimitive: 8 },
            backendLedger(run, issued, encoder.transcript[0]!.instanceCount),
        );
        expect(reconcile.healthy).toBe(true);
    });

    test("a fused adjacent draw keeps its own accounting row out of the run's pairs", () => {
        const run = { expectedPairCount: 7, prefixVsBits: undefined };
        const encoder = recordingEncoder();
        const issued = encodeMegaBatchRunDraw(encoder, megaPlan(8, 7, 12), run);

        expect(encoder.transcript[0]!.instanceCount).toBe(8);
        expect(issued.encodedRunLogicalDraws).toBe(7);
        expect(issued.encodedPairs).toBe(7);
        expect(issued.packConsistent).toBe(true);
        expect(arenaRunEncodingComplete(run, issued.encodedPairs, issued.encodedRunLogicalDraws))
            .toBe(true);
    });

    test("passing the pair count as the instance count is caught, not absorbed", () => {
        // The exact one-line mutation this ledger exists to catch: hand drawIndexed
        // `encodedPairCount` instead of `instanceCount`, silently dropping the prefix instance.
        const run = { expectedPairCount: 7, prefixVsBits: new Uint32Array(4) };
        const encoder = recordingEncoder();
        const issued = encodeMegaBatchRunDraw(encoder, megaPlan(7, 7), run);

        expect(encoder.transcript[0]!.instanceCount).toBe(7);
        expect(issued.encodedPairs).toBe(6);
        expect(issued.packConsistent).toBe(false);
        expect(arenaRunEncodingComplete(run, issued.encodedPairs, issued.encodedRunLogicalDraws))
            .toBe(false);

        const reconcile = reconcileD3D9ArenaRuns(
            { pairRuns: 1, pairs: 7 }, { drawIndexedPrimitive: 8 },
            backendLedger(run, issued, encoder.transcript[0]!.instanceCount),
        );
        expect(reconcile.healthy).toBe(false);
        expect(reconcile.executedDelta).toBe(-1);
        expect(reconcile.apiDrawDelta).toBe(-1);
    });
});

describe("D3D9 arena-run uniform capacity preflight", () => {
    /** What UniformArena.begin() actually allocates for a request. */
    function arenaCapacityFor(requested: number): number {
        return Math.ceil(Math.max(requested, 256) * 2 / 256) * 256;
    }

    const runs = [
        { bindStateIndex: 0, expectedPairCount: 7, prefixVsBits: new Uint32Array(4) },
        { bindStateIndex: 0, expectedPairCount: 4 },
        { bindStateIndex: 0, expectedPairCount: 3 },
    ];
    const frame = {
        drawStateCount: 1,
        drawStates: [drawState(64, 32)],
        arenaIndexedRuns: runs,
    } as unknown as Pick<RenderFrame, "drawStateCount" | "drawStates" | "arenaIndexedRuns">;

    /** Walk the frame's runs through the preflight the executor uses, one after another. */
    function replay(capacity: number) {
        let cursor = 0;
        let encodedLogical = 0;
        let declines = 0;
        let shortfall = 0;
        for (const run of runs) {
            const plan = planArenaRunUniformReplay(run, 64, capacity - cursor);
            if (!plan.fits) {
                declines++;
                shortfall = Math.max(shortfall, plan.shortfallBytes);
                continue;
            }
            cursor += plan.neededBytes;
            encodedLogical += arenaRunExpectedLogicalDraws(run);
        }
        return { encodedLogical, declines, shortfall };
    }

    const expectedLogical = runs.reduce((n, run) => n + arenaRunExpectedLogicalDraws(run), 0);

    test("a frame whose runs exceed the estimate by one block still encodes every draw", () => {
        const { vsNeeded } = estimateProgrammableArenaNeeds(frame);
        // The estimate is short by exactly one block; begin()'s headroom must absorb it.
        const capacity = arenaCapacityFor(vsNeeded - uniformBlockBytes(64));
        const result = replay(capacity);
        expect(result.declines).toBe(0);
        expect(result.encodedLogical).toBe(expectedLogical);
        expect(expectedLogical).toBe(15);
    });

    test("declines a run that cannot fit and reports the shortfall to grow by", () => {
        const oneRunBytes = arenaRunVsBudgetBytes(64, arenaRunExpectedLogicalDraws(runs[0]!));
        const result = replay(oneRunBytes);
        expect(result.declines).toBe(2);
        expect(result.encodedLogical).toBe(arenaRunExpectedLogicalDraws(runs[0]!));
        expect(result.shortfall).toBeGreaterThan(0);
    });

    test("the per-run budget is exactly one block per logical draw", () => {
        // The legacy/compact replays bind once per logical draw and each bind is one arena
        // write (vsVersion is invalidated every time), so budget and spend must be identical —
        // this is what the executor's arenaRunBudgetOverruns counter checks at runtime.
        for (const run of runs) {
            expect(arenaRunVsBudgetBytes(64, arenaRunExpectedLogicalDraws(run)))
                .toBe(uniformBlockBytes(64) * (run.expectedPairCount + (run.prefixVsBits ? 1 : 0)));
        }
    });
});
