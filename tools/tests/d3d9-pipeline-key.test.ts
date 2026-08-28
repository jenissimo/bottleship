import { describe, expect, test } from "bun:test";
import { D3D9Device, emitFfpShader } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";

type KeyProbe = {
    stateTracker: {
        computePipelineKey: () => number;
        getRenderState: (state: number) => number;
    };
    activeVertexShader: number;
    activeVertexDecl: number;
};

// The method is intentionally exercised against a tiny structural probe: constructing a real
// WebGPU device is neither necessary nor available in the Bun test environment.  This catches
// accidental mixing of cache hashes/markers into the state bits that resolvePipelineId decodes.
const buildPipelineKey = (D3D9Device.prototype as unknown as {
    buildPipelineKey: (this: KeyProbe) => number;
}).buildPipelineKey;

describe("D3D9 pipeline key state bits", () => {
    test("keeps FFP lighting and cull bits intact across fill/shade values", () => {
        const probe: KeyProbe = {
            stateTracker: {
                // cull=CCW, lighting=on, z-enable/write=on
                computePipelineKey: () => 0x07030000,
                getRenderState: state => state === 8 ? 3 : 2,
            },
            activeVertexShader: 0,
            activeVertexDecl: 0,
        };
        expect(buildPipelineKey.call(probe)).toBe(0x07030000);
        probe.stateTracker.getRenderState = state => state === 8 ? 1 : 4;
        expect(buildPipelineKey.call(probe)).toBe(0x07030000);
    });

    test("preserves programmable declaration and render-state fields", () => {
        const probe: KeyProbe = {
            stateTracker: {
                computePipelineKey: () => 0x06020000,
                getRenderState: () => 3,
            },
            activeVertexShader: 7,
            activeVertexDecl: 0x1234,
        };
        // Programmable keys retain only the decodable render-state bits, declaration handle,
        // and the compact VS handle; no fill/shade hash is allowed to perturb them.
        expect(buildPipelineKey.call(probe)).toBe((0x06020000 & 0x07ff0000) | 0x1234 | (7 << 27));
    });
});

describe("D3DRS_SHADEMODE = D3DSHADE_FLAT is lowered, not refused", () => {
    // WGSL has @interpolate(flat) and rasterStateKey() already folds the shade mode into
    // pipeline identity, so refusing the draw threw away geometry we can render exactly.
    const emit = (flatShading: boolean): string => emitFfpShader({
        inputFields: ["@location(0) pos: vec3<f32>"],
        hasRhw: false,
        hasTex: false,
        lit: false,
        colorExpr: "vec4<f32>(1.0)",
        specularExpr: "vec4<f32>(0.0)",
        normalExpr: "vec3<f32>(0.0, 0.0, 1.0)",
        alphaTest: null,
        flatShading,
    });

    test("flat shading marks the colour varyings @interpolate(flat)", () => {
        const wgsl = emit(true);
        expect(wgsl).toContain("@location(0) @interpolate(flat) color: vec4<f32>");
        expect(wgsl).toContain("@location(2) @interpolate(flat) specular: vec4<f32>");
    });

    test("gouraud (the default) leaves every varying interpolated", () => {
        const wgsl = emit(false);
        expect(wgsl).not.toContain("@interpolate(flat)");
        expect(wgsl).toContain("@location(0) color: vec4<f32>");
    });

    test("only the colour registers stop interpolating", () => {
        // D3DSHADE_FLAT does not flat-shade texcoords, fog or the clip distances.
        const wgsl = emit(true);
        expect(wgsl).toContain("@location(1) fog: f32");
        expect(wgsl).toContain("@location(3) clipA: vec4<f32>");
    });
});

describe("rasterStateSupported is the shared gate for BOTH pipeline paths", () => {
    // buildProgrammablePipeline calls buildDepthStencilState with no stencil-vs-attachment
    // guard of its own, so a D16 depth surface + D3DRS_STENCILENABLE + a pixel shader used to
    // produce a WebGPU pipeline rejection and lose every draw with that shader.
    const rasterStateSupported = (D3D9Device.prototype as unknown as {
        rasterStateSupported: (this: unknown, topology: string) => boolean;
    }).rasterStateSupported;

    const probe = (states: Record<number, number>, depthFormat: GPUTextureFormat) => ({
        getRS: (state: number) => states[state] ?? 0,
        activeDepthTargetFormat: () => depthFormat,
        activeRenderTargetSampleCount: () => 1,
    });

    // D3DFILL_SOLID / D3DCULL_NONE / D3DCMP_LESSEQUAL — a device that would otherwise draw.
    const BASE: Record<number, number> = { 8: 3, 22: 1, 23: 4, 7: 1, 14: 1 };

    test("a plain state on a depth-only attachment is supported", () => {
        expect(rasterStateSupported.call(probe(BASE, "depth24plus"), "triangle-list")).toBe(true);
    });

    test("D3DRS_STENCILENABLE with no stencil plane is refused here, not at pipeline creation", () => {
        // STENCILENABLE with a complete, VALID stencil op set: the refusal under test must be
        // "no stencil plane", not "invalid enum".
        const states = { ...BASE, 52: 1, 53: 1, 54: 1, 55: 1, 56: 8 };
        expect(rasterStateSupported.call(probe(states, "depth24plus"), "triangle-list")).toBe(false);
        // The same state IS representable once the attachment carries stencil.
        expect(rasterStateSupported.call(probe(states, "depth24plus-stencil8"), "triangle-list")).toBe(true);
    });

    test("D3DRS_SHADEMODE=FLAT no longer refuses; D3DFILL_WIREFRAME still does", () => {
        expect(rasterStateSupported.call(probe({ ...BASE, 9: 1 }, "depth24plus"), "triangle-list")).toBe(true);
        expect(rasterStateSupported.call(probe({ ...BASE, 8: 2 }, "depth24plus"), "triangle-list")).toBe(false);
    });
});

describe("state blocks record the viewport and scissor rect", () => {
    // BeginStateBlock -> SetViewport -> SetRenderState -> EndStateBlock -> Apply is the standard
    // UI idiom. Without the recording branch the block restores the render states and leaves the
    // viewport wherever the guest happened to put it.
    const proto = D3D9Device.prototype as unknown as {
        setScissorRect: (this: unknown, l: number, t: number, r: number, b: number) => void;
        setViewportValues: (this: unknown, v: Record<string, number>) => number;
    };

    function recorder() {
        const entries: unknown[] = [];
        return {
            entries,
            receiver: {
                recordingStateBlock: true,
                recordStateBlock: (entry: unknown) => { entries.push(entry); },
                getCurrentTargetSize: () => ({ w: 800, h: 600 }),
                scissorRect: { left: 0, top: 0, right: 0, bottom: 0 },
                viewport: { x: 0, y: 0, width: 800, height: 600, minZ: 0, maxZ: 1 },
            },
        };
    }

    test("SetScissorRect journals instead of applying", () => {
        const { entries, receiver } = recorder();
        proto.setScissorRect.call(receiver, 10, 20, 30, 40);
        expect(entries).toEqual([{ op: "scissorRect", left: 10, top: 20, right: 30, bottom: 40 }]);
        expect(receiver.scissorRect).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
    });

    test("SetViewport journals instead of applying", () => {
        const { entries, receiver } = recorder();
        proto.setViewportValues.call(receiver, { x: 1, y: 2, width: 300, height: 400, minZ: 0, maxZ: 1 });
        expect(entries).toEqual([{ op: "viewport", x: 1, y: 2, width: 300, height: 400, minZ: 0, maxZ: 1 }]);
        expect(receiver.viewport.width).toBe(800);
    });

    test("outside a recording the setters apply as usual", () => {
        const { entries, receiver } = recorder();
        receiver.recordingStateBlock = false;
        proto.setScissorRect.call(receiver, 10, 20, 30, 40);
        proto.setViewportValues.call(receiver, { x: 1, y: 2, width: 300, height: 400, minZ: 0, maxZ: 1 });
        expect(entries).toHaveLength(0);
        expect(receiver.scissorRect).toEqual({ left: 10, top: 20, right: 30, bottom: 40 });
        expect(receiver.viewport).toMatchObject({ x: 1, y: 2, width: 300, height: 400 });
    });
});

describe("the D3D9 scissor rect defaults to the whole render target", () => {
    // An all-zero default clips everything away the moment a game enables
    // D3DRS_SCISSORTESTENABLE without ever calling SetScissorRect — and it makes the
    // viewport-limited Clear resolve to an empty region.
    const proto = D3D9Device.prototype as unknown as {
        getScissorRect: (this: unknown) => { left: number; top: number; right: number; bottom: number };
        setScissorRect: (this: unknown, l: number, t: number, r: number, b: number) => void;
    };
    // effectiveScissorRect is a private prototype method, so the stand-in has to inherit it;
    // recordingStateBlock is a prototype getter and has to be shadowed with a descriptor.
    const receiver = () => Object.defineProperties(Object.create(D3D9Device.prototype), {
        recordingStateBlock: { value: false, writable: true },
        scissorRect: { value: { left: 0, top: 0, right: 0, bottom: 0 }, writable: true },
        scissorRectSet: { value: false, writable: true },
        getCurrentTargetSize: { value: () => ({ w: 1024, h: 768 }), writable: true },
    });

    test("an untouched device reads back the full target", () => {
        expect(proto.getScissorRect.call(receiver()))
            .toEqual({ left: 0, top: 0, right: 1024, bottom: 768 });
    });

    test("an app-set rect wins, including a deliberately empty one", () => {
        const r = receiver();
        proto.setScissorRect.call(r, 4, 8, 4, 8);
        expect(proto.getScissorRect.call(r)).toEqual({ left: 4, top: 8, right: 4, bottom: 8 });
    });
});
