import { describe, expect, test } from "bun:test";
import { analyzePs, emitPsMain } from "../../src/worker/backends/webgpu/d3d9/shader/emit/ps";
import { Census } from "../../src/worker/backends/webgpu/d3d9/shader/census";
import { planUniformity } from "../../src/worker/backends/webgpu/d3d9/shader/passes/uniformity";
import { Op, RegType } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";
import type { SmInstruction, SmProgram, SmSource } from "../../src/worker/backends/webgpu/d3d9/shader/sm-parser";

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

    test("refuses texldd in dynamic control flow instead of emitting textureSampleGrad", () => {
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

        expect(() => emitPsMain(program, analyzePs(program))).toThrow(
            "D3D9 texldd in dynamic control flow cannot be lowered to WGSL; refusing link",
        );
    });

    test("uniformity pass refuses every explicit derivative below divergent flow", () => {
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
        expect(plan.isDerivativeRefused(texldd)).toBe(true);
        expect(census.summary()).toMatchObject({
            unsupported: 3,
            unsupportedOps: ["dsx", "dsy", "texldd"],
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

    test("a per-lane break makes the same rep divergent again", () => {
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

        expect(planUniformity(program).isDerivativeRefused(texldd)).toBe(true);
    });
});
