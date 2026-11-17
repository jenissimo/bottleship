import { describe, expect, test } from "bun:test";
import { analyzePs, emitPsMain } from "../../src/worker/backends/webgpu/d3d9/shader/emit/ps";
import { Census } from "../../src/worker/backends/webgpu/d3d9/shader/census";
import { planUniformity } from "../../src/worker/backends/webgpu/d3d9/shader/passes/uniformity";
import { Op, RegType, TexType, Usage } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";
import type { SmInstruction, SmProgram, SmSource } from "../../src/worker/backends/webgpu/d3d9/shader/sm-parser";

import { compilePixelShader, compileVertexShader, linkProgram } from "../../src/worker/backends/webgpu/d3d9/shader";
import { probeOfflineWgslValidator, validateWgslOffline } from "../d3d9-parity/wgsl-validator";

const IDENTITY = 0xe4;

function source(type: RegType, num: number): SmSource {
    return { reg: { type, num, relative: false }, swizzle: IDENTITY, modifier: 0 };
}

function destination(num: number): NonNullable<SmInstruction["dst"]> {
    return {
        reg: { type: RegType.TEMP, num, relative: false },
        writeMask: 0xf,
        shift: 0,
        saturate: false,
        partialPrecision: false,
        centroid: false,
    };
}

function instruction(
    opcode: Op,
    src: SmSource[] = [],
    dst: SmInstruction["dst"] = null,
    specificData = 0,
): SmInstruction {
    return { opcode, coissue: false, predicated: false, specificData, dst, src };
}

function pixelProgram(instructions: SmInstruction[]): SmProgram {
    return {
        isPixelShader: true,
        major: 3,
        minor: 0,
        instructions,
        declarations: [],
        definitions: [],
        maxTemp: 2,
        maxConst: -1,
        maxBool: -1,
        samplersUsed: new Set([0, 1]),
        inputRegs: new Set([0, 1]),
        usesRelativeConst: false,
        stream: [],
        tokenCount: 0,
        terminated: true,
    };
}

describe("D3D9 divergent texture gradients", () => {
    test("derives projected 2D and cube sample addresses with matching gradient widths", () => {
        const coordinate = source(RegType.INPUT, 0);
        const program = pixelProgram([
            instruction(Op.IF, [source(RegType.INPUT, 1)]),
            instruction(Op.TEX, [coordinate, source(RegType.SAMPLER, 0)], destination(0), 1),
            instruction(Op.TEX, [coordinate, source(RegType.SAMPLER, 1)], destination(1), 1),
            instruction(Op.ENDIF),
        ]);

        const wgsl = emitPsMain(program, analyzePs(program), null, 1 << 1);

        expect(wgsl).toContain("dpdx(((in.tex0) / (in.tex0).w).xy)");
        expect(wgsl).toContain("dpdy(((in.tex0) / (in.tex0).w).xy)");
        expect(wgsl).toContain("dpdx(((in.tex0) / (in.tex0).w).xyz)");
        expect(wgsl).toContain("dpdy(((in.tex0) / (in.tex0).w).xyz)");
        expect(wgsl).toMatch(/textureSampleGrad\(tex1, samp1, .*\.xyz, _ddx\d+, _ddy\d+\)/);

        const firstIf = wgsl.indexOf("if (");
        expect(wgsl.indexOf("dpdx(")).toBeLessThan(firstIf);
    });

    test("preserves texldb bias when a dynamic sample is lowered to gradients", () => {
        const coordinate = source(RegType.INPUT, 0);
        const program = pixelProgram([
            instruction(Op.IF, [source(RegType.INPUT, 1)]),
            instruction(Op.TEX, [coordinate, source(RegType.SAMPLER, 0)], destination(0), 2),
            instruction(Op.ENDIF),
        ]);

        const wgsl = emitPsMain(program, analyzePs(program));

        expect(wgsl).toContain("textureSampleGrad(tex0, samp");
        expect(wgsl).toContain("exp2((_tc");
    });

    test("preserves explicit texldd gradients inside dynamic control flow", () => {
        const coordinate = source(RegType.INPUT, 0);
        const gradientSample = instruction(
            Op.TEXLDD,
            [coordinate, source(RegType.SAMPLER, 0), coordinate, coordinate],
            destination(0),
        );
        const program = pixelProgram([
            instruction(Op.IF, [source(RegType.INPUT, 1)]),
            gradientSample,
            instruction(Op.ENDIF),
        ]);

        const wgsl = emitPsMain(program, analyzePs(program));
        expect(wgsl).toContain("textureSampleGrad(tex0, samp");
        expect(wgsl.indexOf("textureSampleGrad(")).toBeGreaterThan(wgsl.indexOf("if ("));
        expect(wgsl).not.toContain("dpdx(");
        expect(wgsl).not.toContain("dpdy(");
    });

    test("uniformity pass refuses derivative computation, not sampling with explicit gradients", () => {
        const coordinate = source(RegType.INPUT, 0);
        const dsx = instruction(Op.DSX, [coordinate], destination(0));
        const dsy = instruction(Op.DSY, [coordinate], destination(1));
        const texldd = instruction(
            Op.TEXLDD,
            [coordinate, source(RegType.SAMPLER, 0), coordinate, coordinate],
            destination(2),
        );
        const program = pixelProgram([
            instruction(Op.IF, [source(RegType.INPUT, 1)]),
            dsx,
            dsy,
            texldd,
            instruction(Op.ENDIF),
        ]);
        const census = new Census();
        const plan = planUniformity(program, { census });

        expect(plan.isDerivativeRefused(dsx)).toBe(true);
        expect(plan.isDerivativeRefused(dsy)).toBe(true);
        expect(plan.isDerivativeRefused(texldd)).toBe(false);
        expect(census.summary()).toMatchObject({
            unsupported: 2,
            unsupportedOps: ["dsx", "dsy"],
        });
    });

    test("a loop-carried coordinate is not stable on the second iteration", () => {
        // mov r0, t0 / rep i0 { texld r1, r0, s0 ; mul r0, r1, c0 } endrep
        // A single forward walk sees only `mov r0, t0` and would hoist a gradient
        // built from dpdx(t0) — the address only iteration 1 ever samples.
        const sample = instruction(
            Op.TEX,
            [source(RegType.TEMP, 0), source(RegType.SAMPLER, 0)],
            destination(1),
        );
        const program = pixelProgram([
            instruction(Op.MOV, [source(RegType.INPUT, 0)], destination(0)),
            instruction(Op.REP, [source(RegType.CONSTINT, 0)]),
            sample,
            instruction(Op.MUL, [source(RegType.TEMP, 1), source(RegType.CONST, 0)], destination(0)),
            instruction(Op.ENDREP),
        ]);

        const plan = planUniformity(program);
        const planned = plan.get(sample);
        expect(planned?.coordinateSafety).not.toBe("stable");
        expect(planned?.reason).not.toBe("stable-coordinate");
        expect(planned?.derivative?.coordinateExpression).toBeUndefined();
    });

    test("a uniform rep is uniform control flow for an explicit derivative", () => {
        // rep i0 { texldd r0, t0, s0, t1, t1 } endrep — the trip count comes from
        // the integer constant bank, so WGSL accepts a derivative in the body.
        const coordinate = source(RegType.INPUT, 0);
        const gradient = source(RegType.INPUT, 1);
        const texldd = instruction(
            Op.TEXLDD,
            [coordinate, source(RegType.SAMPLER, 0), gradient, gradient],
            destination(0),
        );
        const program = pixelProgram([
            instruction(Op.REP, [source(RegType.CONSTINT, 0)]),
            texldd,
            instruction(Op.ENDREP),
        ]);

        const census = new Census();
        expect(planUniformity(program, { census }).isDerivativeRefused(texldd)).toBe(false);
        expect(census.summary().unsupported).toBe(0);
        expect(emitPsMain(program, analyzePs(program))).toContain("textureSampleGrad(tex0, samp");
    });

    test("explicit gradients remain usable after a per-lane break", () => {
        const coordinate = source(RegType.INPUT, 0);
        const gradient = source(RegType.INPUT, 1);
        const texldd = instruction(
            Op.TEXLDD,
            [coordinate, source(RegType.SAMPLER, 0), gradient, gradient],
            destination(0),
        );
        const program = pixelProgram([
            instruction(Op.REP, [source(RegType.CONSTINT, 0)]),
            instruction(Op.IF, [source(RegType.INPUT, 1)]),
            instruction(Op.BREAK),
            instruction(Op.ENDIF),
            texldd,
            instruction(Op.ENDREP),
        ]);

        expect(planUniformity(program).isDerivativeRefused(texldd)).toBe(false);
        expect(emitPsMain(program, analyzePs(program))).toContain("textureSampleGrad(tex0, samp");
    });

    test("nested uniform reps sample loop-carried coordinates without hoisting derivatives", () => {
        const sample = instruction(Op.TEX, [source(RegType.TEMP, 0), source(RegType.SAMPLER, 0)], destination(1));
        const program = pixelProgram([
            instruction(Op.MOV, [source(RegType.INPUT, 0)], destination(0)),
            instruction(Op.REP, [source(RegType.CONSTINT, 0)]),
            instruction(Op.REP, [source(RegType.CONSTINT, 1)]),
            sample,
            instruction(Op.MUL, [source(RegType.TEMP, 1), source(RegType.CONST, 0)], destination(0)),
            instruction(Op.ENDREP),
            instruction(Op.ENDREP),
        ]);
        expect(planUniformity(program).get(sample)).toMatchObject({ mode: "implicit", divergent: false, derivative: null });
        const wgsl = emitPsMain(program, analyzePs(program));
        expect(wgsl).toContain("textureSample(tex0, samp");
        expect(wgsl).not.toContain("dpdx(");
        expect(wgsl.indexOf("textureSample(")).toBeGreaterThan(wgsl.lastIndexOf("for ("));
    });

    test("an implicit sample with a non-affine coordinate remains refused after a per-lane break", () => {
        const sample = instruction(Op.TEX, [source(RegType.TEMP, 0), source(RegType.SAMPLER, 0)], destination(1));
        const program = pixelProgram([
            instruction(Op.REP, [source(RegType.CONSTINT, 0)]),
            instruction(Op.IF, [source(RegType.INPUT, 1)]),
            instruction(Op.BREAK),
            instruction(Op.ENDIF),
            instruction(Op.MUL, [source(RegType.INPUT, 0), source(RegType.INPUT, 1)], destination(0)),
            sample,
            instruction(Op.ENDREP),
        ]);
        expect(planUniformity(program).get(sample)).toMatchObject({ mode: "refuse", divergent: true });
        expect(() => emitPsMain(program, analyzePs(program))).toThrow("refusing link");
    });
});

// Validate complete linked modules, including branch-local gradients and a loop
// whose lanes leave on different iterations. No derivative may be hoisted.
const validator = probeOfflineWgslValidator();
const reg = (type: number, num: number) => (((type & 7) << 28) | (((type >>> 3) & 3) << 11) | num) >>> 0;
const token = (op: number, operands: number) => (op | (operands << 24)) >>> 0;
const dst = (type: number, num: number) => (reg(type, num) | (0xf << 16)) >>> 0;
const src = (type: number, num: number) => (reg(type, num) | (IDENTITY << 16)) >>> 0;
const dcl = (usage: number, index: number, type: number, num: number, texType = 0) => [
    token(Op.DCL, 2), (usage | (index << 16) | (texType << 27)) >>> 0, reg(type, num),
];
const vs = compileVertexShader(new Uint32Array([
    0xfffe0300,
    ...dcl(Usage.POSITION, 0, RegType.INPUT, 0),
    ...dcl(Usage.POSITION, 0, RegType.OUTPUT, 0),
    ...dcl(Usage.TEXCOORD, 0, RegType.OUTPUT, 1),
    token(Op.MOV, 2), dst(RegType.OUTPUT, 0), src(RegType.INPUT, 0),
    token(Op.MOV, 2), dst(RegType.OUTPUT, 1), src(RegType.INPUT, 0), 0xffff,
]));

describe.skipIf(!validator.available)("divergent TEXLDD complete WGSL validation", () => {
    for (const texture of [TexType.D2, TexType.CUBE, TexType.VOLUME]) {
        for (const loop of [false, true]) {
            test(`texture ${texture}, divergent ${loop ? "loop" : "branch"}`, () => {
                const ps = compilePixelShader(new Uint32Array([
                    0xffff0300,
                    ...dcl(Usage.TEXCOORD, 0, RegType.INPUT, 0),
                    ...dcl(0, 0, RegType.SAMPLER, 0, texture),
                    ...(loop ? [token(Op.REP, 1), src(RegType.CONSTINT, 0)] : []),
                    token(Op.IF, 1), src(RegType.INPUT, 0),
                    ...(loop ? [token(Op.BREAK, 0), token(Op.ENDIF, 0)] : []),
                    token(Op.MUL, 3), dst(RegType.TEMP, 1), src(RegType.INPUT, 0), src(RegType.INPUT, 0),
                    token(Op.ADD, 3), dst(RegType.TEMP, 2), src(RegType.INPUT, 0), src(RegType.TEMP, 1),
                    token(Op.TEXLDD, 5), dst(RegType.TEMP, 0), src(RegType.INPUT, 0), src(RegType.SAMPLER, 0), src(RegType.TEMP, 1), src(RegType.TEMP, 2),
                    token(loop ? Op.ENDREP : Op.ENDIF, 0),
                    token(Op.MOV, 2), dst(RegType.COLOROUT, 0), src(RegType.TEMP, 0), 0xffff,
                ]));
                const linked = linkProgram({ vs, ps, declElements: null, streamStride: 16 });
                expect(linked.wgsl).toContain("textureSampleGrad(tex0, samp");
                expect(linked.wgsl).not.toContain("dpdx(");
                expect(linked.wgsl).not.toContain("dpdy(");
                expect(linked.census.ps.unsupportedOps).toEqual([]);
                const result = validateWgslOffline(linked.wgsl, validator);
                expect(result.status, result.diagnostics ?? result.reason).toBe("passed");
            });
        }
    }
});
