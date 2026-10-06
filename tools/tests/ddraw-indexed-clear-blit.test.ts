import { expect, spyOn, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { ComObjectFactory } from "../../src/worker/core/com/base-com-object";
import { DirectDrawSurfaceObject } from "../../src/worker/modules/ddraw/com-objects";
import { createDirectDrawExports } from "../../src/worker/modules/ddraw/directdraw";
import { createSurfaceBltFlipExports } from "../../src/worker/modules/ddraw/surface-blt-flip";
import { createDefaultPixelFormat, writePixelFormat } from "../../src/worker/modules/ddraw/structs";
import {
    DDBLT_COLORFILL, DDBLTFAST_SRCCOLORKEY, DDBLTFX_OFFSETS,
    DDSCAPS_3DDEVICE, DDSCAPS_OFFSCREENPLAIN,
    DDSD_CAPS, DDSD_HEIGHT, DDSD_WIDTH, DDSD_PITCH, DDSD_PIXELFORMAT, DDSD_LPSURFACE,
} from "../../src/worker/modules/ddraw/constants";

test("an indexed 3D-capable surface clears old pixels before a keyed CPU blit", async () => {
    const mem = new Uint8Array(0x20000);
    Mem.bind(() => mem);
    const view = new DataView(mem.buffer);
    const objects = new Map<number, DirectDrawSurfaceObject>();
    let nextBlock = 0x18000;
    let nextHandle = 1;
    let clears = 0;
    const context: any = {
        display: { width: 8, height: 2, bpp: 8 },
        vtables: { IDirectDrawSurface7: { address: 0x3000 } },
        surfaces: {},
        process: { memory: { allocSystemBlock(size: number) {
            const ptr = nextBlock; nextBlock += size; return ptr;
        } } },
        resourceProvider: {
            mapAddressToHandle(addr: number, handle: number) { objects.set(addr, objects.get(handle)!); },
            registerSurfacePtr() {},
            getComObjectByAddress(addr: number) { return objects.get(addr); },
        },
        executor: { clear() { clears++; } },
    };
    const oldSystem = (globalThis as any).System;
    (globalThis as any).System = System;
    const systemSpy = spyOn(System, "getInstance").mockReturnValue({ scheduler: {} } as any);
    const factorySpy = spyOn(ComObjectFactory, "create").mockImplementation((_iid, _vt, state: any) => {
        const obj = Object.create(DirectDrawSurfaceObject.prototype);
        Object.defineProperties(obj, {
            handle: { value: nextHandle++ },
            getState: { value: () => state },
            setDDrawOwnerAddr: { value: () => {} },
        });
        objects.set(obj.handle, obj);
        return obj;
    });
    try {
        const dd = createDirectDrawExports(context);
        const blt = createSurfaceBltFlipExports(context);
        const create = (bpp: number, pixels: number): number => {
            mem.fill(0, 0x11000, 0x11080);
            for (const [off, value] of [
                [0, 124], [4, DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PITCH | DDSD_PIXELFORMAT | DDSD_LPSURFACE],
                [8, 2], [12, 8], [16, 32], [36, pixels], [104, DDSCAPS_3DDEVICE | DDSCAPS_OFFSCREENPLAIN],
            ]) view.setUint32(0x11000 + off!, value!, true);
            writePixelFormat(mem, 0x11048, createDefaultPixelFormat(bpp));
            expect(dd.IDirectDraw7_CreateSurface!({ esp: 0 } as any, mem, [0, 0x11000, 0x12000, 0])).toBe(0);
            return view.getUint32(0x12000, true);
        };
        const dst = create(8, 0x4000);
        const src = create(8, 0x6000);
        const dstState = objects.get(dst)!.getState();
        const srcState = objects.get(src)!.getState();
        // Keep a GPU texture present so the pre-fix code actually takes its GPU clear.
        dstState.gpuTexture = {} as GPUTexture;
        srcState.srcColorKey = { low: 0, high: 0 };
        mem.fill(7, 0x4000, 0x4040);
        mem[0x6001] = 11;
        mem[0x6026] = 12;
        view.setUint32(0x12080 + DDBLTFX_OFFSETS.fillColor, 0, true);
        expect(await blt.IDirectDrawSurface7_Blt!({} as any, mem, [dst, 0, 0, 0, DDBLT_COLORFILL, 0x12080])).toBe(0);
        expect(await blt.IDirectDrawSurface7_BltFast!({} as any, mem, [dst, 0, 0, src, 0, DDBLTFAST_SRCCOLORKEY])).toBe(0);
        for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) {
            expect(mem[0x4000 + y * 32 + x]).toBe(y === 0 && x === 1 ? 11 : y === 1 && x === 6 ? 12 : 0);
        }
        expect(clears).toBe(0);
        // True-color 3D targets still use GPU storage to preserve D3D-authored frames.
        for (const bpp of [16, 32]) {
            expect(objects.get(create(bpp, 0x8000))!.getState().mode).toBe("GPU_ONLY");
        }
    } finally {
        factorySpy.mockRestore();
        systemSpy.mockRestore();
        (globalThis as any).System = oldSystem;
    }
});
