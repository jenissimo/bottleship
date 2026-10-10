import { afterEach, describe, expect, test } from "bun:test";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import {
    fillDeviceDesc,
    fillDeviceDesc7,
    D3D7_RGB_DEVICE_GUID_BYTES,
    D3D7_HAL_DEVICE_GUID_BYTES,
    D3D7_TNLHAL_DEVICE_GUID_BYTES,
} from "../../src/worker/modules/ddraw/d3d/d3d-caps-utils";
import {
    MAX_FFP_STAGES,
    MAX_FFP_SAMPLED_STAGES,
} from "../../src/worker/backends/webgpu/ddraw/ffp-stages";
import type { WgbManifest } from "../../src/worker/runtime/filesystem/wgb-loader";

const config = EmulatorConfig.getInstance();
afterEach(() => config.reset());

function readCaps(): Array<{ blend: number; textures: number }> {
    const view = new DataView(new ArrayBuffer(0x11000));
    const addr = 0x10000;
    const result: Array<{ blend: number; textures: number }> = [];
    for (const software of [false, true]) {
        view.setUint32(addr, 252, true);
        fillDeviceDesc(view, addr, software);
        result.push({ blend: view.getUint16(addr + 248, true), textures: view.getUint16(addr + 250, true) });
    }
    for (const guid of [D3D7_RGB_DEVICE_GUID_BYTES, D3D7_HAL_DEVICE_GUID_BYTES, D3D7_TNLHAL_DEVICE_GUID_BYTES]) {
        fillDeviceDesc7(view, addr, guid);
        result.push({ blend: view.getUint16(addr + 184, true), textures: view.getUint16(addr + 186, true) });
    }
    return result;
}

function overrideTextures(textures: number): void {
    config.applyFromManifest({ emulator: { d3dCaps: { wMaxSimultaneousTextures: textures } } } as WgbManifest);
}

describe("legacy Direct3D texture-stage capability contract", () => {
    test("all device descriptions distinguish arithmetic stages from texture samplers", () => {
        config.reset();
        for (const caps of readCaps()) {
            expect(caps.blend).toBe(MAX_FFP_STAGES);
            expect(caps.textures).toBe(MAX_FFP_SAMPLED_STAGES);
        }
    });

    test("a manifest cannot advertise texture samplers the renderer cannot bind", () => {
        config.reset();
        overrideTextures(8);
        for (const caps of readCaps()) {
            expect(caps.textures).toBe(MAX_FFP_SAMPLED_STAGES);
            expect(caps.blend).toBe(MAX_FFP_STAGES);
        }
        overrideTextures(2);
        for (const caps of readCaps()) expect(caps.textures).toBe(2);
        config.reset();
        for (const caps of readCaps()) expect(caps.textures).toBe(MAX_FFP_SAMPLED_STAGES);
    });
});
