/** Real GPU readback for two partial depth clears encoded before one submit. */
import { closeHarnessConnection, harness } from "../../harness";

async function probe(modulePath: string) {
    const gpu = navigator.gpu;
    if (!gpu) throw new Error("WebGPU is unavailable");
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error("No WebGPU adapter");
    const device = await adapter.requestDevice();
    const errors: string[] = [];
    device.addEventListener("uncapturederror", event => errors.push(event.error.message));
    device.pushErrorScope("validation");
    const { ClearPipeline } = await import(modulePath);
    const clear = new ClearPipeline(device, device.queue);
    const depth = device.createTexture({ size: [4, 2], format: "depth24plus-stencil8",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    const color = device.createTexture({ size: [4, 2], format: "rgba8unorm",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const readback = device.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
        const shader = device.createShaderModule({ code: `
            @group(0) @binding(0) var depth: texture_depth_2d;
            @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
                let p = array<vec2f, 3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3));
                return vec4f(p[i], 0, 1);
            }
            @fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
                return vec4f(textureLoad(depth, vec2i(p.xy), 0), 0, 0, 1);
            }` });
        const pipeline = device.createRenderPipeline({ layout: "auto",
            vertex: { module: shader, entryPoint: "vs" },
            fragment: { module: shader, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] } });
        const binding = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: depth.createView({ aspect: "depth-only" }) }] });
        const encoder = device.createCommandEncoder();
        const view = depth.createView();
        clear.clear(encoder, null, 4, 2, view, { flags: 2, depth: 1 }, "rgba8unorm");
        clear.clear(encoder, null, 4, 2, view, { flags: 2, depth: 0.125,
            rects: [{ x1: 0, y1: 0, x2: 2, y2: 2 }] }, "rgba8unorm");
        clear.clear(encoder, null, 4, 2, view, { flags: 2, depth: 0.875,
            rects: [{ x1: 2, y1: 0, x2: 4, y2: 2 }] }, "rgba8unorm");
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: color.createView(),
            clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" }] });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, binding);
        pass.draw(3);
        pass.end();
        encoder.copyTextureToBuffer({ texture: color }, { buffer: readback, bytesPerRow: 256 }, [4, 2]);
        device.queue.submit([encoder.finish()]);
        clear.destroyPendingAfterSubmit(encoder);
        await readback.mapAsync(GPUMapMode.READ);
        const bytes = new Uint8Array(readback.getMappedRange());
        const red = Array.from({ length: 2 }, (_, y) => Array.from({ length: 4 }, (_, x) => bytes[y * 256 + x * 4]));
        readback.unmap();
        const validation = await device.popErrorScope();
        if (validation) errors.push(validation.message);
        return { red, errors, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
            device: adapter.info.device, description: adapter.info.description } };
    } finally {
        if (readback.mapState === "mapped") readback.unmap();
        readback.destroy();
        color.destroy();
        depth.destroy();
        clear.destroy();
        device.destroy();
    }
}

const modulePath = "/src/worker/backends/webgpu/ddraw/clear-pipeline.ts";
try {
    const run = await harness().evalPage(`(${probe.toString()})(${JSON.stringify(modulePath)})`, 20000).run();
    if (!run.ok) throw new Error(JSON.stringify(run));
    const result = run.steps[0]!.result as Awaited<ReturnType<typeof probe>>;
    console.log(JSON.stringify({ modulePath, ...result }, null, 2));
    if (result.errors.length) throw new Error("GPU rejected work: " + result.errors.join("; "));
    const expected = [32, 32, 223, 223];
    if (result.red.length !== 2 || !result.red.every(row => row.length === 4 &&
        row.every((value, x) => value !== undefined && Math.abs(value - expected[x]!) <= 1))) {
        throw new Error("Depth readback must preserve both requested values");
    }
} finally {
    closeHarnessConnection();
}
