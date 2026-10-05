import { beforeEach, describe, expect, test } from 'bun:test';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { createResourcesExports } from '../../src/worker/modules/d3d9/resources';
import { textureMeta } from '../../src/worker/modules/d3d9/resource-registry';
import { devices, resourceToDevice } from '../../src/worker/modules/d3d9/shared-state';
import {
    D3DTEXF_LINEAR,
    D3DTEXF_POINT,
    generateD3D9AutogenMipLevel,
} from '../../src/worker/modules/d3d9/mip-autogen';

const D3D_OK = 0;
const D3DERR_NOTAVAILABLE = 0x8876086a;
const DEVICE = 0x100;
const TEXTURE = 0x200;

function rgba(values: number[], pitch = 8): { data: Uint8Array; pitch: number; width: number; height: number } {
    return { data: Uint8Array.from(values), pitch, width: 2, height: 2 };
}

describe('D3D9 AUTOGENMIPMAP filtering', () => {
    beforeEach(() => {
        textureMeta.clear();
        devices.clear();
        resourceToDevice.clear();
    });

    test('LINEAR averages each 2x2 texel footprint', () => {
        const source = rgba([
            0, 10, 20, 30, 100, 110, 120, 130,
            20, 30, 40, 50, 120, 130, 140, 150,
        ]);
        const mip = generateD3D9AutogenMipLevel(source, 4, D3DTEXF_LINEAR);
        expect(mip).not.toBeNull();
        expect(mip!.width).toBe(1);
        expect(mip!.height).toBe(1);
        expect(Array.from(mip!.data)).toEqual([60, 70, 80, 90]);
    });

    test('POINT selects the top-left texel without averaging', () => {
        const source = rgba([
            1, 2, 3, 4, 101, 102, 103, 104,
            11, 12, 13, 14, 111, 112, 113, 114,
        ]);
        const mip = generateD3D9AutogenMipLevel(source, 4, D3DTEXF_POINT);
        expect(mip).not.toBeNull();
        expect(Array.from(mip!.data)).toEqual([1, 2, 3, 4]);
    });

    test('R8G8B8 POINT/LINEAR preserves three-byte BGR channels', () => {
        // Two tightly packed BGR rows with a two-byte pitch pad, as produced by
        // the canonical D3D9 layout for a 2x2 24-bit surface.
        const source = {
            data: Uint8Array.from([
                10, 20, 30, 40, 50, 60, 0, 0,
                70, 80, 90, 100, 110, 120, 0, 0,
            ]),
            pitch: 8,
            width: 2,
            height: 2,
        };
        const point = generateD3D9AutogenMipLevel(source, 3, D3DTEXF_POINT, 4);
        expect(point).not.toBeNull();
        expect(Array.from(point!.data)).toEqual([10, 20, 30, 0]);
        const linear = generateD3D9AutogenMipLevel(source, 3, D3DTEXF_LINEAR, 4);
        expect(linear).not.toBeNull();
        expect(Array.from(linear!.data)).toEqual([55, 65, 75, 0]);
    });

    test('preserves canonical destination pitch and clamps odd edges', () => {
        const source = {
            data: Uint8Array.from([20]),
            pitch: 1,
            width: 1,
            height: 1,
        };
        const mip = generateD3D9AutogenMipLevel(source, 1, D3DTEXF_LINEAR, 4);
        expect(mip).not.toBeNull();
        expect(mip!.width).toBe(1);
        expect(mip!.height).toBe(1);
        expect(mip!.pitch).toBe(4);
        // A 1x1 source repeats its edge texel across the entire 2x2 footprint.
        expect(Array.from(mip!.data)).toEqual([20, 0, 0, 0]);
    });

    test('does not claim kernels that are not implemented', () => {
        const source = rgba(new Array(16).fill(1));
        expect(generateD3D9AutogenMipLevel(source, 4, 3)).toBeNull(); // ANISOTROPIC
        expect(generateD3D9AutogenMipLevel(source, 4, 6)).toBeNull(); // PYRAMIDALQUAD
        expect(generateD3D9AutogenMipLevel(source, 4, 7)).toBeNull(); // GAUSSIANQUAD
        expect(generateD3D9AutogenMipLevel(source, 4, 8)).toBeNull(); // CONVOLUTIONMONO
        expect(generateD3D9AutogenMipLevel(source, 5, D3DTEXF_LINEAR)).toBeNull();
        expect(generateD3D9AutogenMipLevel({ ...source, pitch: 4 }, 4, D3DTEXF_LINEAR)).toBeNull();
    });

    test('A8L8 autogen averages luminance and alpha bytes independently', () => {
        const source = {
            data: new Uint8Array([
                0, 0, 100, 100,
                200, 200, 255, 255,
            ]),
            pitch: 4,
            width: 2,
            height: 2,
        };
        const point = generateD3D9AutogenMipLevel(source, 2, D3DTEXF_POINT, 2);
        expect(point).not.toBeNull();
        expect(Array.from(point!.data)).toEqual([0, 0]);
        const linear = generateD3D9AutogenMipLevel(source, 2, D3DTEXF_LINEAR, 2);
        expect(linear).not.toBeNull();
        expect(Array.from(linear!.data)).toEqual([139, 139]);
    });

    test('resource GenerateMipSubLevels consumes SetAutoGenFilterType state', () => {
        const levels = new Map<number, { data: Uint8Array; pitch: number; width: number; height: number }>([
            [0, {
                data: Uint8Array.from([
                    1, 2, 3, 4, 101, 102, 103, 104,
                    11, 12, 13, 14, 111, 112, 113, 114,
                ]),
                pitch: 8,
                width: 2,
                height: 2,
            }],
            [1, { data: new Uint8Array(4), pitch: 4, width: 1, height: 1 }],
        ]);
        const fakeDevice = {
            getTextureLevelPixels: (_texture: number, level: number) => levels.get(level) ?? null,
            setTextureLevelPixels: (_texture: number, level: number, data: Uint8Array, pitch: number) => {
                const destination = levels.get(level);
                if (!destination || pitch !== destination.pitch || data.length < pitch * destination.height) return false;
                destination.data.set(data.subarray(0, destination.data.length));
                return true;
            },
        } as any;
        devices.set(DEVICE, fakeDevice);
        resourceToDevice.set(TEXTURE, fakeDevice);
        textureMeta.set(TEXTURE, { width: 2, height: 2, levels: 2, usage: 0x400, pool: 0, format: 21 });

        const resources = createResourcesExports();
        const call = (name: string, ...args: number[]) => resources[name]!({ esp: 0 }, new Uint8Array(0), args) as number;

        expect(call('IDirect3DTexture9_SetAutoGenFilterType', TEXTURE, D3DTEXF_POINT)).toBe(D3D_OK);
        expect(call('IDirect3DTexture9_GenerateMipSubLevels', TEXTURE)).toBe(D3D_OK);
        expect(Array.from(levels.get(1)!.data)).toEqual([1, 2, 3, 4]);

        levels.get(1)!.data.fill(0);
        expect(call('IDirect3DTexture9_SetAutoGenFilterType', TEXTURE, D3DTEXF_LINEAR)).toBe(D3D_OK);
        expect(call('IDirect3DTexture9_GenerateMipSubLevels', TEXTURE)).toBe(D3D_OK);
        expect(Array.from(levels.get(1)!.data)).toEqual([56, 57, 58, 59]);

        expect(call('IDirect3DTexture9_SetAutoGenFilterType', TEXTURE, 3)).toBe(D3D_OK);
        expect(call('IDirect3DTexture9_GenerateMipSubLevels', TEXTURE)).toBe(D3DERR_NOTAVAILABLE);

        // A packed 8-bit word is not a set of linear byte channels: averaging
        // R3G3B2 values directly would produce visibly wrong colour quantisation.
        textureMeta.get(TEXTURE)!.format = 27;
        expect(call('IDirect3DTexture9_SetAutoGenFilterType', TEXTURE, D3DTEXF_LINEAR)).toBe(D3D_OK);
        expect(call('IDirect3DTexture9_GenerateMipSubLevels', TEXTURE)).toBe(D3DERR_NOTAVAILABLE);
    });

    test('resource GenerateMipSubLevels supports R8G8B8', () => {
        const levels = new Map<number, { data: Uint8Array; pitch: number; width: number; height: number }>([
            [0, {
                data: Uint8Array.from([
                    10, 20, 30, 40, 50, 60, 0, 0,
                    70, 80, 90, 100, 110, 120, 0, 0,
                ]),
                pitch: 8,
                width: 2,
                height: 2,
            }],
            [1, { data: new Uint8Array(3), pitch: 3, width: 1, height: 1 }],
        ]);
        const fakeDevice = {
            getTextureLevelPixels: (_texture: number, level: number) => levels.get(level) ?? null,
            setTextureLevelPixels: (_texture: number, level: number, data: Uint8Array, pitch: number) => {
                const destination = levels.get(level);
                if (!destination || pitch !== destination.pitch || data.length < pitch * destination.height) return false;
                destination.data.set(data.subarray(0, destination.data.length));
                return true;
            },
        } as any;
        devices.set(DEVICE, fakeDevice);
        resourceToDevice.set(TEXTURE, fakeDevice);
        textureMeta.set(TEXTURE, { width: 2, height: 2, levels: 2, usage: 0x400, pool: 0, format: 20 });

        const resources = createResourcesExports();
        const call = (name: string, ...args: number[]) => resources[name]!({ esp: 0 }, new Uint8Array(0), args) as number;
        expect(call('IDirect3DTexture9_SetAutoGenFilterType', TEXTURE, D3DTEXF_LINEAR)).toBe(D3D_OK);
        expect(call('IDirect3DTexture9_GenerateMipSubLevels', TEXTURE)).toBe(D3D_OK);
        expect(Array.from(levels.get(1)!.data)).toEqual([55, 65, 75]);
    });

    test('cube GenerateMipSubLevels filters each face independently', () => {
        const faces = new Map<string, { data: Uint8Array; pitch: number; width: number; height: number }>();
        for (let face = 0; face < 6; face++) {
            faces.set(`${face}:0`, {
                data: Uint8Array.from([
                    face, 0, 0, 255, face + 10, 0, 0, 255,
                    face + 20, 0, 0, 255, face + 30, 0, 0, 255,
                ]),
                pitch: 8,
                width: 2,
                height: 2,
            });
            faces.set(`${face}:1`, { data: new Uint8Array(4), pitch: 4, width: 1, height: 1 });
        }
        const fakeDevice = {
            getCubeFacePixels: (_texture: number, face: number, level: number) => faces.get(`${face}:${level}`) ?? null,
            setCubeFacePixels: (_texture: number, face: number, level: number, data: Uint8Array, pitch: number) => {
                const destination = faces.get(`${face}:${level}`);
                if (!destination || pitch !== destination.pitch || data.length < destination.data.length) return false;
                destination.data.set(data.subarray(0, destination.data.length));
                return true;
            },
        } as any;
        devices.set(DEVICE, fakeDevice);
        resourceToDevice.set(TEXTURE, fakeDevice);
        textureMeta.set(TEXTURE, { width: 2, height: 2, levels: 2, usage: 0x400, pool: 0, format: 21, isCube: true });

        const resources = createResourcesExports();
        const call = (name: string, ...args: number[]) => resources[name]!({ esp: 0 }, new Uint8Array(0), args) as number;
        expect(call('IDirect3DCubeTexture9_SetAutoGenFilterType', TEXTURE, D3DTEXF_POINT)).toBe(D3D_OK);
        expect(call('IDirect3DCubeTexture9_GenerateMipSubLevels', TEXTURE)).toBe(D3D_OK);
        for (let face = 0; face < 6; face++) {
            expect(Array.from(faces.get(`${face}:1`)!.data)).toEqual([face, 0, 0, 255]);
        }
    });
});
