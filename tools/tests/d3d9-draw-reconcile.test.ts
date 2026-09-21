/**
 * The indexed-draw ledger: `apiDrawIndexed` and `backendDrawIndexed` are the two ends of the
 * same handoff, and they are NOT required to be equal — a fan is rewound into a non-indexed
 * draw, an unrepresentable draw is dropped, a lost device discards a whole recorded frame. The
 * invariant is that every difference is NAMED, which is what `apiDrawUnaccounted` measures.
 *
 * Each case here feeds the reconciliation the bypass it exists to catch: an unnamed shortfall,
 * a HALF-named one (partial credit must not pass), a frame discard the pair identity cannot
 * see on its own, and a poisoned counter increment. The encoder-side half — setBindGroup0's
 * elision and the frame-discard walk — is exercised on a real executor with no GPU device,
 * because a counter that cannot be shown firing is indistinguishable from one that never fires.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
    reconcileD3D9ArenaRuns,
    d3d9NoteIndexedDrawUnencoded,
    getD3D9PerfSnapshot,
    resetD3D9Perf,
} from "../../src/worker/modules/d3d9/d3d9-perf";
import { D3D9BackendExecutor } from "../../src/worker/backends/webgpu/d3d9/d3d9-backend-executor";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { D3D9CommandRecorder } from "../../src/worker/backends/webgpu/d3d9/d3d9-command-recorder";
import { RenderCommandType, RenderFramePool } from "../../src/worker/backends/webgpu/render-frame";
import type { RenderFrame } from "../../src/worker/backends/webgpu/render-frame";
import type { StreamBindingPlan } from "../../src/worker/backends/webgpu/shared/vertex-streams";

/** Producer-side wbuf totals; every case below keeps the run/pair identity satisfied unless it
 *  is the thing under test, so an assertion about draws is never answered by a pair mismatch. */
const wbuf = { pairRuns: 10, pairs: 70 };

/** An arena ledger that balances: what the executor expected is what it encoded. */
const balancedRuns = {
    arenaRunCommands: 10,
    arenaRunExpectedPairs: 70,
    arenaRunExecutedPairs: 70,
    arenaRunExpectedLogicalDraws: 70,
    arenaRunEncodedLogicalDraws: 70,
};

describe("d3d9 indexed-draw reconciliation", () => {
    test("an unnamed 100-draw shortfall is unhealthy and sized", () => {
        const r = reconcileD3D9ArenaRuns(
            wbuf,
            { drawIndexedPrimitive: 4_145_288 },
            { ...balancedRuns, drawIndexedCalls: 4_145_188 },
            {},
        );
        expect(r.healthy).toBe(false);
        expect(r.apiDrawUnencoded).toBe(0);
        expect(r.apiDrawUnaccounted).toBe(100);
    });

    test("the same shortfall named by the device ledger is healthy and still visible", () => {
        const r = reconcileD3D9ArenaRuns(
            wbuf,
            { drawIndexedPrimitive: 4_145_288 },
            { ...balancedRuns, drawIndexedCalls: 4_145_188 },
            { reroutedNonIndexed: 60, dropped: 30, scrubBisect: 10 },
        );
        expect(r.healthy).toBe(true);
        expect(r.apiDrawUnencoded).toBe(100);
        expect(r.apiDrawUnaccounted).toBe(0);
        // The raw difference is still reported: "healthy" means accounted for, not absent.
        expect(r.apiDrawDelta).toBe(-100);
    });

    test("each executor-side decline closes the identity on its own", () => {
        const base = { ...balancedRuns, drawIndexedCalls: 900 };
        for (const key of [
            "drawIndexedSkippedNoPipeline",
            "drawIndexedSkippedValidator",
            "drawIndexedFrameDiscarded",
        ]) {
            const r = reconcileD3D9ArenaRuns(
                wbuf, { drawIndexedPrimitive: 1000 }, { ...base, [key]: 100 }, {});
            expect(r.apiDrawUnencoded).toBe(100);
            expect(r.apiDrawUnaccounted).toBe(0);
            expect(r.healthy).toBe(true);
        }
    });

    test("a HALF-named shortfall stays unhealthy: partial credit does not pass", () => {
        // 40 of the 100 missing draws name themselves; the other 60 are still unexplained,
        // which is exactly the shape a future fast path would produce if it counted only the
        // declines it happens to know about.
        const r = reconcileD3D9ArenaRuns(
            wbuf,
            { drawIndexedPrimitive: 1000 },
            { ...balancedRuns, drawIndexedCalls: 900, drawIndexedSkippedValidator: 40 },
            {},
        );
        expect(r.apiDrawUnencoded).toBe(40);
        expect(r.apiDrawUnaccounted).toBe(60);
        expect(r.healthy).toBe(false);
    });

    test("a device ledger and an executor decline sum rather than shadow each other", () => {
        const r = reconcileD3D9ArenaRuns(
            wbuf,
            { drawIndexedPrimitive: 1000 },
            { ...balancedRuns, drawIndexedCalls: 900, drawIndexedSkippedValidator: 40 },
            { reroutedNonIndexed: 60 },
        );
        expect(r.apiDrawUnencoded).toBe(100);
        expect(r.healthy).toBe(true);
    });

    test("an arena run that encoded fewer logical draws than it promised names the shortfall", () => {
        const r = reconcileD3D9ArenaRuns(
            wbuf,
            { drawIndexedPrimitive: 1000 },
            {
                ...balancedRuns,
                arenaRunEncodedLogicalDraws: 63,
                drawIndexedCalls: 993,
            },
            {},
        );
        expect(r.apiDrawUnencoded).toBe(7);
        expect(r.apiDrawUnaccounted).toBe(0);
        expect(r.healthy).toBe(true);
    });

    test("pairs lost with a discarded frame break the pair identity until they are counted", () => {
        const backend = {
            arenaRunCommands: 10,
            arenaRunExpectedPairs: 55,
            arenaRunExecutedPairs: 55,
            arenaRunExpectedLogicalDraws: 55,
            arenaRunEncodedLogicalDraws: 55,
            drawIndexedCalls: 55,
            drawIndexedFrameDiscarded: 15,
        };
        // Bypass: the draws are named but the PAIRS the same frame held are not.
        const lost = reconcileD3D9ArenaRuns(wbuf, { drawIndexedPrimitive: 70 }, backend, {});
        expect(lost.apiDrawUnaccounted).toBe(0);
        expect(lost.expectedDelta).toBe(-15);
        expect(lost.healthy).toBe(false);

        const counted = reconcileD3D9ArenaRuns(
            wbuf, { drawIndexedPrimitive: 70 },
            { ...backend, arenaRunPairsFrameDiscarded: 15 }, {});
        expect(counted.expectedDelta).toBe(0);
        expect(counted.healthy).toBe(true);
    });

    test("the run and execution identities still gate health on their own", () => {
        const missingRuns = reconcileD3D9ArenaRuns(
            wbuf, { drawIndexedPrimitive: 70 },
            { ...balancedRuns, arenaRunCommands: 4, drawIndexedCalls: 70 }, {});
        expect(missingRuns.runDelta).toBe(-6);
        expect(missingRuns.healthy).toBe(false);

        const underExecuted = reconcileD3D9ArenaRuns(
            wbuf, { drawIndexedPrimitive: 70 },
            { ...balancedRuns, arenaRunExecutedPairs: 67, drawIndexedCalls: 67 }, {});
        expect(underExecuted.executedDelta).toBe(-3);
        expect(underExecuted.healthy).toBe(false);
    });
});

describe("d3d9 indexedDrawUnencoded ledger", () => {
    test("accumulates by reason, reaches the snapshot, and clears on reset", () => {
        resetD3D9Perf();
        d3d9NoteIndexedDrawUnencoded("reroutedNonIndexed");
        d3d9NoteIndexedDrawUnencoded("reroutedNonIndexed");
        d3d9NoteIndexedDrawUnencoded("unclassified");
        expect(getD3D9PerfSnapshot().indexedDrawUnencoded)
            .toEqual({ reroutedNonIndexed: 2, unclassified: 1 });
        resetD3D9Perf();
        expect(getD3D9PerfSnapshot().indexedDrawUnencoded).toEqual({});
    });

    test("a poisoned count is refused and the refusal is itself counted", () => {
        // Silently dropping it would make the ledger read balanced while a whole class of
        // draws went unrecorded — the failure this counter exists to prevent.
        resetD3D9Perf();
        d3d9NoteIndexedDrawUnencoded("dropped", Number.NaN);
        d3d9NoteIndexedDrawUnencoded("dropped", -5);
        const snap = getD3D9PerfSnapshot();
        expect(snap.indexedDrawUnencoded).toEqual({});
        expect(snap.counterRejections).toEqual({ "indexedDrawUnencoded:dropped": 2 });
        resetD3D9Perf();
    });
});

type BindHost = {
    metrics: {
        bindGroupSets: number;
        bindGroupSetSkips: number;
        bindGroupSetSameGroup: number;
        drawIndexedFrameDiscarded: number;
        arenaRunPairsFrameDiscarded: number;
    };
    lastBindDynCount: number;
    setBindGroup0: (
        renderPass: GPURenderPassEncoder, bindGroup: GPUBindGroup,
        offset0?: number, offset1?: number, dynCount?: number,
    ) => void;
    resetRenderPassBindCache: () => void;
    noteFrameIndexedDrawsLost: (frame: RenderFrame, from: number) => void;
    noteFrameDiscardedBeforeExecute: (frame: RenderFrame, reason: string) => void;
};

function makeExecutor(): BindHost {
    // These paths touch plain fields and the pass encoder only; no GPU device is needed.
    return new D3D9BackendExecutor({} as never) as unknown as BindHost;
}

/** Records nothing: what is under test is which calls REACH an encoder, not what it does. */
const pass = { setBindGroup(): void { /* no-op */ } } as unknown as GPURenderPassEncoder;
const groupA = {} as GPUBindGroup;
const groupB = {} as GPUBindGroup;

describe("d3d9 setBindGroup0 elision", () => {
    test("fires on the repeat the FFP per-draw path produces", () => {
        // Consecutive FFP draws sharing a block re-point at the same arena offset with the
        // same cached group (bindFfpDrawState/sameAsLastBlock) — the one shape that elides.
        const e = makeExecutor();
        e.setBindGroup0(pass, groupA, 128, -1, 1);
        e.setBindGroup0(pass, groupA, 128, -1, 1);
        expect(e.metrics.bindGroupSets).toBe(1);
        expect(e.metrics.bindGroupSetSkips).toBe(1);
        expect(e.metrics.bindGroupSetSameGroup).toBe(0);
    });

    test("the arena-run shape is counted, not silent", () => {
        // Every replayed pair writes a fresh constant block, so the dynamic offset moves by
        // construction and the elision cannot fire. `bindGroupSetSameGroup` is what separates
        // "asked and refused" from "never asked" — without it a zero skip count is ambiguous.
        const e = makeExecutor();
        e.setBindGroup0(pass, groupA, 0, 0);
        e.setBindGroup0(pass, groupA, 256, 0);
        e.setBindGroup0(pass, groupA, 512, 0);
        expect(e.metrics.bindGroupSets).toBe(3);
        expect(e.metrics.bindGroupSetSkips).toBe(0);
        expect(e.metrics.bindGroupSetSameGroup).toBe(2);
    });

    test("a different bind group is neither a skip nor a same-group re-bind", () => {
        const e = makeExecutor();
        e.setBindGroup0(pass, groupA, 0, 0);
        e.setBindGroup0(pass, groupB, 0, 0);
        expect(e.metrics.bindGroupSets).toBe(2);
        expect(e.metrics.bindGroupSetSkips).toBe(0);
        expect(e.metrics.bindGroupSetSameGroup).toBe(0);
    });

    test("invalidation clears every field of the cache", () => {
        const e = makeExecutor();
        e.setBindGroup0(pass, groupA, 128, -1, 1);
        e.resetRenderPassBindCache();
        expect(e.lastBindDynCount).toBe(0);
        e.setBindGroup0(pass, groupA, 128, -1, 1);
        expect(e.metrics.bindGroupSetSkips).toBe(0);
        expect(e.metrics.bindGroupSets).toBe(2);
    });
});

describe("d3d9 frame-discard draw accounting", () => {
    /** DrawIndexed, an arena run of 12 pairs with a fused prefix draw, DrawIndexed. */
    const frame = {
        commandTypes: [
            RenderCommandType.DrawIndexed,
            RenderCommandType.DrawIndexedArenaRun,
            RenderCommandType.DrawIndexed,
        ],
        commandA: [0, 0, 0],
        arenaIndexedRuns: [{ expectedPairCount: 12, prefixVsBits: new Uint32Array(4) }],
    } as unknown as RenderFrame;

    test("counts every indexed logical draw and pair a discarded frame still owed", () => {
        const e = makeExecutor();
        e.noteFrameIndexedDrawsLost(frame, 0);
        expect(e.metrics.drawIndexedFrameDiscarded).toBe(1 + (12 + 1) + 1);
        expect(e.metrics.arenaRunPairsFrameDiscarded).toBe(12);
    });

    test("an abort counts only the tail it never reached", () => {
        const e = makeExecutor();
        e.noteFrameIndexedDrawsLost(frame, 2);
        expect(e.metrics.drawIndexedFrameDiscarded).toBe(1);
        expect(e.metrics.arenaRunPairsFrameDiscarded).toBe(0);
    });

    test("a run index that names no run is skipped rather than counted as zero draws", () => {
        const dangling = {
            commandTypes: [RenderCommandType.DrawIndexedArenaRun, RenderCommandType.DrawIndexed],
            commandA: [7, 0],
            arenaIndexedRuns: [],
        } as unknown as RenderFrame;
        const e = makeExecutor();
        e.noteFrameIndexedDrawsLost(dangling, 0);
        expect(e.metrics.drawIndexedFrameDiscarded).toBe(1);
        expect(e.metrics.arenaRunPairsFrameDiscarded).toBe(0);
    });
});

/**
 * The wrapper's attribution has to survive an EXCEPTION, not just a return. The api counter is
 * minted inside the impl, which goes on to call queue.writeBuffer / createBuffer / the pipeline
 * builders — every one of which can throw. An unwind past a bare call leaves a counted draw
 * that never reached the encoder and named no fate: invisible to BOTH ledgers, which is exactly
 * the shape of an unaccounted residual.
 */
describe("d3d9 drawIndexedPrimitive accounting under a throw", () => {
    type WrapperHost = {
        drawIndexedPrimitive: (
            primitiveType: number, baseVertexIndex: number, minVertexIndex: number,
            numVertices: number, startIndex: number, primitiveCount: number,
        ) => number;
        drawIndexedPrimitiveImpl: () => number;
        indexedDrawFate: string;
        indexedDrawThrows: number;
    };

    /** The wrapper reads two own fields and calls the impl, so it runs on a bare prototype
     *  object — no GPU, no System, no device construction. */
    function makeWrapperHost(impl: () => number): WrapperHost {
        const host = Object.create(D3D9Device.prototype) as WrapperHost;
        host.indexedDrawFate = "";
        host.indexedDrawThrows = 0;
        host.drawIndexedPrimitiveImpl = impl;
        return host;
    }

    test("a throw out of the impl is named rather than silently unaccounted", () => {
        resetD3D9Perf();
        const host = makeWrapperHost(() => {
            throw new Error("writeBuffer: size is not a multiple of 4");
        });
        // The exception still reaches the caller: this counts the loss, it does not swallow it.
        expect(() => host.drawIndexedPrimitive(4, 0, 0, 3, 0, 1)).toThrow(/multiple of 4/);
        expect(getD3D9PerfSnapshot().indexedDrawUnencoded).toEqual({ threw: 1 });
        expect(host.indexedDrawThrows).toBe(1);

        // And the reconciliation it exists to serve now closes on that one draw.
        const r = reconcileD3D9ArenaRuns(
            wbuf, { drawIndexedPrimitive: 1000 }, { ...balancedRuns, drawIndexedCalls: 999 },
            getD3D9PerfSnapshot().indexedDrawUnencoded);
        expect(r.apiDrawUnaccounted).toBe(0);
        expect(r.healthy).toBe(true);
        resetD3D9Perf();
    });

    test("an ordinary encoded return still names nothing", () => {
        // The negative control: a finally block that attributed EVERY call would fill the
        // ledger with phantom declines, and "healthy" would stop meaning anything.
        resetD3D9Perf();
        const host = makeWrapperHost(function (this: WrapperHost): number {
            this.indexedDrawFate = "encoded";
            return 0;
        });
        expect(host.drawIndexedPrimitive(4, 0, 0, 3, 0, 1)).toBe(0);
        expect(getD3D9PerfSnapshot().indexedDrawUnencoded).toEqual({});
        expect(host.indexedDrawThrows).toBe(0);
        resetD3D9Perf();
    });
});

/**
 * submitFrame refuses a FINALIZED frame at seven sites (no colour view, no target formats, an
 * MSAA layout we decline). execute() is never called for those, so neither the encoder's
 * declines nor its mid-flush abort walk can see the draws the frame was still holding.
 */
describe("d3d9 frame refused before execute", () => {
    /** DrawIndexed, an arena run of 12 pairs with a fused prefix draw, DrawIndexed. */
    const held = {
        commandTypes: [
            RenderCommandType.DrawIndexed,
            RenderCommandType.DrawIndexedArenaRun,
            RenderCommandType.DrawIndexed,
        ],
        commandA: [0, 0, 0],
        arenaIndexedRuns: [{ expectedPairCount: 12, prefixVsBits: new Uint32Array(4) }],
    } as unknown as RenderFrame;

    test("names its lost draws by refusing site and closes the ledger", () => {
        resetD3D9Perf();
        const e = makeExecutor();
        e.noteFrameDiscardedBeforeExecute(held, "mrtNoColorView");
        expect(getD3D9PerfSnapshot().indexedDrawUnencoded)
            .toEqual({ "submitRefused:mrtNoColorView": 1 + (12 + 1) + 1 });
        // The pairs the same frame held break the arena pair identity unless counted too.
        expect(e.metrics.arenaRunPairsFrameDiscarded).toBe(12);
        // NOT routed through drawIndexedFrameDiscarded: that is the executor's own abort walk,
        // and one loss counted in two summed terms would over-close the ledger.
        expect(e.metrics.drawIndexedFrameDiscarded).toBe(0);

        const r = reconcileD3D9ArenaRuns(
            wbuf, { drawIndexedPrimitive: 1015 }, { ...balancedRuns, drawIndexedCalls: 1000 },
            getD3D9PerfSnapshot().indexedDrawUnencoded);
        expect(r.apiDrawUnaccounted).toBe(0);
        expect(r.healthy).toBe(true);
        resetD3D9Perf();
    });

    test("every submit-side refusal routes through the accounting teardown", () => {
        // The unit test above proves the counter works; this pins the WIRING, which is the
        // half that eroded. A refusal drops a finalized frame, and the only thing in
        // d3d9-device.ts that releases such a frame's temporaries is `refuseFrame`, which
        // accounts first — so a new refusal added with its own inline teardown shows up here
        // as a second release site, and a new one that calls refuseFrame shows up as a census
        // change rather than as silently missing draws.
        const source = readFileSync(
            new URL("../../src/worker/backends/webgpu/d3d9/d3d9-device.ts", import.meta.url),
            "utf8");
        const releases = source.match(/frame\.releaseTemporaryBuffers\(\)/g) ?? [];
        expect(releases.length).toBe(1);
        const teardown = source.slice(source.indexOf("const refuseFrame = "));
        expect(teardown.indexOf("noteFrameDiscardedBeforeExecute"))
            .toBeLessThan(teardown.indexOf("frame.releaseTemporaryBuffers()"));
        // Pinned census of the refusing sites (see submitFrame).
        const sites = source.match(/ {8,}refuseFrame\("[A-Za-z]+"\);/g) ?? [];
        expect(sites.length).toBe(7);
        expect(new Set(sites).size).toBe(7);
    });

    test("a refusal that held no draw names nothing", () => {
        resetD3D9Perf();
        const e = makeExecutor();
        e.noteFrameDiscardedBeforeExecute(
            { commandTypes: [], commandA: [], arenaIndexedRuns: [] } as unknown as RenderFrame,
            "noColorTargetFormats");
        expect(getD3D9PerfSnapshot().indexedDrawUnencoded).toEqual({});
        expect(e.metrics.arenaRunPairsFrameDiscarded).toBe(0);
        resetD3D9Perf();
    });
});

/**
 * The midpoint counter. `apiDrawIndexed - drawIndexedRecorded` is loss before a command exists;
 * `drawIndexedRecorded - drawIndexedCalls` is recorded work the encoder has not consumed —
 * which at any instant includes the frame still being recorded when the snapshot was taken.
 * Without it a snapshot's residual delta cannot tell a dropped draw from an in-flight one.
 */
describe("d3d9 recorder indexed-draw midpoint", () => {
    const emptyPlan = {
        count: 0, at: () => { throw new Error("unused"); },
    } as unknown as StreamBindingPlan;
    const ib = {} as GPUBuffer;

    test("counts ordinary draws and arena-run pairs in the api's units", () => {
        const recorder = new D3D9CommandRecorder(new RenderFramePool(2));
        expect(recorder.getIndexedDrawsRecorded()).toBe(0);
        for (let i = 0; i < 2; i++) {
            recorder.recordDrawIndexed({
                pipelineId: 1, streams: emptyPlan, ibGpuBuffer: ib, ibFormat: "uint16",
                indexCount: 3, startIndex: 0, baseVertex: 0,
            });
        }
        expect(recorder.getIndexedDrawsRecorded()).toBe(2);

        recorder.recordDrawIndexedArenaRun({
            pipelineId: 1, streams: emptyPlan, ibGpuBuffer: ib, ibFormat: "uint16",
            bindStateIndex: 0, arenaCommandStart: 0, arenaCommandEnd: 0,
            pairCount: 12, prefixVsBits: new Uint32Array(4),
        });
        // 12 pairs + the fused prefix draw — the same unit the api counter mints.
        expect(recorder.getIndexedDrawsRecorded()).toBe(2 + 13);

        // Monotonic across frames: finalize hands out a new frame, the midpoint carries on.
        recorder.finalize();
        recorder.recordDrawIndexed({
            pipelineId: 1, streams: emptyPlan, ibGpuBuffer: ib, ibFormat: "uint16",
            indexCount: 3, startIndex: 0, baseVertex: 0,
        });
        expect(recorder.getIndexedDrawsRecorded()).toBe(16);
        recorder.resetIndexedDrawsRecorded();
        expect(recorder.getIndexedDrawsRecorded()).toBe(0);
    });
});
