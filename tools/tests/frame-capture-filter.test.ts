import { expect, test } from "bun:test";
import { startCapture, cancelCapture, recordRawDraw, onFrameEnd, isCapturing } from "../../src/worker/modules/ddraw/frame-capture";

test("capture skips complete loading frames and preserves only the matching frame", async () => {
    const recording = startCapture("d3d9", { minDraws: 2 });
    try {
        recordRawDraw({ backend: "d3d9", vertexCount: 100 });
        onFrameEnd("d3d9"); // partial frame
        recordRawDraw({ backend: "d3d9", vertexCount: 200 });
        onFrameEnd("d3d9"); // loading frame
        expect(isCapturing()).toBe(true);
        recordRawDraw({ backend: "d3d9", vertexCount: 3 });
        recordRawDraw({ backend: "d3d9", vertexCount: 6 });
        onFrameEnd("ddraw");
        expect(isCapturing()).toBe(true);
        onFrameEnd("d3d9");
        const frame = await recording;
        expect(frame.drawCalls.map(d => [d.index, d.vertexCount])).toEqual([[0, 3], [1, 6]]);
        expect(frame.skippedFilteredFrameEnds).toBe(1);
        expect(frame.captureConfig?.minDraws).toBe(2);
        expect(isCapturing()).toBe(false);
    } finally {
        cancelCapture();
    }
});

test("cancelled frame selection does not leak into the next capture", async () => {
    const filtered = startCapture("d3d9", { minDraws: 200 });
    const rejection = filtered.catch(error => error);
    onFrameEnd("d3d9");
    cancelCapture();
    expect((await rejection).message).toBe("capture cancelled");
    const recording = startCapture("d3d9");
    onFrameEnd("d3d9");
    recordRawDraw({ backend: "d3d9", vertexCount: 3 });
    onFrameEnd("d3d9");
    expect((await recording).drawCalls).toHaveLength(1);
});

test('target selection excludes a busy menu and waits for multiple render attachments', async () => {
    const recording = startCapture('d3d9', { minDraws: 2, minRenderTargets: 2 });
    try {
        onFrameEnd('d3d9');
        for (let i = 0; i < 10; i++) recordRawDraw({ backend: 'd3d9', rtSurfacePtr: 100 });
        onFrameEnd('d3d9'); expect(isCapturing()).toBe(true);
        for (const rtSurfacePtr of [200, 300]) recordRawDraw({ backend: 'd3d9', rtSurfacePtr });
        onFrameEnd('d3d9');
        const frame = await recording;
        expect(frame.drawCalls.map(draw => draw.rtSurfacePtr)).toEqual([200, 300]);
        expect(frame.skippedFilteredFrameEnds).toBe(1);
    } finally { cancelCapture(); }
});
