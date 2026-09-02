import { describe, expect, test } from "bun:test";
import { emitVsMain, analyzeVs } from "../../src/worker/backends/webgpu/d3d9/shader/emit/vs";
import { emitPsMain, analyzePs } from "../../src/worker/backends/webgpu/d3d9/shader/emit/ps";
import { structureProgram, StructureError } from "../../src/worker/backends/webgpu/d3d9/shader/passes/structure";
import { Op, RegType } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";
import type { SmInstruction, SmProgram, SmSource } from "../../src/worker/backends/webgpu/d3d9/shader/sm-parser";
import { asmFixture, d3dxOracleAvailable } from "./helpers/asm-fixture";
import { parseShader } from "../../src/worker/backends/webgpu/d3d9/shader/sm-parser";
import { compileVertexShader, linkProgram } from "../../src/worker/backends/webgpu/d3d9/shader";
import { Census, type CensusSummary } from "../../src/worker/backends/webgpu/d3d9/shader/census";
import { System } from "../../src/worker/core/system";
import { registerShaderCommands } from "../../src/worker/harness/cmds/shader";

const FULL_SWIZZLE = 0xe4;

function source(type: RegType, num: number): SmSource {
    return { reg: { type, num, relative: false }, swizzle: FULL_SWIZZLE, modifier: 0 };
}

function destination(type: RegType, num: number): NonNullable<SmInstruction["dst"]> {
    return {
        reg: { type, num, relative: false },
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
    comparison?: SmInstruction["comparison"],
): SmInstruction {
    return { opcode, coissue: false, predicated: false, specificData, comparison, dst, src };
}

function program(instructions: SmInstruction[]): SmProgram {
    return {
        isPixelShader: false,
        major: 3,
        minor: 0,
        instructions,
        declarations: [],
        definitions: [],
        maxTemp: 1,
        maxConst: 1,
        maxBool: 0,
        samplersUsed: new Set(),
        inputRegs: new Set(),
        usesRelativeConst: false,
        stream: [],
        tokenCount: 0,
        terminated: true,
    };
}

function pixelProgram(instructions: SmInstruction[]): SmProgram {
    return {
        ...program(instructions),
        isPixelShader: true,
        samplersUsed: new Set([0]),
    };
}

function pixelProgramAt(major: number, instructions: SmInstruction[] = []): SmProgram {
    return { ...pixelProgram(instructions), major };
}

function lowerWithCensus(instructions: SmInstruction[]): { wgsl: string; census: CensusSummary } {
    const prog = program(instructions);
    const census = new Census();
    const wgsl = emitVsMain(prog, analyzeVs(prog), {
        interpColors: [false, false],
        interpTexcoords: [],
        inputExprs: new Map(),
        constantCount: 2,
        pixelCentreSlot: 2,
        census,
    });
    return { wgsl, census: census.summary() };
}

function lower(instructions: SmInstruction[]): string {
    return lowerWithCensus(instructions).wgsl;
}

describe("D3D9 SM3 structured flow lowering", () => {
    test("emits fixed-function pixel fog only for PS major < 3, with alpha test first", () => {
        const fog = {
            enabled: "fogParams.w > 0.0",
            mode: "fogParams.w",
            start: "fogParams.x",
            end: "fogParams.y",
            density: "fogParams.z",
            color: "fogColor",
            clipZ: "(in.pos).z",
            clipW: "(in.pos).w",
        };
        const ps2 = pixelProgramAt(2, [
            instruction(Op.MOV, [source(RegType.CONST, 0)], destination(RegType.COLOROUT, 0)),
        ]);
        const ps2Wgsl = emitPsMain(ps2, analyzePs(ps2), { func: 7, ref: 128 }, 0, 0, fog);
        expect(ps2Wgsl).toContain("fn ffpFogFactor(");
        expect(ps2Wgsl).toContain("if (fogParams.w > 0.0) {");
        expect(ps2Wgsl).toContain("mix(vec3<f32>(oC0[0], oC0[1], oC0[2]), (fogColor).rgb, _psFogFactor)");
        expect(ps2Wgsl.indexOf("discard;")).toBeLessThan(ps2Wgsl.indexOf("_psFogFactor"));

        const fogOff = emitPsMain(ps2, analyzePs(ps2));
        expect(fogOff).not.toContain("fn ffpFogFactor(");
        expect(fogOff).not.toContain("_psFogFactor");

        const ps1 = pixelProgramAt(1, [
            instruction(Op.MOV, [source(RegType.CONST, 0)], destination(RegType.TEMP, 0)),
        ]);
        const ps1Wgsl = emitPsMain(ps1, analyzePs(ps1), null, 0, 0, fog);
        expect(ps1Wgsl).toContain("mix(vec3<f32>(r0[0], r0[1], r0[2]), (fogColor).rgb, _psFogFactor)");

        const ps3 = pixelProgramAt(3, [
            instruction(Op.MOV, [source(RegType.CONST, 0)], destination(RegType.COLOROUT, 0)),
        ]);
        const ps3Wgsl = emitPsMain(ps3, analyzePs(ps3), null, 0, 0, fog);
        expect(ps3Wgsl).not.toContain("fn ffpFogFactor(");
        expect(ps3Wgsl).not.toContain("_psFogFactor");
    });

    test("lowers if, ifc, else, and endif without executing either body unconditionally", () => {
        const { wgsl, census } = lowerWithCensus([
            instruction(Op.IF, [source(RegType.CONSTBOOL, 0)]),
            instruction(Op.MOV, [source(RegType.INPUT, 0)], destination(RegType.RASTOUT, 0)),
            instruction(Op.ELSE),
            instruction(Op.MOV, [source(RegType.INPUT, 1)], destination(RegType.RASTOUT, 0)),
            instruction(Op.ENDIF),
            instruction(Op.IFC, [source(RegType.TEMP, 0), source(RegType.CONST, 1)], null, 1, "gt"),
            instruction(Op.MOV, [source(RegType.INPUT, 2)], destination(RegType.RASTOUT, 0)),
            instruction(Op.ENDIF),
        ]);

        expect(wgsl).toContain("if (vsBool(0u)) {");
        expect(wgsl).toContain("} else {");
        expect(wgsl).toContain("if (((vec4<f32>(r0)).x > (vec4<f32>(vsc.c[1])).x)) {");
        expect(census.unsupportedOps).toEqual([]);
    });

    test("lowers rep with an observable iteration body", () => {
        const { wgsl, census } = lowerWithCensus([
            instruction(Op.REP, [source(RegType.CONSTINT, 0)]),
            instruction(Op.ADD, [source(RegType.TEMP, 0), source(RegType.CONST, 1)], destination(RegType.TEMP, 0)),
            instruction(Op.ENDREP),
        ]);

        expect(wgsl).toContain("for (var _repI");
        expect(wgsl).toContain("clamp(i32(select(ceil(((vec4<f32>(vsc.i[0])).x) - 0.5)");
        expect(wgsl).toContain("r0 = vec4<f32>(_st");
        expect(wgsl).not.toMatch(/r0\.[xyzw]\s*=/);
        expect(census.unsupportedOps).toEqual([]);
    });

    test("uses a lexical aL local and i#.xyz count, initial, and stride", () => {
        const wgsl = lower([
            instruction(Op.LOOP, [source(RegType.LOOP, 0), source(RegType.CONSTINT, 0)]),
            instruction(Op.MOV, [source(RegType.LOOP, 0)], destination(RegType.TEMP, 0)),
            instruction(Op.ADD, [source(RegType.TEMP, 0), source(RegType.CONST, 1)], destination(RegType.TEMP, 0)),
            instruction(Op.ENDLOOP),
        ]);

        expect(wgsl).toContain("let _loopCount");
        expect(wgsl).toContain("let _loopInitial");
        expect(wgsl).toContain("let _loopStride");
        expect(wgsl).toContain("var aL: i32 =");
        expect(wgsl).toContain("vec4<f32>(f32(aL))");
        expect(wgsl).toContain("clamp(i32(select(ceil(((vec4<f32>(vsc.i[0])).x) - 0.5)");
    });

    test("lowers break, breakc, and breakp only inside the loop", () => {
        const wgsl = lower([
            instruction(Op.LOOP, [source(RegType.LOOP, 0), source(RegType.CONSTINT, 0)]),
            instruction(Op.BREAK),
            instruction(Op.BREAKC, [source(RegType.TEMP, 0), source(RegType.CONST, 1)], null, 4, "lt"),
            instruction(Op.BREAKP, [source(RegType.PREDICATE, 0)]),
            instruction(Op.ENDLOOP),
        ]);

        expect(wgsl).toContain("break;");
        expect(wgsl).toContain("if (((vec4<f32>(r0)).x < (vec4<f32>(vsc.c[1])).x))");
        // Scalar control flow consumes the predicate's x lane; arithmetic
        // predication keeps the full four-lane register.
        expect(wgsl).toContain("if ((vec4<bool>(p0))[0])");
        expect(wgsl).toContain("var p0: vec4<bool> = vec4<bool>(false);");
    });

    test("rejects malformed flow rather than emitting an unconditional body", () => {
        expect(() => structureProgram(program([
            instruction(Op.LOOP, [source(RegType.CONSTINT, 0)]),
        ]))).toThrow(StructureError);
        expect(() => structureProgram(program([
            instruction(Op.BREAK),
        ]))).toThrow("inside a loop");
        expect(() => structureProgram(program([
            instruction(Op.CALL, [source(RegType.LABEL, 0)]),
        ]))).toThrow("not representable");
    });

    test("retains the four-level static loop guard", () => {
        const open = instruction(Op.LOOP, [source(RegType.LOOP, 0), source(RegType.CONSTINT, 0)]);
        const close = instruction(Op.ENDLOOP);
        const instructions = [
            open, open, open, open, open,
            close, close, close, close, close,
        ];
        expect(() => structureProgram(program(instructions))).toThrow("static loop nesting");
    });

    test("routes an implicit sample in a dynamic PS block through the W2 uniformity seam", () => {
        const sample = instruction(
            Op.TEX,
            [source(RegType.INPUT, 0), source(RegType.SAMPLER, 0)],
            destination(RegType.TEMP, 0),
        );
        const wgsl = emitPsMain(pixelProgram([
            instruction(Op.IF, [source(RegType.TEMP, 1)]),
            sample,
            instruction(Op.ENDIF),
            instruction(Op.MOV, [source(RegType.TEMP, 0)], destination(RegType.COLOROUT, 0)),
        ]), analyzePs(pixelProgram([
            instruction(Op.IF, [source(RegType.TEMP, 1)]),
            sample,
            instruction(Op.ENDIF),
            instruction(Op.MOV, [source(RegType.TEMP, 0)], destination(RegType.COLOROUT, 0)),
        ])));

        const derivative = wgsl.indexOf("let _ddx");
        const branch = wgsl.indexOf("if (((vec4<f32>(r1)).x != 0.0))");
        expect(derivative).toBeGreaterThanOrEqual(0);
        expect(branch).toBeGreaterThan(derivative);
        expect(wgsl).toContain("textureSampleGrad(tex0, samp");
        expect(wgsl).not.toContain("textureSample(tex0, samp");
    });

    test("hoists an affine branch-local coordinate instead of differentiating a temporary", () => {
        const sample = instruction(
            Op.TEX,
            [source(RegType.TEMP, 0), source(RegType.SAMPLER, 0)],
            destination(RegType.TEMP, 1),
        );
        const ps = pixelProgram([
            instruction(Op.IF, [source(RegType.TEMP, 7)]),
            instruction(Op.MOV, [source(RegType.INPUT, 1)], destination(RegType.TEMP, 0)),
            sample,
            instruction(Op.ENDIF),
            instruction(Op.MOV, [source(RegType.TEMP, 1)], destination(RegType.COLOROUT, 0)),
        ]);
        const wgsl = emitPsMain(ps, analyzePs(ps));

        const derivative = wgsl.indexOf("let _ddx");
        const branch = wgsl.indexOf("if (((vec4<f32>(r7)).x != 0.0))");
        expect(derivative).toBeGreaterThanOrEqual(0);
        expect(branch).toBeGreaterThan(derivative);
        expect(wgsl).toContain("dpdx((in.tex1).xy)");
        expect(wgsl).toContain("dpdy((in.tex1).xy)");
        expect(wgsl).toContain("textureSampleGrad(tex0, samp, (_tc1).xy");
        expect(wgsl).not.toContain("textureSampleLevel(tex0, samp");
    });

    test("refuses a non-affine branch-local coordinate instead of substituting LOD 0", () => {
        const sample = instruction(
            Op.TEX,
            [source(RegType.TEMP, 0), source(RegType.SAMPLER, 0)],
            destination(RegType.TEMP, 1),
        );
        const ps = pixelProgram([
            instruction(Op.IF, [source(RegType.TEMP, 7)]),
            instruction(Op.MUL, [source(RegType.INPUT, 1), source(RegType.INPUT, 2)], destination(RegType.TEMP, 0)),
            sample,
            instruction(Op.ENDIF),
            instruction(Op.MOV, [source(RegType.TEMP, 1)], destination(RegType.COLOROUT, 0)),
        ]);
        expect(() => emitPsMain(ps, analyzePs(ps))).toThrow("refusing link instead of substituting LOD 0");
    });

    test("refuses explicit derivatives in dynamic control flow before WGSL emission", () => {
        const dsx = instruction(
            Op.DSX,
            [source(RegType.INPUT, 0)],
            destination(RegType.TEMP, 0),
        );
        const ps = pixelProgram([
            instruction(Op.IF, [source(RegType.TEMP, 7)]),
            dsx,
            instruction(Op.ENDIF),
            instruction(Op.MOV, [source(RegType.TEMP, 0)], destination(RegType.COLOROUT, 0)),
        ]);
        expect(() => emitPsMain(ps, analyzePs(ps))).toThrow(
            "dsx in dynamic control flow cannot be lowered to WGSL; refusing link",
        );
    });
});

describe.skipIf(!d3dxOracleAvailable())("D3D9 SM3 oracle flow fixtures", () => {
    test("assembles if/ifc/else, rep, and loop aL through d3dx9 and links golden WGSL", async () => {
        const fixture = await asmFixture(`
            vs_3_0
            dcl_position v0
            dcl_position o0
            defb b0, true
            defi i0, 2, 1, 1, 0
            def c0, 1.0, 0.0, 0.5, 1.0
            if b0
                mov r0, v0
            else
                mov r0, c0
            endif
            if_gt r0.x, c0.y
                rep i0
                    add r0, r0, c0
                endrep
            endif
            loop aL, i0
                add r0, r0, c0
            endloop
            mov o0, r0
        `);
        const { assemble } = await import("../d3dx-oracle");
        const oracle = assemble(`
            vs_3_0
            dcl_position v0
            dcl_position o0
            defb b0, true
            defi i0, 2, 1, 1, 0
            def c0, 1.0, 0.0, 0.5, 1.0
            if b0
                mov r0, v0
            else
                mov r0, c0
            endif
            if_gt r0.x, c0.y
                rep i0
                    add r0, r0, c0
                endrep
            endif
            loop aL, i0
                add r0, r0, c0
            endloop
            mov o0, r0
        `);
        if (!oracle.tokens) throw new Error(oracle.error ?? "oracle returned no tokens");
        expect(fixture.instructions.some(instruction => instruction.opcode === Op.LOOP)).toBe(true);
        const linked = linkProgram({
            vs: compileVertexShader(oracle.tokens),
            ps: null,
            declElements: null,
            streamStride: 16,
        });
        expect(linked.wgsl).toContain("for (var _loopI");
        expect(linked.wgsl).toContain("for (var _repI");
        expect(linked.census.vs.unsupportedOps).toEqual([]);

        // Run the real harness seam when a live device exists. The ordinary
        // unit environment has no render backend, so this remains a conditional
        // device acceptance rather than a runtime dependency of shader tests.
        const backend = System.getInstance().services.render.getBackend() as {
            kind?: string;
            getDevice?: () => { createShaderModule(options: { code: string }): {
                getCompilationInfo(): Promise<{ messages: Array<{ type: string }> }>;
            } } | null;
        } | null;
        const device = backend?.kind === "webgpu" ? backend.getDevice?.() : null;
        if (device) {
            const service = new Map<string, (args: unknown[]) => unknown | Promise<unknown>>();
            registerShaderCommands({ register(name, handler) {
                service.set(name, handler as (args: unknown[]) => unknown | Promise<unknown>);
            } } as never);
            const check = await service.get("wgslCheck")!([{ wgsl: linked.wgsl }]);
            const result = check as { ok: boolean; messages: Array<{ type: string }> };
            expect(result.ok).toBe(true);
            expect(result.messages.filter(message => message.type === "error")).toHaveLength(0);
        }
    });
});
