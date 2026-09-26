import { describe, expect, test } from "bun:test";
import { attachD3D9Split } from "../../src/worker/modules/d3d9/split";

// The flag picks the devices' roles when they are created; a front has no GPU of its own, so
// the stream must stay armed if the flag is flipped (or a harness resets flags) mid-run.
describe("d3d9 split: armed state is latched at attach", () => {
    test("clearing __d3d9Split at runtime keeps the split client armed", () => {
        const g = globalThis as { __d3d9Split?: boolean };
        const prev = g.__d3d9Split;
        let client: { armed(): boolean } | null = null;
        const dispatcher = {
            registerQueuePayloadHandler: () => 0xFFFF,
            enqueuePayloadById: () => true,
            executeWbufQueue: () => {},
            setWbufSplitClient: (c: { armed(): boolean } | null) => { client = c; },
        };
        try {
            g.__d3d9Split = true;
            attachD3D9Split({ isExtended: false } as never, null, dispatcher, null);
            expect(client).not.toBeNull();
            expect(client!.armed()).toBe(true);
            g.__d3d9Split = false;
            expect(client!.armed()).toBe(true);
        } finally {
            g.__d3d9Split = prev;
        }
    });
});
