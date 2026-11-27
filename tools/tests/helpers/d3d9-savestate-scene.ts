import type { Rig } from "./d3d9-savestate-rig";
import { d3d9SplitFlush } from "../../../src/worker/modules/d3d9/split";
import { OUT_ADDR } from "./d3d9-savestate-rig";

const SCRATCH = 0x3000;
export const D3DFMT_A8R8G8B8 = 21;

export interface Scene {
    vb: number;
    vbDefault: number;
    ib: number;
    tex: number;
    rtTex: number;
    rtSurface: number;
    cube: number;
    volume: number;
    vs: number;
    ps: number;
    decl: number;
    block: number;
    allBlock: number;
    query: number;
}

const f32 = (mem: Uint8Array, at: number, values: number[]): void => {
    const dv = new DataView(mem.buffer);
    values.forEach((v, i) => dv.setFloat32(at + i * 4, v, true));
};

const u32 = (mem: Uint8Array, at: number, values: number[]): void => {
    const dv = new DataView(mem.buffer);
    values.forEach((v, i) => dv.setUint32(at + i * 4, v >>> 0, true));
};

export const reg = (type: number, num: number, mask = 0xf): number =>
    (num & 0x7ff) | ((mask & 0xf) << 16) | ((type & 7) << 28) | (((type >>> 3) & 3) << 11);

export const VS_TOKENS = [0xfffe0200, (2 << 24) | 31, 0, reg(1, 0), (2 << 24) | 1, reg(4, 0), reg(1, 0, 0) | (0xe4 << 16), 0x0000ffff];
export const PS_TOKENS = [0xffff0200, (2 << 24) | 1, reg(8, 0), reg(2, 0, 0) | (0xe4 << 16), 0x0000ffff];

export async function ok(rig: Rig, name: string, ...args: number[]): Promise<void> {
    const hr = await rig.call(name, ...args);
    if (hr !== 0) throw new Error(`${name} failed with 0x${(hr >>> 0).toString(16)}`);
}

async function made(rig: Rig, name: string, ...args: number[]): Promise<number> {
    await ok(rig, name, ...args);
    return rig.u32(OUT_ADDR);
}

const O = OUT_ADDR;

export async function buildScene(rig: Rig): Promise<Scene> {
    const { mem, devicePtr: dev } = rig;
    const at = (n: number): number => SCRATCH + n * 0x100;

    const vb = await made(rig, "IDirect3DDevice9_CreateVertexBuffer", dev, 256, 0, 0x112, 1, O, 0);
    await ok(rig, "IDirect3DVertexBuffer9_Lock", vb, 0, 0, OUT_ADDR, 0);
    for (let i = 0; i < 256; i++) mem[rig.u32(OUT_ADDR) + i] = (i * 3 + 1) & 0xff;
    await ok(rig, "IDirect3DVertexBuffer9_Unlock", vb);
    const vbDefault = await made(rig, "IDirect3DDevice9_CreateVertexBuffer", dev, 64, 0x208, 0x2, 0, O, 0);
    await ok(rig, "IDirect3DVertexBuffer9_Lock", vbDefault, 0, 0, OUT_ADDR, 0);
    for (let i = 0; i < 64; i++) mem[rig.u32(OUT_ADDR) + i] = 0xa0 + (i & 7);
    await ok(rig, "IDirect3DVertexBuffer9_Unlock", vbDefault);

    const ib = await made(rig, "IDirect3DDevice9_CreateIndexBuffer", dev, 64, 0, 101, 1, O, 0);
    await ok(rig, "IDirect3DIndexBuffer9_Lock", ib, 0, 0, OUT_ADDR, 0);
    for (let i = 0; i < 64; i++) mem[rig.u32(OUT_ADDR) + i] = i + 7;
    await ok(rig, "IDirect3DIndexBuffer9_Unlock", ib);

    const tex = await made(rig, "IDirect3DDevice9_CreateTexture", dev, 4, 4, 3, 0, D3DFMT_A8R8G8B8, 1, O, 0);
    for (const level of [0, 1]) {
        await ok(rig, "IDirect3DTexture9_LockRect", tex, level, at(0), 0, 0);
        const bits = rig.u32(at(0) + 4);
        for (let i = 0; i < 16 >> (level * 2); i++) mem.set([level * 40 + i, 2 * i, 3 * i, 255], bits + i * 4);
        await ok(rig, "IDirect3DTexture9_UnlockRect", tex, level);
    }

    const rtTex = await made(rig, "IDirect3DDevice9_CreateTexture", dev, 8, 8, 1, 1, D3DFMT_A8R8G8B8, 0, O, 0);
    const rtSurface = await made(rig, "IDirect3DTexture9_GetSurfaceLevel", rtTex, 0, O);
    d3d9SplitFlush();
    const rtGpu = rig.gpu.textures[rig.gpu.textures.length - 1]!;
    for (let i = 0; i < 64; i++) rtGpu.data.set([i, 100 + i, 200 - i, 255], i * 4);
    await ok(rig, "IDirect3DDevice9_SetRenderTarget", dev, 1, rtSurface);

    const cube = await made(rig, "IDirect3DDevice9_CreateCubeTexture", dev, 4, 1, 0, D3DFMT_A8R8G8B8, 1, O, 0);
    for (let face = 0; face < 6; face++) {
        await ok(rig, "IDirect3DCubeTexture9_LockRect", cube, face, 0, at(1), 0, 0);
        mem.fill(0x10 + face, rig.u32(at(1) + 4), rig.u32(at(1) + 4) + 64);
        await ok(rig, "IDirect3DCubeTexture9_UnlockRect", cube, face, 0);
    }

    const volume = await made(rig, "IDirect3DDevice9_CreateVolumeTexture", dev, 4, 4, 2, 1, 0, D3DFMT_A8R8G8B8, 1, O, 0);
    await ok(rig, "IDirect3DVolumeTexture9_LockBox", volume, 0, at(2), 0, 0);
    mem.fill(0x77, rig.u32(at(2) + 8), rig.u32(at(2) + 8) + 128);
    await ok(rig, "IDirect3DVolumeTexture9_UnlockBox", volume, 0);

    u32(mem, at(3), VS_TOKENS);
    const vs = await made(rig, "IDirect3DDevice9_CreateVertexShader", dev, at(3), O);
    u32(mem, at(4), PS_TOKENS);
    const ps = await made(rig, "IDirect3DDevice9_CreatePixelShader", dev, at(4), O);
    const dv = new DataView(mem.buffer);
    dv.setUint16(at(5), 0, true); dv.setUint16(at(5) + 2, 0, true);
    mem[at(5) + 4] = 3; mem[at(5) + 5] = 0; mem[at(5) + 6] = 0; mem[at(5) + 7] = 0;
    dv.setUint16(at(5) + 8, 0, true); dv.setUint16(at(5) + 10, 16, true);
    mem[at(5) + 12] = 4; mem[at(5) + 13] = 0; mem[at(5) + 14] = 10; mem[at(5) + 15] = 0;
    dv.setUint16(at(5) + 16, 0xff, true); mem[at(5) + 20] = 17;
    const decl = await made(rig, "IDirect3DDevice9_CreateVertexDeclaration", dev, at(5), O);

    await ok(rig, "IDirect3DDevice9_SetRenderState", dev, 7, 0);
    await ok(rig, "IDirect3DDevice9_SetRenderState", dev, 27, 1);
    await ok(rig, "IDirect3DDevice9_SetRenderState", dev, 19, 5);
    await ok(rig, "IDirect3DDevice9_SetRenderState", dev, 22, 2);
    await ok(rig, "IDirect3DDevice9_SetRenderState", dev, 154, 0x40000000);
    await ok(rig, "IDirect3DDevice9_SetSamplerState", dev, 0, 5, 2);
    await ok(rig, "IDirect3DDevice9_SetSamplerState", dev, 3, 1, 3);
    await ok(rig, "IDirect3DDevice9_SetTextureStageState", dev, 0, 1, 4);
    await ok(rig, "IDirect3DDevice9_SetTextureStageState", dev, 2, 24, 3);
    f32(mem, at(6), [1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 3, 0, 4, 5, 6, 1]);
    await ok(rig, "IDirect3DDevice9_SetTransform", dev, 0x100, at(6));
    await ok(rig, "IDirect3DDevice9_SetTransform", dev, 16, at(6));
    f32(mem, at(7), [0.1, 0.2, 0.3, 1, 0.4, 0.5, 0.6, 1, 0.7, 0.8, 0.9, 1, 0.2, 0.1, 0.05, 1, 16]);
    await ok(rig, "IDirect3DDevice9_SetMaterial", dev, at(7));
    f32(mem, at(8), new Array(26).fill(0).map((_u, i) => i / 10));
    u32(mem, at(8), [1]);
    await ok(rig, "IDirect3DDevice9_SetLight", dev, 2, at(8));
    await ok(rig, "IDirect3DDevice9_LightEnable", dev, 2, 1);
    f32(mem, at(9), [0, 1, 0, 0.5]);
    await ok(rig, "IDirect3DDevice9_SetClipPlane", dev, 1, at(9));
    u32(mem, at(10), [4, 6, 40, 30]);
    f32(mem, at(10) + 16, [0.25, 0.75]);
    await ok(rig, "IDirect3DDevice9_SetViewport", dev, at(10));
    u32(mem, at(11), [1, 2, 33, 21]);
    await ok(rig, "IDirect3DDevice9_SetScissorRect", dev, at(11));
    await ok(rig, "IDirect3DDevice9_SetVertexShader", dev, vs);
    await ok(rig, "IDirect3DDevice9_SetPixelShader", dev, ps);
    await ok(rig, "IDirect3DDevice9_SetVertexDeclaration", dev, decl);
    await ok(rig, "IDirect3DDevice9_SetStreamSource", dev, 0, vb, 8, 32);
    await ok(rig, "IDirect3DDevice9_SetStreamSource", dev, 2, vbDefault, 0, 16);
    await ok(rig, "IDirect3DDevice9_SetStreamSourceFreq", dev, 2, 0x40000002);
    await ok(rig, "IDirect3DDevice9_SetIndices", dev, ib);
    await ok(rig, "IDirect3DDevice9_SetTexture", dev, 0, tex);
    await ok(rig, "IDirect3DDevice9_SetTexture", dev, 1, cube);
    await ok(rig, "IDirect3DDevice9_SetTexture", dev, 2, volume);
    f32(mem, at(12), new Array(16).fill(0).map((_u, i) => i * 0.5 + 1));
    await ok(rig, "IDirect3DDevice9_SetVertexShaderConstantF", dev, 4, at(12), 4);
    await ok(rig, "IDirect3DDevice9_SetPixelShaderConstantF", dev, 1, at(12), 2);
    u32(mem, at(13), [1, 2, 3, 4]);
    await ok(rig, "IDirect3DDevice9_SetVertexShaderConstantI", dev, 1, at(13), 1);
    await ok(rig, "IDirect3DDevice9_SetPixelShaderConstantI", dev, 2, at(13), 1);
    u32(mem, at(14), [1, 0, 1]);
    await ok(rig, "IDirect3DDevice9_SetVertexShaderConstantB", dev, 2, at(14), 3);
    await ok(rig, "IDirect3DDevice9_SetPixelShaderConstantB", dev, 0, at(14), 2);
    await ok(rig, "IDirect3DDevice9_SetNPatchMode", dev, 0x40000000);

    await ok(rig, "IDirect3DDevice9_BeginStateBlock", dev);
    await ok(rig, "IDirect3DDevice9_SetRenderState", dev, 14, 0);
    await ok(rig, "IDirect3DDevice9_SetRenderState", dev, 28, 1);
    const block = await made(rig, "IDirect3DDevice9_EndStateBlock", dev, O);
    const allBlock = await made(rig, "IDirect3DDevice9_CreateStateBlock", dev, 1, O);
    const query = await made(rig, "IDirect3DDevice9_CreateQuery", dev, 8, O);

    await rig.call("IDirect3DVertexBuffer9_AddRef", vb);
    await rig.call("IDirect3DVertexBuffer9_AddRef", vb);
    await rig.call("IDirect3DTexture9_AddRef", tex);
    return { vb, vbDefault, ib, tex, rtTex, rtSurface, cube, volume, vs, ps, decl, block, allBlock, query };
}

export interface Extras {
    chain: number;
    plain: number;
    renderTarget: number;
    backBuffer: number;
    volumeLevel: number;
    occlusion: number;
    validator: number;
}

const GUID = 0x5000;

export async function buildExtras(rig: Rig, scene: Scene): Promise<Extras> {
    const { mem, devicePtr: dev } = rig;
    const at = (n: number): number => 0x7000 + n * 0x100;
    writePresentParamsWindowed(mem, at(0), 32, 32);
    const chain = await made(rig, "IDirect3DDevice9_CreateAdditionalSwapChain", dev, at(0), O);
    const plain = await made(rig, "IDirect3DDevice9_CreateOffscreenPlainSurface", dev, 16, 16, D3DFMT_A8R8G8B8, 2, O, 0);
    await ok(rig, "IDirect3DSurface9_LockRect", plain, at(1), 0, 0);
    mem.fill(0x5a, rig.u32(at(1) + 4), rig.u32(at(1) + 4) + 256);
    await ok(rig, "IDirect3DSurface9_UnlockRect", plain);
    const renderTarget = await made(rig, "IDirect3DDevice9_CreateRenderTarget", dev, 16, 16, D3DFMT_A8R8G8B8, 0, 0, 1, O, 0);
    d3d9SplitFlush();
    const rtGpu = rig.gpu.textures[rig.gpu.textures.length - 1]!;
    for (let i = 0; i < 256; i++) rtGpu.data.set([i, 255 - i, i >> 1, 255], i * 4);
    await ok(rig, "IDirect3DDevice9_SetRenderTarget", dev, 2, renderTarget);
    const backBuffer = await made(rig, "IDirect3DDevice9_GetBackBuffer", dev, 0, 0, 0, O);
    const volumeLevel = await made(rig, "IDirect3DVolumeTexture9_GetVolumeLevel", scene.volume, 0, O);
    const occlusion = await made(rig, "IDirect3DDevice9_CreateQuery", dev, 4, O);
    const validator = await rig.call("Direct3DShaderValidatorCreate9") as number;

    mem.set([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], GUID);
    mem.set([9, 8, 7, 6], at(2));
    await ok(rig, "IDirect3DTexture9_SetPrivateData", scene.tex, GUID, at(2), 4, 0);
    await rig.call("IDirect3DTexture9_SetPriority", scene.tex, 5);
    await rig.call("IDirect3DTexture9_SetLOD", scene.tex, 2);
    const ramp = new DataView(mem.buffer);
    for (let i = 0; i < 768; i++) ramp.setUint16(at(3) + i * 2, (i * 83) & 0xffff, true);
    await ok(rig, "IDirect3DDevice9_SetGammaRamp", dev, 0, 0, at(3));
    u32(mem, at(4), [5, 0xfffffff0]);
    await ok(rig, "IDirect3DDevice9_SetClipStatus", dev, at(4));
    for (let i = 0; i < 256; i++) ramp.setUint32(at(5) + i * 4, 0xff000000 | (i * 0x010203), true);
    await ok(rig, "IDirect3DDevice9_SetPaletteEntries", dev, 3, at(5));
    await ok(rig, "IDirect3DDevice9_SetCurrentTexturePalette", dev, 3);
    await ok(rig, "IDirect3DDevice9_SetDialogBoxMode", dev, 1);
    await ok(rig, "IDirect3DDevice9_SetSoftwareVertexProcessing", dev, 1);
    f32(mem, at(6), [1, 2, 3, 4, 5, 6, 7, 8]);
    await ok(rig, "IDirect3DDevice9_SetVertexShaderConstantF", dev, 300, at(6), 2);
    u32(mem, at(7), [7, 7, 7, 7]);
    await ok(rig, "IDirect3DDevice9_SetVertexShaderConstantI", dev, 40, at(7), 1);
    u32(mem, at(8), [1, 1]);
    await ok(rig, "IDirect3DDevice9_SetVertexShaderConstantB", dev, 100, at(8), 2);
    await ok(rig, "IDirect3DDevice9_SetSoftwareVertexProcessing", dev, 0);
    return { chain, plain, renderTarget, backBuffer, volumeLevel, occlusion, validator };
}

function writePresentParamsWindowed(mem: Uint8Array, at: number, w: number, h: number): void {
    const dv = new DataView(mem.buffer);
    mem.fill(0, at, at + 56);
    dv.setUint32(at + 0, w, true);
    dv.setUint32(at + 4, h, true);
    dv.setUint32(at + 8, 22, true);
    dv.setUint32(at + 12, 1, true);
    dv.setUint32(at + 24, 1, true);
    dv.setUint32(at + 28, 0x5000, true);
    dv.setUint32(at + 32, 1, true);
}
