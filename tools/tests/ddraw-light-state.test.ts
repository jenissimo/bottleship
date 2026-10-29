/**
 * IDirect3DDevice2/3::SetLightState — the DX5/DX6 way to pick a material and set ambient,
 * fog and colour-vertex state. A stub answering D3D_OK left a lit scene with the default
 * black material and no ambient term.
 */
import { describe, expect, test } from "bun:test";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";
import { Direct3DDevice3Object, Direct3DMaterial3Object } from "../../src/worker/modules/ddraw/com-objects";
import { D3DRENDERSTATE_AMBIENT, D3DRENDERSTATE_FOGSTART } from "../../src/worker/modules/ddraw/constants";
import { createDeviceExports } from "../../src/worker/modules/ddraw/d3d/device-impl";
import { createLightMaterialExports } from "../../src/worker/modules/ddraw/d3d/light-material-impl";

const DEVICE = 0x100, MATERIAL = 0x200, OUT = 0x300, MAT_DESC = 0x400;
const D3DLIGHTSTATE_MATERIAL = 1, D3DLIGHTSTATE_AMBIENT = 2, D3DLIGHTSTATE_COLORMODEL = 3, D3DLIGHTSTATE_FOGSTART = 5;
const DDERR_INVALIDPARAMS = 0x80070057;

function setup() {
    const rp = SystemResourceProvider.getInstance();
    const device = new Direct3DDevice3Object(0);
    const material = new Direct3DMaterial3Object(0);
    material.setMaterialHandle(material.handle);
    rp.mapAddressToHandle(DEVICE, device.handle);
    rp.mapAddressToHandle(MATERIAL, material.handle);
    const context = { resourceProvider: rp };
    const device3 = createDeviceExports(context as never, {} as never, {} as never);
    const materials = createLightMaterialExports(context as never);
    const mem = new Uint8Array(0x1000);
    return { device, material, device3, materials, mem, view: new DataView(mem.buffer) };
}

/** D3DMATERIAL: dwSize, then diffuse/ambient/specular/emissive D3DCOLORVALUEs, power, hTexture. */
function writeMaterial(view: DataView, diffuseR: number): void {
    view.setUint32(MAT_DESC, 76, true);
    view.setFloat32(MAT_DESC + 4, diffuseR, true);
}

describe("IDirect3DDevice3::SetLightState", () => {
    test("MATERIAL makes the material behind the handle the device's", () => {
        const { device, material, device3, materials, mem, view } = setup();
        writeMaterial(view, 0.5);
        expect(materials["IDirect3DMaterial3_SetMaterial"]!(null as never, mem, [MATERIAL, MAT_DESC])).toBe(0);
        expect(device3["IDirect3DDevice3_SetLightState"]!(null as never, mem, [DEVICE, D3DLIGHTSTATE_MATERIAL, material.handle])).toBe(0);
        expect(device.getMaterial().diffuse.r).toBeCloseTo(0.5);
        device3["IDirect3DDevice3_GetLightState"]!(null as never, mem, [DEVICE, D3DLIGHTSTATE_MATERIAL, OUT]);
        expect(view.getUint32(OUT, true)).toBe(material.handle);
    });

    test("a material in use stays live: changing it relights the device", () => {
        const { device, material, device3, materials, mem, view } = setup();
        device3["IDirect3DDevice3_SetLightState"]!(null as never, mem, [DEVICE, D3DLIGHTSTATE_MATERIAL, material.handle]);
        writeMaterial(view, 0.25);
        materials["IDirect3DMaterial3_SetMaterial"]!(null as never, mem, [MATERIAL, MAT_DESC]);
        expect(device.getMaterial().diffuse.r).toBeCloseTo(0.25);
    });

    test("AMBIENT and the fog values are render states under another name", () => {
        const { device, device3, mem, view } = setup();
        device3["IDirect3DDevice3_SetLightState"]!(null as never, mem, [DEVICE, D3DLIGHTSTATE_AMBIENT, 0xff404040]);
        expect(device.getRenderState(D3DRENDERSTATE_AMBIENT) >>> 0).toBe(0xff404040);
        const fogStart = new DataView(new ArrayBuffer(4));
        fogStart.setFloat32(0, 10, true);
        device3["IDirect3DDevice3_SetLightState"]!(null as never, mem, [DEVICE, D3DLIGHTSTATE_FOGSTART, fogStart.getUint32(0, true)]);
        expect(device.getRenderState(D3DRENDERSTATE_FOGSTART) >>> 0).toBe(fogStart.getUint32(0, true));
        device3["IDirect3DDevice3_GetLightState"]!(null as never, mem, [DEVICE, D3DLIGHTSTATE_AMBIENT, OUT]);
        expect(view.getUint32(OUT, true)).toBe(0xff404040);
    });

    test("COLORMODEL accepts RGB and mono, and an unknown state is invalid", () => {
        const { device3, mem, view } = setup();
        expect(device3["IDirect3DDevice3_SetLightState"]!(null as never, mem, [DEVICE, D3DLIGHTSTATE_COLORMODEL, 2])).toBe(0);
        device3["IDirect3DDevice3_GetLightState"]!(null as never, mem, [DEVICE, D3DLIGHTSTATE_COLORMODEL, OUT]);
        expect(view.getUint32(OUT, true)).toBe(2);
        expect(device3["IDirect3DDevice3_SetLightState"]!(null as never, mem, [DEVICE, D3DLIGHTSTATE_COLORMODEL, 7]) >>> 0).toBe(DDERR_INVALIDPARAMS);
        expect(device3["IDirect3DDevice3_SetLightState"]!(null as never, mem, [DEVICE, 99, 0]) >>> 0).toBe(DDERR_INVALIDPARAMS);
    });
});
