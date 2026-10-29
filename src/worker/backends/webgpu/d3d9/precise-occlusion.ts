/** Count fragments in a color attachment, after discard/depth/stencil tests.
 * WebGPU occlusion queries are predicates, so their native result cannot supply D3D9 counts. */
export function countingFragment(wgsl: string, location: number): string {
    const entry = /@fragment\s+fn fs_main\((\w+):\s*(\w+)\)\s*->\s*(?:@location\(0\)\s*)?(\w+(?:<[^>]+>)?)\s*\{/;
    const match = entry.exec(wgsl);
    if (!match) throw new Error("Unrecognized D3D9 fragment entry point");
    const [, argument, inputType, outputType] = match;
    let fields: string, assignments: string;
    if (outputType === "vec4<f32>") {
        fields = "@location(0) color: vec4<f32>,";
        assignments = "out.color = value;";
    } else {
        const body = new RegExp("struct " + outputType + "\\s*\\{([^}]+)\\}").exec(wgsl)?.[1];
        if (!body) throw new Error("Missing D3D9 fragment output structure");
        fields = body;
        const names = [...body.matchAll(/(?:@\w+\([^)]*\)\s*)+(\w+)\s*:/g)].map(m => m[1]);
        if (!names.length) throw new Error("Empty D3D9 fragment output structure");
        assignments = names.map(name => `out.${name} = value.${name};`).join("\n");
    }
    const original = wgsl.replace(entry, `fn d3d9_query_fragment(${argument}: ${inputType}) -> ${outputType} {`);
    return original + `
struct D3D9CountOutput {
${fields}
@location(${location}) querySamples: f32,
}
@fragment fn fs_main(${argument}: ${inputType}) -> D3D9CountOutput {
let value = d3d9_query_fragment(${argument});
var out: D3D9CountOutput;
${assignments}
out.querySamples = 1.0;
return out;
}`;
}

export class PreciseOcclusion {
    private pipelines = new Map<number, GPUComputePipeline>();
    private totals = new Map<number, GPUBuffer>();
    readonly active = new Set<number>();
    constructor(private device: GPUDevice) {}
    private pipeline(sampleCount: number): GPUComputePipeline {
        const cached = this.pipelines.get(sampleCount);
        if (cached) return cached;
        const device = this.device;
        const multisampled = sampleCount > 1;
        const pipeline = device.createComputePipeline({
            layout: device.createPipelineLayout({bindGroupLayouts:[device.createBindGroupLayout({entries:[
                {binding:0,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"unfilterable-float",multisampled}},
                {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage"}},
            ]})]}),
            compute: { entryPoint: "main", module: device.createShaderModule({code: `
@group(0) @binding(0) var counts: ${multisampled ? 'texture_multisampled_2d' : 'texture_2d'}<f32>;
@group(0) @binding(1) var<storage, read_write> total: array<atomic<u32>>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
let size = textureDimensions(counts);
if (id.x >= size.x || id.y >= size.y) { return; }
var count = 0u;
for(var sample=0; sample<${sampleCount}; sample++) {
count += u32(textureLoad(counts, vec2<i32>(id.xy), sample).r);
}
if(count != 0u) { atomicAdd(&total[0], count); }
}`}) }
        });
        this.pipelines.set(sampleCount,pipeline);
        return pipeline;
    }
    begin(id: number): void {
        this.totals.get(id)?.destroy();
        this.totals.set(id, this.device.createBuffer({
            size: 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        }));
        this.active.add(id);
    }
    target(width: number, height: number, sampleCount = 1): GPUTexture {
        return this.device.createTexture({size: [width,height],format:"r32float",sampleCount,
            usage:GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING});
    }
    reduce(encoder: GPUCommandEncoder, texture: GPUTexture, id: number): void {
        const total = this.totals.get(id);
        if (!total) throw new Error("Occlusion interval has no counter");
        const pass = encoder.beginComputePass();
        const pipeline = this.pipeline(texture.sampleCount);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0,this.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),
            entries:[{binding:0,resource:texture.createView()},{binding:1,resource:{buffer:total}}]}));
        pass.dispatchWorkgroups(Math.ceil(texture.width/8),Math.ceil(texture.height/8));
        pass.end();
    }
    results(): ReadonlyMap<number,GPUBuffer> { return this.totals; }
    retire(id: number): void {
        this.totals.get(id)?.destroy();
        this.totals.delete(id);
    }
    destroy(): void {
        for (const buffer of this.totals.values()) buffer.destroy();
        this.totals.clear(); this.active.clear();
    }
}
