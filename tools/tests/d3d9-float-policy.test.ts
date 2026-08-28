import { afterEach, describe, expect, test } from "bun:test";
import {
    D3DFMT_A16B16G16R16F,
    D3DFMT_G16R16F,
    D3DFMT_R16F,
    getD3D9FloatCapabilityContract,
    makeD3D9FloatUpload,
    makeD3D9R16FUpload,
    resolveD3D9FloatTexturePolicy,
    setD3D9FloatCapabilityContract,
} from "../../src/worker/backends/webgpu/shared/float-format-policy";
import {
    checkDxDeviceFormat,
    D3DERR_NOTAVAILABLE,
    D3D_OK,
    isDxRenderTargetFormat,
    isDxUnsupportedFormat,
} from "../../src/worker/backends/webgpu/shared/dx-format-support";

afterEach(() => {
    setD3D9FloatCapabilityContract(null);
});

function installContract(overrides: Partial<Record<"supportsTexture" | "supportsUpload" | "supportsSampling" | "supportsReadback", (format: number) => boolean>> = {}): void {
    setD3D9FloatCapabilityContract({
        supportsTexture: () => true,
        supportsUpload: () => true,
        supportsSampling: () => true,
        supportsReadback: () => true,
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
        // The bounded seam is sampled texture storage only; a float attachment
        // must remain refused until a separate render-target contract exists.
        for (const format of FLOAT16_FORMATS) {
            expect(checkDxDeviceFormat(9, 0, 1, 22, 0, 3, format)).toBe(D3D_OK);
            expect(checkDxDeviceFormat(9, 0, 1, 22, 0x1, 3, format)).toBe(D3DERR_NOTAVAILABLE);
            expect(checkDxDeviceFormat(9, 0, 1, 22, 0, 1, format)).toBe(D3DERR_NOTAVAILABLE);
            expect(checkDxDeviceFormat(9, 0, 1, 22, 0, 5, format)).toBe(D3DERR_NOTAVAILABLE);
            expect(isDxRenderTargetFormat(format, 9)).toBe(false);
        }
    });

    test("keeps other float formats outside the first bounded path", () => {
        installContract();
        for (const format of [114, 115, 116]) {
            expect(resolveD3D9FloatTexturePolicy(format).supported, format.toString()).toBe(false);
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
