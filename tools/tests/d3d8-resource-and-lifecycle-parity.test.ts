/**
 * D3D8 resource/state-block parity tests — see docs/d3d8-parity/05-resources-formats-caps.md
 * (§3.3 CopyRects, §3.4 UpdateTexture) and docs/d3d8-parity/06-device-lifecycle.md (F2/F3
 * state-block membership). Each test is written to FAIL against the pre-fix code, not just
 * pass against the fixed code — see the inline notes on what the old behaviour would do.
 *
 * State-block tests exercise captureD3D8StateToEntries/applyD3D8StateBlockEntries directly
 * against a minimal duck-typed device (only the methods those two functions actually call —
 * a real D3D8DeviceAdapter needs a live WebGPU/guest-memory context this suite doesn't have).
 *
 * CopyRects/UpdateTexture tests exercise the real exported thunk handlers from resources.ts
 * against the shared-state module's own Maps (surfaceInfo/resourceToDevice/textureMeta/
 * textureLevelSurfaces) — the same singletons the handlers use in production — with a fake
 * `System.process` supplying real guest-memory bytes so the copy paths execute for real.
 */
import { describe, expect, test, afterEach } from "bun:test";
import {
    D3DSBT_ALL,
    D3DSBT_PIXELSTATE,
    D3DSBT_VERTEXSTATE,
    captureD3D8StateToEntries,
    applyD3D8StateBlockEntries,
    type D3D8StateBlockEntry,
} from "../../src/worker/backends/webgpu/d3d8/d3d8-state-block";
import { createResourcesExports } from "../../src/worker/modules/d3d8/resources";
import {
    surfaceInfo,
    resourceToDevice,
    textureMeta,
    textureLevelSurfaces,
    type D3D8SurfaceInfo,
} from "../../src/worker/modules/d3d8/shared-state";
import { createRenderTarget, createTextureSurface } from "../../src/worker/backends/webgpu/shared/surface-factory";
import { System } from "../../src/worker/core/system";
import type { D3D8DeviceAdapter } from "../../src/worker/backends/webgpu/d3d8/d3d8-device-adapter";

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_R5G6B5 = 23;
const D3DFMT_X1R5G5B5 = 24;
const D3DFMT_D24S8 = 75;
const D3DFMT_X8R8G8B8 = 22;

// ---------------------------------------------------------------------------------------
// State-block membership tables (F2/F3)
// ---------------------------------------------------------------------------------------

/** Minimal duck-typed stand-in for D3D8DeviceAdapter — only what capture/apply touch. */
class FakeD3D8Device {
    renderStates: number[] = new Array(256).fill(0);
    tss: number[][] = Array.from({ length: 8 }, () => new Array(32).fill(0));
    textureComPtrs: number[] = new Array(8).fill(0);
    texSurfaces: Map<number, unknown> = new Map();
    streams: { vb: number; stride: number }[] = Array.from({ length: 16 }, () => ({ vb: 0, stride: 0 }));
    transforms: Map<number, Float32Array> = new Map();
    lights: Map<number, unknown> = new Map();
    enabledLights = new Set<number>();
    clipPlanes: Map<number, Float32Array> = new Map();
    material: unknown = { diffuse: { r: 0, g: 0, b: 0, a: 0 }, ambient: { r: 0, g: 0, b: 0, a: 0 }, specular: { r: 0, g: 0, b: 0, a: 0 }, emissive: { r: 0, g: 0, b: 0, a: 0 }, power: 0 };
    vertexToken = 0;
    pixelShaderHandle = 0;
    indexIB = 0;
    baseVertexIndex = 0;
    viewport = { x: 0, y: 0, width: 640, height: 480, minZ: 0, maxZ: 1 };
    shaders = {
        psConstants: new Float32Array(32),
        vsConstants: new Float32Array(96),
        setVertexShaderConstantFromArray(_start: number, _data: Float32Array): void { /* not exercised here */ },
        setPixelShaderConstantFromArray(_start: number, _data: Float32Array): void { /* not exercised here */ },
    };

    getRenderState(state: number): number { return this.renderStates[state] ?? 0; }
    setRenderState(state: number, value: number): void { this.renderStates[state] = value; }
    getTextureStageState(stage: number, type: number): number { return this.tss[stage]?.[type] ?? 0; }
    setTextureStageState(stage: number, type: number, value: number): void { this.tss[stage]![type] = value; }
    getTextureComPtr(stage: number): number { return this.textureComPtrs[stage] ?? 0; }
    setTexture(stage: number, _surface: unknown, texPtr: number): void { this.textureComPtrs[stage] = texPtr; }
    getStreamSource(stream: number): { vb: number; stride: number } { return this.streams[stream] ?? { vb: 0, stride: 0 }; }
    setStreamSource(stream: number, vb: number, stride: number): void { this.streams[stream] = { vb, stride }; }
    getAllTransforms(): { state: number; matrix: Float32Array }[] { return [...this.transforms.entries()].map(([state, matrix]) => ({ state, matrix })); }
    setTransform(state: number, matrix: Float32Array): void { this.transforms.set(state, matrix); }
    getMaterial(): unknown { return this.material; }
    setMaterial(mat: unknown): void { this.material = mat; }
    getAllLights(): { index: number; light: unknown }[] { return [...this.lights.entries()].map(([index, light]) => ({ index, light })); }
    setLight(index: number, light: unknown): void { this.lights.set(index, light); }
    getEnabledLightIndices(): number[] { return [...this.enabledLights]; }
    lightEnable(index: number, enable: boolean): void { if (enable) this.enabledLights.add(index); else this.enabledLights.delete(index); }
    getAllClipPlanes(): { index: number; plane: Float32Array }[] { return [...this.clipPlanes.entries()].map(([index, plane]) => ({ index, plane })); }
    setClipPlane(index: number, plane: Float32Array): void { this.clipPlanes.set(index, plane); }
    getActiveVertexToken(): number { return this.vertexToken; }
    setFVF(token: number): void { this.vertexToken = token; }
    setVertexShaderHandle(token: number): number { this.vertexToken = token; return D3D_OK; }
    getPixelShaderHandle(): number { return this.pixelShaderHandle; }
    setPixelShader(handle: number): number { this.pixelShaderHandle = handle; return D3D_OK; }
}

function renderStatesOf(entries: D3D8StateBlockEntry[]): Set<number> {
    return new Set(entries.filter((e): e is Extract<D3D8StateBlockEntry, { op: "renderState" }> => e.op === "renderState").map((e) => e.state));
}

function tssTypesOf(entries: D3D8StateBlockEntry[], stage: number): Set<number> {
    return new Set(
        entries
            .filter((e): e is Extract<D3D8StateBlockEntry, { op: "textureStageState" }> => e.op === "textureStageState" && e.stage === stage)
            .map((e) => e.type),
    );
}

describe("D3D8 state-block membership (D3DSBT_VERTEXSTATE / D3DSBT_PIXELSTATE)", () => {
    test("D3DSBT_VERTEXSTATE captures vertex render states, not pixel-only ones", () => {
        const fake = new FakeD3D8Device();
        const entries = captureD3D8StateToEntries(fake as unknown as D3D8DeviceAdapter, D3DSBT_VERTEXSTATE);
        const states = renderStatesOf(entries);

        // D3DRS_LIGHTING(137)/CLIPPING(136) are the exact states F2 calls out as silently
        // dropped by a VERTEXSTATE snapshot under the old single-boolean gate.
        expect(states.has(137)).toBe(true);  // LIGHTING
        expect(states.has(136)).toBe(true);  // CLIPPING
        expect(states.has(22)).toBe(true);   // CULLMODE

        // Pixel-only states must NOT leak into a VERTEXSTATE capture (the old code's
        // PIXELSTATE over-capture bug, checked from the other side below).
        expect(states.has(27)).toBe(false);  // ALPHABLENDENABLE
        expect(states.has(15)).toBe(false);  // ALPHATESTENABLE
    });

    test("D3DSBT_PIXELSTATE captures pixel render states, not vertex-only ones", () => {
        const fake = new FakeD3D8Device();
        const entries = captureD3D8StateToEntries(fake as unknown as D3D8DeviceAdapter, D3DSBT_PIXELSTATE);
        const states = renderStatesOf(entries);

        expect(states.has(27)).toBe(true);   // ALPHABLENDENABLE
        expect(states.has(15)).toBe(true);   // ALPHATESTENABLE
        expect(states.has(60)).toBe(true);   // TEXTUREFACTOR

        // Vertex-only render states (the ones an ApplyStateBlock(PIXELSTATE) must NOT
        // clobber — F2's "over-capture" half of the bug) must be absent.
        expect(states.has(137)).toBe(false); // LIGHTING
        expect(states.has(136)).toBe(false); // CLIPPING
    });

    test("D3DTSS_TEXCOORDINDEX/TEXTURETRANSFORMFLAGS are captured by VERTEXSTATE; D3DTSS_COLOROP is not", () => {
        const fake = new FakeD3D8Device();
        const entries = captureD3D8StateToEntries(fake as unknown as D3D8DeviceAdapter, D3DSBT_VERTEXSTATE);
        const stage0 = tssTypesOf(entries, 0);

        expect(stage0.has(11)).toBe(true);  // D3DTSS_TEXCOORDINDEX
        expect(stage0.has(24)).toBe(true);  // D3DTSS_TEXTURETRANSFORMFLAGS
        expect(stage0.has(1)).toBe(false);  // D3DTSS_COLOROP is pixel-group only
    });

    test("D3DSBT_ALL still captures the union (both groups present)", () => {
        const fake = new FakeD3D8Device();
        const entries = captureD3D8StateToEntries(fake as unknown as D3D8DeviceAdapter, D3DSBT_ALL);
        const states = renderStatesOf(entries);
        expect(states.has(137)).toBe(true);
        expect(states.has(27)).toBe(true);
    });
});

describe("D3D8 state-block NULL-member capture/restore (F3)", () => {
    test("D3DSBT_ALL records every texture stage and stream, including unbound ones", () => {
        const fake = new FakeD3D8Device();
        fake.textureComPtrs[0] = 0x1234; // stage 0 bound
        // stage 1..7 stay 0 (unbound)
        fake.streams[0] = { vb: 0x5678, stride: 32 };
        // stream 1..15 stay unbound

        const entries = captureD3D8StateToEntries(fake as unknown as D3D8DeviceAdapter, D3DSBT_ALL);
        const texEntries = entries.filter((e): e is Extract<D3D8StateBlockEntry, { op: "texture" }> => e.op === "texture");
        const streamEntries = entries.filter((e): e is Extract<D3D8StateBlockEntry, { op: "streamSource" }> => e.op === "streamSource");

        // Old code: `if (texPtr !== 0) entries.push(...)` / `if (src.vb !== 0) entries.push(...)`
        // — only the BOUND slots got an entry, so this would be 1, not 8 (and 1, not 16).
        expect(texEntries.length).toBe(8);
        expect(streamEntries.length).toBe(16);

        const stage1 = texEntries.find((e) => e.stage === 1);
        expect(stage1).toBeDefined();
        expect(stage1!.texPtr).toBe(0);
    });

    test("ApplyStateBlock restores a stage/stream back to NULL even if it was unbound at Capture time", () => {
        const fake = new FakeD3D8Device();
        // Capture with stage 1 / stream 1 unbound.
        const entries = captureD3D8StateToEntries(fake as unknown as D3D8DeviceAdapter, D3DSBT_ALL);

        // Something else binds stage 1 / stream 1 after Capture, before Apply.
        fake.texSurfaces.set(0x9999, {});
        fake.setTexture(1, fake.texSurfaces.get(0x9999), 0x9999);
        fake.setStreamSource(1, 0x8888, 16);
        expect(fake.textureComPtrs[1]).toBe(0x9999);
        expect(fake.streams[1]!.vb).toBe(0x8888);

        applyD3D8StateBlockEntries(fake as unknown as D3D8DeviceAdapter, entries);

        // Old code never recorded a stage-1/stream-1 entry at all, so Apply would leave
        // whatever got bound in between untouched — this is the exact bug F3 describes.
        expect(fake.textureComPtrs[1]).toBe(0);
        expect(fake.streams[1]!.vb).toBe(0);
    });
});

// ---------------------------------------------------------------------------------------
// CopyRects (§3.3) / UpdateTexture (§3.4)
// ---------------------------------------------------------------------------------------

const resources = createResourcesExports();

/** Fake process installed on the real System singleton so resources.ts's
 *  `System.getInstance().process.getCurrentMemory()` reads real bytes. */
function withFakeGuestMemory<T>(size: number, fn: (mem: Uint8Array) => T): T {
    const mem = new Uint8Array(size);
    const prevProcess = System.getInstance().process;
    (System.getInstance() as unknown as { process: unknown }).process = {
        getCurrentMemory: () => mem,
        memory: { alloc: () => { throw new Error("not mocked — test should not need alloc"); } },
    };
    try {
        return fn(mem);
    } finally {
        (System.getInstance() as unknown as { process: unknown }).process = prevProcess;
    }
}

const usedPtrs: number[] = [];
function trackedInfo(ptr: number, info: D3D8SurfaceInfo): void {
    surfaceInfo.set(ptr, info);
    usedPtrs.push(ptr);
}
afterEach(() => {
    for (const ptr of usedPtrs.splice(0)) {
        surfaceInfo.delete(ptr);
        resourceToDevice.delete(ptr);
        textureMeta.delete(ptr);
        textureLevelSurfaces.delete(ptr);
    }
});

describe("D3D8 CopyRects format/self/depth-stencil rejection (§3.3)", () => {
    test("rejects a same-bpp, different-format copy (R5G6B5 -> X1R5G5B5) and touches no bytes", () => {
        withFakeGuestMemory(0x1000, (mem) => {
            const srcSurf = createTextureSurface(4, 4, D3DFMT_R5G6B5);
            srcSurf.surfacePtr = 0x010;
            const dstSurf = createTextureSurface(4, 4, D3DFMT_X1R5G5B5);
            dstSurf.surfacePtr = 0x100;

            mem.fill(0x55, srcSurf.surfacePtr, srcSurf.surfacePtr + srcSurf.pitch * 4);
            mem.fill(0xaa, dstSurf.surfacePtr, dstSurf.surfacePtr + dstSurf.pitch * 4);
            const dstBefore = mem.slice(dstSurf.surfacePtr, dstSurf.surfacePtr + dstSurf.pitch * 4);

            const pSrc = 0xd3d8_0001, pDst = 0xd3d8_0002;
            trackedInfo(pSrc, { texturePtr: 0, level: 0, surface: srcSurf, d3dFormat: D3DFMT_R5G6B5 });
            trackedInfo(pDst, { texturePtr: 0, level: 0, surface: dstSurf, d3dFormat: D3DFMT_X1R5G5B5 });

            // Old code: bpp equality only (both 16bpp) — this would SUCCEED and reinterpret
            // the bits, actually overwriting dst with src's pattern.
            const hr = resources["IDirect3DDevice8_CopyRects"]!({} as never, mem, [0, pSrc, 0, 0, pDst, 0]);
            expect(hr).toBe(D3DERR_INVALIDCALL);
            expect(mem.slice(dstSurf.surfacePtr, dstSurf.surfacePtr + dstSurf.pitch * 4)).toEqual(dstBefore);
        });
    });

    test("rejects pSrc === pDst (self-copy)", () => {
        withFakeGuestMemory(0x1000, (mem) => {
            const surf = createTextureSurface(4, 4, D3DFMT_A8R8G8B8);
            surf.surfacePtr = 0x010;
            const pSurf = 0xd3d8_0003;
            trackedInfo(pSurf, { texturePtr: 0, level: 0, surface: surf, d3dFormat: D3DFMT_A8R8G8B8 });

            const hr = resources["IDirect3DDevice8_CopyRects"]!({} as never, mem, [0, pSurf, 0, 0, pSurf, 0]);
            expect(hr).toBe(D3DERR_INVALIDCALL);
        });
    });

    test("rejects a depth-stencil surface even with matching formats", () => {
        withFakeGuestMemory(0x1000, (mem) => {
            const srcSurf = createTextureSurface(4, 4, D3DFMT_D24S8);
            srcSurf.surfacePtr = 0x010;
            const dstSurf = createTextureSurface(4, 4, D3DFMT_D24S8);
            dstSurf.surfacePtr = 0x100;

            const pSrc = 0xd3d8_0004, pDst = 0xd3d8_0005;
            trackedInfo(pSrc, { texturePtr: 0, level: 0, surface: srcSurf, d3dFormat: D3DFMT_D24S8 });
            trackedInfo(pDst, { texturePtr: 0, level: 0, surface: dstSurf, d3dFormat: D3DFMT_D24S8 });

            const hr = resources["IDirect3DDevice8_CopyRects"]!({} as never, mem, [0, pSrc, 0, 0, pDst, 0]);
            expect(hr).toBe(D3DERR_INVALIDCALL);
        });
    });

    test("copies the back buffer into a same-format image surface (screenshot path)", () => {
        // The back buffer is a wrapper around a LIVE render target: Wine reads the format off
        // the resource (wined3d_texture_get_sub_resource_desc), not off the wrapper. A wrapper
        // that records nothing must therefore resolve from its surface, not compare as
        // "different from everything" — which would fail this copy while writing no pixels.
        withFakeGuestMemory(0x1000, (mem) => {
            const backBuffer = createRenderTarget(4, 4, D3DFMT_X8R8G8B8);
            backBuffer.surfacePtr = 0x010;
            const shot = createTextureSurface(4, 4, D3DFMT_X8R8G8B8);
            shot.surfacePtr = 0x100;
            mem.fill(0x66, backBuffer.surfacePtr, backBuffer.surfacePtr + backBuffer.pitch * 4);

            const pSrc = 0xd3d8_0008, pDst = 0xd3d8_0009;
            trackedInfo(pSrc, {
                texturePtr: 0, level: 0, surface: backBuffer,
                d3dFormat: undefined as unknown as number, role: 'backbuffer',
            });
            trackedInfo(pDst, { texturePtr: 0, level: 0, surface: shot, d3dFormat: D3DFMT_X8R8G8B8 });

            const hr = resources["IDirect3DDevice8_CopyRects"]!({} as never, mem, [0, pSrc, 0, 0, pDst, 0]);
            expect(hr).toBe(D3D_OK);
            expect(mem[shot.surfacePtr]).toBe(0x66);
        });
    });

    test("still allows a same-format, non-depth-stencil copy (positive control)", () => {
        withFakeGuestMemory(0x1000, (mem) => {
            const srcSurf = createTextureSurface(4, 4, D3DFMT_A8R8G8B8);
            srcSurf.surfacePtr = 0x010;
            const dstSurf = createTextureSurface(4, 4, D3DFMT_A8R8G8B8);
            dstSurf.surfacePtr = 0x100;
            mem.fill(0x77, srcSurf.surfacePtr, srcSurf.surfacePtr + srcSurf.pitch * 4);

            const pSrc = 0xd3d8_0006, pDst = 0xd3d8_0007;
            trackedInfo(pSrc, { texturePtr: 0, level: 0, surface: srcSurf, d3dFormat: D3DFMT_A8R8G8B8 });
            trackedInfo(pDst, { texturePtr: 0, level: 0, surface: dstSurf, d3dFormat: D3DFMT_A8R8G8B8 });

            const hr = resources["IDirect3DDevice8_CopyRects"]!({} as never, mem, [0, pSrc, 0, 0, pDst, 0]);
            expect(hr).toBe(D3D_OK);
            expect(mem[dstSurf.surfacePtr]).toBe(0x77);
        });
    });
});

describe("D3D8 UpdateTexture copies every mip level (§3.4)", () => {
    test("copies level 1 (not just level 0) from src to dst", () => {
        withFakeGuestMemory(0x2000, (mem) => {
            const srcParent = createTextureSurface(4, 4, D3DFMT_A8R8G8B8);
            srcParent.surfacePtr = 0x0010; // 4*4*4 = 64 bytes
            const srcLevel1 = createTextureSurface(2, 2, D3DFMT_A8R8G8B8);
            srcLevel1.surfacePtr = 0x0100; // 2*2*4 = 16 bytes

            const dstParent = createTextureSurface(4, 4, D3DFMT_A8R8G8B8);
            dstParent.surfacePtr = 0x0400;
            const dstLevel1 = createTextureSurface(2, 2, D3DFMT_A8R8G8B8);
            dstLevel1.surfacePtr = 0x0500;

            mem.fill(0x11, srcParent.surfacePtr, srcParent.surfacePtr + 64);
            mem.fill(0x22, srcLevel1.surfacePtr, srcLevel1.surfacePtr + 16);
            // dst starts zeroed (the Uint8Array default).

            const pSrcTex = 0xd3d8_1001, pDstTex = 0xd3d8_1002;
            const pSrcLevel0 = 0xd3d8_1011, pSrcLevel1 = 0xd3d8_1012;
            const pDstLevel0 = 0xd3d8_1021, pDstLevel1 = 0xd3d8_1022;

            textureMeta.set(pSrcTex, { width: 4, height: 4, levels: 2, usage: 0, pool: 0, format: D3DFMT_A8R8G8B8 });
            textureMeta.set(pDstTex, { width: 4, height: 4, levels: 2, usage: 0, pool: 0, format: D3DFMT_A8R8G8B8 });
            usedPtrs.push(pSrcTex, pDstTex);

            resourceToDevice.set(pSrcTex, { texSurfaces: new Map([[pSrcTex, srcParent]]) } as unknown as D3D8DeviceAdapter);
            resourceToDevice.set(pDstTex, { texSurfaces: new Map([[pDstTex, dstParent]]) } as unknown as D3D8DeviceAdapter);
            usedPtrs.push(pSrcTex, pDstTex);

            // Pre-seed the per-level COM-ptr cache so the handler's ensureTextureLevelSurface
            // call is a cache hit (no vtables/COM/process.memory.alloc needed for this test).
            textureLevelSurfaces.set(pSrcTex, new Map([[0, pSrcLevel0], [1, pSrcLevel1]]));
            textureLevelSurfaces.set(pDstTex, new Map([[0, pDstLevel0], [1, pDstLevel1]]));
            trackedInfo(pSrcLevel0, { texturePtr: pSrcTex, level: 0, surface: srcParent, d3dFormat: D3DFMT_A8R8G8B8 });
            trackedInfo(pSrcLevel1, { texturePtr: pSrcTex, level: 1, surface: srcLevel1, d3dFormat: D3DFMT_A8R8G8B8 });
            trackedInfo(pDstLevel0, { texturePtr: pDstTex, level: 0, surface: dstParent, d3dFormat: D3DFMT_A8R8G8B8 });
            trackedInfo(pDstLevel1, { texturePtr: pDstTex, level: 1, surface: dstLevel1, d3dFormat: D3DFMT_A8R8G8B8 });

            const hr = resources["IDirect3DDevice8_UpdateTexture"]!({} as never, mem, [0, pSrcTex, pDstTex]);
            expect(hr).toBe(D3D_OK);

            expect(mem[dstParent.surfacePtr]).toBe(0x11);
            // The regression: old code resolved BOTH src/dst through texSurfaces.get() (always
            // level 0), so level 1 of dst was NEVER written and stays 0x00 here.
            expect(mem[dstLevel1.surfacePtr]).toBe(0x22);
        });
    });
});
