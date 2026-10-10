import { afterAll, beforeAll, expect, test } from 'bun:test';
import { D3D9Device } from '../../src/worker/backends/webgpu/d3d9/d3d9-device';
import { TextureStore } from '../../src/worker/backends/webgpu/d3d9/d3d9-resources';
import { D3DFMT_A16B16G16R16 } from '../../src/worker/backends/webgpu/shared/texture-formats';
import { makeD3D9Unorm16Upload, normalized16TexturePolicy } from '../../src/worker/backends/webgpu/shared/unorm16-texture-policy';

const globals = globalThis as { GPUTextureUsage?: unknown };
const originalUsage = globals.GPUTextureUsage;
beforeAll(() => { globals.GPUTextureUsage = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4 }; });
afterAll(() => { globals.GPUTextureUsage = originalUsage; });

function fixture(features = ['float32-filterable']) {
    const writes: Array<{ format: string; level: number; face: number; pitch: number; data: Uint8Array }> = [];
    const gpu = {
        features: new Set(features),
        createTexture: (descriptor: GPUTextureDescriptor) => ({
            format: descriptor.format, mipLevelCount: descriptor.mipLevelCount,
            createView: () => ({}), destroy: () => {},
        }),
    };
    const host = Object.assign(Object.create(D3D9Device.prototype), {
        textures: new TextureStore(4), mipLevelData: new Map(), cubeFaceData: new Map(),
        volumeByIndex: new Map(), gpuResourceGeneration: 0, arenaSamplerBankGeneration: 0,
        frameSnapshot: { frameCounters: { uploads: 0, textureBytes: 0 } },
        backend: {
            getDevice: () => gpu,
            getQueue: () => ({ writeTexture: (destination: any, data: Uint8Array, layout: any) => {
                writes.push({ format: destination.texture.format, level: destination.mipLevel ?? 0,
                    face: destination.origin?.z ?? 0, pitch: layout.bytesPerRow, data: data.slice() });
            } }),
        },
    });
    return { host, writes };
}

const texel = new Uint8Array(8);
new DataView(texel.buffer).setUint16(0, 1, true);
new DataView(texel.buffer).setUint16(2, 128, true);
new DataView(texel.buffer).setUint16(4, 257, true);
new DataView(texel.buffer).setUint16(6, 65535, true);
const expandedTexel = [Math.fround(1 / 65535), Math.fround(128 / 65535), Math.fround(257 / 65535), 1];

test('UNORM16 textures preserve dim channels through mip uploads and managed restoration', () => {
    const { host, writes } = fixture();
    const index = host.textures.create(1, 2, 2, 2, D3DFMT_A16B16G16R16, -1, 1);
    const base = host.textures.getData(index) as Uint8Array;
    for (let offset = 0; offset < 32; offset += 8) base.set(texel, offset);
    host.mipLevelData.set('1:1', texel.slice());
    host.ensureTexture(index);
    expect(writes).toHaveLength(2);
    expect(writes.map(write => write.format)).toEqual(['rgba32float', 'rgba32float']);
    expect([...new Float32Array(writes[0]!.data.buffer, 0, 8)]).toEqual([...expandedTexel, ...expandedTexel]);
    expect([...new Float32Array(writes[0]!.data.buffer, writes[0]!.pitch, 8)]).toEqual([...expandedTexel, ...expandedTexel]);
    expect([...new Float32Array(writes[1]!.data.buffer, 0, 4)]).toEqual(expandedTexel);
    expect(host.frameSnapshot.frameCounters.textureBytes).toBe(80);
    host.ensureTexture(index);
    expect(writes).toHaveLength(2);
    host.textures.dropGpuResources();
    host.ensureTexture(index);
    expect(writes).toHaveLength(4);
    expect(writes[2]!.data).toEqual(writes[0]!.data);
    expect(writes[3]!.data).toEqual(writes[1]!.data);
});

test('UNORM16 cube faces use the same filterable storage and upload layout', () => {
    const { host, writes } = fixture();
    const index = host.textures.create(2, 1, 1, 1, D3DFMT_A16B16G16R16, -1, 1);
    host.textures.markCube(index);
    for (let face = 0; face < 6; face++) host.cubeFaceData.set(`2:${face}:0`, texel.slice());
    host.ensureTexture(index);
    expect(writes).toHaveLength(6);
    expect(writes.map(write => write.face)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const write of writes) {
        expect(write.format).toBe('rgba32float');
        expect([...new Float32Array(write.data.buffer, 0, 4)]).toEqual(expandedTexel);
    }
    expect(host.frameSnapshot.frameCounters.textureBytes).toBe(6 * 256);
});

test('texture format tiers do not make UNORM16 filterable', () => {
    expect(normalized16TexturePolicy(new Set(['texture-formats-tier1', 'texture-formats-tier2']))).toBeNull();
    const { host, writes } = fixture(['texture-formats-tier1', 'texture-formats-tier2', 'float32-filterable']);
    const index = host.textures.create(3, 1, 1, 1, D3DFMT_A16B16G16R16, -1, 1);
    host.textures.getData(index).set(texel);
    host.ensureTexture(index);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.format).toBe('rgba32float');
    expect([...new Float32Array(writes[0]!.data.buffer, 0, 4)])
        .toEqual([Math.fround(1 / 65535), Math.fround(128 / 65535), Math.fround(257 / 65535), 1]);
});

test('float expansion round-trips all 65536 UNORM16 codes without merging adjacent values', () => {
    const source = new Uint16Array(65536);
    for (let i = 0; i < source.length; i++) source[i] = i;
    const packed = makeD3D9Unorm16Upload(new Uint8Array(source.buffer), 16384, 1, source.byteLength, 'rgba32float')!;
    const values = new Float32Array(packed.data.buffer);
    let mismatches = 0;
    for (let i = 0; i < source.length; i++) {
        if (Math.round(values[i]! * 65535) !== i) mismatches++;
    }
    expect(values[0]).toBe(0);
    expect(values[65535]).toBe(1);
    expect(mismatches).toBe(0);
});
