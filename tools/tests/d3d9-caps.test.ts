import { afterEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { writeDeviceCaps9 } from "../../src/worker/modules/d3d9/caps";
import { writeDeviceCaps8 } from "../../src/worker/modules/d3d8/caps";
import {
    checkDxDeviceFormat,
    checkDxDeviceFormatConversion,
} from "../../src/worker/backends/webgpu/shared/dx-format-support";
import { MAX_DYNAMIC_DEPTH, MAX_LOOP_NESTING } from "../../src/worker/backends/webgpu/d3d9/shader/passes/structure";
import { VS_FLOAT_REGISTER_COUNT } from "../../src/worker/backends/webgpu/d3d9/shader/emit/vs";
import { setD3D9WebGpuCapabilityLimits } from "../../src/worker/backends/webgpu/shared/webgpu-capability-limits";

const D3DCAPS9_SIZE = 304;
const CAPS_PTR = 0x100;
const D3DPS20CAPS_PREDICATION = 1 << 2;
const D3DPS20CAPS_GRADIENTINSTRUCTIONS = 1 << 1;
const D3DVTXPCAPS_TWEENING = 1 << 6;
const D3DDEVTYPE_HAL = 1;
const D3DFMT_X8R8G8B8 = 22;
const D3DFMT_A8R8G8B8 = 21;
const D3DRTYPE_TEXTURE = 3;
const D3DUSAGE_QUERY_VERTEXTEXTURE = 0x00100000;
const D3DPTADDRESSCAPS_WRAP = 0x00000001;
const D3DPTADDRESSCAPS_MIRROR = 0x00000002;
const D3DPTADDRESSCAPS_CLAMP = 0x00000004;
const D3DPTADDRESSCAPS_BORDER = 0x00000008;
const D3DPTADDRESSCAPS_MIRRORONCE = 0x00000020;

function readPatchedCaps(): DataView {
    const memory = new Uint8Array(0x1000);
    Mem.bind(() => memory);
    expect(writeDeviceCaps9(CAPS_PTR)).toBe(true);
    return new DataView(memory.buffer, CAPS_PTR, D3DCAPS9_SIZE);
}

afterEach(() => {
    setD3D9WebGpuCapabilityLimits(null);
});

describe("D3DCAPS9 shader capability patch", () => {
    test("matches the implemented SM3 flow/predicate seam and VS register file", () => {
        const caps = readPatchedCaps();

        // D3DCAPS9 offsets, in bytes, from d3d9caps.h.
        expect(caps.getUint32(200, true)).toBe(VS_FLOAT_REGISTER_COUNT);
        // FFP exposes four non-indexed palette matrices, an eight-entry indexed palette, and
        // declaration-based POSITION0/POSITION1 tweening.
        expect(caps.getUint32(168, true)).toBe(4);
        expect(caps.getUint32(172, true)).toBe(7);
        expect(caps.getUint32(156, true) & D3DVTXPCAPS_TWEENING).toBe(D3DVTXPCAPS_TWEENING);
        expect(caps.getUint32(264, true) & D3DPS20CAPS_PREDICATION).toBe(D3DPS20CAPS_PREDICATION);
        // Dynamic DSX/DSY/TEXLDD cannot be lowered to WGSL; the shader linker
        // refuses that path, so the global gradient bit must not invite it.
        expect(caps.getUint32(264, true) & D3DPS20CAPS_GRADIENTINSTRUCTIONS).toBe(0);
        expect(caps.getInt32(268, true)).toBe(MAX_DYNAMIC_DEPTH);
        expect(caps.getInt32(276, true)).toBe(MAX_LOOP_NESTING);
        // PREMODULATE is already absent from the reference profile; BUMPENVMAP and
        // BUMPENVMAPLUMINANCE are absent because the stage-local FFP combiner cannot
        // consume the next stage's texture that these operators require.
        expect(caps.getUint32(144, true) & 0x00600000).toBe(0);
    });

    test("advertises shader-emulated sampler address modes", () => {
        const caps = readPatchedCaps();
        const addressCaps = caps.getUint32(76, true);

        // Native WebGPU modes remain available to callers that probe the caps.
        expect(addressCaps & (D3DPTADDRESSCAPS_WRAP | D3DPTADDRESSCAPS_MIRROR | D3DPTADDRESSCAPS_CLAMP))
            .toBe(D3DPTADDRESSCAPS_WRAP | D3DPTADDRESSCAPS_MIRROR | D3DPTADDRESSCAPS_CLAMP);
        // BORDER and MIRRORONCE are lowered by both programmable and FFP shader emitters.
        expect(addressCaps & (D3DPTADDRESSCAPS_BORDER | D3DPTADDRESSCAPS_MIRRORONCE))
            .toBe(D3DPTADDRESSCAPS_BORDER | D3DPTADDRESSCAPS_MIRRORONCE);
    });

    test("advertises per-stage constants now that the FFP uniform carries them", () => {
        const caps = readPatchedCaps();
        expect(caps.getUint32(32, true) & 0x00008000).toBe(0x00008000);
    });

    test("advertises vertex-texture filters only when CheckDeviceFormat accepts 2D fetch", () => {
        const caps = readPatchedCaps();

        expect(caps.getUint32(284, true)).toBe(0x03000300);
        expect(
            checkDxDeviceFormat(
                9,
                0,
                D3DDEVTYPE_HAL,
                D3DFMT_X8R8G8B8,
                D3DUSAGE_QUERY_VERTEXTEXTURE,
                D3DRTYPE_TEXTURE,
                D3DFMT_A8R8G8B8,
            ),
        ).toBe(0);
    });

    test("advertises the stencil operations lowered by the depth24plus-stencil8 path", () => {
        expect(readPatchedCaps().getUint32(136, true)).toBe(0x1ff);
    });

    test("format-conversion queries follow the actual color-copy contract", () => {
        expect(checkDxDeviceFormatConversion(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, D3DFMT_A8R8G8B8)).toBe(0);
        expect(checkDxDeviceFormatConversion(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 75)).toBe(0x8876086a);
        expect(checkDxDeviceFormatConversion(9, 1, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, D3DFMT_A8R8G8B8)).toBe(0x8876086c);
    });

    test("caps never exceed the live WebGPU 2-D texture limit", () => {
        setD3D9WebGpuCapabilityLimits({ maxTextureDimension2D: 1024, maxTextureDimension3D: 256 });
        const caps = readPatchedCaps();
        expect(caps.getUint32(88, true)).toBe(1024);
        expect(caps.getUint32(92, true)).toBe(1024);
        expect(caps.getUint32(104, true)).toBe(1024);
    });

    test("does not advertise unsupported fixed-function or declaration paths", () => {
        const caps = readPatchedCaps();
        expect(caps.getUint32(144, true) & 0x00600000).toBe(0);
        expect(caps.getUint32(236, true) & 0x000000c0).toBe(0);
        expect(caps.getUint32(36, true) & 0x00000004).toBe(0);
        expect(caps.getUint32(12, true) & 0x40000000).toBe(0);
        expect(caps.getFloat32(116, true)).toBe(-32768);
        expect(caps.getFloat32(124, true)).toBe(32768);
    });
});

describe("D3DCAPS8 capability limits", () => {
    test("keeps dimensions, aspect ratio, and bump ops within the backend contract", () => {
        const memory = new Uint8Array(0x1000);
        setD3D9WebGpuCapabilityLimits({ maxTextureDimension2D: 1024, maxTextureDimension3D: 256 });
        expect(writeDeviceCaps8(CAPS_PTR, memory)).toBe(true);
        const caps = new DataView(memory.buffer, CAPS_PTR, 212);
        expect(caps.getUint32(88, true)).toBe(1024);
        expect(caps.getUint32(92, true)).toBe(1024);
        // 104 is MaxTextureAspectRatio — a RATIO, not a dimension, so no WebGPU texture
        // limit constrains it (see tools/tests/d3d8-ffp-combiner.test.ts).
        expect(caps.getUint32(104, true)).not.toBe(1024);
        expect(caps.getUint32(144, true) & 0x00600000).toBe(0);
    });
});
