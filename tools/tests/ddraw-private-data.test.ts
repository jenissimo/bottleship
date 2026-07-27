/**
 * IDirectDrawSurface7 Set/Get/FreePrivateData contract.
 *
 * The store is opaque to us but load-bearing for D3D7 wrappers that hang their
 * own bookkeeping (source image extent, mip level, wrapper object) off a surface
 * and read it back on the texture-upload path — a stub that returns DD_OK without
 * filling the caller's buffer makes them upload a 0x0 image and every texture
 * renders blank. Cases mirror the ddraw7 conformance behaviour.
 */

import { describe, expect, test } from "bun:test";
import { createSurfacePrivateDataExports } from "../../src/worker/modules/ddraw/surface-private-data";

const DD_OK = 0;
const DDERR_INVALIDPARAMS = 0x80070057;
const DDERR_INVALIDOBJECT = 0x88760082;
const DDERR_NOTFOUND = 0x887600ff;
const DDERR_MOREDATA = 0x887602b2;
const DDSPD_IUNKNOWNPOINTER = 0x00000001;

const GUID_A = 0x1000;   // 16 raw bytes live here
const GUID_B = 0x1010;
const DATA = 0x2000;
const OUT_BUF = 0x3000;
const OUT_SIZE = 0x3100;

/** A surface COM object stub plus a ref-counted "IUnknown" the app can stash. */
function makeHarness() {
    const mem = new Uint8Array(0x10000);
    for (let i = 0; i < 16; i++) { mem[GUID_A + i] = i + 1; mem[GUID_B + i] = 0x80 + i; }

    const surfaceState: any = { caps: 0 };
    const surface = { getState: () => surfaceState };
    const unknown = { refs: 1, addRef() { return ++this.refs; }, release() { return --this.refs; } };
    const SURFACE_PTR = 0x40000;
    const UNKNOWN_PTR = 0x50000;

    const context: any = {
        resourceProvider: {
            getComObjectByAddress: (addr: number) =>
                addr === SURFACE_PTR ? surface : addr === UNKNOWN_PTR ? unknown : null,
        },
    };
    const api = createSurfacePrivateDataExports(context);
    const call = (name: string, ...args: number[]) =>
        api[`IDirectDrawSurface7_${name}`]!({ esp: 0 } as any, mem, args as any) as number;

    const view = new DataView(mem.buffer);
    return { mem, view, call, surfaceState, unknown, SURFACE_PTR, UNKNOWN_PTR };
}

describe("IDirectDrawSurface7 private data", () => {
    test("blob round-trips byte-exactly and reports its size", () => {
        const h = makeHarness();
        const payload = [0x11, 0x22, 0x33, 0x44, 0x55];
        h.mem.set(payload, DATA);

        expect(h.call("SetPrivateData", h.SURFACE_PTR, GUID_A, DATA, payload.length, 0)).toBe(DD_OK);

        h.view.setUint32(OUT_SIZE, 64, true);
        expect(h.call("GetPrivateData", h.SURFACE_PTR, GUID_A, OUT_BUF, OUT_SIZE)).toBe(DD_OK);
        expect(h.view.getUint32(OUT_SIZE, true)).toBe(payload.length);
        expect([...h.mem.subarray(OUT_BUF, OUT_BUF + payload.length)]).toEqual(payload);
    });

    test("a stored blob is not visible under a different tag", () => {
        const h = makeHarness();
        h.mem.set([1, 2, 3, 4], DATA);
        h.call("SetPrivateData", h.SURFACE_PTR, GUID_A, DATA, 4, 0);
        h.view.setUint32(OUT_SIZE, 64, true);
        expect(h.call("GetPrivateData", h.SURFACE_PTR, GUID_B, OUT_BUF, OUT_SIZE)).toBe(DDERR_NOTFOUND);
    });

    test("absent tag is DDERR_NOTFOUND and touches neither buffer nor size", () => {
        const h = makeHarness();
        h.view.setUint32(OUT_SIZE, 0xdeadbabe, true);
        h.view.setUint32(OUT_BUF, 0xdeadbeef, true);
        expect(h.call("GetPrivateData", h.SURFACE_PTR, GUID_A, OUT_BUF, OUT_SIZE)).toBe(DDERR_NOTFOUND);
        expect(h.view.getUint32(OUT_SIZE, true)).toBe(0xdeadbabe);
        expect(h.view.getUint32(OUT_BUF, true)).toBe(0xdeadbeef);
    });

    test("too-small buffer yields DDERR_MOREDATA with the required size", () => {
        const h = makeHarness();
        h.mem.set([9, 9, 9, 9, 9, 9, 9, 9], DATA);
        h.call("SetPrivateData", h.SURFACE_PTR, GUID_A, DATA, 8, 0);

        h.view.setUint32(OUT_SIZE, 1, true);
        h.view.setUint32(OUT_BUF, 0xdeadbeef, true);
        expect(h.call("GetPrivateData", h.SURFACE_PTR, GUID_A, OUT_BUF, OUT_SIZE)).toBe(DDERR_MOREDATA);
        expect(h.view.getUint32(OUT_SIZE, true)).toBe(8);
        expect(h.view.getUint32(OUT_BUF, true)).toBe(0xdeadbeef);
    });

    test("NULL size pointer, or NULL buffer with room, is DDERR_INVALIDPARAMS", () => {
        const h = makeHarness();
        h.mem.set([1, 2, 3, 4], DATA);
        h.call("SetPrivateData", h.SURFACE_PTR, GUID_A, DATA, 4, 0);

        expect(h.call("GetPrivateData", h.SURFACE_PTR, GUID_A, OUT_BUF, 0)).toBe(DDERR_INVALIDPARAMS);
        h.view.setUint32(OUT_SIZE, 64, true);
        expect(h.call("GetPrivateData", h.SURFACE_PTR, GUID_A, 0, OUT_SIZE)).toBe(DDERR_INVALIDPARAMS);
        expect(h.view.getUint32(OUT_SIZE, true)).toBe(64);
    });

    test("NULL data is rejected by SetPrivateData", () => {
        const h = makeHarness();
        expect(h.call("SetPrivateData", h.SURFACE_PTR, GUID_A, 0, 4, 0)).toBe(DDERR_INVALIDPARAMS);
        expect(h.call("SetPrivateData", h.SURFACE_PTR, GUID_A, 0, 4, DDSPD_IUNKNOWNPOINTER)).toBe(DDERR_INVALIDPARAMS);
    });

    test("DDSPD_IUNKNOWNPOINTER needs sizeof(IUnknown*), refs the object, and the getter does not", () => {
        const h = makeHarness();
        expect(h.call("SetPrivateData", h.SURFACE_PTR, GUID_A, h.UNKNOWN_PTR, 5, DDSPD_IUNKNOWNPOINTER)).toBe(DDERR_INVALIDPARAMS);
        expect(h.unknown.refs).toBe(1);

        expect(h.call("SetPrivateData", h.SURFACE_PTR, GUID_A, h.UNKNOWN_PTR, 4, DDSPD_IUNKNOWNPOINTER)).toBe(DD_OK);
        expect(h.unknown.refs).toBe(2);

        h.view.setUint32(OUT_SIZE, 4, true);
        expect(h.call("GetPrivateData", h.SURFACE_PTR, GUID_A, OUT_BUF, OUT_SIZE)).toBe(DD_OK);
        expect(h.view.getUint32(OUT_BUF, true)).toBe(h.UNKNOWN_PTR);
        expect(h.unknown.refs).toBe(2);

        expect(h.call("FreePrivateData", h.SURFACE_PTR, GUID_A)).toBe(DD_OK);
        expect(h.unknown.refs).toBe(1);
    });

    test("overwriting a tag releases the previous IUnknown", () => {
        const h = makeHarness();
        h.call("SetPrivateData", h.SURFACE_PTR, GUID_A, h.UNKNOWN_PTR, 4, DDSPD_IUNKNOWNPOINTER);
        expect(h.unknown.refs).toBe(2);
        h.mem.set([7, 7], DATA);
        expect(h.call("SetPrivateData", h.SURFACE_PTR, GUID_A, DATA, 2, 0)).toBe(DD_OK);
        expect(h.unknown.refs).toBe(1);
    });

    test("FreePrivateData on an unknown tag is DDERR_NOTFOUND and the entry is gone after a free", () => {
        const h = makeHarness();
        expect(h.call("FreePrivateData", h.SURFACE_PTR, GUID_A)).toBe(DDERR_NOTFOUND);
        h.mem.set([1], DATA);
        h.call("SetPrivateData", h.SURFACE_PTR, GUID_A, DATA, 1, 0);
        expect(h.call("FreePrivateData", h.SURFACE_PTR, GUID_A)).toBe(DD_OK);
        h.view.setUint32(OUT_SIZE, 64, true);
        expect(h.call("GetPrivateData", h.SURFACE_PTR, GUID_A, OUT_BUF, OUT_SIZE)).toBe(DDERR_NOTFOUND);
    });

    test("an unknown surface pointer is DDERR_INVALIDOBJECT", () => {
        const h = makeHarness();
        expect(h.call("SetPrivateData", 0x999, GUID_A, DATA, 4, 0)).toBe(DDERR_INVALIDOBJECT);
        expect(h.call("GetPrivateData", 0x999, GUID_A, OUT_BUF, OUT_SIZE)).toBe(DDERR_INVALIDOBJECT);
        expect(h.call("FreePrivateData", 0x999, GUID_A)).toBe(DDERR_INVALIDOBJECT);
    });
});
