import { describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { writeDeviceCaps9 } from "../../src/worker/modules/d3d9/caps";
import {
    checkDxDeviceFormat,
    D3DERR_NOTAVAILABLE,
} from "../../src/worker/backends/webgpu/shared/dx-format-support";
import {
    D3D9_VOLUME_ADDRESS_CAPS_MASK,
    D3D9_VOLUME_FILTER_CAPS_MASK,
} from "../../src/worker/backends/webgpu/shared/volume-policy";
import {
    D3DFMT_A8R8G8B8,
    D3DPTADDRESSCAPS_CLAMP,
    D3DPTADDRESSCAPS_WRAP,
    D3DPTFILTERCAPS_MAGFPOINT,
    D3DPTFILTERCAPS_MINFPOINT,
    D3DPTFILTERCAPS_MIPFPOINT,
    getD3D9VolumeCapabilityContract,
    isD3D9VolumeExtentSupported,
    resolveD3D9VolumePolicy,
    setD3D9VolumeCapabilityContract,
} from "../../src/worker/backends/webgpu/shared/volume-policy";

const D3DDEVTYPE_HAL = 1;
const D3DRTYPE_VOLUMETEXTURE = 4;
const D3DUSAGE_AUTOGENMIPMAP = 0x00000400;
const D3DFMT_DXT1 = 0x31545844;
const CAPS_PTR = 0x100;

function makeContract() {
    return {
        supportsTexture3D: (format: number) => format === D3DFMT_A8R8G8B8,
        maxExtent: 2048,
        filterCaps: D3DPTFILTERCAPS_MINFPOINT | D3DPTFILTERCAPS_MAGFPOINT | D3DPTFILTERCAPS_MIPFPOINT,
        addressCaps: D3DPTADDRESSCAPS_WRAP | D3DPTADDRESSCAPS_CLAMP,
        supportsAutoGenMipmaps: (format: number) => format === D3DFMT_A8R8G8B8,
    };
}

function withContract<T>(contract: ReturnType<typeof makeContract> | undefined, fn: () => T): T {
    const previous = getD3D9VolumeCapabilityContract();
    setD3D9VolumeCapabilityContract(contract ?? null);
    try {
        return fn();
    } finally {
        setD3D9VolumeCapabilityContract(previous);
    }
}

describe("D3D9 volume capability policy", () => {
    test("keeps volume support disabled until a host contract is installed", () => {
        withContract(undefined, () => {
            expect(getD3D9VolumeCapabilityContract()).toBeNull();
            const policy = resolveD3D9VolumePolicy(9, D3DFMT_A8R8G8B8);
            expect(policy.supported).toBe(false);
            expect(policy.reason).toContain("texture_3d adapter capability contract");
            expect(checkDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, 22, 0, D3DRTYPE_VOLUMETEXTURE, D3DFMT_A8R8G8B8))
                .toBe(D3DERR_NOTAVAILABLE);
        });
    });

    test("exposes only the formats, filters, addressing, and autogen modes the probe supplied", () => {
        withContract(makeContract(), () => {
            const policy = resolveD3D9VolumePolicy(9, D3DFMT_A8R8G8B8);
            expect(policy).toMatchObject({
                supported: true,
                maxExtent: 2048,
                filterCaps: makeContract().filterCaps,
                addressCaps: makeContract().addressCaps,
                supportsAutoGenMipmaps: true,
            });
            expect(resolveD3D9VolumePolicy(9, D3DFMT_DXT1).supported).toBe(false);
            expect(checkDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, 22, 0, D3DRTYPE_VOLUMETEXTURE, D3DFMT_A8R8G8B8))
                .toBe(0);
            expect(checkDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, 22, D3DUSAGE_AUTOGENMIPMAP, D3DRTYPE_VOLUMETEXTURE, D3DFMT_A8R8G8B8))
                .toBe(0);
            expect(checkDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, 22, D3DUSAGE_AUTOGENMIPMAP, D3DRTYPE_VOLUMETEXTURE, D3DFMT_DXT1))
                .toBe(D3DERR_NOTAVAILABLE);
            expect(D3D9_VOLUME_FILTER_CAPS_MASK & policy.filterCaps).toBe(policy.filterCaps);
            expect(D3D9_VOLUME_ADDRESS_CAPS_MASK & policy.addressCaps).toBe(policy.addressCaps);
        });
    });

    test("keeps the caller-side extent check coupled to the probed maximum", () => {
        withContract(makeContract(), () => {
            const policy = resolveD3D9VolumePolicy(9, D3DFMT_A8R8G8B8);
            expect(isD3D9VolumeExtentSupported(1, 1, 1, policy)).toBe(true);
            expect(isD3D9VolumeExtentSupported(2048, 2048, 2048, policy)).toBe(true);
            expect(isD3D9VolumeExtentSupported(2049, 1, 1, policy)).toBe(false);
            expect(isD3D9VolumeExtentSupported(0, 1, 1, policy)).toBe(false);
        });
    });

    test("keeps D3DCAPS9 and CheckDeviceFormat consistent under the same contract", () => {
        withContract(makeContract(), () => {
            const memory = new Uint8Array(0x1000);
            Mem.bind(() => memory);
            expect(writeDeviceCaps9(CAPS_PTR)).toBe(true);
            const caps = new DataView(memory.buffer, CAPS_PTR, 304);
            expect(caps.getUint32(60, true) & 0x0000A000).toBe(0x0000A000);
            expect(caps.getUint32(72, true)).toBe(makeContract().filterCaps);
            expect(caps.getUint32(80, true)).toBe(makeContract().addressCaps);
            expect(caps.getUint32(96, true)).toBe(2048);
        });
        withContract(undefined, () => {
            const memory = new Uint8Array(0x1000);
            Mem.bind(() => memory);
            expect(writeDeviceCaps9(CAPS_PTR)).toBe(true);
            const caps = new DataView(memory.buffer, CAPS_PTR, 304);
            expect(caps.getUint32(60, true) & 0x0000A000).toBe(0);
            expect(caps.getUint32(72, true)).toBe(0);
            expect(caps.getUint32(80, true)).toBe(0);
            expect(caps.getUint32(96, true)).toBe(0);
        });
    });
});
