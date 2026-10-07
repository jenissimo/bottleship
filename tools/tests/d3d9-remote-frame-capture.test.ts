/** A future-frame request must release the replay queue, and the remote producer must
 * close its own capture at Present. Otherwise a live split device always times out. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { cancelCapture, isCapturing, onFrameEnd, recordRawDraw, startCapture } from "../../src/worker/modules/ddraw/frame-capture";

const globals = globalThis as unknown as Record<string, any>;
const originalSelf = globals.self;
const originalWorkerFlag = globals.__d3d9RenderWorker;
const replies: Array<{ type: string; id?: number; value?: any }> = [];
let receive: (e: { data: unknown }) => void;

beforeAll(async () => {
    const worker = { postMessage: (message: any) => replies.push(message), onmessage: null as any };
    globals.self = worker;
    await import("../../src/worker/render/d3d9-render-worker");
    receive = worker.onmessage;
});

afterAll(() => {
    cancelCapture();
    globals.self = originalSelf;
    globals.__d3d9RenderWorker = originalWorkerFlag;
    delete globals.__captureQueueProgress;
});

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(1);
    expect(predicate()).toBe(true);
}

function finishFrame(): void {
    recordRawDraw({ backend: "d3d9", vertexCount: 2 }); // discarded tail
    onFrameEnd("d3d9");
    recordRawDraw({ backend: "d3d9", vertexCount: 3 });
    onFrameEnd("d3d9");
}

describe("remote D3D9 frame capture", () => {
    test("arms in order, allows future messages through, then replies with the complete frame", async () => {
        replies.length = 0;
        receive({ data: { type: "request", kind: "captureFrame", id: 1, timeoutMs: 1000, maxVerts: 9 } });
        receive({ data: { type: "flags", flags: { __captureQueueProgress: 1 } } });
        await waitFor(() => globals.__captureQueueProgress === 1);
        expect(isCapturing()).toBe(true);
        expect(replies.find(r => r.id === 1)).toBeUndefined();
        finishFrame();
        await waitFor(() => replies.some(r => r.id === 1));
        const frame = replies.find(r => r.id === 1)!.value;
        expect(frame.drawCalls.map((draw: any) => draw.vertexCount)).toEqual([3]);
        expect(frame.captureConfig.maxVerts).toBe(9);
        expect(isCapturing()).toBe(false);
    });

    test("an overlapping request fails without cancelling the first recording", async () => {
        replies.length = 0;
        receive({ data: { type: "request", kind: "captureFrame", id: 2, timeoutMs: 1000 } });
        receive({ data: { type: "request", kind: "captureFrame", id: 3, timeoutMs: 1000 } });
        await waitFor(() => replies.some(r => r.id === 3));
        expect(replies.find(r => r.id === 3)!.value.error).toContain("already armed");
        expect(isCapturing()).toBe(true);
        finishFrame();
        await waitFor(() => replies.some(r => r.id === 2));
        expect(replies.find(r => r.id === 2)!.value.drawCalls).toHaveLength(1);
    });

    test("a timeout clears the recording and permits the next request", async () => {
        replies.length = 0;
        receive({ data: { type: "request", kind: "captureFrame", id: 4, timeoutMs: 5 } });
        await waitFor(() => replies.some(r => r.id === 4));
        expect(replies.find(r => r.id === 4)!.value.error).toContain("capture timeout");
        expect(isCapturing()).toBe(false);
        receive({ data: { type: "request", kind: "captureFrame", id: 5, timeoutMs: 1000 } });
        await waitFor(isCapturing);
        finishFrame();
        await waitFor(() => replies.some(r => r.id === 5));
        expect(replies.find(r => r.id === 5)!.value.drawCalls).toHaveLength(1);
    });

    test("the real render-role Present closes the remote buffer once per frame", async () => {
        const device: any = Object.create(D3D9Device.prototype);
        for (const [key, value] of Object.entries({
            role: "render", splitLossSource: { isUsable: () => true },
            renderTargetIndices: [null], submitFrame() {}, fetchAuditOnPresent() {}, updateFps() {},
            backendExecutor: { hasFrameSink: () => true }, presentBoundarySerial: 0,
            frameSnapshot: { presents: 0, frameCounters: null, drawCalls: 0 },
            frameIdCounter: 0, lastDrawSnapshot: { timestamp: 0 },
        })) Object.defineProperty(device, key, { value, writable: true });
        const recording = startCapture("d3d9");
        recordRawDraw({ backend: "d3d9", vertexCount: 2 });
        await device.present();
        recordRawDraw({ backend: "d3d9", vertexCount: 3 });
        await device.present();
        expect(isCapturing()).toBe(false);
        const frame = await recording;
        expect(frame.drawCalls.map(draw => draw.vertexCount)).toEqual([3]);
    });
});
