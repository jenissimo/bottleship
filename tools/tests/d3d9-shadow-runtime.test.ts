import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compilePixelShader, compileVertexShader, linkProgram } from "../../src/worker/backends/webgpu/d3d9/shader";
import { Op, RegType, TexType, Usage } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";

const END = 0xffff;
const SWZ = 0xe4;
const reg = (type: number, num: number) => (((type & 7) << 28) | (((type >>> 3) & 3) << 11) | num) >>> 0;
const version = (ps: boolean) => (((ps ? 0xffff : 0xfffe) << 16) | 0x0300) >>> 0;
const ins = (op: number, operands: number) => (op | (operands << 24)) >>> 0;
const dst = (type: number, num: number) => (reg(type, num) | (0xf << 16)) >>> 0;
const src = (type: number, num: number) => (reg(type, num) | (SWZ << 16)) >>> 0;
const dcl = (usage: number, index: number, type: number, num: number, texType = 0) => [
    ins(Op.DCL, 2), (usage | (index << 16) | (texType << 27)) >>> 0, reg(type, num),
];

const vs = compileVertexShader(new Uint32Array([
    version(false), ...dcl(Usage.POSITION, 0, RegType.INPUT, 0),
    ...dcl(Usage.POSITION, 0, RegType.OUTPUT, 0),
    ...dcl(Usage.TEXCOORD, 0, RegType.OUTPUT, 1),
    ins(Op.MOV, 2), dst(RegType.OUTPUT, 0), src(RegType.INPUT, 0),
    ins(Op.MOV, 2), dst(RegType.OUTPUT, 1), src(RegType.INPUT, 0), END,
]));
const ps = compilePixelShader(new Uint32Array([
    version(true), ...dcl(Usage.TEXCOORD, 0, RegType.INPUT, 0),
    ...dcl(0, 0, RegType.SAMPLER, 3, TexType.D2),
    ins(Op.TEX, 3), dst(RegType.TEMP, 0), src(RegType.INPUT, 0), src(RegType.SAMPLER, 3),
    ins(Op.MOV, 2), dst(RegType.COLOROUT, 0), src(RegType.TEMP, 0), END,
]));

describe("D3D9 W12 live shadow sampling", () => {
    test("linking a live depth stage changes the complete shader/layout ABI", () => {
        const link = linkProgram({
            vs, ps, declElements: null, streamStride: 16,
            comparisonSamplers: new Map([[3, {}]]),
        });
        expect(link.comparisonMask).toBe(1 << 3);
        expect(link.wgsl).toContain("var tex3: texture_depth_2d;");
        expect(link.wgsl).toContain("var samp3: sampler_comparison;");
        expect(link.wgsl).toContain("textureSampleCompare(tex3, samp3");
    });

    test("runtime creates depth resources and keys layout/snapshot/cache by comparison mask", () => {
        const root = join(import.meta.dir, "..", "..");
        const device = readFileSync(join(root, "src/worker/backends/webgpu/d3d9/d3d9-device.ts"), "utf8");
        const executor = readFileSync(join(root, "src/worker/backends/webgpu/d3d9/d3d9-backend-executor.ts"), "utf8");
        const frame = readFileSync(join(root, "src/worker/backends/webgpu/render-frame.ts"), "utf8");
        expect(device).toContain("GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT");
        expect(device).toContain("state.comparisonMask = comparisonMask");
        expect(device).toContain("setDepthStencilTexture(texturePtr: number)");
        expect(executor).toContain('sampleType: "depth"');
        expect(executor).toContain('"comparison" : "filtering"');
        expect(executor).toContain("progCacheComparisonMask");
        expect(frame).toContain("comparisonMask: number");
    });

});
