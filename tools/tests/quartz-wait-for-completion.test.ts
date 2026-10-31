// IMediaEvent::WaitForCompletion timeout semantics: 0 polls, null (INFINITE) blocks until
// EC_COMPLETE, a finite timeout reports expiry instead of pretending completion.
import { describe, it, expect } from "bun:test";
import "../../src/worker/core/system";
import { FilterGraphObject } from "../../src/worker/modules/quartz/com-objects";
import { FilterState } from "../../src/worker/modules/quartz/constants";

function runningGraph(): FilterGraphObject {
    const fg = new FilterGraphObject(0);
    fg.state = FilterState.RUNNING;
    return fg;
}

describe("FilterGraphObject.waitForCompletion", () => {
    it("timeout 0 polls instead of waiting forever", async () => {
        expect(await runningGraph().waitForCompletion(0)).toBe(false);
    });

    it("a finite timeout expires as not-completed", async () => {
        expect(await runningGraph().waitForCompletion(5)).toBe(false);
    });

    it("an already-completed graph answers at once", async () => {
        const fg = runningGraph();
        fg.markCompleted();
        expect(await fg.waitForCompletion(0)).toBe(true);
    });

    it("an infinite wait resolves on completion", async () => {
        const fg = runningGraph();
        const wait = fg.waitForCompletion(null);
        fg.markCompleted();
        expect(await wait).toBe(true);
    });
});
