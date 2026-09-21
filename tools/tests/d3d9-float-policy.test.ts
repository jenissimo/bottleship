import { afterEach, describe, expect, test } from "bun:test";
import {
    D3DFMT_A16B16G16R16F,
    D3DFMT_G16R16F,
    D3DFMT_R16F,
    getD3D9FloatCapabilityContract,
    makeD3D9FloatUpload,
    makeD3D9R16FUpload,
    D3DFMT_R32F,
    isD3D9FloatRenderTargetBlendable,
    isD3D9FloatRenderTargetSupported,
    isGpuColorFormatBlendable,
    resolveD3D9FloatRenderTargetPolicy,
    resolveD3D9FloatTexturePolicy,
    setD3D9FloatCapabilityContract,
} from "../../src/worker/backends/webgpu/shared/float-format-policy";
import {
    checkDxDeviceFormat,
    D3DERR_NOTAVAILABLE,
    D3D_OK,
    isDxCreatableRenderTargetFormat,
    isDxRenderTargetFormat,
    isDxUnsupportedFormat,
} from "../../src/worker/backends/webgpu/shared/dx-format-support";

afterEach(() => {
    setD3D9FloatCapabilityContract(null);
});

type ProbeName = "supportsTexture" | "supportsUpload" | "supportsSampling" | "supportsReadback"
    | "supportsRenderTarget" | "supportsRenderTargetBlending";

/** Sampled storage passes by default; attachment is opt-in, matching the two contracts. */
function installContract(overrides: Partial<Record<ProbeName, (format: number) => boolean>> = {}): void {
    setD3D9FloatCapabilityContract({
        supportsTexture: () => true,
        supportsUpload: () => true,
        supportsSampling: () => true,
        supportsReadback: () => true,
        supportsRenderTarget: () => false,
        supportsRenderTargetBlending: () => false,
        ...overrides,
    });
}

const FLOAT16_FORMATS = [D3DFMT_R16F, D3DFMT_G16R16F, D3DFMT_A16B16G16R16F] as const;

describe("D3D9 16-bit float texture capability policy", () => {
    test("refuses without an explicit host probe", () => {
        expect(getD3D9FloatCapabilityContract()).toBeNull();
        for (const format of FLOAT16_FORMATS) {
            expect(resolveD3D9FloatTexturePolicy(format)).toMatchObject({
                supported: false,
                gpuFormat: null,
            });
            expect(isDxUnsupportedFormat(format, 9)).toBe(true);
        }
    });

    test("requires all allocation/upload/sampling/readback probes", () => {
        installContract({ supportsSampling: () => false });
        expect(resolveD3D9FloatTexturePolicy(D3DFMT_R16F).supported).toBe(false);

        installContract({});
        expect(resolveD3D9FloatTexturePolicy(D3DFMT_R16F)).toMatchObject({
            supported: true, gpuFormat: "r16float", bytesPerTexel: 2, reason: null,
        });
        expect(resolveD3D9FloatTexturePolicy(D3DFMT_G16R16F)).toMatchObject({
            supported: true, gpuFormat: "rg16float", bytesPerTexel: 4, reason: null,
        });
        expect(resolveD3D9FloatTexturePolicy(D3DFMT_A16B16G16R16F)).toMatchObject({
            supported: true, gpuFormat: "rgba16float", bytesPerTexel: 8, reason: null,
        });
        for (const format of FLOAT16_FORMATS) expect(isDxUnsupportedFormat(format, 9)).toBe(false);
        // Sampled storage alone does not make an attachment: the render-target contract
        // is separate, and this arm has it OFF.
        for (const format of FLOAT16_FORMATS) {
            expect(checkDxDeviceFormat(9, 0, 1, 22, 0, 3, format)).toBe(D3D_OK);
            expect(checkDxDeviceFormat(9, 0, 1, 22, 0x1, 3, format)).toBe(D3DERR_NOTAVAILABLE);
            expect(checkDxDeviceFormat(9, 0, 1, 22, 0, 1, format)).toBe(D3DERR_NOTAVAILABLE);
            expect(checkDxDeviceFormat(9, 0, 1, 22, 0, 5, format)).toBe(D3DERR_NOTAVAILABLE);
            expect(isDxRenderTargetFormat(format, 9)).toBe(false);
        }
    });

    test("answers for float attachments only when the render-target probe passed", () => {
        installContract({ supportsRenderTarget: () => true });
        for (const format of FLOAT16_FORMATS) {
            expect(resolveD3D9FloatRenderTargetPolicy(format).supported, format.toString()).toBe(true);
            expect(isDxRenderTargetFormat(format, 9), format.toString()).toBe(true);
            expect(isDxCreatableRenderTargetFormat(format, 9), format.toString()).toBe(true);
            // TEXTURE / SURFACE / CUBETEXTURE are the forms a render target is asked about.
            expect(checkDxDeviceFormat(9, 0, 1, 22, 0x1, 3, format), format.toString()).toBe(D3D_OK);
            expect(checkDxDeviceFormat(9, 0, 1, 22, 0x1, 1, format), format.toString()).toBe(D3D_OK);
            expect(checkDxDeviceFormat(9, 0, 1, 22, 0x1, 5, format), format.toString()).toBe(D3D_OK);
            // Sampled storage stays a 2-D texture answer even with attachments allowed.
            expect(checkDxDeviceFormat(9, 0, 1, 22, 0, 5, format), format.toString()).toBe(D3DERR_NOTAVAILABLE);
        }
        // A format the adapter refuses as sampled storage is not an attachment either.
        installContract({ supportsTexture: () => false, supportsRenderTarget: () => true });
        for (const format of FLOAT16_FORMATS) {
            expect(resolveD3D9FloatRenderTargetPolicy(format).supported, format.toString()).toBe(false);
            expect(isDxRenderTargetFormat(format, 9), format.toString()).toBe(false);
        }
    });

    test("covers the 32-bit float family under the same probed contract", () => {
        installContract();
        for (const [format, gpuFormat, bytesPerTexel] of
            [[114, "r32float", 4], [115, "rg32float", 8], [116, "rgba32float", 16]] as const) {
            expect(resolveD3D9FloatTexturePolicy(format), format.toString())
                .toMatchObject({ supported: true, gpuFormat, bytesPerTexel, reason: null });
            expect(isDxUnsupportedFormat(format, 9), format.toString()).toBe(false);
        }
        // An adapter that refuses the storage refuses the format — no hardcoded allow-list.
        installContract({ supportsSampling: () => false });
        for (const format of [114, 115, 116]) {
            expect(resolveD3D9FloatTexturePolicy(format).supported, format.toString()).toBe(false);
            expect(isDxUnsupportedFormat(format, 9), format.toString()).toBe(true);
        }
    });

    test("separates attachment from blending on a float target", () => {
        // Attachable but NOT blendable — the r32float shadow-map case. Creation must
        // succeed; the blending capability query must still say no.
        installContract({ supportsRenderTarget: () => true });
        for (const format of [D3DFMT_R32F, D3DFMT_A16B16G16R16F]) {
            expect(isD3D9FloatRenderTargetSupported(format), format.toString()).toBe(true);
            expect(isD3D9FloatRenderTargetBlendable(format), format.toString()).toBe(false);
            expect(isGpuColorFormatBlendable(
                resolveD3D9FloatTexturePolicy(format).gpuFormat!), format.toString()).toBe(false);
            // usage RENDERTARGET|QUERY_POSTPIXELSHADER_BLENDING
            expect(checkDxDeviceFormat(9, 0, 1, 22, 0x80001, 3, format), format.toString())
                .toBe(D3DERR_NOTAVAILABLE);
            expect(checkDxDeviceFormat(9, 0, 1, 22, 0x1, 3, format), format.toString()).toBe(D3D_OK);
        }
        installContract({ supportsRenderTarget: () => true, supportsRenderTargetBlending: () => true });
        for (const format of [D3DFMT_R32F, D3DFMT_A16B16G16R16F]) {
            expect(isD3D9FloatRenderTargetBlendable(format), format.toString()).toBe(true);
            expect(checkDxDeviceFormat(9, 0, 1, 22, 0x80001, 3, format), format.toString()).toBe(D3D_OK);
        }
        // A non-float target is always blendable — the predicate must not be a blanket no.
        expect(isGpuColorFormatBlendable("bgra8unorm")).toBe(true);
    });

    test("keeps non-float exotics outside the supported set", () => {
        installContract();
        for (const format of [85, 117]) {
            expect(isDxUnsupportedFormat(format, 9), format.toString()).toBe(true);
        }
    });
});

describe("D3D9 float upload layout", () => {
    test("copies guest rows losslessly into a 256-byte WebGPU stride", () => {
        const source = new Uint8Array(16).map((_, i) => i + 1);
        const upload = makeD3D9R16FUpload(source, 3, 2, 8);
        expect(upload).not.toBeNull();
        expect(upload!.bytesPerRow).toBe(256);
        expect(Array.from(upload!.data.slice(0, 6))).toEqual([1, 2, 3, 4, 5, 6]);
        expect(Array.from(upload!.data.slice(256, 262))).toEqual([9, 10, 11, 12, 13, 14]);
        expect(upload!.data.slice(6, 256).every(value => value === 0)).toBe(true);
    });

    test("rejects truncated or undersized guest rows", () => {
        expect(makeD3D9R16FUpload(new Uint8Array(3), 2, 1, 4)).toBeNull();
        expect(makeD3D9R16FUpload(new Uint8Array(8), 3, 1, 4)).toBeNull();
    });

    test("packs multi-channel half-float rows with the format's texel width", () => {
        const source = new Uint8Array(16).map((_, i) => i + 1);
        const upload = makeD3D9FloatUpload(source, 2, 1, 12, 4);
        expect(upload).not.toBeNull();
        expect(upload!.bytesPerRow).toBe(256);
        expect(Array.from(upload!.data.slice(0, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });
});
