import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { ThunkGenerator } from '../../src/worker/core/thunking/thunk-generator';
import { generateModuleVTables } from '../../src/worker/api/codegen';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import {
    d3d9Module,
    IDirect3DVolume9,
    IDirect3DVolumeTexture9,
} from '../../src/worker/api/d3d9.api';
import { createResourcesExports } from '../../src/worker/modules/d3d9/resources';
import { createVolumeExports } from '../../src/worker/modules/d3d9/volume';
import { devices, getComRefCount, resetD3D9SharedState, resourceToDevice } from '../../src/worker/modules/d3d9/shared-state';
import {
    createVolumeTextureResource,
    getVolumeLevelDims,
    lockVolumeBox,
    volumeLevelObjects,
    volumeLevelParents,
    volumeTextureResources,
    unlockVolumeBox,
} from '../../src/worker/modules/d3d9/volume-resources';
import { setD3D9VolumeCapabilityContract } from '../../src/worker/backends/webgpu/shared/volume-policy';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DERR_NOTAVAILABLE = 0x8876086a;
const DEVICE = 0x100;
const SRC = 0x200;
const DST = 0x300;

let memory: Uint8Array;
let nextPtr = 0x4000;
const fakeDevice = {} as any;

function allocator() {
    return {
        alloc(size: number) {
            const ptr = nextPtr;
            nextPtr += size;
            return ptr;
        },
        free: () => undefined,
    };
}

function makeVolume(
    width: number,
    height: number,
    depth: number,
    levels: number,
    usage: number,
    pool: number,
    format = 21,
) {
    const resource = createVolumeTextureResource(width, height, depth, levels, usage, pool, format, allocator());
    if (!resource) throw new Error('volume allocation failed');
    return resource;
}

beforeEach(() => {
    memory = new Uint8Array(0x20000);
    nextPtr = 0x4000;
    Mem.bind(() => memory, (address, size) => address >= 0 && address + size <= memory.length);
    volumeTextureResources.clear();
    volumeLevelObjects.clear();
    volumeLevelParents.clear();
    resourceToDevice.clear();
    devices.clear();
    devices.set(DEVICE, fakeDevice);
    setD3D9VolumeCapabilityContract(null);
});

describe('D3D9 volume texture ABI', () => {
    test('CreateVolumeTexture refuses without the explicit adapter capability contract', () => {
        const volume = createVolumeExports();
        expect(volume['IDirect3DDevice9_CreateVolumeTexture']!({ esp: 0 }, memory, [
            DEVICE, 8, 8, 4, 1, 0, 21, 0, 0x100,
        ])).toBe(D3DERR_NOTAVAILABLE);
        expect(new DataView(memory.buffer).getUint32(0x100, true)).toBe(0);
    });

    test('publishes the native base-texture prefix and volume methods', () => {
        expect(IDirect3DVolumeTexture9.methods.slice(0, 3).map((m) => m.name))
            .toEqual(['QueryInterface', 'AddRef', 'Release']);
        expect(IDirect3DVolumeTexture9.methods.slice(-5).map((m) => m.name))
            .toEqual(['GetLevelDesc', 'GetVolumeLevel', 'LockBox', 'UnlockBox', 'AddDirtyBox']);
        expect(IDirect3DVolumeTexture9.methods.find((m) => m.name === 'LockBox')?.params.length).toBe(5);
        expect(IDirect3DVolume9.methods.map((m) => m.name).slice(-4))
            .toEqual(['GetContainer', 'GetDesc', 'LockBox', 'UnlockBox']);
        // IDirect3DResource9::PreLoad is STDMETHOD_(void): the volume texture inherits
        // the same return ABI as every other resource interface.
        expect(IDirect3DVolumeTexture9.methods.find((m) => m.name === 'PreLoad')?.returnType)
            .toBe('void');

        const tables = generateModuleVTables(d3d9Module);
        expect(tables.find((t) => t.name === 'IDirect3DVolumeTexture9')?.methods.length)
            .toBe(IDirect3DVolumeTexture9.methods.length);
        expect(tables.find((t) => t.name === 'IDirect3DVolume9')?.methods.length)
            .toBe(IDirect3DVolume9.methods.length);
    });

    test('Volume9 GetContainer requires a GUID and accepts the parent resource contract', () => {
        const resource = makeVolume(2, 2, 1, 1, 0, 2);
        volumeTextureResources.set(SRC, resource);
        volumeLevelParents.set(0x350, { texturePtr: SRC, level: 0 });
        const volume = createVolumeExports();
        const view = new DataView(memory.buffer);
        const out = 0x180;
        view.setUint32(out, 0xffffffff, true);
        expect(volume['IDirect3DVolume9_GetContainer']!({ esp: 0 }, memory, [0x350, 0, out]))
            .toBe(D3DERR_INVALIDCALL);
        expect(view.getUint32(out, true)).toBe(0);

        const iid = 0x200;
        memory.set([0x5d, 0xc0, 0xee, 0x05, 0x7d, 0x8f, 0x62, 0x43,
            0xb9, 0x99, 0xd1, 0xba, 0xf3, 0x57, 0xc7, 0x04], iid);
        expect(volume['IDirect3DVolume9_GetContainer']!({ esp: 0 }, memory, [0x350, iid, out]))
            .toBe(D3D_OK);
        expect(view.getUint32(out, true)).toBe(SRC);
    });
});

describe('CPU volume mip storage and LockBox', () => {
    test('rejects zero dimensions and an explicit mip chain beyond distinct dimensions', () => {
        expect(createVolumeTextureResource(0, 4, 4, 0, 0, 0, 21, allocator())).toBeNull();
        expect(createVolumeTextureResource(4, 4, 4, 3, 0, 0, 21, allocator())).not.toBeNull();
        expect(createVolumeTextureResource(4, 4, 4, 4, 0, 0, 21, allocator())).toBeNull();
    });

    test('allocates all mip dimensions and reports full-level pitches', () => {
        let next = 0x1000;
        const freed: number[] = [];
        const resource = createVolumeTextureResource(8, 4, 2, 0, 0, 2, 21, {
            alloc: (size) => { const ptr = next; next += size; return ptr; },
            free: (ptr) => freed.push(ptr),
        });
        expect(resource).not.toBeNull();
        expect(resource!.levels).toBe(4);
        expect(resource!.levelData.map((level) => [level.width, level.height, level.depth]))
            .toEqual([[8, 4, 2], [4, 2, 1], [2, 1, 1], [1, 1, 1]]);
        expect(getVolumeLevelDims(8, 4, 2, 2)).toEqual({ width: 2, height: 1, depth: 1 });
    });

    test('LockBox returns a 3-D origin with row and slice pitch', () => {
        let next = 0x2000;
        const resource = createVolumeTextureResource(4, 4, 3, 1, 0, 0, 21, {
            alloc: (size) => { const ptr = next; next += size; return ptr; },
            free: () => undefined,
        })!;
        volumeTextureResources.set(0x55, resource);
        const lock = lockVolumeBox(0x55, 0, { left: 1, top: 2, front: 1, right: 3, bottom: 4, back: 2 });
        expect(lock).toEqual({ ptr: resource.levelData[0]!.ptr + 1 * 64 + 2 * 16 + 1 * 4, rowPitch: 16, slicePitch: 64 });
        expect(lockVolumeBox(0x55, 0, null)).toBeNull();
        expect(unlockVolumeBox(0x55, 0)).toBe(true);
        expect(unlockVolumeBox(0x55, 0)).toBe(false);
        volumeTextureResources.delete(0x55);
    });

    test('LockBox READONLY does not publish a dirty mark and rejects DISCARD|READONLY', () => {
        const resource = makeVolume(2, 2, 1, 1, 0, 0);
        volumeTextureResources.set(SRC, resource);
        const marks: number[] = [];
        resourceToDevice.set(SRC, { markVolumeTextureDirty: (ptr: number) => marks.push(ptr) } as any);
        const volume = createVolumeExports();
        const locked = 0x800;
        expect(volume['IDirect3DVolumeTexture9_LockBox']!({ esp: 0 }, memory, [SRC, 0, locked, 0, 0x10])).toBe(D3D_OK);
        expect(volume['IDirect3DVolumeTexture9_UnlockBox']!({ esp: 0 }, memory, [SRC, 0])).toBe(D3D_OK);
        expect(marks).toEqual([]);
        expect(volume['IDirect3DVolumeTexture9_LockBox']!({ esp: 0 }, memory, [SRC, 0, locked, 0, 0x2010])).toBe(D3DERR_INVALIDCALL);
        volumeTextureResources.delete(SRC);
    });

    test('LockBox NO_DIRTY_UPDATE copies through without publishing a dirty mark', () => {
        const resource = makeVolume(2, 2, 1, 1, 0, 0);
        volumeTextureResources.set(SRC, resource);
        const marks: number[] = [];
        resourceToDevice.set(SRC, { markVolumeTextureDirty: (ptr: number) => marks.push(ptr) } as any);
        const volume = createVolumeExports();
        const locked = 0x800;
        expect(volume['IDirect3DVolumeTexture9_LockBox']!({ esp: 0 }, memory, [SRC, 0, locked, 0, 0x8000])).toBe(D3D_OK);
        memory.fill(0x5c, resource.levelData[0]!.ptr, resource.levelData[0]!.ptr + resource.levelData[0]!.bytes);
        expect(volume['IDirect3DVolumeTexture9_UnlockBox']!({ esp: 0 }, memory, [SRC, 0])).toBe(D3D_OK);
        expect(marks).toEqual([]);
        expect(Array.from(memory.slice(resource.levelData[0]!.ptr, resource.levelData[0]!.ptr + 4)))
            .toEqual([0x5c, 0x5c, 0x5c, 0x5c]);
        volumeTextureResources.delete(SRC);
    });

    test('GenerateMipSubLevels filters all eight voxels into the next mip', () => {
        const resource = makeVolume(2, 2, 2, 2, 0x400, 0);
        volumeTextureResources.set(SRC, resource);

        const base = resource.levelData[0]!;
        for (let voxel = 0; voxel < 8; voxel++) {
            const offset = base.ptr + voxel * 4;
            for (let channel = 0; channel < 4; channel++) {
                expect(Mem.writeUint8(offset + channel, voxel + channel * 10)).toBe(true);
            }
        }

        const volume = createVolumeExports();
        expect(volume['IDirect3DVolumeTexture9_GenerateMipSubLevels']!({ esp: 0 }, memory, [SRC])).toBe(D3D_OK);

        const mip = resource.levelData[1]!;
        expect(Array.from(memory.slice(mip.ptr, mip.ptr + 4))).toEqual([4, 14, 24, 34]);
    });

    test('GenerateMipSubLevels refuses unsupported volume filter kernels', () => {
        const resource = makeVolume(2, 2, 2, 2, 0x400, 0);
        volumeTextureResources.set(SRC, resource);
        const volume = createVolumeExports();
        expect(volume['IDirect3DVolumeTexture9_SetAutoGenFilterType']!({ esp: 0 }, memory,
            [SRC, 3 /* D3DTEXF_ANISOTROPIC */])).toBe(D3D_OK);
        expect(volume['IDirect3DVolumeTexture9_GenerateMipSubLevels']!({ esp: 0 }, memory,
            [SRC])).toBe(D3DERR_NOTAVAILABLE);
    });

    test('GenerateMipSubLevels refuses four-channel kernels for wider texels', () => {
        // A16B16G16R16 is 8 bytes/texel.  The CPU fallback below is intentionally
        // limited to tightly packed four-byte texels; accepting this format
        // would index each row at x*4 and corrupt the generated mip.
        const resource = makeVolume(2, 2, 2, 2, 0x400, 0, 36 /* D3DFMT_A16B16G16R16 */);
        volumeTextureResources.set(SRC, resource);
        const volume = createVolumeExports();
        expect(volume['IDirect3DVolumeTexture9_GenerateMipSubLevels']!({ esp: 0 }, memory,
            [SRC])).toBe(D3DERR_NOTAVAILABLE);
    });

    test('UpdateTexture copies volume mips by matching dimensions', () => {
        const source = makeVolume(4, 4, 2, 0, 0, 2);
        const destination = makeVolume(2, 2, 1, 0, 0, 0);
        volumeTextureResources.set(SRC, source);
        volumeTextureResources.set(DST, destination);
        resourceToDevice.set(SRC, fakeDevice);
        resourceToDevice.set(DST, fakeDevice);

        // Destination level 0 is 2x2x1, so UpdateTexture starts at source level 1;
        // level 2 must also be copied into destination level 1.
        memory.fill(0x44, source.levelData[1]!.ptr, source.levelData[1]!.ptr + source.levelData[1]!.bytes);
        memory.fill(0x55, source.levelData[2]!.ptr, source.levelData[2]!.ptr + source.levelData[2]!.bytes);

        const resources = createResourcesExports();
        expect(resources['IDirect3DDevice9_UpdateTexture']!({ esp: 0 }, memory, [DEVICE, SRC, DST])).toBe(D3D_OK);
        expect(Array.from(memory.slice(destination.levelData[0]!.ptr, destination.levelData[0]!.ptr + destination.levelData[0]!.bytes)))
            .toEqual(new Array(destination.levelData[0]!.bytes).fill(0x44));
        expect(Array.from(memory.slice(destination.levelData[1]!.ptr, destination.levelData[1]!.ptr + destination.levelData[1]!.bytes)))
            .toEqual(new Array(destination.levelData[1]!.bytes).fill(0x55));

        resourceToDevice.delete(DST);
        expect(resources['IDirect3DDevice9_UpdateTexture']!({ esp: 0 }, memory, [DEVICE, SRC, DST])).toBe(D3DERR_INVALIDCALL);
    });
});

describe('IDirect3DVolume9 lifetime and LOD contracts', () => {
    const TEXTURE_OUT = 0x100;
    const VOLUME_OUT = 0x140;
    let originalProcess: unknown;
    let volume: Record<string, any>;

    beforeEach(() => {
        const system = System.getInstance() as any;
        originalProcess = system.process;
        memory = new Uint8Array(0x200000);
        let next = 0x1f0000;
        const thunkGenerator = new ThunkGenerator();
        thunkGenerator.setBaseAddress(0x10000);
        system.process = {
            memory: {
                alloc: (size: number) => { const ptr = next; next += Math.max(4, size); return ptr; },
                allocAt: () => undefined,
                allocSystemBlock: (size: number) => { const ptr = next; next += Math.max(16, size); return ptr; },
                free: () => undefined,
                freeSystemBlock: () => undefined,
            },
            dispatcher: { registerModule: () => undefined, applyPendingRegistrations: () => undefined },
            thunkGenerator,
            getCurrentMemory: () => memory,
        };
        Mem.bind(() => memory, (address, size) => address >= 0 && address + size <= memory.length);
        resetD3D9SharedState();
        devices.set(DEVICE, { registerVolumeTexture: () => undefined, releaseVolumeTexture: () => undefined } as any);
        setD3D9VolumeCapabilityContract({
            supportsTexture3D: () => true,
            maxExtent: 2048,
            filterCaps: 0x100,
            addressCaps: 0x1,
            supportsAutoGenMipmaps: () => true,
        } as any);
        volume = createVolumeExports();
    });

    afterEach(() => {
        setD3D9VolumeCapabilityContract(null);
        resetD3D9SharedState();
        System.getInstance().process = originalProcess as any;
    });

    function createTexture(pool: number): number {
        expect(volume['IDirect3DDevice9_CreateVolumeTexture']!({ esp: 0 }, memory, [
            DEVICE, 8, 8, 8, 4, 0, 21, pool, TEXTURE_OUT,
        ])).toBe(D3D_OK);
        return new DataView(memory.buffer).getUint32(TEXTURE_OUT, true);
    }

    test('GetVolumeLevel leaks no COM block: the child dies with its texture', () => {
        const texturePtr = createTexture(1);
        expect(getComRefCount(texturePtr)).toBe(1);

        expect(volume['IDirect3DVolumeTexture9_GetVolumeLevel']!({ esp: 0 }, memory, [texturePtr, 1, VOLUME_OUT]))
            .toBe(D3D_OK);
        const volumePtr = new DataView(memory.buffer).getUint32(VOLUME_OUT, true);
        expect(volumePtr).not.toBe(0);
        // The caller's reference is a reference on the PARENT — Release through the
        // child lands there too.
        expect(getComRefCount(texturePtr)).toBe(2);

        // The same level hands back the same object and one more parent reference.
        expect(volume['IDirect3DVolumeTexture9_GetVolumeLevel']!({ esp: 0 }, memory, [texturePtr, 1, VOLUME_OUT]))
            .toBe(D3D_OK);
        expect(new DataView(memory.buffer).getUint32(VOLUME_OUT, true)).toBe(volumePtr);
        expect(getComRefCount(texturePtr)).toBe(3);

        expect(volume['IDirect3DVolume9_Release']!({ esp: 0 }, memory, [volumePtr])).toBe(2);
        expect(volume['IDirect3DVolume9_Release']!({ esp: 0 }, memory, [volumePtr])).toBe(1);
        expect(volume['IDirect3DVolumeTexture9_Release']!({ esp: 0 }, memory, [texturePtr])).toBe(0);

        // Nothing is left holding the child allocation.
        expect(getComRefCount(volumePtr)).toBeFalsy();
        expect(volumeLevelParents.has(volumePtr)).toBe(false);
    });

    test('volume SetLOD applies to MANAGED only and always returns a DWORD', () => {
        const managed = createTexture(1);
        expect(volume['IDirect3DVolumeTexture9_SetLOD']!({ esp: 0 }, memory, [managed, 2])).toBe(0);
        expect(volume['IDirect3DVolumeTexture9_GetLOD']!({ esp: 0 }, memory, [managed])).toBe(2);
        expect(volume['IDirect3DVolumeTexture9_SetLOD']!({ esp: 0 }, memory, [managed, 0])).toBe(2);

        const scratch = createTexture(3);
        expect(volume['IDirect3DVolumeTexture9_SetLOD']!({ esp: 0 }, memory, [scratch, 2])).toBe(0);
        expect(volume['IDirect3DVolumeTexture9_GetLOD']!({ esp: 0 }, memory, [scratch])).toBe(0);

        // A stale pointer answers 0, not D3DERR_INVALIDCALL read as the previous LOD.
        expect(volume['IDirect3DVolumeTexture9_SetLOD']!({ esp: 0 }, memory, [0xdead, 1])).toBe(0);
    });
});
