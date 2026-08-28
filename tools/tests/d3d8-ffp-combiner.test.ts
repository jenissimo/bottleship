/**
 * D3D8/DDraw FFP combiner tests (shader-generator.ts's `applyStageOp`/`resolveStageArg`) +
 * the caps<->implementation sync (d3d8/caps.ts).
 *
 * Mirrors the evaluation strategy of d3d9-ffp-combiner.test.ts: each `if (op == Nu) { return
 * EXPR; }` branch is lifted out of the generated WGSL and evaluated against a reference written
 * straight from the D3DTEXTUREOP definitions, so a wrong formula fails here instead of showing
 * up only as a mis-shaded surface in one game.
 *
 * Before this change, the D3D8/DDraw combiner had no branch for ADDSMOOTH(11),
 * BLENDTEXTUREALPHAPM(15), BLENDCURRENTALPHA(16), MODULATEALPHA_ADDCOLOR(18),
 * MODULATECOLOR_ADDALPHA(19), MODULATEINVALPHA_ADDCOLOR(20), MODULATEINVCOLOR_ADDALPHA(21) or
 * DOTPRODUCT3(24) — all eight silently fell through to `arg1 * arg2` (MODULATE) — and
 * D3DTA_SPECULAR/D3DTA_TEMP were not modeled at all (both resolved to DIFFUSE). Every test
 * below fails against that code.
 */
import { describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
// Prime the module graph the same way ffp-stages.test.ts does: ddraw/constants participates in
// an import cycle through core/com/com-memory -> ... -> d3d/types (which reads constants at
// module scope). Evaluating d3d/types first resolves the cycle the same way the worker does.
import "../../src/worker/modules/ddraw/d3d/types";
import {
    FFP_D3D8_IMPLEMENTED_OPS,
    generateShaderHelpers,
} from "../../src/worker/backends/webgpu/ddraw/shader-generator";
import { MAX_FFP_STAGES, MAX_FFP_SAMPLED_STAGES } from "../../src/worker/backends/webgpu/ddraw/ffp-stages";
import { writeDeviceCaps8 } from "../../src/worker/modules/d3d8/caps";
import {
    D3DTOP_DISABLE,
    D3DTOP_ADDSMOOTH,
    D3DTOP_BLENDTEXTUREALPHAPM,
    D3DTOP_BLENDCURRENTALPHA,
    D3DTOP_MODULATEALPHA_ADDCOLOR,
    D3DTOP_MODULATECOLOR_ADDALPHA,
    D3DTOP_MODULATEINVALPHA_ADDCOLOR,
    D3DTOP_MODULATEINVCOLOR_ADDALPHA,
    D3DTOP_DOTPRODUCT3,
} from "../../src/worker/modules/ddraw/constants";

type Vec4 = [number, number, number, number];
interface Env {
    a0: Vec4; a1: Vec4; a2: Vec4;
    texColor: Vec4; current: Vec4; diffuse: Vec4; textureFactor: Vec4; dst: Vec4;
}
const ENV_NAMES = ["a0", "a1", "a2", "texColor", "current", "diffuse", "textureFactor", "dst"] as const;

const sat = (x: number): number => Math.min(1, Math.max(0, x));
const lerp = (x: number, y: number, t: number): number => x + (y - x) * t;
const dot3 = (a: Vec4, sa: number, b: Vec4, sb: number): number =>
    (a[0] - sa) * (b[0] - sb) + (a[1] - sa) * (b[1] - sb) + (a[2] - sa) * (b[2] - sb);

/** `return EXPR;` of every op branch in the emitted applyStageOp, keyed by D3DTEXTUREOP. */
function shaderOpExpressions(wgsl: string): Map<number, string> {
    const body = /fn applyStageOp\([\s\S]*?\n\}/.exec(wgsl);
    expect(body).not.toBeNull();
    const out = new Map<number, string>();
    for (const m of body![0].matchAll(/if \(op == (\d+)u\)\s*\{ return (.*?); \}/g)) {
        out.set(Number(m[1]), m[2]);
    }
    return out;
}

/** Evaluate one component (0=r,1=g,2=b,3=a) of a combiner expression lifted from the WGSL. */
function evalComponent(expr: string, env: Env, i: number): number {
    const names = ENV_NAMES.join("|");
    let js = expr
        // DOTPRODUCT3 is the one non-component-wise op; keep its registers whole.
        .replace(
            new RegExp(`dot\\((${names})\\.rgb - vec3f\\(([\\d.]+)\\), (${names})\\.rgb - vec3f\\(([\\d.]+)\\)\\)`, "g"),
            "dot3(ARG_$1, $2, ARG_$3, $4)")
        .replace(/vec4f\(/g, "(")
        .replace(/\bone\b/g, "1.0")
        .replace(/\bzero\b/g, "0.0")
        .replace(/\bmix\(/g, "mix(")
        // One pass, so a register rewritten to `diffuse[3]` is not rewritten again.
        .replace(new RegExp(`\\b(${names})(\\.a)?\\b`, "g"), (_m, name, alpha) => `${name}[${alpha ? 3 : i}]`)
        .replace(/ARG_/g, "");
    js = js.trim();
    const fn = new Function(...ENV_NAMES, "clamp", "mix", "dot3", `"use strict"; return (${js});`);
    return fn(env.a0, env.a1, env.a2, env.texColor, env.current, env.diffuse, env.textureFactor, env.dst,
        (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x)),
        (x: number, y: number, t: number) => lerp(x, y, t), dot3);
}

/** D3DTEXTUREOP -> expected value of component `i`, straight from the D3D definitions
 *  (cross-checked against DXVK's d3d9_fixed_function.cpp, which D3D8 shares the enum with). */
const REFERENCE: Record<number, (e: Env, i: number) => number> = {
    2: (e, i) => e.a1[i],
    3: (e, i) => e.a2[i],
    4: (e, i) => e.a1[i] * e.a2[i],
    5: (e, i) => sat(e.a1[i] * e.a2[i] * 2),
    6: (e, i) => sat(e.a1[i] * e.a2[i] * 4),
    7: (e, i) => sat(e.a1[i] + e.a2[i]),
    10: (e, i) => sat(e.a1[i] - e.a2[i]),
    8: (e, i) => sat(e.a1[i] + e.a2[i] - 0.5),
    9: (e, i) => sat((e.a1[i] + e.a2[i] - 0.5) * 2),
    [D3DTOP_ADDSMOOTH]: (e, i) => sat(e.a1[i] + e.a2[i] * (1 - e.a1[i])),
    12: (e, i) => lerp(e.a2[i], e.a1[i], e.diffuse[3]),
    13: (e, i) => lerp(e.a2[i], e.a1[i], e.texColor[3]),
    14: (e, i) => lerp(e.a2[i], e.a1[i], e.textureFactor[3]),
    [D3DTOP_BLENDTEXTUREALPHAPM]: (e, i) => sat(e.a1[i] + e.a2[i] * (1 - e.texColor[3])),
    [D3DTOP_BLENDCURRENTALPHA]: (e, i) => lerp(e.a2[i], e.a1[i], e.current[3]),
    [D3DTOP_MODULATEALPHA_ADDCOLOR]: (e, i) => sat(e.a1[i] + e.a1[3] * e.a2[i]),
    [D3DTOP_MODULATECOLOR_ADDALPHA]: (e, i) => sat(e.a1[i] * e.a2[i] + e.a1[3]),
    [D3DTOP_MODULATEINVALPHA_ADDCOLOR]: (e, i) => sat(e.a1[i] + (1 - e.a1[3]) * e.a2[i]),
    [D3DTOP_MODULATEINVCOLOR_ADDALPHA]: (e, i) => sat((1 - e.a1[i]) * e.a2[i] + e.a1[3]),
    [D3DTOP_DOTPRODUCT3]: (e) => sat(dot3(e.a1, 0.5, e.a2, 0.5) * 4),
    25: (e, i) => sat(e.a0[i] + e.a1[i] * e.a2[i]),
    26: (e, i) => lerp(e.a2[i], e.a1[i], e.a0[i]),
};

function environments(): Env[] {
    let seed = 0x9e3779b9;
    const rnd = (): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return (seed >>> 8) / 0x1000000;
    };
    const v = (): Vec4 => [rnd(), rnd(), rnd(), rnd()];
    const envs: Env[] = [];
    for (let n = 0; n < 8; n++) {
        envs.push({ a0: v(), a1: v(), a2: v(), texColor: v(), current: v(), diffuse: v(), textureFactor: v(), dst: v() });
    }
    envs.push({
        a0: [1, 1, 1, 1], a1: [1, 0.9, 0.1, 0], a2: [1, 0.9, 0.1, 1],
        texColor: [0, 0, 0, 0.25], current: [0, 0, 0, 0.75], diffuse: [0, 0, 0, 0.5], textureFactor: [0, 0, 0, 1],
        dst: [0.5, 0.5, 0.5, 0.5],
    });
    return envs;
}

describe("D3D8/DDraw FFP stage combiner (applyStageOp)", () => {
    const wgsl = generateShaderHelpers();
    const exprs = shaderOpExpressions(wgsl);
    const envs = environments();

    test("the shader implements exactly the ops FFP_D3D8_IMPLEMENTED_OPS advertises", () => {
        const advertised = [...FFP_D3D8_IMPLEMENTED_OPS].sort((a, b) => a - b);
        expect([...exprs.keys()].sort((a, b) => a - b)).toEqual(advertised);
        // DISABLE is handled by the stage cascade before applyStageOp runs.
        expect(FFP_D3D8_IMPLEMENTED_OPS.has(D3DTOP_DISABLE)).toBe(false);
    });

    test("every advertised op is covered by a reference formula", () => {
        expect([...exprs.keys()].sort((a, b) => a - b))
            .toEqual(Object.keys(REFERENCE).map(Number).sort((a, b) => a - b));
    });

    for (const [op, expr] of [...exprs].sort((a, b) => a[0] - b[0])) {
        test(`D3DTEXTUREOP ${op} matches its D3D definition`, () => {
            const ref = REFERENCE[op];
            for (const env of envs) {
                for (let i = 0; i < 4; i++) {
                    expect({ op, i, value: evalComponent(expr, env, i) })
                        .toEqual({ op, i, value: expect.closeTo(ref(env, i), 6) as unknown as number });
                }
            }
        });
    }

    test("BLENDTEXTUREALPHA weighs by the STAGE'S texel alpha, not an argument's", () => {
        const env: Env = {
            a0: [0, 0, 0, 0], a1: [1, 1, 1, 0.0], a2: [0, 0, 0, 1],
            texColor: [0, 0, 0, 0.25], current: [0, 0, 0, 0], diffuse: [0, 0, 0, 0], textureFactor: [0, 0, 0, 0],
            dst: [0, 0, 0, 0],
        };
        expect(evalComponent(exprs.get(13)!, env, 0)).toBeCloseTo(0.25, 6);
    });

    test("DOTPRODUCT3 replicates the same scalar to every channel, incl. alpha", () => {
        const env: Env = {
            a0: [0, 0, 0, 0], a1: [1, 0, 0, 1], a2: [1, 0, 0, 0],
            texColor: [0, 0, 0, 0], current: [0, 0, 0, 0], diffuse: [0, 0, 0, 0], textureFactor: [0, 0, 0, 0],
            dst: [0, 0, 0, 0],
        };
        const expr = exprs.get(D3DTOP_DOTPRODUCT3)!;
        const r = evalComponent(expr, env, 0);
        const g = evalComponent(expr, env, 1);
        const b = evalComponent(expr, env, 2);
        const a = evalComponent(expr, env, 3);
        expect(r).toBeCloseTo(1.0, 6); // dot((0.5,-0.5,-0.5),(0.5,-0.5,-0.5))*4 = (0.25+0.25+0.25)*4 = 3 -> sat = 1
        expect([g, b, a]).toEqual([r, r, r]);
    });

    test("an unimplemented op (PREMODULATE=17) returns the destination register unchanged", () => {
        expect(FFP_D3D8_IMPLEMENTED_OPS.has(17)).toBe(false);
        expect(exprs.has(17)).toBe(false);
        expect(wgsl).toContain("return dst;");
    });
});

describe("D3D8/DDraw FFP stage argument selector (resolveStageArg)", () => {
    const wgsl = generateShaderHelpers();

    test("resolves D3DTA_SPECULAR and D3DTA_TEMP to their own registers, not DIFFUSE", () => {
        const body = /fn resolveStageArg\([\s\S]*?\n\}/.exec(wgsl);
        expect(body).not.toBeNull();
        expect(body![0]).toMatch(/argType == 4u\)\s*\{\s*result = specular;/);
        expect(body![0]).toMatch(/argType == 5u\)\s*\{\s*result = temp;/);
    });

    test("D3DTA_TEMP has no writer on this path: it stays the documented (0,0,0,0) default", () => {
        // No stage-indexed accumulator is threaded into resolveStageArg's `temp` parameter —
        // every call site passes the same zero constant (see emitStageBlock's tempReg).
        expect(wgsl).not.toContain("temp[s]");
    });

    test("applies the D3DTA_COMPLEMENT and D3DTA_ALPHAREPLICATE modifier bits", () => {
        expect(wgsl).toContain("(sel & 16u)");
        expect(wgsl).toContain("(sel & 32u)");
    });
});

const CAPS_PTR = 0x100;

function readCaps8(): DataView {
    const memory = new Uint8Array(0x1000);
    Mem.bind(() => memory);
    expect(writeDeviceCaps8(CAPS_PTR, memory)).toBe(true);
    return new DataView(memory.buffer, CAPS_PTR, 212);
}

describe("D3DCAPS8 TextureOpCaps is derived from the implementation, not hand-maintained", () => {
    test("every op FFP_D3D8_IMPLEMENTED_OPS lists is advertised", () => {
        const caps = readCaps8();
        const textureOpCaps = caps.getUint32(144, true);
        for (const op of FFP_D3D8_IMPLEMENTED_OPS) {
            expect(textureOpCaps & (1 << (op - 1))).not.toBe(0);
        }
    });

    test("no op outside the implemented set (+DISABLE) is advertised", () => {
        const caps = readCaps8();
        const textureOpCaps = caps.getUint32(144, true);
        const implementedBits = [...FFP_D3D8_IMPLEMENTED_OPS, D3DTOP_DISABLE]
            .reduce((mask, op) => mask | (1 << (op - 1)), 0);
        expect(textureOpCaps & ~implementedBits).toBe(0);
    });

    test("the eight previously silently-wrong ops (ADDSMOOTH..DOTPRODUCT3) are now truthfully advertised", () => {
        const caps = readCaps8();
        const textureOpCaps = caps.getUint32(144, true);
        for (const op of [
            D3DTOP_ADDSMOOTH, D3DTOP_BLENDTEXTUREALPHAPM, D3DTOP_BLENDCURRENTALPHA,
            D3DTOP_MODULATEALPHA_ADDCOLOR, D3DTOP_MODULATECOLOR_ADDALPHA,
            D3DTOP_MODULATEINVALPHA_ADDCOLOR, D3DTOP_MODULATEINVCOLOR_ADDALPHA, D3DTOP_DOTPRODUCT3,
        ]) {
            expect(textureOpCaps & (1 << (op - 1))).not.toBe(0);
        }
    });
});

describe("D3DCAPS8 MaxTextureBlendStages / MaxSimultaneousTextures are two different, honest caps", () => {
    test("MaxSimultaneousTextures matches the resolver's real sampling cap (4), not the blend-stage depth (8)", () => {
        const caps = readCaps8();
        expect(caps.getUint32(148, true)).toBe(MAX_FFP_STAGES); // MaxTextureBlendStages
        expect(caps.getUint32(152, true)).toBe(MAX_FFP_SAMPLED_STAGES); // MaxSimultaneousTextures
        // Pin the actual numbers so a change to either constant is a visible test diff, not a
        // silent cap drift: this is exactly the class of bug the audit found (MaxSimultaneous
        // Textures=8 advertised against a MAX_FFP_SAMPLED_STAGES=4 pipeline).
        expect(MAX_FFP_STAGES).toBe(8);
        expect(MAX_FFP_SAMPLED_STAGES).toBe(4);
    });
});

describe("D3DCAPS8 MaxTextureAspectRatio is a ratio, not a texture dimension", () => {
    test("it is not tied to the WebGPU 2-D dimension limit", () => {
        const caps = readCaps8();
        const maxAspect = caps.getUint32(104, true);
        const maxWidth = caps.getUint32(88, true);
        // 0 means "unlimited"; anything else must be a real bound. Writing the 2-D dimension
        // limit here answers a different question than the one the app asked, and it shrank
        // with the live WebGPU limit — a device with maxTextureDimension2D=4096 would have
        // claimed textures wider than 4096:1 are unsupported.
        expect(maxAspect === 0 || maxAspect >= 8192).toBe(true);
        expect(maxAspect).not.toBe(maxWidth);
    });

    test("the __caps8Legacy kill switch does not carry it either", () => {
        const g = globalThis as Record<string, unknown>;
        const prev = g.__caps8Legacy;
        g.__caps8Legacy = true;
        try {
            // The legacy branch exists to revert to the pre-caps-rewrite answers; a field added
            // to it changes what the A/B reverts TO, which makes the switch useless as a control.
            expect(readCaps8().getUint32(104, true)).toBe(0);
        } finally {
            if (prev === undefined) delete g.__caps8Legacy; else g.__caps8Legacy = prev;
        }
    });
});
