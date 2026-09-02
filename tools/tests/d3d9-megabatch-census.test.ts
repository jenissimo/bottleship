import { describe, expect, test } from "bun:test";
import {
    censusD3D9MegaBatchFrame,
    createD3D9MegaBatchCensus,
    d3d9MegaBatchCensusMetrics,
    type D3D9MegaBatchArenaReader,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-megabatch-census";
import { ArenaCommandType } from "../../src/worker/backends/webgpu/d3d9/d3d9-wasm-arena";
import { RenderFrame } from "../../src/worker/backends/webgpu/render-frame";

function arenaReader(
    types: number[],
    args: Array<[number, number, number]>,
    compact?: D3D9MegaBatchArenaReader["readCompactWbufRun"],
): D3D9MegaBatchArenaReader {
    const a = args.map(row => row[0]);
    const b = args.map(row => row[1]);
    const c = args.map(row => row[2]);
    return {
        getCommandCount: () => types.length,
        getCommandTypes: () => types,
        getCommandA: () => a,
        getCommandB: () => b,
        getCommandC: () => c,
        readCompactWbufRun: compact,
    };
}

function appendRun(
    frame: RenderFrame,
    start: number,
    end: number,
    expected: number,
): void {
    frame.pushDrawIndexedArenaRun(start, end, 0, 1, expected);
}

describe("D3D9 programmable MegaBatch eligibility census", () => {
    test("collapses exact consecutive indexed arguments into estimated physical draws", () => {
        const frame = new RenderFrame();
        appendRun(frame, 0, 10, 5);
        const types: number[] = [];
        const args: Array<[number, number, number]> = [];
        for (const draw of [
            [36, 0, -4], [36, 0, -4],
            [18, 12, 7], [18, 12, 7], [18, 12, 7],
        ] as Array<[number, number, number]>) {
            types.push(ArenaCommandType.BindProgrammable, ArenaCommandType.DrawIndexed);
            args.push([123, 0, 0], draw);
        }

        const result = censusD3D9MegaBatchFrame(frame, arenaReader(types, args));
        expect(result.logicalArenaIndexedDraws).toBe(5);
        expect(result.decodedArenaIndexedDraws).toBe(5);
        expect(result.estimatedPhysicalDraws).toBe(2);
        expect(result.eligibleLogicalDraws).toBe(5);
        expect(result.exactGroups).toBe(2);
        expect(result.eligibleGroups).toBe(2);
        expect(result.differentArgsBreaks).toBe(1);
        expect(result.maxGroupSize).toBe(3);
        expect(d3d9MegaBatchCensusMetrics(result).megaBatchMeanGroupSize).toBe(2.5);
        expect(d3d9MegaBatchCensusMetrics(result).megaBatchEligibleMeanGroupSize).toBe(2.5);
    });

    test("never joins identical draws across atomic arena-run boundaries", () => {
        const frame = new RenderFrame();
        appendRun(frame, 0, 4, 2);
        appendRun(frame, 4, 8, 2);
        const types = new Array(8).fill(0).map((_, i) =>
            i % 2 === 0 ? ArenaCommandType.BindProgrammable : ArenaCommandType.DrawIndexed);
        const args = types.map(type => type === ArenaCommandType.DrawIndexed
            ? [12, 3, 0] as [number, number, number]
            : [64, 0, 0] as [number, number, number]);

        const result = censusD3D9MegaBatchFrame(frame, arenaReader(types, args));
        expect(result.arenaRuns).toBe(2);
        expect(result.runBoundaryBreaks).toBe(1);
        expect(result.logicalArenaIndexedDraws).toBe(4);
        expect(result.estimatedPhysicalDraws).toBe(2);
        expect(result.exactGroups).toBe(2);
        expect(result.maxGroupSize).toBe(2);
    });

    test("vetoes guest instancing conservatively", () => {
        const frame = new RenderFrame();
        appendRun(frame, 0, 2, 3);
        frame.commandD[0] = 4;
        const result = censusD3D9MegaBatchFrame(frame, arenaReader(
            [ArenaCommandType.BindProgrammable, ArenaCommandType.DrawIndexed],
            [[1, 0, 0], [9, 0, 0]],
        ));

        expect(result.guestInstancingVetoRuns).toBe(1);
        expect(result.guestInstancingVetoDraws).toBe(3);
        expect(result.estimatedPhysicalDraws).toBe(3);
        expect(result.eligibleLogicalDraws).toBe(0);
    });

    test("vetoes the whole run when decoded draw count disagrees with finalized metadata", () => {
        const frame = new RenderFrame();
        appendRun(frame, 0, 4, 3);
        const result = censusD3D9MegaBatchFrame(frame, arenaReader(
            [
                ArenaCommandType.BindProgrammable, ArenaCommandType.DrawIndexed,
                ArenaCommandType.BindProgrammable, ArenaCommandType.DrawIndexed,
            ],
            [[1, 0, 0], [9, 0, 0], [2, 0, 0], [9, 0, 0]],
        ));

        expect(result.malformedVetoRuns).toBe(1);
        expect(result.malformedVetoDraws).toBe(3);
        expect(result.estimatedPhysicalDraws).toBe(3);
        expect(result.decodedArenaIndexedDraws).toBe(0);
        expect(result.exactGroups).toBe(0);
        expect(result.differentArgsBreaks).toBe(0);
    });

    test.each([false, true])("accepts an empty legacy range for compact storage=%s", storageReady => {
        const frame = new RenderFrame();
        frame.pushDrawIndexedArenaRun(
            0, 0, 0, 1, 7, 128,
            new Uint32Array([0x3f800000]), 0,
        );
        const result = censusD3D9MegaBatchFrame(frame, arenaReader([], [], () => ({
            pairCount: 7,
            indexCount: 36,
            startIndex: 0,
            baseVertex: 0,
            storageReady,
        })));

        expect(result.malformedVetoRuns).toBe(0);
        expect(result.decodedArenaIndexedDraws).toBe(7);
        expect(result.logicalArenaIndexedDraws).toBe(8);
        expect(result.eligibleLogicalDraws).toBe(8);
        expect(result.estimatedPhysicalDraws).toBe(1);
        expect(result.maxGroupSize).toBe(8);
    });

    test("accumulates weighted means without averaging per-frame ratios", () => {
        const totals = createD3D9MegaBatchCensus();
        const first = new RenderFrame();
        appendRun(first, 0, 4, 2);
        censusD3D9MegaBatchFrame(first, arenaReader(
            [
                ArenaCommandType.BindProgrammable, ArenaCommandType.DrawIndexed,
                ArenaCommandType.BindProgrammable, ArenaCommandType.DrawIndexed,
            ],
            [[1, 0, 0], [6, 0, 0], [2, 0, 0], [6, 0, 0]],
        ), totals);

        const second = new RenderFrame();
        appendRun(second, 0, 2, 1);
        censusD3D9MegaBatchFrame(second, arenaReader(
            [ArenaCommandType.BindProgrammable, ArenaCommandType.DrawIndexed],
            [[3, 0, 0], [7, 0, 0]],
        ), totals);

        const metrics = d3d9MegaBatchCensusMetrics(totals);
        expect(metrics.megaBatchCensusFrames).toBe(2);
        expect(metrics.megaBatchMeanGroupSize).toBe(1.5);
        expect(metrics.megaBatchEligibleMeanGroupSize).toBe(2);
    });
});
