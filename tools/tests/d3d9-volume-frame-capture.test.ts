import { expect, test } from "bun:test";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { startCapture, cancelCapture, onFrameEnd } from "../../src/worker/modules/ddraw/frame-capture";

test("capturing a draw with a volume sampler preserves its guest identity without a 2D lookup", async () => {
    const d: any = Object.create(D3D9Device.prototype);
    Object.assign(d, {
        stateTracker: { getTexture: (s: number) => s === 0 ? -1 : null, getRenderState: () => 0, getFVF: () => 0, getMVP: () => new Float32Array(16) },
        boundTexturePtrs: new Uint32Array([0x1234, 0]), activeVertexDecl: 0,
        activeVertexShader: 0, activePixelShader: 0, currentRtIndex: null,
        getActiveVsShader: () => null, activeSlotMask: () => 0,
        getCurrentTargetSize: () => ({ w: 640, h: 480 }), viewport: { x: 0, y: 0, width: 640, height: 480 },
        activeColorTargetFormats: () => ["rgba8unorm"], activeDepthTargetFormat: () => "depth24plus-stencil8",
        isVolumeIndex: (i: number) => i < 0, volumeEntry: () => ({ pointer: 0x1234 }),
        textures: { getHandle: () => { throw new Error("volume is not a 2D texture"); } },
        getSamplerState: (_s: number, t: number) => t === 1 ? 3 : 0,
        rsFloat: () => 0, getTextureStageState: () => 0,
        activeStageCount: () => 1, resolveFfpStages: () => [], captureLighting: () => ({}),
    });
    const recording = startCapture("d3d9");
    try {
        onFrameEnd("d3d9");
        d.captureDrawIfArmed(4, 1);
        onFrameEnd("d3d9");
        const draw = (await recording).drawCalls[0]!;
        expect(draw.warnings).toContain("tex0 handle=0x1234");
        expect(draw.samplers?.[0]).toMatchObject({ texture: "0x1234", kind: "ps:volume", addressU: 3 });
        expect(draw.rtFormat).toBe("rgba8unorm");
    } finally { cancelCapture(); }
});
