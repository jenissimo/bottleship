import { describe, expect, test } from "bun:test";
import {
    D3D9StateBlockRecorder,
    applyStateBlockEntries,
    captureStateToEntries,
    refreshCapturedEntries,
    D3D9_PIXEL_RENDER_STATES,
    D3D9_VERTEX_RENDER_STATES,
    D3DSBT_ALL,
    D3DSBT_PIXELSTATE,
    D3DSBT_VERTEXSTATE,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-state-block";
import {
    d3d9TextureStageSlot, isD3D9TextureStage, D3D9_TEXTURE_SLOT_COUNT,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-state-tracker";

describe("D3D9StateBlockRecorder", () => {
    test("captures DXVK pixel/vertex memberships without leaking ALL-only state", () => {
        const device = {
            getAllRenderStates: () => [],
            getAllTextureStageStates: () => [],
            getAllSamplerStates: () => [],
            getBoundTexturePtr: () => 0,
            getPixelShaderComPtr: () => 0,
            getAllPixelShaderConstants: () => new Float32Array(0),
            getAllPixelShaderConstantsI: () => new Int32Array(0),
            getAllPixelShaderConstantsB: () => new Int32Array(0),
            getAllTransforms: () => [],
            getNPatchMode: () => 3,
            getMaterial: () => new Uint8Array(68),
            getAllLights: () => [],
            getAllLightEnables: () => [],
            getAllClipPlanes: () => [],
            getViewport: () => ({ x: 0, y: 0, width: 1, height: 1, minZ: 0, maxZ: 1 }),
            getScissorRect: () => ({ left: 0, top: 0, right: 1, bottom: 1 }),
            // A REAL FVF: with 0 the test could not tell "captured the FVF" from
            // "captured nothing", which is how the missing entry went unnoticed.
            getFVF: () => 0x142,
            getVertexShaderComPtr: () => 0,
            getVertexDeclarationComPtr: () => 0,
            getAllVertexShaderConstants: () => new Float32Array(0),
            getAllVertexShaderConstantsI: () => new Int32Array(0),
            getAllVertexShaderConstantsB: () => new Int32Array(0),
            getStreamSourceFreq: () => null,
            getStreamBinding: () => ({ ptr: 0, offset: 0, stride: 0 }),
            getBoundIndexBufferPtr: () => 0,
        } as any;

        const pixel = captureStateToEntries(device, D3DSBT_PIXELSTATE);
        expect(pixel.filter(e => e.op === "texture")).toHaveLength(0);
        expect(pixel.find(e => e.op === "pixelShader")).toEqual({ op: "pixelShader", handle: 0 });

        const vertex = captureStateToEntries(device, D3DSBT_VERTEXSTATE);
        expect(vertex.find(e => e.op === "texture")).toBeUndefined();
        // FVF and the vertex declaration are ONE D3D9 state slot. A block that captures the
        // declaration but not the FVF applies the CURRENT FVF's stride against the captured
        // everything-else, so both must be there — FVF first so the declaration wins on Apply.
        expect(vertex.find(e => e.op === "fvf")).toEqual({ op: "fvf", value: 0x142 });
        const fvfIndex = vertex.findIndex(e => e.op === "fvf");
        const declIndex = vertex.findIndex(e => e.op === "vertexDeclaration");
        expect(fvfIndex).toBeGreaterThanOrEqual(0);
        expect(declIndex).toBeGreaterThan(fvfIndex);
        // D3D9's documented vertex-state list includes NPatchMode.
        expect(vertex.find(e => e.op === "npatchMode")).toEqual({ op: "npatchMode", segments: 3 });
        expect(vertex.filter(e => e.op === "samplerState")).toHaveLength(4);
        expect(vertex.filter(e => e.op === "samplerState").every(e => e.op === "samplerState" && e.type === 13)).toBe(true);
        expect(vertex.find(e => e.op === "renderState")).toBeUndefined();
        expect(vertex.find(e => e.op === "vertexShader")).toEqual({ op: "vertexShader", handle: 0 });
        expect(vertex.find(e => e.op === "vertexDeclaration")).toEqual({ op: "vertexDeclaration", handle: 0 });
    });

    test("matches DXVK's pixel, vertex, and ALL render-state memberships", () => {
        const device = {
            getAllRenderStates: () => Array.from({ length: 256 }, (_, state) => ({ state, value: state })),
            getAllTextureStageStates: () => [],
            getAllSamplerStates: () => [],
            getBoundTexturePtr: () => 0,
            getPixelShaderComPtr: () => 0,
            getAllPixelShaderConstants: () => new Float32Array(0),
            getAllPixelShaderConstantsI: () => new Int32Array(0),
            getAllPixelShaderConstantsB: () => new Int32Array(0),
            getAllTransforms: () => [],
            getNPatchMode: () => 0,
            getMaterial: () => new Uint8Array(68),
            getAllLights: () => [],
            getAllLightEnables: () => [],
            getAllClipPlanes: () => [],
            getViewport: () => ({ x: 0, y: 0, width: 1, height: 1, minZ: 0, maxZ: 1 }),
            getScissorRect: () => ({ left: 0, top: 0, right: 1, bottom: 1 }),
            getFVF: () => 0,
            getSoftwareVertexProcessing: () => false,
            getVertexShaderComPtr: () => 0,
            getVertexDeclarationComPtr: () => 0,
            getAllVertexShaderConstants: () => new Float32Array(0),
            getAllVertexShaderConstantsI: () => new Int32Array(0),
            getAllVertexShaderConstantsB: () => new Int32Array(0),
            getStreamSourceFreq: () => null,
            getStreamBinding: () => ({ ptr: 0, offset: 0, stride: 0 }),
            getBoundIndexBufferPtr: () => 0,
        } as any;
        const states = (blockType: number) => captureStateToEntries(device, blockType)
            .filter((entry): entry is Extract<typeof entry, { op: "renderState" }> => entry.op === "renderState")
            .map(entry => entry.state);
        const pixel = states(D3DSBT_PIXELSTATE);
        const vertex = states(D3DSBT_VERTEXSTATE);
        const all = states(D3DSBT_ALL);

        expect(pixel).toEqual([...D3D9_PIXEL_RENDER_STATES].sort((a, b) => a - b));
        expect(vertex).toEqual([...D3D9_VERTEX_RENDER_STATES].sort((a, b) => a - b));
        expect(new Set(all)).toEqual(new Set([...D3D9_PIXEL_RENDER_STATES, ...D3D9_VERTEX_RENDER_STATES]));
        expect(all).not.toContain(0);
        expect(all).not.toContain(255);
    });

    test("records and deduplicates state changes between begin/end", () => {
        const recorder = new D3D9StateBlockRecorder();
        expect(recorder.isRecording()).toBe(false);

        expect(recorder.begin()).toBeUndefined();
        expect(recorder.isRecording()).toBe(true);

        recorder.record({ op: "renderState", state: 7, value: 1 });
        recorder.record({ op: "renderState", state: 7, value: 0 });
        recorder.record({ op: "texture", stage: 0, texPtr: 0x1000 });
        recorder.record({ op: "fvf", value: 0x112 });

        const entries = recorder.end();
        expect(recorder.isRecording()).toBe(false);
        expect(entries).toHaveLength(3);
        expect(entries[0]).toEqual({ op: "renderState", state: 7, value: 0 });
        expect(entries[1]).toEqual({ op: "texture", stage: 0, texPtr: 0x1000 });
        expect(entries[2]).toEqual({ op: "fvf", value: 0x112 });
    });

    test("ignores records outside an active block", () => {
        const recorder = new D3D9StateBlockRecorder();
        recorder.record({ op: "renderState", state: 1, value: 2 });
        recorder.begin();
        recorder.record({ op: "renderState", state: 3, value: 4 });
        expect(recorder.end()).toHaveLength(1);
    });

    test("captures, applies, and refreshes NPatch vertex state", () => {
        const recorder = new D3D9StateBlockRecorder();
        recorder.begin();
        recorder.record({ op: "npatchMode", segments: 4 });
        recorder.record({ op: "npatchMode", segments: 8 });
        const entries = recorder.end();
        expect(entries).toEqual([{ op: "npatchMode", segments: 8 }]);

        let segments = 0;
        const fake = {
            setNPatchMode(value: number): number { segments = value; return 0; },
            getNPatchMode(): number { return segments; },
        };
        applyStateBlockEntries(fake as never, entries, new Uint8Array());
        expect(segments).toBe(8);

        segments = 3;
        refreshCapturedEntries(fake as never, entries);
        expect(entries).toEqual([{ op: "npatchMode", segments: 3 }]);
    });
});

describe("D3D9 texture-stage namespace", () => {
    test("D3DDMAPSAMPLER (256) is a real slot, not a refused call", () => {
        // SetTexture(D3DDMAPSAMPLER, tex) is legal D3D9 — the displacement map for presampled
        // patch tessellation. Returning -1 failed a call that cannot fail; the slot simply has
        // no consumer (nothing samples it), which is a different thing from rejecting it.
        const slot = d3d9TextureStageSlot(256);
        expect(slot).toBeGreaterThanOrEqual(0);
        expect(isD3D9TextureStage(256)).toBe(true);
        expect(slot).toBeLessThan(D3D9_TEXTURE_SLOT_COUNT);
        // And it must not collide with any pixel or vertex sampler slot.
        const others = new Set<number>();
        for (let stage = 0; stage < 16; stage++) others.add(d3d9TextureStageSlot(stage));
        for (let n = 0; n < 4; n++) others.add(d3d9TextureStageSlot(257 + n));
        expect(others.has(slot)).toBe(false);
        expect(others.size).toBe(20);
    });

    test("the gap around it is still refused", () => {
        for (const stage of [16, 200, 255, 261, 1024]) {
            expect(d3d9TextureStageSlot(stage)).toBe(-1);
        }
    });
});
