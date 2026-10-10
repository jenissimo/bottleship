import { expect, test } from "bun:test";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { TextureStore } from "../../src/worker/backends/webgpu/d3d9/d3d9-resources";

test("texture diagnostics read the selected authored mip and refuse an absent level", () => {
    const d: any = Object.create(D3D9Device.prototype);
    d.textures = new TextureStore();
    d.mipLevelData = new Map();
    d.textures.create(0x1000, 4, 4, 3, 21, -1);
    d.mipLevelData.set("4096:1", new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8,
        9, 10, 11, 12, 13, 14, 15, 16,
    ]));
    const mip = d.readTextureRgba(0x1000, 1);
    expect(mip.w).toBe(2);
    expect(mip.h).toBe(2);
    expect(Array.from(mip.rgba)).toEqual([3, 2, 1, 4, 7, 6, 5, 8, 11, 10, 9, 12, 15, 14, 13, 16]);
    expect(d.readTextureRgba(0x1000, 2)).toEqual({ err: "mip has no authored pixels" });
    expect(d.readTextureRgba(0x1000, 3).err).toContain("outside");
});
