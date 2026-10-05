/**
 * The shared DDraw/D3D3-7/D3D8 fixed-function generator is under the same Dawn/Tint
 * constraint as the D3D9 emitter: `out.position.z = …` on a `var out` is a writable
 * component swizzle, and Tint currently fails to lower those ("swizzle view instruction
 * still has usages after lowering"), taking the whole pipeline with it. Every vertex stage
 * this generator emits must assign complete vectors instead.
 */
import { describe, expect, test } from "bun:test";
import {
    generateShaderCode,
    generateMegaBatchShaderCode,
    generateClearShaderCode,
    generateColorKeyBlitShaderCode,
    type ShaderConfig,
} from "../../src/worker/backends/webgpu/ddraw/shader-generator";
import { DEFAULT_DEBUG_FLAGS } from "../../src/worker/backends/webgpu/ddraw/types";

/** `name.<component> =`, excluding ==/!=/<=/>=. */
const COMPONENT_ASSIGNMENT = /\b[A-Za-z_]\w*\.[xyzwrgba]\s*=(?!=)/g;

/** A `//` comment can carry an innocent `t.y=1`; the check is about emitted code. */
function stripComments(wgsl: string): string {
    return wgsl.replace(/\/\/[^\n]*/g, "");
}

function config(overrides: Partial<ShaderConfig>): ShaderConfig {
    return {
        sampledMask: 1,
        stageCount: 1,
        flatShading: false,
        alphaTestEnabled: false,
        alphaFunc: 8,
        shouldEnableBlending: false,
        missingTexture: false,
        colorKeyEnabled: false,
        colorKey: null,
        debugFlags: DEFAULT_DEBUG_FLAGS,
        needsUVFlip: false,
        ...overrides,
    };
}

/** State combinations that reach every z-transform and UV-flip branch of both entry points. */
function generatedShaders(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const needsUVFlip of [false, true]) {
        for (const forceZMidpoint of [false, true]) {
            for (const stageCount of [1, 4, 8]) {
                for (const alphaTestEnabled of [false, true]) {
                    const cfg = config({
                        needsUVFlip,
                        stageCount,
                        sampledMask: (1 << stageCount) - 1,
                        alphaTestEnabled,
                        alphaFunc: alphaTestEnabled ? 7 : 8,
                        colorKeyEnabled: alphaTestEnabled,
                        colorKey: alphaTestEnabled ? { low: 0, high: 0 } as ShaderConfig["colorKey"] : null,
                        debugFlags: { ...DEFAULT_DEBUG_FLAGS, forceZMidpoint },
                    });
                    const label = `flip=${needsUVFlip} zMid=${forceZMidpoint} stages=${stageCount} alpha=${alphaTestEnabled}`;
                    out.push([`legacy ${label}`, generateShaderCode(cfg)]);
                    out.push([`megabatch ${label}`, generateMegaBatchShaderCode(cfg)]);
                }
            }
        }
    }
    out.push(["clear", generateClearShaderCode()]);
    out.push(["colorkey blit", generateColorKeyBlitShaderCode()]);
    return out;
}

describe("ddraw/d3d8 FFP shader generator — no writable component swizzles", () => {
    test("no generated shader assigns a single component of a var", () => {
        const offenders: string[] = [];
        for (const [name, wgsl] of generatedShaders()) {
            for (const match of stripComments(wgsl).matchAll(COMPONENT_ASSIGNMENT)) {
                offenders.push(`${name}: ${match[0]}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test("the z transforms still write position, through a whole vec4", () => {
        const remap = generateShaderCode(config({}));
        expect(remap).toContain("let zRemapPos = out.position;");
        expect(remap).toContain("out.position = vec4f(zRemapPos.xy, z_ndc2 * zRemapPos.w, zRemapPos.w);");
        expect(remap).toContain("out.position = vec4f(clipPos.xy, clamp(zNdc, 0.0, 1.0) * zw, zw);");

        const midpoint = generateShaderCode(
            config({ debugFlags: { ...DEFAULT_DEBUG_FLAGS, forceZMidpoint: true } }));
        expect(midpoint).toContain("out.position = vec4f(zMidPos.xy, 0.5 * zMidPos.w, zMidPos.w);");
        expect(midpoint).not.toContain("z_ndc2");
    });

    test("the UV flip rebuilds the coordinate instead of assigning .y", () => {
        const legacy = generateShaderCode(config({ needsUVFlip: true }));
        expect(legacy).toContain("vec4f(src0Raw.x, 1.0 - src0Raw.y, src0Raw.z, src0Raw.w)");
        const mega = generateMegaBatchShaderCode(config({ needsUVFlip: true }));
        expect(mega).toContain("vec2f(adjustedUVRaw.x, 1.0 - adjustedUVRaw.y)");

        // The flip must still be conditional, not baked into every shader.
        expect(generateShaderCode(config({ needsUVFlip: false }))).not.toContain("1.0 - src0Raw.y");
        expect(generateMegaBatchShaderCode(config({ needsUVFlip: false })))
            .not.toContain("1.0 - adjustedUVRaw.y");
    });
});
