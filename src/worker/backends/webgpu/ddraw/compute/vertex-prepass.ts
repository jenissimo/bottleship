// The converter reads CPU-uploaded geometry and writes disjoint, submit-scoped
// output ranges. Rendering only reads those ranges, so all conversions owned
// by a render encoder can be submitted immediately before it in the same batch.
type Batch = { encoder: GPUCommandEncoder; pass?: GPUComputePassEncoder };
/** @transient(batches are owned by live render encoder identities) */
const owners = new WeakMap<GPUCommandEncoder, Batch>();
/** @transient(compute passes are owned by live conversion encoder identities) */
const converters = new WeakMap<GPUCommandEncoder, Batch>();

export function prepassEnabledForDraw(fromD3D8: boolean): boolean {
    const override = (globalThis as { __ffpVertexPrepass?: boolean }).__ffpVertexPrepass;
    return typeof override === "boolean" ? override : fromD3D8;
}

export function vertexPrepassEncoder(device: GPUDevice, render: GPUCommandEncoder): GPUCommandEncoder {
    let batch = owners.get(render);
    if (!batch) {
        batch = { encoder: device.createCommandEncoder({label: "FFP vertex conversions"}) };
        owners.set(render, batch);
        converters.set(batch.encoder, batch);
    }
    return batch.encoder;
}

export function dispatchVertexConversion(encoder: GPUCommandEncoder, pipeline: GPUComputePipeline,
    bindings: GPUBindGroup, offset: number, workgroups: number): void {
    const batch = converters.get(encoder);
    const pass = batch ? (batch.pass ??= encoder.beginComputePass()) : encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings, [offset]);
    pass.dispatchWorkgroups(workgroups);
    if (!batch) pass.end();
}

export function endVertexPrepass(encoder: GPUCommandEncoder): void {
    const batch = converters.get(encoder);
    if (batch?.pass) {
        batch.pass.end();
        batch.pass = undefined;
    }
}

export function finishDrawCommands(render: GPUCommandEncoder): GPUCommandBuffer[] {
    const batch = owners.get(render);
    if (!batch) return [render.finish()];
    owners.delete(render);
    endVertexPrepass(batch.encoder);
    return [batch.encoder.finish(), render.finish()];
}
