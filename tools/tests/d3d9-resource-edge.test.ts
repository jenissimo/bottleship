import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { createResourcesExports } from "../../src/worker/modules/d3d9/resources";
import { createVolumeExports } from "../../src/worker/modules/d3d9/volume";
import { devices, resourceToDevice } from "../../src/worker/modules/d3d9/shared-state";
import { surfaceMeta, textureMeta } from "../../src/worker/modules/d3d9/resource-registry";
import {
    createVolumeTextureResource,
    volumeLevelObjects,
    volumeLevelParents,
    volumeTextureResources,
} from "../../src/worker/modules/d3d9/volume-resources";
import {
    isValidBufferUsagePool,
    isValidTextureUsagePool,
} from "../../src/worker/modules/d3d9/resource-contract";

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const DEVICE = 0x710;
const TEXTURE = 0x720;
const SURFACE = 0x721;
const CUBE = 0x730;
const VERTEX_BUFFER = 0x740;
const INDEX_BUFFER = 0x741;
const LOCKED = 0x1000;
const BOX = 0x1020;
const OUT = 0x1040;

let memory: Uint8Array;
let resources: Record<string, any>;
let volume: Record<string, any>;
let cubeUnlocks: number;
let dirtyVolumeMarks: number;

const fakeDevice = {
    textureReadbackForLock: () => null,
    isRenderTargetTexture: () => false,
    lockTexture: () => ({ ptr: 0x2000, pitch: 16 }),
    unlockTexture: () => 0,
    lockCubeFace: () => ({ ptr: 0x3000, pitch: 16 }),
    unlockCubeFace: () => {
        cubeUnlocks++;
        return true;
    },
    lockVertexBuffer: () => 0x4000,
    unlockVertexBuffer: () => 0,
    lockIndexBuffer: () => 0x4100,
    unlockIndexBuffer: () => 0,
    markVolumeTextureDirty: () => {
        dirtyVolumeMarks++;
    },
    supportsD3D9MultisampleType: (type: number) => type === 0,
} as any;

function call(table: Record<string, any>, name: string, ...args: number[]): number {
    return table[name]!({ esp: 0 }, memory, args) as number;
}

function volumeAllocator() {
    let next = 0x5000;
    return {
        alloc: (size: number) => {
            const ptr = next;
            next += size;
            return ptr;
        },
        free: () => undefined,
    };
}

beforeEach(() => {
    memory = new Uint8Array(0x20000);
    Mem.bind(() => memory, (address, size) => address >= 0 && address + size <= memory.length);
    resources = createResourcesExports();
    volume = createVolumeExports();
    devices.clear();
    resourceToDevice.clear();
    textureMeta.clear();
    surfaceMeta.clear();
    volumeTextureResources.clear();
    volumeLevelObjects.clear();
    volumeLevelParents.clear();
    devices.set(DEVICE, fakeDevice);
    cubeUnlocks = 0;
    dirtyVolumeMarks = 0;
});

describe("D3D9 resource lock edge contracts", () => {
    test("uses the native pool/usage matrix for textures and buffers", () => {
        expect(isValidTextureUsagePool(0x400, 1)).toBe(true); // MANAGED + AUTOGENMIPMAP
        expect(isValidTextureUsagePool(0x200, 2)).toBe(true); // SYSTEMMEM + DYNAMIC
        expect(isValidTextureUsagePool(0x200, 1)).toBe(false); // MANAGED + DYNAMIC
        expect(isValidTextureUsagePool(0x400, 2)).toBe(false); // SYSTEMMEM + AUTOGENMIPMAP
        expect(isValidTextureUsagePool(0x8, 0)).toBe(false); // WRITEONLY is buffer-only
        expect(isValidTextureUsagePool(0x203, 0)).toBe(false); // RT|DS + DYNAMIC
        expect(isValidBufferUsagePool(0x200, 2)).toBe(true); // SYSTEMMEM + DYNAMIC
        expect(isValidBufferUsagePool(0x200, 1)).toBe(false); // MANAGED + DYNAMIC
    });

    test("Surface9 and Texture9 cannot hold two locks on the same subresource", () => {
        textureMeta.set(TEXTURE, { width: 4, height: 4, levels: 1, usage: 0, pool: 2, format: 21 });
        surfaceMeta.set(SURFACE, {
            width: 4, height: 4, format: 21, usage: 0, pool: 2,
            multiSampleType: 0, multiSampleQuality: 0, texturePtr: TEXTURE, level: 0,
        });
        resourceToDevice.set(TEXTURE, fakeDevice);
        resourceToDevice.set(SURFACE, fakeDevice);

        expect(call(resources, "IDirect3DSurface9_LockRect", SURFACE, LOCKED, 0, 0)).toBe(D3D_OK);
        // A parent texture and its level surface alias the same lock state.
        expect(call(resources, "IDirect3DTexture9_LockRect", TEXTURE, 0, LOCKED, 0, 0))
            .toBe(D3DERR_INVALIDCALL);
        expect(call(resources, "IDirect3DSurface9_LockRect", SURFACE, LOCKED, 0, 0))
            .toBe(D3DERR_INVALIDCALL);
        expect(call(resources, "IDirect3DTexture9_UnlockRect", TEXTURE, 0)).toBe(D3D_OK);
        expect(call(resources, "IDirect3DSurface9_UnlockRect", SURFACE)).toBe(D3DERR_INVALIDCALL);
        expect(call(resources, "IDirect3DSurface9_UnlockRect", SURFACE)).toBe(D3DERR_INVALIDCALL);
    });

    test("Surface9 guards unknown descriptions, non-lockable targets, and GetDC", () => {
        expect(call(resources, "IDirect3DSurface9_GetDesc", 0xdead, OUT)).toBe(D3DERR_INVALIDCALL);
        expect(call(resources, "IDirect3DSurface9_GetDesc", SURFACE, 0)).toBe(D3DERR_INVALIDCALL);
        textureMeta.set(TEXTURE, { width: 4, height: 4, levels: 1, usage: 1, pool: 0, format: 21 });
        surfaceMeta.set(SURFACE, {
            width: 4, height: 4, format: 21, usage: 1, pool: 0,
            multiSampleType: 0, multiSampleQuality: 0, texturePtr: TEXTURE, level: 0,
            lockable: false,
        });
        resourceToDevice.set(TEXTURE, fakeDevice);
        resourceToDevice.set(SURFACE, fakeDevice);
        expect(call(resources, "IDirect3DSurface9_LockRect", SURFACE, LOCKED, 0, 0))
            .toBe(D3DERR_INVALIDCALL);
        expect(call(resources, "IDirect3DSurface9_GetDC", SURFACE, OUT)).toBe(D3DERR_INVALIDCALL);
    });

    test("CubeTexture9 rejects a nested face lock and an unlock without a lock", () => {
        textureMeta.set(CUBE, { width: 4, height: 4, levels: 1, usage: 0, pool: 2, format: 21, isCube: true });
        resourceToDevice.set(CUBE, fakeDevice);

        expect(call(resources, "IDirect3DCubeTexture9_UnlockRect", CUBE, 0, 0)).toBe(D3DERR_INVALIDCALL);
        expect(call(resources, "IDirect3DCubeTexture9_LockRect", CUBE, 0, 0, LOCKED, 0, 0x10)).toBe(D3D_OK);
        expect(call(resources, "IDirect3DCubeTexture9_LockRect", CUBE, 0, 0, LOCKED, 0, 0x10))
            .toBe(D3DERR_INVALIDCALL);
        expect(call(resources, "IDirect3DCubeTexture9_UnlockRect", CUBE, 0, 0)).toBe(D3D_OK);
        expect(cubeUnlocks).toBe(1);
        expect(call(resources, "IDirect3DCubeTexture9_UnlockRect", CUBE, 0, 0)).toBe(D3DERR_INVALIDCALL);
    });

    test("a cube face surface shares the face-aware lock with CubeTexture9", () => {
        textureMeta.set(CUBE, { width: 4, height: 4, levels: 1, usage: 0, pool: 2, format: 21, isCube: true });
        surfaceMeta.set(SURFACE, {
            width: 4, height: 4, format: 21, usage: 0, pool: 2,
            multiSampleType: 0, multiSampleQuality: 0, texturePtr: CUBE, level: 0, face: 2,
        });
        resourceToDevice.set(CUBE, fakeDevice);
        resourceToDevice.set(SURFACE, fakeDevice);

        expect(call(resources, "IDirect3DSurface9_LockRect", SURFACE, LOCKED, 0, 0)).toBe(D3D_OK);
        expect(call(resources, "IDirect3DCubeTexture9_LockRect", CUBE, 2, 0, LOCKED, 0, 0))
            .toBe(D3DERR_INVALIDCALL);
        expect(call(resources, "IDirect3DSurface9_UnlockRect", SURFACE)).toBe(D3D_OK);
        expect(call(resources, "IDirect3DCubeTexture9_UnlockRect", CUBE, 2, 0)).toBe(D3DERR_INVALIDCALL);
    });

    test("dynamic vertex and index buffers reject non-DEFAULT pools before allocation", () => {
        const out = new DataView(memory.buffer);
        out.setUint32(OUT, 0xffffffff, true);
        expect(call(resources, "IDirect3DDevice9_CreateVertexBuffer", DEVICE, 64, 0x200, 0, 1, OUT))
            .toBe(D3DERR_INVALIDCALL);
        expect(out.getUint32(OUT, true)).toBe(0);
        expect(call(resources, "IDirect3DDevice9_CreateVertexBuffer", DEVICE, 64, 0, 0, 3, OUT))
            .toBe(D3DERR_INVALIDCALL);
        expect(out.getUint32(OUT, true)).toBe(0);
        out.setUint32(OUT, 0xffffffff, true);
        expect(call(resources, "IDirect3DDevice9_CreateIndexBuffer", DEVICE, 64, 0x200, 101, 1, OUT))
            .toBe(D3DERR_INVALIDCALL);
        expect(out.getUint32(OUT, true)).toBe(0);
        expect(call(resources, "IDirect3DDevice9_CreateIndexBuffer", DEVICE, 64, 0, 101, 3, OUT))
            .toBe(D3DERR_INVALIDCALL);
        expect(out.getUint32(OUT, true)).toBe(0);
    });

    test("texture and volume usages reject incompatible pools before adapter probing", () => {
        const out = new DataView(memory.buffer);
        out.setUint32(OUT, 0xffffffff, true);
        expect(call(resources, "IDirect3DDevice9_CreateTexture", DEVICE, 4, 4, 1, 0x200, 21, 1, OUT))
            .toBe(D3DERR_INVALIDCALL);
        expect(out.getUint32(OUT, true)).toBe(0);
        out.setUint32(OUT, 0xffffffff, true);
        expect(call(resources, "IDirect3DDevice9_CreateCubeTexture", DEVICE, 4, 1, 0x200, 21, 1, OUT))
            .toBe(D3DERR_INVALIDCALL);
        expect(out.getUint32(OUT, true)).toBe(0);
        out.setUint32(OUT, 0xffffffff, true);
        expect(call(volume, "IDirect3DDevice9_CreateVolumeTexture", DEVICE, 4, 4, 2, 1, 0x200, 21, 1, OUT))
            .toBe(D3DERR_INVALIDCALL);
        expect(out.getUint32(OUT, true)).toBe(0);
    });

    test("surface creation reports INVALIDCALL for a stale device pointer", () => {
        devices.clear();
        const out = new DataView(memory.buffer);
        out.setUint32(OUT, 0xffffffff, true);
        expect(call(resources, "IDirect3DDevice9_CreateDepthStencilSurface",
            DEVICE, 4, 4, 75, 0, 0, 0, OUT, 0)).toBe(D3DERR_INVALIDCALL);
        expect(out.getUint32(OUT, true)).toBe(0);
        out.setUint32(OUT, 0xffffffff, true);
        expect(call(resources, "IDirect3DDevice9_CreateRenderTarget",
            DEVICE, 4, 4, 21, 0, 0, 0, OUT, 0)).toBe(D3DERR_INVALIDCALL);
        expect(out.getUint32(OUT, true)).toBe(0);
    });

    test("depth-surface creation refuses color formats and nonzero quality", () => {
        const out = new DataView(memory.buffer);
        out.setUint32(OUT, 0xffffffff, true);
        // A8R8G8B8 is a color format, never a depth-stencil attachment.
        expect(call(resources, "IDirect3DDevice9_CreateDepthStencilSurface",
            DEVICE, 4, 4, 21, 0, 0, 0, OUT, 0)).toBe(0x8876086a);
        expect(out.getUint32(OUT, true)).toBe(0);

        out.setUint32(OUT, 0xffffffff, true);
        // The capability profile exposes one quality level, so quality index 1
        // must be refused even for a valid D24S8 surface.
        expect(call(resources, "IDirect3DDevice9_CreateDepthStencilSurface",
            DEVICE, 4, 4, 75, 0, 1, 0, OUT, 0)).toBe(0x8876086a);
        expect(out.getUint32(OUT, true)).toBe(0);
    });

    test("vertex and index Unlock reject no-lock and nested-lock calls", () => {
        resourceToDevice.set(VERTEX_BUFFER, fakeDevice);
        resourceToDevice.set(INDEX_BUFFER, fakeDevice);

        expect(call(resources, "IDirect3DVertexBuffer9_Unlock", VERTEX_BUFFER)).toBe(D3DERR_INVALIDCALL);
        expect(call(resources, "IDirect3DVertexBuffer9_Lock", VERTEX_BUFFER, 0, 16, OUT, 0)).toBe(D3D_OK);
        expect(call(resources, "IDirect3DVertexBuffer9_Lock", VERTEX_BUFFER, 0, 16, OUT, 0))
            .toBe(D3DERR_INVALIDCALL);
        expect(call(resources, "IDirect3DVertexBuffer9_Unlock", VERTEX_BUFFER)).toBe(D3D_OK);
        expect(call(resources, "IDirect3DVertexBuffer9_Unlock", VERTEX_BUFFER)).toBe(D3DERR_INVALIDCALL);
        expect(call(resources, "IDirect3DVertexBuffer9_Lock", VERTEX_BUFFER, 0, 16, 0, 0))
            .toBe(D3DERR_INVALIDCALL);

        expect(call(resources, "IDirect3DIndexBuffer9_Unlock", INDEX_BUFFER)).toBe(D3DERR_INVALIDCALL);
        expect(call(resources, "IDirect3DIndexBuffer9_Lock", INDEX_BUFFER, 0, 16, OUT, 0)).toBe(D3D_OK);
        expect(call(resources, "IDirect3DIndexBuffer9_Lock", INDEX_BUFFER, 0, 16, OUT, 0))
            .toBe(D3DERR_INVALIDCALL);
        expect(call(resources, "IDirect3DIndexBuffer9_Unlock", INDEX_BUFFER)).toBe(D3D_OK);
        expect(call(resources, "IDirect3DIndexBuffer9_Unlock", INDEX_BUFFER)).toBe(D3DERR_INVALIDCALL);
    });

    test("volume DISCARD clears a full DEFAULT mip but is stripped for a sub-box", () => {
        const allocator = volumeAllocator();
        const resource = createVolumeTextureResource(2, 2, 1, 1, 0x200, 0, 21, allocator);
        expect(resource).not.toBeNull();
        volumeTextureResources.set(TEXTURE, resource!);
        resourceToDevice.set(TEXTURE, fakeDevice);
        const level = resource!.levelData[0]!;
        memory.fill(0xa5, level.ptr, level.ptr + level.bytes);

        expect(call(volume, "IDirect3DVolumeTexture9_LockBox", TEXTURE, 0, LOCKED, 0, 0x2000))
            .toBe(D3D_OK);
        expect(memory.slice(level.ptr, level.ptr + level.bytes).every((byte) => byte === 0)).toBe(true);
        expect(call(volume, "IDirect3DVolumeTexture9_UnlockBox", TEXTURE, 0)).toBe(D3D_OK);

        const view = new DataView(memory.buffer);
        view.setUint32(BOX + 0, 0, true);
        view.setUint32(BOX + 4, 0, true);
        view.setUint32(BOX + 8, 0, true);
        view.setUint32(BOX + 12, 1, true);
        view.setUint32(BOX + 16, 1, true);
        view.setUint32(BOX + 20, 1, true);
        memory.fill(0x5a, level.ptr, level.ptr + level.bytes);
        expect(call(volume, "IDirect3DVolumeTexture9_LockBox", TEXTURE, 0, LOCKED, BOX, 0x2000))
            .toBe(D3D_OK);
        expect(memory.slice(level.ptr, level.ptr + level.bytes).every((byte) => byte === 0x5a)).toBe(true);
        expect(call(volume, "IDirect3DVolumeTexture9_UnlockBox", TEXTURE, 0)).toBe(D3D_OK);
    });

    test("volume AddDirtyBox notifies the owning device only after box validation", () => {
        const resource = createVolumeTextureResource(4, 4, 2, 1, 0, 1, 21, volumeAllocator());
        expect(resource).not.toBeNull();
        volumeTextureResources.set(TEXTURE, resource!);
        resourceToDevice.set(TEXTURE, fakeDevice);

        expect(call(volume, "IDirect3DVolumeTexture9_AddDirtyBox", TEXTURE, 0)).toBe(D3D_OK);
        expect(dirtyVolumeMarks).toBe(1);

        const view = new DataView(memory.buffer);
        view.setUint32(BOX + 0, 1, true);
        view.setUint32(BOX + 4, 1, true);
        view.setUint32(BOX + 8, 0, true);
        view.setUint32(BOX + 12, 3, true);
        view.setUint32(BOX + 16, 3, true);
        view.setUint32(BOX + 20, 2, true);
        expect(call(volume, "IDirect3DVolumeTexture9_AddDirtyBox", TEXTURE, BOX)).toBe(D3D_OK);
        expect(dirtyVolumeMarks).toBe(2);

        view.setUint32(BOX + 12, 5, true);
        expect(call(volume, "IDirect3DVolumeTexture9_AddDirtyBox", TEXTURE, BOX)).toBe(D3DERR_INVALIDCALL);
        expect(dirtyVolumeMarks).toBe(2);
    });
    test("GetDC serves a surface with no lockable flag and gates on the GDI format", () => {
        // A swap-chain back buffer and a texture level carry no `lockable` at all.
        // Demanding one refuses the canonical GetBackBuffer()->GetDC() overlay path.
        const gdi = System.getInstance().gdiContext as any;
        const released: number[] = [];
        System.getInstance().gdiContext = {
            createOverlayDC: () => 0x4321,
            releaseDC: (hdc: number) => released.push(hdc),
        } as any;
        try {
            surfaceMeta.set(SURFACE, {
                width: 64, height: 64, format: 22 /* X8R8G8B8 */, usage: 1, pool: 0,
                multiSampleType: 0, multiSampleQuality: 0,
            });
            resourceToDevice.set(SURFACE, fakeDevice);
            expect(call(resources, "IDirect3DSurface9_GetDC", SURFACE, OUT)).toBe(D3D_OK);
            expect(Mem.readUint32(OUT)).toBe(0x4321);
            expect(call(resources, "IDirect3DSurface9_ReleaseDC", SURFACE, 0x4321)).toBe(D3D_OK);
            expect(released).toEqual([0x4321]);

            // GDI cannot describe a compressed/float surface: that is what GetDC refuses.
            surfaceMeta.set(SURFACE, {
                width: 64, height: 64, format: 827611204 /* DXT1 */, usage: 0, pool: 0,
                multiSampleType: 0, multiSampleQuality: 0,
            });
            expect(call(resources, "IDirect3DSurface9_GetDC", SURFACE, OUT)).toBe(D3DERR_INVALIDCALL);
        } finally {
            System.getInstance().gdiContext = gdi;
        }
    });

    test("SetLOD is a MANAGED-pool DWORD contract, never an HRESULT", () => {
        textureMeta.set(TEXTURE, { width: 8, height: 8, levels: 4, usage: 0, pool: 1, format: 21 });
        resourceToDevice.set(TEXTURE, fakeDevice);
        expect(call(resources, "IDirect3DTexture9_SetLOD", TEXTURE, 2)).toBe(0);
        expect(call(resources, "IDirect3DTexture9_GetLOD", TEXTURE)).toBe(2);
        // The previous LOD is the return value, so old = SetLOD(n); SetLOD(old) restores it.
        expect(call(resources, "IDirect3DTexture9_SetLOD", TEXTURE, 0)).toBe(2);
        expect(call(resources, "IDirect3DTexture9_GetLOD", TEXTURE)).toBe(0);

        // Outside D3DPOOL_MANAGED SetLOD is ignored and both calls report 0.
        textureMeta.set(CUBE, { width: 8, height: 8, levels: 4, usage: 0, pool: 0, format: 21, isCube: true });
        resourceToDevice.set(CUBE, fakeDevice);
        expect(call(resources, "IDirect3DCubeTexture9_SetLOD", CUBE, 3)).toBe(0);
        expect(call(resources, "IDirect3DCubeTexture9_GetLOD", CUBE)).toBe(0);

        // A stale pointer answers 0, not an HRESULT posing as the previous LOD.
        expect(call(resources, "IDirect3DTexture9_SetLOD", 0xdead, 1)).toBe(0);
    });
});
