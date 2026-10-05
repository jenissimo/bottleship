import { describe, expect, test } from "bun:test";
import {
    D3DBLEND_BOTHSRCALPHA,
    D3DBLEND_INVSRCALPHA,
    D3DBLEND_ONE,
    D3DBLEND_SRCCOLOR2,
    D3DBLEND_SRCALPHA,
    D3DBLEND_ZERO,
    D3DPT_LINELIST,
    D3DPT_LINESTRIP,
    D3DPT_POINTLIST,
    D3DPT_TRIANGLEFAN,
    D3DPT_TRIANGLELIST,
    D3D9_MAX_DRAW_ARGUMENT,
    classifyD3D9BlendFactor,
    classifyD3D9BlendState,
    classifyD3D9HomogeneousPosition,
    clipD3D9HomogeneousLine,
    clipD3D9HomogeneousTriangle,
    d3d9HomogeneousClipCode,
    isD3D9DualSourceBlendFactor,
    resolveD3D9MultisampleRasterPolicy,
    resolveD3D9PrimitiveRasterPolicy,
    resolveD3D9SampleMaskPolicy,
    validateD3D9RasterDrawCommand,
} from "../../src/worker/backends/webgpu/d3d9/raster-emulation";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { D3D9_FFP_STAGE_COUNT } from "../../src/worker/backends/webgpu/d3d9/d3d9-state-tracker";
import { FFP_MAX_LIGHTS } from "../../src/worker/backends/webgpu/d3d9/ffp-lighting";

describe("D3D9 raster emulation policy", () => {
    test("keeps fixed-function texture-stage state within the eight-stage contract", () => {
        const set = (D3D9Device.prototype as unknown as {
            setTextureStageState: (stage: number, type: number, value: number) => number;
            getTextureStageState: (stage: number, type: number) => number;
        });
        const fake = {
            textureStageStates: new Map<number, number>(), recordingStateBlock: false,
            projectedSetCount: 0, projectedFlagsSeen: 0,
            makeStageStateKey: (stage: number, type: number) => (((stage & 0xffff) << 16) | (type & 0xffff)) >>> 0,
        } as any;
        expect(D3D9_FFP_STAGE_COUNT).toBe(8);
        expect(set.setTextureStageState.call(fake, 7, 1, 2)).toBe(0);
        expect(set.getTextureStageState.call(fake, 7, 1)).toBe(2);
        expect(set.setTextureStageState.call(fake, 8, 1, 2)).not.toBe(0);
        expect(set.getTextureStageState.call(fake, 8, 1)).toBe(0);
    });

    test("accepts a sparse light index; the bank cap is on how many are ENABLED", () => {
        // D3D9 light indices are an unbounded sparse DWORD space (DXVK resizes its vector to
        // Index + 1); MaxActiveLights caps only the simultaneously enabled set, which is
        // enforced where the FFP bank is built. An engine that gives each scene light its own
        // slot and enables a subset is doing the documented thing.
        const set = (D3D9Device.prototype as unknown as {
            setLight: (index: number, data: Uint8Array) => number;
            getLight: (index: number) => Uint8Array | null;
            lightEnable: (index: number, enable: number) => number;
        });
        const fake = { lights: new Map<number, Uint8Array>(), lightEnables: new Map<number, number>(), recordingStateBlock: false } as any;
        expect(FFP_MAX_LIGHTS).toBe(8);
        expect(set.setLight.call(fake, 12, new Uint8Array(64))).toBe(0);
        expect(set.getLight.call(fake, 12)).not.toBeNull();
        expect(set.lightEnable.call(fake, 12, 1)).toBe(0);
        // A negative index is not a sparse one — it is a malformed call.
        expect(set.setLight.call(fake, -1, new Uint8Array(64))).not.toBe(0);
        expect(set.getLight.call(fake, -1)).toBeNull();
    });
    test("classifies D3D9 homogeneous clip planes without a perspective divide", () => {
        expect(d3d9HomogeneousClipCode([0, 0, 0.5, 1])).toBe(0);
        expect(d3d9HomogeneousClipCode([-2, 0, 0.5, 1])).toBe(1);
        expect(d3d9HomogeneousClipCode([0, 0, -0.1, 1])).toBe(16);
        expect(d3d9HomogeneousClipCode([0, 0, 0.5, 0])).toBe(64);
        expect(d3d9HomogeneousClipCode([Number.NaN, 0, 0, 1])).toBeNull();
        expect(classifyD3D9HomogeneousPosition([0, 0, 0, 1])).toEqual({ code: 0, classification: "inside" });
        expect(classifyD3D9HomogeneousPosition([2, 0, 0, 1]).classification).toBe("outside");
        expect(classifyD3D9HomogeneousPosition([0, 0, 0, -1]).classification).toBe("invalid");
    });

    test("clips a line against D3D9 x/y/z homogeneous bounds", () => {
        const clipped = clipD3D9HomogeneousLine([[-2, 0, 0.5, 1], [0, 0, 0.5, 1]]);
        expect(clipped).toMatchObject({ valid: true, classification: "partial", reason: null });
        expect(clipped.vertices).toHaveLength(2);
        expect(clipped.vertices[0]).toEqual([-1, 0, 0.5, 1]);
        expect(clipped.vertices.every(vertex => d3d9HomogeneousClipCode(vertex) === 0)).toBe(true);

        expect(clipD3D9HomogeneousLine([[0, 0, -1, 1], [0, 0, -0.1, 1]])).toMatchObject({
            valid: true, classification: "outside", vertices: [], reason: null,
        });
    });

    test("clips a triangle to an ordered polygon and refuses non-positive W", () => {
        const clipped = clipD3D9HomogeneousTriangle([
            [-2, -0.5, 0.5, 1],
            [0.5, -0.5, 0.5, 1],
            [0.5, 0.5, 0.5, 1],
        ]);
        expect(clipped.valid).toBe(true);
        expect(clipped.classification).toBe("partial");
        expect(clipped.vertices).toHaveLength(4);
        expect(clipped.vertices.every(vertex => (d3d9HomogeneousClipCode(vertex) ?? 64) === 0)).toBe(true);
        expect(clipped.vertices.some(vertex => vertex[0] === -1)).toBe(true);

        const invalid = clipD3D9HomogeneousTriangle([
            [0, 0, 0.5, 1], [0.5, 0, 0.5, 1], [0, 0.5, 0.5, 0],
        ]);
        expect(invalid).toMatchObject({ valid: false, classification: "invalid", vertices: [] });
        expect(invalid.reason).toMatch(/non-positive/);
    });

    test("accepts full masks and ignores high DWORD bits", () => {
        expect(resolveD3D9SampleMaskPolicy(1, 0xffff_ffff)).toEqual({
            sampleCount: 1,
            requestedMask: 0xffff_ffff,
            effectiveMask: 1,
            mode: "all",
            supported: true,
            reason: null,
        });
        expect(resolveD3D9SampleMaskPolicy(4, 0xffff_ffff).effectiveMask).toBe(0xf);
        expect(resolveD3D9SampleMaskPolicy(4, 0x0000_000f).supported).toBe(true);
    });

    test("carries zero and partial sample masks into WebGPU coverage", () => {
        const none = resolveD3D9SampleMaskPolicy(4, 0);
        expect(none.mode).toBe("none");
        expect(none.supported).toBe(true);
        expect(none.reason).toBeNull();

        const partial = resolveD3D9SampleMaskPolicy(4, 0x5);
        expect(partial).toMatchObject({ effectiveMask: 0x5, mode: "partial", supported: true, reason: null });
    });

    test("D3DRS_MULTISAMPLEANTIALIAS=FALSE never refuses a draw on an MSAA target", () => {
        // DXVK lowers it to rasterizationSamples=1 (d3d9_device.cpp BindRasterizerState);
        // WebGPU has no rasterizer sample-count override, so the hint is ignored. Refusing
        // would drop every UI/particle pass that turns AA off.
        expect(resolveD3D9MultisampleRasterPolicy(1, false, 1).supported).toBe(true);
        for (const sampleCount of [2, 4]) {
            const disabled = resolveD3D9MultisampleRasterPolicy(sampleCount, false, 0xf);
            expect(disabled.supported).toBe(true);
            expect(disabled.reason).toBeNull();
            expect(disabled.antialiasEnabled).toBe(false);
            expect(disabled.sampleMask.effectiveMask).toBe(sampleCount === 4 ? 0xf : 0x3);
        }
        // An unrepresentable sample count is still a real refusal.
        expect(resolveD3D9MultisampleRasterPolicy(3, false, 0xf).supported).toBe(false);
    });

    test("validates primitive counts and lowers safe list topologies", () => {
        expect(resolveD3D9PrimitiveRasterPolicy(D3DPT_TRIANGLELIST, { primitiveCount: 2 })).toMatchObject({
            supported: true,
            topology: "triangle-list",
            sourceVertexCount: 6,
            outputVertexCount: 6,
            needsCpuLowering: false,
        });
        expect(resolveD3D9PrimitiveRasterPolicy(D3DPT_TRIANGLEFAN, { primitiveCount: 3 })).toMatchObject({
            supported: true,
            topology: "triangle-list",
            sourceVertexCount: 5,
            outputVertexCount: 9,
            needsCpuLowering: true,
        });
        expect(resolveD3D9PrimitiveRasterPolicy(D3DPT_LINESTRIP, { primitiveCount: 4 })).toMatchObject({
            supported: true,
            topology: "line-list",
            sourceVertexCount: 5,
            outputVertexCount: 8,
            needsCpuLowering: true,
        });
        expect(resolveD3D9PrimitiveRasterPolicy(D3DPT_LINELIST, { primitiveCount: -1 }).supported).toBe(false);
        expect(resolveD3D9PrimitiveRasterPolicy(99, { primitiveCount: 1 }).reason).toMatch(/unknown/);
    });

    test("refuses raster states that cannot preserve point/line coverage", () => {
        const point = resolveD3D9PrimitiveRasterPolicy(D3DPT_POINTLIST, {
            primitiveCount: 2,
            pointSpriteEnable: true,
            pointSize: 8,
        });
        expect(point).toMatchObject({ supported: true, topology: "triangle-list", outputVertexCount: 12, needsCpuLowering: true });
        expect(resolveD3D9PrimitiveRasterPolicy(D3DPT_POINTLIST, {
            primitiveCount: 1,
            indexed: true,
        })).toMatchObject({ supported: true, outputVertexCount: 6, needsCpuLowering: true });
        expect(resolveD3D9PrimitiveRasterPolicy(D3DPT_POINTLIST, {
            primitiveCount: 1,
            programmable: true,
        })).toMatchObject({ supported: true, outputVertexCount: 6, needsCpuLowering: true });
        expect(resolveD3D9PrimitiveRasterPolicy(D3DPT_LINELIST, {
            primitiveCount: 1,
            antialiasedLineEnable: true,
        }).reason).toMatch(/ANTIALIASEDLINEENABLE/);
    });

    test("validates compact draw arguments before WebGPU encoding", () => {
        expect(validateD3D9RasterDrawCommand({
            kind: "non-indexed", count: 6, start: 4, instanceCount: 1,
        })).toBeNull();
        expect(validateD3D9RasterDrawCommand({
            kind: "indexed", count: 6, start: 0, baseVertex: -4, instanceCount: 2,
        })).toBeNull();
        // Empty draws remain representable no-ops; they must not be confused
        // with malformed negative/NaN arguments.
        expect(validateD3D9RasterDrawCommand({ kind: "non-indexed", count: 0, start: 0, instanceCount: 0 })).toBeNull();

        expect(validateD3D9RasterDrawCommand({ kind: "non-indexed", count: -1, start: 0 })).toMatch(/count/);
        expect(validateD3D9RasterDrawCommand({ kind: "non-indexed", count: Number.NaN, start: 0 })).toMatch(/count/);
        expect(validateD3D9RasterDrawCommand({ kind: "non-indexed", count: 1, start: D3D9_MAX_DRAW_ARGUMENT + 1 })).toMatch(/start/);
        expect(validateD3D9RasterDrawCommand({ kind: "indexed", count: 1, start: 0, baseVertex: 0x8000_0000 })).toMatch(/baseVertex/);
        expect(validateD3D9RasterDrawCommand({ kind: "indexed", count: 1, start: 0, baseVertex: -0x8000_0001 })).toMatch(/baseVertex/);
        expect(validateD3D9RasterDrawCommand({ kind: "indexed", count: 1, start: 0, instanceCount: Infinity })).toMatch(/instance/);
    });

    test("classifies ordinary, legacy BOTH*, dual-source, and invalid blend factors", () => {
        expect(classifyD3D9BlendFactor(D3DBLEND_SRCALPHA)).toMatchObject({ kind: "ordinary", representable: true });
        expect(classifyD3D9BlendFactor(D3DBLEND_BOTHSRCALPHA)).toMatchObject({ kind: "legacy-both", representable: false });
        expect(classifyD3D9BlendFactor(D3DBLEND_SRCCOLOR2)).toMatchObject({ kind: "dual-source", representable: false });
        expect(classifyD3D9BlendFactor(0xdead)).toMatchObject({ kind: "invalid", representable: false });
        expect(isD3D9DualSourceBlendFactor(D3DBLEND_SRCCOLOR2)).toBe(true);
        expect(isD3D9DualSourceBlendFactor(D3DBLEND_ONE)).toBe(false);
    });

    test("expands BOTH* legacy source factors and refuses second-source factors", () => {
        const legacy = classifyD3D9BlendState({
            srcColor: D3DBLEND_BOTHSRCALPHA,
            dstColor: D3DBLEND_ZERO,
        });
        expect(legacy).toMatchObject({
            supported: true,
            usesDualSource: false,
            color: { src: D3DBLEND_SRCALPHA, dst: D3DBLEND_INVSRCALPHA },
        });

        const dual = classifyD3D9BlendState({
            srcColor: D3DBLEND_SRCCOLOR2,
            dstColor: D3DBLEND_ONE,
        });
        expect(dual.supported).toBe(false);
        expect(dual.usesDualSource).toBe(true);
        expect(dual.reason).toMatch(/second fragment color/);
    });
});
