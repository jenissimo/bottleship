import { afterEach, beforeEach, expect, test } from 'bun:test';
import { D3D9Device } from '../../src/worker/backends/webgpu/d3d9/d3d9-device';
import { TextureStore } from '../../src/worker/backends/webgpu/d3d9/d3d9-resources';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { createResourcesExports } from '../../src/worker/modules/d3d9/resources';
import { devices, resourceToDevice } from '../../src/worker/modules/d3d9/shared-state';
import { surfaceMeta, textureMeta } from '../../src/worker/modules/d3d9/resource-registry';

const system = System.getInstance();
const originalProcess = system.process;
let memory: Uint8Array;
const BORROWED = 0x2000, SOURCE = 0x100, DEST = 0x200, DEVICE = 0x300;
const pixels = Uint8Array.of(4, 8, 16, 255, 10, 30, 50, 128, 20, 60, 90, 255, 1, 2, 3, 0);
let frees: number[], allocations: number, host: any;

beforeEach(() => {
    memory = new Uint8Array(0x10000); memory.set(pixels, BORROWED);
    frees = []; allocations = 0;
    system.process = {
        getCurrentMemory: () => memory,
        addressSpace: { validateRange: (ptr: number, bytes: number) => ptr >= 0x1000 && ptr + bytes <= memory.length },
        memory: { alloc: () => { allocations++; return 0x4000; }, free: (ptr: number) => frees.push(ptr) },
    } as never;
    Mem.bind(() => memory, (ptr, bytes) => ptr >= 0 && ptr + bytes <= memory.length);
    host = Object.assign(Object.create(D3D9Device.prototype), {
        role: 'front', textures: new TextureStore(), rtCreateLog: [], arenaSamplerBankGeneration: 0,
        mipLevelLocks: new Map(), mipLevelData: new Map(), cubeFaceLocks: new Map(), cubeFaceData: new Map(),
        renderTargetGpuFormats: new Map(), cubeFaceRenderViews: new Map(),
    });
    devices.set(DEVICE, host);
});

afterEach(() => {
    system.process = originalProcess;
    devices.delete(DEVICE);
    for (const ptr of [SOURCE, DEST, SOURCE + 1, DEST + 1]) {
        resourceToDevice.delete(ptr); surfaceMeta.delete(ptr); textureMeta.delete(ptr);
    }
});

test('SYSTEMMEM textures wrap the caller buffer, preserve Lock identity, and never free it', () => {
    expect(host.createTexture(SOURCE, 2, 2, 1, 21, 0, 2, BORROWED)).toBe(BORROWED);
    expect(allocations).toBe(0);
    expect(host.getTextureLevelPixels(SOURCE, 0).data).toEqual(pixels);
    expect(host.lockTexture(SOURCE, 0)).toMatchObject({ ptr: BORROWED, pitch: 8 });
    expect(memory.slice(BORROWED, BORROWED + 16)).toEqual(pixels);
    memory[BORROWED] = 72;
    host.unlockTexture(SOURCE, 0, memory);
    memory[BORROWED + 1] = 84;
    expect(Array.from(host.getTextureLevelPixels(SOURCE, 0).data.slice(0, 2))).toEqual([72, 84]);
    host.releaseTexture(SOURCE);
    expect(frees).toEqual([]);
    expect(memory[BORROWED]).toBe(72);
    host.createTexture(SOURCE, 2, 2, 1, 21, 0, 2);
    host.releaseTexture(SOURCE);
    expect(frees).toEqual([0x4000]);
});

test('UpdateSurface consumes live caller pixels through the wrapped surface', () => {
    host.createTexture(SOURCE, 2, 2, 1, 21, 0, 2, BORROWED);
    host.createTexture(DEST, 2, 2, 1, 21, 0, 0);
    for (const [ptr, pool] of [[SOURCE, 2], [DEST, 0]]) {
        const meta = { width: 2, height: 2, levels: 1, format: 21, usage: 0, pool };
        textureMeta.set(ptr, meta);
        surfaceMeta.set(ptr + 1, { ...meta, type: 1, texturePtr: ptr, level: 0, multiSampleType: 0, multiSampleQuality: 0 });
        resourceToDevice.set(ptr, host); resourceToDevice.set(ptr + 1, host);
    }
    const table = createResourcesExports();
    expect(table.IDirect3DDevice9_UpdateSurface({ esp: 0 } as never, memory, [DEVICE, SOURCE + 1, 0, DEST + 1, 0])).toBe(0);
    expect(host.getTextureLevelPixels(DEST, 0).data).toEqual(pixels);
    memory[BORROWED + 6] = 100;
    expect(table.IDirect3DDevice9_UpdateSurface({ esp: 0 } as never, memory, [DEVICE, SOURCE + 1, 0, DEST + 1, 0])).toBe(0);
    expect(host.getTextureLevelPixels(DEST, 0).data[6]).toBe(100);
});

test('copies into a wrapped texture honor source row pitch and write the original buffer', () => {
    host.createTexture(SOURCE, 2, 2, 1, 21, 0, 2, BORROWED);
    const padded = new Uint8Array(24).fill(99);
    padded.set(pixels.slice(0, 8), 0); padded.set(pixels.slice(8), 12);
    expect(host.setTextureLevelPixels(SOURCE, 0, padded, 12)).toBeTrue();
    expect(memory.slice(BORROWED, BORROWED + 16)).toEqual(pixels);
    expect(memory[BORROWED + 16]).toBe(0);
});

test('wrapped storage re-derives guest memory after the process view changes', () => {
    host.createTexture(SOURCE, 2, 2, 1, 21, 0, 2, BORROWED);
    host.getTextureLevelPixels(SOURCE, 0);
    const grown = new Uint8Array(0x20000);
    grown.set(memory);
    grown[BORROWED + 1] = 77;
    memory = grown;
    expect(host.getTextureLevelPixels(SOURCE, 0).data[1]).toBe(77);
    expect(host.lockTexture(SOURCE, 0).ptr).toBe(BORROWED);
    expect(memory[BORROWED + 1]).toBe(77);
});

test('split GPU readback publishes pixels into the original caller buffer', async () => {
    host.createTexture(SOURCE, 2, 2, 1, 21, 0, 2, BORROWED);
    host.createTexture(DEST, 2, 2, 1, 21, 1, 0);
    const rendered = pixels.map((value) => value ^ 0xff);
    host.splitFetchTexture = async () => ({ data: rendered, answer: 0 });
    expect(await host.readTextureIntoGuestTexture(DEST, SOURCE)).toBe(0);
    expect(memory.slice(BORROWED, BORROWED + 16)).toEqual(rendered);
    expect(host.getTextureLevelPixels(SOURCE, 0).data).toEqual(rendered);
    expect(memory[BORROWED + 16]).toBe(0);
});

test('CreateTexture rejects unsupported wrapping contracts and validates the whole borrowed extent', () => {
    const handler = createResourcesExports().IDirect3DDevice9_CreateTexture;
    Mem.writeUint32(0x1000, BORROWED);
    const invoke = (levels: number, usage: number, pool: number, format = 21) =>
        handler({ esp: 0 } as never, memory, [DEVICE, 2, 2, levels, usage, format, pool, 0x1010, 0x1000]);
    for (const [levels, usage, pool, format] of [[0, 0, 2, 21], [2, 0, 2, 21], [1, 0, 1, 21], [1, 0, 0, 21], [1, 0x200, 2, 21], [1, 0, 2, 0x31545844]]) {
        expect(invoke(levels, usage, pool, format)).toBe(0x8876086c);
    }
    Mem.writeUint32(0x1000, memory.length - 8);
    expect(invoke(1, 0, 2)).toBe(0x8876086c);
    expect(Mem.readUint32(0x1010)).toBe(0);
    expect(allocations).toBe(0);
});
