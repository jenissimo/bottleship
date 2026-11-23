import { expect, test } from "bun:test";
import { dispatchVertexConversion, endVertexPrepass, finishDrawCommands, prepassEnabledForDraw, vertexPrepassEncoder }
    from "../../src/worker/backends/webgpu/ddraw/compute/vertex-prepass";

test("the default applies only to D3D8-origin draws and preserves explicit switches", () => {
    const options = globalThis as { __ffpVertexPrepass?: boolean };
    const previous = options.__ffpVertexPrepass;
    try {
        delete options.__ffpVertexPrepass;
        expect(prepassEnabledForDraw(true)).toBe(true);
        expect(prepassEnabledForDraw(false)).toBe(false);
        options.__ffpVertexPrepass = false;
        expect(prepassEnabledForDraw(true)).toBe(false);
        options.__ffpVertexPrepass = true;
        expect(prepassEnabledForDraw(false)).toBe(true);
    } finally {
        options.__ffpVertexPrepass = previous;
    }
});

test("private vertex conversions share a pass and precede only their own render buffer", () => {
    const events: string[] = [];
    function encoder(name: string): GPUCommandEncoder {
        return {
            beginComputePass: () => {
                events.push(name + " begin");
                return {
                    setPipeline() {}, setBindGroup() {},
                    dispatchWorkgroups: (count: number) => events.push(name + " " + count),
                    end: () => events.push(name + " end"),
                };
            },
            finish: () => name,
        } as unknown as GPUCommandEncoder;
    }
    const render = encoder("render");
    const device = {createCommandEncoder: () => encoder("geometry")} as unknown as GPUDevice;
    const convert = vertexPrepassEncoder(device, render);
    const dispatch = (count: number) => dispatchVertexConversion(convert, {} as GPUComputePipeline, {} as GPUBindGroup, 0, count);
    dispatch(3);
    expect(vertexPrepassEncoder(device, render)).toBe(convert);
    dispatch(4);
    endVertexPrepass(convert); // A scratch-pool spill needs a buffer copy outside the compute pass.
    dispatch(5);
    expect(finishDrawCommands(encoder("other frame"))).toEqual(["other frame"]);
    expect(finishDrawCommands(render)).toEqual(["geometry", "render"]);
    expect(events).toEqual(["geometry begin", "geometry 3", "geometry 4", "geometry end",
        "geometry begin", "geometry 5", "geometry end"]);
});
