/**
 * DX5-DX7 HAL drivers all required power-of-two textures and said so in
 * dpcTriCaps.dwTextureCaps. Titles size their textures from that bit: one that sees it
 * clear sizes a text texture exactly, then rejects its own non-power-of-two image.
 */
import { afterEach, expect, test } from "bun:test";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import {
    fillDeviceDesc,
    fillDeviceDesc7,
    D3D7_HAL_DEVICE_GUID_BYTES,
    D3D7_RGB_DEVICE_GUID_BYTES,
    D3D7_TNLHAL_DEVICE_GUID_BYTES,
} from "../../src/worker/modules/ddraw/d3d/d3d-caps-utils";

const D3DPTEXTURECAPS_POW2 = 0x2;
const ADDR = 0x10000;
// D3DDEVICEDESC: dpcTriCaps at 100; D3DDEVICEDESC7: dpcTriCaps at 60. dwTextureCaps is +32.
const TRI_TEXTURE_CAPS = 100 + 32;
const TRI_TEXTURE_CAPS7 = 60 + 32;

afterEach(() => EmulatorConfig.getInstance().reset());

test("every device description requires power-of-two textures", () => {
    const view = new DataView(new ArrayBuffer(0x11000));
    for (const software of [false, true]) {
        view.setUint32(ADDR, 252, true);
        fillDeviceDesc(view, ADDR, software);
        expect(view.getUint32(ADDR + TRI_TEXTURE_CAPS, true) & D3DPTEXTURECAPS_POW2).toBe(D3DPTEXTURECAPS_POW2);
    }
    for (const guid of [D3D7_RGB_DEVICE_GUID_BYTES, D3D7_HAL_DEVICE_GUID_BYTES, D3D7_TNLHAL_DEVICE_GUID_BYTES]) {
        fillDeviceDesc7(view, ADDR, guid);
        expect(view.getUint32(ADDR + TRI_TEXTURE_CAPS7, true) & D3DPTEXTURECAPS_POW2).toBe(D3DPTEXTURECAPS_POW2);
    }
});
