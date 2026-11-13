/**
 * EnumSurfaces hands the callback a reference it owns: every enumerated surface is
 * AddRef'd first, and only root surfaces are enumerated. A guest that keeps the pointer
 * and Releases it later (a movie player giving its frame target back) otherwise frees a
 * primary it never held, and every Lock after that fails.
 */
import { expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { DirectDrawSurfaceObject } from "../../src/worker/modules/ddraw/com-objects";
import { createDirectDrawExports } from "../../src/worker/modules/ddraw/directdraw";

const DDENUMSURFACES_ALL = 0x1;
const DDENUMSURFACES_DOESEXIST = 0x10;
const RGB565 = { flags: 0x40, bpp: 16, rMask: 0xf800, gMask: 0x07e0, bMask: 0x001f, aMask: 0 };

test("EnumSurfaces AddRefs each surface it passes to the callback and skips implicit chain members", () => {
    const mem = new Uint8Array(0x20000);
    Mem.bind(() => mem);

    const addRefs = new Map<number, number>();
    const surface = (handle: number, caps: number, implicitChainMember: boolean) => {
        const obj = Object.create(DirectDrawSurfaceObject.prototype);
        const state = { width: 640, height: 480, pitch: 1280, caps, caps2: 0, surfacePtr: 0x4000, format: RGB565, implicitChainMember };
        Object.defineProperties(obj, {
            handle: { value: handle },
            getState: { value: () => state },
            addRef: { value: () => { addRefs.set(handle, (addRefs.get(handle) ?? 0) + 1); return 2; } },
        });
        return obj;
    };
    const PRIMARY = 0x9000, BACK = 0x9100, ZBUF = 0x9200;
    const objects = new Map<number, any>([
        [PRIMARY, surface(PRIMARY, 0x6218, false)],
        [BACK, surface(BACK, 0x6014, true)],
        [ZBUF, surface(ZBUF, 0x24000, false)],
    ]);

    const invoked: number[] = [];
    const pending: Array<{ enumerationState?: { continueEnumeration: () => void } }> = [];
    let nextBlock = 0x18000;
    const context: any = {
        display: { width: 640, height: 480, bpp: 16 },
        vtables: {},
        surfaces: {},
        resourceProvider: {
            getAllComObjects: () => [...objects.values()],
            getAddressForHandle: (handle: number) => handle,
            getComObjectByAddress: (addr: number) => objects.get(addr) ?? null,
        },
        process: {
            memory: { alloc(size: number) { const p = nextBlock; nextBlock += size; return p; }, free() {} },
            dispatcher: { callbackManager: {
                saveSuspendedThunkContext: () => 1,
                invokeCallback(_cb: number, args: number[]) {
                    invoked.push(args[0]!);
                    pending.push({});
                    return { callbackId: pending.length };
                },
                getPendingCallback: (id: number) => pending[id - 1],
            } },
        },
    };

    const dd = createDirectDrawExports(context);
    const flags = DDENUMSURFACES_ALL | DDENUMSURFACES_DOESEXIST;
    const result: any = dd.IDirectDraw7_EnumSurfaces!({ esp: 0x1000 } as any, mem, [0, flags, 0, 0, 0x401000]);
    expect(result.suspendedForCallback).toBe(true);

    // The reference exists before the callback runs.
    expect(invoked).toEqual([PRIMARY]);
    expect(addRefs.get(PRIMARY)).toBe(1);
    expect(addRefs.get(ZBUF)).toBeUndefined();

    pending[0]!.enumerationState!.continueEnumeration();
    expect(invoked).toEqual([PRIMARY, ZBUF]);
    expect(addRefs.get(ZBUF)).toBe(1);
    expect(addRefs.get(BACK)).toBeUndefined();
});
