/**
 * CheckDeviceMultiSampleType answers D3DMULTISAMPLE_NONMASKABLE with D3D_OK and one quality
 * level (one sample). An engine that read that answer then asks CreateDevice/Reset for
 * NONMASKABLE quality 0; the device refused it with D3DERR_NOTAVAILABLE, the engine reported
 * "device reset failed" and gave up. The device must accept every type the query accepted.
 */
import { describe, expect, test } from "bun:test";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { checkDxDeviceMultiSampleType } from "../../src/worker/backends/webgpu/shared/dx-format-support";
import { D3DMULTISAMPLE_NONMASKABLE } from "../../src/worker/backends/webgpu/shared/msaa-policy";

const D3D_OK = 0;
const D3DDEVTYPE_HAL = 1;
const D3DFMT_X8R8G8B8 = 22;
const supports = D3D9Device.prototype.supportsD3D9MultisampleType;
const configure = D3D9Device.prototype.configureD3D9MultisampleType;

describe("D3D9 NONMASKABLE", () => {
    test("the device accepts every multisample type the capability query accepts", () => {
        const device = { d3d9MsaaProbe: null };
        for (let type = 0; type <= 16; type++) {
            for (const windowed of [0, 1]) {
                const hr = checkDxDeviceMultiSampleType(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, windowed, type);
                if (hr === D3D_OK) expect({ type, ok: supports.call(device, type) }).toEqual({ type, ok: true });
            }
        }
    });

    test("NONMASKABLE is accepted and configured as one sample", () => {
        expect(supports.call({ d3d9MsaaProbe: null }, D3DMULTISAMPLE_NONMASKABLE)).toBe(true);
        let reconfigured = false;
        const device = {
            d3d9MsaaProbe: null,
            d3d9MsaaSampleCount: 1,
            supportsD3D9MultisampleType: supports,
            backendExecutor: { configureD3D9BackbufferMsaa: () => { reconfigured = true; return true; } },
        };
        expect(configure.call(device, D3DMULTISAMPLE_NONMASKABLE)).toBe(true);
        expect(device.d3d9MsaaSampleCount).toBe(1);
        expect(reconfigured).toBe(false);
    });
});
