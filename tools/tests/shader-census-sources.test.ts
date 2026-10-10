import { expect, test } from "bun:test";
import { censusComplete, collectShaderCensus } from "../../src/worker/harness/shader-census";

test("shader census reads the rendering twins, including their failed pipeline builds", () => {
    const twin = {
        shaderInstrumentationSnapshot: () => ({
            shaderBuildFailures: 1,
            pairs: [{ handle: 7, build: "failed", error: "interpolant budget", drawsIssued: 0 }],
        }),
    };
    const collection = collectShaderCensus(false, new Map([[3, twin]]));
    expect(censusComplete(collection)).toBe(true);
    expect(collection.snapshots).toEqual([{
        device: 3, shaderBuildFailures: 1,
        pairs: [{ handle: 7, build: "failed", error: "interpolant budget", drawsIssued: 0 }],
    }]);
});

test("an empty or failed rendering source cannot report a complete clean shader census", () => {
    expect(censusComplete(collectShaderCensus(false, []))).toBe(false);
    const collection = collectShaderCensus(false, [[4, {
        shaderInstrumentationSnapshot: () => { throw new Error("device unavailable"); },
    }]]);
    expect(censusComplete(collection)).toBe(false);
    expect(collection.snapshotFailures).toBe(1);
    expect(collection.snapshots[0]?.error).toContain("device unavailable");
});

test("the API front cannot certify modules linked by another worker", () => {
    const collection = collectShaderCensus(false, [[1, {
        shaderInstrumentationSnapshot: () => ({ shaderBuildFailures: 0, census: { complete: false } }),
    }]]);
    expect(censusComplete(collection)).toBe(false);
});
