/**
 * The D3D9 bind-group census: a diagnostic that must not be able to report a plausible number
 * for something other than its label.
 *
 * The number it replaces was `bindGroupCacheHits / bindGroupSets` ("81.6 % hits", E6), a ratio
 * of two different populations — hits across four caches over setBindGroup calls that survived
 * a redundancy filter. What is pinned here is that the census counts builds where builds
 * happen, divides rates by its OWN frame counter, and says "did not run" where it has no
 * measurement rather than reporting zero.
 */

import { describe, expect, test } from "bun:test";
import { D3D9BackendExecutor } from "../../src/worker/backends/webgpu/d3d9/d3d9-backend-executor";

type CensusHost = {
    census: Record<string, number>;
    censusPresents: number;
    bgProfMs: number[];
    bgProfN: number[];
    fastKeyGroup: GPUBindGroup | null;
    finishProgAcquire: (
        group: GPUBindGroup, armed: boolean, verifying: boolean,
        predicted: boolean, stageEpoch: number, sampler: GPUSampler,
        cubeMask: number, comparisonMask: number, volumeMask: number, vertexVolumeMask: number,
    ) => GPUBindGroup;
    getBindGroupCensus: (reset?: boolean) => Record<string, number | string | null | boolean>;
};

function makeExecutor(): CensusHost {
    // getBindGroupCensus reads plain fields only; a device is neither available nor needed.
    return new D3D9BackendExecutor({} as never) as unknown as CensusHost;
}

describe("d3d9 bind-group census", () => {
    test("an empty window reports no rate rather than zero", () => {
        const e = makeExecutor();
        const s = e.getBindGroupCensus();
        expect(s.frames).toBe(0);
        expect(s.perFrameProgBuilds).toBeNull();
        expect(s.progHitRate).toBeNull();
    });

    test("builds and hits are counted separately from setBindGroup traffic", () => {
        const e = makeExecutor();
        e.census.progAcquires = 100;
        e.census.progHits = 80;
        e.census.progBuilds = 20;
        e.censusPresents = 2;
        const s = e.getBindGroupCensus();
        expect(s.progHitRate).toBeCloseTo(0.8, 6);
        expect(s.perFrameProgBuilds).toBeCloseTo(10, 6);
        // The rate divides by the census's OWN frame counter, not by bindGroupSets.
        expect(s.frames).toBe(2);
    });

    test("reset clears the census counters and its frame denominator together", () => {
        const e = makeExecutor();
        e.census.progBuilds = 5;
        e.censusPresents = 1;
        e.getBindGroupCensus(true);
        const s = e.getBindGroupCensus();
        expect(s.progBuilds).toBe(0);
        expect(s.frames).toBe(0);
        expect(s.perFrameProgBuilds).toBeNull();
    });

    test("an unrun acquire profile reads as null, never as free", () => {
        const e = makeExecutor();
        const s = e.getBindGroupCensus();
        expect(s.profiling).toBe(false);
        expect(s.hitUs).toBeNull();
        expect(s.missUs).toBeNull();
        expect(s.clockUs).toBeNull();
    });

    test("an unrun front-memo oracle says so instead of reporting safe", () => {
        const e = makeExecutor();
        const s = e.getBindGroupCensus();
        expect(s.fastKeyChecked).toBe(0);
        expect(s.fastKeyVerdict).toBe("front-memo oracle did not run");
    });

    test("the front-memo oracle CAN fail: one disagreement flips the verdict", () => {
        const e = makeExecutor();
        const flags = globalThis as { __d3d9ProgBindFastKeyVerify?: boolean };
        flags.__d3d9ProgBindFastKeyVerify = true;
        try {
            const sampler = {} as GPUSampler;
            const groupA = { a: 1 } as unknown as GPUBindGroup;
            const groupB = { b: 2 } as unknown as GPUBindGroup;
            // The memo predicted groupA; the full key answered groupB. That is the bug the
            // oracle exists to name, and it must count as unsafe rather than pass.
            e.fastKeyGroup = groupA;
            e.finishProgAcquire(groupB, true, true, true, 5, sampler, 0, 0, 0, 0);
            let s = e.getBindGroupCensus();
            expect(s.fastKeyChecked).toBe(1);
            expect(s.fastKeyUnsafe).toBe(1);
            expect(s.fastKeyVerdict).toBe("UNSAFE");

            // A prediction declined where the full key returned the same group is a lost skip,
            // not a bug — counted apart so the two can never be confused.
            e.getBindGroupCensus(true);
            e.fastKeyGroup = groupA;
            e.finishProgAcquire(groupA, true, true, false, 6, sampler, 0, 0, 0, 0);
            s = e.getBindGroupCensus();
            expect(s.fastKeyUnsafe).toBe(0);
            expect(s.fastKeyConservative).toBe(1);
            expect(s.fastKeyVerdict).toBe("safe");
        } finally {
            flags.__d3d9ProgBindFastKeyVerify = false;
        }
    });

    test("the acquire profile reports us/call per outcome", () => {
        const e = makeExecutor();
        e.bgProfMs[0] = 0.010; e.bgProfN[0] = 10;   // 1.0 us/hit
        e.bgProfMs[1] = 0.020; e.bgProfN[1] = 2;    // 10 us/miss
        e.bgProfMs[2] = 0.001; e.bgProfN[2] = 10;   // 0.1 us clock floor
        const s = e.getBindGroupCensus();
        expect(s.hitUs).toBeCloseTo(1, 6);
        expect(s.missUs).toBeCloseTo(10, 6);
        expect(s.clockUs).toBeCloseTo(0.1, 6);
    });
});
