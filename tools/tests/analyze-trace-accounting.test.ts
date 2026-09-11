import { describe, expect, test } from "bun:test";
import { buildParentMap, computeStats, mergeProfileChunks, reportGpuProcess } from "../analyze-trace";

const node = (id: number, fields: { parent?: number; children?: number[] } = {}) => ({
    id, callFrame: { functionName: `n${id}`, url: "", lineNumber: 0, columnNumber: 0 }, ...fields,
});

describe("Chrome trace accounting", () => {
    test("trace parent edges and standalone children edges give identical inclusive time", () => {
        const variants = [
            [node(1), node(2, { parent: 1 }), node(3, { parent: 2 })],
            [node(1, { children: [2] }), node(2, { children: [3] }), node(3)],
        ];
        for (const rows of variants) {
            const stats = computeStats({ nodes: new Map(rows.map(n => [n.id, n])),
                samples: [3, 2, 3], timeDeltas: [7, 5, 11], startTime: 0, startTs: 0 });
            expect(stats.get(1)).toEqual({ selfUs: 0, totalUs: 23 });
            expect(stats.get(2)).toEqual({ selfUs: 5, totalUs: 23 });
            expect(stats.get(3)).toEqual({ selfUs: 18, totalUs: 18 });
            expect([...stats.values()].reduce((sum, row) => sum + row.selfUs, 0)).toBe(23);
        }
    });

    test("contradictory parent encodings refuse attribution", () => {
        expect(() => buildParentMap(new Map([
            [1, node(1, { children: [3] })], [2, node(2)], [3, node(3, { parent: 2 })],
        ]))).toThrow("Conflicting profile parents");
    });

    test("chunk delivery timestamp does not shift samples or lose cross-chunk parents", () => {
        const common = { ph: "P", pid: 42, id: "0x1" };
        const profiles = mergeProfileChunks([
            { ...common, name: "Profile", tid: 7, ts: 1004, args: { data: { startTime: 1000 } } },
            { ...common, name: "ProfileChunk", tid: 99, ts: 8000,
                args: { data: { cpuProfile: { nodes: [node(1), node(2, { parent: 1 })], samples: [2] }, timeDeltas: [20] } } },
            { ...common, name: "ProfileChunk", tid: 99, ts: 9000,
                args: { data: { cpuProfile: { nodes: [node(3, { parent: 2 })], samples: [3] }, timeDeltas: [30] } } },
        ] as any);
        const p = profiles.get("42:7")!;
        expect(p.startTs).toBe(1000);
        expect(p.timeDeltas).toEqual([20, 30]);
        expect(computeStats(p).get(1)?.totalUs).toBe(50);
    });

    test("GPU coverage unions nested and overlapping scopes separately per thread", () => {
        const event = (ts: number, dur: number, tid = 2) => ({
            ph: "X", name: "task", cat: "disabled-by-default-gpu.dawn", pid: 1, tid, ts, dur,
        });
        const text = reportGpuProcess([
            event(0, 10000), event(1000, 8000), event(9000, 4000), event(15000, 2000),
            event(0, 7000, 3),
        ], new Map([["1:2", "CrGpuMain"], ["1:3", "VizCompositorThread"]]), 2);
        // Canonical occupied intervals: [0,13] + [15,17] ms; other thread [0,7] ms.
        expect(text).toMatch(/CrGpuMain\s+15\.0\s+4\s+7\.50/);
        expect(text).toMatch(/VizCompositorThread\s+7\.0\s+1\s+3\.50/);
        expect(text).toContain("neither scheduled CPU time nor GPU hardware time");
        expect(text).toContain("GPU HARDWARE TIMINGS: NOT DECODED");
    });
});
