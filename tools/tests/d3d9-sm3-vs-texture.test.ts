/** W16 acceptance: VS3 texldl lowering and the vertex-visible bind snapshot. */
import { describe, expect, test } from "bun:test";
import { D3D9BackendExecutor } from "../../src/worker/backends/webgpu/d3d9/d3d9-backend-executor";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import {
    D3D9StateTracker,
    d3d9TextureStageSlot,
    isD3D9TextureStage,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-state-tracker";
import { StreamBindingTable } from "../../src/worker/backends/webgpu/shared/vertex-streams";
import {
    captureVertexTextureEntries,
    classifyStateBlockCoverage,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-state-block";
import { Emitter } from "../../src/worker/backends/webgpu/d3d9/shader/emitter";
import { analyzeVs, emitVsMain } from "../../src/worker/backends/webgpu/d3d9/shader/emit/vs";
import { emitBindLayout } from "../../src/worker/backends/webgpu/d3d9/shader/link/bind-layout";
import { Census } from "../../src/worker/backends/webgpu/d3d9/shader/census";
import { Op, RegType } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";
import type { SmInstruction, SmProgram, SmSource } from "../../src/worker/backends/webgpu/d3d9/shader/sm-parser";

const IDENTITY = 0xE4;

function source(type: RegType, num: number, swizzle = IDENTITY): SmSource {
    return { reg: { type, num, relative: false }, swizzle, modifier: 0 };
}

function destination(type: RegType, num: number): NonNullable<SmInstruction["dst"]> {
    return {
        reg: { type, num, relative: false },
        writeMask: 0xF,
        shift: 0,
        saturate: false,
        partialPrecision: false,
        centroid: false,
    };
}

function instruction(opcode: Op, src: SmSource[], dst: SmInstruction["dst"]): SmInstruction {
    return { opcode, coissue: false, predicated: false, specificData: 0, dst, src };
}

function vertexProgram(instructions: SmInstruction[]): SmProgram {
    return {
        isPixelShader: false,
        major: 3,
        minor: 0,
        instructions,
        declarations: [],
        definitions: [],
        maxTemp: 0,
        maxConst: -1,
        maxBool: -1,
        samplersUsed: new Set(),
        inputRegs: new Set([0]),
        usesRelativeConst: false,
        stream: [],
        tokenCount: 0,
        terminated: true,
    };
}

describe("D3D9 VS3 vertex texture fetch (W16)", () => {
    test("texldl selects D3DVERTEXTEXTURESAMPLER2 and produces a sampled value", () => {
        const program = vertexProgram([
            instruction(Op.TEXLDL, [source(RegType.INPUT, 0), source(RegType.SAMPLER, 2, 0x00)], destination(RegType.TEMP, 0)),
            instruction(Op.MOV, [source(RegType.TEMP, 0)], destination(RegType.ATTROUT, 0)),
        ]);
        const census = new Census();
        const wgsl = emitVsMain(program, analyzeVs(program), {
            interpColors: [true, false],
            interpTexcoords: [],
            inputExprs: new Map(),
            constantCount: 0,
            pixelCentreSlot: 0,
            census,
        });

        expect(wgsl).toContain("// texldl (D3DVERTEXTEXTURESAMPLER2, stage 259)");
        expect(wgsl).toContain("textureSampleLevel(vtex2, vsamp2");
        expect(wgsl).toContain(").xxxx");
        expect(census.summary().unsupportedOps).toEqual([]);
        // The sampled result is observable through the vertex colour output, not just a dead load.
        expect(wgsl).toContain("oD0 = vec4<f32>(_st");
        expect(wgsl).not.toMatch(/oD0\.[xyzw]\s*=/);
    });

    test("vertex bind declarations reserve four 257..260 sampler pairs", () => {
        const emitter = new Emitter();
        emitBindLayout(emitter, {
            hasTexture: false,
            fragSamplers: [],
            cubeMask: 0,
            programmablePixel: true,
            samplerBinding: 2,
            textureBase: 3,
            hybridSamplerBase: 19,
        });
        const wgsl = emitter.toString();
        for (let n = 0; n < 4; n++) {
            expect(wgsl).toContain(`D3DVERTEXTEXTURESAMPLER${n} (stage ${257 + n})`);
            expect(wgsl).toContain(`@binding(${34 + n}) var vtex${n}: texture_2d<f32>;`);
            expect(wgsl).toContain(`@binding(${38 + n}) var vsamp${n}: sampler;`);
        }
    });

    test("executor snapshot makes the vertex pairs VERTEX-visible and non-overlapping", () => {
        const globals = globalThis as Record<string, unknown>;
        const previous = globals.GPUShaderStage;
        globals.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
        try {
            let entries: any[] = [];
            const device = {
                createBindGroupLayout: (desc: { entries: any[] }) => { entries = desc.entries; return {}; },
                createPipelineLayout: () => ({}),
            };
            const executor = new D3D9BackendExecutor({ getDevice: () => device } as never);
            executor.getProgrammableLayout(0);

            const vertexTextures = entries.filter((entry) => entry.visibility === 1 && entry.texture);
            const vertexSamplers = entries.filter((entry) => entry.visibility === 1 && entry.sampler);
            expect(vertexTextures.map((entry) => entry.binding)).toEqual([34, 35, 36, 37]);
            expect(vertexSamplers.map((entry) => entry.binding)).toEqual([38, 39, 40, 41]);
            expect(vertexTextures.every((entry) => entry.texture.viewDimension === "2d")).toBe(true);
        } finally {
            if (previous === undefined) delete globals.GPUShaderStage;
            else globals.GPUShaderStage = previous;
        }
    });

    test("maps exactly 0..15, D3DDMAPSAMPLER and 257..260 into independent runtime slots", () => {
        expect([0, 7, 15, 256, 257, 258, 259, 260].map(d3d9TextureStageSlot))
            .toEqual([0, 7, 15, 20, 16, 17, 18, 19]);
        for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 16, 255, 261, 0xffffffff]) {
            expect(isD3D9TextureStage(invalid)).toBe(false);
        }

        const tracker = new D3D9StateTracker(new StreamBindingTable());
        expect(tracker.setTexture(0, 10)).toBe(true);
        expect(tracker.setTexture(257, 20)).toBe(true);
        expect(tracker.getTexture(0)).toBe(10);
        expect(tracker.getTexture(257)).toBe(20);
        // D3DDMAPSAMPLER is a legal SetTexture target (the presampled-displacement map). It
        // has no consumer here, but D3D9 has no failure mode for the call.
        expect(tracker.setTexture(256, 30)).toBe(true);
        expect(tracker.getTexture(256)).toBe(30);
        expect(tracker.getTexture(0)).toBe(10);
        expect(tracker.getTexture(257)).toBe(20);
    });

    test("sampler state accepts vertex stages and rejects the exact sparse-stage gap", () => {
        const device: any = Object.create(D3D9Device.prototype);
        Object.defineProperties(device, {
            recordingStateBlock: { value: false, writable: true },
            samplerStates: { value: new Map<number, number>(), writable: true },
            stageSamplersValid: { value: 0, writable: true },
        });

        expect(device.setSamplerState(15, 5, 7)).toBe(0);
        expect(device.getSamplerState(15, 5)).toBe(7);
        expect(device.setSamplerState(259, 5, 3)).toBe(0);
        expect(device.getSamplerState(259, 5)).toBe(3);
        expect(device.setSamplerState(256, 5, 4)).toBe(0); // D3DDMAPSAMPLER
        expect(device.getSamplerState(256, 5)).toBe(4);
        for (const invalid of [16, 261, 0xffffffff]) {
            expect(device.setSamplerState(invalid, 5, 9)).toBe(0x8876086c);
            expect(device.getSamplerState(invalid, 5)).toBe(0);
        }
    });

    test("vertex state blocks capture DMAP sampler state while ALL owns texture bindings", () => {
        const entries: any[] = [];
        captureVertexTextureEntries({
            getAllSamplerStates: () => [
                { sampler: 0, type: 5, value: 1 },
                { sampler: 257, type: 5, value: 2 },
                { sampler: 260, type: 6, value: 3 },
                { sampler: 261, type: 5, value: 4 },
            ],
            getBoundTexturePtr: stage => stage === 259 ? 0x1234 : 0,
        }, entries);

        expect(entries.filter(e => e.op === "samplerState").map(e => e.sampler)).toEqual([257, 258, 259, 260]);
        // D3D9 texture bindings are ALL-only; VERTEXSTATE owns only D3DSAMP_DMAPOFFSET.
        expect(entries.filter(e => e.op === "texture")).toEqual([]);
        expect(classifyStateBlockCoverage(entries).coverable).toBe(false);
    });

    test("real bind entries and cache identity include vertex texture and sampler changes", () => {
        const groups: Array<{ entries: Array<{ binding: number; resource: unknown }> }> = [];
        const gpu = {
            createBindGroup: (desc: { entries: Array<{ binding: number; resource: unknown }> }) => {
                groups.push(desc);
                return { id: groups.length };
            },
        };
        const executor: any = new D3D9BackendExecutor({ getDevice: () => gpu } as never);
        const fallback = { fallback: true };
        executor.vsArena = { buffer: {} };
        executor.psArena = { buffer: {} };
        executor.getProgrammableLayout = () => ({ bindGroupLayout: {} });
        executor.getFallbackTextureView = () => fallback;

        const pixelTextures = new Array(16).fill(null);
        const pixelSamplers = new Array(16).fill(null);
        const vertexTextures = [{ view: "a" }, null, null, null];
        const vertexSamplers = [{ sampler: "a" }, null, null, null];
        const sharedSampler = { shared: true };
        const acquire = executor.acquireProgBindGroup.bind(executor);

        const first = acquire(sharedSampler, pixelTextures, pixelSamplers, vertexTextures, vertexSamplers, 0);
        expect(acquire(sharedSampler, pixelTextures, pixelSamplers, vertexTextures, vertexSamplers, 0)).toBe(first);
        expect(groups).toHaveLength(1);
        expect(groups[0]!.entries.find(e => e.binding === 34)?.resource).toBe(vertexTextures[0]);
        expect(groups[0]!.entries.find(e => e.binding === 38)?.resource).toBe(vertexSamplers[0]);

        const highPixelTextures = pixelTextures.slice();
        highPixelTextures[15] = { view: "s15" };
        acquire(sharedSampler, highPixelTextures, pixelSamplers, vertexTextures, vertexSamplers, 0);

        const changedTextures = [{ view: "b" }, null, null, null];
        acquire(sharedSampler, pixelTextures, pixelSamplers, changedTextures, vertexSamplers, 0);
        const changedSamplers = [{ sampler: "b" }, null, null, null];
        acquire(sharedSampler, pixelTextures, pixelSamplers, changedTextures, changedSamplers, 0);
        expect(groups).toHaveLength(4);
    });
});
