import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createResourcesExports } from "../../src/worker/modules/d3d9/resources";
import {
    indexBufferMeta,
    surfaceMeta,
    textureMeta,
    vertexBufferMeta,
} from "../../src/worker/modules/d3d9/resource-registry";
import { devices, resourceToDevice } from "../../src/worker/modules/d3d9/shared-state";
import {
    getOpaqueUnknownReferenceCount,
    resetResourceContract,
} from "../../src/worker/modules/d3d9/resource-contract";
import { getComRefCount, releaseComRef, trackComObject } from "../../src/worker/modules/d3d9/com-refs";

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DERR_NOTFOUND = 0x88760866;
const D3DERR_MOREDATA = 0x88760867;
const D3DSPD_IUNKNOWN = 1;
const D3DRTYPE_SURFACE = 1;
const D3DRTYPE_TEXTURE = 3;
const D3DRTYPE_CUBETEXTURE = 5;
const D3DRTYPE_VERTEXBUFFER = 6;
const D3DRTYPE_INDEXBUFFER = 7;

const DEVICE = 0x100;
const VB = 0x200;
const IB = 0x300;
const TEX = 0x400;
const CUBE = 0x500;
const SURFACE = 0x600;
const GUID = 0x1000;
const DATA = 0x1100;
const OUT = 0x1200;
const SIZE = 0x1300;
const UNKNOWN = 0x1400;
const OTHER_GUID = 0x1500;

let mem: Uint8Array;
let view: DataView;
let resources: Record<string, any>;
const fakeDevice = { resetSubsystemPerf() {} } as any;

function call(name: string, ...args: number[]): number {
    return resources[name]!({ esp: 0 } as any, mem, args) as number;
}

beforeEach(() => {
    mem = new Uint8Array(0x10000);
    view = new DataView(mem.buffer);
    Mem.bind(() => mem, (address, size) => address >= 0 && address + size <= mem.length);
    resources = createResourcesExports();
    devices.clear();
    resourceToDevice.clear();
    vertexBufferMeta.clear();
    indexBufferMeta.clear();
    textureMeta.clear();
    surfaceMeta.clear();
    resetResourceContract();
    devices.set(DEVICE, fakeDevice);
    for (let i = 0; i < 16; i++) mem[GUID + i] = i + 1;
    for (let i = 0; i < 16; i++) mem[OTHER_GUID + i] = 0xa0 + i;
    mem.set([0x11, 0x22, 0x33, 0x44, 0x55], DATA);
    resourceToDevice.set(VB, fakeDevice);
    resourceToDevice.set(IB, fakeDevice);
    resourceToDevice.set(TEX, fakeDevice);
    resourceToDevice.set(CUBE, fakeDevice);
    resourceToDevice.set(SURFACE, fakeDevice);
    // Priority is observable only for MANAGED resources on the base D3D9
    // contract; use that pool for the positive round-trip cases below.
    vertexBufferMeta.set(VB, { size: 128, usage: 0, pool: 1 });
    indexBufferMeta.set(IB, { size: 128, usage: 0, pool: 1 });
    textureMeta.set(TEX, { width: 8, height: 8, levels: 1, usage: 0, pool: 1, format: 21 });
    textureMeta.set(CUBE, { width: 8, height: 8, levels: 1, usage: 0, pool: 1, format: 21, isCube: true });
    surfaceMeta.set(SURFACE, {
        format: 21, type: D3DRTYPE_SURFACE, usage: 0, pool: 1,
        multiSampleType: 0, multiSampleQuality: 0, width: 8, height: 8,
    });
});

afterEach(() => {
    resetResourceContract();
    resourceToDevice.clear();
    devices.clear();
});

describe("D3D9 IDirect3DResource9 inherited methods", () => {
    test("private data and priorities work for every concrete resource", () => {
        const cases: Array<[string, number, number]> = [
            ["IDirect3DVertexBuffer9", VB, D3DRTYPE_VERTEXBUFFER],
            ["IDirect3DIndexBuffer9", IB, D3DRTYPE_INDEXBUFFER],
            ["IDirect3DTexture9", TEX, D3DRTYPE_TEXTURE],
            ["IDirect3DCubeTexture9", CUBE, D3DRTYPE_CUBETEXTURE],
            ["IDirect3DSurface9", SURFACE, D3DRTYPE_SURFACE],
        ];
        for (const [prefix, ptr, type] of cases) {
            expect(call(`${prefix}_SetPrivateData`, ptr, GUID, DATA, 5, 0)).toBe(D3D_OK);
            view.setUint32(SIZE, 64, true);
            expect(call(`${prefix}_GetPrivateData`, ptr, GUID, OUT, SIZE)).toBe(D3D_OK);
            expect(view.getUint32(SIZE, true)).toBe(5);
            expect([...mem.subarray(OUT, OUT + 5)]).toEqual([0x11, 0x22, 0x33, 0x44, 0x55]);
            expect(call(`${prefix}_GetType`, ptr)).toBe(type);
            expect(call(`${prefix}_GetPriority`, ptr)).toBe(0);
            expect(call(`${prefix}_SetPriority`, ptr, 0x37)).toBe(0);
            expect(call(`${prefix}_GetPriority`, ptr)).toBe(0x37);
            expect(call(`${prefix}_PreLoad`, ptr)).toBe(D3D_OK);
            expect(call(`${prefix}_FreePrivateData`, ptr, GUID)).toBe(D3D_OK);
            expect(call(`${prefix}_FreePrivateData`, ptr, GUID)).toBe(D3DERR_NOTFOUND);
        }
    });

    test("GetPrivateData reports the required size without overwriting a short buffer", () => {
        expect(call("IDirect3DTexture9_SetPrivateData", TEX, GUID, DATA, 5, 0)).toBe(D3D_OK);
        view.setUint32(SIZE, 2, true);
        view.setUint32(OUT, 0xdeadbeef, true);
        expect(call("IDirect3DTexture9_GetPrivateData", TEX, GUID, OUT, SIZE)).toBe(D3DERR_MOREDATA);
        expect(view.getUint32(SIZE, true)).toBe(5);
        expect(view.getUint32(OUT, true)).toBe(0xdeadbeef);
    });

    test("GetPrivateData with NULL pData is a successful size query", () => {
        expect(call("IDirect3DTexture9_SetPrivateData", TEX, GUID, DATA, 5, 0)).toBe(D3D_OK);
        view.setUint32(SIZE, 0, true);
        expect(call("IDirect3DTexture9_GetPrivateData", TEX, GUID, 0, SIZE)).toBe(D3D_OK);
        expect(view.getUint32(SIZE, true)).toBe(5);
    });

    test("IUnknown private data takes and returns a COM reference", () => {
        trackComObject(UNKNOWN);
        expect(getComRefCount(UNKNOWN)).toBe(1);
        expect(call("IDirect3DTexture9_SetPrivateData", TEX, GUID, UNKNOWN, 4, D3DSPD_IUNKNOWN)).toBe(D3D_OK);
        expect(getComRefCount(UNKNOWN)).toBe(2);
        view.setUint32(SIZE, 4, true);
        expect(call("IDirect3DTexture9_GetPrivateData", TEX, GUID, OUT, SIZE)).toBe(D3D_OK);
        expect(view.getUint32(OUT, true)).toBe(UNKNOWN);
        expect(getComRefCount(UNKNOWN)).toBe(3);
        expect(call("IDirect3DTexture9_FreePrivateData", TEX, GUID)).toBe(D3D_OK);
        expect(getComRefCount(UNKNOWN)).toBe(2);
        releaseComRef(UNKNOWN);
        releaseComRef(UNKNOWN);
    });

    test("IUnknown private data retains an opaque guest interface", () => {
        expect(call("IDirect3DTexture9_SetPrivateData", TEX, GUID, 0xdead, 4, D3DSPD_IUNKNOWN))
            .toBe(D3D_OK);
        expect(getOpaqueUnknownReferenceCount(0xdead)).toBe(1);
        view.setUint32(SIZE, 4, true);
        expect(call("IDirect3DTexture9_GetPrivateData", TEX, GUID, OUT, SIZE)).toBe(D3D_OK);
        expect(view.getUint32(OUT, true)).toBe(0xdead);
        expect(getOpaqueUnknownReferenceCount(0xdead)).toBe(2);
        expect(call("IDirect3DTexture9_FreePrivateData", TEX, GUID)).toBe(D3D_OK);
        expect(getOpaqueUnknownReferenceCount(0xdead)).toBe(1);
    });

    test("resource teardown releases a retained IUnknown private-data reference", () => {
        trackComObject(UNKNOWN);
        expect(call("IDirect3DTexture9_SetPrivateData", TEX, GUID, UNKNOWN, 4, D3DSPD_IUNKNOWN)).toBe(D3D_OK);
        expect(getComRefCount(UNKNOWN)).toBe(2);
        resetResourceContract();
        expect(getComRefCount(UNKNOWN)).toBe(1);
        releaseComRef(UNKNOWN);
    });

    test("dead resource and malformed private-data arguments fail explicitly", () => {
        expect(call("IDirect3DTexture9_SetPriority", 0xdead, 1)).toBe(0);
        expect(call("IDirect3DTexture9_SetPrivateData", 0xdead, GUID, DATA, 5, 0)).toBe(D3DERR_INVALIDCALL);
        expect(call("IDirect3DTexture9_GetPrivateData", TEX, GUID, OUT, SIZE)).toBe(D3DERR_NOTFOUND);
        expect(call("IDirect3DTexture9_SetPrivateData", TEX, GUID, DATA, 4, 2)).toBe(D3DERR_INVALIDCALL);
    });

    test("DEFAULT priority is ignored while the old value is returned", () => {
        textureMeta.get(TEX)!.pool = 0;
        expect(call("IDirect3DTexture9_SetPriority", TEX, 0x37)).toBe(0);
        expect(call("IDirect3DTexture9_GetPriority", TEX)).toBe(0);
    });

    test("Surface GetContainer returns the texture/device and rejects unrelated IIDs", () => {
        const textureIid = 0x1600;
        // IID_IDirect3DTexture9 in Windows GUID byte order.
        mem.set([0x27, 0x12, 0xc3, 0x85, 0xe5, 0x3d, 0x00, 0x4f,
            0x9b, 0x3a, 0xf1, 0x1a, 0xc3, 0x8c, 0x18, 0xb5], textureIid);
        surfaceMeta.set(SURFACE, {
            format: 21, type: D3DRTYPE_SURFACE, usage: 0, pool: 0,
            multiSampleType: 0, multiSampleQuality: 0, width: 8, height: 8,
            texturePtr: TEX, level: 0,
        });
        expect(call("IDirect3DSurface9_GetContainer", SURFACE, textureIid, OUT)).toBe(D3D_OK);
        expect(view.getUint32(OUT, true)).toBe(TEX);
        expect(call("IDirect3DSurface9_GetContainer", SURFACE, OTHER_GUID, OUT)).toBe(0x80004002);

        // A known IID for a different container is still unrelated to this
        // surface's parent and must not receive the texture pointer.
        const deviceIid = 0x1700;
        mem.set([0x96, 0x3b, 0x22, 0xd0, 0x7a, 0xbf, 0xfd, 0x43,
            0x92, 0xbd, 0xa4, 0x3b, 0x0d, 0x82, 0xb9, 0xeb], deviceIid);
        expect(call("IDirect3DSurface9_GetContainer", SURFACE, deviceIid, OUT)).toBe(0x80004002);

        const deviceExIid = 0x1800;
        mem.set([0xce, 0x10, 0x8b, 0xb1, 0x49, 0x26, 0x5a, 0x40,
            0x87, 0x0f, 0x95, 0xf7, 0x77, 0xd4, 0x31, 0x3a], deviceExIid);
        // The surface is texture-owned, so even a valid Ex-device IID is
        // unrelated to this container and must be rejected.
        expect(call("IDirect3DSurface9_GetContainer", SURFACE, deviceExIid, OUT)).toBe(0x80004002);

        // A device-created render target may use a hidden texture internally,
        // but that texture is not its D3D9 container.
        surfaceMeta.get(SURFACE)!.standalone = true;
        view.setUint32(OUT, 0xffffffff, true);
        expect(call("IDirect3DSurface9_GetContainer", SURFACE, textureIid, OUT)).toBe(0x80004002);
        expect(view.getUint32(OUT, true)).toBe(0);
        view.setUint32(OUT, 0xffffffff, true);
        expect(call("IDirect3DSurface9_GetContainer", SURFACE, deviceIid, OUT)).toBe(D3D_OK);
        expect(view.getUint32(OUT, true)).toBe(DEVICE);

        // REFIID is mandatory; a null pointer must not be treated as IUnknown.
        view.setUint32(OUT, 0xffffffff, true);
        expect(call("IDirect3DSurface9_GetContainer", SURFACE, 0, OUT)).toBe(D3DERR_INVALIDCALL);
        expect(view.getUint32(OUT, true)).toBe(0);
    });
});
