/**
 * The D3D9 FFP texture-stage combiner is WGSL, so nothing on the JS side ever executes it and
 * a wrong formula shows up only as a mis-shaded (or, through the alpha test, a MISSING) surface
 * in one game.
 *
 * These tests execute it anyway: each `if (op == Nu) { return EXPR; }` is lifted out of the
 * generated shader and evaluated one component at a time against a reference written from the
 * D3DTEXTUREOP definitions. The evaluator understands only the vocabulary the combiner uses,
 * so an expression it cannot parse fails loudly instead of being skipped.
 *
 * The other half is the census contract: `FFP_IMPLEMENTED_OPS` is what tells the operator an op
 * is missing. If it claims an op the shader has no branch for (or hides one it does), the
 * counter reports a comfortable zero for a gap that is eating pixels — so the two are compared
 * directly, in both directions.
 */
import { describe, expect, test } from "bun:test";
import { FFP_IMPLEMENTED_OPS, emitFfpCombinerWgsl } from "../../src/worker/backends/webgpu/d3d9/ffp-combiner";

type Vec4 = [number, number, number, number];
interface Env {
    a0: Vec4; a1: Vec4; a2: Vec4;
    texC: Vec4; cur: Vec4; diff: Vec4; tf: Vec4; dst: Vec4;
}
const ENV_NAMES = ["a0", "a1", "a2", "texC", "cur", "diff", "tf", "dst"] as const;

const sat = (x: number): number => Math.min(1, Math.max(0, x));
const lerp = (x: number, y: number, t: number): number => x + (y - x) * t;
const dot3 = (a: Vec4, sa: number, b: Vec4, sb: number): number =>
    (a[0] - sa) * (b[0] - sb) + (a[1] - sa) * (b[1] - sb) + (a[2] - sa) * (b[2] - sb);

/** `return EXPR;` of every op branch in the emitted ffpStageOp, keyed by D3DTEXTUREOP. */
function shaderOpExpressions(wgsl: string): Map<number, string> {
    const body = /fn ffpStageOp\([\s\S]*?\n\}/.exec(wgsl);
    expect(body).not.toBeNull();
    const out = new Map<number, string>();
    for (const m of body![0].matchAll(/if \(op == (\d+)u\) \{ return (.*?); \}/g)) {
        out.set(Number(m[1]), m[2]);
    }
    return out;
}

/**
 * Evaluate one component of a combiner expression. Every op but DOTPRODUCT3 is component-wise,
 * so a vec4 expression becomes a scalar one by indexing each register — which is also why an
 * unknown identifier survives the rewrite and throws at evaluation instead of reading as 0.
 */
function evalComponent(expr: string, env: Env, i: number): number {
    const names = ENV_NAMES.join("|");
    let js = expr
        // DOTPRODUCT3 is the one non-component-wise op; keep its registers whole (the ARG_
        // prefix hides them from the component rewrite below).
        .replace(
            new RegExp(`dot\\((${names})\\.rgb - vec3<f32>\\(([\\d.]+)\\), (${names})\\.rgb - vec3<f32>\\(([\\d.]+)\\)\\)`, "g"),
            "dot3(ARG_$1, $2, ARG_$3, $4)")
        .replace(/vec4<f32>\(/g, "(")
        .replace(/\bone\b/g, "1.0")
        .replace(/\bzero\b/g, "0.0")
        // One pass, so a register rewritten to `diff[3]` is not rewritten again to `diff[i][3]`.
        .replace(new RegExp(`\\b(${names})(\\.a)?\\b`, "g"), (_m, name, alpha) => `${name}[${alpha ? 3 : i}]`)
        .replace(/ARG_/g, "");
    // Anything left that is not a number, an operator or a known helper means the evaluator has
    // fallen behind the shader — better a hard failure than a silently wrong reference.
    js = js.trim();
    const fn = new Function(...ENV_NAMES, "clamp", "mix", "dot3", `"use strict"; return (${js});`);
    return fn(env.a0, env.a1, env.a2, env.texC, env.cur, env.diff, env.tf, env.dst,
        (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x)), lerp, dot3);
}

/** D3DTEXTUREOP → expected value of component `i`, straight from the D3D definitions. */
const REFERENCE: Record<number, (e: Env, i: number) => number> = {
    2: (e, i) => e.a1[i],
    3: (e, i) => e.a2[i],
    4: (e, i) => sat(e.a1[i] * e.a2[i]),
    5: (e, i) => sat(e.a1[i] * e.a2[i] * 2),
    6: (e, i) => sat(e.a1[i] * e.a2[i] * 4),
    7: (e, i) => sat(e.a1[i] + e.a2[i]),
    8: (e, i) => sat(e.a1[i] + e.a2[i] - 0.5),
    9: (e, i) => sat((e.a1[i] + e.a2[i] - 0.5) * 2),
    10: (e, i) => sat(e.a1[i] - e.a2[i]),
    11: (e, i) => sat(e.a1[i] + e.a2[i] * (1 - e.a1[i])),
    12: (e, i) => lerp(e.a2[i], e.a1[i], e.diff[3]),
    13: (e, i) => lerp(e.a2[i], e.a1[i], e.texC[3]),
    14: (e, i) => lerp(e.a2[i], e.a1[i], e.tf[3]),
    15: (e, i) => sat(e.a1[i] + e.a2[i] * (1 - e.texC[3])),
    16: (e, i) => lerp(e.a2[i], e.a1[i], e.cur[3]),
    18: (e, i) => sat(e.a1[i] + e.a1[3] * e.a2[i]),
    19: (e, i) => sat(e.a1[i] * e.a2[i] + e.a1[3]),
    20: (e, i) => sat(e.a1[i] + (1 - e.a1[3]) * e.a2[i]),
    21: (e, i) => sat((1 - e.a1[i]) * e.a2[i] + e.a1[3]),
    24: (e) => sat(dot3(e.a1, 0.5, e.a2, 0.5) * 4),
    25: (e, i) => sat(e.a0[i] + e.a1[i] * e.a2[i]),
    26: (e, i) => lerp(e.a2[i], e.a1[i], e.a0[i]),
};

/** Deterministic pseudo-random environments, incl. values that exercise the saturation. */
function environments(): Env[] {
    let seed = 0x9e3779b9;
    const rnd = (): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return (seed >>> 8) / 0x1000000;
    };
    const v = (): Vec4 => [rnd(), rnd(), rnd(), rnd()];
    const envs: Env[] = [];
    for (let n = 0; n < 8; n++) {
        envs.push({ a0: v(), a1: v(), a2: v(), texC: v(), cur: v(), diff: v(), tf: v(), dst: v() });
    }
    // Extremes: MODULATE4X / ADD / SUBTRACT must clamp, not wrap or go negative.
    envs.push({
        a0: [1, 1, 1, 1], a1: [1, 0.9, 0.1, 0], a2: [1, 0.9, 0.1, 1],
        texC: [0, 0, 0, 0.25], cur: [0, 0, 0, 0.75], diff: [0, 0, 0, 0.5], tf: [0, 0, 0, 1],
        dst: [0.5, 0.5, 0.5, 0.5],
    });
    return envs;
}

describe("D3D9 FFP stage combiner", () => {
    const wgsl = emitFfpCombinerWgsl("dst");
    const exprs = shaderOpExpressions(wgsl);
    const envs = environments();

    test("the shader implements exactly the ops FFP_IMPLEMENTED_OPS advertises", () => {
        // DISABLE (1) never reaches ffpStageOp — the cascade handles it — so it is not advertised.
        const advertised = [...FFP_IMPLEMENTED_OPS].sort((a, b) => a - b);
        expect([...exprs.keys()].sort((a, b) => a - b)).toEqual(advertised);
        expect(FFP_IMPLEMENTED_OPS.has(1)).toBe(false);
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

    test("BLENDTEXTUREALPHA weighs by the TEXEL alpha, not by an argument's", () => {
        // The two are equal in the common arg1==TEXTURE setup, which is exactly why weighing by
        // arg1.a survives casual inspection; force them apart so only the texel alpha passes.
        const env: Env = {
            a0: [0, 0, 0, 0], a1: [1, 1, 1, 0.0], a2: [0, 0, 0, 1],
            texC: [0, 0, 0, 0.25], cur: [0, 0, 0, 0], diff: [0, 0, 0, 0], tf: [0, 0, 0, 0],
            dst: [0, 0, 0, 0],
        };
        expect(evalComponent(exprs.get(13)!, env, 0)).toBeCloseTo(0.25, 6);
    });

    test("an unimplemented op returns the destination register, unchanged", () => {
        // PREMODULATE and BUMPENVMAP[LUMINANCE] read the next stage's texture; leaving `dst`
        // alone is the only fallback that cannot invent pixels.
        for (const op of [17, 22, 23]) {
            expect(FFP_IMPLEMENTED_OPS.has(op)).toBe(false);
            expect(exprs.has(op)).toBe(false);
        }
        expect(wgsl).toContain("return dst;");
    });

    test("the fallback expression is what the caller passes (the magenta diagnostic)", () => {
        expect(emitFfpCombinerWgsl("vec4<f32>(1.0, 0.0, 1.0, 1.0)"))
            .toContain("return vec4<f32>(1.0, 0.0, 1.0, 1.0);");
    });
});

describe("D3D9 FFP stage argument selector", () => {
    const wgsl = emitFfpCombinerWgsl("dst");

    test("resolves SPECULAR and TEMP to their own registers, not to diffuse", () => {
        expect(wgsl).toContain("if (base == 4u) { c = spec; }");
        expect(wgsl).toContain("if (base == 5u) { c = tmp; }");
    });

    test("applies the D3DTA_COMPLEMENT and D3DTA_ALPHAREPLICATE modifier bits", () => {
        expect(wgsl).toContain("(sel & 0x10u)");
        expect(wgsl).toContain("(sel & 0x20u)");
    });
});
