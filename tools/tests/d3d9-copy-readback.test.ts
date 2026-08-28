import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createResourcesExports } from "../../src/worker/modules/d3d9/resources";
import { resourceToDevice, devices } from "../../src/worker/modules/d3d9/shared-state";
import { surfaceMeta, textureMeta } from "../../src/worker/modules/d3d9/resource-registry";
import { TextureStore } from "../../src/worker/backends/webgpu/d3d9/d3d9-resources";

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const DEVICE = 0x100;
const SRC = 0x200;
const DST = 0x300;
const SRC_SURFACE = 0x400;
const DST_SURFACE = 0x500;
const CUBE = 0x600;
const RECT = 0x1000;
const POINT = 0x1020;

type Pixels = { data: Uint8Array; pitch: number; width: number; height: number };

function makePixels(width: number, height: number, value: number): Pixels {
    return { data: new Uint8Array(width * height * 4).fill(value), pitch: width * 4, width, height };
}

let memory: Uint8Array;
let exports9: Record<string, any>;
const levels = new Map<string, Pixels>();
const cubeLevels = new Map<string, Pixels>();
let readbackCalls = 0;
let markDirtyCalls = 0;

const fakeDevice = {
    getTextureLevelPixels(texture: number, level: number): Pixels | null {
        return levels.get(`${texture}:${level}`) ?? null;
    },
    setTextureLevelPixels(texture: number, level: number, src: Uint8Array, srcPitch: number): boolean {
        const prior = levels.get(`${texture}:${level}`);
        if (!prior || src.length < srcPitch * prior.height) return false;
        for (let row = 0; row < prior.height; row++) {
            prior.data.set(src.subarray(row * srcPitch, row * srcPitch + prior.pitch), row * prior.pitch);
        }
        return true;
    },
    getCubeFacePixels(texture: number, face: number, level: number): Pixels | null {
        return cubeLevels.get(`${texture}:${face}:${level}`) ?? null;
    },
    setCubeFacePixels(texture: number, face: number, level: number, src: Uint8Array, srcPitch: number): boolean {
        const prior = cubeLevels.get(`${texture}:${face}:${level}`);
        if (!prior || src.length < srcPitch * prior.height) return false;
        for (let row = 0; row < prior.height; row++) {
            prior.data.set(src.subarray(row * srcPitch, row * srcPitch + prior.pitch), row * prior.pitch);
        }
        return true;
    },
    readTextureIntoGuestTexture(): number {
        readbackCalls++;
        return D3D_OK;
    },
    markTextureDirty(): void {
        markDirtyCalls++;
    },
} as any;

function call(name: string, ...args: number[]): number {
    return exports9[name]!({ esp: 0 }, memory, args) as number;
}

beforeEach(() => {
    memory = new Uint8Array(0x10000);
    Mem.bind(() => memory, (address, size) => address >= 0 && address + size <= memory.length);
    exports9 = createResourcesExports();
    levels.clear();
    cubeLevels.clear();
    readbackCalls = 0;
    markDirtyCalls = 0;
    devices.clear();
    resourceToDevice.clear();
    devices.set(DEVICE, fakeDevice);
    resourceToDevice.set(SRC, fakeDevice);
    resourceToDevice.set(DST, fakeDevice);
    resourceToDevice.set(SRC_SURFACE, fakeDevice);
    resourceToDevice.set(DST_SURFACE, fakeDevice);
    textureMeta.clear();
    surfaceMeta.clear();
});

describe("D3D9 CPU copy/readback contracts", () => {
    test("cube LockRect refuses an invalid RECT pointer before touching the device", () => {
        textureMeta.set(CUBE, { width: 4, height: 4, levels: 1, usage: 0, pool: 2, format: 21, isCube: true });
        resourceToDevice.set(CUBE, fakeDevice);
        let lockCalls = 0;
        const priorLock = fakeDevice.lockCubeFace;
        fakeDevice.lockCubeFace = () => {
            lockCalls++;
            return { ptr: 0x2000, pitch: 16 };
        };
        expect(call("IDirect3DCubeTexture9_LockRect", CUBE, 0, 0, 0x100, 0xfff8, 0)).toBe(D3DERR_INVALIDCALL);
        expect(lockCalls).toBe(0);
        fakeDevice.lockCubeFace = priorLock;
    });

    test("2D LockRect refuses a mip level outside the declared chain", () => {
        textureMeta.set(SRC, { width: 4, height: 4, levels: 2, usage: 0, pool: 2, format: 21 });
        resourceToDevice.set(SRC, fakeDevice);
        let lockCalls = 0;
        fakeDevice.lockTexture = () => {
            lockCalls++;
            return { ptr: 0x2000, pitch: 16 };
        };
        expect(call("IDirect3DTexture9_LockRect", SRC, 2, 0x1100, 0, 0, 0)).toBe(D3DERR_INVALIDCALL);
        expect(new DataView(memory.buffer).getUint32(0x1100, true)).toBe(0);
        expect(lockCalls).toBe(0);
        expect(call("IDirect3DTexture9_UnlockRect", SRC, 2)).toBe(D3DERR_INVALIDCALL);
    });

    test("2D LockRect rejects a nested lock until the first lock is unlocked", () => {
        textureMeta.set(SRC, { width: 4, height: 4, levels: 1, usage: 0, pool: 2, format: 21 });
        resourceToDevice.set(SRC, fakeDevice);
        fakeDevice.textureReadbackForLock = () => null;
        fakeDevice.isRenderTargetTexture = () => false;
        fakeDevice.lockTexture = () => ({ ptr: 0x2000, pitch: 16 });
        fakeDevice.unlockTexture = () => 0;
        expect(call("IDirect3DTexture9_LockRect", SRC, 0, 0x1100, 0, 0, 0)).toBe(D3D_OK);
        expect(call("IDirect3DTexture9_LockRect", SRC, 0, 0x1100, 0, 0, 0)).toBe(D3DERR_INVALIDCALL);
        expect(call("IDirect3DTexture9_UnlockRect", SRC, 0)).toBe(D3D_OK);
        expect(call("IDirect3DTexture9_UnlockRect", SRC, 0)).toBe(D3DERR_INVALIDCALL);
    });

    test("2D LockRect propagates NO_DIRTY_UPDATE and still publishes guest bytes", () => {
        textureMeta.set(SRC, { width: 2, height: 2, levels: 1, usage: 0, pool: 2, format: 21 });
        resourceToDevice.set(SRC, fakeDevice);
        fakeDevice.textureReadbackForLock = () => null;
        fakeDevice.isRenderTargetTexture = () => false;
        fakeDevice.lockTexture = () => ({ ptr: 0x2000, pitch: 8 });
        const unlockOptions: unknown[] = [];
        fakeDevice.unlockTexture = (_texture: number, _level: number, _mem: Uint8Array, options: unknown) => {
            unlockOptions.push(options);
            return 0;
        };

        expect(call("IDirect3DTexture9_LockRect", SRC, 0, 0x1100, 0, 0x8000)).toBe(D3D_OK);
        expect(call("IDirect3DTexture9_UnlockRect", SRC, 0)).toBe(D3D_OK);
        expect(unlockOptions).toEqual([{ readOnly: false, noDirtyUpdate: true }]);
    });

    test("TextureStore NO_DIRTY_UPDATE copies the guest write without dirtying the resource", () => {
        const store = new TextureStore();
        const index = store.create(0x7700, 2, 2, 1, 21, 0, 2);
        store.setDirty(index, false);
        const guestMemory = new Uint8Array(16).fill(0x6a);
        expect(store.lock(index, guestMemory, { publish: false })).not.toBeNull();
        store.unlock(index, guestMemory, { noDirtyUpdate: true });
        expect(store.getData(index)?.every((byte) => byte === 0x6a)).toBe(true);
        expect(store.isDirty(index)).toBe(false);
        // NO_DIRTY_UPDATE preserves an already-dirty state as well; it is not
        // an implicit clear, only a promise not to change the dirty bit.
        store.setDirty(index, true);
        guestMemory.fill(0x7b);
        expect(store.lock(index, guestMemory, { publish: false })).not.toBeNull();
        store.unlock(index, guestMemory, { noDirtyUpdate: true });
        expect(store.getData(index)?.every((byte) => byte === 0x7b)).toBe(true);
        expect(store.isDirty(index)).toBe(true);
    });

    test("cube LockRect propagates NO_DIRTY_UPDATE to the face unlock", () => {
        textureMeta.set(CUBE, { width: 2, height: 2, levels: 1, usage: 0, pool: 2, format: 21, isCube: true });
        resourceToDevice.set(CUBE, fakeDevice);
        const lockOptions: unknown[] = [];
        const unlockCalls: number[] = [];
        fakeDevice.lockCubeFace = (_cube: number, _face: number, _level: number, options: unknown) => {
            lockOptions.push(options);
            return { ptr: 0x2000, pitch: 8 };
        };
        fakeDevice.unlockCubeFace = () => {
            unlockCalls.push(1);
            return true;
        };

        expect(call("IDirect3DCubeTexture9_LockRect", CUBE, 0, 0, 0x1100, 0, 0x8000)).toBe(D3D_OK);
        expect(call("IDirect3DCubeTexture9_UnlockRect", CUBE, 0, 0)).toBe(D3D_OK);
        expect(lockOptions).toEqual([{ discard: false, readOnly: false, noDirtyUpdate: true }]);
        expect(unlockCalls).toEqual([1]);
    });

    test("AddDirtyRect notifies the backend upload path", () => {
        textureMeta.set(SRC, { width: 4, height: 4, levels: 1, usage: 0, pool: 1, format: 21 });
        resourceToDevice.set(SRC, fakeDevice);
        const view = new DataView(memory.buffer);
        view.setInt32(RECT + 0, 1, true);
        view.setInt32(RECT + 4, 1, true);
        view.setInt32(RECT + 8, 3, true);
        view.setInt32(RECT + 12, 3, true);
        expect(call("IDirect3DTexture9_AddDirtyRect", SRC, RECT)).toBe(D3D_OK);
        expect(markDirtyCalls).toBe(1);
        expect(call("IDirect3DTexture9_AddDirtyRect", SRC, 0)).toBe(D3D_OK);
        expect(markDirtyCalls).toBe(2);
        textureMeta.set(SRC, { width: 4, height: 4, levels: 1, usage: 0x1, pool: 0, format: 21 });
        expect(call("IDirect3DTexture9_AddDirtyRect", SRC, 0)).toBe(D3D_OK);
        expect(markDirtyCalls).toBe(2);
    });

    test("UpdateTexture copies every matching mip and refuses partial success", () => {
        textureMeta.set(SRC, { width: 4, height: 4, levels: 2, usage: 0, pool: 2, format: 21 });
        textureMeta.set(DST, { width: 4, height: 4, levels: 2, usage: 0, pool: 0, format: 21 });
        levels.set(`${SRC}:0`, makePixels(4, 4, 0x11));
        levels.set(`${SRC}:1`, makePixels(2, 2, 0x22));
        levels.set(`${DST}:0`, makePixels(4, 4, 0));
        levels.set(`${DST}:1`, makePixels(2, 2, 0));

        expect(call("IDirect3DDevice9_UpdateTexture", DEVICE, SRC, DST)).toBe(D3D_OK);
        expect(levels.get(`${DST}:0`)!.data.every((byte) => byte === 0x11)).toBe(true);
        expect(levels.get(`${DST}:1`)!.data.every((byte) => byte === 0x22)).toBe(true);

        levels.delete(`${SRC}:1`);
        expect(call("IDirect3DDevice9_UpdateTexture", DEVICE, SRC, DST)).toBe(D3DERR_INVALIDCALL);
    });

    test("UpdateTexture copies all six cube faces without aliasing face zero", () => {
        textureMeta.set(SRC, { width: 2, height: 2, levels: 1, usage: 0, pool: 2, format: 21, isCube: true });
        textureMeta.set(DST, { width: 2, height: 2, levels: 1, usage: 0, pool: 0, format: 21, isCube: true });
        for (let face = 0; face < 6; face++) {
            cubeLevels.set(`${SRC}:${face}:0`, makePixels(2, 2, 0x10 + face));
            cubeLevels.set(`${DST}:${face}:0`, makePixels(2, 2, 0));
        }

        expect(call("IDirect3DDevice9_UpdateTexture", DEVICE, SRC, DST)).toBe(D3D_OK);
        for (let face = 0; face < 6; face++) {
            expect(cubeLevels.get(`${DST}:${face}:0`)!.data.every((byte) => byte === 0x10 + face)).toBe(true);
        }
    });

    test("UpdateSurface honors a sub-rect and destination point", () => {
        textureMeta.set(SRC, { width: 4, height: 4, levels: 1, usage: 0, pool: 2, format: 21 });
        textureMeta.set(DST, { width: 4, height: 4, levels: 1, usage: 0, pool: 0, format: 21 });
        surfaceMeta.set(SRC_SURFACE, {
            format: 21, type: 1, usage: 0, pool: 2, multiSampleType: 0, multiSampleQuality: 0,
            width: 4, height: 4, texturePtr: SRC, level: 0,
        });
        surfaceMeta.set(DST_SURFACE, {
            format: 21, type: 1, usage: 0, pool: 0, multiSampleType: 0, multiSampleQuality: 0,
            width: 4, height: 4, texturePtr: DST, level: 0,
        });
        const source = makePixels(4, 4, 0);
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) source.data[(y * 4 + x) * 4] = y * 4 + x;
        levels.set(`${SRC}:0`, source);
        levels.set(`${DST}:0`, makePixels(4, 4, 0xff));
        new DataView(memory.buffer).setInt32(RECT + 0, 1, true);
        new DataView(memory.buffer).setInt32(RECT + 4, 1, true);
        new DataView(memory.buffer).setInt32(RECT + 8, 3, true);
        new DataView(memory.buffer).setInt32(RECT + 12, 3, true);
        new DataView(memory.buffer).setInt32(POINT + 0, 0, true);
        new DataView(memory.buffer).setInt32(POINT + 4, 0, true);

        expect(call("IDirect3DDevice9_UpdateSurface", DEVICE, SRC_SURFACE, RECT, DST_SURFACE, POINT)).toBe(D3D_OK);
        const out = levels.get(`${DST}:0`)!.data;
        expect(out[0]).toBe(5);
        expect(out[4]).toBe(6);
        expect(out[16]).toBe(9);
        expect(out[20]).toBe(10);
        expect(out[24]).toBe(0xff);
    });

    test("GetRenderTargetData rejects a non-SYSTEMMEM destination before dispatch", () => {
        textureMeta.set(SRC, { width: 4, height: 4, levels: 1, usage: 1, pool: 0, format: 21 });
        textureMeta.set(DST, { width: 4, height: 4, levels: 1, usage: 0, pool: 0, format: 21 });
        surfaceMeta.set(SRC_SURFACE, {
            format: 21, type: 1, usage: 1, pool: 0, multiSampleType: 0, multiSampleQuality: 0,
            width: 4, height: 4, texturePtr: SRC, level: 0,
        });
        surfaceMeta.set(DST_SURFACE, {
            format: 21, type: 1, usage: 0, pool: 0, multiSampleType: 0, multiSampleQuality: 0,
            width: 4, height: 4, texturePtr: DST, level: 0,
        });

        expect(call("IDirect3DDevice9_GetRenderTargetData", DEVICE, SRC_SURFACE, DST_SURFACE)).toBe(D3DERR_INVALIDCALL);
        expect(readbackCalls).toBe(0);
        surfaceMeta.get(DST_SURFACE)!.pool = 2;
        expect(call("IDirect3DDevice9_GetRenderTargetData", DEVICE, SRC_SURFACE, DST_SURFACE)).toBe(D3D_OK);
        expect(readbackCalls).toBe(1);
    });

    test("CreateOffscreenPlainSurface refuses R16F without a surface contract", () => {
        // The bounded R16F probe only proves sampled 2-D texture storage.  A
        // plain surface is D3DRTYPE_SURFACE and must not inherit that answer
        // before a separate attachment/readback contract exists.
        expect(call("IDirect3DDevice9_CreateOffscreenPlainSurface", DEVICE, 4, 4, 111, 0, 0x1100, 0))
            .toBe(0x8876086a);
        expect(new DataView(memory.buffer).getUint32(0x1100, true)).toBe(0);
    });
});
