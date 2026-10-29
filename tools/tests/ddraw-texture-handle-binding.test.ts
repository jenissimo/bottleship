import { expect, test } from "bun:test";
import { createTextureManager } from "../../src/worker/modules/ddraw/d3d/texture-manager";

test("switching persistent texture handles preserves their surface ownership", () => {
    const handle = 0x10fc, address = 0x5fb04b70;
    let releases = 0, binding = 0;
    const surface = { release() { releases++; } };
    const context = {
        textureHandles: new Map([[handle, { handle, format: { bpp: 32, aMask: 0xff000000 } }]]),
        resourceProvider: {
            getComObjectByAddress: (ptr: number) => ptr === address ? surface : null,
            getComObject: (ptr: number) => ptr === handle ? surface : null,
            getAddressForHandle: (ptr: number) => ptr === handle ? address : null,
        },
    };
    const device = {
        handle: 123, getTexture: () => binding,
        setTexture: (_stage: number, value: number) => { binding = value; },
    };
    const manager = createTextureManager(context as any);
    for (let i = 0; i < 4; i++) {
        manager.setDeviceTexture(device as any, 0, handle);
        expect(binding).toBe(handle);
        manager.setDeviceTexture(device as any, 0, 0);
    }
    expect(releases).toBe(0);
    expect(binding).toBe(0);
});
