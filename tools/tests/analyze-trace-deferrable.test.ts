import { describe, expect, test } from "bun:test";
import { analyzeThread, computeDeferrable } from "../analyze-trace";

const frame = (functionName: string, url: string) => ({ functionName, url, lineNumber: 0, columnNumber: 0 });
const node = (id: number, fn: string, url: string, parent?: number) =>
    ({ id, callFrame: frame(fn, url), ...(parent === undefined ? {} : { parent }) });

const DISPATCH = "http://localhost:5174/src/worker/core/thunking/thunk-dispatcher.ts";
const EXECUTOR = "http://localhost:5174/src/worker/backends/webgpu/d3d9/d3d9-backend-executor.ts";
const D3D9 = "http://localhost:5174/src/worker/modules/d3d9/fast-path.ts";

/**
 * A profile with known self-times in each region: drain payload, executor payload, boundary
 * work outside the drain, unrelated JS, and idle. The point of the fixture is that the two
 * denominators are NOT equal — a report printing only one of them cannot be checked.
 */
function syntheticThread() {
    const nodes = [
        node(1, "(root)", ""),
        node(2, "handlePortWrite", DISPATCH, 1),
        node(3, "drainWriteBuffer", DISPATCH, 2),
        node(4, "applyRenderState", D3D9, 3),          // drain payload      → deferrable
        node(5, "execute", EXECUTOR, 2),               // executor frame walk
        node(6, "encodeDraw", EXECUTOR, 5),            // executor payload   → deferrable
        node(7, "getRenderState", D3D9, 2),            // boundary, not deferrable
        node(8, "onMessage", DISPATCH, 1),             // outside the boundary
        node(9, "(idle)", "", 1),
    ];
    //                    leaf: 4   6   7   8   9
    const samples = [4, 6, 7, 8, 9];
    const timeDeltas = [300, 200, 100, 150, 250];
    const profile = {
        nodes: new Map(nodes.map(n => [n.id, n as any])),
        samples, timeDeltas, startTime: 0, startTs: 0,
    };
    return analyzeThread("1:10", "DedicatedWorker thread", profile);
}

describe("analyze-trace DEFERRABLE census", () => {
    test("sums the drain and executor regions and nothing else", () => {
        const c = computeDeferrable(syntheticThread());
        expect(c.totalUs).toBe(1000);
        expect(c.offGuestUs).toBe(500);                       // 300 drain + 200 executor
        expect(c.byRegion.get("under drainWriteBuffer")).toBe(300);
        expect(c.byRegion.get("under the boundary, outside the drain")).toBe(300); // 100 + 200 executor
        expect(c.byRegion.get("outside the boundary")).toBe(150);
    });

    test("the two denominators differ by exactly the idle share", () => {
        const c = computeDeferrable(syntheticThread());
        expect(c.idleUs).toBe(250);
        expect(c.busyUs).toBe(750);

        const ofThread = (c.offGuestUs / c.totalUs) * 100;
        const ofBusy = (c.offGuestUs / c.busyUs) * 100;
        expect(ofThread).toBeCloseTo(50, 6);
        expect(ofBusy).toBeCloseTo(66.667, 3);
        // Equality here would mean the busy denominator was never applied — the failure this
        // assertion exists to catch, since both figures are individually plausible.
        expect(ofBusy).toBeGreaterThan(ofThread);
        expect(c.totalUs - c.idleUs).toBe(c.busyUs);
    });

    test("splits the ceiling by side of the boundary, and the split is not the union", () => {
        const c = computeDeferrable(syntheticThread());
        // The drain payload is recorder work (modules/d3d9), so it stays with the guest; only
        // the executor's own payload would move. Quoting offGuestUs for a placement change
        // overstates it by 2.5x on this fixture and by 3-5x on the real traces.
        expect(c.movesUs).toBe(200);
        expect(c.keepsUs).toBe(300);
        expect(c.movesUs + c.keepsUs).toBe(c.offGuestUs);
        expect(c.movesUs).toBeLessThan(c.offGuestUs);
    });

    test("a title whose deferrable work is all recorder reports a zero movable ceiling", () => {
        // The failure this split exists to catch: a profile that looks 30% deferrable while
        // nothing at all would move. A union-only report calls this a 30% ceiling.
        const nodes = [
            node(1, "(root)", ""),
            node(2, "handlePortWrite", DISPATCH, 1),
            node(3, "drainWriteBuffer", DISPATCH, 2),
            node(4, "applyRenderState", D3D9, 3),
            node(5, "(idle)", "", 1),
        ];
        const c = computeDeferrable(analyzeThread("1:12", "t", {
            nodes: new Map(nodes.map(n => [n.id, n as any])),
            samples: [4, 5], timeDeltas: [300, 700], startTime: 0, startTs: 0,
        }));
        expect(c.offGuestUs).toBe(300);
        expect(c.movesUs).toBe(0);
        expect(c.keepsUs).toBe(300);
    });

    test("the executor counts as movable even nested under the drain", () => {
        // The walk must not stop at the first marker: drain is an ancestor of the executor on
        // some engines, and a walk that breaks there attributes executor time to KEEPS.
        const nodes = [
            node(1, "(root)", ""),
            node(2, "handlePortWrite", DISPATCH, 1),
            node(3, "drainWriteBuffer", DISPATCH, 2),
            node(4, "execute", EXECUTOR, 3),
            node(5, "encodeDraw", EXECUTOR, 4),
        ];
        const c = computeDeferrable(analyzeThread("1:13", "t", {
            nodes: new Map(nodes.map(n => [n.id, n as any])),
            samples: [5], timeDeltas: [400], startTime: 0, startTs: 0,
        }));
        expect(c.offGuestUs).toBe(400);
        expect(c.movesUs).toBe(400);
        expect(c.keepsUs).toBe(0);
    });

    test("an all-idle thread cannot report a busy percentage over 100", () => {
        const nodes = [node(1, "(root)", ""), node(2, "(idle)", "", 1)];
        const c = computeDeferrable(analyzeThread("1:11", "t", {
            nodes: new Map(nodes.map(n => [n.id, n as any])),
            samples: [2], timeDeltas: [500], startTime: 0, startTs: 0,
        }));
        expect(c.offGuestUs).toBe(0);
        expect(c.bucketUs).toBe(0);
        expect(c.busyUs).toBeGreaterThan(0);
    });
});
