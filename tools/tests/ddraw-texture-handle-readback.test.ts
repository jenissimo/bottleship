import { expect, test } from "bun:test";
import { DDraw } from "../../src/worker/modules/ddraw";
import { DirectDrawSurfaceObject } from "../../src/worker/modules/ddraw/com-objects";

test("texture-handle readback resolves the owner's pixels rather than treating the handle as a pixel pointer", async () => {
    const rgba = new Uint8Array([12, 34, 56, 255]);
    const state = { surfacePtr: 0x1000, width: 1, height: 1, rgbaScratch: rgba };
    const owner = Object.create(DirectDrawSurfaceObject.prototype);
    owner.getState = () => state;
    const dd = Object.create(DDraw.prototype);
    dd.context = {
        textureHandles: new Map([[0x1234, { handle: 0x1234 }]]),
        resourceProvider: {
            getAllComObjects: () => [owner],
            getComObject: (handle: number) => handle === 0x1234 ? owner : null,
            getComObjectByAddress: () => null,
        },
    };
    expect(await dd.readSurfaceRGBA(0x1234, "scratch")).toEqual({ w: 1, h: 1, rgba, source: "scratch" });
    expect(await dd.readSurfaceRGBA(0x1000, "scratch")).toEqual({ w: 1, h: 1, rgba, source: "scratch" });
    expect(await dd.readSurfaceRGBA(0x9999, "scratch")).toHaveProperty("err");
});
