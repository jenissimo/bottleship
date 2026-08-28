import { describe, expect, test } from "bun:test";
import { D3D9CommandRecorder } from "../../src/worker/backends/webgpu/d3d9/d3d9-command-recorder";
import { RenderCommandType, RenderFramePool } from "../../src/worker/backends/webgpu/render-frame";

/** D3D9's viewport is per-draw state; a WebGPU pass carries one default. Recording it as a
 *  pass-level snapshot let a guest SetViewport made AFTER the last draw (but before the flush
 *  that a SetRenderTarget triggers) retarget every draw already in the pass — Far Cry's world
 *  pass rendered into the top-left 512x512 of a 1024x768 backbuffer. */
const vp = (width: number, height: number) => ({ x: 0, y: 0, width, height, minZ: 0, maxZ: 1 });
const draw = (viewport: ReturnType<typeof vp>) => ({
    pipelineId: 1,
    vertexCount: 3,
    startVertex: 0,
    gpuBuffer: {} as GPUBuffer,
    bufferOffset: 0,
    bufferSize: 36,
    viewport,
});

const viewportCommands = (frame: ReturnType<D3D9CommandRecorder["finalize"]>) =>
    frame.commandTypes.flatMap((type, i) =>
        type === RenderCommandType.SetViewport
            ? [frame.viewportData.slice(frame.commandA[i], frame.commandA[i] + 6)]
            : []);

describe("d3d9 per-draw viewport", () => {
    test("a viewport change between draws is recorded as a command", () => {
        const recorder = new D3D9CommandRecorder(new RenderFramePool());
        recorder.recordDraw(draw(vp(1024, 768)));
        recorder.recordDraw(draw(vp(512, 512)));
        expect(viewportCommands(recorder.finalize())).toEqual([
            [0, 0, 1024, 768, 0, 1],
            [0, 0, 512, 512, 0, 1],
        ]);
    });

    test("an unchanged viewport emits nothing per draw", () => {
        const recorder = new D3D9CommandRecorder(new RenderFramePool());
        for (let i = 0; i < 4; i++) recorder.recordDraw(draw(vp(1024, 768)));
        expect(viewportCommands(recorder.finalize())).toEqual([[0, 0, 1024, 768, 0, 1]]);
    });

    test("the recorded viewport is independent of the state at flush time", () => {
        const recorder = new D3D9CommandRecorder(new RenderFramePool());
        // The device hands its live viewport object to every draw; the recorder must copy it,
        // not alias it, or a later mutation rewrites what earlier draws asked for.
        const live = vp(1024, 768);
        recorder.recordDraw(draw(live));
        live.width = 512; live.height = 512;
        expect(viewportCommands(recorder.finalize())).toEqual([[0, 0, 1024, 768, 0, 1]]);
    });

    test("each frame re-emits its viewport rather than inheriting the previous pass's", () => {
        const recorder = new D3D9CommandRecorder(new RenderFramePool());
        recorder.recordDraw(draw(vp(1024, 768)));
        recorder.finalize();
        recorder.recordDraw(draw(vp(1024, 768)));
        expect(viewportCommands(recorder.finalize())).toEqual([[0, 0, 1024, 768, 0, 1]]);
    });
});
