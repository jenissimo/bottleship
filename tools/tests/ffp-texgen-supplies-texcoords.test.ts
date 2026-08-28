/**
 * A stage with D3DTSS_TCI_CAMERASPACE* texgen supplies its OWN texture coordinates.
 *
 * Such a draw carries no UV set in its vertex format, so deriving "this draw has texture
 * coordinates" from the FVF alone dropped the texture: D3DTA_TEXTURE then resolved to white,
 * and the surrounding blend turned that into a solid fill — SRCALPHA/INVSRCALPHA painted it
 * white, ZERO/INVSRCCOLOR painted it black. That is what XIII's projected shadows and decals
 * looked like before the fix.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FfpStagesState } from "../../src/worker/backends/webgpu/ddraw/ffp-stages";
import { DDrawWebGPUExecutor } from "../../src/worker/backends/webgpu/ddraw/ddraw-backend-executor";
import {
    D3DTSS_COLOROP, D3DTSS_COLORARG1, D3DTSS_COLORARG2, D3DTSS_TEXCOORDINDEX,
    D3DTOP_SELECTARG1, D3DTOP_DISABLE, D3DTA_TEXTURE, D3DTA_CURRENT,
} from "../../src/worker/modules/ddraw/constants";

const D3DTSS_TCI_CAMERASPACEPOSITION = 0x00020000;
const D3DTSS_TCI_CAMERASPACENORMAL = 0x00010000;
const D3DTSS_TCI_CAMERASPACEREFLECTIONVECTOR = 0x00030000;
const D3DTSS_TCI_SPHEREMAP = 0x00040000;

/** The predicate is stateless — call it off the prototype rather than standing a live
 *  executor (and a GPU device) up for a pure state read. */
const hasCameraSpaceTexgen = (ts: Int32Array): boolean =>
    (DDrawWebGPUExecutor.prototype as unknown as {
        hasCameraSpaceTexgen(ts: Int32Array): boolean;
    }).hasCameraSpaceTexgen.call({}, ts);

function tciOnStage(stage: number, tci: number): Int32Array {
    const ts = new Int32Array(256);
    ts[stage * 32 + D3DTSS_TEXCOORDINDEX] = tci;
    return ts;
}

function stage0SelectsTexture(texgen: boolean): Int32Array {
    const ts = new Int32Array(256);
    ts[0 * 32 + D3DTSS_COLOROP] = D3DTOP_SELECTARG1;
    ts[0 * 32 + D3DTSS_COLORARG1] = D3DTA_TEXTURE;
    ts[0 * 32 + D3DTSS_COLORARG2] = D3DTA_CURRENT;
    ts[0 * 32 + D3DTSS_TEXCOORDINDEX] = texgen ? D3DTSS_TCI_CAMERASPACEPOSITION : 0;
    ts[1 * 32 + D3DTSS_COLOROP] = D3DTOP_DISABLE;
    return ts;
}

describe("FFP texgen supplies texture coordinates", () => {
    test("stage 0 samples its bound texture when the draw declares texcoords", () => {
        const stages = new FfpStagesState();
        stages.resolve(stage0SelectsTexture(false), /* realTexMask */ 1, /* hasTexCoords */ true, false);
        expect(stages.sampledMask & 1).toBe(1);
    });

    test("without texcoords and without texgen, stage 0 does NOT sample — the pre-fix behaviour", () => {
        const stages = new FfpStagesState();
        stages.resolve(stage0SelectsTexture(false), 1, /* hasTexCoords */ false, false);
        expect(stages.sampledMask & 1).toBe(0);
    });

    test("a texgen stage sampling with hasTexCoords=true keeps its texture", () => {
        // This is the state the executor must produce for a texgen draw: the vertex format
        // carries no UV set, but the coordinates exist, so the texture must still be sampled.
        const stages = new FfpStagesState();
        stages.resolve(stage0SelectsTexture(true), 1, /* hasTexCoords */ true, false);
        expect(stages.sampledMask & 1).toBe(1);
    });

    test("only the three real CAMERASPACE modes count as camera-space texgen", () => {
        for (const mode of [
            D3DTSS_TCI_CAMERASPACENORMAL,
            D3DTSS_TCI_CAMERASPACEPOSITION,
            D3DTSS_TCI_CAMERASPACEREFLECTIONVECTOR,
        ]) {
            expect(hasCameraSpaceTexgen(tciOnStage(0, mode))).toBe(true);
            expect(hasCameraSpaceTexgen(tciOnStage(2, mode | 1))).toBe(true);  // UV index in the low half
        }
    });

    test("SPHEREMAP and stale garbage in the high half do NOT widen hasTexCoords", () => {
        // The predicate feeds hasTexCoords on the shared DDraw/D3D7 path: a legacy title with
        // junk in the high half would otherwise sample a stage whose vertices carry no UVs,
        // and the shader generates coordinates for exactly three modes.
        expect(hasCameraSpaceTexgen(tciOnStage(0, D3DTSS_TCI_SPHEREMAP))).toBe(false);
        expect(hasCameraSpaceTexgen(tciOnStage(0, 0x00070000))).toBe(false);
        expect(hasCameraSpaceTexgen(tciOnStage(1, 0xdead0000 | 0))).toBe(false);
        expect(hasCameraSpaceTexgen(tciOnStage(0, 0))).toBe(false);
    });

    test("the executor derives hasTexCoords from texgen as well as the FVF", () => {
        // Structural guard: the one-line composition is what the unit tests above cannot see.
        const src = readFileSync(
            "src/worker/backends/webgpu/ddraw/ddraw-backend-executor.ts", "utf8");
        const line = src.split("\n").find((l) => l.includes("const hasTexCoords ="));
        expect(line).toBeDefined();
        expect(line).toContain("vertexType & 0xf00");
        expect(line).toContain("hasCameraSpaceTexgen");
    });
});

describe("draw diagnostics never fault on a surface with no guest pointer", () => {
    test("the SOLID-FILL-RISK warn tolerates a missing surfacePtr", () => {
        // A D3D8-created surface can have surfacePtr undefined; a diagnostic that throws a
        // TypeError mid-draw is worse than the condition it reports.
        const src = readFileSync(
            "src/worker/backends/webgpu/ddraw/ddraw-backend-executor.ts", "utf8");
        const at = src.indexOf("SOLID-FILL-RISK: stage 0");
        expect(at).toBeGreaterThan(0);
        const block = src.slice(at, at + 400);
        expect(block).toContain("(texture.surfacePtr ?? 0).toString(16)");
    });
});
