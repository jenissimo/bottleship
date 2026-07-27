// The surface-op log is a DIAGNOSTIC, so its own cost is part of its correctness: a ring
// that pays O(n) per record once full makes frames slower than the compositing it is there
// to explain, and the timing it reports becomes its own. These pin the two properties that
// matter — bounded memory, and oldest-first order across the wrap.

import { describe, expect, test } from "bun:test";
import {
    armSurfaceOps, recordSurfaceOp, surfaceOpsArmed, takeSurfaceOps,
} from "../../src/worker/modules/ddraw/surface-op-log";

// recordSurfaceOp only reads these fields off the state; a bitmap surface takes the
// non-render branch, which is enough to exercise the ring.
const state = (ptr: number) => ({ surfacePtr: ptr }) as never;

describe("surface op ring", () => {
    test("disarmed by default and records nothing", () => {
        armSurfaceOps(0);
        expect(surfaceOpsArmed()).toBe(false);
        recordSurfaceOp("blt", "gpu", state(1), null, null, null);
        expect(takeSurfaceOps()).toEqual([]);
    });

    test("keeps the LAST n and returns them oldest-first across the wrap", () => {
        armSurfaceOps(4);
        for (let i = 0; i < 10; i++) recordSurfaceOp("blt", `p${i}`, state(i), null, null, null);
        const out = takeSurfaceOps();
        expect(out.length).toBe(4);
        // 0..5 evicted; the survivors must be in the order they happened, not rotated.
        expect(out.map((r) => r.path)).toEqual(["p6", "p7", "p8", "p9"]);
        expect(out.map((r) => r.seq)).toEqual([6, 7, 8, 9]);
    });

    test("under-filled ring returns only what was recorded, in order", () => {
        armSurfaceOps(8);
        for (let i = 0; i < 3; i++) recordSurfaceOp("flip", `q${i}`, state(i), null, null, null);
        expect(takeSurfaceOps().map((r) => r.path)).toEqual(["q0", "q1", "q2"]);
    });

    test("take empties the ring, so a second window is not contaminated", () => {
        armSurfaceOps(4);
        recordSurfaceOp("fill", "cpu", state(1), null, null, null);
        expect(takeSurfaceOps().length).toBe(1);
        expect(takeSurfaceOps()).toEqual([]);
        recordSurfaceOp("fill", "gpu", state(2), null, null, null);
        expect(takeSurfaceOps().map((r) => r.path)).toEqual(["gpu"]);
    });

    test("re-arming clears whatever the previous window held", () => {
        armSurfaceOps(4);
        recordSurfaceOp("blt", "old", state(1), null, null, null);
        armSurfaceOps(4);
        expect(takeSurfaceOps()).toEqual([]);
    });

    test("stays bounded well past capacity", () => {
        armSurfaceOps(16);
        for (let i = 0; i < 5_000; i++) recordSurfaceOp("blt", "x", state(i), null, null, null);
        expect(takeSurfaceOps().length).toBe(16);
    });
});
