/**
 * Split worker mode: the Present gate bounds FRAMES in flight, not shipped batches. A title that
 * polls GetData(FLUSH) ships a mid-frame batch every frame, and a batch count read those as
 * frames — the depth-2 window shrank to one frame, while a load with no Present piled up
 * batches the gate never saw.
 */

import { describe, expect, test } from "bun:test";
import { SplitPresentBacklog } from "../../src/worker/render/d3d9-render-client";

describe("split present backlog", () => {
    test("mid-frame ships do not count as frames", () => {
        const b = new SplitPresentBacklog();
        // Frame 1: flush ship (1), present ship (2). Frame 2: flush (3), present (4).
        b.notePresent(2, 0);
        b.notePresent(4, 0);
        expect(b.inFlight()).toBe(2);
        // Retiring the frame-1 flush batch retires no frame.
        b.retire(1);
        expect(b.inFlight()).toBe(2);
        b.retire(2);
        expect(b.inFlight()).toBe(1);
        b.retire(4);
        expect(b.inFlight()).toBe(0);
    });

    test("a present batch already retired, or noted twice, is not a frame in flight", () => {
        const b = new SplitPresentBacklog();
        b.notePresent(3, 3);
        expect(b.inFlight()).toBe(0);
        b.notePresent(5, 3);
        b.notePresent(5, 3);
        expect(b.inFlight()).toBe(1);
    });
});
