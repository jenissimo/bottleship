import { PipelineCache } from "../legacy3d/pipeline-cache";
import { LegacyPrimitiveTopology } from "../legacy3d/types";
import { GlidePipelineConfig } from "./glide-types";
import { generateGlideShader } from "./glide-shader-generator";
import {
    glideSrcFactorToGpu,
    glideDstFactorToGpu,
    glideSrcFactorToGpuAlpha,
    glideDstFactorToGpuAlpha,
    unpackBlend,
} from "./glide-combine";

function topologyToGpu(topology: LegacyPrimitiveTopology): GPUPrimitiveTopology {
    switch (topology) {
        case "point-list":
            return "point-list";
        case "line-list":
            return "line-list";
        default:
            return "triangle-list";
    }
}

function cullModeToGpu(mode: number): GPUCullMode {
    if (mode === 1) return "back";
    if (mode === 2) return "front";
    return "none";
}

function depthCompareFromGlide(depthTestEnabled: boolean, depthFunction: number): GPUCompareFunction {
    if (!depthTestEnabled) {
        return "always";
    }
    switch (depthFunction | 0) {
        case 0: return "never";
        case 1: return "less";
        case 2: return "equal";
        case 3: return "less-equal";
        case 4: return "greater";
        case 5: return "not-equal";
        case 6: return "greater-equal";
        case 7:
        default:
            return "always";
    }
}

function blendStateFromGlide(packed: number): GPUBlendState {
    const b = unpackBlend(packed);
    return {
        color: {
            srcFactor: glideSrcFactorToGpu(b.rgbSf),
            dstFactor: glideDstFactorToGpu(b.rgbDf),
            operation: "add",
        },
        alpha: {
            srcFactor: glideSrcFactorToGpuAlpha(b.alphaSf),
            dstFactor: glideDstFactorToGpuAlpha(b.alphaDf),
            operation: "add",
        },
    };
}

function configKey(config: GlidePipelineConfig): string {
    return [
        config.topology,
        config.useTexture ? 1 : 0,
        config.blendEnabled ? 1 : 0,
        config.blendEnabled ? (config.blend >>> 0) : 0,
        config.depthTestEnabled ? 1 : 0,
        config.depthWriteEnabled ? 1 : 0,
        config.depthFunction | 0,
        config.cullMode,
        config.colorWriteMask & 0xf,
    ].join("|");
}

export class GlidePipelineFactory {
    private readonly cache = new PipelineCache<GPURenderPipeline>();

    constructor(
        private readonly device: GPUDevice,
        private readonly colorFormat: GPUTextureFormat,
        // Explicit layout so group 0 binding 0 can carry a DYNAMIC offset: every draw
        // needs its own uniform slice, and "auto" layouts cannot express that.
        private readonly pipelineLayout: GPUPipelineLayout,
    ) {}

    getOrCreate(config: GlidePipelineConfig): GPURenderPipeline {
        const key = configKey(config);
        const cached = this.cache.get(key);
        if (cached) {
            return cached;
        }

        const shader = this.device.createShaderModule({
            code: generateGlideShader({
                useTexture: config.useTexture,
            }),
        });

        const pipeline = this.device.createRenderPipeline({
            layout: this.pipelineLayout,
            vertex: {
                module: shader,
                entryPoint: "vs_main",
                buffers: [
                    {
                        arrayStride: 28,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: "float32x3" },
                            { shaderLocation: 1, offset: 12, format: "float32x2" },
                            { shaderLocation: 2, offset: 20, format: "float32" },
                            { shaderLocation: 3, offset: 24, format: "unorm8x4" },
                        ],
                    },
                ],
            },
            fragment: {
                module: shader,
                entryPoint: "fs_main",
                targets: [
                    {
                        format: this.colorFormat,
                        blend: config.blendEnabled ? blendStateFromGlide(config.blend) : undefined,
                        writeMask: (config.colorWriteMask & 0xf) as GPUColorWriteFlags,
                    },
                ],
            },
            primitive: {
                topology: topologyToGpu(config.topology),
                cullMode: cullModeToGpu(config.cullMode),
            },
            depthStencil: {
                format: "depth24plus",
                depthWriteEnabled: config.depthWriteEnabled,
                depthCompare: depthCompareFromGlide(config.depthTestEnabled, config.depthFunction),
            },
        });

        this.cache.set(key, pipeline);
        return pipeline;
    }

    getStats(): { hits: number; misses: number; size: number } {
        return this.cache.getStats();
    }

    clear(): void {
        this.cache.clear();
    }
}
